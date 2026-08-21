# 短剧转绘离线语言与地区验证 Worker 设计

日期：2026-08-08

状态：已批准设计，等待书面规格审查

首期范围：`en-US`

## 1. 目标

为短剧转绘生成的语音增加一条可审计、不可伪造的输出验证链，回答三个不同问题：

1. 音频中是否存在可识别语音；
2. 实际说出的台词是否与服务端批准文本一致；
3. 实际语言和地区口音是否满足首期 `en-US` 要求。

只有三项全部通过，系统才可以写入 `detected_locale=en-US` 和
`language_verified=true`。请求中的 locale、TTS 配置中的 locale、文件名和角色资料都不能
替代输出检测结果。

本设计只定义隔离 Worker、校准和接入边界，不授权安装生产依赖、下载模型、切换线上 release、
修改生产数据库或调用付费供应商。

## 2. 已确认前提

### 2.1 当前生产环境

2026-08-08 的只读检查结果：

- x86_64，4 个 AMD EPYC 7K62 vCPU，支持 AVX2；
- 约 7.7 GiB 内存，检查时约 6.4 GiB 可用；约 2 GiB swap；
- 约 67 GiB 可用磁盘；
- Python 3.12.3、`venv`、FFmpeg 和 ffprobe 已存在；
- 没有 NVIDIA GPU；
- 当前未安装 PyTorch、torchaudio、SpeechBrain、faster-whisper、CTranslate2 或 ONNX Runtime；
- 当前生产模型配置只有 text、image、TTS 和 video，没有 STT、ASR 或 transcription 服务。

因此结论是：该机器具备用 CPU 运行隔离单并发 Worker 的基础条件，但当前并未具备可直接调用的
语言/口音检测能力。是否满足速度和内存门槛必须由目标机基准测试决定，不能依据模型说明推断。

### 2.2 当前 TTS 证据边界

现有 MiniMax 同步 TTS 路径能够保留真实 trace id、完成状态、实际 voice id 和时长，但没有可信的
输出地区检测字段。请求的 `en-US` 不能复制成 `detected_locale`。缺少独立检测时，语音资产必须
保持不可绑定或 `needs_attention`，不得伪造 verified evidence。

## 3. 方案选择

### 3.1 采用方案：隔离 Python Worker、单并发、先基准校准

Node 主服务只通过本机 IPC 调用一个独立 Python Worker。Worker 离线加载固定版本模型，单次只处理
一个音频任务，并返回结构化检测证据。模型、阈值和校准清单未通过门禁时，主服务在供应商调用和
积分冻结前拒绝生产音色任务。

选择该方案的原因：

- 与主 Node 进程隔离，模型崩溃或内存增长不会直接拖垮 Web 服务；
- 音频不需要上传第三方检测服务；
- 单并发符合当前 4 vCPU、无 GPU、约 8 GiB 内存的机器边界；
- 后续可通过语言包增加新语言，而不修改核心证据合同。

### 3.2 未采用方案

1. **把 ASR/口音模型直接嵌入 Node 进程**：依赖和内存生命周期难以隔离，生产故障域过大。
2. **直接调用外部语言检测 API**：增加音频外发、供应商不确定性和新的付费/隐私合同。
3. **只使用 Whisper 语言码**：只能证明类似 `en`、`es` 的语言级判断，不能证明 `en-US`、
   `es-MX` 等地区口音，也不能单独证明台词忠实度。

## 4. 系统边界与组件

### 4.1 Node 接入层

职责：

- 验证音频资产的租户、用户、版本、类型、MIME、路径和可读性；
- 从服务端持久数据取得批准台词、目标 locale、TTS provider/config pin 和真实 provider task id；
- 在供应商调用前检查 Worker、模型和校准清单健康状态；
- 在 TTS 完成后调用 Worker；
- 校验 Worker 返回的模型 hash、音频 hash、语言包版本和校准 manifest hash；
- 按验证结果原子写入 voice evidence、资产状态和积分状态。

Node 不负责推断语言或口音，不接受客户端提交检测结果或阈值。

### 4.2 隔离 Python Worker

职责：

- 只读取经过 Node 授权且位于允许根目录内的本地音频；
- 用 FFmpeg 解码为检测模型要求的单声道 PCM；
- 执行语音活动检查、ASR/语言识别、台词对齐和地区口音分类；
- 返回检测数值、模型身份和可审计 hash；
- 不写业务数据库，不调用外部网络，不决定积分和资产终态。

Worker 通过 Unix domain socket 提供本机接口；Windows 测试环境可用绑定到 loopback 的等价接口。
生产不开放公网端口。

### 4.3 模型与语言包仓库

模型文件和校准清单位于 release 之外的只读受控目录。部署时显式安装，运行时禁止自动下载。
每个文件都必须固定：

- 模型名称、来源、版本或 revision；
- 许可证审查结果；
- 文件 SHA-256；
- 推理运行时版本；
- 对应校准 manifest SHA-256。

Worker 启动时逐项校验；任一缺失或 hash 不符即不健康。

## 5. 首期 en-US 检测流水线

### 5.1 语音活动与输入规范化

- 输入必须是可读的 `audio/*` 资产，并与本次真实 TTS 调用绑定；
- 解码为 16 kHz、单声道 PCM，计算原始文件和规范化音频 SHA-256；
- 静音、无语音、过短或无法解码的输入直接返回未验证；
- 临时 PCM 位于 Worker 专用临时目录，请求结束后清除，不进入静态资源目录。

### 5.2 ASR 与语言识别

首选 `faster-whisper` 多语言模型的 CPU INT8 路径。输出至少包含：

- 检测语言码及概率；
- 转写文本；
- 分段时间信息；
- ASR 模型 revision 和 SHA-256；
- 推理时长。

语言码必须为英语且概率达到校准 manifest 的通过阈值。阈值没有内置默认值；manifest 缺失或失效时
一律不验证。

### 5.3 台词一致性

批准台词来自服务端的本次对白快照。规范化规则包括 Unicode 规范化、大小写、标点、数字和空白，
但不得删除姓名、金额、否定词等影响语义的内容。

Worker 计算至少一种逐词错误指标和一种字符级指标。通过阈值由签名校准 manifest 提供；如果校准集
不能在规定的误接受率下给出稳定阈值，则该语言包不能启用。只做语义相似而遗漏关键字不算通过。

### 5.4 US 英语口音验证

使用独立的英语口音分类器，例如经过许可证和文件审计的 CommonAccent XLSR 英语模型。分类器必须
直接分析生成音频，不能根据 voice id、请求 locale 或台词文本推断。

通过条件：

- 分类结果为校准 manifest 定义的 US 类；
- 置信度达到独立校准集确定的阈值；
- ASR 语言、台词一致性和音频质量同时通过。

模型 README 的总体准确率不等于本项目的 US 类通过率，不能直接作为生产阈值。

## 6. Worker 接口合同

### 6.1 请求

```json
{
  "request_id": "server-generated-id",
  "audio_path": "/allowed/read-only/path/output.mp3",
  "audio_sha256": "64-hex",
  "approved_text": "Server-approved dialogue",
  "locale_pack": "en-US@1",
  "tts_invocation": {
    "provider": "minimax",
    "model": "server-pinned-model",
    "ai_service_config_id": 1234,
    "config_updated_at": "2026-08-08T00:00:00.000Z",
    "provider_task_id": "real-provider-trace-id"
  }
}
```

`audio_path`、批准台词、locale pack 和 TTS pin 都由服务端生成。客户端不能覆盖这些字段。

### 6.2 成功响应

```json
{
  "request_id": "server-generated-id",
  "status": "completed",
  "language_verified": true,
  "detected_language": "en",
  "detected_locale": "en-US",
  "transcript_sha256": "64-hex",
  "audio_sha256": "64-hex",
  "metrics": {
    "language_probability": 0.98,
    "word_error_rate": 0.04,
    "character_error_rate": 0.02,
    "accent_label": "us",
    "accent_probability": 0.93
  },
  "models": {
    "asr_revision": "pinned-revision",
    "asr_sha256": "64-hex",
    "accent_revision": "pinned-revision",
    "accent_sha256": "64-hex"
  },
  "calibration_manifest_sha256": "64-hex",
  "completed_at": "2026-08-08T00:00:00.000Z"
}
```

示例数值只说明字段形态，不是生产阈值。生产阈值只来自已批准的校准 manifest。

### 6.3 失败响应

失败必须使用稳定错误码，至少区分：输入不可读、hash 不符、无语音、ASR 低置信度、台词不一致、
口音未通过、模型缺失、校准失效、超时和内部错误。失败响应不能把请求 locale 回显成检测结果。

## 7. 状态、计费与防重

### 7.1 供应商调用前

Worker 不健康、模型 hash 不符、校准 manifest 失效或目标语言包未启用时：

- 不冻结积分；
- 不调用 TTS；
- 不创建可绑定 production voice；
- 返回明确的能力不可用状态。

### 7.2 供应商调用后

TTS 已经可能被供应商受理或扣费后，检测超时、模型崩溃、语言/口音不确定、台词不一致或本地证据
写入失败时：

- 资产和父任务进入 `needs_attention`；
- 积分 reservation 保持 held；
- 保留真实 provider task id 和已知音频审计信息；
- 禁止同幂等键和跨幂等键自动重提；
- 不把未验证音色加入 production voice 列表。

明确检测为非英语、非 US 或台词不一致，也不能自动再次调用供应商。是否退款或人工重做由人工审计
决定，避免供应商已扣费后的重复调用。

## 8. 资源隔离与安全

生产 Worker 必须满足：

- 独立 Python venv 和独立 systemd service；
- 单并发，队列上限有界；
- 无 GPU 假设，不因检测到缺少 GPU 而下载其他模型；
- 初始硬限制为 `MemoryMax=5G`、`CPUQuota=300%`；只有新的目标机基准和人工审查通过后才可调整；
- 每次请求有总截止时间，超时终止该请求但不自动重提 TTS；
- Worker 用户只读访问允许的音频和模型目录，只写专用临时目录；
- 禁止任意路径、路径穿越、符号链接逃逸和网络访问；
- 日志不记录 API key、完整台词或音频内容，只记录 request id、错误码、耗时、模型/音频 hash 和资源指标。

若基准证明 5 GiB 内存上限或主服务安全余量无法满足，则停止本机部署，改为独立推理主机；不得通过
关闭验证、降低证据要求或与 Web 服务争抢内存来上线。

## 9. 基准与校准门禁

### 9.1 性能基准

先在与生产相同的无 GPU CPU 环境运行至少 30 条短音频，每个 3、5、10、15、30 秒时长档位
至少 6 条。记录：

- 冷启动、热启动和端到端延迟；
- p50、p95、最大延迟；
- 峰值 RSS、平均 CPU、临时磁盘；
- Worker 崩溃、超时和主服务健康情况。

首轮生产门禁：单并发下峰值 RSS 不超过 4.5 GiB，主服务无重启且保留至少 1.5 GiB 可用内存；
15 秒音频热运行 p95 不超过 90 秒。任一失败就不在当前机器启用。

### 9.2 准确率校准

性能样本不能兼作准确率结论。准确率校准集至少包含 200 条合法授权且人工标注的独立音频：

- 至少 50 条 US English 正样本；
- 至少 50 条其他英语口音负样本；
- 至少 50 条非英语、静音、噪声或混合语言对抗样本；
- 至少 50 条包含姓名、数字、否定词和专有名词的台词一致性样本。

阈值选择和最终验收使用不重叠的数据子集。校准 manifest 必须记录样本集版本、模型 hash、规范化
版本、各阈值、US 类误接受率和拒绝率。若无法把非 US 样本的误接受率控制在 1% 以内，则
`en-US` 语言包不能启用。

## 10. 多语言扩展合同

底层接口从第一天使用语言包，但首期只注册 `en-US@1`。

每个新语言包必须独立提供：

- ASR 支持和实际语言识别结果；
- 对应文字体系的规范化和台词一致性指标；
- 若产品声称地区 locale，必须有对应地区/口音分类器；
- 独立校准数据、阈值 manifest、模型 hash 和许可证审查；
- 使用线上目标 TTS Key 完成一次真实生成，等待成功终态并验证音频可读取；
- 完整的失败、held、防重和可绑定性测试。

推荐扩展顺序：`en-US` 稳定后，依次评估西班牙语、德语、意大利语。Whisper 支持某种语言只代表
可以评估语言级能力，不代表已经验证 `es-MX`、`de-DE` 或其他地区 locale。没有地区分类器时，
系统最多记录检测语言，不得写 `locale_verified=true`，也不得在产品中展示为已验证生产语言。

## 11. 部署顺序

1. 在隔离目录准备固定 Python runtime、模型和校准资源，不连接生产业务流量；
2. 在目标服务器进行只读资源预检和离线性能基准；
3. 完成独立准确率校准并生成不可变 manifest；
4. 实现 Node/Worker 合同、fail-closed 状态和测试；
5. 从实时 `/opt/moli-drama/current` 创建受保护候选，经共享 release guard 审计；
6. 经用户另行批准后部署 Worker 和候选，但保持语言包 disabled；
7. 经用户另行批准后使用目标 TTS Key 做一次真实付费 `en-US` canary；
8. 验证真实音频、检测证据、积分、任务状态、预览和绑定链后，才允许启用 `en-US@1`。

每一步失败都停止，不自动进入下一步。

## 12. 验收标准

1. Worker 无网络、单并发运行，模型和校准资源 hash 不符时拒绝启动或保持不健康。
2. Node 在 reserve/TTS 前检查精确语言包健康状态；不可用时供应商调用数和 reservation 都为零。
3. 请求 locale 不能直接或间接成为 `detected_locale`。
4. 只有 ASR、台词一致性、US 口音、音频可读性和真实 provider evidence 全部通过，才写 verified voice evidence。
5. 供应商调用后的检测或本地故障进入 `needs_attention + held`，跨幂等键也不重提。
6. 租户、版本、音频路径、MIME、授权和精确 TTS config pin 在检测前后均 fail closed。
7. 基准满足内存、稳定性和延迟门槛；校准满足 US 类误接受率门槛。
8. 真实付费 canary 返回可播放音频，证据可重建，积分和任务状态一致，音色可以通过公开产品流程预览和绑定。
9. 未完成独立语言包验收的语言不会出现在生产可选目录。

## 13. 非目标

- 首期不同时上线多种语言或多个地区口音模型；
- 不在运行时下载模型；
- 不自动把 `en` 映射为 `en-US`；
- 不承诺像素级视频一致或声纹完全相同；
- 不在本设计阶段安装依赖、修改线上配置、部署、重启、写生产数据库或调用付费模型；
- 不因为检测失败而自动重做或切换 TTS 供应商。

## 14. 参考依据

- OpenAI Whisper：多语言语音识别、翻译和语言识别：<https://github.com/openai/whisper>
- Whisper 官方语言清单：<https://github.com/openai/whisper/blob/main/whisper/tokenizer.py>
- faster-whisper CPU INT8 路径：<https://github.com/SYSTRAN/faster-whisper>
- CommonAccent 英语口音模型：<https://huggingface.co/Jzuluaga/accent-id-commonaccent_xlsr-en-english>
- CommonAccent 模型列表：<https://huggingface.co/models?other=CommonAccent>
- CommonAccent 论文：<https://arxiv.org/abs/2305.18283>
