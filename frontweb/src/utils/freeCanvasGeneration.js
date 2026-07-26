const FREE_NODE_KINDS = new Set(['text', 'image', 'video', 'audio'])
const FREE_NODE_STATUSES = new Set(['idle', 'queued', 'running', 'success', 'failed'])
const FREE_NODE_ASSET_SAVE_STATUSES = new Set(['idle', 'running', 'success', 'failed'])
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

function booleanValue(value) {
  return value === true
}

function imageSizeFromResolution(aspectRatio, resolution) {
  const longEdge = { '1K': 1024, '2K': 2048, '4K': 4096 }[cleanString(resolution)]
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
  if (Object.hasOwn(data, 'style')) normalized.style = cleanString(data.style)
  if (Object.hasOwn(data, 'resolution')) normalized.resolution = cleanString(data.resolution)
  if (Object.hasOwn(data, 'quantity')) normalized.quantity = positiveInteger(data.quantity)
  if (Object.hasOwn(data, 'negativePrompt')) normalized.negativePrompt = cleanString(data.negativePrompt)
  if (Object.hasOwn(data, 'voiceId')) normalized.voiceId = cleanString(data.voiceId)
  if (Object.hasOwn(data, 'speechRate')) normalized.speechRate = positiveNumber(data.speechRate)
  if (Object.hasOwn(data, 'cameraMovement')) normalized.cameraMovement = cleanString(data.cameraMovement)
  if (Object.hasOwn(data, 'effect')) normalized.effect = cleanString(data.effect)
  if (Object.hasOwn(data, 'includeAudio')) normalized.includeAudio = booleanValue(data.includeAudio)
  if (Object.hasOwn(data, 'characterReferenceUrls')) {
    normalized.characterReferenceUrls = uniqueStrings(data.characterReferenceUrls)
  }
  if (Object.hasOwn(data, 'resultUrls')) normalized.resultUrls = uniqueStrings(data.resultUrls)
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
  const upstreamUrls = uniqueStrings(options.upstreamUrls)
  const referenceUrls = uniqueStrings([
    ...upstreamUrls,
    ...(nodeData.characterReferenceUrls || []),
  ])

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
    return withoutEmptyFields({
      drama_id: dramaId,
      prompt: content,
      model: nodeData.model,
      aspect_ratio: nodeData.aspectRatio,
      style: nodeData.style,
      size: imageSizeFromResolution(nodeData.aspectRatio, nodeData.resolution),
      negative_prompt: nodeData.negativePrompt,
      reference_images: referenceUrls,
    })
  }

  if (nodeData.kind === 'video') {
    const dramaId = requirePositiveDramaId(options.dramaId, '自由节点生成缺少有效项目 ID')
    const firstFrameUrl = referenceUrls[0] || ''
    return withoutEmptyFields({
      drama_id: dramaId,
      prompt: decoratedVideoPrompt({ ...nodeData, content }),
      model: nodeData.model,
      image_url: firstFrameUrl,
      first_frame_url: firstFrameUrl,
      reference_image_urls: referenceUrls,
      aspect_ratio: nodeData.aspectRatio,
      duration: nodeData.duration,
      style: nodeData.style,
      resolution: nodeData.resolution,
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
  const target = String(targetNodeId || '')
  if (!target) return []
  const byId = new Map((Array.isArray(nodes) ? nodes : [])
    .filter((node) => node?.id)
    .map((node) => [String(node.id), node]))
  const references = []
  const seen = new Set()
  for (const edge of edges || []) {
    if (String(edge?.target || '') !== target) continue
    if (edge.data?.manual !== true && !String(edge.id || '').startsWith('manual:')) continue
    const source = byId.get(String(edge.source || ''))
    const sourceKind = cleanString(source?.data?.kind || source?.data?.asset?.type)
    if (sourceKind !== 'image' || seen.has(String(source?.id || ''))) continue
    seen.add(String(source.id))
    const url = resultUrlFromNode(source)
    references.push({
      nodeId: String(source.id),
      title: cleanString(source.data?.title || source.data?.label || source.data?.asset?.name) || '图片节点',
      url,
      ready: Boolean(url),
    })
  }
  return references
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
    if (edge.data?.manual !== true && !String(edge.id || '').startsWith('manual:')) continue
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
