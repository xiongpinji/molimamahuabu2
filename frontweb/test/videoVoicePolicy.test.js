import test from 'node:test'
import assert from 'node:assert/strict'

import { buildVoicePromptPreview, classifyVideoVoicePolicy, generatedVoiceStyle, videoVoicePolicyForConfig } from '../src/utils/videoVoicePolicy.js'

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

test('角色没有显式声线时生成稳定的角色级提示', () => {
  const first = generatedVoiceStyle({ id: 7, name: '小狐狸' })
  assert.equal(first, generatedVoiceStyle({ id: 7, name: '小狐狸' }))
  assert.match(first, /clear diction/)
})

test('声音预览区分静音后期配音与原生音频模型', () => {
  const silent = buildVoicePromptPreview({
    policy: classifyVideoVoicePolicy({ model: 'veo-2.0-generate-001' }),
    characters: [{ id: 1, name: '小狐狸' }],
  })
  assert.match(silent, /不生成原生音频/)

  const native = buildVoicePromptPreview({
    policy: classifyVideoVoicePolicy({ model: 'veo-3.1-generate-preview' }),
    characters: [{ id: 1, name: '小狐狸', voice_style: '明亮、清透、中速语速' }],
  })
  assert.match(native, /小狐狸: 明亮、清透、中速语速/)
  assert.match(native, /不保证音色克隆/)
})
