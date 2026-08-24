function safeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function statusRank(status) {
  if (status === 'failed' || status === 'needs_attention') return 2
  if (status === 'processing' || status === 'pending') return 1
  return 0
}

const DIALOGUE_QUOTE_HASH = /^[a-f0-9]{64}$/

export function dialogueQuoteCredits(quote) {
  const credits = quote?.total_credits
  if (quote?.status !== 'ready' || quote?.priced !== true) return null
  return Number.isSafeInteger(credits) && credits > 0 ? credits : null
}

export function normalizeTimelineShots(shots = []) {
  return [...(Array.isArray(shots) ? shots : [])]
    .map((shot) => ({
      ...shot,
      start_ms: safeNumber(shot?.start_ms),
      end_ms: safeNumber(shot?.end_ms),
      duration_ms: safeNumber(shot?.duration_ms, Math.max(0, safeNumber(shot?.end_ms) - safeNumber(shot?.start_ms))),
    }))
    .sort((left, right) => {
      const byStart = safeNumber(left.start_ms) - safeNumber(right.start_ms)
      if (byStart) return byStart
      return safeNumber(left.shot_index) - safeNumber(right.shot_index)
    })
}

export function canStartDialogue(quote, task) {
  if (task && ['pending', 'processing', 'completed'].includes(task.status)) return false
  return dialogueQuoteCredits(quote) !== null
    && DIALOGUE_QUOTE_HASH.test(String(quote?.quote_hash || ''))
}

export function canStartComposition(shots = [], dialogueTask, compositionTask) {
  if (dialogueTask?.status !== 'completed') return false
  if (compositionTask && ['pending', 'processing'].includes(compositionTask.status)) return false
  const normalized = normalizeTimelineShots(shots)
  return normalized.length > 0 && normalized.every((shot) => ['completed', 'approved', 'included'].includes(shot.status))
}

export function shouldPollTask(task) {
  return Boolean(task && ['pending', 'processing'].includes(task.status))
}

export function statusLabel(status) {
  const labels = {
    pending: '排队中',
    processing: '处理中',
    completed: '完成',
    failed: '失败',
    needs_attention: '需要处理',
  }
  return labels[status] || status || '未开始'
}

export function formatTimecode(ms) {
  const total = Math.max(0, Math.floor(safeNumber(ms) / 1000))
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export function exportByKind(exports = [], kind) {
  return (Array.isArray(exports) ? exports : [])
    .find((item) => String(item?.kind || '').toLowerCase() === String(kind || '').toLowerCase())
}

export function expandExportArtifacts(exportRow) {
  const row = Array.isArray(exportRow) ? exportRow[0] : exportRow
  if (!row?.id) return []
  const hashes = row.hashes && typeof row.hashes === 'object' ? row.hashes : {}
  return ['mp4', 'srt', 'vtt']
    .filter((kind) => typeof hashes[kind] === 'string' && hashes[kind])
    .map((kind) => ({
      exportId: row.id,
      kind,
      sha256: hashes[kind],
      status: row.status || 'unknown',
    }))
}

export function sourcePreviewUrl(shots = [], selectedShotId = null) {
  const ordered = normalizeTimelineShots(shots)
  const selected = ordered.find((shot) => String(shot.id) === String(selectedShotId))
  return selected?.source_video_ref?.url || ordered[0]?.source_video_ref?.url || ''
}

export function worstShotStatus(shots = []) {
  return normalizeTimelineShots(shots).reduce((status, shot) => (
    statusRank(shot.status) > statusRank(status) ? shot.status : status
  ), 'completed')
}

export function normalizeReleaseReadiness(value = {}) {
  const blockers = Array.isArray(value?.blockers)
    ? value.blockers
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        shot_id: item.shot_id == null ? null : Number(item.shot_id),
        reason_code: String(item.reason_code || 'release_input_not_ready'),
      }))
    : []
  return {
    ready: value?.ready === true,
    readiness_hash: typeof value?.readiness_hash === 'string' ? value.readiness_hash : null,
    blockers,
    shot_count: Number(value?.shot_count || 0),
    quality_summary: value?.quality_summary || null,
  }
}

export function controlledReleaseDownloadUrl(value) {
  const url = String(value || '')
  return /^\/api\/v1\/redraw\/exports\/\d+(?:\/download\/(?:mp4|srt|vtt))?$/.test(url) ? url : ''
}
