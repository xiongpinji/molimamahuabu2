# 转绘四镜人物去人净景本地门禁设计

## 背景与边界

ToAPIs Mini 480p 整集真实提交已经完成可读性验收，但视觉复刻仍出现原人物残留、人物身份漂移以及原片文字残留。下一阶段先处理“去人”这一前置资产问题：在重绘前准备没有原人物的场景参考图（clean plate），使后续模型有机会重新生成目标演员，而不是直接沿用原片人物。

本阶段只做本地开发、fixture、自动化测试和本地证据报告，不调用 ToAPIs 或其他付费供应商，不读取或写入线上 Key，不访问 `/opt/moli-drama`，不部署、不 activate、不写生产数据库。中文硬字幕和屏幕文字不在本阶段范围内，另列文字清除阶段。

## 目标与非目标

### 目标

1. 为整集验收中最容易暴露人物残留的第 1、6、7、8 镜建立可审计的静态 clean-plate 资产链。
2. 复用现有 `redrawAssetService.generateCleanPlate` 合同，保留原场景版本，并将遮罩、源帧指纹和质量指标写入资产快照。
3. 证明未通过质量门禁或人工审核的 clean plate 不能成为重绘参考。
4. 输出一份本地四镜证据清单，明确“去人净景已验证”与“整段视频已完成去人”之间的边界。

### 非目标

- 不做跨帧人物跟踪、视频级 inpainting 或整段视频擦除。
- 不修复中文硬字幕、屏幕文字、原片对白或口型；这些属于后续独立资产/音频阶段。
- 不把本地 fixture 的通过结果写成真实供应商能力证明，也不改变前端或生产模型目录。

## 方案选择

采用现有 clean-plate 资产合同加四镜本地 runner，不新增数据库表：

- 场景源资产仍保存在 `redraw_assets.asset_id` 对应的原场景版本。
- 人物遮罩通过 `mask_asset_id` 绑定，遮罩必须是当前租户/用户可读且与源场景同尺寸的资产。
- clean plate 通过 `clean_plate_asset_id` 绑定，独立保存并可读；源场景不被替换。
- `source_ref_json.snapshot` 保存 `source_asset_id`、`mask_asset_id`、`input_frame_fingerprint`、`model`、`prompt` 及本地 runner 的非敏感任务标识。
- 质量结果至少包含 `width`、`height`、`mask_area_changed`、`non_mask_similarity`；本地门禁默认以 `non_mask_similarity >= 0.97` 为目标基线。

不采用直接覆盖源图的快捷实现，因为它无法区分原图和净景，也无法在失败后安全回退。不采用整段视频跟踪，因为当前本地范围没有跨帧遮罩与视频修复证据，且会把尚未验证的供应商能力带入本阶段。

## 四镜输入合同

本地 runner 只接受明确的四镜清单，每项必须包含：

```json
{
  "shot_id": "shot-1",
  "source_asset_id": 101,
  "representative_frame": {
    "path": "本地受控目录内的相对路径",
    "sha256": "64 位小写 hex",
    "width": 1280,
    "height": 720,
    "mime_type": "image/png"
  },
  "mask_asset_id": 102,
  "target": "人物去除"
}
```

`shot_id` 仅允许第 1、6、7、8 镜；源帧路径必须位于本地受控存储根目录内，禁止绝对路径、`..` 逃逸和符号链接逃逸。客户端或 fixture 不能提交伪造的源帧哈希；runner 在读取时重新计算并拒绝漂移。

## 生成与快照合同

本地 runner 使用与服务一致的 provider 形状，但 provider 只返回本地 fixture 结果：

```json
{
  "status": "completed",
  "provider": "local-fixture",
  "model": "local-clean-plate",
  "provider_task_id": "fixture-clean-plate-shot-1",
  "clean_plate": true,
  "clean_plate_asset_id": 103,
  "quality": {
    "width": 1280,
    "height": 720,
    "mask_area_changed": true,
    "non_mask_similarity": 0.98
  }
}
```

服务端仍负责：

- 校验源场景、遮罩的租户/用户归属和可读性；
- 保存源帧指纹、遮罩 ID、模型、提示词和任务 ID；
- 要求终态为 completed/succeeded 等成功状态；
- 执行尺寸、遮罩变化和非遮罩相似度门禁；
- 将结果写入 `clean_plate_asset_id`，并把场景资产置为 `needs_attention`、`approval_status='pending'`；
- 在任何异常时保留源场景，失败尝试进入 failed，按既有结算合同退款（本地 fixture 不产生真实扣费）。

## 审核与引用门禁

clean plate 生成成功不等于可用于重绘。四镜证据只有同时满足以下条件，才标记为 `ready_for_reference=true`：

1. 源帧和遮罩指纹仍与快照一致；
2. clean plate 文件可读，尺寸和 MIME 与源场景合同一致；
3. `mask_area_changed=true` 且非遮罩相似度达到 0.97；
4. `clean_plate_asset_id` 指向当前场景版本，未跨租户、跨用户或跨版本；
5. 人工审核状态为 `approved`。

任一条件不满足都必须 fail closed：重绘引用解析返回明确缺失项，不能回退到原场景或直接返回未经审核的 clean plate。身份包和对白/音频门禁仍由既有合同独立负责。

## 本地验证交付物

实现阶段应补充或复用以下本地验证：

1. 四镜 fixture：源帧、人物遮罩和 clean plate 结果，均不含真实供应商调用。
2. 服务测试：完整链路、缺遮罩、跨租户、路径逃逸、源帧哈希漂移、尺寸不一致、遮罩未变化、相似度低于 0.97、结果不可读、审核未通过等失败场景。
3. 本地 runner 输出 JSON manifest 和四镜对照图；manifest 只保存相对路径、哈希、尺寸、状态和错误码，不泄露本机绝对路径或 Key。
4. 验收报告明确记录每镜 `source → mask → clean_plate → review → reference_gate` 状态，并声明不代表整段视频已完成去人。

## 风险与后续阶段

- 静态 clean plate 只能解决代表帧层面的原人物残留；视频运动中的人物边缘、遮挡变化和镜头切换仍需视频级跟踪/inpainting 阶段验证。
- 原片中文硬字幕和屏幕文字不会因人物去除自动消失；下一阶段应建立文字区域资产、清除质量指标和文字内容复核合同。
- 只有在本地四镜门禁和人工审核证据稳定后，才讨论新的真实供应商验证；该决定需要单独的付费前门禁授权。

## 验证标准

- 新增/调整的 clean-plate 目标测试全部通过，失败场景证明源场景未变且不会开放引用。
- `node --check`、`git diff --check` 通过。
- 本地 runner 可重复生成同一 manifest（相同输入指纹得到相同状态），不产生供应商网络请求。
- 报告中的四镜状态与数据库投影、可读文件和审核门禁一致；不把单元测试、fixture 或静态 UI 当作整集真实视频验收。
