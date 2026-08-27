# ToAPIs 未知提交恢复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** ToAPIs 视频提交结果未知时保存可查询的 `client_business_id`，后续只查询恢复而不重复 POST；同时允许管理员配置官方大陆入口 `https://toapis.xyz`。

**架构：** 创建请求继续使用现有官方 JSON 合同。若 POST 已发出但没有可信 `task_id`，客户端把本次稳定的 `client_business_id` 作为恢复查询句柄返回；路由层原子地把句柄固化到既有任务凭证字段，同时保持路由、业务任务和积分为 `needs_attention`/held，交给现有对账器执行单次 GET。域名变更仅增加白名单兼容，不自动改生产配置。

**技术栈：** Node.js、`node:test`、better-sqlite3、现有 provider route stability/reconciliation 服务。

---

### 任务 1：锁定官方大陆入口和未知提交恢复元数据

**文件：**
- 修改：`backend-node/test/toapisVideoClient.test.js`
- 修改：`backend-node/src/services/toapisVideoClient.js`

- [x] **步骤 1：编写失败的测试**

```js
assert.equal(normalizeToapisBaseUrl('https://toapis.xyz/v1/'), 'https://toapis.xyz');

const unknown = await callToapisVideoApi(config, log, {
  model: 'seedance-2-mini',
  prompt: 'x',
  resolution: '480p',
  duration: 4,
  client_business_id: 'video-335',
}, { fetchImpl: async () => { throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }); } });
assert.equal(unknown.route_meta.recoveryTaskId, 'video-335');
```

- [x] **步骤 2：运行测试验证失败**

运行：`node --test test/toapisVideoClient.test.js`

预期：FAIL；`.xyz` 被拒绝，且未知提交没有 `recoveryTaskId`。

- [x] **步骤 3：编写最少实现代码**

允许 `toapis.com` 与 `toapis.xyz` 两个精确 HTTPS 主机；构建请求后，对连接中断、408/5xx、非 JSON 和缺少任务 ID 的结果，把非空 `body.client_business_id` 写入 `route_meta.recoveryTaskId`。不把它伪装成已确认的供应商 `task_id`。

- [x] **步骤 4：运行测试验证通过**

运行：`node --test test/toapisVideoClient.test.js`

预期：PASS，且既有非法域名/密钥脱敏测试继续通过。

### 任务 2：原子固化恢复查询句柄但保持 needs_attention

**文件：**
- 修改：`backend-node/test/toapisVideoIntegration.test.js`
- 修改：`backend-node/test/providerRouteStability.test.js`
- 修改：`backend-node/test/providerRouteVideoIntegration.test.js`
- 修改：`backend-node/src/services/providerRouteStabilityService.js`
- 修改：`backend-node/src/services/videoClient.js`

- [x] **步骤 1：编写失败的集成测试**

```js
const result = await callVideoApi(db, log, {
  model: 'seedance-2-mini',
  video_gen_id: 335,
  // 省略其余已存在的有效请求参数
}, { fetchImpl: interruptedFetch });

assert.equal(result.indeterminate, true);
assert.equal(attempt.state, 'needs_attention');
assert.equal(attempt.provider_task_id, 'video-335');
assert.equal(route.state, 'needs_attention');
assert.equal(video.provider_task_id, 'video-335');
assert.equal(postCount, 1);
```

- [x] **步骤 2：运行测试验证失败**

运行：`node --test test/toapisVideoIntegration.test.js`

预期：FAIL；当前未知提交丢失恢复句柄。

- [x] **步骤 3：编写最少实现代码**

在 `providerRouteStabilityService` 增加一个原子记录函数：仅允许从空凭证写入非空恢复句柄，将 attempt 与 route 保持为 `needs_attention`，写入 `submission_unknown` 和安全 HTTP 摘要。`videoClient` 只在 `result.indeterminate === true` 且存在 `route_meta.recoveryTaskId` 时调用它，并把同一句柄写入 `video_generations.provider_task_id`；返回仍为 indeterminate，不触发第二次 POST。

- [x] **步骤 4：运行测试验证通过**

运行：`node --test test/toapisVideoIntegration.test.js test/videoGenerationRequestSnapshot.test.js`

预期：PASS；未知提交仍冻结积分并阻止重试，但现在可以由既有对账器 GET 查询。

### 任务 3：回归和交付边界审计

**文件：**
- 验证：`backend-node/test/toapisVideoClient.test.js`
- 验证：`backend-node/test/toapisVideoIntegration.test.js`
- 验证：`backend-node/test/providerTaskReconciliation.test.js`
- 验证：`backend-node/test/videoGenerationRequestSnapshot.test.js`

- [x] **步骤 1：运行相关回归**

运行：

```bash
node --test test/toapisVideoClient.test.js test/toapisVideoIntegration.test.js test/providerTaskReconciliation.test.js test/videoGenerationRequestSnapshot.test.js
```

预期：全部 PASS，零真实供应商请求、零付费。

- [x] **步骤 2：审计精确差异**

运行：`git diff --check && git status --short && git diff --stat`

预期：仅计划列出的客户端、路由服务、测试和本计划文档有差异。

- [x] **步骤 3：用红灯锁定新鲜功能锁批准要求**

运行：`node --test test/featureLockManifest.test.js`

结果：14 项中 12 项通过、2 项按预期失败；新增断言显示两个锁仍使用旧批准，真实 `--base HEAD^` 审计返回 `FEATURE_LOCKED`。

- [x] **步骤 4：按产品负责人批准精准刷新四个功能锁**

仅更新 `stability.provider-route-contract`、`stability.safe-provider-failover`、`stability.unknown-state-billing-reconciliation` 与 `stability.proactive-canary-and-public-evidence` 的 `unlock`，并把各自旧 `unlock` 追加到 `unlockHistory` 末尾；同步锁测试。不得修改 acceptance、protectedPaths、requiredTests、evidence、fixCommit 或其他功能锁。

- [x] **步骤 5：验证功能锁绿灯**

运行：`node --test test/featureLockManifest.test.js`

结果：14 项全部通过；更严格的
`node backend-node/scripts/verify-feature-lock-manifest.js --base origin/main`
返回 `ready: true`。字段级白名单审计同时确认：只有上述四个功能锁的
`unlock` 与 `unlockHistory` 发生变化，每条历史仅追加对应的上一批准；
acceptance、protectedPaths、requiredTests、evidence、fixCommit、清单根字段
以及其余功能锁均保持不变。

- [x] **步骤 6：提交本地分支**

```bash
git add docs/superpowers/plans/2026-08-27-toapis-submission-recovery.md \
  backend-node/src/services/toapisVideoClient.js \
  backend-node/src/services/providerRouteStabilityService.js \
  backend-node/src/services/videoClient.js \
  backend-node/test/providerRouteStability.test.js \
  backend-node/test/providerRouteVideoIntegration.test.js \
  backend-node/test/toapisVideoClient.test.js \
  backend-node/test/toapisVideoIntegration.test.js \
  backend-node/test/featureLockManifest.test.js \
  docs/verification/platform-stability/feature-lock-manifest.json
git commit -m "fix(video): preserve ToAPIs recovery receipt"
```

此提交不推送、不部署、不修改生产 SQLite、不查询供应商、不付费。
