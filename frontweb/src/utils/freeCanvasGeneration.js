const FREE_NODE_KINDS = new Set(['text', 'image', 'video', 'audio'])
const FREE_NODE_STATUSES = new Set(['idle', 'queued', 'running', 'success', 'failed'])
const FREE_NODE_ASSET_SAVE_STATUSES = new Set(['idle', 'running', 'success', 'failed'])
const IMAGE_TOOL_STATUSES = new Set(['running', 'success', 'failed'])
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
})
const ASSET_TYPES = new Set(['image', 'video', 'audio'])

function cleanString(value) {
  return String(value ?? '').trim()
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanString(value))
    .filter(Boolean))]
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
  const stringLimits = operation === 'cinematic_relight'
    ? { preset: 32, description: 300 }
    : (['panorama', 'panorama_scene'].includes(operation) ? { description: 300 } : {})
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
  return Object.keys(parameters).length ? parameters : undefined
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
  if (Object.hasOwn(data, 'model')) normalized.model = cleanString(data.model)
  if (Object.hasOwn(data, 'aspectRatio')) normalized.aspectRatio = cleanString(data.aspectRatio)
  if (Object.hasOwn(data, 'duration')) normalized.duration = positiveNumber(data.duration)
  if (Object.hasOwn(data, 'taskId')) normalized.taskId = cleanString(data.taskId)
  if (Object.hasOwn(data, 'status')) {
    const status = cleanString(data.status)
    if (FREE_NODE_STATUSES.has(status)) normalized.status = status
  }
  if (Object.hasOwn(data, 'error')) normalized.error = cleanString(data.error)
  if (Object.hasOwn(data, 'savedAssetId')) normalized.savedAssetId = cleanString(data.savedAssetId)
  if (Object.hasOwn(data, 'assetSaveStatus')) {
    const assetSaveStatus = cleanString(data.assetSaveStatus)
    if (FREE_NODE_ASSET_SAVE_STATUSES.has(assetSaveStatus)) normalized.assetSaveStatus = assetSaveStatus
  }
  if (Object.hasOwn(data, 'assetSaveError')) normalized.assetSaveError = cleanString(data.assetSaveError)
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
  const upstreamUrls = uniqueStrings(options.upstreamUrls)

  if (nodeData.kind === 'image') {
    const dramaId = requirePositiveDramaId(options.dramaId, '自由节点生成缺少有效项目 ID')
    return withoutEmptyFields({
      drama_id: dramaId,
      prompt: nodeData.content,
      model: nodeData.model,
      aspect_ratio: nodeData.aspectRatio,
      reference_images: upstreamUrls,
    })
  }

  if (nodeData.kind === 'video') {
    const dramaId = requirePositiveDramaId(options.dramaId, '自由节点生成缺少有效项目 ID')
    const firstFrameUrl = upstreamUrls[0] || ''
    return withoutEmptyFields({
      drama_id: dramaId,
      prompt: nodeData.content,
      model: nodeData.model,
      image_url: firstFrameUrl,
      first_frame_url: firstFrameUrl,
      reference_image_urls: upstreamUrls,
      aspect_ratio: nodeData.aspectRatio,
      duration: nodeData.duration,
    })
  }

  if (nodeData.kind === 'audio') {
    const dramaId = requirePositiveDramaId(options.dramaId, '自由节点生成缺少有效项目 ID')
    return withoutEmptyFields({
      drama_id: dramaId,
      text: nodeData.content,
      tts_model: nodeData.model,
    })
  }

  return null
}

export function collectDirectUpstreamResultUrls(nodes = [], edges = [], targetNodeId = '') {
  const target = String(targetNodeId || '')
  if (!target) return []
  const byId = new Map((Array.isArray(nodes) ? nodes : [])
    .filter((node) => node?.id)
    .map((node) => [String(node.id), node]))
  const urls = []
  for (const edge of edges || []) {
    if (String(edge?.target || '') !== target) continue
    if (edge.data?.manual !== true && !String(edge.id || '').startsWith('manual:')) continue
    const source = byId.get(String(edge.source || ''))
    const url = resultUrlFromNode(source)
    if (url) urls.push(url)
  }
  return uniqueStrings(urls)
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
      result.video_url,
      result.url,
      normalizedResponse.video_url,
      normalizedResponse.url,
      record.video_url,
      record.url,
      staticLocalPathUrl(result.local_path || normalizedResponse.local_path || record.local_path)
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

function resultUrlFromNode(node) {
  const data = node?.data || {}
  return firstString(
    data.url,
    data.resultUrl,
    data.savedAssetUrl,
    data.status?.resultUrl,
    data.status?.savedAssetUrl
  )
}
