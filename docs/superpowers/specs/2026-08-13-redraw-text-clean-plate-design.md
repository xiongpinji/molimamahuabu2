# 转绘字幕与屏幕文字清除本地门禁设计

## 背景与边界

上一阶段已为第 1、6、7、8 镜建立静态人物 clean plate 合同，但整集真实验收仍发现中文硬字幕和场景内屏幕文字残留。人物去除不能自动清除文字；文字清除必须拥有独立的区域遮罩、源帧指纹和质量证据。

本阶段只做本地代码、fixture、自动化测试和脱敏报告，不调用 ToAPIs 或其他付费供应商，不读取或写入线上 Key，不访问 `/opt/moli-drama`，不部署、不 activate、不写生产数据库。第一批只处理第 4、8 镜的静态代表帧，不宣称已完成整段视频文字清除。

## 目标与非目标

### 目标

1. 将“底部硬字幕”和“场景内屏幕文字”建模为两种不同的文字区域类型。
2. 为第 4、8 镜生成可审计的 text mask 与独立 text-clean plate，保留人物 clean plate 和原场景版本。
3. 复用现有 clean-plate 资产存储与审核门禁，通过快照模式区分 `text_subtitle` 与 `text_screen`，不新增数据库表或生产迁移。
4. 证明未通过质量门禁或人工审核的 text-clean plate 不能进入重绘参考。

### 非目标

- 不做整段视频跨帧字幕跟踪、屏幕文字跟踪或视频级 inpainting。
- 不删除场景内的真实道具、标识、包装或建筑文字；遮罩必须明确声明属于 `text_subtitle` 或 `text_screen`。
- 不修改原视频音轨、英文 TTS、口型或角色身份包。
- 不把 OCR/fixture 通过结果当作真实供应商文字清除能力证明。

## 方案选择

采用现有 `redraw_assets` 版本/尝试记录，不新增数据库字段：

- 每个文字清除尝试仍是 `kind='scene'` 的独立资产版本；`clean_plate_asset_id` 指向输出图片，`mask_asset_id` 指向文字遮罩。
- `source_ref_json.snapshot.mode` 固定为 `text_clean_plate`，并增加 `text_kind`：`text_subtitle` 或 `text_screen`。
- `source_ref_json.snapshot.text_regions` 保存脱敏后的区域几何、区域标签和源帧指纹；不保存 OCR 原文、绝对路径或 Key。
- 人物 clean plate 与文字 clean plate 使用不同尝试/版本，不能互相覆盖；引用端必须按当前版本和模式选择已审核资产。

不采用“直接在源图上涂抹文字”的实现，因为无法证明原图未被覆盖，也无法区分字幕与场景文字。不采用整段视频跟踪，因为当前没有跨帧遮罩漂移与视频修复证据。

## 输入合同

本地 runner 只接受第 4、8 镜各一份代表帧，输入结构如下：

```json
{
  "shot_id": "shot-4",
  "source_asset_id": 404,
  "representative_frame": {
    "path": "shots/shot-4/source.png",
    "sha256": "64 位小写 hex",
    "width": 1280,
    "height": 720,
    "mime_type": "image/png"
  },
  "text_regions": [
    {
      "kind": "text_subtitle",
      "shape": "polygon",
      "points": [[0, 620], [1280, 620], [1280, 720], [0, 720]],
      "source": "manual_fixture"
    }
  ],
  "mask_asset": {
    "path": "shots/shot-4/subtitle-mask.png",
    "sha256": "64 位小写 hex",
    "width": 1280,
    "height": 720,
    "mime_type": "image/png"
  },
  "quality": {
    "mask_area_changed": true,
    "non_mask_similarity": 0.98,
    "text_residual": false
  },
  "review": { "status": "pending" }
}
```

- `shot_id` 只允许 `shot-4`、`shot-8`，必须恰好两镜且不可重复。
- `text_kind='text_subtitle'` 只允许底部字幕区域；`text_kind='text_screen'` 只允许场景内屏幕/牌面文字区域。每个 region 必须有合法多边形、非零面积、在源帧边界内。
- runner 读取源帧和 mask 时重新计算 SHA-256，并拒绝绝对路径、`..`、root 外 realpath 和符号链接逃逸。
- mask 与源帧必须尺寸和 MIME 一致；mask 只表达文字区域，不得把整个人物或大块背景当作文字区域。

## 质量门禁

文字清除输出只有同时满足以下条件才允许进入审核：

1. 输出可读，尺寸和 MIME 与源帧一致；
2. `mask_area_changed=true`；
3. 非文字区域相似度 `non_mask_similarity >= 0.97`；
4. `text_residual=false`，fixture 的文字残留检查必须明确失败可重现；
5. 输出与源帧、mask 的指纹绑定仍有效。

质量失败必须 fail closed：尝试状态为 `failed`，不写 `clean_plate_asset_id`，原场景仍可读，任何旧的已批准文字/人物资产不被覆盖。成功生成只将状态置为 `needs_attention`、`approval_status='pending'`；只有人工审核后才可设置 `ready_for_reference=true`。

## 引用门禁

引用解析必须同时检查：

- 当前场景版本与 `source_asset_id` 匹配；
- `snapshot.mode='text_clean_plate'` 且 `text_kind` 与镜头需求一致；
- `mask_asset_id`、源帧指纹和输出文件仍可读且未漂移；
- 文字区域类型与镜头类型一致（字幕不能冒充屏幕文字，反之亦然）；
- `approval_status='approved'`。

任一条件不满足，返回明确的 `text_clean_plate_required` / `text_clean_plate_stale` / `text_clean_plate_review_required` 缺失项，不能回退到带中文字的源场景，也不能把人物 clean plate 当作文字 clean plate。

## 本地验证交付物

实现阶段应提供：

1. 第 4、8 镜 fixture：分别覆盖字幕和屏幕文字，含 source/mask/text-clean plate、SHA-256、尺寸、MIME、区域类型和质量结果。
2. 服务测试：缺镜头、重复镜头、非法区域、路径逃逸、哈希漂移、尺寸/MIME 不一致、mask 未变化、相似度低、文字残留、审核未通过等失败场景。
3. 本地 CLI：输出脱敏 JSON manifest 和 2 镜 contact sheet；manifest 不包含 OCR 原文、绝对路径、Authorization 或 Key。
4. 报告逐镜记录 `source → text_mask → text_clean_plate → review → reference_gate`，明确“不代表整段视频已完成文字清除”。

## 后续阶段

静态两镜门禁稳定后，再单独设计字幕时间段检测、跨帧 mask tracking 和屏幕文字随镜头运动的跟踪；在此之前不得用静态结果宣称整段视频已完成文字清除。

## 验证标准

- 目标测试和本地 CLI 测试全部通过，失败场景证明源场景不变且引用门禁关闭。
- `node --check`、`git diff --check` 通过。
- fixture dry-run 无网络请求、无 Key 读取、可重复生成相同 manifest 结构。
- 报告中的镜头、类型、状态、指纹和文件可读性与本地运行结果一致。
