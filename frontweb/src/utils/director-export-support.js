export const DIRECTOR_RECORDING_MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

export function pickDirectorRecordingMimeType(isSupported) {
  if (typeof isSupported !== 'function') return ''
  return DIRECTOR_RECORDING_MIME_TYPES.find((type) => isSupported(type)) || ''
}

export function directorExportFilename(title, extension = 'webm') {
  const safeTitle = String(title || '导演台镜头序列').replace(/[\\/:*?"<>|]/g, '_') || '导演台镜头序列'
  const safeExtension = String(extension || 'webm').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'webm'
  return `${safeTitle}.${safeExtension}`
}

export function parseDirectorExportResult(result) {
  if (typeof result !== 'string') return result && typeof result === 'object' ? result : {}
  try {
    const parsed = JSON.parse(result)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}
