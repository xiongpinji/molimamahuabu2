import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canAlignCanvasNodes,
  computeStandaloneAutoLayoutPositions,
  computeStandaloneNodePosition,
} from '../src/utils/canvasStandaloneLayout.js'

test('独立画布无需剧集项目也可以执行整理', () => {
  assert.equal(canAlignCanvasNodes({
    standalone: true,
    hasDrama: false,
    nodeCount: 3,
    aligning: false,
  }), true)
  assert.equal(canAlignCanvasNodes({
    standalone: false,
    hasDrama: false,
    nodeCount: 3,
    aligning: false,
  }), false)
})

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

test('大量远处节点不会把新节点推离当前视口中心', () => {
  const center = { x: 800, y: 480 }
  const distantNodes = Array.from({ length: 67 }, (_, index) => ({
    id: `free:image:${index}`,
    type: 'homeCanvasNode',
    position: { x: -20000 + index * 10, y: -20000 },
  }))

  assert.deepEqual(computeStandaloneNodePosition(distantNodes, center), center)
})

test('偏移节点阻挡多个候选时继续寻找最近空位', () => {
  const center = { x: 0, y: 0 }
  const nodes = [
    { id: 'free:image:1', type: 'homeCanvasNode', position: { x: 340, y: 0 } },
    { id: 'free:image:2', type: 'homeCanvasNode', position: { x: 1020, y: 0 } },
  ]
  const position = computeStandaloneNodePosition(nodes, center)
  const collides = nodes.some((node) => (
    Math.abs(Number(node.position.x || 0) - position.x) < 680
    && Math.abs(Number(node.position.y || 0) - position.y) < 460
  ))

  assert.equal(collides, false)
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
