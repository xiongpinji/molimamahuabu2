# 供应商线路就绪与 TTS 主动巡检实施计划

> 本计划只覆盖本地实现和验证。不得连接真实供应商、产生付费请求、修改生产数据库、启用 `enforce`、推送或部署。

## 目标

1. 让 `tts` 与现有 text/image/video 一样具备指定线路、单次提交、可读产物验证和证据生命周期。
2. 让 TTS 的运行指纹覆盖实际客户端、模型选择、产物校验和共享安全依赖，避免代码变化后继续信任旧证据。
3. 保持 `shadow` 与现有用户目录行为不变；在没有新鲜证据时不伪造“已验证”。
4. 复用既有证据绑定拆分工具；只生成生产配置差距清单，不猜测供应商成本、能力或真实证据。

## 非目标

- 不启用生产巡检或 `enforce`。
- 不自动解除任何 `canary_paused`。
- 不补写未知成本、能力或逻辑模型 ID。
- 不把历史成功记录升级为主动巡检新鲜证据。
- 不接入 `video_understanding`；它需要独立的目标线路、价格、真实生成和可读产物证据。

## Task 1：锁定 TTS 运行指纹

**文件**

- 修改：`backend-node/src/services/providerRuntimeFingerprintService.js`
- 修改：`backend-node/test/providerRuntimeFingerprint.test.js`

**TDD**

1. 先写失败测试：MiniMax/OpenAI TTS 均能解析运行映射；`ttsService.js` 或 `ttsConfigSelectionService.js` 变化会改变指纹；未知 TTS 协议 fail closed。
2. 最小实现：增加 `tts` 公共文件、协议表和 provider 映射，不改变其他服务类型。
3. 运行聚焦测试和现有 text/image/video 指纹回归。

## Task 2：验证本地 MP3 巡检产物

**文件**

- 修改：`backend-node/src/services/providerCanaryArtifactService.js`
- 新增：`backend-node/test/providerCanaryAudioArtifact.test.js`

**TDD**

1. 先写失败测试：仅接受目标 run 目录内的非空常规 MP3；拒绝路径逃逸、符号链接、非 MP3、其他 run 和用户目录。
2. 最小实现：新增本地音频摘要入口，复用现有路径约束和 SHA-256 摘要；公开摘要只含相对路径、哈希、字节数和 `audio/mpeg`。
3. 不新增远程下载器，不改变图片/视频物化逻辑。

## Task 3：TTS 单次主动巡检

**文件**

- 修改：`backend-node/src/services/providerCanaryExecutor.js`
- 修改：`backend-node/test/providerCanaryExecutor.test.js`

**TDD**

1. 先写失败测试：TTS 请求使用固定无人物短句、精确 `config_id`、`count=1`；使用 `cost_unit=request` 的正成本；只提交一次且无 failover。
2. 成功测试：注入 TTS 客户端，在隔离 run 目录生成合法 MP3；摘要可读后才结算成功并写 `fresh`。
3. 失败测试：明确提交前失败退款；网络/响应/本地写入状态未知保持 held；无产物、非法 MP3 或路径逃逸写 `artifact_unreadable`，不写 fresh，不自动重试。
4. 最小实现：调用现有 `ttsService.synthesize`，不复制 MiniMax/OpenAI 协议；产物用 Task 2 的入口校验。

## Task 4：调度与清单闭环

**文件**

- 修改：`backend-node/test/providerCanaryScheduler.test.js`（若现有通用逻辑已满足则只加测试）
- 修改：`backend-node/test/providerCanaryInventory.test.js`（若现有通用逻辑已满足则只加测试）

**TDD**

1. TTS 声明能力形成唯一单次 profile；缺价格、成本、能力、逻辑模型或运行映射继续阻断。
2. `canary_paused` 继续只产生阻断项；本地实现不得自动解除。
3. zero-cost sweep 不发生成请求；paid scheduler 默认仍关闭。

## Task 5：生产配置精确差距清单

**文件**

- 新增：`docs/verification/platform-stability/provider-readiness-repair-manifest-20260823.md`

**步骤**

1. 从已经取得的生产只读快照逐条列出 config ID、服务类型和 blocker。
2. 对可由代码解决的 `missing_runtime_mapping` 标记“本候选解决”。
3. 对 `missing_logical_model_id`、`missing_user_price`、`missing_cost`、`missing_capabilities` 标记所需可信输入；没有来源时保持 blocked。
4. 对配置 16/27 和所有暂停线路保持 paused；只在后续获得独立付费授权和新鲜证据后申请解除。
5. 明确 `video_understanding` 为独立阻断项，不混入本次 TTS 修复。

## 完成门禁

- 新增行为均先红后绿。
- TTS 聚焦测试、主动巡检 Task 3-10 相关回归、现有 MiniMax TTS 测试、后端全量测试全部通过。
- `node --check`、`git diff --check`、敏感信息扫描通过。
- 不产生真实网络请求、供应商任务、积分或生产写入。
- 未通过真实付费生成与可读产物验证前，只能称“本地候选”，不能称生产可用或稳定。
