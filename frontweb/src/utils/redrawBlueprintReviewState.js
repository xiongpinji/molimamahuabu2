const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const STABLE_ID = /^[a-zA-Z0-9._-]+$/
const SHA256 = /^[a-f0-9]{64}$/

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
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainData(item, `${name}[${index}]`, seen))
    seen.delete(value)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw inputError(`${name} 不允许继承字段或自定义原型`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const [key, descriptor] of Object.entries(descriptors)) {
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
  const match = /^speaker-cluster-([1-9][0-9]*)$/.exec(value)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function compareClusters(left, right) {
  return clusterNumber(left.id) - clusterNumber(right.id)
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

export function unresolvedVoiceClusters(blueprint) {
  assertBlueprint(blueprint)
  const counts = new Map()
  for (const { dialogue } of dialogueEntries(blueprint)) {
    if (dialogue?.speaker_kind !== 'voice_cluster') continue
    const id = requiredStableId(dialogue.speaker_id, '声音聚类标识')
    if (!/^speaker-cluster-[1-9][0-9]*$/.test(id)) throw inputError(`声音聚类标识无效：${id}`)
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  return [...counts].map(([id, dialogue_count]) => ({ id, dialogue_count })).sort(compareClusters)
}

export function mapVoiceClusterToCharacter(blueprint, clusterIdValue, characterIdValue) {
  const { characterIds } = assertBlueprint(blueprint)
  const clusterId = requiredStableId(clusterIdValue, '声音聚类标识')
  const characterId = requiredStableId(characterIdValue, '角色标识')
  if (!characterIds.has(characterId)) throw inputError(`未知角色：${characterId}`)
  if (!unresolvedVoiceClusters(blueprint).some((cluster) => cluster.id === clusterId)) {
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

export function createOffScreenCharacterForCluster(blueprint, clusterIdValue, input = {}) {
  const { characterIds } = assertBlueprint(blueprint)
  const clusterId = requiredStableId(clusterIdValue, '声音聚类标识')
  if (!unresolvedVoiceClusters(blueprint).some((cluster) => cluster.id === clusterId)) {
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

export function blueprintLockBlockers(blueprint) {
  const { characterIds } = assertBlueprint(blueprint)
  const entries = dialogueEntries(blueprint)
  const blockers = []
  if (unresolvedVoiceClusters(blueprint).length > 0) blockers.push('仍有未解决声音聚类')
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

export function approveBlueprintReview(blueprint, reviewerValue) {
  assertBlueprint(blueprint)
  const reviewer = requiredText(reviewerValue, '审核人标识')
  const blockers = blueprintLockBlockers(blueprint).filter((item) => item !== '母本事实尚未审核通过')
  if (blockers.length > 0) throw inputError(blockers.join('；'))
  const next = clonePlainData(blueprint)
  next.review = { ...(next.review || {}), status: 'approved', reviewer }
  return next
}
