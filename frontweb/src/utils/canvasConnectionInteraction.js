const DEFAULT_CONNECTION_RADIUS = 20
const DEFAULT_EDGE_UPDATER_RADIUS = 10

export const canvasConnectionInteractionOptions = Object.freeze({
  connectionRadius: DEFAULT_CONNECTION_RADIUS * 3,
  edgeUpdaterRadius: DEFAULT_EDGE_UPDATER_RADIUS * 3,
  connectOnClick: true,
})

function closestElement(target, selector) {
  return target?.closest?.(selector) || null
}

export function resolveCanvasConnectionDrop({
  sourceNodeId,
  targets = [],
  clientX,
  clientY,
} = {}) {
  const sourceId = String(sourceNodeId || '')
  if (!sourceId) return null

  for (const target of targets) {
    const node = closestElement(target, '.vue-flow__node')
    const targetNodeId = String(node?.dataset?.id || '')
    if (targetNodeId && targetNodeId !== sourceId) {
      return { kind: 'connect', targetNodeId, clientX, clientY }
    }
  }

  const droppedOnSource = targets.some((target) => {
    const node = closestElement(target, '.vue-flow__node')
    return String(node?.dataset?.id || '') === sourceId
  })
  if (droppedOnSource) return null

  const droppedOnPane = targets.some((target) => closestElement(target, '.vue-flow__pane'))
  if (droppedOnPane) {
    return { kind: 'create', clientX, clientY }
  }

  return null
}
