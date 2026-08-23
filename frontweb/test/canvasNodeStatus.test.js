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
    resultSummary: '',
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
    actionError: '',
    retryAction: '',
    retryActionLabel: '',
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
      runKey: 'storyboard:301:video:20000',
      sourceNodeId: 'sb:301',
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
    resultSummary: '',
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
    actionError: '',
    retryAction: '',
    retryActionLabel: '',
    at: 20000,
    workflowId: 'wf-1',
    runKey: 'storyboard:301:video:20000',
    sourceNodeId: 'sb:301',
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
    resultSummary: '',
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
    actionError: '',
    retryAction: '',
    retryActionLabel: '',
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
    resultSummary: '',
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
    actionError: '',
    retryAction: '',
    retryActionLabel: '',
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

test('画布节点状态会保留上游引用结果用于覆盖层和重试恢复', () => {
  const store = createCanvasNodeStatusStore()
  store.set('sbvid:601', {
    step: 'video',
    message: '视频生成中',
    upstreamReferenceUrls: ['/static/a.png', ' ', '/static/a.png', '/static/b.mp4'],
    at: 50000,
  })

  assert.deepEqual(store.snapshot()['sbvid:601'].upstreamReferenceUrls, ['/static/a.png', '/static/b.mp4'])

  const restored = createCanvasNodeStatusStore()
  restored.restore(store.snapshot(), { now: 51000 })

  assert.deepEqual(restored.snapshot()['sbvid:601'].upstreamReferenceUrls, ['/static/a.png', '/static/b.mp4'])
})

test('画布节点状态会保留脚本提取结果摘要和实体引用', () => {
  const store = createCanvasNodeStatusStore()
  store.success('script:901', {
    message: '角色提取完成',
    resultType: 'text',
    resultSummary: '新增 2 个实体：角色:小狐狸、场景:雨林',
    resultReferences: ['@角色(小狐狸#1)', ' ', '@角色(小狐狸#1)', '@场景(雨林#2)'],
    autoClear: false,
    at: 80000,
  })

  const snapshot = store.snapshot()['script:901']
  assert.equal(snapshot.resultSummary, '新增 2 个实体：角色:小狐狸、场景:雨林')
  assert.deepEqual(snapshot.resultReferences, ['@角色(小狐狸#1)', '@场景(雨林#2)'])

  const restored = createCanvasNodeStatusStore()
  restored.restore(store.snapshot(), { now: 81000 })
  assert.equal(restored.snapshot()['script:901'].resultSummary, '新增 2 个实体：角色:小狐狸、场景:雨林')
  assert.deepEqual(restored.snapshot()['script:901'].resultReferences, ['@角色(小狐狸#1)', '@场景(雨林#2)'])
})

test('画布节点成功状态会保留结果操作失败和重试动作', () => {
  const store = createCanvasNodeStatusStore()
  store.success('sbimg:701', {
    message: '图片已生成',
    resultUrl: '/static/result.png',
    resultType: 'image',
    actionError: '设为首帧失败',
    retryAction: 'attach_image_first',
    retryActionLabel: '重试设为首帧',
    autoClear: false,
    at: 60000,
  })

  const snapshot = store.snapshot()['sbimg:701']
  assert.equal(snapshot.actionError, '设为首帧失败')
  assert.equal(snapshot.retryAction, 'attach_image_first')
  assert.equal(snapshot.retryActionLabel, '重试设为首帧')

  const restored = createCanvasNodeStatusStore()
  restored.restore(store.snapshot(), { now: 61000 })

  assert.equal(restored.snapshot()['sbimg:701'].actionError, '设为首帧失败')
  assert.equal(restored.snapshot()['sbimg:701'].retryAction, 'attach_image_first')
  assert.equal(restored.snapshot()['sbimg:701'].retryActionLabel, '重试设为首帧')
})

test('画布节点状态快照会保留真实请求审计和模型元数据', () => {
  const store = createCanvasNodeStatusStore()
  store.success('sbvid:801', {
    message: '视频已生成',
    resultUrl: '/static/video.mp4',
    resultType: 'video',
    dramaId: 12,
    storyboardId: 801,
    model: 'grok-imagine-video',
    videoGenerationId: 99,
    requestPayload: { prompt: '小狐狸穿过雨林', model: 'grok-imagine-video' },
    requestAudit: { voice_policy: { label: '小狐狸声线' } },
    autoClear: false,
    at: 70000,
  })

  const snapshot = store.snapshot()['sbvid:801']
  assert.equal(snapshot.dramaId, 12)
  assert.equal(snapshot.model, 'grok-imagine-video')
  assert.equal(snapshot.videoGenerationId, 99)
  assert.deepEqual(snapshot.requestPayload, { prompt: '小狐狸穿过雨林', model: 'grok-imagine-video' })
  assert.deepEqual(snapshot.requestAudit, { voice_policy: { label: '小狐狸声线' } })

  const restored = createCanvasNodeStatusStore()
  restored.restore(store.snapshot(), { now: 71000 })
  assert.equal(restored.snapshot()['sbvid:801'].model, 'grok-imagine-video')
  assert.deepEqual(restored.snapshot()['sbvid:801'].requestAudit, { voice_policy: { label: '小狐狸声线' } })
})

test('画布节点状态快照会保留素材挂载失败重试上下文', () => {
  const store = createCanvasNodeStatusStore()
  const libraryAsset = { id: 'asset-1', name: '首帧参考', type: 'image' }
  store.success('sbimg:802', {
    message: '图片已生成',
    resultUrl: '/static/result.png',
    resultType: 'image',
    actionError: '素材库首帧挂载失败',
    retryAction: 'attach_library_image',
    retryActionLabel: '重试设为首帧',
    attachedSlot: 'first',
    attachedToStoryboardId: 802,
    libraryAsset,
    autoClear: false,
    at: 72000,
  })

  const restored = createCanvasNodeStatusStore()
  restored.restore(store.snapshot(), { now: 73000 })
  const snapshot = restored.snapshot()['sbimg:802']
  assert.equal(snapshot.retryAction, 'attach_library_image')
  assert.equal(snapshot.attachedSlot, 'first')
  assert.equal(snapshot.attachedToStoryboardId, 802)
  assert.deepEqual(snapshot.libraryAsset, libraryAsset)
})
