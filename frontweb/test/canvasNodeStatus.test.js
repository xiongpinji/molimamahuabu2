import test from 'node:test'
import assert from 'node:assert/strict'

import { createCanvasNodeStatusStore } from '../src/composables/useCanvasNodeStatus.js'
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

test('画布节点状态快照可恢复结果和耗时', () => {
  const store = createCanvasNodeStatusStore()
  store.restore({
    'sbimg:301': {
      step: 'success',
      message: '图片已生成',
      resultUrl: '/static/image.png',
      resultType: 'image',
      nextStep: 'video',
      retryStep: 'image',
      retryLabel: '重试生图',
      at: 12345,
    },
  })

  assert.deepEqual(store.snapshot()['sbimg:301'], {
    step: 'success',
    message: '图片已生成',
    detail: '',
    taskId: '',
    progress: null,
    resultUrl: '/static/image.png',
    resultType: 'image',
    resultLabel: '',
    nextStep: 'video',
    nextLabel: '',
    retryStep: 'image',
    retryLabel: '重试生图',
    at: 12345,
  })
})
