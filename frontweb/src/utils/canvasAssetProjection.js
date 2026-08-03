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

  return metadata.canvas_added === true
    || EXPLICIT_CANVAS_CATEGORIES.has(category)
    || EXPLICIT_CANVAS_SOURCES.has(source)
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
