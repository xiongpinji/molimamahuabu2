import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFreeCanvasReferenceMentionCandidates,
  buildFreeCanvasGenerationRequest,
  buildFreeCanvasProjectAssetPayload,
  collectDirectUpstreamImageReferences,
  collectDirectUpstreamMediaReferences,
  collectDirectUpstreamResultUrls,
  collectDirectUpstreamTextInputs,
  getFreeCanvasNodeResultUrl,
  normalizeFreeCanvasSubmissionReferences,
  normalizeFreeCanvasNode,
  normalizeFreeCanvasNodeData,
  normalizeFreeCanvasVideoReferenceMode,
  planFreeCanvasVideoReferences,
  pollFreeCanvasTask,
  resolveFreeCanvasVideoReferenceInput,
  resolveFreeCanvasResultUrl,
} from '../src/utils/freeCanvasGeneration.js'
import * as freeCanvasGeneration from '../src/utils/freeCanvasGeneration.js'
import {
  buildCanvasLayoutPayload,
  resolveFreeCanvasNodes,
} from '../src/utils/canvasLayout.js'
import {
  canvasModelEntry,
  canvasModelOptions,
  normalizeCanvasModelCatalog,
} from '../src/utils/canvasModelCapabilities.js'

test('支持同步音频的视频模型默认开启声音且无声提交必须二次确认', () => {
  assert.equal(typeof freeCanvasGeneration.defaultFreeCanvasVideoIncludeAudio, 'function')
  assert.equal(typeof freeCanvasGeneration.resolveFreeCanvasVideoIncludeAudio, 'function')
  assert.equal(typeof freeCanvasGeneration.requiresSilentVideoConfirmation, 'function')
  assert.equal(freeCanvasGeneration.defaultFreeCanvasVideoIncludeAudio({ supportsAudio: true }), true)
  assert.equal(freeCanvasGeneration.defaultFreeCanvasVideoIncludeAudio({ supportsAudio: false }), false)
  assert.equal(freeCanvasGeneration.requiresSilentVideoConfirmation({
    kind: 'video', includeAudio: false,
  }, { supportsAudio: true }), true)
  assert.equal(freeCanvasGeneration.requiresSilentVideoConfirmation({
    kind: 'video', includeAudio: true,
  }, { supportsAudio: true }), false)
  assert.equal(freeCanvasGeneration.requiresSilentVideoConfirmation({
    kind: 'image', includeAudio: false,
  }, { supportsAudio: true }), false)
  assert.equal(freeCanvasGeneration.resolveFreeCanvasVideoIncludeAudio({
    kind: 'video',
  }, { supportsAudio: true }), true)
  assert.equal(freeCanvasGeneration.resolveFreeCanvasVideoIncludeAudio({
    kind: 'video', includeAudio: false,
  }, { supportsAudio: true }), false)
  assert.equal(freeCanvasGeneration.requiresSilentVideoConfirmation({
    kind: 'video',
  }, { supportsAudio: true }), false)
})

test('自由节点任务轮询容忍瞬时断网并继续查询同一 task_id', async () => {
  const calls = []
  const task = await pollFreeCanvasTask('task-video-1', {
    maxAttempts: 3,
    intervalMs: 0,
    sleep: async () => {},
    getTask: async (taskId) => {
      calls.push(taskId)
      if (calls.length === 1) throw new Error('Network Error')
      if (calls.length === 2) return { status: 'processing', progress: 40 }
      return { status: 'completed', result: { video_url: 'https://cdn.example/result.mp4' } }
    },
  })

  assert.equal(task.status, 'completed')
  assert.deepEqual(calls, ['task-video-1', 'task-video-1', 'task-video-1'])
})

test('自由节点查询中断时保留已提交状态并明确禁止重复提交', async () => {
  let calls = 0
  await assert.rejects(
    pollFreeCanvasTask('task-video-2', {
      maxAttempts: 2,
      intervalMs: 0,
      sleep: async () => {},
      getTask: async () => {
        calls += 1
        throw new Error('Network Error')
      },
    }),
    (error) => error.code === 'FREE_CANVAS_TASK_STATUS_UNAVAILABLE'
      && /任务已提交/.test(error.message)
      && /不要重复提交/.test(error.message),
  )
  assert.equal(calls, 2)
})

test('自由节点 needs_attention 状态直接提示禁止重复提交', async () => {
  await assert.rejects(
    pollFreeCanvasTask('task-video-3', {
      maxAttempts: 1,
      intervalMs: 0,
      sleep: async () => {},
      getTask: async () => ({
        status: 'needs_attention',
        error: '供应商提交结果未知，请勿重复提交',
      }),
    }),
    (error) => error.code === 'FREE_CANVAS_TASK_NEEDS_ATTENTION'
      && /请勿重复提交/.test(error.message),
  )
})

test('参考图 @ 候选按连线顺序生成图片1、图片2、图片3及同序号 token', () => {
  const candidates = buildFreeCanvasReferenceMentionCandidates([
    { nodeId: 'image-a', title: '角色图', url: '/a.png', ready: true, enabled: true },
    { nodeId: 'image-b', title: '场景图', url: '/b.png', ready: true, enabled: true },
    { nodeId: 'image-c', title: '道具图', url: '/c.png', ready: true, enabled: true },
  ])

  assert.deepEqual(candidates.map(({ label, mentionToken }) => ({ label, mentionToken })), [
    { label: '图片1', mentionToken: '@图片1' },
    { label: '图片2', mentionToken: '@图片2' },
    { label: '图片3', mentionToken: '@图片3' },
  ])
})

test('未就绪参考图不会让后续 @ 候选序号与卡片序号错位', () => {
  const candidates = buildFreeCanvasReferenceMentionCandidates([
    { nodeId: 'image-pending', title: '待生成', url: '', ready: false, enabled: true },
    { nodeId: 'image-ready', title: '已生成', url: '/ready.png', ready: true, enabled: true },
  ])

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].label, '图片2')
  assert.equal(candidates[0].mentionToken, '@图片2')
})

test('MiniMax H3 只采用前三张参考图且未采用素材不生成 @图片 token', () => {
  const references = Array.from({ length: 4 }, (_, index) => ({
    nodeId: `image-${index + 1}`,
    kind: 'image',
    title: `参考图 ${index + 1}`,
    url: `/static/reference-${index + 1}.png`,
    ready: true,
    enabled: true,
    order: index,
  }))
  const capability = {
    declared: true,
    referenceTypes: ['image', 'audio'],
    maxImageReferences: 3,
    maxAudioReferences: 3,
    maxVideoReferences: 0,
    supportsImageReference: true,
    supportsAudioReference: true,
    supportsVideoReference: false,
  }
  const planned = planFreeCanvasVideoReferences(capability, 'omni', references)
  assert.deepEqual(planned.map(({ enabled }) => enabled), [true, true, true, false])

  const adopted = planned.filter(({ enabled }) => enabled).map(({ reference }) => reference)
  assert.deepEqual(
    buildFreeCanvasReferenceMentionCandidates(adopted).map(({ mentionToken }) => mentionToken),
    ['@图片1', '@图片2', '@图片3'],
  )
  assert.deepEqual(buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '只使用已采用的三张参考图',
    model: 'MiniMax H3',
    videoReferenceMode: 'omni',
    aspectRatio: '16:9',
    duration: 15,
    resolution: '1440p',
  }, { dramaId: 7, upstreamReferences: references, capability }).reference_image_urls, [
    '/static/reference-1.png',
    '/static/reference-2.png',
    '/static/reference-3.png',
  ])
})

test('国内 Seedance FAST 和 MINI 按 9 图、3 视频、3 音频能力采用全部参考素材', () => {
  const references = [
    ...Array.from({ length: 9 }, (_, index) => ({
      kind: 'image', url: `/static/image-${index + 1}.png`, ready: true, order: index,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      kind: 'video', url: `/static/video-${index + 1}.mp4`, ready: true, order: 9 + index,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      kind: 'audio', url: `/static/audio-${index + 1}.mp3`, ready: true, order: 12 + index,
    })),
  ]
  const capability = {
    declared: true,
    referenceTypes: ['image', 'video', 'audio'],
    maxReferences: 9,
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    supportsImageReference: true,
    supportsVideoReference: true,
    supportsAudioReference: true,
  }

  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    const planned = planFreeCanvasVideoReferences(capability, 'omni', references)
    assert.equal(planned.length, 15, model)
    assert.equal(planned.every(({ enabled }) => enabled), true, model)
  }
})

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
    videoReferenceMode: 'first-last',
    characterReferenceUrls: [' https://cdn.example/character.png ', ''],
    taskId: 42,
    progress: 145,
    progressKnown: true,
    generationActive: true,
    generationBatchSize: 3,
    generationTaskBaseCount: 1,
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
    videoReferenceMode: 'first-last',
    characterReferenceUrls: ['https://cdn.example/character.png'],
    taskId: '42',
    progress: 100,
    progressKnown: true,
    generationActive: true,
    generationBatchSize: 3,
    generationTaskBaseCount: 1,
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

test('画布生成结果识别器保留线上图片和视频去重合同', () => {
  assert.equal(typeof freeCanvasGeneration.isCanvasGeneratedResultAsset, 'function')
  assert.equal(freeCanvasGeneration.isCanvasGeneratedResultAsset({
    type: 'image',
    category: 'canvas-result',
    metadata: { canvas_node_id: 'free:image:1' },
  }), true)
  assert.equal(freeCanvasGeneration.isCanvasGeneratedResultAsset({
    type: 'video',
    category: 'canvas-result',
    metadata: { source: 'canvas_node_result' },
  }), true)
  assert.equal(freeCanvasGeneration.isCanvasGeneratedResultAsset({
    type: 'audio',
    category: 'canvas-result',
    metadata: { auto_saved: true },
  }), false)
})

test('视频节点在没有参考图时仍可保存首尾帧模式', () => {
  assert.equal(normalizeFreeCanvasVideoReferenceMode('first-last', []), 'first-last')
})

test('视频节点可持久化全能参考模式', () => {
  assert.equal(normalizeFreeCanvasVideoReferenceMode('omni', []), 'omni')
})

test('首尾帧模式将前两张参考图映射为首帧和尾帧', () => {
  assert.equal(resolveFreeCanvasVideoReferenceInput('first-last', 0), 'first-frame')
  assert.equal(resolveFreeCanvasVideoReferenceInput('first-last', 1), 'last-frame')
  assert.equal(resolveFreeCanvasVideoReferenceInput('first-last', 2), 'reference-image')
  assert.equal(resolveFreeCanvasVideoReferenceInput('multi', 0), 'reference-image')
  assert.equal(resolveFreeCanvasVideoReferenceInput('omni', 0), 'reference-image')
  assert.equal(resolveFreeCanvasVideoReferenceInput('omni', 1), 'reference-image')
})

test('电影级光影校正失败重试参数可安全持久化并在刷新后恢复', () => {
  const normalized = normalizeFreeCanvasNodeData({
    kind: 'image',
    url: '/static/source.png',
    imageToolStatus: 'failed',
    imageToolError: '电影级光影校正处理失败',
    imageToolRetryOperation: 'cinematic_relight',
    imageToolRetryParameters: {
      preset: 'moonlight',
      intensity: 5,
      description: '失败后必须保留这一组重试参数',
      ignored: '不应持久化',
    },
  })
  assert.equal(normalized.imageToolRetryOperation, 'cinematic_relight')
  assert.deepEqual(normalized.imageToolRetryParameters, {
    preset: 'moonlight',
    intensity: 5,
    description: '失败后必须保留这一组重试参数',
  })

  const tooLong = normalizeFreeCanvasNodeData({
    kind: 'image',
    imageToolRetryOperation: 'cinematic_relight',
    imageToolRetryParameters: {
      preset: 'cinematic',
      intensity: 3,
      description: 'x'.repeat(301),
    },
  })
  assert.equal(tooLong.imageToolRetryOperation, undefined)
  assert.equal(tooLong.imageToolRetryParameters, undefined)
})

test('图片编辑派生节点关联字段可安全持久化', () => {
  const normalized = normalizeFreeCanvasNodeData({
    kind: 'image',
    url: '/static/result.png',
    savedAssetId: '7',
    sourceImageToolNodeId: 'free:image:source',
    imageToolOperation: 'selection_cutout',
    imageToolTaskId: 'task-1',
  })

  assert.equal(normalized.sourceImageToolNodeId, 'free:image:source')
  assert.equal(normalized.imageToolOperation, 'selection_cutout')
  assert.equal(normalized.imageToolTaskId, 'task-1')
})

test('全景失败重试只保留 300 字以内的补充要求', () => {
  for (const operation of ['panorama', 'panorama_scene']) {
    const normalized = normalizeFreeCanvasNodeData({
      kind: 'image',
      imageToolRetryOperation: operation,
      imageToolRetryParameters: {
        description: '保持中央主体并补全四周环境',
        ignored: '不应持久化',
      },
    })
    assert.equal(normalized.imageToolRetryOperation, operation)
    assert.deepEqual(normalized.imageToolRetryParameters, {
      description: '保持中央主体并补全四周环境',
    })

    const tooLong = normalizeFreeCanvasNodeData({
      kind: 'image',
      imageToolRetryOperation: operation,
      imageToolRetryParameters: {
        description: 'x'.repeat(301),
      },
    })
    assert.equal(tooLong.imageToolRetryOperation, undefined)
    assert.equal(tooLong.imageToolRetryParameters, undefined)
  }
})

test('画面联想失败重试只保留 300 字以内的补充要求', () => {
  for (const operation of [
    'image_ideation',
    'angle_ideation',
    'character_views',
    'narrative_grid',
    'frame_forward',
    'frame_backward',
  ]) {
    const normalized = normalizeFreeCanvasNodeData({
      kind: 'image',
      imageToolRetryOperation: operation,
      imageToolRetryParameters: {
        description: '  保留中央人物并联想雨后黄昏  ',
        ignored: '不应持久化',
      },
    })
    assert.equal(normalized.imageToolRetryOperation, operation)
    assert.deepEqual(normalized.imageToolRetryParameters, {
      description: '  保留中央人物并联想雨后黄昏  ',
    })

    const overLimit = normalizeFreeCanvasNodeData({
      kind: 'image',
      imageToolRetryOperation: operation,
      imageToolRetryParameters: { description: 'x'.repeat(301) },
    })
    assert.equal(overLimit.imageToolRetryParameters, undefined)
  }
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
    resolution: '2k',
    size: '2048x1152',
    n: 2,
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
    upstreamReferences: [
      { url: 'https://cdn.example/first.png', slot: 'first-frame' },
      { url: 'https://cdn.example/last.png', slot: 'last-frame' },
      { url: 'https://cdn.example/ref.png', slot: 'reference-image' },
    ],
  })
  assert.deepEqual(videoPayload, {
    drama_id: 7,
    prompt: '镜头推近\n镜头运动：push-in\n视觉特效：film-grain\n音频要求：生成与画面同步的对白、环境音或音效。',
    model: 'kling',
    image_url: 'https://cdn.example/first.png',
    first_frame_url: 'https://cdn.example/first.png',
    last_frame_url: 'https://cdn.example/last.png',
    reference_image_urls: [
      'https://cdn.example/first.png',
      'https://cdn.example/last.png',
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

test('视频节点纯文生视频模式不提交参考素材字段', () => {
  assert.equal(normalizeFreeCanvasVideoReferenceMode('text', []), 'text')
  const payload = buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '纯文本生成一个镜头',
    model: 'text-video',
    videoReferenceMode: 'text',
    aspectRatio: '16:9',
    duration: 4,
    resolution: '480p',
  }, {
    dramaId: 7,
    upstreamUrls: ['/static/stale-reference.jpg'],
    upstreamReferences: [{ kind: 'image', url: '/static/stale-reference.jpg', ready: true }],
    capability: {
      declared: true,
      referenceTypes: ['image'],
      supportsImageReference: true,
      maxImageReferences: 3,
      resolutions: ['480p'],
      durations: [4],
    },
  })

  for (const field of [
    'reference_mode',
    'image_url',
    'first_frame_url',
    'last_frame_url',
    'reference_image_urls',
    'reference_video_urls',
    'reference_audio_urls',
  ]) {
    assert.equal(field in payload, false, `纯文生视频不应提交 ${field}`)
  }
})

test('视频节点无可用参考时将历史 multi 状态降级为纯文生视频', () => {
  const payload = buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '忽略已失效参考',
    model: 'text-video',
    videoReferenceMode: 'multi',
    aspectRatio: '16:9',
    duration: 4,
    resolution: '480p',
  }, {
    dramaId: 7,
    upstreamUrls: ['/static/stale-reference.jpg'],
    upstreamReferences: [],
    capability: {
      declared: true,
      referenceTypes: ['image'],
      supportsImageReference: true,
      maxImageReferences: 3,
      resolutions: ['480p'],
      durations: [4],
    },
  })

  assert.equal('reference_mode' in payload, false)
  assert.equal('reference_image_urls' in payload, false)
})

test('视频模型明确关闭文生视频时在提交前阻断', () => {
  assert.throws(() => buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '不应提交',
    model: 'image-to-video-only',
    videoReferenceMode: 'text',
    duration: 4,
    resolution: '480p',
  }, {
    dramaId: 7,
    capability: {
      declared: true,
      supportsTextToVideo: false,
      resolutions: ['480p'],
      durations: [4],
    },
  }), /image-to-video-only.*不支持文生视频/)
})

test('视频节点按模型能力传递多图片、音频和视频参考', () => {
  const upstreamReferences = [
    ...Array.from({ length: 5 }, (_, index) => ({
      kind: 'image',
      url: `/static/ref-${index + 1}.jpg`,
      order: index,
    })),
    { kind: 'audio', url: '/static/voice.wav', order: 5 },
    { kind: 'video', url: '/static/motion.mp4', order: 6 },
  ]
  const payload = buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '跟随参考素材生成',
    model: 'omni-model',
  }, {
    dramaId: 7,
    upstreamReferences,
    capability: {
      referenceTypes: ['image', 'audio', 'video'],
      maxImageReferences: 10,
      maxAudioReferences: 1,
      maxVideoReferences: 1,
    },
  })

  assert.equal(payload.reference_image_urls.length, 5)
  assert.equal('image_url' in payload, false)
  assert.equal('first_frame_url' in payload, false)
  assert.equal('last_frame_url' in payload, false)
  assert.deepEqual(payload.reference_audio_urls, ['/static/voice.wav'])
  assert.deepEqual(payload.reference_video_urls, ['/static/motion.mp4'])
})

test('右键媒体序号与实际提交数组共享过滤、排序和去重顺序', () => {
  const upstreamReferences = [
    { edgeId: 'pending-video', kind: 'video', url: '', ready: false, order: 0 },
    { edgeId: 'audio-1', kind: 'audio', url: '/static/voice.wav', ready: true, order: 1 },
    { edgeId: 'video-1', kind: 'video', url: '/static/motion-a.mp4', ready: true, order: 2 },
    { edgeId: 'video-duplicate', kind: 'video', url: '/static/motion-a.mp4', ready: true, order: 3 },
    { edgeId: 'disabled-video', kind: 'video', url: '/static/disabled.mp4', ready: true, enabled: false, order: 4 },
    { edgeId: 'video-2', kind: 'video', url: '/static/motion-b.mp4', ready: true, order: 5 },
  ]
  const submissionReferences = normalizeFreeCanvasSubmissionReferences(upstreamReferences)
  assert.deepEqual(submissionReferences.map((reference) => reference.edgeId), [
    'audio-1',
    'video-1',
    'video-2',
  ])

  const payload = buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '按引用顺序生成',
    model: 'omni-model',
  }, {
    dramaId: 7,
    upstreamReferences,
    capability: {
      referenceTypes: ['audio', 'video'],
      maxAudioReferences: 1,
      maxVideoReferences: 2,
    },
  })
  assert.deepEqual(payload.reference_audio_urls, ['/static/voice.wav'])
  assert.deepEqual(payload.reference_video_urls, ['/static/motion-a.mp4', '/static/motion-b.mp4'])
})

test('不同上游节点 URL 相同时仍按真实提交数组去重', () => {
  const references = normalizeFreeCanvasSubmissionReferences([
    { edgeId: 'edge-a', nodeId: 'image-a', kind: 'image', url: '/static/shared.png', ready: true, order: 0 },
    { edgeId: 'edge-b', nodeId: 'image-b', kind: 'image', url: '/static/shared.png', ready: true, order: 1 },
    { edgeId: 'edge-a-duplicate', nodeId: 'image-a', kind: 'image', url: '/static/shared.png', ready: true, order: 2 },
  ])

  assert.deepEqual(references.map((reference) => reference.edgeId), ['edge-a'])
})

test('首尾帧按实际提交序列取前两张且不会把同一张图重复提交', () => {
  const payload = buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '首尾帧测试',
    model: 'first-last-model',
    videoReferenceMode: 'first-last',
  }, {
    dramaId: 7,
    upstreamReferences: [
      { kind: 'image', url: '', ready: false, slot: 'first-frame', order: 0 },
      { kind: 'image', url: '/static/last-ready.png', ready: true, slot: 'last-frame', order: 1 },
    ],
    capability: {
      referenceTypes: ['image'],
      supportsFirstFrame: true,
      supportsLastFrame: true,
      maxImageReferences: 2,
    },
  })

  assert.equal(payload.reference_mode, 'first_last')
  assert.equal(payload.first_frame_url, '/static/last-ready.png')
  assert.equal(payload.image_url, '/static/last-ready.png')
  assert.equal('last_frame_url' in payload, false)
})

test('首尾帧忽略失效连接的旧卡槽并采用后续两张有效图片', () => {
  const payload = buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '首尾帧连续性测试',
    model: 'first-last-model',
    videoReferenceMode: 'first-last',
  }, {
    dramaId: 7,
    upstreamReferences: [
      { kind: 'image', url: '', ready: false, slot: 'first-frame', order: 0 },
      { kind: 'image', url: '/static/first-ready.png', ready: true, slot: 'last-frame', order: 1 },
      { kind: 'image', url: '/static/last-ready.png', ready: true, slot: 'reference-image', order: 2 },
    ],
    capability: {
      referenceTypes: ['image'],
      supportsFirstFrame: true,
      supportsLastFrame: true,
      maxImageReferences: 2,
    },
  })

  assert.equal(payload.first_frame_url, '/static/first-ready.png')
  assert.equal(payload.last_frame_url, '/static/last-ready.png')
})

test('视频节点在付费请求前拒绝当前模型未声明的媒体参考', () => {
  assert.throws(() => buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '测试',
    model: 'video-v1',
  }, {
    dramaId: 7,
    upstreamReferences: [{ kind: 'audio', url: '/static/voice.wav' }],
    capability: { referenceTypes: ['image'], maxImageReferences: 10 },
  }), /video-v1.*不支持音频参考/)
})

test('图片节点在付费请求前拒绝当前模型未验证的参考图能力', () => {
  assert.throws(() => buildFreeCanvasGenerationRequest({
    kind: 'image',
    content: '保持角色一致性生成分镜图',
    model: 'image-v1-2k',
  }, {
    dramaId: 7,
    upstreamReferences: [{ kind: 'image', url: '/static/reference.jpg' }],
    capability: { maxReferences: 0 },
  }), /image-v1-2k.*不支持参考图/)
})

test('图片模型只有显式声明后才开放参考图并优先选择兼容模型', () => {
  const catalog = normalizeCanvasModelCatalog([
    { kind: 'image', model: 'text-to-image-only', capabilities: {} },
    { kind: 'image', model: 'reference-image', capabilities: { maxReferences: 6 } },
  ])

  assert.equal(catalog[0].capabilities.maxReferences, 0)
  assert.deepEqual(canvasModelOptions(catalog, 'image', { referenceCount: 2 }), [
    { value: 'text-to-image-only', label: 'text-to-image-only｜文生图 · 不支持参考图（超出参考图上限）', disabled: true },
    { value: 'reference-image', label: 'reference-image｜文生图 · 图生图（6 张参考图）' },
  ])
  assert.equal(canvasModelEntry(catalog, 'image', '', { referenceCount: 2 }).model, 'reference-image')
})

test('视频节点在付费请求前明确拒绝超过模型上限的参考素材', () => {
  assert.throws(() => buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '测试',
    model: 'video-v1',
  }, {
    dramaId: 7,
    upstreamReferences: Array.from({ length: 11 }, (_, index) => ({
      kind: 'image',
      url: `/static/ref-${index + 1}.jpg`,
    })),
    capability: { referenceTypes: ['image'], maxImageReferences: 10 },
  }), /video-v1.*最多支持 10 个图片参考/)
})

test('未声明能力的旧视频模型仍沿用旧参考合同而不会被当成零引用能力', () => {
  const payload = buildFreeCanvasGenerationRequest({
    kind: 'video', content: '镜头推近', model: 'legacy-video', duration: 5, resolution: '720p',
  }, {
    dramaId: 7,
    capability: {
      declared: false,
      resolutions: ['720p'],
      durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      maxReferences: 3,
    },
    upstreamReferences: [{ kind: 'video', url: 'https://cdn.example/reference.mp4' }],
  })

  assert.deepEqual(payload.reference_video_urls, ['https://cdn.example/reference.mp4'])
})

test('图片节点在提交前拒绝超过模型上限的参考图而不是静默截断', () => {
  const upstreamReferences = Array.from({ length: 7 }, (_, index) => ({
    kind: 'image',
    url: `https://cdn.example/reference-${index + 1}.png`,
    order: index,
  }))
  assert.throws(() => buildFreeCanvasGenerationRequest({
    kind: 'image',
    content: '保持全部参考人物一致',
    model: 'nano-banana-2',
    aspectRatio: '1:1',
    resolution: '1K',
  }, {
    dramaId: 7,
    upstreamReferences,
  }), /最多支持 6 张参考图/)
})

test('图片节点大小计算不区分分辨率大小写并同步透传小写档位', () => {
  const payload = buildFreeCanvasGenerationRequest({
    kind: 'image',
    content: '纵向人物海报',
    model: 'nano-banana-2',
    aspectRatio: '9:16',
    resolution: '4k',
    quantity: 1,
  }, { dramaId: 7, maxReferences: 6 })
  assert.equal(payload.resolution, '4k')
  assert.equal(payload.size, '2304x4096')
  assert.equal(payload.n, 1)
})

test('图片节点阻断 GPT 4K 和 USMercari 未验证的多张数量', () => {
  assert.throws(() => buildFreeCanvasGenerationRequest({
    kind: 'image', content: '海报', model: 'gpt-image-2-2-4k', aspectRatio: '1:1', resolution: '4k', quantity: 1,
  }, { dramaId: 7 }), /只开放 1k、2k/)
  assert.throws(() => buildFreeCanvasGenerationRequest({
    kind: 'image', content: '海报', model: 'nano-banana-2', aspectRatio: '1:1', resolution: '2k', quantity: 2,
  }, { dramaId: 7 }), /只开放单张生成/)
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

test('只有图片自由节点请求携带合法目录配置身份', () => {
  const imagePayload = buildFreeCanvasGenerationRequest({
    kind: 'image',
    content: '一张雨夜街道',
    model: 'image-a',
  }, { dramaId: 7, configId: '42' })
  assert.equal(imagePayload.config_id, 42)

  for (const configId of [true, '1e2', '1.0', '+42', 0, Number.MAX_SAFE_INTEGER + 1]) {
    const payload = buildFreeCanvasGenerationRequest({
      kind: 'image',
      content: '一张雨夜街道',
      model: 'image-a',
    }, { dramaId: 7, configId })
    assert.equal('config_id' in payload, false)
  }

  const nonImagePayloads = [
    buildFreeCanvasGenerationRequest({ kind: 'text', content: '旁白', model: 'text-a' }, { dramaId: 7, configId: 42 }),
    buildFreeCanvasGenerationRequest({ kind: 'video', content: '推镜', model: 'video-a' }, { dramaId: 7, configId: 42 }),
    buildFreeCanvasGenerationRequest({ kind: 'audio', content: '对白', model: 'audio-a' }, { dramaId: 7, configId: 42 }),
  ]
  for (const payload of nonImagePayloads) assert.equal('config_id' in payload, false)
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

test('collectDirectUpstreamResultUrls 收集所有直接上游真实结果 URL 并去重', () => {
  const nodes = [
    { id: 'a', data: { kind: 'image', url: 'https://cdn.example/a.png' } },
    { id: 'b', data: { kind: 'image', url: 'https://cdn.example/a.png' } },
    { id: 'c', data: { kind: 'image', url: '' } },
    { id: 'd', data: { kind: 'video', url: 'https://cdn.example/d.mp4' } },
    { id: 'e', data: { kind: 'image', url: 'https://cdn.example/e.png' } },
  ]
  const edges = [
    { id: 'auto:a:d', source: 'a', target: 'd' },
    { id: 'auto:e:d', source: 'e', target: 'd' },
    { id: 'manual:a:d', source: 'a', target: 'd', data: { manual: true } },
    { id: 'manual:b:d', source: 'b', target: 'd', data: { manual: true } },
    { id: 'manual:c:d', source: 'c', target: 'd', data: { manual: true } },
  ]

  assert.deepEqual(collectDirectUpstreamResultUrls(nodes, edges, 'd'), [
    'https://cdn.example/a.png',
    'https://cdn.example/e.png',
  ])
})

test('collectDirectUpstreamImageReferences 同时呈现已就绪和等待生成的图片连线', () => {
  const nodes = [
    { id: 'image-ready', data: { kind: 'image', title: '首帧', url: '', resultUrls: ['/static/first.png'] } },
    { id: 'image-pending', data: { kind: 'image', title: '尾帧', url: '' } },
    { id: 'audio', data: { kind: 'audio', title: '旁白', url: '/static/voice.mp3' } },
    { id: 'video', data: { kind: 'video', title: '视频' } },
  ]
  const edges = [
    { id: 'manual:ready', source: 'image-ready', target: 'video', data: { manual: true } },
    { id: 'legacy:ready', source: 'image-ready', target: 'video' },
    { id: 'manual:pending', source: 'image-pending', target: 'video', data: { manual: true } },
    { id: 'manual:audio', source: 'audio', target: 'video', data: { manual: true } },
  ]

  assert.deepEqual(collectDirectUpstreamImageReferences(nodes, edges, 'video'), [
    { kind: 'image', nodeId: 'image-ready', edgeId: 'manual:ready', title: '首帧', url: '/static/first.png', ready: true, slot: 'reference-image', enabled: true, order: 0, weight: 1 },
    { kind: 'image', nodeId: 'image-pending', edgeId: 'manual:pending', title: '尾帧', url: '', ready: false, slot: 'reference-image', enabled: true, order: 1, weight: 1 },
  ])
})

test('collectDirectUpstreamMediaReferences 分类收集图片、音频和视频连线', () => {
  const nodes = [
    { id: 'image', data: { kind: 'image', title: '角色', url: '/static/role.jpg' } },
    { id: 'audio', data: { kind: 'audio', title: '音色', url: '/static/voice.wav' } },
    { id: 'source-video', data: { kind: 'video', title: '动作', url: '/static/motion.mp4' } },
    { id: 'target-video', data: { kind: 'video', title: '生成' } },
  ]
  const edges = [
    { id: 'image-edge', source: 'image', target: 'target-video' },
    { id: 'audio-edge', source: 'audio', target: 'target-video' },
    { id: 'video-edge', source: 'source-video', target: 'target-video' },
  ]

  assert.deepEqual(
    collectDirectUpstreamMediaReferences(nodes, edges, 'target-video').map((item) => item.kind),
    ['image', 'audio', 'video'],
  )
})

test('全能参考收集图片、视频、音频并构造真实视频请求字段', () => {
  const nodes = [
    { id: 'image', data: { kind: 'image', title: '首帧', url: '/static/first.png' } },
    { id: 'video-ref', data: { kind: 'video', title: '动作参考', url: '/static/motion.mp4' } },
    { id: 'audio-ref', data: { kind: 'audio', title: '声音参考', url: '/static/voice.mp3' } },
    { id: 'target', data: { kind: 'video', title: '目标视频' } },
  ]
  const edges = [
    { id: 'image-edge', source: 'image', target: 'target', data: { contract: { input: 'first-frame', order: 0 } } },
    { id: 'video-edge', source: 'video-ref', target: 'target', data: { contract: { input: 'reference-video', order: 1 } } },
    { id: 'audio-edge', source: 'audio-ref', target: 'target', data: { contract: { input: 'reference-audio', order: 2 } } },
  ]
  const references = collectDirectUpstreamMediaReferences(nodes, edges, 'target')

  assert.deepEqual(references.map(({ kind, slot, url }) => ({ kind, slot, url })), [
    { kind: 'image', slot: 'first-frame', url: '/static/first.png' },
    { kind: 'video', slot: 'reference-video', url: '/static/motion.mp4' },
    { kind: 'audio', slot: 'reference-audio', url: '/static/voice.mp3' },
  ])
  assert.deepEqual(buildFreeCanvasGenerationRequest({
    kind: 'video', content: '跟随参考动作', model: 'MiniMax H3', aspectRatio: '16:9', duration: 5, resolution: '480p',
  }, { dramaId: 7, upstreamReferences: references, maxReferences: 4 }), {
    drama_id: 7,
    prompt: '跟随参考动作',
    model: 'MiniMax H3',
    reference_image_urls: ['/static/first.png'],
    reference_video_urls: ['/static/motion.mp4'],
    reference_audio_urls: ['/static/voice.mp3'],
    aspect_ratio: '16:9',
    duration: 5,
    resolution: '480p',
  })
})

test('getFreeCanvasNodeResultUrl 兼容当前 URL 与多结果数组', () => {
  assert.equal(getFreeCanvasNodeResultUrl({
    data: { url: '/static/current.png', resultUrls: ['/static/generated.png'] },
  }), '/static/current.png')
  assert.equal(getFreeCanvasNodeResultUrl({
    data: { url: '', resultUrls: ['/static/generated.png'] },
  }), '/static/generated.png')
})

test('collectDirectUpstreamTextInputs 收集所有直接上游文本输入并去重', () => {
  const nodes = [
    { id: 'text-a', data: { kind: 'text', content: '上游对白' } },
    { id: 'text-b', data: { kind: 'text', content: '补充动作' } },
    { id: 'image-a', data: { kind: 'image', content: '不是文本输入' } },
  ]
  const edges = [
    { id: 'manual:text-a:video', source: 'text-a', target: 'video', data: { manual: true } },
    { id: 'manual:text-a:video-copy', source: 'text-a', target: 'video', data: { manual: true } },
    { id: 'auto:text-b:video', source: 'text-b', target: 'video' },
    { id: 'manual:image-a:video', source: 'image-a', target: 'video', data: { manual: true } },
    { id: 'auto:text-a:other', source: 'text-a', target: 'other' },
  ]

  assert.deepEqual(collectDirectUpstreamTextInputs(nodes, edges, 'video'), ['上游对白', '补充动作'])
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
