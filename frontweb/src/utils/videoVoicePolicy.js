const POLICIES = Object.freeze({
  reference_audio: Object.freeze({ key: 'reference_audio', label: '参考音频', type: 'success' }),
  native_audio_prompt: Object.freeze({ key: 'native_audio_prompt', label: '文字声线提示', type: 'warning' }),
  silent: Object.freeze({ key: 'silent', label: '静音后期配音', type: 'info' }),
})

const VOICE_PITCHES = ['medium-low pitch', 'mid-range pitch', 'medium-high pitch']
const VOICE_TIMBRES = ['warm clear timbre', 'soft breathy timbre', 'bright focused timbre', 'deep textured timbre']
const VOICE_PACES = ['measured pace', 'natural conversational pace', 'slightly brisk pace']

function normalize(value) {
  return String(value || '').trim().toLowerCase()
}

function classifyVideoVoicePolicy({ protocol, provider, model } = {}) {
  const p = normalize(protocol)
  const vendor = normalize(provider)
  const m = normalize(model)
  if (/seedance[\s._-]*2(?:[\s._-]*0)?/i.test(m)) return POLICIES.reference_audio
  if (p === 'veo2' || /veo[\s._-]*2(?:[\s._-]*0)?(?:[\s._-]|$)/i.test(m)) return POLICIES.silent
  if (p === 'veo3' || /veo[\s._-]*3(?:[\s._-]*[01])?(?:[\s._-]|$)/i.test(m)) return POLICIES.native_audio_prompt
  if (p.includes('deepwl_grok') || /grok.*video/i.test(m)) return POLICIES.native_audio_prompt
  if (vendor === 'gemini' || vendor === 'google') return POLICIES.native_audio_prompt
  return POLICIES.native_audio_prompt
}

function videoVoicePolicyForConfig(config = {}) {
  const models = Array.isArray(config.model)
    ? config.model
    : config.model != null
      ? [config.model]
      : []
  const candidates = models.length ? models : [config.default_model]
  const items = candidates
    .map((model) => String(model || '').trim())
    .filter(Boolean)
    .map((model) => ({ model, ...classifyVideoVoicePolicy({ protocol: config.api_protocol, provider: config.provider, model }) }))
  const defaultModel = String(config.default_model || '').trim()
  return items.find((item) => item.model === defaultModel) || items[0] || null
}

function stableVoiceHash(value) {
  let hash = 2166136261
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function generatedVoiceStyle(character = {}) {
  const key = character.id != null ? character.id : character.name || 'character'
  const hash = stableVoiceHash(key)
  return `${VOICE_PITCHES[hash % VOICE_PITCHES.length]}, ${VOICE_TIMBRES[(hash >>> 3) % VOICE_TIMBRES.length]}, ${VOICE_PACES[(hash >>> 6) % VOICE_PACES.length]}, clear diction`
}

function buildVoicePromptPreview({ policy, characters = [] } = {}) {
  if (!policy) return '当前模型的声音策略尚未加载。'
  if (policy.key === 'silent') {
    return '本模型不生成原生音频。请在生成后使用“对白配音/TTS”并在整集合成时混音。'
  }
  const list = Array.isArray(characters) ? characters.filter(Boolean) : []
  if (!list.length) return '本镜没有已绑定角色，不会追加角色级声线锚点。'
  const lines = list.map((character) => {
    const name = String(character.name || `角色${character.id || ''}`).trim()
    const style = String(character.voice_style || '').trim() || generatedVoiceStyle(character)
    return `- ${name}: ${style}. Keep this voice distinct and consistent across shots.`
  })
  const mode = policy.key === 'reference_audio' ? '参考音频优先；以下文字只用于对白归属和连续性。' : '模型不保证音色克隆；以下文字用于稳定角色声线差异。'
  return [`VOICE CONTINUITY：${mode}`, ...lines, '对白必须由标注角色说出，并与环境音、配乐分离。'].join('\n')
}

export {
  POLICIES,
  buildVoicePromptPreview,
  classifyVideoVoicePolicy,
  generatedVoiceStyle,
  videoVoicePolicyForConfig,
}
