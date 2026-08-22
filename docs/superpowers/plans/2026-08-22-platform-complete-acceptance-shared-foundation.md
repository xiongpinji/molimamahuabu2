# 平台完整验收阶段 1：公共运行底座完整验收计划

> **执行方式：** 在独立工作树 `platform-acceptance-shared-20260822` 中按 TDD 顺序执行。任何生产代码修改必须先有稳定复现的红灯；没有缺陷时只增加验收覆盖和证据，不改业务代码。

**目标：** 对来源清单中 `module=shared` 的 17 项功能完成同一候选的本地真实后端、SQLite、浏览器、权限、租户、素材和计费闭环；随后经过 Hosted CI 与获批的生产回读，才把对应条目从 `unverified` 变为 `locked_pass` 或 `locked_fixed`。

**基线：** `origin/main@897dfcbc28e3598fbc47e5731c61dfdeda2c9e80`

**明确边界：**

- 不调用图片、视频、文本或音频供应商，不发生模型费用。
- 不真实支付支付宝订单；本地只验证签名、订单、幂等回调和账本。真实支付如被判定为适用证据，必须另获单次金额授权。
- 不写生产数据库、不启用 `enforce`、不激活现有生产候选、不触碰 `/opt/moli-mama`。
- 本地、Hosted CI、生产回读是三层独立证据；任一未完成时不得写 `locked_pass/locked_fixed`。
- 若新红灯需要修改下列测试/证据文件之外的生产文件，先登记缺陷、定位根因并补充本计划的精确文件清单，再实施；不得顺手重构。

## 范围映射

本阶段只处理以下 17 个 `feature_id`：

1. `shared.auth.route_permission`
2. `shared.admin.permission_boundary`
3. `shared.navigation.primary_modules`
4. `shared.billing.credit_account`
5. `shared.billing.generation_catalog`
6. `shared.assets.library_api`
7. `shared.api.auth_session`
8. `shared.api.tenant_member`
9. `shared.api.platform_account_admin`
10. `shared.api.billing_account`
11. `shared.api.billing_catalog`
12. `shared.api.billing_redeem`
13. `shared.api.billing_orders`
14. `shared.api.billing_recharge`
15. `shared.api.billing_admin_pricing`
16. `shared.api.billing_reconciliation`
17. `shared.api.asset_library`

图片/视频/文本/音频节点、画布、短剧工厂和剧本分析业务功能不在本阶段修改。

## 验收证据分层

### 本地可完成

- 真实 Express 路由与隔离 SQLite，不使用 API Mock 代替后端。
- 三种角色的认证、RBAC、租户隔离与写回。
- 公共模型目录、用户积分价格、管理员成本和递归脱敏。
- 素材上传、登记、签名读取、下载、跨租户拒绝和重开恢复。
- 积分账户、兑换码、套餐订单、充值回调、预占/确认/退款/未知冻结和人工对账。
- 并发请求、重复回调、页面刷新和服务实例重启后的幂等恢复。
- Chromium 真实页面连接上述本地后端，不产生外部请求。

### 后续门禁

- Hosted CI：后端全量、前端全量、构建、公共底座 Playwright、功能锁和增量范围均通过。
- 生产只读回读：登录页、公开导航、健康、公共目录脱敏、静态资源和管理员入口的安全状态。
- 生产写入回读：账户/租户/素材/兑换/订单类写操作必须另获生产数据写入授权，并使用专用验收租户；不得借用真实用户数据。
- 支付：若必须完成真实支付宝终态，另行确认金额、账户、次数和硬上限；结果未知立即停止且不重试。

## 任务 1：固定阶段 1 的清单合同与基线

**新增：**

- `backend-node/test/platformSharedFoundationInventory.test.js`

**修改：**

- 无生产文件。

### 步骤 1：先写清单红灯

测试必须断言：

- `module=shared` 精确为上述 17 项，顺序和 `feature_id` 均固定。
- 每项来源路径、测试路径存在，`acceptance_chain` 与 schema 一致。
- 阶段开始时 17 项均没有锁定决策；已有 16 个其他模块 `blocked` 不得被修改。
- 计划文件、后续验收测试和阶段 release scope 在未创建时形成预期红灯。

运行：

```bash
cd backend-node
node --test test/platformSharedFoundationInventory.test.js
```

预期：因阶段 1 验收文件和 release scope 尚不存在而失败；不得通过放宽数量或跳过断言消除红灯。

### 步骤 2：建立最小阶段元数据

只创建本计划中明确列出的测试、证据骨架和 release scope；不修改业务实现。

### 步骤 3：复跑绿灯

运行同一命令，预期通过。

## 任务 2：认证、路由、平台管理员和租户边界

**新增：**

- `backend-node/test/platformSharedAuthAcceptance.test.js`

**复用：**

- `backend-node/src/app.js`
- `backend-node/src/routes/auth.js`
- `backend-node/src/routes/tenants.js`
- `backend-node/src/routes/platformAccounts.js`
- `backend-node/src/services/userAuthService.js`

### 步骤 1：写真实 HTTP 红灯

用隔离临时 SQLite 启动真实 Express，覆盖：

- 未登录访问受保护 API 为 401，普通用户访问平台管理员 API 为 403。
- 注册、登录、`/me`、修改密码、登出后旧令牌失效；响应不含密码摘要、验证码或内部密钥。
- owner/admin/member 的成员读取、邀请、升降级和移除矩阵；另一租户的 ID 不可读写。
- 平台管理员停用账号后旧会话立即失效，普通租户管理员不能执行平台操作。
- 两个并发角色变更不能绕过“最后一个 owner”保护。
- 关闭并重建 app/DB 连接后，合法会话和成员状态按合同恢复，不创建重复成员。

先运行新增测试，记录任何真实失败。若失败源于业务实现，先定位到精确函数并登记 `SHARED-FOUNDATION-###`，再只修改对应源文件。

### 步骤 2：最小修复或保留业务代码

- 无红灯：不改生产文件，证据标记“业务代码未修改”。
- 有红灯：只修复导致该红灯的最小路径，补同类跨租户与重复请求反例。

### 步骤 3：回归

```bash
cd backend-node
node --test --test-concurrency=1 \
  test/platformSharedAuthAcceptance.test.js \
  test/authRoutes.test.js \
  test/userAuth.test.js \
  test/platformRbac.test.js \
  test/platformAdminRoutes.test.js \
  test/platform-admin-service.test.js \
  test/tenantRoutes.test.js \
  test/tenantMemberRoleHierarchy.test.js
```

预期：全部通过，测试后临时数据库和服务进程均被清理。

## 任务 3：模型目录、用户价格、管理员成本与公开脱敏

**新增：**

- `backend-node/test/platformSharedCatalogAcceptance.test.js`

**复用：**

- `backend-node/src/routes/billing.js`
- `backend-node/src/services/canvasModelCatalogService.js`
- `backend-node/src/services/modelPriceService.js`
- `backend-node/src/services/providerRouteCostService.js`

### 步骤 1：写合同红灯

测试使用隔离 SQLite 明确插入：启用/停用、已验证/未验证、配置价格缺失、成本缺失、不同分辨率档位和多个同逻辑模型线路，断言：

- 用户目录只返回当前可公开逻辑模型、能力和用户积分，不暴露 provider、域名、配置 ID、证据、密钥或内部成本。
- 管理员接口可看到线路身份、用户积分和内部成本，并能区分 480P/720P 等档位。
- 用户预计积分与服务端实际报价使用同一档位；无定价时为不可生成状态，不默认成 0。
- 修改配置、能力、价格或成本后旧巡检证据失效；`shadow` 仅记录将被隐藏项，不影响现有用户目录。
- 同逻辑模型多线路不会在用户目录重复显示。

### 步骤 2：最小修复规则

只有测试复现实际泄漏、错误档位或重复公开时才改对应服务；不得借阶段 1 修改供应商适配器或启用 `enforce`。

### 步骤 3：回归

```bash
cd backend-node
node --test --test-concurrency=1 \
  test/platformSharedCatalogAcceptance.test.js \
  test/billingPublicCatalog.test.js \
  test/modelPrice.test.js \
  test/canvasModelCatalogService.test.js \
  test/providerCanaryPublicGate.test.js \
  test/providerRouteCost.test.js \
  test/aiConfigPublicView.test.js
```

## 任务 4：素材、静态文件、签名读取与下载边界

**新增：**

- `backend-node/test/platformSharedAssetAcceptance.test.js`

**复用：**

- `backend-node/src/routes/assets.js`
- `backend-node/src/middleware/resourceOwnership.js`
- `backend-node/src/services/assetService.js`
- `backend-node/src/services/providerAssetUrlService.js`

### 步骤 1：写产物闭环红灯

在临时 storage root 中生成最小 PNG、MP4 和 MP3，走真实 API 验证：

- 上传/登记后可按本租户和项目读取，文件魔数正确。
- 数据库关闭重开后资产仍可查询、预览和下载。
- 普通静态路径、签名路径和下载路径均拒绝 `..`、绝对路径、编码逃逸、符号链接/Junction 逃逸和另一租户资源。
- 签名 URL 过期、篡改、缺失会失败；日志和用户响应不泄露存储绝对路径或签名 secret。
- 删除只删除本记录允许的资源，不影响同文件派生记录或另一租户资产。

### 步骤 2：最小修复

只修复红灯对应的 ownership、路径 canonicalization 或回写事务；不重构素材库 UI。

### 步骤 3：回归

```bash
cd backend-node
node --test --test-concurrency=1 \
  test/platformSharedAssetAcceptance.test.js \
  test/canvasAssetPersistence.integration.test.js \
  test/standaloneCanvasAssetIsolation.test.js \
  test/providerAssetSignedAccess.test.js \
  test/projectOwnership.test.js \
  test/mediaUpload.integration.test.js
```

## 任务 5：积分、兑换、订单、充值与人工对账状态机

**新增：**

- `backend-node/test/platformSharedBillingAcceptance.test.js`

**复用：**

- `backend-node/src/routes/billing.js`
- `backend-node/src/routes/alipay-recharge.js`
- `backend-node/src/services/billingReconciliationService.js`
- `backend-node/src/services/subscriptionBillingService.js`
- `backend-node/src/services/redeem-code-service.js`

### 步骤 1：写账本红灯

在隔离 SQLite 中验证：

- 积分账户、流水和套餐目录严格租户隔离，余额只来自账本事实。
- 同一兑换码、订单幂等键、支付回调 ID 和退款请求重复提交均只产生一次状态变化和一次账本分录。
- 明确成功确认、明确未受理失败退款、提交/结果未知保持 held，人工对账后才转终态。
- 管理员价格/成本写入权限与普通用户只读 DTO 分离。
- 支付宝回调只接受有效签名和合法金额/订单绑定；无效、错租户、错金额和并发重复回调均不入账。
- 关闭并重开 DB/app 后继续处理同一回调不重复加分。
- 所有测试只使用本地签名夹具，不请求支付宝网络。

### 步骤 2：最小修复

若发现账本或回调缺陷，必须保持一条事务内的业务状态、账本和审计一致性；禁止用“捕获后继续”掩盖部分提交。

### 步骤 3：回归

```bash
cd backend-node
node --test --test-concurrency=1 \
  test/platformSharedBillingAcceptance.test.js \
  test/billingRoutes.test.js \
  test/billingAdminRbacRoutes.test.js \
  test/billingReconciliation.test.js \
  test/redeem-code-routes.test.js \
  test/redeem-code-service.test.js \
  test/subscriptionBillingRoutes.test.js \
  test/subscriptionBillingService.test.js \
  test/alipay-recharge-routes.test.js
```

## 任务 6：真实浏览器连接本地后端

**新增：**

- `frontweb/e2e/platform-shared-foundation-backend-integration.spec.js`

**修改：**

- `frontweb/package.json`
- `.github/workflows/frontend-e2e.yml`

### 步骤 1：浏览器红灯

新增串行 Playwright 规格，像现有真实后端画布规格一样启动临时后端与 SQLite，但不启动任何供应商夹具。覆盖：

- 匿名访问首页和导航；受保护页跳登录并恢复原地址。
- 用户登录后读取账户、工作区、模型目录和素材，刷新后保持会话与租户。
- owner/admin/member 的页面按钮与后端 403 一致。
- 平台管理员看到账号、价格、成本和对账入口；普通用户 DOM 与网络响应均无中转/成本/配置身份。
- 本地素材上传、预览、下载和刷新恢复。
- 本地兑换/订单/充值展示与重复操作保护；不创建真实支付或外部请求。
- 390、1024、1440 三个视口无横向泄漏，错误状态不会覆盖可操作控件。

为所有非本地 origin 设置 route abort，并断言外部请求计数为 0。

### 步骤 2：固定本地与 CI 命令

`frontweb/package.json` 增加：

```json
"test:e2e:shared-foundation": "playwright test e2e/platform-shared-foundation-backend-integration.spec.js"
```

`.github/workflows/frontend-e2e.yml` 在现有依赖安装后新增独立 step 运行该命令；不得替换或跳过现有 canvas E2E。

### 步骤 3：绿灯

```bash
cd frontweb
npm run test:e2e:shared-foundation
```

预期：全部通过，测试后后端进程、临时数据库、storage 和浏览器产物按路径边界清理。

## 任务 7：记录本地同批证据，但保持未完成门禁

**新增：**

- `docs/verification/platform-stability/platform-shared-foundation-verification.md`
- `deploy/release-scopes/platform-complete-acceptance-shared-foundation.json`

**修改：**

- `backend-node/test/incrementalReleaseScope.test.js`

### 步骤 1：证据文档

记录：基线/候选 SHA、17 项清单、红灯、修复提交（如有）、本地命令、exit code、测试数、依赖 lock SHA、临时资源清理、secret 扫描和仍阻断的 CI/生产/支付门禁。不得把未执行项写成通过。

### 步骤 2：精确 release scope

scope 仅包含本阶段实际改动文件，禁止目录通配、运行数据库、storage、用户资产、AI 音乐、共享 release guard 和其他阶段业务文件。测试必须拒绝同数量偷换任一文件。

### 步骤 3：本地验证

```bash
cd backend-node
node --test \
  test/platformSharedFoundationInventory.test.js \
  test/incrementalReleaseScope.test.js
node scripts/verify-platform-feature-acceptance.js
```

预期：结构验证 exit 0，但 `--require-complete` 仍因其他阶段和本阶段尚缺 CI/生产证据而 exit 1；该阻断是正确行为。

## 任务 8：本地候选全量回归与实现 PR

### 步骤 1：全量门禁

```bash
cd backend-node && npm test
cd ../frontweb && node --test test/*.test.js
npm run build
npm run test:e2e:shared-foundation
cd ../backend-node
npm run audit:feature-lock
node scripts/verify-incremental-release-scope.js \
  --manifest ../deploy/release-scopes/platform-complete-acceptance-shared-foundation.json \
  --candidate .. \
  --parent-git origin/main
```

另执行：

- `git diff --check origin/main...HEAD`
- 变更文件精确 allowlist 比对。
- 密钥、Authorization、Cookie、邮箱、手机号、绝对生产路径和供应商原始响应扫描。
- 确认没有跟踪 `node_modules`、测试数据库、上传文件、Playwright trace 或截图。

### 步骤 2：独立复审

进行规格符合性与质量审查；任何 P0/P1 必须先修复并完整复跑。由于当前会话未获并行代理授权，复审在当前任务内独立重新读取差异完成，不创建子代理。

### 步骤 3：实现 PR

仅在用户明确要求后推送和创建 PR。Hosted CI 未绿前不合入，不制作生产候选。

## 任务 9：Hosted CI、受保护生产回读与验收锁闭环

本任务必须在任务 8 合入后，从届时实时 `main` 和实时 `/opt/moli-drama/current` 重新开始。

### 步骤 1：Hosted CI

确认后端、前端浏览器、依赖安全和功能锁工作流在合并提交上全部通过；记录 run URL、commit SHA 和结论。

### 步骤 2：生产只读预检

- 读取实时 `current`、服务状态、活动任务、冻结积分、磁盘、日志和 AI 音乐 PID/端口。
- 从实时 current 克隆新候选，只叠加精确 allowlist。
- 构建、预检和共享 release guard 必须通过。
- 活动任务非零、部署锁冲突、CAS 漂移或 AI 音乐隔离异常时停止。

### 步骤 3：单独授权后才激活或写生产数据

激活必须使用：

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

生产写入验收和真实支付分别需要新的明确授权；结果未知立即停止且不重试。

### 步骤 4：证据闭环 PR

在所有适用证据齐全后：

**修改：**

- `docs/verification/platform-stability/platform-feature-acceptance.json`
- `docs/verification/platform-stability/feature-lock-manifest.json`
- `backend-node/test/platformFeatureAcceptance.test.js`
- `backend-node/test/featureLockManifest.test.js`
- `docs/verification/platform-stability/platform-shared-foundation-verification.md`

规则：

- 17 项逐项写 `locked_pass`、`locked_fixed` 或有用户批准依据的 `not_applicable`。
- 每个 `acceptance_chain` 的证据类型齐全，`candidate_commit` 一致。
- 真实支付或生产写入未授权时，对应条目保持 `blocked`，不得省略。
- 新增 `stability.platform-shared-foundation` 锁，固定保护路径、测试和不可变证据历史。
- 触碰已有锁保护路径时必须写新的批准解锁记录和影响测试。

## 阶段 1 完成条件

只有同时满足以下条件才可报告“公共底座验收完成”：

1. 17 项均有明确决策，没有未解释的 `unverified` 或 `blocked`。
2. 本地真实后端、SQLite、浏览器、刷新/重启、并发、素材、账本和脱敏证据全部通过。
3. 后端全量、前端全量、生产构建、Playwright、Hosted CI、功能锁和精确范围全部通过。
4. 生产候选来自操作时实时 `current`，经共享门禁激活并完成回读；或经书面证明本阶段无运行时代码变化且用户批准生产激活不适用。
5. 生产写入和支付类条目完成获批验收，或保持阻断；不得用本地 Mock 替代。
6. 没有未解决 P0/P1，没有未知账本状态，没有不可读取产物，没有外部请求或测试残留。
7. AI 音乐进程、端口和文件树前后不变。

完成后才能进入阶段 2“图片节点完整验收”。
