import { canvasNodeKind, resolveCanvasNodeConnection } from './canvasNodeContracts.js'

function manualEdge(edge) {
  return edge?.data?.manual === true || String(edge?.id || '').startsWith('manual:')
}

function validCanvasExecutionEdges(byId, edges) {
  return edges.filter((edge) => {
    const source = byId.get(String(edge?.source || ''))
    const target = byId.get(String(edge?.target || ''))
    return manualEdge(edge) && source?.type === 'homeCanvasNode' && target?.type === 'homeCanvasNode'
      && resolveCanvasNodeConnection(canvasNodeKind(source), canvasNodeKind(target)).allowed
      && edge?.data?.contract?.enabled !== false
  })
}

export function buildCanvasExecutionPlan(nodes = [], edges = [], options = {}) {
  const byId = new Map(nodes.filter((node) => node?.id).map((node) => [String(node.id), node]))
  const validEdges = validCanvasExecutionEdges(byId, edges)
  const roots = new Set((options.rootNodeIds || []).map(String).filter((id) => byId.has(id)))
  const included = new Set(roots)
  if (options.includeDownstream) {
    const queue = [...roots]
    while (queue.length) {
      const sourceId = queue.shift()
      for (const edge of validEdges.filter((item) => String(item.source) === sourceId)) {
        const targetId = String(edge.target)
        if (!included.has(targetId)) {
          included.add(targetId)
          queue.push(targetId)
        }
      }
    }
  }
  const indegree = new Map([...included].map((id) => [id, 0]))
  for (const edge of validEdges) {
    const source = String(edge.source)
    const target = String(edge.target)
    if (included.has(source) && included.has(target)) indegree.set(target, indegree.get(target) + 1)
  }
  const queue = [...included].filter((id) => indegree.get(id) === 0)
  const orderedNodeIds = []
  while (queue.length) {
    const id = queue.shift()
    orderedNodeIds.push(id)
    for (const edge of validEdges.filter((item) => String(item.source) === id)) {
      const target = String(edge.target)
      if (!included.has(target)) continue
      indegree.set(target, indegree.get(target) - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  return {
    orderedNodeIds,
    cycleNodeIds: [...included].filter((id) => !orderedNodeIds.includes(id)),
  }
}

export function buildCanvasExecutionBatches(nodes = [], edges = [], options = {}) {
  const plan = buildCanvasExecutionPlan(nodes, edges, options)
  if (plan.cycleNodeIds.length || !plan.orderedNodeIds.length) {
    return { ...plan, batches: [] }
  }

  const byId = new Map(nodes.filter((node) => node?.id).map((node) => [String(node.id), node]))
  const included = new Set(plan.orderedNodeIds)
  const validEdges = validCanvasExecutionEdges(byId, edges)
  const indegree = new Map(plan.orderedNodeIds.map((id) => [id, 0]))
  for (const edge of validEdges) {
    const source = String(edge.source)
    const target = String(edge.target)
    if (included.has(source) && included.has(target)) indegree.set(target, indegree.get(target) + 1)
  }

  const remaining = new Set(plan.orderedNodeIds)
  const batches = []
  while (remaining.size) {
    const batch = plan.orderedNodeIds.filter((id) => remaining.has(id) && indegree.get(id) === 0)
    if (!batch.length) break
    batches.push(batch)
    batch.forEach((id) => remaining.delete(id))
    for (const edge of validEdges) {
      if (!batch.includes(String(edge.source))) continue
      const target = String(edge.target)
      if (remaining.has(target)) indegree.set(target, indegree.get(target) - 1)
    }
  }
  return { ...plan, batches }
}
