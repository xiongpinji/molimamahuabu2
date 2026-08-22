function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeViewport(viewport) {
  return {
    x: Number(viewport?.x) || 0,
    y: Number(viewport?.y) || 0,
    zoom: Number(viewport?.zoom) || 0.75,
  }
}

export function createCanvasInteractionState(nodes = [], viewport = {}, edges = [], suppressedEdgeIds = []) {
  const positions = {}
  const groups = []
  const freeNodes = []
  for (const node of nodes || []) {
    if (!node?.id || !node.position) continue
    const x = Number(node.position.x)
    const y = Number(node.position.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    positions[String(node.id)] = { x, y }
    if (node.type === 'homeCanvasNode') {
      freeNodes.push({
        id: String(node.id),
        type: 'homeCanvasNode',
        position: { x, y },
        data: clone(node.data || {}),
      })
    }
    if (node.type !== 'canvasGroup') continue
    const childNodeIds = [...new Set((node.data?.childNodeIds || []).map(String).filter(Boolean))]
    const width = Number(node.data?.width)
    const height = Number(node.data?.height)
    if (childNodeIds.length < 2 || !Number.isFinite(width) || !Number.isFinite(height)) continue
    groups.push({
      id: String(node.id),
      title: String(node.data?.title || '节点组'),
      childNodeIds,
      position: { x, y },
      width,
      height,
    })
  }
  return {
    nodes: positions,
    groups,
    freeNodes,
    viewport: normalizeViewport(viewport),
    edges: clone(edges || []),
    suppressedEdgeIds: [...new Set((suppressedEdgeIds || []).map(String))].sort(),
  }
}

export function serializeCanvasInteractionState(state) {
  return JSON.stringify({
    nodes: Object.fromEntries(Object.entries(state?.nodes || {}).sort(([a], [b]) => a.localeCompare(b))),
    groups: [...(state?.groups || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    freeNodes: [...(state?.freeNodes || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    viewport: normalizeViewport(state?.viewport),
    edges: state?.edges || [],
    suppressedEdgeIds: [...new Set((state?.suppressedEdgeIds || []).map(String))].sort(),
  })
}

export function restoreCanvasInteractionFreeNodes(nodes = [], state = {}) {
  if (!Array.isArray(state?.freeNodes)) return nodes
  return [
    ...(nodes || []).filter((node) => node.type !== 'homeCanvasNode'),
    ...clone(state.freeNodes).map((node) => ({ ...node, selected: false, dragging: false })),
  ]
}

export function createCanvasInteractionHistory(state, limit = 50) {
  return { past: [], present: clone(state), future: [], limit: Math.max(1, Number(limit) || 50) }
}

export function commitCanvasInteractionHistory(history, previousState, nextState) {
  if (serializeCanvasInteractionState(previousState) === serializeCanvasInteractionState(nextState)) return history
  return {
    ...history,
    past: [...history.past, clone(previousState)].slice(-history.limit),
    present: clone(nextState),
    future: [],
  }
}

export function undoCanvasInteractionHistory(history) {
  if (!history.past.length) return history
  const previous = history.past.at(-1)
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: clone(previous),
    future: [clone(history.present), ...history.future],
  }
}

export function redoCanvasInteractionHistory(history) {
  if (!history.future.length) return history
  const next = history.future[0]
  return {
    ...history,
    past: [...history.past, clone(history.present)].slice(-history.limit),
    present: clone(next),
    future: history.future.slice(1),
  }
}
