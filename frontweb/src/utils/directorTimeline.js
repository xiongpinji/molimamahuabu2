export const DIRECTOR_TIMELINE_VERSION = 1

export const SHOT_CAMERA_TYPES = [
  { value: 'director', label: '导演视角' },
  { value: 'wide', label: '全景机位' },
  { value: 'close', label: '近景机位' },
  { value: 'profile', label: '侧面机位' },
]

export const TRANSITION_TYPES = [
  { value: 'cut', label: '硬切' },
  { value: 'dissolve', label: '叠化' },
  { value: 'wipe', label: '划像' },
]

export const ACTION_LIBRARY = ['Idle', 'Walk', 'Run', 'Talk', 'Wave', 'Attack']

const MIN_SHOT_DURATION = 0.25
const MIN_CLIP_DURATION = 0.25

function id(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function asNumber(value, fallback = 0) {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || ''
}

function normalizeAssetId(...values) {
  const value = values.find((item) => item !== undefined && item !== null && String(item).trim() !== '')
  if (value === undefined) return null
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null
}

function normalizeCharacterAssets(input, characters = []) {
  const source = input && typeof input === 'object' ? input : {}
  const result = {}
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object') continue
    const actions = value.actions && typeof value.actions === 'object' ? value.actions : {}
    const modelAssetId = normalizeAssetId(value.modelAssetId, value.model_asset_id)
    result[String(key)] = {
      modelUrl: firstString(value.modelUrl, value.model_url, value.url),
      scale: Math.max(0.01, Math.min(100, asNumber(value.scale, 1))),
      actions: Object.fromEntries(Object.entries(actions).map(([action, resource]) => {
        if (!resource || typeof resource !== 'object') return [action, { url: '' }]
        const normalized = {
          url: firstString(resource.url, resource.actionUrl, resource.action_url),
          clipName: firstString(resource.clipName, resource.clip_name),
        }
        const assetId = normalizeAssetId(resource.assetId, resource.asset_id)
        if (assetId !== null) normalized.assetId = assetId
        return [action, normalized]
      })),
    }
    if (modelAssetId !== null) result[String(key)].modelAssetId = modelAssetId
  }
  for (const [index, character] of (characters || []).entries()) {
    const id = String(character?.id ?? character?.name ?? `character-${index + 1}`)
    const current = result[id] || { modelUrl: '', scale: 1, actions: {} }
    result[id] = {
      ...current,
      modelUrl: current.modelUrl || firstString(
        character?.modelUrl,
        character?.model_url,
        character?.gltfUrl,
        character?.gltf_url,
        character?.model_path,
      ),
      actions: current.actions || {},
    }
  }
  return result
}

function normalizeShot(shot, index, start) {
  const duration = Math.max(MIN_SHOT_DURATION, asNumber(shot?.duration, 4))
  return {
    id: shot?.id || id('shot'),
    name: String(shot?.name || `镜头 ${index + 1}`),
    sceneId: shot?.sceneId == null ? '' : String(shot.sceneId),
    camera: SHOT_CAMERA_TYPES.some((item) => item.value === shot?.camera) ? shot.camera : 'director',
    transition: TRANSITION_TYPES.some((item) => item.value === shot?.transition) ? shot.transition : 'cut',
    transitionDuration: Math.max(0, Math.min(duration, asNumber(shot?.transitionDuration, 0))),
    start,
    duration,
  }
}

function normalizeClip(clip, characterId, index, duration) {
  const start = Math.max(0, asNumber(clip?.start, 0))
  return {
    id: clip?.id || id('clip'),
    characterId: String(clip?.characterId || characterId),
    action: ACTION_LIBRARY.includes(clip?.action) ? clip.action : 'Idle',
    start: Math.min(start, duration),
    duration: Math.max(MIN_CLIP_DURATION, asNumber(clip?.duration, 2)),
  }
}

export function createDirectorTimeline(characters = []) {
  const firstCharacter = characters?.[0]
  const state = {
    version: DIRECTOR_TIMELINE_VERSION,
    sequence: { name: '主序列', fps: 24, currentTime: 0, duration: 4 },
    shots: [{
      id: id('shot'),
      name: '镜头 1',
      sceneId: '',
      camera: 'director',
      transition: 'cut',
      transitionDuration: 0,
      start: 0,
      duration: 4,
    }],
    tracks: firstCharacter ? [{
      id: id('track'),
      characterId: String(firstCharacter.id ?? firstCharacter.name ?? 'character-1'),
      clips: [{ id: id('clip'), characterId: String(firstCharacter.id ?? firstCharacter.name ?? 'character-1'), action: 'Idle', start: 0, duration: 4 }],
    }] : [],
    characterAssets: normalizeCharacterAssets({}, characters),
  }
  return normalizeDirectorTimeline(state, characters)
}

export function normalizeDirectorTimeline(input, characters = []) {
  const source = input && typeof input === 'object' ? input : {}
  const sourceSequence = source.sequence && typeof source.sequence === 'object' ? source.sequence : {}
  const sourceShots = Array.isArray(source.shots) && source.shots.length ? source.shots : createDirectorTimeline(characters).shots
  let cursor = 0
  const shots = sourceShots.map((shot, index) => {
    const next = normalizeShot(shot, index, cursor)
    cursor += next.duration
    return next
  })
  const characterIds = new Set((characters || []).map((character, index) => String(character?.id ?? character?.name ?? `character-${index + 1}`)))
  const tracks = (Array.isArray(source.tracks) ? source.tracks : []).map((track, index) => {
    const characterId = String(track?.characterId || `character-${index + 1}`)
    const clips = (Array.isArray(track?.clips) ? track.clips : []).map((clip, clipIndex) => normalizeClip(clip, characterId, clipIndex, cursor))
    return { id: track?.id || id('track'), characterId, clips }
  }).filter((track) => !characterIds.size || characterIds.has(track.characterId))
  const duration = cursor
  const currentTime = Math.max(0, Math.min(duration, asNumber(sourceSequence.currentTime, 0)))
  return {
    version: DIRECTOR_TIMELINE_VERSION,
    sequence: {
      name: String(sourceSequence.name || '主序列'),
      fps: Math.max(1, Math.min(120, asNumber(sourceSequence.fps, 24))),
      currentTime,
      duration,
    },
    shots,
    tracks,
    characterAssets: normalizeCharacterAssets(source.characterAssets, characters),
  }
}

export function appendShot(state, patch = {}) {
  const current = normalizeDirectorTimeline(state)
  const nextIndex = current.shots.length
  return normalizeDirectorTimeline({
    ...current,
    shots: [...current.shots, {
      id: id('shot'),
      name: `镜头 ${nextIndex + 1}`,
      camera: 'director',
      transition: 'cut',
      transitionDuration: 0,
      duration: 4,
      ...patch,
    }],
  })
}

export function appendActionClip(state, characterId, action = 'Idle', patch = {}) {
  const current = normalizeDirectorTimeline(state)
  const normalizedCharacterId = String(characterId)
  const start = Math.min(current.sequence.duration, Math.max(0, asNumber(patch.start, current.sequence.currentTime)))
  const clip = {
    id: id('clip'),
    characterId: normalizedCharacterId,
    action: ACTION_LIBRARY.includes(action) ? action : 'Idle',
    start,
    duration: Math.max(MIN_CLIP_DURATION, asNumber(patch.duration, 2)),
  }
  let found = false
  const tracks = current.tracks.map((track) => {
    if (track.characterId !== normalizedCharacterId) return track
    found = true
    return { ...track, clips: [...track.clips, clip] }
  })
  if (!found) tracks.push({ id: id('track'), characterId: normalizedCharacterId, clips: [clip] })
  return normalizeDirectorTimeline({ ...current, tracks })
}

export function findActiveShot(state, time) {
  const current = normalizeDirectorTimeline(state)
  const target = Math.max(0, Math.min(current.sequence.duration, asNumber(time, 0)))
  return current.shots.find((shot, index) => target < shot.start + shot.duration || index === current.shots.length - 1) || null
}

export function findActiveActionClips(state, time) {
  const target = Math.max(0, asNumber(time, 0))
  const clips = []
  for (const track of normalizeDirectorTimeline(state).tracks) {
    const clip = track.clips
      .filter((item) => target >= item.start && target <= item.start + item.duration)
      .sort((a, b) => b.start - a.start)[0]
    if (clip) clips.push(clip)
  }
  return clips
}
