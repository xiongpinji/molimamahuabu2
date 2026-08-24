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

function normalizedDialogueInputText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n')
}

export function localizedDialogueText(dialogue) {
  return (Array.isArray(dialogue) ? dialogue : []).map((turn) => {
    if (typeof turn === 'string') return turn
    return String(turn?.localized_text ?? turn?.target_text ?? turn?.text ?? turn?.content ?? turn?.dialogue ?? '')
  }).join('\n')
}

export function mergeLocalizedDialogueText(dialogue, value) {
  const turns = Array.isArray(dialogue) ? dialogue : []
  const text = normalizedDialogueInputText(value)
  if (!turns.length) {
    return text === ''
      ? { ok: true, dialogue: [], reason: '' }
      : { ok: false, dialogue: [], reason: '目标语台词只能逐行修改，不能新增、删除或重排对白行' }
  }
  if (turns.some((turn) => !turn || typeof turn !== 'object' || Array.isArray(turn))) {
    return { ok: false, dialogue: [], reason: '当前目标对白不是可安全编辑的结构化数据' }
  }
  if (text === localizedDialogueText(turns)) {
    return { ok: true, dialogue: turns.map((turn) => ({ ...turn })), reason: '' }
  }
  const lines = text.split('\n')
  if (lines.length !== turns.length || lines.some((line) => !line.trim())) {
    return {
      ok: false,
      dialogue: [],
      reason: '目标语台词只能逐行修改，不能新增、删除或重排对白行',
    }
  }
  return {
    ok: true,
    dialogue: turns.map((turn, index) => ({ ...turn, localized_text: lines[index] })),
    reason: '',
  }
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

function preparationScopeError() {
  return Object.assign(new Error('逐镜参考准备范围或报价已变化，请重新确认'), {
    code: 'REDRAW_REFERENCE_PREPARATION_SCOPE_CHANGED',
  })
}

function exactPreparationShotIds(value, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw preparationScopeError()
  const ids = value.map(Number)
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw preparationScopeError()
  }
  return ids.sort((left, right) => left - right)
}

export function buildReferencePreparationScopedStart(
  quote = {},
  requestedShotIds = [],
  expectedVersionId = null,
  displayedQuote = null,
) {
  const requested = exactPreparationShotIds(requestedShotIds)
  const selected = exactPreparationShotIds(quote?.selected_shot_ids)
  const missing = exactPreparationShotIds(quote?.missing_shot_ids)
  const reused = exactPreparationShotIds(quote?.reused_shot_ids, true)
  const needsAttention = exactPreparationShotIds(quote?.needs_attention_shot_ids, true)
  const sameScope = requested.length === selected.length
    && requested.length === missing.length
    && requested.every((id, index) => id === selected[index] && id === missing[index])
    && reused.length === 0
    && needsAttention.length === 0
  const sameVersion = expectedVersionId == null
    || (Number.isSafeInteger(Number(expectedVersionId))
      && Number(expectedVersionId) > 0
      && Number(quote?.version_id) === Number(expectedVersionId))
  const quoteHash = String(quote?.quote_hash || '')
  const credits = Number(quote?.credits)
  const sameDisplayedTerms = displayedQuote == null || (
    Number(displayedQuote?.version_id) === Number(quote?.version_id)
    && String(displayedQuote?.version_snapshot_hash || '') === String(quote?.version_snapshot_hash || '')
    && String(displayedQuote?.character_plan_hash || '') === String(quote?.character_plan_hash || '')
    && String(displayedQuote?.effective_mode || '') === String(quote?.effective_mode || '')
    && String(displayedQuote?.action || '') === String(quote?.action || '')
    && displayedQuote?.priced === quote?.priced
    && Number(displayedQuote?.credits) === credits
  )
  if (!sameScope || !sameVersion || !sameDisplayedTerms
    || !['advance', 'needs_review'].includes(String(quote?.action || ''))
    || quote?.priced !== true
    || !Number.isSafeInteger(credits) || credits < 0
    || !/^[a-f0-9]{64}$/i.test(quoteHash)) {
    throw preparationScopeError()
  }
  return { quote_hash: quoteHash, shot_ids: requested }
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

export function providerDeliveryState(shot = {}) {
  const status = String(shot?.provider_status || '')
  if (status === 'submission_unknown') {
    return {
      label: '需要核对',
      canRetry: false,
      warning: '提交结果未知，需要核对；不会自动重试',
    }
  }
  if (status === 'failed_terminal') {
    return {
      label: '明确失败',
      canRetry: shot?.can_start_next_attempt === true,
      warning: shot?.can_start_next_attempt === true ? '策略允许下一次尝试' : '当前策略不允许下一次尝试',
    }
  }
  const labels = {
    accepted: '已受理',
    running: '生成中',
    completed_candidate: '候选已返回',
    result_unavailable: '结果不可读取',
  }
  return { label: labels[status] || status || '未提交', canRetry: false, warning: '' }
}

export function referencePreparationFailurePolicy(error = {}, { requestStarted = true } = {}) {
  const status = Number(error?.response?.status || error?.response?.data?.status || 0)
  const responseData = error?.response?.data || {}
  const errorData = responseData?.error || {}
  const outcomeText = [
    error?.code,
    error?.message,
    responseData?.status,
    errorData?.code,
    errorData?.message,
    errorData?.details?.status,
    errorData?.details?.action,
  ].map((value) => String(value || '').toLowerCase()).join(' ')
  const unknownOutcome = outcomeText.includes('submission_unknown')
    || outcomeText.includes('result_unknown')
    || outcomeText.includes('needs_attention')
    || outcomeText.includes('schedule_failed')
  const deterministicRejection = status >= 400 && status < 500 && status !== 408 && !unknownOutcome
  if (requestStarted && deterministicRejection) {
    return {
      outcome: 'rejected',
      keepLocked: false,
      resetIdempotency: true,
      refreshWorkspace: true,
    }
  }
  return {
    outcome: requestStarted ? 'unknown' : 'local_error',
    keepLocked: requestStarted,
    resetIdempotency: !requestStarted,
    refreshWorkspace: false,
  }
}

export function referencePreparationResultPolicy(result = {}) {
  const status = String(result?.status || '')
  let outcome = 'accepted'
  if (status === 'needs_attention') outcome = 'needs_attention'
  else if (['submission_unknown', 'result_unknown'].includes(status)) outcome = 'unknown'
  return {
    outcome,
    keepLocked: true,
    resetIdempotency: false,
  }
}

export function createReferencePreparationIdempotencyKey(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') {
    try {
      const uuid = String(cryptoApi.randomUUID()).toLowerCase()
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
        return uuid
      }
    } catch (_) {}
  }
  if (typeof cryptoApi?.getRandomValues === 'function') {
    try {
      const bytes = new Uint8Array(16)
      cryptoApi.getRandomValues(bytes)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    } catch (_) {}
  }
  throw Object.assign(new Error('浏览器安全随机数不可用，无法创建参考准备幂等键'), {
    code: 'REDRAW_REFERENCE_PREPARATION_RANDOM_UNAVAILABLE',
  })
}

export function settleReferencePreparationSubmission({
  idempotencyKey = '',
  requestStarted = false,
  error,
  result,
} = {}) {
  const policy = error
    ? referencePreparationFailurePolicy(error, { requestStarted })
    : referencePreparationResultPolicy(result)
  return {
    outcome: policy.outcome,
    submitting: false,
    locked: policy.keepLocked,
    idempotencyKey: policy.resetIdempotency ? '' : idempotencyKey,
    refreshWorkspace: policy.refreshWorkspace === true,
  }
}

export function referencePreparationManualReviewState(idempotencyKey = '') {
  return {
    submitting: false,
    locked: false,
    idempotencyKey,
  }
}
