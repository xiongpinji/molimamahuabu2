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

function parseCharacterRefs(value) {
  if (Array.isArray(value)) return value
  if (value == null || value === '') return []
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch (_) {
      return value.split(/[，,\s]+/).map((item) => item.trim()).filter(Boolean)
    }
  }
  return [value]
}

function normalizeCharacterName(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s　]+/g, '')
}

function collectDramaCharacters(drama = {}) {
  const fromRoot = Array.isArray(drama.characters) ? drama.characters : []
  const fromEpisodes = (Array.isArray(drama.episodes) ? drama.episodes : [])
    .flatMap((episode) => Array.isArray(episode.characters) ? episode.characters : [])
  const rows = [...fromRoot, ...fromEpisodes].filter(Boolean)
  const seen = new Set()
  return rows.filter((row) => {
    const key = row.id != null ? `id:${row.id}` : `name:${normalizeCharacterName(row.name)}`
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function storyboardVoiceCharacters(drama = {}, storyboard = {}) {
  const refs = parseCharacterRefs(storyboard.characters)
  const rows = collectDramaCharacters(drama)
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  const byName = new Map(rows.map((row) => [normalizeCharacterName(row.name), row]))
  const out = []
  const seen = new Set()
  for (const ref of refs) {
    const object = ref && typeof ref === 'object' ? ref : null
    const id = object ? object.id : ref
    const name = object?.name || object?.character_name || (typeof ref === 'string' && !/^\d+$/.test(ref) ? ref : '')
    const row = byId.get(String(id)) || byName.get(normalizeCharacterName(name)) || object
    if (!row?.name) continue
    const key = row.id != null ? `id:${row.id}` : `name:${normalizeCharacterName(row.name)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  const dialogue = String(storyboard.dialogue || '')
  if (dialogue) {
    for (const row of rows) {
      const key = row.id != null ? `id:${row.id}` : `name:${normalizeCharacterName(row.name)}`
      if (seen.has(key)) continue
      if (dialogue.includes(`${row.name}：`) || dialogue.includes(`${row.name}:`)) {
        seen.add(key)
        out.push(row)
      }
    }
  }
  return out.slice(0, 6)
}

function appendVoicePromptToVideoPrompt({ prompt, policy, characters = [] } = {}) {
  const base = String(prompt || '').trim()
  if (!base || /(^|\n)VOICE CONTINUITY\b/i.test(base)) return base
  const effectivePolicy = policy?.key === 'silent' || !policy
    ? POLICIES.native_audio_prompt
    : policy
  const block = buildVoicePromptPreview({ policy: effectivePolicy, characters })
  if (!/^VOICE CONTINUITY/i.test(block)) return base
  return `${base}\n\n${block}`
}

export {
  POLICIES,
  appendVoicePromptToVideoPrompt,
  buildVoicePromptPreview,
  classifyVideoVoicePolicy,
  generatedVoiceStyle,
  storyboardVoiceCharacters,
  videoVoicePolicyForConfig,
}
