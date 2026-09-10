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
  const script = compileScript(descriptor, { id: 'execution-run-candidate' })
  const imports = /^import\s+\{([^}]+)\}\s+from\s+['"]vue['"];?[ \t]*$/gm
  const fromVue = (_all, names) => `const {${names.replace(/\s+as\s+/g, ':')}} = Vue;`
  assert.equal("import { redrawAPI } from '@/api/redraw'\nimport { readSession } from '@/utils/authSession'\nimport { ref as localRef } from 'vue'".replace(imports, fromVue),
    "import { redrawAPI } from '@/api/redraw'\nimport { readSession } from '@/utils/authSession'\nconst { ref:localRef } = Vue;", 'Vue binding conversion must not consume preceding non-Vue imports')
  const body = script.content.replace(imports, fromVue).replace(/^import[^\n]*(?:\n|$)/gm, '').replace('export default', 'return')
  const template = compileTemplate({ id: 'execution-run-candidate', filename: location.pathname, source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const component = new Function('Vue', 'redrawAPI', 'readSession', 'readCurrentTenantId', 'crypto', 'window', 'localStorage', 'sessionStorage', 'URL', body)(
    vue, api, env.auth.readSession, env.auth.readCurrentTenantId, env.crypto || webcrypto, env.window, env.local, env.session, env.urls)
  component.render = new Function('Vue', template.code.replace(imports, fromVue).replace('export function render', 'return function render'))(vue)
  return component
}
function renderer() {
  return vue.createRenderer({
    createElement: tag => ({ tag, tagName: tag.toUpperCase(), children: [], parent: null, events: {},
      pauseCount: 0, loadCount: 0,
      pause() { this.pauseCount++ }, load() { this.loadCount++ }, removeAttribute(name) { delete this[name] },
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

const checkKeys = ['scene_action_continuity', 'source_text_and_caption_residue', 'character_identity',
  'target_dialogue_complete', 'speaker_order', 'target_names', 'language_and_locale', 'voice_and_emotion',
  'no_extra_dialogue', 'lip_sync', 'ambient_audio']
const mediaBytes = new TextEncoder().encode('fixture-only: not a decodable MP4; UI logic evidence only')
const mediaHash = createHash('sha256').update(mediaBytes).digest('hex')
function candidate(keys = checkKeys) {
  return { schema_version: 'redraw-execution-unit-candidate-review-v1', run_id: 20, run_revision: 6,
    unit_id: 'unit-1', ordinal: 0, attempt_id: 30, status: 'waiting_review', candidate_hash: digest('c'),
    asset: { id: 50, sha256: mediaHash, bytes: mediaBytes.length, mime_type: 'video/mp4', duration_ms: 5000,
      width: 720, height: 1280, video_codec: 'h264', audio_codec: 'aac' },
    output_contract: { durationMs: 5000, audioMode: 'native', resolution: '720p', aspectRatio: '9:16' },
    billing: { status: 'held', amount: 12 }, required_checks: [...keys],
    review_policy: { execution_mode: 'safe', policy_version: 2, human_required: true, reason_codes: ['first_unit'] },
    technical_qa: { status: 'passed', method: 'ffprobe', probe: { durationMs: 5000, width: 720, height: 1280,
      videoCodec: 'h264', audioCodec: 'aac', displayWidth: 720 } },
    content_qa: { status: 'requires_human_review', machine_evidence: 'not_available', final_audio_review: 'not_composed' },
    target_contract: { character_name_map: { 'character-1': 'Maya' },
      dialogues: [{ target_speaker_name: 'Maya', target_text: 'Please wait here.', unit_start_ms: 1200, unit_end_ms: 3500,
        emotion: 'worried', pronunciation_hint: 'MY-ah' }],
      shots: [{ unit_start_ms: 0, unit_end_ms: 5000, composition: 'medium shot', camera_movement: 'slow pan',
        opening_state: 'standing', continuous_action: 'walk to the door', ending_state: 'hand on handle' }] },
    review: null }
}
function scenario(t, { session = storage(), keys = checkKeys } = {}) {
  const env = browser(session), fixture = document(), calls = [], pending = [], instances = [], waits = []
  const created = [], revoked = []
  env.urls = { createObjectURL(blob) { const url = 'blob:candidate-fixture-' + (created.length + 1); created.push({ url, blob }); env.afterURL?.(); return url },
    revokeObjectURL(url) { revoked.push(url) } }
  const world = { env, fixture, calls, created, revoked, candidate: candidate(keys) }
  world.server = { ...run(fixture), status: 'waiting_review', revision: 6,
    output_parameters: { resolution: '720p', aspect_ratio: '9:16' } }
  world.server.units[0].status = 'waiting_review'
  world.server.units[0].attempts = [{ id: 30, attempt_no: 1, status: 'waiting_review', created_at: 'created', updated_at: 'updated' }]
  const handlers = {
    listExecutionRuns: async () => ({ version_id: 10, current_run_id: 20, runs: [structuredClone(world.server)] }),
    getExecutionRun: async () => structuredClone(world.server),
    getExecutionRunReadiness: async () => ({ status: 'blocked', run_id: 20, run_revision: world.server.revision, reason_codes: ['WAITING_REVIEW'] }),
    getExecutionUnitCandidate: async () => structuredClone(world.candidate),
    getExecutionUnitCandidateMedia: async () => new Blob([mediaBytes], { type: 'video/mp4' }),
    reviewExecutionUnitCandidate: async (_version, _run, _unit, body) => {
      world.server.revision = 7
      world.server.status = body.decision === 'approved' ? 'ready' : 'needs_attention'
      world.server.units[0].status = body.decision; world.server.units[0].attempts[0].status = body.decision
      world.candidate = { ...world.candidate, run_revision: 7, status: body.decision,
        billing: { ...world.candidate.billing, status: body.decision === 'approved' ? 'confirmed' : 'held' },
        content_qa: { ...world.candidate.content_qa, status: 'human_reviewed' },
        review: { decision: body.decision, checks: structuredClone(body.checks), reviewed_by: 'user-a', reviewed_at: '2026-09-08T00:00:00Z', review_hash: digest('f') } }
      return { ...structuredClone(world.candidate), newly_reviewed: true }
    },
    createExecutionRun: async () => { throw Error('unexpected create') },
    advanceExecutionRun: async () => { throw Error('unexpected advance') },
    pauseExecutionRun: async () => { throw Error('unexpected pause') },
    resumeExecutionRun: async () => { throw Error('unexpected resume') },
    recoverExecutionUnitTask: async () => { throw Error('unexpected recover') },
  }
  const api = Object.fromEntries(Object.keys(handlers).map(name => [name, (...args) => {
    calls.push({ name, args, storageAtEntry: env.session?.snapshot() || {} }); return handlers[name](...args)
  }]))
  function evaluate() { return evaluateModule(env, api) }
  function mount(component = evaluate()) {
    const props = vue.reactive(structuredClone(fixture)), root = { children: [] }
    const app = renderer().createApp({ setup: () => () => vue.h(component, props) })
    app.component('el-button', { props: ['disabled', 'loading'], setup: (buttonProps, { attrs, slots }) => () => vue.h('button', { ...attrs, disabled: buttonProps.disabled }, slots.default?.()) })
    app.config.warnHandler = message => { throw Error('Vue fixture warning: ' + message) }
    app.mount(root)
    const instance = app._instance.subTree.component
    assert.ok(instance?.isMounted, 'real Vue must mount before business assertions')
    let disposed = false
    const h = { props, root, instance, state: instance.setupState,
      invoke(name, ...args) {
        assert.equal(typeof h.state[name], 'function', 'candidate UI action ' + name + ' must exist')
        const result = Promise.resolve(h.state[name](...args)); pending.push(result); return result
      },
      dispose() { if (!disposed) { disposed = true; app.unmount() } } }
    instances.push(h); return h
  }
  function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); const wait = { promise, resolve, reject }; waits.push(wait); return wait }
  t.after(async () => { waits.forEach(wait => wait.resolve(null)); instances.forEach(h => h.dispose()); await Promise.allSettled(pending); await tick() })
  return Object.assign(world, { handlers, evaluate, mount, deferred })
}
function nodes(node, predicate) { return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => nodes(child, predicate))] }
function visibleText(node) { return [node.text || '', ...(node.children || []).map(visibleText)].join(' ') }
const posts = world => world.calls.filter(call => !call.name.startsWith('get') && !call.name.startsWith('list'))
const reviewCalls = world => world.calls.filter(call => call.name === 'reviewExecutionUnitCandidate')
const savedReviews = world => Object.values(world.env.session.snapshot()).map(raw => JSON.parse(raw)).filter(value => value.action === 'review')
async function selected(h) { await h.invoke('refreshRuns'); await h.invoke('selectRun', 20); assert.equal(h.state.currentRun, true) }
async function loaded(h) { await selected(h); await h.invoke('loadCandidate', 'unit-1'); await tick() }
function player(h) { const node = nodes(h.root, node => node.tag === 'video')[0]; assert.ok(node, 'controlled video must render'); return node }
async function markReadable(h) {
  const video = player(h); assert.equal(typeof video.onLoadeddata, 'function')
  video.onLoadeddata({ currentTarget: video }); await tick()
}
async function humanChecks(h, value = 'passed') {
  for (const select of nodes(h.root, node => node.tag === 'select' && node['data-review-check'])) {
    assert.equal(select.disabled, false); select.onChange({ target: { value } })
  }
  const ack = nodes(h.root, node => node.tag === 'input' && node['aria-label'] === '我已实际播放并逐项听看本候选')[0]
  assert.ok(ack); assert.equal(ack.disabled, false)
  ack.onChange({ target: { checked: true } }); await tick()
}
async function ready(h) { await loaded(h); await markReadable(h); await humanChecks(h) }
function ownerABA(env, dimension = 'user') {
  const key = dimension === 'user' ? 'moli_mama_session' : 'moli_mama_tenant_id', oldValue = env.local.getItem(key)
  if (dimension === 'user') env.auth.saveSession({ token: 'fixture-b', user: { id: 'user-b' } })
  else env.auth.saveCurrentTenantId('tenant-b')
  const newValue = env.local.getItem(key)
  env.auth.saveSession({ token: 'fixture-token', user: { id: 'user-a' } }); env.auth.saveCurrentTenantId('tenant-a')
  env.window.dispatch('storage', { key, oldValue, newValue, storageArea: env.local })
  env.window.dispatch('storage', { key, oldValue: newValue, newValue: oldValue, storageArea: env.local })
}
function invalidate(world, h, kind) {
  if (kind === 'unmount') h.dispose()
  else if (kind === 'owner' || kind === 'tenant') ownerABA(world.env, kind === 'tenant' ? 'tenant' : 'user')
  else if (kind === 'props') { const old = h.props.record.updated_at; h.props.record.updated_at = 'changed'; h.props.record.updated_at = old }
  else if (kind === 'policy') { h.props.projectPolicy.execution_mode = 'auto'; h.props.projectPolicy.epoch++; h.props.projectPolicy.execution_mode = 'safe'; h.props.projectPolicy.epoch++ }
  else if (kind === 'run') { h.state.selectedRunId = null; h.state.selectedRunId = 20 }
  else if (kind === 'parameters') { h.state.selectedResolution = '720p'; h.state.selectedResolution = '' }
}

test('mount and record selection do not implicitly read candidates, fetch media or POST', async t => {
  const world = scenario(t), h = world.mount()
  assert.equal(world.calls.length, 0); await selected(h)
  assert.deepEqual(world.calls.map(call => call.name), ['listExecutionRuns', 'getExecutionRun'])
  const buttons = nodes(h.root, node => node.tag === 'button' && visibleText(node).includes('读取候选'))
  assert.equal(buttons.length, 1, 'a real candidate read action must exist for the eligible unit')
  assert.equal(buttons[0].disabled, false)
})

test('controlled candidate GET validates separate identity and byte hashes, then creates only a blob URL', async t => {
  const world = scenario(t), h = world.mount(); await loaded(h)
  assert.equal(h.state.candidate.candidate_hash, digest('c')); assert.notEqual(digest('c'), mediaHash)
  const calls = world.calls.filter(call => call.name.startsWith('getExecutionUnit'))
  assert.deepEqual(calls[0].args.slice(0, 3), [10, 20, 'unit-1']); assert.ok(calls[0].args[3].signal instanceof AbortSignal)
  assert.deepEqual(calls[1].args.slice(0, 4), [10, 20, 'unit-1', { expected_candidate_hash: digest('c') }])
  assert.equal(calls[1].args[4].signal, calls[0].args[3].signal)
  assert.equal(world.created.length, 1); assert.equal(player(h).src, world.created[0].url); assert.equal(posts(world).length, 0)
  assert.equal(h.state.mediaReady, false, 'a blob response alone cannot attest decode or human viewing')
})

for (const [name, keys, mode] of [
  ['native dialogue', checkKeys, 'native'],
  ['native silent', ['scene_action_continuity', 'source_text_and_caption_residue', 'no_dialogue', 'ambient_audio'], 'native'],
  ['replace', ['scene_action_continuity', 'source_text_and_caption_residue', 'character_identity'], 'replace'],
]) test(name + ' renders exact dynamic checks, all initially unchecked even under auto/ffprobe passed', async t => {
  const world = scenario(t, { keys }), h = world.mount()
  h.props.projectPolicy.execution_mode = 'auto'; world.candidate.review_policy.execution_mode = 'auto'
  world.candidate.output_contract.audioMode = mode
  world.candidate.content_qa.final_audio_review = mode === 'replace' ? 'deferred_to_composition' : 'not_composed'
  await loaded(h)
  assert.deepEqual(nodes(h.root, n => n.tag === 'select' && n['data-review-check']).map(n => n['data-review-check']), keys)
  assert.deepEqual({ ...h.state.reviewChecks }, Object.fromEntries(keys.map(key => [key, 'not_checked'])))
  assert.equal(h.state.canApproveCandidate, false); await markReadable(h)
  assert.equal(h.state.canApproveCandidate, false, 'synthetic readable event is not human checks')
  const text = visibleText(h.root)
  for (const target of ['Maya', 'Please wait here.', '1200', '3500', 'worried', 'MY-ah', 'medium shot', 'slow pan', 'walk to the door', 'hand on handle']) assert.ok(text.includes(target), target)
  assert.ok(text.includes('not_available')); if (mode === 'replace') assert.ok(text.includes('deferred_to_composition'))
})

for (const kind of ['nonblob', 'empty', 'json', 'mime', 'wronghash', 'bytes']) test('media rejects ' + kind + ' without URL or review readiness', async t => {
  const world = scenario(t), h = world.mount()
  world.handlers.getExecutionUnitCandidateMedia = async () => {
    if (kind === 'nonblob') return { data: 'not a Blob' }
    if (kind === 'empty') return new Blob([], { type: 'video/mp4' })
    if (kind === 'json') return new Blob(['{"code":"CONFLICT"}'], { type: 'application/json' })
    if (kind === 'mime') return new Blob([mediaBytes], { type: 'text/plain' })
    return new Blob([kind === 'wronghash' ? new Uint8Array(mediaBytes.length) : mediaBytes.slice(1)], { type: 'video/mp4' })
  }
  await loaded(h); assert.equal(world.created.length, 0); assert.equal(h.state.mediaReady, false)
  assert.equal(h.state.canApproveCandidate, false); assert.equal(h.state.candidate, null); assert.ok(h.state.error)
})

for (const field of ['schema', 'run', 'revision', 'unit', 'ordinal', 'attempt', 'hash', 'policy', 'human', 'checks', 'duplicate']) test('candidate DTO rejects mismatched ' + field + ' before media read', async t => {
  const world = scenario(t), h = world.mount(), dto = world.candidate
  if (field === 'schema') dto.schema_version = 'old-schema'
  if (field === 'run') dto.run_id = 21
  if (field === 'revision') dto.run_revision = 5
  if (field === 'unit') dto.unit_id = 'other'
  if (field === 'ordinal') dto.ordinal = 1
  if (field === 'attempt') dto.attempt_id = 31
  if (field === 'hash') dto.candidate_hash = 'C'.repeat(64)
  if (field === 'policy') dto.review_policy.policy_version++
  if (field === 'human') dto.review_policy.human_required = false
  if (field === 'checks') dto.required_checks = [{ key: 'scene_action_continuity' }]
  if (field === 'duplicate') dto.required_checks.push(dto.required_checks[0])
  await loaded(h); assert.equal(world.calls.filter(c => c.name === 'getExecutionUnitCandidateMedia').length, 0)
  assert.equal(h.state.candidate, null); assert.ok(h.state.error)
})

for (const phase of ['candidate', 'media', 'arraybuffer', 'digest']) for (const kind of ['owner', 'props', 'policy', 'unmount']) {
  test(phase + ' deferred result cannot restore media or drafts after ' + kind, async t => {
    const world = scenario(t), h = world.mount(), wait = world.deferred()
    if (phase === 'candidate') world.handlers.getExecutionUnitCandidate = () => wait.promise
    if (phase === 'media') world.handlers.getExecutionUnitCandidateMedia = () => wait.promise
    if (phase === 'arraybuffer') world.handlers.getExecutionUnitCandidateMedia = async () => {
      const blob = new Blob([mediaBytes], { type: 'video/mp4' }); blob.arrayBuffer = () => wait.promise; return blob
    }
    if (phase === 'digest') world.env.crypto = { subtle: { digest: () => wait.promise } }
    // Crypto is injected at module evaluation, so the digest case needs its instance created afterwards.
    let target = h
    if (phase === 'digest') { h.dispose(); target = world.mount() }
    await selected(target); const request = target.invoke('loadCandidate', 'unit-1'); await tick()
    assert.equal(world.calls.filter(c => c.name === 'getExecutionUnitCandidate').length, 1, 'deferred API must actually enter')
    if (phase !== 'candidate') assert.equal(world.calls.filter(c => c.name === 'getExecutionUnitCandidateMedia').length, 1)
    const signal = world.calls.find(c => c.name === 'getExecutionUnitCandidate').args[3].signal
    invalidate(world, target, kind); assert.equal(signal.aborted, true)
    wait.resolve(phase === 'candidate' ? structuredClone(world.candidate) : phase === 'media' ? new Blob([mediaBytes], { type: 'video/mp4' })
      : phase === 'arraybuffer' ? mediaBytes.buffer : Buffer.from(mediaHash, 'hex').buffer)
    await request; await tick()
    assert.equal(world.created.length, 0); assert.equal(target.state.candidate, null); assert.equal(target.state.mediaReady, false)
    assert.deepEqual({ ...target.state.reviewChecks }, {}); assert.equal(posts(world).length, 0)
  })
}

for (const kind of ['owner', 'tenant', 'props', 'policy', 'unmount', 'run', 'parameters']) test('loaded player is stopped, source removed, reloaded and URL revoked on ' + kind, async t => {
  const world = scenario(t), h = world.mount(); await ready(h); const video = player(h), url = video.src
  assert.equal(h.state.canApproveCandidate, true)
  invalidate(world, h, kind); await tick()
  assert.equal(video.pauseCount, 1); assert.equal(video.loadCount, 1); assert.equal(video.src, undefined)
  assert.deepEqual(world.revoked, [url]); assert.equal(h.state.candidate, null); assert.equal(h.state.mediaReady, false)
  assert.deepEqual({ ...h.state.reviewChecks }, {})
  video.onLoadeddata({ currentTarget: video }); await tick(); assert.equal(h.state.mediaReady, false)
})

test('invalidation synchronously inside createObjectURL revokes the uninstalled URL', async t => {
  const world = scenario(t), h = world.mount(); world.env.afterURL = () => invalidate(world, h, 'policy')
  await loaded(h); assert.equal(world.created.length, 1); assert.deepEqual(world.revoked, [world.created[0].url])
  assert.equal(h.state.candidateUrl, ''); assert.equal(h.state.candidate, null)
})

test('decode error cancels media and all checked human drafts; late readable cannot resurrect it', async t => {
  const world = scenario(t), h = world.mount(); await ready(h); const video = player(h), url = video.src
  assert.equal(typeof video.onError, 'function'); video.onError({ currentTarget: video }); await tick()
  assert.equal(h.state.canApproveCandidate, false); assert.equal(h.state.mediaReady, false); assert.deepEqual({ ...h.state.reviewChecks }, {})
  assert.deepEqual(world.revoked, [url]); assert.equal(video.pauseCount, 1); assert.equal(video.loadCount, 1)
  video.onLoadeddata({ currentTarget: video }); assert.equal(h.state.mediaReady, false); assert.ok(h.state.error)
})

test('approval requires readable media, explicit human acknowledgement and every check passed', async t => {
  const world = scenario(t), h = world.mount(); await loaded(h)
  await h.invoke('reviewCandidate', 'approved'); assert.equal(reviewCalls(world).length, 0)
  await markReadable(h); await h.invoke('reviewCandidate', 'approved'); assert.equal(reviewCalls(world).length, 0)
  await humanChecks(h, 'failed'); assert.equal(h.state.canApproveCandidate, false)
  await h.invoke('reviewCandidate', 'approved'); assert.equal(reviewCalls(world).length, 0)
  await humanChecks(h); assert.equal(h.state.canApproveCandidate, true)
  await h.invoke('reviewCandidate', 'approved'); assert.equal(reviewCalls(world).length, 1)
  const call = reviewCalls(world)[0], body = call.args[3]
  assert.deepEqual(call.args.slice(0, 3), [10, 20, 'unit-1'])
  assert.deepEqual(Object.keys(body).sort(), ['checks', 'decision', 'expected_candidate_hash', 'expected_revision'])
  assert.equal(body.expected_revision, 6); assert.equal(body.expected_candidate_hash, digest('c')); assert.equal(body.decision, 'approved')
  assert.deepEqual(body.checks, Object.fromEntries(checkKeys.map(key => [key, { basis: 'human_watch_listen', result: 'passed' }])))
  const intent = Object.values(call.storageAtEntry).map(raw => JSON.parse(raw)).find(value => value.action === 'review')
  assert.equal(intent.status, 'pending'); assert.deepEqual(intent.review, body); assert.equal(intent.attempt_id, 30); assert.equal(intent.unit_id, 'unit-1')
  assert.equal(savedReviews(world)[0].status, 'received'); assert.equal(h.state.run.revision, 6); assert.equal(h.state.run.status, 'waiting_review')
  assert.equal(world.calls.length, 5, 'approval must not implicitly GET, POST or advance')
  assert.equal(h.state.candidate, null); assert.deepEqual({ ...h.state.reviewChecks }, {})
  await h.invoke('reviewCandidate', 'approved'); assert.equal(reviewCalls(world).length, 1)
  assert.ok(visibleText(h.root).includes('approved')); assert.ok(visibleText(h.root).includes('刷新执行记录'))
})

test('explicit rejection permits failed and not_checked, stays held, and never claims refund or run completion', async t => {
  const world = scenario(t), h = world.mount(); await loaded(h); await markReadable(h); await humanChecks(h, 'not_checked')
  const select = nodes(h.root, n => n.tag === 'select' && n['data-review-check'])[0]
  select.onChange({ target: { value: 'failed' } }); await tick()
  assert.equal(h.state.canRejectCandidate, true); await h.invoke('reviewCandidate', 'rejected')
  const body = reviewCalls(world)[0].args[3]
  assert.deepEqual(body.checks.scene_action_continuity, { result: 'failed', basis: 'human_watch_listen' })
  assert.deepEqual(body.checks.source_text_and_caption_residue, { result: 'not_checked', basis: 'not_checked' })
  assert.equal(world.candidate.billing.status, 'held'); assert.equal(h.state.run.status, 'waiting_review')
  assert.equal(posts(world).length, 1); assert.equal(savedReviews(world)[0].status, 'received')
})

for (const outcome of ['deferred', 'unknown', '400', '404', '409', '500']) test('review ' + outcome + ' retains original intent, blocks repeated decisions and clears stale media', async t => {
  const world = scenario(t), h = world.mount(), wait = world.deferred(); await ready(h)
  world.handlers.reviewExecutionUnitCandidate = () => outcome === 'deferred' ? wait.promise
    : Promise.reject(Object.assign(Error('fixture review transport'), outcome === 'unknown' ? {} : { response: { status: Number(outcome), data: new Blob(['{"code":"ERROR"}'], { type: 'application/json' }) } }))
  const request = h.invoke('reviewCandidate', 'approved'); await tick()
  assert.equal(reviewCalls(world).length, 1); assert.equal(savedReviews(world)[0].status, outcome === 'deferred' ? 'pending' : 'unknown')
  await h.invoke('reviewCandidate', 'rejected'); assert.equal(reviewCalls(world).length, 1)
  if (outcome === 'deferred') { wait.reject(Error('fixture lost response')); await request } else await request
  assert.equal(savedReviews(world)[0].status, 'unknown'); assert.equal(h.state.candidate, null); assert.equal(world.revoked.length, 1)
  await loaded(h); await markReadable(h); await humanChecks(h)
  assert.equal(h.state.canApproveCandidate, false); await h.invoke('reviewCandidate', 'approved'); assert.equal(reviewCalls(world).length, 1)
  const remounted = world.mount(world.evaluate()); await loaded(remounted); await markReadable(remounted); await humanChecks(remounted)
  assert.equal(remounted.state.canApproveCandidate, false); assert.equal(savedReviews(world)[0].status, 'unknown')
})

test('two real instances share the persisted pending review lock before POST', async t => {
  const world = scenario(t), module = world.evaluate(), first = world.mount(module), second = world.mount(module), wait = world.deferred()
  await ready(first); await ready(second); assert.equal(second.state.canApproveCandidate, true)
  world.handlers.reviewExecutionUnitCandidate = () => wait.promise
  const request = first.invoke('reviewCandidate', 'approved'); await tick(); assert.equal(reviewCalls(world).length, 1)
  await second.invoke('reviewCandidate', 'rejected'); assert.equal(reviewCalls(world).length, 1)
  wait.reject(Error('lost')); await request
})

for (const kind of ['owner', 'props', 'policy', 'unmount']) test('late review response after ' + kind + ' settles original slot only and cannot restore candidate', async t => {
  const world = scenario(t), h = world.mount(), wait = world.deferred(); await ready(h)
  const success = world.handlers.reviewExecutionUnitCandidate
  world.handlers.reviewExecutionUnitCandidate = () => wait.promise
  const request = h.invoke('reviewCandidate', 'approved'); await tick(); assert.equal(reviewCalls(world).length, 1)
  const args = reviewCalls(world)[0].args; invalidate(world, h, kind); wait.resolve(await success(...args)); await request; await tick()
  assert.equal(savedReviews(world)[0].status, 'received'); assert.equal(h.state.candidate, null); assert.equal(h.state.mediaReady, false)
  assert.equal(posts(world).length, 1)
})

test('explicit exact candidate GET reconciles an unknown approved review after module reload without POST', async t => {
  const world = scenario(t), h = world.mount(); await ready(h)
  const success = world.handlers.reviewExecutionUnitCandidate
  world.handlers.reviewExecutionUnitCandidate = async (...args) => { await success(...args); throw Error('lost response') }
  await h.invoke('reviewCandidate', 'approved'); assert.equal(savedReviews(world)[0].status, 'unknown')
  const fresh = world.mount(world.evaluate()); await loaded(fresh)
  assert.equal(savedReviews(world)[0].status, 'received'); assert.equal(fresh.state.candidate.status, 'approved')
  assert.equal(fresh.state.canApproveCandidate, false); assert.deepEqual({ ...fresh.state.reviewChecks }, Object.fromEntries(checkKeys.map(key => [key, 'not_checked'])))
  assert.equal(reviewCalls(world).length, 1)
})

for (const mismatch of ['decision', 'checks', 'revision', 'hash', 'attempt']) test('explicit GET with ' + mismatch + ' mismatch cannot reconcile original review unknown', async t => {
  const world = scenario(t), h = world.mount(); await ready(h); const success = world.handlers.reviewExecutionUnitCandidate
  world.handlers.reviewExecutionUnitCandidate = async (...args) => { await success(...args); throw Error('lost response') }
  await h.invoke('reviewCandidate', 'approved')
  if (mismatch === 'decision') { world.candidate.status = 'rejected'; world.candidate.review.decision = 'rejected'; world.server.units[0].status = 'rejected'; world.server.units[0].attempts[0].status = 'rejected' }
  if (mismatch === 'checks') world.candidate.review.checks.scene_action_continuity = { result: 'failed', basis: 'human_watch_listen' }
  if (mismatch === 'revision') { world.candidate.run_revision = 8; world.server.revision = 8 }
  if (mismatch === 'hash') world.candidate.candidate_hash = digest('d')
  if (mismatch === 'attempt') { world.candidate.attempt_id = 31; world.server.units[0].attempts[0].id = 31 }
  await loaded(h); assert.equal(savedReviews(world)[0].status, 'unknown'); assert.equal(reviewCalls(world).length, 1)
})

test('new run revision and candidate reload always starts a fresh unchecked human draft', async t => {
  const world = scenario(t), h = world.mount(); await ready(h)
  world.server.revision = 7; world.candidate.run_revision = 7; world.candidate.candidate_hash = digest('d')
  await loaded(h); assert.equal(world.revoked.length, 1); assert.equal(h.state.candidate.candidate_hash, digest('d'))
  assert.equal(h.state.canApproveCandidate, false); assert.deepEqual({ ...h.state.reviewChecks }, Object.fromEntries(checkKeys.map(key => [key, 'not_checked'])))
})

for (const fault of ['read', 'write', 'readback_throw', 'readback_mismatch']) test('review storage ' + fault + ' failure prevents POST', async t => {
  const world = scenario(t), h = world.mount(); await ready(h); assert.equal(h.state.canApproveCandidate, true)
  world.env.session.fault = fault; await h.invoke('reviewCandidate', 'approved'); assert.equal(reviewCalls(world).length, 0)
})

// Evidence extension after SPEC PASS: the original 71 assertions above remain unchanged.
for (const evidence of ['matching', 'decision', 'checks', 'revision']) test('new module reconciles inherited pending only with ' + evidence + ' candidate GET evidence', async t => {
  const world = scenario(t), first = world.mount(), wait = world.deferred(); await ready(first)
  const success = world.handlers.reviewExecutionUnitCandidate
  world.handlers.reviewExecutionUnitCandidate = () => wait.promise
  const request = first.invoke('reviewCandidate', 'approved'); await tick()
  assert.equal(reviewCalls(world).length, 1); assert.equal(savedReviews(world)[0].status, 'pending')
  const pendingSnapshot = world.env.session.snapshot()
  await success(...reviewCalls(world)[0].args)
  first.dispose(); await tick(); assert.equal(first.instance.isUnmounted, true)
  // Finish the old JS before restoring the exact pre-response snapshot: no old promise can overwrite the fresh module's evidence.
  wait.reject(Error('fixture old runtime terminated')); await request
  for (const [key, raw] of Object.entries(pendingSnapshot)) world.env.session.setItem(key, raw)
  assert.deepEqual(world.env.session.snapshot(), pendingSnapshot)
  if (evidence === 'decision') {
    world.candidate.status = 'rejected'; world.candidate.review.decision = 'rejected'
    world.server.units[0].status = 'rejected'; world.server.units[0].attempts[0].status = 'rejected'
  }
  if (evidence === 'checks') world.candidate.review.checks.scene_action_continuity = { result: 'failed', basis: 'human_watch_listen' }
  if (evidence === 'revision') { world.server.revision = 8; world.candidate.run_revision = 8 }
  const before = JSON.stringify(savedReviews(world)[0]), fresh = world.mount(world.evaluate())
  assert.notEqual(fresh.instance.type, first.instance.type, 'inherited pending must be read by a genuinely re-evaluated module')
  await loaded(fresh)
  assert.equal(world.calls.filter(call => call.name === 'getExecutionUnitCandidate').length, 2)
  assert.equal(fresh.state.candidate.run_revision, world.server.revision, 'the explicit candidate GET must be accepted, not fail before reconciliation')
  assert.equal(savedReviews(world)[0].status, evidence === 'matching' ? 'received' : 'pending')
  if (evidence !== 'matching') assert.equal(JSON.stringify(savedReviews(world)[0]), before)
  assert.equal(posts(world).length, 1, 'candidate GET must not retry the pending review')
})

test('same module active pending remains pending even when explicit candidate GET already sees a matching terminal review', async t => {
  const world = scenario(t), module = world.evaluate(), first = world.mount(module), second = world.mount(module), wait = world.deferred()
  await ready(first); const success = world.handlers.reviewExecutionUnitCandidate
  world.handlers.reviewExecutionUnitCandidate = () => wait.promise
  const request = first.invoke('reviewCandidate', 'approved'); await tick()
  assert.equal(reviewCalls(world).length, 1); assert.equal(savedReviews(world)[0].status, 'pending')
  const response = await success(...reviewCalls(world)[0].args), before = JSON.stringify(savedReviews(world)[0])
  await loaded(second)
  assert.equal(second.instance.type, first.instance.type); assert.equal(second.state.candidate.status, 'approved')
  assert.equal(second.state.candidate.run_revision, 7); assert.equal(JSON.stringify(savedReviews(world)[0]), before)
  assert.equal(savedReviews(world)[0].status, 'pending'); assert.equal(posts(world).length, 1)
  wait.resolve(response); await request
  assert.equal(savedReviews(world)[0].status, 'received', 'only the actually pending POST response now settles its own operation')
})

function idleReadiness(world, unitId, output, confirmation = digest('8')) {
  return { schema_version: 'redraw-execution-run-advance-readiness-v1', status: 'ready', executable: false, action: 'advance',
    phase: 'idle', run_id: 20, run_revision: world.server.revision, plan_hash: world.fixture.preview.plan_hash,
    unit_id: unitId, attempt_id: null, output_parameters: output, amount: 12, billing_mode: 'paid', quote_hash: digest('6'),
    confirmation_hash: confirmation, policy: { execution_mode: 'safe', policy_version: 2 } }
}
test('review reconciliation leaves a separately produced advance unknown slot byte-exact and keeps a genuinely ready successor locked', async t => {
  function addSuccessor(world) {
    const unit = { ...structuredClone(world.fixture.preview.units[0]), id: 'unit-2', source_start_ms: 5000, source_end_ms: 10000 }
    world.fixture.preview.units.push(unit); world.fixture.savedReview.plan = structuredClone(world.fixture.preview)
    world.fixture.queue.units.push({ id: 'unit-2', ordinal: 1, status: 'pending', unit_hash: hash(unit), plan_unit: unit })
    world.server.units.push({ id: 'unit-2', ordinal: 1, unit_hash: hash(unit), status: 'pending', attempts: [] })
  }
  // Produce the other durable slot through an actual UI advance with a stubbed lost response, not a hand-authored storage record.
  const advanceWorld = scenario(t); addSuccessor(advanceWorld)
  const advancing = advanceWorld.mount()
  advanceWorld.server.status = 'ready'; advanceWorld.server.units[0].status = 'pending'; advanceWorld.server.units[0].attempts = []
  advanceWorld.handlers.getExecutionRunReadiness = async (_v, _r, output) => idleReadiness(advanceWorld, 'unit-1', output)
  advanceWorld.handlers.advanceExecutionRun = async () => { throw Error('fixture advance response lost') }
  await selected(advancing); advancing.state.selectedResolution = '720p'; advancing.state.selectedAspectRatio = '9:16'
  await advancing.invoke('loadReadiness'); await advancing.invoke('confirmAction'); assert.equal(advancing.state.canAdvance, true)
  await advancing.invoke('advanceRun'); assert.equal(posts(advanceWorld).length, 1)
  const [advanceKey, advanceRaw] = Object.entries(advanceWorld.env.session.snapshot()).find(([, raw]) => JSON.parse(raw).action === 'advance')
  assert.equal(JSON.parse(advanceRaw).status, 'unknown'); advancing.dispose()

  const world = scenario(t); addSuccessor(world)
  assert.deepEqual(world.fixture, advanceWorld.fixture, 'both persisted intents belong to exactly the same plan and queue fixture')
  const first = world.mount(); await ready(first); const success = world.handlers.reviewExecutionUnitCandidate
  world.handlers.reviewExecutionUnitCandidate = async (...args) => { await success(...args); throw Error('fixture review response lost') }
  await first.invoke('reviewCandidate', 'approved'); assert.equal(savedReviews(world)[0].status, 'unknown')
  assert.equal(savedReviews(world)[0].scope, JSON.parse(advanceRaw).scope)
  // Replay the exact previously produced persistence bytes as inherited local state in a fresh module.
  world.env.session.setItem(advanceKey, advanceRaw); first.dispose()
  const fresh = world.mount(world.evaluate()); await loaded(fresh)
  assert.equal(savedReviews(world)[0].status, 'received'); assert.equal(world.env.session.getItem(advanceKey), advanceRaw)
  world.handlers.getExecutionRunReadiness = async (_v, _r, output) => idleReadiness(world, 'unit-2', output, digest('9'))
  fresh.state.selectedResolution = '720p'; fresh.state.selectedAspectRatio = '9:16'
  assert.equal(fresh.state.canReadiness, true); await fresh.invoke('loadReadiness'); assert.equal(fresh.state.validReadiness, true)
  assert.equal(fresh.state.canConfirm, false); await fresh.invoke('confirmAction'); await fresh.invoke('advanceRun')
  assert.equal(fresh.state.canAdvance, false); assert.equal(posts(world).length, 1)
  assert.equal(world.env.session.getItem(advanceKey), advanceRaw, 'review read must never rewrite or settle the original advance unknown bytes')
})

for (const status of ['pending', 'unknown']) for (const changed of ['candidate_hash', 'checks']) {
  test('inherited review ' + status + ' cannot be bypassed by changed ' + changed, async t => {
    const world = scenario(t), first = world.mount(), wait = world.deferred(); await ready(first)
    world.handlers.reviewExecutionUnitCandidate = () => status === 'pending' ? wait.promise : Promise.reject(Error('fixture review unknown'))
    const request = first.invoke('reviewCandidate', 'approved'); await tick()
    if (status === 'unknown') await request
    assert.equal(reviewCalls(world).length, 1); assert.equal(savedReviews(world)[0].status, status)
    const pendingSnapshot = world.env.session.snapshot(), before = JSON.stringify(savedReviews(world)[0]); first.dispose()
    if (status === 'pending') {
      wait.reject(Error('fixture old runtime terminated')); await request
      for (const [key, raw] of Object.entries(pendingSnapshot)) world.env.session.setItem(key, raw)
      assert.deepEqual(world.env.session.snapshot(), pendingSnapshot)
    }
    if (changed === 'candidate_hash') world.candidate.candidate_hash = digest('d')
    const fresh = world.mount(world.evaluate()); await loaded(fresh); await markReadable(fresh)
    await humanChecks(fresh, changed === 'checks' ? 'failed' : 'passed')
    assert.equal(fresh.state.canEditCandidate, true, 'readable media and explicit human checks stay available')
    if (changed === 'candidate_hash') assert.equal(fresh.state.candidate.candidate_hash, digest('d'))
    else assert.ok(Object.values(fresh.state.reviewChecks).every(result => result === 'failed'), 'new draft must actually differ from the submitted passed checks')
    assert.equal(fresh.state.canApproveCandidate, false); assert.equal(fresh.state.canRejectCandidate, false)
    await fresh.invoke('reviewCandidate', 'approved'); await fresh.invoke('reviewCandidate', 'rejected')
    assert.equal(reviewCalls(world).length, 1); assert.equal(JSON.stringify(savedReviews(world)[0]), before)
  })
}

for (const mismatch of ['run', 'unit', 'attempt', 'hash', 'asset', 'reviewer', 'decision', 'checks', 'revision']) {
  test('successful HTTP review DTO with wrong ' + mismatch + ' remains unknown without replacing the original intent', async t => {
    const world = scenario(t), h = world.mount(); await ready(h); const success = world.handlers.reviewExecutionUnitCandidate
    world.handlers.reviewExecutionUnitCandidate = async (...args) => {
      const value = await success(...args)
      if (mismatch === 'run') value.run_id = 21
      if (mismatch === 'unit') value.unit_id = 'other-unit'
      if (mismatch === 'attempt') value.attempt_id = 31
      if (mismatch === 'hash') value.candidate_hash = digest('d')
      if (mismatch === 'asset') value.asset.sha256 = digest('d')
      if (mismatch === 'reviewer') value.review.reviewed_by = 'other-user'
      if (mismatch === 'decision') { value.status = 'rejected'; value.review.decision = 'rejected' }
      if (mismatch === 'checks') value.review.checks.scene_action_continuity = { result: 'failed', basis: 'human_watch_listen' }
      if (mismatch === 'revision') value.run_revision = 8
      return value
    }
    await h.invoke('reviewCandidate', 'approved'); assert.equal(reviewCalls(world).length, 1)
    const intent = savedReviews(world)[0]
    assert.equal(intent.status, 'unknown'); assert.equal(intent.receipt, null)
    assert.deepEqual(intent.review, reviewCalls(world)[0].args[3]); assert.equal(intent.review.decision, 'approved')
    assert.equal(intent.review.expected_candidate_hash, digest('c')); assert.equal(intent.review.expected_revision, 6)
    assert.equal(h.state.candidate, null); assert.ok(h.state.error)
    await h.invoke('reviewCandidate', 'approved'); assert.equal(posts(world).length, 1)
  })
}
