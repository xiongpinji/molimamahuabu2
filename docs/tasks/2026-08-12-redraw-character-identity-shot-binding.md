# 一键转绘角色身份包与逐镜绑定：本地验证记录

日期：2026-08-13  
范围：`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809`  仅本地开发与验证

## 交付内容

- 后端角色身份包服务：服务端从 owner-scoped 资产读取可读图片，计算尺寸、MIME、SHA-256 和稳定包哈希；路径越界、跨租户、TOCTOU、内容漂移和投影失败均 fail closed。
- 后端身份包保存接口：`PUT /api/v1/redraw/assets/:id/identity-pack`。客户端只提交目标演员、已确认视图、真人/18+/一致性确认和 `expected_updated_at`；source key、artifact、hash、ready、reviewer、路径、owner 等字段拒绝接收。
- 审批/逐镜/生成门禁：角色未绑定 ready 身份包不能批准；逐镜绑定保存服务端角色键、身份包哈希和版本；生成请求快照携带 canonical `identity_bindings`。
- 前端确认 UI：目标演员、front/profile/full_body、真人、18+、一致性确认；保存后刷新并提示重新批准；未 ready 禁用批准；逐镜显示源角色 → 目标演员和短哈希。
- 保留 `canvas-credit-callout-v1`，显示“本次预计扣除 X 积分”或“积分待管理员配置”。

## 本地证据

### 单元/服务回归

以下命令在本 worktree 执行并退出码 0：

```text
node --test --test-concurrency=1 backend-node/test/redrawCharacterIdentity.test.js backend-node/test/redrawRoutes.test.js backend-node/test/redrawReviewGate.test.js backend-node/test/redrawShots.test.js backend-node/test/redrawGeneration.test.js frontweb/test/redrawCharacterIdentity.test.js frontweb/test/redrawAssets.test.js frontweb/test/redrawShots.test.js
```

任务 1 身份包联合测试最终 26/26；任务 2 审批/逐镜/生成/路由联合测试最终 205/205；任务 3 路由联合测试最终 116/116；前端目标测试 20/20。`node --check` 与 `git diff --check` 均通过。

### 前端构建

```text
npm run build
```

Vite 生产构建退出码 0，1894 modules transformed；仅有既有大 chunk warning，没有构建错误。

### Playwright 本地 fixture

```text
npm run test:e2e -- e2e/redraw-workspace.spec.js --grep "角色身份包未确认"
npm run test:e2e -- e2e/redraw-workspace.spec.js --grep "第二步资产审核批准后开放门禁|第三步按后端快照编辑"
```

- 新增用例通过：未确认身份包时“服务端未确认”、缺项显示、批准按钮 disabled；勾选目标演员/三视图/真人/18+/一致性后只提交白名单字段，保存刷新为“服务端已确认”，随后才允许批准。
- 既有第二步审核门禁通过（1/1），既有第三步逐镜编辑/失败重试/新片切换通过（1/1）。
- fixture 不上传用户案例、不调用付费供应商、不生成真实视频；不存在真实供应商产物证据。

## 明确边界

- 用户提供的 MP4 仅作为后续本地案例输入，当前阶段未上传、未生成、未消费积分。
- 本次没有 SSH、生产数据库写入、`/opt/moli-drama` 候选制作、activate、部署或 push。
- 线上一键转绘入口仍按既定要求隐藏/暂停访问；本地路由和本地 fixture 验证不等同于线上开放。
- 现有概念图/合照只能作为 `casting_reference` 或普通资产，不能自动升级为生产级真人身份包；必须经过服务端图片证据、人工确认、审批和逐镜绑定门禁。

## 后续建议

1. 在不改变本地门禁的前提下，用用户指定案例做离线媒体分析和截图核对，不调用供应商。
2. 若要进行一次真实付费生成，先重新读取最新 current/CAS、供应商真实生成可用性、价格/余额和共享门禁，再单独取得一次明确提交授权。
3. 只有本地证据和真实供应商/产物/计费/审核链均齐全后，才讨论受保护候选；本记录不构成部署批准。
