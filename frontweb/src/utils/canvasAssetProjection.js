const AUTO_RESULT_CATEGORIES = new Set([
  'canvas-result',
  'director-ai-reference',
])

const AUTO_RESULT_SOURCES = new Set([
  'canvas_node_result',
  'director_reference_analysis',
])

const EXPLICIT_CANVAS_CATEGORIES = new Set([
  'canvas-library-pick',
  'canvas-upload',
  'canvas-paste',
  'canvas-asset-failure',
])

const EXPLICIT_CANVAS_SOURCES = new Set([
  'canvas_asset_picker',
  'canvas_context_upload',
  'canvas_context_paste',
  'canvas_asset_picker_failure',
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
  if (metadata.canvas_added === true) return true
  if (EXPLICIT_CANVAS_CATEGORIES.has(category) || EXPLICIT_CANVAS_SOURCES.has(source)) return true
  return true
}

export function canvasAssetProjectionPayload(asset, addSource) {
  return {
    metadata: {
      ...parseAssetMetadata(asset?.metadata),
      canvas_added: true,
      canvas_add_source: addSource,
    },
  }
}
