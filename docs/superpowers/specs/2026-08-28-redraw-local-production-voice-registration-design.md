# 一键转绘 owner-scoped 本地 Production Voice 登记补充设计

日期：2026-08-28

状态：设计已确认，等待书面规格批准

范围：仅本地实现、测试与审查；不下载 TTS 引擎、不调用真实供应商、不付费、不 push、不部署

## 1. 背景

当前一键转绘本地九镜验收可以完成真实素材登记、V2 分析、本地化、覆盖素材登记和审核，但角色计划要求每个角色都有同一 owner、同一版本、已生成、已审核、可读取且目标语言核验通过的 production voice。

现有正式 production voice 路径只接受真实 TTS 供应商生成证据。当前九镜素材包没有五个目标语言语音文件，而本地验收又必须保持供应商提交次数为零，因此不能用以下方式绕过：

- 把 `draft` 语音记录直接改成 `generated`；
- 把请求 locale 回写成检测结果；
- 用普通上传、占位音频或测试音冒充 production voice；
- 伪造现有 `real_generation_verified` 供应商证据；
- 放宽 character-plan、production voice 目录或语言核验门禁。

本补充设计增加一条 owner-scoped、离线、可审计的 production voice 登记路径。它只为受信任的本地 eSpeak NG Worker 产物建立独立证据分支，不改变正式供应商语音合同。

## 2. 已批准的验收边界

本地阶段必须证明：

- 目标语言对白来自当前版本已批准的本地化结果；
- 每个角色获得稳定且可复现的声线配置；
- 音频文件可读取，包含真实音轨，并通过格式、大小、时长和 SHA-256 检查；
- 独立语言 Worker 验证目标语言、对白一致性和音频质量；
- owner、版本、角色、审核和绑定状态链完整；
- 相同请求幂等，结果未知时关闭放行且不自动重试；
- 全链路不调用外部供应商、不冻结或扣除积分。

本地阶段不把以下项目作为硬门槛：

- 商业级自然度；
- 情感表演质量；
- 与真人或源角色的声音相似度。

这些质量项必须留给后续真实供应商验收。本地 eSpeak NG 语音不得宣传为真人克隆或商业成片最终配音。

## 3. 方案选择

采用 A1：固定版本 eSpeak NG 确定性 Worker。

选择原因：

- 完全离线，不需要供应商 Key 或付费请求；
- 引擎版本、二进制 SHA 和角色参数可以固定并复核；
- 适合验证目标语言、角色映射、媒体登记和状态链；
- 本阶段已经明确不以自然度作为通过条件。

本阶段不安装或下载 eSpeak NG。实现必须支持受控测试 Worker；只有后续单独安装固定版本、登记二进制哈希并执行真实离线验收后，才能声称 eSpeak NG 本机路径通过。

## 4. 设计原则

1. **服务端派生**：台词、locale、market、角色键、临时路径和核验证据均由服务端决定。
2. **证据分支隔离**：本地证据使用 `local_offline_tts`，不能写入或伪装成正式供应商的 `real_generation_verified`。
3. **先证据后放行**：合成、媒体检查和独立语言核验全部通过后，语音槽位才能进入 `generated/pending`。
4. **owner-scoped**：登记、媒体、语音槽位、审核和角色绑定必须属于同一 tenant、user 和 version。
5. **失败关闭**：缺依赖、证据不可信、CAS 冲突、超时或结果未知都不能进入 production voice 目录。
6. **最小补充**：复用现有媒体登记、语言 Worker、审核、绑定和 character-plan 合同，不另建平行角色或审核系统。

## 5. 数据模型

新增迁移 `69_redraw_local_voice_registrations.sql`，创建 `redraw_local_voice_registrations`。

建议字段：

| 字段 | 约束与用途 |
| --- | --- |
| `id` | 主键 |
| `tenant_id`、`user_id` | 非空 owner 范围 |
| `version_id` | 非空，关联 `redraw_versions` |
| `voice_redraw_asset_id` | 非空，关联当前版本 `kind='voice'` 的 `redraw_assets` 记录 |
| `source_character_key` | 服务端从语音槽位 `source_ref_json` 派生 |
| `idempotency_hash` | 服务端对幂等键做摘要，不保存明文 |
| `request_hash` | 覆盖 owner、版本、语音槽位、目标、对白摘要、配置及预期更新时间 |
| `target_locale`、`target_market` | 从版本派生 |
| `approved_text_sha256` | 已批准目标语言台词摘要 |
| `profile_key` | 服务端分配的稳定角色声线配置 |
| `engine_manifest_sha256` | 固定引擎与配置清单摘要 |
| `status` | `processing/completed/needs_attention/failed` |
| `audio_asset_id`、`audio_sha256` | 安全登记后的 owner 媒体和文件摘要 |
| `locale_evidence_sha256` | 独立语言核验证据摘要 |
| `error_code`、`error_message` | 稳定错误信息；不得包含绝对路径或台词正文 |
| `created_at`、`updated_at`、`completed_at`、`deleted_at` | 审计时间 |

唯一索引：

```text
(tenant_id, user_id, version_id, voice_redraw_asset_id, idempotency_hash)
WHERE deleted_at IS NULL
```

相同索引命中且 `request_hash` 相同，返回已有登记；`request_hash` 不同，返回幂等冲突。

## 6. 服务端对白与角色配置派生

### 6.1 台词

服务端按镜头顺序收集 `source_character_key` 对应的已批准目标语言对白：

- 忽略空白台词；
- 保持原镜头和对白顺序；
- 使用 locale pack 的正规化规则构造核验文本；
- 达不到语言 Worker 的最小语音/文本要求时返回 `REDRAW_LOCAL_VOICE_APPROVED_TEXT_INSUFFICIENT`；
- 不新增、翻译、重复或补写台词；
- 客户端不能覆盖台词。

### 6.2 声线配置

活动的本地 TTS manifest 必须列出允许的 profile，每项固定：

- eSpeak voice code；
- pitch；
- rate；
- amplitude；
- 目标 locale；
- manifest 版本与 SHA-256。

服务端对当前版本角色按稳定角色键排序，并从目标 locale 的 profile 列表依次分配。profile 数量少于角色数时能力不可用，不允许静默复用造成角色冲突。分配结果写入登记和语音证据，重复执行必须得到相同结果。

## 7. HTTP 接口

新增受保护接口：

```http
POST /api/v1/redraw/versions/:versionId/voices/:voiceAssetId/local-production-registrations
```

请求体只允许：

```json
{
  "idempotency_key": "opaque-client-key",
  "expected_updated_at": "2026-08-28T00:00:00.000Z"
}
```

未知字段直接拒绝。尤其禁止客户端提交：

- 台词、locale 或 market；
- profile、引擎参数或命令；
- 输入/输出路径；
- 音频 SHA 或媒体资产 ID；
- `language_verified`、`detected_locale` 或其他核验结论。

接口在启动 Worker 前必须验证：

- 用户已登录；
- version、voice slot 和 owner 一致；
- 目标资产确为 `kind='voice'` 且未删除；
- `expected_updated_at` 与语音槽位当前值一致；
- 当前版本本地化和对白状态允许登记；
- 本地引擎 manifest 与语言 Worker 均可信、健康且支持目标 locale。

## 8. Worker 合同

Worker 适配器必须：

- 使用固定绝对可执行文件路径；
- 在调用前计算并比对二进制 SHA-256；
- 使用参数数组启动子进程，禁止通过 shell 拼接；
- 只允许写入服务端创建的独立临时目录；
- 使用随机服务端文件名并拒绝已存在目标；
- 设置超时、最大输出字节和退出码检查；
- 不提供网络访问能力；
- 返回引擎版本、profile、manifest SHA、输出路径、输出 SHA 和完成时间。

测试 Worker 可以生成受控的真实语音 fixture，但它必须使用独立测试 manifest，不能被生产运行时信任。

## 9. 执行与状态转换

1. 校验 owner、版本、语音槽位、CAS、manifest 和语言 Worker。
2. 计算请求哈希并事务性创建 `processing` 登记。
3. 在事务外执行本地合成。
4. 服务端重新计算音频 SHA，并用媒体探测器检查：
   - MIME/容器属于允许集合；
   - 至少有一条可解码音轨；
   - 时长达到语言 Worker 最小值且不超过上限；
   - 文件大小在限制内；
   - Worker 报告 SHA 与服务端 SHA 一致。
5. 调用现有独立语言 Worker，使用服务端批准文本和目标 locale pack 核验。
6. 使用现有安全媒体登记能力创建当前 owner 的音频资产。
7. 重新检查语音槽位 CAS，在一个事务内：
   - 写入登记的音频及核验证据；
   - 将语音槽位 `voice_asset_id` 指向新媒体；
   - 合并 `local_offline_tts` 证据；
   - 将语音槽位置为 `generated`、`approval_status='pending'`；
   - 将登记置为 `completed`。
8. 后续继续使用已有流程：语音审核通过、绑定角色、角色复审、character-plan 放行。

## 10. Production voice 可信证据

现有正式供应商证据条件保持原样。production voice 目录新增第二个互斥可信分支：

```text
trusted provider evidence
OR
trusted local_offline_tts evidence
```

本地证据至少包含：

- `source = local_offline_tts`；
- `contract_version`；
- owner、version、voice slot 和角色键；
- locale、market、profile；
- engine name、engine version、binary SHA、manifest SHA；
- audio asset ID、audio SHA、duration；
- approved text SHA；
- 独立语言证据及其可信 manifest/calibration hashes；
- `language_verified=true` 且 `detected_locale === locale`；
- 登记 ID、完成状态及完成时间。

本地分支不得要求或写入 `ai_service_config_id`、provider task ID、计费信息或 `real_generation_verified=true`。两个分支必须分别验证，不能用字段拼接形成“半个供应商证据加半个本地证据”的混合通过。

## 11. 失败、清理与审计

- 合成开始前的确定失败：登记为 `failed`，不创建媒体资产。
- Worker 超时、退出结果不明或输出写入状态不明：登记为 `needs_attention`，不自动重试。
- 媒体安全登记前失败：清理本次独立临时目录。
- 媒体已登记但最终绑定或事务失败：保留媒体并由登记记录引用，状态为 `needs_attention`，禁止静默删除。
- CAS 冲突：不覆盖语音槽位，登记为 `needs_attention`。
- 所有错误均不得冻结积分、写计费流水或调用供应商。
- 日志只记录请求 ID、owner 摘要、版本/资产 ID、状态和哈希摘要；不记录台词正文、Key 或本地绝对路径。

稳定错误码至少包括：

- `REDRAW_LOCAL_TTS_NOT_READY`
- `REDRAW_LOCAL_TTS_OWNER_MISMATCH`
- `REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT`
- `REDRAW_LOCAL_TTS_IDEMPOTENCY_CONFLICT`
- `REDRAW_LOCAL_TTS_OUTPUT_INVALID`
- `REDRAW_LOCAL_TTS_VERIFICATION_FAILED`
- `REDRAW_LOCAL_TTS_RESULT_UNKNOWN`
- `REDRAW_LOCAL_TTS_CAS_CONFLICT`

## 12. TDD 与验收矩阵

### 12.1 迁移与服务

- 新表、约束和索引可重复迁移；
- owner/version/voice slot 三重隔离；
- 服务端对白与 profile 派生确定；
- 相同幂等请求复用、异参冲突；
- 无效状态和 CAS 冲突不启动 Worker；
- 未知结果不自动重试。

### 12.2 Worker 与媒体

- 二进制或 manifest SHA 不符时 fail closed；
- 命令使用参数数组且关闭 shell；
- 超时、非零退出、越界路径、无音轨、超时长、超大小和 SHA 不符均拒绝；
- 临时文件清理和已登记资产审计符合第 11 节。

### 12.3 证据与目录

- 本地证据不能冒充供应商证据；
- 正式供应商路径不发生合同回归；
- 缺少独立语言证据、证据不可信或 locale 不一致时不进入目录；
- 跨 owner 的列表、预览、审核和分配均拒绝。

### 12.4 路由

- 未登录、跨 owner、非法 ID、未知字段、伪造字段和过期 CAS 均拒绝；
- 合法请求只调用本地 Worker 和本地语言 Worker；
- 错误响应不暴露绝对路径、台词或内部命令。

### 12.5 本地完整链

使用九镜本地启动器验证：

1. 五个语音槽逐一登记；
2. 五条语音审核通过；
3. 分别绑定对应角色；
4. 角色重新审核；
5. character-plan 五个角色全部 `ready`；
6. 网络守卫覆盖单资产与批量生成路由；
7. 供应商提交计数、积分流水和生产数据库写入均为零。

测试 Worker 通过只证明接口和状态合同。真实 eSpeak NG 离线验收必须另行记录引擎安装来源、许可证、版本、二进制 SHA、manifest SHA、五个音频文件及独立语言核验结果。

## 13. 实施范围

本阶段包含：

- 迁移；
- 本地语音登记服务；
- eSpeak NG Worker 适配器；
- production voice 双分支可信证据验证；
- 受保护 HTTP 路由；
- 单元、路由、集成与安全回归测试；
- 九镜本地启动器接入五角色登记链；
- 批量生成路由的零外部调用守卫补齐。

本阶段不包含：

- 下载或安装 eSpeak NG；
- 引入 Piper 或其他神经 TTS；
- 真实供应商调用或付费；
- 自然度或情感表现验收；
- 前端产品交互扩展；
- push、PR、合并、部署或生产数据写入。

## 14. 完成标准

只有以下条件同时满足，才能宣称本补充实现完成：

- 所有新增测试先失败后通过，并保留可审计的 TDD 证据；
- 相关既有回归通过；
- 五角色测试 Worker 完整链通过；
- 外部供应商、计费和生产写入计数均为零；
- 规格审查和代码质量审查均无未解决问题；
- Git 提交只包含本补充范围，不覆盖当前未提交的九镜启动器工作。

真实 eSpeak NG 尚未安装时，只能报告“代码合同与测试 Worker 验收通过”，不能报告“真实离线引擎验收通过”或“项目已完整交付”。
