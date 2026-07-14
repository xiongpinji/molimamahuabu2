import test from 'node:test'
import assert from 'node:assert/strict'

import { getCanvasNodeSize, virtualizeCanvasGraph } from '../src/utils/canvasVirtualization.js'

function makeNodes(count = 80) {
  return Array.from({ length: count }, (_, index) => ({
    id: `sb:${index + 1}`,
    type: 'canvasStoryboard',
    position: { x: 0, y: index * 300 },
  }))
}

test('多集画布只渲染视口附近节点并保留连线两端', () => {
  const nodes = makeNodes()
  const edges = [
    { id: 'near', source: 'sb:1', target: 'sb:2' },
    { id: 'far', source: 'sb:1', target: 'sb:80' },
  ]
  const result = virtualizeCanvasGraph(
    nodes,
    edges,
    { x: 0, y: 0, zoom: 1 },
    { width: 800, height: 620 },
    { overscan: 0 },
  )

  assert.equal(result.virtualized, true)
  assert.equal(result.nodes.length < nodes.length, true)
  assert.deepEqual(result.edges.map((edge) => edge.id), ['near'])
  assert.equal(result.hiddenNodeCount > 0, true)
})

test('已选或聚焦节点即使在视口外也保持可交互', () => {
  const nodes = makeNodes()
  nodes[79].selected = true
  const result = virtualizeCanvasGraph(
    nodes,
    [],
    { x: 0, y: 0, zoom: 1 },
    { width: 800, height: 620 },
    { overscan: 0, pinnedIds: ['sb:79'] },
  )

  assert.equal(result.visibleIds.has('sb:80'), true)
})

test('节点数量较少或容器尺寸未知时不裁剪，避免初次挂载丢节点', () => {
  const nodes = makeNodes(2)
  const result = virtualizeCanvasGraph(nodes, [], { x: 0, y: 0, zoom: 1 }, null)
  assert.equal(result.virtualized, false)
  assert.equal(result.nodes.length, 2)
})

test('优先使用 Vue Flow 已测量尺寸', () => {
  assert.deepEqual(getCanvasNodeSize({
    type: 'canvasStoryboard',
    position: { x: 0, y: 0 },
    measured: { width: 300, height: 240 },
  }), { width: 300, height: 240 })
})
