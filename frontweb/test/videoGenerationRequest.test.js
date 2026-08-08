import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildVideoGenerationAudit,
  buildVideoGenerationRequest,
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

test('短剧工厂为两个飞拓模型启用全能模式并按模型限制参考图', () => {
  const references = Array.from({ length: 12 }, (_, index) => `https://cdn.example/ref-${index + 1}.jpg`)
  const h3 = limitFeituoShortDramaReferenceImages('sdas-lm-hailuo-h3-2k', references)
  const fast = limitFeituoShortDramaReferenceImages('sdas-my-seedance-2.0-fast-upscaled-1080p', references)
  const other = limitFeituoShortDramaReferenceImages('grok-video-3', references)

  assert.equal(supportsFeituoShortDramaOmni('sdas-lm-hailuo-h3-2k'), true)
  assert.equal(supportsFeituoShortDramaOmni('sdas-my-seedance-2.0-fast-upscaled-1080p'), true)
  assert.equal(supportsFeituoShortDramaOmni('grok-video-3'), false)
  assert.equal(h3.length, 9)
  assert.equal(fast.length, 4)
  assert.equal(other.length, 12)
})
