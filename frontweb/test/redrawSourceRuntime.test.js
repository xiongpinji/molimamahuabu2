import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analysisQuoteCredits,
  buildAnalyzePayload,
  buildLocalizationPayload,
  canConfirmLocalization,
  canStartRedrawAnalysis,
  createRedrawStyleSelection,
  createLocalizationConfirmationSnapshot,
  localizationQuoteCredits,
  localizationTaskState,
  localeReady,
  createLocalizationQuoteRequestGate,
  isCurrentLocalizationConfirmation,
  resolveUpdatedStep,
  redrawWorkflowPhase,
  shouldResetLocalizationIdempotencyKey,
  taskStateFromWork,
} from '../src/utils/redrawWorkspaceState.js'

test('有效报价启用且无报价禁用，只读取 work.analysis_quote', () => {
  const work = { id: 8, analysis_quote: { credits: 6 } }
  const presetWithFakeCredits = { id: 3, credits: 99 }

  assert.equal(analysisQuoteCredits(work, presetWithFakeCredits), 6)
  assert.equal(canStartRedrawAnalysis({ work, locales: [{ locale: 'ja-JP', market: 'JP' }], selectedPreset: { id: 3 } }), true)
  assert.equal(canStartRedrawAnalysis({
    work: { id: 8, analysis_quote: null },
    locales: [{ locale: 'ja-JP', market: 'JP' }],
    selectedPreset: presetWithFakeCredits,
  }), false)
})

test('分析 payload 包含语言地区、比例、普通 preset 或自由风格参考图字段', () => {
  assert.deepEqual(buildAnalyzePayload({
    locale: 'ja-JP',
    market: 'JP',
    aspectRatio: '9:16',
    selectedPreset: { id: 7 },
  }), {
    locale: 'ja-JP',
    market: 'JP',
    aspect_ratio: '9:16',
    style_preset_id: 7,
  })

  assert.deepEqual(buildAnalyzePayload({
    locale: 'en-US',
    market: 'US',
    aspectRatio: '16:9',
    freeStyle: {
      positivePrompt: 'warm light',
      negativePrompt: 'blur',
      referenceImage: { name: 'style.png' },
    },
  }), {
    locale: 'en-US',
    market: 'US',
    aspect_ratio: '16:9',
    free_style: {
      positive: 'warm light',
      negative: 'blur',
      reference: { filename: 'style.png' },
    },
  })
})

test('自由风格真实参考图文件保留给 analyze API multipart 上传', () => {
  const referenceFile = new File(['style'], 'style.png', { type: 'image/png' })

  const payload = buildAnalyzePayload({
    locale: 'en-US',
    market: 'US',
    aspectRatio: '3:4',
    freeStyle: {
      positivePrompt: 'warm light',
      negativePrompt: 'blur',
      referenceImage: referenceFile,
    },
  })

  assert.equal(payload.aspect_ratio, '3:4')
  assert.equal(payload.free_style.reference.filename, 'style.png')
  assert.equal(payload.free_style.reference.file, referenceFile)
})

test('刷新恢复真实 task progress，不伪造 processing 进度', () => {
  assert.deepEqual(taskStateFromWork({
    task_id: 'task-1',
    task_status: 'processing',
    task_progress: 64,
    task_message: '正在读取源片',
  }), {
    task_id: 'task-1',
    status: 'processing',
    progress: 64,
    message: '正在读取源片',
  })
})

test('空 locales 不伪造默认语言并禁用提交', () => {
  assert.equal(localeReady([]), false)
  assert.equal(canStartRedrawAnalysis({
    work: { id: 8, analysis_quote: { credits: 6 } },
    locales: [],
    selectedPreset: { id: 3 },
  }), false)
})

test('普通 preset 与自由风格双向互斥并保留参考图字段', () => {
  const selection = createRedrawStyleSelection()
  selection.setFreeStyle({
    positivePrompt: 'free style',
    negativePrompt: 'noise',
    referenceImage: { name: 'style.png' },
  })
  assert.equal(selection.selectedPreset, null)
  assert.equal(selection.freeStyle.referenceImage.name, 'style.png')

  selection.selectPreset({ id: 3, name: '真人写实' })
  assert.equal(selection.selectedPreset.id, 3)
  assert.deepEqual(selection.freeStyle, { positivePrompt: '', negativePrompt: '', referenceImage: null })
})

test('分析完成后停留确认态且本地化任务独立恢复', () => {
  assert.equal(redrawWorkflowPhase({
    current_step: 1,
    workflow_phase: 'analysis_review',
    analysis_task: { status: 'completed' },
  }), 'analysis_review')
  assert.equal(canConfirmLocalization({
    workflow_phase: 'analysis_review',
    localization_quote: { priced: true, credits: 9, quote_hash: 'quote-9' },
  }), true)
  assert.deepEqual(localizationTaskState({
    localization_task: { id: 'loc-1', status: 'processing', progress: 35 },
  }), {
    task_id: 'loc-1',
    status: 'processing',
    progress: 35,
    message: '',
  })
})

test('本地化 payload 只提交服务端允许字段且修剪字符串', () => {
  assert.deepEqual(buildLocalizationPayload({
    locale: ' en-US ',
    market: ' US ',
    localizationLevel: ' faithful ',
    quoteHash: ' quote-9 ',
    idempotencyKey: ' idem-1 ',
    model: 'forbidden',
    credits: 9,
    dialogue: [{ source: 'ja' }],
    maps: { role: 'name' },
  }), {
    locale: 'en-US',
    market: 'US',
    localization_level: 'faithful',
    quote_hash: 'quote-9',
    idempotency_key: 'idem-1',
  })
})

test('本地化 payload 缺省使用服务端 faithful 等级', () => {
  assert.equal(buildLocalizationPayload({
    locale: 'en-US',
    market: 'US',
    quoteHash: 'quote-9',
    idempotencyKey: 'idem-1',
  }).localization_level, 'faithful')
})

test('本地化报价哈希变化时不能用旧报价提交', () => {
  const work = {
    workflow_phase: 'analysis_review',
    localization_quote: { priced: true, credits: 9, quote_hash: 'quote-new' },
  }

  assert.equal(localizationQuoteCredits(work), 9)
  assert.equal(canConfirmLocalization(work, 'quote-old'), false)
  assert.equal(canConfirmLocalization(work, 'quote-new'), true)
})

test('二次报价缺失、未定价或哈希变化都必须失败关闭', () => {
  assert.equal(canConfirmLocalization({
    workflow_phase: 'analysis_review',
    localization_quote: { priced: true, credits: 9, quote_hash: '' },
  }, 'quote-9'), false)
  assert.equal(canConfirmLocalization({
    workflow_phase: 'analysis_review',
    localization_quote: { priced: false, credits: 9, quote_hash: 'quote-9' },
  }, 'quote-9'), false)
  assert.equal(canConfirmLocalization({
    workflow_phase: 'analysis_review',
    localization_quote: { priced: true, credits: 9, quote_hash: 'quote-new' },
  }, 'quote-9'), false)
})

test('明确服务端 workflow_phase 优先于 current_step 兼容回退', () => {
  assert.equal(redrawWorkflowPhase({
    current_step: 2,
    workflow_phase: 'analysis_review',
  }), 'analysis_review')
  assert.equal(redrawWorkflowPhase({
    current_step: 2,
    workflow_phase: 'asset_review',
  }), 'assets')
  assert.equal(redrawWorkflowPhase({ current_step: 2 }), 'assets')
})

test('本地化轮询阶段独立于分析任务和 current_step', () => {
  assert.equal(redrawWorkflowPhase({
    current_step: 1,
    workflow_phase: 'localizing',
    analysis_task: { status: 'completed' },
    localization_task: { id: 'loc-1', status: 'processing' },
  }), 'localizing')
  assert.deepEqual(localizationTaskState({
    current_step: 2,
    analysis_task: { status: 'completed' },
    localization_task: { id: 'loc-2', status: 'completed', progress: 100, message: 'done' },
  }), {
    task_id: 'loc-2',
    status: 'completed',
    progress: 100,
    message: 'done',
  })
})

test('本地化失败状态优先于后端回落的分析确认阶段', () => {
  assert.equal(redrawWorkflowPhase({
    workflow_phase: 'analysis_review',
    analysis_task: { status: 'completed' },
    localization_task: { id: 'loc-1', status: 'failed' },
  }), 'localization_needs_attention')
})

test('本地化重试必须明确失败且明确已退款或释放，否则失败关闭', () => {
  assert.equal(canConfirmLocalization({
    workflow_phase: 'localization_needs_attention',
    localization_task: { id: 'loc-1', status: 'failed' },
    localization_quote: { priced: true, credits: 9, quote_hash: 'quote-9' },
  }), false)
  assert.equal(canConfirmLocalization({
    workflow_phase: 'localization_needs_attention',
    localization_task: { id: 'loc-1', status: 'failed' },
    localization_billing: { held: 0, charged: 0, released: 9 },
    localization_quote: { priced: true, credits: 9, quote_hash: 'quote-9' },
  }), true)
  assert.equal(canConfirmLocalization({
    workflow_phase: 'localization_needs_attention',
    localization_task: { id: 'loc-1', status: 'failed' },
    localization_billing: { held: 0, charged: 0, released: 0 },
    localization_quote: { priced: true, credits: 9, quote_hash: 'quote-9' },
  }), false)
})

test('本地化幂等键只在完成或明确失败且已退款释放后重置', () => {
  assert.equal(shouldResetLocalizationIdempotencyKey({
    workflow_phase: 'analysis_review',
    localization_quote: { priced: true, credits: 9, quote_hash: 'quote-9' },
  }), false)
  assert.equal(shouldResetLocalizationIdempotencyKey({
    workflow_phase: 'localization_needs_attention',
    localization_task: { id: 'loc-1', status: 'failed' },
  }), false)
  assert.equal(shouldResetLocalizationIdempotencyKey({
    localization_task: { id: 'loc-1', status: 'completed' },
  }), true)
  assert.equal(shouldResetLocalizationIdempotencyKey({
    localization_task: { id: 'loc-1', status: 'failed' },
    localization_billing: { held: 0, charged: 0, released: 9 },
  }), true)
})

test('工作台步骤由后端真实推进自动进入下一步但不覆盖用户回退', () => {
  assert.equal(resolveUpdatedStep({ routeStep: 1, previousBackendStep: 1, nextBackendStep: 2 }), 2)
  assert.equal(resolveUpdatedStep({ routeStep: 1, previousBackendStep: 2, nextBackendStep: 2 }), 1)
  assert.equal(resolveUpdatedStep({ routeStep: 3, previousBackendStep: 1, nextBackendStep: 2 }), 2)
})

test('本地化报价请求按 work 和目标参数去重且不吞不同作品请求', () => {
  const gate = createLocalizationQuoteRequestGate()
  const requestA = { workId: 1, locale: 'en-US', market: 'US', localizationLevel: 'faithful' }
  const requestB = { workId: 2, locale: 'en-US', market: 'US', localizationLevel: 'faithful' }

  assert.equal(gate.begin(requestA), true)
  assert.equal(gate.begin(requestA), false)
  assert.equal(gate.begin(requestB), true)
  assert.equal(gate.isActive(requestA), true)
  gate.finish(requestA)
  assert.equal(gate.begin(requestA), true)
})

test('本地化报价 gate 分离 active 去重与当前期望 key', () => {
  const gate = createLocalizationQuoteRequestGate()
  const requestA = { workId: 1, locale: 'en-US', market: 'US', localizationLevel: 'faithful' }
  const requestB = { workId: 2, locale: 'en-US', market: 'US', localizationLevel: 'faithful' }

  assert.equal(gate.begin(requestA), true)
  assert.equal(gate.begin(requestB), true)
  assert.equal(gate.begin(requestA), false)
  assert.equal(gate.accepts(requestA), true)
  assert.equal(gate.accepts(requestB), false)
  gate.finish(requestA)
  assert.equal(gate.begin(requestA), true)
})

test('本地化确认二次报价只接受同 work 同上下文且仍在确认阶段', () => {
  const snapshot = createLocalizationConfirmationSnapshot({
    work: {
      id: 1,
      workflow_phase: 'analysis_review',
      localization_quote: { priced: true, credits: 9, quote_hash: 'quote-9' },
    },
    quoteBody: { locale: 'en-US', market: 'US', localization_level: 'faithful' },
  })

  assert.equal(isCurrentLocalizationConfirmation(snapshot, {
    work: { id: 2, workflow_phase: 'analysis_review' },
    quoteBody: { locale: 'en-US', market: 'US', localization_level: 'faithful' },
  }), false)
  assert.equal(isCurrentLocalizationConfirmation(snapshot, {
    work: { id: 1, workflow_phase: 'analysis_review' },
    quoteBody: { locale: 'ja-JP', market: 'JP', localization_level: 'faithful' },
  }), false)
  assert.equal(isCurrentLocalizationConfirmation(snapshot, {
    work: { id: 1, workflow_phase: 'localizing' },
    quoteBody: { locale: 'en-US', market: 'US', localization_level: 'faithful' },
  }), false)
  assert.equal(isCurrentLocalizationConfirmation(snapshot, {
    work: {
      id: 1,
      workflow_phase: 'analysis_review',
      localization_quote: { priced: true, credits: 9, quote_hash: 'quote-new' },
    },
    quoteBody: { locale: 'en-US', market: 'US', localization_level: 'faithful' },
  }), false)
  assert.equal(isCurrentLocalizationConfirmation(snapshot, {
    work: {
      id: 1,
      workflow_phase: 'analysis_review',
      localization_quote: { priced: true, credits: 9, quote_hash: 'quote-9' },
    },
    quoteBody: { locale: 'en-US', market: 'US', localization_level: 'faithful' },
  }), true)
})

test('真实公开 localization_billing released 是本地化失败重试证据', () => {
  assert.equal(canConfirmLocalization({
    workflow_phase: 'localization_needs_attention',
    localization_task: { id: 'loc-1', status: 'failed' },
    localization_billing: { held: 0, charged: 0, released: 9 },
    localization_quote: { priced: true, credits: 9, quote_hash: 'quote-9' },
  }), true)
  assert.equal(shouldResetLocalizationIdempotencyKey({
    localization_task: { id: 'loc-1', status: 'failed' },
    localization_billing: { held: 0, charged: 0, released: 9 },
  }), true)
})
