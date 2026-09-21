import { isNative } from './request.js';
import { Reply } from './reply.js';

export async function* sseEvents(reader, wait) {
    const decoder = new TextDecoder();
    let buffer = '';
    let data = [];
    let ended = false;
    while (!ended) {
        const chunk = await wait(() => reader.read());
        ended = chunk.done;
        buffer += decoder.decode(chunk.value, { stream: !ended });
        let match;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
            if (!ended && match[0] === '\r' && match.index === buffer.length - 1) break;
            const line = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (!line) {
                if (data.length) yield data.join('\n');
                data = [];
            } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
    if (data.length) yield data.join('\n');
}

export async function requestReply(fetcher, input, init, body, onStatus, { idleMs = 120000, maxAttempts = 3 } = {}) {
    const controller = new AbortController();
    const signal = init.signal;
    const abort = () => controller.abort(signal.reason || new DOMException('已取消', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    async function wait(operation) {
        controller.signal.throwIfAborted();
        let timer;
        let abortWait;
        try {
            return await Promise.race([
                operation(),
                new Promise((_, reject) => {
                    abortWait = () => reject(controller.signal.reason);
                    controller.signal.addEventListener('abort', abortWait, { once: true });
                    timer = setTimeout(() => controller.abort(new DOMException('响应等待超过两分钟', 'TimeoutError')), idleMs);
                }),
            ]);
        } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', abortWait);
        }
    }
    const native = isNative(body);
    // ST 1.19 drops Gemini finishReason in its non-stream response wrapper.
    const upstream = { ...body, stream: native ? true : body.stream };
    const open = () => wait(() => fetcher(input, { ...init, body: JSON.stringify(upstream), signal: controller.signal }));
    let attempt = 1;
    let response;
    let current;
    let result;
    const report = status => onStatus({ ...status, attempts: attempt });
    const failure = error => ({
        mode: current?.replyCalls.length ? 'tool' : 'plain', complete: false,
        finishReason: current?.finishReason || null,
        state: signal?.aborted ? 'cancelled' : 'incomplete',
        reason: signal?.aborted ? 'cancelled' : error?.name === 'TimeoutError' ? 'timeout' : 'connection',
        detail: signal?.aborted ? '已取消，保留已显示的文字' : error?.name === 'TimeoutError' ? '等待响应超时，回复可能未完成' : '响应中断或格式错误，回复可能未完成',
    });
    try {
        response = await open();
        if (!response.ok) {
            report({ state: 'error', mode: 'tool', complete: false, reason: 'http', detail: `接口返回 HTTP ${response.status}，未自动重试` });
            cleanup();
            return response;
        }
    } catch (error) { report(failure(error)); cleanup(); throw error; }

    async function* run() {
        try {
            while (true) {
                current = new Reply(native, upstream.stream);
                let reader;
                let status;
                try {
                    const contentType = response.headers.get('content-type') || '';
                    const stream = contentType.includes('text/event-stream') || (upstream.stream && !contentType.includes('application/json'));
                    if (stream) {
                        reader = response.body.getReader();
                        for await (const event of sseEvents(reader, wait)) {
                            if (event === '[DONE]') { current.done = true; break; }
                            const packets = current.accept(JSON.parse(event));
                            for (const packet of packets) yield packet;
                            if (current.problem) break;
                        }
                    } else {
                        // Some compatible endpoints ignore stream=true and return one JSON object.
                        current.streaming = false;
                        reader = response.body.getReader();
                        const decoder = new TextDecoder();
                        let json = '';
                        while (true) {
                            const chunk = await wait(() => reader.read());
                            json += decoder.decode(chunk.value, { stream: !chunk.done });
                            if (chunk.done) break;
                        }
                        const data = JSON.parse(json);
                        for (const packet of current.accept(data)) yield packet;
                    }
                    status = current.status();
                } catch (error) {
                    status = failure(error);
                    if (signal?.aborted || !current.substantive) { report(status); throw error; }
                } finally {
                    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
                }
                if (status.state === 'empty' && attempt < maxAttempts) {
                    report({ ...status, state: 'retrying', detail: '收到空回复，正在有限重试' });
                    attempt++;
                    response = await open();
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    continue;
                }
                report(status);
                result = current.whole(status);
                for (const packet of current.tail(status)) yield packet;
                if (!current.substantive) throw new Error(status.detail);
                return;
            }
        } catch (error) {
            // Keep the more specific protocol/empty result already reported at the end.
            if (!result) report(failure(error));
            throw error;
        } finally { cleanup(); }
    }

    const iterator = run();
    if (!body.stream) {
        for await (const _ of iterator) { /* Consume before returning one ordinary reply. */ }
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async pull(sink) {
            try {
                const { done, value } = await iterator.next();
                if (done) { sink.enqueue(encoder.encode('data: [DONE]\n\n')); sink.close(); }
                else sink.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
            } catch (error) { sink.error(error); }
        },
        async cancel() {
            controller.abort(new DOMException('读取已取消', 'AbortError'));
            await iterator.return().catch(() => {});
            cleanup();
        },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
