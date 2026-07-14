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
      kind: ['text', 'image', 'video'].includes(node.data?.kind) ? node.data.kind : 'text',
      title: String(node.data?.title || '未命名节点'),
      content: String(node.data?.content || ''),
      url: node.data?.url ? String(node.data.url) : '',
    },
  }
}

export function normalizeHomeCanvasState(raw) {
  const parsed = parseRawState(raw)
  const fallback = createHomeCanvasState()
  if (!parsed) return fallback

  const nodes = Array.isArray(parsed.nodes)
    ? parsed.nodes.map(normalizeNode).filter(Boolean)
    : fallback.nodes
  const edges = Array.isArray(parsed.edges) ? parsed.edges : []
  return {
    version: 1,
    nodes,
    edges,
    viewport: normalizeViewport(parsed.viewport),
  }
}

export function serializeHomeCanvasState(state) {
  return JSON.stringify(normalizeHomeCanvasState(state))
}
