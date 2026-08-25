import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  buildCanvasLayoutPayload,
  normalizeManualCanvasEdges,
} from '../src/utils/canvasLayout.js'
import { cloneSingleCanvasNodeWithIncidentEdges } from '../src/utils/canvasDuplicate.js'

const adapterSource = readFileSync(
  fileURLToPath(new URL('../src/utils/dramaCanvasAdapter.js', import.meta.url)),
  'utf8'
)

test('normalizeManualCanvasEdges 仅保留手动连线并按连接去重', () => {
  const edges = normalizeManualCanvasEdges([
    { id: 'auto:1', source: 'a', target: 'b' },
    { id: 'manual:a:b', source: 'a', target: 'b', data: { manual: true } },
    { id: 'manual:a:b:duplicate', source: 'a', target: 'b', data: { manual: true } },
    { id: 'manual:b:c', source: 'b', target: 'c', sourceHandle: 'out', targetHandle: 'in' },
    { id: 'manual:broken', source: 'b' },
  ])

  assert.deepEqual(edges, [
    {
      id: 'manual:a:b',
      source: 'a',
      target: 'b',
      sourceHandle: null,
      targetHandle: null,
      type: 'smoothstep',
      data: { manual: true },
    },
    {
      id: 'manual:b:c',
      source: 'b',
      target: 'c',
      sourceHandle: 'out',
      targetHandle: 'in',
      type: 'smoothstep',
      data: { manual: true },
    },
  ])
})

test('buildCanvasLayoutPayload 写入节点位置、视口和手动连线', () => {
  const payload = buildCanvasLayoutPayload(
    [
      { id: 'a', type: 'canvasStoryboard', position: { x: 10, y: 20 } },
      { id: 'label', type: 'canvasLabel', position: { x: 99, y: 99 } },
    ],
    { x: 1, y: 2, zoom: 0.8 },
    { nodes: { old: { x: 3, y: 4 } } },
    [
      { id: 'e-auto', source: 'old', target: 'a' },
      { id: 'manual:old:a', source: 'old', target: 'a', data: { manual: true } },
    ]
  )

  assert.equal(payload.version, 1)
  assert.deepEqual(payload.viewport, { x: 1, y: 2, zoom: 0.8 })
  assert.deepEqual(payload.nodes.old, { x: 3, y: 4 })
  assert.deepEqual(payload.nodes.a, { x: 10, y: 20 })
  assert.equal(payload.nodes.label, undefined)
  assert.deepEqual(payload.manual_edges, [
    {
      id: 'manual:old:a',
      source: 'old',
      target: 'a',
      sourceHandle: null,
      targetHandle: null,
      type: 'smoothstep',
      data: { manual: true },
    },
  ])
})

test('剪线抑制列表可持久化且自定义边不会污染手动连线类型', () => {
  const payload = buildCanvasLayoutPayload(
    [],
    {},
    null,
    [{
      id: 'manual:a:b',
      source: 'a',
      target: 'b',
      type: 'cuttable',
      data: { manual: true, lineType: 'smoothstep' },
    }],
    { suppressedEdgeIds: ['auto:b:c', 'auto:b:c'] },
  )

  assert.equal(payload.manual_edges[0].type, 'smoothstep')
  assert.deepEqual(payload.manual_edges[0].data, { manual: true })
  assert.deepEqual(payload.suppressed_edge_ids, ['auto:b:c'])
})

test('buildDramaCanvasGraph 合并 canvas_layout 手动连线且过滤无效节点', () => {
  assert.match(adapterSource, /import \{ normalizeManualCanvasEdges, parseCanvasLayout, resolveFreeCanvasNodes, resolveNodePosition \} from '\.\/canvasLayout'/)
  assert.match(adapterSource, /function appendManualEdges\(edges, savedLayout, nodes\)/)
  assert.match(adapterSource, /const nodeIds = new Set\(nodes\.map\(\(node\) => String\(node\.id\)\)\)/)
  assert.match(adapterSource, /if \(!nodeIds\.has\(edge\.source\) \|\| !nodeIds\.has\(edge\.target\)\) continue/)
  assert.match(adapterSource, /for \(const edge of normalizeManualCanvasEdges\(savedLayout\?\.manual_edges\)\)/)
  assert.match(adapterSource, /data: \{ \.\.\.\(edge\.data \|\| \{\}\), manual: true \}/)
  assert.match(adapterSource, /appendManualEdges\(edges, savedLayout, nodes\)/)
})

test('副本生成的手动连线可写入 canvas_layout manual_edges', () => {
  const { edges } = cloneSingleCanvasNodeWithIncidentEdges({
    sourceNode: { id: 'image-1' },
    edges: [
      { id: 'manual:text:image', source: 'text-1', target: 'image-1', data: { manual: true } },
      { id: 'manual:image:video', source: 'image-1', target: 'video-1', data: { manual: true } },
    ],
    nextNodeId: 'image-2',
    nextEdgeId: (edge) => `copy:${edge.id}`,
  })
  const payload = buildCanvasLayoutPayload(
    [
      { id: 'text-1', type: 'homeCanvasNode', position: { x: 0, y: 0 } },
      { id: 'image-1', type: 'homeCanvasNode', position: { x: 100, y: 0 } },
      { id: 'image-2', type: 'homeCanvasNode', position: { x: 140, y: 40 } },
      { id: 'video-1', type: 'homeCanvasNode', position: { x: 200, y: 0 } },
    ],
    {},
    null,
    edges,
    { persistFreeNodes: true },
  )

  assert.deepEqual(payload.manual_edges.map((edge) => [edge.id, edge.source, edge.target]), [
    ['copy:manual:text:image', 'text-1', 'image-2'],
    ['copy:manual:image:video', 'image-2', 'video-1'],
  ])
})
