import test from 'node:test';
import assert from 'node:assert/strict';
import { install, KEY } from '../src/runtime.js';
import { ROUTE } from '../src/request.js';

function harness() {
    const listeners = new Map();
    const eventTypes = Object.fromEntries(['CHAT_COMPLETION_SETTINGS_READY', 'STREAM_TOKEN_RECEIVED', 'MESSAGE_RECEIVED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED', 'MESSAGE_EDITED'].map(k => [k, k]));
    const events = {
        on(k, fn) { listeners.set(k, [...(listeners.get(k) || []), fn]); },
        makeFirst(k, fn) { listeners.set(k, [fn, ...(listeners.get(k) || [])]); },
        async emit(k, ...args) { for (const fn of listeners.get(k) || []) await fn(...args); },
    };
    const ctx = { chat: [{ is_user: true, mes: 'test' }], chatId: 'chat-a', characterId: 1, groupId: null, extensionSettings: { [KEY]: { enabled: true } }, eventSource: events, eventTypes, saveChat: async () => { saved++; } };
    let saved = 0;
    let response = new Response('untouched');
    const requests = [];
    const statuses = [];
    const host = { crypto, location: { origin: 'http://localhost' }, fetch: async (...args) => { requests.push(args); return response; } };
    install(() => ctx, host, (...s) => statuses.push(s), () => {});
    return { ctx, host, events, requests, statuses, get saved() { return saved; }, set response(r) { response = r; } };
}
const body = (stream = true, type = 'normal') => ({ type, model: 'gemini-test', chat_completion_source: 'custom', stream, messages: [{ role: 'user', content: '你好' }] });
const message = () => ({ is_user: false, mes: '正文', swipe_id: 0, swipes: ['正文'], swipe_info: [{ extra: {} }], extra: {} });
const response = (finish = 'stop') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'reply-1', function: { name: 'output_reply', arguments: '{"content":"正文"}' } }] }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
async function send(h, b) {
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', b);
    return h.host.fetch(ROUTE, { method: 'POST', body: JSON.stringify(b) });
}

test('disabled, non-Gemini, quiet and unrelated fetch pass through unchanged', async () => {
    const h = harness();
    for (const override of [{ type: 'quiet' }, { model: 'claude-test' }, { n: 2 }, { enable_web_search: true }]) {
        const b = { ...body(), ...override };
        const expected = JSON.stringify(b);
        await send(h, b);
        assert.equal(h.requests.at(-1)[1].body, expected);
    }
    h.ctx.extensionSettings[KEY].enabled = false;
    const b = body(); await send(h, b);
    assert.equal(h.requests.at(-1)[1].body, JSON.stringify(b));
    const init = { method: 'POST', body: 'payload' };
    await h.host.fetch('/api/settings/save', init);
    assert.equal(h.requests.at(-1)[1], init);
});

test('stream status is saved on matching message and matching swipe before MESSAGE_RECEIVED observers', async () => {
    const h = harness();
    h.ctx.streamingProcessor = { messageId: -1 };
    h.response = response('length');
    const result = await send(h, body());
    h.ctx.chat.push(message()); h.ctx.streamingProcessor.messageId = 1;
    await result.text();
    let observed;
    h.events.on('MESSAGE_RECEIVED', i => { observed = h.ctx.chat[i].extra[KEY]; });
    await h.events.emit('MESSAGE_RECEIVED', 1);
    assert.equal(observed.complete, false);
    assert.equal(observed.reason, 'length');
    assert.deepEqual(h.ctx.chat[1].swipe_info[0].extra[KEY], observed);
    await h.events.emit('GENERATION_ENDED');
    assert.equal(h.saved, 1);
});

test('non-stream status attaches to new message; regenerate is not attributed to previous reply', async () => {
    const h = harness();
    h.ctx.chat.push(message());
    h.response = new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'r', function: { name: 'output_reply', arguments: '{"content":"正文"}' } }] }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    const result = await send(h, body(false, 'regenerate')); await result.json();
    assert.equal(h.ctx.chat[1].extra[KEY], undefined);
    h.ctx.chat.push(message());
    await h.events.emit('MESSAGE_RECEIVED', 2);
    assert.equal(h.ctx.chat[2].extra[KEY].complete, true);
});

test('quiet generation ending while main stream is active must not detach its status', async () => {
    const h = harness();
    h.ctx.streamingProcessor = { messageId: -1, isFinished: false, isStopped: false };
    h.response = response();
    const result = await send(h, body());
    await h.events.emit('GENERATION_ENDED'); // e.g. an independent extension's quiet request finishes.
    h.ctx.chat.push(message()); h.ctx.streamingProcessor.messageId = 1;
    await result.text();
    await h.events.emit('MESSAGE_RECEIVED', 1);
    assert.equal(h.ctx.chat[1].extra[KEY]?.complete, true);
});

test('switching chat, replacing message and switching existing swipe cannot receive late status', async () => {
    for (const change of ['chat', 'replace', 'swipe']) {
        const h = harness();
        h.ctx.streamingProcessor = { messageId: -1 };
        h.response = response('length');
        const result = await send(h, body());
        h.ctx.chat.push(message()); h.ctx.streamingProcessor.messageId = 1;
        await h.events.emit('STREAM_TOKEN_RECEIVED');
        const old = h.ctx.chat[1];
        if (change === 'chat') { h.ctx.chatId = 'chat-b'; h.ctx.chat = [{ is_user: true }, message()]; await h.events.emit('CHAT_CHANGED'); }
        if (change === 'replace') h.ctx.chat[1] = message();
        if (change === 'swipe') { old.swipe_id = 1; old.extra = {}; old.swipe_info.push({ extra: {} }); }
        await result.text();
        await h.events.emit('MESSAGE_RECEIVED', 1);
        assert.equal(h.ctx.chat[1].extra[KEY], undefined);
    }
});

test('fresh unprotected swipe clears old status and leaves other swipe intact', async () => {
    const h = harness();
    const oldStatus = { complete: false, state: 'incomplete' };
    const m = message(); m.extra[KEY] = oldStatus; m.swipe_info[0].extra[KEY] = oldStatus;
    m.swipe_id = 1; m.swipe_info.push({ extra: {} }); h.ctx.chat.push(m);
    h.ctx.extensionSettings[KEY].enabled = false;
    h.ctx.streamingProcessor = { messageId: 1 };
    await send(h, body(true, 'swipe'));
    await h.events.emit('STREAM_TOKEN_RECEIVED');
    assert.equal(m.extra[KEY], undefined);
    assert.equal(m.swipe_info[0].extra[KEY], oldStatus);
});

test('cancellation and manual edits cannot be labelled complete', async () => {
    const h = harness();
    h.ctx.streamingProcessor = { messageId: -1 }; h.response = response();
    const result = await send(h, body());
    h.ctx.chat.push(message()); h.ctx.streamingProcessor.messageId = 1;
    await h.events.emit('STREAM_TOKEN_RECEIVED');
    await h.events.emit('GENERATION_STOPPED');
    assert.equal(h.ctx.chat[1].extra[KEY].state, 'cancelled');
    await result.text(); // Test harness has no ST AbortController: real transport cancellation is separately covered.
    assert.equal(h.ctx.chat[1].extra[KEY].state, 'cancelled');
    await h.events.emit('GENERATION_ENDED');
    await h.events.emit('MESSAGE_EDITED', 1);
    assert.equal(h.ctx.chat[1].extra[KEY].state, 'edited');
    assert.equal(h.ctx.chat[1].extra[KEY].complete, false);
});

test('a failed non-stream request cannot attach its status to a later unrelated inserted message', async () => {
    for (const status of [200, 400]) {
        const h = harness();
        h.response = new Response('{"error":{"message":"local test failure"}}', { status, headers: { 'content-type': 'application/json' } });
        try { await send(h, body(false)); } catch { /* The failure is expected. */ }
        await h.events.emit('GENERATION_ENDED');
        h.ctx.chat.push(message());
        await h.events.emit('MESSAGE_RECEIVED', 1);
        assert.equal(h.ctx.chat[1].extra[KEY], undefined);
    }
});
