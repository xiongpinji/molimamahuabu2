import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createHomeCanvasState,
  normalizeHomeCanvasState,
  serializeHomeCanvasState,
} from '../src/utils/homeCanvasState.js'

test('首页画布默认状态不包含项目标识', () => {
  const state = createHomeCanvasState()
  assert.equal(state.version, 1)
  assert.ok(state.nodes.length > 0)
  assert.equal(state.nodes[0].type, 'homeCanvasNode')
  assert.equal(Object.hasOwn(state, 'dramaId'), false)
})

test('首页画布状态会丢弃非法节点并补齐视口', () => {
  const state = normalizeHomeCanvasState({
    nodes: [null, { id: 'n1', position: { x: 12 }, data: { kind: 'unknown', title: 7 } }],
    edges: 'invalid',
    viewport: { x: 'bad', zoom: -1 },
  })
  assert.equal(state.nodes.length, 1)
  assert.deepEqual(state.nodes[0].position, { x: 12, y: 0 })
  assert.equal(state.nodes[0].data.kind, 'text')
  assert.equal(state.viewport.x, 0)
  assert.equal(state.viewport.zoom, 0.75)
  assert.deepEqual(state.edges, [])
})

test('首页画布状态可以序列化后恢复', () => {
  const original = createHomeCanvasState()
  original.nodes.push({
    id: 'home:text:1',
    type: 'homeCanvasNode',
    position: { x: 100, y: 80 },
    data: { kind: 'text', title: '镜头一', content: '开场' },
  })
  const restored = normalizeHomeCanvasState(serializeHomeCanvasState(original))
  assert.equal(restored.nodes.at(-1).data.title, '镜头一')
  assert.deepEqual(restored.nodes.at(-1).position, { x: 100, y: 80 })
})

test('首页画布只恢复连接现有节点的有效边并去重', () => {
  const state = normalizeHomeCanvasState({
    nodes: [
      { id: 'a', position: { x: 0, y: 0 }, data: { kind: 'text', title: 'A' } },
      { id: 'b', position: { x: 100, y: 0 }, data: { kind: 'text', title: 'B' } },
    ],
    edges: [
      { id: 'edge-1', source: 'a', target: 'b' },
      { id: 'edge-duplicate', source: 'a', target: 'b' },
      { id: 'self', source: 'a', target: 'a' },
      { id: 'missing', source: 'a', target: 'unknown' },
      null,
    ],
  })
  assert.equal(state.edges.length, 1)
  assert.equal(state.edges[0].id, 'edge-1')
  assert.equal(state.edges[0].type, 'smoothstep')
})
