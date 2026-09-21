import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentDecoder } from '../src/decoder.js';
import { MARKER, ROUTE, prepareRequest, skipReason, markedRequest } from '../src/request.js';
import { requestReply, sseEvents } from '../src/transport.js';

const base = () => ({ type: 'normal', model: 'gemini-2.5-pro', chat_completion_source: 'custom', stream: true, messages: [{ role: 'user', content: '你好' }] });
const chunk = (args, finish = null, fields = {}) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'reply-1', type: 'function', function: { name: 'output_reply', arguments: args } }], ...fields }, finish_reason: finish }] });
const plain = (content, finish = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
const jsonResponse = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function streamResponse(events, { byteSize = 0, fail = false, delay = 0 } = {}) {
    const bytes = new TextEncoder().encode(events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`).join(''));
    let pos = 0;
    return new Response(new ReadableStream({ async pull(sink) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (pos >= bytes.length) { if (fail) sink.error(new Error('socket lost')); else sink.close(); return; }
        const end = Math.min(bytes.length, pos + (byteSize || bytes.length));
        sink.enqueue(bytes.slice(pos, end)); pos = end;
    } }), { headers: { 'content-type': 'text/event-stream' } });
}
async function execute(responseFactory, body = base(), options = {}, signal) {
    const statuses = [];
    const sent = [];
    const response = await requestReply(async (_, init) => { sent.push(JSON.parse(init.body)); return responseFactory(sent.length, init); }, ROUTE, { method: 'POST', signal }, prepareRequest(body), s => statuses.push(s), options);
    const packets = [];
    if (body.stream) {
        const reader = response.body.getReader();
        for await (const event of sseEvents(reader, fn => fn())) if (event !== '[DONE]') packets.push(JSON.parse(event));
        reader.releaseLock();
    } else packets.push(await response.json());
    return { packets, status: statuses.at(-1), statuses, sent, text: packets.map(p => p.choices?.[0]?.delta?.content || p.choices?.[0]?.message?.content || p.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '').join('') };
}

test('request gate and immutable multimodal request preparation', () => {
    const input = base();
    input.messages[0].content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }, { type: 'text', text: '你好' }];
    input[MARKER] = 'secret-marker';
    const original = structuredClone(input);
    const next = prepareRequest(input);
    assert.deepEqual(input, original);
    assert.equal(next[MARKER], undefined);
    assert.equal(next.tools[0].function.name, 'output_reply');
    assert.equal(next.tool_choice.function.name, 'output_reply');
    assert.equal(next.parallel_tool_calls, false);
    assert.deepEqual(next.messages[0].content[0], input.messages[0].content[0]);
    assert.equal(next.messages[0].content.length, 3);
    assert.equal(skipReason(base()), '');
    for (const override of [{ type: 'quiet' }, { type: 'impersonate' }, { model: 'claude' }, { n: 2 }, { json_schema: {} }, { enable_web_search: true }, { request_images: true }, { tool_choice: 'none' }, { tool_choice: { function: { name: 'search' } } }, { tools: [{ type: 'web_search' }] }, { custom_include_body: 'tools: []' }, { chat_completion_source: 'unknown' }]) assert.ok(skipReason({ ...base(), ...override }));
    const withTools = prepareRequest({ ...base(), tools: [{ type: 'function', function: { name: 'search' } }] });
    assert.equal(withTools.tool_choice, 'required');
    assert.equal(withTools.tools[0].function.name, 'search');
    assert.match(prepareRequest({ ...base(), type: 'continue' }).messages[0].content, /only the new continuation/);
});

test('interceptor only claims exact same-origin marked POST; marker is consumed once', () => {
    const scope = {};
    const pending = new Map([['m', scope]]);
    const init = { method: 'POST', body: JSON.stringify({ ...base(), [MARKER]: 'm' }) };
    for (const url of ['https://elsewhere.test' + ROUTE, ROUTE + '/other', ROUTE + '?x=1']) assert.equal(markedRequest(url, init, 'http://localhost', pending), null);
    assert.equal(markedRequest(ROUTE, { ...init, method: 'GET' }, 'http://localhost', pending), null);
    assert.equal(markedRequest(ROUTE, { ...init, body: '{}' }, 'http://localhost', pending), null);
    const got = markedRequest(ROUTE, init, 'http://localhost', pending);
    assert.equal(got.scope, scope);
    assert.equal(got.body[MARKER], undefined);
    assert.equal(markedRequest(ROUTE, init, 'http://localhost', pending), null);
});

test('decoder every split point, escapes, Unicode and no half-surrogate output', () => {
    const raw = '{ "content" : "引号\\\" \\\\ \\/ \\n\\t\\b\\f\\r \\u4f60\\u597d \\ud83d\\ude0a 😊 <panel>正文</panel>" }';
    const expected = JSON.parse(raw).content;
    for (let split = 0; split <= raw.length; split++) {
        const decoder = new ContentDecoder();
        const first = decoder.feed(raw.slice(0, split));
        assert.ok(!/[\uD800-\uDBFF]$/.test(first));
        assert.equal(first + decoder.feed(raw.slice(split)), expected);
        assert.equal(decoder.complete, true);
    }
    const decoder = new ContentDecoder();
    for (const code of raw.split('')) decoder.feed(code);
    assert.equal(decoder.text, expected);
    assert.equal(decoder.complete, true);
});

test('decoder rejects extra fields, illegal escapes, control characters and unpaired Unicode', () => {
    for (const raw of ['{"content":"x","other":1}', '{"wrong":"x"}', '{"content":12}', '{"content":"\\q"}', '{"content":"a\nb"}', '{"content":"\\ud800x"}', '{"content":"\\udc00"}', '{"content":"x"} trailing', '\u00a0{"content":"x"}']) {
        const decoder = new ContentDecoder(); decoder.feed(raw);
        assert.ok(decoder.error, raw);
        assert.equal(decoder.complete, false);
    }
    for (const raw of ['{"content":"partial', '{"content":"partial"', '{"content":"\\u12']) {
        const decoder = new ContentDecoder(); decoder.feed(raw); assert.equal(decoder.complete, false);
    }
});

test('OpenAI stream: byte-split SSE, tool argument fragments, plain suppression, reasoning retained', async () => {
    const result = await execute(() => streamResponse([plain('不要重复我'), chunk('{"con'), chunk('tent":"你好\\n\\ud83d'), chunk('\\ude0a"}', 'tool_calls', { reasoning_content: '思考' }), '[DONE]'], { byteSize: 1 }));
    assert.equal(result.text, '你好\n😊');
    assert.equal(result.status.complete, true);
    assert.equal(result.status.mode, 'tool');
    assert.ok(result.packets.some(p => p.choices?.[0]?.delta?.reasoning_content === '思考'));
    assert.ok(!JSON.stringify(result.packets).includes('output_reply'));
    assert.equal(result.sent.length, 1);
});

test('plain fallback is held to the end and labelled honestly', async () => {
    const result = await execute(() => streamResponse([plain('普通'), plain('正文', 'stop'), '[DONE]']));
    assert.equal(result.text, '普通正文');
    assert.equal(result.status.mode, 'plain');
    assert.equal(result.status.complete, true);
});

test('ST forwards SSE without content-type; still parse as the requested stream', async () => {
    const result = await execute(() => {
        const response = streamResponse([chunk('{"content":"无响应类型"}', 'stop'), '[DONE]']);
        response.headers.delete('content-type');
        return response;
    });
    assert.equal(result.text, '无响应类型');
    assert.equal(result.status.complete, true);
});

for (const [name, events, reason] of [
    ['length', [chunk('{"content":"半截', 'length'), '[DONE]'], 'length'],
    ['missing close brace', [chunk('{"content":"半截"', 'tool_calls'), '[DONE]'], 'arguments'],
    ['missing terminal', [chunk('{"content":"半截"}')], 'eof'],
    ['invalid escape', [chunk('{"content":"半截\\q"}', 'tool_calls')], 'arguments'],
    ['content filter', [chunk('{"content":"半截"}', 'content_filter'), '[DONE]'], 'finish'],
]) test(`partial is preserved but never complete: ${name}`, async () => {
    const result = await execute(() => streamResponse(events));
    assert.equal(result.text, '半截');
    assert.equal(result.status.complete, false);
    assert.equal(result.status.reason, reason);
    assert.equal(result.sent.length, 1);
});

test('finish reason alone is a valid terminal; DONE alone also accepted for a closed tool envelope', async () => {
    for (const events of [[chunk('{"content":"完整"}', 'stop')], [chunk('{"content":"完整"}'), '[DONE]']]) {
        const result = await execute(() => streamResponse(events)); assert.equal(result.status.complete, true);
    }
});

test('genuinely empty replies retry at most three attempts', async () => {
    const result = await execute(n => streamResponse(n < 3 ? [plain('', 'stop'), '[DONE]'] : [chunk('{"content":"第三次"}', 'stop'), '[DONE]']));
    assert.equal(result.sent.length, 3);
    assert.equal(result.status.attempts, 3);
    let count = 0;
    await assert.rejects(execute(() => { count++; return streamResponse([plain('', 'stop'), '[DONE]']); }), /没有收到正文/);
    assert.equal(count, 3);
});

test('reasoning-only, refusal and bad tool arguments are not retried', async () => {
    const reasoning = await execute(() => streamResponse([{ choices: [{ delta: { reasoning_content: '仅思考' }, finish_reason: 'stop' }] }, '[DONE]']));
    assert.equal(reasoning.sent.length, 1);
    assert.equal(reasoning.status.complete, false);
    let count = 0;
    await assert.rejects(execute(() => { count++; return streamResponse([{ choices: [{ delta: { refusal: 'No' }, finish_reason: 'stop' }] }, '[DONE]']); }));
    assert.equal(count, 1);
});

test('real tools retain IDs, signatures and raw argument deltas; never execute mixed/invalid tools', async () => {
    const tool = args => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'search-1', type: 'function', signature: 'sig', function: { name: 'search', arguments: args } }] }, finish_reason: null }] });
    const events = [tool('{"q":'), tool('"a"}'), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]'];
    const result = await execute(() => streamResponse(events));
    const calls = result.packets.flatMap(p => p.choices?.[0]?.delta?.tool_calls || []);
    assert.deepEqual(calls, events.slice(0, 2).flatMap(p => p.choices[0].delta.tool_calls));
    assert.equal(result.status.mode, 'tools');
    const mixed = tool('{}'); mixed.choices[0].delta.tool_calls[0].index = 1;
    const bad = await execute(() => streamResponse([chunk('{"content":"正文"}'), mixed, '[DONE]']));
    assert.equal(bad.text, '正文');
    assert.equal(bad.status.reason, 'mixed-tools');
    assert.ok(!bad.packets.some(p => p.choices?.[0]?.delta?.tool_calls));
    for (const calls of [[{ index: 0, function: { name: 'search', arguments: '{}' } }], [{ index: 0, id: 'same', function: { name: 'a', arguments: '{}' } }, { index: 1, id: 'same', function: { name: 'b', arguments: '{}' } }]]) {
        const badTool = await execute(() => streamResponse([{ choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] }, '[DONE]']));
        assert.equal(badTool.status.reason, 'real-tool');
        assert.ok(!badTool.packets.some(p => p.choices?.[0]?.delta?.tool_calls));
    }
});

test('native Gemini streaming and non-stream display both retain finish cause and real tool signatures', async () => {
    const events = [
        { candidates: [{ content: { parts: [{ thought: true, text: '思考' }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: 'output_reply', args: { content: '原生正文😊' } }, thoughtSignature: 'function-signature' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 42 } },
    ];
    for (const stream of [true, false]) {
        const result = await execute(() => streamResponse(events), { ...base(), chat_completion_source: 'makersuite', stream });
        assert.equal(result.text, '原生正文😊');
        assert.equal(result.sent[0].stream, true);
        assert.equal(result.status.complete, true);
        assert.ok(!JSON.stringify(result.packets).includes('output_reply'));
        assert.ok(!JSON.stringify(result.packets).includes('function-signature'));
    }
    const truncated = await execute(() => streamResponse([{ candidates: [{ content: { parts: [{ functionCall: { name: 'output_reply', args: { content: '半截' } } }] }, finishReason: 'MAX_TOKENS' }] }]), { ...base(), chat_completion_source: 'vertexai', stream: false });
    assert.equal(truncated.status.reason, 'length');
    assert.equal(truncated.text, '半截');
    const part = { functionCall: { name: 'search', args: { q: '测试' } }, thoughtSignature: 'keep-sig' };
    const real = await execute(() => streamResponse([{ candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] }]), { ...base(), chat_completion_source: 'makersuite' });
    assert.deepEqual(real.packets.flatMap(p => p.candidates?.[0]?.content?.parts || []).find(p => p.functionCall), part);
});

test('parameterless real tools remain executable with an empty argument string', async () => {
    const call = { id: 'empty-1', type: 'function', function: { name: 'probe', arguments: '' } };
    for (const stream of [true, false]) {
        const result = await execute(() => stream
            ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: 'tool_calls' }] }, '[DONE]'])
            : jsonResponse({ choices: [{ message: { tool_calls: [call] }, finish_reason: 'tool_calls' }] }), { ...base(), stream });
        assert.equal(result.status.complete, true);
        assert.equal(result.status.mode, 'tools');
        const choice = result.packets.find(p => p.choices?.[0]?.[stream ? 'delta' : 'message']?.tool_calls).choices[0];
        assert.equal(choice.index, 0);
        assert.equal(choice[stream ? 'delta' : 'message'].tool_calls[0].function.arguments, '');
    }
});

test('non-stream OpenAI response unwrapped with reasoning and usage retained', async () => {
    const input = { choices: [{ message: { role: 'assistant', content: '重复文本', reasoning_content: '思考', tool_calls: [{ id: 'r', type: 'function', function: { name: 'output_reply', arguments: '{"content":"正文"}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 123 } };
    const result = await execute(() => jsonResponse(input), { ...base(), stream: false });
    assert.equal(result.text, '正文');
    assert.equal(result.packets[0].choices[0].message.reasoning_content, '思考');
    assert.equal(result.packets[0].choices[0].finish_reason, 'stop');
    assert.equal(result.packets[0].usage.total_tokens, 123);
    assert.ok(!JSON.stringify(result.packets).includes('output_reply'));
});

test('HTTP failure and pre-cancel do not retry; cancellation propagates to upstream', async () => {
    let calls = 0;
    const statuses = [];
    const response = await requestReply(async () => { calls++; return new Response('unsupported tools', { status: 400 }); }, ROUTE, {}, prepareRequest(base()), s => statuses.push(s));
    assert.equal(response.status, 400); assert.equal(calls, 1); assert.equal(statuses.at(-1).reason, 'http');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(execute(() => { calls++; return streamResponse([]); }, base(), {}, abort.signal));
    assert.equal(calls, 1);
    const active = new AbortController();
    let upstreamSignal;
    const resultPromise = requestReply(async (_, init) => { upstreamSignal = init.signal; return new Promise(() => {}); }, ROUTE, { signal: active.signal }, prepareRequest(base()), s => statuses.push(s));
    active.abort();
    await assert.rejects(resultPromise);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(statuses.at(-1).state, 'cancelled');
});

test('idle timeout does not cap total stream duration; socket loss preserves partial without retry', async () => {
    const result = await execute(() => streamResponse([chunk('{"content":"持续输出"}', 'stop'), '[DONE]'], { byteSize: 40, delay: 8 }), base(), { idleMs: 45 });
    assert.equal(result.status.complete, true);
    const partial = await execute(() => streamResponse([chunk('{"content":"保留半截')], { fail: true, byteSize: 256 }));
    assert.equal(partial.text, '保留半截');
    assert.equal(partial.status.reason, 'connection');
    assert.equal(partial.sent.length, 1);
    let calls = 0;
    await assert.rejects(requestReply(async () => { calls++; return new Promise(() => {}); }, ROUTE, {}, prepareRequest(base()), () => {}, { idleMs: 10 }), { name: 'TimeoutError' });
    assert.equal(calls, 1);
});
