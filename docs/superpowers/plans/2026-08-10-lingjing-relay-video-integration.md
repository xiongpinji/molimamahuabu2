# 灵境 Relay 视频模型接入实施计划

> **面向 AI 代理的执行者：** 必须使用 `executing-plans` 在当前会话逐项实施；如果用户明确要求委派，才可改用 `subagent-driven-development`。每个任务均先写失败测试，再做最小实现、复验并提交。

**目标：** 将 `seed.alimyun.xyz` 的上游 `relay` 渠道以稳定公开模型 ID `lingjing-video-v1` 接入管理员后台、首页、画布和短剧工厂；只开放供应商文档和一次真实生成共同证明的能力，并用严格证据、价格和发布门禁阻止错协议、错能力或未验证模型重新暴露。

**架构：** 新建独立 `lingjing_open` 客户端，彻底停止把灵境请求伪装成 `xai` 或 `aihubcc`。配置层保存公开模型 `lingjing-video-v1`，供应商请求固定翻译为 `model_key: "relay"`。创建任务前与供应商提交前各执行一次同源能力、证据和价格校验；所有前端入口只消费 `/canvas/model-catalog`。真实验证脚本只提交一个 4 秒、单张非真人参考图用例，记录任务、成品、速度和费用证据，成功后配置事务才允许启用模型。

**技术栈：** Node.js CommonJS、`node:test`、SQLite/`better-sqlite3`、Vue 3、Element Plus、Vite、`ffprobe`、systemd/nginx、共享外部模型证据门禁和受保护 release guard。

---

## 固定合同

- 公开模型 ID：`lingjing-video-v1`
- 默认展示名：`灵境 Seedance 2.0 Fast（9 图参考）`
- 独立协议：`lingjing_open`
- 供应商 Base URL：`https://seed.alimyun.xyz/api/open/v1`
- 上游模型键：`relay`
- 创建：`POST /videos`
- 查询：`GET /videos/{task_id}`
- 下载：`GET /videos/{task_id}/download`
- 上传：`POST /uploads`
- 时长：`4、5、6、8、10、11、15` 秒
- 画幅：`16:9、9:16、1:1、4:3、3:4、21:9`
- 引用：最多 9 张图片；不开放首尾帧、视频参考、音频参考、动作模仿和同步音频
- 成品：允许供应商返回的 MP4 自带音轨；该音轨不代表支持 `reference_audios` 或 `generate_audio`
- 分辨率：供应商目录返回空数组；前端隐藏清晰度，后端不发送 `resolution`
- 数量：固定 1
- 每次请求：生成不可复用 `request_id`
- 真实生成前：配置保持非公开；连接测试和 `/models` 读取不得把状态升级成 `verified`

## 文件结构

- 新建 `backend-node/src/services/lingjingVideoClient.js`：官方主机锁、URL、请求体、上传、创建、查询、下载和解析。
- 修改 `backend-node/src/services/aihubccClient.js`：删除 `lingjing-video-v1` 特判，AIHubCC 不再承载灵境协议。
- 修改 `backend-node/src/services/videoClient.js`：选择 `lingjing_open`、提交前终端门禁、轮询和成品下载。
- 修改 `backend-node/src/services/videoService.js`：任务/预扣前验证配置、能力、引用、时长、画幅和价格。
- 修改 `backend-node/src/services/videoReferenceCapabilityService.js`：灵境只允许 9 张图片参考。
- 修改 `backend-node/src/services/aiConfigService.js`、`backend-node/src/routes/aiConfig.js`：管理员协议、端点和连接测试语义。
- 修改 `backend-node/src/services/canvasModelCatalogService.js`、`backend-node/src/services/modelPriceService.js`：严格目录和无分辨率的按秒计价。
- 修改 `backend-node/src/services/canvasProviderConfigService.js`：移除旧 `aihubcc_video/aihubcc` 默认映射，改为专用协议默认值。
- 修改 `backend-node/src/services/externalModelEvidenceService.js`：绑定灵境证据合同。
- 修改 `frontweb/src/components/AIConfigContent.vue`：管理员预设、展示名和协议。
- 修改 `frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`、`frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue`：隐藏空分辨率、只开放多图参考。
- 修改 `frontweb/src/utils/canvasModelCapabilities.js`、`frontweb/src/utils/freeCanvasGeneration.js`、`frontweb/src/utils/homeQuickGeneration.js`、`frontweb/src/utils/videoGenerationRequest.js`：统一能力、请求字段和计价。
- 修改 `frontweb/src/views/FilmList.vue`、`frontweb/src/views/FreeCreate.vue`、`frontweb/src/views/FilmCreate.vue`：首页和短剧入口同步目录并隐藏不适用参数。
- 新建 `backend-node/scripts/verify-lingjing-video-model.js`：一次性真实生成和速度/成品/费用证据。
- 新建 `backend-node/scripts/verify-lingjing-video-release-contract.js`：候选代码与证据合同审计。
- 新建 `deploy/apply-lingjing-video-model-config.js`：计划/应用/验证/回滚单事务。
- 修改 `deploy/release-guard/verify-external-model-release.js`：增加固定灵境 provider、manifest 和运行时门禁检查。
- 修改 `backend-node/package.json`：增加 `verify:lingjing-video` 和 `audit:lingjing-video`。

### 任务 1：用专用客户端替换混用协议

**文件：**
- 新建：`backend-node/src/services/lingjingVideoClient.js`
- 新建：`backend-node/test/lingjingVideoClient.test.js`
- 修改：`backend-node/src/services/aihubccClient.js`
- 修改：`backend-node/test/aihubccClient.test.js`
- 修改：`backend-node/test/aihubccVideo.test.js`

- [ ] **步骤 1：写失败测试锁定官方主机、模型翻译和请求体**

```js
test('builds relay request without unsupported fields', () => {
  const body = buildLingjingVideoBody({
    model: 'lingjing-video-v1',
    prompt: '雨后森林中的小猫缓慢前行',
    duration: 4,
    aspect_ratio: '16:9',
    reference_image_paths: ['uploads/a.png'],
    request_id: 'audit-uuid',
    resolution: '720p',
    generate_audio: true,
  })
  assert.deepEqual(body, {
    model_key: 'relay', prompt: '雨后森林中的小猫缓慢前行',
    duration: 4, ratio: '16:9', reference_images: ['uploads/a.png'],
    request_id: 'audit-uuid',
  })
})
```

同时覆盖：非官方 hostname、超过 9 张图、非法时长、非法比例、视频/音频引用、首尾帧、空 `request_id` 均抛出明确错误。

- [ ] **步骤 2：运行测试确认红灯**

运行：

```powershell
cd backend-node
node --test test/lingjingVideoClient.test.js test/aihubccClient.test.js test/aihubccVideo.test.js
```

预期：新模块不存在；旧测试仍期待 `model: lingjing-video-v1`、12 张引用或 `/content`。

- [ ] **步骤 3：实现最小专用客户端**

```js
const PUBLIC_MODEL = 'lingjing-video-v1'
const UPSTREAM_MODEL = 'relay'
const DURATIONS = Object.freeze([4, 5, 6, 8, 10, 11, 15])
const RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
const MAX_IMAGE_REFERENCES = 9

function normalizeLingjingBaseUrl(value) {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:' || url.hostname !== 'seed.alimyun.xyz') {
    throw gateError('LINGJING_CONFIG_MISMATCH', '灵境视频只允许官方已审核域名')
  }
  return 'https://seed.alimyun.xyz/api/open/v1'
}
```

导出 `buildLingjingModelsUrl`、`buildLingjingUploadUrl`、`buildLingjingCreateUrl`、`buildLingjingStatusUrl`、`buildLingjingDownloadUrl`、`buildLingjingVideoBody`、`callLingjingVideoApi`、`parseLingjingTask`。上传后只把供应商返回的受控 path 放入 `reference_images`。

- [ ] **步骤 4：从 AIHubCC 删除灵境特判**

`aihubccClient.buildVideoBody()`、`getSupportedVideoDurationsForModel()` 和 AIHubCC 视频测试不再认识 `lingjing-video-v1`；AIHubCC `/content` 行为只保留给真正的 AIHubCC 模型。

- [ ] **步骤 5：运行定向测试并提交**

```powershell
cd backend-node
node --check src/services/lingjingVideoClient.js
node --test test/lingjingVideoClient.test.js test/aihubccClient.test.js test/aihubccVideo.test.js
git add src/services/lingjingVideoClient.js src/services/aihubccClient.js test/lingjingVideoClient.test.js test/aihubccClient.test.js test/aihubccVideo.test.js
git commit -m "feat: 独立灵境 relay 视频协议"
```

预期：全部通过，密钥不进入日志或错误正文。

### 任务 2：创建前和提交前双层严格门禁

**文件：**
- 修改：`backend-node/src/services/videoClient.js`
- 修改：`backend-node/src/services/videoService.js`
- 修改：`backend-node/src/services/videoReferenceCapabilityService.js`
- 新建：`backend-node/test/lingjingVideoGate.test.js`
- 修改：`backend-node/test/videoGenerationRequestSnapshot.test.js`
- 修改：`backend-node/test/videoBilling.test.js`
- 修改：`backend-node/test/videoRecovery.test.js`

- [ ] **步骤 1：写失败测试证明旧配置会走错协议或产生副作用**

测试矩阵：

1. `provider=xai/api_protocol=xai` 即使模型名相同也拒绝。
2. `provider=lingjing/api_protocol=lingjing_open` 才能选择。
3. `verification_status!=verified`、证据 SHA 不符、价格缺失、引用超过 9、视频/音频引用、非法时长/比例均在 `video_generations`、`async_tasks`、积分冻结和 scheduler 之前拒绝。
4. 活跃旧任务不得绕过配置降级门禁。
5. 最终 `fetch(POST /videos)` 前再执行同一能力/证据/价格检查。

```js
await assert.rejects(
  () => videoService.create(db, log, invalidRequest, billingOptions),
  (error) => error.code === 'VIDEO_REFERENCE_LIMIT_EXCEEDED',
)
assert.equal(count(db, 'video_generations'), 0)
assert.equal(count(db, 'async_tasks'), 0)
assert.equal(count(db, 'usage_reservations'), 0)
assert.equal(supplierPosts, 0)
```

- [ ] **步骤 2：运行测试确认红灯**

```powershell
cd backend-node
node --test test/lingjingVideoGate.test.js test/videoGenerationRequestSnapshot.test.js test/videoBilling.test.js test/videoRecovery.test.js
```

预期：旧 `xai/aihubcc` 路径仍能被选中或上限仍为 12。

- [ ] **步骤 3：接入 `lingjing_open` 调度和恢复**

`inferVideoProtocol()`、`resolveVideoProtocol()`、`getDefaultVideoConfig()`、`callVideoApi()`、`pollVideoTask()` 均显式处理 `lingjing_open`。轮询终态只接受供应商成功状态和有效视频地址；完成但无地址时调用固定 `/download`，不再回退 `/content`。

- [ ] **步骤 4：实现共享就绪状态**

```js
function lingjingReadyState(db, config, model, request, evidenceRoots) {
  const capability = exactVerifiedCapability(config, model)
  assertExactLingjingConfig(config, model)
  assertTrustedEvidenceBinding(model, capability, evidenceRoots)
  assertLingjingRequestCapability(request, capability)
  modelPriceService.calculateCharge(db, model, {
    duration: request.duration,
    allowedDurations: capability.durations,
  })
  return capability
}
```

创建路径和最终提交路径调用同一个无副作用校验函数；参考图片按顺序去重后最多 9 张，绝不静默截断。

- [ ] **步骤 5：运行回归并提交**

```powershell
cd backend-node
node --test test/lingjingVideoGate.test.js test/videoGenerationRequestSnapshot.test.js test/videoBilling.test.js test/videoRecovery.test.js test/videoDuplicateGuard.test.js test/videoArtifactAuth.test.js
git add src/services/videoClient.js src/services/videoService.js src/services/videoReferenceCapabilityService.js test/lingjingVideoGate.test.js test/videoGenerationRequestSnapshot.test.js test/videoBilling.test.js test/videoRecovery.test.js
git commit -m "feat: 锁定灵境视频双层生成门禁"
```

### 任务 3：统一目录、管理员预设和全站参数

**文件：**
- 修改：`backend-node/src/services/aiConfigService.js`
- 修改：`backend-node/src/routes/aiConfig.js`
- 修改：`backend-node/src/services/canvasProviderConfigService.js`
- 修改：`backend-node/src/services/canvasModelCatalogService.js`
- 修改：`backend-node/src/services/modelPriceService.js`
- 修改：`frontweb/src/components/AIConfigContent.vue`
- 修改：`frontweb/src/utils/canvasModelCapabilities.js`
- 修改：`frontweb/src/utils/freeCanvasGeneration.js`
- 修改：`frontweb/src/utils/homeQuickGeneration.js`
- 修改：`frontweb/src/utils/videoGenerationRequest.js`
- 修改：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`
- 修改：`frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue`
- 修改：`frontweb/src/views/FilmList.vue`
- 修改：`frontweb/src/views/FreeCreate.vue`
- 修改：`frontweb/src/views/FilmCreate.vue`
- 新建：`frontweb/test/lingjingVideoCanvasContract.test.js`
- 修改：`frontweb/test/aiConfigProviderPresets.test.js`
- 修改：`frontweb/test/canvasFiveGapCore.test.js`
- 修改：`frontweb/test/videoGenerationRequest.test.js`

- [ ] **步骤 1：写失败测试锁定四个入口的相同目录合同**

断言首页、画布、短剧工厂和管理员显示同一个 label/note/model；只从 `/canvas/model-catalog` 取得生成模型，禁止 legacy 列表回填受保护模型。

```js
assert.deepEqual(entry.capabilities, {
  declared: true,
  referenceTypes: ['image'],
  maxReferences: 9,
  maxImageReferences: 9,
  maxVideoReferences: 0,
  maxAudioReferences: 0,
  supportsImageReference: true,
  supportsFirstFrame: false,
  supportsLastFrame: false,
  supportsVideoReference: false,
  supportsAudioReference: false,
  supportsAudio: false,
  aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  resolutions: [], durations: [4, 5, 6, 8, 10, 11, 15], quantities: [1],
})
```

- [ ] **步骤 2：写失败测试锁定 UI 和请求**

- 清晰度字段在 `resolutions=[]` 时不渲染。
- 首尾帧、动作模仿、全能参考、视频编辑和同步音频不作为灵境生成能力开放；多图参考可用。
- `reference_image_urls` 完整保留最多 9 张；请求不含 `resolution`、`reference_video_urls`、`reference_audio_urls`、`first_frame_url`、`last_frame_url`、`generate_audio`。
- 模型切换后立即把不兼容的旧草稿参数原子清空并保存。
- 无有效按秒价格时两个运行按钮均禁用并显示“积分待管理员配置”。

- [ ] **步骤 3：运行测试确认红灯**

```powershell
cd frontweb
node --test test/lingjingVideoCanvasContract.test.js test/aiConfigProviderPresets.test.js test/canvasFiveGapCore.test.js test/videoGenerationRequest.test.js test/homeQuickGeneration.test.js
```

- [ ] **步骤 4：实现统一目录和空分辨率语义**

后端将 `lingjing_open` 加入严格协议集合；目录必须同时满足：精确协议、精确上游绑定、verified capabilities、共享证据 SHA、启用价格。`modelPriceService` 对 `resolutions=[]` 的视频模型使用基础按秒价格，不要求伪造 480P/720P 分档。

前端将“无分辨率选择”视为合法的已声明能力，而不是未配置；组件只有在 `capability.resolutions.length > 0` 时显示清晰度。所有构造器从请求中删除空或不适用的 `resolution`。

- [ ] **步骤 5：实现管理员预设**

```js
{ id: 'lingjing', name: '灵境 Seedance 2.0 Fast（9 图参考）', models: ['lingjing-video-v1'] }
providerProtocolMap.lingjing = 'lingjing_open'
```

默认 Base URL 和端点使用固定合同；连接测试只返回可达性，不修改真实生成验证状态。

- [ ] **步骤 6：运行前后端目录回归并提交**

```powershell
cd backend-node
node --test test/lingjingVideoGate.test.js test/canvasModelCatalogService.test.js test/modelPrice.test.js test/aiConfigPublicView.test.js test/videoProviderVerification.test.js
cd ../frontweb
node --test test/lingjingVideoCanvasContract.test.js test/aiConfigProviderPresets.test.js test/canvasFiveGapCore.test.js test/videoGenerationRequest.test.js test/homeQuickGeneration.test.js test/canvasGenerationOptions.test.js test/toapisVideoCanvasContract.test.js test/toapisShortDramaVideoContract.test.js
git add ../backend-node/src/services/aiConfigService.js ../backend-node/src/routes/aiConfig.js ../backend-node/src/services/canvasProviderConfigService.js ../backend-node/src/services/canvasModelCatalogService.js ../backend-node/src/services/modelPriceService.js src/components/AIConfigContent.vue src/utils/canvasModelCapabilities.js src/utils/freeCanvasGeneration.js src/utils/homeQuickGeneration.js src/utils/videoGenerationRequest.js src/components/dramaCanvas/HomeCanvasNode.vue src/components/dramaCanvas/CanvasGenerationOptions.vue src/views/FilmList.vue src/views/FreeCreate.vue src/views/FilmCreate.vue test/lingjingVideoCanvasContract.test.js test/aiConfigProviderPresets.test.js test/canvasFiveGapCore.test.js test/videoGenerationRequest.test.js
git commit -m "feat: 同步灵境视频模型全站能力"
```

### 任务 4：真实验证脚本和证据合同

**文件：**
- 新建：`backend-node/scripts/verify-lingjing-video-model.js`
- 新建：`backend-node/test/lingjingVideoVerification.test.js`
- 新建：`backend-node/scripts/verify-lingjing-video-release-contract.js`
- 新建：`backend-node/test/lingjingVideoReleaseContract.test.js`
- 修改：`backend-node/package.json`

- [ ] **步骤 1：写失败测试锁定单次、低成本、不可重试矩阵**

唯一用例：`lingjing-relay-i2v-4s`，4 秒、16:9、一张固定非真人参考图、不发送分辨率。测试覆盖并发锁、`submitting/indeterminate/rejected` 禁止自动重试、已接受任务只轮询、成品恢复只校验不重发。

- [ ] **步骤 2：写失败测试锁定证据字段**

证据必须包含：

- `provider_origin=https://seed.alimyun.xyz`
- 公开模型、上游 `relay`、协议 `lingjing_open`
- 唯一 `request_id`、供应商 `task_id`
- 规范化请求体 SHA-256、创建与终态响应 SHA-256
- 开始/接受/完成时间
- 上传路径与参考图 SHA-256 的绑定，不保存 Key
- 成品公网 URL、输出文件、字节数、SHA-256、MIME
- `ffprobe` 的宽高、时长、编码和可读性
- 创建延迟、生成耗时、下载耗时、总耗时
- 供应商返回的可核对费用字段；若无费用字段则明确 `supplier_cost_unavailable`，不推断人民币

- [ ] **步骤 3：实现脚本和 release contract 审计**

脚本从绝对 Key 文件读取凭据；私有状态目录与公网成品目录分离；所有状态原子写入。`--confirm-paid-call` 缺失时在任何 POST 前失败。一次提交失败或不确定即停止，永不自动第二次 POST。

- [ ] **步骤 4：运行定向测试并提交**

```powershell
cd backend-node
node --check scripts/verify-lingjing-video-model.js
node --check scripts/verify-lingjing-video-release-contract.js
node --test test/lingjingVideoVerification.test.js test/lingjingVideoReleaseContract.test.js
npm pkg get scripts.verify:lingjing-video scripts.audit:lingjing-video
git add scripts/verify-lingjing-video-model.js scripts/verify-lingjing-video-release-contract.js test/lingjingVideoVerification.test.js test/lingjingVideoReleaseContract.test.js package.json
git commit -m "feat: 添加灵境视频真实验证合同"
```

### 任务 5：共享证据绑定和发布防篡改

**文件：**
- 修改：`backend-node/src/services/externalModelEvidenceService.js`
- 修改：`deploy/release-guard/verify-external-model-release.js`
- 修改：`backend-node/test/externalModelEvidenceBinding.test.js`
- 新建：`backend-node/test/lingjingExternalReleaseGuard.test.js`
- 修改：`backend-node/test/sharedReleaseGuardRotation.test.js`

- [ ] **步骤 1：写篡改反例并确认红灯**

反例包括：任意 evidence 文件名、任意 provider 目录、SHA 不符、模型/上游/协议错配、缺 task/request ID、非 MP4、URL 与文件名不一致、过期/未来时间、软链接、非 root 所有、group/other 可写、运行时证据门禁在任务/扣费/供应商调用之后。

- [ ] **步骤 2：增加固定合同映射**

```js
CONTRACT_BY_MODEL['lingjing-video-v1'] = 'lingjing-video-real-verification-v1'
EVIDENCE_FILE_BY_CONTRACT['lingjing-video-real-verification-v1'] = 'lingjing-video-verification.json'
PUBLIC_PROVIDER_BY_CONTRACT['lingjing-video-real-verification-v1'] = 'lingjing'
```

共享 verifier 的固定 `PROVIDERS.lingjing` 必须审计专用客户端、官方 hostname、`lingjing_open` dispatch、双层证据门禁、`relay` 上游映射、9 图限制和成品绑定；manifest 不接受任意新增 contract。

- [ ] **步骤 3：运行安全门禁测试并提交**

```powershell
cd backend-node
node --test test/externalModelEvidenceBinding.test.js test/lingjingExternalReleaseGuard.test.js test/sharedReleaseGuardRotation.test.js test/releasePreflight.test.js
node ../deploy/release-guard/verify-external-model-release.js --help
git add src/services/externalModelEvidenceService.js test/externalModelEvidenceBinding.test.js test/lingjingExternalReleaseGuard.test.js test/sharedReleaseGuardRotation.test.js ../deploy/release-guard/verify-external-model-release.js
git commit -m "feat: 将灵境视频纳入共享证据门禁"
```

### 任务 6：证据驱动的生产配置事务

**文件：**
- 新建：`deploy/apply-lingjing-video-model-config.js`
- 新建：`backend-node/test/lingjingVideoModelConfigTransaction.test.js`

- [ ] **步骤 1：写失败测试锁定原位升级和零覆盖**

事务只允许升级现有唯一、停用且仍为历史 `xai/xai` 身份的 `lingjing-video-v1` 配置；若存在多个匹配配置、配置已被管理员修改、Base URL/Key 缺失、证据不新鲜、旧价格/分档不是线上只读确认的精确形态或回执不匹配，全部 fail closed。

- [ ] **步骤 2：实现 `plan/apply/verify/rollback`**

目标配置：

```js
{
  service_type: 'video',
  provider: 'lingjing',
  api_protocol: 'lingjing_open',
  name: '灵境 Seedance 2.0 Fast（9 图参考）',
  base_url: 'https://seed.alimyun.xyz/api/open/v1',
  model: 'lingjing-video-v1',
  default_model: 'lingjing-video-v1',
  endpoint: '/videos',
  query_endpoint: '/videos/{taskId}',
  verification_status: 'verified',
}
```

`settings` 保存 `upstream_model: relay`、证据 contract/SHA 和精确能力；`verified_capabilities` 保存同一能力。脚本复用现有 Key但从不打印。它在同一事务中把该模型迁移为 149 积分/秒、成本 170000 微元/秒、统一展示名/公开备注，并删除仅该模型的旧 480P/720P 分档。回执保存配置、基础价格和分档的完整旧值；回滚必须原子恢复，其他配置、价格、用户、任务和积分记录逐项不变。

- [ ] **步骤 3：运行事务演练并提交**

```powershell
cd backend-node
node --test test/lingjingVideoModelConfigTransaction.test.js
node --check ../deploy/apply-lingjing-video-model-config.js
git add test/lingjingVideoModelConfigTransaction.test.js ../deploy/apply-lingjing-video-model-config.js
git commit -m "feat: 添加灵境视频配置事务"
```

临时 SQLite 必须完成：`plan -> apply -> verify -> exact noop -> rollback -> plan`，并证明其他配置、Key、积分、任务和用户数据未改变。

### 任务 7：本地全量回归、构建和独立复审

**文件：**
- 修改：`docs/tasks/2026-08-10-lingjing-relay-video-integration.md`

- [ ] **步骤 1：运行后端定向矩阵**

```powershell
cd backend-node
node --test test/lingjingVideoClient.test.js test/lingjingVideoGate.test.js test/lingjingVideoVerification.test.js test/lingjingVideoReleaseContract.test.js test/lingjingExternalReleaseGuard.test.js test/lingjingVideoModelConfigTransaction.test.js test/videoGenerationRequestSnapshot.test.js test/videoBilling.test.js test/videoRecovery.test.js test/videoDuplicateGuard.test.js test/videoArtifactAuth.test.js test/canvasModelCatalogService.test.js test/modelPrice.test.js test/videoProviderVerification.test.js test/aihubccClient.test.js test/aihubccVideo.test.js test/toapisVideoClient.test.js test/feituoVideo.test.js
```

预期：0 失败。

- [ ] **步骤 2：运行后端全量测试**

```powershell
cd backend-node
npm test
```

预期：0 失败；平台条件 skip 单列说明。

- [ ] **步骤 3：运行前端定向、全量和生产构建**

```powershell
cd frontweb
node --test test/lingjingVideoCanvasContract.test.js test/aiConfigProviderPresets.test.js test/canvasFiveGapCore.test.js test/videoGenerationRequest.test.js test/homeQuickGeneration.test.js test/canvasGenerationOptions.test.js test/videoNodeToolbar.test.js test/toapisVideoCanvasContract.test.js test/toapisShortDramaVideoContract.test.js
node --test test/*.test.js
npm run build
```

预期：0 失败，Vite 构建成功。

- [ ] **步骤 4：运行发布与安全审计**

```powershell
git diff --check
rg -n "<<<<<<<|=======|>>>>>>>" backend-node frontweb deploy docs
rg -n "api[_-]?key|Authorization:\s*Bearer\s+[A-Za-z0-9]" docs backend-node/test frontweb/test
cd backend-node
npm run audit:canvas-credit-contract -- --require-build
npm run audit:lingjing-video
```

预期：无冲突标记、无凭据泄漏；`canvas-credit-callout-v1` 源码和 build 合同保持通过。

- [ ] **步骤 5：独立复审并修完所有 P0/P1**

复审重点：协议串线、证据绕过、任务/预扣前门禁、重复付费、引用静默截断、空分辨率、四个前端入口一致性、共享 verifier 防篡改。全部中高风险归零后提交任务文档。

### 任务 8：一次最低成本真实验证和受保护部署

**前置授权：** 当前计划不包含付费执行。只有用户再次明确批准“灵境 4 秒单图真实验证”后才进入本任务；批准不扩展到 30 秒、真人参考、第二次重试或其他供应商。

- [ ] **步骤 1：只读复核生产状态**

SSH 读取实时 `/opt/moli-drama/current`、服务、活动任务、DB quick check、配置 ID/updated_at、价格、Key 文件存在性、deploy.lock 和其他会话状态。任何漂移都停止并重新计划。

- [ ] **步骤 2：执行唯一一次 4 秒单图验证并计时**

使用固定非真人参考图和专用状态目录；命令必须带 `--confirm-paid-call`。记录提交延迟、生成耗时、下载耗时和总耗时。任何失败或不确定状态都停止，不自动第二次 POST。

- [ ] **步骤 3：复核证据和成品**

确认 task/request ID、请求 SHA、响应 SHA、MP4 MIME/字节/SHA、`ffprobe` 宽高/4 秒附近时长/编码、公网 200 和费用字段。只有全部通过才生成 `lingjing-video-verification.json` 和固定 manifest 项。

- [ ] **步骤 4：从最新实时 current 创建新候选**

只覆盖本计划审核过的 allowlist 文件；不得复用旧候选或整体上传本地 worktree。冻结候选权限，运行全量测试、构建、DB quick check、外部模型共享 verifier 和增量发布审计。

- [ ] **步骤 5：受保护切换并应用配置事务**

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

服务健康且无致命日志后执行配置 `plan -> apply -> verify`；失败立即按 receipt 回滚配置和 release。

- [ ] **步骤 6：无额外付费的线上浏览器验收**

验证管理员、首页、画布 `/canvas/48` 和短剧工厂均显示相同模型/备注/价格；只显示多图参考，最多 9 张；隐藏清晰度和不支持的参考模式；4/5/6/8/10/11/15 秒可选；预计扣分醒目；刷新后参数仍保存。此步骤不点击再次生成，避免未经另行授权的第二次付费。

- [ ] **步骤 7：如需“前端点击到成品回写”的真实产品 E2E，单独申请一次付费授权**

供应商直连证据和浏览器界面验收不等同于前端产品真实生成。只有用户另行批准后，再从画布发起一次最短请求并验证：预扣、任务、轮询、成品回写、下载、账本确认和失败退款全链。

---

## 完成标准

1. `lingjing-video-v1` 只通过 `lingjing_open` 调度，供应商请求固定 `model_key=relay`。
2. 所有入口只显示真实验证、证据绑定且已定价的模型；连接测试不能升级验证状态。
3. 画布只开放最多 9 张图片参考，隐藏清晰度和所有未证实能力。
4. 请求中没有伪造分辨率、首尾帧、视频/音频参考或同步音频字段。
5. 配置或证据在任务、预扣或供应商提交前失效时，零副作用拒绝。
6. 唯一付费验证不自动重试，成品可读且速度、费用、哈希和任务 ID 有证据。
7. 后端/前端全量测试、生产构建、共享外部模型门禁和 `canvas-credit-callout-v1` 全部通过。
8. 发布从当时实时 current 构建，使用共享受保护激活器，不覆盖其他会话和用户数据。
