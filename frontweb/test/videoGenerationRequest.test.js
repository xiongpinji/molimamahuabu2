import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildVideoGenerationAudit,
  buildShortDramaVideoRequest,
  buildVideoGenerationRequest,
  feituoShortDramaImageLimit,
  isUsmercariShortDramaModel,
  limitFeituoShortDramaReferenceImages,
  supportsFeituoShortDramaOmni,
} from '../src/utils/videoGenerationRequest.js'

test('请求审计保留分镜模型、参考图和首尾帧字段', () => {
  const payload = buildVideoGenerationRequest({
    dramaId: 14,
    storyboardId: 216,
    prompt: '角色A：继续向前走。',
    model: 'grok-video-3',
    imageUrl: 'http://localhost:3014/static/frames/first.jpg',
    firstFrameUrl: 'http://localhost:3014/static/frames/first.jpg',
    lastFrameUrl: 'http://localhost:3014/static/frames/last.jpg',
    referenceImageUrls: [
      'http://localhost:3014/static/refs/scene.jpg',
      'http://localhost:3014/static/refs/scene.jpg',
      '  ',
    ],
    style: 'cinematic',
    aspectRatio: '16:9',
    resolution: '720p',
    duration: 5,
  })

  assert.equal(payload.model, 'grok-video-3')
  assert.equal(payload.storyboard_id, 216)
  assert.equal(payload.prompt, '角色A：继续向前走。')
  assert.equal(payload.first_frame_url.endsWith('/first.jpg'), true)
  assert.equal(payload.last_frame_url.endsWith('/last.jpg'), true)
  assert.deepEqual(payload.reference_image_urls, ['http://localhost:3014/static/refs/scene.jpg'])
  assert.equal(payload.style, 'cinematic')
  assert.equal(payload.aspect_ratio, '16:9')
  assert.equal(payload.resolution, '720p')
  assert.equal(payload.duration, 5)
})

test('全能参考请求保留完整多模态数组、参考模式与 false 同步音频快照', () => {
  const payload = buildVideoGenerationRequest({
    dramaId: 14,
    storyboardId: 216,
    prompt: '森林中的跟拍镜头',
    model: 'seedance-2-mini',
    referenceImageUrls: [
      'https://molimama.vip/static/projects/0014/assets/scene.png',
      'https://molimama.vip/static/projects/0014/assets/scene.png',
      'https://molimama.vip/static/projects/0014/assets/role.png',
    ],
    referenceVideoUrls: [
      'https://molimama.vip/static/projects/0014/assets/motion.mp4',
      'https://molimama.vip/static/projects/0014/assets/motion.mp4',
    ],
    referenceAudioUrls: [
      'https://molimama.vip/static/projects/0014/assets/voice.mp3',
    ],
    referenceMode: 'omni',
    generateAudio: false,
    resolution: '720p',
    duration: 8,
    capability: {
      declared: true,
      resolutions: ['480p', '720p'],
      durations: [4, 8, 10, 12, 15],
      supportsImageReference: true,
      supportsVideoReference: true,
      supportsAudioReference: true,
      supportsAudio: true,
      maxReferences: 4,
      maxVideoReferences: 3,
      maxAudioReferences: 3,
    },
  })

  assert.deepEqual(payload.reference_image_urls, [
    'https://molimama.vip/static/projects/0014/assets/scene.png',
    'https://molimama.vip/static/projects/0014/assets/role.png',
  ])
  assert.deepEqual(payload.reference_video_urls, [
    'https://molimama.vip/static/projects/0014/assets/motion.mp4',
  ])
  assert.deepEqual(payload.reference_audio_urls, [
    'https://molimama.vip/static/projects/0014/assets/voice.mp3',
  ])
  assert.equal(payload.reference_mode, 'omni')
  assert.equal(payload.generate_audio, false)
})

test('声明能力的视频请求拒绝越界档位、超量引用和首尾帧/全能混用', () => {
  const capability = {
    declared: true,
    resolutions: ['480p', '720p'],
    durations: [4, 8, 10, 12, 15],
    supportsImageReference: true,
    supportsVideoReference: true,
    supportsAudioReference: true,
    supportsAudio: true,
    maxReferences: 1,
    maxVideoReferences: 1,
    maxAudioReferences: 1,
  }
  const base = {
    model: 'seedance-2-fast',
    prompt: '森林中的跟拍镜头',
    resolution: '720p',
    duration: 8,
    capability,
  }

  assert.throws(
    () => buildVideoGenerationRequest({ ...base, resolution: '1080p' }),
    /不支持 1080p 清晰度/,
  )
  assert.throws(
    () => buildVideoGenerationRequest({ ...base, duration: 5 }),
    /仅支持 4、8、10、12、15 秒/,
  )
  assert.throws(
    () => buildVideoGenerationRequest({ ...base, referenceImageUrls: ['a.png', 'b.png'], referenceMode: 'omni' }),
    /最多支持 1 张参考图/,
  )
  assert.throws(
    () => buildVideoGenerationRequest({
      ...base,
      firstFrameUrl: 'first.png',
      referenceImageUrls: ['ref.png'],
      referenceMode: 'first_last',
    }),
    /首尾帧模式与全能参考模式互斥/,
  )
})

test('声明能力的视频请求拒绝未开放的首帧和尾帧槽位', () => {
  const base = {
    model: 'seedance-2-fast',
    prompt: '森林中的跟拍镜头',
    resolution: '720p',
    duration: 8,
    referenceMode: 'first_last',
  }
  const capability = {
    declared: true,
    resolutions: ['480p', '720p'],
    durations: [4, 8, 10, 12, 15],
    supportsFirstFrame: false,
    supportsLastFrame: false,
  }

  assert.throws(
    () => buildVideoGenerationRequest({ ...base, firstFrameUrl: 'first.png', capability }),
    /不支持首帧参考/,
  )
  assert.throws(
    () => buildVideoGenerationRequest({ ...base, lastFrameUrl: 'last.png', capability }),
    /不支持尾帧参考/,
  )
})

test('请求审计区分参考音频候选与实际视频请求体', () => {
  const payload = buildVideoGenerationRequest({
    dramaId: 14,
    storyboardId: 216,
    prompt: '小狐狸：别怕。',
    model: 'bytedance/seedance-2-0-fast',
  })
  const audit = buildVideoGenerationAudit({
    payload,
    config: { provider: 'icreat', api_protocol: 'icreat_task' },
    voicePolicy: { key: 'reference_audio', label: '参考音频' },
    voicePrompt: 'VOICE CONTINUITY\n- 小狐狸: bright youthful voice',
    voiceReferences: [{ id: 9, name: '小狐狸', url: '/static/voices/fox.mp3', source: 'extracted_voice_asset' }],
  })

  assert.equal(audit.model, 'bytedance/seedance-2-0-fast')
  assert.equal(audit.voice_policy.key, 'reference_audio')
  assert.equal(audit.reference_audio.mode, 'backend_auto_injection')
  assert.deepEqual(audit.reference_audio.candidates[0], {
    id: 9,
    name: '小狐狸',
    url: '/static/voices/fox.mp3',
    source: 'extracted_voice_asset',
  })
  assert.equal(audit.payload.storyboard_id, 216)
  assert.equal(Object.hasOwn(audit.payload, 'voice_reference_url'), false)
})

test('请求审计保存角色声线快照但不污染真实 provider payload', () => {
  const payload = buildVideoGenerationRequest({
    dramaId: 14,
    storyboardId: 216,
    prompt: '小狐狸：别怕。',
    model: 'grok-video-3',
  })
  const audit = buildVideoGenerationAudit({
    payload,
    voicePolicy: { key: 'native_audio_prompt', label: '文字声线提示' },
    voicePrompt: 'VOICE CONTINUITY\n- 小狐狸 [voice-card:character-1]: 清亮。',
    voiceSnapshot: {
      version: 1,
      storyboard_id: 216,
      characters: [
        {
          id: 1,
          name: '小狐狸',
          voice_card: 'voice-card:character-1',
          voice_style: '清亮、少年感、语速轻快',
          source: 'character_voice_style',
        },
      ],
    },
  })

  assert.equal(audit.voice_snapshot.storyboard_id, 216)
  assert.deepEqual(audit.voice_snapshot.characters[0], {
    id: 1,
    name: '小狐狸',
    voice_card: 'voice-card:character-1',
    voice_style: '清亮、少年感、语速轻快',
    source: 'character_voice_style',
  })
  assert.equal(Object.hasOwn(audit.payload, 'voice_snapshot'), false)
})

test('短剧 USMercari H3 全能参考请求保留 false 同步音频并校验三类引用上限', () => {
  assert.equal(isUsmercariShortDramaModel('MiniMax H3'), true)

  const payload = buildShortDramaVideoRequest({
    mode: 'omni_reference',
    prompt: '根据角色、场景和声线参考生成 15 秒视频',
    model: 'MiniMax H3',
    storyboardImageUrl: 'https://molimama.vip/static/storyboard.png',
    baseReferenceImageUrls: [
      'https://molimama.vip/static/role.png',
      'https://molimama.vip/static/scene.png',
    ],
    referenceAudioUrls: ['https://molimama.vip/static/voice.mp3'],
    generateAudio: false,
    resolution: '480p',
    duration: 15,
    capability: {
      declared: true,
      resolutions: ['480p', '720p'],
      durations: [5, 10, 15],
      supportsImageReference: true,
      supportsAudioReference: true,
      maxReferences: 5,
      maxAudioReferences: 3,
    },
  })

  assert.equal(payload.reference_mode, 'omni')
  assert.equal(payload.image_url, 'https://molimama.vip/static/storyboard.png')
  assert.deepEqual(payload.reference_image_urls, [
    'https://molimama.vip/static/storyboard.png',
    'https://molimama.vip/static/role.png',
    'https://molimama.vip/static/scene.png',
  ])
  assert.deepEqual(payload.reference_audio_urls, ['https://molimama.vip/static/voice.mp3'])
  assert.equal(payload.generate_audio, false)

  assert.throws(
    () => buildShortDramaVideoRequest({
      mode: 'omni_reference',
      prompt: '不能带参考视频',
      model: 'MiniMax H3',
      storyboardImageUrl: 'https://molimama.vip/static/storyboard.png',
      referenceVideoUrls: ['https://molimama.vip/static/motion.mp4'],
    }),
    /MiniMax H3 最多支持 0 个参考视频/,
  )
})

test('短剧 ToAPIs strict 全能参考请求不同时提交 image_url 和 reference_image_urls', () => {
  const payload = buildShortDramaVideoRequest({
    mode: 'omni_reference',
    prompt: '根据分镜图和角色参考生成视频',
    model: 'seedance-2-fast',
    storyboardImageUrl: 'https://molimama.vip/static/storyboard.png',
    baseReferenceImageUrls: ['https://molimama.vip/static/role.png'],
    strictToapis: true,
    resolution: '720p',
    duration: 8,
    capability: {
      declared: true,
      resolutions: ['480p', '720p'],
      durations: [4, 8, 10, 12, 15],
      supportsImageReference: true,
      maxReferences: 9,
    },
  })

  assert.equal(payload.reference_mode, 'omni')
  assert.equal(Object.hasOwn(payload, 'image_url'), false)
  assert.deepEqual(payload.reference_image_urls, [
    'https://molimama.vip/static/storyboard.png',
    'https://molimama.vip/static/role.png',
  ])
})

test('短剧首尾帧模式与普通参考图互斥，避免供应商混合引用报错', () => {
  assert.throws(
    () => buildShortDramaVideoRequest({
      mode: 'first_last_frame',
      prompt: '首尾帧生成',
      model: 'seedance-2.0-fast',
      firstFrameUrl: 'https://molimama.vip/static/first.png',
      lastFrameUrl: 'https://molimama.vip/static/last.png',
      baseReferenceImageUrls: ['https://molimama.vip/static/ref.png'],
    }),
    /首尾帧模式不能混用参考图/,
  )
})

test('飞拓短剧模型声明全能参考和参考图裁剪上限', () => {
  assert.equal(supportsFeituoShortDramaOmni('sdas-lm-hailuo-h3-2k'), true)
  assert.equal(feituoShortDramaImageLimit('sdas-lm-hailuo-h3-2k'), 9)
  assert.deepEqual(
    limitFeituoShortDramaReferenceImages(
      'sdas-my-seedance-2.0-fast-upscaled-1080p',
      ['1.png', '2.png', '3.png', '4.png', '5.png'],
    ),
    ['1.png', '2.png', '3.png', '4.png'],
  )
})
