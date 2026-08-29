# 一键转绘 owner-scoped 本地 Production Voice 登记实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `subagent-driven-development` 逐任务实现；每个任务先由实现子代理完成 TDD，再由独立规格审查子代理和代码质量审查子代理验收。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 为一键转绘增加 owner-scoped、零供应商调用的本地 production voice 登记链，使五个本地化角色能通过受信任测试 Worker 完成目标语言语音登记、审核、绑定、角色复审和 character-plan 放行，同时保持正式供应商语音合同不变。

**架构：** 新增幂等登记表、eSpeak NG 受限进程适配器和本地语音登记服务；服务端只使用已完成且 `localization_decision.action='advance'`、version/facts hash/policy version 精确匹配的目标语言对白。独立语言 Worker 新增互斥 `verify_local_voice` 动作，production voice 目录以“完整供应商证据 OR 完整本地离线证据”两个独立分支验证。HTTP 只接收幂等键与 voice slot CAS，九镜启动器只通过真实路由完成五角色状态链。

**技术栈：** Node.js 24、Express、better-sqlite3、`node:test`、`child_process.spawn`、FFmpeg/ffprobe、Python 3.11 `unittest`、Unix socket locale verifier、Playwright。

**范围限制：** 不下载或安装 eSpeak NG；不调用真实供应商；不付费；不 push；不部署；不写生产数据库。测试 Worker 通过不等于真实 eSpeak NG 本机验收通过。

---

## 执行纪律

- 当前 worktree：`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-fumin-r5-origin-main-integration-20260825`。
- 当前已有两份未提交九镜工作，属于既有 Task F，不得还原、覆盖或格式化：
  - `frontweb/e2e/redraw-live-launcher.spec.js`
  - `frontweb/e2e/support/redraw-live-product-harness.mjs`
- 任务 1–7 不得修改上述两份文件；任务 8 由单一子代理在现有 diff 上增量接入。
- 不得并行派发会写相同文件的任务。
- 每个任务遵循：实现子代理 TDD → 规格审查 → 修复（如有）→ 代码质量审查 → 修复（如有）→ 定向测试 → 独立提交。
- 子代理不得 push、部署、下载引擎、调用供应商或修改生产状态。

## 文件结构

### 新增

- `backend-node/migrations/69_redraw_local_voice_registrations.sql`
- `backend-node/src/services/redrawLocalTtsWorkerProcess.js`
- `backend-node/src/services/redrawLocalVoiceRegistrationService.js`
- `backend-node/test/redrawLocalTtsWorkerProcess.test.js`
- `backend-node/test/redrawLocalVoiceRegistration.test.js`
- `backend-node/test/redrawLocalVoiceRoutes.test.js`
- `frontweb/e2e/fixtures/redraw-local-english-voice-fixtures.js`
- `docs/superpowers/reports/2026-08-28-redraw-local-production-voice-registration-local-evidence.md`

### 修改

- `backend-node/src/services/redrawLocaleVerifierClient.js`
- `backend-node/src/services/redrawVoiceService.js`
- `backend-node/src/routes/redraw.js`
- `backend-node/src/routes/index.js`
- `backend-node/test/redrawLocaleVerifierClient.test.js`
- `backend-node/test/redrawVoices.test.js`
- `backend-node/test/redrawVoices.routes.test.js`
- `backend-node/test/redrawCharacterPlan.test.js`
- `backend-node/test/redrawRoutes.test.js`
- `workers/redraw-locale-verifier/src/redraw_locale_worker/protocol.py`
- `workers/redraw-locale-verifier/src/redraw_locale_worker/server.py`
- `workers/redraw-locale-verifier/src/redraw_locale_worker/verifier.py`
- `workers/redraw-locale-verifier/tests/test_protocol.py`
- `workers/redraw-locale-verifier/tests/test_server.py`
- `workers/redraw-locale-verifier/tests/test_verifier.py`
- `frontweb/e2e/redraw-live-launcher.spec.js`
- `frontweb/e2e/support/redraw-live-product-harness.mjs`
- `frontweb/scripts/run-redraw-live-product.mjs`

## 任务 1：迁移与登记服务边界

**文件：**

- 创建：`backend-node/migrations/69_redraw_local_voice_registrations.sql`
- 创建：`backend-node/src/services/redrawLocalVoiceRegistrationService.js`
- 创建：`backend-node/test/redrawLocalVoiceRegistration.test.js`

- [ ] **步骤 1：写红灯测试**

在新测试文件中覆盖：

```js
test('local voice registration migration creates the exact scoped contract idempotently', () => {
  // 连续运行两次 runMigrationsAndEnsure。
  // 断言字段、status CHECK、version/voice 两个外键、部分唯一索引。
});

test('local voice registration service exposes one narrow command', () => {
  const service = require('../src/services/redrawLocalVoiceRegistrationService');
  assert.deepEqual(Object.keys(service), ['registerLocalProductionVoice']);
});
```

表字段必须与规格一致：owner、version、voice slot、角色键、幂等/请求哈希、目标语言市场、批准文本哈希、profile、引擎 manifest、状态、音频、语言证据、错误和审计时间。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 --test-name-pattern="migration creates|one narrow command" test/redrawLocalVoiceRegistration.test.js
```

预期：FAIL，迁移和服务文件不存在。

- [ ] **步骤 3：最小实现**

- SQL 全部使用 `IF NOT EXISTS`，适配当前按文件名字典序重复执行的 migration runner。
- 唯一索引固定为 `(tenant_id, user_id, version_id, voice_redraw_asset_id, idempotency_hash) WHERE deleted_at IS NULL`。
- 服务只导出 `registerLocalProductionVoice`；尚未实现的路径抛 `REDRAW_LOCAL_TTS_NOT_READY`。

- [ ] **步骤 4：运行绿灯**

重复步骤 2，预期 PASS。

- [ ] **步骤 5：规格审查与质量审查**

独立审查必须确认没有改动核心表、没有 migration ledger 假设、没有供应商/计费字段进入本地登记表。

- [ ] **步骤 6：Commit**

```powershell
git add -- backend-node/migrations/69_redraw_local_voice_registrations.sql backend-node/src/services/redrawLocalVoiceRegistrationService.js backend-node/test/redrawLocalVoiceRegistration.test.js
git commit -m "test(redraw): define local voice registration boundary"
```

## 任务 2：受限 eSpeak NG 进程适配器

**文件：**

- 创建：`backend-node/src/services/redrawLocalTtsWorkerProcess.js`
- 创建：`backend-node/test/redrawLocalTtsWorkerProcess.test.js`

- [ ] **步骤 1：写红灯测试**

覆盖：

- `assertReady` 要求绝对 executable、普通文件、非链接、binary SHA 与 manifest SHA 匹配；
- manifest 只接受 `local-tts-manifest-v1`、`eSpeak NG`、固定版本和目标 locale profile；
- `synthesize` 使用 `spawn(command, args, { shell:false, windowsHide:true })`；
- 台词从 stdin 写入，不出现在 args、stdout、stderr或错误消息；
- output path 由服务端生成，必须位于 verifier 可读的私有 allowed root，且目标文件预先不存在；
- timeout、abort、非零退出、重复/额外输出、stdout/stderr 超限、无文件、SHA 漂移统一稳定错误码；
- `assertEvidenceTrusted` 只接受当前 manifest/binary/profile 的完整本地证据；
- 测试 manifest 与测试 Worker 明确标记 `test_only=true`，不能被非测试上下文信任。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawLocalTtsWorkerProcess.test.js
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：最小实现**

导出工厂 `createRedrawLocalTtsWorkerProcess(options)`，实例仅暴露：

```text
assertReady(locale)
synthesize({ requestId, approvedText, locale, profileKey, outputRoot, signal })
assertEvidenceTrusted(evidence)
```

实现要求：

- 复用 `redrawFullFrameDetectorProcess` 的安全 env、单次 settle、超时 kill 和输出上限模式；
- 不把 safe env 宣称为通用网络沙箱；零网络信任来自固定且哈希锁定的 eSpeak NG 二进制；
- 使用 stdin 传台词；args 只含 manifest 允许的 voice/pitch/rate/amplitude 和服务端 output path；
- 生产默认无 manifest 时 fail closed；本任务不创建或下载真实引擎。

- [ ] **步骤 4：运行绿灯**

重复步骤 2，预期 PASS。

- [ ] **步骤 5：规格审查与质量审查**

重点审查 Windows reparse/symlink、realpath、路径交集、子进程双 settle、输出上限和台词泄漏。

- [ ] **步骤 6：Commit**

```powershell
git add -- backend-node/src/services/redrawLocalTtsWorkerProcess.js backend-node/test/redrawLocalTtsWorkerProcess.test.js
git commit -m "feat(redraw): add restricted local tts process"
```

## 任务 3：独立语言 Worker 的本地语音动作

**文件：**

- 修改：`backend-node/src/services/redrawLocaleVerifierClient.js`
- 修改：`backend-node/test/redrawLocaleVerifierClient.test.js`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/protocol.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/server.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/verifier.py`
- 修改：`workers/redraw-locale-verifier/tests/test_protocol.py`
- 修改：`workers/redraw-locale-verifier/tests/test_server.py`
- 修改：`workers/redraw-locale-verifier/tests/test_verifier.py`

- [ ] **步骤 1：写 Node 和 Python 红灯测试**

新增精确动作：`verify_local_voice`。

请求 exact keys：

```json
{
  "action": "verify_local_voice",
  "request_id": "server-id",
  "audio_path": "/allowed/private/audio.wav",
  "audio_sha256": "64-hex",
  "approved_text": "server-approved text",
  "locale_pack": "en-US@1",
  "local_tts_invocation": {
    "engine": "eSpeak NG",
    "engine_version": "pinned-version",
    "binary_sha256": "64-hex",
    "manifest_sha256": "64-hex",
    "profile": "role-1"
  }
}
```

测试必须证明：

- `verify` 与 `verify_native_audio` 原合同完全不变；
- 本地动作拒绝 `tts_invocation`、`video_invocation`、provider、model、配置 ID、task ID 和额外字段；
- audio hash、approved text、locale pack 和 local invocation 被响应证据精确绑定；
- server 分发到本地 wrapper，仍复用同一 ASR/accent 核验；
- Node 客户端新增 `verifyLocalVoice`，先重新计算文件 SHA，再验证响应 exact keys 和 manifest/audio 绑定。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 --test-name-pattern="local voice" test/redrawLocaleVerifierClient.test.js
Set-Location ..
$env:PYTHONPATH = (Resolve-Path 'workers/redraw-locale-verifier/src').Path
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_protocol.py' -v
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_verifier.py' -v
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_server.py' -v
Remove-Item Env:PYTHONPATH
```

预期：新增动作测试 FAIL，原动作测试保持 PASS。

- [ ] **步骤 3：最小实现**

- Python protocol 增加独立 exact-key parser；
- verifier 增加本地 wrapper，只替换 invocation 证据，不改变 ASR/accent、阈值或 locale 结论；
- server 显式选择本地 wrapper；
- Node 客户端增加 `verifyLocalVoice` 和独立响应验证；
- 不通过空字段或假 ID 调用旧 `verify`。

- [ ] **步骤 4：运行绿灯与原协议回归**

重复步骤 2，不限制 Node name pattern 再运行一次整个 `redrawLocaleVerifierClient.test.js`。预期全部 PASS。

- [ ] **步骤 5：规格审查与质量审查**

确认三种动作互斥、无字段混合、无阈值放宽、无请求 locale 自证检测 locale。

- [ ] **步骤 6：Commit**

```powershell
git add -- backend-node/src/services/redrawLocaleVerifierClient.js backend-node/test/redrawLocaleVerifierClient.test.js workers/redraw-locale-verifier/src/redraw_locale_worker/protocol.py workers/redraw-locale-verifier/src/redraw_locale_worker/server.py workers/redraw-locale-verifier/src/redraw_locale_worker/verifier.py workers/redraw-locale-verifier/tests/test_protocol.py workers/redraw-locale-verifier/tests/test_server.py workers/redraw-locale-verifier/tests/test_verifier.py
git commit -m "feat(redraw): verify local voice evidence independently"
```

## 任务 4：登记 claim、对白证据与稳定 profile

**文件：**

- 修改：`backend-node/src/services/redrawLocalVoiceRegistrationService.js`
- 修改：`backend-node/test/redrawLocalVoiceRegistration.test.js`

- [ ] **步骤 1：写红灯测试**

覆盖：

- 只接受同 tenant/user/version 的 `kind='voice'` 活跃槽位；
- version 不能是 `draft`；
- `localization_task_id` 必须指向同 owner、同 work 的 completed localization task；
- task result 的 `localization_decision.action='advance'`，version ID、facts hash、policy version 必须匹配当前 version/project；
- 按 `batch_index, shot_index, id` 收集该角色对白；`target_text` 优先，兼容 `localized_text`；
- speaker 必须匹配 `source_character_key`；空白或文本不足 fail closed，不编造、翻译或重复；
- 当前版本所有角色按稳定角色键排序，profile 一一分配；profile 少于角色数 fail closed；
- 相同幂等键 + 相同 request hash 返回原登记且不启动 Worker；异参返回幂等冲突；
- 过期 `expected_updated_at`、决策漂移、owner 错误均在创建进程前失败；
- 登记 claim 只写 `processing`，不改语音槽位、不写媒体、不写计费。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 --test-name-pattern="owner|localization decision|approved dialogue|stable profile|idempotency|claim" test/redrawLocalVoiceRegistration.test.js
```

预期：FAIL，服务尚未实现 claim 和派生。

- [ ] **步骤 3：最小实现**

实现私有 helper，不扩大 public API：

```text
readOwnedScope
readApprovedDialogueEvidence
assignStableProfile
claimRegistration
replayRegistration
```

`request_hash` 必须覆盖 owner、version、voice slot、角色键、locale、market、facts hash、policy version、批准文本 SHA、profile、engine manifest SHA 和 CAS。

- [ ] **步骤 4：运行绿灯**

重复步骤 2，预期 PASS。

- [ ] **步骤 5：规格审查与质量审查**

重点检查“已批准”没有退化成读取任意 `localized_dialogue_json`，并确认 replay 绝不二次合成。

- [ ] **步骤 6：Commit**

```powershell
git add -- backend-node/src/services/redrawLocalVoiceRegistrationService.js backend-node/test/redrawLocalVoiceRegistration.test.js
git commit -m "feat(redraw): claim local voice registrations safely"
```

## 任务 5：合成、媒体登记、语言核验与原子完成

**文件：**

- 修改：`backend-node/src/services/redrawLocalVoiceRegistrationService.js`
- 修改：`backend-node/test/redrawLocalVoiceRegistration.test.js`

- [ ] **步骤 1：写红灯测试**

成功路径断言：

- Worker 只收到服务端 request ID、批准文本、locale、profile 和私有 staging root；
- staging root 位于 locale verifier allowed root 内；
- 服务端重新计算 SHA，ffprobe 证明 WAV 有可解码音轨、非静音、时长/大小在限制内；
- `verifyLocalVoice` 输入绑定音频 SHA、批准文本、locale pack 和 local invocation；
- 内容寻址写入 `redraw-local-voices/<sha256>.wav`，使用 `assetService.create` 登记当前 owner 音频；
- 最终事务再次检查 voice slot CAS，把 `voice_asset_id`、`local_offline_tts` 证据、`generated/pending` 与 registration `completed` 一次写入；
- 返回 billing 固定 `{ credits:0, held:0, charged:0 }`；数据库无 reservation/ledger 增量。

失败路径断言：

- manifest/binary/profile 不可信、路径越界、链接/reparse、WAV magic、无音轨、静音、时长/大小或 SHA 不符 → `failed` 且清理未登记临时文件；
- Worker timeout/abort/退出结果未知 → `needs_attention`，不自动重试；
- 媒体已登记后的最终 CAS 冲突或 DB 完成失败 → `needs_attention`，登记保留音频引用；locale verifier 在媒体登记前失败时不得创建媒体资产；
- 内容寻址目标已存在时必须重新验证 SHA 与文件身份；
- 错误不泄露台词、绝对路径、命令或环境。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 --test-name-pattern="synthesizes|media|verifies|completed|needs_attention|billing|redacts" test/redrawLocalVoiceRegistration.test.js
```

预期：FAIL，完整执行链不存在。

- [ ] **步骤 3：最小实现**

- 采用专用音频安全登记，不重构图片/动作参考服务；
- 进程执行和媒体探测在 DB 事务外；claim 和 finalization 使用短事务；
- 文件复制使用排他创建，前后 stat/realpath/SHA 检查，DB 失败只清理本次新建文件；
- registration 的 `completed` 是唯一可进入语音槽位的终态。

- [ ] **步骤 4：运行绿灯**

重复步骤 2，再运行完整 `redrawLocalVoiceRegistration.test.js`，预期全部 PASS。

- [ ] **步骤 5：规格审查与质量审查**

重点检查 TOCTOU、文件清理范围、SQLite 事务边界、needs_attention 证据保留和零计费。

- [ ] **步骤 6：Commit**

```powershell
git add -- backend-node/src/services/redrawLocalVoiceRegistrationService.js backend-node/test/redrawLocalVoiceRegistration.test.js
git commit -m "feat(redraw): register verified local production voices"
```

## 任务 6：Production voice 双证据分支

**文件：**

- 修改：`backend-node/src/services/redrawVoiceService.js`
- 修改：`backend-node/test/redrawVoices.test.js`
- 修改：`backend-node/test/redrawVoices.routes.test.js`
- 修改：`backend-node/test/redrawCharacterPlan.test.js`

- [ ] **步骤 1：写红灯测试**

覆盖：

- 完整可信 `local_offline_tts` 证据进入同 owner/version/locale/market production voice 目录；
- 缺 registration、binary/manifest/profile/audio/locale evidence 任一字段都拒绝；
- 供应商半证据与本地半证据不能拼接通过；
- 本地分支不要求活动 `ai_service_configs`、克隆授权、provider task 或 `real_generation_verified`；
- 正式供应商分支的活动配置、克隆授权和真实生成要求保持不变；
- `assignVoice` 对两个分支分别做 CAS 和证据重验；
- 角色快照返回 `verification_source`、`provider_verified`、`local_offline_verified`，本地分支不得写 `real_generation_verified=true`；
- voice 审核 → 绑定角色 → 角色复审后，现有 character-plan 对该角色为 ready，无需放宽 character-plan。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 --test-name-pattern="local_offline|local offline|mixed evidence|verification_source" test/redrawVoices.test.js test/redrawVoices.routes.test.js test/redrawCharacterPlan.test.js
```

预期：本地分支测试 FAIL；既有供应商测试保持 PASS。

- [ ] **步骤 3：最小实现**

- 将证据标准化和可信检查拆成两个完整互斥分支；
- `sameVoice` / `sameEvidence` 分支感知；
- 列表、预览、绑定和 dialogue batch 继续复用同一可信入口；
- 保持现有 public 字段兼容，并添加明确来源字段，不把本地证明命名为 provider verified。

- [ ] **步骤 4：运行绿灯与供应商回归**

```powershell
node --test --test-concurrency=1 test/redrawVoices.test.js test/redrawVoices.routes.test.js test/redrawVoiceAssetIntegration.test.js test/redrawCharacterPlan.test.js test/redrawDialogue.test.js
```

预期：全部 PASS。

- [ ] **步骤 5：规格审查与质量审查**

重点检查没有弱化任何正式供应商条件，没有用请求 locale 自证检测 locale。

- [ ] **步骤 6：Commit**

```powershell
git add -- backend-node/src/services/redrawVoiceService.js backend-node/test/redrawVoices.test.js backend-node/test/redrawVoices.routes.test.js backend-node/test/redrawCharacterPlan.test.js
git commit -m "feat(redraw): trust complete local voice evidence"
```

## 任务 7：受保护 HTTP 路由与五角色后端状态链

**文件：**

- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 创建：`backend-node/test/redrawLocalVoiceRoutes.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：写红灯测试**

使用真实 `setupRouter`、登录 token 和 `X-Tenant-Id` 覆盖：

- 新路由始终注册；依赖未配置返回 503 `REDRAW_LOCAL_TTS_NOT_READY`，不静默卸载；
- 未登录 401；无租户、跨 tenant/user/version/voice slot、wrong kind 均 404；
- body 只接受 `idempotency_key` 与 `expected_updated_at`；
- locale、market、text、profile、path、hash、asset、evidence、billing、原型污染和未知字段全部 400，服务 0 调用；
- handler 只把精确 owner/version/voice/CAS 和受信依赖传给登记服务；
- 状态与错误码稳定映射，未知异常脱敏；
- 响应只含 registration/version/voice/audio/status/CAS/billing，不含台词、绝对路径、命令或 raw evidence；
- 五个 voice slot 通过真实 HTTP：登记 → voice review → character voice assign → character review → character-plan 5/5 ready；
- 全链路 supplier/provider/billing 计数为零。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawLocalVoiceRoutes.test.js
node --test --test-concurrency=1 --test-name-pattern="local production voice route" test/redrawRoutes.test.js
```

预期：FAIL，路由未注册。

- [ ] **步骤 3：最小实现**

- `routes/index.js` 显式把 locale verifier/registry 与 local TTS worker 依赖传给 redraw routes；
- `routes/redraw.js` 增加严格字段集合、owner 查询、CAS 预检、公共结果投影和脱敏错误映射；
- 路由：`POST /redraw/versions/:versionId/voices/:voiceAssetId/local-production-registrations`；
- 不使用 multipart，不接收本地路径或音频上传。

- [ ] **步骤 4：运行绿灯与路由回归**

```powershell
node --test --test-concurrency=1 test/redrawLocalVoiceRoutes.test.js test/redrawRoutes.test.js test/redrawVoices.routes.test.js
```

预期：全部 PASS。

- [ ] **步骤 5：规格审查与质量审查**

重点检查 middleware 顺序、route 公开性、owner 404 语义、依赖默认 fail closed 和响应脱敏。

- [ ] **步骤 6：Commit**

```powershell
git add -- backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawLocalVoiceRoutes.test.js backend-node/test/redrawRoutes.test.js
git commit -m "feat(redraw): expose scoped local voice registration"
```

## 任务 8：九镜启动器接入与全局网络守卫

**文件：**

- 创建：`frontweb/e2e/fixtures/redraw-local-english-voice-fixtures.js`
- 修改：`frontweb/e2e/redraw-live-launcher.spec.js`
- 修改：`frontweb/e2e/support/redraw-live-product-harness.mjs`
- 修改：`frontweb/scripts/run-redraw-live-product.mjs`

- [ ] **步骤 1：保护并确认现有 dirty 基线**

```powershell
git diff --stat -- frontweb/e2e/redraw-live-launcher.spec.js frontweb/e2e/support/redraw-live-product-harness.mjs
git diff --check -- frontweb/e2e/redraw-live-launcher.spec.js frontweb/e2e/support/redraw-live-product-harness.mjs
```

记录当前 stat；不得使用 checkout、reset、整体覆盖或格式化。

- [ ] **步骤 2：写红灯测试**

新增断言：

- 网络守卫阻断 `POST /api/v1/redraw/versions/:id/assets/batches`；
- 网络守卫阻断 `POST /api/v1/redraw/versions/:id/dialogue/start`；
- 新本地登记路由允许通过；
- harness 在 identity 后、reference preparation 前完成 5 次本地合成、5 次语言核验、5 次语音登记、5 次 voice review、5 次角色绑定和 5 次角色复审；
- character-plan 严格 5/5 ready，五个 profile 唯一；
- `voiceProviderCalls=0`、`providerPaidSubmits=0`、`generationSubmits=0`、external fetches=0；
- summary 增加 `voice_registered=5`、`character_plan_ready=5`、`local_tts_syntheses=5`、`locale_verification_calls=5`；
- 实际 launcher 脚本使用与 dirty spec 相同的 Latin-American fixture builder 和 15 个批准本地素材输入。

- [ ] **步骤 3：运行红灯**

```powershell
Set-Location frontweb
npx playwright test e2e/redraw-live-launcher.spec.js --workers=1
```

预期：新增守卫和语音链测试 FAIL。

- [ ] **步骤 4：最小实现**

- 只在现有 dirty diff 上增量修改；
- 新 fixture 文件保存可被 ffprobe 读取的英语合成语音及来源/生成器/文本 SHA/音频 SHA 元数据；本机已只读确认可使用 `Microsoft Zira Desktop (en-US)` 一次性生成该 `test_only` fixture；不得包含真人声音或敏感素材；
- Windows SAPI 只负责生成不可被生产信任的测试 fixture，不是本地 production voice 引擎，也不得写入 `local_offline_tts` 生产 manifest；
- 测试 local TTS worker 按 profile 写入上述真实英语语音 fixture，使用 `test_only` manifest；不得用正弦音、空 RIFF 或西语 fixture；
- locale verifier stub 的 `verifyLocalVoice` 必须重新计算实际音频 SHA，并把批准文本 SHA、locale pack 和 local invocation 精确绑定；
- 通过新 HTTP 路由登记，不直接 SQL 修改 voice 或 character 状态；
- 保持现有真实素材、coverage、identity、motion、clean、两轮 preparation 和 zero-cost 断言。

- [ ] **步骤 5：运行绿灯**

重复步骤 3，预期 PASS。

若 15 个已批准素材路径仍存在，再运行显式本地链：

```powershell
$env:REDRAW_LIVE_PRODUCT_E2E = '1'
npm run test:e2e:redraw-live-launcher -- --workers=1
Remove-Item Env:REDRAW_LIVE_PRODUCT_E2E
```

这仍是测试 Worker 路径，不得声称真实 eSpeak NG 验收通过。

- [ ] **步骤 6：规格审查与质量审查**

重点检查既有 dirty 工作未丢失、危险路由守卫先于 handler、生效计数真实、无 SQL 快捷写状态、无外部网络。

- [ ] **步骤 7：Commit**

仅在确认这两份 dirty 文件全部属于当前已批准 Task F 且 diff 无无关变化后提交：

```powershell
git add -- frontweb/e2e/fixtures/redraw-local-english-voice-fixtures.js frontweb/e2e/redraw-live-launcher.spec.js frontweb/e2e/support/redraw-live-product-harness.mjs frontweb/scripts/run-redraw-live-product.mjs
git commit -m "test(redraw): complete local five voice product chain"
```

## 任务 9：完整回归、审计报告与交付边界

**文件：**

- 创建：`docs/superpowers/reports/2026-08-28-redraw-local-production-voice-registration-local-evidence.md`

- [ ] **步骤 1：运行 Python Worker 全套测试**

```powershell
Set-Location 'C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-fumin-r5-origin-main-integration-20260825'
$env:PYTHONPATH = (Resolve-Path 'workers/redraw-locale-verifier/src').Path
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_*.py' -v
Remove-Item Env:PYTHONPATH
```

- [ ] **步骤 2：运行后端相关回归**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 `
  test/redrawLocalTtsWorkerProcess.test.js `
  test/redrawLocalVoiceRegistration.test.js `
  test/redrawLocalVoiceRoutes.test.js `
  test/redrawLocaleVerifierClient.test.js `
  test/redrawVoices.test.js `
  test/redrawVoices.routes.test.js `
  test/redrawVoiceAssetIntegration.test.js `
  test/redrawCharacterPlan.test.js `
  test/redrawReviewGate.test.js `
  test/redrawDialogue.test.js `
  test/redrawRoutes.test.js
```

- [ ] **步骤 3：运行后端全套与前端构建/启动器回归**

```powershell
Set-Location backend-node
npm test
Set-Location ../frontweb
npm run build
npx playwright test e2e/redraw-live-launcher.spec.js --workers=1
```

- [ ] **步骤 4：审计零外部调用和 Git 边界**

报告必须记录：

- 精确命令、退出码、测试数量；
- 五角色登记/审核/绑定/复审/character-plan 数量；
- local synth 与 locale verify 次数；
- generation、provider、external fetch、reservation、held、charged 全部为零；
- 新增音频文件 SHA 和测试 manifest SHA，不记录绝对路径或台词正文；
- `git diff --check`；
- `git status --short --branch`；
- 没有 push、部署、供应商调用、付费或生产数据库写入；
- 明确结论只能是“代码合同与测试 Worker 本地验收通过”；真实 eSpeak NG 仍是后续门禁。

- [ ] **步骤 5：独立最终规格审查与代码质量审查**

审查完整 commit range，确认规格的每项完成标准均有同次运行证据，且未把 mock/unit/build 提升为真实引擎或生产验收。

- [ ] **步骤 6：Commit 报告**

```powershell
git add -- docs/superpowers/reports/2026-08-28-redraw-local-production-voice-registration-local-evidence.md
git commit -m "docs(redraw): record local voice registration evidence"
```

## 最终停点

本计划完成后必须停止在本地、未 push、未部署状态，并向用户报告：

- 已完成的本地代码合同和测试 Worker 同链证据；
- 仍未完成的真实 eSpeak NG 安装、二进制/许可证审计和五角色真实离线音频验收；
- Hosted CI、push、PR、合并、候选、部署和生产验收仍需分别授权。
