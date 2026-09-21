import { install, KEY } from './src/runtime.js';

const getContext = () => SillyTavern.getContext();
const context = getContext();
context.extensionSettings[KEY] ??= { enabled: false };
const panel = document.createElement('details');
panel.id = 'gemini-reply-settings';
panel.innerHTML = `
    <summary>Gemini 抗截断</summary>
    <label class="checkbox_label"><input type="checkbox"><span>启用 Gemini 抗截断</span></label>
    <p>仅用于 Gemini 主聊天。空回复最多尝试 3 次；仍可能截断。</p>
    <p class="gemini-reply-status" role="status"></p>`;
const checkbox = panel.querySelector('input');
const statusElement = panel.querySelector('[role="status"]');
checkbox.checked = context.extensionSettings[KEY].enabled;
statusElement.textContent = checkbox.checked ? '已开启，等待主聊天请求' : '已关闭';
checkbox.addEventListener('change', () => {
    getContext().extensionSettings[KEY].enabled = checkbox.checked;
    getContext().saveSettingsDebounced();
    statusElement.classList.remove('gemini-reply-warning');
    statusElement.textContent = checkbox.checked ? '已开启，从下一次主聊天请求生效' : '已关闭，从下一次主聊天请求生效';
});
document.querySelector('#extensions_settings')?.append(panel);

function renderMessage(index) {
    const element = document.querySelector(`#chat .mes[mesid="${Number(index)}"] .mes_block`);
    if (!element) return;
    element.querySelector('.gemini-reply-note')?.remove();
    const status = getContext().chat[index]?.extra?.[KEY];
    if (!status || ['pending', 'retrying'].includes(status.state) || (status.complete && status.mode !== 'plain')) return;
    const note = document.createElement('div');
    note.className = 'gemini-reply-note';
    note.textContent = `Gemini 抗截断：${status.detail}`;
    element.append(note);
}

install(getContext, window, (detail, warning) => {
    statusElement.textContent = detail;
    statusElement.classList.toggle('gemini-reply-warning', warning);
}, renderMessage);
for (const event of ['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED']) {
    context.eventSource.on(context.eventTypes[event], renderMessage);
}
for (const event of ['CHAT_CHANGED', 'MORE_MESSAGES_LOADED']) {
    context.eventSource.on(context.eventTypes[event], () => getContext().chat.forEach((_, i) => renderMessage(i)));
}
