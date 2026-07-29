export const DIRECTOR_TIMELINE_VERSION = 2

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

export const MIN_SHOT_DURATION = 0.25
export const MIN_ACTION_CLIP_DURATION = 0.25

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
    const boneRotations = value.boneRotations && typeof value.boneRotations === 'object' ? value.boneRotations : {}
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
      boneRotations: Object.fromEntries(Object.entries(boneRotations)
        .filter(([name, rotation]) => name && Array.isArray(rotation))
        .map(([name, rotation]) => [String(name), vector3(rotation, [0, 0, 0])])),
    }
    if (modelAssetId !== null) result[String(key)].modelAssetId = modelAssetId
  }
  for (const [index, character] of (characters || []).entries()) {
    const id = String(character?.id ?? character?.name ?? `character-${index + 1}`)
    const current = result[id] || { modelUrl: '', scale: 1, actions: {}, boneRotations: {} }
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
      boneRotations: current.boneRotations || {},
    }
  }
  return result
}

function vector3(value, fallback) {
  const source = Array.isArray(value) ? value : []
  return fallback.map((item, index) => asNumber(source[index], item))
}

function optionalVector4(value) {
  if (!Array.isArray(value) || value.length !== 4) return null
  return value.map((item, index) => asNumber(item, index === 3 ? 1 : 0))
}

function normalizeObjects(input) {
  const objects = []
  const ids = new Set()
  for (const [index, value] of (Array.isArray(input) ? input : []).entries()) {
    if (!value || typeof value !== 'object') continue
    const objectId = String(value.id || `object-${index + 1}`)
    if (ids.has(objectId)) continue
    ids.add(objectId)
    objects.push({
      id: objectId,
      type: String(value.type || 'group'),
      name: String(value.name || `对象 ${index + 1}`),
      parentId: value.parentId == null ? '' : String(value.parentId),
      visible: value.visible !== false,
      locked: value.locked === true,
      assetRef: value.assetRef && typeof value.assetRef === 'object' ? {
        assetId: value.assetRef.assetId ?? null,
        url: String(value.assetRef.url || ''),
        kind: String(value.assetRef.kind || ''),
        ...(value.assetRef.characterId ? { characterId: String(value.assetRef.characterId) } : {}),
        description: String(value.assetRef.description || ''),
      } : null,
      poseRotations: Object.fromEntries(Object.entries(value.poseRotations && typeof value.poseRotations === 'object' ? value.poseRotations : {})
        .filter(([semantic, rotation]) => semantic && Array.isArray(rotation))
        .map(([semantic, rotation]) => [String(semantic), vector3(rotation, [0, 0, 0])])),
      transform: {
        position: vector3(value.transform?.position, [0, 0, 0]),
        rotation: vector3(value.transform?.rotation, [0, 0, 0]),
        scale: vector3(value.transform?.scale, [1, 1, 1]).map((item) => Math.max(0.0001, item)),
      },
    })
  }
  const byId = new Map(objects.map((object) => [object.id, object]))
  for (const object of objects) {
    if (!byId.has(object.parentId) || object.parentId === object.id) object.parentId = ''
    const visited = new Set([object.id])
    let parent = byId.get(object.parentId)
    while (parent) {
      if (visited.has(parent.id)) { object.parentId = ''; break }
      visited.add(parent.id)
      parent = byId.get(parent.parentId)
    }
  }
  return objects
}

function mergeProjectCharacterObjects(objects, characters = [], sync = false) {
  const characterIds = new Set((characters || []).map((character, index) => String(character?.id ?? character?.name ?? `character-${index + 1}`)))
  const result = sync
    ? objects.filter((object) => object.assetRef?.kind !== 'project-character' || characterIds.has(String(object.assetRef?.characterId || '')))
    : [...objects]
  const existing = new Set(result
    .filter((object) => object.type === 'character' && object.assetRef?.characterId)
    .map((object) => object.assetRef.characterId))
  const count = characters.length
  characters.forEach((character, index) => {
    const characterId = String(character?.id ?? character?.name ?? `character-${index + 1}`)
    if (existing.has(characterId)) return
    result.push({
      id: `project-character:${characterId}`,
      type: 'character',
      name: String(character?.name || `角色 ${index + 1}`),
      parentId: '', visible: true, locked: false,
      assetRef: { assetId: null, url: '', kind: 'project-character', characterId, description: '' },
      poseRotations: {},
      transform: { position: [(index - (count - 1) / 2) * 1.8, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    })
  })
  return result
}

function legacyCameraId(camera) {
  return `legacy-camera-${SHOT_CAMERA_TYPES.some((item) => item.value === camera) ? camera : 'director'}`
}

function normalizeCameras(input, shots = []) {
  const source = Array.isArray(input) ? input : []
  const requiredLegacy = new Set(shots.map((shot) => shot.camera || 'director'))
  const candidates = source.length ? source : [...requiredLegacy].map((camera) => ({ id: legacyCameraId(camera), name: camera, legacyType: camera }))
  const ids = new Set()
  return candidates.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const cameraId = String(value.id || `camera-${index + 1}`)
    if (ids.has(cameraId)) return []
    ids.add(cameraId)
    return [{
      id: cameraId,
      name: String(value.name || `机位 ${index + 1}`),
      objectId: String(value.objectId || ''),
      legacyType: String(value.legacyType || ''),
      fov: Math.max(1, Math.min(179, asNumber(value.fov, 50))),
      aspect: Math.max(0.1, Math.min(10, asNumber(value.aspect, 16 / 9))),
      near: Math.max(0.001, asNumber(value.near, 0.1)),
      far: Math.max(1, asNumber(value.far, 1000)),
      quaternion: optionalVector4(value.quaternion),
      target: vector3(value.target, [0, 0.8, 0]),
      followTargetId: String(value.followTargetId || ''),
      lookAtMode: ['origin', 'object'].includes(value.lookAtMode) ? value.lookAtMode : 'origin',
      lookAtTargetId: String(value.lookAtTargetId || ''),
      showGuides: value.showGuides === true,
    }]
  })
}

function normalizeShot(shot, index, start) {
  const duration = Math.max(MIN_SHOT_DURATION, asNumber(shot?.duration, 4))
  return {
    id: shot?.id || id('shot'),
    name: String(shot?.name || `镜头 ${index + 1}`),
    sceneId: shot?.sceneId == null ? '' : String(shot.sceneId),
    camera: SHOT_CAMERA_TYPES.some((item) => item.value === shot?.camera) ? shot.camera : 'director',
    cameraId: String(shot?.cameraId || legacyCameraId(shot?.camera)),
    transition: TRANSITION_TYPES.some((item) => item.value === shot?.transition) ? shot.transition : 'cut',
    transitionDuration: Math.max(0, Math.min(duration, asNumber(shot?.transitionDuration, 0))),
    start,
    duration,
  }
}

function normalizeClip(clip, characterId, index, duration) {
  const maxStart = Math.max(0, duration - MIN_ACTION_CLIP_DURATION)
  const start = Math.min(maxStart, Math.max(0, asNumber(clip?.start, 0)))
  const maxDuration = Math.max(MIN_ACTION_CLIP_DURATION, duration - start)
  return {
    id: clip?.id || id('clip'),
    characterId: String(clip?.characterId || characterId),
    action: ACTION_LIBRARY.includes(clip?.action) ? clip.action : 'Idle',
    start,
    duration: Math.min(maxDuration, Math.max(MIN_ACTION_CLIP_DURATION, asNumber(clip?.duration, 2))),
  }
}

function normalizeMotionTracks(input, objects, duration) {
  const objectIds = new Set(objects.map((object) => object.id))
  return (Array.isArray(input) ? input : []).flatMap((track, index) => {
    const objectId = String(track?.objectId || '')
    if (!objectIds.has(objectId)) return []
    const keyframes = (Array.isArray(track?.keyframes) ? track.keyframes : []).map((keyframe) => ({
      id: String(keyframe?.id || `keyframe-${index}-${Math.random().toString(36).slice(2, 7)}`),
      time: Math.max(0, Math.min(duration, asNumber(keyframe?.time, 0))),
      position: vector3(keyframe?.position, [0, 0, 0]),
      rotation: vector3(keyframe?.rotation, [0, 0, 0]),
      scale: vector3(keyframe?.scale, [1, 1, 1]).map((value) => Math.max(0.0001, value)),
    })).sort((a, b) => a.time - b.time)
    return [{ id: String(track?.id || `motion-${objectId}`), objectId, keyframes }]
  })
}

export function createDirectorTimeline(characters = []) {
  const firstCharacter = characters?.[0]
  const state = {
    version: DIRECTOR_TIMELINE_VERSION,
    sequence: { name: '主序列', fps: 24, currentTime: 0, duration: 4, loop: false, autoKey: false, showMotionPaths: false, timelineZoom: 1, timelineCollapsed: false },
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
    motionTracks: [],
    characterAssets: normalizeCharacterAssets({}, characters),
    objects: [],
    cameras: [{ id: legacyCameraId('director'), name: '导演视角', objectId: '', legacyType: 'director', fov: 50, aspect: 16 / 9, near: 0.1, far: 1000 }],
    environment: {
      backgroundColor: '#101014', panoramaUrl: '', ambientIntensity: 1, directionalIntensity: 2,
      sceneScale: 1, scenePosition: [0, 0, 0], sceneRotation: [0, 0, 0], panoramaRotation: 0, panoramaRadius: 60,
      showCharacterLabels: true, gridSnap: false, groundSnap: true, showGround: true, groundOpacity: 0.4, groundHeight: 0,
    },
    revision: 0,
    extensions: {},
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
  const objects = mergeProjectCharacterObjects(normalizeObjects(source.objects), characters, arguments.length >= 2)
  const motionTracks = normalizeMotionTracks(source.motionTracks, objects, duration)
  const cameras = normalizeCameras(source.cameras, shots)
  const cameraIds = new Set(cameras.map((camera) => camera.id))
  for (const shot of shots) {
    if (!cameraIds.has(shot.cameraId)) shot.cameraId = cameras[0]?.id || ''
  }
  const activeCameraId = cameraIds.has(String(sourceSequence.activeCameraId || ''))
    ? String(sourceSequence.activeCameraId)
    : (cameras[0]?.id || '')
  const environment = source.environment && typeof source.environment === 'object' ? source.environment : {}
  return {
    version: DIRECTOR_TIMELINE_VERSION,
    sequence: {
      name: String(sourceSequence.name || '主序列'),
      fps: Math.max(1, Math.min(120, asNumber(sourceSequence.fps, 24))),
      currentTime,
      duration,
      activeCameraId,
      loop: sourceSequence.loop === true,
      autoKey: sourceSequence.autoKey === true,
      showMotionPaths: sourceSequence.showMotionPaths === true,
      timelineZoom: Math.max(0.5, Math.min(4, asNumber(sourceSequence.timelineZoom, 1))),
      timelineCollapsed: sourceSequence.timelineCollapsed === true,
    },
    shots,
    tracks,
    motionTracks,
    characterAssets: normalizeCharacterAssets(source.characterAssets, characters),
    objects,
    cameras,
    environment: {
      backgroundColor: String(environment.backgroundColor || '#101014'),
      panoramaUrl: String(environment.panoramaUrl || ''),
      ambientIntensity: Math.max(0, asNumber(environment.ambientIntensity, 1)),
      directionalIntensity: Math.max(0, asNumber(environment.directionalIntensity, 2)),
      sceneScale: Math.max(0.01, Math.min(10, asNumber(environment.sceneScale, 1))),
      scenePosition: vector3(environment.scenePosition, [0, 0, 0]),
      sceneRotation: vector3(environment.sceneRotation, [0, 0, 0]),
      panoramaRotation: asNumber(environment.panoramaRotation, 0),
      panoramaRadius: Math.max(1, Math.min(500, asNumber(environment.panoramaRadius, 60))),
      showCharacterLabels: environment.showCharacterLabels !== false,
      gridSnap: environment.gridSnap === true,
      groundSnap: environment.groundSnap !== false,
      showGround: environment.showGround !== false,
      groundOpacity: Math.max(0, Math.min(1, asNumber(environment.groundOpacity, 0.4))),
      groundHeight: asNumber(environment.groundHeight, 0),
    },
    revision: Math.max(0, Math.floor(asNumber(source.revision, 0))),
    extensions: source.extensions && typeof source.extensions === 'object' && !Array.isArray(source.extensions) ? { ...source.extensions } : {},
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

export function splitShotAtTime(state, shotId, time) {
  const current = normalizeDirectorTimeline(state)
  const shotIndex = current.shots.findIndex((shot) => shot.id === String(shotId || ''))
  if (shotIndex < 0) return current
  const shot = current.shots[shotIndex]
  const cutTime = Math.max(shot.start, Math.min(shot.start + shot.duration, asNumber(time, shot.start)))
  const firstDuration = cutTime - shot.start
  const secondDuration = shot.duration - firstDuration
  if (firstDuration < MIN_SHOT_DURATION || secondDuration < MIN_SHOT_DURATION) return current
  const shots = [...current.shots]
  shots.splice(
    shotIndex,
    1,
    { ...shot, duration: firstDuration },
    {
      ...shot,
      id: id('shot'),
      name: `${shot.name}（后段）`,
      transition: 'cut',
      transitionDuration: 0,
      duration: secondDuration,
    },
  )
  return normalizeDirectorTimeline({ ...current, shots })
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
    duration: Math.max(MIN_ACTION_CLIP_DURATION, asNumber(patch.duration, 2)),
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

export function updateActionClip(state, clipId, patch = {}) {
  const current = normalizeDirectorTimeline(state)
  const normalizedClipId = String(clipId || '')
  const tracks = current.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => clip.id === normalizedClipId ? {
      ...clip,
      action: patch.action ?? clip.action,
      start: patch.start ?? clip.start,
      duration: patch.duration ?? clip.duration,
    } : clip),
  }))
  return normalizeDirectorTimeline({ ...current, tracks })
}

export function removeActionClip(state, clipId) {
  const current = normalizeDirectorTimeline(state)
  const normalizedClipId = String(clipId || '')
  const tracks = current.tracks
    .map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== normalizedClipId) }))
    .filter((track) => track.clips.length)
  return normalizeDirectorTimeline({ ...current, tracks })
}

export function appendDirectorObject(state, type = 'box', patch = {}) {
  const current = normalizeDirectorTimeline(state)
  const object = {
    id: patch.id || id('object'),
    type,
    name: patch.name || (type === 'sphere' ? '球体' : type === 'group' ? '空对象' : type === 'humanoid' ? '角色素体' : type === 'light' ? '方向灯光' : '立方体'),
    parentId: patch.parentId || '',
    visible: patch.visible !== false,
    locked: patch.locked === true,
    assetRef: patch.assetRef || null,
    poseRotations: patch.poseRotations || {},
    transform: patch.transform || { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }
  return normalizeDirectorTimeline({ ...current, objects: [...current.objects, object], revision: current.revision + 1 })
}

export function updateDirectorObject(state, objectId, patch = {}) {
  const current = normalizeDirectorTimeline(state)
  const targetId = String(objectId)
  const objects = current.objects.map((object) => object.id === targetId ? {
    ...object,
    ...patch,
    transform: patch.transform ? { ...object.transform, ...patch.transform } : object.transform,
  } : object)
  return normalizeDirectorTimeline({ ...current, objects, revision: current.revision + 1 })
}

export function upsertMotionKeyframe(state, objectId, time, transform) {
  const current = normalizeDirectorTimeline(state)
  const targetId = String(objectId)
  if (!current.objects.some((object) => object.id === targetId)) return current
  const targetTime = Math.max(0, Math.min(current.sequence.duration, asNumber(time, 0)))
  const frame = {
    id: id('keyframe'), time: targetTime,
    position: vector3(transform?.position, [0, 0, 0]),
    rotation: vector3(transform?.rotation, [0, 0, 0]),
    scale: vector3(transform?.scale, [1, 1, 1]),
  }
  let found = false
  const motionTracks = current.motionTracks.map((track) => {
    if (track.objectId !== targetId) return track
    found = true
    const existing = track.keyframes.findIndex((keyframe) => Math.abs(keyframe.time - targetTime) < 0.001)
    const keyframes = existing >= 0 ? track.keyframes.map((keyframe, index) => index === existing ? { ...frame, id: keyframe.id } : keyframe) : [...track.keyframes, frame]
    return { ...track, keyframes: keyframes.sort((a, b) => a.time - b.time) }
  })
  if (!found) motionTracks.push({ id: id('motion'), objectId: targetId, keyframes: [frame] })
  return normalizeDirectorTimeline({ ...current, motionTracks, revision: current.revision + 1 })
}

export function interpolateMotionTransform(state, objectId, time) {
  const current = normalizeDirectorTimeline(state)
  const track = current.motionTracks.find((item) => item.objectId === String(objectId))
  if (!track?.keyframes.length) return null
  const target = Math.max(0, Math.min(current.sequence.duration, asNumber(time, 0)))
  const before = [...track.keyframes].reverse().find((keyframe) => keyframe.time <= target) || track.keyframes[0]
  const after = track.keyframes.find((keyframe) => keyframe.time >= target) || track.keyframes.at(-1)
  if (before === after || after.time === before.time) return { position: [...before.position], rotation: [...before.rotation], scale: [...before.scale] }
  const progress = (target - before.time) / (after.time - before.time)
  const lerp = (start, end) => start.map((value, index) => value + (end[index] - value) * progress)
  return { position: lerp(before.position, after.position), rotation: lerp(before.rotation, after.rotation), scale: lerp(before.scale, after.scale) }
}

export function removeDirectorObject(state, objectId) {
  const current = normalizeDirectorTimeline(state)
  const targetId = String(objectId)
  const removedIds = new Set([targetId])
  let changed = true
  while (changed) {
    changed = false
    for (const object of current.objects) {
      if (removedIds.has(object.parentId) && !removedIds.has(object.id)) {
        removedIds.add(object.id)
        changed = true
      }
    }
  }
  const objects = current.objects.filter((object) => !removedIds.has(object.id))
  const removedCameraIds = new Set(current.cameras.filter((camera) => removedIds.has(camera.objectId)).map((camera) => camera.id))
  const cameras = current.cameras.filter((camera) => !removedCameraIds.has(camera.id))
  const fallbackCameraId = cameras[0]?.id || ''
  const shots = current.shots.map((shot) => removedCameraIds.has(shot.cameraId) ? { ...shot, cameraId: fallbackCameraId } : shot)
  return normalizeDirectorTimeline({ ...current, objects, cameras, shots, revision: current.revision + 1 })
}

export function appendDirectorCamera(state, patch = {}) {
  const withObject = appendDirectorObject(state, 'camera', {
    id: patch.objectId || id('camera-object'),
    name: patch.name || '新机位',
    transform: patch.transform || { position: [6.8, 4.8, 8.6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  })
  const camera = {
    id: patch.id || id('camera'),
    name: patch.name || `机位 ${withObject.cameras.length + 1}`,
    objectId: withObject.objects.at(-1).id,
    fov: patch.fov || 50,
    aspect: patch.aspect || 16 / 9,
    near: patch.near || 0.1,
    far: patch.far || 1000,
    quaternion: patch.quaternion || null,
    target: patch.target || [0, 0.8, 0],
    followTargetId: patch.followTargetId || '',
    lookAtMode: patch.lookAtMode || 'origin',
    lookAtTargetId: patch.lookAtTargetId || '',
    showGuides: patch.showGuides === true,
  }
  return normalizeDirectorTimeline({
    ...withObject,
    cameras: [...withObject.cameras, camera],
    sequence: { ...withObject.sequence, activeCameraId: camera.id },
    revision: withObject.revision + 1,
  })
}

export function duplicateDirectorObject(state, objectId) {
  const current = normalizeDirectorTimeline(state)
  const source = current.objects.find((object) => object.id === String(objectId))
  if (!source) return current
  const transform = {
    position: [source.transform.position[0] + 0.5, source.transform.position[1], source.transform.position[2] + 0.5],
    rotation: [...source.transform.rotation], scale: [...source.transform.scale],
  }
  const sourceCamera = current.cameras.find((camera) => camera.objectId === source.id)
  if (sourceCamera) return appendDirectorCamera(current, { ...sourceCamera, id: undefined, objectId: undefined, name: `${source.name} 副本`, transform })
  return appendDirectorObject(current, source.type, {
    name: `${source.name} 副本`, parentId: source.parentId, visible: source.visible, assetRef: source.assetRef ? { ...source.assetRef } : null, transform,
  })
}

export function proportionalScaleFromAxis(startScale, currentScale) {
  const start = vector3(startScale, [1, 1, 1]).map((value) => Math.max(0.0001, value))
  const current = vector3(currentScale, start)
  const deltas = current.map((value, index) => Math.abs(value / start[index] - 1))
  const axis = deltas.reduce((best, value, index) => value > deltas[best] ? index : best, 0)
  const ratio = current[axis] / start[axis]
  return start.map((value) => Math.max(0.0001, value * ratio))
}

export function findActiveCameraObject(state) {
  const activeCamera = state?.cameras?.find((camera) => camera.id === state?.sequence?.activeCameraId)
  return state?.objects?.find((object) => object.id === activeCamera?.objectId && object.type === 'camera') || null
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
