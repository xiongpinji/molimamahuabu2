import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

const location = new URL('../src/components/redraw/RedrawExecutionRunPanel.vue', import.meta.url)
const authSource = readFileSync(new URL('../src/utils/authSession.js', import.meta.url), 'utf8')
const digest = value => value.repeat(64)
const hash = value => createHash('sha256').update(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
const tick = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }
function document() {
  const unit = { id: 'unit-1', source_start_ms: 0, source_end_ms: 5000, parent_shots: [{ id: 'shot-1' }],
    retained_duration_ms: 5000, generated_duration_ms: 5000, padding_ms: 0, dialogues: [],
    reference_requirements: [{ id: 'motion-shot-1', kind: 'video' }] }
  const bindings = { tenant_id: 'tenant-a', user_id: 'user-a', work_id: 1, version_id: 10, source_asset_id: 101,
    source_sha256: digest('d'), blueprint_hash: digest('b'), localization_hash: digest('c'), capability_hash: digest('e'), localization_updated_at: 'saved' }
  const preview = { schema_version: 'redraw-execution-plan-preview-v1', status: 'ready', executable: false,
    plan_hash: digest('a'), bindings, units: [unit], blocking_reasons: [], execution_blockers: ['PREVIEW_ONLY'],
    capability: { model: 'fixture', audio_mode: 'native', resolutions: ['480p', '720p'], aspect_ratios: ['9:16', '16:9'] } }
  return { record: { version_id: 10, blueprint_hash: bindings.blueprint_hash, localization_hash: bindings.localization_hash, updated_at: 'saved' },
    preview, savedReview: { id: 4, status: 'current', plan_hash: preview.plan_hash, plan: structuredClone(preview) },
    queue: { id: 8, version_id: 10, work_id: 1, status: 'waiting_readiness', executable: false, plan_hash: preview.plan_hash,
      execution_blockers: ['PREVIEW_ONLY'], units: [{ id: unit.id, ordinal: 0, status: 'pending', unit_hash: hash(unit), plan_unit: unit }] },
    blocked: false, projectPolicy: { project_id: 5, execution_mode: 'safe', policy_version: 2, epoch: 1 } }
}
function run(props) {
  return { id: 20, work_id: 1, version_id: 10, queue_id: 8, review_id: 4, plan_hash: props.preview.plan_hash,
    status: 'ready', binding_status: 'current', pause_requested: false, revision: 0, created_at: 'created', updated_at: 'updated',
    executable: false, output_parameters: null, units: [{ id: 'unit-1', ordinal: 0, unit_hash: props.queue.units[0].unit_hash,
      status: 'pending', attempts: [] }], execution_blockers: ['PREVIEW_ONLY', 'EXECUTION_RUN_STORAGE_ONLY'] }
}
function readiness(props, output) {
  return { schema_version: 'redraw-execution-run-advance-readiness-v1', status: 'ready', executable: false, action: 'advance',
    phase: 'idle', run_id: 20, run_revision: 0, plan_hash: props.preview.plan_hash, unit_id: 'unit-1', attempt_id: null,
    output_parameters: output, amount: 12, billing_mode: 'paid', quote_hash: digest('6'), confirmation_hash: digest('7'),
    policy: { execution_mode: 'safe', policy_version: 2 } }
}
function receipt() {
  return { run_id: 20, run_revision: 4, attempt_id: 30, task_id: 'd2781e76-f87f-4efb-8f34-6e8ac48b091b', status: 'running',
    attempt_status: 'running', provider_task_id: 'fixture-provider-id', newly_submitted: true, receipt_persisted: true, changed: true, executable: false }
}
function safeReceipt(newlySubmitted = true) {
  return { run_id: 20, attempt_id: 30, task_id: 'd2781e76-f87f-4efb-8f34-6e8ac48b091b', status: 'needs_attention',
    ...(newlySubmitted ? { attempt_status: 'needs_attention', changed: true } : {}),
    provider_task_id: 'unique-provider-receipt', newly_submitted: newlySubmitted, receipt_persisted: false, fallback_receipt_persisted: false,
    executable: false, recovery_receipt: { schema_version: 'redraw-execution-unit-safe-receipt-v1', tenant_id: 'tenant-a', user_id: 'user-a',
      work_id: 1, version_id: 10, run_id: 20, attempt_id: 30, task_id: 'd2781e76-f87f-4efb-8f34-6e8ac48b091b',
      request_hash: digest('9'), submit_started_at: '2026-09-08T00:00:00.000Z', provider_task_id: 'unique-provider-receipt',
      status: 'needs_attention', reason_code: 'PROVIDER_RECEIPT_PERSISTENCE_FAILED' } }
}
function storage() {
  const values = new Map(), writes = []
  return { fault: '', writes, snapshot: () => Object.fromEntries(values),
    get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem(key) {
      if (this.fault === 'read' || (this.fault === 'readback_throw' && values.has(key))) throw Error('fixture storage read denied')
      if (this.fault === 'readback_mismatch' && values.has(key)) return 'fixture mismatched readback'
      return values.get(key) ?? null
    },
    setItem(key, value) { if (this.fault === 'write') throw Error('fixture storage write denied'); values.set(key, String(value)); writes.push([key, String(value)]) },
    removeItem(key) { if (this.fault === 'write') throw Error('fixture storage write denied'); values.delete(key) } }
}
function browser(session = storage()) {
  const local = storage(), listeners = new Map()
  const auth = new Function('localStorage', 'sessionStorage', authSource.replace(/export /g, '')
    + '\nreturn { readSession, readCurrentTenantId, saveSession, saveCurrentTenantId, clearSession }')(local, session)
  auth.saveSession({ token: 'fixture-token', user: { id: 'user-a' } }); auth.saveCurrentTenantId('tenant-a')
  const window = { localStorage: local, sessionStorage: session,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    dispatch: (name, event) => [...(listeners.get(name) || [])].forEach(fn => fn(event)) }
  return { local, session, auth, window }
}
function evaluateModule(env, api) {
  const { descriptor } = parse(readFileSync(location, 'utf8'))
  const script = compileScript(descriptor, { id: 'execution-run-lifecycle' })
  const imports = /^import\s+\{([^}]+)\}\s+from\s+['"]vue['"];?[ \t]*$/gm
  const fromVue = (_all, names) => `const {${names.replace(/\s+as\s+/g, ':')}} = Vue;`
  assert.equal("import { redrawAPI } from '@/api/redraw'\nimport { readSession } from '@/utils/authSession'\nimport { ref as localRef } from 'vue'".replace(imports, fromVue),
    "import { redrawAPI } from '@/api/redraw'\nimport { readSession } from '@/utils/authSession'\nconst { ref:localRef } = Vue;", 'Vue binding conversion must not consume preceding non-Vue imports')
  const body = script.content.replace(imports, fromVue).replace(/^import[^\n]*(?:\n|$)/gm, '').replace('export default', 'return')
  const template = compileTemplate({ id: 'execution-run-lifecycle', filename: location.pathname, source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const component = new Function('Vue', 'redrawAPI', 'readSession', 'readCurrentTenantId', 'crypto', 'window', 'localStorage', 'sessionStorage', body)(
    vue, api, env.auth.readSession, env.auth.readCurrentTenantId, webcrypto, env.window, env.local, env.session)
  component.render = new Function('Vue', template.code.replace(imports, fromVue).replace('export function render', 'return function render'))(vue)
  return component
}
function renderer() {
  return vue.createRenderer({
    createElement: tag => ({ tag, tagName: tag.toUpperCase(), children: [], parent: null, events: {},
      addEventListener(name, fn) { this.events[name] = fn }, removeEventListener(name) { delete this.events[name] },
      get options() { return this.children.filter(node => node.tag === 'option') } }),
    createText: text => ({ text, parent: null }), createComment: comment => ({ comment, parent: null }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _old, value) => { node[key] = value }, parentNode: node => node.parent,
    nextSibling: node => { const nodes = node.parent?.children || []; return nodes[nodes.indexOf(node) + 1] || null },
    insert(node, target, anchor = null) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = target; const index = target.children.indexOf(anchor)
      if (index < 0) target.children.push(node); else target.children.splice(index, 0, node)
    },
    remove(node) { if (node.parent) { node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null } },
  })
}
function scenario(t, { action = 'advance', session = storage() } = {}) {
  const env = browser(session), fixture = document(), calls = [], pending = [], instances = [], waits = []
  let hasRun = action !== 'create'
  const handlers = {
    listExecutionRuns: async () => ({ version_id: 10, current_run_id: hasRun ? 20 : null, runs: hasRun ? [run(fixture)] : [] }),
    getExecutionRun: async () => run(fixture), getExecutionRunReadiness: async (_v, _r, output) => readiness(fixture, output),
    createExecutionRun: async () => { hasRun = true; return run(fixture) }, advanceExecutionRun: async () => receipt(),
    pauseExecutionRun: async () => { throw Error('unexpected pause fixture call') },
    resumeExecutionRun: async () => { throw Error('unexpected resume fixture call') },
    recoverExecutionUnitTask: async () => { throw Error('unexpected recover fixture call') },
  }
  const api = Object.fromEntries(Object.keys(handlers).map(name => [name, (...args) => {
    calls.push({ name, args, storageAtEntry: env.session?.snapshot() || {}, writesAtEntry: env.session?.writes.slice() || [] })
    return handlers[name](...args)
  }]))
  function evaluate() { return evaluateModule(env, api) }
  function mount(component) {
    const props = vue.reactive(structuredClone(fixture)), root = { children: [] }
    const app = renderer().createApp({ setup: () => () => vue.h(component, props) })
    app.component('el-button', { props: ['disabled', 'loading'], setup: (buttonProps, { attrs, slots }) => () => vue.h('button', { ...attrs, disabled: buttonProps.disabled }, slots.default?.()) })
    app.config.warnHandler = message => { throw Error(`Vue fixture warning: ${message}`) }
    app.mount(root)
    const instance = app._instance.subTree.component
    assert.ok(instance?.isMounted, 'actual Vue component must mount before behavior assertions')
    assert.equal(instance.type, component)
    let disposed = false
    const h = { props, root, instance, state: instance.setupState,
      invoke(name, ...args) {
        assert.equal(typeof h.state[name], 'function', `lifecycle UI action ${name} must exist`)
        const result = Promise.resolve(h.state[name](...args)); pending.push(result); return result
      },
      dispose() { if (!disposed) { disposed = true; app.unmount() } },
    }
    instances.push(h); return h
  }
  function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); const wait = { promise, resolve, reject }; waits.push(wait); return wait }
  t.after(async () => { waits.forEach(wait => wait.resolve(null)); instances.forEach(h => h.dispose()); await Promise.allSettled(pending); await tick() })
  return { env, fixture, calls, handlers, evaluate, mount, deferred }
}
const posts = world => world.calls.filter(call => !call.name.startsWith('get') && !call.name.startsWith('list'))
async function prepare(h, action) {
  await h.invoke('refreshRuns')
  if (action === 'advance') {
    await h.invoke('selectRun', 20)
    h.state.selectedResolution = '720p'; h.state.selectedAspectRatio = '16:9'
    await h.invoke('loadReadiness'); await h.invoke('confirmAction')
  }
}
function assertDurableIntent(entry, action) {
  const records = Object.entries(entry.storageAtEntry).map(([key, raw]) => ({ key, raw, value: JSON.parse(raw) }))
  const saved = records.find(({ value }) => value?.action === action && value.status === 'pending')
  assert.ok(saved, 'a single durable pending action record must exist before entering POST')
  assert.deepEqual(JSON.parse(saved.value.scope), [['tenant-a', 'user-a'], 5, 1, 10, 4, 8, digest('a')])
  assert.equal(saved.value.hash, action === 'advance' ? digest('7') : '', 'intent must bind this action confirmation')
  assert.ok(entry.writesAtEntry.some(([key, raw]) => key === saved.key && raw === saved.raw), 'the exact pending record must be written before POST')
  assert.equal(saved.raw.includes('fixture-token'), false, 'pending storage must never copy the bearer token')
}
function savedOperations(world) {
  return Object.entries(world.env.session.snapshot()).map(([key, raw]) => ({ key, value: JSON.parse(raw) }))
}
function savedAction(world, action = 'advance') {
  const saved = savedOperations(world).find(({ value }) => value.action === action && JSON.parse(value.scope)[0][1] === 'user-a')
  assert.ok(saved, `the original ${action} operation must remain in session storage`)
  return saved
}
function visibleText(node) { return [node.text || '', ...(node.children || []).map(visibleText)].join(' ') }
function freshConfirmation(world, character = '8') {
  world.handlers.getExecutionRunReadiness = async (_v, _r, output) => ({ ...readiness(world.fixture, output), confirmation_hash: digest(character) })
}
function queuedOwnerABA(env, dimension) {
  const key = dimension === 'user' ? 'moli_mama_session' : 'moli_mama_tenant_id', oldValue = env.local.getItem(key)
  if (dimension === 'user') {
    env.auth.saveSession({ token: 'fixture-token-b', user: { id: 'user-b' } }); env.auth.saveCurrentTenantId('tenant-a')
  } else env.auth.saveCurrentTenantId('tenant-b')
  const otherValue = env.local.getItem(key)
  env.auth.saveSession({ token: 'fixture-token', user: { id: 'user-a' } }); env.auth.saveCurrentTenantId('tenant-a')
  assert.equal(env.local.getItem(key), oldValue, 'underlying storage must already be A before queued B/A delivery')
  env.window.dispatch('storage', { key, oldValue, newValue: otherValue, storageArea: env.local })
  env.window.dispatch('storage', { key, oldValue: otherValue, newValue: oldValue, storageArea: env.local })
}
function twoUnitWorld(t) {
  const world = scenario(t), second = { ...structuredClone(world.fixture.preview.units[0]), id: 'unit-2', source_start_ms: 5000, source_end_ms: 10000 }
  world.fixture.preview.units.push(second)
  world.fixture.savedReview.plan = structuredClone(world.fixture.preview)
  world.fixture.queue.units.push({ id: second.id, ordinal: 1, status: 'pending', unit_hash: hash(second), plan_unit: second })
  world.server = run(world.fixture)
  world.server.units.push({ id: second.id, ordinal: 1, unit_hash: hash(second), status: 'pending', attempts: [] })
  world.handlers.listExecutionRuns = async () => ({ version_id: 10, current_run_id: 20, runs: [structuredClone(world.server)] })
  world.handlers.getExecutionRun = async () => structuredClone(world.server)
  world.handlers.getExecutionRunReadiness = async (_v, _r, output) => ({ ...readiness(world.fixture, output), run_revision: world.server.revision,
    unit_id: world.server.units[0].status === 'approved' ? 'unit-2' : 'unit-1',
    quote_hash: world.server.units[0].status === 'approved' ? digest('8') : digest('6'),
    confirmation_hash: world.server.units[0].status === 'approved' ? digest('9') : digest('7') })
  return world
}
async function unknownFirstUnit(world, h, outcome = 'safe') {
  world.handlers.advanceExecutionRun = async () => { if (outcome === 'reject') throw Error('fixture original response lost'); return safeReceipt() }
  await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true); await h.invoke('advanceRun')
  assert.equal(posts(world).length, 1); assert.equal(savedAction(world).value.status, 'unknown')
  world.server = { ...world.server, status: 'needs_attention', revision: 4, output_parameters: { resolution: '720p', aspect_ratio: '16:9' } }
  world.server.units[0].status = 'needs_attention'
  world.server.units[0].attempts = [{ id: 30, attempt_no: 1, status: 'needs_attention', created_at: 'created', updated_at: 'updated' }]
  await h.invoke('refreshRuns'); await h.invoke('selectRun', 20)
  assert.equal(h.state.currentRun, true); assert.equal(h.state.canRecover(30), true)
}
function recoveredReceipt() {
  return { run_id: 20, run_revision: 6, attempt_id: 30, task_id: safeReceipt().task_id, status: 'waiting_review',
    provider_task_id: safeReceipt().provider_task_id, newly_submitted: false, receipt_persisted: true, executable: false,
    output_asset_id: 50, output_sha256: digest('b'), candidate_hash: digest('c') }
}
function approveFirstUnit(world) {
  // Only a fake backend transition; this suite does not perform or attest human/content review.
  world.server = { ...world.server, status: 'ready', revision: 7 }
  world.server.units[0].status = 'approved'; world.server.units[0].attempts.at(-1).status = 'approved'
}
function pausedWorld(t, phase) {
  const world = scenario(t), output = { resolution: '720p', aspect_ratio: '16:9' }
  world.server = { ...run(world.fixture), revision: 6, status: phase === 'idle' ? 'paused' : 'running', pause_requested: true }
  if (phase !== 'idle') {
    world.server.output_parameters = output; world.server.units[0].status = 'claimed'
    world.server.units[0].attempts = [{ id: 30, attempt_no: 1, status: 'claimed', created_at: 'created', updated_at: 'updated' }]
  }
  world.handlers.listExecutionRuns = async () => ({ version_id: 10, current_run_id: 20, runs: [structuredClone(world.server)] })
  world.handlers.getExecutionRun = async () => structuredClone(world.server)
  world.handlers.getExecutionRunReadiness = async (_v, _r, chosen) => ({ ...readiness(world.fixture, chosen), phase,
    run_revision: world.server.revision, action: world.server.pause_requested ? 'resume' : 'advance',
    attempt_id: phase === 'idle' ? null : world.server.units[0].attempts.at(-1).id,
    confirmation_hash: world.server.pause_requested ? digest('8') : digest('9') })
  world.handlers.resumeExecutionRun = async () => {
    world.server = { ...world.server, revision: 7, pause_requested: false, status: phase === 'idle' ? 'ready' : 'running' }
    throw Error('fixture resume completed but response lost')
  }
  return world
}
async function unknownResume(world, h) {
  await prepare(h, 'advance'); assert.equal(h.state.canResume, true); assert.equal(h.state.canAdvance, false)
  await h.invoke('resumeRun'); assert.equal(posts(world).length, 1); assert.equal(savedAction(world, 'resume').value.status, 'unknown')
}

test('bootstrap uses one evaluated module and real Vue mount/unmount with fake auth storage and no API', async t => {
  const world = scenario(t), module = world.evaluate(), first = world.mount(module), second = world.mount(module)
  assert.notEqual(first.instance, second.instance); assert.equal(first.instance.type, second.instance.type)
  assert.equal(world.env.auth.readSession().user.id, 'user-a'); assert.equal(world.env.auth.readCurrentTenantId(), 'tenant-a')
  assert.equal(world.calls.length, 0)
  first.dispose(); await tick(); assert.equal(first.instance.isUnmounted, true); assert.equal(second.instance.isUnmounted, false)
  assert.notEqual(world.evaluate(), module, 'a reload must evaluate a fresh module, not merely remount an old one')
})

test('create and advance persist scoped pending intent before the sole API entry', async t => {
  for (const action of ['create', 'advance']) {
    const world = scenario(t, { action }), h = world.mount(world.evaluate())
    await prepare(h, action)
    assert.equal(h.state[action === 'create' ? 'canCreate' : 'canAdvance'], true, `${action} must reach the enabled action before submission`)
    await h.invoke(action === 'create' ? 'createRun' : 'advanceRun')
    assert.equal(posts(world).length, 1); assertDurableIntent(posts(world)[0], action)
  }
})

test('unavailable, unreadable or unwritable session storage fails closed with zero create/advance POSTs', async t => {
  for (const action of ['create', 'advance']) for (const fault of ['missing', 'read', 'write']) {
    const session = fault === 'missing' ? undefined : storage()
    if (session) session.fault = fault
    const world = scenario(t, { action, session: session ?? null }), h = world.mount(world.evaluate())
    await prepare(h, action)
    await h.invoke(action === 'create' ? 'createRun' : 'advanceRun')
    assert.equal(posts(world).length, 0, `${action}/${fault}: storage failure must block POST`)
    assert.equal(h.state[action === 'create' ? 'canCreate' : 'canAdvance'], false)
  }
})

test('two real Vue instances from the same module and storage submit advance only once', async t => {
  const world = scenario(t), module = world.evaluate(), first = world.mount(module), second = world.mount(module), wait = world.deferred()
  world.handlers.advanceExecutionRun = () => wait.promise
  await prepare(first, 'advance'); await prepare(second, 'advance')
  assert.equal(first.state.canAdvance, true); assert.equal(second.state.canAdvance, true)
  const original = first.invoke('advanceRun'); await tick()
  assert.equal(posts(world).length, 1, 'the first POST must actually enter before testing duplicate prevention')
  const duplicate = second.invoke('advanceRun'); await tick()
  assert.equal(posts(world).length, 1)
  wait.resolve(receipt()); await Promise.all([original, duplicate])
  assert.equal(posts(world).length, 1)
})

test('two real Vue instances from the same module and storage create only once', async t => {
  const world = scenario(t, { action: 'create' }), module = world.evaluate(), first = world.mount(module), second = world.mount(module), wait = world.deferred()
  world.handlers.createExecutionRun = () => wait.promise
  await prepare(first, 'create'); await prepare(second, 'create')
  assert.equal(first.state.canCreate, true); assert.equal(second.state.canCreate, true)
  const original = first.invoke('createRun'); await tick()
  assert.equal(posts(world).length, 1); assertDurableIntent(posts(world)[0], 'create')
  const duplicate = second.invoke('createRun'); await tick(); assert.equal(posts(world).length, 1)
  wait.resolve(run(world.fixture)); await Promise.all([original, duplicate]); assert.equal(posts(world).length, 1)
})

for (const action of ['create', 'advance']) test(`${action} pending survives props ABA and actual unmount/remount`, async t => {
  const world = scenario(t, { action }), module = world.evaluate(), h = world.mount(module), wait = world.deferred()
  const method = action === 'create' ? 'createRun' : 'advanceRun', api = action === 'create' ? 'createExecutionRun' : 'advanceExecutionRun'
  world.handlers[api] = () => wait.promise
  await prepare(h, action); assert.equal(h.state[action === 'create' ? 'canCreate' : 'canAdvance'], true)
  const original = h.invoke(method); await tick(); assert.equal(posts(world).length, 1)
  h.props.record.version_id = 11; h.props.record.version_id = 10; await tick()
  freshConfirmation(world)
  await prepare(h, action); const afterABA = h.invoke(method); await tick()
  assert.equal(posts(world).length, 1, 'props ABA and new confirmation must not release the original pending POST')
  h.dispose(); await tick(); assert.equal(h.instance.isUnmounted, true)
  const remounted = world.mount(module), before = world.calls.length
  await tick(); assert.equal(world.calls.length, before, 'mount must not call an API')
  await prepare(remounted, action); const afterRemount = remounted.invoke(method); await tick(); assert.equal(posts(world).length, 1)
  wait.resolve(action === 'create' ? run(world.fixture) : receipt()); await Promise.all([original, afterABA, afterRemount])
  assert.equal(posts(world).length, 1)
})

for (const action of ['create', 'advance']) for (const outcome of ['pending', 'unknown']) {
  test(`${action} ${outcome} survives fresh module evaluation and stale explicit GETs`, async t => {
    const world = scenario(t, { action }), firstModule = world.evaluate(), first = world.mount(firstModule), wait = world.deferred()
    const method = action === 'create' ? 'createRun' : 'advanceRun', api = action === 'create' ? 'createExecutionRun' : 'advanceExecutionRun'
    world.handlers[api] = () => wait.promise
    await prepare(first, action); assert.equal(first.state[action === 'create' ? 'canCreate' : 'canAdvance'], true)
    const original = first.invoke(method); await tick(); assert.equal(posts(world).length, 1)
    if (outcome === 'unknown') { wait.reject(Error('fixture response lost')); await original }
    first.dispose(); await tick(); const before = world.calls.length, newModule = world.evaluate(), reloaded = world.mount(newModule)
    assert.notEqual(newModule, firstModule); await tick(); assert.equal(world.calls.length, before, 'reload must not discover or recover automatically')
    const originalSlot = savedAction(world, action)
    assert.equal(originalSlot.value.status, outcome)
    freshConfirmation(world)
    await prepare(reloaded, action); const duplicate = reloaded.invoke(method); await tick()
    assert.equal(posts(world).length, 1, 'a different confirmation hash and old DTO must not unlock an unresolved operation')
    assert.deepEqual(savedAction(world, action), originalSlot, 'read-only refresh must not delete or rewrite the operation')
    if (outcome === 'pending') wait.resolve(action === 'create' ? run(world.fixture) : receipt())
    await Promise.all([original, duplicate])
  })
}

for (const action of ['create', 'advance']) for (const outcome of ['reject', 'no_response', 'transport_timeout']) test(`${action}/${outcome} remains unknown without automatic calls or resubmission`, async t => {
  const world = scenario(t, { action }), h = world.mount(world.evaluate()), wait = world.deferred()
  const method = action === 'create' ? 'createRun' : 'advanceRun', api = action === 'create' ? 'createExecutionRun' : 'advanceExecutionRun'
  world.handlers[api] = () => wait.promise
  await prepare(h, action); assert.equal(h.state[action === 'create' ? 'canCreate' : 'canAdvance'], true)
  const original = h.invoke(method); await tick(); assert.equal(posts(world).length, 1)
  const atEntry = world.calls.length
  if (outcome === 'no_response') wait.resolve(undefined)
  else wait.reject(Object.assign(Error('fixture transport response unavailable'), { code: outcome === 'transport_timeout' ? 'ECONNABORTED' : 'ERR_NETWORK' }))
  await original; await tick()
  assert.equal(world.calls.length, atEntry, 'a rejected or missing response must not trigger GET, recover or POST')
  assert.equal(savedAction(world, action).value.status, 'unknown'); assert.ok(h.state.error)
  freshConfirmation(world); await prepare(h, action); await h.invoke(method)
  assert.equal(posts(world).length, 1); assert.equal(h.state[action === 'create' ? 'canCreate' : 'canAdvance'], false)
})

test('sparse unique safe receipt survives both persistence failures, failed GET, stale DTO and fresh module', async t => {
  const world = scenario(t), h = world.mount(world.evaluate()), value = safeReceipt()
  assert.equal('run_revision' in value, false); assert.equal('units' in value, false)
  assert.equal(value.receipt_persisted, false); assert.equal(value.fallback_receipt_persisted, false)
  world.handlers.advanceExecutionRun = async () => value
  await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true); await h.invoke('advanceRun'); await tick()
  assert.equal(posts(world).length, 1); assert.deepEqual(h.state.submissionReceipt, value)
  const original = savedAction(world)
  assert.equal(original.value.status, 'unknown'); assert.deepEqual(original.value.receipt, value)
  assert.match(visibleText(h.root), /unique-provider-receipt/)
  world.handlers.getExecutionRun = async () => { throw { success: false, error: { code: 'EXECUTION_RUN_NOT_FOUND', message: 'fixture unavailable' }, timestamp: 'fixture' } }
  await h.invoke('selectRun', 20)
  assert.deepEqual(savedAction(world), original); assert.deepEqual(h.state.submissionReceipt, value)
  world.handlers.getExecutionRun = async () => run(world.fixture)
  await prepare(h, 'advance'); assert.deepEqual(h.state.submissionReceipt, value); assert.deepEqual(savedAction(world), original)
  h.dispose(); await tick(); const before = world.calls.length, reloaded = world.mount(world.evaluate())
  await tick(); assert.equal(world.calls.length, before)
  await prepare(reloaded, 'advance'); await tick()
  assert.deepEqual(reloaded.state.submissionReceipt, value); assert.match(visibleText(reloaded.root), /unique-provider-receipt/)
  await reloaded.invoke('advanceRun'); assert.equal(posts(world).length, 1)
})

test('late owner A receipt is written to its original slot, hidden from B, and restored for A in a new module', async t => {
  const world = scenario(t), h = world.mount(world.evaluate()), wait = world.deferred(), value = safeReceipt()
  world.handlers.advanceExecutionRun = () => wait.promise
  await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true)
  const original = h.invoke('advanceRun'); await tick(); assert.equal(posts(world).length, 1)
  const slot = savedAction(world), before = world.calls.length, other = structuredClone(world.fixture)
  const otherScope = JSON.parse(slot.value.scope); otherScope[0] = ['tenant-b', 'user-b']
  const otherKey = slot.key.replaceAll('tenant-a', 'tenant-b').replaceAll('user-a', 'user-b')
  assert.notEqual(otherKey, slot.key)
  const otherTaskId = '54d93506-4467-4e02-9d43-6da366c37c1d'
  const otherReceipt = { ...safeReceipt(), task_id: otherTaskId, provider_task_id: 'owner-b-sentinel', recovery_receipt: {
    ...safeReceipt().recovery_receipt, tenant_id: 'tenant-b', user_id: 'user-b', task_id: otherTaskId, request_hash: digest('b'), provider_task_id: 'owner-b-sentinel' } }
  world.env.session.setItem(otherKey, JSON.stringify({ ...slot.value, scope: JSON.stringify(otherScope), status: 'unknown', receipt: otherReceipt }))
  other.preview.bindings.user_id = 'user-b'; other.preview.bindings.tenant_id = 'tenant-b'; other.savedReview.plan = structuredClone(other.preview)
  world.env.auth.saveSession({ token: 'fixture-token-b', user: { id: 'user-b' } }); world.env.auth.saveCurrentTenantId('tenant-b')
  Object.assign(h.props, other); world.env.window.dispatch('focus', {}); await tick()
  assert.equal(world.calls.length, before); assert.notEqual(h.state.submissionReceipt?.provider_task_id, value.provider_task_id)
  const slotsBefore = savedOperations(world).filter(item => item.key !== slot.key)
  wait.resolve(value); await original; await tick()
  const saved = savedAction(world)
  assert.equal(saved.key, slot.key); assert.deepEqual(saved.value.receipt, value); assert.equal(saved.value.status, 'unknown')
  assert.deepEqual(savedOperations(world).filter(item => item.key !== slot.key), slotsBefore, 'late A must not create or overwrite a B slot')
  assert.deepEqual(savedOperations(world).find(item => item.key === otherKey)?.value.receipt, otherReceipt)
  assert.notEqual(h.state.submissionReceipt?.provider_task_id, value.provider_task_id); assert.doesNotMatch(visibleText(h.root), /unique-provider-receipt/)
  h.dispose(); await tick()
  world.env.auth.saveSession({ token: 'fixture-token', user: { id: 'user-a' } }); world.env.auth.saveCurrentTenantId('tenant-a')
  const reloaded = world.mount(world.evaluate()); await prepare(reloaded, 'advance'); await tick()
  assert.deepEqual(reloaded.state.submissionReceipt, value); assert.match(visibleText(reloaded.root), /unique-provider-receipt/)
  await reloaded.invoke('advanceRun'); assert.equal(posts(world).length, 1)
})

for (const dimension of ['user', 'tenant']) {
  test(`queued ${dimension} storage ABA revokes an already enabled confirmation even though reads return A`, async t => {
    const world = scenario(t), h = world.mount(world.evaluate())
    await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true); assert.ok(h.state.confirmation)
    queuedOwnerABA(world.env, dimension); await tick()
    assert.equal(h.state.confirmation, null); assert.equal(h.state.canAdvance, false)
    await h.invoke('advanceRun'); assert.equal(posts(world).length, 0)
  })
  test(`queued ${dimension} storage ABA aborts and rejects a late readiness GET`, async t => {
    const world = scenario(t), h = world.mount(world.evaluate()), wait = world.deferred()
    await h.invoke('refreshRuns'); await h.invoke('selectRun', 20)
    h.state.selectedResolution = '720p'; h.state.selectedAspectRatio = '16:9'
    assert.equal(h.state.canReadiness, true); world.handlers.getExecutionRunReadiness = () => wait.promise
    const read = h.invoke('loadReadiness'); await tick()
    const entry = world.calls.find(call => call.name === 'getExecutionRunReadiness'); assert.ok(entry, 'the GET must actually enter before the owner event')
    queuedOwnerABA(world.env, dimension)
    wait.resolve(readiness(world.fixture, { resolution: '720p', aspect_ratio: '16:9' })); await read; await tick()
    assert.equal(entry.args[3].signal.aborted, true); assert.equal(h.state.readiness, null); assert.equal(h.state.confirmation, null)
    await h.invoke('confirmAction'); await h.invoke('advanceRun'); assert.equal(posts(world).length, 0)
  })
}

test('focus rechecks the actual owner and revokes an old confirmation without any API', async t => {
  const world = scenario(t), h = world.mount(world.evaluate())
  await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true)
  const before = world.calls.length
  world.env.auth.saveCurrentTenantId('tenant-b'); world.env.window.dispatch('focus', {}); await tick()
  assert.equal(h.state.confirmation, null); assert.equal(world.calls.length, before)
  await h.invoke('advanceRun'); assert.equal(posts(world).length, 0)
})

test('same-owner token refresh retains pending across reload and retains the eventual original receipt', async t => {
  const world = scenario(t), h = world.mount(world.evaluate()), wait = world.deferred()
  world.handlers.advanceExecutionRun = () => wait.promise
  await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true)
  const original = h.invoke('advanceRun'); await tick(); assert.equal(posts(world).length, 1)
  const key = 'moli_mama_session', oldValue = world.env.local.getItem(key), slot = savedAction(world)
  world.env.auth.saveSession({ token: 'refreshed-fixture-token', user: { id: 'user-a' } })
  world.env.window.dispatch('storage', { key, oldValue, newValue: world.env.local.getItem(key), storageArea: world.env.local }); await tick()
  assert.deepEqual(savedAction(world), slot)
  const reloaded = world.mount(world.evaluate()); freshConfirmation(world); await prepare(reloaded, 'advance')
  const duplicate = reloaded.invoke('advanceRun'); await tick()
  assert.equal(posts(world).length, 1, 'token refresh and a new confirmation cannot release pending')
  wait.resolve(safeReceipt()); await Promise.all([original, duplicate]); await tick()
  assert.deepEqual(h.state.submissionReceipt, safeReceipt()); assert.deepEqual(savedAction(world).value.receipt, safeReceipt())
  assert.equal(JSON.stringify(world.env.session.snapshot()).includes('refreshed-fixture-token'), false)
})

for (const action of ['create', 'advance']) for (const fault of ['readback_throw', 'readback_mismatch']) {
  test(`${action} write success followed by ${fault} blocks POST`, async t => {
    const session = storage(), world = scenario(t, { action, session }), h = world.mount(world.evaluate())
    await prepare(h, action); assert.equal(h.state[action === 'create' ? 'canCreate' : 'canAdvance'], true)
    session.fault = fault
    await h.invoke(action === 'create' ? 'createRun' : 'advanceRun')
    assert.equal(session.writes.length, 1, 'the write must actually succeed before its readback fails')
    assert.equal(savedAction(world, action).value.status, 'pending')
    assert.equal(posts(world).length, 0); assert.equal(h.state[action === 'create' ? 'canCreate' : 'canAdvance'], false)
    assert.ok(h.state.error)
  })
}

for (const phase of ['idle', 'claimed_unbound', 'claimed_bound']) {
  test(`${phase}: pause is CAS only, resume consumes its own confirmation, advance needs a new revision and confirmation`, async t => {
    const world = scenario(t), h = world.mount(world.evaluate()), output = { resolution: '720p', aspect_ratio: '16:9' }
    let server = { ...run(world.fixture), revision: 5, status: phase === 'idle' ? 'ready' : 'running' }
    if (phase !== 'idle') {
      server.output_parameters = output
      server.units[0].status = 'claimed'
      server.units[0].attempts = [{ id: 30, attempt_no: 1, status: 'claimed', created_at: 'created', updated_at: 'updated' }]
    }
    const nextReady = () => ({ ...readiness(world.fixture, output), phase, run_revision: server.revision,
      action: server.pause_requested ? 'resume' : 'advance', attempt_id: phase === 'idle' ? null : 30,
      confirmation_hash: digest(server.pause_requested ? '8' : server.revision === 5 ? '7' : '9') })
    world.handlers.listExecutionRuns = async () => ({ version_id: 10, current_run_id: 20, runs: [structuredClone(server)] })
    world.handlers.getExecutionRun = async () => structuredClone(server)
    world.handlers.getExecutionRunReadiness = async () => nextReady()
    world.handlers.pauseExecutionRun = async () => {
      server = { ...server, pause_requested: true, revision: 6, status: phase === 'idle' ? 'paused' : 'running' }
      return structuredClone(server)
    }
    world.handlers.resumeExecutionRun = async () => {
      server = { ...server, pause_requested: false, revision: 7, status: phase === 'idle' ? 'ready' : 'running' }
      return { run_id: 20, run_revision: 7, run_status: server.status, pause_requested: false, attempt_id: phase === 'idle' ? null : 30,
        attempt_status: phase === 'idle' ? null : 'claimed', amount: phase === 'idle' ? null : 12,
        billing_mode: phase === 'idle' ? null : 'paid', changed: true, executable: false }
    }
    const finalRevision = phase === 'idle' ? 11 : phase === 'claimed_unbound' ? 10 : 9
    world.handlers.advanceExecutionRun = async () => ({ ...receipt(), run_revision: finalRevision })
    await h.invoke('refreshRuns'); await h.invoke('selectRun', 20); assert.equal(h.state.currentRun, true)
    h.state.selectedResolution = output.resolution; h.state.selectedAspectRatio = output.aspect_ratio
    await h.invoke('loadReadiness'); await h.invoke('confirmAction')
    const beforePause = world.calls.length
    await h.invoke('pauseRun'); await tick()
    assert.deepEqual(posts(world).map(call => call.name), ['pauseExecutionRun'])
    assert.deepEqual(posts(world)[0].args, [10, 20, { expected_revision: 5 }])
    assert.equal(world.calls.length, beforePause + 1, 'pause must not automatically read, resume or generate')
    assert.equal(h.state.run.revision, 6); assert.equal(h.state.run.pause_requested, true); assert.equal(h.state.confirmation, null)
    await h.invoke('advanceRun'); await h.invoke('resumeRun'); assert.equal(posts(world).length, 1)
    await h.invoke('loadReadiness'); assert.equal(h.state.readiness.action, 'resume'); assert.equal(h.state.readiness.run_revision, 6)
    await h.invoke('resumeRun'); assert.equal(posts(world).length, 1, 'readiness alone is not a new cost confirmation')
    await h.invoke('confirmAction'); assert.equal(h.state.canResume, true); assert.equal(h.state.canAdvance, false)
    await h.invoke('advanceRun'); assert.equal(posts(world).length, 1, 'resume confirmation cannot authorize advance')
    const beforeResume = world.calls.length
    await h.invoke('resumeRun'); await tick()
    assert.deepEqual(posts(world).map(call => call.name), ['pauseExecutionRun', 'resumeExecutionRun'])
    assert.deepEqual(posts(world)[1].args, [10, 20, { expected_revision: 6, expected_plan_hash: digest('a'), expected_quote_hash: digest('6'),
      expected_confirmation_hash: digest('8'), output_parameters: output }])
    assert.equal(world.calls.length, beforeResume + 1, 'resume must not automatically refresh or generate')
    assert.equal(h.state.run.revision, 7); assert.equal(h.state.run.pause_requested, false); assert.equal(h.state.confirmation, null)
    await h.invoke('advanceRun'); assert.equal(posts(world).length, 2)
    await h.invoke('loadReadiness'); assert.equal(h.state.readiness.action, 'advance'); assert.equal(h.state.readiness.run_revision, 7)
    await h.invoke('advanceRun'); assert.equal(posts(world).length, 2, 'new readiness still needs its own explicit confirmation')
    await h.invoke('confirmAction'); assert.equal(h.state.canAdvance, true)
    await h.invoke('advanceRun')
    assert.deepEqual(posts(world).map(call => call.name), ['pauseExecutionRun', 'resumeExecutionRun', 'advanceExecutionRun'])
    assert.deepEqual(posts(world)[2].args, [10, 20, { expected_revision: 7, expected_plan_hash: digest('a'), expected_quote_hash: digest('6'),
      expected_confirmation_hash: digest('9'), output_parameters: output }])
    assert.equal(h.state.submissionReceipt.run_revision, finalRevision)
  })
}

for (const invalid of [
  { name: 'unknown phase', phase: 'other', attempt_id: null },
  { name: 'idle with an attempt', phase: 'idle', attempt_id: 30 },
  { name: 'claimed_unbound without attempt', phase: 'claimed_unbound', attempt_id: null },
  { name: 'claimed_bound without attempt', phase: 'claimed_bound', attempt_id: null },
  { name: 'claimed_unbound wrong original attempt', phase: 'claimed_unbound', attempt_id: 31 },
  { name: 'claimed_bound wrong original attempt', phase: 'claimed_bound', attempt_id: 31 },
  { name: 'needs_attention run', phase: 'idle', attempt_id: null, status: 'needs_attention' },
]) test(`${invalid.name} cannot authorize advance`, async t => {
  const world = scenario(t), h = world.mount(world.evaluate())
  await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true, 'normal DTO must enable the baseline before mismatch injection')
  const server = run(world.fixture)
  if (invalid.phase.startsWith('claimed')) {
    server.status = 'running'; server.units[0].status = 'claimed'
    server.units[0].attempts = [{ id: 30, attempt_no: 1, status: 'claimed', created_at: 'created', updated_at: 'updated' }]
  }
  if (invalid.status) {
    server.status = invalid.status; server.units[0].status = invalid.status
    server.units[0].attempts = [{ id: 30, attempt_no: 1, status: invalid.status, created_at: 'created', updated_at: 'updated' }]
  }
  if (server.units[0].attempts.length) server.output_parameters = { resolution: '720p', aspect_ratio: '16:9' }
  world.handlers.getExecutionRun = async () => structuredClone(server)
  await h.invoke('selectRun', 20); assert.equal(h.state.confirmation, null)
  assert.equal(h.state.currentRun, true, 'the real detail DTO must still bind before injecting the invalid readiness')
  assert.equal(h.state.canReadiness, true, 'an unrelated detail or parameter failure must not make this negative case pass')
  world.handlers.getExecutionRunReadiness = async (_v, _r, output) => ({ ...readiness(world.fixture, output), phase: invalid.phase, attempt_id: invalid.attempt_id })
  await h.invoke('loadReadiness'); await h.invoke('confirmAction'); await h.invoke('advanceRun')
  assert.equal(posts(world).length, 0); assert.equal(h.state.canAdvance, false); assert.equal(h.state.confirmation, null)
})

for (const recoverOutcome of ['unpersisted_receipt', 'reject']) test(`unknown generation permits explicit recover again after ${recoverOutcome}, with independent in-flight double-click protection`, async t => {
  const world = scenario(t), h = world.mount(world.evaluate()), wait = world.deferred()
  world.handlers.advanceExecutionRun = async () => { throw Error('fixture response lost after submission') }
  await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true); await h.invoke('advanceRun')
  assert.deepEqual(posts(world).map(call => call.name), ['advanceExecutionRun'])
  const server = { ...run(world.fixture), status: 'needs_attention', revision: 4, output_parameters: { resolution: '720p', aspect_ratio: '16:9' } }
  server.units[0].status = 'needs_attention'
  server.units[0].attempts = [{ id: 30, attempt_no: 1, status: 'needs_attention', created_at: 'created', updated_at: 'updated' }]
  assert.equal(JSON.stringify(server.units[0].attempts).includes('provider_task_id'), false)
  assert.equal(JSON.stringify(server.units[0].attempts).includes('task_id'), false)
  world.handlers.getExecutionRun = async () => structuredClone(server)
  world.handlers.recoverExecutionUnitTask = () => wait.promise
  const before = world.calls.length
  await tick(); assert.equal(world.calls.length, before, 'unknown must not automatically query or recover')
  await h.invoke('refreshRuns'); await h.invoke('selectRun', 20)
  assert.equal(posts(world).length, 1, 'explicit GET alone cannot recover')
  const invalidAttempt = h.invoke('recoverAttempt', 31); await tick()
  assert.equal(posts(world).length, 1, 'an ID absent from the real run must not be guessed')
  const recovery = h.invoke('recoverAttempt', 30); await tick()
  const recoverCalls = () => world.calls.filter(call => call.name === 'recoverExecutionUnitTask')
  assert.equal(recoverCalls().length, 1, 'recover must actually enter despite the unknown generation lock')
  assert.deepEqual(recoverCalls()[0].args, [10, 20, { attempt_id: 30 }])
  const duplicate = h.invoke('recoverAttempt', 30); await tick(); assert.equal(recoverCalls().length, 1)
  const recovered = safeReceipt(false)
  assert.equal(recovered.newly_submitted, false); assert.equal('attempt_status' in recovered, false); assert.equal('changed' in recovered, false)
  const beforeSettle = world.calls.length
  if (recoverOutcome === 'reject') wait.reject(Error('fixture recover response lost'))
  else wait.resolve(recovered)
  await Promise.all([invalidAttempt, recovery, duplicate]); await tick()
  assert.equal(recoverCalls().length, 1); assert.equal(world.calls.length, beforeSettle, 'settling recover must not automatically query again')
  if (recoverOutcome === 'unpersisted_receipt') assert.deepEqual(h.state.submissionReceipt, recovered)
  else assert.ok(h.state.error)
  const next = world.deferred(); world.handlers.recoverExecutionUnitTask = () => next.promise
  const repeated = h.invoke('recoverAttempt', 30); await tick()
  assert.equal(recoverCalls().length, 2, 'a settled recover must not permanently lock out explicit reconciliation of the same original attempt')
  assert.deepEqual(recoverCalls()[1].args, [10, 20, { attempt_id: 30 }])
  const repeatedDuplicate = h.invoke('recoverAttempt', 30); await tick(); assert.equal(recoverCalls().length, 2)
  next.resolve(recovered); await Promise.all([repeated, repeatedDuplicate]); await tick()
  assert.equal(recoverCalls().length, 2); assert.deepEqual(h.state.submissionReceipt, recovered)
  assert.match(visibleText(h.root), /unique-provider-receipt/)
  assert.ok(savedOperations(world).some(({ value }) => value.receipt?.provider_task_id === 'unique-provider-receipt'))
  freshConfirmation(world); await h.invoke('loadReadiness'); await h.invoke('confirmAction'); await h.invoke('advanceRun')
  assert.deepEqual(posts(world).map(call => call.name), ['advanceExecutionRun', 'recoverExecutionUnitTask', 'recoverExecutionUnitTask'])
})

test('no original attempt means zero recover POSTs, including after an unknown submission and fresh module', async t => {
  const world = scenario(t), h = world.mount(world.evaluate())
  world.handlers.advanceExecutionRun = async () => { throw Error('fixture response lost') }
  await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true); await h.invoke('advanceRun')
  assert.equal(posts(world).length, 1); h.dispose(); await tick()
  const reloaded = world.mount(world.evaluate())
  await reloaded.invoke('refreshRuns'); await reloaded.invoke('selectRun', 20)
  assert.deepEqual(reloaded.state.run.units[0].attempts, [])
  await reloaded.invoke('recoverAttempt', null); await reloaded.invoke('recoverAttempt', 30)
  assert.equal(world.calls.filter(call => call.name === 'recoverExecutionUnitTask').length, 0)
  assert.equal(posts(world).length, 1)
})

for (const outcome of ['safe', 'reject']) for (const reload of [false, true]) test(`successful explicit recover resolves only unit1's ${outcome} intent and permits confirmed unit2${reload ? ' after reload' : ''}`, async t => {
  const world = twoUnitWorld(t); let h = world.mount(world.evaluate())
  await unknownFirstUnit(world, h, outcome)
  const original = savedAction(world), before = world.calls.length
  world.handlers.recoverExecutionUnitTask = async () => recoveredReceipt()
  await h.invoke('recoverAttempt', 30); await tick()
  assert.equal(world.calls.length, before + 1); assert.equal(posts(world).filter(call => call.name === 'advanceExecutionRun').length, 1)
  const resolved = savedAction(world)
  assert.equal(resolved.key, original.key); assert.equal(resolved.value.hash, digest('7'))
  assert.equal(resolved.value.status, 'received', 'authoritative explicit original-attempt recovery must resolve the original advance intent')
  assert.equal(resolved.value.receipt.attempt_id, 30); assert.equal(resolved.value.receipt.task_id, recoveredReceipt().task_id)
  if (outcome === 'safe') assert.deepEqual(resolved.value.receipt.recovery_receipt, safeReceipt().recovery_receipt)
  await h.invoke('advanceRun'); assert.equal(posts(world).length, 2, 'recover alone must not advance the next unit')
  if (reload) { h.dispose(); await tick(); const calls = world.calls.length; h = world.mount(world.evaluate()); await tick(); assert.equal(world.calls.length, calls) }
  approveFirstUnit(world)
  await h.invoke('refreshRuns'); await h.invoke('selectRun', 20)
  h.state.selectedResolution = '720p'; h.state.selectedAspectRatio = '16:9'
  const nextReady = world.handlers.getExecutionRunReadiness
  world.handlers.getExecutionRunReadiness = async (...args) => ({ ...await nextReady(...args), confirmation_hash: digest('7') })
  await h.invoke('loadReadiness'); await h.invoke('confirmAction'); await h.invoke('advanceRun')
  assert.equal(posts(world).length, 2, 'the consumed original hash must remain non-replayable')
  world.handlers.getExecutionRunReadiness = nextReady
  await h.invoke('loadReadiness'); assert.equal(h.state.readiness.unit_id, 'unit-2'); assert.equal(h.state.canAdvance, false)
  await h.invoke('advanceRun'); assert.equal(posts(world).length, 2)
  await h.invoke('confirmAction'); assert.equal(h.state.canAdvance, true)
  world.handlers.advanceExecutionRun = async () => ({ ...receipt(), run_revision: 11, attempt_id: 31, task_id: 'second-task', provider_task_id: 'second-provider' })
  await h.invoke('advanceRun')
  const advances = posts(world).filter(call => call.name === 'advanceExecutionRun')
  assert.equal(advances.length, 2); assert.equal(advances[1].args[2].expected_revision, 7); assert.equal(advances[1].args[2].expected_confirmation_hash, digest('9'))
})

for (const fault of ['unpersisted', 'needs_attention', 'wrong_attempt', 'missing_task', 'different_unit', 'ambiguous_attempts', 'missing_attempt']) {
  test(`${fault} is insufficient proof to resolve an unknown original advance`, async t => {
    const world = twoUnitWorld(t), h = world.mount(world.evaluate())
    await unknownFirstUnit(world, h)
    if (fault === 'different_unit') {
      world.server.units[1].attempts = world.server.units[0].attempts; world.server.units[1].status = 'needs_attention'
      world.server.units[0].attempts = []; world.server.units[0].status = 'pending'
    }
    if (fault === 'ambiguous_attempts') world.server.units[0].attempts.unshift({ id: 29, attempt_no: 1, status: 'failed', created_at: 'old', updated_at: 'old' })
    if (fault === 'ambiguous_attempts') world.server.units[0].attempts.at(-1).attempt_no = 2
    if (fault === 'missing_attempt') { world.server.units[0].attempts = []; world.server.units[0].status = 'pending'; world.server.output_parameters = null }
    await h.invoke('selectRun', 20); assert.equal(h.state.currentRun, true)
    const value = fault === 'unpersisted' ? safeReceipt(false) : recoveredReceipt()
    if (fault === 'needs_attention') value.status = 'needs_attention'
    if (fault === 'wrong_attempt') value.attempt_id = 31
    if (fault === 'missing_task') delete value.task_id
    world.handlers.recoverExecutionUnitTask = async () => value
    await h.invoke('recoverAttempt', 30)
    assert.equal(posts(world).filter(call => call.name === 'recoverExecutionUnitTask').length, fault === 'missing_attempt' ? 0 : 1)
    assert.equal(savedAction(world).value.status, 'unknown')
    assert.equal(posts(world).filter(call => call.name === 'advanceExecutionRun').length, 1)
  })
}

for (const fault of ['write', 'readback_throw', 'readback_mismatch']) test(`original advance reconciliation ${fault} stays unknown durably and after reload`, async t => {
  const world = twoUnitWorld(t), h = world.mount(world.evaluate())
  await unknownFirstUnit(world, h)
  const store = world.env.session, originalGet = store.getItem.bind(store), originalSet = store.setItem.bind(store)
  let reconciliationWrites = 0
  store.setItem = (key, raw) => { const value = JSON.parse(raw)
    if (value.action === 'advance' && value.status === 'received') reconciliationWrites++
    if (fault === 'write' && value.action === 'advance' && value.status === 'received') throw Error('fixture reconcile write denied')
    return originalSet(key, raw)
  }
  store.getItem = key => { const raw = originalGet(key), value = JSON.parse(raw)
    if (value?.action === 'advance' && value.status === 'received' && fault !== 'write') {
      if (fault === 'readback_throw') throw Error('fixture reconcile readback denied')
      return 'fixture reconcile readback mismatch'
    }
    return raw
  }
  world.handlers.recoverExecutionUnitTask = async () => recoveredReceipt()
  await h.invoke('recoverAttempt', 30)
  assert.equal(posts(world).filter(call => call.name === 'recoverExecutionUnitTask').length, 1)
  assert.ok(reconciliationWrites > 0, 'the original intent settlement must actually reach the injected storage fault')
  assert.equal(savedAction(world).value.status, 'unknown', 'failed durable reconciliation must not leave a stored received flag')
  store.getItem = originalGet; store.setItem = originalSet
  h.dispose(); await tick(); approveFirstUnit(world)
  const reloaded = world.mount(world.evaluate()); await prepare(reloaded, 'advance'); await reloaded.invoke('advanceRun')
  assert.equal(reloaded.state.canAdvance, false); assert.equal(posts(world).filter(call => call.name === 'advanceExecutionRun').length, 1)
})

for (const field of ['run', 'task', 'request_hash', 'user', 'tenant', 'attempt', 'submit_started_at', 'work', 'version', 'provider']) {
  test(`a repeated recover with conflicting ${field} cannot replace the sole safe receipt`, async t => {
    const world = twoUnitWorld(t), h = world.mount(world.evaluate()), original = safeReceipt(false)
    await unknownFirstUnit(world, h, 'reject')
    world.handlers.recoverExecutionUnitTask = async () => original
    await h.invoke('recoverAttempt', 30); await tick()
    assert.deepEqual(h.state.submissionReceipt, original); assert.deepEqual(savedAction(world, 'recover').value.receipt, original)
    const changed = structuredClone(original)
    if (field === 'run') { changed.run_id = 21; changed.recovery_receipt.run_id = 21 }
    if (field === 'task') { changed.task_id = 'different-task'; changed.recovery_receipt.task_id = 'different-task' }
    if (field === 'request_hash') changed.recovery_receipt.request_hash = digest('b')
    if (field === 'user') changed.recovery_receipt.user_id = 'user-b'
    if (field === 'tenant') changed.recovery_receipt.tenant_id = 'tenant-b'
    if (field === 'attempt') { changed.attempt_id = 31; changed.recovery_receipt.attempt_id = 31 }
    if (field === 'submit_started_at') changed.recovery_receipt.submit_started_at = '2026-09-08T00:00:01.000Z'
    if (field === 'work') changed.recovery_receipt.work_id = 2
    if (field === 'version') changed.recovery_receipt.version_id = 11
    if (field === 'provider') { changed.provider_task_id = 'different-provider'; changed.recovery_receipt.provider_task_id = 'different-provider' }
    world.handlers.recoverExecutionUnitTask = async () => changed
    await h.invoke('recoverAttempt', 30); await tick()
    assert.equal(savedAction(world, 'recover').value.status, 'unknown')
    assert.deepEqual(savedAction(world, 'recover').value.receipt, original, 'invalid or conflicting evidence must never overwrite the original safe receipt')
    assert.deepEqual(h.state.submissionReceipt, original); assert.equal(h.state.canRecover(30), true)
    h.dispose(); await tick(); const reloaded = world.mount(world.evaluate())
    await reloaded.invoke('refreshRuns'); await reloaded.invoke('selectRun', 20)
    assert.deepEqual(reloaded.state.submissionReceipt, original)
    world.handlers.recoverExecutionUnitTask = async () => original
    await reloaded.invoke('recoverAttempt', 30)
    assert.equal(posts(world).filter(call => call.name === 'recoverExecutionUnitTask').length, 3)
    assert.equal(posts(world).filter(call => call.name === 'advanceExecutionRun').length, 1)
  })
}

for (const reload of [false, true]) test(`unknown create resolves only through explicit matching current detail${reload ? ' in a new module' : ''}`, async t => {
  const world = scenario(t, { action: 'create' }); let h = world.mount(world.evaluate())
  world.handlers.createExecutionRun = async () => { throw Error('fixture create response lost') }
  await prepare(h, 'create'); assert.equal(h.state.canCreate, true); await h.invoke('createRun')
  const original = savedAction(world, 'create'); assert.equal(original.value.status, 'unknown')
  if (reload) { h.dispose(); await tick(); const before = world.calls.length; h = world.mount(world.evaluate()); await tick(); assert.equal(world.calls.length, before) }
  world.handlers.listExecutionRuns = async () => ({ version_id: 10, current_run_id: 20, runs: [run(world.fixture)] })
  await h.invoke('refreshRuns'); assert.equal(savedAction(world, 'create').value.status, 'unknown', 'collection discovery alone does not prove current detail')
  await h.invoke('selectRun', 20); assert.equal(h.state.currentRun, true)
  const resolved = savedAction(world, 'create'); assert.equal(resolved.key, original.key); assert.equal(resolved.value.status, 'received')
  await h.invoke('createRun'); assert.equal(posts(world).length, 1, 'the original create cannot be replayed')
  h.state.selectedResolution = '720p'; h.state.selectedAspectRatio = '16:9'
  await h.invoke('loadReadiness'); assert.equal(h.state.canAdvance, false); await h.invoke('advanceRun'); assert.equal(posts(world).length, 1)
  await h.invoke('confirmAction'); assert.equal(h.state.canAdvance, true); await h.invoke('advanceRun')
  assert.deepEqual(posts(world).map(call => call.name), ['createExecutionRun', 'advanceExecutionRun'])
})

for (const phase of ['idle', 'claimed_unbound', 'claimed_bound']) for (const reload of [false, true]) {
  test(`unknown ${phase} resume needs exact next revision and explicit real phase readiness${reload ? ' after reload' : ''}`, async t => {
    const world = pausedWorld(t, phase); let h = world.mount(world.evaluate())
    await unknownResume(world, h)
    const original = savedAction(world, 'resume')
    if (reload) { h.dispose(); await tick(); const before = world.calls.length; h = world.mount(world.evaluate()); await tick(); assert.equal(world.calls.length, before) }
    await h.invoke('refreshRuns'); await h.invoke('selectRun', 20)
    assert.equal(h.state.currentRun, true); assert.equal(h.state.run.revision, 7); assert.equal(h.state.run.pause_requested, false)
    assert.equal(savedAction(world, 'resume').value.status, 'unknown', 'public detail does not reveal claimed bound/unbound phase')
    h.state.selectedResolution = '720p'; h.state.selectedAspectRatio = '16:9'
    await h.invoke('loadReadiness')
    const resolved = savedAction(world, 'resume')
    assert.equal(resolved.key, original.key); assert.equal(resolved.value.status, 'received')
    assert.equal(resolved.value.phase, phase); assert.deepEqual(resolved.value.output_parameters, { resolution: '720p', aspect_ratio: '16:9' })
    assert.equal(h.state.canAdvance, false); await h.invoke('resumeRun'); await h.invoke('advanceRun'); assert.equal(posts(world).length, 1)
    await h.invoke('confirmAction'); assert.equal(h.state.canAdvance, true)
    world.handlers.advanceExecutionRun = async () => ({ ...receipt(), run_revision: phase === 'idle' ? 11 : phase === 'claimed_unbound' ? 10 : 9 })
    await h.invoke('advanceRun'); assert.deepEqual(posts(world).map(call => call.name), ['resumeExecutionRun', 'advanceExecutionRun'])
  })
}

for (const mismatch of ['old_revision', 'higher_revision', 'wrong_phase', 'wrong_attempt', 'changed_output']) {
  test(`unknown resume is not resolved by ${mismatch}`, async t => {
    const world = pausedWorld(t, 'claimed_bound'), h = world.mount(world.evaluate())
    await unknownResume(world, h)
    if (mismatch === 'old_revision') { world.server.revision = 6; world.server.pause_requested = true }
    if (mismatch === 'higher_revision') world.server.revision = 8
    if (mismatch === 'wrong_attempt') world.server.units[0].attempts[0].id = 31
    if (mismatch === 'changed_output') world.server.output_parameters = { resolution: '480p', aspect_ratio: '16:9' }
    if (mismatch === 'wrong_phase') {
      const original = world.handlers.getExecutionRunReadiness
      world.handlers.getExecutionRunReadiness = async (...args) => ({ ...await original(...args), phase: 'claimed_unbound' })
    }
    await h.invoke('refreshRuns'); await h.invoke('selectRun', 20); assert.equal(h.state.currentRun, true)
    h.state.selectedResolution = mismatch === 'changed_output' ? '480p' : '720p'; h.state.selectedAspectRatio = '16:9'
    assert.equal(h.state.canReadiness, true); await h.invoke('loadReadiness')
    assert.equal(savedAction(world, 'resume').value.status, 'unknown')
    await h.invoke('confirmAction'); await h.invoke('advanceRun'); assert.equal(posts(world).length, 1)
  })
}

for (const action of ['create', 'resume']) test(`explicit ${action} control reconciliation never clears a coexisting advance unknown`, async t => {
  const world = action === 'create' ? scenario(t, { action }) : pausedWorld(t, 'idle'), h = world.mount(world.evaluate())
  if (action === 'create') {
    world.handlers.createExecutionRun = async () => { throw Error('fixture create response lost') }
    await prepare(h, 'create'); assert.equal(h.state.canCreate, true); await h.invoke('createRun')
    world.handlers.listExecutionRuns = async () => ({ version_id: 10, current_run_id: 20, runs: [run(world.fixture)] })
  } else await unknownResume(world, h)
  const control = savedAction(world, action).value
  const prior = { ...control, action: 'advance', hash: digest('5'), run_id: 20, unit_id: 'unit-1', attempt_id: null, status: 'unknown', receipt: null }
  const priorKey = 'redraw-execution-run-operation-v1:' + JSON.stringify([prior.scope, prior.action, prior.hash])
  world.env.session.setItem(priorKey, JSON.stringify(prior))
  await h.invoke('refreshRuns'); await h.invoke('selectRun', 20)
  h.state.selectedResolution = '720p'; h.state.selectedAspectRatio = '16:9'; await h.invoke('loadReadiness')
  assert.equal(savedAction(world, action).value.status, 'received')
  assert.deepEqual(savedOperations(world).find(item => item.key === priorKey)?.value, prior)
  await h.invoke('confirmAction'); await h.invoke('advanceRun'); assert.equal(posts(world).length, 1)
})

for (const change of ['refresh', 'unmount', 'owner', 'parameters', 'props_aba']) test(`late successful original recovery settles A after ${change} without implicit calls`, async t => {
  const world = twoUnitWorld(t), h = world.mount(world.evaluate()), wait = world.deferred()
  await unknownFirstUnit(world, h)
  const original = savedAction(world)
  world.handlers.recoverExecutionUnitTask = () => wait.promise
  const recovering = h.invoke('recoverAttempt', 30); await tick()
  assert.equal(posts(world).length, 2, 'the explicit original recovery must enter before invalidation')
  let otherKey, otherRaw
  if (change === 'refresh') await h.invoke('refreshRuns')
  if (change === 'unmount') { h.dispose(); await tick(); assert.equal(h.instance.isUnmounted, true) }
  if (change === 'parameters') h.state.selectedResolution = '480p'
  if (change === 'props_aba') {
    h.props.record.updated_at = 'other'; h.props.record.updated_at = 'saved'
    assert.equal(h.state.run, null, 'shared record ABA must synchronously invalidate the actual mounted child')
  }
  if (change === 'owner') {
    world.env.auth.saveSession({ token: 'fixture-token-b', user: { id: 'user-b' } }); world.env.auth.saveCurrentTenantId('tenant-b')
    world.env.window.dispatch('focus', { type: 'focus' })
    const other = { ...original.value, scope: JSON.stringify([['tenant-b', 'user-b'], 5, 1, 10, 4, 8, digest('a')]), receipt: null }
    otherKey = 'redraw-execution-run-operation-v1:' + JSON.stringify([other.scope, other.action, other.hash])
    otherRaw = JSON.stringify(other); world.env.session.setItem(otherKey, otherRaw)
    h.props.preview.bindings.user_id = 'user-b'; h.props.preview.bindings.tenant_id = 'tenant-b'
    h.props.savedReview.plan = structuredClone(world.fixture.preview)
    h.props.savedReview.plan.bindings.user_id = 'user-b'; h.props.savedReview.plan.bindings.tenant_id = 'tenant-b'
    assert.equal(h.state.contextReady, true)
  }
  const before = world.calls.length
  wait.resolve(recoveredReceipt()); await recovering; await tick()
  assert.equal(world.calls.length, before, 'a late recovery must not issue any follow-up request')
  assert.equal(savedAction(world).key, original.key)
  assert.equal(savedAction(world).value.status, 'received', 'original captured proof must settle the original slot even when the UI ticket is stale')
  if (change === 'owner') {
    assert.equal(world.env.session.getItem(otherKey), otherRaw); assert.equal(h.state.submissionReceipt, null)
    assert.equal(visibleText(h.root).includes('unique-provider-receipt'), false)
    world.env.auth.saveSession({ token: 'fixture-token', user: { id: 'user-a' } }); world.env.auth.saveCurrentTenantId('tenant-a')
  }
  h.dispose(); await tick(); approveFirstUnit(world)
  const reloaded = world.mount(world.evaluate()); await reloaded.invoke('refreshRuns'); await reloaded.invoke('selectRun', 20)
  reloaded.state.selectedResolution = '720p'; reloaded.state.selectedAspectRatio = '16:9'
  const nextReady = world.handlers.getExecutionRunReadiness
  world.handlers.getExecutionRunReadiness = async (...args) => ({ ...await nextReady(...args), confirmation_hash: digest('7') })
  await reloaded.invoke('loadReadiness'); await reloaded.invoke('confirmAction'); await reloaded.invoke('advanceRun')
  assert.equal(posts(world).length, 2, 'late settlement must not release the consumed original hash')
  world.handlers.getExecutionRunReadiness = nextReady
  await reloaded.invoke('loadReadiness'); assert.equal(reloaded.state.readiness.unit_id, 'unit-2')
  await reloaded.invoke('advanceRun'); assert.equal(posts(world).length, 2)
  await reloaded.invoke('confirmAction'); assert.equal(reloaded.state.canAdvance, true)
  world.handlers.advanceExecutionRun = async () => ({ ...receipt(), run_revision: 11, attempt_id: 31, task_id: 'second-task', provider_task_id: 'second-provider' })
  await reloaded.invoke('advanceRun'); assert.equal(posts(world).filter(call => call.name === 'advanceExecutionRun').length, 2)
})

for (const status of ['waiting_review', 'approved', 'rejected', 'failed']) test(`first explicit detail with ${status} allows reconciliation only for its unknown original advance`, async t => {
  const world = twoUnitWorld(t), h = world.mount(world.evaluate())
  world.handlers.advanceExecutionRun = async () => { throw Error('fixture submission response lost') }
  await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true); await h.invoke('advanceRun')
  assert.equal(savedAction(world).value.status, 'unknown')
  world.server = { ...world.server, status: status === 'approved' ? 'ready' : status === 'rejected' ? 'needs_attention' : status,
    revision: status === 'approved' || status === 'rejected' ? 7 : 6, output_parameters: { resolution: '720p', aspect_ratio: '16:9' } }
  world.server.units[0].status = status
  world.server.units[0].attempts = [{ id: 30, attempt_no: 1, status, created_at: 'created', updated_at: 'updated' }]
  await h.invoke('refreshRuns'); await h.invoke('selectRun', 20)
  assert.equal(h.state.currentRun, true); assert.equal(posts(world).length, 1)
  assert.equal(h.state.canRecover(30), true, 'the first authoritative terminal detail must not make an unknown original submission unrecoverable')
  assert.ok(h.state.recoverableAttempts.some(attempt => attempt.id === 30))
  world.handlers.recoverExecutionUnitTask = async () => ({ run_id: 20, run_revision: world.server.revision, attempt_id: 30,
    task_id: safeReceipt().task_id, provider_task_id: safeReceipt().provider_task_id, status,
    newly_submitted: false, receipt_persisted: true, executable: false })
  await h.invoke('recoverAttempt', 30)
  assert.equal(savedAction(world).value.status, 'received'); assert.equal(posts(world).length, 2)
  assert.equal(h.state.canRecover(30), false, 'resolved terminal attempts must not become a general-purpose recovery button')
  await h.invoke('advanceRun'); assert.equal(posts(world).length, 2)
  if (status === 'waiting_review') {
    h.state.selectedResolution = '720p'; h.state.selectedAspectRatio = '16:9'
    await h.invoke('loadReadiness'); await h.invoke('confirmAction'); await h.invoke('advanceRun')
    assert.equal(posts(world).length, 2, 'recovery does not replace required human approval')
    approveFirstUnit(world); await h.invoke('refreshRuns'); await h.invoke('selectRun', 20)
    await h.invoke('loadReadiness'); await h.invoke('advanceRun'); assert.equal(posts(world).length, 2)
    await h.invoke('confirmAction'); assert.equal(h.state.canAdvance, true)
    world.handlers.advanceExecutionRun = async () => ({ ...receipt(), run_revision: 11, attempt_id: 31, task_id: 'second-task', provider_task_id: 'second-provider' })
    await h.invoke('advanceRun'); assert.equal(posts(world).length, 3)
  }
})

for (const status of ['waiting_review', 'approved', 'rejected', 'failed']) test(`${status} with no local unknown advance has no terminal recovery action`, async t => {
  const world = twoUnitWorld(t), h = world.mount(world.evaluate())
  world.server.status = status === 'approved' ? 'ready' : status === 'rejected' ? 'needs_attention' : status
  world.server.revision = 7; world.server.output_parameters = { resolution: '720p', aspect_ratio: '16:9' }
  world.server.units[0].status = status
  world.server.units[0].attempts = [{ id: 30, attempt_no: 1, status, created_at: 'created', updated_at: 'updated' }]
  await h.invoke('refreshRuns'); await h.invoke('selectRun', 20); assert.equal(h.state.currentRun, true)
  assert.equal(h.state.canRecover(30), false); assert.equal(h.state.recoverableAttempts.length, 0)
  await h.invoke('recoverAttempt', 30); assert.equal(posts(world).length, 0)
})

for (const phase of ['idle', 'claimed_unbound', 'claimed_bound']) for (const fault of ['second_attempt', 'changed_output']) {
  test(`${phase} original intent cannot be settled with ${fault} despite a valid recover receipt`, async t => {
    const world = twoUnitWorld(t), h = world.mount(world.evaluate())
    if (phase !== 'idle') {
      world.server.status = 'running'; world.server.revision = 2; world.server.output_parameters = { resolution: '720p', aspect_ratio: '16:9' }
      world.server.units[0].status = 'claimed'
      world.server.units[0].attempts = [{ id: 30, attempt_no: 1, status: 'claimed', created_at: 'created', updated_at: 'updated' }]
      world.handlers.getExecutionRunReadiness = async (_v, _r, output) => ({ ...readiness(world.fixture, output), phase, run_revision: 2, attempt_id: 30 })
    }
    world.handlers.advanceExecutionRun = async () => { throw Error('fixture original response lost') }
    await prepare(h, 'advance'); assert.equal(h.state.canAdvance, true); await h.invoke('advanceRun')
    assert.equal(savedAction(world).value.attempt_id, phase === 'idle' ? null : 30)
    world.server.status = 'needs_attention'; world.server.revision = 4; world.server.output_parameters = { resolution: '720p', aspect_ratio: '16:9' }
    world.server.units[0].status = 'needs_attention'
    world.server.units[0].attempts = [{ id: 30, attempt_no: 1, status: 'needs_attention', created_at: 'created', updated_at: 'updated' }]
    if (fault === 'second_attempt') world.server.units[0].attempts.push({ id: 31, attempt_no: 2, status: 'failed', created_at: 'new', updated_at: 'new' })
    else world.server.output_parameters.resolution = '480p'
    await h.invoke('refreshRuns'); await h.invoke('selectRun', 20); assert.equal(h.state.currentRun, true); assert.equal(h.state.canRecover(30), true)
    world.handlers.recoverExecutionUnitTask = async () => recoveredReceipt()
    await h.invoke('recoverAttempt', 30)
    assert.equal(posts(world).length, 2); assert.equal(savedAction(world, 'recover').value.status, 'received')
    assert.equal(savedAction(world).value.status, 'unknown', 'the original unit must retain one matching attempt and the same output snapshot')
  })
}

for (const action of ['create', 'resume', 'advance', 'recover']) test(`fresh module reconciles inherited ${action} pending only through explicit authoritative evidence`, async t => {
  const world = action === 'create' ? scenario(t, { action }) : action === 'resume' ? pausedWorld(t, 'claimed_bound') : twoUnitWorld(t)
  const h = world.mount(world.evaluate()), wait = world.deferred()
  if (action === 'recover') {
    await unknownFirstUnit(world, h, 'reject')
    world.handlers.recoverExecutionUnitTask = () => wait.promise
    h.invoke('recoverAttempt', 30)
  } else {
    const method = action === 'create' ? 'createRun' : action === 'resume' ? 'resumeRun' : 'advanceRun'
    world.handlers[`${action}ExecutionRun`] = () => wait.promise
    await prepare(h, action === 'create' ? 'create' : 'advance')
    assert.equal(h.state[action === 'create' ? 'canCreate' : action === 'resume' ? 'canResume' : 'canAdvance'], true)
    h.invoke(method)
  }
  await tick(); assert.equal(savedAction(world, action).value.status, 'pending')
  h.dispose(); await tick()
  const reloaded = world.mount(world.evaluate()), before = world.calls.length
  await tick(); assert.equal(world.calls.length, before, 'loading a module with inherited pending must not make any API call')
  if (action === 'create') {
    world.handlers.listExecutionRuns = async () => ({ version_id: 10, current_run_id: 20, runs: [run(world.fixture)] })
  } else if (action === 'resume') {
    world.server.revision = 7; world.server.pause_requested = false
  } else {
    world.server.status = 'waiting_review'; world.server.revision = 6
    world.server.output_parameters = { resolution: '720p', aspect_ratio: '16:9' }
    world.server.units[0].status = 'waiting_review'
    world.server.units[0].attempts = [{ id: 30, attempt_no: 1, status: 'waiting_review', created_at: 'created', updated_at: 'updated' }]
  }
  await reloaded.invoke('refreshRuns'); assert.equal(savedAction(world, action).value.status, 'pending')
  await reloaded.invoke('selectRun', 20); assert.equal(reloaded.state.currentRun, true)
  reloaded.state.selectedResolution = '720p'; reloaded.state.selectedAspectRatio = '16:9'
  if (action === 'resume') {
    assert.equal(savedAction(world, action).value.status, 'pending', 'detail alone cannot prove the old claimed phase')
    await reloaded.invoke('loadReadiness')
  }
  if (action === 'advance' || action === 'recover') {
    assert.equal(savedAction(world, action).value.status, 'pending')
    assert.equal(reloaded.state.canRecover(30), true)
    const next = world.deferred(); world.handlers.recoverExecutionUnitTask = () => next.promise
    const recovery = reloaded.invoke('recoverAttempt', 30); await tick()
    const count = posts(world).length, duplicate = reloaded.invoke('recoverAttempt', 30); await tick()
    assert.equal(posts(world).length, count, 'inherited recovery pending must immediately become this module active double-click protection')
    assert.equal(posts(world).filter(call => call.name === 'recoverExecutionUnitTask').length, action === 'recover' ? 2 : 1)
    next.resolve({ run_id: 20, run_revision: 6, attempt_id: 30, task_id: safeReceipt().task_id,
      provider_task_id: safeReceipt().provider_task_id, status: 'waiting_review', newly_submitted: false, receipt_persisted: true, executable: false })
    await Promise.all([recovery, duplicate]); assert.equal(savedAction(world).value.status, 'received')
  }
  assert.equal(savedAction(world, action).value.status, 'received')
  const count = posts(world).length
  await reloaded.invoke('createRun'); await reloaded.invoke('resumeRun'); await reloaded.invoke('advanceRun')
  assert.equal(posts(world).length, count, 'reconciliation must not replay the original action or bypass a new confirmation')
})

async function pendingPause(t) {
  const world = pausedWorld(t, 'claimed_bound'), wait = world.deferred()
  world.server.pause_requested = false
  world.handlers.pauseExecutionRun = () => wait.promise
  const h = world.mount(world.evaluate())
  await h.invoke('refreshRuns'); await h.invoke('selectRun', 20); assert.equal(h.state.canPause, true)
  h.invoke('pauseRun'); await tick()
  assert.equal(posts(world).length, 1); assert.equal(savedAction(world, 'pause').value.status, 'pending')
  world.server.revision = 7; world.server.pause_requested = true
  return { world, h }
}

test('inherited pause pending settles only on explicit next-revision paused detail, then resume still needs confirmation', async t => {
  const { world, h } = await pendingPause(t), original = savedAction(world, 'pause')
  h.dispose(); await tick(); const reloaded = world.mount(world.evaluate()), before = world.calls.length
  await tick(); assert.equal(world.calls.length, before)
  await reloaded.invoke('refreshRuns'); assert.equal(savedAction(world, 'pause').value.status, 'pending')
  await reloaded.invoke('selectRun', 20); assert.equal(reloaded.state.currentRun, true)
  const resolved = savedAction(world, 'pause')
  assert.equal(resolved.key, original.key); assert.equal(resolved.value.hash, original.value.hash); assert.equal(resolved.value.status, 'received')
  await reloaded.invoke('pauseRun'); await reloaded.invoke('resumeRun'); await reloaded.invoke('advanceRun'); assert.equal(posts(world).length, 1)
  reloaded.state.selectedResolution = '720p'; reloaded.state.selectedAspectRatio = '16:9'
  await reloaded.invoke('loadReadiness'); assert.equal(reloaded.state.readiness.action, 'resume'); assert.equal(reloaded.state.canResume, false)
  await reloaded.invoke('resumeRun'); assert.equal(posts(world).length, 1)
  await reloaded.invoke('confirmAction'); assert.equal(reloaded.state.canResume, true)
  world.handlers.resumeExecutionRun = async () => {
    world.server.revision = 8; world.server.pause_requested = false
    return { run_id: 20, run_revision: 8, run_status: 'running', pause_requested: false, attempt_id: 30, attempt_status: 'claimed',
      amount: 12, billing_mode: 'paid', changed: true, executable: false }
  }
  await reloaded.invoke('resumeRun'); assert.deepEqual(posts(world).map(call => call.name), ['pauseExecutionRun', 'resumeExecutionRun'])
  await reloaded.invoke('advanceRun'); assert.equal(posts(world).length, 2, 'pause reconciliation and resume never imply advance')
})

test('a same-module active pause cannot be settled by detail or cause resume while the original request is in flight', async t => {
  const { world, h } = await pendingPause(t)
  await h.invoke('refreshRuns'); await h.invoke('selectRun', 20); assert.equal(h.state.currentRun, true)
  h.state.selectedResolution = '720p'; h.state.selectedAspectRatio = '16:9'; await h.invoke('loadReadiness')
  assert.equal(h.state.readiness.action, 'resume'); assert.equal(savedAction(world, 'pause').value.status, 'pending')
  await h.invoke('confirmAction'); await h.invoke('resumeRun'); await h.invoke('pauseRun'); assert.equal(posts(world).length, 1)
})

for (const mismatch of ['old_revision', 'higher_revision', 'wrong_run', 'unpaused']) test(`inherited pause cannot settle from ${mismatch} detail`, async t => {
  const { world, h } = await pendingPause(t)
  h.dispose(); await tick(); const reloaded = world.mount(world.evaluate())
  if (mismatch === 'old_revision') world.server.revision = 6
  if (mismatch === 'higher_revision') world.server.revision = 8
  if (mismatch === 'unpaused') world.server.pause_requested = false
  if (mismatch === 'wrong_run') {
    world.server.id = 21
    world.handlers.listExecutionRuns = async () => ({ version_id: 10, current_run_id: 21, runs: [structuredClone(world.server)] })
  }
  await reloaded.invoke('refreshRuns'); await reloaded.invoke('selectRun', world.server.id); assert.equal(reloaded.state.currentRun, true)
  assert.equal(savedAction(world, 'pause').value.status, 'pending')
  await reloaded.invoke('resumeRun'); await reloaded.invoke('advanceRun'); assert.equal(posts(world).length, 1)
})

test('pause reconciliation preserves a coexisting original advance unknown', async t => {
  const { world, h } = await pendingPause(t), pause = savedAction(world, 'pause').value
  const advance = { ...pause, action: 'advance', hash: digest('5'), unit_id: 'unit-1', attempt_id: 30, status: 'unknown', receipt: null,
    output_parameters: { resolution: '720p', aspect_ratio: '16:9' } }
  const key = 'redraw-execution-run-operation-v1:' + JSON.stringify([advance.scope, advance.action, advance.hash]), raw = JSON.stringify(advance)
  world.env.session.setItem(key, raw); h.dispose(); await tick(); const reloaded = world.mount(world.evaluate())
  await reloaded.invoke('refreshRuns'); await reloaded.invoke('selectRun', 20)
  assert.equal(savedAction(world, 'pause').value.status, 'received'); assert.equal(world.env.session.getItem(key), raw)
  reloaded.state.selectedResolution = '720p'; reloaded.state.selectedAspectRatio = '16:9'; await reloaded.invoke('loadReadiness')
  assert.equal(reloaded.state.readiness.action, 'resume'); await reloaded.invoke('confirmAction'); assert.equal(reloaded.state.canResume, false)
  await reloaded.invoke('resumeRun'); await reloaded.invoke('advanceRun'); assert.equal(posts(world).length, 1)
})

for (const fault of ['write', 'readback_throw', 'readback_mismatch']) test(`pause reconciliation ${fault} does not durably release the pending lock`, async t => {
  const { world, h } = await pendingPause(t), store = world.env.session
  h.dispose(); await tick(); const reloaded = world.mount(world.evaluate()), get = store.getItem.bind(store), set = store.setItem.bind(store)
  let attempted = 0
  store.setItem = (key, raw) => {
    const value = JSON.parse(raw)
    if (value.action === 'pause' && value.status === 'received') { attempted++; if (fault === 'write') throw Error('fixture pause settlement write denied') }
    return set(key, raw)
  }
  store.getItem = key => {
    const raw = get(key), value = JSON.parse(raw)
    if (value?.action === 'pause' && value.status === 'received' && fault !== 'write') {
      if (fault === 'readback_throw') throw Error('fixture pause settlement readback denied')
      return 'fixture pause readback mismatch'
    }
    return raw
  }
  await reloaded.invoke('refreshRuns'); await reloaded.invoke('selectRun', 20)
  assert.equal(reloaded.state.currentRun, true); assert.ok(attempted > 0, 'settlement must reach the injected pause storage fault')
  assert.equal(savedAction(world, 'pause').value.status, 'unknown'); assert.equal(reloaded.state.storageBlocked, true)
  reloaded.state.selectedResolution = '720p'; reloaded.state.selectedAspectRatio = '16:9'; await reloaded.invoke('loadReadiness')
  await reloaded.invoke('confirmAction'); await reloaded.invoke('resumeRun'); assert.equal(posts(world).length, 1)
  store.getItem = get; store.setItem = set; reloaded.dispose(); await tick()
  const fresh = world.mount(world.evaluate()); await tick(); assert.equal(fresh.state.canResume, false)
  assert.equal(savedAction(world, 'pause').value.status, 'unknown')
})
