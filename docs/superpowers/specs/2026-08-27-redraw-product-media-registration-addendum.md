# 一键转绘产品媒体登记补充规格

## 背景

九镜本地产品验收已经具备角色身份图导入、动作参考导入、审核、参考包绑定和 stale gate，但真实产品链仍缺两个服务端登记点：

1. 审核完成的全帧 coverage 证据树尚不能通过产品入口登记为当前版本的可信 scene asset。
2. 净景 provider 只能返回一个已经存在的 `asset_id`；产品服务尚不能接收 provider 在受控暂存目录产出的本地图片并自行验真、存储和登记。

因此当前 launcher 仍需直接写数据库或覆盖 reference bundle service 才能得到 `reference_ready`，不满足同一次真实产品链验收。

## 目标

补齐上述两个登记点，使本地零费用 provider 只能产出文件和质量证据，所有资产行、转绘状态、审核状态、reference bundle 和 `reference_ready` 都由现有产品服务与 HTTP 路由产生。

## 非目标

- 不新增通用本地路径素材导入接口。
- 不允许客户端提交 evidence root、provider 输出路径、asset id、积分或 reference bundle。
- 不让 provider、launcher 或测试代码写 `assets`、`redraw_assets`、`redraw_shots`。
- 不绕过现有 `POST /redraw/assets/:id/review` 审核接口。
- 不调用外部供应商、不上传、不生成收费内容、不部署。
- 不在本阶段解决真实生成或整集付费验收。

## 产品合同

### 1. 全帧 coverage 候选

新增一个版本级产品入口：

`POST /api/v1/redraw/versions/:id/full-frame-coverages`

客户端仅可提交：

- `expected_version_updated_at`
- `idempotency_key`

路由必须先完成用户、租户和版本 owner 校验，再调用服务端配置的 coverage provider。产品服务创建私有暂存目录并把该目录传给 provider；provider 只能返回 reviewed manifest 的相对路径和 provider task id，不能返回数据库字段或任意绝对路径。

产品服务必须：

- 校验版本 CAS、`facts_hash`、source fingerprint、duration 和镜头时间线。
- 使用现有 `validateReviewedCoverageManifest` 验证 manifest 和证据树。
- 拒绝符号链接、reparse/path escape、缺失文件、hash 漂移和超出清单的关键引用。
- 将证据树复制到 storage root 下的内容寻址目录。
- 为 manifest、frame 和 mask 建立 `assets` 记录。
- 为每个已验证文件建立完整且不可盲信 provider 路径的资产记录：frame/mask 必须为 `type=image` 并写入真实 `mime_type`、`local_path`、`width`、`height`、`file_size` 与 `metadata.sha256`；manifest 必须为 `type=document`、`mime_type=application/json` 并写入真实 `local_path`、`file_size` 与 `metadata.sha256`。
- 建立精确兼容现有 loader 的 owner-scoped coverage `redraw_asset`：`kind='scene'`、初始 `status='generated'`、`approval_status='pending'`、`asset_id` 指向 manifest asset；`source_ref_json.source_ref.stable_id='full-frame-reviewed-coverage'`，且 snapshot 必须包含 `mode='full_frame_reviewed_coverage'`、当前 `version_id`、`facts_hash`、`source_fingerprint` 和 reviewed manifest 的 `analysis_sha256`。
- 返回 coverage redraw asset id、`expected_updated_at` 和 `{ credits: 0, held: 0, charged: 0 }`。
- 使用专用 coverage registration 表记录 request hash、状态、provider task、analysis SHA 和最终 redraw asset id；唯一键为 owner/version/idempotency hash。必须在 `BEGIN IMMEDIATE` 等价事务中先认领 `processing` 再调用 provider：同 key 同请求已完成时重放结果，同 key 不同请求冲突，同 key processing/unknown 时不得再次调用 provider。

coverage 经过现有 review 路由批准后必须形成 `status='generated'`、`approval_status='approved'`、`approved_by/approved_at` 非空的同一行；此时 `loadReviewedReferenceCoverage()` 必须实际读取并返回该 coverage，才允许进入 clean preparation。

### 2. 净景 provider 本地媒体

扩展现有 `generateCleanPlate`/`prepareReferenceCleanRequirement`，兼容 provider 返回：

```json
{
  "status": "completed",
  "provider_task_id": "...",
  "output": { "relative_path": "clean.png" },
  "quality": {}
}
```

产品服务必须先创建私有单次暂存目录，并只接受该目录内普通文件的相对路径。服务端负责：

- 拒绝绝对路径、path escape、符号链接和 reparse。
- 限制文件大小、像素和尺寸；校验 magic、解码格式、MIME、width/height。
- 计算 SHA-256 并原子复制到 `redraw-clean-plates/<sha>.<ext>`。
- 创建 `assets(type=image, category=redraw)`，metadata 保存 canonical SHA。
- 将创建的 asset id 交给现有 `finalizeAssetAttempt`。
- 继续保持 clean redraw asset 为 `needs_attention/pending`，由现有 review 路由批准。
- provider 成功但本地登记或结算结果未知时 fail closed 为 `needs_attention`；不得自动再次调用 provider。
- 无论成功或失败都清理单次暂存目录。

已有 provider 返回已登记 `asset_id` 的兼容路径保留。

### 3. 一等免费模型与计费

当前价格表和管理服务只允许正整数，分析与本地化也会无条件创建预留。为了让“从 source upload 到九镜 ready”保持正式产品合同下的全链零计费，新增一等免费模型语义，而不是测试专用免计费开关：

- `model_credit_prices` 增加 `pricing_mode`，只允许 `paid` 或 `free`。
- `paid` 必须 `credits > 0`；`free` 必须 `credits = 0`。不能仅凭写入 0 或 provider 名称推断免费。
- 管理服务只有在调用方明确提交 `pricing_mode=free` 时才接受 0；既有模型迁移后全部保持 `paid` 和原价格。
- `requirePrice`/`calculateCharge` 对已启用 free 模型返回 0，报价仍是 `priced=true, credits=0`。
- analysis、localization 和 clean asset 尝试在 amount/quote credits 为 0 时不调用 ledger reserve，任务与作品的 reservation id 保持 `NULL`；完成、失败、unknown 和恢复路径只有在 reservation id 存在时才 settle/refund。
- ledger 自身继续拒绝 0 金额；免费任务不能制造 0 金额 reservation 或 ledger 行。
- capability verification、owner/idempotency、provider unknown 与审核门禁均保持不变；免费不等于跳过供应商或状态安全。

本地验收 provider 的模型必须以正式 `pricing_mode=free` 配置。完整链路报告必须以运行前后账本差值证明新增 reservation 数、reserved、held 和 charged 均为 0。

### 4. 最终状态链

1. 真实 source upload、analysis、localization 通过现有产品 HTTP 完成。
2. coverage provider 只产证据文件；产品入口登记为 `generated/pending`。
3. 现有 review HTTP 批准 coverage。
4. 角色身份图和九段动作参考继续通过现有 multipart HTTP 导入并审核。
5. 第一轮 reference preparation 调用净景 provider；产品服务登记 clean 图片，镜头保持 `needs_attention`。
6. 现有 review HTTP 批准 clean assets。
7. 第二轮 reference preparation 复用已批准 clean 结果、绑定 pending motion、保存可信 reference bundle。
8. 只有此时九镜进入 `reference_ready`。

## 安全与失败语义

- owner、version 和 expected timestamp 不匹配：404 或 409，provider 调用为 0。
- coverage/clean provider 结果未知：停止，不重试，保留人工处理状态。
- 任一媒体安全校验失败：不产生可消费资产；清理本次新文件。
- provider 不得获取数据库对象、存储根目录或任意资产写入能力，只接收单次暂存目录和只读输入描述。
- HTTP 响应和报告不得泄露绝对路径、Authorization 或 Key。

## 验收标准

- coverage 登记、重放、并发、CAS、owner、路径逃逸、symlink、hash 漂移测试通过。
- 价格迁移保留全部既有价格并把它们标为 paid；paid 0、free 正数、未显式 free 的 0 均拒绝。
- free analysis/localization/clean 报价为 `priced=true, credits=0`，任务成功且无 reservation/ledger 行；正价回归保持原行为。
- coverage route + review 后必须以真实 `loadReviewedReferenceCoverage()` 读取成功，不允许使用 injected coverage loader。
- clean 本地媒体 happy path、零计费、质量失败、未知状态、路径安全和清理测试通过。
- 真实 HTTP 集成证明 coverage 与 clean 均经过 pending -> approved，且 provider/launcher 未直接写状态。
- clean review 后第二轮 preparation 必须由默认 `redrawReferenceBundleService` 写入 `reference_ready`；不得覆盖该 service 或直接更新 `redraw_shots`。
- launcher 不再覆盖 `referenceBundleService`，不再手写 `reference_ready`，不再使用伪造 source Blob。
- 九镜同一次运行得到 `reference_ready=9`、`generation_submits=0`、`external_fetches=0`、`reserved_credits=0`、`held_credits=0`、`charged_credits=0`。
