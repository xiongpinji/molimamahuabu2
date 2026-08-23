function firstValue(asset, keys) {
  for (const key of keys) {
    if (asset[key]) return asset[key]
  }
  return ''
}

export function buildAssetReusePayload(asset, { purpose, dramaId, storyboardId }) {
  const targetStoryboardId = purpose === 'canvas' ? null : storyboardId
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata
    : {}

  return {
    drama_id: dramaId,
    storyboard_id: targetStoryboardId,
    name: asset.name || asset.filename || '未命名素材',
    type: asset.type || 'image',
    category: asset.category ?? null,
    url: firstValue(asset, ['url', 'image_url', 'video_url', 'audio_url', 'voice_url']),
    local_path: firstValue(asset, ['local_path', 'image_local_path', 'video_local_path', 'audio_local_path', 'voice_local_path']) || null,
    file_size: asset.file_size ?? asset.size ?? null,
    mime_type: asset.mime_type ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    duration: asset.duration ?? null,
    metadata: {
      ...metadata,
      reused_from_asset_id: asset.id,
      reuse_purpose: purpose,
      reuse_source_drama_id: asset.drama_id ?? null,
      reuse_source_storyboard_id: asset.storyboard_id ?? null,
      attached_drama_id: dramaId,
      attached_storyboard_id: targetStoryboardId,
    },
    image_gen_id: asset.image_gen_id ?? null,
    video_gen_id: asset.video_gen_id ?? null,
  }
}
