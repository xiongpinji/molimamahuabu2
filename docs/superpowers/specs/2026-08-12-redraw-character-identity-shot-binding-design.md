# 转绘角色真人身份包与逐镜绑定设计

## 背景与边界

当前第二步已经能显示后端真实图片，第三步也能保存已批准资产引用，但“角色图片可见”不等于“同一原片角色已经绑定到固定目标演员”。现有拉美演员四人合照仍是 `casting_reference`，不能冒充 Mateo、Diego、Elena、Rafael 四个生产级身份包。

本阶段只做本地代码、自动化测试和浏览器验证；不上传用户源片到第三方，不调用付费模型，不读取供应商 Key，不部署，不访问 `/opt/moli-drama`，不恢复线上入口。

## 目标

1. 每个角色资产保存一份服务端签名的真人身份包快照。
2. 每个镜头把“原片角色 → 目标演员 → 身份包哈希”固化进 `references_json`。
3. 缺少完整身份包、资产未重新批准、镜头绑定缺失或哈希漂移时，生成门禁必须关闭。
4. 第三步同时展示源片时间码、目标演员绑定和英文对白；不伪造生成后视频。

## 方案选择

采用现有 JSON 快照扩展，不新增数据库表：

- 角色身份包写入 `redraw_assets.source_ref_json.identity_pack`。
- 镜头绑定写入 `redraw_shots.references_json`。
- 生成请求的 `request_snapshot` 记录身份绑定摘要。

没有采用新表，因为身份包和角色资产版本一起失效，当前合同不需要跨版本复用。没有只做前端标签，因为前端状态不能作为供应商调用门禁。

## 身份包合同

服务端根据当前角色资产和其底层图片产物生成：

```json
{
  "schema_version": "target-actor-identity-v1",
  "source_character_key": "mateo",
  "target_actor_label": "Mateo",
  "artifact": {
    "asset_id": 101,
    "sha256": "64位小写hex",
    "width": 1024,
    "height": 1536,
    "mime_type": "image/png"
  },
  "confirmed_views": ["front", "profile", "full_body"],
  "live_action_human_confirmed": true,
  "adult_status": "verified_18_plus",
  "identity_consistency_confirmed": true,
  "ready": true,
  "pack_sha256": "64位小写hex",
  "reviewed_by": "当前用户",
  "reviewed_at": "ISO时间"
}
```

- `source_character_key` 从服务端已有 `source_ref.stable_id/id/source_character_id` 推导，客户端不能改写。
- 图片哈希、尺寸和 MIME 由服务端从当前 `asset_id` 对应的本地可读图片计算，客户端不能提交。
- 只有正面、侧面、全身三项齐全，且真人、满 18 岁和身份一致性均人工确认时，`ready=true`。
- 保存身份包后清除旧资产审批；用户必须重新批准该角色资产。
- 现有四人概念合照没有这些角色级证据，因此保持 `ready=false`，不得被自动升级。

## 镜头绑定合同

角色引用在原有 `redraw_asset_id/kind/version_number` 之外增加：

```json
{
  "source_character_key": "mateo",
  "target_actor_label": "Mateo",
  "identity_pack_sha256": "64位小写hex"
}
```

这些字段由后端按当前已批准身份包生成。客户端只提交角色资产 ID，不能自报身份包哈希。身份包更新后，旧镜头引用因哈希不一致变为过期，必须重新保存镜头。

## 门禁与错误处理

- 角色资产缺少完整身份包：`character_identity_pack_required`。
- 镜头没有身份绑定或绑定哈希与当前身份包不同：`character_identity_binding_stale`。
- 尝试批准不完整角色身份包：`REDRAW_CHARACTER_IDENTITY_REQUIRED`。
- 图片不可读、不是受支持图片、路径越界或哈希无法计算：保存身份包失败，不修改数据库。
- 跨租户、跨用户或跨版本访问继续返回不存在，不泄露资源状态。

门禁响应在 `missing` 中保留角色资产 ID、镜头 ID 和可定位锚点，前端展示具体阻塞原因。

## 前端交互

- 角色卡片真实图片下方显示原片角色、目标演员、已确认视图、身份包哈希和就绪状态。
- 用户填写目标演员名，并逐项确认真人、满 18 岁、身份一致性、正面、侧面、全身；保存后提示需要重新批准。
- 不完整身份包的批准按钮禁用；服务端仍做同样的最终校验。
- 分镜引用标签展示“原片角色 → 目标演员”，已选标签展示身份包哈希前 8 位。
- 源片对照和英文对白保持现有布局；生成按钮消费后端门禁，不增加本地绕过开关。

## 验证标准

1. 后端服务测试覆盖所有完整/不完整身份包、哈希、路径、租户和 CAS 情况。
2. 门禁测试证明缺包、旧绑定和哈希漂移都会关闭，完整且当前的绑定才能开放。
3. 路由测试证明身份包证据由服务端计算，客户端不能伪造哈希或原片角色键。
4. 前端单元测试覆盖状态、标签、保存 payload 和禁用条件。
5. 浏览器测试展示真人参考图、身份包表单、具体门禁阻塞和逐镜演员映射；不宣称生成了新真人视频。
6. 相关后端/前端全量回归和前端构建通过；若后端全量仍受既有慢测试超时影响，单独记录，不把目标测试结果外推为全量通过。

