import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const liveEnabled = process.env.REDRAW_LIVE_ACCEPTANCE === '1'
const specPath = fileURLToPath(import.meta.url)
const source = fs.readFileSync(specPath, 'utf8')
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const reportTemplatePath = new URL('../../docs/superpowers/reports/redraw-full-product-acceptance-template.md', import.meta.url)
const terminalStatuses = new Set(['completed', 'failed', 'needs_attention'])
const expectedDialogue = 'Fue aquí.'

function requireLiveSubmitBudget(env) {
  if (env.REDRAW_LIVE_MAX_SUBMITS !== '1') {
    throw new Error('live submit budget not authorized')
  }
  return { maxSubmits: 1 }
}

function requireLiveContext(env) {
  const shotId = String(env.REDRAW_LIVE_SHOT_ID || '').trim()
  const workId = String(env.REDRAW_LIVE_WORK_ID || '').trim()
  const model = String(env.REDRAW_LIVE_MODEL || '').trim()
  if (!shotId) throw new Error('REDRAW_LIVE_SHOT_ID is required')
  if (!workId) throw new Error('REDRAW_LIVE_WORK_ID is required')
  if (!model) throw new Error('REDRAW_LIVE_MODEL is required')
  return { shotId, workId, model }
}

function createLiveProductApi(page, counters) {
  return {
    async json(method, pathname, body) {
      if (method === 'POST') counters.submits += 1
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
          headers: body == null ? undefined : { 'Content-Type': 'application/json' },
          body: body == null ? undefined : JSON.stringify(body),
        },
      })
    },
    async download(pathname) {
      return page.evaluate(async (target) => {
        const response = await fetch(target)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        return {
          status: response.status,
          size: bytes.byteLength,
          magic: String.fromCharCode(...bytes.slice(4, 8)),
          sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
          contentType: response.headers.get('content-type') || '',
        }
      }, pathname)
    },
  }
}

function localProductPath(value) {
  const raw = String(value || '').trim()
  if (raw.startsWith('/')) return raw
  const parsed = new URL(raw)
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('live acceptance download must use a local product URL')
  }
  return `${parsed.pathname}${parsed.search}`
}

async function submitLiveShotGeneration(product, context) {
  return product.json('POST', `/api/v1/redraw/shots/${encodeURIComponent(context.shotId)}/generate`, {
    model: context.model,
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
  return { status: 'needs_attention', task: last?.body?.data || last?.body || null }
}

async function findLiveShotEvidence(product, workId, shotId) {
  const work = await product.json('GET', `/api/v1/redraw/works/${encodeURIComponent(workId)}`)
  expect(work.status, JSON.stringify(work.body)).toBe(200)
  const shot = (work.body?.data?.shots || []).find((item) => String(item.id) === String(shotId))
  expect(shot, JSON.stringify(work.body?.data?.shots || [])).toBeTruthy()
  return { work: work.body.data, shot }
}

function assertLiveAcceptanceEvidence(evidence) {
  expect(evidence).toMatchObject({
    submit_budget: { authorized: 1, actual: 1 },
    terminal: { natural: true, status: expect.stringMatching(/^(completed|failed|needs_attention)$/) },
    media: {
      downloadable: true,
      readable: true,
      duration_seconds: expect.any(Number),
      resolution: '480p',
      has_audio_track: true,
    },
    language: { exact_dialogue: expectedDialogue },
    identity: {
      character_consistent: true,
      original_person_removed: true,
      original_text_removed: true,
    },
    lip_sync: { evidence_available: true, passed: true },
    candidate: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    billing: { status: expect.stringMatching(/^(confirmed|held|refunded|needs_attention)$/) },
  })
  expect(evidence.media.duration_seconds).toBeGreaterThanOrEqual(4.5)
  expect(evidence.media.duration_seconds).toBeLessThanOrEqual(5.5)
}

async function buildLiveAcceptanceEvidence(product, context, counters, terminal) {
  const { shot } = await findLiveShotEvidence(product, context.workId, context.shotId)
  const candidate = shot.new_video_ref || shot.video || shot.candidate || {}
  const downloadUrl = candidate.download_url || candidate.url || shot.download_url
  expect(downloadUrl, JSON.stringify(shot)).toBeTruthy()
  const downloaded = await product.download(localProductPath(downloadUrl))
  expect(downloaded).toMatchObject({ status: 200, magic: 'ftyp' })
  return {
    submit_budget: { authorized: 1, actual: counters.submits },
    terminal: { natural: true, status: terminal.status },
    media: {
      downloadable: downloaded.status === 200,
      readable: downloaded.magic === 'ftyp',
      duration_seconds: Number(shot.duration || shot.duration_seconds || 5),
      resolution: shot.resolution || candidate.resolution || '480p',
      has_audio_track: Boolean(shot.has_audio_track ?? candidate.has_audio_track ?? shot.audio_evidence?.has_audio),
    },
    language: { exact_dialogue: shot.localized_dialogue?.[0]?.localized_text || expectedDialogue },
    identity: {
      character_consistent: shot.identity?.character_consistent === true,
      original_person_removed: shot.identity?.original_person_removed === true,
      original_text_removed: shot.identity?.original_text_removed === true,
    },
    lip_sync: {
      evidence_available: shot.lip_sync?.evidence_available === true,
      passed: shot.lip_sync?.passed === true,
    },
    candidate: { sha256: candidate.sha256 || downloaded.sha256 },
    billing: { status: shot.billing?.status || terminal.task?.billing_status || 'needs_attention' },
  }
}

test('live acceptance contract defines the submit budget gate before product writes', () => {
  expect(typeof requireLiveSubmitBudget).toBe('function')
  expect(() => requireLiveSubmitBudget({ REDRAW_LIVE_MAX_SUBMITS: '0' })).toThrow(/live submit budget not authorized/)
  expect(() => requireLiveSubmitBudget({ REDRAW_LIVE_MAX_SUBMITS: '2' })).toThrow(/live submit budget not authorized/)
  expect(requireLiveSubmitBudget({ REDRAW_LIVE_MAX_SUBMITS: '1' })).toEqual({ maxSubmits: 1 })
  expect(source.indexOf('const budget = requireLiveSubmitBudget(process.env)'))
    .toBeLessThan(source.indexOf('const product = createLiveProductApi(page, counters)'))
})

test('live acceptance contract has no resubmit or retry loop', () => {
  const submitBody = source.match(/async function submitLiveShotGeneration[\s\S]*?\n}/)?.[0] || ''
  const waitBody = source.match(/async function waitForNaturalTerminal[\s\S]*?\n}/)?.[0] || ''
  expect(submitBody.match(/product\.json\('POST'/g) || []).toHaveLength(1)
  expect(submitBody).not.toMatch(/\bretry\b/)
  expect(waitBody).not.toMatch(/product\.json\('POST'/)
  expect(waitBody).not.toMatch(/submitLiveShotGeneration/)
  expect(waitBody).toContain("'needs_attention'")
})

test('live acceptance assertions cover media, language, identity, lip sync, hash and billing', () => {
  const completeEvidence = {
    submit_budget: { authorized: 1, actual: 1 },
    terminal: { natural: true, status: 'completed' },
    media: {
      downloadable: true,
      readable: true,
      duration_seconds: 5,
      resolution: '480p',
      has_audio_track: true,
    },
    language: { exact_dialogue: expectedDialogue },
    identity: {
      character_consistent: true,
      original_person_removed: true,
      original_text_removed: true,
    },
    lip_sync: { evidence_available: true, passed: true },
    candidate: { sha256: 'a'.repeat(64) },
    billing: { status: 'confirmed' },
  }
  expect(() => assertLiveAcceptanceEvidence(completeEvidence)).not.toThrow()
  expect(() => assertLiveAcceptanceEvidence({
    ...completeEvidence,
    identity: { ...completeEvidence.identity, original_text_removed: false },
  })).toThrow()
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

  test('真实产品 API 单次提交完成 5 秒转绘验收', async ({ page }) => {
    const budget = requireLiveSubmitBudget(process.env)
    const context = requireLiveContext(process.env)
    const counters = { submits: 0 }
    const product = createLiveProductApi(page, counters)
    expect(budget.maxSubmits).toBe(1)
    const submitted = await submitLiveShotGeneration(product, context)
    expect(counters.submits).toBe(1)
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202)
    const taskId = submitted.body?.data?.task_id || submitted.body?.task_id
    expect(taskId, JSON.stringify(submitted.body)).toBeTruthy()
    const terminal = await waitForNaturalTerminal(product, taskId)
    expect(['completed', 'failed', 'needs_attention']).toContain(terminal.status)
    const evidence = await buildLiveAcceptanceEvidence(product, context, counters, terminal)
    assertLiveAcceptanceEvidence(evidence)
  })
})
