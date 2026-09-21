# 来源与修改说明

本项目借鉴 STA1N156 及 RP-Hub 贡献者的 Gemini 正文工具提交方法。

- 来源：https://github.com/STA1N156/RP-Hub
- 版本：1.9.5；提交：cd7fb2b946f5985991b60597960852671013f36f
- 主要参考：https://github.com/STA1N156/RP-Hub/blob/cd7fb2b946f5985991b60597960852671013f36f/assets/js/api-utils.js
- 原文件 SHA-256：7110b2a2599b3f45e9b0804f0c58cbfdbc1c405092f67bdf85ecf2c7a4d5294d
- 许可：Creative Commons Attribution-NonCommercial 4.0 International（CC BY-NC 4.0）
- 许可说明：https://creativecommons.org/licenses/by-nc/4.0/

修改：独立编写 SillyTavern 扩展接入和设置界面，重新实现正文参数解码、原生 Gemini 响应转换、有限空回重试、取消处理和逐消息完成状态。未沿用 RPH 的随机串注入及按名称排除 COT 预设行为。

本扩展以 CC BY-NC 4.0 提供。安装与再分发请保留本声明和 LICENSE；不宣称 RP-Hub 作者为本扩展提供背书。

接口适配参考 SillyTavern 官方 1.19.0 提交 06bde939fb1e9c4c8d8641d810f0a916b5bce127（https://github.com/SillyTavern/SillyTavern）。安装包不包含 SillyTavern 核心源码。
