import { MAIN_TYPES, MARKER, markedRequest, prepareRequest, skipReason } from './request.js';
import { requestReply } from './transport.js';

export const KEY = 'gemini_reply';
const chatKey = context => JSON.stringify([context.groupId ?? null, context.groupId ? null : context.characterId, context.chatId]);

export function install(getContext, host, showStatus, renderMessage) {
    const pending = new Map();
    let active = null;
    const context = getContext();
    const { eventSource: events, eventTypes: types } = context;
    context.extensionSettings[KEY] ??= { enabled: false };
    const originalFetch = host.fetch;
    const current = scope => scope === active && scope.key === chatKey(getContext()) && scope.chat === getContext().chat;

    function attach(scope, index = scope.processor?.messageId) {
        if (!current(scope) || index !== scope.target) return false;
        const message = scope.chat[index];
        if (!message || message.is_user || message.is_system) return false;
        if (scope.message && (scope.message !== message || scope.swipe !== message.swipe_id)) return false;
        scope.message = message;
        scope.swipe = message.swipe_id;
        message.extra ??= {};
        if (scope.status) message.extra[KEY] = { ...scope.status };
        else delete message.extra[KEY]; // A fresh unprotected reply must not inherit the previous swipe's status.
        const swipeExtra = message.swipe_info?.[message.swipe_id]?.extra;
        if (swipeExtra) {
            if (scope.status) swipeExtra[KEY] = { ...scope.status };
            else delete swipeExtra[KEY];
        }
        renderMessage(index);
        return true;
    }

    function report(scope, status) {
        if (scope.status?.state === 'cancelled' && status.state !== 'cancelled') return;
        scope.status = { version: 1, requestId: scope.id, ...status };
        if (current(scope)) {
            showStatus(status.detail, !status.complete && !['pending', 'retrying'].includes(status.state));
            attach(scope);
        }
    }

    events.on(types.CHAT_COMPLETION_SETTINGS_READY, body => {
        if (!MAIN_TYPES.has(body.type)) return;
        const ctx = getContext();
        const scope = {
            id: host.crypto.randomUUID(), key: chatKey(ctx), chat: ctx.chat,
            target: ctx.chat.length - (['swipe', 'continue'].includes(body.type) ? 1 : 0),
            processor: ctx.streamingProcessor, status: null,
        };
        active = scope;
        pending.clear();
        if (!ctx.extensionSettings[KEY].enabled) return;
        const reason = skipReason(body);
        if (reason) { showStatus(`本轮未启用：${reason}`, false); return; }
        pending.set(scope.id, scope);
        body[MARKER] = scope.id;
        report(scope, { state: 'pending', mode: 'tool', complete: false, attempts: 1, detail: '正在接收 Gemini 回复' });
    });

    host.fetch = async function (input, init) {
        const marked = markedRequest(input, init, host.location.origin, pending);
        if (!marked) return originalFetch.call(this, input, init);
        const { body, scope } = marked;
        // Check again in case a later settings event listener changed the request.
        const reason = skipReason(body);
        if (reason || !getContext().extensionSettings[KEY].enabled) {
            scope.status = null;
            showStatus(`本轮未启用：${reason || '开关已关闭'}`, false);
            return originalFetch.call(this, input, { ...init, body: JSON.stringify(body) });
        }
        try {
            const response = await requestReply(originalFetch.bind(this), input, init, prepareRequest(body), status => report(scope, status));
            if (!response.ok && !scope.processor && current(scope)) active = null;
            return response;
        } catch (error) {
            if (!scope.processor && current(scope)) active = null;
            throw error;
        }
    };

    events.makeFirst(types.STREAM_TOKEN_RECEIVED, () => {
        if (active && active.processor === getContext().streamingProcessor) attach(active);
    });
    events.makeFirst(types.MESSAGE_RECEIVED, index => { if (active) attach(active, index); });
    events.on(types.GENERATION_STOPPED, () => {
        if (active?.status && current(active)) report(active, {
            ...active.status, state: 'cancelled', complete: false, reason: 'cancelled', detail: '已取消，保留已显示的文字',
        });
    });
    events.on(types.GENERATION_ENDED, async () => {
        const scope = active;
        if (!scope || !current(scope)) return;
        // The event also fires for independent quiet requests from other extensions.
        if (scope.status?.state === 'pending' || scope.status?.state === 'retrying') return;
        if (scope.processor && scope.processor === getContext().streamingProcessor && scope.processor.isFinished === false && !scope.processor.isStopped) return;
        attach(scope);
        if (!scope.message && !scope.processor) return;
        if (scope.message && scope.status && !scope.status.complete) await getContext().saveChat();
        if (active === scope) { active = null; pending.clear(); }
    });
    events.on(types.CHAT_CHANGED, () => { active = null; pending.clear(); });
    events.on(types.MESSAGE_EDITED, index => {
        const message = getContext().chat[index];
        if (!message?.extra?.[KEY]) return;
        message.extra[KEY] = { ...message.extra[KEY], state: 'edited', complete: false, reason: 'edited', detail: '正文已手动修改，原接收状态仅供参考' };
        const swipeExtra = message.swipe_info?.[message.swipe_id]?.extra;
        if (swipeExtra) swipeExtra[KEY] = { ...message.extra[KEY] };
        renderMessage(index);
    });
}
