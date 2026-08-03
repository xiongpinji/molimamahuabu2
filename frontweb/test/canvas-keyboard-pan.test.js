import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANVAS_KEYBOARD_PAN_SPEED,
  calculateCanvasKeyboardPanDelta,
} from '../src/utils/canvas-keyboard-pan.js'

test('WASD 按画布视角方向生成逐帧位移', () => {
  assert.deepEqual(calculateCanvasKeyboardPanDelta(new Set(['w']), 20), { x: 0, y: 10.4 })
  assert.deepEqual(calculateCanvasKeyboardPanDelta(new Set(['a']), 20), { x: 10.4, y: 0 })
  assert.deepEqual(calculateCanvasKeyboardPanDelta(new Set(['s']), 20), { x: 0, y: -10.4 })
  assert.deepEqual(calculateCanvasKeyboardPanDelta(new Set(['d']), 20), { x: -10.4, y: 0 })
})

test('对角平移保持与单方向相同的速度', () => {
  const delta = calculateCanvasKeyboardPanDelta(new Set(['w', 'd']), 20)
  assert.ok(Math.abs(Math.hypot(delta.x, delta.y) - (CANVAS_KEYBOARD_PAN_SPEED * 0.02)) < 1e-9)
})

test('相反方向抵消，长帧时间被限幅', () => {
  assert.deepEqual(calculateCanvasKeyboardPanDelta(new Set(['w', 's']), 20), { x: 0, y: 0 })
  assert.deepEqual(calculateCanvasKeyboardPanDelta(new Set(['d']), 1000), { x: -16.64, y: 0 })
})
