function staticMediaUrl(value) {
  const p = String(value || '').trim()
  if (!p) return ''
  if (/^(https?:|data:|blob:)/i.test(p)) return p
  return '/static/' + p.replace(/^\/+/, '').replace(/^static\//, '')
}

function referenceMediaUrl(value) {
  const p = String(value || '').trim()
  if (!p) return ''
  if (/^(https?:|data:|blob:)/i.test(p) || p.startsWith('/')) return p
  return staticMediaUrl(p)
}

export function canvasResultPlaybackUrl({ kind, url, savedAssetLocalPath } = {}) {
  if (String(kind || '').toLowerCase() === 'video' && savedAssetLocalPath) {
    return staticMediaUrl(savedAssetLocalPath)
  }
  return referenceMediaUrl(url)
}

/** 统一媒体 URL：优先本地路径，其次素材/参考图常见远程字段 */
export function assetImageUrl(item) {
  if (!item) return ''
  const localPath = item.local_path || item.path || item.file_path || item.image_local_path || item.thumbnail_local_path
  if (localPath) return staticMediaUrl(localPath)
  const remote = item.image_url
    || item.ref_image
    || item.thumbnail_url
    || item.file_url
    || item.cover_url
    || item.poster_url
    || item.display_url
    || item.asset_url
    || item.preview_url
    || item.url
  return remote ? referenceMediaUrl(remote) : ''
}

/** 统一素材媒体 URL：图片/视频/音频均可用于画布节点预览和上游引用 */
export function assetMediaUrl(item) {
  if (!item) return ''
  const localPath = item.local_path
    || item.path
    || item.file_path
    || item.image_local_path
    || item.video_local_path
    || item.audio_local_path
    || item.voice_local_path
    || item.thumbnail_local_path
  if (localPath) return staticMediaUrl(localPath)
  const remote = item.url
    || item.asset_url
    || item.display_url
    || item.preview_url
    || item.image_url
    || item.video_url
    || item.audio_url
    || item.voice_url
    || item.ref_image
    || item.thumbnail_url
    || item.file_url
    || item.cover_url
    || item.poster_url
  return remote ? referenceMediaUrl(remote) : ''
}

export function storyboardImageUrl(sb) {
  if (!sb) return ''
  return assetImageUrl(sb)
}

export function storyboardVideoUrl(sb) {
  if (!sb) return ''
  const lp = sb.video_local_path && String(sb.video_local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return sb.video_url || ''
}

export function audioUrl(localPath) {
  if (!localPath) return ''
  const p = String(localPath).trim()
  if (!p) return ''
  if (/^(https?:|data:|blob:)/i.test(p)) return p
  return '/static/' + p.replace(/^\//, '')
}
