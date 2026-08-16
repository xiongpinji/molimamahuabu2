import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCanvasExecutionPlan } from '../src/utils/canvasExecutionPlan.js'
import {
  canvasModelCapability,
  canvasModelRoute,
  estimateCanvasCredits,
  imageModelCapabilityBadges,
  normalizeCanvasModelCatalog,
  canvasModelOptions,
} from '../src/utils/canvasModelCapabilities.js'
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
  const catalog = [{
    kind: 'video',
    model: 'v1',
    credits: 12,
    billing_unit: 'second',
    resolution_prices: {
      '480p': { credits: 6, cost_micros_per_second: 50000 },
      '720p': { credits: 12, cost_micros_per_second: 100000 },
    },
    capabilities: { durations: [5, 8] },
  }]
  assert.deepEqual(canvasModelCapability(catalog, 'video', 'v1').durations, [5, 8])
  assert.equal(estimateCanvasCredits(catalog, 'video', 'v1', 1, 8, '480P'), 48)
  assert.equal(estimateCanvasCredits(catalog, 'video', 'v1', 1, 8, '720p'), 96)
  assert.equal(estimateCanvasCredits(catalog, 'video', 'v1', 1, 12, '720p'), null)
})

test('model capabilities estimate per-request video cost without duration multiplier', () => {
  const catalog = [{
    kind: 'video',
    model: 'sdas-my-seedance-2.0-fast-upscaled-1080p',
    credits: 860,
    billing_unit: 'request',
    capabilities: { durations: [5, 15] },
  }]
  assert.equal(estimateCanvasCredits(catalog, 'video', catalog[0].model, 1, 15, '1080p'), 860)
})

test('video capability fallback includes every supported duration from 5 to 15 seconds', () => {
  assert.deepEqual(canvasModelCapability([], 'video', 'lingjing-video-v1').durations, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
})

test('model catalog keeps a strict opaque config route out of user-facing labels', () => {
  const catalog = normalizeCanvasModelCatalog([
    { kind: 'image', model: 'image-a', label: '图片模型 A', config_id: 42 },
    { kind: 'image', model: 'image-b', label: '图片模型 B', config_id: '0043' },
    { kind: 'image', model: 'bad-boolean', config_id: true },
    { kind: 'image', model: 'bad-exponent', config_id: '1e2' },
    { kind: 'image', model: 'bad-decimal', config_id: '1.0' },
    { kind: 'image', model: 'bad-sign', config_id: '+44' },
    { kind: 'image', model: 'bad-zero', config_id: 0 },
    { kind: 'image', model: 'bad-unsafe', config_id: Number.MAX_SAFE_INTEGER + 1 },
  ])

  assert.equal(canvasModelRoute(catalog, 'image', 'image-a').configId, 42)
  assert.equal(canvasModelRoute(catalog, 'image', 'image-b').configId, 43)
  assert.equal(canvasModelRoute(catalog, 'image', 'image-a').label, '图片模型 A')
  for (const model of ['bad-boolean', 'bad-exponent', 'bad-decimal', 'bad-sign', 'bad-zero', 'bad-unsafe']) {
    assert.equal(canvasModelRoute(catalog, 'image', model).configId, null)
  }
  assert.equal(catalog.some((item) => item.label.includes('#42') || item.label.includes('config')), false)
})

test('image model options and selected details explain each model capability range', () => {
  const catalog = [
    {
      kind: 'image', model: 'gpt-image-2', label: 'GPT Image 2',
      capabilities: {
        maxReferences: 20,
        supportsImageReference: true,
        resolutions: ['1K', '2K'],
        aspectRatios: ['16:9', '9:16', '1:1'],
        quantities: [1],
      },
    },
    {
      kind: 'image', model: 'fumin-gpt-image-2-4K', label: 'fumin GPT Image 2 4K',
      capabilities: {
        maxReferences: 0,
        supportsImageReference: false,
        resolutions: ['4K'],
        quantities: [1],
      },
    },
  ]

  assert.deepEqual(canvasModelOptions(catalog, 'image').map(({ label }) => label), [
    'GPT Image 2｜文生图 · 图生图（20 张参考图）',
    'fumin GPT Image 2 4K｜文生图 · 不支持参考图',
  ])
  assert.deepEqual(imageModelCapabilityBadges(catalog[0].capabilities), [
    '文生图',
    '图生图：最多 20 张参考图',
    '清晰度：1K / 2K',
    '画面比例：16:9 / 9:16 / 1:1',
    '每次 1 张',
  ])
  assert.deepEqual(imageModelCapabilityBadges(catalog[1].capabilities), [
    '文生图',
    '参考图：不支持',
    '清晰度：4K',
    '每次 1 张',
  ])
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
