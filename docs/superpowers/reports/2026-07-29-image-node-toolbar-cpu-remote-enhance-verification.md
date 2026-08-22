# 图片节点工具栏：无 GPU 远程高清与细节增强验收

## 结论

- 线上轻量服务器不再依赖 Real-ESRGAN NCNN Vulkan 才能提供高清和细节增强。
- 经过审计的火山 Seedream 4.5 参考图配置可显式声明：
  - `upscale`
  - `detail_enhance`
- 本地 Real-ESRGAN 处理链继续作为有匹配运行环境时的可选能力，不进入无 GPU
  服务器的部署前提。
- 对口型与核验、侵权检测、版权判断均未进入本次实现。

## 成品服务与边界

- 服务：火山方舟 Seedream 4.5 图片生成/编辑 API。
- 官方图片生成 API 支持传入参考图片；Seedream 4.5 官方指南声明支持图片编辑和
  参考图生图。
- 参考：
  - <https://api.volcengine.com/api-docs/view?action=ImageGenerations&serviceCode=ark&version=2024-01-01>
  - <https://www.volcengine.com/docs/82379/1829186>
- 服务器只承担输入校验、供应商调用、下载、像素与画幅校验、固定尺寸归一化、素材
  落库，不运行 GPU 模型。

## 能力门控

- 只接受 `storyboard_image + volcengine + volcengine`。
- 模型必须匹配 `doubao-seedream-4-5` 或官方日期后缀版本，例如
  `doubao-seedream-4-5-251128`。
- AI 配置保存时显式写入 `supports_upscale` 和
  `supports_detail_enhance`；配置离开已审计适配器时自动删除声明。
- 未声明、旧版模型、仿冒供应商、缺少 Base URL 或 API Key 时不公布远程能力。
- 公开平台的计费与审计链仍需单独完成；本报告不把本地能力冒充线上可用。

## 处理与产物校验

### 高清增强

- 仅接受 `2x / 3x / 4x`。
- 计算目标像素并在请求前执行 4000 万像素上限检查。
- 供应商返回后校验图片格式、像素上限和画幅偏差。
- 使用 Sharp 归一化到精确目标尺寸并生成独立 PNG 派生素材。

### 细节纹理增强

- 仅接受 `natural / balanced / strong`。
- 远程模型生成后回落到源图片精确尺寸。
- 派生素材记录 `preserveDimensions=true`。

### 通用边界

- 原始素材不覆盖。
- 相同文件、错误画幅、非法图片、空响应和供应商失败均拒绝。
- 上游错误正文、密钥和本地路径不返回前端或失败任务。
- 任务状态、派生素材 ID、URL、引擎和模型版本写入现有图片工具闭环。

## 验证结果

- 后端完整测试：`466 / 466`。
- 前端完整测试：`346 / 346`。
- 前端生产构建：通过。
- 后端生产依赖审计：`0 vulnerabilities`。
- 前端生产依赖审计：`0 vulnerabilities`。
- 定向测试覆盖远程 2x 高清、原尺寸强烈细节增强、源图不变、非法倍率拒绝、
  供应商错误清洗、旧版模型拒绝和本地 Real-ESRGAN 回归。

## 当前门禁

`productComplete=false`

下一门禁是公开平台计费、租户隔离与审计事件闭环。完成该门禁并取得新的真实
Seedream 浏览器同链证据前，不创建 PR、不推送、不部署。
