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

export function createCanvasInteractionState(nodes = [], viewport = {}) {
  const positions = {}
  for (const node of nodes || []) {
    if (!node?.id || !node.position) continue
    const x = Number(node.position.x)
    const y = Number(node.position.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    positions[String(node.id)] = { x, y }
  }
  return { nodes: positions, viewport: normalizeViewport(viewport) }
}

export function serializeCanvasInteractionState(state) {
  return JSON.stringify({
    nodes: Object.fromEntries(Object.entries(state?.nodes || {}).sort(([a], [b]) => a.localeCompare(b))),
    viewport: normalizeViewport(state?.viewport),
  })
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
