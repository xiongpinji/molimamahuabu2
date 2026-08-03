import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCanvasExecutionPlan } from '../src/utils/canvasExecutionPlan.js'
import {
  canvasModelCapability,
  canvasModelEntry,
  canvasModelOptions,
  estimateCanvasCredits,
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
  const catalog = [{ kind: 'video', model: 'v1', credits: 12, billing_unit: 'second', capabilities: { durations: [5, 8] } }]
  assert.deepEqual(canvasModelCapability(catalog, 'video', 'v1').durations, [5, 8])
  assert.equal(estimateCanvasCredits(catalog, 'video', 'v1', 1, 12), 144)
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
