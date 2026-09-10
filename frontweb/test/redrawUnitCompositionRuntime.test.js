import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Mount the actual Release SFC. Only its existing transport and browser boundaries
// are synthetic; its five proof GETs, template events and lifecycle remain real.
// These tests do not establish HTTP, a browser, media or final delivery acceptance.
const source = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const releaseSource = source('../src/components/redraw/RedrawEpisodeReleasePanel.vue')
const authSource = source('../src/utils/authSession.js')
const timelineSource = source('../src/utils/redrawTimelineState.js')
const clone = value => JSON.parse(JSON.stringify(value))
const sha = value => createHash('sha256').update(value).digest('hex')
const digest = character => character.repeat(64)
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const compositionSchema = 'redraw-execution-unit-composition-v1'
const releaseSchema = 'redraw-execution-unit-release-v1'
const composeLabel = '合成此执行记录（一次提交）'
const recoverLabel = '只读核对原合成'
const proofNames = ['getLocalization', 'getExecutionPlanReview', 'getExecutionQueue', 'listExecutionRuns', 'getExecutionRun']
const stamp = '2026-09-09T00:00:00.000Z'
async function flush() { for (let index = 0; index < 24; index++) { await vue.nextTick(); await Promise.resolve() } }

function pureModule(text) {
  assert.doesNotMatch(text, /^import\s/m, 'real state helpers must remain import-free')
  const names = [...text.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1])
  assert.ok(names.length)
  return new Function(text.replace(/^export /gm, '') + `\nreturn {${names.join(',')}}`)()
}
const timeline = pureModule(timelineSource)

function fixture(audioMode = 'native') {
  const units = [0, 1].map(index => ({ id: `unit-${index + 1}`, source_start_ms: index * 5000, source_end_ms: (index + 1) * 5000,
    parent_shots: [{ id: `shot-${index + 1}`, contract_hash: digest('6'), source_start_ms: index * 5000,
      source_end_ms: (index + 1) * 5000, unit_start_ms: 0, unit_end_ms: 5000 }],
    retained_duration_ms: 5000, generated_duration_ms: 5000, padding_ms: 0,
    dialogues: audioMode === 'not_required' ? [] : [{ id: `dialogue-${index + 1}`, start_ms: index * 5000 + 500,
      end_ms: index * 5000 + 1500, source_text: '等等我。', target_text: 'Wait for me.', evidence_ref: `audio-${index + 1}`,
      evidence_sha256: digest('7'), estimated_duration_ms: 1000, unit_start_ms: 500, unit_end_ms: 1500 }],
    reference_requirements: [{ id: `motion-${index + 1}`, kind: 'video', requirement_hash: digest('8') }] }))
  const preview = { schema_version: 'redraw-execution-plan-preview-v1', status: 'ready', executable: false,
    plan_hash: digest('a'), bindings: { tenant_id: 'tenant-a', user_id: 'user-a', work_id: 1, version_id: 10,
      source_asset_id: 101, source_sha256: digest('d'), blueprint_hash: digest('b'), localization_hash: digest('c'),
      capability_hash: digest('e'), localization_updated_at: stamp, locale: 'en', market: 'US' },
    units, blocking_reasons: [], execution_blockers: ['PREVIEW_ONLY'],
    capability: { model: 'synthetic-unit-model', audio_mode: audioMode, resolutions: ['720p'], aspect_ratios: ['16:9'] } }
  const review = { id: 4, status: 'current', saved_at: stamp, plan_hash: preview.plan_hash, plan: clone(preview) }
  const queue = { id: 8, version_id: 10, work_id: 1, status: 'waiting_readiness', executable: false,
    plan_hash: preview.plan_hash, execution_blockers: ['PREVIEW_ONLY'], created_at: stamp,
    units: units.map((unit, ordinal) => ({ id: unit.id, ordinal, status: 'pending', unit_hash: sha(stable(unit)), plan_unit: clone(unit) })) }
  const run = { id: 21, work_id: 1, version_id: 10, queue_id: 8, review_id: 4, plan_hash: preview.plan_hash,
    status: 'completed', binding_status: 'current', pause_requested: false, revision: 7, executable: false,
    output_parameters: { resolution: '720p', aspect_ratio: '16:9' }, created_at: stamp, updated_at: stamp,
    units: queue.units.map((unit, index) => ({ id: unit.id, ordinal: index, unit_hash: unit.unit_hash, status: 'approved',
      attempts: [{ id: 30 + index, attempt_no: 1, status: 'approved', created_at: stamp, updated_at: stamp }] })),
    execution_blockers: ['PREVIEW_ONLY', 'EXECUTION_RUN_STORAGE_ONLY'] }
  const dialogueMap = units.flatMap(unit => unit.dialogues.map(dialogue => ({ source_dialogue_id: dialogue.id,
    shot_id: unit.parent_shots[0].id, speaker_id: 'character-1', speaker_kind: 'character', source_text: dialogue.source_text,
    target_text: dialogue.target_text, start_ms: dialogue.start_ms, end_ms: dialogue.end_ms,
    estimated_duration_ms: dialogue.estimated_duration_ms, estimated_speech_rate: 12, emotion: '平静', pronunciation_hint: '' })))
  const localization = { work_id: 1, version_id: 10, version: 1, status: 'review', locale: 'en', market: 'US',
    blueprint_hash: digest('b'), localization_hash: digest('c'), updated_at: stamp,
    localization: { schema_version: 'episode-localization-v1', blueprint_hash: digest('b'), localization_hash: digest('c'),
      locale: 'en', market: 'US', character_name_map: { 'character-1': 'Maya' }, dialogue_map: dialogueMap, text_region_map: [],
      cultural_adaptations: [], glossary: [], locked_terms: [], review: { status: 'review', updated_at: stamp,
        character_name_map: { 'character-1': true }, dialogue_map: Object.fromEntries(dialogueMap.map(item => [item.source_dialogue_id, true])),
        text_region_map: {}, cultural_adaptations: {}, glossary: {}, locked_terms: {} } } }
  return { preview, review, queue, run, localization }
}

function propsFor(value) {
  return { versionId: value.run.version_id, unitMode: true, refreshToken: 0,
    unitIntent: { run_id: value.run.id, version_id: value.run.version_id, plan_hash: value.run.plan_hash, run_revision: value.run.revision },
    // This is the already verified upstream context, not a bypass for Release's own proof.
    unitContext: { owner: ['tenant-a', 'user-a'], project_id: 5, work_id: 1, version_id: 10,
      policy: { project_id: 5, execution_mode: 'safe', policy_version: 2, epoch: 0 } } }
}

// Authoritative wire identity: routes/redraw.js executionUnitExportKeySha256.
// It hashes these release-v1 keys in this order, not the POST composition body.
function originalRequest(version, body) {
  return { expected_plan_hash: body.expected_plan_hash, expected_run_revision: body.expected_run_revision,
    run_id: body.run_id, schema_version: releaseSchema, version_id: version }
}
function exportRow(version, body, overrides = {}) {
  return { id: 401, version_id: version, export_type: 'video', version_number: 1, status: 'pending',
    schema_version: compositionSchema, asset_id: null, subtitle_asset_id: null, project_asset_id: null,
    request_hash: sha(JSON.stringify(originalRequest(version, body))), idempotency_key_sha256: sha(body.idempotency_key),
    run_id: body.run_id, plan_hash: body.expected_plan_hash, audio_mode: null, input_hash: null,
    error_code: null, error_message: null, created_at: stamp, updated_at: stamp, ...overrides }
}

function memoryStorage(events, label) {
  const values = new Map()
  const store = { failRead: false, failWrite: false, failAfterWrite: false,
    get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem(key) { if (store.failRead) throw Error('synthetic storage read denied'); return values.get(key) ?? null },
    setItem(key, value) {
      events.push({ kind: `${label}:set`, key, value: String(value) })
      if (store.failWrite) throw Error('synthetic storage write denied before save')
      values.set(key, String(value))
      if (store.failAfterWrite) throw Error('synthetic ambiguous storage save')
    },
    removeItem(key) { events.push({ kind: `${label}:remove`, key }); values.delete(key) },
    snapshot: () => Object.fromEntries(values),
    seed: (key, value) => values.set(key, String(value)),
  }
  return store
}

const importPattern = /^import[ \t]+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"\r\n]+)\2[ \t]*;?[ \t]*(?:\r?\n|$)/gm
function bindImports(text, modules) {
  const body = text.replace(importPattern, (_whole, names, _quote, specifier) => {
    if (specifier === 'vue') {
      assert.ok(names.startsWith('{'))
      return `const ${names.replace(/\s+as\s+/g, ':')} = Vue;\n`
    }
    assert.ok(Object.hasOwn(modules, specifier), `unapproved SFC import: ${specifier}`)
    return `const ${names.replace(/\s+as\s+/g, ':')} = modules[${JSON.stringify(specifier)}];\n`
  })
  assert.doesNotMatch(body, /^import\s/m, 'unhandled import fails closed')
  return body
}
function compileRelease(world) {
  const { descriptor } = parse(releaseSource), script = compileScript(descriptor, { id: 'unit-composition' })
  const modules = { '@/api/redraw': { redrawAPI: world.api }, '@/utils/authSession': world.auth,
    '@/utils/redrawTimelineState': timeline,
    'vue-router': { useRoute: () => world.route, useRouter: () => ({ replace: () => world.forbid('router.replace') }) } }
  const template = compileTemplate({ id: 'unit-composition', filename: 'RedrawEpisodeReleasePanel.vue',
    source: descriptor.template.content, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const code = bindImports(script.content, modules).replace('export default', 'return')
  const component = new Function('Vue', 'modules', 'crypto', 'window', 'localStorage', 'sessionStorage', 'globalThis',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'AbortController', 'AbortSignal', 'URL', 'document', code)(
    vue, modules, world.crypto, world.window, world.local, world.session, world.globals,
    world.setTimer, world.clearTimer, world.setTimer, world.clearTimer, AbortController, AbortSignal,
    world.urls, world.document)
  component.render = new Function('Vue', bindImports(template.code, {}).replace('export function render', 'return function render'))(vue)
  return component
}
function renderer() {
  return vue.createRenderer({
    createElement: tag => ({ tag, children: [], parent: null }),
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
const nodes = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => nodes(child, predicate))]
const visibleText = node => [node?.text || '', ...(node?.children || []).map(visibleText)].join(' ').replace(/\s+/g, ' ').trim()
const calls = (world, name) => world.calls.filter(call => call.name === name)
const postCalls = world => calls(world, 'composeVersion')
const exportCalls = world => world.calls.filter(call => ['listExports', 'getExport'].includes(call.name))

async function scenario(t, configure = () => {}) {
  const world = { value: fixture(), calls: [], errors: [], events: [], pending: [], waits: [], timers: new Map(),
    hashes: [], uuidCount: 0, hashGate: null }
  world.defer = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no }), wait = { promise, resolve, reject }
    world.waits.push(wait); return wait
  }
  world.forbid = name => { world.errors.push(name); throw Error(`UNIT_COMPOSITION_FORBIDS_${name}`) }
  world.local = memoryStorage(world.events, 'local'); world.session = memoryStorage(world.events, 'session')
  world.session.seed('unrelated-session-record', 'preserve-me')
  assert.doesNotMatch(authSource, /^import\s/m)
  world.auth = new Function('localStorage', 'sessionStorage', authSource.replace(/^export /gm, '')
    + '\nreturn { readSession, readCurrentTenantId, saveSession, saveCurrentTenantId, clearSession }')(world.local, world.session)
  world.auth.saveSession({ token: 'synthetic-token-a', user: { id: 'user-a' } }); world.auth.saveCurrentTenantId('tenant-a')
  world.localBaseline = world.local.snapshot()
  const listeners = new Map()
  world.window = { localStorage: world.local, sessionStorage: world.session,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    dispatch: (name, event) => [...(listeners.get(name) || [])].forEach(fn => fn(event)) }
  world.crypto = {
    randomUUID() { world.uuidCount++; return world.uuid ?? `synthetic-unit-composition-${world.uuidCount}` },
    subtle: { async digest(algorithm, bytes) {
      assert.equal(typeof algorithm === 'string' ? algorithm : algorithm.name, 'SHA-256')
      const input = new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength)
      world.hashes.push(new TextDecoder().decode(input))
      const gate = world.hashGate; world.hashGate = null
      if (gate) await gate.promise
      return Uint8Array.from(createHash('sha256').update(input).digest()).buffer
    } },
  }
  world.document = { createElement: () => world.forbid('document.createElement'), activeElement: null }
  world.urls = { createObjectURL: () => world.forbid('URL.createObjectURL'), revokeObjectURL: () => world.forbid('URL.revokeObjectURL') }
  world.globals = { crypto: world.crypto, localStorage: world.local, sessionStorage: world.session }
  let timerId = 0
  world.setTimer = (callback, delay) => { const id = ++timerId; world.timers.set(id, { callback, delay }); return id }
  world.clearTimer = id => world.timers.delete(id)
  world.runTimers = async () => { for (const item of [...world.timers.values()]) await item.callback(); await flush() }
  world.route = vue.reactive({ params: { projectId: '5', workId: '1' }, query: { step: '4' } })
  world.props = vue.reactive(propsFor(world.value))
  world.handlers = {
    getLocalization: async () => clone(world.value.localization),
    getExecutionPlanReview: async () => ({ preview: clone(world.value.preview), saved_review: clone(world.value.review) }),
    getExecutionQueue: async () => ({ preview: clone(world.value.preview), saved_review: clone(world.value.review), queue: clone(world.value.queue) }),
    listExecutionRuns: async () => ({ version_id: world.value.run.version_id, current_run_id: world.value.run.id, runs: [clone(world.value.run)] }),
    getExecutionRun: async () => clone(world.value.run),
  }
  world.api = new Proxy({}, { get: (_target, name) => (...args) => {
    world.calls.push({ name, args }); world.events.push({ kind: 'api', name })
    if (!Object.hasOwn(world.handlers, name)) {
      world.errors.push(`unapproved API ${String(name)}`); return Promise.reject(Error(`UNAPPROVED_API_${String(name)}`))
    }
    try {
      if (proofNames.includes(name)) {
        assert.equal(args[0], world.value.run.version_id)
        const count = name === 'getExecutionRun' ? 2 : 1
        if (name === 'getExecutionRun') assert.equal(args[1], world.value.run.id)
        assert.ok(args.length === count || (['listExecutionRuns', 'getExecutionRun'].includes(name) && args.length === count + 1))
        if (args.length > count) { assert.deepEqual(Object.keys(args[count]), ['signal']); assert.ok(args[count].signal instanceof AbortSignal) }
      } else if (name === 'composeVersion') {
        assert.equal(args.length, 2); assert.equal(args[0], world.value.run.version_id)
        assert.deepEqual(Object.keys(args[1]).sort(), ['schema_version', 'run_id', 'expected_plan_hash', 'expected_run_revision', 'idempotency_key'].sort())
        assert.equal(args[1].schema_version, compositionSchema); assert.equal(args[1].run_id, world.value.run.id)
        assert.equal(args[1].expected_plan_hash, world.value.run.plan_hash); assert.equal(args[1].expected_run_revision, world.value.run.revision)
        assert.equal(typeof args[1].idempotency_key, 'string'); assert.ok(args[1].idempotency_key.length > 0)
        assert.equal(args[1].idempotency_key, args[1].idempotency_key.trim())
        assert.equal(new TextDecoder().decode(new TextEncoder().encode(args[1].idempotency_key)), args[1].idempotency_key)
      } else if (name === 'listExports') assert.deepEqual(args, [world.value.run.version_id])
      else if (name === 'getExport') { assert.equal(args.length, 1); assert.ok(Number.isSafeInteger(args[0]) && args[0] > 0) }
      else assert.fail(`unapproved handler ${String(name)}`)
    } catch (error) {
      world.errors.push(`${String(name)} arguments: ${error.message}`); return Promise.reject(error)
    }
    return Promise.resolve().then(() => world.handlers[name](...args))
  } })
  world.mount = () => {
    assert.equal(world.app, null, 'remount requires a real unmount')
    world.component = compileRelease(world)
    const app = renderer().createApp({ setup: () => () => vue.h(world.component, world.props) })
    for (const [name, tag] of [['el-button', 'button'], ['el-tag', 'span'], ['el-alert', 'div']]) {
      app.component(name, { props: ['disabled', 'loading', 'title'], setup: (props, { attrs, slots }) => () => vue.h(tag,
        { ...attrs, disabled: props.disabled, loading: props.loading }, [props.title || '', ...(slots.default?.() || [])]) })
    }
    app.config.warnHandler = message => world.forbid(`Vue warning: ${message}`)
    world.root = { children: [] }; world.app = app; app.mount(world.root)
  }
  world.app = null
  world.unmount = () => { world.app?.unmount(); world.app = null }
  world.findButton = label => nodes(world.root, node => node.tag === 'button' && visibleText(node) === label)
  world.button = label => { const found = world.findButton(label); assert.equal(found.length, 1, `one real rendered button: ${label}`); return found[0] }
  world.beginClick = label => {
    const node = world.button(label)
    assert.ok(!node.disabled, `actual button must be enabled: ${label}`); assert.equal(typeof node.onClick, 'function')
    const pending = Promise.resolve(node.onClick({ target: node, currentTarget: node })); world.pending.push(pending); return pending
  }
  world.click = async label => { await world.beginClick(label); await flush() }
  configure(world)
  t.after(async () => {
    world.unmount(); world.waits.forEach(wait => wait.resolve(null)); await Promise.allSettled(world.pending); await flush()
    assert.deepEqual(world.errors, [], 'even caught forbidden API calls and argument failures must fail teardown')
    assert.equal(world.timers.size, 0, 'no automatic polling or retry timers survive')
    assert.equal(world.session.snapshot()['unrelated-session-record'], 'preserve-me', 'use an independent sessionStorage slot')
    assert.deepEqual(world.local.snapshot(), world.localBaseline, 'unit composition must not write localStorage or auth')
    assert.deepEqual(world.events.filter(event => event.kind === 'session:remove'), [], 'original intent must never be automatically deleted')
  })
  world.mount(); await flush(); return world
}

function assertProof(world) {
  assert.deepEqual(world.calls.slice(0, 5).map(call => call.name), proofNames, 'Release itself must execute all five ordered GETs')
  assert.match(visibleText(world.root), /绑定已核验/)
}
function assertNoArtifacts(world) {
  const dangerous = nodes(world.root, node => node.tag === 'button' && /下载|生成.*配音|创建整集 release/.test(visibleText(node)))
  assert.ok(dangerous.every(node => node.disabled), 'this slice must not enable download, legacy release or TTS')
  assert.equal(nodes(world.root, node => ['video', 'audio', 'a'].includes(node.tag)).length, 0)
  assert.doesNotMatch(visibleText(world.root), /成片已完成|最终质量通过|四文件已核验|可发布/)
}
function intentEntry(world) {
  const entries = Object.entries(world.session.snapshot()).filter(([key]) => key !== 'unrelated-session-record')
  assert.equal(entries.length, 1, 'one independent persisted original intent')
  return { key: entries[0][0], raw: entries[0][1], value: JSON.parse(entries[0][1]) }
}
function fieldValues(value, key) {
  if (!value || typeof value !== 'object') return []
  return [...(Object.hasOwn(value, key) ? [value[key]] : []), ...Object.values(value).flatMap(item => fieldValues(item, key))]
}
function assertSavedOriginal(world) {
  const entry = intentEntry(world), post = postCalls(world)[0]
  assert.ok(post)
  const [version, body] = post.args
  for (const [key, value] of Object.entries({ idempotency_key: body.idempotency_key,
    request_hash: sha(JSON.stringify(originalRequest(version, body))), idempotency_key_sha256: sha(body.idempotency_key) })) {
    assert.deepEqual(fieldValues(entry.value, key), [value], `original intent preserves exact ${key}`)
  }
  const context = world.props.unitContext
  for (const [key, value] of Object.entries({ project_id: context.project_id, work_id: context.work_id,
    version_id: version, run_id: body.run_id })) {
    assert.deepEqual([...new Set(fieldValues(entry.value, key))], [value], `persist original ${key}, not only its digest`)
  }
  const owners = fieldValues(entry.value, 'owner')
  if (owners.length) owners.forEach(owner => assert.deepEqual(owner, [...context.owner]))
  else {
    assert.deepEqual([...new Set(fieldValues(entry.value, 'tenant_id'))], [context.owner[0]])
    assert.deepEqual([...new Set(fieldValues(entry.value, 'user_id'))], [context.owner[1]])
  }
  assert.deepEqual([...new Set([...fieldValues(entry.value, 'expected_plan_hash'), ...fieldValues(entry.value, 'plan_hash')])],
    [body.expected_plan_hash], 'retain the original plan rather than reconstructing from the current selection')
  assert.deepEqual([...new Set([...fieldValues(entry.value, 'expected_run_revision'), ...fieldValues(entry.value, 'run_revision')])],
    [body.expected_run_revision], 'retain the original revision rather than reconstructing from the current selection')
  assert.notEqual(fieldValues(entry.value, 'request_hash')[0], sha(stable(body)), 'composition body is not the release request identity')
  const postIndex = world.events.findIndex(event => event.kind === 'api' && event.name === 'composeVersion')
  assert.ok(world.events.slice(0, postIndex).some(event => event.kind === 'session:set' && event.key === entry.key), 'save original intent before POST')
  return entry
}
async function attemptCompose(world) {
  const found = world.findButton(composeLabel)
  assert.ok(found.length <= 1)
  if (found[0] && !found[0].disabled) await world.click(composeLabel)
}
function assertUnknown(world) {
  assert.match(visibleText(world.root), /原合成[^。]*?(未知|待核对|未核对|尚未核对)|(?:结果|状态)未知/)
  assert.doesNotMatch(visibleText(world.root), /原合成状态\s*[：:]\s*(?:pending|processing|completed|failed|needs_attention)/)
  assertNoArtifacts(world)
}
function assertRecovered(world, status) {
  const labels = { pending: /pending|排队中/, processing: /processing|处理中/, completed: /completed|技术任务完成|任务已完成/,
    failed: /failed|失败/, needs_attention: /needs_attention|需要处理|需人工处理/ }
  const statusNodes = nodes(world.root, node => node.role === 'status' && /原合成/.test(visibleText(node)))
  assert.equal(statusNodes.length, 1, 'one accessible status distinguishes the original composition from the completed execution run')
  assert.match(visibleText(statusNodes[0]), labels[status])
  assert.doesNotMatch(visibleText(statusNodes[0]), /未知|未核对|待核对/)
  if (status === 'completed') assert.match(visibleText(world.root), /四文件.*(?:未|尚|待)|(?:未|尚|待).*四文件/)
  assertNoArtifacts(world)
}
async function submitLost(world) {
  world.handlers.composeVersion = async () => { throw Error('synthetic response lost after submission') }
  await world.click(composeLabel)
  assert.equal(postCalls(world).length, 1); assertSavedOriginal(world)
  assert.equal(exportCalls(world).length, 0, 'no automatic recovery after an unknown POST')
  assertUnknown(world)
  return postCalls(world)[0]
}
function recoveryHandlers(world, rows, detail) {
  world.handlers.listExports = async () => clone(rows)
  world.handlers.getExport = async () => clone(detail ?? rows[0])
}
function contextABA(world, dimension) {
  const context = world.props.unitContext
  if (dimension === 'owner') { context.owner[1] = 'user-b'; context.owner[1] = 'user-a' }
  if (dimension === 'tenant') { context.owner[0] = 'tenant-b'; context.owner[0] = 'tenant-a' }
  if (dimension === 'project') { context.project_id = 6; context.project_id = 5 }
  if (dimension === 'work') { context.work_id = 2; context.work_id = 1 }
  if (dimension === 'version') { context.version_id = 11; context.version_id = 10 }
  if (dimension === 'policy') { context.policy.execution_mode = 'auto'; context.policy.execution_mode = 'safe' }
  if (dimension === 'policy epoch') { context.policy.epoch = 1; context.policy.epoch = 0 }
}
function denyNewProof(world) { world.handlers.getLocalization = async () => { throw Error('synthetic new proof denied after context change') } }

for (const mode of ['native', 'not_required']) {
  test(`${mode}: actual button saves exact original identity before one five-field POST and never trusts a completed receipt`, async t => {
    const world = await scenario(t, current => { current.value = fixture(mode); current.props = vue.reactive(propsFor(current.value)) })
    assertProof(world); assert.equal(world.button(composeLabel).disabled, false)
    world.handlers.composeVersion = async () => ({ export_id: 401, status: 'completed', downloads: { mp4: '/synthetic-must-not-open' } })
    await world.click(composeLabel)
    assert.equal(postCalls(world).length, 1); assertSavedOriginal(world); assertUnknown(world)
    assert.equal(exportCalls(world).length, 0)
    await attemptCompose(world); await world.runTimers(); assert.equal(postCalls(world).length, 1)
    assert.equal(world.timers.size, 0)
  })
}

for (const [name, mutate] of [
  ['replace requires approved dub', value => { value.preview.capability.audio_mode = 'replace'; value.review.plan = clone(value.preview) }],
  ['run waiting_review', value => { value.run.status = 'waiting_review' }],
  ['run failed', value => { value.run.status = 'failed' }],
  ['second unit not approved', value => { value.run.units[1].status = 'waiting_review' }],
  ['second unit missing approval status', value => { delete value.run.units[1].status }],
]) {
  test(`${name}: no compose or TTS action can be submitted`, async t => {
    const world = await scenario(t, current => mutate(current.value))
    assertProof(world)
    if (name.startsWith('replace')) assert.match(visibleText(world.root), /(?:配音|音轨).*(?:缺口|尚未|仍须)|缺口.*(?:配音|音轨)/)
    const button = world.findButton(composeLabel)[0]
    assert.ok(!button || button.disabled, 'disqualified run must not offer an enabled compose button')
    await world.runTimers(); assert.equal(postCalls(world).length, 0); assertNoArtifacts(world)
  })
}

test('a delayed fifth proof GET leaves composition unavailable until the actual current run detail arrives', async t => {
  const world = await scenario(t, current => { current.detail = current.defer(); current.handlers.getExecutionRun = () => current.detail.promise })
  assert.deepEqual(world.calls.map(call => call.name), proofNames)
  const button = world.findButton(composeLabel)[0]
  assert.ok(!button || button.disabled); assert.equal(postCalls(world).length, 0)
  world.detail.resolve(clone(world.value.run)); await flush()
  assert.equal(world.button(composeLabel).disabled, false); assertProof(world)
})

test('double click takes the busy lock before either asynchronous hash completes and posts only once', async t => {
  const world = await scenario(t), hashWait = world.defer(), postWait = world.defer()
  world.hashGate = hashWait; world.handlers.composeVersion = () => postWait.promise
  const first = world.beginClick(composeLabel), second = world.beginClick(composeLabel)
  await flush(); assert.equal(postCalls(world).length, 0); assert.equal(world.uuidCount, 1)
  hashWait.resolve(null); await flush()
  assert.equal(postCalls(world).length, 1); assertSavedOriginal(world)
  postWait.resolve({ export_id: 401, status: 'pending' }); await Promise.all([first, second]); await flush()
  assert.equal(postCalls(world).length, 1); assertUnknown(world)
})

for (const fault of ['failRead', 'failWrite', 'failAfterWrite']) {
  test(`sessionStorage ${fault}: storage failure before submission permits zero POST and no replacement key retry`, async t => {
    const world = await scenario(t)
    world.session[fault] = true
    await attemptCompose(world); await attemptCompose(world); await world.runTimers()
    assert.equal(postCalls(world).length, 0)
    assert.equal(exportCalls(world).length, 0); assertNoArtifacts(world)
    assert.ok(world.uuidCount <= 1, 'storage failure must not silently mint another attempt key')
  })
}

test('same-scope remount retains its original intent without POST, key generation or automatic export lookup', async t => {
  const world = await scenario(t); await submitLost(world)
  const before = intentEntry(world), uuidCount = world.uuidCount, callCount = world.calls.length
  world.unmount(); world.mount(); await flush(); assertProof(world)
  assert.deepEqual(world.calls.slice(callCount).map(call => call.name), proofNames, 'remount independently rereads all five proofs')
  await attemptCompose(world); await world.runTimers()
  assert.equal(postCalls(world).length, 1); assert.equal(exportCalls(world).length, 0)
  assert.equal(world.uuidCount, uuidCount); assert.deepEqual(intentEntry(world), before); assertUnknown(world)
})

for (const corruption of ['invalid JSON', 'missing request hash', 'wrong request hash', 'missing key digest', 'wrong key digest',
  'unpaired surrogate key', 'whitespace key']) {
  test(`persisted original intent ${corruption}: remount cannot authorize another POST or a guessed lookup`, async t => {
    const world = await scenario(t); await submitLost(world)
    const original = intentEntry(world)
    let raw = original.raw
    if (corruption === 'invalid JSON') raw = '{'
    else {
      const value = clone(original.value)
      const mutate = object => {
        if (!object || typeof object !== 'object') return
        for (const key of Object.keys(object)) {
          if (key === 'request_hash' && corruption === 'missing request hash') delete object[key]
          else if (key === 'request_hash' && corruption === 'wrong request hash') object[key] = digest('f')
          else if (key === 'idempotency_key_sha256' && corruption === 'missing key digest') delete object[key]
          else if (key === 'idempotency_key_sha256' && corruption === 'wrong key digest') object[key] = digest('f')
          else if (key === 'idempotency_key' && corruption === 'unpaired surrogate key') object[key] = 'synthetic-\ud800'
          else if (key === 'idempotency_key' && corruption === 'whitespace key') object[key] = ' synthetic-original '
          else if (key === 'idempotency_key_sha256' && corruption === 'unpaired surrogate key') object[key] = sha('synthetic-\ud800')
          else if (key === 'idempotency_key_sha256' && corruption === 'whitespace key') object[key] = sha(' synthetic-original ')
          else mutate(object[key])
        }
      }
      mutate(value); raw = JSON.stringify(value)
    }
    world.unmount(); world.session.seed(original.key, raw); world.mount(); await flush()
    await attemptCompose(world)
    const recovery = world.findButton(recoverLabel)[0]
    if (recovery && !recovery.disabled) await world.click(recoverLabel)
    assert.equal(postCalls(world).length, 1); assert.equal(exportCalls(world).length, 0)
    assert.equal(world.session.snapshot()[original.key], raw, 'corrupt original intent must remain frozen')
    assertNoArtifacts(world)
  })
}

test('valid non-ASCII original key uses its exact UTF-8 bytes for persistence and read-only recovery', async t => {
  const world = await scenario(t, current => { current.uuid = 'synthetic-合成-😀' })
  const post = await submitLost(world)
  assert.match(post.args[1].idempotency_key, /合成-😀/)
  const row = exportRow(...post.args, { status: 'processing' })
  recoveryHandlers(world, [row]); await world.click(recoverLabel)
  assertRecovered(world, 'processing'); assertSavedOriginal(world); assert.equal(postCalls(world).length, 1)
})

for (const count of [0, 1, 2]) {
  test(`lost response: explicit recovery of ${count} exact list matches never replays POST or selects first/latest`, async t => {
    const world = await scenario(t), post = await submitLost(world)
    const row = exportRow(...post.args, { status: 'completed' })
    recoveryHandlers(world, count === 0 ? [] : count === 1 ? [{ ...row, id: 999, request_hash: digest('f') }, row] : [row, { ...row, id: 402 }], row)
    const before = intentEntry(world)
    await world.click(recoverLabel)
    assert.equal(calls(world, 'listExports').length, 1); assert.equal(postCalls(world).length, 1)
    assert.equal(calls(world, 'getExport').length, count === 1 ? 1 : 0)
    if (count === 1) { assert.deepEqual(calls(world, 'getExport')[0].args, [401]); assertRecovered(world, 'completed') }
    else { assertUnknown(world); assert.deepEqual(intentEntry(world), before) }
    await world.runTimers(); assert.equal(calls(world, 'listExports').length, 1)
  })
}

const mismatches = [
  ['wrong schema', row => { row.schema_version = 'redraw-episode-release-v1' }],
  ['not video', row => { row.export_type = 'audio' }],
  ['wrong version', row => { row.version_id = 11 }],
  ['string version', row => { row.version_id = '10' }],
  ['wrong run', row => { row.run_id = 22 }],
  ['wrong plan', row => { row.plan_hash = digest('f') }],
  ['missing request hash', row => { delete row.request_hash }],
  ['wrong request hash', row => { row.request_hash = digest('f') }],
  ['missing key digest', row => { delete row.idempotency_key_sha256 }],
  ['wrong key digest', row => { row.idempotency_key_sha256 = digest('f') }],
]
for (const [name, mutate] of mismatches) {
  test(`list ${name}: no detail read, no result adoption and no POST replay`, async t => {
    const world = await scenario(t), post = await submitLost(world), row = exportRow(...post.args, { status: 'completed' })
    mutate(row); recoveryHandlers(world, [row])
    await world.click(recoverLabel)
    assert.equal(calls(world, 'getExport').length, 0); assert.equal(postCalls(world).length, 1); assertUnknown(world)
  })
  test(`detail ${name}: a matching list row cannot authorize a mismatched detail`, async t => {
    const world = await scenario(t), post = await submitLost(world), row = exportRow(...post.args, { status: 'completed' }), detail = clone(row)
    mutate(detail); recoveryHandlers(world, [row], detail)
    await world.click(recoverLabel)
    assert.deepEqual(calls(world, 'getExport').map(call => call.args), [[401]])
    assert.equal(postCalls(world).length, 1); assertUnknown(world)
  })
}

for (const distinction of ['same request different key', 'same key different revision']) {
  test(`${distinction}: both original hashes are required to identify the submitted operation`, async t => {
    const world = await scenario(t), post = await submitLost(world), body = clone(post.args[1])
    if (distinction === 'same request different key') body.idempotency_key += '-other'
    else body.expected_run_revision += 1
    recoveryHandlers(world, [exportRow(post.args[0], body, { status: 'completed' })])
    await world.click(recoverLabel)
    assert.equal(calls(world, 'getExport').length, 0); assert.equal(postCalls(world).length, 1); assertUnknown(world)
  })
}

test('known POST export_id must match the unique original-request list row instead of adopting another ID', async t => {
  const world = await scenario(t)
  world.handlers.composeVersion = async () => ({ export_id: 402, status: 'pending' })
  await world.click(composeLabel)
  recoveryHandlers(world, [exportRow(...postCalls(world)[0].args, { id: 401, status: 'completed' })])
  await world.click(recoverLabel)
  assert.equal(calls(world, 'getExport').length, 0); assert.equal(postCalls(world).length, 1); assertUnknown(world)
})

test('detail id must equal the unique list id, even when every request binding and both hashes match', async t => {
  const world = await scenario(t), post = await submitLost(world), row = exportRow(...post.args)
  recoveryHandlers(world, [row], { ...row, id: 402, status: 'completed' })
  await world.click(recoverLabel)
  assert.equal(calls(world, 'getExport').length, 1); assertUnknown(world); assert.equal(postCalls(world).length, 1)
})

for (const status of ['pending', 'processing', 'completed', 'failed', 'needs_attention']) {
  test(`explicitly recovered ${status} remains a distinct technical status with no automatic polling, retry or four-file claim`, async t => {
    const world = await scenario(t), post = await submitLost(world), row = exportRow(...post.args, { status })
    recoveryHandlers(world, [row], row)
    await world.click(recoverLabel); assertRecovered(world, status)
    const before = exportCalls(world).length
    await attemptCompose(world); await world.runTimers()
    assert.equal(exportCalls(world).length, before); assert.equal(postCalls(world).length, 1); assert.equal(world.timers.size, 0)
    assertSavedOriginal(world)
  })
}

for (const method of ['listExports', 'getExport']) {
  test(`${method} failure keeps the saved original unknown, with no automatic retry or POST`, async t => {
    const world = await scenario(t), post = await submitLost(world), row = exportRow(...post.args)
    recoveryHandlers(world, [row]); world.handlers[method] = async () => { throw Error('synthetic read access failure') }
    const before = intentEntry(world)
    await world.click(recoverLabel); await world.runTimers()
    assertUnknown(world); assert.deepEqual(intentEntry(world), before); assert.equal(postCalls(world).length, 1)
    assert.equal(calls(world, method).length, 1)
  })
}

test('a second explicit recovery may read the same original request again but cannot create another attempt', async t => {
  const world = await scenario(t), post = await submitLost(world), row = exportRow(...post.args, { status: 'processing' })
  recoveryHandlers(world, [])
  await world.click(recoverLabel); assertUnknown(world)
  recoveryHandlers(world, [row])
  await world.click(recoverLabel); assertRecovered(world, 'processing')
  assert.equal(calls(world, 'listExports').length, 2); assert.equal(postCalls(world).length, 1); assert.equal(world.uuidCount, 1)
})

for (const dimension of ['owner', 'tenant', 'project', 'work', 'version', 'policy', 'policy epoch']) {
  test(`${dimension} same-tick ABA during hashing cannot submit the late original proof`, async t => {
    const world = await scenario(t), wait = world.defer()
    world.hashGate = wait
    const pending = world.beginClick(composeLabel)
    await flush(); assert.equal(postCalls(world).length, 0)
    denyNewProof(world); contextABA(world, dimension); await flush()
    wait.resolve(null); await pending; await flush()
    assert.equal(postCalls(world).length, 0); assert.doesNotMatch(visibleText(world.root), /绑定已核验/); assertNoArtifacts(world)
  })
  test(`${dimension} same-tick ABA hides a recovered result immediately while preserving its original intent`, async t => {
    const world = await scenario(t), post = await submitLost(world), row = exportRow(...post.args, { status: 'completed' })
    recoveryHandlers(world, [row]); await world.click(recoverLabel); assertRecovered(world, 'completed')
    const before = intentEntry(world)
    denyNewProof(world); contextABA(world, dimension); await flush()
    assert.doesNotMatch(visibleText(world.root), /绑定已核验|原合成状态\s*[：:]\s*completed/)
    assert.deepEqual(intentEntry(world), before); assert.equal(postCalls(world).length, 1); assertNoArtifacts(world)
  })
}

for (const phase of ['POST', 'list GET', 'detail GET']) {
  for (const invalidation of ['owner ABA', 'version ABA', 'policy ABA', 'unmount']) {
    test(`${phase} late response after ${invalidation} cannot publish the old operation into the visible current context`, async t => {
      const world = await scenario(t), wait = world.defer()
      let pending, row
      if (phase === 'POST') {
        world.handlers.composeVersion = () => wait.promise; pending = world.beginClick(composeLabel); await flush()
        assert.equal(postCalls(world).length, 1); row = exportRow(...postCalls(world)[0].args, { status: 'completed' })
      } else {
        const post = await submitLost(world); row = exportRow(...post.args, { status: 'completed' }); recoveryHandlers(world, [row])
        world.handlers[phase === 'list GET' ? 'listExports' : 'getExport'] = () => wait.promise
        pending = world.beginClick(recoverLabel); await flush()
        assert.equal(calls(world, phase === 'list GET' ? 'listExports' : 'getExport').length, 1)
      }
      const originalKey = intentEntry(world).key
      denyNewProof(world)
      if (invalidation === 'unmount') { world.unmount(); world.mount(); await flush() }
      else { contextABA(world, invalidation.split(' ')[0]); await flush() }
      wait.resolve(phase === 'POST' ? { export_id: 401, status: 'completed' } : phase === 'list GET' ? [row] : row)
      await pending; await flush()
      assert.doesNotMatch(visibleText(world.root), /绑定已核验|原合成状态\s*[：:]\s*completed/)
      assert.ok(world.session.snapshot()[originalKey], 'retain original intent for its valid scope')
      assert.equal(postCalls(world).length, 1); assertNoArtifacts(world)
      if (phase === 'list GET') assert.equal(calls(world, 'getExport').length, 0, 'stale list must not launch a detail read')
    })
  }
}

test('unmount during the first hash cannot submit or let the old hash unlock a fresh instance', async t => {
  const world = await scenario(t), wait = world.defer()
  world.hashGate = wait; const pending = world.beginClick(composeLabel); await flush()
  world.unmount(); denyNewProof(world); world.mount(); await flush()
  wait.resolve(null); await pending; await flush()
  assert.equal(postCalls(world).length, 0); assert.doesNotMatch(visibleText(world.root), /绑定已核验/); assertNoArtifacts(world)
})

for (const dimension of ['owner', 'tenant', 'project', 'work', 'version']) {
  test(`saved intent is isolated by ${dimension}; another valid scope must never restore the previous scope's original`, async t => {
    const world = await scenario(t); await submitLost(world)
    const original = intentEntry(world), props = clone(world.props)
    world.unmount()
    if (dimension === 'owner') {
      props.unitContext.owner[1] = 'user-b'; world.value.preview.bindings.user_id = 'user-b'
      world.auth.saveSession({ token: 'synthetic-token-b', user: { id: 'user-b' } }); world.auth.saveCurrentTenantId('tenant-a')
    }
    if (dimension === 'tenant') {
      props.unitContext.owner[0] = 'tenant-b'; world.value.preview.bindings.tenant_id = 'tenant-b'; world.auth.saveCurrentTenantId('tenant-b')
    }
    if (dimension === 'project') { props.unitContext.project_id = 6; props.unitContext.policy.project_id = 6 }
    if (dimension === 'work') {
      props.unitContext.work_id = 2; world.value.localization.work_id = 2; world.value.preview.bindings.work_id = 2
      world.value.queue.work_id = 2; world.value.run.work_id = 2
    }
    if (dimension === 'version') {
      props.versionId = 11; props.unitIntent.version_id = 11; props.unitContext.version_id = 11
      world.value.localization.version_id = 11; world.value.preview.bindings.version_id = 11
      world.value.queue.version_id = 11; world.value.run.version_id = 11
    }
    world.value.review.plan = clone(world.value.preview)
    world.localBaseline = world.local.snapshot(); world.props = vue.reactive(props)
    world.mount(); await flush()
    assert.match(visibleText(world.root), /绑定已核验/)
    assert.equal(world.button(composeLabel).disabled, false, 'another proved scope has no submitted original of its own')
    const recovery = world.findButton(recoverLabel)[0]
    assert.ok(!recovery || recovery.disabled, 'cannot expose the previous scope original recovery')
    assert.equal(world.session.snapshot()[original.key], original.raw)
    assert.equal(postCalls(world).length, 1); assert.equal(exportCalls(world).length, 0)
  })
}

test('same-scope new run selection cannot replace or reinterpret the saved original composition', async t => {
  const world = await scenario(t), post = await submitLost(world)
  const original = intentEntry(world), uuidCount = world.uuidCount, callCount = world.calls.length
  world.unmount()
  world.value.run.id = 22; world.value.run.revision = 8
  world.props.unitIntent.run_id = 22; world.props.unitIntent.run_revision = 8
  world.mount(); await flush()
  assert.deepEqual(world.calls.slice(callCount).map(call => call.name), proofNames)
  assert.match(visibleText(world.root), /绑定已核验/)
  await attemptCompose(world)
  const newBody = { ...post.args[1], run_id: 22, expected_run_revision: 8 }
  const unrelated = exportRow(post.args[0], newBody, { id: 402, status: 'completed' })
  recoveryHandlers(world, [unrelated], unrelated)
  const recovery = world.findButton(recoverLabel)[0]
  if (recovery && !recovery.disabled) await world.click(recoverLabel)
  assert.equal(calls(world, 'getExport').length, 0, 'new run data cannot stand in for the original request')
  assert.equal(world.uuidCount, uuidCount); assert.equal(postCalls(world).length, 1)
  assert.equal(world.session.snapshot()[original.key], original.raw)
  assert.doesNotMatch(visibleText(world.root), /原合成状态\s*[：:]\s*completed/)
  assertNoArtifacts(world)
})

test('known POST export ID remains binding after remount instead of becoming a guessed identity', async t => {
  const world = await scenario(t)
  world.handlers.composeVersion = async () => ({ export_id: 402, status: 'pending' })
  await world.click(composeLabel)
  const original = intentEntry(world)
  world.unmount(); world.mount(); await flush(); assertProof(world)
  recoveryHandlers(world, [exportRow(...postCalls(world)[0].args, { id: 401, status: 'completed' })])
  await world.click(recoverLabel)
  assert.equal(calls(world, 'getExport').length, 0)
  assert.equal(postCalls(world).length, 1); assert.equal(world.uuidCount, 1)
  assert.deepEqual(intentEntry(world), original); assertUnknown(world)
})

for (const refreshProof of [false, true]) {
  test(`known receipt ID cannot be lost after its storage write fails${refreshProof ? ' and proof is refreshed' : ''}`, async t => {
    const world = await scenario(t)
    world.handlers.composeVersion = async () => {
      world.session.failWrite = true
      return { export_id: 402, status: 'pending' }
    }
    await world.click(composeLabel)
    world.session.failWrite = false
    if (refreshProof) await world.click('重新核验导出准备')
    recoveryHandlers(world, [exportRow(...postCalls(world)[0].args, { id: 401, status: 'completed' })])
    const recovery = world.findButton(recoverLabel)[0]
    if (recovery && !recovery.disabled) await world.click(recoverLabel)
    assert.equal(calls(world, 'getExport').length, 0, 'known 402 must not downgrade to unbound ID after save failure')
    assert.equal(postCalls(world).length, 1); assert.equal(world.uuidCount, 1)
    assertUnknown(world)
  })
}
