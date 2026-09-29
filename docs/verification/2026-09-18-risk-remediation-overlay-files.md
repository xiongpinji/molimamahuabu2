# 隐患治理 + 用户安全预部署 — 审计覆盖文件清单

日期：2026-09-18
门禁：`verify:risk-remediation-gate` + `verify:user-safe-predeploy-gate`
生产注意：不要开启 `AI_CONFIG_ENCRYPT_AT_REST`

## 后端运行时

- backend-node/src/app.js
- backend-node/src/middleware/resourceOwnership.js
- backend-node/src/routes/index.js
- backend-node/src/routes/drama.js
- backend-node/src/routes/characterLibrary.js
- backend-node/src/routes/propLibrary.js
- backend-node/src/routes/sceneLibrary.js
- backend-node/src/routes/settings.js
- backend-node/src/routes/libraryOwnership.js
- backend-node/src/routes/redraw.js
- backend-node/src/routes/redraw/index.js
- backend-node/src/routes/redraw/catalog.js
- backend-node/src/services/aiConfigService.js
- backend-node/src/services/secretBox.js
- backend-node/src/services/platformCapabilityService.js
- backend-node/src/services/generationLimits.js
- backend-node/src/services/taskService.js
- backend-node/src/services/billingReconciliationService.js
- backend-node/src/services/providerReconciliationService.js
- backend-node/src/services/productionPreflightService.js
- backend-node/src/services/dramaService.js

## 前端运行时

- frontweb/src/api/drama.js
- frontweb/src/views/DramaCanvas.vue
- frontweb/src/composables/useCanvasRemoteSync.js
- frontweb/src/utils/canvasRemoteSync.js

## 门禁/部署脚本（候选内可选，不强制覆盖生产运行时）

- backend-node/package.json
- backend-node/scripts/verify-risk-remediation-gate.js
- backend-node/scripts/verify-user-safe-predeploy-gate.js
- deploy/install-protected-release-guard.sh
- deploy/rotate-reviewed-source-group.sh