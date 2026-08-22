const ACTIVE_TASK_STATES = new Set(['pending', 'queued', 'processing', 'running'])
const FAILED_SHOT_STATES = new Set(['failed', 'needs_attention'])
const REFERENCE_KINDS = new Set(['character', 'scene', 'prop'])
const PREPARATION_REASON_LABELS = {
  identity_changed: '角色身份发生变化',
  character_identity_changed: '角色身份发生变化',
  voice_changed: '角色声音发生变化',
  wardrobe_changed: '角色服装发生变化',
  character_wardrobe_changed: '角色服装发生变化',
  dialogue_changed: '目标对白发生变化',
  text_region_changed: '文字覆盖发生变化',
  shot_timing_changed: '镜头时间范围发生变化',
  coverage_changed: '人物或文字覆盖发生变化',
  upstream_version_drift: '上游版本发生变化',
  clean_plate_status_unknown: '净景结果状态未知',
  preparation_interrupted: '准备任务中断',
}

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
  const directQuote = shot?.quote
  const quote = shot?.billing?.quote
  for (const value of [
    directQuote?.amount,
    directQuote?.credits,
    directQuote?.unit_amount,
    quote?.amount,
    quote?.credits,
    quote?.unit_amount,
    shot?.quote_snapshot?.amount,
    shot?.quote_snapshot?.credits,
  ]) {
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
  if (shot?.generation_availability?.ok === false) {
    return { ok: false, reason: shot.generation_availability.reason || '生成能力不可用' }
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

function preparationEvidence(label, required, completed) {
  return {
    label,
    required,
    completed,
    ready: required === completed,
  }
}

export function projectShotPreparation(shot = {}, gate = {}, quote = {}) {
  const preparation = shot?.preparation && typeof shot.preparation === 'object' ? shot.preparation : {}
  const snapshotRequirements = Array.isArray(preparation.requirements) ? preparation.requirements : []
  const quoteRequirements = (Array.isArray(quote?.items) ? quote.items : [])
    .filter((item) => Number(item?.shot_id) === Number(shot?.id))
    .map((item) => ({ kind: item.kind, key: item.key }))
  const requirements = snapshotRequirements.length ? snapshotRequirements : quoteRequirements
  const results = Array.isArray(preparation.clean_results) ? preparation.clean_results : []
  const requiredCount = (kind) => requirements.filter((item) => item?.kind === kind).length
  const completedCount = (kind) => results.filter((item) => (
    item?.kind === kind && item?.status === 'completed'
  )).length
  const personRequired = requiredCount('person_clean')
  const personCompleted = completedCount('person_clean')
  const textRequired = requiredCount('text_clean')
  const textCompleted = completedCount('text_clean')
  const missing = (Array.isArray(gate?.missing) ? gate.missing : []).filter((item) => (
    String(item?.resource_type ?? item?.scope) === 'shot'
      && String(item?.resource_id ?? item?.id) === String(shot?.id)
  ))
  const state = String(shot?.preparation_state || preparation.status || 'localized')
  const staleReasonCode = String(shot?.stale_reason_code || '')
  return {
    id: shot?.id,
    state,
    personCoverage: preparationEvidence('人物覆盖', personRequired, personCompleted),
    textCoverage: preparationEvidence('文字覆盖', textRequired, textCompleted),
    cleanPlate: preparationEvidence('净景', personRequired + textRequired, personCompleted + textCompleted),
    referenceBundle: {
      label: '参考包',
      ready: state === 'reference_ready' && Boolean(shot?.reference_bundle_hash),
    },
    missingReasonCodes: missing.map((item) => String(item?.reason_code ?? item?.code ?? '')).filter(Boolean),
    staleReason: PREPARATION_REASON_LABELS[staleReasonCode]
      || (state === 'stale' ? '上游证据发生变化' : ''),
    reworkScope: state === 'stale' ? '只返工此镜头' : '',
  }
}

export function preparationActionState(shot = {}) {
  if (String(shot?.preparation_state) === 'needs_attention') {
    return { canRetry: false, manualReviewOnly: true, label: '人工核对' }
  }
  return { canRetry: false, manualReviewOnly: false, label: '准备参考' }
}
