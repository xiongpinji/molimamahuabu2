import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../backend-node/', import.meta.url))
const { getFfprobePath } = require(`${backendRoot.replace(/\\/g, '/')}/src/utils/ffmpegPath`)

test.use({ trace: 'off' })

const liveEnabled = process.env.REDRAW_LIVE_ACCEPTANCE === '1'
const specPath = fileURLToPath(import.meta.url)
const source = fs.readFileSync(specPath, 'utf8')
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const reportTemplatePath = new URL('../../docs/superpowers/reports/redraw-full-product-acceptance-template.md', import.meta.url)
const terminalStatuses = new Set(['completed', 'failed', 'needs_attention'])
const generationSubmitPath = /^\/api\/v1\/redraw\/shots\/[^/]+\/generate(?:[?#]|$)/
const forbiddenClientConfigFields = /\b(model|provider|price|config|key|url)\b/i
const fakeProductContext = Object.freeze({ authToken: 'test-product-token', tenantId: 'tenant-test' })

function requiredEnv(env, name) {
  const value = String(env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requireLiveSubmitBudget(env) {
  if (env.REDRAW_LIVE_MAX_SUBMITS !== '1') {
    throw new Error('live submit budget not authorized')
  }
  return { maxSubmits: 1 }
}

function requireLiveContext(env) {
  return {
    shotId: requiredEnv(env, 'REDRAW_LIVE_SHOT_ID'),
    workId: requiredEnv(env, 'REDRAW_LIVE_WORK_ID'),
    versionId: requiredEnv(env, 'REDRAW_LIVE_VERSION_ID'),
    expectedDialogue: requiredEnv(env, 'REDRAW_LIVE_EXPECTED_DIALOGUE'),
    expectedLanguage: requiredEnv(env, 'REDRAW_LIVE_EXPECTED_LANGUAGE'),
    authToken: requiredEnv(env, 'REDRAW_LIVE_PRODUCT_AUTH_TOKEN'),
    tenantId: requiredEnv(env, 'REDRAW_LIVE_TENANT_ID'),
  }
}

function productHeaders(context = fakeProductContext) {
  return {
    Authorization: `Bearer ${context.authToken}`,
    'X-Tenant-Id': context.tenantId,
  }
}

function safeResponseSummary(response) {
  const body = response?.body || {}
  const data = body.data || {}
  const error = body.error || {}
  return JSON.stringify({
    http_status: response?.status ?? null,
    task_status: data.status || body.status || null,
    error_code: error.code || body.code || null,
    error_category: error.category || body.category || null,
  })
}

async function prepareLiveProductPage(page) {
  await page.goto('/')
}

function createLiveProductApi(page, counters, context = fakeProductContext) {
  return {
    async json(method, pathname, body) {
      if (method === 'POST' && generationSubmitPath.test(pathname)) counters.generationSubmits += 1
      return page.evaluate(async ({ target, options }) => {
        const response = await fetch(target, options)
        const contentType = response.headers.get('content-type') || ''
        const payload = contentType.includes('application/json')
          ? await response.json()
          : { raw: await response.text() }
        return { status: response.status, headers: Object.fromEntries(response.headers), body: payload }
      }, {
        target: pathname,
        options: {
          method,
          headers: {
            ...productHeaders(context),
            ...(body == null ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body == null ? undefined : JSON.stringify(body),
        },
      })
    },
  }
}

function localProductPath(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('candidate download reference is unsafe')
  if (raw.startsWith('/')) {
    const rawPath = raw.split(/[?#]/, 1)[0]
    if (rawPath.split('/').some((part) => part === '..' || /^%2e%2e$/i.test(part))) {
      throw new Error('candidate download reference is unsafe')
    }
    const parsed = new URL(raw, 'http://127.0.0.1')
    return `${parsed.pathname}${parsed.search}`
  }
  const parsed = new URL(raw)
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('candidate download reference is unsafe')
  }
  return `${parsed.pathname}${parsed.search}`
}

function safeStaticPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/')
  if (!raw
    || raw.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/i.test(raw)
    || raw.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('candidate download reference is unsafe')
  }
  return `/static/${raw.split('/').map(encodeURIComponent).join('/')}`
}

function candidateDownloadPath(shot) {
  const ref = shot?.new_video_ref || shot?.video || shot?.candidate || {}
  if (ref.local_path) return safeStaticPath(ref.local_path)
  return localProductPath(ref.video_url || ref.url || ref.download_url || shot?.download_url)
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function downloadProductMp4(request, downloadPath, testInfo, context = fakeProductContext) {
  const response = await request.get(downloadPath, { headers: productHeaders(context) })
  expect(response.status()).toBe(200)
  const bytes = await response.body()
  const outputPath = testInfo.outputPath('candidate.mp4')
  fs.writeFileSync(outputPath, bytes)
  return {
    path: outputPath,
    size: bytes.length,
    sha256: sha256Buffer(bytes),
    contentType: response.headers()['content-type'] || '',
    magic: bytes.subarray(4, 8).toString('ascii'),
  }
}

function probeMp4(filePath) {
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) {
    throw new Error('ffprobe failed')
  }
  const parsed = JSON.parse(result.stdout)
  const video = parsed.streams.find((stream) => stream.codec_type === 'video')
  const audio = parsed.streams.find((stream) => stream.codec_type === 'audio')
  return {
    durationSeconds: Number(parsed.format?.duration),
    width: Number(video?.width),
    height: Number(video?.height),
    hasAudio: Boolean(audio),
  }
}

async function submitLiveShotGeneration(product, context) {
  return product.json('POST', `/api/v1/redraw/shots/${encodeURIComponent(context.shotId)}/generate`, {
    duration: 5,
    resolution: '480p',
  })
}

async function waitForNaturalTerminal(product, taskId) {
  let last = null
  for (let poll = 0; poll < 120; poll += 1) {
    last = await product.json('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`)
    const status = String(last.body?.data?.status || last.body?.status || '')
    if (terminalStatuses.has(status)) return { status, task: last.body?.data || last.body }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  throw new Error(`live acceptance timed out before product terminal state: ${safeResponseSummary(last)}`)
}

async function findLiveShotEvidence(product, workId, shotId) {
  const work = await product.json('GET', `/api/v1/redraw/works/${encodeURIComponent(workId)}`)
  expect(work.status, safeResponseSummary(work)).toBe(200)
  const shot = (work.body?.data?.shots || []).find((item) => String(item.id) === String(shotId))
  expect(shot, safeResponseSummary(work)).toBeTruthy()
  return { work: work.body.data, shot }
}

async function fetchCurrentCandidateReview(product, shotId) {
  const reviews = await product.json('GET', `/api/v1/redraw/shots/${encodeURIComponent(shotId)}/candidate-reviews`)
  expect(reviews.status, safeResponseSummary(reviews)).toBe(200)
  const current = reviews.body?.data?.current
  expect(current, safeResponseSummary(reviews)).toBeTruthy()
  return current
}

function assertNeedsAttentionSummary(summary, shotId) {
  expect(summary?.budget?.held).toBeGreaterThan(0)
  const shot = (summary?.shots || []).find((item) => String(item.shot_id) === String(shotId))
  expect(shot, 'needs_attention summary missing target shot').toBeTruthy()
  expect(shot.provider_status).toBe('submission_unknown')
}

async function failOnNeedsAttention(product, context) {
  const summary = await product.json('GET', `/api/v1/redraw/versions/${encodeURIComponent(context.versionId)}/generation-summary`)
  expect(summary.status, safeResponseSummary(summary)).toBe(200)
  assertNeedsAttentionSummary(summary.body?.data, context.shotId)
  throw new Error('live acceptance reached needs_attention; product shows held submission_unknown, no candidate download attempted')
}

function assertCurrentReviewMetrics(current, context) {
  const metrics = current?.metrics
  expect(current?.candidate_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(metrics?.media).toMatchObject({
    readable: true,
    duration_matches: true,
    dimensions_match: true,
    hash_matches: true,
  })
  expect(metrics?.dialogue).toMatchObject({
    has_audio: true,
    language: context.expectedLanguage,
    language_matches: true,
    exact_target_text: true,
    speaker_voice_matches: true,
  })
  expect(metrics?.identity).toMatchObject({
    all_bound: true,
    stable: true,
    person_count_matches: true,
    relationships_match: true,
  })
  expect(metrics?.residuals).toMatchObject({
    original_person_absent: true,
    original_text_absent: true,
  })
  expect(metrics?.lip_sync).toMatchObject({
    evidence_available: true,
    passed: true,
  })
}

function localizedDialogueText(shot) {
  const direct = shot?.localized_dialogue
  if (Array.isArray(direct)) return direct.map((turn) => turn.localized_text).join(' ').trim()
  const json = shot?.localized_dialogue_json
  if (typeof json === 'string' && json.trim()) {
    return JSON.parse(json).map((turn) => turn.localized_text).join(' ').trim()
  }
  throw new Error('localized dialogue evidence is missing')
}

function requiredFiniteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('live billing evidence is not confirmed')
  }
  return value
}

function liveBillingEvidence(billing) {
  const charged = requiredFiniteNumber(billing?.charged)
  const held = requiredFiniteNumber(billing?.held)
  const released = requiredFiniteNumber(billing?.released)
  if (charged <= 0 || held !== 0 || released !== 0) {
    throw new Error('live billing evidence is not confirmed')
  }
  return { status: 'confirmed', charged, held, released, quote: billing.quote }
}

function assertLiveAcceptanceEvidence(evidence, context) {
  expect(evidence).toMatchObject({
    submit_budget: { authorized: 1, actual: 1 },
    terminal: { natural: true, status: 'completed' },
    media: {
      downloadable: true,
      readable: true,
      resolution: '480p',
      width: 854,
      height: 480,
      has_audio_track: true,
    },
    language: {
      expected_dialogue: context.expectedDialogue,
      actual_dialogue: context.expectedDialogue,
      expected_language: context.expectedLanguage,
      qa_language: context.expectedLanguage,
    },
    identity: {
      character_consistent: true,
      original_person_removed: true,
      original_text_removed: true,
    },
    lip_sync: { evidence_available: true, passed: true },
    candidate: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), downloaded_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    billing: { status: 'confirmed' },
  })
  expect(evidence.media.duration_seconds).toBeGreaterThanOrEqual(4.5)
  expect(evidence.media.duration_seconds).toBeLessThanOrEqual(5.5)
  expect(evidence.candidate.downloaded_sha256).toBe(evidence.candidate.sha256)
}

async function buildLiveAcceptanceEvidence(product, request, context, counters, terminal, testInfo) {
  if (terminal.status === 'needs_attention') await failOnNeedsAttention(product, context)
  expect(terminal.status).toBe('completed')
  const { shot } = await findLiveShotEvidence(product, context.workId, context.shotId)
  const current = await fetchCurrentCandidateReview(product, context.shotId)
  assertCurrentReviewMetrics(current, context)
  const downloaded = await downloadProductMp4(request, candidateDownloadPath(shot), testInfo, context)
  const probe = probeMp4(downloaded.path)
  expect(downloaded).toMatchObject({ magic: 'ftyp' })
  expect(probe).toMatchObject({ width: 854, height: 480, hasAudio: true })
  const dialogue = localizedDialogueText(shot)
  expect(dialogue).toBe(context.expectedDialogue)
  return {
    submit_budget: { authorized: 1, actual: counters.generationSubmits },
    terminal: { natural: true, status: terminal.status },
    media: {
      downloadable: downloaded.size > 0,
      readable: downloaded.magic === 'ftyp',
      duration_seconds: probe.durationSeconds,
      resolution: '480p',
      width: probe.width,
      height: probe.height,
      has_audio_track: probe.hasAudio,
    },
    language: {
      expected_dialogue: context.expectedDialogue,
      actual_dialogue: dialogue,
      expected_language: context.expectedLanguage,
      qa_language: current.metrics.dialogue.language,
    },
    identity: {
      character_consistent: current.metrics.identity.all_bound && current.metrics.identity.stable,
      original_person_removed: current.metrics.residuals.original_person_absent,
      original_text_removed: current.metrics.residuals.original_text_absent,
    },
    lip_sync: current.metrics.lip_sync,
    candidate: { sha256: current.candidate_sha256, downloaded_sha256: downloaded.sha256 },
    billing: liveBillingEvidence(shot.billing),
  }
}

test('live acceptance contract defines the submit budget gate before product writes', () => {
  expect(typeof requireLiveSubmitBudget).toBe('function')
  expect(() => requireLiveSubmitBudget({ REDRAW_LIVE_MAX_SUBMITS: '0' })).toThrow(/live submit budget not authorized/)
  expect(() => requireLiveSubmitBudget({ REDRAW_LIVE_MAX_SUBMITS: '2' })).toThrow(/live submit budget not authorized/)
  expect(requireLiveSubmitBudget({ REDRAW_LIVE_MAX_SUBMITS: '1' })).toEqual({ maxSubmits: 1 })
  expect(source.indexOf('const budget = requireLiveSubmitBudget(process.env)'))
    .toBeLessThan(source.indexOf('const product = createLiveProductApi(page, counters)'))
  expect(source.indexOf('const budget = requireLiveSubmitBudget(process.env)'))
    .toBeLessThan(source.indexOf('await prepareLiveProductPage(page)'))
})

test('live acceptance contract has no resubmit, retry loop or client config fields', () => {
  const submitBody = source.match(/async function submitLiveShotGeneration[\s\S]*?\n}/)?.[0] || ''
  const waitBody = source.match(/async function waitForNaturalTerminal[\s\S]*?\n}/)?.[0] || ''
  expect(submitBody.match(/product\.json\('POST'/g) || []).toHaveLength(1)
  expect(submitBody).not.toMatch(/\bretry\b/)
  expect(submitBody).not.toMatch(forbiddenClientConfigFields)
  expect(source).not.toContain(['REDRAW', 'LIVE', 'MODEL'].join('_'))
  expect(waitBody).not.toMatch(/product\.json\('POST'/)
  expect(waitBody).not.toMatch(/submitLiveShotGeneration/)
  expect(waitBody).not.toContain("'needs_attention'")
  expect(waitBody).toContain('timed out before product terminal state')
})

test('live generation submit body only contains server-owned generation parameters', async () => {
  let submittedBody = null
  const product = {
    async json(method, pathname, body) {
      submittedBody = { method, pathname, body }
      return { status: 202, body: { data: { task_id: 'task-contract' } } }
    },
  }
  expect(requireLiveContext({
    REDRAW_LIVE_SHOT_ID: '12',
    REDRAW_LIVE_WORK_ID: '34',
    REDRAW_LIVE_VERSION_ID: '56',
    REDRAW_LIVE_EXPECTED_DIALOGUE: 'Fue aqui.',
    REDRAW_LIVE_EXPECTED_LANGUAGE: 'es-ES',
    REDRAW_LIVE_PRODUCT_AUTH_TOKEN: 'test-product-token',
    REDRAW_LIVE_TENANT_ID: 'tenant-test',
  })).toMatchObject({ shotId: '12', workId: '34', versionId: '56' })
  await submitLiveShotGeneration(product, { shotId: '12' })
  expect(submittedBody.body).toEqual({ duration: 5, resolution: '480p' })
  expect(Object.keys(submittedBody.body).join(',')).not.toMatch(forbiddenClientConfigFields)
})

test('live acceptance counts only generation submits', async () => {
  const counters = { generationSubmits: 0 }
  const product = createLiveProductApi({
    evaluate: async () => ({ status: 200, headers: {}, body: { ok: true } }),
  }, counters)
  await product.json('POST', '/api/v1/redraw/projects', { title: 'prep' })
  await product.json('POST', '/api/v1/redraw/shots/12/generate', { duration: 5, resolution: '480p' })
  expect(counters.generationSubmits).toBe(1)
})

test('live acceptance assertions fail closed when required evidence is missing', () => {
  const context = { expectedDialogue: 'Fue aqui.', expectedLanguage: 'es-ES' }
  const completeEvidence = {
    submit_budget: { authorized: 1, actual: 1 },
    terminal: { natural: true, status: 'completed' },
    media: {
      downloadable: true,
      readable: true,
      duration_seconds: 5,
      resolution: '480p',
      width: 854,
      height: 480,
      has_audio_track: true,
    },
    language: {
      expected_dialogue: 'Fue aqui.',
      actual_dialogue: 'Fue aqui.',
      expected_language: 'es-ES',
      qa_language: 'es-ES',
    },
    identity: {
      character_consistent: true,
      original_person_removed: true,
      original_text_removed: true,
    },
    lip_sync: { evidence_available: true, passed: true },
    candidate: { sha256: 'a'.repeat(64), downloaded_sha256: 'a'.repeat(64) },
    billing: { status: 'confirmed' },
  }
  expect(() => assertLiveAcceptanceEvidence(completeEvidence, context)).not.toThrow()
  for (const broken of [
    { ...completeEvidence, media: { ...completeEvidence.media, duration_seconds: undefined } },
    { ...completeEvidence, language: { ...completeEvidence.language, actual_dialogue: undefined } },
    { ...completeEvidence, candidate: { ...completeEvidence.candidate, downloaded_sha256: 'b'.repeat(64) } },
    { ...completeEvidence, billing: { status: undefined } },
  ]) {
    expect(() => assertLiveAcceptanceEvidence(broken, context)).toThrow()
  }
})

test('live billing evidence is confirmed only from charged product shot billing', () => {
  expect(liveBillingEvidence({ charged: 5, held: 0, released: 0, quote: { total: 5 } }))
    .toEqual({ status: 'confirmed', charged: 5, held: 0, released: 0, quote: { total: 5 } })
  for (const billing of [
    undefined,
    {},
    { charged: '5', held: 0, released: 0, quote: { total: 5 } },
    { charged: 0, held: 0, released: 0, quote: { total: 5 } },
    { charged: 5, held: 1, released: 0, quote: { total: 5 } },
    { charged: 5, held: 0, released: 5, quote: { total: 5 } },
  ]) {
    expect(() => liveBillingEvidence(billing)).toThrow(/live billing evidence is not confirmed/)
  }
})

test('live product context requires auth tenant and redacted summaries hide sensitive fields', () => {
  const context = requireLiveContext({
    REDRAW_LIVE_SHOT_ID: '12',
    REDRAW_LIVE_WORK_ID: '34',
    REDRAW_LIVE_VERSION_ID: '56',
    REDRAW_LIVE_EXPECTED_DIALOGUE: 'Fue aqui.',
    REDRAW_LIVE_EXPECTED_LANGUAGE: 'es-ES',
    REDRAW_LIVE_PRODUCT_AUTH_TOKEN: 'secret-product-token',
    REDRAW_LIVE_TENANT_ID: 'tenant-live',
  })
  expect(productHeaders(context)).toMatchObject({
    Authorization: 'Bearer secret-product-token',
    'X-Tenant-Id': 'tenant-live',
  })
  const summary = safeResponseSummary({
    status: 500,
    body: {
      error: {
        code: 'SAFE_CODE',
        category: 'safe_category',
        provider_task_id: 'provider-task-secret',
        metadata: { token: 'secret-product-token' },
        result: { url: 'https://provider.example/private' },
        local_path: 'C:\\secret\\candidate.mp4',
      },
    },
  })
  expect(summary).toContain('SAFE_CODE')
  expect(summary).toContain('safe_category')
  expect(summary).not.toMatch(/secret-product-token|provider-task-secret|provider\.example|candidate\.mp4|metadata|result/i)
})

test('live product API forwards auth tenant headers and counts only generation submits', async () => {
  const calls = []
  const page = {
    evaluate: async (_fn, payload) => {
      calls.push(payload)
      return { status: 200, headers: {}, body: { data: { status: 'completed' } } }
    },
  }
  const counters = { generationSubmits: 0 }
  const product = createLiveProductApi(page, counters, {
    authToken: 'secret-product-token',
    tenantId: 'tenant-live',
  })
  await product.json('POST', '/api/v1/redraw/projects', { title: 'prep' })
  await product.json('POST', '/api/v1/redraw/shots/12/generate', { duration: 5, resolution: '480p' })
  expect(counters.generationSubmits).toBe(1)
  expect(calls[0].options.headers.Authorization).toBe('Bearer secret-product-token')
  expect(calls[0].options.headers['X-Tenant-Id']).toBe('tenant-live')
})

test('live candidate download forwards auth tenant headers', async ({}, testInfo) => {
  let requestCall = null
  const mp4Bytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112])
  const request = {
    async get(pathname, options) {
      requestCall = { pathname, options }
      return {
        status: () => 200,
        body: async () => mp4Bytes,
        headers: () => ({ 'content-type': 'video/mp4' }),
      }
    },
  }
  await downloadProductMp4(request, '/static/redraw/live/candidate.mp4', testInfo, {
    authToken: 'secret-product-token',
    tenantId: 'tenant-live',
  })
  expect(requestCall).toMatchObject({
    pathname: '/static/redraw/live/candidate.mp4',
    options: { headers: { Authorization: 'Bearer secret-product-token', 'X-Tenant-Id': 'tenant-live' } },
  })
})

test('live flow establishes page origin before relative product requests', async () => {
  const events = []
  const page = {
    async goto(pathname) { events.push(['goto', pathname]) },
    async evaluate() { events.push(['fetch']); return { status: 200, headers: {}, body: {} } },
  }
  await prepareLiveProductPage(page)
  const product = createLiveProductApi(page, { generationSubmits: 0 }, {
    authToken: 'secret-product-token',
    tenantId: 'tenant-live',
  })
  await product.json('GET', '/api/v1/redraw/works/34')
  expect(events).toEqual([['goto', '/'], ['fetch']])
})

test('candidate download path prefers safe local_path and rejects unsafe paths', () => {
  expect(candidateDownloadPath({ new_video_ref: { local_path: 'redraw/live/candidate.mp4' } }))
    .toBe('/static/redraw/live/candidate.mp4')
  expect(candidateDownloadPath({ new_video_ref: { video_url: '/api/v1/redraw/exports/1/download/mp4?x=1' } }))
    .toBe('/api/v1/redraw/exports/1/download/mp4?x=1')
  for (const shot of [
    { new_video_ref: { local_path: '../candidate.mp4' } },
    { new_video_ref: { local_path: 'C:\\secret\\candidate.mp4' } },
    { new_video_ref: { video_url: '/static/../candidate.mp4' } },
    { new_video_ref: { video_url: 'https://provider.example/candidate.mp4' } },
    { new_video_ref: { download_url: 'file:///C:/secret/candidate.mp4' } },
  ]) {
    expect(() => candidateDownloadPath(shot)).toThrow(/candidate download reference is unsafe/)
  }
})

test('live describe disables trace and extends only live timeout', () => {
  expect(source).toContain("test.use({ trace: 'off' })")
  expect(source).toContain('test.setTimeout(660_000)')
})

test('needs_attention requires product summary evidence and remains a failed acceptance', async () => {
  const product = {
    async json() {
      return {
        status: 200,
        body: {
          data: {
            budget: { held: 5 },
            shots: [{ shot_id: 12, provider_status: 'submission_unknown' }],
          },
        },
      }
    },
  }
  await expect(failOnNeedsAttention(product, { versionId: '56', shotId: '12' }))
    .rejects.toThrow(/needs_attention/)
  expect(() => assertNeedsAttentionSummary({
    budget: { held: 0 },
    shots: [{ shot_id: 12, provider_status: 'submission_unknown' }],
  }, '12')).toThrow()
})

test('live acceptance report template records evidence without secrets or local paths', () => {
  const template = fs.readFileSync(reportTemplatePath, 'utf8')
  for (const required of [
    '提交预算',
    '实际提交次数',
    '自然终态',
    '候选哈希',
    '媒体检查',
    '语言检查',
    '身份检查',
    '口型检查',
    '计费检查',
    'Skipped gates',
  ]) {
    expect(template).toContain(required)
  }
  expect(template).not.toMatch(/\b(Key|Authorization|Bearer|api[_-]?key|token)\b/i)
  expect(template).not.toMatch(/https?:\/\/[^\s)]+/)
  expect(template).not.toContain(repoRoot)
  expect(template).not.toMatch(/[A-Z]:[\\/]/)
})

test.describe('live product acceptance', () => {
  test.skip(!liveEnabled, '真实产品验收必须显式启用 REDRAW_LIVE_ACCEPTANCE=1')

  test('真实产品 API 单次提交完成 5 秒转绘验收', async ({ page, request }, testInfo) => {
    test.setTimeout(660_000)
    const budget = requireLiveSubmitBudget(process.env)
    const context = requireLiveContext(process.env)
    const counters = { generationSubmits: 0 }
    expect(budget.maxSubmits).toBe(1)
    await prepareLiveProductPage(page)
    const product = createLiveProductApi(page, counters, context)
    const submitted = await submitLiveShotGeneration(product, context)
    expect(counters.generationSubmits).toBe(1)
    expect(submitted.status, safeResponseSummary(submitted)).toBe(202)
    const taskId = submitted.body?.data?.task_id || submitted.body?.task_id
    expect(taskId, safeResponseSummary(submitted)).toBeTruthy()
    const terminal = await waitForNaturalTerminal(product, taskId)
    const evidence = await buildLiveAcceptanceEvidence(product, request, context, counters, terminal, testInfo)
    assertLiveAcceptanceEvidence(evidence, context)
  })
})
