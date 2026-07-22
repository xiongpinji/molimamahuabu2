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
      promptText: '雨林中的小狐狸',
      errorDetail: '',
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
    resultNodeId: '',
    resultType: 'image',
    resultLabel: '',
    savedAssetId: '',
    savedAssetName: '',
    savedAssetUrl: '',
    savedAssetLocalPath: '',
    savedAssetDuration: null,
    promptText: '雨林中的小狐狸',
    errorDetail: '',
    nextStep: 'video',
    nextLabel: '',
    retryStep: 'image',
    retryLabel: '重试生图',
    at: 12345,
    restored: true,
  })
})

test('画布节点状态恢复会保留队列元数据', () => {
  const store = createCanvasNodeStatusStore()
  store.restore({
    'workflow:301': {
      step: 'workflow',
      message: '工作流执行中',
      workflowId: 'wf-1',
      queueLabel: '镜头 1-3',
      storyboardId: 301,
      stepIndex: 2,
      stepTotal: 4,
      at: 20000,
    },
  }, { now: 25000 })

  assert.deepEqual(store.snapshot()['workflow:301'], {
    step: 'workflow',
    message: '工作流执行中',
    detail: '',
    taskId: '',
    progress: null,
    resultUrl: '',
    resultNodeId: '',
    resultType: '',
    resultLabel: '',
    savedAssetId: '',
    savedAssetName: '',
    savedAssetUrl: '',
    savedAssetLocalPath: '',
    savedAssetDuration: null,
    promptText: '',
    errorDetail: '',
    nextStep: '',
    nextLabel: '',
    retryStep: '',
    retryLabel: '',
    at: 20000,
    workflowId: 'wf-1',
    queueLabel: '镜头 1-3',
    storyboardId: 301,
    stepIndex: 2,
    stepTotal: 4,
    restored: true,
  })
})

test('画布节点恢复过期运行态会转为可重试失败态', () => {
  const store = createCanvasNodeStatusStore()
  store.restore({
    'sbvideo:302': {
      step: 'video',
      message: '视频生成中',
      at: 1000,
    },
  }, { now: 31 * 60 * 1000 + 1000, staleMs: 30 * 60 * 1000 })

  assert.deepEqual(store.snapshot()['sbvideo:302'], {
    step: 'failed',
    message: '节点任务已中断，可重试',
    detail: '',
    taskId: '',
    progress: null,
    resultUrl: '',
    resultNodeId: '',
    resultType: '',
    resultLabel: '',
    savedAssetId: '',
    savedAssetName: '',
    savedAssetUrl: '',
    savedAssetLocalPath: '',
    savedAssetDuration: null,
    promptText: '',
    errorDetail: '页面刷新或任务超时导致运行状态中断，请点击重试继续。',
    nextStep: '',
    nextLabel: '',
    retryStep: 'video',
    retryLabel: '重试生视频中',
    at: 1000,
    recoverable: true,
    restored: true,
    stale: true,
  })
})

test('画布节点状态快照可恢复已保存素材引用', () => {
  const store = createCanvasNodeStatusStore()
  store.success('sbvid:401', {
    message: '视频已生成',
    resultUrl: '/static/video.mp4',
    resultNodeId: '',
    resultType: 'video',
    savedAssetId: 77,
    savedAssetName: '镜头视频',
    savedAssetUrl: '/static/video.mp4',
    savedAssetLocalPath: 'video.mp4',
    savedAssetDuration: 5,
    autoClear: false,
    at: 30000,
  })

  assert.deepEqual(store.snapshot()['sbvid:401'], {
    step: 'success',
    message: '视频已生成',
    detail: '',
    taskId: '',
    progress: null,
    resultUrl: '/static/video.mp4',
    resultNodeId: '',
    resultType: 'video',
    resultLabel: '',
    savedAssetId: 77,
    savedAssetName: '镜头视频',
    savedAssetUrl: '/static/video.mp4',
    savedAssetLocalPath: 'video.mp4',
    savedAssetDuration: 5,
    promptText: '',
    errorDetail: '',
    nextStep: '',
    nextLabel: '',
    retryStep: '',
    retryLabel: '',
    at: 30000,
  })
})

test('画布节点状态快照可恢复结果节点定位', () => {
  const store = createCanvasNodeStatusStore()
  store.success('sb:501', {
    message: '尾帧已生成',
    resultUrl: '/static/last.png',
    resultNodeId: 'sbimg-last:501',
    resultType: 'image',
    autoClear: false,
    at: 40000,
  })

  assert.equal(store.snapshot()['sb:501'].resultNodeId, 'sbimg-last:501')
})
