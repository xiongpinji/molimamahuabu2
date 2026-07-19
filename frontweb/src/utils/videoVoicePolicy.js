const POLICIES = Object.freeze({
  reference_audio: Object.freeze({ key: 'reference_audio', label: '参考音频', type: 'success' }),
  native_audio_prompt: Object.freeze({ key: 'native_audio_prompt', label: '文字声线提示', type: 'warning' }),
  silent: Object.freeze({ key: 'silent', label: '静音后期配音', type: 'info' }),
})

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

export { POLICIES, classifyVideoVoicePolicy, videoVoicePolicyForConfig }
