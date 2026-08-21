# ToAPIs Seedance 2 视频模型全站接入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用独立 `toapis_video` 协议接入 `seedance-2-fast` 和 `seedance-2-mini` 的 480P/720P、首尾帧和多模态参考能力，并让管理员、首页、两类画布和短剧工厂共用同一验证与计费目录；真实验证通过后与未部署图片模型一起安全发布。

**架构：** 新建小型 ToAPIs 客户端负责参数校验、角色请求体、异步提交和单次状态解析，现有 `videoClient` 只负责协议分发和统一轮询。`ai_service_configs.verification_status/verified_capabilities` 与分辨率价格表共同控制用户目录，前端所有入口只消费统一目录。生产候选从实时线上 `current` 克隆，只叠加审计文件并经共享门禁切换。

**技术栈：** Node.js 20、Express、SQLite/better-sqlite3、Vue 3、Element Plus、Node test runner、Playwright、ffprobe。

---

## 文件职责

- `backend-node/src/services/toapisVideoClient.js`：ToAPIs 唯一协议实现，负责模型能力、HTTPS 参考素材、请求体、提交和单次状态解析。
- `backend-node/src/services/videoClient.js`：增加 `toapis_video` 的协议识别、调用分发和统一轮询分支，不复制 ToAPIs 请求细节。
- `backend-node/src/services/videoService.js`：按模型能力做预扣前时长/分辨率/参考模式校验，并保存任务快照、恢复轮询、下载成品和结算退款。
- `backend-node/migrations/53_video_generation_request_snapshot.sql`、`backend-node/src/db/migrate.js`：持久化 `reference_mode`、`generate_audio` 和完整请求快照，保证重启恢复不改变请求语义。
- `backend-node/src/services/aiConfigService.js`：管理员 ToAPIs 配置默认值、只读连接测试、验证状态/能力持久化、环境 Key 识别和安全公开视图。
- `backend-node/src/services/canvasModelCatalogService.js`：只发布已验证、已定价、启用且有密钥的 ToAPIs 模型与能力。
- `backend-node/src/services/modelPriceService.js`：480P/720P 按秒成本和积分；ToAPIs 模型允许 4 秒，旧模型仍保持 5 秒下限。
- `backend-node/src/routes/videos.js`：把预扣前能力错误映射为可理解的 400/503，不把用户参数错误伪装成 500。
- `frontweb/src/components/AIConfigContent.vue`：管理员 ToAPIs 供应商预设和验证状态展示。
- `frontweb/src/views/BillingAdmin.vue`：复用视频分辨率成本/积分编辑，显示管理员展示名和公开备注。
- `frontweb/src/utils/canvasModelCapabilities.js`：标准化目录中的分辨率、时长、参考上限和同步音频能力。
- `frontweb/src/utils/videoDuration.js`：模型能力驱动的视频时长选项与校验，旧模型默认仍为 5–15 秒。
- `frontweb/src/utils/homeQuickGeneration.js`、`frontweb/src/views/FilmList.vue`、`frontweb/src/views/FreeCreate.vue`：真实首页快速生成使用统一目录、分辨率、时长和计费门禁。
- `frontweb/src/utils/freeCanvasGeneration.js`：根据首尾帧或全能参考模式构造统一视频请求，禁止混发。
- `frontweb/src/utils/videoGenerationRequest.js`：短剧工厂所有视频路径共用的请求构造器，完整传递参考视频、参考音频、模式和同步音频。
- `frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`：首页/独立画布的视频模型参数与扣分提示。
- `frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue`：项目画布生成面板改用统一目录，移除硬编码 1080P 和固定 5–15 秒。
- `frontweb/src/views/HomeCanvas.vue`、`frontweb/src/views/DramaCanvas.vue`：消费统一目录并持久化模型参数。
- `frontweb/src/views/FilmCreate.vue`：项目默认、分镜覆盖、单条、批量、一键和修复路径共用模型目录和请求构造。
- `backend-node/scripts/verify-toapis-video-models.js`：使用环境变量中的 Key 进行受控真实生成、下载、ffprobe 和脱敏证据输出。
- `backend-node/scripts/verify-toapis-video-release-contract.js`：静态检查协议、目录、计费、真实证据和受保护积分合同。
- `docs/TOAPIS_VIDEO_MODELS_VERIFICATION_20260807.md`：不含密钥的真实任务、媒体和计费证据。

### 任务 0：保护现有图片候选并建立可归因基线

**文件：**
- 检查：当前工作树全部已修改和未跟踪文件
- 测试：`backend-node/test/usmercariImage*.test.js`
- 测试：`frontweb/test/*Image*.test.js`、`frontweb/test/homeQuickGeneration.test.js`

- [ ] **步骤 1：确认工作树和分叉状态**

运行：

```powershell
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
git diff --stat
git diff --name-only
```

预期：分支为 `codex/usmercari-image-models-20260807`，现有图片改动仍完整，未出现 Key、生产数据库或生成媒体文件。

- [ ] **步骤 2：建立只指向当前提交的本地备份分支**

```powershell
git branch codex/usmercari-image-models-20260807-pre-toapis HEAD
```

预期：仅新增本地分支引用，不切换、不清理、不覆盖当前工作树。

- [ ] **步骤 3：运行图片候选定向测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/usmercariImageClient.test.js test/usmercariImageVerification.test.js test/usmercariImageGenerationFlow.test.js test/assetImageBilling.test.js test/modelPrice.test.js test/aiConfigPublicView.test.js test/canvasModelCatalogService.test.js
cd ../frontweb
node --test test/usmercariImageFrontendContract.test.js test/usmercariImageProviderConfig.test.js test/imageResolutionPricingContract.test.js test/filmCreateImageModelResolution.test.js test/homeQuickGeneration.test.js test/standaloneCanvasFreeNodeGeneration.test.js
```

预期：全部 PASS；任一失败先修复图片候选，不进入 ToAPIs 代码。

- [ ] **步骤 4：审计现有图片差异并形成检查点提交**

```powershell
git diff --check
git diff --name-only | Sort-Object
rg -n "sk-[A-Za-z0-9_-]{12,}|Bearer [A-Za-z0-9_-]{12,}" backend-node frontweb docs
git add -u
git add -- backend-node/migrations/51_ai_config_verification_and_model_notes.sql backend-node/migrations/52_image_generation_request_snapshot.sql backend-node/test/aiConfigService.test.js backend-node/test/usmercariImageGenerationFlow.test.js frontweb/test/filmCreateImageModelResolution.test.js frontweb/test/imageResolutionPricingContract.test.js frontweb/test/usmercariImageFrontendContract.test.js frontweb/test/usmercariImageProviderConfig.test.js
git diff --cached --check
git commit -m "feat: 完成 USMercari 图片模型全站候选"
```

预期：提交前 `git diff --cached --name-only` 必须与步骤 1 已审计的图片 allowlist 一致；`docs/superpowers/*toapis*`、ToAPIs 验证文档和任何非图片文件不得出现。搜索没有真实密钥。提交后工作树干净，ToAPIs 改动可按提交独立归因。

### 任务 1：锁定 ToAPIs 客户端合同

**文件：**
- 创建：`backend-node/test/toapisVideoClient.test.js`
- 创建：`backend-node/src/services/toapisVideoClient.js`

- [ ] **步骤 1：编写模型、分辨率和时长失败测试**

```js
const assert = require('node:assert/strict')
const test = require('node:test')
const toapis = require('../src/services/toapisVideoClient')

test('只允许两个模型和 480P/720P', () => {
  assert.equal(toapis.validateToapisVideoOptions({
    model: 'seedance-2-fast', duration: 4, resolution: '480p', aspect_ratio: '16:9',
  }).resolution, '480p')
  assert.throws(() => toapis.validateToapisVideoOptions({
    model: 'seedance-2-mini', duration: 4, resolution: '1080p', aspect_ratio: '16:9',
  }), /只支持 480P、720P/)
})

test('Mini 使用保守离散时长而 Fast 接受 4 到 15 秒整数', () => {
  assert.throws(() => toapis.validateToapisVideoOptions({
    model: 'seedance-2-mini', duration: 5, resolution: '480p', aspect_ratio: '16:9',
  }), /4、8、10、12、15/)
  assert.equal(toapis.validateToapisVideoOptions({
    model: 'seedance-2-fast', duration: 15, resolution: '720p', aspect_ratio: '16:9',
  }).duration, 15)
})
```

- [ ] **步骤 2：运行测试确认红灯**

```powershell
cd backend-node
node --test --test-concurrency=1 test/toapisVideoClient.test.js
```

预期：FAIL，模块 `toapisVideoClient` 尚不存在。

- [ ] **步骤 3：实现最小模型能力和校验**

```js
const TOAPIS_MODELS = Object.freeze({
  'seedance-2-fast': Object.freeze({ resolutions: ['480p', '720p'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], maxImages: 1, maxVideos: 1, maxAudio: 1 }),
  'seedance-2-mini': Object.freeze({ resolutions: ['480p', '720p'], durations: [4, 8, 10, 12, 15], maxImages: 9, maxVideos: 3, maxAudio: 3 }),
})

function validateToapisVideoOptions(opts = {}) {
  const model = String(opts.model || '').trim()
  const spec = TOAPIS_MODELS[model]
  if (!spec) throw new Error(`ToAPIs 模型 ${model || '(empty)'} 未经验证，禁止提交`)
  const resolution = String(opts.resolution || '').trim().toLowerCase()
  if (!spec.resolutions.includes(resolution)) throw new Error('ToAPIs 视频只支持 480P、720P')
  const duration = Number(opts.duration)
  if (!spec.durations.includes(duration)) throw new Error(`${model} 不支持 ${duration} 秒`)
  const firstFrame = String(opts.first_frame_url || '').trim()
  const lastFrame = String(opts.last_frame_url || '').trim()
  const images = [...new Set((opts.reference_urls || []).map(String).map((item) => item.trim()).filter(Boolean))]
  const videos = [...new Set((opts.reference_video_urls || []).map(String).map((item) => item.trim()).filter(Boolean))]
  const audio = [...new Set((opts.reference_audio_urls || []).map(String).map((item) => item.trim()).filter(Boolean))]
  if (lastFrame && !firstFrame) throw new Error('ToAPIs 尾帧必须与首帧一起使用')
  if ((firstFrame || lastFrame) && (images.length || videos.length || audio.length)) {
    throw new Error('ToAPIs 首尾帧模式与全能参考模式互斥')
  }
  if (images.length > spec.maxImages || videos.length > spec.maxVideos || audio.length > spec.maxAudio) {
    throw new Error('ToAPIs 参考素材数量超过当前已验证上限')
  }
  return {
    model, spec, resolution, duration,
    aspectRatio: String(opts.aspect_ratio || '16:9'),
    firstFrame, lastFrame, images, videos, audio,
  }
}
```

- [ ] **步骤 4：编写角色请求体和互斥失败测试**

```js
test('首尾帧使用 first_frame/last_frame 且不混入 reference_image', () => {
  assert.deepEqual(toapis.buildToapisVideoBody({
    model: 'seedance-2-fast', prompt: '镜头推进', duration: 4, resolution: '480p', aspect_ratio: '16:9',
    first_frame_url: 'https://molimama.vip/static/first.png',
    last_frame_url: 'https://molimama.vip/static/last.png',
  }).image_with_roles, [
    { url: 'https://molimama.vip/static/first.png', role: 'first_frame' },
    { url: 'https://molimama.vip/static/last.png', role: 'last_frame' },
  ])
  assert.throws(() => toapis.buildToapisVideoBody({
    model: 'seedance-2-fast', prompt: '冲突', duration: 4, resolution: '480p', aspect_ratio: '16:9',
    first_frame_url: 'https://molimama.vip/static/first.png',
    reference_urls: ['https://molimama.vip/static/ref.png'],
  }), /首尾帧模式与全能参考模式互斥/)
})
```

- [ ] **步骤 5：实现 HTTPS 公网素材与角色数组**

```js
function buildToapisVideoBody(opts = {}) {
  const checked = validateToapisVideoOptions(opts)
  const body = {
    model: checked.model,
    prompt: String(opts.prompt || ''),
    duration: checked.duration,
    aspect_ratio: checked.aspectRatio,
    resolution: checked.resolution,
    generate_audio: opts.generate_audio === true,
  }
  if (checked.firstFrame) body.image_with_roles = [{ url: checked.firstFrame, role: 'first_frame' }]
  if (checked.lastFrame) body.image_with_roles.push({ url: checked.lastFrame, role: 'last_frame' })
  if (checked.images.length) body.image_with_roles = checked.images.map((url) => ({ url, role: 'reference_image' }))
  if (checked.videos.length) body.video_with_roles = checked.videos.map((url) => ({ url, role: 'reference_video' }))
  if (checked.audio.length) body.audio_with_roles = checked.audio.map((url) => ({ url, role: 'reference_audio' }))
  return body
}
```

客户端只接收后端已经完成授权解析的公网 URL：把 `/static/...` 转换成 `files_base_url` 同源 HTTPS URL；只接受该源，明确拒绝 `data:`、`asset://`、HTTP、localhost、私网 IP、带用户名密码和外站原生素材。仅“同源”不能证明有权使用素材；`videoService.create()` 必须先用当前租户和项目上下文解析每个资产 ID/URL，确认素材属于当前租户且属于当前项目或被明确共享，随后才把解析结果交给客户端。

- [ ] **步骤 6：编写提交、解析和未知结果测试**

```js
test('POST 使用 Bearer 且连接中断返回 indeterminate', async () => {
  const result = await toapis.callToapisVideoApi(
    { base_url: 'https://toapis.com', api_key: 'secret' },
    { info() {} },
    { model: 'seedance-2-fast', prompt: '镜头', duration: 4, resolution: '480p', aspect_ratio: '16:9', fetchImpl: async () => { throw new Error('socket closed') } },
  )
  assert.equal(result.indeterminate, true)
  assert.doesNotMatch(result.error, /secret/)
})

test('完成态只从 result.data 第一条可用 MP4 取地址', () => {
  assert.deepEqual(toapis.parseToapisTask({ status: 'completed', result: { data: [{ url: 'https://files.toapis.com/a.mp4', format: 'mp4' }] } }), {
    state: 'completed', videoUrl: 'https://files.toapis.com/a.mp4', progress: 100,
  })
})
```

- [ ] **步骤 7：实现提交和单次查询**

`callToapisVideoApi()` 固定调用 `${normalizeToapisBaseUrl(base_url)}/v1/videos/generations`；`fetchToapisTask()` 固定调用 `/v1/videos/generations/{task_id}`。HTTP 错误只保留状态、请求 ID 和截断后的供应商消息，不记录 Key 或完整 HTML。`normalizeToapisBaseUrl()` 必须同时去掉管理员误填的尾部 `/v1`，避免形成 `/v1/v1`。

- [ ] **步骤 8：运行测试并提交**

```powershell
node --test --test-concurrency=1 test/toapisVideoClient.test.js
git add src/services/toapisVideoClient.js test/toapisVideoClient.test.js
git commit -m "feat: 实现 ToAPIs 视频协议客户端"
```

预期：全部 PASS，提交只含新客户端和合同测试。

### 任务 2：接入统一视频分发、轮询和恢复链

**文件：**
- 修改：`backend-node/src/services/videoClient.js`
- 修改：`backend-node/src/services/videoService.js`
- 创建：`backend-node/migrations/53_video_generation_request_snapshot.sql`
- 修改：`backend-node/src/db/migrate.js`
- 创建：`backend-node/test/toapisVideoIntegration.test.js`
- 创建：`backend-node/test/videoGenerationRequestSnapshot.test.js`

- [ ] **步骤 1：编写协议分发失败测试**

```js
test('provider 与显式协议都解析为 toapis_video', () => {
  assert.equal(videoClient.inferVideoProtocol('toapis'), 'toapis_video')
  assert.equal(videoClient.resolveVideoProtocol({ provider: 'other', api_protocol: 'toapis_video' }), 'toapis_video')
})
```

- [ ] **步骤 2：运行测试确认红灯**

```powershell
node --test --test-concurrency=1 test/toapisVideoIntegration.test.js
```

预期：FAIL，协议尚未识别或未导出。

- [ ] **步骤 3：增加最小分发**

在 `videoClient.js` 引入新客户端，并增加：

```js
if (p === 'toapis' || p === 'toapis_video') return 'toapis_video'
if (provider === 'toapis' || provider === 'toapis_video') protocol = 'toapis_video'

if (protocol === 'toapis_video') {
  return toapisVideoClient.callToapisVideoApi(config, log, {
    ...opts,
    model,
    prompt,
    duration,
    aspect_ratio,
    resolution,
  })
}
```

把 `inferVideoProtocol` 和 `resolveVideoProtocol` 加入 `module.exports`，使测试直接锁定显式协议与 provider 推断，不依赖真实网络。

- [ ] **步骤 4：编写请求快照迁移失败测试**

```js
test('视频任务持久化模式、同步音频和完整请求快照', () => {
  const row = db.prepare('SELECT reference_mode, generate_audio, reference_video_urls, reference_audio_urls, request_snapshot FROM video_generations WHERE id = ?').get(created.id)
  assert.equal(row.reference_mode, 'omni')
  assert.equal(row.generate_audio, 0)
  assert.deepEqual(JSON.parse(row.reference_video_urls), ['https://molimama.vip/static/ref.mp4'])
  assert.deepEqual(JSON.parse(row.reference_audio_urls), ['https://molimama.vip/static/ref.mp3'])
  assert.deepEqual(JSON.parse(row.request_snapshot), {
    model: 'seedance-2-fast', resolution: '480p', duration: 4,
    reference_mode: 'omni', generate_audio: false,
    reference_image_urls: ['https://molimama.vip/static/ref.png'],
    reference_video_urls: ['https://molimama.vip/static/ref.mp4'],
    reference_audio_urls: ['https://molimama.vip/static/ref.mp3'],
  })
})
```

- [ ] **步骤 5：增加数据库迁移和 create/process 透传**

迁移只追加五列，不重建或清空 `video_generations`：

```sql
ALTER TABLE video_generations ADD COLUMN reference_mode TEXT;
ALTER TABLE video_generations ADD COLUMN generate_audio INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_generations ADD COLUMN reference_video_urls TEXT;
ALTER TABLE video_generations ADD COLUMN reference_audio_urls TEXT;
ALTER TABLE video_generations ADD COLUMN request_snapshot TEXT;
```

`videoService.create()` 在事务前完成租户/项目素材授权解析与能力校验，然后把标准化后的模式、同步音频和完整图片/视频/音频数组写入行与 JSON 快照。测试至少覆盖“同源但属于另一租户”和“同租户但未共享的另一项目”均在预扣前拒绝。旧单值 `reference_video_url/reference_audio_url` 继续写第一项以兼容旧读取方，但 ToAPIs 生成和恢复必须读取 JSON 数组。`processVideoGeneration()`、`resumePollForVideoGeneration()` 只从已保存行/快照恢复并传给 `callVideoApi()`，不得根据当前 UI 或当前管理员默认值重新推断。

- [ ] **步骤 6：编写轮询与重启恢复测试**

测试第一次返回 `in_progress`、第二次 `completed`；断言保存 `provider_task_id`，服务重启后只 GET 原任务，不再次调用创建接口；失败态只退款一次。

```js
assert.equal(created.provider_task_id, 'tsk_vid_demo')
assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
assert.equal(calls.filter((call) => call.method === 'GET').length, 2)
assert.equal(creditLedger.getReservation(db, created.credit_reservation_id).status, 'settled')
```

- [ ] **步骤 7：接入统一轮询**

在 `pollVideoTask()` 中声明 `isToapis`，每轮调用 `toapisVideoClient.fetchToapisTask(config, taskId)`，将其 `completed/failed/processing` 映射到统一返回。不要在通用 OpenAI 轮询体中猜 ToAPIs 字段。

- [ ] **步骤 8：让首个参考图不再被错误降级为首帧**

现有 `callVideoApi()` 会把非 USMercari 的第一张参考图改写为首帧。把排除条件改为：

```js
if (!['usmercari_media', 'toapis_video'].includes(protocol) && !image_url && !first_frame_url) {
  // 仅旧协议保留第一参考图降级逻辑
}
```

`videoService.create()` 中同样让 `toapis_video` 不使用 `firstReferenceFallback`，保持多图参考语义。

- [ ] **步骤 9：运行集成测试并提交**

```powershell
node --test --test-concurrency=1 test/toapisVideoClient.test.js test/toapisVideoIntegration.test.js test/videoGenerationRequestSnapshot.test.js test/videoRecovery.test.js test/videoBilling.test.js test/usmercariVideo.test.js
git add src/services/videoClient.js src/services/videoService.js src/db/migrate.js migrations/53_video_generation_request_snapshot.sql test/toapisVideoIntegration.test.js test/videoGenerationRequestSnapshot.test.js
git commit -m "feat: 接入 ToAPIs 视频异步生成链"
```

预期：ToAPIs 与现有 USMercari/恢复/计费测试全部 PASS。

### 任务 3：增加预扣前能力、计费和目录门禁

**文件：**
- 修改：`backend-node/src/services/videoService.js`
- 修改：`backend-node/src/services/modelPriceService.js`
- 修改：`backend-node/src/services/canvasModelCatalogService.js`
- 修改：`backend-node/src/services/aiConfigService.js`
- 修改：`backend-node/src/routes/videos.js`
- 修改：`backend-node/test/modelPrice.test.js`
- 修改：`backend-node/test/canvasModelCatalogService.test.js`
- 创建：`backend-node/test/toapisVideoGate.test.js`

- [ ] **步骤 1：编写 4 秒和分辨率价格失败测试**

```js
test('ToAPIs 允许 4 秒而旧视频模型仍拒绝 4 秒', () => {
  assert.equal(prices.calculateCharge(db, 'seedance-2-fast', { duration: 4, resolution: '480p' }), 2044)
  assert.throws(() => prices.calculateCharge(db, 'legacy-video', { duration: 4 }), /5 到 15 秒/)
})
```

价格夹具：Fast 480P/720P 各 511 积分/秒、584000 微元/秒；Mini 480P 为 294 积分/秒、335800 微元/秒；Mini 720P 为 595 积分/秒、678900 微元/秒。

- [ ] **步骤 2：实现模型特定时长与预扣前验证**

在 `modelPriceService` 增加：

```js
const TOAPIS_VIDEO_MODELS = new Set(['seedance-2-fast', 'seedance-2-mini'])
const minDuration = TOAPIS_VIDEO_MODELS.has(model.toLowerCase()) ? 4 : 5
```

`videoService.normalizeVideoDuration()` 改为接收显式允许集合：

```js
function normalizeVideoDuration(value, fallback = 5, allowedDurations = null) {
  const duration = value == null || value === '' ? Number(fallback) : Number(value)
  if (Array.isArray(allowedDurations) && allowedDurations.length) {
    if (!allowedDurations.includes(duration)) throw invalidVideoDuration(allowedDurations)
    return duration
  }
  if (!Number.isSafeInteger(duration) || duration < 5 || duration > 15) throw invalidVideoDuration([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  return duration
}
```

`videoService.create()` 必须先解析 `videoConfig + selectedModel`，取得 ToAPIs 允许时长，再计算 storyboard/config fallback 和调用 `normalizeVideoDuration()`；`processVideoGeneration()` 使用同一已保存时长，不再走固定 5 秒下限。`aiConfigService.parseVideoSettings(settings, { protocol, model })` 对 `toapis_video` 接受对应模型的时长集合，旧协议仍只接受 5–15 秒；`normalizeCreateSettings()` 和 `mergeVideoSettings()` 都必须把协议与模型上下文传入。

随后在创建任务和 `creditLedger.reserve()` 前调用 `toapisVideoClient.validateToapisVideoOptions()`；因此 1080P、Mini 5 秒、参考数量超限和模式混发都不会产生任务或预扣。

- [ ] **步骤 3：编写严格目录门禁测试**

```js
test('ToAPIs 未验证、缺 Key 或缺任一档价格时不进入目录', () => {
  assert.deepEqual(catalog.list(db).filter((item) => item.protocol === 'toapis_video'), [])
})

test('已验证且两档已定价时只发布证据声明的能力', () => {
  const item = catalog.list(db).find((row) => row.model === 'seedance-2-fast')
  assert.deepEqual(item.capabilities.resolutions, ['480p', '720p'])
  assert.deepEqual(item.capabilities.durations, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  assert.equal(item.capabilities.maxReferences, 1)
})
```

- [ ] **步骤 4：实现通用严格配置门禁**

把仅图片使用的严格检查扩展为显式协议集合：

```js
const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video'])
```

ToAPIs 目录能力只读 `verified_capabilities[model]`，不得用硬编码能力替代真实证据；`resolution_prices` 只保留验证且已定价的 480P/720P。

`modelPriceService.listPublic()` 使用同一严格协议集合；配置仍为 `pending/failed`、环境 Key 不存在或任一已验证分辨率缺价时，不得通过计费公开目录泄露模型。`routes/videos.js` 把 `INVALID_VIDEO_DURATION`、不支持分辨率、参考超量、模式互斥映射为 400，把未验证/缺价/停用映射为 503，保留原错误码供前端显示。

- [ ] **步骤 5：保留积分合同并运行测试**

```powershell
node --test --test-concurrency=1 test/modelPrice.test.js test/canvasModelCatalogService.test.js test/toapisVideoGate.test.js test/videoBilling.test.js test/aiConfigPublicView.test.js
```

预期：全部 PASS；未验证/缺 Key/缺价均在任务创建前失败。

- [ ] **步骤 6：提交门禁**

```powershell
git add src/services/videoService.js src/services/modelPriceService.js src/services/canvasModelCatalogService.js src/services/aiConfigService.js src/routes/videos.js test/modelPrice.test.js test/canvasModelCatalogService.test.js test/toapisVideoGate.test.js
git commit -m "feat: 增加 ToAPIs 视频验证与计费门禁"
```

### 任务 4：接入管理员配置、展示名和备注

**文件：**
- 修改：`backend-node/src/services/aiConfigService.js`
- 修改：`backend-node/src/routes/aiConfig.js`
- 修改：`backend-node/test/aiConfigService.test.js`
- 修改：`backend-node/test/aiConfigPublicView.test.js`
- 修改：`frontweb/src/components/AIConfigContent.vue`
- 修改：`frontweb/test/usmercariProviderConfig.test.js`
- 创建：`frontweb/test/toapisVideoProviderConfig.test.js`

- [ ] **步骤 1：编写管理员配置失败测试**

```js
test('ToAPIs 视频预设使用根 Base URL 和明确 v1 endpoint', () => {
  assert.equal(defaults.base_url, 'https://toapis.com')
  assert.equal(defaults.endpoint, '/v1/videos/generations')
  assert.equal(defaults.query_endpoint, '/v1/videos/generations/{task_id}')
  assert.equal(defaults.api_protocol, 'toapis_video')
})
```

前端源码合同同时断言供应商选项、默认 URL、两个模型 ID、验证状态、展示名和备注字段存在。

- [ ] **步骤 2：增加后端默认配置和只读连接测试**

`aiConfigService.createConfig()` 对 `provider=toapis`、`service_type=video` 写入上述默认值；`testConnection()` 只调用官方只读模型/账户接口并确认目标模型 ID 可见，不创建视频，不修改 `verification_status`。

`hasConnectionCredential()` 与 `toPublicConfig().has_api_key` 识别 `process.env.TOAPIS_API_KEY`，但永远不返回其值。增加仅供受控验证脚本调用的服务方法：

```js
function recordVerification(db, id, { status, capabilities = {}, error = null, verifiedAt = null }) {
  if (!['pending', 'verified', 'failed'].includes(status)) throw new Error('无效验证状态')
  db.prepare(`UPDATE ai_service_configs
    SET verification_status = ?, verified_capabilities = ?, verified_at = ?, verification_error = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL`)
    .run(status, JSON.stringify(capabilities), verifiedAt, error, new Date().toISOString(), id)
  return getConfig(db, id)
}
```

通用 `updateConfig()` 和普通管理员表单不能把 `pending` 手工改成 `verified`；只有真实验证脚本在证据写入成功后调用 `recordVerification()`。

`routes/aiConfig.listPublicVideoModels()` 对 `toapis_video` 使用 `canvasModelCatalogService.list(db)` 的允许集合过滤，不能像旧视频配置一样只凭 `is_active` 暴露裸模型名。

- [ ] **步骤 3：增加管理员前端预设**

```vue
<el-option label="ToAPIs 视频（异步生成）" value="toapis" />
```

选择后设置 `api_protocol='toapis_video'`、`base_url='https://toapis.com'`、提交/查询 endpoint 和两个模型 ID。管理员展示名、公开备注、验证状态和启停继续使用现有公共字段。

- [ ] **步骤 4：运行测试并提交**

```powershell
cd backend-node
node --test --test-concurrency=1 test/aiConfigService.test.js test/aiConfigPublicView.test.js
cd ../frontweb
node --test test/toapisVideoProviderConfig.test.js test/usmercariProviderConfig.test.js
git add ../backend-node/src/services/aiConfigService.js ../backend-node/src/routes/aiConfig.js ../backend-node/test/aiConfigService.test.js ../backend-node/test/aiConfigPublicView.test.js src/components/AIConfigContent.vue test/toapisVideoProviderConfig.test.js test/usmercariProviderConfig.test.js
git commit -m "feat: 在管理员后台配置 ToAPIs 视频模型"
```

### 任务 5：首页和两类画布使用真实能力

**文件：**
- 修改：`frontweb/src/utils/videoDuration.js`
- 修改：`frontweb/src/utils/homeQuickGeneration.js`
- 修改：`frontweb/src/utils/canvasModelCapabilities.js`
- 修改：`frontweb/src/utils/freeCanvasGeneration.js`
- 修改：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`
- 修改：`frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue`
- 修改：`frontweb/src/views/FilmList.vue`
- 修改：`frontweb/src/views/FreeCreate.vue`
- 修改：`frontweb/src/views/HomeCanvas.vue`
- 修改：`frontweb/src/views/DramaCanvas.vue`
- 修改：`frontweb/test/homeQuickGeneration.test.js`
- 修改：`frontweb/test/canvasGenerationOptions.test.js`
- 修改：`frontweb/test/standaloneCanvasFreeNodeGeneration.test.js`
- 创建：`frontweb/test/toapisVideoCanvasContract.test.js`

- [ ] **步骤 1：编写目录参数和请求互斥失败测试**

```js
test('ToAPIs 节点只显示目录声明的分辨率和时长', () => {
  const capability = canvasModelCapability(catalog, 'video', 'seedance-2-mini')
  assert.deepEqual(capability.resolutions, ['480p', '720p'])
  assert.deepEqual(capability.durations, [4, 8, 10, 12, 15])
})

test('首尾帧请求不同时携带全能参考', () => {
  assert.throws(() => buildFreeCanvasGenerationRequest(node, { upstreamReferences: conflictingRefs }), /首尾帧模式与全能参考模式互斥/)
})
```

- [ ] **步骤 2：标准化目录能力并校正草稿**

在 `videoDuration.js` 增加 `videoDurationOptionsForCapability(capability)` 和 `assertVideoDurationAllowed(duration, capability)`；没有声明能力的旧模型仍用 5–15 秒。模型切换时如果当前分辨率、时长、数量不在能力数组内，选择第一个允许值并立即保存；提交旧草稿时必须明确报错，不得静默把 1080P 或 Mini 5 秒降档。同步音频仅在 `supportsAudio === true` 时显示并发送。

`homeQuickGeneration.normalizeQuickGenerationCatalog()` 将 `toapis_video` 视为 catalog-only 严格模型；`normalizeQuickGenerationDraft()`、`estimateGenerationCredits()` 和 `buildQuickGenerationRequest()` 全部使用目录能力。真实首页的 `FilmList.vue`、`FreeCreate.vue` 不再硬编码 5/10/15 秒。

- [ ] **步骤 3：让请求显式传递参考模式和同步音频**

```js
return withoutEmptyFields({
  ...base,
  reference_mode: hasFrameSlots ? 'first_last' : 'omni',
  first_frame_url: hasFrameSlots ? firstFrameUrl : undefined,
  last_frame_url: hasFrameSlots ? lastFrameUrl : undefined,
  reference_image_urls: hasFrameSlots ? undefined : referenceImageUrls,
  reference_video_urls: hasFrameSlots ? undefined : videoReferences.map((item) => item.url),
  reference_audio_urls: hasFrameSlots ? undefined : audioReferences.map((item) => item.url),
  generate_audio: capability.supportsAudio === true ? nodeData.includeAudio === true : undefined,
})
```

- [ ] **步骤 4：保留醒目积分提示**

`HomeCanvasNode.vue` 继续保留：

```vue
<!-- canvas-credit-callout-v1 -->
<span v-if="canGenerate" class="billing-cost" aria-live="polite">
  <template v-if="estimatedCredits">本次预计扣除 <strong>{{ estimatedCredits }}</strong> 积分</template>
  <template v-else>积分待管理员配置</template>
</span>
```

缺价时运行按钮必须禁用，不能只显示文字。

`freeCanvasGeneration.js` 不得再对视频/音频引用 `.slice(0, 1)`；它按完整 capability 校验并传数组。`CanvasGenerationOptions.vue` 改为使用 `/canvas/model-catalog` 的标签和能力，删除硬编码 1080P 与固定 5–15 秒；`DramaCanvas.vue` 调用自由节点构造器时传完整 capability，而不只传 `maxReferences`。

- [ ] **步骤 5：运行前端测试并提交**

```powershell
node --test test/toapisVideoCanvasContract.test.js test/standaloneCanvasFreeNodeGeneration.test.js test/homeQuickGeneration.test.js test/canvasGenerationOptions.test.js test/canvasFiveGapCore.test.js
git add src/utils/videoDuration.js src/utils/homeQuickGeneration.js src/utils/canvasModelCapabilities.js src/utils/freeCanvasGeneration.js src/components/dramaCanvas/HomeCanvasNode.vue src/components/dramaCanvas/CanvasGenerationOptions.vue src/views/FilmList.vue src/views/FreeCreate.vue src/views/HomeCanvas.vue src/views/DramaCanvas.vue test/toapisVideoCanvasContract.test.js test/standaloneCanvasFreeNodeGeneration.test.js test/homeQuickGeneration.test.js test/canvasGenerationOptions.test.js
git commit -m "feat: 在首页和画布开放 ToAPIs 视频能力"
```

### 任务 6：短剧工厂所有视频路径共用目录和请求

**文件：**
- 修改：`frontweb/src/views/FilmCreate.vue`
- 修改：`frontweb/src/utils/videoGenerationRequest.js`
- 修改：`frontweb/test/videoGenerationRequest.test.js`
- 创建：`frontweb/test/toapisShortDramaVideoContract.test.js`

- [ ] **步骤 1：编写全路径失败测试**

对单分镜、批量、一键流水线和修复缺失四类捕获请求，断言都携带同一 `model/resolution/duration/reference_mode/generate_audio` 快照：

```js
for (const request of captured) {
  assert.equal(request.model, 'seedance-2-mini')
  assert.equal(request.resolution, '720p')
  assert.equal(request.duration, 8)
}
assert.deepEqual(captured.map((item) => item.path).sort(), ['batch', 'repair', 'single', 'workflow'])
```

- [ ] **步骤 2：让视频模型选项来自 `/canvas/model-catalog`**

`loadVideoModelOptions()` 不再只拼接 `/ai-config/public` 的裸模型名；使用目录中的 `kind=video` 条目生成 `{ model, label, publicNote, capabilities, resolutionPrices }`。管理员展示名作为选项标签，真实 ID 作为值。

- [ ] **步骤 3：增加模型特定分辨率和时长选项**

项目默认与每分镜覆盖切换模型时同步校正 480P/720P 和时长。Mini 不显示 5 秒；Fast 显示 4–15 秒；任何旧草稿的 1080P 在提交前报错，不静默降档。

- [ ] **步骤 4：扩展公共短剧请求构造器**

`buildVideoGenerationRequest()` 增加并完整透传：

```js
export function buildVideoGenerationRequest({
  dramaId, storyboardId, prompt, model, imageUrl, firstFrameUrl, lastFrameUrl,
  referenceImageUrls, referenceVideoUrls, referenceAudioUrls,
  referenceMode, generateAudio, style, aspectRatio, resolution, duration,
}) {
  return compact({
    drama_id: dramaId,
    storyboard_id: storyboardId,
    prompt,
    model,
    image_url: imageUrl,
    first_frame_url: firstFrameUrl,
    last_frame_url: lastFrameUrl,
    reference_image_urls: referenceImageUrls,
    reference_video_urls: referenceVideoUrls,
    reference_audio_urls: referenceAudioUrls,
    reference_mode: referenceMode,
    generate_audio: generateAudio,
    style,
    aspect_ratio: aspectRatio,
    resolution,
    duration,
  })
}
```

`videoGenerationRequest.test.js` 断言 `false` 不会被 `compact()` 错删，确保 `generate_audio=false` 明确送达后端。

- [ ] **步骤 5：统一四类构造路径**

当前 `FilmCreate.vue` 只有 `buildSbVideoRequestContext()` 可复用，批量、一键和修复仍存在手工拼请求；不要假设当前分支存在 `buildShortDramaVideoRequest()` 或 `buildSbUsmercariVideoPayload()`。让 `buildSbVideoRequestContext()` 成为单一来源，并由它调用 `buildVideoGenerationRequest()`；单条、批量、一键和修复全部调用这条链，不在循环中重新拼参考字段。全能模式根据目录能力传完整图片、视频、音频数组，首尾帧模式只传首尾帧。

- [ ] **步骤 6：运行测试并提交**

```powershell
node --test test/toapisShortDramaVideoContract.test.js test/videoGenerationRequest.test.js test/filmCreateImageModelResolution.test.js
git add src/views/FilmCreate.vue src/utils/videoGenerationRequest.js test/toapisShortDramaVideoContract.test.js test/videoGenerationRequest.test.js
git commit -m "feat: 在短剧工厂统一 ToAPIs 视频模型"
```

### 任务 7：真实供应商验证脚本与发布合同

**文件：**
- 创建：`backend-node/scripts/verify-toapis-video-models.js`
- 创建：`backend-node/scripts/verify-toapis-video-release-contract.js`
- 创建：`backend-node/test/toapisVideoVerification.test.js`
- 创建：`backend-node/test/toapisVideoReleaseContract.test.js`
- 修改：`backend-node/package.json`
- 修改：`docs/TOAPIS_VIDEO_MODELS_VERIFICATION_20260807.md`

- [ ] **步骤 1：编写验证脚本纯函数测试**

覆盖测试矩阵生成、Key 脱敏、未知提交不重试、完成态下载、ffprobe 解析和证据 JSON：

```js
assert.deepEqual(buildRequiredMatrix().map((item) => item.id), [
  'fast-t2v-480', 'fast-t2v-720', 'mini-t2v-480', 'mini-t2v-720',
  'fast-first-last-480', 'mini-first-last-480',
  'fast-omni-480', 'mini-omni-480',
])
assert.doesNotMatch(JSON.stringify(redactEvidence({ apiKey: 'secret', task_id: 'tsk' })), /secret/)
```

- [ ] **步骤 2：实现可恢复验证脚本**

Key 只从 `TOAPIS_API_KEY` 环境变量读取。脚本把已取得 `task_id` 写入临时运行状态，重启时只轮询已有任务；没有明确供应商拒绝时不自动重复 POST。每个成品下载后执行 ffprobe 和 SHA-256，写入本站长期测试资产并记录真实账户扣费。证据文件不含 Key、Authorization 或完整请求头。只有全部必需组合通过后，脚本才调用 `aiConfigService.recordVerification()` 写入对应模型的 `verified_capabilities`；失败时记录 `failed` 和脱敏错误。

- [ ] **步骤 3：编写发布合同突变测试**

分别移除 `toapis_video` 协议分支、Mini 720P 证据、参考能力证据、两档价格、严格目录门禁和 `canvas-credit-callout-v1`；验证器必须以 `TOAPIS_VIDEO_RELEASE_CONTRACT_FAILED` 非零退出。

- [ ] **步骤 4：实现静态发布验证器**

验证器读取候选源码和脱敏证据，要求 8 个矩阵组合成功、媒体字段齐全、真实费用已复核、两模型只含 480P/720P、Key 不在仓库、目录严格门禁和积分合同存在。

- [ ] **步骤 5：运行脚本单测并提交**

```powershell
node --test --test-concurrency=1 test/toapisVideoVerification.test.js test/toapisVideoReleaseContract.test.js
git add scripts/verify-toapis-video-models.js scripts/verify-toapis-video-release-contract.js test/toapisVideoVerification.test.js test/toapisVideoReleaseContract.test.js package.json ../docs/TOAPIS_VIDEO_MODELS_VERIFICATION_20260807.md
git commit -m "test: 增加 ToAPIs 视频真实验证门禁"
```

- [ ] **步骤 6：只补齐缺失的真实矩阵**

文档中已有三条只可复用供应商终态、临时下载和 ffprobe/hash；必须先补入本站长期测试资产并取得真实账户扣费证据。任一旧任务因临时 URL 过期、资产导入失败或费用无法绑定而不完整时，只重跑该组合。其余至少新建 Mini 720P、两模型首尾帧和两模型全能参考共 5 个缺失任务，因此本阶段新增 POST 数量为 5 至 8 个，以补齐证据所需的最小数量为准。每次 POST 前打印模型、分辨率、时长和预计成本，不打印 Key；失败记录原因且不开放对应能力。

预期：8 个矩阵组合全部有 `completed + readable artifact + ffprobe + hash + cost evidence` 才能把两模型标记为 `verified`。

### 任务 8：本地全量、浏览器实操和合并候选审计

**文件：**
- 创建：`frontweb/e2e/toapis-video-models.spec.js`
- 修改：`docs/TOAPIS_VIDEO_MODELS_VERIFICATION_20260807.md`

- [ ] **步骤 1：运行后端全量**

```powershell
cd backend-node
npm test
```

预期：退出码 0；记录通过/失败数和耗时。

- [ ] **步骤 2：运行前端定向、全量和构建**

```powershell
cd ../frontweb
node --test test/*.test.js
npm run build
```

预期：不得新增失败；构建退出码 0。若主线已有失败，记录精确失败集合并证明本分支没有增加。

- [ ] **步骤 3：运行独立浏览器实操**

使用专用端口且 `PLAYWRIGHT_REUSE_SERVER=0`。管理员配置两个模型的展示名、备注、验证能力和两档价格；依次在首页、独立画布、项目画布、短剧工厂操作模型、分辨率、时长、首尾帧、全能参考、扣分提示、提交、运行态、完成态、视频播放、下载和刷新持久化。

```powershell
$env:PLAYWRIGHT_REUSE_SERVER='0'
npx playwright test e2e/toapis-video-models.spec.js
```

预期：所有入口产生功能结果，不以按钮存在替代生成、回填和可播放成品。

- [ ] **步骤 4：合并最新主线与图片候选**

在图片候选已形成干净提交后，从最新 `origin/main` 建集成分支，按提交顺序 cherry-pick 图片候选和 ToAPIs 提交。解决冲突时保护：GPT 仅 1K/2K、Nano 1K/2K/4K、ToAPIs 仅 480P/720P、严格验证目录、参考互斥和 `canvas-credit-callout-v1`。

- [ ] **步骤 5：运行合并后审计**

```powershell
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
cd backend-node
npm test
npm run audit:usmercari-image
npm run audit:toapis-video
cd ../frontweb
node --test test/*.test.js
npm run build
```

预期：合并候选通过图片与视频两套门禁，无 Key、数据库、生成媒体或无关文件进入 Git。

### 任务 9：从实时线上版本制作并激活受保护候选

**文件：**
- 服务器端实时 release 的审计 allowlist 文件
- 不修改共享门禁

- [ ] **步骤 1：读取生产实况和锁定预期 current**

通过 SSH 只读检查：

```bash
readlink -f /opt/moli-drama/current
git -C /opt/moli-drama/current rev-parse HEAD 2>/dev/null || true
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh --help
```

记录 `EXPECTED_CURRENT`，检查部署锁、活动生成任务、磁盘、健康、进程和 AI 音乐隔离。任何异常停止。

- [ ] **步骤 2：从实时 current 克隆候选并复制 allowlist**

候选目录必须位于 `/opt/moli-drama/releases/`，初始内容来自实时 `current`。只复制本轮审计确认的图片/视频源码、测试、迁移和前端构建文件；不得整体上传本地工作树。

- [ ] **步骤 3：候选内运行门禁和构建**

运行图片、ToAPIs、画布积分合同、后端全量、前端构建和健康预检。生产 Key 只写入现有受保护 secret/env 机制，不进入命令输出、候选源码或日志。

- [ ] **步骤 4：只用共享脚本激活**

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

禁止直接替换 `current`，禁止修改、删除或绕过 `/opt/moli-drama/shared/release-guard`。

- [ ] **步骤 5：配置模型并执行生产验收**

管理员配置两图片模型和两 ToAPIs 视频模型的真实 ID、展示名、备注、已验证能力和价格；随后只做受控低档生产实操，核对目录、预计扣分、冻结/结算/退款、人民币成本、成品 URL、本站资产、页面回填、下载、刷新持久化和错误日志。

生产验收失败时按共享发布机制回退，并保留任务、账务和日志证据，不重复提交付费生成。

## 完成标准

只有同时满足以下条件才能称为“接入并部署完成”：

1. 两视频模型的 480P/720P、首尾帧和全能参考共 8 个组合通过真实生成、下载、ffprobe、哈希、费用和本站资产门禁；
2. 两图片模型既有真实验证合同仍完整，GPT 不出现 4K，Nano 保留 4K；
3. 管理员、首页、独立画布、项目画布和短剧工厂共享展示名、备注、能力、价格和启停状态；
4. 所有入口的真实生成、任务恢复、结算/退款、回填、播放、下载和刷新持久化通过；
5. 未验证、缺 Key、停用、缺价、1080P、非法时长、超量参考或模式混发在任务入库和预扣前被阻断；
6. 后端全量、前端全量差异审计、生产构建、浏览器 E2E、图片门禁、ToAPIs 门禁和共享发布门禁通过；
7. 生产 `current` 由共享脚本原子切换，健康、日志、任务、账务和 AI 音乐隔离复核正常。
