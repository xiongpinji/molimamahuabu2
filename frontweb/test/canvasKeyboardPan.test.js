import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANVAS_KEYBOARD_PAN_INITIAL_STEP,
  CANVAS_KEYBOARD_PAN_MAX_FRAME_MS,
  CANVAS_KEYBOARD_PAN_SPEED,
  canvasKeyboardPanDelta,
  canvasKeyboardPanVector,
  isCanvasKeyboardPanKey,
} from '../src/utils/canvasKeyboardPan.js'

test('WASD 与方向键映射为一致的画布方向', () => {
  assert.equal(isCanvasKeyboardPanKey('w'), true)
  assert.equal(isCanvasKeyboardPanKey('ArrowUp'), true)
  assert.equal(isCanvasKeyboardPanKey('Enter'), false)
  assert.deepEqual(canvasKeyboardPanVector(['w']), { x: 0, y: 1 })
  assert.deepEqual(canvasKeyboardPanVector(['ArrowLeft']), { x: 1, y: 0 })
  const diagonal = canvasKeyboardPanVector(['s', 'd'])
  assert.ok(Math.abs(diagonal.x + Math.SQRT1_2) < 0.000001)
  assert.ok(Math.abs(diagonal.y + Math.SQRT1_2) < 0.000001)
})

test('连续平移按时间计算并限制长帧跳跃', () => {
  assert.equal(CANVAS_KEYBOARD_PAN_SPEED, 2200)
  assert.equal(CANVAS_KEYBOARD_PAN_INITIAL_STEP, 56)
  assert.equal(CANVAS_KEYBOARD_PAN_MAX_FRAME_MS, 32)
  assert.deepEqual(canvasKeyboardPanDelta(['w'], 16), { x: 0, y: 35.2 })
  assert.deepEqual(canvasKeyboardPanDelta(['w'], 500), { x: 0, y: 70.4 })

  const diagonal = canvasKeyboardPanDelta(['w', 'd'], 1000)
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 70.4) < 0.000001)
})
