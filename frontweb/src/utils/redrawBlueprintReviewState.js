const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const STABLE_ID = /^[a-zA-Z0-9._-]+$/
const SHA256 = /^[a-f0-9]{64}$/
const AUDIO_V2_SCHEMA = 'redraw-source-audio-evidence-v2'
const WINDOW_CLUSTER = /^aw([0-9]{6})-speaker-cluster-([1-9][0-9]*)$/

function inputError(message) {
  return new Error(`母本蓝图审核输入无效：${message}`)
}

function assertPlainData(value, name = 'blueprint', seen = new WeakSet()) {
  if (value == null || ['string', 'boolean'].includes(typeof value)) return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw inputError(`${name} 数值无效`)
    return
  }
  if (typeof value !== 'object') throw inputError(`${name} 类型无效`)
  if (seen.has(value)) throw inputError(`${name} 不允许循环引用`)
  seen.add(value)
  const isArray = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw inputError(`${name} 不允许继承字段或自定义原型`)
  }
  if (Object.getOwnPropertySymbols(value).length) throw inputError(`${name} 不允许符号字段`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (isArray && Object.keys(descriptors).length !== value.length + 1) {
    throw inputError(`${name} 必须是完整数组`)
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (isArray && key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      throw inputError(`${name}.${key} 数组字段无效`)
    }
    if (DANGEROUS_KEYS.has(key)) throw inputError(`${name}.${key} 是危险字段`)
    if (!Object.hasOwn(descriptor, 'value')) throw inputError(`${name}.${key} 不允许访问器`)
    assertPlainData(descriptor.value, `${name}.${key}`, seen)
  }
  seen.delete(value)
}

function clonePlainData(value) {
  if (Array.isArray(value)) return value.map(clonePlainData)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePlainData(item)]))
  }
  return value
}

function requiredText(value, name, maxLength = 120) {
  if (typeof value !== 'string') throw inputError(`${name} 必填`)
  const text = value.trim()
  if (!text) throw inputError(`${name} 必填`)
  if (text.length > maxLength) throw inputError(`${name} 过长`)
  return text
}

function requiredStableId(value, name) {
  const id = requiredText(value, name, 96)
  if (!STABLE_ID.test(id)) throw inputError(`${name} 只能包含字母、数字、点、下划线和连字符`)
  return id
}

function assertBlueprint(blueprint) {
  assertPlainData(blueprint)
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) {
    throw inputError('blueprint 必须是对象')
  }
  if (!Array.isArray(blueprint.characters)) throw inputError('characters 必须是数组')
  if (!Array.isArray(blueprint.shots)) throw inputError('shots 必须是数组')
  const characterIds = new Set()
  for (const [index, character] of blueprint.characters.entries()) {
    const id = requiredStableId(character?.id, `characters[${index}].角色标识`)
    if (characterIds.has(id)) throw inputError(`角色标识重复：${id}`)
    characterIds.add(id)
  }
  for (const [index, shot] of blueprint.shots.entries()) {
    if (!Array.isArray(shot?.dialogue)) throw inputError(`shots[${index}].dialogue 必须是数组`)
    if (!Array.isArray(shot?.visible_character_ids)) {
      throw inputError(`shots[${index}].visible_character_ids 必须是数组`)
    }
  }
  return { characterIds }
}

function dialogueEntries(blueprint) {
  return blueprint.shots.flatMap((shot) => shot.dialogue.map((dialogue) => ({ shot, dialogue })))
}

function clusterNumber(value) {
  const match = /^(?:aw[0-9]{6}-)?speaker-cluster-([1-9][0-9]*)$/.exec(value)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function compareClusters(left, right) {
  const windowNumber = (id) => Number(WINDOW_CLUSTER.exec(id)?.[1] || 0)
  return windowNumber(left.id) - windowNumber(right.id) || clusterNumber(left.id) - clusterNumber(right.id)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

function normalizedRecordStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  if (Object.hasOwn(value, 'status')) return String(value.status || '').trim()
  if (value.blueprint && typeof value.blueprint === 'object' && Object.hasOwn(value.blueprint, 'status')) {
    return String(value.blueprint.status || '').trim()
  }
  return ''
}

export function canStartLocalization(blueprintRecord) {
  return normalizedRecordStatus(blueprintRecord) === 'locked'
}

export function dialogueSourceForReview(record, blueprint, shotId, dialogueId) {
  const unavailable = { status: 'not_available' }
  const unresolved = { status: 'unresolved' }
  try {
    assertPlainData(record, 'record')
    assertPlainData(blueprint)
  } catch { return unresolved }
  if (!Array.isArray(record?.source_dialogue)) return unavailable
  const matches = record.source_dialogue.filter((item) => item?.shot_id === shotId && item?.dialogue_id === dialogueId)
  if (matches.length !== 1) return unresolved
  const source = matches[0]
  const isV2 = source.audio_evidence_schema_version === AUDIO_V2_SCHEMA
  if (source.status !== 'resolved') return source.status === 'not_available' ? unavailable : unresolved
  const shot = blueprint?.shots?.find((item) => item.id === shotId)
  const turns = shot?.dialogue?.filter((item) => item.id === dialogueId) || []
  const turn = turns[0]
  const persistedShots = record.blueprint?.shots?.filter((item) => item.id === shotId) || []
  const persistedTurns = persistedShots[0]?.dialogue?.filter((item) => item.id === dialogueId) || []
  const evidence = blueprint?.evidence_manifest?.items?.filter((item) => item.id === source.evidence_ref) || []
  if (isV2) {
    try {
      const saved = selectedDialogues(record.blueprint, [dialogueId]).entries[0]
      const current = selectedDialogues(blueprint, [dialogueId]).entries[0]
      if (record.source_dialogue.filter((item) => item.dialogue_id === dialogueId).length !== 1
        || saved.shot.id !== shotId || current.shot.id !== shotId
        || blueprint.shots.filter((item) => item.id === shotId).length !== 1
        || record.blueprint_hash !== record.blueprint.blueprint_hash
        || !positiveAssetId(blueprint.source?.asset_id)
        || !sameAudioManifest(record, blueprint, source)
        || source.source_text !== saved.dialogue.source_text || source.source_language !== saved.dialogue.source_language
        || source.projection_start_ms !== saved.dialogue.start_ms || source.projection_end_ms !== saved.dialogue.end_ms
        || !saved.dialogue.evidence_refs.includes(source.evidence_ref)
        || !validSourceRange(source.source_start_ms, source.source_end_ms, record.blueprint.source.duration_ms, saved.shot, true)) return unresolved
      if (source.source_origin === 'manual_correction') {
        if (!sameSourceCorrection(saved.dialogue.source_correction, {
          evidence_ref: source.evidence_ref, evidence_sha256: source.evidence_sha256,
          original_source_text: source.original_source_text, original_start_ms: source.original_start_ms, original_end_ms: source.original_end_ms,
          source_start_ms: source.source_start_ms, source_end_ms: source.source_end_ms,
        })) return unresolved
      } else if (saved.dialogue.source_correction !== undefined) return unresolved
    } catch { return unresolved }
  }
  if (!shot || turns.length !== 1 || persistedShots.length !== 1 || persistedTurns.length !== 1
    || !sameSourceCorrection(turn.source_correction, persistedTurns[0].source_correction)
    || record.blueprint_hash !== blueprint.blueprint_hash
    || !SHA256.test(record.blueprint_hash || '')
    || !SHA256.test(blueprint.source?.sha256 || '')
    || blueprint.source?.sha256 !== record.blueprint?.source?.sha256
    || blueprint.source?.asset_id !== record.blueprint?.source?.asset_id
    || blueprint.source?.duration_ms !== record.blueprint?.source?.duration_ms
    || !blueprint.source?.asset_id
    || !Number.isSafeInteger(blueprint.source?.duration_ms) || blueprint.source.duration_ms <= 0
    || source.source_text !== turn.source_text || source.source_language !== turn.source_language
    || source.projection_start_ms !== turn.start_ms || source.projection_end_ms !== turn.end_ms
    || !turn.evidence_refs?.includes(source.evidence_ref)
    || evidence.length !== 1 || evidence[0].sha256 !== source.evidence_sha256
    || !SHA256.test(source.evidence_sha256 || '')
    || !validDialogueMilliseconds(source.source_start_ms, isV2) || !validDialogueMilliseconds(source.source_end_ms, isV2)
    || source.source_start_ms < 0 || source.source_end_ms <= source.source_start_ms
    || source.source_end_ms > blueprint.source.duration_ms
    || isV2 && !validSourceRange(source.source_start_ms, source.source_end_ms, blueprint.source.duration_ms, shot, true)
    || Math.max(source.source_start_ms, shot.start_ms) !== turn.start_ms
    || Math.min(source.source_end_ms, shot.end_ms) !== turn.end_ms) return unresolved
  return {
    ...source,
    cross_shot: source.source_start_ms < shot.start_ms || source.source_end_ms > shot.end_ms,
  }
}

const SOURCE_CORRECTION_FIELDS = ['evidence_ref', 'evidence_sha256', 'original_source_text',
  'original_start_ms', 'original_end_ms', 'source_start_ms', 'source_end_ms']

function sameSourceCorrection(left, right) {
  if (left === undefined && right === undefined) return true
  return !!left && !!right && typeof left === 'object' && typeof right === 'object'
    && Object.keys(left).length === SOURCE_CORRECTION_FIELDS.length
    && Object.keys(right).length === SOURCE_CORRECTION_FIELDS.length
    && SOURCE_CORRECTION_FIELDS.every((key) => Object.hasOwn(left, key) && Object.hasOwn(right, key) && left[key] === right[key])
}

function validDialogueMilliseconds(value, isV2) {
  return isV2 ? typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER : Number.isSafeInteger(value)
}

function positiveAssetId(value) {
  return (typeof value === 'number' || typeof value === 'string' && /^[1-9][0-9]*$/.test(value))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0
}

function sameAudioManifest(record, blueprint, source) {
  const saved = record.blueprint?.evidence_manifest?.items?.filter((item) => item.id === source.evidence_ref) || []
  const current = blueprint?.evidence_manifest?.items?.filter((item) => item.id === source.evidence_ref) || []
  return saved.length === 1 && current.length === 1 && positiveAssetId(saved[0].asset_id)
    && current[0].asset_id === saved[0].asset_id && current[0].sha256 === saved[0].sha256
    && current[0].sha256 === source.evidence_sha256 && current[0].kind === saved[0].kind
    && ['asr', 'audio', 'audio_transcript', 'transcript'].includes(current[0].kind)
}

function validSourceRange(start, end, duration, shot, isV2 = false) {
  return validDialogueMilliseconds(start, isV2) && validDialogueMilliseconds(end, isV2)
    && Number.isSafeInteger(duration) && start >= 0 && start < end && end <= duration
    && Number.isSafeInteger(shot.start_ms) && Number.isSafeInteger(shot.end_ms)
    && shot.start_ms >= 0 && shot.start_ms < shot.end_ms && shot.end_ms <= duration
    && Math.max(start, shot.start_ms) < Math.min(end, shot.end_ms)
}

export function dialogueOriginalForReview(record, blueprint, shotId, dialogueId) {
  try {
    assertPlainData(record, 'record')
    const persisted = selectedDialogues(record?.blueprint, [dialogueId]).entries[0]
    const current = selectedDialogues(blueprint, [dialogueId]).entries[0]
    correctionId(shotId, '镜头标识')
    const source = dialogueSourceForReview(record, record.blueprint, persisted.shot.id, dialogueId)
    if (source.status !== 'resolved') return { status: source.status }
    const isV2 = source.audio_evidence_schema_version === AUDIO_V2_SCHEMA
    if ((!isV2 && persisted.shot.id !== shotId) || current.shot.id !== shotId
      || blueprint.shots.filter((shot) => shot.id === shotId).length !== 1
      || record.blueprint.shots.filter((shot) => shot.id === persisted.shot.id).length !== 1) return { status: 'unresolved' }
    if (isV2) {
      boundaryShots(record.blueprint)
      boundaryShots(blueprint)
      if (!sameAudioManifest(record, blueprint, source)
        || blueprint.shots.length !== record.blueprint.shots.length
        || blueprint.shots.some((shot, index) => shot.id !== record.blueprint.shots[index].id)) return { status: 'unresolved' }
    }
    const original = source.source_origin === 'manual_correction'
      ? { evidence_ref: source.evidence_ref, evidence_sha256: source.evidence_sha256,
        original_source_text: source.original_source_text, original_start_ms: source.original_start_ms, original_end_ms: source.original_end_ms }
      : { evidence_ref: source.evidence_ref, evidence_sha256: source.evidence_sha256,
        original_source_text: source.source_text, original_start_ms: source.source_start_ms, original_end_ms: source.source_end_ms }
    requiredText(original.original_source_text, '原始识别文字', 16384)
    if (original.original_source_text.length > 16384 || original.original_source_text.includes('\0')
      || !validSourceRange(original.original_start_ms, original.original_end_ms, blueprint.source?.duration_ms,
        isV2 ? { start_ms: 0, end_ms: blueprint.source.duration_ms } : current.shot, isV2)
      || blueprint.blueprint_hash !== record.blueprint_hash
      || blueprint.source?.asset_id !== record.blueprint.source.asset_id
      || blueprint.source?.sha256 !== record.blueprint.source.sha256
      || blueprint.source?.duration_ms !== record.blueprint.source.duration_ms
      || !isV2 && (current.shot.start_ms !== persisted.shot.start_ms || current.shot.end_ms !== persisted.shot.end_ms)
      || current.dialogue.source_language !== persisted.dialogue.source_language
      || JSON.stringify(current.dialogue.evidence_refs) !== JSON.stringify(persisted.dialogue.evidence_refs)) return { status: 'unresolved' }
    const evidence = blueprint.evidence_manifest?.items?.filter((item) => item.id === source.evidence_ref) || []
    if (evidence.length !== 1 || evidence[0].sha256 !== source.evidence_sha256
      || !['asr', 'audio', 'audio_transcript', 'transcript'].includes(evidence[0].kind)) return { status: 'unresolved' }
    if (source.source_origin === 'manual_correction') {
      if (!sameSourceCorrection(persisted.dialogue.source_correction,
        { ...original, source_start_ms: source.source_start_ms, source_end_ms: source.source_end_ms })) return { status: 'unresolved' }
    } else if (persisted.dialogue.source_correction !== undefined) return { status: 'unresolved' }
    const correction = current.dialogue.source_correction
    if (correction !== undefined && (!sameSourceCorrection(correction, { ...original,
      source_start_ms: correction?.source_start_ms, source_end_ms: correction?.source_end_ms })
      || !validSourceRange(correction.source_start_ms, correction.source_end_ms, blueprint.source.duration_ms, current.shot, isV2))) {
      return { status: 'unresolved' }
    }
    if (isV2) {
      const start = correction?.source_start_ms ?? original.original_start_ms
      const end = correction?.source_end_ms ?? original.original_end_ms
      if (!validSourceRange(start, end, blueprint.source.duration_ms, current.shot, true)
        || current.dialogue.start_ms !== Math.max(start, current.shot.start_ms)
        || current.dialogue.end_ms !== Math.min(end, current.shot.end_ms)) return { status: 'unresolved' }
    }
    return { status: 'resolved', ...original }
  } catch {
    return { status: 'unresolved' }
  }
}

function hasV2DialogueContext(record, blueprint, shotId, dialogueId) {
  return dialogueOriginalForReview(record, blueprint, shotId, dialogueId).status === 'resolved'
    && record.source_dialogue.find((item) => item.dialogue_id === dialogueId)?.audio_evidence_schema_version === AUDIO_V2_SCHEMA
}

function sourceCorrectionContext(record, blueprint, shotId, dialogueId) {
  assertPlainData(record, 'record')
  assertBlueprint(blueprint)
  if (normalizedRecordStatus(record) === 'locked') throw inputError('已锁定蓝图不可纠错')
  const original = dialogueOriginalForReview(record, blueprint, shotId, dialogueId)
  if (original.status !== 'resolved') throw inputError('原始识别证据未核验或已变化，请刷新后复核')
  const { shot, dialogue } = selectedDialogues(blueprint, [dialogueId]).entries[0]
  const isV2 = record.source_dialogue.find((item) => item.dialogue_id === dialogueId)?.audio_evidence_schema_version === AUDIO_V2_SCHEMA
  return { original, shot, dialogue, isV2 }
}

export function applyDialogueSourceCorrection(record, blueprint, shotId, dialogueId, input) {
  correctionOptions(input, ['source_text', 'source_start_ms', 'source_end_ms'])
  const { original, shot, isV2 } = sourceCorrectionContext(record, blueprint, shotId, dialogueId)
  const text = requiredText(input.source_text, '修订文字', 500)
  if (text.includes('\0')) throw inputError('修订文字不允许 NUL 字符')
  if (!validSourceRange(input.source_start_ms, input.source_end_ms, blueprint.source.duration_ms, shot, isV2)) {
    throw inputError('完整时间范围必须符合已核验来源精度，位于源片内且与所属镜头相交')
  }
  const next = clonePlainData(blueprint)
  const dialogue = next.shots.find((item) => item.id === shotId).dialogue.find((item) => item.id === dialogueId)
  const { status: _status, ...anchor } = original
  dialogue.source_text = text
  dialogue.start_ms = Math.max(input.source_start_ms, shot.start_ms)
  dialogue.end_ms = Math.min(input.source_end_ms, shot.end_ms)
  dialogue.source_correction = { ...anchor, source_start_ms: input.source_start_ms, source_end_ms: input.source_end_ms }
  dialogue.review_status = 'needs_review'
  next.review = { ...(next.review || {}), status: 'needs_review' }
  delete next.review.reviewer
  return next
}

export function restoreDialogueSourceCorrection(record, blueprint, shotId, dialogueId) {
  const { original } = sourceCorrectionContext(record, blueprint, shotId, dialogueId)
  const next = applyDialogueSourceCorrection(record, blueprint, shotId, dialogueId, {
    source_text: original.original_source_text, source_start_ms: original.original_start_ms, source_end_ms: original.original_end_ms,
  })
  delete next.shots.find((shot) => shot.id === shotId).dialogue.find((dialogue) => dialogue.id === dialogueId).source_correction
  return next
}

function shiftDecimal(value, places) {
  const [mantissa, exponent = '0'] = value.toLowerCase().split('e')
  const [whole, fraction = ''] = mantissa.split('.')
  const digits = whole + fraction
  const point = whole.length + Number(exponent) + places
  const shifted = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`
  return shifted.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

export function dialogueMillisecondsToSeconds(value) {
  if (!validDialogueMilliseconds(value, true)) throw inputError('毫秒数无效')
  return shiftDecimal(String(value), -3)
}

export function dialogueSecondsToMilliseconds(value, record, blueprint, shotId, dialogueId) {
  const isV2 = hasV2DialogueContext(record, blueprint, shotId, dialogueId)
  if (typeof value !== 'string' || !(isV2 ? /^(0|[1-9][0-9]*)(\.[0-9]+)?$/ : /^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/).test(value)) {
    throw inputError(isV2 ? '秒数须为非负十进制数' : '秒数须为非负十进制数，最多三位小数')
  }
  if (isV2) {
    const shifted = shiftDecimal(value, 3)
    const [whole, fraction = ''] = shifted.split('.')
    const maximum = BigInt(Number.MAX_SAFE_INTEGER)
    if (BigInt(whole) > maximum || BigInt(whole) === maximum && /[1-9]/.test(fraction)) throw inputError('秒数超出安全范围')
    const milliseconds = Number(shifted)
    if (!validDialogueMilliseconds(milliseconds, true) || milliseconds === 0 && /[1-9]/.test(shifted)) throw inputError('秒数超出安全范围')
    return milliseconds
  }
  const [seconds, fraction = ''] = value.split('.')
  const milliseconds = BigInt(seconds) * 1000n + BigInt(fraction.padEnd(3, '0'))
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw inputError('秒数超出安全范围')
  return Number(milliseconds)
}

function boundaryShots(blueprint) {
  assertBlueprint(blueprint)
  const duration = blueprint.source?.duration_ms
  if (!Number.isSafeInteger(duration) || duration <= 0 || !blueprint.shots.length) throw inputError('源片时长无效')
  const asset = blueprint.source?.asset_id
  if (!(typeof asset === 'number' || typeof asset === 'string' && /^[1-9][0-9]*$/.test(asset))
    || !Number.isSafeInteger(Number(asset)) || Number(asset) <= 0) throw inputError('源片资产标识无效')
  const ids = new Set(), dialogueIds = new Set()
  let end = 0
  for (const shot of blueprint.shots) {
    const id = correctionId(shot.id, '镜头标识')
    if (!shot.audio_contract || typeof shot.audio_contract !== 'object' || Array.isArray(shot.audio_contract)) {
      throw inputError('镜头音频合同必须是对象')
    }
    if (ids.has(id) || shot.start_ms !== end || !Number.isSafeInteger(shot.end_ms)
      || shot.end_ms <= end || shot.end_ms > duration) throw inputError('镜头须按原顺序连续覆盖源片且标识唯一')
    ids.add(id); end = shot.end_ms
    for (const line of shot.dialogue) {
      const dialogueId = correctionId(line?.id, '对白标识')
      if (dialogueIds.has(dialogueId)) throw inputError('对白标识必须全局唯一')
      dialogueIds.add(dialogueId)
    }
  }
  if (end !== duration) throw inputError('镜头须完整覆盖源片')
  return dialogueIds
}

// This path verifies persisted anchors by stable ID; it does not resolve a new draft projection on behalf of the server.
function boundaryDialogue(record, blueprint, entry) {
  const { dialogue, shot } = entry
  const persisted = dialogueEntries(record.blueprint).filter((item) => item.dialogue.id === dialogue.id)
  const dto = record.source_dialogue?.filter((item) => item.dialogue_id === dialogue.id)
  if (persisted.length !== 1 || dto?.length !== 1) throw inputError('缺少唯一完整原句证据，请刷新后复核')
  const previous = persisted[0]
  const source = dialogueSourceForReview(record, record.blueprint, previous.shot.id, dialogue.id)
  if (source.status !== 'resolved') throw inputError('完整原句证据未核验或已变化，请刷新后复核')
  const isV2 = source.audio_evidence_schema_version === AUDIO_V2_SCHEMA
  if (isV2 && !hasV2DialogueContext(record, blueprint, shot.id, dialogue.id)) throw inputError('完整原句上下文已变化')
  const original = source.source_origin === 'manual_correction'
    ? { evidence_ref: source.evidence_ref, evidence_sha256: source.evidence_sha256,
      original_source_text: source.original_source_text, original_start_ms: source.original_start_ms, original_end_ms: source.original_end_ms }
    : { evidence_ref: source.evidence_ref, evidence_sha256: source.evidence_sha256,
      original_source_text: source.source_text, original_start_ms: source.source_start_ms, original_end_ms: source.source_end_ms }
  const fullSource = { start_ms: 0, end_ms: blueprint.source.duration_ms }
  const evidence = blueprint.evidence_manifest?.items?.filter((item) => item.id === original.evidence_ref) || []
  requiredText(original.original_source_text, '原始识别文字', 16384)
  if (original.original_source_text.includes('\0')
    || !validSourceRange(original.original_start_ms, original.original_end_ms, fullSource.end_ms, fullSource, isV2)
    || evidence.length !== 1 || evidence[0].sha256 !== original.evidence_sha256
    || !['asr', 'audio', 'audio_transcript', 'transcript'].includes(evidence[0].kind)
    || dialogue.source_language !== previous.dialogue.source_language
    || JSON.stringify(dialogue.evidence_refs) !== JSON.stringify(previous.dialogue.evidence_refs)) {
    throw inputError('原始 ASR 锚点或证据引用已变化')
  }
  if (source.source_origin === 'manual_correction'
    ? !sameSourceCorrection(previous.dialogue.source_correction, { ...original, source_start_ms: source.source_start_ms, source_end_ms: source.source_end_ms })
    : previous.dialogue.source_correction !== undefined) throw inputError('已保存原句修订锚点无效')
  const correction = dialogue.source_correction
  const start = correction?.source_start_ms ?? original.original_start_ms
  const end = correction?.source_end_ms ?? original.original_end_ms
  if (correction !== undefined) {
    if (!sameSourceCorrection(correction, { ...original, source_start_ms: start, source_end_ms: end })) throw inputError('人工修订原句锚点不可改变')
    requiredText(dialogue.source_text, '修订文字', 500)
    if (dialogue.source_text.includes('\0')) throw inputError('修订文字无效')
  } else if (dialogue.source_text !== original.original_source_text) throw inputError('原句文字发生未锚定的修订')
  if (!validSourceRange(start, end, fullSource.end_ms, shot, isV2)
    || dialogue.start_ms !== Math.max(start, shot.start_ms) || dialogue.end_ms !== Math.min(end, shot.end_ms)) {
    throw inputError('完整原句范围或当前镜头投影无效')
  }
  return { dialogue_id: dialogue.id, current_shot_id: shot.id, source_start_ms: start, source_end_ms: end, source_text: dialogue.source_text }
}

function boundaryCorrectionContext(record, blueprint, leftShotId, rightShotId, boundaryMs) {
  assertPlainData(record, 'record')
  const currentIds = boundaryShots(blueprint), previousIds = boundaryShots(record?.blueprint)
  if (normalizedRecordStatus(record) === 'locked') throw inputError('已锁定蓝图不可纠错')
  correctionId(leftShotId, '左镜头标识'); correctionId(rightShotId, '右镜头标识')
  if (!SHA256.test(record.blueprint_hash || '') || record.blueprint_hash !== blueprint.blueprint_hash
    || record.blueprint_hash !== record.blueprint.blueprint_hash
    || !SHA256.test(blueprint.source?.sha256 || '') || !blueprint.source.asset_id
    || ['asset_id', 'sha256', 'duration_ms'].some((key) => blueprint.source[key] !== record.blueprint.source[key])
    || blueprint.shots.length !== record.blueprint.shots.length
    || blueprint.shots.some((shot, index) => shot.id !== record.blueprint.shots[index].id)
    || currentIds.size !== previousIds.size || [...currentIds].some((id) => !previousIds.has(id))) {
    throw inputError('源片、版本或稳定标识已变化，请刷新后复核')
  }
  const index = blueprint.shots.findIndex((shot) => shot.id === leftShotId)
  const left = blueprint.shots[index], right = blueprint.shots[index + 1]
  if (!left || right?.id !== rightShotId) throw inputError('只能调整按原顺序相邻的两个镜头')
  if (!Number.isSafeInteger(boundaryMs) || boundaryMs <= left.start_ms || boundaryMs >= right.end_ms) {
    throw inputError('公共切点须为相邻两镜内部的安全整数毫秒，不能形成零长镜头')
  }
  const shots = blueprint.shots.map((shot) => ({ ...shot,
    ...(shot.id === leftShotId ? { end_ms: boundaryMs } : shot.id === rightShotId ? { start_ms: boundaryMs } : {}) }))
  const entries = dialogueEntries(blueprint).filter(({ shot }) => [leftShotId, rightShotId].includes(shot.id))
  const turns = entries.map((entry) => {
    const source = boundaryDialogue(record, blueprint, entry)
    return { ...source, target_shots: shots.filter((shot) => {
      return Math.max(source.source_start_ms, shot.start_ms) < Math.min(source.source_end_ms, shot.end_ms)
        && !(entry.dialogue.speaker_kind === 'character' && entry.dialogue.off_screen !== true
          && !shot.visible_character_ids.includes(entry.dialogue.speaker_id))
    }).map((shot) => shot.id) }
  })
  return { shots, turns, left, right }
}

export function boundaryCorrectionForReview(record, blueprint, leftShotId, rightShotId, boundaryMs) {
  try {
    const { turns } = boundaryCorrectionContext(record, blueprint, leftShotId, rightShotId, boundaryMs)
    return { status: turns.length ? 'resolved' : 'pending_server_verification', turns }
  } catch (error) {
    return { status: 'unresolved', turns: [], reason: error.message }
  }
}

export function applyAdjacentBoundaryCorrection(record, blueprint, leftShotId, rightShotId, input) {
  correctionOptions(input, ['boundary_ms', 'assignments'])
  const { turns, left, right } = boundaryCorrectionContext(record, blueprint, leftShotId, rightShotId, input.boundary_ms)
  if (!Array.isArray(input.assignments) || input.assignments.length !== turns.length) throw inputError('归属选择须恰好覆盖两镜的全部对白')
  const assignments = new Map()
  for (const assignment of input.assignments) {
    correctionOptions(assignment, ['dialogue_id', 'target_shot_id'])
    correctionId(assignment.dialogue_id, '对白标识'); correctionId(assignment.target_shot_id, '目标镜头标识')
    const turn = turns.find((item) => item.dialogue_id === assignment.dialogue_id)
    if (!turn || assignments.has(assignment.dialogue_id) || !turn.target_shots.includes(assignment.target_shot_id)) {
      throw inputError('请为每句选择有效归属：完整原句须正相交且画内人物在目标镜头可见')
    }
    assignments.set(assignment.dialogue_id, assignment.target_shot_id)
  }
  const changed = new Set()
  if (left.end_ms !== input.boundary_ms) { changed.add(left.id); changed.add(right.id) }
  for (const turn of turns) if (assignments.get(turn.dialogue_id) !== turn.current_shot_id) {
    changed.add(turn.current_shot_id); changed.add(assignments.get(turn.dialogue_id))
  }
  for (const entry of dialogueEntries(blueprint)) if (changed.has(entry.shot.id) && !assignments.has(entry.dialogue.id)) {
    boundaryDialogue(record, blueprint, entry)
  }
  const next = clonePlainData(blueprint)
  if (!changed.size) return next
  next.shots.find((shot) => shot.id === left.id).end_ms = input.boundary_ms
  next.shots.find((shot) => shot.id === right.id).start_ms = input.boundary_ms
  const moving = dialogueEntries(next).filter(({ dialogue }) => assignments.has(dialogue.id))
  for (const shot of next.shots) shot.dialogue = shot.dialogue.filter((line) => !assignments.has(line.id))
  for (const { dialogue } of moving) {
    const shot = next.shots.find((item) => item.id === assignments.get(dialogue.id))
    const source = turns.find((item) => item.dialogue_id === dialogue.id)
    dialogue.start_ms = Math.max(source.source_start_ms, shot.start_ms)
    dialogue.end_ms = Math.min(source.source_end_ms, shot.end_ms)
    shot.dialogue.push(dialogue)
  }
  for (const shot of next.shots) if (changed.has(shot.id)) {
    for (const line of shot.dialogue) line.review_status = 'needs_review'
    shot.audio_contract = { ...shot.audio_contract, dialogue_mode: shot.dialogue.length ? 'spoken' : 'silent' }
  }
  next.review = { ...(next.review || {}), status: 'needs_review' }
  delete next.review.reviewer
  return next
}

export function controlledBlueprintSourceUrl(value) {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (!candidate.startsWith('/api/') || /[\u0000-\u001f\u007f\\]/.test(candidate)) return ''
  let decodedPath = candidate.split(/[?#]/, 1)[0]
  for (let pass = 0; pass < 5; pass += 1) {
    if (!decodedPath.startsWith('/api/')
      || decodedPath.includes('\\')
      || decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
      return ''
    }
    let nextPath
    try {
      nextPath = decodeURIComponent(decodedPath)
    } catch (_) {
      return ''
    }
    if (nextPath === decodedPath) {
      const parsed = new URL(candidate, 'https://local.invalid')
      return parsed.origin === 'https://local.invalid' && parsed.pathname.startsWith('/api/') ? candidate : ''
    }
    decodedPath = nextPath
  }
  return ''
}

export function buildBlueprintSavePayload(reviewRecord) {
  assertPlainData(reviewRecord, 'reviewRecord')
  const updatedAt = requiredText(reviewRecord?.updated_at, 'expected updated_at', 100)
  assertBlueprint(reviewRecord?.blueprint)
  return {
    expected_updated_at: updatedAt,
    blueprint: clonePlainData(reviewRecord.blueprint),
  }
}

export function buildBlueprintLockPayload(reviewRecord) {
  assertPlainData(reviewRecord, 'reviewRecord')
  const updatedAt = requiredText(reviewRecord?.updated_at, 'expected updated_at', 100)
  const blueprintHash = requiredText(reviewRecord?.blueprint_hash, 'expected blueprint_hash', 64)
  if (!SHA256.test(blueprintHash)) throw inputError('expected blueprint_hash 必须是 SHA-256')
  return {
    expected_blueprint_hash: blueprintHash,
    expected_updated_at: updatedAt,
  }
}

export function unresolvedVoiceClusters(blueprint, record) {
  assertBlueprint(blueprint)
  const counts = new Map()
  for (const { shot, dialogue } of dialogueEntries(blueprint)) {
    if (dialogue?.speaker_kind !== 'voice_cluster') continue
    const id = requiredStableId(dialogue.speaker_id, '声音聚类标识')
    if (!/^speaker-cluster-[1-9][0-9]*$/.test(id)) {
      const window = WINDOW_CLUSTER.exec(id)
      if (!window || Number(window[1]) === 0 || !Number.isSafeInteger(Number(window[2]))
        || !hasV2DialogueContext(record, blueprint, shot.id, dialogue.id)) throw inputError(`声音聚类标识无效：${id}`)
      const saved = selectedDialogues(record.blueprint, [dialogue.id]).entries[0].dialogue
      if (saved.speaker_kind !== 'voice_cluster' || saved.speaker_id !== id) throw inputError('声音聚类与已保存对白不一致')
    }
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  return [...counts].map(([id, dialogue_count]) => ({ id, dialogue_count })).sort(compareClusters)
}

export function mapVoiceClusterToCharacter(blueprint, clusterIdValue, characterIdValue, record) {
  const { characterIds } = assertBlueprint(blueprint)
  const clusterId = requiredStableId(clusterIdValue, '声音聚类标识')
  const characterId = requiredStableId(characterIdValue, '角色标识')
  if (!characterIds.has(characterId)) throw inputError(`未知角色：${characterId}`)
  if (!unresolvedVoiceClusters(blueprint, record).some((cluster) => cluster.id === clusterId)) {
    throw inputError(`未知声音聚类：${clusterId}`)
  }
  const next = clonePlainData(blueprint)
  for (const shot of next.shots) {
    const visibleCharacters = new Set(shot.visible_character_ids)
    for (const dialogue of shot.dialogue) {
      if (dialogue.speaker_kind !== 'voice_cluster' || dialogue.speaker_id !== clusterId) continue
      dialogue.speaker_id = characterId
      dialogue.speaker_kind = 'character'
      dialogue.off_screen = dialogue.off_screen === true || !visibleCharacters.has(characterId)
      dialogue.review_status = 'approved'
    }
  }
  return next
}

export function createOffScreenCharacterForCluster(blueprint, clusterIdValue, input = {}, record) {
  const { characterIds } = assertBlueprint(blueprint)
  const clusterId = requiredStableId(clusterIdValue, '声音聚类标识')
  if (!unresolvedVoiceClusters(blueprint, record).some((cluster) => cluster.id === clusterId)) {
    throw inputError(`未知声音聚类：${clusterId}`)
  }
  const id = requiredStableId(input?.id, '角色标识')
  const name = requiredText(input?.name, '角色名称')
  if (characterIds.has(id)) throw inputError(`角色标识重复：${id}`)
  const related = dialogueEntries(blueprint)
    .map(({ dialogue }) => dialogue)
    .filter((dialogue) => dialogue.speaker_kind === 'voice_cluster' && dialogue.speaker_id === clusterId)
  const evidenceRefs = [...new Set(related.flatMap((dialogue) => (
    Array.isArray(dialogue.evidence_refs) ? dialogue.evidence_refs : []
  )))].sort()
  const next = clonePlainData(blueprint)
  next.characters.push({
    id,
    source_name: name,
    display_name: name,
    relationship: '画外角色',
    relationships: [],
    face_track_ids: [],
    evidence_refs: evidenceRefs,
    confidence: 0,
    review_status: 'approved',
  })
  for (const shot of next.shots) {
    for (const dialogue of shot.dialogue) {
      if (dialogue.speaker_kind !== 'voice_cluster' || dialogue.speaker_id !== clusterId) continue
      dialogue.speaker_id = id
      dialogue.speaker_kind = 'off_screen'
      dialogue.off_screen = true
      dialogue.review_status = 'approved'
    }
  }
  return next
}

function correctionId(value, name) {
  const id = requiredStableId(value, name)
  if (id !== value || DANGEROUS_KEYS.has(id)) throw inputError(`${name} 无效`)
  return id
}

function selectedDialogues(blueprint, dialogueIds) {
  const { characterIds } = assertBlueprint(blueprint)
  for (const id of characterIds) correctionId(id, '角色标识')
  assertPlainData(dialogueIds, 'dialogueIds')
  if (!Array.isArray(dialogueIds) || !dialogueIds.length) throw inputError('必须选择至少一条对白')
  const selected = new Set()
  for (const value of dialogueIds) {
    const id = correctionId(value, '对白标识')
    if (selected.has(id)) throw inputError(`对白标识重复：${id}`)
    selected.add(id)
  }
  const known = new Set()
  const entries = dialogueEntries(blueprint)
  for (const { dialogue } of entries) {
    const id = correctionId(dialogue?.id, '对白标识')
    if (known.has(id)) throw inputError(`对白标识重复：${id}`)
    known.add(id)
  }
  for (const id of selected) if (!known.has(id)) throw inputError(`未知对白：${id}`)
  return { characterIds, selected, entries: entries.filter(({ dialogue }) => selected.has(dialogue.id)) }
}

function correctionOptions(input, fields) {
  assertPlainData(input, 'options')
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== fields.length || fields.some((key) => !Object.hasOwn(input, key))) {
    throw inputError('纠错选项字段无效')
  }
}

const SHOT_VISUAL_TEXT_LIMITS = { composition: 500, camera_movement: 300, opening_state: 500, continuous_action: 500, ending_state: 500 }

function factCorrectionDraft(blueprint, collection, targetId, input, limits, extraFields = []) {
  assertBlueprint(blueprint)
  correctionOptions(input, [...Object.keys(limits), ...extraFields])
  correctionId(targetId, '事实标识')
  for (const key of ['characters', 'shots', 'scenes', 'props']) {
    if (!Array.isArray(blueprint[key])) throw inputError(`${key} 必须是数组`)
    const ids = new Set()
    for (const item of blueprint[key]) {
      const id = correctionId(item?.id, `${key} 标识`)
      if (ids.has(id)) throw inputError(`${key} 标识重复：${id}`)
      ids.add(id)
    }
  }
  const dialogueIds = new Set()
  for (const { dialogue } of dialogueEntries(blueprint)) {
    const id = correctionId(dialogue?.id, '对白标识')
    if (dialogueIds.has(id)) throw inputError(`对白标识重复：${id}`)
    dialogueIds.add(id)
  }
  if (!blueprint[collection].some((item) => item.id === targetId)) throw inputError('未知事实标识')
  const values = {}
  for (const [key, maxLength] of Object.entries(limits)) {
    const text = requiredText(input[key], key, maxLength)
    if (/(?:\0|https?:\/\/|file:\/\/|^[a-zA-Z]:[\\/]|^\\\\|api[_-]?key|bearer\s+|prompt\s*:)/i.test(text)) {
      throw inputError(`${key} 包含危险路径、URL 或凭据`)
    }
    values[key] = text
  }
  const next = clonePlainData(blueprint)
  Object.assign(next[collection].find((item) => item.id === targetId), values)
  next.review = { ...(next.review || {}), status: 'needs_review' }
  delete next.review.reviewer
  return next
}

export function applyShotVisualFactCorrection(blueprint, shotId, input) {
  const next = factCorrectionDraft(blueprint, 'shots', shotId, input, SHOT_VISUAL_TEXT_LIMITS, ['visible_character_ids'])
  const characterIds = new Set(blueprint.characters.map((character) => character.id))
  if (!Array.isArray(input.visible_character_ids)) throw inputError('可见角色必须是数组')
  const visible = new Set()
  for (const value of input.visible_character_ids) {
    const id = correctionId(value, '可见角色标识')
    if (!characterIds.has(id) || visible.has(id)) throw inputError('可见角色必须是已有且不重复的角色')
    visible.add(id)
  }
  const shot = next.shots.find((item) => item.id === shotId)
  if (shot.dialogue.some((line) => line.speaker_kind === 'character' && line.off_screen !== true && !visible.has(line.speaker_id))) {
    throw inputError('不能删除画内对白仍引用的可见角色；请先核实对白说话人和画面状态')
  }
  const changed = visible.size !== shot.visible_character_ids.length || shot.visible_character_ids.some((id) => !visible.has(id))
  if (changed) {
    shot.visible_character_ids = [...visible]
    for (const line of shot.dialogue) line.review_status = 'needs_review'
  }
  return next
}

export function applySceneFactCorrection(blueprint, sceneId, input) {
  return factCorrectionDraft(blueprint, 'scenes', sceneId, input, { location: 200, time: 120 })
}

export function applyPropFactCorrection(blueprint, propId, input) {
  return factCorrectionDraft(blueprint, 'props', propId, input, { name: 200 })
}

function reviseDialogueSpeakers(blueprint, selected, characterId, offScreen) {
  const next = clonePlainData(blueprint)
  for (const { dialogue } of dialogueEntries(next)) {
    if (!selected.has(dialogue.id)) continue
    dialogue.speaker_id = characterId
    dialogue.speaker_kind = offScreen ? 'off_screen' : 'character'
    dialogue.off_screen = offScreen
    dialogue.review_status = 'needs_review'
  }
  next.review = { ...(next.review || {}), status: 'needs_review' }
  delete next.review.reviewer
  return next
}

export function assignDialogueSpeakers(blueprint, dialogueIds, input) {
  const { characterIds, selected, entries } = selectedDialogues(blueprint, dialogueIds)
  correctionOptions(input, ['character_id', 'off_screen'])
  const characterId = correctionId(input.character_id, '角色标识')
  if (!characterIds.has(characterId)) throw inputError(`未知角色：${characterId}`)
  if (typeof input.off_screen !== 'boolean') throw inputError('画外状态必须是布尔值')
  if (!input.off_screen && entries.some(({ shot }) => !shot.visible_character_ids.includes(characterId))) {
    throw inputError('画内角色必须在全部选中对白所属镜头中可见；请核实角色或明确选择画外')
  }
  return reviseDialogueSpeakers(blueprint, selected, characterId, input.off_screen)
}

export function createOffScreenCharacterForDialogues(blueprint, dialogueIds, input) {
  const { characterIds, selected, entries } = selectedDialogues(blueprint, dialogueIds)
  correctionOptions(input, ['name'])
  const name = requiredText(input.name, '角色名称')
  let ordinal = 1
  while (characterIds.has(`manual-character-${ordinal}`)) ordinal += 1
  const id = `manual-character-${ordinal}`
  const next = reviseDialogueSpeakers(blueprint, selected, id, true)
  next.characters.push({
    id, source_name: name, display_name: name, relationship: '画外角色', relationships: [], face_track_ids: [],
    evidence_refs: [...new Set(entries.flatMap(({ dialogue }) => dialogue.evidence_refs || []))].sort(),
    confidence: 0, review_status: 'needs_review',
  })
  return next
}

export function approveCharacterReview(blueprint, characterIdValue) {
  const { characterIds } = assertBlueprint(blueprint)
  const characterId = requiredStableId(characterIdValue, '角色标识')
  if (!characterIds.has(characterId)) throw inputError(`未知角色：${characterId}`)
  const next = clonePlainData(blueprint)
  const character = next.characters.find((item) => item.id === characterId)
  character.review_status = 'approved'
  return next
}

export function approveDialogueReview(blueprint, dialogueIdValue) {
  assertBlueprint(blueprint)
  const dialogueId = requiredStableId(dialogueIdValue, '对白标识')
  const matches = dialogueEntries(blueprint).filter(({ dialogue }) => dialogue?.id === dialogueId)
  if (matches.length !== 1) throw inputError(`未知对白或对白标识重复：${dialogueId}`)
  if (matches[0].dialogue.speaker_kind === 'voice_cluster') {
    throw inputError('声音聚类必须先显式映射角色')
  }
  const next = clonePlainData(blueprint)
  const dialogue = dialogueEntries(next).find((entry) => entry.dialogue.id === dialogueId).dialogue
  dialogue.review_status = 'approved'
  return next
}

export function blueprintLockBlockers(blueprint, record) {
  const { characterIds } = assertBlueprint(blueprint)
  const entries = dialogueEntries(blueprint)
  const blockers = []
  if (unresolvedVoiceClusters(blueprint, record).length > 0) blockers.push('仍有未解决声音聚类')
  if (blueprint.characters.some((character) => character.review_status !== 'approved')) {
    blockers.push('仍有角色未审核通过')
  }
  if (entries.some(({ dialogue }) => dialogue.review_status !== 'approved')) {
    blockers.push('仍有对白未审核通过')
  }
  if (entries.some(({ dialogue, shot }) => (
    (dialogue.speaker_kind === 'character'
      && (!characterIds.has(dialogue.speaker_id)
        || (dialogue.off_screen !== true && !shot.visible_character_ids.includes(dialogue.speaker_id))))
    || (dialogue.speaker_kind === 'off_screen' && dialogue.off_screen !== true)
    || !['character', 'off_screen', 'voice_cluster'].includes(dialogue.speaker_kind)
  ))) {
    blockers.push('仍有对白说话人映射无效')
  }
  if (!['approved', 'locked'].includes(blueprint.review?.status)) {
    blockers.push('母本事实尚未审核通过')
  }
  return blockers
}

export function approveBlueprintReview(blueprint, reviewerValue, record) {
  assertBlueprint(blueprint)
  const reviewer = requiredText(reviewerValue, '审核人标识')
  const blockers = blueprintLockBlockers(blueprint, record)
    .filter((item) => item !== '母本事实尚未审核通过')
  if (blockers.length > 0) throw inputError(blockers.join('；'))
  const next = clonePlainData(blueprint)
  next.review = { ...(next.review || {}), status: 'approved', reviewer }
  return next
}
