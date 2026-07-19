import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildVideoGenerationAudit,
  buildVideoGenerationRequest,
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
    ],
    aspectRatio: '16:9',
    duration: 5,
  })

  assert.equal(payload.model, 'grok-video-3')
  assert.equal(payload.storyboard_id, 216)
  assert.equal(payload.first_frame_url.endsWith('/first.jpg'), true)
  assert.equal(payload.last_frame_url.endsWith('/last.jpg'), true)
  assert.deepEqual(payload.reference_image_urls, ['http://localhost:3014/static/refs/scene.jpg'])
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
