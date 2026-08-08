import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCanvasExecutionPlan } from '../src/utils/canvasExecutionPlan.js'
import {
  canvasModelCapability,
  canvasModelEntry,
  canvasModelOptions,
  estimateCanvasCredits,
  filterCanvasCatalogFallbackModels,
  normalizeCanvasModelCatalog,
} from '../src/utils/canvasModelCapabilities.js'
import * as canvasModelCapabilities from '../src/utils/canvasModelCapabilities.js'
import { mergeLocalCanvasIntoProjectLayout } from '../src/utils/localCanvasBinding.js'

const node = (id, kind) => ({ id, type: 'homeCanvasNode', position: { x: 0, y: 0 }, data: { kind } })
const edge = (id, source, target) => ({ id: `manual:${id}`, source, target, data: { manual: true, contract: { enabled: true } } })

test('subgraph follows valid dependencies in topological order', () => {
  const plan = buildCanvasExecutionPlan(
    [node('a', 'text'), node('b', 'image'), node('c', 'video')],
    [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')],
    { rootNodeIds: ['a'], includeDownstream: true },
  )
  assert.deepEqual(plan, { orderedNodeIds: ['a', 'b', 'c'], cycleNodeIds: [] })
})

test('subgraph reports cycles before execution', () => {
  const plan = buildCanvasExecutionPlan(
    [node('a', 'image'), node('b', 'image')],
    [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')],
    { rootNodeIds: ['a'], includeDownstream: true },
  )
  assert.deepEqual(new Set(plan.cycleNodeIds), new Set(['a', 'b']))
})

test('model capabilities restrict parameters and estimate per-second video cost', () => {
  const catalog = [{ kind: 'video', model: 'v1', credits: 12, billing_unit: 'second', capabilities: { durations: [5, 8] } }]
  assert.deepEqual(canvasModelCapability(catalog, 'video', 'v1').durations, [5, 8])
  assert.equal(estimateCanvasCredits(catalog, 'video', 'v1', 1, 12), 144)
})

test('model capabilities estimate resolution-tier and per-request video cost', () => {
  const tieredCatalog = [{
    kind: 'video',
    model: 'tiered-video',
    credits: 12,
    billing_unit: 'second',
    resolution_prices: {
      '480p': { credits: 6 },
      '720p': { credits: 12 },
    },
    capabilities: { durations: [5, 8] },
  }]
  assert.equal(estimateCanvasCredits(tieredCatalog, 'video', 'tiered-video', 1, 12, '480P'), 72)
  assert.equal(estimateCanvasCredits(tieredCatalog, 'video', 'tiered-video', 1, 12, '720p'), 144)

  const requestCatalog = [{
    kind: 'video',
    model: 'sdas-my-seedance-2.0-fast-upscaled-1080p',
    credits: 860,
    billing_unit: 'request',
    capabilities: { durations: [5, 15] },
  }]
  assert.equal(estimateCanvasCredits(requestCatalog, 'video', requestCatalog[0].model, 1, 15, '1080p'), 860)
})

test('canvas model options show admin labels but retain model IDs and price the default model', () => {
  const catalog = [
    { kind: 'image', model: 'image-v1', label: '写实图片 Pro', credits: 18, billing_unit: 'request' },
    { kind: 'image', model: 'image-v2', label: '', credits: 26, billing_unit: 'request' },
  ]

  assert.deepEqual(canvasModelOptions(catalog, 'image'), [
    { value: 'image-v1', label: '写实图片 Pro' },
    { value: 'image-v2', label: 'image-v2' },
  ])
  assert.equal(canvasModelEntry(catalog, 'image', '').model, 'image-v1')
  assert.equal(canvasModelEntry(catalog, 'image', 'missing'), null)
  assert.equal(estimateCanvasCredits(catalog, 'image', '', 2), 36)
})

test('图片目录同步展示信息、验证状态、档位能力并按数量估算积分', () => {
  const catalog = normalizeCanvasModelCatalog([{
    kind: 'image',
    model: 'gpt-image-2-2-4k',
    label: 'GPT Image 2',
    public_note: '4K 尚未通过，暂不开放',
    verification_status: 'verified',
    protocol: 'usmercari_image',
    provider: 'usmercari',
    default_voice_id: 'voice-1',
    credits: 70,
    billing_unit: 'request',
    resolution_prices: {
      '1k': { credits: 70 },
      '2k': { credits: 87 },
      '4k': { credits: 105 },
    },
    capabilities: { resolutions: ['1k', '2k', '4k'], maxReferences: 6 },
  }])
  const entry = canvasModelEntry(catalog, 'image', 'gpt-image-2-2-4k')
  assert.equal(entry.label, 'GPT Image 2')
  assert.equal(entry.publicNote, '4K 尚未通过，暂不开放')
  assert.equal(entry.note, '4K 尚未通过，暂不开放')
  assert.equal(entry.verificationStatus, 'verified')
  assert.equal(entry.provider, 'usmercari')
  assert.equal(entry.defaultVoiceId, 'voice-1')
  assert.deepEqual(entry.capabilities.resolutions, ['1k', '2k'])
  assert.deepEqual(Object.keys(entry.resolutionPrices), ['1k', '2k'])
  assert.equal(estimateCanvasCredits(catalog, 'image', entry.model, 3, 1, '2K'), null)
  assert.equal(estimateCanvasCredits(catalog, 'image', entry.model, 1, 1, '4k'), null)

  const legacyCatalog = [{
    kind: 'image',
    model: 'legacy-multi-image',
    resolution_prices: { '2k': { credits: 87 } },
    capabilities: { resolutions: ['2k'], quantities: [1, 2, 3] },
  }]
  assert.equal(estimateCanvasCredits(legacyCatalog, 'image', 'legacy-multi-image', 3, 1, '2K'), 261)
})

test('统一目录加载器合并并缓存同一次请求且保留严格目录过滤', async () => {
  assert.equal(typeof canvasModelCapabilities.createCanvasModelCatalogLoader, 'function')
  let resolveCatalog
  let calls = 0
  const loader = canvasModelCapabilities.createCanvasModelCatalogLoader(() => {
    calls += 1
    return new Promise((resolve) => { resolveCatalog = resolve })
  })

  const first = loader.load()
  const second = loader.load()
  assert.equal(first, second)
  assert.equal(loader.snapshot().status, 'loading')
  resolveCatalog([
    {
      kind: 'video',
      model: 'seedance-2-fast',
      protocol: 'toapis_video',
      verification_status: 'verified',
      resolution_prices: { '480p': { credits: 511 } },
      capabilities: { resolutions: ['480p'], durations: [4] },
    },
    {
      kind: 'video',
      model: 'seedance-2-mini',
      protocol: 'toapis_video',
      verification_status: 'pending',
      resolution_prices: { '480p': { credits: 294 } },
      capabilities: { resolutions: ['480p'], durations: [4] },
    },
  ])

  const catalog = await first
  assert.deepEqual(catalog.map((entry) => entry.model), ['seedance-2-fast'])
  assert.equal(loader.snapshot().status, 'loaded')
  assert.equal(await loader.load(), catalog)
  assert.equal(calls, 1)
})

test('目录选择决策在加载失败、未就绪和模型移除时保持提交门禁', () => {
  assert.equal(typeof canvasModelCapabilities.canvasModelSelectionDecision, 'function')
  const catalog = [{ kind: 'image', model: 'verified-image', label: '已验证图片' }]
  assert.equal(canvasModelCapabilities.canvasModelSelectionDecision(catalog, 'image', '', 'loaded').code, 'MODEL_DEFAULT')
  assert.equal(canvasModelCapabilities.canvasModelSelectionDecision(catalog, 'image', 'verified-image', 'loaded').code, 'MODEL_AVAILABLE')
  assert.equal(canvasModelCapabilities.canvasModelSelectionDecision(catalog, 'image', 'removed-image', 'loaded').code, 'MODEL_UNAVAILABLE')
  assert.equal(canvasModelCapabilities.canvasModelSelectionDecision(catalog, 'image', 'verified-image', 'loading').code, 'CATALOG_NOT_READY')
  assert.equal(canvasModelCapabilities.canvasModelSelectionDecision(catalog, 'image', 'verified-image', 'error').code, 'CATALOG_ERROR')
})

test('严格目录图片模型不会从旧 AI 配置回退重新暴露', () => {
  assert.deepEqual(filterCanvasCatalogFallbackModels([
    'legacy-image',
    'gpt-image-2-2-4k',
    'nano-banana-2',
  ], 'image'), ['legacy-image'])
  assert.deepEqual(filterCanvasCatalogFallbackModels(['nano-banana-2'], 'video'), ['nano-banana-2'])
})

test('video capability fallback includes every supported duration from 5 to 15 seconds', () => {
  assert.deepEqual(canvasModelCapability([], 'video', 'lingjing-video-v1').durations, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
})

test('local canvas binding preserves existing project nodes and remaps collisions', () => {
  const merged = mergeLocalCanvasIntoProjectLayout(
    { nodes: { a: { x: 1, y: 2 } }, free_nodes: [node('a', 'text')], manual_edges: [] },
    { nodes: [node('a', 'image'), node('b', 'video')], edges: [edge('ab', 'a', 'b')], viewport: { x: 0, y: 0, zoom: 1 } },
    'bound',
  )
  assert.equal(merged.free_nodes.length, 3)
  assert.equal(merged.free_nodes[1].id, 'bound:0')
  assert.equal(merged.manual_edges[0].source, 'bound:0')
  assert.equal(merged.manual_edges[0].target, 'b')
})
