# 一键转绘产品媒体登记实现计划

> **执行方式：** 使用子代理驱动开发；每个实现任务先写红灯，再写最小实现，并依次完成规格审查与代码质量审查。

**目标：** 补齐 coverage 与 clean 本地媒体的服务端登记点，解除九镜同链 launcher 对直写数据库和 service override 的依赖。

**架构：** 新增窄范围 coverage registration service 和一个版本级触发路由；扩展现有净景服务以接收服务端私有暂存目录中的 provider 图片。继续复用现有 assets、redraw assets、review route、reference preparation 与 reference bundle 状态机。

## 任务 A：正式免费模型计费语义

**文件：**

- 创建：`backend-node/migrations/67_model_credit_price_free.sql`
- 修改：`backend-node/src/services/modelPriceService.js`
- 修改：`backend-node/src/services/redrawOrchestrator.js`
- 修改：`backend-node/src/services/redrawLocalizationOrchestrator.js`
- 修改：`backend-node/test/modelPrice.test.js`
- 修改：`backend-node/test/redrawAnalysis.test.js`
- 修改：`backend-node/test/redrawLocalizationOrchestration.test.js`
- 修改：发布范围与特性锁测试

步骤：

1. 写迁移保真、paid/free 互斥约束、管理 set 显式 free、free quote、analysis/localization 零 reservation/ledger、正价不回归的红灯。
2. 迁移重建 `model_credit_prices`，新增 `pricing_mode`；既有行全部保留并设为 `paid`，约束 `paid > 0`、`free = 0`。
3. `modelPriceService.set` 只有显式 `pricingMode=free` 才接受 0；read/list/cost snapshot 均携带 mode。
4. analysis/localization 在 0 积分时创建正常任务但不调用 ledger；所有 settle/refund/recovery 分支只处理非空 reservation id。
5. 跑模型价格、分析、本地化定向测试与相关回归；规格/质量审查通过后提交。

## 任务 B：Coverage 产品登记服务

**文件：**

- 创建：`backend-node/src/services/redrawCoverageRegistrationService.js`
- 创建：`backend-node/migrations/68_redraw_coverage_registrations.sql`
- 创建：`backend-node/test/redrawCoverageRegistration.test.js`
- 修改：`backend-node/test/featureLockManifest.test.js`
- 修改：`backend-node/test/incrementalReleaseScope.test.js`

步骤：

1. 写 owner/CAS、manifest/version 对齐、媒体安全、同 key 重放/冲突、同 key 并发单 provider 调用、unknown 不重提、零计费红灯。
2. 运行定向测试并保存失败证据。
3. 迁移创建 owner/version/idempotency hash 唯一登记表，保存 request hash、`processing/completed/needs_attention/failed`、provider task、analysis SHA、redraw asset id 和错误码；在 immediate transaction 中认领后才能调用 provider。
4. 实现私有 staging、reviewed manifest 验证和只复制 manifest 引用的必需证据；frame/mask 资产必须写 `type=image`、真实 MIME/尺寸/大小/相对路径/SHA，manifest 资产必须写 `type=document`、`application/json`、真实大小/相对路径/SHA。
5. coverage `redraw_assets` 必须精确为 `kind=scene`、`status=generated`、`approval_status=pending`、`asset_id=manifest asset`，并写入 loader 要求的 stable id、mode、version/facts/source/analysis snapshot。
6. 运行定向测试到绿灯，并通过真实 review 后调用默认 `loadReviewedReferenceCoverage()` 证明可消费。
7. 完成规格审查与质量审查；修复后提交。

## 任务 C：Coverage 版本级 HTTP 入口

**文件：**

- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

步骤：

1. 写认证/租户/owner 在 provider 前、字段白名单、错误脱敏和公开响应红灯。
2. 新增 `POST /redraw/versions/:id/full-frame-coverages`，客户端不能控制路径、provider、asset id 或积分。
3. 运行 route 和 service 定向测试。
4. 完成规格审查与质量审查；修复后提交。

## 任务 D：Clean provider 本地媒体登记

**文件：**

- 修改：`backend-node/src/services/redrawAssetService.js`
- 创建或修改：窄范围媒体 helper（仅在能明显避免复制且不扩大产品入口时）
- 修改：`backend-node/test/redrawAssets.test.js`
- 修改：`backend-node/test/redrawReferencePreparationOrchestration.test.js`

步骤：

1. 写本地图片 happy path、零积分、质量失败、未知状态不重试、路径逃逸/symlink、落盘失败清理红灯。
2. 运行定向测试并确认失败来自未实现合同。
3. 让产品服务创建单次 staging，provider 只写相对输出；服务端验真、内容寻址、创建 asset 并走现有 finalize。
4. 保持 pending review 和已有 provider asset-id 兼容路径。
5. 运行定向测试与 reference preparation 两轮回归。
6. 完成规格审查与质量审查；修复后提交。

## 任务 E：真实产品 HTTP 同链回归

**文件：**

- 修改：`backend-node/test/redrawReferencePreparationOrchestration.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`
- 视必要创建：`backend-node/test/redrawProductMediaChain.test.js`

步骤：

1. 通过真实路由完成 coverage candidate -> review；断言默认 `loadReviewedReferenceCoverage()` 返回 approved coverage 后，才执行 clean preparation。
2. 通过第一轮 preparation 得到 clean candidate -> review -> 第二轮 preparation -> reference_ready；断言使用默认 `redrawReferenceBundleService`，不得注入 coverage loader、保存 bundle service 或直接更新 `redraw_shots`。
3. 断言 provider 只产文件，不直接写 DB；无 reference bundle override；所有 billing delta 为 0。
4. 跑相关后端测试与全量后端回归。
5. 完成规格审查与质量审查；修复后提交。

## 任务 F：恢复原 Task6 launcher

**文件：**

- 修改：`frontweb/e2e/support/redraw-live-product-harness.mjs`
- 修改：`frontweb/scripts/run-redraw-live-product.mjs`
- 修改：`frontweb/e2e/redraw-live-launcher.spec.js`
- 修改：`frontweb/e2e/redraw-full-product-live.spec.js`

步骤：

1. 删除 source Blob、`req.user/req.tenant` 注入、reference bundle override 和 direct-ready 写入。
2. 使用真实登录/租户链、真实本地 source/5 张身份图/9 段 motion、coverage route、review route 和两轮 preparation。
3. 安装覆盖 global fetch、node:http、node:https 和 undici 的全局网络 guard；仅允许本地服务。
4. 断言九镜 ready、0 generation submit、0 external fetch、0 provider paid submit、0 reserved/held/charged。
5. 跑 Playwright launcher、脚本和九镜同链；完成规格/质量审查后提交。

## 任务 G：证据与收口

1. 运行后端全量、前端 build/targeted Playwright/launcher。
2. 写 `docs/superpowers/reports/2026-08-27-redraw-product-media-registration-local-evidence.md`，记录命令、退出码、计数、SHA 和未执行门禁。
3. 独立最终代码审查和验证审查。
4. 只有本地与 Hosted CI 均通过后，才向用户申请后续 push/PR；真实供应商、付费、合并和部署仍需分别授权。
