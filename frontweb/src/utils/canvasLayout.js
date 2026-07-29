/** 从 drama.metadata 解析画布布局（旧 JSON 无此字段时返回 null） */
export function parseCanvasLayout(metadata) {
  if (metadata == null) return null
  let meta = metadata
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta)
    } catch {
      return null
    }
  }
  if (!meta || typeof meta !== 'object') return null
  return meta.canvas_layout || null
}

/** 合并 metadata 并写入 canvas_layout（阶段 B 使用） */
export function mergeCanvasLayoutIntoMetadata(metadata, canvasLayout) {
  let meta = metadata
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta)
    } catch {
      meta = {}
    }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {}
  return {
    ...meta,
    canvas_layout: canvasLayout,
  }
}

/** 读取已保存节点坐标，无则返回 fallback */
export function resolveNodePosition(savedLayout, nodeId, fallback) {
  const saved = savedLayout?.nodes?.[nodeId]
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    return { x: saved.x, y: saved.y }
  }
  return fallback
}

export function resolveViewport(savedLayout, fallback = { x: 0, y: 0, zoom: 0.75 }) {
  const v = savedLayout?.viewport
  if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom)) {
    return v
  }
  return fallback
}

const NON_DRAGGABLE_TYPES = new Set(['canvasLabel', 'canvasAddButton'])

export function normalizeManualCanvasEdges(edges) {
  const result = []
  const seen = new Set()
  for (const edge of edges || []) {
    if (!edge?.source || !edge?.target) continue
    if (edge.data?.manual !== true && !String(edge.id || '').startsWith('manual:')) continue

    const source = String(edge.source)
    const target = String(edge.target)
    const sourceHandle = edge.sourceHandle || null
    const targetHandle = edge.targetHandle || null
    const key = `${source}|${sourceHandle || ''}|${target}|${targetHandle || ''}`
    if (seen.has(key)) continue
    seen.add(key)

    result.push({
      id: edge.id || `manual:${key}`,
      source,
      target,
      sourceHandle,
      targetHandle,
      type: edge.data?.lineType || edge.type || 'smoothstep',
      data: { manual: true },
    })
  }
  return result
}

/** 从当前 Vue Flow 节点与视口构建可持久化的 canvas_layout */
export function buildCanvasLayoutPayload(flowNodes, viewport, existingLayout = null, flowEdges = [], suppressedEdgeIds = null) {
  const nodes = { ...(existingLayout?.nodes || {}) }
  const base = existingLayout && typeof existingLayout === 'object' ? { ...existingLayout } : {}
  const manualEdges = normalizeManualCanvasEdges(flowEdges.length ? flowEdges : existingLayout?.manual_edges)
  for (const node of flowNodes || []) {
    if (!node?.id || NON_DRAGGABLE_TYPES.has(node.type)) continue
    if (!node.position) continue
    nodes[node.id] = {
      x: node.position.x,
      y: node.position.y,
    }
  }
  return {
    ...base,
    version: 1,
    viewport: {
      x: Number(viewport?.x) || 0,
      y: Number(viewport?.y) || 0,
      zoom: Number(viewport?.zoom) || 0.75,
    },
    nodes,
    manual_edges: manualEdges,
    suppressed_edge_ids: suppressedEdgeIds == null
      ? [...new Set((existingLayout?.suppressed_edge_ids || []).map(String))].sort()
      : [...new Set((suppressedEdgeIds || []).map(String))].sort(),
    updated_at: new Date().toISOString(),
  }
}

export function parseDramaMetadata(metadata) {
  if (metadata == null) return {}
  if (typeof metadata === 'object' && !Array.isArray(metadata)) return metadata
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata)
    } catch {
      return {}
    }
  }
  return {}
}
