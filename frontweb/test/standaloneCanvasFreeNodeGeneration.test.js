import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFreeCanvasGenerationRequest,
  buildFreeCanvasProjectAssetPayload,
  collectDirectUpstreamImageReferences,
  collectDirectUpstreamResultUrls,
  collectDirectUpstreamTextInputs,
  normalizeFreeCanvasNode,
  normalizeFreeCanvasNodeData,
  resolveFreeCanvasResultUrl,
} from '../src/utils/freeCanvasGeneration.js'
import {
  buildCanvasLayoutPayload,
  resolveFreeCanvasNodes,
} from '../src/utils/canvasLayout.js'

test('normalizeFreeCanvasNodeData 保留生成字段并过滤非法 kind、数值和状态', () => {
  assert.equal(normalizeFreeCanvasNodeData({ kind: 'scene' }), null)
  assert.deepEqual(normalizeFreeCanvasNodeData({
    kind: 'video',
    title: '雨夜街道',
    content: '镜头向前推进',
    url: ' https://cdn.example/result.mp4 ',
    model: 'kling',
    aspectRatio: '9:16',
    duration: '8',
    style: 'cinematic',
    resolution: '1080p',
    quantity: '2',
    voiceId: 'female-shaonv',
    speechRate: '1.15',
    speechVolume: '1.2',
    speechPitch: '-2',
    speechEmotion: 'disgusted',
    pronunciationTones: [' 重庆/(chong2)(qing4) ', ''],
    cameraMovement: 'push-in',
    effect: 'film-grain',
    characterReferenceUrls: [' https://cdn.example/character.png ', ''],
    taskId: 42,
    status: 'success',
    error: ' ',
    savedAssetId: 99,
    assetSaveStatus: 'failed',
    assetSaveError: ' 入库失败 ',
  }), {
    kind: 'video',
    title: '雨夜街道',
    content: '镜头向前推进',
    url: 'https://cdn.example/result.mp4',
    model: 'kling',
    aspectRatio: '9:16',
    duration: 8,
    style: 'cinematic',
    resolution: '1080p',
    quantity: 2,
    voiceId: 'female-shaonv',
    speechRate: 1.15,
    speechVolume: 1.2,
    speechPitch: -2,
    speechEmotion: 'disgusted',
    pronunciationTones: ['重庆/(chong2)(qing4)'],
    cameraMovement: 'push-in',
    effect: 'film-grain',
    characterReferenceUrls: ['https://cdn.example/character.png'],
    taskId: '42',
    status: 'success',
    error: '',
    savedAssetId: '99',
    assetSaveStatus: 'failed',
    assetSaveError: '入库失败',
  })
  assert.deepEqual(normalizeFreeCanvasNodeData({
    kind: 'audio',
    duration: -1,
    status: 'done',
    assetSaveStatus: 'done',
  }), {
    kind: 'audio',
    title: '',
    content: '',
    url: '',
  })
})

test('自由节点生成请求按 kind 构造且不携带 storyboard_id', () => {
  const imagePayload = buildFreeCanvasGenerationRequest({
    kind: 'image',
    content: '一张雨夜街道',
    model: 'flux',
    aspectRatio: '16:9',
    style: 'cinematic',
    resolution: '2K',
    quantity: 2,
    negativePrompt: '模糊，低清晰度',
    characterReferenceUrls: ['https://cdn.example/character.png'],
  }, {
    dramaId: 7,
    upstreamUrls: ['https://cdn.example/a.png', '', 'https://cdn.example/a.png'],
  })
  assert.deepEqual(imagePayload, {
    drama_id: 7,
    prompt: '一张雨夜街道',
    model: 'flux',
    aspect_ratio: '16:9',
    style: 'cinematic',
    size: '2048x1152',
    negative_prompt: '模糊，低清晰度',
    reference_images: [
      'https://cdn.example/a.png',
      'https://cdn.example/character.png',
    ],
  })
  assert.equal('storyboard_id' in imagePayload, false)
  assert.equal('storyboardId' in imagePayload, false)

  const videoPayload = buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '镜头推近',
    model: 'kling',
    aspectRatio: '9:16',
    duration: 5,
    resolution: '1080p',
    quantity: 2,
    cameraMovement: 'push-in',
    effect: 'film-grain',
    includeAudio: true,
    characterReferenceUrls: ['https://cdn.example/character.png'],
  }, {
    dramaId: 7,
    upstreamUrls: ['https://cdn.example/first.png', 'https://cdn.example/ref.png'],
  })
  assert.deepEqual(videoPayload, {
    drama_id: 7,
    prompt: '镜头推近\n镜头运动：push-in\n视觉特效：film-grain\n音频要求：生成与画面同步的对白、环境音或音效。',
    model: 'kling',
    image_url: 'https://cdn.example/first.png',
    first_frame_url: 'https://cdn.example/first.png',
    reference_image_urls: [
      'https://cdn.example/first.png',
      'https://cdn.example/ref.png',
      'https://cdn.example/character.png',
    ],
    aspect_ratio: '9:16',
    duration: 5,
    resolution: '1080p',
  })

  const audioPayload = buildFreeCanvasGenerationRequest({
    kind: 'audio',
    content: '欢迎来到茉莉妈妈',
    model: 'cosyvoice',
    voiceId: 'female-shaonv',
    speechRate: 1.15,
    speechVolume: 1.2,
    speechPitch: -2,
    speechEmotion: 'disgusted',
    pronunciationTones: ['重庆/(chong2)(qing4)'],
  }, { dramaId: 7 })
  assert.deepEqual(audioPayload, {
    drama_id: 7,
    text: '欢迎来到茉莉妈妈',
    tts_model: 'cosyvoice',
    voice_id: 'female-shaonv',
    speed: 1.15,
    volume: 1.2,
    pitch: -2,
    emotion: 'disgusted',
    pronunciation_tones: ['重庆/(chong2)(qing4)'],
  })
  assert.equal('storyboard_id' in audioPayload, false)
})

test('文本连线内容按契约进入下游图片、视频和音频模型输入', () => {
  assert.equal(buildFreeCanvasGenerationRequest({
    kind: 'audio',
    content: '目标节点补充',
  }, {
    dramaId: 7,
    upstreamTexts: ['上游对白'],
  }).text, '上游对白\n\n目标节点补充')

  assert.equal(buildFreeCanvasGenerationRequest({
    kind: 'image',
    content: '电影光影',
  }, {
    dramaId: 7,
    upstreamTexts: ['雨夜车站'],
  }).prompt, '雨夜车站\n\n电影光影')
})

test('文本自由节点构造真实 AI 生成请求', () => {
  assert.deepEqual(buildFreeCanvasGenerationRequest({
    kind: 'text',
    content: '写一段雨夜车站的开场旁白',
    model: 'GPT-5.5',
  }, { dramaId: 7 }), {
    drama_id: 7,
    prompt: '写一段雨夜车站的开场旁白',
    model: 'GPT-5.5',
  })
})

test('自由节点图片、视频和音频请求强制要求正整数 dramaId', () => {
  const imageData = { kind: 'image', content: '一张图' }
  const videoData = { kind: 'video', content: '一段视频' }
  const audioData = { kind: 'audio', content: '一段对白' }
  for (const dramaId of [undefined, 0, 'abc']) {
    assert.throws(
      () => buildFreeCanvasGenerationRequest(imageData, { dramaId }),
      /自由节点生成缺少有效项目 ID/
    )
    assert.throws(
      () => buildFreeCanvasGenerationRequest(videoData, { dramaId }),
      /自由节点生成缺少有效项目 ID/
    )
    assert.throws(
      () => buildFreeCanvasGenerationRequest(audioData, { dramaId }),
      /自由节点生成缺少有效项目 ID/
    )
  }
})

test('collectDirectUpstreamResultUrls 只收集直接手动上游真实结果 URL 并去重', () => {
  const nodes = [
    { id: 'a', data: { kind: 'image', url: 'https://cdn.example/a.png' } },
    { id: 'b', data: { kind: 'image', url: 'https://cdn.example/a.png' } },
    { id: 'c', data: { kind: 'image', url: '' } },
    { id: 'd', data: { kind: 'video', url: 'https://cdn.example/d.mp4' } },
  ]
  const edges = [
    { id: 'auto:a:d', source: 'a', target: 'd' },
    { id: 'manual:a:d', source: 'a', target: 'd', data: { manual: true } },
    { id: 'manual:b:d', source: 'b', target: 'd', data: { manual: true } },
    { id: 'manual:c:d', source: 'c', target: 'd', data: { manual: true } },
  ]

  assert.deepEqual(collectDirectUpstreamResultUrls(nodes, edges, 'd'), ['https://cdn.example/a.png'])
})

test('collectDirectUpstreamImageReferences 同时呈现已就绪和等待生成的图片连线', () => {
  const nodes = [
    { id: 'image-ready', data: { kind: 'image', title: '首帧', url: '/static/first.png' } },
    { id: 'image-pending', data: { kind: 'image', title: '尾帧', url: '' } },
    { id: 'audio', data: { kind: 'audio', title: '旁白', url: '/static/voice.mp3' } },
    { id: 'video', data: { kind: 'video', title: '视频' } },
  ]
  const edges = [
    { id: 'manual:ready', source: 'image-ready', target: 'video', data: { manual: true } },
    { id: 'manual:pending', source: 'image-pending', target: 'video', data: { manual: true } },
    { id: 'manual:audio', source: 'audio', target: 'video', data: { manual: true } },
  ]

  assert.deepEqual(collectDirectUpstreamImageReferences(nodes, edges, 'video'), [
    { nodeId: 'image-ready', edgeId: 'manual:ready', title: '首帧', url: '/static/first.png', ready: true, slot: 'reference-image', enabled: true, order: 0, weight: 1 },
    { nodeId: 'image-pending', edgeId: 'manual:pending', title: '尾帧', url: '', ready: false, slot: 'reference-image', enabled: true, order: 1, weight: 1 },
  ])
})

test('collectDirectUpstreamTextInputs 只按手动直连契约收集文本输入并去重', () => {
  const nodes = [
    { id: 'text-a', data: { kind: 'text', content: '上游对白' } },
    { id: 'image-a', data: { kind: 'image', content: '不是文本输入' } },
  ]
  const edges = [
    { id: 'manual:text-a:video', source: 'text-a', target: 'video', data: { manual: true } },
    { id: 'manual:text-a:video-copy', source: 'text-a', target: 'video', data: { manual: true } },
    { id: 'manual:image-a:video', source: 'image-a', target: 'video', data: { manual: true } },
    { id: 'auto:text-a:other', source: 'text-a', target: 'other' },
  ]

  assert.deepEqual(collectDirectUpstreamTextInputs(nodes, edges, 'video'), ['上游对白'])
})

test('buildFreeCanvasProjectAssetPayload 生成 canvas-result 素材入库 payload', () => {
  const requestPayload = { drama_id: 7, prompt: '画面' }
  assert.deepEqual(buildFreeCanvasProjectAssetPayload({
    dramaId: 7,
    nodeId: 'free:image:1',
    taskId: 'task-1',
    model: 'flux',
    name: '雨夜站台',
    type: 'image',
    url: 'https://cdn.example/image.png',
    requestPayload,
  }), {
    drama_id: 7,
    storyboard_id: null,
    name: '雨夜站台',
    category: 'canvas-result',
    type: 'image',
    url: 'https://cdn.example/image.png',
    metadata: {
      canvas_node_id: 'free:image:1',
      task_id: 'task-1',
      model: 'flux',
      request_payload: requestPayload,
    },
  })
})

test('buildFreeCanvasProjectAssetPayload 强制要求正整数 dramaId', () => {
  for (const dramaId of [undefined, 0, 'abc']) {
    assert.throws(
      () => buildFreeCanvasProjectAssetPayload({
        dramaId,
        nodeId: 'free:image:1',
        taskId: 'task-1',
        model: 'flux',
        type: 'image',
        url: 'https://cdn.example/image.png',
        requestPayload: { prompt: '画面' },
      }),
      /自由节点素材入库缺少有效项目 ID/
    )
  }
})

test('resolveFreeCanvasResultUrl 兼容图片、视频任务/记录和同步音频结果', () => {
  assert.equal(resolveFreeCanvasResultUrl('image', null), '')
  assert.equal(resolveFreeCanvasResultUrl('video', null), '')
  assert.equal(resolveFreeCanvasResultUrl('audio', null), '')
  assert.equal(resolveFreeCanvasResultUrl('image', {
    result: { image_url: 'https://cdn.example/image.png' },
  }), 'https://cdn.example/image.png')
  assert.equal(resolveFreeCanvasResultUrl('video', {
    result: { video_url: '' },
    video: { local_path: 'videos/out.mp4' },
  }), '/static/videos/out.mp4')
  assert.equal(resolveFreeCanvasResultUrl('video', {
    result: {
      video_url: 'https://provider.example/protected-download',
      local_path: 'videos/local-out.mp4',
    },
  }), '/static/videos/local-out.mp4')
  assert.equal(resolveFreeCanvasResultUrl('audio', {
    url: 'https://cdn.example/audio.mp3',
  }), 'https://cdn.example/audio.mp3')
})

test('canvasLayout 使用标准化函数保存和恢复自由节点生成字段', () => {
  const node = normalizeFreeCanvasNode({
    id: 'free:video:1',
    type: 'homeCanvasNode',
    position: { x: 10, y: 20 },
    data: {
      kind: 'video',
      title: '雨夜街道',
      content: '镜头向前推进',
      url: 'https://cdn.example/result.mp4',
      model: 'kling',
      aspectRatio: '9:16',
      duration: 5,
      taskId: 'task-1',
      status: 'running',
      error: '',
      savedAssetId: 'asset-1',
      assetSaveStatus: 'failed',
      assetSaveError: '入库失败',
    },
  })
  const layout = buildCanvasLayoutPayload(
    [node],
    { x: 0, y: 0, zoom: 1 },
    null,
    [],
    { persistFreeNodes: true }
  )

  assert.deepEqual(resolveFreeCanvasNodes(layout), [node])
})
