const SHANGHAI_TIME_ZONE = 'Asia/Shanghai'

function unwrapItems(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.items)) return value.items
  if (Array.isArray(value?.data?.items)) return value.data.items
  if (Array.isArray(value?.data)) return value.data
  return []
}

function mediaType(value = {}) {
  const rawType = String(
    value.type
      || value.media_type
      || value.asset_type
      || value.kind
      || '',
  ).toLowerCase()
  const url = String(
    value.url
      || value.display_url
      || value.image_url
      || value.video_url
      || value.audio_url
      || value.local_path
      || '',
  ).toLowerCase()

  if (rawType.includes('video') || /\.(mp4|mov|webm|mkv)(\?|$)/.test(url)) return 'video'
  if (rawType.includes('audio') || /\.(mp3|wav|m4a|aac|ogg)(\?|$)/.test(url)) return 'audio'
  if (rawType.includes('text') || rawType.includes('prompt')) return 'text'
  if (
    rawType.includes('model')
    || rawType.includes('3d')
    || /\.(glb|gltf|fbx|obj|usdz)(\?|$)/.test(url)
  ) return 'model'
  return 'image'
}

function itemUrl(value = {}) {
  return value.url
    || value.display_url
    || value.image_url
    || value.video_url
    || value.audio_url
    || value.local_path
    || ''
}

function itemCreatedAt(value = {}) {
  return value.completed_at
    || value.completedAt
    || value.updated_at
    || value.updatedAt
    || value.created_at
    || value.createdAt
    || ''
}

function timestamp(value) {
  const time = new Date(value || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function nodeStoryboardId(node) {
  return node?.data?.storyboard?.id
    ?? node?.data?.storyboard_id
    ?? node?.data?.entity?.storyboard_id
    ?? null
}

function generationNodeId(nodes, type, record) {
  const recordUrl = itemUrl(record)
  const urlMatch = nodes.find((node) => {
    const data = node?.data || {}
    return recordUrl && [
      data.url,
      itemUrl(data.entity),
      itemUrl(data.asset),
    ].includes(recordUrl)
  })
  if (urlMatch) return urlMatch.id

  const storyboardId = record.storyboard_id
  if (storyboardId == null) return ''
  const storyboardMatch = nodes.find((node) => (
    nodeStoryboardId(node) === storyboardId
    && (
      (type === 'video' && node?.data?.kind === 'video')
      || (type === 'image' && node?.data?.kind === 'image')
    )
  ))
  return storyboardMatch?.id || ''
}

export function assetCategory(value = {}) {
  const category = String(
    value.category
      || value.asset_category
      || value.kind
      || value.source_kind
      || '',
  ).toLowerCase()
  const type = mediaType(value)

  if (category.includes('character') || category.includes('person')) return 'person'
  if (category.includes('scene')) return 'scene'
  if (category.includes('prop') || category.includes('item')) return 'item'
  if (category.includes('style')) return 'style'
  if (type === 'audio' || category.includes('sound') || category.includes('voice')) return 'sound'
  if (type === 'text' || category.includes('prompt')) return 'prompt'
  return 'other'
}

export function normalizeLibraryAssets(value) {
  return unwrapItems(value).map((asset) => {
    const type = mediaType(asset)
    return {
      key: `asset:${asset.id}`,
      rawId: asset.id,
      type,
      category: assetCategory(asset),
      name: asset.name || asset.title || asset.filename || `资产 #${asset.id}`,
      url: itemUrl(asset),
      createdAt: itemCreatedAt(asset),
      prompt: asset.prompt || asset.description || '',
      model: asset.model || '',
      taskId: asset.task_id || '',
      status: asset.status || '',
      nodeId: asset.node_id || '',
      source: 'library',
      raw: asset,
    }
  })
}

export function normalizeGenerationHistory({ images = [], videos = [], nodes = [] } = {}) {
  const imageItems = unwrapItems(images).map((record) => ({
    key: `image:${record.id}`,
    rawId: record.id,
    type: 'image',
    category: 'other',
    name: record.name || record.title || `图片 #${record.id}`,
    url: itemUrl(record),
    createdAt: itemCreatedAt(record),
    prompt: record.prompt || '',
    model: record.model || '',
    taskId: record.task_id || record.provider_task_id || '',
    status: record.status || '',
    ratio: record.aspect_ratio || record.ratio || '',
    storyboardId: record.storyboard_id ?? null,
    nodeId: generationNodeId(nodes, 'image', record),
    source: 'history',
    raw: record,
  }))
  const videoItems = unwrapItems(videos).map((record) => ({
    key: `video:${record.id}`,
    rawId: record.id,
    type: 'video',
    category: 'other',
    name: record.name || record.title || `视频 #${record.id}`,
    url: itemUrl(record),
    createdAt: itemCreatedAt(record),
    prompt: record.prompt || '',
    model: record.model || '',
    taskId: record.task_id || record.provider_task_id || '',
    status: record.status || '',
    ratio: record.aspect_ratio || record.ratio || '',
    storyboardId: record.storyboard_id ?? null,
    nodeId: generationNodeId(nodes, 'video', record),
    source: 'history',
    raw: record,
  }))

  return [...imageItems, ...videoItems]
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))
}

export function normalizeCanvasAssets(nodes = []) {
  return nodes.flatMap((node) => {
    const data = node?.data || {}
    const entity = data.entity || {}
    const asset = data.asset || {}
    let type = ''
    let value = {}

    if (node?.type === 'canvasAsset') {
      type = 'image'
      value = entity
    } else if (node?.type === 'canvasMedia') {
      type = mediaType(data)
      value = data
    } else if (node?.type === 'canvasProjectAsset') {
      type = mediaType(asset)
      value = asset
    } else if (node?.type === 'homeCanvasNode') {
      type = mediaType(data)
      value = data
    } else {
      return []
    }

    const summary = data.summary || data.text || data.content || ''
    const kindName = {
      image: '图片',
      video: '视频',
      audio: '音频',
      text: '文本',
      model: '3D World',
    }[type]
    return [{
      key: `node:${node.id}`,
      rawId: value.id ?? node.id,
      type,
      category: assetCategory({ ...value, kind: data.kind, type }),
      name: value.name || value.title || summary || `${kindName}节点`,
      url: itemUrl(value) || data.url || '',
      createdAt: itemCreatedAt(value) || itemCreatedAt(data),
      prompt: value.prompt || data.prompt || summary,
      model: value.model || data.model || '',
      taskId: value.task_id || value.taskId || data.task_id || data.taskId || '',
      status: value.status || data.status || '',
      nodeId: node.id,
      source: 'canvas',
      raw: value,
    }]
  })
}

function zonedDateParts(value) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(value))
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

function dateKey(value) {
  const parts = zonedDateParts(value)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function weekKey(value) {
  const parts = zonedDateParts(value)
  const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)))
  const daysFromMonday = (localDate.getUTCDay() + 6) % 7
  localDate.setUTCDate(localDate.getUTCDate() - daysFromMonday)
  return localDate.toISOString().slice(0, 10)
}

function groupLabel(mode, key, sample, now) {
  if (mode === 'day') {
    const parts = zonedDateParts(sample.createdAt)
    return `${parts.month}月${parts.day}日 ${parts.weekday}`
  }
  if (mode === 'week') {
    if (key === weekKey(now)) return '本周'
    const monday = new Date(`${key}T00:00:00+08:00`)
    const sunday = new Date(monday)
    sunday.setDate(sunday.getDate() + 6)
    const start = zonedDateParts(monday)
    const end = zonedDateParts(sunday)
    return `${start.month}月${start.day}日 - ${end.month}月${end.day}日`
  }
  if (mode === 'month') {
    const current = zonedDateParts(now)
    if (key === `${current.year}-${String(current.month).padStart(2, '0')}`) return '本月'
    const [year, month] = key.split('-')
    return `${year}年${Number(month)}月`
  }
  return ''
}

export function groupMediaItems(items = [], mode = 'flat', now = new Date()) {
  const sorted = [...items].sort(
    (left, right) => timestamp(right.createdAt) - timestamp(left.createdAt),
  )
  if (!sorted.length) return []
  if (mode === 'flat') return [{ key: 'flat', label: '', items: sorted }]

  const groups = new Map()
  for (const item of sorted) {
    let key
    if (!item.createdAt || !timestamp(item.createdAt)) {
      key = 'unknown'
    } else if (mode === 'day') {
      key = dateKey(item.createdAt)
    } else if (mode === 'week') {
      key = weekKey(item.createdAt)
    } else {
      const parts = zonedDateParts(item.createdAt)
      key = `${parts.year}-${String(parts.month).padStart(2, '0')}`
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  return [...groups].map(([key, groupedItems]) => ({
    key,
    label: key === 'unknown'
      ? '未知时间'
      : groupLabel(mode, key, groupedItems[0], now),
    items: groupedItems,
  }))
}
