const ACTIVE_TASK_STATES = new Set(['pending', 'queued', 'processing', 'running'])
const FAILED_SHOT_STATES = new Set(['failed', 'needs_attention'])
const REFERENCE_KINDS = new Set(['character', 'scene', 'prop'])

function finiteCredits(value) {
  if (value === null || value === undefined || value === '') return null
  const credits = Number(value)
  return Number.isFinite(credits) && credits >= 0 ? credits : null
}

export function normalizeShotWorkspace(work = {}) {
  const shots = Array.isArray(work?.shots) ? work.shots : []
  const shotsById = new Map(shots.map((shot) => [String(shot.id), shot]))
  const serverBatches = Array.isArray(work?.batches) ? work.batches : []
  const batches = serverBatches.length
    ? serverBatches.map((batch) => ({
      ...batch,
      shots: (Array.isArray(batch.shots) ? batch.shots : [])
        .map((shot) => shotsById.get(String(shot?.id)) || shot)
        .filter(Boolean),
    }))
    : Array.from(shots.reduce((groups, shot) => {
      const index = Number(shot.batch_index) || 1
      if (!groups.has(index)) groups.set(index, [])
      groups.get(index).push(shot)
      return groups
    }, new Map()), ([batch_index, items]) => ({
      batch_index,
      duration_ms: items.reduce((total, shot) => total + (Number(shot.duration_ms) || 0), 0),
      shots: items,
    }))
  return { shots, batches }
}

export function restoreSelectedShotId(shots, selectedShotId) {
  const items = Array.isArray(shots) ? shots : []
  if (items.some((shot) => String(shot.id) === String(selectedShotId))) return selectedShotId
  return items[0]?.id ?? null
}

export function filterShots(shots, filter = 'incomplete') {
  const items = Array.isArray(shots) ? shots : []
  if (filter === 'failed') return items.filter((shot) => FAILED_SHOT_STATES.has(String(shot.status)))
  if (filter === 'completed') return items.filter((shot) => String(shot.status) === 'completed')
  if (filter === 'all') return items
  return items.filter((shot) => String(shot.status) !== 'completed')
}

export function quoteCredits(shot) {
  const quote = shot?.billing?.quote
  for (const value of [quote?.amount, quote?.credits, quote?.unit_amount, shot?.quote_snapshot?.amount, shot?.quote_snapshot?.credits]) {
    const credits = finiteCredits(value)
    if (credits !== null) return credits
  }
  return null
}

export function sumShotQuotes(shots) {
  const items = Array.isArray(shots) ? shots : []
  if (!items.length) return { priced: false, total: null }
  const values = items.map(quoteCredits)
  if (values.some((value) => value === null)) return { priced: false, total: null }
  return { priced: true, total: values.reduce((total, value) => total + value, 0) }
}

export function shouldPollWork(shots) {
  return (Array.isArray(shots) ? shots : []).some((shot) => (
    ACTIVE_TASK_STATES.has(String(shot?.generation?.status || ''))
    || ACTIVE_TASK_STATES.has(String(shot?.status || ''))
  ))
}

export function approvedReferenceOptions(assets, query = '') {
  const needle = String(query).trim().replace(/^@/, '').toLocaleLowerCase()
  return (Array.isArray(assets) ? assets : []).filter((asset) => {
    if (asset?.approval_status !== 'approved' || !REFERENCE_KINDS.has(String(asset?.kind))) return false
    const label = String(asset.localized_name || asset.display_name || asset.name || '')
    return label && (!needle || label.toLocaleLowerCase().includes(needle))
  })
}

export function structuredReferences(assets) {
  const seen = new Set()
  return (Array.isArray(assets) ? assets : []).flatMap((asset) => {
    const id = Number(asset?.redraw_asset_id ?? asset?.id ?? asset?.asset_id)
    const kind = String(asset?.kind || '')
    const key = `${kind}:${id}`
    if (!Number.isSafeInteger(id) || !REFERENCE_KINDS.has(kind) || seen.has(key)) return []
    seen.add(key)
    return [{
      redraw_asset_id: id,
      kind,
      version_number: asset?.version_number ?? asset?.versionNumber ?? null,
    }]
  })
}

export function generationAvailability(shot, gate) {
  if (gate?.ok !== true || (Array.isArray(gate?.missing) && gate.missing.length)) {
    return { ok: false, reason: '资产门禁未开放，请先完成资产审核' }
  }
  if (quoteCredits(shot) === null) return { ok: false, reason: '积分待管理员配置' }
  const status = String(shot?.status || '')
  if (!['draft', 'failed'].includes(status)) {
    return { ok: false, reason: status === 'completed' ? '镜头已完成' : '镜头正在处理或需要人工确认' }
  }
  return { ok: true, reason: '' }
}

export function formatTimecode(milliseconds) {
  const total = Math.max(0, Number(milliseconds) || 0)
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const millis = Math.floor(total % 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}
