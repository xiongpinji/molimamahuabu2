import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeStandaloneAutoLayoutPositions,
  computeStandaloneNodePosition,
} from '../src/utils/canvasStandaloneLayout.js'

test('连续从顶栏添加独立画布节点时不会重叠在同一坐标', () => {
  const center = { x: 800, y: 480 }
  const first = computeStandaloneNodePosition([], center)
  const second = computeStandaloneNodePosition([
    { id: 'free:text:1', type: 'homeCanvasNode', position: first },
  ], center)
  const third = computeStandaloneNodePosition([
    { id: 'free:text:1', type: 'homeCanvasNode', position: first },
    { id: 'free:image:2', type: 'homeCanvasNode', position: second },
  ], center)

  assert.deepEqual(first, center)
  assert.notDeepEqual(second, first)
  assert.notDeepEqual(third, first)
  assert.notDeepEqual(third, second)
})

test('独立画布整理会为自由节点和打组节点生成互不重叠的网格坐标', () => {
  const nodes = [
    { id: 'free:text:1', type: 'homeCanvasNode' },
    { id: 'free:image:2', type: 'homeCanvasNode' },
    { id: 'free:video:3', type: 'homeCanvasNode' },
    { id: 'group:1', type: 'canvasGroup' },
  ]
  const positions = computeStandaloneAutoLayoutPositions(nodes)

  assert.deepEqual(Object.keys(positions).sort(), nodes.map((node) => node.id).sort())
  assert.equal(new Set(Object.values(positions).map(({ x, y }) => `${x}:${y}`)).size, nodes.length)
})
