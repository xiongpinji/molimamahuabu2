import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

const location = new URL('../src/components/redraw/RedrawExecutionRunPanel.vue', import.meta.url)
const digest = value => value.repeat(64)
const hash = value => createHash('sha256').update(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
const tick = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function document() {
  const unit = { id: 'unit-1', source_start_ms: 0, source_end_ms: 5000, parent_shots: [{ id: 'shot-1' }],
    retained_duration_ms: 5000, generated_duration_ms: 5000, padding_ms: 0, dialogues: [],
    reference_requirements: [{ id: 'motion-shot-1', kind: 'video' }] }
  const bindings = { tenant_id: 'tenant-a', user_id: 'user-a', work_id: 1, version_id: 10, source_asset_id: 101,
    source_sha256: digest('d'), blueprint_hash: digest('b'), localization_hash: digest('c'), capability_hash: digest('e'),
    localization_updated_at: 'saved' }
  const preview = { schema_version: 'redraw-execution-plan-preview-v1', status: 'ready', executable: false,
    plan_hash: digest('a'), bindings, units: [unit], blocking_reasons: [], execution_blockers: ['PREVIEW_ONLY'],
    capability: { model: 'fixture', audio_mode: 'native', resolutions: ['480p', '720p'], aspect_ratios: ['9:16', '16:9'] } }
  return { record: { version_id: 10, blueprint_hash: bindings.blueprint_hash, localization_hash: bindings.localization_hash, updated_at: 'saved' },
    preview, savedReview: { id: 4, status: 'current', plan_hash: preview.plan_hash, plan: structuredClone(preview) },
    queue: { id: 8, version_id: 10, work_id: 1, status: 'waiting_readiness', executable: false, plan_hash: preview.plan_hash,
      execution_blockers: ['PREVIEW_ONLY'], units: [{ id: unit.id, ordinal: 0, status: 'pending', unit_hash: hash(unit), plan_unit: unit }] },
    blocked: false, projectPolicy: { project_id: 5, execution_mode: 'safe', policy_version: 2, epoch: 1 } }
}
function run(props, id = 20, revision = 0) {
  return { id, work_id: 1, version_id: 10, queue_id: 8, review_id: 4, plan_hash: props.preview.plan_hash,
    status: 'ready', binding_status: 'current', pause_requested: false, revision, created_at: 'created', updated_at: 'updated',
    executable: false, output_parameters: null, units: [{ id: 'unit-1', ordinal: 0, unit_hash: props.queue.units[0].unit_hash,
      status: 'pending', attempts: [] }], execution_blockers: [] }
}
function readiness(props, output = { resolution: '720p', aspect_ratio: '16:9' }, revision = 0) {
  return { schema_version: 'redraw-execution-run-advance-readiness-v1', status: 'ready', executable: false, action: 'advance',
    phase: 'idle', run_id: 20, run_revision: revision, plan_hash: props.preview.plan_hash, unit_id: 'unit-1', attempt_id: null,
    output_parameters: output, amount: 12, billing_mode: 'paid', quote_hash: digest('6'), confirmation_hash: digest('7'),
    policy: { execution_mode: 'safe', policy_version: 2 } }
}
function submission(taskId = 'd2781e76-f87f-4efb-8f34-6e8ac48b091b', revision = 1) {
  return { run_id: 20, run_revision: revision, attempt_id: 30, task_id: taskId, status: 'pending', attempt_status: 'submitted',
    provider_task_id: 'fixture-provider-id', newly_submitted: true, receipt_persisted: true, changed: true, executable: false }
}
function storage() {
  const values = new Map()
  return { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
}
function runtime(t, overrides = {}) {
  assert.ok(existsSync(location), 'G4.8 component missing: RedrawExecutionRunPanel.vue')
  const source = readFileSync(location, 'utf8'), props = vue.reactive(document()), calls = [], unmount = []
  const scope = vue.effectScope(), local = storage(), session = storage(), listeners = new Map()
  local.setItem('moli_mama_session', JSON.stringify({ token: 'fixture-token', user: { id: 'user-a' } }))
  local.setItem('moli_mama_tenant_id', 'tenant-a')
  const window = { localStorage: local, sessionStorage: session,
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn) }
  const defaults = {
    listExecutionRuns: async () => ({ version_id: 10, current_run_id: 20, runs: [run(props), { ...run(props, 19), binding_status: 'stale' }] }),
    getExecutionRun: async (_v, id) => run(props, id), createExecutionRun: async () => run(props),
    getExecutionRunReadiness: async (_v, _r, output) => readiness(props, output),
    advanceExecutionRun: async () => submission(),
  }
  const api = Object.fromEntries(Object.entries({ ...defaults, ...overrides }).map(([name, fn]) => [name, (...args) => {
    calls.push([name, ...args]); return fn(...args)
  }]))
  for (const name of ['pauseExecutionRun', 'resumeExecutionRun', 'recoverExecutionUnitTask', 'reviewExecutionUnitCandidate']) {
    api[name] ??= (...args) => { calls.push([name, ...args]); throw new Error('Unexpected POST in first component group') }
  }
  const bindings = { reactive: vue.reactive, computed: vue.computed, ref: vue.ref, watch: vue.watch,
    redrawAPI: api, crypto: webcrypto, window, localStorage: local, sessionStorage: session,
    readSession: () => JSON.parse(local.getItem('moli_mama_session')), readCurrentTenantId: () => local.getItem('moli_mama_tenant_id'),
    onUnmounted: fn => unmount.push(fn) }
  const descriptor = parse(source).descriptor, script = compileScript(descriptor, { id: 'execution-run' })
  const compiled = script.content.replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
  const template = compileTemplate({ id: 'execution-run', filename: location.pathname, source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const component = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings))
  const state = scope.run(() => component.setup(props, { expose() {}, emit() {} }))
  let disposed = false
  const dispose = () => { if (!disposed) { disposed = true; unmount.forEach(fn => fn()); scope.stop() } }
  t.after(dispose)
  return { state, props, calls, dispose }
}
const posts = h => h.calls.filter(([name]) => !name.startsWith('get') && !name.startsWith('list'))
async function selectCurrent(h) {
  await h.state.refreshRuns(); await h.state.selectRun(20)
  assert.equal(h.state.run.value?.id, 20, 'backend run detail must be accepted before readiness')
}
async function quote(h) {
  await selectCurrent(h)
  h.state.selectedResolution.value = '720p'; h.state.selectedAspectRatio.value = '16:9'
  await h.state.loadReadiness()
}
function revisionOneRuntime(t, overrides = {}) {
  const h = runtime(t, {
    listExecutionRuns: async () => ({ version_id: 10, current_run_id: 20, runs: [run(h.props, 20, 1)] }),
    getExecutionRun: async (_v, id) => run(h.props, id, 1),
    getExecutionRunReadiness: async (_v, _r, output) => readiness(h.props, output, 1), ...overrides,
  })
  return h
}

test('discovery exposes backend current/history and detail without any implicit mutation', async t => {
  const h = runtime(t); await tick(); assert.equal(posts(h).length, 0)
  await selectCurrent(h)
  assert.equal(h.state.currentRunId.value, 20)
  assert.deepEqual(h.state.runs.value.map(item => item.id), [20, 19])
  assert.equal(h.state.run.value.id, 20); assert.equal(posts(h).length, 0)
  assert.equal(h.props.queue.units[0].status, 'pending')
  for (const [name, ...args] of h.calls) if (name.startsWith('get') || name.startsWith('list')) {
    assert.ok(args.at(-1)?.signal instanceof AbortSignal, `${name} must be abortable`)
  }
})

test('create is explicit, binds the reviewed plan/queue, and double click sends only one POST', async t => {
  const wait = deferred()
  const h = runtime(t, { listExecutionRuns: async () => ({ version_id: 10, current_run_id: null, runs: [] }),
    createExecutionRun: () => wait.promise })
  await h.state.refreshRuns(); assert.equal(posts(h).length, 0)
  const first = h.state.createRun(); const second = h.state.createRun(); await tick()
  assert.equal(posts(h).length, 1)
  assert.deepEqual(posts(h)[0], ['createExecutionRun', 10, { expected_plan_hash: digest('a'), expected_queue_id: 8 }])
  wait.resolve(run(h.props)); await Promise.all([first, second])
  assert.equal(posts(h).length, 1)
  assert.equal(h.state.run.value?.revision, 0, 'new backend run revision zero must be accepted')
  assert.equal(h.state.run.value?.status, 'ready')
  assert.equal(h.state.error.value, '')
})

test('readiness uses only supported chosen parameters and explicit cost confirmation advances once', async t => {
  const wait = deferred(), h = runtime(t, { advanceExecutionRun: () => wait.promise })
  await quote(h)
  assert.deepEqual(h.calls.findLast(([name]) => name === 'getExecutionRunReadiness')[3], { resolution: '720p', aspect_ratio: '16:9' })
  assert.equal(h.state.canAdvance.value, false); assert.equal(posts(h).length, 0)
  h.state.confirmAction(); assert.equal(h.state.canAdvance.value, true)
  const first = h.state.advanceRun(), second = h.state.advanceRun(); await tick()
  assert.equal(posts(h).length, 1)
  assert.deepEqual(posts(h)[0].slice(0, 3), ['advanceExecutionRun', 10, 20])
  assert.deepEqual(posts(h)[0][3], { expected_revision: 0, expected_plan_hash: digest('a'), expected_quote_hash: digest('6'),
    expected_confirmation_hash: digest('7'), output_parameters: { resolution: '720p', aspect_ratio: '16:9' } })
  wait.resolve(submission())
  await Promise.all([first, second]); assert.equal(posts(h).length, 1)
})

test('unsupported parameters are not probed and changing parameters revokes a prior confirmation', async t => {
  const h = runtime(t); await quote(h); h.state.confirmAction()
  const before = h.calls.length
  h.state.selectedResolution.value = '4k'; await h.state.loadReadiness(); await h.state.advanceRun()
  assert.equal(h.state.canAdvance.value, false); assert.equal(h.calls.length, before); assert.equal(posts(h).length, 0)
  h.state.selectedResolution.value = '720p'
  assert.equal(h.state.canAdvance.value, false)
})

test('missing price cannot be confirmed or submitted', async t => {
  const h = runtime(t, { getExecutionRunReadiness: async () => ({ ...readiness(h.props), amount: null }) })
  await quote(h); h.state.confirmAction(); await h.state.advanceRun()
  assert.equal(h.state.canAdvance.value, false); assert.equal(posts(h).length, 0)
})

test('GET project policy is not authority: readiness must match a real positive policy version', async t => {
  for (const policy of [{ execution_mode: 'auto', policy_version: 2 }, { execution_mode: 'safe', policy_version: 1 },
    { execution_mode: 'safe', policy_version: 0 }, { execution_mode: 'safe', policy_version: '2' }]) {
    const h = runtime(t, { getExecutionRunReadiness: async () => ({ ...readiness(h.props), policy }) })
    await quote(h); h.state.confirmAction(); await h.state.advanceRun()
    assert.equal(h.state.canAdvance.value, false); assert.equal(posts(h).length, 0)
  }
})

test('stable policy context observes same-tick source ABA and revokes confirmation synchronously', async t => {
  const h = runtime(t); await quote(h); h.state.confirmAction(); assert.equal(h.state.canAdvance.value, true)
  const shared = h.props.projectPolicy
  shared.execution_mode = 'auto'; shared.epoch++
  shared.execution_mode = 'safe'; shared.epoch++
  assert.equal(h.props.projectPolicy, shared); assert.equal(h.state.canAdvance.value, false)
  await h.state.advanceRun(); assert.equal(posts(h).length, 0)
})

test('late readiness cannot refill state after policy epoch ABA, scope ABA, or unmount; GET is aborted', async t => {
  for (const mutate of [h => { h.props.projectPolicy.epoch += 2 },
    h => { h.props.record.version_id = 11; h.props.record.version_id = 10 }, h => h.dispose()]) {
    const wait = deferred(), entered = deferred()
    const h = runtime(t, { getExecutionRunReadiness: (...args) => { entered.resolve(args.at(-1).signal); return wait.promise } })
    await selectCurrent(h); h.state.selectedResolution.value = '720p'; h.state.selectedAspectRatio.value = '16:9'
    const pending = h.state.loadReadiness(), signal = await entered.promise, response = readiness(h.props)
    mutate(h); assert.equal(signal.aborted, true)
    wait.resolve(response); await pending
    assert.equal(h.state.readiness.value, null); assert.equal(h.state.canAdvance.value, false); assert.equal(posts(h).length, 0)
  }
})

test('revision-one run accepts UUID and opaque nonempty task receipts without an unknown-result error', async t => {
  for (const taskId of ['d2781e76-f87f-4efb-8f34-6e8ac48b091b', 'task-1', 'd2781e76-f87f-1efb-8f34-6e8ac48b091b']) {
    const expected = submission(taskId, 2)
    const h = revisionOneRuntime(t, { advanceExecutionRun: async () => expected })
    await quote(h); h.state.confirmAction(); await h.state.advanceRun()
    assert.equal(posts(h).length, 1)
    assert.equal(h.state.error.value, '', 'a persisted nonempty string task receipt is not an unknown result')
    assert.deepEqual(vue.toRaw(h.state.submissionReceipt.value), expected)
    await h.state.advanceRun(); assert.equal(posts(h).length, 1)
  }
})

test('negative, fractional, string and unsafe run revisions remain rejected', async t => {
  for (const revision of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    const h = revisionOneRuntime(t, { getExecutionRun: async () => run(h.props, 20, revision) })
    await h.state.refreshRuns(); await h.state.selectRun(20)
    assert.ok(h.calls.some(([name]) => name === 'getExecutionRun'), 'invalid detail must actually reach the component')
    assert.equal(h.state.run.value, null); assert.notEqual(h.state.error.value, '')
    h.state.confirmAction(); await h.state.advanceRun(); assert.equal(posts(h).length, 0)
  }
})

test('invalid task IDs remain unconfirmed and cannot cause a second POST', async t => {
  for (const taskId of [40, '', '  ', null, {}, []]) {
    const expected = submission(taskId, 2)
    const h = revisionOneRuntime(t, { advanceExecutionRun: async () => expected })
    await quote(h); h.state.confirmAction(); await h.state.advanceRun()
    assert.equal(posts(h).length, 1)
    assert.notEqual(h.state.error.value, '', 'an invalid task ID must not become a confirmed receipt')
    assert.equal(h.state.canAdvance.value, false)
    await h.state.advanceRun(); assert.equal(posts(h).length, 1)
  }
})

test('refresh clears the only selected or newly created run so it can be explicitly selected again', async t => {
  for (const origin of ['selected', 'created']) {
    let hasRun = origin === 'selected'
    const h = runtime(t, {
      listExecutionRuns: async () => ({ version_id: 10, current_run_id: hasRun ? 20 : null, runs: hasRun ? [run(h.props)] : [] }),
      createExecutionRun: async () => { hasRun = true; return run(h.props) },
    })
    await h.state.refreshRuns()
    if (origin === 'created') await h.state.createRun()
    else await h.state.selectRun(20)
    assert.equal(h.state.selectedRunId.value, 20); assert.equal(h.state.run.value?.id, 20)
    const before = h.calls.length
    await h.state.refreshRuns()
    assert.equal(h.state.runs.value.length, 1); assert.equal(h.state.currentRunId.value, 20)
    assert.equal(h.state.selectedRunId.value, null, `${origin}: refresh must restore the selection placeholder`)
    assert.equal(h.state.run.value, null); assert.equal(h.state.readiness.value, null)
    assert.deepEqual(h.calls.slice(before).map(([name]) => name), ['listExecutionRuns'], 'refresh must not implicitly read detail or POST')
    await h.state.selectRun(20)
    assert.equal(h.state.run.value?.id, 20)
    h.state.selectedResolution.value = '720p'; h.state.selectedAspectRatio.value = '16:9'
    await h.state.loadReadiness()
    assert.equal(h.state.readiness.value?.status, 'ready'); assert.equal(h.state.error.value, '')
    assert.equal(posts(h).length, origin === 'created' ? 1 : 0)
  }
})
