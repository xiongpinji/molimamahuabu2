import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createHomeCanvasState,
  createHomeCanvasHistory,
  commitHomeCanvasHistory,
  hasDuplicateHomeCanvasEdge,
  normalizeHomeCanvasState,
  removeSelectedHomeCanvasElements,
  redoHomeCanvasHistory,
  serializeHomeCanvasState,
  undoHomeCanvasHistory,
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

test('首页画布边连接去重会区分句柄并支持排除当前边', () => {
  const edges = [
    { id: 'edge-a', source: 'a', target: 'b', sourceHandle: 'out-1', targetHandle: 'in-1' },
  ]

  assert.equal(hasDuplicateHomeCanvasEdge(edges, { source: 'a', target: 'b', sourceHandle: 'out-1', targetHandle: 'in-1' }), true)
  assert.equal(hasDuplicateHomeCanvasEdge(edges, { source: 'a', target: 'b', sourceHandle: 'out-2', targetHandle: 'in-1' }), false)
  assert.equal(hasDuplicateHomeCanvasEdge(edges, { id: 'edge-a', source: 'a', target: 'b', sourceHandle: 'out-1', targetHandle: 'in-1' }), false)
})

test('首页画布归一化会保留同端点的不同句柄边', () => {
  const state = normalizeHomeCanvasState({
    nodes: [
      { id: 'a', position: { x: 0, y: 0 }, data: { title: 'A' } },
      { id: 'b', position: { x: 100, y: 0 }, data: { title: 'B' } },
    ],
    edges: [
      { id: 'edge-1', source: 'a', target: 'b', sourceHandle: 'out-1', targetHandle: 'in-1' },
      { id: 'edge-2', source: 'a', target: 'b', sourceHandle: 'out-2', targetHandle: 'in-1' },
      { id: 'edge-duplicate', source: 'a', target: 'b', sourceHandle: 'out-1', targetHandle: 'in-1' },
    ],
  })

  assert.deepEqual(state.edges.map((edge) => edge.id), ['edge-1', 'edge-2'])
})

test('首页画布历史支持撤销和重做并清空重做分支', () => {
  const initial = createHomeCanvasState()
  const first = structuredClone(initial)
  first.nodes[0].data.title = '第一次编辑'
  const second = structuredClone(first)
  second.nodes[0].data.title = '第二次编辑'

  let history = createHomeCanvasHistory(initial)
  history = commitHomeCanvasHistory(history, initial, first)
  history = commitHomeCanvasHistory(history, first, second)
  assert.equal(history.present.nodes[0].data.title, '第二次编辑')

  history = undoHomeCanvasHistory(history)
  assert.equal(history.present.nodes[0].data.title, '第一次编辑')
  history = undoHomeCanvasHistory(history)
  assert.equal(history.present.nodes[0].data.title, '首页自由画布')
  history = redoHomeCanvasHistory(history)
  assert.equal(history.present.nodes[0].data.title, '第一次编辑')

  const branch = structuredClone(history.present)
  branch.nodes[0].data.title = '新分支'
  history = commitHomeCanvasHistory(history, history.present, branch)
  assert.equal(history.future.length, 0)
})

test('首页画布删除选中节点时会同步删除关联边并保留未关联内容', () => {
  const state = normalizeHomeCanvasState({
    nodes: [
      { id: 'a', position: { x: 0, y: 0 }, data: { title: 'A' } },
      { id: 'b', position: { x: 100, y: 0 }, selected: true, data: { title: 'B' } },
      { id: 'c', position: { x: 200, y: 0 }, data: { title: 'C' } },
    ],
    edges: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'bc', source: 'b', target: 'c' },
      { id: 'ac', source: 'a', target: 'c' },
    ],
  })

  const result = removeSelectedHomeCanvasElements(state)

  assert.deepEqual(result.nodes.map((node) => node.id), ['a', 'c'])
  assert.deepEqual(result.edges.map((edge) => edge.id), ['ac'])
})

test('首页画布历史会复制快照避免后续原地修改污染历史', () => {
  const initial = createHomeCanvasState()
  const next = structuredClone(initial)
  next.nodes[0].data.title = '已提交标题'

  let history = createHomeCanvasHistory(initial)
  history = commitHomeCanvasHistory(history, initial, next)
  next.nodes[0].data.title = '后续原地修改'

  assert.equal(history.present.nodes[0].data.title, '已提交标题')
  assert.equal(history.past[0].nodes[0].data.title, '首页自由画布')
})
