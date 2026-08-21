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
- 初次接入实测到 2 张参考图；后续容量验证使用 9 张可区分参考图一次成功，因此生产能力声明提高为 `maxReferences: 9`。未实测 10 张及以上，不作更高承诺。

## 九图参考容量复测

- 输入为 9 张独立 PNG，每张使用不同颜色并带白色编号 1–9；汇总图 SHA-256 `91178bc41f15d6a60e651c6ee32768b5bd402f88f8df8068e1114a2c84a18ed6`，文件为 `C:\Users\canqu\Documents\茉莉妈妈2\artifacts\provider-validation\rehdasu-gpt-image-2-reference-sheet-9-20260805.png`。
- `POST /v1/images/generations` 的 `image` 数组一次传入全部 9 张，返回 HTTP 200 和可解码 `b64_json`；未触发数量限制，因此没有继续消耗额度测试 6 张。
- 结果为 1024×1024 PNG、1,196,220 字节，SHA-256 `0f6660662e0a0218b0ee435bb9880c90eb1a1a0011b571bf61aba956b700db2c`，文件为 `C:\Users\canqu\Documents\茉莉妈妈2\artifacts\provider-validation\rehdasu-gpt-image-2-output-9-references-20260805.png`。
- 视觉复核确认结果包含完整的 1–9 九枚独立徽章；颜色并未逐张严格锁定，因此结论是“支持 9 张参考输入”，而不是“绝对忠实复制每张参考”。
- 修改生产能力前创建备份 `database-20260805T044521370Z`，完整性为 `ok`；画布目录随后回读 `maxReferences: 9`、40 积分。
- 容量更新后的实时 `current` 已被并行会话推进到 `/opt/moli-drama/releases/script-analysis-description-20260805T1233CST`；该最新 release 仍保留 `imageMimeFromBase64` 修复和 `canvas-credit-callout-v1`，共享数据库目录继续回读 `maxReferences: 9`。

## 生产交付证据

- 生产候选从实时 `/opt/moli-drama/current` 克隆，候选路径为 `/opt/moli-drama/releases/rehdasu-gpt-image2-20260805T121927`；发布前源文件 SHA-256 与本地提交一致。
- 候选专项测试 7/7、`preflight:production`、SQLite `quick_check` 和 `canvas-credit-callout-v1` 源码/构建审计全部通过。
- 发布前备份 `database-20260805T042628094Z` 完整性为 `ok`，SHA-256 `ac7c0b71a72a5d0f7e50a61b64098e510e47777be090b979778e754cc250ca4d`。
- 共享门禁成功将生产从 `/opt/moli-drama/releases/icreat-reference-roles-livebase-20260805T085755CST` 切换到上述候选。
- 生产应用链路真实复测：默认文字模型解析为 `gpt-5.6-terra` 并返回预期文本；`imageClient` 使用 `gpt-image-2` 生成 1024×1024 PNG、740,003 字节，SHA-256 `c2813efd5af73aa76959deef67b300506243ededaf1908b1ef039c4be0600796`，文件为 `/opt/moli-drama/shared/validation/rehdasu-gpt-image-2-app-path-20260805.png`。
- 画布目录回读 `GPT Image 2`：40 积分、`maxReferences: 9`；文字默认配置回读为 `GPT-5.6 Terra`。
- 使用现有登录会话重新打开生产画布 `/canvas/48`，图片节点编辑器下拉列表实际出现 `GPT Image 2`，提交值为 `gpt-image-2`；只读检查未切换或保存用户节点。
- 被替换的旧文字 Key 指纹在活动配置中计数为 0；新 Key 只出现在 Rehdasu 文字和图片两个目标配置，其他供应商 Key 指纹与切换前一致。发布前备份按回滚制度保留，不作为活动配置读取。
- 发布后 `moli-drama.service` 为 `active`、`NRestarts=0`、内部 `/health` 正常、近期错误计数 0；四类生成任务均为 0；AI 音乐进程 PID `206874`、`206895` 未变化。

## 验收门

- [x] 新 Key 的模型列表包含两个目标模型。
- [x] Terra 真实文字推理通过。
- [x] GPT Image 2 文生图、单图图生图、双图多参考全部通过。
- [x] GPT Image 2 九图参考容量真实生成通过，画布上限更新为 9。
- [x] MIME 回归测试先失败、修复后通过。
- [x] 后端专项、全量测试和前端生产构建通过。
- [x] 双轴复审通过。
- [x] 从实时生产 `current` 构建候选并通过共享发布门禁。
- [x] 生产默认文字模型回读为 Terra，GPT Image 2 出现在画布目录。
- [x] 被替换的旧文字配置 Key 已清除，其他供应商 Key 未变。
- [x] 健康、队列、数据库、日志和 AI 音乐隔离检查通过。
