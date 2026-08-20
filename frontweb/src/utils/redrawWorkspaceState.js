export function normalizeStep(value) {
  const step = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(step)) return 1
  return Math.min(4, Math.max(1, step))
}

export function resolveAllowedStep(routeStepValue, backendStepValue) {
  const routeStep = normalizeStep(routeStepValue)
  const backendStep = normalizeStep(backendStepValue)
  return Math.min(routeStep, backendStep)
}

export function resolveUpdatedStep({ routeStep, previousBackendStep, nextBackendStep }) {
  const route = normalizeStep(routeStep)
  const previousBackend = normalizeStep(previousBackendStep)
  const nextBackend = normalizeStep(nextBackendStep)
  if (nextBackend > previousBackend && route < nextBackend) return nextBackend
  return Math.min(route, nextBackend)
}

export function isExistingWorkId(value) {
  const id = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(id) && id > 0
}

function positiveIntegerOrNull(value) {
  if (value == null || String(value).trim() === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export function buildCreateProjectPayload(body = {}) {
  const executionMode = String(body.execution_mode || body.executionMode || 'safe').trim() || 'safe'
  const budgetLimit = positiveIntegerOrNull(body.budget_limit_credits ?? body.budgetLimitCredits)
  const maxAttempts = positiveIntegerOrNull(body.max_auto_attempts_per_shot ?? body.maxAutoAttemptsPerShot)
  if (executionMode === 'auto' && budgetLimit == null) throw new Error('auto 模式必须填写预算')
  if (executionMode === 'auto' && maxAttempts == null) throw new Error('auto 模式必须填写自动尝试上限')
  const payload = {
    title: String(body.title || '').trim() || '未命名转绘项目',
    execution_mode: executionMode,
    default_locale: String(body.default_locale || body.defaultLocale || 'en-US').trim(),
    default_market: String(body.default_market || body.defaultMarket || 'US').trim(),
    localization_level: String(body.localization_level || body.localizationLevel || 'faithful').trim() || 'faithful',
  }
  if (budgetLimit != null) payload.budget_limit_credits = budgetLimit
  if (maxAttempts != null) payload.max_auto_attempts_per_shot = maxAttempts
  return payload
}

export const EIGHT_STAGE_KEYS = [
  'project_input',
  'source_analysis',
  'localization',
  'character_assets',
  'reference_preparation',
  'generation',
  'shot_quality',
  'episode_export',
]

const EIGHT_STAGE_LABELS = {
  project_input: '项目输入',
  source_analysis: '源片分析',
  localization: '本地化',
  character_assets: '角色资产',
  reference_preparation: '参考准备',
  generation: '生成',
  shot_quality: '镜头质检',
  episode_export: '整集导出',
}

const PHASE_STAGE_ALIAS = {
  source: 'project_input',
  analysis_review: 'source_analysis',
  localizing: 'localization',
  localization_needs_attention: 'localization',
  assets: 'character_assets',
  asset_review: 'character_assets',
  asset_generating: 'generation',
  generating: 'generation',
  reference: 'reference_preparation',
  reference_preparation: 'reference_preparation',
  generation: 'generation',
  shot_quality: 'shot_quality',
  export: 'episode_export',
  episode_export: 'episode_export',
}

export function resolveEightStageState(work = {}) {
  const rawPhase = String(work.workflow_phase || '').trim()
  const activeKey = PHASE_STAGE_ALIAS[rawPhase] || (EIGHT_STAGE_KEYS.includes(rawPhase) ? rawPhase : 'project_input')
  const activeIndex = EIGHT_STAGE_KEYS.indexOf(activeKey)
  const events = Array.isArray(work.events) ? work.events : []
  const eventText = events
    .map((event) => {
      return [
        event?.event_type,
        event?.reason_code,
        event?.status,
        event?.phase,
        event?.from_state,
        event?.to_state,
      ].filter(Boolean).join(' ')
    })
    .join(' ')
    .toLowerCase()
  return EIGHT_STAGE_KEYS.map((key, index) => {
    let status = index < activeIndex || (key === 'localization' && work.version_id) ? 'completed' : 'pending'
    if (index === activeIndex) status = 'active'
    if (eventText.includes(key) && eventText.includes('needs_attention')) status = 'needs_attention'
    if (key === 'localization' && eventText.includes('localization_needs_attention')) status = 'needs_attention'
    return { key, label: EIGHT_STAGE_LABELS[key], status }
  })
}

export function analysisQuoteCredits(work) {
  const credits = Number(work?.analysis_quote?.credits ?? work?.analysis_quote?.amount)
  return Number.isSafeInteger(credits) && credits > 0 ? credits : null
}

export function localizationQuoteCredits(work) {
  const quote = work?.localization_quote
  const credits = Number(quote?.credits ?? quote?.amount)
  return quote?.priced === true && Number.isSafeInteger(credits) && credits > 0 ? credits : null
}

export function localeReady(locales) {
  return Array.isArray(locales) && locales.length > 0
}

function referencePayload(referenceImage) {
  if (!referenceImage) return null
  const filename = String(referenceImage.filename || referenceImage.name || '').trim()
  const id = String(referenceImage.id || referenceImage.asset_id || '').trim()
  const reference = {}
  if (filename) reference.filename = filename
  if (id) reference.id = id
  if (typeof referenceImage.arrayBuffer === 'function') reference.file = referenceImage
  return Object.keys(reference).length ? reference : null
}

export function buildAnalyzePayload({ locale, market, aspectRatio, selectedPreset, freeStyle }) {
  const payload = {
    locale: String(locale || '').trim(),
    market: String(market || '').trim(),
    aspect_ratio: String(aspectRatio || '').trim(),
  }
  if (selectedPreset?.id != null) {
    payload.style_preset_id = Number(selectedPreset.id)
    return payload
  }
  const positive = String(freeStyle?.positivePrompt || freeStyle?.positive || '').trim()
  const negative = String(freeStyle?.negativePrompt || freeStyle?.negative || '').trim()
  const reference = referencePayload(freeStyle?.referenceImage || freeStyle?.reference)
  payload.free_style = {
    positive,
    negative,
    ...(reference ? { reference } : {}),
  }
  return payload
}

export function taskStateFromWork(work) {
  return {
    task_id: work?.task_id || '',
    status: work?.task_status || work?.status || '',
    progress: Number.isFinite(Number(work?.task_progress)) ? Number(work.task_progress) : 0,
    message: work?.task_message || '',
  }
}

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function hasRefundOrReleaseEvidence(work) {
  return Number(work?.localization_billing?.released || 0) > 0
}

export function redrawWorkflowPhase(work) {
  const localizationStatus = normalizedStatus(work?.localization_task?.status)
  if (['pending', 'processing', 'localizing'].includes(localizationStatus)) return 'localizing'
  if (['failed', 'needs_attention'].includes(localizationStatus)) return 'localization_needs_attention'
  if (localizationStatus === 'completed') return 'assets'
  const phase = normalizedStatus(work?.workflow_phase)
  if (['asset_review', 'assets'].includes(phase)) return 'assets'
  if (phase) return phase
  if (Number(work?.current_step || 1) > 1) return 'assets'
  if (normalizedStatus(work?.analysis_task?.status) === 'completed') return 'analysis_review'
  return 'source'
}

export function localizationTaskState(work) {
  const task = work?.localization_task || {}
  const progress = Number(task.progress ?? task.task_progress)
  return {
    task_id: task.id || task.task_id || '',
    status: task.status || task.task_status || '',
    progress: Number.isFinite(progress) ? progress : 0,
    message: task.message || task.task_message || '',
  }
}

export function canConfirmLocalization(work, expectedQuoteHash) {
  const quote = work?.localization_quote
  if (localizationQuoteCredits(work) == null || !String(quote?.quote_hash || '').trim()) return false
  if (expectedQuoteHash && String(quote.quote_hash).trim() !== String(expectedQuoteHash).trim()) return false
  const phase = redrawWorkflowPhase(work)
  if (phase === 'analysis_review') return true
  if (!['localization_needs_attention', 'failed'].includes(phase)) return false
  const task = work?.localization_task || {}
  return normalizedStatus(task.status || task.task_status) === 'failed' && hasRefundOrReleaseEvidence(work)
}

export function shouldResetLocalizationIdempotencyKey(work) {
  const task = work?.localization_task || {}
  const status = normalizedStatus(task.status || task.task_status)
  return status === 'completed' || (status === 'failed' && hasRefundOrReleaseEvidence(work))
}

export function localizationQuoteRequestKey(input) {
  return [
    String(input?.workId || '').trim(),
    String(input?.locale || '').trim(),
    String(input?.market || '').trim(),
    String(input?.localizationLevel || input?.localization_level || 'faithful').trim() || 'faithful',
  ].join('|')
}

export function createLocalizationQuoteRequestGate() {
  const active = new Set()
  let desiredKey = ''
  return {
    begin(input) {
      const key = localizationQuoteRequestKey(input)
      desiredKey = key
      if (active.has(key)) return false
      active.add(key)
      return true
    },
    finish(input) {
      active.delete(localizationQuoteRequestKey(input))
    },
    isActive(input) {
      return active.has(localizationQuoteRequestKey(input))
    },
    accepts(input) {
      return desiredKey === localizationQuoteRequestKey(input)
    },
  }
}

export function createLocalizationConfirmationSnapshot({ work, quoteBody }) {
  const request = {
    workId: work?.id,
    locale: quoteBody?.locale,
    market: quoteBody?.market,
    localizationLevel: quoteBody?.localization_level || quoteBody?.localizationLevel || 'faithful',
  }
  return {
    workId: work?.id,
    phase: redrawWorkflowPhase(work),
    previousHash: String(work?.localization_quote?.quote_hash || '').trim(),
    requestKey: localizationQuoteRequestKey(request),
    quoteBody: {
      locale: String(quoteBody?.locale || '').trim(),
      market: String(quoteBody?.market || '').trim(),
      localization_level: String(quoteBody?.localization_level || quoteBody?.localizationLevel || 'faithful').trim() || 'faithful',
    },
  }
}

export function isCurrentLocalizationConfirmation(snapshot, { work, quoteBody }) {
  if (!snapshot?.workId || String(work?.id || '') !== String(snapshot.workId)) return false
  if (redrawWorkflowPhase(work) !== snapshot.phase) return false
  if (!['analysis_review', 'localization_needs_attention', 'failed'].includes(snapshot.phase)) return false
  if (!canConfirmLocalization(work, snapshot.previousHash)) return false
  const currentKey = localizationQuoteRequestKey({
    workId: work?.id,
    locale: quoteBody?.locale,
    market: quoteBody?.market,
    localizationLevel: quoteBody?.localization_level || quoteBody?.localizationLevel || 'faithful',
  })
  return currentKey === snapshot.requestKey
}

export function buildLocalizationPayload(body) {
  return {
    locale: String(body?.locale || '').trim(),
    market: String(body?.market || '').trim(),
    localization_level: String(body?.localizationLevel || 'faithful').trim(),
    quote_hash: String(body?.quoteHash || '').trim(),
    idempotency_key: String(body?.idempotencyKey || '').trim(),
  }
}

export function canStartRedrawAnalysis({ work, selectedFile, locales, selectedPreset, freeStyle }) {
  const hasStyle = Boolean(
    selectedPreset?.id != null
      || String(freeStyle?.positivePrompt || freeStyle?.positive || '').trim(),
  )
  return Boolean(
    analysisQuoteCredits(work) != null
      && localeReady(locales)
      && (work?.id || selectedFile)
      && hasStyle,
  )
}

export function createRedrawStyleSelection() {
  return {
    selectedPreset: null,
    freeStyle: { positivePrompt: '', negativePrompt: '', referenceImage: null },
    selectPreset(preset) {
      this.selectedPreset = preset || null
      this.freeStyle = { positivePrompt: '', negativePrompt: '', referenceImage: null }
    },
    setFreeStyle(style) {
      this.selectedPreset = null
      this.freeStyle = {
        positivePrompt: String(style?.positivePrompt || style?.positive || '').trim(),
        negativePrompt: String(style?.negativePrompt || style?.negative || '').trim(),
        referenceImage: style?.referenceImage || style?.reference || null,
      }
    },
  }
}
