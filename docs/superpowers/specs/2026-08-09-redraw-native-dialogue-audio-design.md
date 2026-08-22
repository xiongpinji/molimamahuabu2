# 转绘原生外语对白音轨设计

## 1. 文档状态

- 日期：2026-08-09
- 状态：产品方案已确认，待实现计划与编码
- 工作树：`worktrees/redraw-r14-merge-20260809`
- 分支：`codex/redraw-r16-merge-20260809`
- 关联规格：
  - `2026-08-06-one-click-short-drama-redraw-design.md`
  - `2026-08-08-redraw-offline-locale-verification-worker-design.md`

本文扩展现有一键转绘规格。它把首选配音路径从“无声视频 + 后置 TTS”调整为
“视频模型原生声画同出”，但保留 TTS 作为用户明确选择的独立回退能力。

## 2. 已确认事实

### 2.1 Jurilu 真实工程取证

用户授权只读检查其已登录的 Jurilu 历史测试工程。工程使用的模型标签为：

`星光3.0（声画同出，多人对白，掌控叙事，全能融合）`

分镜提示词直接包含目标语言和台词，例如：

```text
用西班牙语说:<Hola, pequeño.>
用西班牙语说:<¿Te has perdido?>
```

对应分镜 MP4 的媒体合同为 H.264 视频加 AAC 双声道音轨。样本文件和抽取音频的
SHA-256 分别为：

```text
MP4  8029b07968c87df1f0082d70eabfd1995fdc9edebea8d0d429fa55d1659fa46a
WAV  b23281b0b23538925b2a61b09f34d73fa796f3e14252b667242045766360913c
```

隔离 ASR 对该样本的结果为：

```json
{
  "language": "es",
  "language_probability": 0.9355576038360596,
  "segments": [
    {
      "start": 7.63,
      "end": 10.63,
      "text": "Hola, Pequeño. ¿Te has perdido?"
    }
  ]
}
```

识别结果与提示词台词一致。该工程的音色面板显示启用音色数量为 0，因此现有证据支持：
默认路径由视频模型直接生成对白音轨，不依赖预绑定 TTS 音色。

### 2.2 官方模型能力

ByteDance 官方 Seedance 2.0 资料将其描述为统一的音视频联合生成模型，支持对白、音效、
BGM 和画面共同生成，并支持多镜头音视频输出：

- <https://seed.bytedance.com/en/seedance2_0>
- <https://seed.bytedance.com/blog/seedance-2-0-official-launch>

### 2.3 当前项目能力和缺口

项目已经具备以下底层能力：

- `video_generations.generate_audio` 字段；
- ToAPIs `seedance-2-fast` 和 `seedance-2-mini` 的 `supportsAudio=true` 能力；
- ToAPIs 请求体 `generate_audio` 传递；
- 视频配置、模型、能力证据和配置更新时间的精确 pin；
- 隔离 Python Worker、固定 ASR/口音模型和单并发运行条件。

当前转绘链仍有三个产品级缺口：

1. `redrawGenerationService` 未从本地化对白生成服务端提示词，也未强制
   `generate_audio=true`；
2. 当前合成只允许 `audio_mode=replace`，FFmpeg 明确丢弃视频输入音轨后混入 TTS；
3. 语言目录没有“目标模型 + 目标 Key + 原生音频 + 目标语言”的真实付费证据，因此仍应
   fail closed，不能仅凭配置列表开放语言和地区。

## 3. 目标和非目标

### 3.1 目标

1. 每个分镜由视频模型一次生成画面、环境声和目标语言对白。
2. 台词、说话人、顺序、时间窗口和目标语言全部来自服务端已批准版本。
3. 生成后验证音轨存在、语言正确、台词相符，并保留完整审计证据。
4. 最终合成保留各分镜原生音轨，不再要求先生成 TTS。
5. 原生音轨结果不确定时不自动重提视频、不自动调用 TTS、不自动第二次扣费。
6. TTS 仅作为用户明确选择、单独报价、单独确认的回退路径。

### 3.2 非目标

- 不承诺视频模型每次都能保持固定角色音色。
- 不把请求 locale 复制成检测 locale。
- 不用 ASR 文本一致性替代嘴型同步的人工验收。
- 不在没有地区口音分类器时声称 `es-MX`、`es-ES` 等地区级能力已验证。
- 不在本设计阶段调用真实供应商、修改生产配置、制作候选或部署。

## 4. 方案选择

### 4.1 采用方案：原生声画优先，异常进入人工确认

主链如下：

```text
已批准本地化对白
  -> 服务端编译分镜声画提示词
  -> 精确模型配置 + generate_audio=true
  -> 视频模型一次生成 MP4
  -> 媒体/语言/台词验证
  -> 保留原生音轨合成
```

任一供应商提交后不确定、音轨缺失、语言错误、台词不匹配或本地验证失败，都进入
`needs_attention`，保持供应商任务和积分预留的审计关系。系统不得自动调用 TTS。

### 4.2 未采用方案

#### 自动 TTS 回退

不采用。它可能在视频供应商已经受理或扣费后再次产生 TTS 费用，并可能破坏模型原生嘴型、
停顿、环境声和对白之间的同步关系。

#### 继续以 TTS 为主链

不采用。它不能达到已确认竞品的声画同出效果，且会继续要求角色音色先完成生产绑定。

## 5. 产品交互

### 5.1 语言和地区入口

语言目录继续由服务端生成。某一选项可用必须同时满足：

1. 精确视频配置处于 active、verified；
2. 精确模型已启用计费；
3. 能力证据声明 `supportsAudio=true`；
4. 已使用该配置对应的目标 Key 完成一次真实原生外语对白生成；
5. 结果达到 completed，MP4 可读且包含音轨；
6. 隔离 Worker 验证目标语言和批准台词；
7. 证据与 `config_id`、`config_updated_at`、provider、model、task id 和 artifact hash
   精确绑定。

只验证语言级能力时，界面可以展示“西班牙语”，但地区保持不可选或显示“地区待验证”。只有
地区/口音分类器通过校准后，才开放具体地区。

### 5.2 分镜状态

每个分镜至少展示：

- 原生声画生成状态；
- 音轨是否存在；
- 检测语言及置信度；
- 台词一致性结果；
- `needs_attention` 的具体原因；
- “试听原生音轨”和“人工确认”；
- “改用 TTS”独立操作及其新报价。

“改用 TTS”不能由系统自动触发，也不能复用旧视频报价确认。用户必须看到新的
“本次预计扣除 X 积分”并再次确认。

### 5.3 一键流程门禁

原生声画模式不再要求先完成角色音色绑定或 dialogue TTS task。进入最终合成的条件变为：

- 所有使用中分镜视频 completed；
- 每个分镜原生音频验证通过，或用户已明确确认该分镜；
- 没有未处理的 `needs_attention`；
- 分镜、视频生成、验证证据和版本快照未发生漂移。

## 6. 服务端提示词合同

### 6.1 数据来源

提示词只能由服务端从以下已持久化数据编译：

- 目标版本的 locale 和已验证语言能力；
- 分镜的时间范围、动作、景别和运镜；
- `localized_dialogue_json` 中已批准的说话人、台词、顺序和时间窗口；
- 已批准角色、场景和物品资产引用。

客户端不得直接覆盖对白文本、目标语言、`generate_audio`、模型、provider、config id、价格或
能力证据。

### 6.2 编译格式

编译器保留模型可理解的简明结构，例如：

```text
写实风格短剧片段，电影级画质，自然光影。
不要出现任何字幕，不允许添加背景 BGM。
角色：@Valeria。
场景：@迷雾森林。
7.6-8.8 秒，@Valeria 用西班牙语说:<Hola, pequeño.>
8.8-10.7 秒，@Valeria 用西班牙语说:<¿Te has perdido?>
保留真实环境声；对白清晰；说话顺序、情绪和停顿按上述时间执行。
```

输出提示词必须和对白快照一起计算稳定 hash。对白、角色、目标语言、时间窗口或模型 pin 任何
一项改变，都使旧报价和旧幂等键失效。

### 6.3 时长预检

提交前必须确认：

- 全部对白窗口包含在分镜时间范围内；
- 台词预计可说时长不超过窗口阈值；
- 对话顺序无非法重叠；
- 模型支持目标分镜时长、分辨率和参考素材数量；
- 精确模型能力支持 `generate_audio=true`。

确定性失败必须发生在 reserve 和供应商调用之前。

## 7. 视频生成合同

原生声画分镜使用现有 `video_generations`，不新建第二套视频任务表：

- `generate_audio=1`；
- `request_snapshot.generate_audio=true`；
- `request_snapshot` 保存服务端 prompt hash、dialogue snapshot hash、locale、model、
  `ai_service_config_id` 和 `config_updated_at`；
- 继续使用现有 reservation、provider task、恢复、防重和 pinned config 合同；
- 同一分镜、版本、对白快照和精确配置只有一个 active/unknown generation。

供应商提交开始后发生网络、状态、下载、审计或本地媒体异常，必须按不确定结果处理，不能退款后
自动重提。

## 8. 原生音轨验证合同

### 8.1 媒体门禁

completed 结果成为可合成分镜前，必须验证：

- 本地 MP4 是 owner/version/shot 绑定的可读普通文件；
- 文件 hash 已记录；
- 存在视频流；
- 存在非空音频流，codec、channels、sample rate、duration 可读；
- 音频时长与视频时长在允许误差内；
- 结果不是只有静音、损坏音轨或不可解码占位文件。

### 8.2 语言和台词门禁

FFmpeg 从 MP4 抽取单声道 16 kHz PCM，仅在隔离 Worker 中验证：

1. VAD 确认存在有效语音；
2. 多语 ASR 检测语言；
3. ASR 转写与服务端批准台词做规范化相似度比较；
4. 记录各段时间码、语言概率、文本 hash、模型 revision 和模型树 hash。

请求 locale 只能作为期望值，不能成为检测结果。语言正确但地区分类不可用时，只能写
`language_verified=true`，不能写 `locale_verified=true`。

### 8.3 嘴型和多人对白

首版不使用低可信自动指标宣称嘴型已验证。真实付费 canary 必须人工检查：

- 说话角色正确；
- 嘴型与语音基本同步；
- 多人对白顺序正确；
- 没有额外台词、错人说话或明显串音。

自动验证通过但人工嘴型检查失败时，状态仍为 `needs_attention`。

## 9. 合成合同

### 9.1 新音频模式

在现有 `replace` 基础上新增 `native`：

- `native`：每个视频输入同时读取视频流和原生音频流，按分镜顺序连接；
- `replace`：保留现有后置 TTS 合成行为，仅用于用户明确选择的回退版本。

原生模式不能执行当前的 `concat ... a=0` 加 TTS `amix` 路径。它必须连接每个分镜的音视频流，
统一必要的采样率、声道布局和时间基，并验证最终导出仍包含可读音轨。

### 9.2 原生模式输入门禁

每个输入必须绑定：

- shot id；
- video generation id；
- provider task id；
- MP4 hash；
- native audio validation hash；
- approved dialogue snapshot hash；
- exact config pin。

任一输入漂移时，旧 composition request hash 失效，不能继续合成。

### 9.3 字幕

字幕继续来源于批准台词和时间码，不从模型音轨反向生成最终字幕。ASR 只用于验证，不成为内容
事实源。用户可选择不烧录字幕；不得因为视频模型偶然生成屏幕文字而将其视为字幕资产。

## 10. 状态、计费和失败策略

### 10.1 供应商调用前

能力、配置 pin、语言包、对白快照、时长或输入不合法时：

- provider calls = 0；
- reservation = 0；
- 返回可修正错误。

### 10.2 供应商调用后

供应商可能已受理后出现以下情况：

- submit/poll/download 状态不确定；
- MP4 或音轨不可读；
- 音轨缺失或近似静音；
- 语言错误；
- 台词不匹配；
- 隔离 Worker 超时或模型异常；
- 本地证据、资产注册或结算写入异常。

统一进入 `needs_attention`，reservation 保持 held 或按现有已确认结算状态保守保留，禁止自动
重提。同一 shot/version/dialogue/config snapshot 即使更换 idempotency key，也不能绕过 ambiguous
duplicate guard 创建第二个供应商任务。

### 10.3 显式 TTS 回退

用户点击“改用 TTS”后：

1. 生成独立 TTS 回退报价；
2. 显示新的积分提示；
3. 用户再次确认；
4. 创建独立 reservation、幂等键和 TTS 审计；
5. 仅回退导出使用 `audio_mode=replace`；
6. 不删除、不覆盖原生视频或原生音轨证据。

## 11. 能力证据

新增 `native_dialogue_audio` 能力证据，至少包含：

```json
{
  "contract": "redraw-native-dialogue-audio-v1",
  "config_id": 16,
  "config_updated_at": "ISO-8601",
  "provider": "toapis",
  "protocol": "toapis_video",
  "model": "seedance-2-fast",
  "target_language": "es",
  "target_locale": null,
  "provider_task_id": "真实供应商任务 ID",
  "terminal_status": "completed",
  "artifact_id": 123,
  "artifact_sha256": "64-hex",
  "audio_stream": {
    "codec": "aac",
    "channels": 2,
    "sample_rate": 44100
  },
  "verification": {
    "audio_sha256": "64-hex",
    "detected_language": "es",
    "language_probability": 0.93,
    "transcript_sha256": "64-hex",
    "dialogue_similarity": 0.9,
    "asr_revision": "固定 revision",
    "asr_tree_sha256": "64-hex"
  },
  "human_review": {
    "speaker_order": "passed",
    "lip_sync": "passed",
    "reviewed_at": "ISO-8601"
  }
}
```

证据不能保存密钥。`config_updated_at`、endpoint 或 key 发生变化后，旧证据不能被重新解释为新配置
已验证；必须重新完成真实生成。

## 12. 多语言边界

多语 ASR 可以为英语、西班牙语、法语、德语、葡萄牙语、日语、韩语等提供语言级检测，但每种
语言仍需独立的目标 Key 真实生成证据和阈值校准。

语言级开放顺序：

1. 用固定测试台词制作小型授权校准集；
2. 目标模型真实付费生成；
3. 验证媒体、语言和台词；
4. 人工检查角色、嘴型和多人对白；
5. 记录精确配置证据；
6. 才开放该语言。

地区级开放必须额外具备地区/口音分类器和对抗样本校准。没有该能力时，语言可用、地区为空是
正确的 fail-closed 行为，而不是前端填充缺陷。

## 13. 测试和验收

### 13.1 自动化测试

至少覆盖：

1. 服务端对白编译顺序、角色、时间和目标语言；
2. 客户端覆盖 prompt、locale、generate_audio、config 或价格被拒绝；
3. 不支持音频的模型在 reserve/provider 前失败；
4. `generate_audio=true` 持久化、恢复和精确配置 pin；
5. completed MP4 无音轨、静音、损坏、错语言、错台词进入 `needs_attention`；
6. Worker 超时或异常不退款、不自动重提；
7. 跨 idempotency key 的 ambiguous duplicate guard；
8. native composition 保留每镜音轨，replace composition 保留现有 TTS 行为；
9. 合成输入 hash 漂移被拒绝；
10. 显式 TTS 回退必须重新报价和确认；
11. 语言能力证据与 config id、updated_at、model、task 和 artifact 绑定；
12. 生产目录仅返回通过真实证据的语言选项。

### 13.2 目标机基准

已完成隔离模型兼容性基线：

```text
faster-whisper-small: 13.030731 s
CommonAccent:         14.808719 s
peak RSS:             2712629248 bytes
single concurrency:   passed
offline network block: passed
```

模型清单 SHA-256：

```text
b3f2ae06d8a17b860ea4291babb1234dc7c0cf84bf10282e904054ece5454ff8
```

已发现兼容性脚本需修复导入顺序：它必须先导入 SSL/异步依赖，再安装 Python socket/DNS 断网钩子。
本次通过等价的预加载方式验证模型本身可离线运行；正式实现必须为该缺陷增加回归测试。

### 13.3 真实付费验收

功能进入语言目录和生产候选前，必须使用当前生产精确配置完成一次真实付费同链：

1. 选择一个授权的 4 至 15 秒分镜和短目标台词；
2. 使用目标 Key、精确 config 和 `generate_audio=true` 提交一次；
3. 等待真实 completed；
4. 下载并验证 MP4、视频流、音频流、时长和 hash；
5. 隔离 ASR 验证语言和台词；
6. 人工检查人物、嘴型、对白顺序和环境声；
7. 合成 native 导出并验证最终音轨仍存在；
8. 核对报价、冻结、结算、任务、资产和审计链；
9. 再执行一次明确失败案例，证明不会自动 TTS 或二次扣费；
10. 写入不含密钥的能力证据后才开放语言选项。

模型列表、连接测试、mock、单元测试、前端下拉框或供应商 completed 状态都不能单独替代上述验收。

## 14. 发布约束

- 实现必须先在独立工作树完成测试、审查和构建。
- 真实付费验收需要单独执行，不能在普通单元测试中触发。
- 制作候选前重新 SSH 读取实时 `/opt/moli-drama/current`，从该 release 克隆候选。
- 合并仅允许审计过的文件差异，不能用本工作树整体覆盖线上 release。
- 候选必须通过共享 release guard、部署锁、CAS、备份、活动任务、健康、日志和 AI 音乐隔离检查。
- 生产切换需要另行批准；本规格批准不等于部署批准。

## 15. 已锁定决策

1. 原生声画模型是转绘对白主链。
2. 原生音轨异常进入 `needs_attention`，不自动调用 TTS。
3. TTS 是用户显式选择、单独报价和确认的回退路径。
4. 原生模式只产生一次视频模型供应商提交；不确定结果禁止自动重提。
5. 最终 native 合成保留视频内嵌音轨，不执行 TTS replace。
6. 请求 locale 不得成为检测 locale。
7. 语言能力和地区能力分开验证、分开开放。
8. 精确模型配置必须先通过目标 Key 真实付费原生对白生成，才能进入生产语言目录。
9. 本规格不授权编码以外的真实供应商调用、生产配置修改、候选制作或部署。
