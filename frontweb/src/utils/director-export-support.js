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

export function directorExportDownloadUrl(result) {
  const localPath = String(result?.local_path || '').replace(/^\/+/, '')
  if (localPath) return `/static/${localPath.split('/').map(encodeURIComponent).join('/')}`
  return String(result?.url || '')
}

export async function waitForDirectorExportTask({ getTask, taskId, maxAttempts = 180, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), isCancelled = () => false }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isCancelled()) throw new Error('已取消视频导出')
    await delay(1000)
    if (isCancelled()) throw new Error('已取消视频导出')
    const task = await getTask(taskId)
    if (task?.status === 'failed') throw new Error(task.error || '服务端转码失败')
    if (task?.status === 'cancelled') throw new Error('已取消视频导出')
    if (task?.status === 'completed') return task
  }
  throw new Error('服务端转码超时')
}
