export function parseTaskResult(result) {
  if (typeof result !== 'string') return result
  try {
    return JSON.parse(result)
  } catch (_) {
    return null
  }
}

export function resolveTaskMediaUrl(result) {
  if (result?.local_path) return `/static/${result.local_path}`
  return result?.video_url || result?.image_url || null
}
