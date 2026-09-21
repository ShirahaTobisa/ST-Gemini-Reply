// Incremental decoder for exactly {"content":"..."}. Never exposes JSON syntax.
export class ContentDecoder {
    raw = '';
    text = '';
    position = 0;
    stage = 0;
    error = '';

    feed(fragment) {
        const before = this.text.length;
        this.raw += fragment;
        while (!this.error && this.position < this.raw.length) {
            const rest = this.raw.slice(this.position);
            const char = rest[0];
            if (this.stage !== 4) {
                if (/[ \t\r\n]/.test(char)) { this.position++; continue; }
                const token = ['{', '"content"', ':', '"', '', '}'][this.stage];
                if (!token) { this.error = '工具参数含多余字段或字符'; break; }
                if (rest.length < token.length && token.startsWith(rest)) break;
                if (!rest.startsWith(token)) { this.error = '工具参数必须只含字符串 content'; break; }
                this.position += token.length;
                this.stage++;
                continue;
            }
            if (char === '"') { this.position++; this.stage++; continue; }
            let value = char;
            let size = 1;
            if (char === '\\') {
                if (rest.length < 2) break;
                const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
                if (rest[1] === 'u') {
                    if (rest.length < 6) break;
                    if (!/^[0-9a-f]{4}$/i.test(rest.slice(2, 6))) { this.error = 'Unicode 转义无效'; break; }
                    value = String.fromCharCode(parseInt(rest.slice(2, 6), 16));
                    size = 6;
                } else if (Object.hasOwn(escapes, rest[1])) { value = escapes[rest[1]]; size = 2; }
                else { this.error = '工具参数含非法转义'; break; }
            } else if (char.charCodeAt(0) < 32) { this.error = '工具参数含未转义控制字符'; break; }
            const code = value.charCodeAt(0);
            if (code >= 0xD800 && code <= 0xDBFF) {
                const tail = rest.slice(size);
                if (!tail || (tail.startsWith('\\') && tail.length < 6)) break;
                const escaped = tail.startsWith('\\u') && /^[0-9a-f]{4}$/i.test(tail.slice(2, 6));
                const low = escaped ? parseInt(tail.slice(2, 6), 16) : tail.charCodeAt(0);
                if (low < 0xDC00 || low > 0xDFFF) { this.error = 'Unicode 字符不完整'; break; }
                value += String.fromCharCode(low);
                size += escaped ? 6 : 1;
            } else if (code >= 0xDC00 && code <= 0xDFFF) { this.error = 'Unicode 字符不完整'; break; }
            this.text += value;
            this.position += size;
        }
        return this.text.slice(before);
    }

    get complete() { return !this.error && this.stage === 6 && this.position === this.raw.length; }
}
