export const TOOL_NAME = 'output_reply';
export const MARKER = '__st_gemini_reply';
export const ROUTE = '/api/backends/chat-completions/generate';
export const MAIN_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
export const isNative = body => ['makersuite', 'vertexai'].includes(body.chat_completion_source);

export function skipReason(body) {
    if (!MAIN_TYPES.has(body.type)) return '只接管主聊天';
    if (!/gemini/i.test(body.model || '')) return '当前不是 Gemini 模型';
    if (!['makersuite', 'vertexai', 'custom', 'openrouter', 'openai'].includes(body.chat_completion_source)) return '此接口尚未适配';
    if (body.n > 1) return '一次生成多个候选时不启用';
    if (body.json_schema || body.responseSchema || (body.responseMimeType && body.responseMimeType !== 'text/plain') || (body.response_format && body.response_format.type !== 'text')) return '结构化输出时不启用';
    if (body.enable_web_search || body.request_images) return '联网搜索或图片生成时不启用';
    if (body.tool_choice === 'none') return '本次请求禁止工具调用';
    if (typeof body.tool_choice === 'object') return '本次已指定其他工具，保留原调用';
    if (body.tools?.some(t => t.type !== 'function' || !t.function?.name)) return '本次含不兼容的工具类型';
    if (body.tools?.some(t => t.function.name === TOOL_NAME)) return '其他扩展已占用 output_reply';
    if (body.custom_include_body?.trim() || body.custom_exclude_body?.trim()) return '自定义请求体覆盖可能改变工具配置，请先清空';
    if (!Array.isArray(body.messages) || !body.messages.length) return '没有聊天消息';
    return '';
}

export function prepareRequest(body) {
    const next = structuredClone(body);
    delete next[MARKER];
    next.tools = [...(next.tools || []), {
        type: 'function',
        function: {
            name: TOOL_NAME,
            description: 'Submit the complete response for display. Put everything you would otherwise write as ordinary text into content, in the same order, including any thinking, planning or analysis section the instructions ask for, and all formatting, markup and state update blocks. This function only displays text and performs no external action.',
            parameters: {
                type: 'object', properties: { content: { type: 'string' } },
                required: ['content'], additionalProperties: false,
            },
        },
    }];
    next.tool_choice = next.tools.length === 1
        ? { type: 'function', function: { name: TOOL_NAME } } : 'required';
    next.parallel_tool_calls = false;
    const instruction = 'For this turn, submit your response using output_reply. content must hold the full response exactly as you would write it as ordinary text, keeping every section the instructions require (such as a thinking or planning block before the main text), the requested language, formatting and markup. Do not repeat it as ordinary text. If another tool is needed, call it first; submit the reply only after its result is available.'
        + (body.type === 'continue' || next.messages.at(-1)?.role === 'assistant' ? ' Continue directly from where the last assistant message stops; include only the new continuation.' : '');
    // Only the outgoing copy changes; no prompt is written to chat history or presets.
    const lastUser = next.messages.findLast(m => m.role === 'user');
    if (lastUser && typeof lastUser.content === 'string') lastUser.content += '\n\n' + instruction;
    else if (lastUser && Array.isArray(lastUser.content)) lastUser.content.push({ type: 'text', text: instruction });
    else next.messages.push({ role: 'user', content: instruction });
    return next;
}

export function markedRequest(input, init, origin, pending) {
    if (typeof input !== 'string' && !(input instanceof URL)) return null;
    const url = new URL(input, origin);
    if (url.origin !== origin || url.pathname !== ROUTE || url.search || init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') return null;
    let body;
    try { body = JSON.parse(init.body); } catch { return null; }
    const scope = pending.get(body[MARKER]);
    if (!scope) return null;
    pending.delete(body[MARKER]);
    delete body[MARKER];
    return { body, scope };
}
