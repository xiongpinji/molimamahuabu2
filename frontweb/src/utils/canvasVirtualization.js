const NODE_SIZE_BY_TYPE = {
  canvasLabel: { width: 220, height: 36 },
  canvasDramaHeader: { width: 320, height: 140 },
  canvasAsset: { width: 190, height: 190 },
  canvasEpisode: { width: 210, height: 140 },
  canvasScript: { width: 230, height: 150 },
  canvasStoryboard: { width: 210, height: 220 },
  canvasMedia: { width: 180, height: 150 },
  canvasAddButton: { width: 190, height: 80 },
}

const DEFAULT_NODE_SIZE = { width: 220, height: 180 }

function nodeSize(node) {
  const measured = node?.measured || node?.dimensions
  const width = Number(measured?.width || node?.width)
  const height = Number(measured?.height || node?.height)
  const fallback = NODE_SIZE_BY_TYPE[node?.type] || DEFAULT_NODE_SIZE
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallback.width,
    height: Number.isFinite(height) && height > 0 ? height : fallback.height,
  }
}

function intersectsViewport(node, bounds) {
  const position = node?.computedPosition || node?.position
  if (!position || !bounds) return true
  const size = nodeSize(node)
  return position.x < bounds.right
    && position.x + size.width > bounds.left
    && position.y < bounds.bottom
    && position.y + size.height > bounds.top
}

function buildViewportBounds(viewport, viewportSize, overscan) {
  const width = Number(viewportSize?.width)
  const height = Number(viewportSize?.height)
  const zoom = Number(viewport?.zoom)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  if (!Number.isFinite(zoom) || zoom <= 0) return null
  const extra = Math.max(0, Number(overscan) || 0)
  return {
    left: (-Number(viewport?.x || 0) - extra) / zoom,
    top: (-Number(viewport?.y || 0) - extra) / zoom,
    right: (width - Number(viewport?.x || 0) + extra) / zoom,
    bottom: (height - Number(viewport?.y || 0) + extra) / zoom,
  }
}

/**
 * 只返回当前视口附近的节点与两端均可见的连线。
 * Vue Flow 的节点集合本身就是渲染边界，因此不把隐藏节点标记为 display:none，
 * 避免大量 DOM 仍参与布局和事件命中。
 */
export function virtualizeCanvasGraph(allNodes = [], allEdges = [], viewport, viewportSize, options = {}) {
  const nodes = Array.isArray(allNodes) ? allNodes : []
  const edges = Array.isArray(allEdges) ? allEdges : []
  const minNodes = Math.max(0, Number(options.minNodes) || 80)
  const pinnedIds = new Set((options.pinnedIds || []).map(String))
  const bounds = nodes.length >= minNodes
    ? buildViewportBounds(viewport, viewportSize, options.overscan ?? 360)
    : null

  if (!bounds) {
    const visibleIds = new Set(nodes.map((node) => String(node.id)))
    return {
      nodes: nodes.slice(),
      edges: edges.slice(),
      visibleIds,
      hiddenNodeCount: 0,
      virtualized: false,
    }
  }

  const visibleNodes = nodes.filter((node) => (
    pinnedIds.has(String(node.id)) || node?.selected || intersectsViewport(node, bounds)
  ))
  const visibleIds = new Set(visibleNodes.map((node) => String(node.id)))
  const visibleEdges = edges.filter((edge) => (
    visibleIds.has(String(edge.source)) && visibleIds.has(String(edge.target))
  ))

  return {
    nodes: visibleNodes,
    edges: visibleEdges,
    visibleIds,
    hiddenNodeCount: Math.max(0, nodes.length - visibleNodes.length),
    virtualized: visibleNodes.length < nodes.length,
  }
}

function hasMeasuredSize(size) {
  return Number(size?.width) > 0 && Number(size?.height) > 0
}

export function preserveCanvasNodeRuntimeMeasurements(nextNodes = [], renderedNodes = []) {
  const renderedById = new Map(renderedNodes.map((node) => [String(node?.id), node]))
  return nextNodes.map((node) => {
    const rendered = renderedById.get(String(node?.id))
    const dimensions = hasMeasuredSize(rendered?.dimensions) ? rendered.dimensions : null
    const measured = hasMeasuredSize(rendered?.measured) ? rendered.measured : null
    if (!dimensions && !measured) return node
    return {
      ...node,
      ...(dimensions ? { dimensions: { ...dimensions } } : {}),
      ...(measured ? { measured: { ...measured } } : {}),
    }
  })
}

export function getCanvasNodeSize(node) {
  return nodeSize(node)
}
