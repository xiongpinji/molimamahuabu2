export function latestVideoGenerationRecord(list) {
  if (!Array.isArray(list) || list.length === 0) return ''
  return [...list].sort((a, b) => {
    const timeDiff = Date.parse(b?.created_at || '') - Date.parse(a?.created_at || '')
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff
    return Number(b?.id || 0) - Number(a?.id || 0)
  })[0]
}

export function latestVideoGenerationError(list) {
  const latest = latestVideoGenerationRecord(list)
  return latest?.status === 'failed' ? String(latest.error_msg || '视频生成失败') : ''
}

export function latestVideoGenerationWarning(list) {
  const latest = latestVideoGenerationRecord(list)
  return latest?.status === 'completed' && latest?.error_msg ? String(latest.error_msg) : ''
}
