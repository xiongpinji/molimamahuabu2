import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Mount the actual Release SFC. Only its existing transport and browser boundaries
// are synthetic; its five proof GETs, template events and lifecycle remain real.
// Four-file bytes are actual local Blobs. The MP4 bytes are deliberately NOT a
// decodable video; synthetic metadata/track events never establish audiovisual
// or human acceptance. No actual HTTP, browser, user media or storage is used.
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
const outputLabel = '核验并加载四文件'
const kinds = ['mp4', 'srt', 'vtt', 'report']
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
  const { descriptor } = parse(releaseSource), script = compileScript(descriptor, { id: 'unit-output' })
  const modules = { '@/api/redraw': { redrawAPI: world.api }, '@/utils/authSession': world.auth,
    '@/utils/redrawTimelineState': timeline,
    'vue-router': { useRoute: () => world.route, useRouter: () => ({ replace: () => world.forbid('router.replace') }) } }
  const template = compileTemplate({ id: 'unit-output', filename: 'RedrawEpisodeReleasePanel.vue',
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
    hashes: [], uuidCount: 0, hashGate: null, objectUrls: [], anchors: [], hashWaitBytes: null }
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
      const inputHash = sha(input)
      if (world.hashRejectBytes === inputHash) throw Error('synthetic digest failure')
      const gate = world.hashWaitBytes === inputHash ? world.outputHashGate : world.hashGate
      world.hashGate = null
      if (gate) { world.hashWaitBytes = null; await gate.promise }
      return Uint8Array.from(createHash('sha256').update(input).digest()).buffer
    } },
  }
  world.document = {
    activeElement: null,
    body: { appendChild: node => node, removeChild: node => node },
    createElement(tag) {
      if (tag !== 'a') return world.forbid('document.createElement.' + tag)
      const anchor = { href: '', download: '', remove() {}, style: {},
        click() {
          const entry = world.objectUrls.find(item => item.url === anchor.href && !item.revoked)
          if (!entry || !anchor.download) return world.forbid('download unverified or revoked URL')
          world.anchors.push({ href: anchor.href, download: anchor.download, blob: entry.blob })
        } }
      return anchor
    },
  }
  let urlAttempt = 0
  world.urls = {
    createObjectURL(blob) {
      urlAttempt++
      if (!(blob instanceof Blob)) return world.forbid('URL.createObjectURL non-Blob')
      if (world.failUrlAt === urlAttempt) throw Error('synthetic object URL creation denied')
      const entry = { url: 'blob:synthetic-unit-output-' + urlAttempt, blob, revoked: false }
      world.objectUrls.push(entry); return entry.url
    },
    revokeObjectURL(url) {
      const entry = world.objectUrls.find(item => item.url === url)
      if (!entry) return world.forbid('URL.revokeObjectURL unknown URL')
      entry.revoked = true
    },
  }
  world.globals = { crypto: world.crypto, localStorage: world.local, sessionStorage: world.session,
    Blob, TextEncoder, TextDecoder, URL: world.urls, document: world.document }
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
      else if (name === 'downloadExport') {
        assert.equal(args.length, 2)
        assert.equal(args[0], 401, 'only the exact originally recovered export may supply bytes')
        assert.ok(kinds.includes(args[1]))
      }
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
    assert.ok(world.objectUrls.every(item => item.revoked), 'all output and download URLs belong to the component and must be revoked on unmount')
    assert.equal(postCalls(world).length <= 1, true, 'four-file reading must never replay compose')
    assert.equal(world.uuidCount <= 1, true, 'four-file reading must never replace the original key')
  })
  world.mount(); await flush(); return world
}

function makeBundle(world, body) {
  const mode = world.value.preview.capability.audio_mode
  const subtitles = mode === 'not_required' ? { srt: '', vtt: 'WEBVTT\n\n' } : {
    srt: '1\n00:00:00,500 --> 00:00:01,500\nWait for me.\n\n2\n00:00:05,500 --> 00:00:06,500\nWait for me.\n',
    vtt: 'WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nWait for me.\n\n00:00:05.500 --> 00:00:06.500\nWait for me.\n',
  }
  const bytes = { mp4: new TextEncoder().encode('SYNTHETIC-NOT-A-DECODABLE-VIDEO\n'),
    srt: new TextEncoder().encode(subtitles.srt), vtt: new TextEncoder().encode(subtitles.vtt) }
  const quality = { decision: 'approved_inputs', approved_unit_count: 2, human_review_count: 2,
    final_media_review: 'pending', dialogue_alignment: 'not_verified' }
  const release = { schema_version: releaseSchema, project_id: 5, work_id: 1, version_id: 10,
    locale: world.value.preview.bindings.locale, market: world.value.preview.bindings.market,
    run_id: 21, run_revision: 7, plan_hash: digest('a'), source_sha256: digest('d'),
    blueprint_hash: digest('b'), localization_hash: digest('c'), duration_ms: 10000, audio_mode: mode,
    quality_summary: clone(quality), units: world.value.queue.units.map((unit, ordinal) => ({
      unit_id: unit.id, ordinal, unit_hash: unit.unit_hash, candidate_sha256: digest(String(ordinal + 2)),
      review_hash: digest(String(ordinal + 4)), timeline: { source_start_ms: ordinal * 5000,
        source_end_ms: (ordinal + 1) * 5000, retained_duration_ms: 5000, generated_duration_ms: 5000, padding_ms: 0 },
      output_start_ms: ordinal * 5000, output_end_ms: (ordinal + 1) * 5000,
    })) }
  const detail = exportRow(10, body, { status: 'completed', asset_id: 601, subtitle_asset_id: 602,
    audio_mode: mode, input_hash: digest('8'), release_hash: digest('9'), quality_summary: quality,
    output_asset_ids: { mp4: 601, srt: 602, vtt: 603, report: 604 }, hashes: {},
    // These hostile-looking strings are data only: the product must use its API,
    // never follow provider/summary URLs or pass them into the rendered media.
    downloads: Object.fromEntries(kinds.map(kind => [kind, 'https://must-not-fetch.invalid/unrelated/' + kind])),
    episode_release: release })
  const report = { schema_version: 'redraw-execution-unit-composition-report-v1', export_id: 401,
    version_id: 10, run_id: 21, release_hash: detail.release_hash, input_hash: detail.input_hash,
    final_media_review: 'pending', dialogue_alignment: 'not_verified',
    audio: { mode, disposition: mode === 'native' ? 'approved_unit_tracks_preserved' : 'video_only_no_unit_tracks',
      approved_dub_required: false, no_dialogue_required: mode === 'not_required',
      units: release.units.map(unit => ({ unit_id: unit.unit_id, input_has_audio: mode === 'native', silence_placeholder: false })),
      post_assembly_ambient_and_extra_dialogue_review_required: true },
    media: { mime_type: 'video/mp4', bytes: bytes.mp4.byteLength, sha256: sha(bytes.mp4),
      duration_ms: 10000, width: 1280, height: 720, sample_aspect_ratio: '1:1',
      display_aspect_ratio: '16:9', has_audio: mode === 'native' },
    units: release.units.map(unit => ({ unit_id: unit.unit_id, ordinal: unit.ordinal, timeline: clone(unit.timeline),
      output_start_ms: unit.output_start_ms, output_end_ms: unit.output_end_ms })),
    outputs: Object.fromEntries(['mp4', 'srt', 'vtt'].map(kind => [kind, { sha256: sha(bytes[kind]), bytes: bytes[kind].byteLength }])) }
  const bundle = { bytes, detail, report, blobs: {} }
  rebuildReport(bundle)
  return bundle
}
function rebuildReport(bundle, raw = null) {
  // Whitespace and trailing LF intentionally differ from a DTO reconstruction.
  bundle.bytes.report = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw ?? JSON.stringify(bundle.report, null, 2) + '\n')
  for (const kind of kinds) {
    bundle.detail.hashes[kind] = sha(bundle.bytes[kind])
    bundle.blobs[kind] = new Blob([bundle.bytes[kind]], { type: { mp4: 'video/mp4', srt: 'application/x-subrip',
      vtt: 'text/vtt', report: 'application/json' }[kind] })
  }
}
function originalSnapshot(world) { return world.session.snapshot() }
function downloadCalls(world) { return calls(world, 'downloadExport') }
function enabledDownloads(world) {
  return nodes(world.root, node => node.tag === 'button' && /下载/.test(visibleText(node)) && !node.disabled)
}
function downloadButton(world, kind) {
  const pattern = kind === 'report' ? /下载.*(?:报告|report)/i : new RegExp('下载.*\\b' + kind + '\\b', 'i')
  const found = enabledDownloads(world).filter(node => pattern.test(visibleText(node)))
  assert.equal(found.length, 1, 'one explicit download control for ' + kind)
  return found[0]
}
function clickNode(world, node) {
  assert.equal(typeof node.onClick, 'function')
  const pending = Promise.resolve(node.onClick({ target: node, currentTarget: node }))
  world.pending.push(pending); return pending
}
function assertNoOutput(world) {
  assert.equal(nodes(world.root, node => ['video', 'audio', 'track'].includes(node.tag)).length, 0, 'unverified or stale output is not mounted')
  assert.equal(enabledDownloads(world).length, 0, 'unverified or stale output cannot be downloaded')
  assert.doesNotMatch(visibleText(world.root), /四文件已核验|技术文件已核验|最终质量通过|可发布/)
}
function assertUrlsRevoked(world, entries = world.objectUrls) { assert.ok(entries.every(item => item.revoked), 'every superseded URL is revoked') }
function assertNeverHumanPass(world) {
  assert.match(visibleText(world.root), /(?:最终|人工|人审).*(?:待|未)|(?:待|未).*(?:最终|人工|人审)/)
  assert.doesNotMatch(visibleText(world.root), /最终质量通过|真人验收通过|对白已听验|可发布/)
}
function player(world) {
  const videos = nodes(world.root, node => node.tag === 'video')
  assert.equal(videos.length, 1, 'one real unit-only controlled video')
  const video = videos[0]
  assert.ok(video.controls === '' || video.controls === true, 'browser-native media controls')
  const mp4 = world.objectUrls.find(item => item.url === video.src && !item.revoked)
  assert.ok(mp4 && mp4.blob === world.bundle.blobs.mp4, 'player uses this verified export MP4 Blob')
  const tracks = nodes(video, node => node.tag === 'track')
  assert.equal(tracks.length, 1, 'one actual subtitles track')
  assert.equal(tracks[0].kind, 'subtitles')
  assert.equal(tracks[0].srclang, world.value.preview.bindings.locale, 'subtitle locale comes from the verified release')
  const vtt = world.objectUrls.find(item => item.url === tracks[0].src && !item.revoked)
  assert.ok(vtt && vtt.blob === world.bundle.blobs.vtt, 'track uses the same verified export VTT Blob')
  assertNeverHumanPass(world)
  return { video, track: tracks[0] }
}
function dispatchMedia(node, property, overrides = {}) {
  assert.equal(typeof node[property], 'function', 'real template handles ' + property)
  Object.assign(node, { videoWidth: 1280, videoHeight: 720, duration: 10, ...overrides })
  return node[property]({ target: node, currentTarget: node })
}
async function recovered(t, mode = 'native', configure = () => {}) {
  const world = await scenario(t, current => {
    current.value = fixture(mode); current.props = vue.reactive(propsFor(current.value)); configure(current)
  })
  assert.deepEqual(world.calls.slice(0, 5).map(call => call.name), proofNames)
  world.handlers.composeVersion = async () => ({ export_id: 401, status: 'completed' })
  await world.click(composeLabel)
  world.bundle = makeBundle(world, postCalls(world)[0].args[1])
  world.handlers.listExports = async () => [
    { ...clone(world.bundle.detail), id: 999, request_hash: digest('f'), version_number: 999 },
    clone(world.bundle.detail),
  ]
  world.handlers.getExport = async () => clone(world.bundle.detail)
  world.handlers.downloadExport = async (_id, kind) => world.bundle.blobs[kind]
  await world.click(recoverLabel)
  assert.equal(calls(world, 'getExport').length, 1)
  assertNoOutput(world)
  assert.equal(downloadCalls(world).length, 0, 'completed recovery is not automatic file loading')
  world.originalIntent = originalSnapshot(world)
  return world
}
async function loadOutput(world) { await world.click(outputLabel) }
function assertSingleRead(world) {
  assert.deepEqual(downloadCalls(world).map(call => call.args), kinds.map(kind => [401, kind]), 'read exact export files in contract order')
  assert.deepEqual(calls(world, 'getExport').map(call => call.args), [[401], [401]], 'explicit loading rereads that exact detail')
  assert.equal(postCalls(world).length, 1, 'only setup composed; no output operation replay')
  assert.deepEqual(originalSnapshot(world), world.originalIntent, 'output reads do not alter original intent')
}
function failNewProof(world) { world.handlers.getLocalization = async () => { throw Error('synthetic new proof denied') } }
function invalidate(world, dimension) {
  failNewProof(world)
  const context = world.props.unitContext
  if (dimension === 'owner') { context.owner[1] = 'user-b'; context.owner[1] = 'user-a' }
  else if (dimension === 'tenant') { context.owner[0] = 'tenant-b'; context.owner[0] = 'tenant-a' }
  else if (dimension === 'project') { context.project_id = 6; context.project_id = 5 }
  else if (dimension === 'work') { context.work_id = 2; context.work_id = 1 }
  else if (dimension === 'version') { context.version_id = 11; context.version_id = 10 }
  else if (dimension === 'policy') { context.policy.execution_mode = 'auto'; context.policy.execution_mode = 'safe' }
  else if (dimension === 'epoch') { context.policy.epoch = 1; context.policy.epoch = 0 }
  else if (dimension === 'unmount') world.unmount()
  else assert.fail('unknown invalidation ' + dimension)
}

for (const mode of ['native', 'not_required']) {
  test(mode + ': explicit exact-export four-file read publishes only byte-verified media, subtitles and original report downloads', async t => {
    const world = await recovered(t, mode)
    assert.equal(world.objectUrls.length, 0)
    await loadOutput(world)
    assertSingleRead(world)
    assert.match(visibleText(world.root), /四文件已核验|技术文件已核验/)
    const { video, track } = player(world)
    assert.match(visibleText(world.root), /未加载|尚未加载|等待.*加载/)
    assert.match(visibleText(world.root), mode === 'native' ? /native|原生音轨/ : /not_required|无需对白|不要求对白/)
    if (mode === 'not_required') assert.equal(world.bundle.blobs.srt.size, 0, 'empty SRT is a real valid Blob')
    const beforeDownloadCount = downloadCalls(world).length
    for (const kind of kinds) {
      const button = downloadButton(world, kind)
      await clickNode(world, button); await flush()
      const actual = world.anchors.at(-1)
      assert.equal(actual.blob, world.bundle.blobs[kind], 'download keeps exact originally verified Blob for ' + kind)
      assert.deepEqual(new Uint8Array(await actual.blob.arrayBuffer()), world.bundle.bytes[kind])
      assert.match(actual.download, new RegExp(kind === 'report' ? '\\.json$' : '\\.' + kind + '$', 'i'))
    }
    assert.equal(downloadCalls(world).length, beforeDownloadCount, 'downloads reuse verified bytes without another GET')
    assert.equal(world.anchors.length, 4)
    assert.notEqual(await world.bundle.blobs.report.text(), JSON.stringify(world.bundle.report), 'report whitespace is significant raw provenance')
    assert.equal(world.objectUrls.find(item => item.url === video.src).revoked, false, 'downloading never revokes the active player')
    assert.equal(world.objectUrls.find(item => item.url === track.src).revoked, false)
    assertNeverHumanPass(world)
  })
}

test('not_required with available tracks and missing intervals preserves explicit silence planning without asserting dialogue quality', async t => {
  const world = await recovered(t, 'not_required')
  world.bundle.report.media.has_audio = true
  world.bundle.report.audio.disposition = 'available_unit_tracks_preserved_with_missing_intervals_silenced'
  world.bundle.report.audio.units[0].input_has_audio = true
  world.bundle.report.audio.units[1].silence_placeholder = true
  rebuildReport(world.bundle)
  await loadOutput(world); player(world); assertNeverHumanPass(world)
})

test('valid assembly duration tolerance and non-square sample pixels do not require exact duration or fixed raster dimensions', async t => {
  const world = await recovered(t)
  for (const duration of [9700, 10300]) {
    world.bundle = makeBundle(world, postCalls(world)[0].args[1])
    // 960/720 * 4/3 = 16/9. Assembly preserves the approved first-unit
    // geometry and permits max(250 ms, 3%) timing drift, not just 1280x720.
    Object.assign(world.bundle.report.media, { duration_ms: duration, width: 960,
      height: 720, sample_aspect_ratio: '4:3', display_aspect_ratio: '16:9' })
    rebuildReport(world.bundle)
    await world.click(recoverLabel)
    await loadOutput(world); player(world); assertNeverHumanPass(world)
  }
})

test('target subtitle language is taken from the verified non-English locale, not a hard-coded en label', async t => {
  const world = await recovered(t, 'native', current => {
    current.value.preview.bindings.locale = 'fr'; current.value.preview.bindings.market = 'FR'
    current.value.review.plan = clone(current.value.preview)
    current.value.localization.locale = 'fr'; current.value.localization.market = 'FR'
    current.value.localization.localization.locale = 'fr'; current.value.localization.localization.market = 'FR'
  })
  await loadOutput(world); assert.equal(player(world).track.srclang, 'fr')
})

test('completed POST receipt alone offers no four-file authority, downloads or player', async t => {
  const world = await scenario(t)
  world.handlers.composeVersion = async () => ({ export_id: 401, status: 'completed', hashes: { mp4: digest('a') } })
  await world.click(composeLabel)
  const button = world.findButton(outputLabel)[0]
  assert.ok(!button || button.disabled)
  assert.equal(downloadCalls(world).length, 0); assert.equal(calls(world, 'getExport').length, 0); assertNoOutput(world)
})

for (const status of ['pending', 'processing', 'failed', 'needs_attention']) {
  test('recovered ' + status + ' is not downloadable even when a DTO advertises hashes', async t => {
    const world = await recovered(t)
    world.bundle.detail.status = status
    await world.click(recoverLabel)
    const button = world.findButton(outputLabel)[0]
    assert.ok(!button || button.disabled)
    assert.equal(downloadCalls(world).length, 0); assertNoOutput(world)
  })
}

const detailMutations = [
  ['exact export ID', detail => { detail.id = 999 }],
  ['completed state', detail => { detail.status = 'processing' }],
  ['composition schema', detail => { detail.schema_version = 'redraw-episode-release-v1' }],
  ['video kind', detail => { detail.export_type = 'audio' }],
  ['version', detail => { detail.version_id = 11 }],
  ['run', detail => { detail.run_id = 22 }],
  ['plan', detail => { detail.plan_hash = digest('f') }],
  ['request digest', detail => { detail.request_hash = digest('f') }],
  ['key digest', detail => { detail.idempotency_key_sha256 = digest('f') }],
  ['release schema', detail => { detail.episode_release.schema_version = 'redraw-episode-release-v1' }],
  ['project', detail => { detail.episode_release.project_id = 6 }],
  ['work', detail => { detail.episode_release.work_id = 2 }],
  ['release version', detail => { detail.episode_release.version_id = 11 }],
  ['release run', detail => { detail.episode_release.run_id = 22 }],
  ['run revision', detail => { detail.episode_release.run_revision = 8 }],
  ['release plan', detail => { detail.episode_release.plan_hash = digest('f') }],
  ['locale', detail => { detail.episode_release.locale = 'zh' }],
  ['market', detail => { detail.episode_release.market = 'CN' }],
  ['release audio mode', detail => { detail.episode_release.audio_mode = 'replace' }],
  ['top-level audio mode', detail => { detail.audio_mode = 'not_required' }],
  ['release hash', detail => { detail.release_hash = null }],
  ['input hash', detail => { detail.input_hash = 'not-a-sha' }],
  ['missing release', detail => { delete detail.episode_release }],
  ['top-level MP4 asset ID', detail => { detail.asset_id = 999 }],
  ['top-level SRT asset ID', detail => { detail.subtitle_asset_id = 999 }],
  ...kinds.map(kind => [kind + ' missing asset ID', detail => { delete detail.output_asset_ids[kind] }]),
  ...kinds.map(kind => [kind + ' invalid asset ID', detail => { detail.output_asset_ids[kind] = '601' }]),
  ...kinds.map(kind => [kind + ' missing hash', detail => { delete detail.hashes[kind] }]),
  ...kinds.map(kind => [kind + ' malformed hash', detail => { detail.hashes[kind] = 'sha' }]),
]
for (const [group, mutations] of [
  ['original request identity', detailMutations.slice(0, 9)],
  ['current release bindings', detailMutations.slice(9, 25)],
  ['all four output asset IDs', detailMutations.slice(25, 33)],
  ['all four advertised SHA-256 values', detailMutations.slice(33)],
]) {
  test('fresh detail rejects invalid ' + group + ' before reading any file', async t => {
    const world = await recovered(t), valid = clone(world.bundle.detail)
    // One mounted component, explicit rechecks, separate named assertions:
    // these are field-level invariants, not a Cartesian combination matrix.
    for (const [name, mutate] of mutations) {
      world.bundle.detail = clone(valid)
      await world.click(recoverLabel)
      mutate(world.bundle.detail)
      await loadOutput(world)
      assert.equal(downloadCalls(world).length, 0, name + ': invalid fresh detail never authorizes file reads')
      assertNoOutput(world); assert.equal(world.objectUrls.length, 0, name)
      assert.deepEqual(originalSnapshot(world), world.originalIntent, name)
    }
  })
}

for (const kind of kinds) {
  test(kind + ': GET/type/byte-read/digest failures publish no partial result and stop the file sequence', async t => {
    const world = await recovered(t)
    for (const fault of ['GET rejected', 'not Blob', 'arrayBuffer rejected', 'digest rejected', 'digest mismatch']) {
      world.bundle = makeBundle(world, postCalls(world)[0].args[1]); world.hashRejectBytes = null
      await world.click(recoverLabel)
      const baseline = world.bundle.blobs[kind], before = downloadCalls(world).length
      if (fault === 'digest rejected') world.hashRejectBytes = sha(world.bundle.bytes[kind])
      if (fault === 'digest mismatch') world.bundle.blobs[kind] = new Blob(['different bytes'], { type: baseline.type })
      world.handlers.downloadExport = async (_id, requested) => {
        if (requested !== kind) return world.bundle.blobs[requested]
        if (fault === 'GET rejected') throw Error('synthetic file GET failure')
        if (fault === 'not Blob') return { data: 'not a Blob', size: baseline.size }
        if (fault === 'arrayBuffer rejected') return new class extends Blob {
          async arrayBuffer() { throw Error('synthetic Blob read failure') }
        }([world.bundle.bytes[kind]], { type: baseline.type })
        return world.bundle.blobs[kind]
      }
      await loadOutput(world)
      assert.deepEqual(downloadCalls(world).slice(before).map(call => call.args[1]), kinds.slice(0, kinds.indexOf(kind) + 1), fault)
      assertNoOutput(world); assert.equal(world.objectUrls.length, 0, fault)
      assert.deepEqual(originalSnapshot(world), world.originalIntent, fault)
    }
  })
}

const reportMutations = [
  ['schema', report => { report.schema_version = 'redraw-composition-report-v1' }],
  ['export ID', report => { report.export_id = 402 }],
  ['version ID', report => { report.version_id = 11 }],
  ['run ID', report => { report.run_id = 22 }],
  ['release hash', report => { report.release_hash = digest('e') }],
  ['input hash', report => { report.input_hash = digest('e') }],
  ['final review claim', report => { report.final_media_review = 'passed' }],
  ['dialogue alignment claim', report => { report.dialogue_alignment = 'verified' }],
  ['audio mode', report => { report.audio.mode = 'replace' }],
  ['native disposition', report => { report.audio.disposition = 'video_only_no_unit_tracks' }],
  ['dub approval requirement', report => { report.audio.approved_dub_required = true }],
  ['dialogue planning', report => { report.audio.no_dialogue_required = true }],
  ['missing later audio review', report => { report.audio.post_assembly_ambient_and_extra_dialogue_review_required = false }],
  ['native silent output', report => { report.media.has_audio = false }],
  ['missing audio declaration', report => { delete report.media.has_audio }],
  ['MP4 media hash', report => { report.media.sha256 = digest('e') }],
  ['MP4 media byte count', report => { report.media.bytes += 1 }],
  ['media MIME', report => { report.media.mime_type = 'audio/mpeg' }],
  ['zero duration', report => { report.media.duration_ms = 0 }],
  ['wrong duration', report => { report.media.duration_ms = 5000 }],
  ['zero width', report => { report.media.width = 0 }],
  ['wrong width', report => { report.media.width = 1920 }],
  ['zero height', report => { report.media.height = 0 }],
  ['wrong height', report => { report.media.height = 1080 }],
  ['wrong display aspect', report => { report.media.display_aspect_ratio = '9:16' }],
  ['invalid sample aspect', report => { report.media.sample_aspect_ratio = '0:0' }],
  ...['mp4', 'srt', 'vtt'].flatMap(kind => [
    [kind + ' output hash', report => { report.outputs[kind].sha256 = digest('f') }],
    [kind + ' output bytes', report => { report.outputs[kind].bytes += 1 }],
    [kind + ' output missing', report => { delete report.outputs[kind] }],
  ]),
]
for (const [group, mutations] of [
  ['report identity and review claims', reportMutations.slice(0, 8)],
  ['audio planning and track declaration', reportMutations.slice(8, 15)],
  ['MP4 bytes/MIME/duration', reportMutations.slice(15, 20)],
  ['media geometry', reportMutations.slice(20, 26)],
  ['each of the three output byte/hash bindings', reportMutations.slice(26)],
]) {
  test('hash-valid report rejects invalid ' + group + ' without publishing output', async t => {
    const world = await recovered(t)
    for (const [name, mutate] of mutations) {
      world.bundle = makeBundle(world, postCalls(world)[0].args[1])
      await world.click(recoverLabel)
      mutate(world.bundle.report); rebuildReport(world.bundle)
      const before = downloadCalls(world).length
      await loadOutput(world)
      assert.equal(downloadCalls(world).length - before, 4, name + ': compare the report with all actual file bytes')
      assertNoOutput(world); assert.equal(world.objectUrls.length, 0, name)
    }
  })
}

test('matching hashes cannot legitimize invalid UTF-8/JSON/VTT or an empty MP4', async t => {
  const world = await recovered(t)
  for (const fault of ['invalid UTF-8 report', 'invalid JSON report', 'invalid UTF-8 VTT', 'invalid VTT', 'empty MP4']) {
    world.bundle = makeBundle(world, postCalls(world)[0].args[1])
    await world.click(recoverLabel)
    if (fault === 'invalid UTF-8 report') rebuildReport(world.bundle, new Uint8Array([0xc3, 0x28]))
    if (fault === 'invalid JSON report') rebuildReport(world.bundle, '{"unfinished":')
    if (fault === 'invalid UTF-8 VTT') {
      world.bundle.bytes.vtt = new Uint8Array([0xc3, 0x28])
      world.bundle.report.outputs.vtt = { sha256: sha(world.bundle.bytes.vtt), bytes: 2 }; rebuildReport(world.bundle)
    }
    if (fault === 'invalid VTT') {
      world.bundle.bytes.vtt = new TextEncoder().encode('not WEBVTT\n')
      world.bundle.report.outputs.vtt = { sha256: sha(world.bundle.bytes.vtt), bytes: world.bundle.bytes.vtt.length }; rebuildReport(world.bundle)
    }
    if (fault === 'empty MP4') {
      world.bundle.bytes.mp4 = new Uint8Array()
      world.bundle.report.outputs.mp4 = { sha256: sha(world.bundle.bytes.mp4), bytes: 0 }
      Object.assign(world.bundle.report.media, world.bundle.report.outputs.mp4); rebuildReport(world.bundle)
    }
    await loadOutput(world); assertNoOutput(world); assert.equal(world.objectUrls.length, 0, fault)
  }
})

for (const [fault, text] of [
  ['malformed timestamp', 'WEBVTT\n\n1\n00:00:bad --> 00:00:01.500\nHello\n'],
  ['seconds out of range', 'WEBVTT\n\n00:00:60.000 --> 00:01:01.000\nHello\n'],
  ['end before start', 'WEBVTT\n\n00:00:02.000 --> 00:00:01.500\nHello\n'],
  ['missing header separator', 'WEBVTT\n00:00:00.500 --> 00:00:01.500\nHello\n'],
  ['missing timing separator', 'WEBVTT\n\n1\n00:00:00.500 - 00:00:01.500\nHello\n'],
  ['empty cue text', 'WEBVTT\n\n1\n00:00:00.500 --> 00:00:01.500\n'],
  ['missing cue separator', 'WEBVTT\n\n1\n00:00:00.500 --> 00:00:01.500\nHello\n2\n00:00:05.500 --> 00:00:06.500\nAgain\n'],
]) {
  test('hash-valid VTT rejects ' + fault + ' before any media URL or download is published', async t => {
    const world = await recovered(t)
    world.bundle.bytes.vtt = new TextEncoder().encode(text)
    world.bundle.report.outputs.vtt = { sha256: sha(world.bundle.bytes.vtt), bytes: world.bundle.bytes.vtt.length }
    rebuildReport(world.bundle)
    await loadOutput(world)
    assert.equal(downloadCalls(world).length, 4, 'all matching bytes and report reached the format check')
    assertNoOutput(world); assert.equal(world.objectUrls.length, 0)
    assert.deepEqual(originalSnapshot(world), world.originalIntent)
  })
}

test('backend-style numbered multiline VTT and CRLF retain their exact original Blob bytes', async t => {
  const world = await recovered(t)
  for (const newline of ['\n', '\r\n']) {
    if (world.objectUrls.length) await world.click(recoverLabel)
    const text = ['WEBVTT', '', '1', '00:00:00.500 --> 00:00:01.500', 'Wait &amp; listen.',
      '&lt;Stay here.&gt;', '', '2', '00:00:05.500 --> 00:00:06.500', 'Come back.', ''].join(newline)
    world.bundle.bytes.vtt = new TextEncoder().encode(text)
    world.bundle.report.outputs.vtt = { sha256: sha(world.bundle.bytes.vtt), bytes: world.bundle.bytes.vtt.length }
    rebuildReport(world.bundle)
    await loadOutput(world); player(world)
    await clickNode(world, downloadButton(world, 'vtt'))
    assert.equal(world.anchors.at(-1).blob, world.bundle.blobs.vtt)
    assert.equal(await world.anchors.at(-1).blob.text(), text, 'parsing must not reserialize or normalize downloaded bytes')
  }
})

test('fresh detail GET failure leaves no old player or automatic retry', async t => {
  const world = await recovered(t); await loadOutput(world); player(world)
  const oldUrls = [...world.objectUrls]
  world.handlers.getExport = async () => { throw Error('synthetic fresh detail unavailable') }
  await loadOutput(world)
  assertNoOutput(world); assertUrlsRevoked(world, oldUrls)
  assert.equal(downloadCalls(world).length, 4, 'fresh-detail failure never redownloads')
  assert.deepEqual(originalSnapshot(world), world.originalIntent)
})

test('double click uses one output read lock before fresh-detail await and reads the four files once', async t => {
  const world = await recovered(t), wait = world.defer()
  world.handlers.getExport = () => wait.promise
  const first = world.beginClick(outputLabel), second = world.beginClick(outputLabel)
  await flush()
  assert.equal(calls(world, 'getExport').length, 2)
  assert.equal(downloadCalls(world).length, 0)
  wait.resolve(clone(world.bundle.detail)); await Promise.all([first, second]); await flush()
  assertSingleRead(world); player(world)
})

for (const attempt of [1, 2]) {
  test('object URL creation failure at ' + attempt + ' reclaims any partial URLs and publishes no media', async t => {
    const world = await recovered(t); world.failUrlAt = attempt
    await loadOutput(world)
    assertNoOutput(world); assertUrlsRevoked(world)
    assert.equal(downloadCalls(world).length, 4)
  })
}

test('manual revalidation revokes old media first, rereads only the original export, and preserves its intent', async t => {
  const world = await recovered(t); await loadOutput(world)
  const old = player(world), urls = [...world.objectUrls], wait = world.defer()
  world.handlers.getExport = () => wait.promise
  const pending = world.beginClick(outputLabel); await flush()
  assertNoOutput(world); assertUrlsRevoked(world, urls)
  wait.resolve(clone(world.bundle.detail)); await pending; await flush()
  const current = player(world)
  assert.notEqual(current.video.src, old.video.src); assert.notEqual(current.track.src, old.track.src)
  assert.deepEqual(downloadCalls(world).map(call => call.args), [...kinds, ...kinds].map(kind => [401, kind]))
  assert.equal(postCalls(world).length, 1); assert.deepEqual(originalSnapshot(world), world.originalIntent)
})

const contexts = ['owner', 'tenant', 'project', 'work', 'version', 'policy', 'epoch', 'unmount']
for (const dimension of contexts) {
  test('visible output ' + dimension + ' invalidation/ABA immediately discards players, download actions and owned URLs', async t => {
    const world = await recovered(t); await loadOutput(world)
    const old = player(world), oldDownload = downloadButton(world, 'report')
    invalidate(world, dimension); await flush()
    assertNoOutput(world); assertUrlsRevoked(world)
    const prior = world.anchors.length, urlCount = world.objectUrls.length, fileCalls = downloadCalls(world).length
    await clickNode(world, oldDownload); await flush()
    assert.equal(world.anchors.length, prior, 'a retained stale click cannot download')
    assert.equal(world.objectUrls.length, urlCount, 'a stale click cannot create a replacement URL')
    assert.equal(downloadCalls(world).length, fileCalls)
    if (typeof old.video.onCanplay === 'function') { dispatchMedia(old.video, 'onCanplay'); await flush() }
    if (typeof old.track.onLoad === 'function') { dispatchMedia(old.track, 'onLoad'); await flush() }
    assertNoOutput(world); assert.equal(postCalls(world).length, 1)
  })
}

const lateStages = ['detail', ...kinds.map(kind => 'download:' + kind), ...kinds.map(kind => 'hash:' + kind), 'read:mp4', 'read:report']
for (const [index, stage] of lateStages.entries()) {
  const dimension = contexts[index % contexts.length]
  test(stage + ' response arriving after ' + dimension + ' invalidation cannot publish or continue the read sequence', async t => {
    const world = await recovered(t), wait = world.defer()
    if (stage === 'detail') world.handlers.getExport = () => wait.promise
    else if (stage.startsWith('download:')) {
      const kind = stage.split(':')[1]
      world.handlers.downloadExport = async (_id, current) => current === kind ? wait.promise : world.bundle.blobs[current]
    } else if (stage.startsWith('read:')) {
      const kind = stage.split(':')[1]
      world.handlers.downloadExport = async (_id, current) => current === kind ? new class extends Blob {
        arrayBuffer() { return wait.promise }
      }([world.bundle.bytes[kind]], { type: world.bundle.blobs[kind].type }) : world.bundle.blobs[current]
    } else {
      world.hashWaitBytes = sha(world.bundle.bytes[stage.split(':')[1]]); world.outputHashGate = wait
    }
    const pending = world.beginClick(outputLabel); await flush()
    const issued = downloadCalls(world).length, readCount = calls(world, 'getExport').length
    if (stage === 'detail') assert.equal(issued, 0)
    else assert.equal(issued, kinds.indexOf(stage.split(':')[1]) + 1, 'the actual controlled await was reached')
    invalidate(world, dimension); await flush()
    wait.resolve(stage === 'detail' ? clone(world.bundle.detail)
      : stage.startsWith('download:') ? world.bundle.blobs[stage.split(':')[1]]
        : stage.startsWith('read:') ? world.bundle.bytes[stage.split(':')[1]].slice().buffer : null)
    await pending; await flush()
    assert.equal(downloadCalls(world).length, issued, 'no later file GET after invalidation')
    assert.equal(calls(world, 'getExport').length, readCount, 'no guessed replacement export')
    assertNoOutput(world); assertUrlsRevoked(world); assert.equal(world.objectUrls.length, 0)
  })
}

test('real media and subtitle events expose technical readiness/errors without asserting human quality', async t => {
  const world = await recovered(t); await loadOutput(world)
  const { video, track } = player(world)
  assert.match(visibleText(world.root), /未加载|尚未加载|等待.*加载/)
  dispatchMedia(video, 'onLoadedmetadata'); await flush()
  assertNeverHumanPass(world)
  dispatchMedia(video, 'onCanplay'); await flush()
  assert.match(visibleText(world.root), /可播放|可以播放/)
  dispatchMedia(track, 'onLoad'); await flush()
  assert.match(visibleText(world.root), /字幕.*(?:已加载|就绪)/)
  dispatchMedia(track, 'onError'); await flush()
  assert.match(visibleText(world.root), /字幕.*(?:失败|错误)/)
  dispatchMedia(video, 'onError', { error: { code: 3 } }); await flush()
  assert.match(visibleText(world.root), /(?:播放|视频).*(?:失败|错误)/)
  assertNeverHumanPass(world)
})

test('late old media/track events cannot change a newly verified player after explicit revalidation', async t => {
  const world = await recovered(t); await loadOutput(world); const old = player(world)
  await loadOutput(world); const current = player(world)
  dispatchMedia(old.video, 'onCanplay'); dispatchMedia(old.video, 'onError', { error: { code: 3 } })
  dispatchMedia(old.track, 'onLoad'); dispatchMedia(old.track, 'onError'); await flush()
  assert.match(visibleText(world.root), /未加载|尚未加载|等待.*加载/)
  assert.doesNotMatch(visibleText(world.root), /(?:播放|视频|字幕).*(?:失败|错误)/)
  assert.equal(player(world).video.src, current.video.src)
  dispatchMedia(current.video, 'onCanplay'); await flush()
  assert.match(visibleText(world.root), /可播放|可以播放/); assertNeverHumanPass(world)
})

test('retained download handlers cannot download a newer verified generation', async t => {
  const world = await recovered(t); await loadOutput(world)
  const oldDownloads = kinds.map(kind => downloadButton(world, kind))
  await loadOutput(world)
  const current = player(world), urlCount = world.objectUrls.length, fileCalls = downloadCalls(world).length
  for (const button of oldDownloads) await clickNode(world, button)
  await flush()
  assert.equal(world.anchors.length, 0, 'old controls cannot resolve to the new generation')
  assert.equal(world.objectUrls.length, urlCount)
  assert.equal(downloadCalls(world).length, fileCalls)
  for (const kind of kinds) await clickNode(world, downloadButton(world, kind))
  await flush()
  assert.equal(world.anchors.length, 4, 'current controls remain usable')
  assert.equal(world.anchors[0].href, current.video.src)
  for (const [index, kind] of kinds.entries()) assert.equal(world.anchors[index].blob, world.bundle.blobs[kind])
  assert.equal(downloadCalls(world).length, fileCalls)
  assert.equal(postCalls(world).length, 1)
})

for (const stage of ['visible', 'download:report']) {
  test('delivered version prop A-B-A invalidates ' + stage + ' output without reusing its generation', async t => {
    const world = await recovered(t), wait = world.defer()
    if (stage === 'download:report') {
      world.handlers.downloadExport = async (_id, kind) => kind === 'report' ? wait.promise : world.bundle.blobs[kind]
    }
    const pending = world.beginClick(outputLabel); await flush()
    if (stage === 'visible') { await pending; player(world) }
    else assert.equal(downloadCalls(world).length, 4, 'the held report GET was actually reached')
    failNewProof(world)
    // Top-level props are parent-render batched. Deliver B before returning to A;
    // synchronous nested-context ABA is covered separately above.
    world.props.versionId = 11; await flush()
    assertNoOutput(world); assertUrlsRevoked(world)
    world.props.versionId = 10; await flush()
    wait.resolve(world.bundle.blobs.report); await pending; await flush()
    assertNoOutput(world); assertUrlsRevoked(world)
    assert.equal(downloadCalls(world).length, 4)
    assert.equal(postCalls(world).length, 1)
    assert.deepEqual(originalSnapshot(world), world.originalIntent)
  })
}
