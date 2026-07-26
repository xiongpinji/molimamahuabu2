export const HOME_CANVAS_STORAGE_KEY = 'moli-mama.home-canvas.v1'

const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 0.75 })

export function createHomeCanvasState() {
  return {
    version: 1,
    nodes: [
      {
        id: 'home:welcome',
        type: 'homeCanvasNode',
        position: { x: 0, y: 0 },
        data: {
          kind: 'text',
          title: '首页自由画布',
          content: '不绑定项目。右键空白处，或点击底部“+”添加文本、图片和视频节点。',
        },
      },
    ],
    edges: [],
    viewport: { ...DEFAULT_VIEWPORT },
  }
}

function parseRawState(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return raw && typeof raw === 'object' ? raw : null
}

function normalizeViewport(viewport) {
  const x = Number(viewport?.x)
  const y = Number(viewport?.y)
  const zoom = Number(viewport?.zoom)
  return {
    x: Number.isFinite(x) ? x : DEFAULT_VIEWPORT.x,
    y: Number.isFinite(y) ? y : DEFAULT_VIEWPORT.y,
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : DEFAULT_VIEWPORT.zoom,
  }
}

function normalizeNode(node, index) {
  if (!node || typeof node !== 'object') return null
  const id = String(node.id || `home:node:${index}`)
  const x = Number(node.position?.x)
  const y = Number(node.position?.y)
  return {
    ...node,
    id,
    type: 'homeCanvasNode',
    position: {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    },
    data: {
      ...(node.data || {}),
      kind: ['text', 'image', 'video', 'audio'].includes(node.data?.kind) ? node.data.kind : 'text',
      title: String(node.data?.title || '未命名节点'),
      content: String(node.data?.content || ''),
      url: node.data?.url ? String(node.data.url) : '',
    },
  }
}

function normalizeEdge(edge, index, nodeIds) {
  if (!edge || typeof edge !== 'object') return null
  const source = String(edge.source || '')
  const target = String(edge.target || '')
  if (!source || !target || source === target || !nodeIds.has(source) || !nodeIds.has(target)) return null
  const sourceHandle = edge.sourceHandle ? String(edge.sourceHandle) : undefined
  const targetHandle = edge.targetHandle ? String(edge.targetHandle) : undefined
  return {
    ...edge,
    id: String(edge.id || `home:edge:${source}:${target}:${index}`),
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(targetHandle ? { targetHandle } : {}),
    type: String(edge.type || 'smoothstep'),
  }
}

function edgeConnectionKey(edge) {
  const source = String(edge?.source || '')
  const target = String(edge?.target || '')
  if (!source || !target) return ''
  return `${source}|${target}|${edge?.sourceHandle ? String(edge.sourceHandle) : ''}|${edge?.targetHandle ? String(edge.targetHandle) : ''}`
}

export function hasDuplicateHomeCanvasEdge(edges, candidate) {
  const candidateKey = edgeConnectionKey(candidate)
  if (!candidateKey || !Array.isArray(edges)) return false
  const excludedId = candidate?.id ? String(candidate.id) : ''
  return edges.some((edge) => edgeConnectionKey(edge) === candidateKey && (!excludedId || String(edge?.id || '') !== excludedId))
}

export function normalizeHomeCanvasState(raw) {
  const parsed = parseRawState(raw)
  const fallback = createHomeCanvasState()
  if (!parsed) return fallback

  const nodes = Array.isArray(parsed.nodes)
    ? parsed.nodes.map(normalizeNode).filter(Boolean)
    : fallback.nodes
  const nodeIds = new Set(nodes.map((node) => node.id))
  const seenEdges = new Set()
  const edges = Array.isArray(parsed.edges)
    ? parsed.edges
      .map((edge, index) => normalizeEdge(edge, index, nodeIds))
      .filter((edge) => {
        if (!edge) return false
        const key = edgeConnectionKey(edge)
        if (seenEdges.has(key)) return false
        seenEdges.add(key)
        return true
      })
    : []
  return {
    version: 1,
    nodes,
    edges,
    viewport: normalizeViewport(parsed.viewport),
  }
}

export function removeSelectedHomeCanvasElements(state) {
  const normalized = normalizeHomeCanvasState(state)
  const selectedNodeIds = new Set(normalized.nodes.filter((node) => node.selected).map((node) => node.id))
  const selectedEdgeIds = new Set(normalized.edges.filter((edge) => edge.selected).map((edge) => edge.id))
  if (!selectedNodeIds.size && !selectedEdgeIds.size) return normalized
  return {
    ...normalized,
    nodes: normalized.nodes.filter((node) => !selectedNodeIds.has(node.id)),
    edges: normalized.edges.filter((edge) => (
      !selectedEdgeIds.has(edge.id)
      && !selectedNodeIds.has(edge.source)
      && !selectedNodeIds.has(edge.target)
    )),
  }
}

export function serializeHomeCanvasState(state) {
  return JSON.stringify(normalizeHomeCanvasState(state))
}

function cloneState(state) {
  return normalizeHomeCanvasState(JSON.parse(JSON.stringify(state)))
}

export function createHomeCanvasHistory(state, limit = 50) {
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 50
  const present = cloneState(state)
  return { past: [], present, future: [], limit: safeLimit }
}

export function commitHomeCanvasHistory(history, previousState, nextState) {
  const previous = cloneState(previousState)
  const present = cloneState(nextState)
  if (serializeHomeCanvasState(previous) === serializeHomeCanvasState(present)) return history
  return {
    past: [...history.past, previous].slice(-history.limit),
    present,
    future: [],
    limit: history.limit,
  }
}

export function undoHomeCanvasHistory(history) {
  if (!history.past.length) return history
  const present = history.past.at(-1)
  return {
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future].slice(0, history.limit),
    limit: history.limit,
  }
}

export function redoHomeCanvasHistory(history) {
  if (!history.future.length) return history
  const present = history.future[0]
  return {
    past: [...history.past, history.present].slice(-history.limit),
    present,
    future: history.future.slice(1),
    limit: history.limit,
  }
}
