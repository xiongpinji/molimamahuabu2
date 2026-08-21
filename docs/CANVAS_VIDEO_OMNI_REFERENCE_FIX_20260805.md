# 视频节点全能参考修复记录（2026-08-05）

## 目标

让独立画布视频节点的“全能参考”模式可以选择、随节点持久化，并把所有已启用的上游图片作为普通参考图传入真实视频生成链路；不得把第一张普通参考图错误声明为首帧。

## 根因

1. `HomeCanvasNode.vue` 将“全能参考”按钮硬编码为 `disabled`。
2. 视频参考模式只按连线插槽临时推断，没有保存到节点数据。
3. 生成请求没有显式的全能参考边界，容易把普通参考图错误映射为首帧字段。

## 最小修复

- 开放“全能参考”选项并提供真实选中状态。
- 将 `videoReferenceMode: 'omni'` 保存到视频节点。
- 全能参考模式把连线统一为 `reference-image`。
- 请求携带 `reference_mode: 'omni'` 和 `reference_image_urls`，并省略 `image_url`、`first_frame_url`、`last_frame_url`。
- 未选择全能参考时保留原有首尾帧和多图参考行为。

## 验证证据

- 红灯单测先复现请求错误，修复后 `standaloneCanvasFreeNodeGeneration.test.js` 通过。
- `home-canvas.spec.js` 实测按钮可选择，`aria-selected=true`，刷新用的节点状态包含 `videoReferenceMode='omni'`。
- 真实浏览器、真实本地后端和模拟视频供应商的同链路测试确认：
  - 供应商收到公开可访问的 `reference_image_urls`；
  - 供应商请求没有 `first_image_url`；
  - 后端生成记录的 `first_frame_url` 为 `null`；
  - 任务能够进入完成终态并返回可见视频。
- 前端生产构建成功。

扩大回归发现一个既有问题：图片/视频生成完成后，数据库任务和素材已完成，但画布布局里的自由节点偶发停留在 `running`。该失败与本次参考模式请求合同独立，未通过删除断言或扩大产品改动掩盖。

## 生产候选

- 实时来源：`/opt/moli-drama/releases/image-asset-model-failover-20260805T153323CST`
- 候选：`/opt/moli-drama/releases/canvas-video-omni-reference-20260805T1619CST`
- 正式生产备份：`database-20260805T081624627Z`，大小 `8564736` 字节，完整性 `ok`。
- 共享门禁验证：`ready=true`，受保护合同 `canvas-credit-callout-v1` 的源码与构建均验证通过。
- 生产预检：`ready=true`，全部检查通过。
- 切换前活动任务硬检查结果：图片任务 `0`、不可恢复异步任务 `0`，6 笔 processing 视频均持有厂商任务 ID，满足服务启动自动恢复条件。
- 共享门禁已完成 CAS 切换，生产 current 指向候选，服务健康检查成功。
- 新进程启动日志确认 6 笔视频轮询全部恢复；其中 1 笔随后因供应商真实人脸参考限制进入失败终态，其余任务继续 processing，该供应商终态与服务重启无关。
- 仍需在已登录的生产浏览器中完成按钮选择与刷新持久化确认；实际提交新视频会扣除积分，不在未确认的情况下执行。
