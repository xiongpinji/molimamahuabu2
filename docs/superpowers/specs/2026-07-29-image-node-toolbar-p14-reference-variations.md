# 图片节点工具栏 P14：参考图生成与推演

## 目标

在图片节点上补齐以下六个非核验能力，并复用现有已审计的 Seedream 参考图供应商、任务、派生资产、失败回写和重试链：

- `image_ideation`：画面联想
- `angle_ideation`：角度联想
- `character_views`：角色三视图
- `narrative_grid`：多机位叙事九宫格
- `frame_forward`：画面推演 3 秒后
- `frame_backward`：画面推演 5 秒前

本包不增加核验、侵权检测、版权判断、对口型或相关状态。

## 能力门禁

- 六个操作必须分别由模型设置中的布尔开关显式声明：
  - `supports_image_ideation`
  - `supports_angle_ideation`
  - `supports_character_views`
  - `supports_narrative_grid`
  - `supports_frame_forward`
  - `supports_frame_backward`
- 仅允许当前已审计的 `storyboard_image / volcengine / volcengine / doubao-seedream-4-5` 参考图适配器。
- 一个能力开关不得连带开放其他操作。
- 公开平台模式继续禁用，直到对应计费与审计链具备。

## 输入与输出

- 源图片只能从当前租户素材记录解析，不接受任意路径或远程 URL。
- 每次操作只使用当前图片作为一张参考图。
- 可选 `description` 必须是字符串，去除首尾空白后不得超过 300 字。
- `image_ideation`、`angle_ideation`、`frame_forward`、`frame_backward` 输出与源图同尺寸。
- `character_views` 输出固定 `2048x1536` PNG，单图包含正面、侧面、背面和 3/4 视角。
- `narrative_grid` 输出固定 `3072x3072` PNG，单图包含连续的 3×3 多机位叙事画格。
- 所有结果作为新派生素材入库，不覆盖源素材。
- 供应商空结果、非法图片、尺寸/比例不符、超限产物或与源图哈希相同的结果均失败，不创建成功资产。

## 失败与重试

- 节点失败后保留原图、错误状态、操作名和白名单内的 `description`。
- 刷新后允许用同一操作和参数重试。
- 响应、日志和持久化数据不得包含供应商密钥或原始错误正文。

## 验收

- 每个操作满足 `implemented`、`backend_readback`、`artifact_verified`、`failure_writeback`、`real_browser_verified`。
- 目标测试、图片工具回归、前端回归、生产构建、依赖审计和禁区扫描通过。
- 本地总审计通过前不推送、不创建 PR、不部署。
