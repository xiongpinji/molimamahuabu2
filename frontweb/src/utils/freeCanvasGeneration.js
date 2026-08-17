import { assetMediaUrl } from './mediaUrl.js'
import { imageModelMaxReferences, validateQuickImageSelection } from './homeQuickGeneration.js'
import { assertVideoDurationAllowed } from './videoDuration.js'
import { normalizeGenerationProgress } from './canvasGenerationProgress.js'

const FREE_NODE_KINDS = new Set(['text', 'image', 'video', 'audio'])
const FREE_NODE_STATUSES = new Set(['idle', 'queued', 'running', 'success', 'failed'])
const FREE_NODE_ASSET_SAVE_STATUSES = new Set(['idle', 'running', 'success', 'failed'])
const IMAGE_TOOL_STATUSES = new Set(['running', 'success', 'failed'])
const VIDEO_TOOL_STATUSES = new Set(['running', 'success', 'failed'])
const FREE_VIDEO_REFERENCE_MODES = new Set(['first-last', 'multi', 'omni'])
const VIDEO_TOOL_OPERATIONS = new Set([
  'crop',
  'upscale',
  'analyze',
  'remove_subtitles',
  'extract_audio',
  'mute',
  'edit',
])
const IMAGE_TOOL_RETRY_PARAMETERS = Object.freeze({
  crop: ['left', 'top', 'width', 'height'],
  compress: ['format', 'quality'],
  mirror: ['direction'],
  rotate: ['angle'],
  grid_crop: ['rows', 'columns'],
  smart_cutout: [],
  selection_cutout: ['left', 'top', 'width', 'height'],
  upscale: ['scale'],
  adjust: ['brightness', 'saturation', 'contrast', 'temperature'],
  lut: ['preset'],
  cinematic_relight: ['preset', 'intensity', 'description'],
  panorama: ['description'],
  panorama_scene: ['description'],
  image_ideation: ['description'],
  angle_ideation: ['description'],
  character_views: ['description'],
  narrative_grid: ['description'],
  frame_forward: ['description'],
  frame_backward: ['description'],
  portrait_texture: ['preset', 'intensity', 'description'],
  portrait_emotion: ['emotion', 'intensity', 'faceRegion'],
})
const VIDEO_TOOL_RETRY_PARAMETERS = Object.freeze({
  crop: ['x', 'y', 'width', 'height'],
  upscale: ['resolution', 'interpolate', 'slowMotion'],
  analyze: ['sceneThreshold', 'maxShots'],
  remove_subtitles: ['x', 'y', 'width', 'height'],
  extract_audio: [],
  mute: [],
  edit: ['transform', 'brightness', 'contrast', 'saturation', 'speed'],
})
const ASSET_TYPES = new Set(['image', 'video', 'audio'])

function freeCanvasTaskError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

export async function pollFreeCanvasTask(taskId, options = {}) {
  const {
    maxAttempts = 60,
    intervalMs = 3000,
    onProgress,
    getTask,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options
  if (typeof getTask !== 'function') throw new TypeError('getTask 必须是函数')

  let lastPollingError = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs)
    let task
    try {
      task = await getTask(taskId)
      lastPollingError = null
    } catch (error) {
      lastPollingError = error
      continue
    }
    const progress = normalizeGenerationProgress(task?.progress)
    if (progress !== null) await onProgress?.(progress)
    if (task?.status === 'completed') return task
    if (task?.status === 'failed') {
      throw freeCanvasTaskError(task?.error || task?.message || '自由节点生成失败', 'FREE_CANVAS_TASK_FAILED')
    }
    if (task?.status === 'needs_attention') {
      throw freeCanvasTaskError(
        task?.error || task?.message || '任务提交结果未知，请勿重复提交',
        'FREE_CANVAS_TASK_NEEDS_ATTENTION',
      )
    }
  }
  if (lastPollingError) {
    throw freeCanvasTaskError(
      '任务已提交，但当前无法查询状态；系统会继续保留任务，请不要重复提交',
      'FREE_CANVAS_TASK_STATUS_UNAVAILABLE',
    )
  }
  throw freeCanvasTaskError(
    '任务已提交且仍在处理中；系统会继续跟踪，请不要重复提交',
    'FREE_CANVAS_TASK_RESULT_PENDING',
  )
}

function cleanString(value) {
  return String(value ?? '').trim()
}

export function normalizeFreeCanvasVideoReferenceMode(value, references = []) {
  const mode = cleanString(value)
  if (FREE_VIDEO_REFERENCE_MODES.has(mode)) return mode
  const enabledReferences = (Array.isArray(references) ? references : [])
    .filter((reference) => reference?.enabled !== false)
  if (enabledReferences.some((reference) => ['video', 'audio'].includes(cleanString(reference?.kind)))) {
    return 'omni'
  }
  return enabledReferences.some((reference) => (
    ['first-frame', 'last-frame'].includes(cleanString(reference?.slot ?? reference?.input))
  )) ? 'first-last' : 'multi'
}

function hasDeclaredVideoReferenceCapability(capability = {}) {
  if (Array.isArray(capability?.referenceTypes)) return true
  return [
    'supportsFirstFrame',
    'supportsLastFrame',
    'supportsImageReference',
    'supportsVideoReference',
    'supportsAudioReference',
    'supportsOmniReference',
  ].some((key) => typeof capability?.[key] === 'boolean')
}

function usesLegacyVideoReferenceCapability(capability = {}) {
  return capability?.declared === false
    || (capability?.declared !== true && !hasDeclaredVideoReferenceCapability(capability))
}

export function selectFreeCanvasVideoReferenceMode(capability = {}, currentMode = '') {
  const mode = cleanString(currentMode)
  const legacyFallback = usesLegacyVideoReferenceCapability(capability)
  const referenceTypes = new Set((Array.isArray(capability?.referenceTypes)
    ? capability.referenceTypes
    : []).map((value) => cleanString(value).toLowerCase()))
  const supportsFirstLast = legacyFallback
    || capability?.supportsFirstFrame === true
    || capability?.supportsLastFrame === true
  const supportsImage = legacyFallback
    || capability?.supportsImageReference === true
    || (capability?.supportsImageReference !== false && referenceTypes.has('image'))
  const supportsVideo = legacyFallback
    || capability?.supportsVideoReference === true
    || (capability?.supportsVideoReference !== false && referenceTypes.has('video'))
  const supportsAudio = legacyFallback
    || capability?.supportsAudioReference === true
    || (capability?.supportsAudioReference !== false && referenceTypes.has('audio'))
  const supportsOmni = legacyFallback
    || capability?.supportsOmniReference === true
    || supportsVideo
    || supportsAudio
  const supported = (
    (mode === 'first-last' && supportsFirstLast)
    || (mode === 'multi' && supportsImage)
    || (mode === 'omni' && supportsOmni)
  )
  if (supported) return mode
  if (supportsFirstLast) return 'first-last'
  if (supportsImage) return 'multi'
  if (supportsOmni) return 'omni'
  return ''
}

export function resolveFreeCanvasVideoReferenceInput(mode, index) {
  const normalizedMode = normalizeFreeCanvasVideoReferenceMode(mode)
  if (normalizedMode !== 'first-last') return 'reference-image'
  if (index === 0) return 'first-frame'
  if (index === 1) return 'last-frame'
  return 'reference-image'
}

export function planFreeCanvasVideoReferences(capability = {}, currentMode = '', references = []) {
  const mode = selectFreeCanvasVideoReferenceMode(capability, currentMode)
  const legacyFallback = usesLegacyVideoReferenceCapability(capability)
  const source = Array.isArray(references) ? references : []
  const seen = new Set()
  const candidates = source
    .filter((reference) => reference?.ready !== false && cleanString(reference?.url))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || Number(b.weight || 1) - Number(a.weight || 1))
    .filter((reference) => {
      const kind = ['image', 'video', 'audio'].includes(reference?.kind) ? reference.kind : 'image'
      const key = `${kind}\u0000${cleanString(reference?.url)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const ordinalByReference = new Map()
  for (const kind of ['image', 'video', 'audio']) {
    candidates.filter((reference) => (reference.kind || 'image') === kind)
      .forEach((reference, index) => ordinalByReference.set(reference, index))
  }
  const imageLimit = legacyFallback
    ? nonNegativeInteger(capability.maxImageReferences ?? capability.maxReferences, 3)
    : nonNegativeInteger(capability.maxImageReferences ?? capability.maxReferences, 0)
  const videoLimit = legacyFallback
    ? nonNegativeInteger(capability.maxVideoReferences, 10)
    : nonNegativeInteger(capability.maxVideoReferences, 0)
  const audioLimit = legacyFallback
    ? nonNegativeInteger(capability.maxAudioReferences, 10)
    : nonNegativeInteger(capability.maxAudioReferences, 0)
  const supportsFirst = legacyFallback || capability.supportsFirstFrame === true
  const supportsLast = legacyFallback || capability.supportsLastFrame === true
  const referenceTypes = new Set((Array.isArray(capability.referenceTypes)
    ? capability.referenceTypes
    : []).map((value) => cleanString(value).toLowerCase()))
  const supportsImage = legacyFallback
    || capability.supportsImageReference === true
    || (capability.supportsImageReference !== false && referenceTypes.has('image'))
  const supportsVideo = legacyFallback
    || capability.supportsVideoReference === true
    || (capability.supportsVideoReference !== false && referenceTypes.has('video'))
  const supportsAudio = legacyFallback
    || capability.supportsAudioReference === true
    || (capability.supportsAudioReference !== false && referenceTypes.has('audio'))
  return source.map((reference) => {
    const kind = ['image', 'video', 'audio'].includes(reference?.kind) ? reference.kind : 'image'
    const index = ordinalByReference.has(reference) ? ordinalByReference.get(reference) : -1
    let enabled = false
    if (index >= 0 && kind === 'image') {
      enabled = mode === 'first-last'
        ? (index === 0 && supportsFirst) || (index === 1 && supportsLast)
        : ['multi', 'omni'].includes(mode) && supportsImage && index < imageLimit
    } else if (index >= 0 && kind === 'video') {
      enabled = mode === 'omni' && supportsVideo && index < videoLimit
    } else if (index >= 0 && kind === 'audio') {
      enabled = mode === 'omni' && supportsAudio && index < audioLimit
    }
    return {
      reference,
      input: kind === 'image' && index >= 0
        ? resolveFreeCanvasVideoReferenceInput(mode, index)
        : reference?.slot,
      enabled,
    }
  })
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function opaqueConfigId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined
  const number = Number(value.trim())
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanString(value))
    .filter(Boolean))]
}

export function normalizeFreeCanvasSubmissionReferences(references = []) {
  const seen = new Set()
  return (Array.isArray(references) ? references : [])
    .filter((reference) => (
      reference?.enabled !== false
      && reference?.ready !== false
      && cleanString(reference?.url)
    ))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || Number(b.weight || 1) - Number(a.weight || 1))
    .filter((reference) => {
      const kind = ['image', 'video', 'audio'].includes(reference?.kind) ? reference.kind : 'image'
      const key = `${kind}\u0000${cleanString(reference?.url)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function booleanValue(value) {
  return value === true
}

function jsonObject(value, maxLength = 120000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const json = JSON.stringify(value)
    if (!json || json.length > maxLength) return null
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeScriptAnalysisProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const sourceType = cleanString(value.sourceType)
  if (!sourceType) return null
  return withoutEmptyFields({
    projectId: value.projectId ?? null,
    version: value.version ?? null,
    sourceType,
    sourceId: cleanString(value.sourceId),
    skillId: cleanString(value.skillId),
    skillVersion: cleanString(value.skillVersion),
  })
}

function normalizeSkillSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = cleanString(value.id)
  const version = cleanString(value.version)
  if (!id || !version) return null
  return withoutEmptyFields({
    id,
    version,
    name: cleanString(value.name),
    module: cleanString(value.module),
    output_schema_version: cleanString(value.output_schema_version),
  })
}

function imageSizeFromResolution(aspectRatio, resolution) {
  const longEdge = { '1k': 1024, '2k': 2048, '4k': 4096 }[cleanString(resolution).toLowerCase()]
  if (!longEdge) return ''
  const [rawWidth, rawHeight] = cleanString(aspectRatio).split(':').map(Number)
  if (!rawWidth || !rawHeight) return ''
  const landscape = rawWidth >= rawHeight
  const width = landscape ? longEdge : Math.round(longEdge * rawWidth / rawHeight)
  const height = landscape ? Math.round(longEdge * rawHeight / rawWidth) : longEdge
  const even = (value) => Math.max(2, Math.round(value / 2) * 2)
  return `${even(width)}x${even(height)}`
}

function decoratedVideoPrompt(nodeData) {
  return [
    nodeData.content,
    nodeData.cameraMovement ? `镜头运动：${nodeData.cameraMovement}` : '',
    nodeData.effect ? `视觉特效：${nodeData.effect}` : '',
    nodeData.includeAudio ? '音频要求：生成与画面同步的对白、环境音或音效。' : '',
  ].filter(Boolean).join('\n')
}

function withoutEmptyFields(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => {
      if (value == null || value === '') return false
      if (Array.isArray(value) && value.length === 0) return false
      return true
    })
  )
}

function staticLocalPathUrl(value) {
  const path = cleanString(value)
  if (!path) return ''
  return path.startsWith('/static/') ? path : `/static/${path.replace(/^\/+/, '')}`
}

function firstString(...values) {
  for (const value of values) {
    const text = cleanString(value)
    if (text) return text
  }
  return ''
}

function normalizeImageToolHistory(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).map((item) => {
    if (!item || typeof item !== 'object') return null
    const taskId = cleanString(item.taskId)
    const operation = cleanString(item.operation)
    if (!taskId || !operation) return null
    return withoutEmptyFields({
      taskId,
      operation,
      status: cleanString(item.status),
      resultAssetId: positiveInteger(item.resultAssetId),
      resultUrl: cleanString(item.resultUrl),
      createdAt: cleanString(item.createdAt),
    })
  }).filter(Boolean)
}

function normalizeImageToolResultAssets(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 25).map((item) => {
    if (!item || typeof item !== 'object') return null
    const id = positiveInteger(item.id)
    const url = cleanString(item.url)
    return id && url ? { id, url } : null
  }).filter(Boolean)
}

function normalizeImageToolRetryParameters(operation, value) {
  const keys = IMAGE_TOOL_RETRY_PARAMETERS[operation]
  if (!keys) return undefined
  if (keys.length === 0) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const stringLimits = ['cinematic_relight', 'portrait_texture'].includes(operation)
    ? { preset: 32, description: 300 }
    : (
      [
        'panorama',
        'panorama_scene',
        'image_ideation',
        'angle_ideation',
        'character_views',
        'narrative_grid',
        'frame_forward',
        'frame_backward',
      ].includes(operation)
        ? { description: 300 }
        : {}
    )
  const parameters = {}
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      parameters[key] = candidate
    } else if (typeof candidate === 'string') {
      const limit = stringLimits[key] || 32
      if (candidate.length > limit) return undefined
      parameters[key] = candidate
    }
  }
  if (operation === 'portrait_emotion') {
    if (
      !Number.isInteger(parameters.intensity)
      || parameters.intensity < 1
      || parameters.intensity > 5
      || value.faceRegion === undefined
    ) {
      return undefined
    }
    const region = value.faceRegion
    const faceRegion = region && typeof region === 'object' && !Array.isArray(region)
      ? {
        x: Number(region.x),
        y: Number(region.y),
        width: Number(region.width),
        height: Number(region.height),
      }
      : null
    if (
      !faceRegion
      || Object.values(faceRegion).some((item) => !Number.isFinite(item))
      || faceRegion.x < 0
      || faceRegion.y < 0
      || faceRegion.width <= 0
      || faceRegion.height <= 0
      || faceRegion.x + faceRegion.width > 1
      || faceRegion.y + faceRegion.height > 1
    ) {
      return undefined
    }
    parameters.faceRegion = faceRegion
  }
  return Object.keys(parameters).length ? parameters : undefined
}

function normalizeVideoToolRetryParameters(operation, value) {
  const keys = VIDEO_TOOL_RETRY_PARAMETERS[operation]
  if (!keys) return undefined
  if (keys.length === 0) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const parameters = {}
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      parameters[key] = candidate
    } else if (typeof candidate === 'boolean' && key === 'interpolate') {
      parameters[key] = candidate
    } else if (typeof candidate === 'string' && candidate.length <= 32) {
      parameters[key] = candidate
    }
  }
  return Object.keys(parameters).length ? parameters : undefined
}

function normalizeVideoToolHistory(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).map((item) => {
    if (!item || typeof item !== 'object') return null
    const taskId = cleanString(item.taskId)
    const operation = cleanString(item.operation)
    if (!taskId || !VIDEO_TOOL_OPERATIONS.has(operation)) return null
    return withoutEmptyFields({
      taskId,
      operation,
      status: cleanString(item.status),
      resultAssetId: positiveInteger(item.resultAssetId),
      resultUrl: cleanString(item.resultUrl),
      createdAt: cleanString(item.createdAt),
    })
  }).filter(Boolean)
}

function normalizeVideoStory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const shots = (Array.isArray(value.shots) ? value.shots : []).slice(0, 120).map((shot) => {
    if (!shot || typeof shot !== 'object') return null
    const index = positiveInteger(shot.index)
    const startTime = finiteNumber(shot.startTime)
    const endTime = finiteNumber(shot.endTime)
    const duration = positiveNumber(shot.duration)
    if (!index || startTime == null || endTime == null || !duration) return null
    return withoutEmptyFields({
      index,
      startTime,
      endTime,
      duration,
      keyframeAssetId: positiveInteger(shot.keyframeAssetId),
      keyframeUrl: cleanString(shot.keyframeUrl),
      visualDescription: cleanString(shot.visualDescription).slice(0, 500),
      narrative: cleanString(shot.narrative).slice(0, 500),
      camera: cleanString(shot.camera).slice(0, 200),
    })
  }).filter(Boolean)
  return {
    width: positiveInteger(value.width),
    height: positiveInteger(value.height),
    duration: positiveNumber(value.duration),
    hasAudio: booleanValue(value.hasAudio),
    fps: positiveNumber(value.fps),
    sceneThreshold: positiveNumber(value.sceneThreshold),
    shots,
  }
}

export function normalizeFreeCanvasNodeData(data = {}) {
  const kind = cleanString(data.kind)
  if (!FREE_NODE_KINDS.has(kind)) return null

  const normalized = {
    kind,
    title: cleanString(data.title),
    content: cleanString(data.content),
    url: cleanString(data.url),
  }
  const scriptAnalysis = normalizeScriptAnalysisProvenance(data.scriptAnalysis)
  if (scriptAnalysis) normalized.scriptAnalysis = scriptAnalysis
  if (scriptAnalysis?.sourceType === 'visual_direction') {
    const visualDirection = jsonObject(data.visualDirection)
    const skillSnapshot = normalizeSkillSnapshot(data.skillSnapshot)
    if (visualDirection) normalized.visualDirection = visualDirection
    if (skillSnapshot) normalized.skillSnapshot = skillSnapshot
  }
  if (Object.hasOwn(data, 'model')) normalized.model = cleanString(data.model)
  if (Object.hasOwn(data, 'aspectRatio')) normalized.aspectRatio = cleanString(data.aspectRatio)
  if (Object.hasOwn(data, 'duration')) normalized.duration = positiveNumber(data.duration)
  if (Object.hasOwn(data, 'style')) normalized.style = cleanString(data.style)
  if (Object.hasOwn(data, 'resolution')) normalized.resolution = cleanString(data.resolution)
  if (Object.hasOwn(data, 'quantity')) normalized.quantity = positiveInteger(data.quantity)
  if (Object.hasOwn(data, 'negativePrompt')) normalized.negativePrompt = cleanString(data.negativePrompt)
  if (Object.hasOwn(data, 'voiceId')) normalized.voiceId = cleanString(data.voiceId)
  if (Object.hasOwn(data, 'speechRate')) normalized.speechRate = positiveNumber(data.speechRate)
  if (Object.hasOwn(data, 'speechVolume')) normalized.speechVolume = positiveNumber(data.speechVolume)
  if (Object.hasOwn(data, 'speechPitch')) normalized.speechPitch = finiteNumber(data.speechPitch)
  if (Object.hasOwn(data, 'speechEmotion')) normalized.speechEmotion = cleanString(data.speechEmotion)
  if (Object.hasOwn(data, 'pronunciationTones')) {
    normalized.pronunciationTones = uniqueStrings(data.pronunciationTones)
  }
  if (Object.hasOwn(data, 'cameraMovement')) normalized.cameraMovement = cleanString(data.cameraMovement)
  if (Object.hasOwn(data, 'effect')) normalized.effect = cleanString(data.effect)
  if (Object.hasOwn(data, 'includeAudio')) normalized.includeAudio = booleanValue(data.includeAudio)
  if (Object.hasOwn(data, 'characterReferenceUrls')) {
    normalized.characterReferenceUrls = uniqueStrings(data.characterReferenceUrls)
  }
  if (Object.hasOwn(data, 'resultUrls')) normalized.resultUrls = uniqueStrings(data.resultUrls)
  if (Object.hasOwn(data, 'taskId')) normalized.taskId = cleanString(data.taskId)
  if (Object.hasOwn(data, 'progress')) {
    normalized.progress = Math.min(100, Math.max(0, finiteNumber(data.progress)))
  }
  if (Object.hasOwn(data, 'progressKnown')) normalized.progressKnown = booleanValue(data.progressKnown)
  if (Object.hasOwn(data, 'generationActive')) normalized.generationActive = booleanValue(data.generationActive)
  if (Object.hasOwn(data, 'generationBatchSize')) {
    normalized.generationBatchSize = positiveInteger(data.generationBatchSize)
  }
  if (Object.hasOwn(data, 'generationTaskBaseCount')) {
    const taskBaseCount = Number(data.generationTaskBaseCount)
    if (Number.isInteger(taskBaseCount) && taskBaseCount >= 0) normalized.generationTaskBaseCount = taskBaseCount
  }
  if (Object.hasOwn(data, 'status')) {
    const status = cleanString(data.status)
    if (FREE_NODE_STATUSES.has(status)) normalized.status = status
  }
  if (Object.hasOwn(data, 'error')) normalized.error = cleanString(data.error)
  if (Object.hasOwn(data, 'savedAssetId')) normalized.savedAssetId = cleanString(data.savedAssetId)
  if (Object.hasOwn(data, 'savedAssetLocalPath')) {
    normalized.savedAssetLocalPath = cleanString(data.savedAssetLocalPath)
  }
  if (Object.hasOwn(data, 'assetSaveStatus')) {
    const assetSaveStatus = cleanString(data.assetSaveStatus)
    if (FREE_NODE_ASSET_SAVE_STATUSES.has(assetSaveStatus)) normalized.assetSaveStatus = assetSaveStatus
  }
  if (Object.hasOwn(data, 'assetSaveError')) normalized.assetSaveError = cleanString(data.assetSaveError)
  if (Object.hasOwn(data, 'sourceVideoToolNodeId')) {
    normalized.sourceVideoToolNodeId = cleanString(data.sourceVideoToolNodeId)
  }
  const videoToolOperation = cleanString(data.videoToolOperation)
  if (VIDEO_TOOL_OPERATIONS.has(videoToolOperation)) normalized.videoToolOperation = videoToolOperation
  if (Object.hasOwn(data, 'videoToolTaskId')) {
    normalized.videoToolTaskId = cleanString(data.videoToolTaskId)
  }
  if (kind === 'text' && Object.hasOwn(data, 'videoStory')) {
    const videoStory = normalizeVideoStory(data.videoStory)
    if (videoStory) normalized.videoStory = videoStory
  }
  if (kind === 'video') {
    const videoReferenceMode = cleanString(data.videoReferenceMode)
    if (FREE_VIDEO_REFERENCE_MODES.has(videoReferenceMode)) {
      normalized.videoReferenceMode = videoReferenceMode
    }
    const videoToolStatus = cleanString(data.videoToolStatus)
    if (VIDEO_TOOL_STATUSES.has(videoToolStatus)) normalized.videoToolStatus = videoToolStatus
    if (Object.hasOwn(data, 'videoToolError')) normalized.videoToolError = cleanString(data.videoToolError)
    const retryOperation = cleanString(data.videoToolRetryOperation)
    const retryParameters = normalizeVideoToolRetryParameters(
      retryOperation,
      data.videoToolRetryParameters,
    )
    if (retryParameters) {
      normalized.videoToolRetryOperation = retryOperation
      normalized.videoToolRetryParameters = retryParameters
    }
    if (Object.hasOwn(data, 'videoToolHistory')) {
      normalized.videoToolHistory = normalizeVideoToolHistory(data.videoToolHistory)
    }
  }
  if (kind === 'image') {
    const markerColor = cleanString(data.imageMarkerColor)
    if (/^#[0-9a-f]{6}$/i.test(markerColor)) normalized.imageMarkerColor = markerColor
    if (Object.hasOwn(data, 'imageToolTaskId')) {
      normalized.imageToolTaskId = cleanString(data.imageToolTaskId)
    }
    const imageToolStatus = cleanString(data.imageToolStatus)
    if (IMAGE_TOOL_STATUSES.has(imageToolStatus)) normalized.imageToolStatus = imageToolStatus
    if (Object.hasOwn(data, 'imageToolError')) {
      normalized.imageToolError = cleanString(data.imageToolError)
    }
    const retryOperation = cleanString(data.imageToolRetryOperation)
    const retryParameters = normalizeImageToolRetryParameters(
      retryOperation,
      data.imageToolRetryParameters,
    )
    if (retryParameters) {
      normalized.imageToolRetryOperation = retryOperation
      normalized.imageToolRetryParameters = retryParameters
    }
    if (Object.hasOwn(data, 'imageToolHistory')) {
      normalized.imageToolHistory = normalizeImageToolHistory(data.imageToolHistory)
    }
    if (Object.hasOwn(data, 'imageToolResultAssets')) {
      normalized.imageToolResultAssets = normalizeImageToolResultAssets(data.imageToolResultAssets)
    }
    if (Object.hasOwn(data, 'sourceImageToolNodeId')) {
      normalized.sourceImageToolNodeId = cleanString(data.sourceImageToolNodeId)
    }
    if (Object.hasOwn(data, 'imageToolOperation')) {
      normalized.imageToolOperation = cleanString(data.imageToolOperation)
    }
  }
  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined)
  )
}

export function normalizeFreeCanvasNode(node = {}) {
  if (!node?.id || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) return null
  const data = normalizeFreeCanvasNodeData(node.data)
  if (!data) return null
  return {
    id: String(node.id),
    type: 'homeCanvasNode',
    position: { x: node.position.x, y: node.position.y },
    data,
  }
}

export function buildFreeCanvasGenerationRequest(data = {}, options = {}) {
  const nodeData = normalizeFreeCanvasNodeData(data)
  if (!nodeData) return null
  const content = uniqueStrings([
    ...(options.upstreamTexts || []),
    nodeData.content,
  ]).join('\n\n')
  const capability = options.capability && typeof options.capability === 'object'
    ? options.capability
    : {}
  const capabilityDeclared = capability.declared === true
    || (capability.declared !== false && Object.keys(capability).length > 0)
  const configuredMaxReferences = nonNegativeInteger(options.maxReferences, 10)
  const verifiedMaxReferences = nodeData.kind === 'image' ? imageModelMaxReferences(nodeData.model) : null
  const maxReferences = verifiedMaxReferences == null
    ? configuredMaxReferences
    : Math.min(configuredMaxReferences, verifiedMaxReferences)
  const rawReferences = normalizeFreeCanvasSubmissionReferences(options.upstreamReferences)
  const requestedVideoReferenceMode = nodeData.kind === 'video'
    ? normalizeFreeCanvasVideoReferenceMode(nodeData.videoReferenceMode, options.upstreamReferences)
    : ''
  const selectedVideoReferenceMode = nodeData.kind === 'video'
    ? selectFreeCanvasVideoReferenceMode(capability, requestedVideoReferenceMode)
    : ''
  const references = nodeData.kind === 'video'
    ? planFreeCanvasVideoReferences(
      capability,
      selectedVideoReferenceMode,
      (options.upstreamReferences || []).filter((reference) => reference?.enabled !== false),
    )
      .filter(({ enabled }) => enabled)
      .map(({ reference, input }) => ({ ...reference, slot: input }))
    : rawReferences
  const imageReferences = references.filter((reference) => (reference.kind || 'image') === 'image')
  const upstreamImageUrls = uniqueStrings([
    ...(imageReferences.length ? [] : (options.upstreamUrls || [])),
    ...imageReferences.map((reference) => reference.url),
  ])
  const videoReferences = references.filter((reference) => reference.kind === 'video')
  const audioReferences = references.filter((reference) => reference.kind === 'audio')
  const referenceUrls = uniqueStrings([
    ...upstreamImageUrls,
    ...(nodeData.characterReferenceUrls || []),
  ])
  if (nodeData.kind === 'image' && referenceUrls.length > maxReferences) {
    throw new Error(`当前模型最多支持 ${maxReferences} 张参考图，请先移除多余参考图`)
  }

  if (nodeData.kind === 'text') {
    const dramaId = requirePositiveDramaId(options.dramaId, '自由节点生成缺少有效项目 ID')
    return withoutEmptyFields({
      drama_id: dramaId,
      prompt: content,
      model: nodeData.model,
    })
  }

  if (nodeData.kind === 'image') {
    const dramaId = requirePositiveDramaId(options.dramaId, '自由节点生成缺少有效项目 ID')
    const declaredImageReferenceLimit = nonNegativeInteger(
      options.capability?.maxReferences,
      maxReferences,
    )
    const imageReferenceLimit = Math.min(declaredImageReferenceLimit, maxReferences)
    if (referenceUrls.length > imageReferenceLimit) {
      if (imageReferenceLimit === 0) {
        throw new Error(`${nodeData.model || '当前图片模型'} 当前不支持参考图`)
      }
      throw new Error(`${nodeData.model || '当前图片模型'} 最多支持 ${imageReferenceLimit} 个图片参考`)
    }
    const resolution = cleanString(nodeData.resolution || '1k').toLowerCase()
    const quantity = positiveInteger(nodeData.quantity) || 1
    validateQuickImageSelection({ model: nodeData.model, resolution, quantity })
    return withoutEmptyFields({
      drama_id: dramaId,
      prompt: content,
      model: nodeData.model,
      config_id: opaqueConfigId(options.configId),
      aspect_ratio: nodeData.aspectRatio,
      style: nodeData.style,
      resolution,
      size: imageSizeFromResolution(nodeData.aspectRatio, resolution),
      n: quantity,
      negative_prompt: nodeData.negativePrompt,
      reference_images: referenceUrls,
    })
  }

  if (nodeData.kind === 'video') {
    const dramaId = requirePositiveDramaId(options.dramaId, '自由节点生成缺少有效项目 ID')
    const labels = { image: '图片', audio: '音频', video: '视频' }
    const resolutions = uniqueStrings(capability.resolutions).map((value) => value.toLowerCase())
    const hasDeclaredResolutionContract = capabilityDeclared && Array.isArray(capability.resolutions)
    const resolution = hasDeclaredResolutionContract && !resolutions.length
      ? ''
      : cleanString(nodeData.resolution || '720p').toLowerCase()
    if (resolutions.length && !resolutions.includes(resolution)) {
      throw new Error(`当前模型视频清晰度仅支持 ${resolutions.join('、')}`)
    }
    const duration = capabilityDeclared && Array.isArray(capability.durations) && capability.durations.length
      ? assertVideoDurationAllowed(nodeData.duration, capability)
      : nodeData.duration
    const explicitMode = FREE_VIDEO_REFERENCE_MODES.has(cleanString(nodeData.videoReferenceMode))
      && Boolean(selectedVideoReferenceMode)
    const referenceMode = selectedVideoReferenceMode
    const firstFrameReference = imageReferences[0]
    const lastFrameReference = imageReferences[1]
    const hasOmniReferences = imageReferences.length > 2
      || videoReferences.length > 0
      || audioReferences.length > 0
      || (nodeData.characterReferenceUrls || []).length > 0
    if (explicitMode && referenceMode === 'first-last' && hasOmniReferences) {
      throw new Error('首尾帧模式与全能参考模式互斥，请移除全能参考素材或切换模式')
    }
    if (explicitMode && referenceMode === 'multi' && (videoReferences.length || audioReferences.length)) {
      throw new Error('多图参考模式仅支持参考图片，请切换全能参考模式')
    }
    const referenceTypes = uniqueStrings(capability.referenceTypes).map((value) => value.toLowerCase())
    const supportKeys = {
      image: 'supportsImageReference',
      video: 'supportsVideoReference',
      audio: 'supportsAudioReference',
    }
    const supportsReference = (type) => {
      const declaredSupport = capability[supportKeys[type]]
      if (declaredSupport === true) return true
      if (declaredSupport === false) return false
      return referenceTypes.includes(type)
    }
    if (capabilityDeclared) {
      if (referenceMode === 'first-last' && firstFrameReference && capability.supportsFirstFrame !== true) {
        throw new Error(`${nodeData.model || '当前视频模型'} 当前不支持首帧参考`)
      }
      if (referenceMode === 'first-last' && lastFrameReference && capability.supportsLastFrame !== true) {
        throw new Error(`${nodeData.model || '当前视频模型'} 当前不支持尾帧参考`)
      }
      if (referenceMode !== 'first-last' && imageReferences.length && !supportsReference('image')) {
        throw new Error(`${nodeData.model || '当前视频模型'} 当前不支持图片参考`)
      }
      if (videoReferences.length && !supportsReference('video')) {
        throw new Error(`${nodeData.model || '当前视频模型'} 当前不支持视频参考`)
      }
      if (audioReferences.length && !supportsReference('audio')) {
        throw new Error(`${nodeData.model || '当前视频模型'} 当前不支持音频参考`)
      }
      if (nodeData.includeAudio === true && capability.supportsAudio !== true) {
        throw new Error(`${nodeData.model || '当前视频模型'} 当前不支持同步音频`)
      }
    }
    const referenceImageUrls = references.length
      ? uniqueStrings([
        ...imageReferences.map((reference) => reference.url),
        ...(nodeData.characterReferenceUrls || []),
      ])
      : referenceUrls
    const maxImageReferences = capabilityDeclared
      ? nonNegativeInteger(capability.maxImageReferences ?? capability.maxReferences, 0)
      : nonNegativeInteger(capability.maxImageReferences ?? capability.maxReferences, maxReferences)
    const maxAudioReferences = capabilityDeclared
      ? nonNegativeInteger(capability.maxAudioReferences, 0)
      : 10
    const maxVideoReferences = capabilityDeclared
      ? nonNegativeInteger(capability.maxVideoReferences, 0)
      : 10
    const audioReferenceUrls = uniqueStrings(audioReferences.map((reference) => reference.url))
    const videoReferenceUrls = uniqueStrings(videoReferences.map((reference) => reference.url))
    for (const [type, urls, limit] of [
      ['image', referenceImageUrls, maxImageReferences],
      ['audio', audioReferenceUrls, maxAudioReferences],
      ['video', videoReferenceUrls, maxVideoReferences],
    ]) {
      if (type === 'image' && explicitMode && referenceMode === 'first-last') continue
      if (urls.length > limit) {
        throw new Error(`${nodeData.model || '当前视频模型'} 最多支持 ${limit} 个${labels[type]}参考`)
      }
    }
    if (explicitMode && referenceMode === 'first-last') {
      return withoutEmptyFields({
        drama_id: dramaId,
        prompt: decoratedVideoPrompt({ ...nodeData, content }),
        model: nodeData.model,
        reference_mode: 'first_last',
        image_url: firstFrameReference?.url,
        first_frame_url: firstFrameReference?.url,
        last_frame_url: lastFrameReference?.url,
        aspect_ratio: nodeData.aspectRatio,
        duration,
        style: nodeData.style,
        resolution,
        ...(capability.supportsAudio === true ? { generate_audio: nodeData.includeAudio === true } : {}),
      })
    }
    const firstFrameUrl = imageReferences.find((reference) => reference.slot === 'first-frame')?.url || ''
    const lastFrameUrl = imageReferences.find((reference) => reference.slot === 'last-frame')?.url || ''
    return withoutEmptyFields({
      drama_id: dramaId,
      prompt: decoratedVideoPrompt({ ...nodeData, content }),
      model: nodeData.model,
      ...(explicitMode ? { reference_mode: 'omni' } : {}),
      ...(!explicitMode ? {
        image_url: firstFrameUrl,
        first_frame_url: firstFrameUrl,
        last_frame_url: lastFrameUrl,
      } : {}),
      reference_image_urls: referenceImageUrls,
      reference_video_urls: videoReferenceUrls,
      reference_audio_urls: audioReferenceUrls,
      aspect_ratio: nodeData.aspectRatio,
      duration,
      style: nodeData.style,
      resolution,
      ...(capability.supportsAudio === true ? { generate_audio: nodeData.includeAudio === true } : {}),
    })
  }

  if (nodeData.kind === 'audio') {
    const dramaId = requirePositiveDramaId(options.dramaId, '自由节点生成缺少有效项目 ID')
    return withoutEmptyFields({
      drama_id: dramaId,
      text: content,
      tts_model: nodeData.model,
      voice_id: nodeData.voiceId,
      speed: nodeData.speechRate,
      volume: nodeData.speechVolume,
      pitch: nodeData.speechPitch,
      emotion: nodeData.speechEmotion,
      pronunciation_tones: nodeData.pronunciationTones,
    })
  }

  return null
}

export function collectDirectUpstreamResultUrls(nodes = [], edges = [], targetNodeId = '') {
  return uniqueStrings(collectDirectUpstreamImageReferences(nodes, edges, targetNodeId)
    .map((reference) => reference.url)
    .filter(Boolean))
}

export function collectDirectUpstreamImageReferences(nodes = [], edges = [], targetNodeId = '') {
  return collectDirectUpstreamMediaReferences(nodes, edges, targetNodeId)
    .filter((reference) => reference.kind === 'image')
}

export function collectDirectUpstreamMediaReferences(nodes = [], edges = [], targetNodeId = '') {
  const target = String(targetNodeId || '')
  if (!target) return []
  const byId = new Map((Array.isArray(nodes) ? nodes : [])
    .filter((node) => node?.id)
    .map((node) => [String(node.id), node]))
  const references = []
  const seen = new Set()
  for (const edge of edges || []) {
    if (String(edge?.target || '') !== target) continue
    const sourceId = String(edge?.source || '')
    const source = byId.get(sourceId)
    const sourceKind = getFreeCanvasNodeResultKind(source)
    if (!['image', 'audio', 'video'].includes(sourceKind) || !sourceId || seen.has(sourceId)) continue
    seen.add(sourceId)
    const contract = edge?.data?.contract || {}
    const url = getFreeCanvasNodeResultUrl(source)
    references.push({
      kind: sourceKind,
      nodeId: String(source.id),
      edgeId: String(edge?.id || ''),
      title: cleanString(source.data?.title || source.data?.label || source.data?.asset?.name) || `${{ image: '图片', audio: '音频', video: '视频' }[sourceKind]}节点`,
      url,
      kind: sourceKind,
      ready: Boolean(url),
      slot: cleanString(contract.input) || `reference-${sourceKind}`,
      enabled: contract.enabled !== false,
      order: Number.isFinite(Number(contract.order)) ? Number(contract.order) : references.length,
      weight: Number.isFinite(Number(contract.weight)) ? Number(contract.weight) : 1,
    })
  }
  return references.sort((a, b) => a.order - b.order)
}

export function buildFreeCanvasReferenceMentionCandidates(references = []) {
  return (Array.isArray(references) ? references : [])
    .map((reference, index) => ({
      nodeId: String(reference?.nodeId || ''),
      title: reference?.title || '图片节点',
      label: `图片${index + 1}`,
      mentionToken: `@图片${index + 1}`,
      url: reference?.url,
      ready: reference?.ready,
      enabled: reference?.enabled,
    }))
    .filter((reference) => reference.nodeId && reference.ready && reference.enabled !== false)
}

export function collectDirectUpstreamTextInputs(nodes = [], edges = [], targetNodeId = '') {
  const target = String(targetNodeId || '')
  if (!target) return []
  const byId = new Map((Array.isArray(nodes) ? nodes : [])
    .filter((node) => node?.id)
    .map((node) => [String(node.id), node]))
  const texts = []
  const seen = new Set()
  for (const edge of edges || []) {
    if (String(edge?.target || '') !== target) continue
    const source = byId.get(String(edge.source || ''))
    const sourceKind = cleanString(source?.data?.kind)
    const sourceId = String(source?.id || '')
    if (!['text', 'universal'].includes(sourceKind) || !sourceId || seen.has(sourceId)) continue
    seen.add(sourceId)
    const content = cleanString(source?.data?.content)
    if (content) texts.push(content)
  }
  return uniqueStrings(texts)
}

export function buildFreeCanvasProjectAssetPayload({
  dramaId,
  nodeId,
  name,
  taskId,
  model,
  type,
  url,
  requestPayload,
} = {}) {
  const assetType = cleanString(type)
  if (!ASSET_TYPES.has(assetType)) return null
  const validDramaId = requirePositiveDramaId(dramaId, '自由节点素材入库缺少有效项目 ID')
  const assetUrl = cleanString(url)
  const resultFilename = assetUrl.split(/[?#]/)[0].split('/').pop()
  return {
    drama_id: validDramaId,
    storyboard_id: null,
    name: cleanString(name) || resultFilename || '未命名画布结果',
    category: 'canvas-result',
    type: assetType,
    url: assetUrl,
    metadata: {
      canvas_node_id: cleanString(nodeId),
      task_id: cleanString(taskId),
      model: cleanString(model),
      request_payload: requestPayload || null,
    },
  }
}

export function isCanvasGeneratedResultAsset(asset) {
  if (!['image', 'video'].includes(asset?.type) || asset?.category !== 'canvas-result') return false
  const metadata = asset?.metadata && typeof asset.metadata === 'object' ? asset.metadata : {}
  return Boolean(
    metadata.canvas_node_id
    || metadata.source === 'canvas_node_result'
    || metadata.auto_saved === true
  )
}

function requirePositiveDramaId(value, message) {
  const dramaId = positiveInteger(value)
  if (!dramaId) throw new Error(message)
  return dramaId
}

export function resolveFreeCanvasResultUrl(kind, response = {}) {
  const resultKind = cleanString(kind)
  const normalizedResponse = response || {}
  const result = normalizedResponse?.result || normalizedResponse?.task?.result || normalizedResponse || {}
  if (resultKind === 'image') {
    return firstString(
      result.image_url,
      result.url,
      normalizedResponse.image_url,
      normalizedResponse.url,
      staticLocalPathUrl(result.local_path || normalizedResponse.local_path)
    )
  }
  if (resultKind === 'video') {
    const record = normalizedResponse?.video || normalizedResponse?.videoRecord || normalizedResponse?.record || {}
    return firstString(
      staticLocalPathUrl(result.local_path || normalizedResponse.local_path || record.local_path),
      result.video_url,
      result.url,
      normalizedResponse.video_url,
      normalizedResponse.url,
      record.video_url,
      record.url
    )
  }
  if (resultKind === 'audio') {
    return firstString(
      result.url,
      result.audio_url,
      result.voice_url,
      normalizedResponse.url,
      normalizedResponse.audio_url,
      normalizedResponse.voice_url,
      staticLocalPathUrl(result.local_path || normalizedResponse.local_path)
    )
  }
  return ''
}

export function getFreeCanvasNodeResultUrl(node) {
  const data = node?.data || {}
  return firstString(
    data.url,
    data.resultUrl,
    data.resultUrls?.[0],
    data.savedAssetUrl,
    data.status?.resultUrl,
    data.status?.savedAssetUrl,
    assetMediaUrl(data.asset),
  )
}

function getFreeCanvasNodeResultKind(node) {
  const data = node?.data || {}
  const declaredKind = cleanString(data.kind || data.asset?.type).toLowerCase()
  if (FREE_NODE_KINDS.has(declaredKind)) return declaredKind
  if (!data.asset) return ''
  if (data.asset.video_url || data.asset.video_local_path) return 'video'
  if (data.asset.audio_url || data.asset.audio_local_path || data.asset.voice_url || data.asset.voice_local_path) return 'audio'
  const url = assetMediaUrl(data.asset).toLowerCase().split(/[?#]/)[0]
  if (/\.(mp4|webm|mov|m4v)$/.test(url)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(url)) return 'audio'
  return url ? 'image' : ''
}
