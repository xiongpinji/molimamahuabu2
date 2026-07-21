import test from 'node:test'
import assert from 'node:assert/strict'

import { isCanvasNodeBusyStatus } from '../src/utils/canvasNodeStatus.js'

test('画布节点 success 和 failed 状态不会被视为忙碌', () => {
  assert.equal(isCanvasNodeBusyStatus(null), false)
  assert.equal(isCanvasNodeBusyStatus({ step: 'success' }), false)
  assert.equal(isCanvasNodeBusyStatus({ step: 'failed' }), false)
})

test('画布节点生成中状态会被视为忙碌', () => {
  assert.equal(isCanvasNodeBusyStatus({ step: 'image' }), true)
  assert.equal(isCanvasNodeBusyStatus({ step: 'video' }), true)
  assert.equal(isCanvasNodeBusyStatus({ step: 'audio' }), true)
})
