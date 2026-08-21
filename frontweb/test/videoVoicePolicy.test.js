import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendVoicePromptToVideoPrompt,
  buildStoryboardVoiceSnapshot,
  buildVoicePromptPreview,
  characterVoiceCard,
  characterVoiceAnchor,
  classifyVideoVoicePolicy,
  generatedVoiceStyle,
  storyboardVoiceCharacters,
  videoVoicePolicyForConfig,
} from '../src/utils/videoVoicePolicy.js'

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

test('角色 voice-card 记录声线来源，便于请求审计追踪', () => {
  const explicit = characterVoiceCard({ id: 1, name: '小狐狸', voice_style: '清亮、少年感' })
  assert.equal(explicit.voice_card, 'voice-card:character-1')
  assert.equal(explicit.source, 'character_voice_style')
  assert.equal(explicit.voice_style, '清亮、少年感')

  const generated = characterVoiceCard({ id: 2, name: '白狐' })
  assert.equal(generated.voice_card, 'voice-card:character-2')
  assert.equal(generated.source, 'generated_stable_voice_style')
  assert.match(generated.voice_style, /clear diction/)
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
  assert.match(native, /小狐狸 \[voice-card:character-1\]: 明亮、清透、中速语速/)
  assert.match(native, /不保证音色克隆/)
})

test('角色声线块包含可跨分镜复用的固定 voice-card', () => {
  const line = characterVoiceAnchor({ id: 1, name: '小狐狸', voice_style: '清亮、少年感、语速轻快' })
  assert.match(line, /小狐狸 \[voice-card:character-1\]/)
  assert.match(line, /every storyboard shot/)
  assert.match(line, /never swap/)
})

test('画布视频提示词自动追加角色声线块且保持幂等', () => {
  const prompt = appendVoicePromptToVideoPrompt({
    prompt: '镜头从树下推近，小狐狸低声说话。',
    policy: classifyVideoVoicePolicy({ model: 'veo-3.1-generate-preview' }),
    characters: [{ id: 1, name: '小狐狸', voice_style: '清亮、少年感、语速轻快' }],
  })
  assert.match(prompt, /VOICE CONTINUITY/)
  assert.match(prompt, /同一角色在所有分镜中必须复用同一张 voice-card/)
  assert.match(prompt, /小狐狸 \[voice-card:character-1\]: 清亮、少年感、语速轻快/)
  assert.match(prompt, /不要把对白、环境音、配乐或其它角色声音混成同一音色/)

  const again = appendVoicePromptToVideoPrompt({
    prompt,
    policy: classifyVideoVoicePolicy({ model: 'veo-3.1-generate-preview' }),
    characters: [{ id: 1, name: '小狐狸', voice_style: '清亮、少年感、语速轻快' }],
  })
  assert.equal(again, prompt)
})

test('不支持音色克隆的模型也降级挂载文字声线指令', () => {
  const prompt = appendVoicePromptToVideoPrompt({
    prompt: '小狐狸望向远处。',
    policy: classifyVideoVoicePolicy({ model: 'veo-2.0-generate-001' }),
    characters: [{ id: 1, name: '小狐狸' }],
  })
  assert.match(prompt, /VOICE CONTINUITY/)
  assert.match(prompt, /模型不保证音色克隆/)
  assert.doesNotMatch(prompt, /不生成原生音频/)
})

test('从分镜绑定角色和对白中提取声线角色', () => {
  const drama = {
    characters: [
      { id: 1, name: '小狐狸', voice_style: '清亮' },
      { id: 2, name: '刻纹木牌', voice_style: '低沉' },
    ],
  }
  const characters = storyboardVoiceCharacters(drama, {
    characters: JSON.stringify([{ id: 1 }]),
    dialogue: '刻纹木牌：你终于来了。',
  })
  assert.deepEqual(characters.map((item) => item.name), ['小狐狸', '刻纹木牌'])
})

test('分镜声线快照固化所有已绑定角色的 voice-card', () => {
  const drama = {
    characters: [
      { id: 1, name: '小狐狸', voice_style: '清亮、少年感、语速轻快' },
      { id: 2, name: '刻纹木牌' },
    ],
  }
  const snapshot = buildStoryboardVoiceSnapshot(drama, {
    id: 216,
    characters: JSON.stringify([{ id: 1 }]),
    dialogue: '刻纹木牌：你终于来了。',
  })
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.storyboard_id, 216)
  assert.deepEqual(snapshot.characters.map((item) => item.name), ['小狐狸', '刻纹木牌'])
  assert.deepEqual(snapshot.characters.map((item) => item.voice_card), ['voice-card:character-1', 'voice-card:character-2'])
  assert.equal(snapshot.characters[0].source, 'character_voice_style')
  assert.equal(snapshot.characters[1].source, 'generated_stable_voice_style')
})
