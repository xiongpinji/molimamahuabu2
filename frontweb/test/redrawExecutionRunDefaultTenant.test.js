import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Real compiled/mounted Run + real import-free auth helper. All API DTOs, storage,
// events and optional media below are synthetic; this is not HTTP/browser acceptance.
const componentLocation = new URL('../src/components/redraw/RedrawExecutionRunPanel.vue', import.meta.url)
const authSource = readFileSync(new URL('../src/utils/authSession.js', import.meta.url), 'utf8')
const digest = character => character.repeat(64)
const clone = value => JSON.parse(JSON.stringify(value))
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
const defaultTenant = 'server-assigned-opaque-tenant-a'
const sessionKey = 'moli_mama_session', tenantKey = 'moli_mama_tenant_id'
async function flush() { for (let index = 0; index < 12; index++) { await vue.nextTick(); await Promise.resolve() } }

function fixture() {
  const unit = { id: 'unit-1', source_start_ms: 0, source_end_ms: 5000, parent_shots: [{ id: 'shot-1' }],
    retained_duration_ms: 5000, generated_duration_ms: 5000, padding_ms: 0, dialogues: [],
    reference_requirements: [{ id: 'motion-shot-1', kind: 'video' }] }
  const bindings = { tenant_id: defaultTenant, user_id: 'user-a', work_id: 1, version_id: 10, source_asset_id: 101,
    source_sha256: digest('d'), blueprint_hash: digest('b'), localization_hash: digest('c'), capability_hash: digest('e'),
    localization_updated_at: 'saved', locale: 'en', market: 'US' }
  const preview = { schema_version: 'redraw-execution-plan-preview-v1', status: 'ready', executable: false,
    plan_hash: digest('a'), bindings, units: [unit], blocking_reasons: [], execution_blockers: ['PREVIEW_ONLY'],
    capability: { model: 'fixture', audio_mode: 'native', resolutions: ['480p', '720p'], aspect_ratios: ['9:16', '16:9'] } }
  return { record: { work_id: 1, version_id: 10, blueprint_hash: digest('b'), localization_hash: digest('c'), updated_at: 'saved' },
    preview, savedReview: { id: 4, status: 'current', plan_hash: preview.plan_hash, plan: clone(preview) },
    queue: { id: 8, version_id: 10, work_id: 1, status: 'waiting_readiness', executable: false, plan_hash: preview.plan_hash,
      execution_blockers: ['PREVIEW_ONLY'], units: [{ id: unit.id, ordinal: 0, status: 'pending', unit_hash: hash(unit), plan_unit: unit }] },
    blocked: false, projectPolicy: { project_id: 5, execution_mode: 'safe', policy_version: 2, epoch: 1 } }
}
function project() {
  // Existing mapProject shape; no client-created personal:<user> identifier.
  return { id: 5, tenant_id: defaultTenant, user_id: 'user-a', title: 'Default owner fixture',
    default_locale: 'en', default_market: 'US', localization_level: 'full', status: 'active', execution_mode: 'safe',
    budget_limit_credits: null, max_auto_attempts_per_shot: null, policy_version: 2,
    created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z' }
}
function run(props) {
  return { id: 20, work_id: 1, version_id: 10, queue_id: 8, review_id: 4, plan_hash: props.preview.plan_hash,
    status: 'ready', binding_status: 'current', pause_requested: false, revision: 0, created_at: 'created', updated_at: 'updated',
    executable: false, output_parameters: null,
    units: [{ id: 'unit-1', ordinal: 0, unit_hash: props.queue.units[0].unit_hash, status: 'pending', attempts: [] }],
    execution_blockers: ['PREVIEW_ONLY', 'EXECUTION_RUN_STORAGE_ONLY'] }
}
function readiness(world, output) {
  return { schema_version: 'redraw-execution-run-advance-readiness-v1', status: 'ready', executable: false, action: 'advance',
    phase: 'idle', run_id: 20, run_revision: world.server.revision, plan_hash: world.fixture.preview.plan_hash,
    unit_id: 'unit-1', attempt_id: null, output_parameters: output, amount: 12, billing_mode: 'paid',
    quote_hash: digest('6'), confirmation_hash: world.confirmationHash, policy: { execution_mode: 'safe', policy_version: 2 } }
}
function receipt() {
  return { run_id: 20, run_revision: 4, attempt_id: 30, task_id: 'd2781e76-f87f-4efb-8f34-6e8ac48b091b', status: 'running',
    attempt_status: 'running', provider_task_id: 'synthetic-provider-receipt', newly_submitted: true,
    receipt_persisted: true, changed: true, executable: false }
}
function storage(onMutation = () => {}) {
  const values = new Map()
  return { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { onMutation('set', key, String(value)); values.set(key, String(value)) },
    removeItem(key) { onMutation('remove', key); values.delete(key) }, snapshot: () => Object.fromEntries(values) }
}
function environment(selectedTenant = null) {
  let fixtureWrite = false
  const writes = [], listeners = new Map(), revoked = []
  const local = storage((action, key) => {
    if (!fixtureWrite) { writes.push({ action, key }); throw Error('DEFAULT_TENANT_PRODUCT_LOCALSTORAGE_WRITE') }
  }), session = storage()
  assert.doesNotMatch(authSource, /^import\s/m, 'real auth helper must remain import-free')
  const auth = new Function('localStorage', 'sessionStorage', authSource.replace(/^export /gm, '')
    + '\nreturn { readSession, readCurrentTenantId, saveSession, saveCurrentTenantId, clearSession }')(local, session)
  const writeFixture = action => { fixtureWrite = true; try { action() } finally { fixtureWrite = false } }
  writeFixture(() => {
    auth.saveSession({ token: 'synthetic-token-a', user: { id: 'user-a' } })
    if (selectedTenant !== null) auth.saveCurrentTenantId(selectedTenant)
  })
  const window = { localStorage: local, sessionStorage: session,
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback) },
    removeEventListener: (name, callback) => listeners.get(name)?.delete(callback),
    dispatch: (name, event) => [...(listeners.get(name) || [])].forEach(callback => callback(event)) }
  return { local, session, auth, writes, writeFixture, window, listeners, revoked,
    urls: { createObjectURL: () => 'blob:default-tenant-synthetic-only', revokeObjectURL: url => revoked.push(url) } }
}

// Closed import conversion reused in shape from Parent, not by importing another test.
const importPattern = /^import[ \t]+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"\r\n]+)\2[ \t]*;?[ \t]*(?:\r?\n|$)/gm
function bindImports(source, modules) {
  const result = source.replace(importPattern, (_whole, names, _quote, specifier) => {
    if (specifier === 'vue') {
      assert.ok(names.startsWith('{'), 'only named Vue bindings are allowed')
      return `const ${names.replace(/\s+as\s+/g, ':')} = Vue;\n`
    }
    assert.ok(Object.hasOwn(modules, specifier), `unapproved SFC import: ${specifier}`)
    return `const ${names.replace(/\s+as\s+/g, ':')} = modules[${JSON.stringify(specifier)}];\n`
  })
  assert.doesNotMatch(result, /^import\s/m, 'all real SFC imports must be explicitly bound')
  return result
}
function compile(world) {
  const parsed = parse(readFileSync(componentLocation, 'utf8'))
  assert.deepEqual(parsed.errors, [])
  const script = compileScript(parsed.descriptor, { id: 'execution-run-default-tenant' })
  const modules = { '@/api/redraw': { redrawAPI: world.api }, '@/utils/authSession': world.env.auth }
  const template = compileTemplate({ id: 'execution-run-default-tenant', filename: componentLocation.pathname,
    source: parsed.descriptor.template.content, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const forbiddenTimer = () => { world.unexpected.push('timer'); throw Error('DEFAULT_TENANT_FORBIDS_POLLING') }
  const component = new Function('Vue', 'modules', 'crypto', 'window', 'localStorage', 'sessionStorage', 'URL',
    'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', bindImports(script.content, modules).replace('export default', 'return'))(
    vue, modules, webcrypto, world.env.window, world.env.local, world.env.session, world.env.urls,
    forbiddenTimer, forbiddenTimer, forbiddenTimer, forbiddenTimer)
  component.render = new Function('Vue', bindImports(template.code, {}).replace('export function render', 'return function render'))(vue)
  return component
}
function renderer() {
  return vue.createRenderer({
    createElement: tag => ({ tag, tagName: tag.toUpperCase(), children: [], parent: null, events: {}, pauseCount: 0, loadCount: 0,
      pause() { this.pauseCount++ }, load() { this.loadCount++ }, removeAttribute(name) { delete this[name] },
      addEventListener(name, fn) { this.events[name] = fn }, removeEventListener(name) { delete this.events[name] },
      get options() { return this.children.filter(node => node.tag === 'option') } }),
    createText: text => ({ text, parent: null }), createComment: comment => ({ comment, parent: null }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _old, value) => { node[key] = value }, parentNode: node => node.parent,
    nextSibling: node => { const siblings = node.parent?.children || []; return siblings[siblings.indexOf(node) + 1] || null },
    insert(node, target, anchor = null) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = target; const index = target.children.indexOf(anchor)
      if (index < 0) target.children.push(node); else target.children.splice(index, 0, node)
    },
    remove(node) { if (node.parent) { node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null } },
  })
}
function nodes(node, predicate) { return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => nodes(child, predicate))] }
function text(node) { return [node.text || '', ...(node.children || []).map(text)].join(' ') }
function button(h, label) {
  const found = nodes(h.root, node => node.tag === 'button' && text(node).trim() === label)
  assert.equal(found.length, 1, `real rendered button must exist once: ${label}`)
  return found[0]
}
function scenario(t, { selectedTenant = null, hasRun = false } = {}) {
  const world = { env: environment(selectedTenant), fixture: fixture(), calls: [], unexpected: [], confirmationHash: digest('7'),
    pending: [], waits: [], mounts: [], lifecycleErrors: [] }
  world.server = run(world.fixture)
  world.handlers = {
    getProject: async () => project(),
    listExecutionRuns: async () => ({ version_id: 10, current_run_id: hasRun ? 20 : null, runs: hasRun ? [clone(world.server)] : [] }),
    getExecutionRun: async () => clone(world.server), getExecutionRunReadiness: async (_v, _r, output) => readiness(world, output),
  }
  world.api = new Proxy({}, { get: (_target, name) => (...args) => {
    world.calls.push({ name, args, localAtEntry: world.env.local.snapshot(), storageAtEntry: world.env.session.snapshot() })
    if (!Object.hasOwn(world.handlers, name)) {
      world.unexpected.push(name); return Promise.reject(Error(`DEFAULT_TENANT_FORBIDS_API_${String(name)}`))
    }
    try { return Promise.resolve(world.handlers[name](...args)) } catch (error) { return Promise.reject(error) }
  } })
  world.allowCreate = handler => { world.handlers.createExecutionRun = handler || (async () => { hasRun = true; return clone(world.server) }) }
  world.allowAdvance = handler => { world.handlers.advanceExecutionRun = handler || (async () => receipt()) }
  world.defer = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no }), wait = { promise, resolve, reject }
    world.waits.push(wait); return wait
  }
  world.evaluate = () => compile(world)
  world.mount = (component = world.evaluate()) => {
    const props = vue.reactive(clone(world.fixture)), root = { children: [] }
    const app = renderer().createApp({ setup: () => () => vue.h(component, props) })
    app.component('el-button', { props: ['disabled', 'loading'],
      setup: (value, { attrs, slots }) => () => vue.h('button', { ...attrs, disabled: value.disabled }, slots.default?.()) })
    app.config.warnHandler = message => { world.lifecycleErrors.push(message) }
    app.config.errorHandler = error => { world.lifecycleErrors.push(String(error?.stack || error)) }
    app.mount(root)
    const instance = app._instance.subTree.component
    assert.ok(instance?.isMounted && instance.type === component, 'mount must instantiate the real compiled Run component')
    let disposed = false
    const h = { root, props, instance, state: instance.setupState,
      invoke(name, ...args) {
        assert.equal(typeof h.state[name], 'function', `real Run action must exist: ${name}`)
        const pending = Promise.resolve(h.state[name](...args)); world.pending.push(pending); return pending
      },
      click(label) {
        const node = button(h, label); assert.equal(Boolean(node.disabled), false, `${label} must be available to the user`)
        const pending = Promise.resolve(node.onClick()); world.pending.push(pending); return pending
      },
      dispose() { if (!disposed) { disposed = true; app.unmount() } },
    }
    world.mounts.push(h); return h
  }
  t.after(async () => {
    world.mounts.forEach(h => h.dispose()); world.waits.forEach(wait => wait.resolve(null))
    await Promise.allSettled(world.pending); await flush()
    assert.deepEqual(world.unexpected, [], 'unexpected API/timer calls cannot be hidden by application catches')
    assert.deepEqual(world.lifecycleErrors, [], 'Vue warnings and lifecycle exceptions cannot pass silently')
    assert.deepEqual(world.env.writes, [], 'product must not write auth or tenant selection into localStorage')
    assert.equal([...world.env.listeners.values()].reduce((sum, value) => sum + value.size, 0), 0, 'owned listeners must be removed on actual unmount')
  })
  return world
}
const posts = world => world.calls.filter(call => !/^(get|list)/.test(call.name))
const calls = (world, name) => world.calls.filter(call => call.name === name)
const operations = world => Object.entries(world.env.session.snapshot()).map(([key, raw]) => ({ key, raw, value: JSON.parse(raw) }))
async function noWrites(h, world) {
  const before = posts(world).length
  for (const name of ['createRun', 'confirmAction', 'advanceRun', 'pauseRun', 'resumeRun']) await h.invoke(name)
  await h.invoke('recoverAttempt', 30); await h.invoke('reviewCandidate', 'approved'); await h.invoke('reviewCandidate', 'rejected')
  assert.equal(posts(world).length, before, 'every direct mutation handler must enforce the unresolved owner gate')
}
async function resolveOwner(world, h) {
  await h.click('刷新执行记录'); await flush()
  assert.equal(calls(world, 'getProject').length, 1, 'one explicit read must obtain the current project owner proof')
  assert.deepEqual(calls(world, 'getProject')[0].args, [5], 'existing getProject takes the project ID only, not invented tenant/header input')
  assert.equal(h.state.contextReady, true); assert.equal(h.state.listLoaded, true)
  assert.equal(world.env.auth.readCurrentTenantId(), null)
}
async function chooseAndQuote(world, h) {
  await h.invoke('selectRun', 20)
  assert.equal(h.state.currentRun, true)
  h.state.selectedResolution = '720p'; h.state.selectedAspectRatio = '16:9'
  await h.invoke('loadReadiness'); await flush()
  assert.equal(h.state.validReadiness, true)
  assert.match(text(h.root), /本次预计扣除 12 积分/)
}
function queuedOwnerABA(env, dimension) {
  const key = dimension === 'user' ? sessionKey : tenantKey, before = env.local.getItem(key)
  env.writeFixture(() => {
    if (dimension === 'user') env.auth.saveSession({ token: 'synthetic-token-b', user: { id: 'user-b' } })
    else env.auth.saveCurrentTenantId('selected-team-b')
  })
  const middle = env.local.getItem(key)
  env.writeFixture(() => { env.auth.saveSession({ token: 'synthetic-token-a', user: { id: 'user-a' } }); env.auth.saveCurrentTenantId(null) })
  assert.equal(env.local.getItem(key), before, 'storage has returned to A before delayed storage events are delivered')
  env.window.dispatch('storage', { key, oldValue: before, newValue: middle, storageArea: env.local })
  env.window.dispatch('storage', { key, oldValue: middle, newValue: before, storageArea: env.local })
}
function invalidate(h, world, kind) {
  if (kind === 'user' || kind === 'tenant') queuedOwnerABA(world.env, kind)
  else if (kind === 'project') { h.props.projectPolicy.project_id = 6; h.props.projectPolicy.project_id = 5 }
  else if (kind === 'policy_epoch') h.props.projectPolicy.epoch += 2
  else if (kind === 'version') { h.props.record.version_id = 11; h.props.record.version_id = 10 }
  else if (kind === 'unmount') h.dispose()
  else throw Error(`unknown fixture invalidation: ${kind}`)
}

test('first login has no inferred tenant, no implicit API and no writes, but the real refresh button is usable', async t => {
  const world = scenario(t), h = world.mount(), before = world.env.local.snapshot()
  await flush()
  assert.equal(world.env.auth.readCurrentTenantId(), null); assert.deepEqual(world.calls, [])
  assert.equal(h.state.contextReady, false); assert.equal(h.state.canCreate, false); assert.equal(h.state.canAdvance, false)
  await noWrites(h, world)
  assert.deepEqual(world.calls, []); assert.deepEqual(world.env.local.snapshot(), before)
  assert.equal(Boolean(button(h, '刷新执行记录').disabled), false, 'missing selection cannot make the explicit owner-proof read unreachable')
})

test('current server project proof enables explicit create, quote, confirmation and one advance without a tenant selection write', async t => {
  const world = scenario(t), h = world.mount(), before = world.env.local.snapshot()
  world.allowCreate(); world.allowAdvance()
  await resolveOwner(world, h)
  assert.deepEqual(world.calls.map(call => call.name), ['getProject', 'listExecutionRuns'])
  assert.equal(posts(world).length, 0); assert.equal(h.state.canCreate, true)
  await h.click('创建执行记录（不生成）'); await flush()
  assert.deepEqual(posts(world).map(call => call.name), ['createExecutionRun'])
  assert.deepEqual(posts(world)[0].args, [10, { expected_plan_hash: digest('a'), expected_queue_id: 8 }])
  await chooseAndQuote(world, h)
  assert.equal(h.state.canAdvance, false); await h.invoke('advanceRun'); assert.equal(posts(world).length, 1)
  await h.invoke('confirmAction'); assert.equal(h.state.canAdvance, true)
  await h.click('确认并推进一次'); await h.invoke('advanceRun'); await flush()
  assert.deepEqual(posts(world).map(call => call.name), ['createExecutionRun', 'advanceExecutionRun'])
  assert.deepEqual(posts(world)[1].args, [10, 20, { expected_revision: 0, expected_plan_hash: digest('a'),
    expected_quote_hash: digest('6'), expected_confirmation_hash: digest('7'), output_parameters: { resolution: '720p', aspect_ratio: '16:9' } }])
  const entered = Object.values(posts(world)[1].storageAtEntry).map(raw => JSON.parse(raw)).find(item => item.action === 'advance')
  assert.equal(entered.status, 'pending')
  assert.deepEqual(JSON.parse(entered.scope), [[defaultTenant, 'user-a'], 5, 1, 10, 4, 8, digest('a')])
  assert.equal(JSON.stringify(operations(world)).includes('synthetic-token'), false)
  assert.deepEqual(world.env.local.snapshot(), before); assert.equal(calls(world, 'getProject').length, 1)
  const count = world.calls.length; await flush(); assert.equal(world.calls.length, count, 'proof publication cannot trigger a watch-driven GET loop')
})

test('two immediate refresh invocations share one in-flight project proof and never submit', async t => {
  const world = scenario(t), h = world.mount(), wait = world.defer()
  world.handlers.getProject = () => wait.promise
  const first = h.invoke('refreshRuns'), second = h.invoke('refreshRuns'); await flush()
  assert.equal(calls(world, 'getProject').length, 1); assert.equal(calls(world, 'listExecutionRuns').length, 0)
  assert.equal(h.state.contextReady, false); assert.equal(Boolean(button(h, '刷新执行记录').disabled), true)
  await noWrites(h, world)
  wait.resolve(project()); await Promise.all([first, second]); await flush()
  assert.equal(calls(world, 'getProject').length, 1); assert.equal(calls(world, 'listExecutionRuns').length, 1)
  assert.equal(h.state.contextReady, true); assert.equal(posts(world).length, 0)
})

for (const invalid of ['missing_tenant', 'empty_tenant', 'whitespace_tenant', 'object_tenant', 'other_tenant',
  'missing_user', 'other_user', 'object_user', 'wrong_project', 'string_project', 'null_response', 'array_response']) {
  test(`project proof ${invalid} is rejected without reading execution DTOs or posting`, async t => {
    const world = scenario(t), h = world.mount(), value = project()
    if (invalid === 'missing_tenant') delete value.tenant_id
    if (invalid === 'empty_tenant') value.tenant_id = ''
    if (invalid === 'whitespace_tenant') value.tenant_id = ' '
    if (invalid === 'object_tenant') value.tenant_id = { id: defaultTenant }
    if (invalid === 'other_tenant') value.tenant_id = 'different-default-owner'
    if (invalid === 'missing_user') delete value.user_id
    if (invalid === 'other_user') value.user_id = 'user-b'
    if (invalid === 'object_user') value.user_id = { id: 'user-a' }
    if (invalid === 'wrong_project') value.id = 6
    if (invalid === 'string_project') value.id = '5'
    world.handlers.getProject = async () => invalid === 'null_response' ? null : invalid === 'array_response' ? [value] : value
    await h.invoke('refreshRuns'); await flush()
    assert.deepEqual(world.calls.map(call => call.name), ['getProject'], 'negative proof must actually reach the explicit server-project boundary')
    assert.equal(h.state.contextReady, false); assert.equal(h.state.listLoaded, false); assert.ok(h.state.error)
    await noWrites(h, world); await h.invoke('selectRun', 20); await h.invoke('loadReadiness'); await h.invoke('loadCandidate', 'unit-1')
    assert.equal(world.calls.length, 1); assert.equal(world.env.auth.readCurrentTenantId(), null)
  })
}

test('a stale team plan cannot supply the missing tenant even when its review and queue agree', async t => {
  const world = scenario(t)
  world.fixture.preview.bindings.tenant_id = 'old-team-tenant'; world.fixture.savedReview.plan = clone(world.fixture.preview)
  const h = world.mount()
  await h.invoke('refreshRuns'); await flush()
  assert.deepEqual(world.calls.map(call => call.name), ['getProject'])
  assert.equal(h.state.contextReady, false); await noWrites(h, world)
  assert.equal(world.env.auth.readCurrentTenantId(), null)
})

for (const invalid of ['no_session', 'missing_user_id', 'missing_token', 'invalid_policy', 'blocked']) {
  test(`${invalid} does not enable the owner-proof GET or any mutation`, async t => {
    const world = scenario(t)
    if (invalid === 'no_session') world.env.writeFixture(() => world.env.auth.clearSession())
    if (invalid === 'missing_user_id') world.env.writeFixture(() => world.env.local.setItem(sessionKey, JSON.stringify({ token: 'synthetic-token-a', user: {} })))
    if (invalid === 'missing_token') world.env.writeFixture(() => world.env.local.setItem(sessionKey, JSON.stringify({ user: { id: 'user-a' } })))
    if (invalid === 'invalid_policy') world.fixture.projectPolicy = { project_id: 5, execution_mode: 'safe', policy_version: 0, epoch: 1 }
    if (invalid === 'blocked') world.fixture.blocked = true
    const h = world.mount(); await flush()
    assert.equal(Boolean(button(h, '刷新执行记录').disabled), true)
    await h.invoke('refreshRuns'); await noWrites(h, world); assert.deepEqual(world.calls, [])
  })
}

for (const outcome of ['rejected', 'not_found', 'timeout']) {
  test(`owner proof ${outcome} stops until another explicit read, never retries or submits`, async t => {
    const world = scenario(t), h = world.mount()
    world.handlers.getProject = async () => { throw Object.assign(Error('synthetic project read failure'),
      outcome === 'not_found' ? { response: { status: 404 } } : outcome === 'timeout' ? { code: 'ECONNABORTED' } : {}) }
    await h.invoke('refreshRuns'); await flush()
    assert.deepEqual(world.calls.map(call => call.name), ['getProject']); assert.equal(h.state.contextReady, false)
    assert.ok(h.state.error); await noWrites(h, world); await flush(); assert.equal(world.calls.length, 1)
    world.handlers.getProject = async () => project()
    await h.click('刷新执行记录'); await flush()
    assert.deepEqual(world.calls.map(call => call.name), ['getProject', 'getProject', 'listExecutionRuns'])
    assert.equal(h.state.contextReady, true); assert.equal(posts(world).length, 0)
  })
}

for (const kind of ['user', 'tenant', 'project', 'policy_epoch', 'version', 'unmount']) {
  test(`late project proof after ${kind} invalidation cannot create a usable owner or begin listing`, async t => {
    const world = scenario(t), h = world.mount(), wait = world.defer()
    world.handlers.getProject = () => wait.promise
    const pending = h.invoke('refreshRuns'); await flush()
    assert.equal(calls(world, 'getProject').length, 1, 'the proof read must enter before invalidation')
    invalidate(h, world, kind); wait.resolve(project()); await pending; await flush()
    assert.equal(calls(world, 'listExecutionRuns').length, 0); assert.equal(h.state.contextReady, false)
    await noWrites(h, world); assert.equal(posts(world).length, 0)
    assert.equal(world.env.auth.readCurrentTenantId(), null)
  })
}

for (const kind of ['user', 'tenant', 'project', 'policy_epoch']) {
  test(`an acquired default owner is revoked after ${kind} ABA and requires an explicit fresh proof`, async t => {
    const world = scenario(t, { hasRun: true }), h = world.mount()
    await resolveOwner(world, h); await chooseAndQuote(world, h); await h.invoke('confirmAction')
    assert.equal(h.state.canAdvance, true)
    const count = world.calls.length
    invalidate(h, world, kind); await flush()
    assert.equal(h.state.contextReady, false); assert.equal(h.state.confirmation, null); assert.equal(world.calls.length, count)
    await noWrites(h, world)
    await h.click('刷新执行记录'); await flush()
    assert.equal(calls(world, 'getProject').length, 2); assert.equal(h.state.contextReady, true)
    assert.equal(h.state.canAdvance, false); assert.equal(posts(world).length, 0)
  })
}

test('late failed proof cannot clear a newer successful visit or its create eligibility', async t => {
  const world = scenario(t), h = world.mount(), old = world.defer()
  world.handlers.getProject = () => old.promise
  const pending = h.invoke('refreshRuns'); await flush()
  assert.equal(calls(world, 'getProject').length, 1)
  invalidate(h, world, 'project'); world.handlers.getProject = async () => project()
  await h.invoke('refreshRuns'); await flush()
  assert.equal(calls(world, 'getProject').length, 2); assert.equal(h.state.canCreate, true)
  old.reject(Error('synthetic stale A failure')); await pending; await flush()
  assert.equal(h.state.contextReady, true); assert.equal(h.state.canCreate, true); assert.equal(h.state.error, '')
  assert.equal(calls(world, 'listExecutionRuns').length, 1); assert.equal(posts(world).length, 0)
})

for (const phase of ['pending_proof', 'confirmed']) {
  test(`same-user token refresh in ${phase} preserves the owner visit without additional GET or storage writes`, async t => {
    const world = scenario(t, { hasRun: true }), h = world.mount(), wait = world.defer()
    let pending
    if (phase === 'pending_proof') {
      world.handlers.getProject = () => wait.promise; pending = h.invoke('refreshRuns'); await flush()
      assert.equal(calls(world, 'getProject').length, 1)
    } else { await resolveOwner(world, h); await chooseAndQuote(world, h); await h.invoke('confirmAction'); assert.equal(h.state.canAdvance, true) }
    const before = world.env.local.getItem(sessionKey), count = world.calls.length
    world.env.writeFixture(() => world.env.auth.saveSession({ token: 'synthetic-token-refreshed', user: { id: 'user-a' } }))
    world.env.window.dispatch('storage', { key: sessionKey, oldValue: before, newValue: world.env.local.getItem(sessionKey), storageArea: world.env.local })
    world.env.window.dispatch('focus', { type: 'focus' }); await flush()
    assert.equal(world.calls.length, count)
    if (phase === 'pending_proof') { wait.resolve(project()); await pending; await flush(); assert.equal(calls(world, 'listExecutionRuns').length, 1) }
    else assert.equal(h.state.canAdvance, true, 'an auth token refresh for the same user does not change the owner scope')
    assert.equal(h.state.contextReady, true); assert.equal(calls(world, 'getProject').length, 1)
    assert.equal(world.env.auth.readCurrentTenantId(), null); assert.equal(posts(world).length, 0)
  })
}

test('explicit selected tenant retains the existing list/create path with zero project-proof GET', async t => {
  const world = scenario(t, { selectedTenant: defaultTenant }), h = world.mount(), local = world.env.local.snapshot()
  delete world.handlers.getProject
  world.allowCreate(); await flush(); assert.equal(h.state.contextReady, true); assert.equal(world.calls.length, 0)
  await h.click('刷新执行记录'); await h.click('创建执行记录（不生成）'); await flush()
  assert.deepEqual(world.calls.map(call => call.name), ['listExecutionRuns', 'createExecutionRun'])
  assert.equal(h.state.run.id, 20); assert.deepEqual(world.env.local.snapshot(), local)
})

for (const action of ['create', 'advance']) for (const outcome of ['pending', 'unknown']) {
  test(`default-owner ${action} ${outcome} retains its original durable scope through selection ABA and module reload`, async t => {
    const world = scenario(t, { hasRun: action === 'advance' }), h = world.mount(), wait = world.defer()
    if (action === 'create') world.allowCreate(() => wait.promise); else world.allowAdvance(() => wait.promise)
    await resolveOwner(world, h)
    if (action === 'advance') { await chooseAndQuote(world, h); await h.invoke('confirmAction') }
    const method = action === 'create' ? 'createRun' : 'advanceRun', pending = h.invoke(method); await flush()
    assert.equal(posts(world).length, 1)
    if (outcome === 'unknown') { wait.reject(Error('synthetic submit result unknown')); await pending; await flush() }
    const original = operations(world).find(item => item.value.action === action)
    assert.ok(original); assert.equal(original.value.status, outcome)
    assert.deepEqual(JSON.parse(original.value.scope)[0], [defaultTenant, 'user-a'])
    queuedOwnerABA(world.env, 'tenant'); h.dispose(); await flush()
    const before = world.calls.length, reloaded = world.mount(world.evaluate()); await flush()
    assert.equal(world.calls.length, before, 'fresh module never implicitly resolves, retries or submits')
    await reloaded.invoke('refreshRuns'); await flush(); assert.equal(calls(world, 'getProject').length, 2)
    if (action === 'advance') {
      world.confirmationHash = digest('8'); await chooseAndQuote(world, reloaded); await reloaded.invoke('confirmAction')
      assert.equal(reloaded.state.canAdvance, false)
    } else assert.equal(reloaded.state.canCreate, false)
    await reloaded.invoke(method); await flush(); assert.equal(posts(world).length, 1)
    assert.deepEqual(operations(world).find(item => item.key === original.key), original, 'proof refresh does not migrate or release an existing pending/unknown intent')
    assert.equal(world.env.auth.readCurrentTenantId(), null)
    if (outcome === 'pending') { wait.resolve(action === 'create' ? clone(world.server) : receipt()); await pending }
  })
}

test('removing an explicit tenant cannot reuse its old identity; the original unknown operation key survives proof resolution', async t => {
  const world = scenario(t, { selectedTenant: defaultTenant, hasRun: true }), h = world.mount()
  world.allowAdvance(async () => { throw Error('synthetic response lost') })
  await h.invoke('refreshRuns'); await chooseAndQuote(world, h); await h.invoke('confirmAction'); await h.invoke('advanceRun')
  assert.equal(posts(world).length, 1); const original = operations(world)[0]
  const before = world.env.local.getItem(tenantKey)
  world.env.writeFixture(() => world.env.auth.saveCurrentTenantId(null))
  world.env.window.dispatch('storage', { key: tenantKey, oldValue: before, newValue: null, storageArea: world.env.local }); await flush()
  assert.equal(h.state.contextReady, false); await noWrites(h, world); assert.equal(calls(world, 'getProject').length, 0)
  await h.invoke('refreshRuns'); await chooseAndQuote(world, h); await h.invoke('confirmAction'); await h.invoke('advanceRun')
  assert.equal(calls(world, 'getProject').length, 1); assert.equal(posts(world).length, 1)
  assert.deepEqual(operations(world)[0], original)
})

test('default owner proof does not bypass candidate watch/listen controls, and owner invalidation revokes its media', async t => {
  const world = scenario(t, { hasRun: true }), h = world.mount()
  const bytes = new TextEncoder().encode('synthetic bytes only; not a decodable MP4 or actual human acceptance')
  world.server.status = 'waiting_review'; world.server.revision = 6
  world.server.units[0].status = 'waiting_review'; world.server.units[0].attempts = [{ id: 30, status: 'waiting_review' }]
  const candidate = { schema_version: 'redraw-execution-unit-candidate-review-v1', run_id: 20, run_revision: 6,
    unit_id: 'unit-1', ordinal: 0, attempt_id: 30, status: 'waiting_review', candidate_hash: digest('c'),
    asset: { id: 50, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mime_type: 'video/mp4',
      duration_ms: 5000, width: 720, height: 1280, video_codec: 'h264', audio_codec: 'aac' },
    required_checks: ['character_identity'], review: null, review_policy: { execution_mode: 'safe', policy_version: 2, human_required: true },
    technical_qa: { method: 'ffprobe', status: 'passed' }, content_qa: { machine_evidence: 'not_available', final_audio_review: 'not_composed' },
    target_contract: { character_name_map: { 'character-1': 'Maya' }, dialogues: [], shots: [] } }
  world.handlers.getExecutionUnitCandidate = async () => clone(candidate)
  world.handlers.getExecutionUnitCandidateMedia = async () => new Blob([bytes], { type: 'video/mp4' })
  await resolveOwner(world, h); await h.invoke('selectRun', 20); await h.invoke('loadCandidate', 'unit-1'); await flush()
  assert.equal(calls(world, 'getExecutionUnitCandidate').length, 1); assert.equal(calls(world, 'getExecutionUnitCandidateMedia').length, 1)
  assert.equal(h.state.canApproveCandidate, false); assert.equal(h.state.canRejectCandidate, false)
  await h.invoke('reviewCandidate', 'approved'); assert.equal(posts(world).length, 0)
  const player = nodes(h.root, node => node.tag === 'video')[0]; assert.ok(player)
  await h.invoke('candidateLoaded', { currentTarget: player })
  await h.invoke('setReviewCheck', 'character_identity', 'passed'); await h.invoke('acknowledgeReview', true); await flush()
  assert.equal(h.state.canApproveCandidate, true, 'only synthetic loaded + explicit test interactions enable the existing review control')
  queuedOwnerABA(world.env, 'user'); await flush()
  assert.equal(h.state.contextReady, false); assert.equal(h.state.candidate, null); assert.equal(h.state.canApproveCandidate, false)
  assert.equal(player.pauseCount, 1); assert.equal(player.loadCount, 1); assert.equal(world.env.revoked.length, 1)
  await noWrites(h, world); assert.equal(posts(world).length, 0)
})
