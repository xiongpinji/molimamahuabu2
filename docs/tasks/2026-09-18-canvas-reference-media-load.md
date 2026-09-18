# 画布连线参考素材加载优化

## 目标

修复线上图片/视频节点「参考图 · 连线自动采用」长时间停在「等待图片」的问题，并恢复分镜画布素材加载的并发与短缓存，且不得引入新的生产回归。

## 线上问题

- 连线后参考槽显示「等待图片」，即使上游节点本体已能预览同一 `/static/` 素材。
- 根因：参考槽对受保护静态地址串行 `fetch→blob`，且无缓存；节点本体却直接使用同源 URL 展示。
- 分镜画布路径仍对每个分镜各发 images/videos 列表请求，无并发上限与短缓存。

## 修改边界（仅此 3 个运行时文件）

1. `frontweb/src/utils/protectedMediaPreview.js`
   - 增加模块级预览缓存与同 URL 进行中请求去重。
2. `frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`
   - 参考预览与节点本体一致：先直接展示同源 URL，再并发换取 blob。
3. `frontweb/src/composables/useCanvasStoryboardMedia.js`
   - 30 秒缓存复用 + 最多 6 并发分镜请求 + 命中缓存后后台静默刷新。

不修改：计费、积分卡片、模型目录、后端 API、供应商调用、画布连线协议、生成提交逻辑。

明确排除：本地调试用的 `PUBLIC_PLATFORM_MODE` 免证据/经济策略降级补丁，不得进入本候选。

## 成功标准

- 连线后参考槽不再长时间空白「等待图片」。
- 二次进入同一分镜集合（30 秒内）不再重复打满列表请求。
- `canvas-credit-callout-v1` 源码与构建合同通过。
- 候选仅覆盖上述审计文件，从实时 `current` 克隆后激活。

## 验证记录

- 专项：`protectedMediaPreview` + `canvasStoryboardMediaLoad` + 画布/积分相关前端契约测试 44/44 通过。
- 本地 `npm run build`（frontweb）通过。
- 候选从实时 `current`（`toapis-image-vip-fix-20260916-r1`）克隆。
- **首轮含 `HomeCanvasNode.vue` 时被共享门禁拒绝**：`EXTERNAL_MODEL_RELEASE_FAILED: migration KM Canary source SHA256 group mismatch`（该文件在 reviewed SHA 白名单中）。按规则未绕过门禁。
- **收窄后实际上线文件仅 2 个**：
  - `frontweb/src/utils/protectedMediaPreview.js`
  - `frontweb/src/composables/useCanvasStoryboardMedia.js`
  - `HomeCanvasNode.vue` 与线上一致（SAME）
- `PROTECTED_RELEASE_VERIFY_ONLY=1` 通过（积分合同、编号提及合同、外部模型证据、目录过渡）。
- 正式激活成功：`activation_success` → `canvas-ref-media-load-20260918104014`（审计 `protected-release-20260918T030401Z-2231398.audit`）。
- 切换后服务 `active`，模型目录接口可达（未登录返回 401）。

## 未上线（需独立门禁升级）

完整「等待图片」即时展示依赖修改 `HomeCanvasNode.vue`，必须先作为**独立安全变更**审查并更新共享 `verify-external-model-release.js` 的 reviewed SHA 组，再做二次候选发布。本轮故意不上，避免绕过门禁。
