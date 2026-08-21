# Rehdasu Terra 与 GPT Image 2 接入

## 目标

- 使用新 Key 验证 `https://rehdasu.cn/v1` 的 `gpt-5.6-terra` 真实文字推理。
- 将 `gpt-5.6-terra` 替换为生产默认文字推理模型。
- 在真实生成和结果文件验证通过后接入 `gpt-image-2`。
- 图片能力必须分别验证文生图、单图图生图和多图参考。
- 新配置生效后清除被替换的旧文字配置 Key；不删除或改写其他供应商 Key。
- 不在源码、测试、任务文档、日志或前端保存任何 Key。

## 接口与安全合同

- 复用现有 OpenAI 兼容深模块：文字使用 `/chat/completions`，图片使用 `/images/generations`。
- 模型列表和只读连接测试只用于确认候选；不能代替真实生成。
- 图片返回的 MIME 必须以实际文件魔数为准，不能假设供应商遵守请求的 `output_format`。
- 画布只展示已验证、已启用且配置了正整数积分价格的模型。
- 保留 `canvas-credit-callout-v1` 受保护积分卡片。

## 实测证据（不含密钥）

- `/models` 返回精确模型代码 `gpt-5.6-terra` 与 `gpt-image-2`。
- Terra 真实推理成功：请求与返回模型均为 `gpt-5.6-terra`，正常停止，返回预期文本且包含 usage。
- 三个图片任务均为 `POST /v1/images/generations` 同步任务，响应直接返回 `data[0].b64_json`，接口没有提供异步任务 ID。
- GPT Image 2 文生图成功：请求不带 `image`，结果为 1024×1024 PNG、699,425 字节，SHA-256 `37806a71dc4f7af02592e5ac08341a2cffb19a9c5f8aee0ca2086ecce466c931`；文件为 `C:\Users\canqu\Documents\茉莉妈妈2\artifacts\provider-validation\rehdasu-gpt-image-2-20260805.png`。
- GPT Image 2 单图图生图成功：请求的 `image` 数组只有上述文生图结果，输入 SHA-256 为 `37806a71dc4f7af02592e5ac08341a2cffb19a9c5f8aee0ca2086ecce466c931`；结果保留蓝圆与橙方，并按提示改变背景和阴影；结果为 1024×1024 PNG、764,929 字节，SHA-256 `3a8d561a612ff60f3ce09a18d0db30bae698264264e84876587672286d0cbe6d`；文件为 `C:\Users\canqu\Documents\茉莉妈妈2\artifacts\provider-validation\rehdasu-gpt-image-2-image-to-image-20260805.png`。
- GPT Image 2 双图多参考成功：请求的 `image` 数组依次包含文生图结果（SHA-256 `37806a71dc4f7af02592e5ac08341a2cffb19a9c5f8aee0ca2086ecce466c931`）和 `frontweb/public/moli-mama-logo.png`（SHA-256 `afa81252ed79966b2d439c472987d1153d0082e4de7db279f54fb0c8886cc7bb`）；结果同时保留第一张的几何构图，并采用第二张的粉色柔和插画风格；结果为 1024×1024 PNG、1,590,356 字节，SHA-256 `8b97f4c30fcecf0635228a02713a86b94ad8764655e5ebfe2e089b2651fdb91f`；文件为 `C:\Users\canqu\Documents\茉莉妈妈2\artifacts\provider-validation\rehdasu-gpt-image-2-multi-reference-20260805.png`。
- 三次图片请求都要求 JPEG，但供应商实际返回 PNG；接入前必须修复现有 MIME 推断。

## 证据复核

- `Get-FileHash -Algorithm SHA256` 已逐一回读上述三个结果文件和两份参考输入，结果与记录一致。
- `sharp(...).metadata()` 已逐一成功解码三个结果文件，均为 `png|1024|1024`；这同时验证结果文件不是只有扩展名的空文件或损坏文件。
- 视觉检查分别确认：文生图包含指定几何元素；单图图生图保留输入构图并完成背景/阴影变更；双图结果同时采用两个输入中明确可区分的构图与风格特征。
- 本轮只实测到 2 张参考图，因此生产能力声明固定为 `maxReferences: 2`，不承诺更多张数。

## 验收门

- [x] 新 Key 的模型列表包含两个目标模型。
- [x] Terra 真实文字推理通过。
- [x] GPT Image 2 文生图、单图图生图、双图多参考全部通过。
- [x] MIME 回归测试先失败、修复后通过。
- [x] 后端专项、全量测试和前端生产构建通过。
- [ ] 双轴复审通过。
- [ ] 从实时生产 `current` 构建候选并通过共享发布门禁。
- [ ] 生产默认文字模型回读为 Terra，GPT Image 2 出现在画布目录。
- [ ] 被替换的旧文字配置 Key 已清除，其他供应商 Key 未变。
- [ ] 健康、队列、数据库、日志和 AI 音乐隔离检查通过。
