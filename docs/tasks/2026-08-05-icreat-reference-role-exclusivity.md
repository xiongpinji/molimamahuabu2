# iCreat 视频参考角色互斥修复

## 目标

- 修复生产画布中 `Seedance 2.0 Mini` 多图参考生成被 iCreat 以 HTTP 400 拒绝的问题。
- 多图参考模式只发送 `reference_image`；首尾帧模式只发送 `first_frame` / `last_frame`。
- 后端必须兼容旧前端或其他调用方，即使收到混合字段也不得向 iCreat 发出互斥角色组合。
- 不改模型价格、积分规则、模型开放状态和供应商 Key。

## 现场错误

生产画布 `/canvas/48` 在多图参考模式连接两张图片后，iCreat 返回：

`frame image roles (first_frame/last_frame) and reference roles (reference_image/reference_video/reference_audio) are mutually exclusive scenarios and must not be mixed`

## 根因

1. 前端构造视频请求时，在没有显式 `first-frame` 槽位的多图参考模式下，错误地把第一张普通参考图回退为 `first_frame_url`。
2. iCreat 请求构造器随后同时追加帧角色和其余参考图角色，没有执行供应商要求的场景互斥。
3. 两层行为组合后，第一张图成为 `first_frame`，第二张图成为 `reference_image`，触发 HTTP 400。该问题与本站积分计费无关。

## 修复合同

- 前端只在素材被明确标记为 `first-frame` 时发送首帧字段；普通多图参考不再隐式生成首帧。
- iCreat 后端构造器检测到任一帧角色后，不再追加参考图片或参考音频；没有帧角色时保留多图片和音频参考能力。
- 该防线同时覆盖当前画布、旧客户端和其他后端调用入口。

## 验收门

- [x] 前端失败测试证明多图参考请求曾错误携带首帧字段。
- [x] 后端失败测试证明混合输入曾生成 `first_frame + reference_image`。
- [x] 最小修复后两条失败测试转绿。
- [x] 后端 iCreat 专项测试和前端自由画布专项测试通过。
- [x] 前端生产构建通过，`canvas-credit-callout-v1` 受保护积分卡片仍在源码与产物中。
- [ ] 双轴复审通过。
- [ ] 从生产实时 `current` 克隆候选并通过共享发布门禁。
- [ ] 发布后服务健康、公开站点、错误日志、数据库和 AI 音乐隔离检查通过。

## 红绿证据

- 修复前后端回归用例实际角色为 `['first_frame', 'reference_image']`，预期仅 `['first_frame']`，测试失败。
- 修复前前端多参考用例仍包含 `image_url` / `first_frame_url`，预期不存在，测试失败。
- 修复后两条定向测试均退出码 0；iCreat 专项 13/13、前端自由画布专项 23/23、后端全量 670/670 通过，前端生产构建成功。
- 积分卡片源码与构建产物均检出 `canvas-credit-callout-v1` 和“本次预计扣除”文案。
