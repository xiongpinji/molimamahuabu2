import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function apiFor(request) {
  // Execute the real API methods, but replace only their HTTP transport boundary.
  const source = readFileSync(new URL('../src/api/redraw.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/export /g, '').replace('const redrawAPI =', 'return')
  return new Function('request', source)(request)
}

const hash = char => char.repeat(64)
const errorBody = (code, message) => ({ success: false, error: { code, message }, timestamp: '2026-09-08T00:00:00.000Z' })
const base = '/redraw/versions/10/execution-runs'
const unit = 'unit/一 ?#'
const unitPath = `${base}/21/units/${encodeURIComponent(unit)}`
const forbidden = { asset_id: 999, model: 'forbidden', key: 'forbidden', url: 'forbidden', path: 'forbidden',
  headers: { Authorization: 'forbidden' }, data: ['forbidden'] }
const action = { expected_revision: 3, expected_plan_hash: hash('a'), expected_quote_hash: hash('b'),
  expected_confirmation_hash: hash('c'), output_parameters: { resolution: '480p', aspect_ratio: '16:9' } }
const checks = { scene_action_continuity: { basis: 'human_watch_listen', result: 'passed' },
  source_text_and_caption_residue: { basis: 'not_checked', result: 'not_checked' } }
const review = { expected_revision: 4, expected_candidate_hash: hash('d'), decision: 'rejected', checks }
const inputs = { ...forbidden, ...action, expected_queue_id: 8, attempt_id: 31, ...review,
  output_parameters: { ...action.output_parameters, ...forbidden },
  checks: Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, { ...value, path: 'forbidden' }])) }

const reads = [
  ['listExecutionRuns', [10], base, undefined],
  ['getExecutionRun', [10, 21], `${base}/21`, undefined],
  ['getExecutionRunReadiness', [10, 21, { resolution: '480p', aspect_ratio: '16:9', ...forbidden }],
    `${base}/21/readiness`, { resolution: '480p', aspect_ratio: '16:9' }],
  ['getExecutionUnitCandidate', [10, 21, unit], `${unitPath}/candidate`, undefined],
  ['getExecutionUnitCandidateMedia', [10, 21, unit, { expected_candidate_hash: hash('d'), ...forbidden }],
    `${unitPath}/candidate/media`, { expected_candidate_hash: hash('d') }, true],
]
for (const [method, args, url, params, blob] of reads) {
  test(`${method} forwards only GET contract fields and AbortSignal without a body`, async () => {
    const calls = [], response = blob ? new Blob(['synthetic'], { type: 'video/mp4' }) : Object.freeze({ opaque: method })
    const api = apiFor({ get: (...values) => { calls.push(values); return Promise.resolve(response) } })
    assert.equal(typeof api[method], 'function', `G4.8 API missing: ${method}`)
    const controller = new AbortController()
    assert.equal(await api[method](...args, { signal: controller.signal, ...forbidden }), response)
    const options = { silentError: true, signal: controller.signal }
    if (params !== undefined) options.params = params
    if (blob) options.responseType = 'blob'
    assert.deepEqual(calls, [[url, options]])
    assert.equal(Object.hasOwn(calls[0][1], 'data'), false)
  })
  test(`${method} preserves the original GET failure object without retry`, async () => {
    const calls = [], body = errorBody('EXECUTION_RUN_CONFLICT', '运行或候选状态不可用，请刷新后确认')
    const failure = Object.assign(new Error('synthetic GET conflict'),
      { response: { status: 409, data: blob ? new Blob([JSON.stringify(body)], { type: 'application/json' }) : body } })
    const api = apiFor({ get: (...values) => { calls.push(values); return Promise.reject(failure) } })
    assert.equal(typeof api[method], 'function', `G4.8 API missing: ${method}`)
    await assert.rejects(api[method](...args, {}), error => error === failure)
    assert.equal(calls.length, 1)
  })
}

test('readiness without chosen parameters sends no body and invents no parameter values', async () => {
  const calls = [], api = apiFor({ get: (...values) => { calls.push(values); return Promise.resolve(null) } })
  assert.equal(typeof api.getExecutionRunReadiness, 'function', 'G4.8 API missing: getExecutionRunReadiness')
  await api.getExecutionRunReadiness(10, 21)
  assert.deepEqual(calls, [[`${base}/21/readiness`, {
    params: { resolution: undefined, aspect_ratio: undefined }, silentError: true, signal: undefined,
  }]])
})

const posts = [
  ['createExecutionRun', [10], base, { expected_plan_hash: inputs.expected_plan_hash, expected_queue_id: 8 }],
  ['pauseExecutionRun', [10, 21], `${base}/21/pause`, { expected_revision: inputs.expected_revision }],
  ['resumeExecutionRun', [10, 21], `${base}/21/resume`, { ...action, expected_revision: inputs.expected_revision }],
  ['advanceExecutionRun', [10, 21], `${base}/21/advance`, { ...action, expected_revision: inputs.expected_revision }],
  ['recoverExecutionUnitTask', [10, 21], `${base}/21/recover`, { attempt_id: 31 }],
  ['reviewExecutionUnitCandidate', [10, 21, unit], `${unitPath}/review`, review],
]
for (const [method, args, url, body] of posts) {
  test(`${method} forwards only its POST contract and preserves the response`, async () => {
    const calls = [], response = Object.freeze({ opaque: method }), before = structuredClone(inputs)
    const api = apiFor({ post: (...values) => { calls.push(values); return Promise.resolve(response) } })
    assert.equal(typeof api[method], 'function', `G4.8 API missing: ${method}`)
    assert.equal(await api[method](...args, inputs), response)
    assert.deepEqual(calls, [[url, body, { silentError: true }]])
    assert.deepEqual(inputs, before, 'API wrapper must not mutate caller confirmation or human checks')
  })
  test(`${method} preserves unknown/error receipt context and makes exactly one POST`, async () => {
    const calls = [], failure = Object.assign(new Error('synthetic result unknown'),
      { response: { status: 500, data: errorBody('INTERNAL_ERROR', '运行请求处理失败') } })
    const api = apiFor({ post: (...values) => { calls.push(values); return Promise.reject(failure) } })
    assert.equal(typeof api[method], 'function', `G4.8 API missing: ${method}`)
    await assert.rejects(api[method](...args, inputs), error => error === failure)
    assert.equal(calls.length, 1)
  })
}

test('review preserves dynamic candidate check keys and explicit results without inventing defaults', async () => {
  const names = ['scene_action_continuity', 'source_text_and_caption_residue', 'character_identity',
    'target_dialogue_complete', 'speaker_order', 'target_names', 'language_and_locale', 'voice_and_emotion',
    'no_extra_dialogue', 'lip_sync', 'ambient_audio', 'unknown_check_for_backend_rejection']
  const expectedChecks = Object.fromEntries(names.map((name, index) => {
    const result = ['passed', 'failed', 'not_checked'][index % 3]
    return [name, { basis: result === 'not_checked' ? 'not_checked' : 'human_watch_listen', result }]
  }))
  const body = { ...review, checks: expectedChecks }
  const input = { ...body, checks: Object.fromEntries(Object.entries(expectedChecks)
    .map(([name, value]) => [name, { ...value, path: 'forbidden', approved: true }])) }
  const calls = [], before = structuredClone(input)
  const api = apiFor({ post: (...values) => { calls.push(values); return Promise.resolve(null) } })
  assert.equal(typeof api.reviewExecutionUnitCandidate, 'function', 'G4.8 API missing: reviewExecutionUnitCandidate')
  await api.reviewExecutionUnitCandidate(10, 21, unit, input)
  assert.deepEqual(calls, [[`${unitPath}/review`, body, { silentError: true }]])
  assert.deepEqual(input, before)
})

for (const method of ['resumeExecutionRun', 'advanceExecutionRun']) {
  test(`${method} omits optional output_parameters when the caller uses frozen run parameters`, async () => {
    const calls = [], api = apiFor({ post: (...values) => { calls.push(values); return Promise.resolve(null) } })
    assert.equal(typeof api[method], 'function', `G4.8 API missing: ${method}`)
    const { output_parameters: _parameters, ...confirmation } = action
    await api[method](10, 21, { ...confirmation, ...forbidden })
    assert.deepEqual(calls, [[`${base}/21/${method === 'resumeExecutionRun' ? 'resume' : 'advance'}`,
      confirmation, { silentError: true }]])
  })
}

test('advance preserves the only provider ID in a safe receipt without requiring a run DTO or rereading', async () => {
  const calls = [], recovery = { schema_version: 'redraw-execution-unit-safe-receipt-v1',
    tenant_id: 'synthetic-tenant', user_id: 'synthetic-user', work_id: 9, version_id: 10, run_id: 21,
    attempt_id: 31, task_id: 'synthetic-task', request_hash: hash('e'), submit_started_at: '2026-09-08T00:00:00.000Z',
    provider_task_id: 'synthetic-only-provider-id', status: 'needs_attention', reason_code: 'PROVIDER_RECEIPT_PERSISTENCE_FAILED' }
  const receipt = { run_id: 21, attempt_id: 31, task_id: 'synthetic-task', status: 'needs_attention',
    provider_task_id: recovery.provider_task_id, newly_submitted: true, receipt_persisted: false,
    fallback_receipt_persisted: false, executable: false, recovery_receipt: recovery,
    attempt_status: 'needs_attention', changed: true }
  const api = apiFor({ post: (...values) => { calls.push(values); return Promise.resolve(receipt) },
    get: () => assert.fail('POST receipt must not cause an implicit GET') })
  assert.equal(typeof api.advanceExecutionRun, 'function', 'G4.8 API missing: advanceExecutionRun')
  const result = await api.advanceExecutionRun(10, 21, action)
  assert.equal(result, receipt)
  assert.equal(result.recovery_receipt, recovery)
  assert.equal(Object.hasOwn(result, 'run_revision'), false)
  assert.equal(calls.length, 1)
})
