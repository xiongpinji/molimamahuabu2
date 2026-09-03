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

function positiveIntegerOrNull(value, max = Number.MAX_SAFE_INTEGER) {
  if (value == null || String(value).trim() === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : null
}

function normalizeLocale(value) {
  const locale = String(value || '').trim()
  if (!locale || /[\s,/]/.test(locale) || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(locale)) {
    throw new Error('目标语言必须是单一 locale')
  }
  return locale
}

function normalizeMarket(value) {
  const market = String(value || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(market)) throw new Error('目标市场必须是单一两位国家码')
  return market
}

export function buildCreateProjectPayload(body = {}) {
  const executionMode = String(body.execution_mode || body.executionMode || 'safe').trim() || 'safe'
  if (!['safe', 'auto'].includes(executionMode)) throw new Error('执行模式必须是 safe 或 auto')
  const budgetLimit = positiveIntegerOrNull(body.budget_limit_credits ?? body.budgetLimitCredits)
  const maxAttempts = positiveIntegerOrNull(body.max_auto_attempts_per_shot ?? body.maxAutoAttemptsPerShot, 5)
  if (executionMode === 'auto' && budgetLimit == null) throw new Error('auto 模式必须填写预算')
  if (executionMode === 'auto' && maxAttempts == null) throw new Error('auto 模式必须填写自动尝试上限')
  const payload = {
    title: String(body.title || '').trim() || '未命名转绘项目',
    execution_mode: executionMode,
    default_locale: normalizeLocale(body.default_locale || body.defaultLocale),
    default_market: normalizeMarket(body.default_market || body.defaultMarket),
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
  analyzing: 'source_analysis',
  analysis_review: 'source_analysis',
  blueprint_review: 'source_analysis',
  blueprint_locked: 'localization',
  localizing: 'localization',
  localization_needs_attention: 'localization',
  assets: 'character_assets',
  asset_review: 'character_assets',
  asset_generating: 'generation',
  generating: 'generation',
  video_generation: 'generation',
  reference: 'reference_preparation',
  reference_preparation: 'reference_preparation',
  generation: 'generation',
  shot_quality: 'shot_quality',
  export: 'episode_export',
  episode_export: 'episode_export',
}

export function resolveEightStageState(work = {}) {
  const rawPhase = String(work.workflow_phase || '').trim()
  const activeKey = rawPhase
    ? PHASE_STAGE_ALIAS[rawPhase] || (EIGHT_STAGE_KEYS.includes(rawPhase) ? rawPhase : '')
    : 'project_input'
  const activeIndex = EIGHT_STAGE_KEYS.indexOf(activeKey)
  const events = Array.isArray(work.events) ? work.events : []
  return EIGHT_STAGE_KEYS.map((key, index) => {
    let status = activeIndex >= 0 && index < activeIndex ? 'completed' : 'pending'
    if (activeIndex >= 0 && index === activeIndex) status = 'active'
    if (events.some((event) => eventNeedsAttentionForStage(event, key))) status = 'needs_attention'
    return { key, label: EIGHT_STAGE_LABELS[key], status }
  })
}

function eventNeedsAttentionForStage(event, key) {
  const text = [
    event?.event_type,
    event?.reason_code,
    event?.status,
    event?.phase,
    event?.from_state,
    event?.to_state,
  ].filter(Boolean).join(' ').toLowerCase()
  if (!text.includes('needs_attention')) return false
  if (text.includes(key)) return true
  return key === 'localization' && text.includes('localization_needs_attention')
}

function eventNeedsAttention(event) {
  return [
    event?.event_type,
    event?.reason_code,
    event?.status,
    event?.phase,
    event?.from_state,
    event?.to_state,
  ].filter(Boolean).join(' ').toLowerCase().includes('needs_attention')
}

function finiteCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function resolveNeedsAttentionCount({ project = {}, work = {}, events = [] } = {}) {
  const projectCount = finiteCount(project.needs_attention_count)
  if (projectCount != null) return projectCount
  const workCount = finiteCount(work.needs_attention_count)
  if (workCount != null) return workCount
  return Array.isArray(events) ? events.filter(eventNeedsAttention).length : 0
}

export function resolveProjectEffectiveMode({ project = {}, work = {} } = {}) {
  return work?.analysis_decision?.effective_mode
    || work?.localization_decision?.effective_mode
    || project?.effective_execution_mode
    || project?.effective_policy?.execution_mode
    || project?.policy?.execution_mode
    || project?.execution_mode
    || '-'
}

function normalizeProjectEvents(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.events)) return value.events
  if (Array.isArray(value?.items)) return value.items
  if (Array.isArray(value?.data)) return value.data
  return []
}

export function resolveProjectEventsState({ previousEvents = [], nextEvents, error } = {}) {
  if (error) {
    return {
      events: Array.isArray(previousEvents) ? previousEvents : [],
      error: error.message || '项目事件读取失败',
    }
  }
  return {
    events: normalizeProjectEvents(nextEvents),
    error: '',
  }
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

export function redrawWorkflowPhase(work, blueprintRecord) {
  const localizationStatus = normalizedStatus(work?.localization_task?.status)
  if (['pending', 'processing', 'localizing'].includes(localizationStatus)) return 'localizing'
  if (['failed', 'needs_attention'].includes(localizationStatus)) return 'localization_needs_attention'
  if (localizationStatus === 'completed') return 'assets'
  const blueprintStatus = normalizedStatus(blueprintRecord?.status)
  if (blueprintStatus === 'draft') return 'blueprint_review'
  if (blueprintStatus === 'locked') return 'blueprint_locked'
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

export function canConfirmLocalization(work, expectedQuoteHash, blueprintRecord) {
  const quote = work?.localization_quote
  if (localizationQuoteCredits(work) == null || !String(quote?.quote_hash || '').trim()) return false
  if (expectedQuoteHash && String(quote.quote_hash).trim() !== String(expectedQuoteHash).trim()) return false
  if (blueprintRecord === undefined) return false
  if (blueprintRecord !== null && normalizedStatus(blueprintRecord.status) !== 'locked') return false
  const phase = redrawWorkflowPhase(work, blueprintRecord)
  if (['analysis_review', 'blueprint_locked'].includes(phase)) return true
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

export function createLocalizationConfirmationSnapshot({ work, quoteBody, blueprint }) {
  const request = {
    workId: work?.id,
    locale: quoteBody?.locale,
    market: quoteBody?.market,
    localizationLevel: quoteBody?.localization_level || quoteBody?.localizationLevel || 'faithful',
  }
  return {
    workId: work?.id,
    phase: redrawWorkflowPhase(work, blueprint),
    blueprintStatus: blueprint == null ? '' : normalizedStatus(blueprint.status),
    blueprintHash: blueprint == null ? '' : String(blueprint.blueprint_hash || '').trim(),
    previousHash: String(work?.localization_quote?.quote_hash || '').trim(),
    requestKey: localizationQuoteRequestKey(request),
    quoteBody: {
      locale: String(quoteBody?.locale || '').trim(),
      market: String(quoteBody?.market || '').trim(),
      localization_level: String(quoteBody?.localization_level || quoteBody?.localizationLevel || 'faithful').trim() || 'faithful',
    },
  }
}

export function isCurrentLocalizationConfirmation(snapshot, { work, quoteBody, blueprint }) {
  if (!snapshot?.workId || String(work?.id || '') !== String(snapshot.workId)) return false
  if (redrawWorkflowPhase(work, blueprint) !== snapshot.phase) return false
  if (!['analysis_review', 'blueprint_locked', 'localization_needs_attention', 'failed'].includes(snapshot.phase)) return false
  if ((blueprint == null ? '' : normalizedStatus(blueprint.status)) !== snapshot.blueprintStatus) return false
  if ((blueprint == null ? '' : String(blueprint.blueprint_hash || '').trim()) !== snapshot.blueprintHash) return false
  if (!canConfirmLocalization(work, snapshot.previousHash, blueprint)) return false
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
