# USMercari 两个图片模型全站接入实施计划

> **2026-08-07 执行修订（覆盖下文冲突步骤）：** `gpt-image-2-2-4k` 仅开放 1K/2K，`nano-banana-2` 开放 1K/2K/4K。GPT 4K 的失败证据保留为禁止开放门禁。图片档位使用独立 `model_image_resolution_prices` 表，不重建现有视频档位表；所有测试、界面与验收按每模型 `verified_capabilities.resolutions` 动态收敛。

> **面向 AI 代理的工作者：** 必需子技能：使用 `subagent-driven-development`（推荐）或 `executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）跟踪进度；每个任务遵循测试先行，只有前一门禁通过才进入下一任务。

**目标：** 接入 `gpt-image-2-2-4k` 与 `nano-banana-2`，让管理员配置、模型展示名/备注、各自已验证分辨率的人民币成本、积分价格和真实验证状态同步到首页、画布和短剧工厂，并让单次生成 1 张图片的文生图、最多六张参考图生图、资产落库、失败退款形成可验证闭环。

**架构：** 新增独立 `usmercari_image` 协议适配器；图片任务在入库和积分预扣前完成模型、分辨率、参考图数量、验证状态和价格校验。后台使用独立图片分辨率价格表，用户端只消费统一画布模型目录。供应商返回 URL 必须由后端下载、验图并保存到当前租户/项目后才算成功。

**技术栈：** Node.js 20、Express、SQLite/better-sqlite3、Vue 3、Element Plus、Node test runner、Playwright、Sharp。

**已确认价格：** 两个模型的已开放同档价格相同；1K 成本 ¥0.08/张、70 积分，2K 成本 ¥0.10/张、87 积分；4K 成本 ¥0.12/张、105 积分只用于 `nano-banana-2`。供应商截图金额是人民币，不做美元换算。

**硬门禁：** 通用后端适配代码可以先存在，但真实生成通过前不得把模型写入前端供应商预设、用户模型目录或生产 `ai_service_configs`。本计划不包含生产切换；部署需用户另行明确授权。

---

## 文件职责

- `backend-node/src/services/usmercariImageClient.js`：唯一负责 USMercari 图片公网参考 URL、generations 请求和供应商响应解析的文件。
- `backend-node/src/services/imageClient.js`：只做协议选择和统一参数转发，不复制供应商协议细节。
- `backend-node/src/services/imageService.js`：负责预扣前门禁、任务/价格快照、结果验图落库和终态退款。
- `backend-node/src/services/modelPriceService.js`：负责图片/视频档位合法性、管理员价格读写、积分和人民币成本计算。
- `backend-node/src/services/aiConfigService.js`：负责管理员配置、连接测试和真实验证状态的持久化/读取。
- `backend-node/src/services/canvasModelCatalogService.js`：负责首页、画布和短剧工厂共用的用户模型目录门禁。
- `backend-node/scripts/verify-usmercari-image-models.js`：负责真实供应商调用、成品下载/验图和脱敏证据输出，不修改用户目录。
- `frontweb/src/components/AIConfigContent.vue`：负责管理员 USMercari 图片供应商预设、展示名、备注和连接测试入口。
- `frontweb/src/views/BillingAdmin.vue`：负责 1K/2K/4K 的人民币成本/张和积分/张编辑。
- `frontweb/src/utils/freeCanvasGeneration.js`：负责画布图片生成请求的 model、resolution、size 和参考图合同。
- `frontweb/src/views/HomeCanvas.vue`、`frontweb/src/views/DramaCanvas.vue`：只消费统一目录和统一请求构造器。
- `frontweb/src/views/FilmCreate.vue`：负责短剧工厂图片模型/档位选择，并把同一快照透传到单项、批量、一键和修复路径。

---

### 任务 1：锁定供应商图片协议的失败合同

**文件：**
- 创建：`backend-node/test/usmercariImageClient.test.js`
- 创建：`backend-node/src/services/usmercariImageClient.js`

- [ ] **步骤 1：编写文生图请求失败测试**

测试 `POST /v1/images/generations` 的 URL、`Authorization: Bearer ***`、JSON Content-Type，以及请求体仅包含 `model`、`prompt`、`n`、`aspect_ratio`、`resolution`。测试日志和错误不得包含完整 Key。

```js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const usmercariImageClient = require('../src/services/usmercariImageClient')

function captureSequence(payloads) {
  const queue = [...payloads]
  const calls = []
  return {
    calls,
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ url, headers: init.headers || {}, body })
      return new Response(JSON.stringify(queue.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
}

const captureFetch = (payload) => captureSequence([payload])
const validInput = {
  baseUrl: 'https://chat-ai.mercarimx.com',
  apiKey: 'secret-key',
  model: 'gpt-image-2-2-4k',
  prompt: '一只猫',
  n: 1,
  aspectRatio: '16:9',
  resolution: '1k',
}

it('uses the USMercari generations JSON contract', async () => {
  const request = captureFetch({ data: [{ url: 'https://cdn.example/result.png' }] })
  await usmercariImageClient.create({
    fetchImpl: request.fetch,
    baseUrl: 'https://chat-ai.mercarimx.com',
    apiKey: 'secret-key',
    model: 'gpt-image-2-2-4k',
    prompt: '一只猫',
    n: 1,
    aspectRatio: '16:9',
    resolution: '1k',
  })
  assert.equal(request.calls[0].url, 'https://chat-ai.mercarimx.com/v1/images/generations')
  assert.equal(request.calls[0].headers.Authorization, 'Bearer secret-key')
  assert.deepEqual(request.calls[0].body, {
    model: 'gpt-image-2-2-4k', prompt: '一只猫', n: 1, aspect_ratio: '16:9', resolution: '1k',
  })
})
```

- [ ] **步骤 2：编写公网参考图合同测试**

证明参考图只接受服务端配置 `STORAGE_BASE_URL` 同源路径下的本站静态资源公网 URL；单张通过 `image_url`、多张通过 `image_urls` 随 `POST /v1/images/generations` 提交。私网地址、其他域名、本机路径、相对 URL 和带认证信息的 URL 都必须在供应商调用前拒绝。

```js
it('uses one public reference on the generations contract', async () => {
  const request = captureFetch({ data: [{ url: 'https://cdn.example/edited.png' }] })
  await usmercariImageClient.create({
    ...validInput,
    fetchImpl: request.fetch,
    referenceImageUrls: ['https://molimama.vip/static/projects/1/reference.png'],
    allowedReferenceBaseUrl: 'https://molimama.vip/static',
  })
  assert.match(request.calls[0].url, /\/v1\/images\/generations$/)
  assert.equal(request.calls[0].body.image_url, 'https://molimama.vip/static/projects/1/reference.png')
  assert.equal(request.calls[0].body.image_urls, undefined)
})
```

- [ ] **步骤 3：编写输入与结果边界失败测试**

覆盖：零张和 1–6 张参考图都走 generations；单张发送 `image_url`，多张发送 `image_urls`；第 7 张在任何 HTTP 调用前失败；HTML/502、空 `data`、缺少 URL 和不可下载结果均失败；同名 `nano-banana-2` 仍命中 `usmercari_image` 而不是旧 `nano_banana` 协议。

```js
it('blocks the seventh reference before provider I/O', async () => {
  let calls = 0
  await assert.rejects(
    usmercariImageClient.create({
      ...validInput,
      fetchImpl: async () => { calls += 1 },
      referenceImageUrls: Array(7).fill('https://molimama.vip/static/projects/1/reference.png'),
      allowedReferenceBaseUrl: 'https://molimama.vip/static',
    }),
    /最多 6 张参考图/,
  )
  assert.equal(calls, 0)
})

it('keeps nano-banana-2 on the explicit USMercari protocol', () => {
  assert.equal(inferProtocol({ api_protocol: 'usmercari_image' }, 'nano-banana-2'), 'usmercari_image')
})
```

- [ ] **步骤 4：运行测试确认红灯**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 test/usmercariImageClient.test.js
```

预期：FAIL，尚无 `usmercariImageClient` 实现。

- [ ] **步骤 5：提交失败合同**

```powershell
git add backend-node/test/usmercariImageClient.test.js
git commit -m "test: 锁定 USMercari 图片协议"
```

### 任务 2：实现不对用户开放的供应商适配器

**文件：**
- 创建：`backend-node/src/services/usmercariImageClient.js`
- 修改：`backend-node/src/services/imageClient.js`
- 修改：`backend-node/test/usmercariImageClient.test.js`

- [ ] **步骤 1：实现输入标准化和能力校验**

允许模型仅为 `gpt-image-2-2-4k`、`nano-banana-2`；GPT 仅允许 `1k/2k`，Nano 允许 `1k/2k/4k`；数量必须为 1；参考图最多 6。错误发生在生成请求之前，不允许静默改写数量或用 `slice(0, 6)` 裁剪参考图。

```js
const MODELS = {
  'gpt-image-2-2-4k': new Set(['1k', '2k']),
  'nano-banana-2': new Set(['1k', '2k', '4k']),
}

function validateRequest({ model, resolution, n, referenceFiles = [] }) {
  if (!MODELS[model]) throw new Error(`USMercari 图片模型不支持: ${model}`)
  if (!MODELS[model].has(resolution)) throw new Error(`USMercari 图片分辨率不支持: ${resolution}`)
  if (!Number.isInteger(n) || n !== 1) throw new Error('图片数量目前仅开放 1 张')
  if (referenceFiles.length > 6) throw new Error('USMercari 图片模型最多 6 张参考图')
}
```

- [ ] **步骤 2：实现公网参考图解析与请求**

复用现有站内素材解析/归属校验，把已验证素材转换成 `STORAGE_BASE_URL` 同源路径下的本站静态资源公网 URL。只允许匿名可取的公网 HTTP(S) 地址；单张写入 `image_url`，多张写入 `image_urls`，都调用 generations。未通过实测的 upload/edits 合同不得启用。

```js
function appendReferences(body, publicReferences) {
  if (publicReferences.length === 1) body.image_url = publicReferences[0]
  if (publicReferences.length > 1) body.image_urls = publicReferences
  return body
}
```

- [ ] **步骤 3：实现供应商响应解析**

只接受 `data[].url` 的图片候选；把 `provider.credits_used`、供应商模型 ID 和任务关联信息作为可审计元数据返回。隐藏 Key，截断 HTML 错误正文，保留 HTTP 状态和供应商请求标识。

```js
function parseResult(payload) {
  const urls = Array.isArray(payload?.data)
    ? payload.data.map((item) => String(item?.url || '').trim()).filter(Boolean)
    : []
  if (!urls.length) throw new Error('USMercari 图片响应没有可下载结果')
  return {
    urls,
    provider: {
      credits_used: payload?.provider?.credits_used ?? null,
      model_id: payload?.provider?.model_id ?? null,
    },
  }
}
```

- [ ] **步骤 4：在图片客户端增加独立协议路由**

`inferProtocol()` 识别显式 `usmercari_image`；`callImageApi()` 将 `resolution`、参考图和项目存储上下文传给新客户端。不得改动既有 USMercari 视频与旧 NanoBanana 分支。

```js
if (protocol === 'usmercari_image') {
  return usmercariImageClient.create({
    config,
    prompt: opts.prompt,
    model: opts.model,
    n: opts.n || 1,
    aspectRatio: opts.aspect_ratio,
    resolution: opts.resolution,
    referenceImageUrls: opts.reference_image_urls || [],
    filesBaseUrl: opts.files_base_url,
    storageLocalPath: opts.storage_local_path,
  })
}
```

- [ ] **步骤 5：运行定向测试确认绿灯**

```powershell
cd backend-node
node --test --test-concurrency=1 test/usmercariImageClient.test.js test/openAIImageOutput.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：提交适配器**

```powershell
git add backend-node/src/services/usmercariImageClient.js backend-node/src/services/imageClient.js backend-node/test/usmercariImageClient.test.js
git commit -m "feat: 接入 USMercari 图片协议"
```

### 任务 3：执行真实供应商开放门禁

**文件：**
- 创建：`backend-node/scripts/verify-usmercari-image-models.js`
- 创建：`docs/USMERCARI_IMAGE_MODELS_VERIFICATION_20260807.md`
- 修改：`backend-node/package.json`

- [ ] **步骤 1：实现服务端验证脚本**

脚本只从环境变量或现有受保护服务端配置读取 Key，不接收命令行明文 Key，不打印请求头。每次调用输出模型、能力、请求档位、实际尺寸、下载字节数、SHA-256、供应商计费字段、开始/结束时间和最终状态。

```js
const apiKey = process.env.USMERCARI_IMAGE_API_KEY
if (!apiKey) throw new Error('缺少 USMERCARI_IMAGE_API_KEY')
if (process.argv.some((arg) => arg.includes('key='))) throw new Error('禁止通过命令行传入 Key')

async function inspectDownloadedImage(buffer) {
  const metadata = await sharp(buffer).metadata()
  return {
    bytes: buffer.length,
    width: metadata.width,
    height: metadata.height,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  }
}
```

- [ ] **步骤 2：准备最小验证素材**

准备一个匿名可读的 HTTPS 测试图片，并通过 `USMERCARI_VERIFY_REFERENCE_URL` 传给验证脚本。该地址必须与生产相同，能够被供应商直接拉取；不把用户素材或带签名的私有地址提交到 Git。

```js
const referenceUrl = String(process.env.USMERCARI_VERIFY_REFERENCE_URL || '').trim()
if (!/^https:\/\//i.test(referenceUrl)) throw new Error('USMERCARI_VERIFY_REFERENCE_URL 必须是 HTTPS 公网地址')
await runVerificationMatrix({ apiKey, referenceUrl })
```

- [ ] **步骤 3：真实验证五个允许开放的文生图组合，并记录 GPT 4K 失败证据**

按顺序运行：

```text
gpt-image-2-2-4k: 1k, 2k（4k 已失败，禁止开放）
nano-banana-2: 1k, 2k, 4k
```

每次等待成功，下载图片，使用 Sharp 打开并记录宽高。对网络状态不明的付费提交不自动重试，先人工核对供应商账单。

- [ ] **步骤 4：真实验证两个参考图组合**

两个模型各至少执行一次 1K 公网参考图生图，证明 `image_url`、generations、下载和验图完整成功；未验证通过的上传/edits 合同不得启用。

- [ ] **步骤 5：写入脱敏证据并判断门禁**

验证文档记录 8 次调用的脱敏请求摘要、结果哈希、尺寸和账务证据。任何模型/能力/档位失败时：停止后续用户开放任务；不得新增前端预设、目录条目或生产配置，只提交后端通用适配器与失败证据。

- [ ] **步骤 6：提交验证工具和证据**

```powershell
git add backend-node/scripts/verify-usmercari-image-models.js backend-node/package.json docs/USMERCARI_IMAGE_MODELS_VERIFICATION_20260807.md
git commit -m "test: 记录 USMercari 图片真实生成证据"
```

### 任务 4：扩展图片分辨率成本和积分账本

> 仅在任务 3 门禁全部通过后执行。

**文件：**
- 创建：`backend-node/migrations/50_image_resolution_pricing.sql`
- 修改：`backend-node/src/services/modelPriceService.js`
- 修改：`backend-node/test/modelPrice.test.js`
- 修改：`backend-node/test/modelPriceMigration.test.js`（若该文件不存在则创建）

- [ ] **步骤 1：编写迁移和计价失败测试**

证明：现有 480p/720p 视频行迁移后值不变；图片价格表可存 `1k/2k/4k`，但模型公开与生成仍按验证能力收敛；其他值拒绝；图片每张成本为 80000/100000/120000 微元、积分为 70/87/105；视频仍按每秒计价。

```js
assert.equal(modelPrice.calculateCharge(db, 'gpt-image-2-2-4k', { resolution: '1k', quantity: 1 }), 70)
assert.throws(() => modelPrice.quoteCost(db, 'gpt-image-2-2-4k', { resolution: '4k', quantity: 1 }), /未配置/)
assert.equal(modelPrice.quoteCost(db, 'nano-banana-2', { resolution: '4k', quantity: 1 }), 120000)
assert.throws(() => modelPrice.set(db, 'gpt-image-2-2-4k', 70, {
  category: 'image', resolution_prices: { '1080p': { credits: 70, cost_micros_per_unit: 80000 } },
}), /图片分辨率/)
```

- [ ] **步骤 2：实现兼容迁移**

新增独立 `model_image_resolution_prices`，图片档位不重建或改写 `model_resolution_prices`。旧视频 `cost_micros_per_second` 和 480p/720p 行保持原样，不丢历史数据。

```sql
CREATE TABLE IF NOT EXISTS model_image_resolution_prices (
  model TEXT NOT NULL COLLATE NOCASE,
  resolution TEXT NOT NULL CHECK (resolution IN ('1k', '2k', '4k')),
  credits INTEGER NOT NULL CHECK (credits > 0),
  cost_micros_per_unit INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros_per_unit >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (model, resolution)
);
```

- [ ] **步骤 3：让价格服务按类别声明档位**

图片类别只接受 `1k/2k/4k`，视频类别继续只接受 `480p/720p`。`calculateCharge()` 对图片按“档位积分 × 数量”，`quoteCost()` 对图片按“每张成本 × 数量”。公共响应继续兼容既有视频字段。

```js
const RESOLUTIONS_BY_CATEGORY = {
  image: ['1k', '2k', '4k'],
  video: ['480p', '720p'],
}

function calculateCharge(db, model, { resolution, quantity = 1 } = {}) {
  const row = readRow(db, canonicalModel(model))
  if (!row) throw priceError('MODEL_PRICE_NOT_CONFIGURED', `${model} 尚未配置积分价格，已禁止生成`)
  const tier = row.resolution_prices[normalizeResolution(resolution, row.category)]
  if (!tier) throw priceError('MODEL_RESOLUTION_PRICE_REQUIRED', '当前分辨率积分待管理员配置')
  return tier.credits * quantity
}

ensureColumn(
  db,
  'public_note',
  'ALTER TABLE model_credit_prices ADD COLUMN public_note TEXT',
)
```

- [ ] **步骤 4：运行迁移和计价测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/modelPrice.test.js test/modelPriceMigration.test.js
```

预期：全部 PASS，既有视频断言无变化。

- [ ] **步骤 5：提交账本扩展**

```powershell
git add backend-node/migrations/50_image_resolution_pricing.sql backend-node/src/services/modelPriceService.js backend-node/test/modelPrice.test.js backend-node/test/modelPriceMigration.test.js
git commit -m "feat: 支持图片分辨率分档计费"
```

### 任务 5：同步管理员配置、展示名、备注和验证状态

**文件：**
- 修改：`backend-node/src/services/aiConfigService.js`
- 修改：`backend-node/src/services/canvasModelCatalogService.js`
- 修改：`backend-node/src/routes/billing.js`
- 修改：`backend-node/test/canvasModelCatalogService.test.js`
- 创建：`backend-node/test/aiConfigService.test.js`
- 修改：`frontweb/src/components/AIConfigContent.vue`
- 修改：`frontweb/src/views/BillingAdmin.vue`
- 创建：`frontweb/test/usmercariImageProviderConfig.test.js`
- 创建：`frontweb/test/imageResolutionPricingContract.test.js`

- [ ] **步骤 1：编写管理员与目录失败测试**

覆盖：`usmercari_image` 连接测试只验证连接，不会自动标记真实验证；展示名和 `public_note` 进入公共目录；未验证、停用、缺 Key 或任一所选档位未定价时不进入用户目录；其他既有供应商目录行为保持不变。

```js
const models = canvasModelCatalog.list(db)
assert.equal(models.some((item) => item.model === 'unverified-model'), false)
assert.deepEqual(models.find((item) => item.model === 'gpt-image-2-2-4k'), {
  kind: 'image',
  model: 'gpt-image-2-2-4k',
  label: 'GPT Image 2',
  public_note: '高精度商品与角色图，支持最多 6 张参考图',
  verification_status: 'verified',
  enabled: true,
  resolution_prices: {
    '1k': { credits: 70 }, '2k': { credits: 87 },
  },
  capabilities: { supportsTextToImage: true, supportsImageReference: true, maxReferences: 6, resolutions: ['1k', '2k'] },
})
```

- [ ] **步骤 2：持久化并返回验证元数据**

`aiConfigService.rowToConfig()` 返回 `verification_status` 和能力档位快照；管理员可见 pending/verified/failed。真实验证脚本成功后才写入通过的模型、能力和档位，普通“测试连接”不得升级状态。

```js
function parseCapabilities(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function rowToConfig(row) {
  const config = {
    id: row.id,
    service_type: row.service_type,
    provider: row.provider,
    api_protocol: row.api_protocol || '',
    name: row.name,
    base_url: row.base_url,
    api_key: row.api_key,
    model: modelFromDb(row.model),
    default_model: row.default_model ? String(row.default_model).trim() : null,
    endpoint: row.endpoint,
    query_endpoint: row.query_endpoint,
    priority: row.priority ?? 0,
    is_default: Boolean(row.is_default),
    is_active: row.is_active == null ? true : Boolean(row.is_active),
    settings: row.settings,
    verification_status: row.verification_status || 'pending',
    verified_capabilities: parseCapabilities(row.verified_capabilities),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
  if (row.service_type === 'tts' && row.settings) {
    const settings = parseCapabilities(row.settings)
    if (settings.voice_id) config.voice_id = settings.voice_id
    if (settings.group_id) config.group_id = settings.group_id
  }
  return config
}

function ensureConfigColumn(db, name, sql) {
  const columns = db.prepare('PRAGMA table_info(ai_service_configs)').all()
  if (!columns.some((column) => column.name === name)) db.exec(sql)
}

ensureConfigColumn(
  db,
  'verification_status',
  "ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending'",
)
ensureConfigColumn(
  db,
  'verified_capabilities',
  "ALTER TABLE ai_service_configs ADD COLUMN verified_capabilities TEXT NOT NULL DEFAULT '{}'",
)

function isUsmercariImageVisible(config) {
  return config.api_protocol === 'usmercari_image'
    && config.enabled === 1
    && Boolean(config.api_key)
    && config.verification_status === 'verified'
}
```

- [ ] **步骤 3：增加管理员供应商预设**

在任务 3 已通过的前提下，增加“USMercari 图片”预设，Base URL 为 `https://chat-ai.mercarimx.com`，协议为 `usmercari_image`，模型 ID 为两个真实 ID。管理员展示名和备注不改变提交 model。

```js
{
  id: 'usmercari_image',
  name: 'USMercari 图片',
  baseUrl: 'https://chat-ai.mercarimx.com',
  apiProtocol: 'usmercari_image',
  models: ['gpt-image-2-2-4k', 'nano-banana-2'],
}
```

- [ ] **步骤 4：扩展图片价格编辑器**

图片按模型显示档位：GPT 显示 1K/2K，Nano 显示 1K/2K/4K；成本单位明确为“人民币元/张”，积分单位为“积分/张”。视频 480P/720P 的“元/秒”界面保持原样。

```js
function resolutionKeys(category, model) {
  if (category === 'image' && model === 'gpt-image-2-2-4k') return ['1k', '2k']
  if (category === 'image') return ['1k', '2k', '4k']
  if (category === 'video') return ['480p', '720p']
  return []
}

const USMERCARI_IMAGE_TIERS = {
  '1k': { credits: 70, cost_micros_per_unit: 80000 },
  '2k': { credits: 87, cost_micros_per_unit: 100000 },
  '4k': { credits: 105, cost_micros_per_unit: 120000 },
}
```

- [ ] **步骤 5：运行管理员与目录测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/aiConfigService.test.js test/canvasModelCatalogService.test.js
cd ../frontweb
node --test test/usmercariImageProviderConfig.test.js test/imageResolutionPricingContract.test.js test/redeem-admin-console.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：提交管理员同步**

```powershell
git add backend-node/src/services/aiConfigService.js backend-node/src/services/canvasModelCatalogService.js backend-node/src/routes/billing.js backend-node/test/aiConfigService.test.js backend-node/test/canvasModelCatalogService.test.js frontweb/src/components/AIConfigContent.vue frontweb/src/views/BillingAdmin.vue frontweb/test/usmercariImageProviderConfig.test.js frontweb/test/imageResolutionPricingContract.test.js
git commit -m "feat: 同步 USMercari 图片模型管理信息"
```

### 任务 6：把图片分档计费接入任务、退款和资产闭环

**文件：**
- 修改：`backend-node/src/services/imageService.js`
- 修改：`backend-node/src/services/generationCostLedgerService.js`
- 修改：`backend-node/test/imageBilling.test.js`
- 创建：`backend-node/test/usmercariImageGenerationFlow.test.js`

- [ ] **步骤 1：编写预扣前阻断测试**

证明未验证模型、档位缺价、非法档位和第 7 张参考图均不会创建 `image_generations`、异步任务或积分冻结，也不会调用供应商。

```js
assert.throws(() => createImage({ reference_images: Array(7).fill('/ref.png') }), /最多 6 张参考图/)
assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, 0)
assert.equal(db.prepare("SELECT COUNT(*) count FROM tenant_credit_ledger WHERE kind = 'hold'").get().count, 0)
assert.equal(providerCalls, 0)
```

- [ ] **步骤 2：编写每模型已验证档位预扣与退款测试**

证明 GPT 1K/2K 与 Nano 1K/2K/4K 按对应档位预扣 1 张图片的积分；`n != 1` 和 GPT 4K 都在任务入库和预扣前拒绝。供应商失败、HTML 错误、结果下载/验图/保存失败均进入终态失败并完整退款；重复终态处理不重复退款。

```js
for (const [resolution, credits] of [['1k', 70], ['2k', 87], ['4k', 105]]) {
  const row = createImage({ model: 'nano-banana-2', resolution, n: 1 })
  assert.equal(readHeldCredits(row.billing_reference), credits)
}
assert.throws(() => createImage({ model: 'nano-banana-2', resolution: '1k', n: 2 }), /仅开放.*1 张/)
settleImageCredit(db, log, failedRow, 'failed', '结果图片不可读')
settleImageCredit(db, log, failedRow, 'failed', '重复回调')
assert.equal(readRefundCount(failedRow.billing_reference), 1)
```

- [ ] **步骤 3：持久化分辨率与任务快照**

任务创建时保存真实 `resolution`、模型 ID、协议、能力、参考图和价格快照。异步执行不得再次采用已变化的管理员默认模型或新价格。

```js
ensureColumn(db, 'image_generations', 'resolution', 'ALTER TABLE image_generations ADD COLUMN resolution TEXT')
ensureColumn(db, 'image_generations', 'request_snapshot', 'ALTER TABLE image_generations ADD COLUMN request_snapshot TEXT')
const requestSnapshot = JSON.stringify({
  model: billedModel,
  protocol: selectedConfig.api_protocol,
  resolution,
  reference_images: referenceImages,
  credits,
  cost_micros_per_unit: tier.cost_micros_per_unit,
})
```

- [ ] **步骤 4：完成结果下载和站内资产落库**

供应商 URL 下载后校验 2xx、图片 MIME、非空和 Sharp 可读；按租户/项目安全路径保存，复用现有图片生成回填链。只有资产、生成记录和节点/角色/场景/道具/分镜回填成功后才标记 completed。

```js
async function downloadVerifiedImage(url, fetchImpl = fetch) {
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`结果下载失败 (${response.status})`)
  const type = String(response.headers.get('content-type') || '').toLowerCase()
  if (!type.startsWith('image/')) throw new Error('供应商结果不是图片')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new Error('供应商结果为空')
  await sharp(buffer).metadata()
  return buffer
}
```

- [ ] **步骤 5：记录人民币经营成本**

`generation_cost_records` 按图片张数与档位写入 80000/100000/120000 微元/张，不把该金额当美元换算。记录供应商模型、档位和数量。

```js
generationCostLedger.record(db, {
  reservationId: row.credit_reservation_id,
  model: snapshot.model,
  resolution: snapshot.resolution,
  quantity: snapshot.n,
  usageSource: 'configured',
})
```

- [ ] **步骤 6：运行账务与闭环测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/imageBilling.test.js test/usmercariImageGenerationFlow.test.js test/generationCostLedger.test.js
```

预期：全部 PASS。

- [ ] **步骤 7：提交生成闭环**

```powershell
git add backend-node/src/services/imageService.js backend-node/src/services/generationCostLedgerService.js backend-node/test/imageBilling.test.js backend-node/test/usmercariImageGenerationFlow.test.js backend-node/test/generationCostLedger.test.js
git commit -m "feat: 接入图片档位计费与资产闭环"
```

### 任务 7：统一首页和画布图片节点的模型、档位与扣分提示

**文件：**
- 修改：`frontweb/src/utils/freeCanvasGeneration.js`
- 修改：`frontweb/src/utils/homeQuickGeneration.js`
- 修改：`frontweb/src/utils/canvasModelCapabilities.js`
- 修改：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`
- 修改：`frontweb/src/views/HomeCanvas.vue`
- 修改：`frontweb/src/views/DramaCanvas.vue`
- 修改：`frontweb/test/standaloneCanvasFreeNodeGeneration.test.js`
- 修改：`frontweb/test/homeQuickGeneration.test.js`
- 修改：`frontweb/test/modelSelection.test.js`
- 修改：`frontweb/test/videoResolutionPricingContract.test.js`

- [ ] **步骤 1：编写统一目录与请求失败测试**

首页和两个画布入口显示相同的管理员展示名、备注、能力与已验证档位；请求提交真实 model ID 和小写档位；GPT 只能选 1K/2K，Nano 可选 1K/2K/4K，预计扣分随档位同步。

```js
assert.deepEqual(buildFreeCanvasGenerationRequest({
  type: 'image', model: 'gpt-image-2-2-4k', resolution: '2K', aspectRatio: '16:9', prompt: '森林',
}), {
  model: 'gpt-image-2-2-4k', resolution: '2k', size: '2048x1152', aspect_ratio: '16:9', prompt: '森林',
})
assert.equal(estimateCredits(gptCatalogModel, { resolution: '4k', quantity: 1 }), null)
assert.equal(estimateCredits(nanoCatalogModel, { resolution: '4k', quantity: 1 }), 105)

export function estimateCanvasCredits(catalog, kind, model, quantity = 1, duration = 1, resolution = '') {
  const entry = normalizeCanvasModelCatalog(catalog).find((item) => item.kind === kind && item.model === model)
  const tier = entry?.resolutionPrices?.[String(resolution).trim().toLowerCase()]
  const credits = Number(tier?.credits) > 0 ? Number(tier.credits) : entry?.credits
  if (!credits) return null
  const durationMultiplier = kind === 'video' && entry.billingUnit === 'second'
    ? Math.max(1, Number(duration) || 1)
    : 1
  return credits * Math.max(1, Number(quantity) || 1) * durationMultiplier
}
```

- [ ] **步骤 2：复用公共模型目录**

禁止三个入口各自硬编码 USMercari 模型。筛选目录时同时检查 `kind=image`、协议、verified、enabled、当前档位已定价和入口所需能力。

```js
export function selectableImageModels(catalog, { requiresReference = false } = {}) {
  return catalog.filter((item) => item.kind === 'image'
    && item.enabled !== false
    && item.verification_status === 'verified'
    && item.capabilities?.supportsTextToImage === true
    && (!requiresReference || item.capabilities?.supportsImageReference === true)
    && Object.keys(item.resolution_prices || {}).length > 0)
}

export function normalizeCanvasModelCatalog(items = []) {
  return items.filter((item) => item?.model && item?.kind).map((item) => ({
    model: String(item.model),
    label: String(item.label || item.model),
    kind: String(item.kind),
    credits: Number(item.credits) > 0 ? Number(item.credits) : null,
    billingUnit: String(item.billing_unit || ''),
    resolutionPrices: item.resolution_prices || {},
    publicNote: String(item.public_note || ''),
    verificationStatus: String(item.verification_status || ''),
    enabled: item.enabled !== false,
    capabilities: { ...(DEFAULTS[item.kind] || {}), ...(item.capabilities || {}) },
  }))
}
```

- [ ] **步骤 3：扩展图片节点请求**

`buildFreeCanvasGenerationRequest()` 同时发送原有 `size` 和标准化 `resolution`；参考图顺序保持当前 `@图片N` 合同；第 7 张在按钮提交前报错，但后端仍是最终门禁。

```js
const resolution = cleanString(nodeData.resolution || '1K').toLowerCase()
const references = collectDirectUpstreamImageReferences(nodeId)
if (references.length > 6) throw new Error('当前模型最多支持 6 张参考图')
return {
  ...baseImageRequest,
  model: nodeData.model,
  resolution,
  size: imageSizeFromResolution(nodeData.aspectRatio, resolution.toUpperCase()),
  reference_images: references.map((item) => item.url),
}
```

- [ ] **步骤 4：保留受保护扣分合同**

所有可生成图片节点继续醒目加粗显示“本次预计扣除 X 积分”；缺价显示“积分待管理员配置”并禁用提交。不得退回灰色 `billing-note`。

```vue
<strong class="canvas-credit-callout" data-contract="canvas-credit-callout-v1">
  {{ estimatedCredits == null ? '积分待管理员配置' : `本次预计扣除 ${estimatedCredits} 积分` }}
</strong>
```

- [ ] **步骤 5：运行定向前端测试**

```powershell
cd frontweb
node --test test/standaloneCanvasFreeNodeGeneration.test.js test/homeQuickGeneration.test.js test/modelSelection.test.js test/videoResolutionPricingContract.test.js
```

预期：全部 PASS，参考图序号与现有视频模型选择无回归。

- [ ] **步骤 6：提交首页与画布接入**

```powershell
git add frontweb/src/utils/freeCanvasGeneration.js frontweb/src/utils/homeQuickGeneration.js frontweb/src/utils/canvasModelCapabilities.js frontweb/src/components/dramaCanvas/HomeCanvasNode.vue frontweb/src/views/HomeCanvas.vue frontweb/src/views/DramaCanvas.vue frontweb/test/standaloneCanvasFreeNodeGeneration.test.js frontweb/test/homeQuickGeneration.test.js frontweb/test/modelSelection.test.js frontweb/test/videoResolutionPricingContract.test.js
git commit -m "feat: 在首页和画布开放 USMercari 图片模型"
```

### 任务 8：统一短剧工厂角色、场景、道具和分镜图片入口

**文件：**
- 修改：`frontweb/src/views/FilmCreate.vue`
- 修改：`frontweb/src/api/characters.js`
- 修改：`frontweb/src/api/scenes.js`
- 修改：`frontweb/src/api/props.js`
- 修改：`backend-node/src/routes/characters.js`
- 修改：`backend-node/src/routes/scenes.js`
- 修改：`backend-node/src/services/characterLibraryService.js`
- 修改：`backend-node/src/services/sceneService.js`
- 修改：`backend-node/src/services/propImageGenerationService.js`
- 修改：`backend-node/src/services/storyboardService.js`
- 创建：`frontweb/test/shortDramaImageModelCatalog.test.js`
- 创建：`backend-node/test/shortDramaImageResolution.test.js`

- [ ] **步骤 1：编写四类入口失败测试**

角色、场景、道具、分镜及“一键生成/修复缺失”都从统一目录取得真实 model ID、展示名、备注和档位；请求携带 model 与 resolution；同一分辨率显示并预扣同一积分。

```js
for (const request of capturedImageRequests) {
  assert.equal(request.model, 'gpt-image-2-2-4k')
  assert.equal(request.resolution, '2k')
}
assert.deepEqual(capturedImageRequests.map((item) => item.target_type).sort(), [
  'character', 'prop', 'scene', 'storyboard',
])
```

- [ ] **步骤 2：增加短剧工厂图片配置控件**

在图片生成配置区提供图片模型和 1K/2K/4K 档位。选项随模型能力变化，不显示未验证或未定价档位；视频配置保持独立。

```vue
<el-form-item label="图片模型">
  <el-select v-model="selectedImageModel">
    <el-option v-for="item in imageModelOptions" :key="item.model" :label="item.label" :value="item.model" />
  </el-select>
</el-form-item>
<el-form-item label="图片分辨率">
  <el-select v-model="imageResolution">
    <el-option v-for="value in selectedImageResolutions" :key="value" :label="value.toUpperCase()" :value="value" />
  </el-select>
</el-form-item>
```

- [ ] **步骤 3：统一所有短剧图片调用**

把单项生成、批量、一键流水线、修复缺失四类路径统一透传选定 model/resolution，禁止某些路径继续落回管理员默认模型。更新 characters/scenes/props API 方法签名但兼容旧调用。

```js
const imageOptions = () => ({
  model: selectedImageModel.value || undefined,
  resolution: imageResolution.value || undefined,
})

await characterAPI.generateImage(char.id, { ...imageOptions(), style })
await sceneAPI.generateImage({ scene_id: scene.id, ...imageOptions(), style, use_quad_grid: useQuad })
await propAPI.generateImage(prop.id, { ...imageOptions(), style, use_quad_grid: propUseQuadGrid.value })
```

- [ ] **步骤 4：后端路由透传任务快照**

角色、场景、道具和分镜服务将 resolution 传入统一 `imageService.create()`，不在各自分支重复计价。参考图仍执行第 6 任务的预扣前门禁。

```js
const imageGeneration = imageService.create(db, log, {
  ...targetRequest,
  model: body.model,
  resolution: body.resolution,
  reference_images: body.reference_images,
}, {
  billingEnabled: Boolean(generationOptions.billingEnabled),
  userId: req.user?.id,
  tenantId: req.tenant?.id,
})
```

- [ ] **步骤 5：运行短剧工厂定向测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/shortDramaImageResolution.test.js test/imageBilling.test.js
cd ../frontweb
node --test test/shortDramaImageModelCatalog.test.js test/videoGenerationRequest.test.js
```

预期：图片模型/分辨率全路径 PASS，既有视频请求合同不变。

- [ ] **步骤 6：提交短剧工厂接入**

```powershell
git add frontweb/src/views/FilmCreate.vue frontweb/src/api/characters.js frontweb/src/api/scenes.js frontweb/src/api/props.js backend-node/src/routes/characters.js backend-node/src/routes/scenes.js backend-node/src/services/characterLibraryService.js backend-node/src/services/sceneService.js backend-node/src/services/propImageGenerationService.js backend-node/src/services/storyboardService.js frontweb/test/shortDramaImageModelCatalog.test.js backend-node/test/shortDramaImageResolution.test.js
git commit -m "feat: 在短剧工厂统一图片模型与档位"
```

### 任务 9：全量回归、浏览器实操与发布前审计

**文件：**
- 创建：`frontweb/e2e/usmercari-image-models.spec.js`
- 创建：`backend-node/scripts/verify-usmercari-image-release-contract.js`
- 创建：`backend-node/test/usmercariImageReleaseContract.test.js`
- 修改：`backend-node/package.json`
- 修改：`docs/USMERCARI_IMAGE_MODELS_VERIFICATION_20260807.md`

- [ ] **步骤 1：先写发布合同失败测试**

测试复制最小源码夹具，分别移除真实验证证据、`usmercari_image` 显式路由、三档价格、verified 目录门禁和 `canvas-credit-callout-v1`，每种情况都必须返回 `USMERCARI_IMAGE_RELEASE_CONTRACT_FAILED`。

```js
for (const mutation of [
  removeVerificationEvidence,
  removeExplicitProtocol,
  removeImageTiers,
  removeVerifiedCatalogGate,
  removeCanvasCreditCallout,
]) {
  const fixture = await createReleaseFixture()
  await mutation(fixture)
  const result = spawnSync(process.execPath, [guardScript, fixture], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /USMERCARI_IMAGE_RELEASE_CONTRACT_FAILED/)
}
```

- [ ] **步骤 2：实现发布合同验证器**

验证器读取仓库文件而不是调用供应商；它确认脱敏证据含 7 个允许开放的成功组合和 GPT 4K 失败标记、每模型档位价格准确、目录具有 verified/enable/key/price 门禁、显式协议存在、扣分合同仍在。任何一项缺失都阻止候选发布。

```js
const requiredEvidence = [
  'gpt-image-2-2-4k|text-to-image|1k|verified',
  'gpt-image-2-2-4k|text-to-image|2k|verified',
  'gpt-image-2-2-4k|text-to-image|4k|failed',
  'gpt-image-2-2-4k|image-to-image|1k|verified',
  'nano-banana-2|text-to-image|1k|verified',
  'nano-banana-2|text-to-image|2k|verified',
  'nano-banana-2|text-to-image|4k|verified',
  'nano-banana-2|image-to-image|1k|verified',
]
for (const marker of requiredEvidence) assertContract(evidence.includes(marker), `缺少真实验证证据: ${marker}`)
assertContract(nodeSource.includes('canvas-credit-callout-v1'), '画布扣分合同缺失')
```

- [ ] **步骤 3：运行后端全量测试**

```powershell
cd backend-node
npm test
```

预期：退出码 0；记录测试数量和耗时。

- [ ] **步骤 4：运行前端全量单测并与基线比较**

```powershell
cd frontweb
node --test test/*.test.js
```

预期：不得新增失败。已知基线为 583 项中 573 通过、10 项既有画布交互合同失败；若失败集合变化则停止交付并定位。

- [ ] **步骤 5：执行前端生产构建**

```powershell
cd frontweb
npm run build
```

预期：退出码 0。

- [ ] **步骤 6：执行本地浏览器实操**

用专用端口、`PLAYWRIGHT_REUSE_SERVER=0` 运行：管理员填写/读取两模型展示名、备注和各自档位价格；首页、画布和短剧工厂列表一致；未验证/停用/缺价立即消失或禁用；GPT 不显示 4K、Nano 4K 扣分提示为 105 积分；第 7 张参考图无预扣；生成成功后成品可打开并回填正确节点/资产。

```js
test('USMercari 图片模型在三个入口共享目录与价格门禁', async ({ page }) => {
  await page.goto('/ai-config')
  await expect(page.getByText('GPT Image 2')).toBeVisible()
  await expect(page.getByText('高精度商品与角色图，支持最多 6 张参考图')).toBeVisible()

  for (const path of ['/', '/canvas', '/film-create']) {
    await page.goto(path)
    await page.getByRole('combobox', { name: '图片模型' }).selectOption('gpt-image-2-2-4k')
    await expect(page.getByRole('combobox', { name: '图片分辨率' }).locator('option[value="4k"]')).toHaveCount(0)
    await page.getByRole('combobox', { name: '图片模型' }).selectOption('nano-banana-2')
    await page.getByRole('combobox', { name: '图片分辨率' }).selectOption('4k')
    await expect(page.getByText('本次预计扣除 105 积分')).toBeVisible()
  }
})
```

```powershell
cd frontweb
npx playwright test e2e/usmercari-image-models.spec.js
```

- [ ] **步骤 7：审计账务和失败链**

核对任务 ID、积分冻结/扣除/退款、人民币成本记录、模型/分辨率快照、资产归属和日志脱敏。任何供应商候选 URL 未下载或资产不可打开都不得记为成功。

- [ ] **步骤 8：审计改动范围和受保护合同**

```powershell
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
cd backend-node
npm run audit:canvas-reference-sequence
npm run audit:usmercari-image
```

确认没有 Key、Cookie、生产数据库、生成图片或无关文件进入 Git；确认 `canvas-credit-callout-v1` 与参考图序号合同仍存在。

- [ ] **步骤 9：提交最终验证证据与门禁**

```powershell
git add frontweb/e2e/usmercari-image-models.spec.js backend-node/scripts/verify-usmercari-image-release-contract.js backend-node/test/usmercariImageReleaseContract.test.js backend-node/package.json docs/USMERCARI_IMAGE_MODELS_VERIFICATION_20260807.md
git commit -m "test: 验证 USMercari 图片全站闭环"
```

### 任务 10：等待明确部署授权

**文件：** 无本地实现文件。

- [ ] **步骤 1：报告本地与真实供应商证据**

明确区分：协议测试、真实供应商 8 次生成、前端浏览器、账务闭环、构建和生产状态。未部署时不得声称线上已生效。

- [ ] **步骤 2：收到明确部署指令后才制作生产候选**

届时通过 SSH 重新读取实时 `/opt/moli-drama/current`，从实时 release 克隆候选，只叠加审计过的 allowlist；执行备份、部署锁、活动任务、健康、日志、AI 音乐进程隔离、CAS 和共享审计器。

- [ ] **步骤 3：只用共享门禁激活**

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

禁止直接替换 current，禁止从本地工作树整体覆盖，禁止修改或绕过共享发布门禁。

- [ ] **步骤 4：激活后通过管理员链配置两模型**

使用已登录管理员接口或服务器端事务创建两条 `usmercari_image` 配置；Key 只从现有受保护环境读取。写入已验证能力和三档人民币成本/积分，不在源码、命令历史或日志中出现 Key。

```json
{
  "api_protocol": "usmercari_image",
  "base_url": "https://chat-ai.mercarimx.com",
  "models": [
    {
      "model": "gpt-image-2-2-4k",
      "verification_status": "verified",
      "resolution_prices": {
        "1k": { "credits": 70, "cost_micros_per_unit": 80000 },
        "2k": { "credits": 87, "cost_micros_per_unit": 100000 }
      }
    },
    {
      "model": "nano-banana-2",
      "verification_status": "verified",
      "resolution_prices": {
        "1k": { "credits": 70, "cost_micros_per_unit": 80000 },
        "2k": { "credits": 87, "cost_micros_per_unit": 100000 },
        "4k": { "credits": 105, "cost_micros_per_unit": 120000 }
      }
    }
  ]
}
```

- [ ] **步骤 5：线上只读复核和一次受控实操**

复核 `/canvas/model-catalog`、首页、画布、短剧工厂和管理员后台一致；每模型至少做一次低档受控生成，核对用户积分、人民币成本、成品 URL、资产归属和失败日志。未经再次确认不重复付费请求。

---

## 完成标准

只有同时满足以下条件才能称为“接入完成”：

1. GPT 的 1K/2K、Nano 的 1K/2K/4K 文生图及各一次参考图生图均为真实成功终态，GPT 4K 失败证据已固化为拒绝门禁；
2. 所有结果已下载、Sharp 可打开、尺寸/哈希/账务证据齐全；
3. 首页、画布、短剧工厂和管理员后台使用同一展示名、备注、能力和定价源；
4. 已开放的 1K/2K/4K 分别预扣 70/87/105 积分，成本分别记 ¥0.08/¥0.10/¥0.12 每张，GPT 不可使用 4K；
5. 未验证、停用、缺 Key 或缺价不会出现在用户入口，且后端不可绕过；
6. 参考图最多六张，第七张在任务入库和积分预扣前阻断；
7. 供应商失败、下载失败、验图失败和落库失败均退款且幂等；
8. 后端全量、前端定向、前端构建、浏览器 E2E、受保护合同和改动范围审计通过；
9. 若未收到明确生产部署授权，最终状态只能是“本地实现与验证完成，尚未部署”。
