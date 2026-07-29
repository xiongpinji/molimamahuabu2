import { buildCanvasLayoutPayload } from './canvasLayout.js'

export function mergeLocalCanvasIntoProjectLayout(projectLayout, localState, namespace = `local:${Date.now()}`) {
  const existing = projectLayout && typeof projectLayout === 'object' ? projectLayout : {}
  const existingIds = new Set([
    ...Object.keys(existing.nodes || {}),
    ...(existing.free_nodes || []).map((node) => String(node.id)),
  ])
  const idMap = new Map()
  const nodes = (localState?.nodes || []).map((node, index) => {
    let id = String(node.id)
    if (existingIds.has(id)) id = `${namespace}:${index}`
    existingIds.add(id)
    idMap.set(String(node.id), id)
    return { ...node, id, selected: false }
  })
  const edges = (localState?.edges || []).map((edge, index) => ({
    ...edge,
    id: `${namespace}:edge:${index}`,
    source: idMap.get(String(edge.source)),
    target: idMap.get(String(edge.target)),
    data: { ...(edge.data || {}), manual: true },
  })).filter((edge) => edge.source && edge.target)
  const localLayout = buildCanvasLayoutPayload(nodes, localState?.viewport, null, edges, { persistFreeNodes: true })
  return {
    ...existing,
    version: 1,
    nodes: { ...(existing.nodes || {}), ...(localLayout.nodes || {}) },
    free_nodes: [...(existing.free_nodes || []), ...(localLayout.free_nodes || [])],
    manual_edges: [...(existing.manual_edges || []), ...(localLayout.manual_edges || [])],
    viewport: localLayout.viewport,
    updated_at: new Date().toISOString(),
  }
}
