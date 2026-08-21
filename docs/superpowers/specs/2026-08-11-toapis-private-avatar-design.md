# ToAPIs 虚拟人像接入设计

## 目标

让画布中由本平台 AI 生成的人物图片，在调用 `seedance-2-fast` 或 `seedance-2-mini` 前自动进入 ToAPIs 虚拟人像素材库，待素材状态为 `active` 后使用受信任的 `asset://` 地址生成视频，避免直接公网图片被误判为真人。

## 官方合同

- 创建素材组：`POST /v1/videos/doubao-seedance-2-0/private-avatar/groups`。
- 创建素材：`POST /v1/videos/doubao-seedance-2-0/private-avatar/assets`。
- 查询素材：`GET /v1/videos/doubao-seedance-2-0/private-avatar/assets/{asset_id}`。
- 只有 `active` 素材可以提交到 `POST /v1/videos/generations`。
- 生成请求继续使用既有 `first_frame`、`last_frame`、`reference_image` 角色；只把对应 URL 换为供应商返回的 `asset://pa_...`。

## 数据和信任边界

新增 `toapis_private_avatar_assets` 缓存表，以 `ai_service_config_id + source_kind + source_id + asset_type` 唯一绑定平台素材与供应商素材。记录 `group_id`、`asset_id`、`asset_url`、状态和脱敏错误。

只有 `videoService` 已验证属于当前项目、且来源是 `image_generations` 或带 `image_gen_id` 的平台资产，才标记为 AI 生成素材。浏览器传入的 `asset://` 一律继续拒绝。生成客户端只接受本次后端解析得到、数据库状态为 `active` 的 `asset://`。

## 数据流

1. `videoService.create()` 完成租户、项目、素材所有权、模型能力和计费检查。
2. 对已确认的 AI 生成图片保存不可伪造的来源标识到内部请求快照。
3. 异步提交前，虚拟人像服务按来源标识查缓存；没有缓存则创建单素材组并提交图片。
4. 轮询至 `active`；`processing` 继续等待，`failed` 明确失败并走现有退款路径。
5. 用缓存中 `active` 的 `asset_url` 替换对应首帧、尾帧或参考图 URL，再走现有 ToAPIs 生成和轮询。

## 隔离原则

- 仅 `toapis_video` 协议且仅 Fast/Mini 启用。
- 非 AI 生成图片继续走现有公网 HTTPS URL。
- 不修改其他供应商、模型能力、价格、参考数量和画布积分卡片合同。
- 不自动重试结果不确定的建组或素材提交，避免重复外部副作用。

## 验证标准

- 单元测试覆盖三个官方接口、状态解析、缓存复用、失败与超时。
- 回归测试证明任意客户端 `asset://` 仍被拒绝，只有服务端受信任列表允许。
- 集成测试证明 AI 生成图片变为 `asset://`，普通上传图片保持 HTTPS，角色顺序不变。
- 后端相关测试、完整后端测试、前端测试与构建全部通过。
- 真实验收另行执行：同一 AI 人物图分别生成 Fast 480P/4 秒和 Mini 480P/4 秒，核对可播放成品、耗时和供应商成本。

## 2026-08-11 真实验证结果

- 来源：项目 48 已完成的 `image_generation:344`，模型 `gpt-image-2-2k`，原图 SHA-256 `18c212d306def1712876481192f1f0e84ec9a642f7ef4ddef108a605b73e3dff`。
- 虚拟人像素材：group `pg_01KZQFMXYB0ZFGV9Q9A00GQZSX`，asset `pa_01KZQFMZ8K4C49THKMRFXZXH93`，终态 `active`。
- Fast：任务 `tsk_vid_01KZQFNBPT74AJ37VHFDGFGZ0R`，480P/4 秒，104.001 秒完成，扣除 32 credits；成品 864×496、4.041667 秒、H.264、SHA-256 `a514dec8698b69632dbb443e518c885c149329379718b2928713b911cbd30a97`。
- Mini：任务 `tsk_vid_01KZQFRJEFPVYH6JB0CKS5W3ZA`，480P/4 秒，104.137 秒完成，扣除 11.4288 credits；成品 864×496、4.041667 秒、H.264、SHA-256 `3f4ef92e6ab103699429f74cd44b5bdcbe53829def416ebad29c22c5408ccf58`。
- 两个模型各提交一次、零自动重试；总扣除 43.4288 credits。首帧/中帧/尾帧人工检查均为同一 AI 探险者，存在连续位移和视线变化，无黑屏或静帧。
- 私有原始证据路径：`C:\Users\canqu\AppData\Local\Temp\toapis-private-avatar-real-20260811T1345\toapis-private-avatar-verification.json`。证据不包含 API Key 或签名素材 URL。
