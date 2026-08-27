# 一键转绘参考素材导入设计

## 1. 背景

通用一键转绘已经具备源片上传、分析、本地化、角色身份包、逐镜参考准备、参考包、生成门禁和供应商生成服务，但目前缺少两类产品入口：

1. 将用户明确选择的角色身份图写入受控存储、登记为 `assets`，并绑定到当前 `redraw_assets` 角色；
2. 将已经完成全帧净化和人工复核的无声动作参考写入受控存储，并绑定到当前镜头、源片和时间段。

现有本地验收启动器曾通过测试中间件注入用户、使用占位源片并直接修改 `redraw_shots.preparation_state`。这只能证明测试替身可以制造结果，不能证明产品链路成立。本设计关闭真实产品入口缺口，禁止启动器、客户端或导入接口直接写 `reference_ready`。

当前 68.7 秒样片及其 5 张身份图、9 段净化动作参考只是首个验收输入。接口不得写死镜头数、角色数、角色名、语言、国家、供应商或样片路径。

## 2. 目标与非目标

### 2.1 目标

1. 提供窄范围、owner-scoped 的 multipart 导入接口；文件、哈希、MIME、尺寸、时长、路径和归属由服务端验证。
2. 身份图只绑定到当前角色资产；身份包确认和批准继续使用现有接口。
3. 动作参考只登记为当前镜头的已复核候选；当前身份、净景和覆盖事实齐全后，由服务端计算最终覆盖哈希并形成可供参考包验证的资产元数据。
4. 所有导入操作为零积分、零供应商调用、零外部上传；生成仍使用现有服务端报价、预留、提交和结算链路。
5. 同一文件和幂等键可以安全复用；跨 owner、过期版本、文件漂移和并发冲突全部失败关闭。
6. 本地验收必须读取真实源片、真实身份图和真实动作参考，通过真实认证、真实 HTTP 路由、真实 SQLite、真实存储文件和真实状态机完成九镜准备。

### 2.2 非目标

- 不扩展通用 `PUT /redraw/assets/:id` 以接受 `asset_id`、路径、URL、哈希或审核状态。
- 不允许客户端选择 provider、model、价格、积分、配置、证据哈希或文件落盘路径。
- 不允许导入接口写 `reference_bundle_json`、`reference_bundle_hash` 或 `preparation_state='reference_ready'`。
- 不把导入成功视为身份批准、动作净化通过、参考包完成、供应商生成完成或整集交付。
- 不读取 Fumin Key、不调用供应商、不付费、不部署、不写生产数据库。

## 3. 方案选择

采用专用 multipart 导入接口，不扩展现有 metadata 更新接口，也不把本地文件导入伪装成 reference-preparation provider。

原因：

- 通用更新接口当前只处理名称、描述和提示词；允许客户端传 `asset_id` 会扩大信任边界。
- reference-preparation 负责净景、证据复用和参考包收口，不负责接收用户本地文件。
- 专用接口可以在一个服务端事务边界内完成 owner 校验、媒体探测、内容寻址存储、资产登记、CAS 和依赖失效。

## 4. HTTP 合同

### 4.1 角色参考图导入

```text
POST /api/v1/redraw/assets/:id/reference-artifact
Content-Type: multipart/form-data
Authorization: Bearer <真实测试 JWT 或生产凭据>
Idempotency-Key: <UUID>
```

文件字段固定为 `file`。表单字段只允许：

```json
{
  "purpose": "identity | wardrobe",
  "expected_updated_at": "当前 redraw_asset.updated_at"
}
```

约束：

- `:id` 必须是当前 tenant/user/version 下 `kind='character'` 的 `redraw_assets`；不存在或跨 owner 均按不可枚举资源处理。
- MIME 只允许 PNG、JPEG、WebP；必须同时通过扩展名、声明 MIME、magic bytes 和图片解码。
- 最大文件 20 MiB；宽、高必须为正整数。
- 服务端计算 SHA-256，以内容寻址方式原子写入 `redraw-reference-artifacts/<sha256>.<ext>`。
- `purpose=identity` 时，服务端 CAS 更新该角色的 `asset_id`，置 `status='generated'`、`approval_status='pending'`，清空旧批准并失效受影响镜头。
- `purpose=wardrobe` 时，只返回受控 `assets.id`；后续仍由现有 identity-pack 接口绑定。
- 同一张身份合成图可以同时作为 identity 和 wardrobe，但第二次调用必须走相同 owner 校验和幂等合同。

响应只返回业务 ID、服务端计算的媒体摘要、角色当前状态和零计费摘要，不返回本地绝对路径。

### 4.2 动作参考导入

```text
POST /api/v1/redraw/shots/:id/motion-reference
Content-Type: multipart/form-data
Authorization: Bearer <真实测试 JWT 或生产凭据>
Idempotency-Key: <UUID>
```

文件字段固定为 `file`。表单字段只允许：

```json
{
  "expected_updated_at": "当前 shot.updated_at",
  "full_frame_reviewed": true,
  "source_identity_obscured": true,
  "source_text_obscured": true,
  "motion_preserved": true
}
```

这些布尔值是当前登录审核人的显式复核动作，不是客户端自报的 `approval_status`。审核人和审核时间由服务端写入。

约束：

- 镜头必须属于当前 tenant/user/version，且源 work、源 asset、源 fingerprint 和镜头边界可验证。
- 只允许可完整解码的 MP4/H.264；音频流数量必须为 0；宽高必须为正整数。
- 时长必须与 `end_ms - start_ms` 相差不超过 100 ms。
- 最大文件 200 MiB。
- 四个审核布尔值必须全部为 `true`；否则拒绝导入，不能形成可用候选。
- 服务端计算 SHA-256，以内容寻址方式原子写入 `redraw-conditioning/<sha256>.mp4`。
- 首次导入只写 `redraw_motion_import` 元数据：owner、version、shot、source、clip、媒体摘要、审核人、审核时间和审核断言；不接受客户端提供 face/text coverage hash。
- 最终 `redraw_motion_reference` 元数据必须由服务端在当前批准身份和当前批准净景结果齐全后生成。face/text coverage hash 从当前 reviewed coverage、身份绑定和净景结果计算。
- 导入接口不更新 `shot.updated_at`，避免把文件登记伪装成镜头状态推进；幂等和 CAS 记录保存在专用导入记录中。

## 5. 数据与幂等合同

新增 `redraw_reference_artifact_imports`：

```text
id
tenant_id
user_id
version_id
scope_type       character | shot
scope_id
purpose          identity | wardrobe | motion
idempotency_hash
request_hash
file_sha256
stored_asset_id
status           completed | failed
error_code
created_at
updated_at
```

唯一键为：

```text
(tenant_id, user_id, version_id, scope_type, scope_id, purpose, idempotency_hash)
```

规则：

- 相同作用域、相同幂等键、相同请求和相同文件 SHA 返回既有结果，HTTP 200。
- 相同幂等键但请求或文件不同，返回 409 `REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT`。
- `expected_updated_at` 不匹配返回 409 `REDRAW_REFERENCE_ARTIFACT_CONFLICT`。
- 幂等键不跨 tenant/user/version/scope 复用。
- 数据库事务提交失败时删除本次新建且未被引用的文件；已存在的内容寻址文件不删除。
- 不硬删除被历史参考包引用的资产；替换只建立新资产和新绑定，旧资产保留审计。

## 6. 服务端可信动作参考绑定

参考准备编排采用两轮 A 模式流程：

1. 身份图导入后，使用现有 identity-pack 和 asset review 完成身份批准。
2. 动作参考导入并记录人工复核，但不写最终 coverage hash。
3. 首次 reference-preparation 创建真实净景候选；若需要人工审核，镜头进入 `needs_attention`，供应商状态和计费沿用现有合同。
4. 使用现有 asset review 批准净景候选。
5. 服务端从当前 reviewed coverage、当前批准身份和当前批准净景结果构建规范 face/text bindings。
6. 服务端验证动作候选文件未漂移，再写完整 `redraw_motion_reference-v1` 元数据和当前 coverage hash。
7. 再次 reference-preparation 复用已批准净景，调用真实 reference-bundle service，并由 orchestrator 原子写 `reference_ready`、snapshot 和 evidence hash。

为避免复制规则，`redrawReferenceBundleService` 提取一个服务端内部 helper，用于建立当前 face/text bindings；动作绑定和参考包构建复用同一个 helper。

任何 identity、wardrobe、coverage、clean result、source fingerprint、shot boundary 或文件哈希变化都会使旧动作绑定无法被 currentMotionAsset 选中，旧参考包继续 fail closed。

## 7. 零费用与安全边界

两个导入接口必须保证：

- provider 调用 0；
- 外部 HTTP 请求 0；
- Key 读取 0；
- generation submit 0；
- reservation/held/charged 全部为 0；
- 不上传第三方，不暴露源片、绝对路径、Authorization 或供应商凭据。

reference-preparation 自身可能调用已配置净景 provider 并产生报价；这不属于导入接口的零费用保证。零费用本地验收可以注入只负责返回真实可读媒体产物的测试 provider，但该 provider不得直接写 `redraw_assets`、`redraw_shots`、reference bundle、审核或计费状态；所有业务状态必须由真实产品服务和 HTTP 路由写入。

## 8. 本地验收启动器修正

启动器必须：

1. 读取并哈希真实源片、全部身份图和全部动作参考；缺一项立即失败。
2. 使用真实测试用户、租户和有效 JWT，通过现有认证中间件访问 HTTP 路由；禁止 middleware 注入 `req.user`/`req.tenant`。
3. 源片上传真实文件，禁止占位 Blob。
4. 身份图和动作参考只通过本设计的 multipart 路由进入产品。
5. 净景测试 provider 只能产生真实可读媒体并返回 provider 结果，不能写业务状态。
6. 身份 pack、角色 review、净景 review、reference-preparation、preparation gate 和 generation gate 均走真实路由。
7. 安装并最终恢复全局网络 guard；所有非 loopback 请求和危险 ai-config 测试路由均在 handler 前阻断并计数。
8. launcher 将运行上下文与脱敏报告分开：短期测试 JWT 只通过当前进程为子 Playwright 进程设置 `REDRAW_LIVE_PRODUCT_AUTH_TOKEN`，不写入磁盘、stdout、报告或模板；素材路径只保存在本机一次性运行环境，不进入脱敏报告。子进程退出后立即清除这些环境变量。脱敏报告只保留 token 指纹、业务 ID、媒体 SHA、门禁和零计费摘要，可安全对照 `redraw-full-product-live.spec.js` 的执行结果。

## 9. 错误码

- `REDRAW_REFERENCE_ARTIFACT_INPUT_INVALID`
- `REDRAW_REFERENCE_ARTIFACT_NOT_FOUND`
- `REDRAW_REFERENCE_ARTIFACT_CONFLICT`
- `REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT`
- `REDRAW_REFERENCE_ARTIFACT_FORBIDDEN_FIELD`
- `REDRAW_REFERENCE_ARTIFACT_MEDIA_INVALID`
- `REDRAW_REFERENCE_ARTIFACT_TOO_LARGE`
- `REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED`
- `REDRAW_MOTION_REFERENCE_REVIEW_REQUIRED`
- `REDRAW_MOTION_REFERENCE_BINDING_NOT_READY`
- `REDRAW_MOTION_REFERENCE_STALE`

错误响应不包含绝对路径、原始 ffprobe stderr、SQL、密钥、Authorization 或内部 provider 响应。

## 10. 测试矩阵

### 10.1 服务与路由

- identity/wardrobe/motion happy path；
- MIME、magic bytes、解码、尺寸、时长、codec、音轨和大小限制；
- 禁止字段：`asset_id/hash/status/approval_status/provider/model/credits/url/local_path/metadata`；
- 跨 tenant/user/version/scope 不可读；
- 同 key 同文件复用、同 key 不同文件冲突；
- 过期 `expected_updated_at` 冲突；
- 原子落盘、事务失败清理、已有 hash 文件复核；
- 替换后旧依赖失效但旧证据不删除；
- 导入阶段 provider、external fetch、submit、reservation、held、charged 全为 0。

### 10.2 状态机

- 动作导入不能直接产生 `redraw_motion_reference` coverage hash 或 `reference_ready`；
- 净景未批准时动作最终绑定失败关闭；
- 当前身份和净景齐全时服务端产生规范 coverage hash；
- reference-preparation 通过真实 bundle service 写 ready/snapshot/evidence；
- 任一上游变化后 generation gate 拒绝旧 bundle。

### 10.3 本地九镜同链

- 真实源片、5 张身份图、9 段动作参考全部被读取并记录 SHA；
- 5 个角色身份 pack 和 review 通过；
- 9 镜均通过真实参考准备状态机成为 `reference_ready`；
- 9 镜目标语言对白、角色名、时长和静默合同来自服务端当前版本；
- `generation_submits=0`、`external_fetches=0`、计费三项为 0；
- launcher 不注入 auth、不覆盖 service、不直写业务状态；
- 缺任一素材、任一路由错误或任一 gate 不通过时退出非零。

## 11. 完成标准

本设计阶段完成不等于剩余六项完成。实现只有在以下证据同次成立时才算关闭本缺口：

1. 定向后端测试、完整后端回归、前端单元测试和构建通过；
2. 本地九镜产品同链通过，且审计确认没有业务状态直写和外部请求；
3. 独立代码审查确认 owner、幂等、文件安全、状态机和零计费边界；
4. Hosted CI 在当前 HEAD 通过。

真实 Fumin 单镜、整集生成、合并、受保护部署和生产浏览器验收仍是后续独立门禁，分别需要当次精确授权。
