# 一键转绘 owner-scoped 补充对白审批合同设计

日期：2026-08-28

状态：书面规格草案，等待用户批准后再实施

范围：仅本地实现、测试与审查；不调用真实供应商、不付费、不 push、不部署、不写生产数据库

## 1. 背景与问题

一键转绘九镜本地完整链要求五个角色都完成 production voice 登记。现有本地语音登记只允许服务端从当前版本已完成、已放行的本地化结果中提取目标语言对白。该边界是正确的，因为 V2 本地化合同禁止：

- 给无源对白镜头新增对白；
- 改变源对白 turn 数量；
- 改变 speaker、时间码或 overlap；
- 在本地化 turn 中增加未知来源字段。

Rafael 在第 6 镜出现，但源对白和本地化对白都没有他的台词。用户已经单独批准英文补句：

```text
Welcome home, son.
```

该句必须标记为：

- `source_translation=false`；
- `approval_source=owner_http`；
- `approval_decision=approved`；
- 只用于本地 production voice 登记；
- 不得宣称为源对白翻译，不得回写或覆盖源对白、本地化对白。

当前前端 fixture 中的补句不是持久化授权证据，不能直接被后端语音登记信任。必须新增独立、owner-scoped、可撤销、可审计的补充对白审批合同。

## 2. 设计目标

本设计必须同时满足：

1. 补充对白与 V2 本地化结果严格隔离，不放宽任何本地化不变量。
2. 只有已登录 owner 可以为自己的当前版本、自己的镜头和自己的角色语音槽批准补句。
3. 补句必须绑定稳定镜头、可见角色、语音槽、本地化决策、facts hash、policy version、locale 和 market。
4. 本地语音登记接口仍不得接收台词；它只能读取服务端持久化的活动审批。
5. 审批撤销、内容漂移、owner 漂移、镜头或语音槽 CAS 漂移均 fail closed，且不得启动本地 TTS Worker。
6. 补充对白正文不得出现在登记响应、日志、错误、证据对象或 request hash 明文中。
7. Task 8 必须通过真实 router、认证与 tenant header 创建审批和登记，不允许 DB proxy 或直接 SQL 伪造完成状态。

## 3. 明确边界

### 3.1 v1 包含

- 独立的补充对白审批表；
- 受保护的创建审批接口；
- 受保护的撤销审批接口；
- 本地 production voice 登记对活动审批的只读消费；
- production voice 本地证据对审批状态和哈希的复核；
- 迁移、服务、路由、安全、幂等、漂移和 Task 8 E2E 测试。

### 3.2 v1 不包含

- 修改 `source_dialogue_json` 或 `localized_dialogue_json`；
- 修改 V2 本地化 turn 数、speaker、时间码或 silent-shot 规则；
- 把补句加入字幕、视频音轨、最终导出、供应商 prompt 或真实生成请求；
- 多人协作审批、pending 队列、管理员代批或批量审批；
- 同一镜头、同一角色的多条独立活动补句；
- 真实 eSpeak NG 安装或真实外部供应商调用；
- push、PR、合并、部署或生产数据库写入。

v1 每个“版本 × 镜头 × 角色语音槽”最多一条活动补句。需要改文案时先撤销旧审批，再用新幂等键创建新审批。多句内容如确有需要，作为一条已批准文本保存；未来若需要逐句时间码，再升级合同版本。

## 4. 不可破坏的既有合同

1. `/local-production-registrations` 请求体保持 exact keys：

   ```json
   {
     "idempotency_key": "opaque-client-key",
     "expected_updated_at": "2026-08-28T00:00:00.000Z"
   }
   ```

2. 该登记接口继续拒绝客户端提交 text、locale、market、profile、路径、SHA、evidence 或验证结论。
3. 普通本地化对白仍只来自 completed + advance 的当前本地化任务。
4. `local_offline_tts` 与正式供应商 `real_generation_verified` 保持互斥，禁止混合证据。
5. 撤销补充审批不得删除已完成登记、音频资产或历史审计，但必须阻止基于该审批的新登记、新重放执行和新的 production voice 信任判定。

## 5. 数据模型

新增迁移：

```text
70_redraw_supplemental_dialogue_approvals.sql
```

新增表：

```text
redraw_supplemental_dialogue_approvals
```

### 5.1 字段

| 字段 | 约束与用途 |
| --- | --- |
| `id` | 主键 |
| `contract_version` | 固定为 `redraw-supplemental-dialogue-approval-v1` |
| `tenant_id`、`user_id` | 非空 owner 范围 |
| `work_id`、`version_id` | 当前作品和版本 |
| `redraw_shot_id` | 当前版本的 `redraw_shots.id` |
| `shot_id` | 从 `redraw_shots.shot_id` 派生的稳定镜头 ID |
| `voice_redraw_asset_id` | 当前版本 `kind='voice'` 的角色语音槽 |
| `source_character_key` | 从语音槽 `source_ref_json.source_ref` 派生 |
| `target_locale`、`target_market` | 从当前版本派生 |
| `target_text` | owner 明确批准的正文，仅供服务端 TTS 合成 |
| `target_text_sha256` | trim 后 UTF-8 文本 SHA-256 |
| `source_translation` | 固定为 `0`，数据库 CHECK 禁止其他值 |
| `localization_task_id` | 创建审批时的 completed localization task |
| `localization_decision_sha256` | 当前 localization decision 的规范化摘要 |
| `facts_hash`、`policy_version` | 创建审批时的事实和策略快照 |
| `dialogue_context_sha256` | 镜头、可见角色、源/本地化对白、locale、market、facts、policy 的规范化摘要 |
| `approval_evidence_sha256` | 创建时持久化的完整审批证据 SHA-256；读取时必须重算并精确比对 |
| `idempotency_hash`、`request_hash` | 创建审批的幂等和完整请求摘要 |
| `approval_source` | 固定为 `owner_http` |
| `approval_decision` | 固定为 `approved` |
| `status` | `active` 或 `revoked` |
| `approved_by`、`approved_at` | 当前登录 owner 和审批时间 |
| `revocation_idempotency_hash`、`revocation_request_hash` | 可空；撤销幂等摘要 |
| `revoked_by`、`revoked_at` | 可空；撤销审计 |
| `created_at`、`updated_at`、`deleted_at` | 审计时间 |

外键至少覆盖 version、shot 和 voice slot。SQLite 迁移必须可重复执行；如果项目迁移器不支持重复 `ALTER TABLE`，需使用现有列探测方式，不能靠捕获任意 SQL 错误掩盖失败。

### 5.2 唯一性

创建幂等索引：

```text
(tenant_id, user_id, version_id, idempotency_hash)
WHERE deleted_at IS NULL
```

活动语义唯一索引：

```text
(tenant_id, user_id, version_id, redraw_shot_id, voice_redraw_asset_id, source_character_key)
WHERE status = 'active' AND deleted_at IS NULL
```

相同幂等键且 `request_hash` 相同，返回原审批；相同幂等键但摘要不同，返回幂等冲突。存在另一条活动语义记录时，不静默覆盖，返回活动审批冲突。

### 5.3 登记证据扩展

`redraw_local_voice_registrations` 新增可空字段：

- `approved_dialogue_evidence_sha256`；
- `supplemental_approval_ids_json`，默认 `[]`。

所有新登记都写入完整 approved-dialogue evidence SHA；使用补句时还要写入按确定顺序排列的审批 ID 数组。旧的无补句 v1 登记不被迁移脚本改写；只有声称使用补句的新证据分支必须满足新字段和复核合同。

## 6. 镜头与角色资格

服务端不得相信客户端提供角色 key、locale、market、work ID 或稳定 shot ID。创建审批时必须：

1. 读取同 tenant/user 的 version、work、project、shot 和 voice slot。
2. version 必须是 work 的当前非 draft 版本。
3. shot 必须属于该 version，且 `redraw_shots.shot_id` 非空。
4. voice slot 必须属于该 version、`kind='voice'`，其稳定角色 key 必须存在于 `source_facts_json.characters`。
5. 从 `source_facts_json.shots` 按稳定 `shot_id` 找到同一镜头。
6. 该镜头 `visible_character_ids` 必须包含 voice slot 的稳定角色 key。
7. version facts hash、project policy version、本地化任务和 decision 必须与当前持久状态完全一致。
8. `expected_shot_updated_at` 和 `expected_voice_updated_at` 必须同时命中，避免审批落到已变化的镜头或语音槽。

任一条件缺失或不一致均 fail closed。不得用前端 fixture 的角色列表自证 Rafael 出现在第 6 镜。

## 7. HTTP 合同

### 7.1 创建审批

```http
POST /api/v1/redraw/versions/:versionId/shots/:shotRowId/voices/:voiceAssetId/supplemental-dialogue-approvals
```

请求体 exact keys：

```json
{
  "idempotency_key": "opaque-client-key",
  "target_text": "Welcome home, son.",
  "source_translation": false,
  "expected_shot_updated_at": "2026-08-28T00:00:00.000Z",
  "expected_voice_updated_at": "2026-08-28T00:00:00.000Z"
}
```

规则：

- 未知字段拒绝；
- `source_translation` 必须显式为 `false`；
- `target_text` 只做 Unicode 保留和首尾 trim，不做语义改写、翻译、大小写折叠或内部空白重排；
- 文本必须非空并受明确字符数/UTF-8 字节数上限约束；
- 文本中的路径、URL、凭据形态不得进入日志或错误；输入验证失败返回稳定错误码；
- 响应不返回 `target_text`。

创建成功与幂等重放使用同一 exact key set；`idempotent_replay` 只改变布尔值，不改变结构：

```json
{
  "approval_id": 1,
  "contract_version": "redraw-supplemental-dialogue-approval-v1",
  "version_id": 2,
  "redraw_shot_id": 6,
  "voice_redraw_asset_id": 15,
  "status": "active",
  "source_translation": false,
  "target_text_sha256": "64-hex",
  "approval_evidence_sha256": "64-hex",
  "approved_at": "2026-08-28T00:00:00.000Z",
  "updated_at": "2026-08-28T00:00:00.000Z",
  "idempotent_replay": false
}
```

不得增加 `target_text`、owner 明文、localization raw result、路径、命令或内部 evidence 对象。

### 7.2 撤销审批

```http
POST /api/v1/redraw/versions/:versionId/supplemental-dialogue-approvals/:approvalId/revoke
```

请求体 exact keys：

```json
{
  "idempotency_key": "opaque-revoke-key",
  "expected_updated_at": "2026-08-28T00:00:00.000Z"
}
```

只允许 `active -> revoked`。相同撤销幂等键和摘要可安全重放；不同摘要冲突。已经 revoked 的审批不得用新的幂等键再次变更，也不得恢复为 active。

撤销成功与撤销幂等重放使用同一 exact key set：

```json
{
  "approval_id": 1,
  "contract_version": "redraw-supplemental-dialogue-approval-v1",
  "version_id": 2,
  "status": "revoked",
  "target_text_sha256": "64-hex",
  "approval_evidence_sha256": "64-hex",
  "revoked_at": "2026-08-28T00:05:00.000Z",
  "updated_at": "2026-08-28T00:05:00.000Z",
  "idempotent_replay": false
}
```

### 7.3 权限和错误投影

- 未登录返回 401；
- 跨 owner/version/shot/voice/approval 一律按不存在处理，避免枚举；
- CAS、幂等、活动审批冲突使用稳定 409；
- facts、policy、本地化决策或上下文漂移使用稳定 not-ready/conflict 错误；
- 错误响应和日志不返回正文、绝对路径、命令、raw evidence 或内部 SQL。

## 8. 审批证据摘要

创建审批时计算 `dialogue_context_sha256`，规范化对象至少包含：

- contract version；
- owner 摘要、work/version；
- redraw shot ID、稳定 shot ID、batch/shot 顺序；
- voice slot ID、稳定角色 key；
- source facts 中该镜头的 `visible_character_ids`；
- 当前 `source_dialogue_json` 与 `localized_dialogue_json` 的规范化摘要；
- localization task ID 和 decision SHA；
- facts hash、policy version、locale、market；
- shot/voice CAS 时间。

`approval_evidence_sha256` 再覆盖：

- `dialogue_context_sha256`；
- `target_text_sha256`；
- `source_translation=false`；
- approval source/decision；
- approved_by 摘要和 approved_at；
- approval ID、status。

该 SHA 在创建事务中计算并写入 `redraw_supplemental_dialogue_approvals.approval_evidence_sha256`。任何服务读取时都必须用持久行和当前上下文重算；重算值与持久值不一致即 fail closed。正文只能在数据库受控列和服务端 TTS 内存中出现。外部证据仅暴露哈希。

## 9. 本地语音登记消费规则

`readApprovedDialogueEvidence()` 改为合并两个互不混淆的来源：

1. 当前 completed + advance 本地化任务派生的普通目标语言对白；
2. 同 owner/version/voice/character 的 active 补充审批。

合并前必须重新计算每条审批的当前 `dialogue_context_sha256` 和 `approval_evidence_sha256`，并校验：

- status 仍为 active；
- owner、work、version、shot、voice、角色、locale、market 全部一致；
- 角色仍在该稳定镜头 `visible_character_ids`；
- localization task、decision、facts hash、policy version 未漂移；
- target text SHA 与数据库正文一致；
- shot/voice 当前状态未晚于审批 CAS 快照发生未批准漂移。

确定顺序为 `batch_index ASC, shot_index ASC, redraw_shot_id ASC, approval_id ASC`。同一角色在同一镜头最多一条活动补句，因此不会有不明确的同镜排序。

登记 `request_hash` 必须加入：

- approved-dialogue evidence SHA；
- supplemental approval IDs；
- 每条 approval evidence SHA、target text SHA、status、approved_at、updated_at；
- 原有 owner/version/voice/locale/market/profile/manifest/CAS 字段。

审批撤销或上下文漂移后：

- 不得启动新的本地 TTS Worker；
- 原幂等登记请求不得仅凭旧 request hash 继续执行；
- completed 历史登记和音频资产保留审计；
- production voice 本地可信分支必须重新读取审批并拒绝把该登记用于新的目录/绑定判定。

## 10. Production voice 本地证据

使用补句的新 `local_offline_tts` evidence 至少增加：

- `approved_dialogue_contract_version`；
- `approved_dialogue_evidence_sha256`；
- `supplemental_dialogue_approval_ids`；
- 每条审批的 evidence SHA 和 target text SHA；
- `source_translation=false`。

不得增加正文、供应商配置、provider task ID、计费信息或 `real_generation_verified=true`。

无补句角色继续沿用普通本地化对白来源；Rafael 的第 6 镜补句必须明确显示为 supplemental owner approval，而不是 source translation。

现有 `redrawVoiceService.js` 使用严格本地证据白名单。实现必须同步更新并回归以下入口，不能只在 registration 侧增加字段：

- `LOCAL_REQUIRED_KEYS`：新 v2 补句分支的 exact evidence keys；
- `normalizeEvidence()`：只规范化允许的哈希、ID 和布尔字段，不引入正文；
- `isCompleteLocalEvidence()`：验证补句 IDs、审批证据 SHA 和 `source_translation=false`；
- `assertCompletedLocalRegistration()`：回查 registration 字段和每条 active approval；
- `publicEvidence()`：只投影审批 IDs/hash，不投影正文；
- `sameVoice()` / `sameEvidence()`：把 approved-dialogue evidence SHA 和审批 IDs 纳入比较。

为避免破坏现有 provider 分支，新增字段只允许出现在 `local_offline_tts` 的新补句证据形态；provider forbidden-key 和 provider exact-evidence 回归必须保持通过。

## 11. Task 8 接入

九镜 launcher 必须按以下顺序执行：

1. 通过现有真实本地化 HTTP 链创建并完成版本；
2. 确认第 6 镜 source/localized dialogue 都不含 Rafael 新 turn；
3. 通过真实受保护 HTTP 审批接口创建 Rafael 补句审批；
4. 确认响应只含哈希和审计字段，不含正文；
5. 通过现有真实 HTTP registration 接口依次完成五个角色语音登记；
6. 完成五条语音审核、角色绑定、角色复审和 character-plan；
7. 断言五角色 5/5 ready，Rafael 登记证据引用真实 approval ID/hash；
8. 断言没有 DB proxy，没有直接 SQL 修改 approval/registration/voice/character ready 状态；
9. 断言供应商、生成、付费、积分冻结/扣除和生产写入计数全部为零。

Task 8 fixture 可以保存用户已批准的 Rafael 文本作为测试输入，但不得再标记为持久证据；持久证据只能来自审批接口成功创建的数据库记录。

Task 8 必须删除或替换旧 fixture 的以下伪证据命名和断言：

- `redraw-local-voice-supplemental-dialogue-v1`；
- `approval_source: supplemental_user_approved`；
- fixture 自算的 `approved_text_sha256`；
- `registration_provenance_persisted: false` 被当作可登记证据。

fixture 最多保留 `{ shot_id, source_character_key, target_text, source_translation:false }` 作为测试请求输入。正式合同名称、`approval_source=owner_http`、target text SHA、approval evidence SHA 和 approval ID 必须来自真实 HTTP 响应及后端持久行。

“不得 DB proxy 或直接 SQL”特指不得用代理或 SQL 写入/伪造 approval、registration、voice、review、binding 或 character-plan 状态。允许测试在 HTTP 链完成后使用只读 SQL 审计 owner 隔离、行数、哈希、状态和 billing/provider 零计数；只读审计不得成为业务执行路径或替代 HTTP 响应验证。

## 12. TDD 验收矩阵

### 12.1 迁移

- 表、CHECK、外键和两个唯一索引存在；
- 迁移可重复执行；
- `source_translation != 0`、非法 status、重复活动语义记录均被数据库拒绝；
- registration 新字段存在，旧行不被改写。

### 12.2 创建审批服务

- 同 owner/current version/shot/voice/visible character 成功；
- Rafael 第 6 镜的批准文本得到固定 SHA；
- 跨 tenant/user/version/shot/voice 拒绝；
- 角色不在 `visible_character_ids` 拒绝；
- 非 current/draft version、缺本地化任务、decision 非 advance 拒绝；
- facts/policy/decision/shot CAS/voice CAS 任一漂移拒绝；
- unknown field、`source_translation:true`、空文本、超限文本拒绝；
- 同幂等同摘要重放，同幂等异摘要冲突；
- 同语义第二条 active 审批冲突。

### 12.3 撤销

- active 可按 CAS 撤销；
- 相同撤销幂等请求安全重放；
- 过期 CAS、跨 owner、异摘要重放、二次新撤销拒绝；
- 撤销不删除历史登记和音频资产；
- 撤销后新登记和新的 production voice 信任判定拒绝。

### 12.4 登记与证据

- 普通本地化对白路径保持通过；
- 无源/本地化 Rafael turn 时，active 补句可让登记通过；
- 缺失、撤销、篡改或漂移审批时 Worker 调用数为零；
- request hash 和完成证据包含审批 IDs/hash，不含正文；
- 同一审批不能被其他 owner、version、shot、voice 或角色复用；
- provider 证据基线和零计费不变量保持通过。

### 12.5 HTTP 与安全

- 401、跨 owner 404、非法 body 400、CAS/幂等 409；
- 创建、创建重放、撤销、撤销重放响应使用第 7 节 exact key set；
- 响应、错误和日志不出现正文、绝对路径、命令或 raw evidence；
- registration body exact keys 回归继续通过。

### 12.6 严格 evidence 白名单

- `LOCAL_REQUIRED_KEYS`、`normalizeEvidence()`、`isCompleteLocalEvidence()`、`assertCompletedLocalRegistration()`、`publicEvidence()`、`sameVoice()` 和 `sameEvidence()` 全部有补句正向及缺字段/多字段/篡改字段反向测试；
- 新补句 evidence 的 exact key set 固定，正文键或未知键均拒绝；
- provider evidence exact key set 和 forbidden local keys 回归不变；
- 无补句的既有 local v1 evidence 继续按原合同验证，不因新增可空数据库列被静默升级。

### 12.7 Task 8

- 真实 router + auth + tenant header 创建 1 条 supplemental approval；
- source/localized dialogue 中 Rafael turn 仍为 0；
- 五角色 registration、review、binding、character re-review、character-plan 全链通过；
- summary 明确 `supplemental_dialogue_approvals=1`、`local_voice_registrations=5`；
- 允许只读 SQL 审计，但所有状态转换必须有对应真实 HTTP 调用证据；
- `providerPaidSubmits=0`、`generationSubmits=0`、`voice_provider_calls=0`、billing held/charged/reservation 全为 0；
- 15 个本地媒体路径若未齐全，继续报告为显式 skipped gate，不冒充完成。

## 13. 实施顺序

书面规格批准后，按独立 TDD 任务执行：

1. migration 和纯服务合同；
2. 创建/撤销审批服务测试与实现；
3. 受保护 HTTP 路由与响应脱敏；
4. registration resolver、request hash 和 evidence 扩展；
5. production voice 本地信任复核；
6. Task 8 launcher 接入和完整本地回归；
7. 规格审查、代码质量审查和最终变更边界审计。

每个实现任务必须先出现失败测试，再写最小实现，再跑相关回归。Task 8 当前未提交前端 WIP 在后端合同完成前保持暂停；不得重置、覆盖或整体格式化这些文件。

## 14. 完成标准

只有以下条件全部满足，才能宣称本补充合同完成：

- 新增测试有可审计的 RED -> GREEN 证据；
- migration、服务、路由、登记、信任分支和 Task 8 回归全部通过；
- Rafael 补句来自真实 owner-scoped HTTP 审批记录；
- localization 1:1、silent-shot 和 unknown-field 合同未放宽；
- registration 接口仍不接收台词；
- source/localized dialogue 未被补写；
- 所有响应、日志和证据不泄露正文；
- 外部供应商、付费、积分和生产写入计数均为零；
- 真实 eSpeak NG 未安装时，只能报告测试 Worker 合同通过，不能报告真实离线引擎验收通过；
- 未执行 push、部署或生产变更；
- 独立规格审查和代码质量审查均无未解决问题。
