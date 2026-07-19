import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyVideoVoicePolicy, videoVoicePolicyForConfig } from '../src/utils/videoVoicePolicy.js'

test('前端策略与后端保持一致：Seedance 2 使用参考音频', () => {
  assert.equal(
    classifyVideoVoicePolicy({ protocol: 'icreat_task', provider: 'icreat', model: 'bytedance/seedance-2-0-fast' }).key,
    'reference_audio'
  )
})

test('Veo 2 显示静音后期配音，Veo 3 显示文字声线提示', () => {
  assert.equal(classifyVideoVoicePolicy({ model: 'veo-2.0-generate-001' }).key, 'silent')
  assert.equal(classifyVideoVoicePolicy({ protocol: 'veo3', model: 'veo-3.1-generate-preview' }).key, 'native_audio_prompt')
})

test('多模型配置按默认模型显示主策略', () => {
  const policy = videoVoicePolicyForConfig({
    provider: 'gemini',
    api_protocol: 'gemini',
    model: ['veo-2.0-generate-001', 'veo-3.1-generate-preview'],
    default_model: 'veo-3.1-generate-preview',
  })
  assert.equal(policy.model, 'veo-3.1-generate-preview')
  assert.equal(policy.label, '文字声线提示')
})
