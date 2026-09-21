import { ContentDecoder } from './decoder.js';
import { TOOL_NAME } from './request.js';

export class Reply {
    constructor(native, streaming) {
        this.native = native;
        this.streaming = streaming;
        this.calls = new Map();
        this.toolPackets = [];
        this.parts = [];
        this.plain = '';
        this.reasoning = false;
        this.finishReason = null;
        this.done = false;
        this.problem = null;
    }

    fail(reason, detail) { this.problem ??= { reason, detail }; }
    get replyCalls() { return [...this.calls.values()].filter(c => c.name === TOOL_NAME); }
    get realCalls() { return [...this.calls.values()].filter(c => c.name !== TOOL_NAME); }
    get text() { return this.replyCalls.length ? this.replyCalls[0].decoder?.text || '' : this.plain; }
    get substantive() { return !!(this.text.trim() || this.calls.size || this.reasoning); }

    call(key, name, args, id, full = false) {
        let call = this.calls.get(key);
        if (!call) { call = { name: '', id: '', args: '', decoder: null }; this.calls.set(key, call); }
        if (name && call.name && name !== call.name) this.fail('tool-name', '同一工具调用的名字发生变化');
        if (id && call.id && id !== call.id) this.fail('tool-id', '同一工具调用的 ID 发生变化');
        call.name ||= name || '';
        call.id ||= id || '';
        call.args += full ? JSON.stringify(args) : args || '';
        let delta = '';
        if (call.name === TOOL_NAME) {
            if (!call.decoder) { call.decoder = new ContentDecoder(); delta = call.decoder.feed(call.args); }
            else delta = call.decoder.feed(args || '');
            if (call.decoder.error) this.fail('arguments', call.decoder.error);
        }
        if (this.replyCalls.length > 1) this.fail('duplicate-reply', '本轮返回了多个正文工具');
        if (this.replyCalls.length && this.realCalls.some(c => c.name)) this.fail('mixed-tools', '正文工具与真实工具混用，已停止执行真实工具');
        return delta;
    }

    accept(packet) {
        this.lastPacket = packet;
        if (packet.error || packet.promptFeedback?.blockReason) {
            this.fail('upstream', '接口返回错误或拒绝了本次请求');
            return [];
        }
        const copy = structuredClone(packet);
        if (this.native) {
            if ((packet.candidates?.length || 0) > 1) this.fail('candidates', '接口返回了多个候选');
            const candidate = packet.candidates?.[0];
            if (!candidate) return [];
            this.finishReason = candidate.finishReason || this.finishReason;
            const parts = [];
            let text = '';
            for (const part of candidate.content?.parts || []) {
                if (part.functionCall) {
                    const { name, args, id } = part.functionCall;
                    text += this.call(this.calls.size, name, args, id, true);
                    this.toolPackets.push({ candidates: [{ content: { parts: [structuredClone(part)] } }] });
                } else if (part.thought) {
                    this.reasoning ||= !!part.text;
                    this.parts.push(part);
                    parts.push(part);
                } else if (typeof part.text === 'string') {
                    this.plain += part.text;
                    if (part.thoughtSignature) this.plainSignature = part.thoughtSignature;
                } else {
                    this.reasoning = true; // Other substantive output must never trigger an empty retry.
                    this.parts.push(part);
                    parts.push(part);
                }
            }
            if (text) parts.push({ text });
            copy.candidates[0].content = { ...candidate.content, parts };
            delete copy.candidates[0].finishReason;
            return parts.length || copy.usageMetadata ? [copy] : [];
        }
        if ((packet.choices?.length || 0) > 1) this.fail('candidates', '接口返回了多个候选');
        const choice = packet.choices?.[0];
        if (!choice) return packet.usage ? [copy] : [];
        if ((choice.index || 0) !== 0) this.fail('candidates', '接口返回了其他候选');
        this.finishReason = choice.finish_reason || this.finishReason;
        const body = choice.delta || choice.message || {};
        const content = body.content ?? choice.text;
        if (typeof content === 'string') this.plain += content;
        else if (Array.isArray(content)) this.plain += content.map(p => p.text || '').join('');
        this.reasoning ||= !!(body.reasoning || body.reasoning_content || body.reasoning_details?.length || body.images?.length);
        if (body.refusal) this.fail('refusal', '模型拒绝了本次请求');
        let text = '';
        for (const [i, tool] of (body.tool_calls || []).entries()) {
            text += this.call(tool.index ?? i, tool.function?.name, tool.function?.arguments, tool.id);
        }
        if (body.tool_calls?.length) this.toolPackets.push({ choices: [{ index: 0, delta: { tool_calls: structuredClone(body.tool_calls) } }] });
        const clean = { ...body };
        delete clean.tool_calls;
        delete clean.content;
        if (text) clean.content = text;
        copy.choices[0] = { ...choice, delta: clean };
        delete copy.choices[0].message;
        delete copy.choices[0].text;
        delete copy.choices[0].finish_reason;
        return text || this.reasoning || packet.usage ? [copy] : [];
    }

    status() {
        const base = { mode: this.replyCalls.length ? 'tool' : this.realCalls.length ? 'tools' : 'plain', finishReason: this.finishReason, complete: false };
        if (this.problem) return { ...base, state: 'error', ...this.problem };
        if (['length', 'MAX_TOKENS'].includes(this.finishReason)) return { ...base, state: 'incomplete', reason: 'length', detail: '达到输出长度上限，正文可能未完成' };
        if (this.finishReason && !['stop', 'STOP', 'tool_calls', 'function_call'].includes(this.finishReason)) return { ...base, state: 'incomplete', reason: 'finish', detail: `接口异常结束：${this.finishReason}` };
        if (this.streaming && !this.finishReason && !this.done) return { ...base, state: 'incomplete', reason: 'eof', detail: '响应结束但没有完成标记' };
        if (this.replyCalls.some(c => !c.decoder?.complete)) return { ...base, state: 'incomplete', reason: 'arguments', detail: '正文工具参数未闭合，已保留收到的文字' };
        if (this.realCalls.length) {
            const ids = new Set();
            for (const call of this.realCalls) {
                try {
                    if (!call.name || (!this.native && (!call.id || ids.has(call.id)))) throw new Error();
                    JSON.parse(call.args || '{}');
                    ids.add(call.id);
                } catch { return { ...base, state: 'error', reason: 'real-tool', detail: '真实工具参数或 ID 不完整，已停止执行' }; }
            }
            return { ...base, state: 'complete', complete: true, detail: '真实工具交由酒馆执行' };
        }
        if (!this.text.trim()) return { ...base, state: this.substantive ? 'incomplete' : 'empty', reason: 'empty', detail: this.reasoning ? '只收到推理，没有正文' : '没有收到正文' };
        return { ...base, state: 'complete', complete: true, detail: base.mode === 'tool' ? '工具正文已完整接收' : '普通正文兜底：接口未使用正文工具' };
    }

    textPacket(text) {
        return this.native
            ? { candidates: [{ content: { parts: [{ text, ...(this.plainSignature && !this.replyCalls.length ? { thoughtSignature: this.plainSignature } : {}) }] } }] }
            : { choices: [{ index: 0, delta: { content: text } }] };
    }

    tail(status) {
        const packets = [];
        if (!this.replyCalls.length && this.plain) packets.push(this.textPacket(this.plain));
        if (status.complete && this.realCalls.length) packets.push(...this.toolPackets);
        return packets;
    }

    whole(status) {
        if (this.native) {
            const parts = [...this.parts, ...(this.text ? [{ text: this.text }] : [])];
            if (status.complete && this.realCalls.length) parts.push(...this.toolPackets.flatMap(p => p.candidates[0].content.parts));
            return { choices: [{ message: { content: this.text }, finish_reason: this.finishReason }], responseContent: { role: 'model', parts }, usageMetadata: this.lastPacket?.usageMetadata };
        }
        const data = structuredClone(this.lastPacket || {});
        const choice = data.choices?.[0] || {};
        const message = { ...(choice.message || choice.delta), content: this.text };
        delete message.tool_calls;
        if (status.complete && this.realCalls.length) message.tool_calls = this.toolPackets.flatMap(p => p.choices[0].delta.tool_calls);
        data.choices = [{ ...choice, index: 0, message, finish_reason: this.replyCalls.length && status.complete ? 'stop' : choice.finish_reason }];
        delete data.choices[0].delta;
        return data;
    }
}
