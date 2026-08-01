const AUTO_RESULT_CATEGORIES = new Set([
  'canvas-result',
  'director-ai-reference',
])

const AUTO_RESULT_SOURCES = new Set([
  'canvas_node_result',
  'director_reference_analysis',
])

function parseAssetMetadata(metadata) {
  if (metadata && typeof metadata === 'object') return metadata
  if (typeof metadata !== 'string' || !metadata.trim()) return {}
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function shouldProjectCanvasAsset(asset) {
  const category = String(asset?.category || '').toLowerCase()
  const metadata = parseAssetMetadata(asset?.metadata)
  const source = String(metadata.source || '').toLowerCase()

  if (AUTO_RESULT_CATEGORIES.has(category) || AUTO_RESULT_SOURCES.has(source)) return false
  if (metadata.auto_saved === true || metadata.canvas_node_id) return false
  if ((metadata.sourceNodeId || metadata.source_node_id) && metadata.operation) return false
  return true
}
