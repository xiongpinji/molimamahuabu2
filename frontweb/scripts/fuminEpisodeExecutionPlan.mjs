import crypto from 'node:crypto'

export const FUMIN_PROVIDER_DURATION_SECONDS = 5

const MAX_KEEP_DURATION_MS = FUMIN_PROVIDER_DURATION_SECONDS * 1000
const HEX_64 = /^[a-f0-9]{64}$/i
const CJK_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const FORBIDDEN_RUNTIME_FIELD_TOKENS = new Set([
  'provider', 'model', 'key', 'secret', 'token', 'credential', 'password',
  'url', 'uri', 'endpoint', 'apikey', 'baseurl', 'authorization', 'auth',
  'header', 'headers', 'cookie',
])
const ALLOWED_DOMAIN_FIELD_KEYS = new Set(['source_character_key'])
const DIALOGUE_STRING_FIELDS = [
  'id', 'speaker_id', 'speaker_kind', 'speaker_name', 'emotion', 'pronunciation_hint',
]

function fail(code, detail = '') {
  const error = new Error(detail ? `${code}: ${detail}` : code)
  error.code = code
  throw error
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isObject(value)) {
    const entries = Object.keys(value)
      .filter((key) => JSON.stringify(value[key]) !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Canonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function requireId(value, code) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) fail(code)
  return id
}

function requireHash(value, code) {
  const hash = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!HEX_64.test(hash)) fail(code)
  return hash
}

function referenceId(reference, type, bindingKey, bindingId, sha256) {
  if (reference.id != null && String(reference.id).trim()) {
    return requireId(reference.id, `FUMIN_EXECUTION_${type.toUpperCase()}_REFERENCE_INVALID`)
  }
  return `${type}-ref-${sha256Canonical({ type, [bindingKey]: bindingId, sha256 })}`
}

function assertNoRuntimeFields(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoRuntimeFields)
    return
  }
  if (!isObject(value)) return
  for (const [key, item] of Object.entries(value)) {
    const tokens = key
      .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
      .split(/[^A-Za-z0-9]+/u)
      .filter(Boolean)
      .map((token) => token.toLowerCase())
    if (!ALLOWED_DOMAIN_FIELD_KEYS.has(key)
      && tokens.some((token) => FORBIDDEN_RUNTIME_FIELD_TOKENS.has(token))) {
      fail('FUMIN_EXECUTION_RUNTIME_CONFIG_FORBIDDEN', key)
    }
    assertNoRuntimeFields(item)
  }
}

function normalizeIdentityReferences(references) {
  if (!Array.isArray(references)) fail('FUMIN_EXECUTION_IDENTITY_REFERENCES_INVALID')
  const seen = new Set()
  return references.map((reference) => {
    if (!isObject(reference)) fail('FUMIN_EXECUTION_IDENTITY_REFERENCE_INVALID')
    const characterId = String(reference.character_id || '').trim()
    const sourceCharacterKey = String(reference.source_character_key || '').trim()
    if ((!characterId && !sourceCharacterKey)
      || (characterId && sourceCharacterKey && characterId !== sourceCharacterKey)) {
      fail('FUMIN_EXECUTION_IDENTITY_REFERENCE_AMBIGUOUS')
    }
    const bindingId = characterId || sourceCharacterKey
    const sha256 = requireHash(
      reference.sha256,
      'FUMIN_EXECUTION_IDENTITY_REFERENCE_HASH_INVALID',
    )
    const id = referenceId(reference, 'identity', 'character_id', bindingId, sha256)
    if (seen.has(id)) fail('FUMIN_EXECUTION_IDENTITY_REFERENCE_DUPLICATE', id)
    seen.add(id)
    return {
      id,
      character_id: bindingId,
      sha256,
    }
  })
}

function normalizeMotionReferences(references) {
  if (!Array.isArray(references)) fail('FUMIN_EXECUTION_MOTION_REFERENCES_INVALID')
  const seen = new Set()
  return references.map((reference) => {
    if (!isObject(reference)) fail('FUMIN_EXECUTION_MOTION_REFERENCE_INVALID')
    const shotId = requireId(reference.shot_id, 'FUMIN_EXECUTION_MOTION_REFERENCE_INVALID')
    const sha256 = requireHash(
      reference.sha256,
      'FUMIN_EXECUTION_MOTION_REFERENCE_HASH_INVALID',
    )
    const id = referenceId(reference, 'motion', 'shot_id', shotId, sha256)
    if (seen.has(id)) fail('FUMIN_EXECUTION_MOTION_REFERENCE_DUPLICATE', id)
    seen.add(id)
    return {
      id,
      shot_id: shotId,
      sha256,
    }
  })
}

function normalizeCharacters(characters, shotId) {
  if (!Array.isArray(characters)) fail('FUMIN_EXECUTION_CHARACTERS_INVALID', shotId)
  const seen = new Set()
  return characters.map((character) => {
    if (!isObject(character)) fail('FUMIN_EXECUTION_CHARACTER_INVALID', shotId)
    const id = requireId(character.id, 'FUMIN_EXECUTION_CHARACTER_INVALID')
    if (seen.has(id)) fail('FUMIN_EXECUTION_CHARACTER_DUPLICATE', id)
    seen.add(id)
    const declaredHashes = Array.isArray(character.identity_hashes)
      ? character.identity_hashes
      : []
    const assetHashes = (Array.isArray(character.assets) ? character.assets : [])
      .filter((asset) => asset?.kind === 'identity')
      .map((asset) => asset.sha256)
    const identityHashes = [...new Set([...declaredHashes, ...assetHashes]
      .map((hash) => requireHash(hash, 'FUMIN_EXECUTION_IDENTITY_ASSET_HASH_INVALID')))]
    return { id, identity_hashes: identityHashes }
  })
}

function normalizeDialogue(dialogue, pack) {
  if (!Array.isArray(dialogue)) fail('FUMIN_EXECUTION_DIALOGUE_INVALID', pack.shot_id)
  return dialogue.map((turn) => {
    if (!isObject(turn)) fail('FUMIN_EXECUTION_DIALOGUE_INVALID', pack.shot_id)
    assertNoRuntimeFields(turn)
    const startMs = Number(turn.start_ms)
    const endMs = Number(turn.end_ms)
    if (!Number.isSafeInteger(startMs)
      || !Number.isSafeInteger(endMs)
      || startMs < pack.start_ms
      || endMs > pack.end_ms
      || endMs <= startMs
      || typeof turn.text !== 'string'
      || !turn.text.trim()) {
      fail('FUMIN_EXECUTION_DIALOGUE_TIMELINE_INVALID', pack.shot_id)
    }
    const normalized = {
      text: turn.text.trim(),
      start_ms: startMs,
      end_ms: endMs,
    }
    for (const field of DIALOGUE_STRING_FIELDS) {
      const value = String(turn[field] ?? '').trim()
      if (value) normalized[field] = value
    }
    return normalized
  })
}

function normalizePack(pack, previousEnd, seenShotIds) {
  if (!isObject(pack)) fail('FUMIN_EXECUTION_PRODUCTION_PACK_INVALID')
  const shotId = requireId(pack.shot_id, 'FUMIN_EXECUTION_SHOT_ID_INVALID')
  if (seenShotIds.has(shotId)) fail('FUMIN_EXECUTION_SHOT_ID_DUPLICATE', shotId)
  seenShotIds.add(shotId)

  const startMs = Number(pack.start_ms)
  const endMs = Number(pack.end_ms)
  const durationMs = Number(pack.duration_ms)
  if (!Number.isSafeInteger(startMs)
    || !Number.isSafeInteger(endMs)
    || !Number.isSafeInteger(durationMs)
    || startMs < 0
    || endMs <= startMs
    || durationMs !== endMs - startMs) {
    fail('FUMIN_EXECUTION_PRODUCTION_PACK_TIMELINE_INVALID', shotId)
  }
  if (previousEnd !== null && startMs !== previousEnd) {
    fail('FUMIN_EXECUTION_PRODUCTION_PACKS_NON_CONTIGUOUS', shotId)
  }
  if (durationMs > MAX_KEEP_DURATION_MS * 2) {
    fail('FUMIN_EXECUTION_DURATION_UNSUPPORTED', shotId)
  }
  if (typeof pack.prompt !== 'string' || !pack.prompt.trim()) {
    fail('FUMIN_EXECUTION_PROMPT_INVALID', shotId)
  }

  const normalized = {
    ...pack,
    shot_id: shotId,
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: durationMs,
    production_pack_hash: requireHash(
      pack.production_pack_hash,
      'FUMIN_EXECUTION_PRODUCTION_PACK_HASH_INVALID',
    ),
  }
  normalized.characters = normalizeCharacters(pack.characters, shotId)
  normalized.dialogue = normalizeDialogue(pack.dialogue, normalized)
  return normalized
}

function identityIdsForPack(identityReferences, pack) {
  const ids = []
  for (const character of pack.characters) {
    const matches = identityReferences.filter((reference) => reference.character_id === character.id)
    const requiredHashes = new Set(character.identity_hashes)
    for (const hash of character.identity_hashes) {
      const hashMatches = matches.filter((reference) => reference.sha256 === hash)
      if (hashMatches.length === 0) fail('FUMIN_EXECUTION_IDENTITY_REFERENCE_MISSING', character.id)
      if (hashMatches.length > 1) fail('FUMIN_EXECUTION_IDENTITY_REFERENCE_AMBIGUOUS', character.id)
      ids.push(hashMatches[0].id)
    }
    if (matches.some((reference) => !requiredHashes.has(reference.sha256))) {
      fail('FUMIN_EXECUTION_IDENTITY_REFERENCE_STALE', character.id)
    }
  }
  return [...new Set(ids)].sort()
}

function motionIdForPack(motionReferences, pack) {
  const expected = (Array.isArray(pack.visual_contract?.references)
    ? pack.visual_contract.references
    : []).filter((reference) => reference?.kind === 'motion')
  if (expected.length > 1) fail('FUMIN_EXECUTION_MOTION_REFERENCE_AMBIGUOUS', pack.shot_id)
  const expectedHash = expected.length === 1
    ? requireHash(expected[0].sha256, 'FUMIN_EXECUTION_MOTION_REFERENCE_HASH_INVALID')
    : null
  const matches = motionReferences.filter((reference) => reference.shot_id === pack.shot_id)
  if (matches.length > 1) fail('FUMIN_EXECUTION_MOTION_REFERENCE_AMBIGUOUS', pack.shot_id)
  if (matches.length === 0) {
    if (expectedHash) fail('FUMIN_EXECUTION_MOTION_REFERENCE_MISSING', pack.shot_id)
    return null
  }
  if (expectedHash && matches[0].sha256 !== expectedHash) {
    fail('FUMIN_EXECUTION_MOTION_REFERENCE_HASH_MISMATCH', pack.shot_id)
  }
  return matches[0].id
}

function isSafeBoundary(dialogue, absoluteBoundary) {
  return dialogue.every((turn) => (
    absoluteBoundary <= turn.start_ms || absoluteBoundary >= turn.end_ms
  ))
}

function splitPack(pack) {
  if (pack.duration_ms <= MAX_KEEP_DURATION_MS) {
    return [{ start_ms: pack.start_ms, end_ms: pack.end_ms }]
  }

  const lowerBoundary = pack.duration_ms - MAX_KEEP_DURATION_MS
  const preferredBoundary = MAX_KEEP_DURATION_MS
  let localBoundary = preferredBoundary
  if (!isSafeBoundary(pack.dialogue, pack.start_ms + preferredBoundary)) {
    const candidates = new Set()
    for (const turn of pack.dialogue) {
      for (const absoluteBoundary of [turn.start_ms, turn.end_ms]) {
        const candidate = absoluteBoundary - pack.start_ms
        if (candidate >= lowerBoundary
          && candidate <= preferredBoundary
          && isSafeBoundary(pack.dialogue, absoluteBoundary)) {
          candidates.add(candidate)
        }
      }
    }
    const ordered = [...candidates].sort((left, right) => (
      Math.abs(preferredBoundary - left) - Math.abs(preferredBoundary - right)
      || left - right
    ))
    if (ordered.length === 0) fail('FUMIN_EXECUTION_DIALOGUE_SPLIT_UNSAFE', pack.shot_id)
    localBoundary = ordered[0]
  }

  const boundary = pack.start_ms + localBoundary
  return [
    { start_ms: pack.start_ms, end_ms: boundary },
    { start_ms: boundary, end_ms: pack.end_ms },
  ]
}

function dialogueForWindow(pack, window) {
  return pack.dialogue
    .filter((turn) => turn.start_ms >= window.start_ms && turn.end_ms <= window.end_ms)
    .map((turn) => ({
      ...clone(turn),
      start_ms: turn.start_ms - window.start_ms,
      end_ms: turn.end_ms - window.start_ms,
    }))
}

function normalizePromptLine(line) {
  return line.trim().replace(/^[-*]\s*/u, '').replace(/\s+/gu, ' ')
}

function parentPromptWithoutDialogue(prompt, dialogue) {
  const dialogueLines = new Set()
  const speakers = new Set()
  for (const turn of dialogue) {
    const text = normalizePromptLine(turn.text)
    dialogueLines.add(text)
    for (const speaker of [turn.speaker_name, turn.speaker_id]) {
      if (speaker) {
        speakers.add(normalizePromptLine(speaker).toLowerCase())
        dialogueLines.add(normalizePromptLine(`${speaker}: ${turn.text}`))
      }
    }
  }
  const kept = []
  let inDialogue = false
  for (const line of prompt.split(/\r?\n/u)) {
    if (/^\s*Dialogue\s*:/iu.test(line)) {
      inDialogue = true
      continue
    }
    if (!inDialogue) {
      kept.push(line)
      continue
    }
    const bullet = line.match(/^\s*[-*]\s*([^:\r\n]+):\s*.+$/u)
    const knownSpeaker = bullet && speakers.has(normalizePromptLine(bullet[1]).toLowerCase())
    if (knownSpeaker || dialogueLines.has(normalizePromptLine(line))) continue
    if (!/^\s*[-*]\s+/u.test(line) && /^\s*[A-Za-z][A-Za-z0-9 -]*:\s*/u.test(line)) {
      inDialogue = false
    }
    kept.push(line)
  }
  return kept.join('\n').trim()
}

function buildExecutionUnitPrompt(pack, dialogue) {
  const parent = parentPromptWithoutDialogue(pack.prompt, pack.dialogue)
  const dialogueText = dialogue.length > 0
    ? dialogue.map((turn) => {
      const speaker = String(turn.speaker_name || turn.speaker_id || '').trim()
      return speaker ? `${speaker}: ${turn.text.trim()}` : turn.text.trim()
    }).join(' ')
    : 'None. Do not add dialogue. Ambient sound only.'
  const prompt = `${parent}\nDialogue: ${dialogueText}`
  if (CJK_TEXT.test(prompt)) fail('FUMIN_EXECUTION_PROMPT_LANGUAGE_INVALID', pack.shot_id)
  return prompt
}

export function buildFuminEpisodeExecutionPlan(pkg) {
  if (!isObject(pkg) || !Array.isArray(pkg.production_packs) || pkg.production_packs.length === 0) {
    fail('FUMIN_EXECUTION_PACKAGE_INVALID')
  }
  assertNoRuntimeFields(pkg)
  const identityReferences = normalizeIdentityReferences(pkg.identity_references)
  const motionReferences = normalizeMotionReferences(pkg.motion_references)
  const seenShotIds = new Set()
  let previousEnd = null
  const packs = pkg.production_packs.map((pack) => {
    const normalized = normalizePack(pack, previousEnd, seenShotIds)
    previousEnd = normalized.end_ms
    return normalized
  })

  const units = []
  for (const pack of packs) {
    const windows = splitPack(pack)
    const identityReferenceIds = identityIdsForPack(identityReferences, pack)
    const motionReferenceId = motionIdForPack(motionReferences, pack)
    let assignedDialogue = 0
    windows.forEach((window, index) => {
      const dialogue = dialogueForWindow(pack, window)
      assignedDialogue += dialogue.length
      const keepDurationMs = window.end_ms - window.start_ms
      if (keepDurationMs <= 0 || keepDurationMs > MAX_KEEP_DURATION_MS) {
        fail('FUMIN_EXECUTION_UNIT_DURATION_INVALID', pack.shot_id)
      }
      units.push({
        schema_version: 'fumin-episode-execution-unit-v1',
        unit_id: `${pack.shot_id}.part-${String(index + 1).padStart(2, '0')}`,
        parent_shot_id: pack.shot_id,
        part_index: index + 1,
        part_count: windows.length,
        source_start_ms: window.start_ms,
        source_end_ms: window.end_ms,
        keep_duration_ms: keepDurationMs,
        provider_duration_seconds: FUMIN_PROVIDER_DURATION_SECONDS,
        parent_production_pack_hash: pack.production_pack_hash,
        dialogue,
        identity_reference_ids: identityReferenceIds,
        motion_reference_id: motionReferenceId,
        prompt: buildExecutionUnitPrompt(pack, dialogue),
      })
    })
    if (assignedDialogue !== pack.dialogue.length) {
      fail('FUMIN_EXECUTION_DIALOGUE_SPLIT_UNSAFE', pack.shot_id)
    }
  }

  const plan = {
    schema_version: 'redraw-provider-execution-plan-v1',
    provider: 'fumin',
    units,
  }
  plan.execution_plan_hash = sha256Canonical(plan)
  return plan
}
