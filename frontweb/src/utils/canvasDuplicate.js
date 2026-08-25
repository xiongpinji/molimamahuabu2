function cloneCanvasValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function uniqueEdgeId(baseId, usedIds) {
  let candidate = String(baseId || `edge:${Date.now()}`)
  let index = 1
  while (usedIds.has(candidate)) {
    candidate = `${baseId}:${index++}`
  }
  usedIds.add(candidate)
  return candidate
}

export function cloneSingleCanvasNodeWithIncidentEdges({
  sourceNode,
  edges = [],
  nextNodeId,
  nextEdgeId,
  createNode,
} = {}) {
  const sourceId = String(sourceNode?.id || '')
  const copyId = String(nextNodeId || '')
  if (!sourceId || !copyId) {
    return { node: null, edges: [] }
  }

  const node = typeof createNode === 'function'
    ? createNode(cloneCanvasValue(sourceNode))
    : { ...cloneCanvasValue(sourceNode), id: copyId }
  const usedEdgeIds = new Set((edges || []).map((edge) => String(edge?.id || '')).filter(Boolean))
  const clonedEdges = []

  for (const edge of edges || []) {
    if (!edge?.source || !edge?.target) continue
    const isIncoming = String(edge.target) === sourceId
    const isOutgoing = String(edge.source) === sourceId
    if (!isIncoming && !isOutgoing) continue

    const clonedEdge = {
      ...cloneCanvasValue(edge),
      id: uniqueEdgeId(
        typeof nextEdgeId === 'function'
          ? nextEdgeId(edge, clonedEdges.length)
          : `${edge.id || 'edge'}:copy:${copyId}`,
        usedEdgeIds,
      ),
      source: isOutgoing ? copyId : edge.source,
      target: isIncoming ? copyId : edge.target,
      selected: false,
    }
    clonedEdges.push(clonedEdge)
  }

  return { node, edges: clonedEdges }
}
