# 画布图片自适应质量优化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复画布图片请求隐式降为低质量的问题，为文生图、单图参考和多图参考增加写实提示增强、质量门禁和最多一次的平台付费定向重试，同时保持用户只扣首次生成积分。

**架构：** 前端只提交稳定的 `quality_profile: recommended` 合同；后端根据已验证模型能力解析实际质量参数，并负责提示增强、生成、质量检查、定向重试和审计。现有 `image_generations` 与 `async_tasks` 继续作为任务主记录，新增少量质量状态字段，不另建第二套任务或计费系统。

**技术栈：** Vue 3、Node.js、Express、SQLite / better-sqlite3、Sharp、Node.js test runner、现有 OpenAI-compatible vision 调用与积分账本。

---

## 实施前约束

1. 实际项目路径：`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\feituo-live-r9-merge-20260808`。
2. 当前工作树还有另一项视频模型接入修改；本计划不得覆盖、格式化或提交那些文件。
3. 每个任务只提交列出的文件；提交前运行 `git diff --cached --name-only` 核对范围。
4. 不调用未经真实验证的图片模型或视觉评估模型。
5. 不部署生产；生产候选与激活必须遵守设计文档中的共享门禁。

## 文件结构与职责

### 新建

- `backend-node/migrations/54_canvas_image_quality.sql`：为图片任务增加质量策略、状态、尝试次数和审计 JSON。
- `backend-node/src/services/imageQualityPolicy.js`：纯函数；解析已验证能力、推荐质量档、输出格式与写实提示增强。
- `backend-node/src/services/imageQualityGate.js`：使用 Sharp 做本地硬指标检查，并可选调用已验证视觉评估器。
- `backend-node/test/canvasImageQualityPolicy.test.js`：质量策略、持久化、提示增强和 GPT 输出参数合同。
- `backend-node/test/canvasImageQualityGate.test.js`：本地门禁、语义解析和失败降级合同。
- `backend-node/test/canvasImageQualityRetry.test.js`：一次重试、较优结果、任务状态和用户单次扣费合同。
- `backend-node/scripts/verify-canvas-image-quality.js`：真实模型验收脚本；不记录密钥，输出可读文件、尺寸、哈希、账本和重试证据。
- `backend-node/test/verifyCanvasImageQuality.test.js`：验收脚本的脱敏、终态和证据完整性测试。
- `docs/reports/2026-08-09-canvas-image-quality-verification.md`：真实生成通过后生成的证据报告；未运行真实生成前不得创建“通过”报告。

### 修改

- `frontweb/src/utils/freeCanvasGeneration.js:527-596`：画布图片请求增加推荐质量合同；节点数据持久化质量状态。
- `frontweb/test/standaloneCanvasFreeNodeGeneration.test.js:232-318`：锁定文生图、单图和多图请求中的质量合同。
- `backend-node/src/db/migrate.js:345-376`：新旧数据库都能补齐质量字段。
- `backend-node/src/services/imageService.js:33-73, 260-355, 1144-1280, 1285-2425`：持久化策略、运行两层门禁、最多一次重试、完成任务并结算一次积分。
- `backend-node/src/services/imageClient.js:792-818, 2158-2442`：移除缺省 `low`，接收后端解析出的输出格式与压缩参数。
- `backend-node/src/services/aiClient.js:857-968`：视觉调用兼容多张有序图片并返回实际配置元数据。
- `frontweb/src/views/DramaCanvas.vue:2706-2715, 3100-3275`：将任务消息、质量状态和最终审计摘要写入节点运行状态。
- `frontweb/src/components/dramaCanvas/HomeCanvasNode.vue:456-501, 602-735`：展示“推荐质量”、生成/检查/重试阶段和最终质量状态，不改变积分金额。
- `frontweb/test/standaloneCanvasFreeNodeRuntime.test.js`：锁定轮询消息和质量状态传递。
- `backend-node/test/canvasCreditReleaseContract.test.js`：现有受保护积分合同测试；实施中只运行，不修改。

## 任务 1：锁定画布推荐质量请求合同

**文件：**
- 修改：`frontweb/test/standaloneCanvasFreeNodeGeneration.test.js:232-318`
- 修改：`frontweb/src/utils/freeCanvasGeneration.js:527-596`

- [ ] **步骤 1：编写失败的前端请求测试**

在现有“自由节点生成请求按 kind 构造”测试的图片期望中加入：

```js
assert.deepEqual(imagePayload, {
  drama_id: 7,
  prompt: '一张雨夜街道',
  model: 'flux',
  aspect_ratio: '16:9',
  style: 'cinematic',
  resolution: '2k',
  size: '2048x1152',
  n: 2,
  quality_profile: 'recommended',
  negative_prompt: '模糊，低清晰度',
  reference_images: [
    'https://cdn.example/a.png',
    'https://cdn.example/character.png',
  ],
})
```

再增加单图参考和多图参考两组断言，确认两者都携带 `quality_profile`，而视频、音频请求不携带该字段。

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test frontweb/test/standaloneCanvasFreeNodeGeneration.test.js
```

预期：FAIL，图片请求缺少 `quality_profile`。

- [ ] **步骤 3：添加最小请求实现**

在 `buildFreeCanvasGenerationRequest()` 的图片分支加入唯一固定合同：

```js
return withoutEmptyFields({
  drama_id: dramaId,
  prompt: content,
  model: nodeData.model,
  aspect_ratio: nodeData.aspectRatio,
  style: nodeData.style,
  resolution,
  size: imageSizeFromResolution(nodeData.aspectRatio, resolution),
  n: quantity,
  quality_profile: 'recommended',
  negative_prompt: nodeData.negativePrompt,
  reference_images: referenceUrls,
})
```

前端不得直接发送 `quality: high`，避免把供应商差异写死在浏览器。

- [ ] **步骤 4：运行测试确认通过**

运行：

```powershell
node --test frontweb/test/standaloneCanvasFreeNodeGeneration.test.js
```

预期：PASS。

- [ ] **步骤 5：提交**

```powershell
git add frontweb/src/utils/freeCanvasGeneration.js frontweb/test/standaloneCanvasFreeNodeGeneration.test.js
git commit -m "feat: add canvas image quality profile contract"
```

## 任务 2：持久化质量策略并按已验证能力解析

**文件：**
- 创建：`backend-node/migrations/54_canvas_image_quality.sql`
- 创建：`backend-node/src/services/imageQualityPolicy.js`
- 创建：`backend-node/test/canvasImageQualityPolicy.test.js`
- 修改：`backend-node/src/db/migrate.js:345-376`
- 修改：`backend-node/src/services/imageService.js:33-73, 260-355, 1144-1280`

- [ ] **步骤 1：编写失败的策略与持久化测试**

测试至少覆盖：

```js
test('推荐策略只使用已验证模型声明的最高稳定质量档', () => {
  const policy = resolveImageQualityPolicy({
    profile: 'recommended',
    model: 'gpt-image-2',
    resolution: '2k',
    capabilities: {
      qualityTiers: ['standard', 'high'],
      outputFormats: ['jpeg', 'png'],
      recommendedQuality: 'high',
    },
  })
  assert.equal(policy.quality, 'high')
  assert.equal(policy.outputFormat, 'png')
})

test('未声明质量能力时不猜测 high 也不返回 low', () => {
  const policy = resolveImageQualityPolicy({
    profile: 'recommended',
    model: 'unknown-image-model',
    resolution: '1k',
    capabilities: {},
  })
  assert.equal(policy.quality, undefined)
  assert.equal(policy.quality === 'low', false)
})
```

数据库测试调用 `imageService.create()` 后断言：

```js
const row = db.prepare(`SELECT quality_profile, quality, quality_status,
  quality_attempts, quality_audit FROM image_generations WHERE id = ?`).get(created.id)
assert.equal(row.quality_profile, 'recommended')
assert.equal(row.quality, 'high')
assert.equal(row.quality_status, 'pending')
assert.equal(row.quality_attempts, 0)
assert.deepEqual(JSON.parse(row.quality_audit), { version: 'canvas-image-quality-v1', attempts: [] })
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
node --test backend-node/test/canvasImageQualityPolicy.test.js
```

预期：FAIL，模块和数据库字段尚不存在。

- [ ] **步骤 3：增加最小数据库字段**

`54_canvas_image_quality.sql`：

```sql
ALTER TABLE image_generations ADD COLUMN quality_profile TEXT;
ALTER TABLE image_generations ADD COLUMN quality_status TEXT;
ALTER TABLE image_generations ADD COLUMN quality_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE image_generations ADD COLUMN quality_audit TEXT;
```

在 `ensureColumns()` 的 `image_generations` 列表中增加同名四列，保证历史库和新库行为一致。

- [ ] **步骤 4：实现纯质量策略解析器**

`imageQualityPolicy.js` 导出下列接口：

```js
const QUALITY_POLICY_VERSION = 'canvas-image-quality-v1'

function verifiedModelCapabilities(config, model) {
  const all = config?.verified_capabilities || {}
  const key = Object.keys(all).find((item) => item.toLowerCase() === String(model || '').toLowerCase())
  const value = key ? all[key] : null
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function resolveImageQualityPolicy({ profile, model, resolution, capabilities = {} }) {
  const normalizedProfile = profile === 'recommended' ? 'recommended' : 'recommended'
  const tiers = Array.isArray(capabilities.qualityTiers) ? capabilities.qualityTiers.map(String) : []
  const formats = Array.isArray(capabilities.outputFormats) ? capabilities.outputFormats.map(String) : []
  const declared = String(capabilities.recommendedQuality || '')
  const quality = tiers.includes(declared) ? declared : tiers.includes('high') ? 'high' : undefined
  const outputFormat = quality === 'high' && formats.includes('png')
    ? 'png'
    : formats.includes('jpeg') ? 'jpeg' : undefined
  return {
    version: QUALITY_POLICY_VERSION,
    profile: normalizedProfile,
    model: String(model || ''),
    resolution: String(resolution || '').toLowerCase(),
    quality,
    outputFormat,
    outputCompression: outputFormat === 'jpeg' && quality === 'high' ? 95 : undefined,
  }
}

module.exports = {
  QUALITY_POLICY_VERSION,
  verifiedModelCapabilities,
  resolveImageQualityPolicy,
}
```

- [ ] **步骤 5：在创建任务时持久化策略**

在 `resolveImageBillingRequest()` 获取当前配置的已验证能力，构造 `qualityPolicy`，放入 `requestSnapshot.quality_policy`。修改 `INSERT INTO image_generations`，写入：

```js
qualityPolicy.profile,
qualityPolicy.quality || null,
'pending',
0,
JSON.stringify({ version: qualityPolicy.version, attempts: [] }),
```

`rowToItem()` 返回：

```js
quality_profile: r.quality_profile || undefined,
quality_status: r.quality_status || undefined,
quality_attempts: Number(r.quality_attempts || 0),
quality_audit: parseJsonObject(r.quality_audit),
```

- [ ] **步骤 6：运行迁移和测试**

```powershell
node --test backend-node/test/canvasImageQualityPolicy.test.js
node --test backend-node/test/assetImageBilling.test.js
```

预期：全部 PASS；现有计费快照和预占金额不变。

- [ ] **步骤 7：提交**

```powershell
git add backend-node/migrations/54_canvas_image_quality.sql backend-node/src/db/migrate.js backend-node/src/services/imageQualityPolicy.js backend-node/src/services/imageService.js backend-node/test/canvasImageQualityPolicy.test.js
git commit -m "feat: persist verified canvas image quality policy"
```

## 任务 3：移除 GPT Image 隐式低质量输出

**文件：**
- 修改：`backend-node/src/services/imageClient.js:792-818, 2419-2433`
- 修改：`backend-node/test/openAIImageOutput.test.js`
- 修改：`backend-node/test/canvasImageQualityPolicy.test.js`

- [ ] **步骤 1：把旧 low 断言改成目标合同**

```js
assert.deepEqual(getOpenAIImageOutputOptions('gpt-image-2', {}), {
  output_format: 'png',
})

assert.deepEqual(getOpenAIImageOutputOptions('gpt-image-2', {
  quality: 'high',
  outputFormat: 'jpeg',
  outputCompression: 95,
}), {
  output_format: 'jpeg',
  output_compression: 95,
})

assert.equal(
  getOpenAIImageOutputOptions('gpt-image-2', {}).quality,
  undefined,
)
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
node --test backend-node/test/openAIImageOutput.test.js
```

预期：FAIL，当前函数仍返回 JPEG 85 和 `quality: low`。

- [ ] **步骤 3：实现模型输出选项**

```js
function getOpenAIImageOutputOptions(model, policy = {}) {
  if (!/^gpt-image-/i.test(String(model || ''))) return {}
  const outputFormat = policy.outputFormat || 'png'
  return {
    output_format: outputFormat,
    ...(outputFormat === 'jpeg' && Number(policy.outputCompression) > 0
      ? { output_compression: Number(policy.outputCompression) }
      : {}),
  }
}
```

`callImageApi()` 继续通过通用请求体发送显式 `quality`，但将完整策略传给 `getOpenAIImageOutputOptions()`：

```js
const outputOptions = isGptImage
  ? getOpenAIImageOutputOptions(model, {
      quality,
      outputFormat: opts.output_format,
      outputCompression: opts.output_compression,
    })
  : {}
```

- [ ] **步骤 4：运行相关测试**

```powershell
node --test backend-node/test/openAIImageOutput.test.js backend-node/test/canvasImageQualityPolicy.test.js
```

预期：PASS，任何缺省路径都不再生成 `quality: low`。

- [ ] **步骤 5：提交**

```powershell
git add backend-node/src/services/imageClient.js backend-node/test/openAIImageOutput.test.js backend-node/test/canvasImageQualityPolicy.test.js
git commit -m "fix: stop degrading canvas GPT images to low quality"
```

## 任务 4：加入写实提示增强和多参考角色锁定

**文件：**
- 修改：`backend-node/src/services/imageQualityPolicy.js`
- 修改：`backend-node/src/services/imageService.js:2104-2181`
- 修改：`backend-node/test/canvasImageQualityPolicy.test.js`

- [ ] **步骤 1：编写失败的提示增强测试**

```js
test('写实增强保留原提示且多参考编号稳定', () => {
  const result = buildRecommendedQualityPrompt({
    prompt: '林夏站在雨夜街道中央，35mm 中景',
    referenceCount: 3,
  })
  assert.match(result.prompt, /^林夏站在雨夜街道中央，35mm 中景/)
  assert.match(result.prompt, /自然皮肤纹理/)
  assert.match(result.prompt, /真实镜头光学/)
  assert.match(result.prompt, /参考图1、参考图2、参考图3/)
  assert.match(result.negativePrompt, /塑料皮肤|蜡像感/)
})

test('重复执行不会重复追加写实段落', () => {
  const first = buildRecommendedQualityPrompt({ prompt: '原始提示', referenceCount: 0 })
  const second = buildRecommendedQualityPrompt({ prompt: first.prompt, referenceCount: 0 })
  assert.equal(second.prompt, first.prompt)
})
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
node --test backend-node/test/canvasImageQualityPolicy.test.js
```

预期：FAIL，`buildRecommendedQualityPrompt` 尚不存在。

- [ ] **步骤 3：实现版本化增强函数**

实现固定标记和有限增强，不调用第二个文本模型：

```js
const REALISM_SUFFIX = '自然皮肤纹理与毛发微细节，真实布料和环境材质，真实镜头光学，合理曝光、阴影、反射与景深，电影级动态范围，保持主体、动作、构图和剧情不变'
const REALISM_NEGATIVE = '塑料皮肤，蜡像感，过度磨皮，廉价CG感，3D渲染感，模糊，低清晰度，错误肢体，异常手指'

function buildRecommendedQualityPrompt({ prompt, negativePrompt, referenceCount }) {
  const source = String(prompt || '').trim()
  const referenceLock = referenceCount > 0
    ? `参考图1${Array.from({ length: referenceCount - 1 }, (_, i) => `、参考图${i + 2}`).join('')}按顺序对应各自人物或场景，保持身份、服装和空间关系，不得串位`
    : ''
  const enhanced = source.includes(REALISM_SUFFIX)
    ? source
    : [source, REALISM_SUFFIX, referenceLock].filter(Boolean).join('。')
  return {
    prompt: enhanced,
    negativePrompt: [negativePrompt, REALISM_NEGATIVE].filter(Boolean).join('，'),
  }
}
```

- [ ] **步骤 4：仅在推荐质量画布路径应用**

在 `processImageGeneration()` 调用供应商前，根据 `requestSnapshot.quality_policy.profile === 'recommended'` 应用增强，并使用一致变量名：

```js
const qualityPrompt = buildRecommendedQualityPrompt({
  prompt: finalPrompt,
  negativePrompt: row.negative_prompt || '',
  referenceCount: reference_image_urls?.length || 0,
})
finalPrompt = qualityPrompt.prompt
const finalNegativePrompt = qualityPrompt.negativePrompt
```

宫格、首尾帧既有身份和布局锁继续在增强后执行，不能被覆盖。

- [ ] **步骤 5：运行提示与现有参考图合同测试**

```powershell
node --test backend-node/test/canvasImageQualityPolicy.test.js backend-node/test/canvasReferenceSequenceContract.test.js backend-node/test/usmercariImageGenerationFlow.test.js
```

预期：PASS。

- [ ] **步骤 6：提交**

```powershell
git add backend-node/src/services/imageQualityPolicy.js backend-node/src/services/imageService.js backend-node/test/canvasImageQualityPolicy.test.js
git commit -m "feat: enhance canvas image realism and reference locking"
```

## 任务 5：实现两层质量门禁

**文件：**
- 创建：`backend-node/src/services/imageQualityGate.js`
- 创建：`backend-node/test/canvasImageQualityGate.test.js`
- 修改：`backend-node/src/services/aiClient.js:857-968`

- [ ] **步骤 1：编写本地硬指标失败测试**

测试使用 Sharp 在临时目录生成正常图、纯色空白图和尺寸不足图：

```js
test('本地门禁拒绝空白图和尺寸不足图', async () => {
  const result = await inspectLocalImage({
    absolutePath: blankPath,
    expectedWidth: 2048,
    expectedHeight: 1152,
  })
  assert.equal(result.passed, false)
  assert.deepEqual(result.reasons.sort(), ['blank_or_flat', 'dimensions_too_small'].sort())
})
```

正常图断言返回实际 `width`、`height`、`meanLuma`、`contrast`、`detailScore` 和 `passed: true`。

- [ ] **步骤 2：编写语义评估解析测试**

```js
test('语义评估只接受严格 JSON 并规范化失败原因', async () => {
  const result = await evaluateSemanticQuality({
    generatedImage: { localAbsPath: outputPath },
    referenceImages: [{ imageUrl: 'https://cdn.example/ref.png' }],
    generateVision: async () => JSON.stringify({
      verdict: 'retry',
      scores: { realism: 48, anatomy: 91, referenceConsistency: 52 },
      reasons: ['plastic_look', 'reference_mismatch'],
    }),
  })
  assert.equal(result.status, 'retry')
  assert.deepEqual(result.reasons, ['plastic_look', 'reference_mismatch'])
})
```

再测试视觉调用异常时返回：

```js
assert.deepEqual(result, {
  status: 'not_evaluated',
  reasons: ['vision_evaluator_unavailable'],
})
```

- [ ] **步骤 3：运行测试确认失败**

```powershell
node --test backend-node/test/canvasImageQualityGate.test.js
```

预期：FAIL，门禁模块不存在。

- [ ] **步骤 4：实现本地硬指标检查**

`inspectLocalImage()` 使用已安装的 Sharp，不增加依赖：

```js
async function inspectLocalImage({ absolutePath, expectedWidth, expectedHeight }) {
  const image = sharp(absolutePath, { failOn: 'error' })
  const metadata = await image.metadata()
  const stats = await image.stats()
  const width = Number(metadata.width || 0)
  const height = Number(metadata.height || 0)
  const channels = stats.channels.slice(0, 3)
  const meanLuma = channels.reduce((sum, item) => sum + item.mean, 0) / Math.max(1, channels.length)
  const contrast = channels.reduce((sum, item) => sum + item.stdev, 0) / Math.max(1, channels.length)
  const reasons = []
  if (width < expectedWidth * 0.9 || height < expectedHeight * 0.9) reasons.push('dimensions_too_small')
  if (meanLuma <= 8 || meanLuma >= 247 || contrast < 3) reasons.push('blank_or_flat')
  const detailScore = await neighborDifferenceScore(image)
  if (detailScore < 1.2) reasons.push('severely_blurred')
  return { passed: reasons.length === 0, reasons, width, height, meanLuma, contrast, detailScore }
}
```

`neighborDifferenceScore()` 将图片缩至最大 256 像素灰度 raw buffer，只计算相邻像素差均值；阈值只拦截严重失败，真实样本验收后才能调整。

- [ ] **步骤 5：让视觉调用支持有序多图**

保持旧单图参数兼容，把 `imageSource` 规范化成数组；用户消息内容按“生成结果、参考图1、参考图2……”交替加入文本标签和图片：

```js
const sources = Array.isArray(imageSource) ? imageSource : [imageSource]
const visionParts = []
for (let index = 0; index < sources.length; index += 1) {
  visionParts.push({ type: 'text', text: index === 0 ? '生成结果' : `参考图${index}` })
  visionParts.push({ type: 'image_url', image_url: { url: await resolveVisionImageUrl(sources[index]) } })
}
```

新增 `options.returnMeta === true` 时返回：

```js
return { text: content.trim(), model, configId: config.id }
```

旧调用仍返回字符串。

- [ ] **步骤 6：实现语义评估器**

`evaluateSemanticQuality()` 使用固定系统词，要求严格 JSON，仅允许以下原因：

```js
const RETRY_REASONS = new Set([
  'plastic_look',
  'anatomy_error',
  'reference_mismatch',
  'reference_role_swap',
])
```

视觉模型未配置、未通过实际图片调用或返回格式错误时，返回 `not_evaluated`，不得伪造通过分数。

- [ ] **步骤 7：运行门禁和视觉回归测试**

```powershell
node --test backend-node/test/canvasImageQualityGate.test.js
node --test backend-node/test/aiClient*.test.js
```

预期：PASS；旧单图视觉分析仍返回字符串。

- [ ] **步骤 8：提交**

```powershell
git add backend-node/src/services/imageQualityGate.js backend-node/src/services/aiClient.js backend-node/test/canvasImageQualityGate.test.js
git commit -m "feat: add canvas image quality gates"
```

## 任务 6：编排一次平台重试并保持用户单次扣费

**文件：**
- 创建：`backend-node/test/canvasImageQualityRetry.test.js`
- 修改：`backend-node/src/services/imageService.js:1285-2425`
- 修改：`backend-node/src/services/imageQualityPolicy.js`

- [ ] **步骤 1：编写失败的一次重试与计费测试**

通过 `runtime.callImageApi` 和 `runtime.evaluateQuality` 注入确定性结果：第一次返回低质量，第二次通过。

```js
assert.equal(providerCalls.length, 2)
assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count, 1)
assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'confirmed')
assert.equal(row.quality_attempts, 2)
assert.equal(row.quality_status, 'passed')
const audit = JSON.parse(row.quality_audit)
assert.equal(audit.attempts[1].trigger, 'platform_quality_retry')
assert.equal(audit.attempts[1].user_credits, 0)
```

再覆盖：

- 首次通过只调用一次；
- 第二次仍不合格时停止并保存评分较高的可读结果，状态为 `review_required`；
- 首次没有可读文件且第二次也失败时任务失败并退款；
- 视觉评估为 `not_evaluated` 时只使用硬指标结果，不触发语义重试；
- 已记录 `quality_attempts = 2` 时不得第三次提交。

- [ ] **步骤 2：运行测试确认失败**

```powershell
node --test backend-node/test/canvasImageQualityRetry.test.js
```

预期：FAIL，当前处理流程没有质量尝试和平台重试。

- [ ] **步骤 3：提取单次生成帮助函数**

在 `imageService.js` 内提取局部函数，不新建第二套服务：

```js
async function runImageAttempt({
  db, log, row, requestSnapshot, prompt, negativePrompt,
  attempt, runtime, imageSize, referenceImageUrls,
  filesBaseUrl, storageLocalPath, imageServiceType,
}) {
  const callImageApi = runtime.callImageApi || imageClient.callImageApi
  const result = await callImageApi(db, log, {
    prompt,
    negative_prompt: negativePrompt,
    model: requestSnapshot.model || row.model,
    preferred_provider: requestSnapshot.provider || undefined,
    preferred_config_id: requestSnapshot.config_id || undefined,
    size: imageSize,
    resolution: requestSnapshot.resolution || row.resolution || undefined,
    n: requestSnapshot.quantity || row.quantity || 1,
    quality: row.quality || undefined,
    output_format: requestSnapshot.quality_policy?.outputFormat,
    output_compression: requestSnapshot.quality_policy?.outputCompression,
    reference_image_urls: referenceImageUrls || undefined,
    image_gen_id: row.id,
    imageServiceType,
    files_base_url: filesBaseUrl,
    storage_local_path: storageLocalPath,
  }, runtime)
  return persistAndInspectAttempt({
    db, log, row, result, attempt, imageSize,
    storageLocalPath, runtime, referenceImageUrls,
  })
}
```

`persistAndInspectAttempt()` 必须完成同一组明确动作：校验供应商结果数量、以 `ig_q1` / `ig_q2` 前缀下载到项目存储、执行已有 `verifyLocalImageArtifact()`、调用 `imageQualityGate.inspectLocalImage()`、按需调用 `evaluateSemanticQuality()`，并返回：

```js
{
  attempt,
  trigger: attempt === 1 ? 'initial' : 'platform_quality_retry',
  images: [{ url, local_path, artifact }],
  gate: {
    hard: { passed, reasons, width, height, meanLuma, contrast, detailScore },
    semantic: { status, reasons, scores, evaluatorModel, evaluatorConfigId },
    passed,
    reasons,
  },
  score,
  providerCostMicros,
}
```

两次文件都保留到任务审计完成；最终资产只绑定被选中的一组。`score` 只用于两次都未通过时选择较优结果：硬指标可读性优先，其次语义分数；不得让主观语义分数覆盖损坏文件。

- [ ] **步骤 4：实现原因到重试词的确定映射**

```js
const RETRY_SUFFIXES = {
  dimensions_too_small: '使用模型原生高质量尺寸输出，禁止低清晰度放大',
  severely_blurred: '主体焦点准确，轮廓与微细节清晰，避免失焦和运动模糊',
  plastic_look: '自然皮肤毛孔和真实材质反射，避免蜡像、塑料感和廉价CG感',
  anatomy_error: '人体解剖结构自然，双手与手指数量、关节和透视正确',
  reference_mismatch: '严格保持参考人物脸型、五官比例、发型、服装和年龄感',
  reference_role_swap: '严格按参考图编号对应人物和场景，禁止身份串位',
}
```

`buildRetryPrompt()` 只追加命中的修正词，保留首次完整提示和构图。

主循环固定为两次上限：

```js
const attempts = []
let promptForAttempt = finalPrompt
for (let attempt = 1; attempt <= 2; attempt += 1) {
  const current = await runImageAttempt({
    db, log, row, requestSnapshot, prompt: promptForAttempt,
    negativePrompt: finalNegativePrompt, attempt, runtime,
    imageSize, referenceImageUrls: reference_image_urls,
    filesBaseUrl, storageLocalPath, imageServiceType,
  })
  attempts.push(current)
  persistQualityAudit(db, row.id, attempts)
  if (current.gate.passed || attempt === 2) break
  if (current.gate.semantic.status === 'not_evaluated' && current.gate.hard.passed) break
  promptForAttempt = buildRetryPrompt(finalPrompt, current.gate.reasons)
}
const selected = selectBestReadableAttempt(attempts)
```

`persistQualityAudit()` 在事务中把完整审计写入 `quality_audit`，同时把 `quality_attempts` 更新为 `attempts.length`。`selectBestReadableAttempt()` 先过滤不可读结果，再按 `gate.passed`、硬指标和语义分数排序；没有可读结果时返回 `null` 并进入既有失败退款路径。

- [ ] **步骤 5：更新任务阶段和审计**

阶段消息固定为：

```js
taskService.updateTaskStatus(db, row.task_id, 'processing', 20, '高质量图片生成中…')
taskService.updateTaskStatus(db, row.task_id, 'processing', 65, '图片质量检查中…')
taskService.updateTaskStatus(db, row.task_id, 'processing', 72, '正在定向重试 1/1…')
taskService.updateTaskStatus(db, row.task_id, 'processing', 92, '正在保存较优结果…')
```

每次尝试完成后，在一个事务中更新 `quality_attempts`、`quality_status` 和完整 `quality_audit`，避免服务异常后重复提交。

- [ ] **步骤 6：保持一次用户结算**

平台重试不得调用 `creditLedger.reserve()` 或新增 `usage_reservations`。整个任务只在最终可读结果选定后执行一次：

```js
settleImageCredit(db, log, row, 'completed')
```

完全失败沿用：

```js
settleImageCredit(db, log, row, 'failed', finalError)
```

重试审计使用 `requestSnapshot.cost_micros_per_unit` 记录平台预计成本，不绑定用户 reservation。

- [ ] **步骤 7：任务结果返回质量摘要**

```js
taskService.updateTaskResult(db, row.task_id, {
  image_generation_id: imageGenId,
  image_url: selected.url,
  images: selectedImages,
  status: 'completed',
  quality: {
    profile: row.quality_profile,
    status: finalQualityStatus,
    attempts: attempts.length,
    reasons: finalReasons,
  },
})
```

- [ ] **步骤 8：运行计费与重试回归**

```powershell
node --test backend-node/test/canvasImageQualityRetry.test.js backend-node/test/assetImageBilling.test.js backend-node/test/creditLedger.test.js
```

预期：PASS；一笔用户预占、一笔最终结算，平台重试只在质量审计中出现。

- [ ] **步骤 9：提交**

```powershell
git add backend-node/src/services/imageService.js backend-node/src/services/imageQualityPolicy.js backend-node/test/canvasImageQualityRetry.test.js
git commit -m "feat: retry failed canvas image quality once at platform cost"
```

## 任务 7：在画布展示真实质量阶段和结果

**文件：**
- 修改：`frontweb/src/utils/freeCanvasGeneration.js:345-450`
- 修改：`frontweb/src/views/DramaCanvas.vue:2706-2715, 3100-3275`
- 修改：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue:456-501, 602-735`
- 修改：`frontweb/test/standaloneCanvasFreeNodeRuntime.test.js`
- 修改：`frontweb/test/standaloneCanvasFreeNodeGeneration.test.js`

- [ ] **步骤 1：编写失败的状态传递测试**

测试源代码和纯数据规范化：

```js
const normalized = normalizeFreeCanvasNodeData({
  kind: 'image',
  qualityProfile: 'recommended',
  qualityStatus: 'review_required',
  qualityAttempts: 2,
  qualityReasons: ['reference_mismatch'],
  generationMessage: '建议复核',
})
assert.equal(normalized.qualityProfile, 'recommended')
assert.equal(normalized.qualityStatus, 'review_required')
assert.equal(normalized.qualityAttempts, 2)
assert.deepEqual(normalized.qualityReasons, ['reference_mismatch'])
```

运行时测试锁定：

```js
assert.match(canvasSource, /onProgress\?\.\(progress, task\)/)
assert.match(nodeSource, /质量策略：推荐/)
assert.match(nodeSource, /正在定向重试 1\/1/)
assert.match(nodeSource, /canvas-credit-callout-v1/)
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
node --test frontweb/test/standaloneCanvasFreeNodeGeneration.test.js frontweb/test/standaloneCanvasFreeNodeRuntime.test.js
```

预期：FAIL，质量字段和任务消息尚未传递。

- [ ] **步骤 3：传递轮询消息和最终质量摘要**

修改轮询：

```js
const progress = normalizeGenerationProgress(task?.progress)
if (progress !== null) await onProgress?.(progress, task)
```

图片任务轮询时写入：

```js
onProgress: async (currentProgress, task) => {
  await patchFreeCanvasNodeData(node.id, {
    progress: calculateBatchGenerationProgress(completedResults.length, quantity, currentProgress),
    progressKnown: true,
    generationMessage: task?.message || '高质量图片生成中…',
  })
}
```

任务完成后从 `task.result.quality` 或 `/images/:id` 写入 `qualityStatus`、`qualityAttempts`、`qualityReasons`。

- [ ] **步骤 4：展示质量标签和状态**

只在图片节点显示：

```vue
<div v-if="data.kind === 'image'" class="image-quality-state" aria-live="polite">
  <span>质量策略：推荐</span>
  <span v-if="data.status === 'running'">{{ data.generationMessage || '高质量图片生成中…' }}</span>
  <strong v-else-if="data.qualityStatus === 'passed'">质量检查已通过</strong>
  <strong v-else-if="data.qualityStatus === 'review_required'" class="needs-review">建议复核</strong>
</div>
```

积分区保持现有 DOM 语义，只确保类名同时包含受保护标记：

```vue
<span v-if="canGenerate" class="billing-cost canvas-credit-callout-v1" aria-live="polite">
```

平台重试不能改变 `estimatedCredits` 或“· N 次”显示。

- [ ] **步骤 5：运行前端测试和构建**

```powershell
node --test frontweb/test/standaloneCanvasFreeNodeGeneration.test.js frontweb/test/standaloneCanvasFreeNodeRuntime.test.js
npm --prefix frontweb run build
```

预期：PASS，构建成功。

- [ ] **步骤 6：提交**

```powershell
git add frontweb/src/utils/freeCanvasGeneration.js frontweb/src/views/DramaCanvas.vue frontweb/src/components/dramaCanvas/HomeCanvasNode.vue frontweb/test/standaloneCanvasFreeNodeGeneration.test.js frontweb/test/standaloneCanvasFreeNodeRuntime.test.js
git commit -m "feat: show canvas image quality status"
```

## 任务 8：增加真实生成验收器并完成发布前证据

**文件：**
- 创建：`backend-node/scripts/verify-canvas-image-quality.js`
- 创建：`backend-node/test/verifyCanvasImageQuality.test.js`
- 修改：`backend-node/package.json`
- 生成：`docs/reports/2026-08-09-canvas-image-quality-verification.md`

- [ ] **步骤 1：编写验收器失败测试**

测试必须确认验收器：

```js
assert.equal(report.cases.length, 3)
assert.deepEqual(report.cases.map((item) => item.mode), [
  'text_to_image',
  'single_reference',
  'multi_reference',
])
for (const item of report.cases) {
  assert.equal(item.terminal_state, 'completed')
  assert.equal(item.artifact.readable, true)
  assert.match(item.artifact.sha256, /^[a-f0-9]{64}$/)
  assert.equal(item.billing.user_reservation_count, 1)
  assert.equal(item.billing.platform_retry_user_credits, 0)
}
assert.doesNotMatch(JSON.stringify(report), /sk-[A-Za-z0-9_-]+/)
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
node --test backend-node/test/verifyCanvasImageQuality.test.js
```

预期：FAIL，验收脚本不存在。

- [ ] **步骤 3：实现只读证据输出和显式实测命令**

脚本参数固定为下列名称；执行时从环境变量读取现场已确认值，命令和报告中不得出现 Key：

```text
--db $env:CANVAS_QUALITY_DB
--model $env:CANVAS_QUALITY_MODEL
--drama-id $env:CANVAS_QUALITY_DRAMA_ID
--user-id $env:CANVAS_QUALITY_USER_ID
--single-ref $env:CANVAS_QUALITY_SINGLE_REF
--multi-ref $env:CANVAS_QUALITY_MULTI_REFS
--output .\docs\reports\canvas-image-quality-evidence.json
--confirm-paid-call
```

没有 `--confirm-paid-call` 时直接退出，且不得提交供应商任务。脚本通过 `imageService.create()` 走与画布相同的前后端后端链路，轮询 `async_tasks`，随后读取本地文件并用 Sharp + SHA-256 验证。报告只记录配置 ID、模型、脱敏请求摘要、终态、文件尺寸/哈希、质量审计和账本状态。

在 `package.json` 增加：

```json
"verify:canvas-image-quality": "node scripts/verify-canvas-image-quality.js"
```

- [ ] **步骤 4：运行验收器单元测试**

```powershell
node --test backend-node/test/verifyCanvasImageQuality.test.js
```

预期：PASS。

- [ ] **步骤 5：运行完整自动回归**

```powershell
npm --prefix backend-node test
node --test frontweb/test/*.test.js
npm --prefix frontweb run build
npm --prefix backend-node run audit:canvas-credit-contract -- --require-build
```

预期：全部 PASS；共享积分合同审计输出成功。

- [ ] **步骤 6：执行真实生成验收**

在用户确认目标模型、样本和本次付费调用后，先设置本次会话的六个环境变量；脚本启动时逐项检查非空，然后执行：

```powershell
npm --prefix backend-node run verify:canvas-image-quality -- --db $env:CANVAS_QUALITY_DB --model $env:CANVAS_QUALITY_MODEL --drama-id $env:CANVAS_QUALITY_DRAMA_ID --user-id $env:CANVAS_QUALITY_USER_ID --single-ref $env:CANVAS_QUALITY_SINGLE_REF --multi-ref $env:CANVAS_QUALITY_MULTI_REFS --output .\docs\reports\canvas-image-quality-evidence.json --confirm-paid-call
```

预期：三种模式全部达到 `completed`，结果文件可读取，尺寸和哈希存在。若自动重试被触发，用户账本仍只有首次结算；若未触发，用专门的质量门禁测试夹具证明一次重试合同，不能为了制造重试而浪费真实供应商调用。

- [ ] **步骤 7：形成不含密钥的验收报告**

`docs/reports/2026-08-09-canvas-image-quality-verification.md` 必须列出：

```markdown
- 当前分支与提交 SHA
- 模型与配置 ID（不含 Key）
- 文生图、单图参考、多图参考的任务 ID
- 每个任务的供应商成功终态
- 本地文件路径、宽高、字节数与 SHA-256
- 质量策略、门禁结果、尝试次数和失败原因
- 用户 reservation 数量、状态和最终扣分
- 平台重试的用户积分为 0
- 自动测试、前端构建和积分合同审计结果
```

- [ ] **步骤 8：提交验收器和真实证据**

只有真实生成全部通过后执行：

```powershell
git add backend-node/scripts/verify-canvas-image-quality.js backend-node/test/verifyCanvasImageQuality.test.js backend-node/package.json docs/reports/2026-08-09-canvas-image-quality-verification.md
git commit -m "test: verify real canvas image quality flow"
```

真实验收失败时只提交验收器代码和测试，不创建“通过”报告，也不得发布。

## 任务 9：最终审计与生产候选准备

**文件：**
- 检查：本计划涉及的全部文件
- 不修改：`/opt/moli-drama/current`

- [ ] **步骤 1：确认差异范围**

```powershell
$qualityBaseline = git rev-parse 4694a156
git status --short
git diff --stat "$qualityBaseline..HEAD"
git diff --check "$qualityBaseline..HEAD"
```

预期：只出现本计划文件和预先存在的独立视频模型修改；两者的提交边界清晰。

- [ ] **步骤 2：执行最终测试矩阵**

```powershell
npm --prefix backend-node test
node --test frontweb/test/*.test.js
npm --prefix frontweb run build
npm --prefix backend-node run audit:canvas-credit-contract -- --require-build
```

预期：全部 PASS。

- [ ] **步骤 3：人工核验四项证据**

逐项读取并确认：

1. GPT Image 请求没有 `quality: low`；
2. 三种真实生成模式都有可读文件；
3. 质量审计最多两次尝试，用户账本只有一次结算；
4. 图片节点仍显示醒目加粗积分卡片和真实质量状态。

- [ ] **步骤 4：只准备受保护候选，不自动激活**

SSH 读取实时 `/opt/moli-drama/current` 后，从该 release 克隆候选，只覆盖审计通过的本任务文件。执行部署锁、活动任务、健康、日志、AI 音乐隔离、备份、构建和共享门禁预检。

只有用户再次明确批准生产切换时，才允许调用：

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

禁止直接修改 `current`，禁止替换或弱化共享门禁。

## 规格覆盖自检映射

| 设计要求 | 实施任务 |
| --- | --- |
| 修复缺失 quality 与隐式 low | 任务 1、2、3 |
| 写实增强且不覆盖用户意图 | 任务 4 |
| 单图、多图参考身份锁定 | 任务 1、4、8 |
| 本地硬指标质量门禁 | 任务 5 |
| 按需语义质量门禁与不可用降级 | 任务 5、8 |
| 最多一次定向重试 | 任务 6 |
| 用户只付首次、平台承担重试 | 任务 6、8 |
| 画布状态与醒目积分卡片 | 任务 7、9 |
| 真实生成、文件、账本与审计证据 | 任务 8、9 |
| 生产保护与回滚边界 | 任务 9 |
