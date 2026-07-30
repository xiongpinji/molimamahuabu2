import { normalizeFreeCanvasNode } from './freeCanvasGeneration.js'

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

export function resolveFreeCanvasNodes(savedLayout) {
  const result = []
  for (const node of savedLayout?.free_nodes || []) {
    const normalized = normalizeFreeCanvasNode(node)
    if (normalized) result.push(normalized)
  }
  return result
}

export function resolveCanvasGroups(savedLayout) {
  const result = []
  for (const group of savedLayout?.groups || []) {
    const childNodeIds = [...new Set((group?.child_node_ids || []).map(String).filter(Boolean))]
    const values = [group?.x, group?.y, group?.width, group?.height].map(Number)
    if (!group?.id || childNodeIds.length < 2 || !values.every(Number.isFinite)) continue
    result.push({
      id: String(group.id),
      title: String(group.title || '节点组'),
      child_node_ids: childNodeIds,
      x: values[0],
      y: values[1],
      width: Math.max(260, values[2]),
      height: Math.max(180, values[3]),
    })
  }
  return result
}

export function translateCanvasGroupChildren(nodes = [], snapshot = null, groupPosition = null) {
  if (!snapshot?.position || !snapshot?.children || !groupPosition) return nodes
  const dx = Number(groupPosition.x) - Number(snapshot.position.x)
  const dy = Number(groupPosition.y) - Number(snapshot.position.y)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return nodes
  return nodes.map((node) => {
    const start = snapshot.children[String(node.id)]
    if (!start) return node
    return {
      ...node,
      position: {
        x: Number(start.x) + dx,
        y: Number(start.y) + dy,
      },
    }
  })
}

export function resizeCanvasGroupsAroundMember(nodes = [], memberId = null, padding = 0) {
  const movedId = String(memberId || '')
  const groupPadding = Math.max(0, Number(padding) || 0)
  const affectedGroups = (nodes || []).filter((node) => (
    node?.type === 'canvasGroup'
    && (node.data?.childNodeIds || []).map(String).includes(movedId)
  ))
  if (!movedId || !affectedGroups.length) return nodes

  const nodesById = new Map((nodes || []).map((node) => [String(node.id), node]))
  const replacements = new Map()
  for (const group of affectedGroups) {
    const members = (group.data?.childNodeIds || [])
      .map((id) => nodesById.get(String(id)))
      .filter((node) => node?.type === 'homeCanvasNode' && node.position)
    if (members.length < 2) continue
    const minX = Math.min(...members.map((node) => Number(node.position.x))) - groupPadding
    const minY = Math.min(...members.map((node) => Number(node.position.y))) - groupPadding
    const maxX = Math.max(...members.map((node) => (
      Number(node.position.x) + Number(node.dimensions?.width || node.data?.width || 460)
    ))) + groupPadding
    const maxY = Math.max(...members.map((node) => (
      Number(node.position.y) + Number(node.dimensions?.height || node.data?.height || 300)
    ))) + groupPadding
    replacements.set(String(group.id), {
      ...group,
      position: { x: minX, y: minY },
      data: {
        ...group.data,
        width: Math.max(260, maxX - minX),
        height: Math.max(180, maxY - minY),
      },
    })
  }
  if (!replacements.size) return nodes
  return nodes.map((node) => replacements.get(String(node.id)) || node)
}

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

    const { lineType, ...persistedData } = edge.data || {}
    result.push({
      id: edge.id || `manual:${key}`,
      source,
      target,
      sourceHandle,
      targetHandle,
      type: lineType || edge.type || 'smoothstep',
      data: {
        ...persistedData,
        manual: true,
        ...(persistedData.contract ? { contract: { ...persistedData.contract } } : {}),
      },
    })
  }
  return result
}

/** 从当前 Vue Flow 节点与视口构建可持久化的 canvas_layout */
export function buildCanvasLayoutPayload(flowNodes, viewport, existingLayout = null, flowEdges = [], options = {}) {
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
  const payload = {
    ...base,
    version: 1,
    viewport: {
      x: Number(viewport?.x) || 0,
      y: Number(viewport?.y) || 0,
      zoom: Number(viewport?.zoom) || 0.75,
    },
    nodes,
    manual_edges: manualEdges,
    suppressed_edge_ids: options.suppressedEdgeIds == null
      ? [...new Set((existingLayout?.suppressed_edge_ids || []).map(String))].sort()
      : [...new Set((options.suppressedEdgeIds || []).map(String))].sort(),
    updated_at: new Date().toISOString(),
  }
  if (options.persistFreeNodes) {
    payload.free_nodes = resolveFreeCanvasNodes({
      free_nodes: (flowNodes || []).filter((node) => node?.type === 'homeCanvasNode'),
    })
    payload.groups = resolveCanvasGroups({
      groups: (flowNodes || [])
        .filter((node) => node?.type === 'canvasGroup')
        .map((node) => ({
          id: node.id,
          title: node.data?.title,
          child_node_ids: node.data?.childNodeIds,
          x: node.position?.x,
          y: node.position?.y,
          width: node.data?.width,
          height: node.data?.height,
        })),
    })
  }
  return payload
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
