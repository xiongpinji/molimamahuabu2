import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Real Workspace -> Source -> Localization -> Plan -> Run and real Edit -> Release.
// Only transport, storage, router, timers and unrelated presentation are synthetic.
// These renderer checks do not establish HTTP, browser, playable media or delivery acceptance.
const source = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const digest = character => character.repeat(64)
const clone = value => JSON.parse(JSON.stringify(value))
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
const time = '2026-09-09T00:00:00.000Z'
async function flush() { for (let index = 0; index < 24; index++) { await vue.nextTick(); await Promise.resolve() } }
function pureModule(relative) {
  const text = source(relative), names = [...text.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1])
  assert.ok(names.length > 0)
  assert.doesNotMatch(text, /^import\s/m, 'real state helpers must remain import-free')
  return new Function(text.replace(/^export /gm, '') + `\nreturn {${names.join(',')}}`)()
}
const stateHelpers = pureModule('../src/utils/redrawWorkspaceState.js')
const blueprintHelpers = pureModule('../src/utils/redrawBlueprintReviewState.js')
const timelineHelpers = pureModule('../src/utils/redrawTimelineState.js')
const sourceAudioSeamReview = pureModule('../src/utils/redrawSourceAudioSeamReview.js')
const authSource = source('../src/utils/authSession.js')

function fixture(audioMode = 'native') {
  // Match publicLocalizationReview/normalizeEpisodeDialogue and previewVersionExecutionPlan:
  // review is the public status; native/replace require a spoken source and its exact mapping.
  const spoken = audioMode !== 'not_required'
  const sourceDialogue = { id: 'dialogue-1', speaker_id: 'character-1', speaker_kind: 'character',
    start_ms: 500, end_ms: 1500, source_text: '等等我。', source_language: 'zh-CN', emotion: '平静',
    evidence_refs: ['evidence-audio-1'] }
  const dialogueMap = spoken ? [{ source_dialogue_id: sourceDialogue.id, shot_id: 'shot-1', speaker_id: sourceDialogue.speaker_id,
    speaker_kind: sourceDialogue.speaker_kind, source_text: sourceDialogue.source_text, target_text: 'Wait for me.',
    start_ms: 500, end_ms: 1500, estimated_duration_ms: 1000, estimated_speech_rate: 12,
    emotion: sourceDialogue.emotion, pronunciation_hint: '' }] : []
  const unit = { id: 'unit-1', source_start_ms: 0, source_end_ms: 5000,
    parent_shots: [{ id: 'shot-1', contract_hash: digest('6'), source_start_ms: 0, source_end_ms: 5000, unit_start_ms: 0, unit_end_ms: 5000 }],
    retained_duration_ms: 5000, generated_duration_ms: 5000, padding_ms: 0,
    dialogues: spoken ? [{ id: sourceDialogue.id, start_ms: 500, end_ms: 1500, source_text: sourceDialogue.source_text,
      target_text: dialogueMap[0].target_text, evidence_ref: 'evidence-audio-1', evidence_sha256: digest('7'),
      estimated_duration_ms: 1000, unit_start_ms: 500, unit_end_ms: 1500 }] : [],
    reference_requirements: [{ id: 'motion-shot-1', kind: 'video', requirement_hash: digest('8') }] }
  const bindings = { tenant_id: 'tenant-a', user_id: 'user-a', work_id: 1, version_id: 10, source_asset_id: 101,
    source_sha256: digest('d'), blueprint_hash: digest('b'), localization_hash: digest('c'), capability_hash: digest('e'),
    localization_updated_at: time, locale: 'en', market: 'US' }
  const preview = { schema_version: 'redraw-execution-plan-preview-v1', status: 'ready', executable: false,
    plan_hash: digest('a'), bindings, units: [unit], blocking_reasons: [], execution_blockers: ['PREVIEW_ONLY'],
    capability: { model: 'synthetic-unit-model', audio_mode: audioMode, resolutions: ['480p', '720p'], aspect_ratios: ['9:16', '16:9'] } }
  const value = {
    project: { id: 5, tenant_id: 'tenant-a', user_id: 'user-a', title: 'Unit delivery renderer fixture', status: 'active',
      execution_mode: 'safe', policy_version: 2, default_locale: 'en', default_market: 'US', localization_level: 'full',
      budget_limit_credits: null, max_auto_attempts_per_shot: null, created_at: time, updated_at: time },
    // Deliberately NOT 4: unit review updates its run, not this legacy shot-step field.
    work: { id: 1, project_id: 5, version_id: 10, current_step: 1, title: 'Synthetic work', status: 'completed', shots: [],
      analysis_task: { status: 'completed' }, localization_task: { id: 'synthetic-localization', status: 'completed' },
      localization_review_status: 'review' },
    blueprint: { work_id: 1, status: 'locked', blueprint_hash: digest('b'),
      blueprint: { characters: [{ id: 'character-1', source_name: '林岚' }],
        shots: [{ id: 'shot-1', start_ms: 0, end_ms: 5000, dialogue: spoken ? [sourceDialogue] : [],
          audio_contract: { dialogue_mode: spoken ? 'spoken' : 'silent', ambient_audio: 'preserve_or_rebuild' } }] } },
    record: { work_id: 1, version_id: 10, version: 1, status: 'review', locale: 'en', market: 'US',
      blueprint_hash: digest('b'), localization_hash: digest('c'), updated_at: time,
      localization: { schema_version: 'episode-localization-v1', blueprint_hash: digest('b'), localization_hash: digest('c'),
        locale: 'en', market: 'US', character_name_map: { 'character-1': 'Maya' }, dialogue_map: dialogueMap, text_region_map: [],
        cultural_adaptations: [], glossary: [], locked_terms: [], review: { status: 'review', updated_at: time,
          character_name_map: { 'character-1': true }, dialogue_map: spoken ? { 'dialogue-1': true } : {},
          text_region_map: {}, cultural_adaptations: {}, glossary: {}, locked_terms: {} } } },
    preview, savedReview: { id: 4, status: 'current', saved_at: time, plan_hash: preview.plan_hash, plan: clone(preview) },
    queue: { id: 8, version_id: 10, work_id: 1, status: 'waiting_readiness', executable: false, plan_hash: preview.plan_hash,
      execution_blockers: ['PREVIEW_ONLY'], created_at: time,
      units: [{ id: unit.id, ordinal: 0, status: 'pending', unit_hash: hash(unit), plan_unit: clone(unit) }] },
  }
  value.selected = { id: 21, work_id: 1, version_id: 10, queue_id: 8, review_id: 4, plan_hash: preview.plan_hash,
    status: 'completed', binding_status: 'current', pause_requested: false, revision: 7, created_at: time, updated_at: time,
    executable: false, output_parameters: { resolution: '720p', aspect_ratio: '16:9' },
    units: [{ id: unit.id, ordinal: 0, unit_hash: value.queue.units[0].unit_hash, status: 'approved',
      attempts: [{ id: 30, attempt_no: 1, status: 'approved', created_at: time, updated_at: time }] }],
    execution_blockers: ['PREVIEW_ONLY', 'EXECUTION_RUN_STORAGE_ONLY'] }
  value.historical = { ...clone(value.selected), id: 20, queue_id: 7, review_id: 3, plan_hash: digest('f'),
    status: 'stale', binding_status: 'stale', revision: 99, execution_blockers: ['EXECUTION_RUN_STALE'] }
  return value
}
const queryFor = value => ({ step: '4', unit_run: String(value.selected.id), unit_version: String(value.selected.version_id),
  unit_plan: value.selected.plan_hash, unit_revision: String(value.selected.revision) })
function storage() {
  const values = new Map()
  return { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
    snapshot: () => Object.fromEntries(values) }
}
function environment() {
  const local = storage(), session = storage(), listeners = new Map(), intervals = new Map(), revoked = [], created = []
  let timerId = 0
  assert.doesNotMatch(authSource, /^import\s/m)
  const auth = new Function('localStorage', 'sessionStorage', authSource.replace(/^export /gm, '')
    + '\nreturn { readSession, readCurrentTenantId, saveSession, saveCurrentTenantId, clearSession }')(local, session)
  auth.saveSession({ token: 'synthetic-token-a', user: { id: 'user-a' } }); auth.saveCurrentTenantId('tenant-a')
  return { local, session, auth, intervals, revoked, created,
    globals: { crypto: webcrypto, localStorage: local, sessionStorage: session },
    urls: { createObjectURL(blob) { created.push(blob); return `blob:unit-delivery-synthetic-${created.length}` },
      revokeObjectURL: url => revoked.push(url) },
    document: { activeElement: null, createElement() { throw Error('UNIT_DELIVERY_FIXTURE_FORBIDS_DOWNLOAD_ANCHOR') } },
    setInterval(callback, delay) { const id = ++timerId; intervals.set(id, { callback, delay }); return id },
    clearInterval: id => intervals.delete(id),
    async runTimers() { for (const [id, item] of [...intervals]) if (intervals.has(id)) await item.callback(); await flush() },
    window: { localStorage: local, sessionStorage: session,
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
      dispatch: (name, event) => [...(listeners.get(name) || [])].forEach(fn => fn(event)) } }
}

// Closed import binding: never execute application API/request, router, Vite or Element Plus modules.
// A fresh compilation on every mount also clears the Run module's in-memory operation maps.
const importPattern = /^import[ \t]+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"\r\n]+)\2[ \t]*;?[ \t]*(?:\r?\n|$)/gm
function bindImports(text, modules) {
  const transformed = text.replace(importPattern, (_whole, names, _quote, specifier) => {
    if (specifier === 'vue') {
      assert.ok(names.startsWith('{'))
      return `const ${names.replace(/\s+as\s+/g, ':')} = Vue;\n`
    }
    assert.ok(Object.hasOwn(modules, specifier), `unapproved SFC import: ${specifier}`)
    return `const ${names.replace(/\s+as\s+/g, ':')} = modules[${JSON.stringify(specifier)}];\n`
  })
  assert.doesNotMatch(transformed, /^import\s/m, 'unhandled imports fail closed')
  return transformed
}
function compile(name, relative, modules, env) {
  const { descriptor } = parse(source(relative)), script = compileScript(descriptor, { id: name })
  const body = bindImports(script.content, modules).replace('export default', 'return')
  const template = compileTemplate({ id: name, filename: relative, source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const component = new Function('Vue', 'modules', 'crypto', 'window', 'localStorage', 'sessionStorage', 'URL',
    'setInterval', 'clearInterval', 'document', 'globalThis', body)(vue, modules, webcrypto, env.window, env.local, env.session,
    env.urls, env.setInterval, env.clearInterval, env.document, env.globals)
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
function findInstance(vnode, component) {
  if (!vnode) return null
  if (vnode.type === component) return vnode.component
  const nested = vnode.component && findInstance(vnode.component.subTree, component)
  if (nested) return nested
  for (const child of Array.isArray(vnode.children) ? vnode.children : []) {
    const found = findInstance(child, component); if (found) return found
  }
  return null
}
function nodes(node, predicate) { return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => nodes(child, predicate))] }
function visibleText(node) { return [node?.text || '', ...(node?.children || []).map(visibleText)].join(' ').replace(/\s+/g, ' ').trim() }
const runReads = world => world.calls.filter(call => call.name === 'getExecutionRun')
const writeCalls = world => world.calls.filter(call => !/^(get|list)/.test(call.name))
const legacyCalls = world => world.calls.filter(call => /^(quoteDialogue|getDialogueTask|listExports|getExport|getReleaseReadiness|download)/.test(call.name))
const entryText = '查看此执行记录的导出准备'

async function scenario(t, configure = () => {}) {
  const world = { env: environment(), value: fixture(), calls: [], unexpected: [], argumentErrors: [], pending: [], waits: [], navigation: [],
    explicitlySelectedRun: 21 }
  world.route = vue.reactive({ params: { projectId: '5', workId: '1' }, query: { step: '1' } })
  world.handlers = {
    getProject: async () => clone(world.value.project), getWork: async () => clone(world.value.work), listProjectEvents: async () => [],
    listProjectWorks: async () => [clone(world.value.work)], getBlueprint: async () => clone(world.value.blueprint),
    listStylePresets: async () => [], listLocales: async () => [{ locale: 'en', market: 'US', status: 'full_output', blocking: [] }],
    getLocalization: async () => clone(world.value.record),
    getExecutionPlanReview: async () => ({ preview: clone(world.value.preview), saved_review: clone(world.value.savedReview) }),
    getExecutionQueue: async () => ({ preview: clone(world.value.preview), saved_review: clone(world.value.savedReview), queue: clone(world.value.queue) }),
    listExecutionRuns: async () => ({ version_id: 10, current_run_id: 21, runs: [clone(world.value.historical), clone(world.value.selected)] }),
    getExecutionRun: async (_version, id) => clone(id === 21 ? world.value.selected : world.value.historical),
  }
  world.defer = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no }), wait = { promise, resolve, reject }
    world.waits.push(wait); return wait
  }
  const api = new Proxy({}, { get: (_target, name) => (...args) => {
    world.calls.push({ name, args, step: String(world.route.query.step), sourceMounted: Boolean(world.find?.('source')) })
    if (!Object.hasOwn(world.handlers, name)) {
      world.unexpected.push(name); return Promise.reject(Error(`UNIT_DELIVERY_FIXTURE_FORBIDS_API_${name}`))
    }
    try {
      // Existing Workspace calls use route strings; Source work refresh and Run default-owner
      // proof use numeric DTO IDs. Accept only these exact values, never Number(...) coercion.
      if (name === 'getProject') { assert.equal(args.length, 1); assert.ok(args[0] === '5' || args[0] === 5) }
      if (name === 'getWork') { assert.equal(args.length, 1); assert.ok(args[0] === '1' || args[0] === 1) }
      if (['getLocalization', 'getExecutionPlanReview', 'getExecutionQueue'].includes(name)) assert.deepEqual(args, [10])
      if (name === 'listExecutionRuns' || name === 'getExecutionRun') {
        const count = name === 'getExecutionRun' ? 2 : 1
        assert.equal(args[0], 10, `${name} must request the exact numeric version`)
        if (name === 'getExecutionRun') assert.equal(args[1], world.explicitlySelectedRun, 'detail must request the exact selected numeric run')
        assert.ok(args.length === count || args.length === count + 1)
        if (args.length > count) {
          assert.deepEqual(Object.keys(args[count]), ['signal'])
          assert.ok(args[count].signal instanceof AbortSignal)
        }
      }
    } catch (error) {
      // A component may catch a rejected read; the fixture must still report bad request identity.
      world.argumentErrors.push({ name, message: error.message }); return Promise.reject(error)
    }
    return Promise.resolve(world.handlers[name](...args))
  } })
  world.mount = () => {
    assert.ok(!world.app, 'reload must really unmount the previous application')
    const stub = { inheritAttrs: false, setup: () => () => vue.h('div') }, components = {}
    const modules = { '@/api/redraw': { redrawAPI: api }, '@/utils/authSession': world.env.auth,
      '@/utils/redrawWorkspaceState': stateHelpers, '@/utils/redrawBlueprintReviewState': blueprintHelpers,
      '@/utils/redrawTimelineState': timelineHelpers, '@/utils/redrawSourceAudioSeamReview': sourceAudioSeamReview,
      'element-plus': { ElMessage: { error() {}, warning() {}, success() {} } },
      'vue-router': { useRoute: () => world.route, useRouter: () => ({ replace(next) {
        world.navigation.push(clone(next))
        if (next.params) Object.assign(world.route.params, next.params)
        if (next.query) world.route.query = clone(next.query)
      } }) } }
    for (const name of ['PlatformHeader', 'RedrawProjectOverview', 'RedrawAssetStep', 'RedrawShotStep', 'RedrawBlueprintReviewPanel', 'StylePresetPicker']) {
      modules[`@/components/${name === 'PlatformHeader' ? '' : 'redraw/'}${name}.vue`] = stub
    }
    for (const [key, name] of [['materials', 'RedrawUnitReferenceMaterialsPanel'], ['run', 'RedrawExecutionRunPanel'],
      ['plan', 'RedrawExecutionPlanReviewPanel'], ['localization', 'RedrawLocalizationReviewPanel'], ['source', 'RedrawSourceStep'],
      ['timeline', 'RedrawTimeline'], ['player', 'RedrawPlayerCompare'], ['exports', 'RedrawExportPanel'],
      ['release', 'RedrawEpisodeReleasePanel'], ['edit', 'RedrawEditStep']]) {
      components[key] = compile(name, `../src/components/redraw/${name}.vue`, modules, world.env)
      modules[`@/components/redraw/${name}.vue`] = components[key]; modules[`./${name}.vue`] = components[key]
    }
    components.workspace = compile('RedrawWorkspace', '../src/views/RedrawWorkspace.vue', modules, world.env)
    const app = renderer().createApp(components.workspace)
    for (const [name, tag] of [['el-button', 'button'], ['el-select', 'select'], ['el-option', 'option'],
      ['el-radio', 'input'], ['el-radio-group', 'div'], ['el-tag', 'span'], ['el-alert', 'div'],
      ['el-progress', 'div'], ['el-segmented', 'div'], ['el-switch', 'input']]) {
      app.component(name, { props: ['disabled', 'loading', 'title', 'value', 'modelValue', 'label', 'options'],
        setup: (props, { attrs, slots }) => () => vue.h(tag, { ...attrs, disabled: props.disabled, value: props.value ?? props.modelValue },
          [props.title || props.label || '', ...(slots.default?.() || [])]) })
    }
    app.directive('loading', {})
    app.config.warnHandler = message => { throw Error(`Vue unit delivery fixture warning: ${message}`) }
    world.root = { children: [] }; world.components = components; world.app = app
    app.mount(world.root)
  }
  world.find = key => key === 'workspace' ? world.app?._instance : findInstance(world.app?._instance?.subTree, world.components?.[key])
  world.unmount = () => { world.app?.unmount(); world.app = null }
  world.button = (label, within = world.root) => {
    const matches = nodes(within, node => node.tag === 'button' && (label instanceof RegExp ? label.test(visibleText(node)) : visibleText(node) === label))
    assert.equal(matches.length, 1, `one real rendered button must match ${label}`)
    return matches[0]
  }
  world.fire = (node, event, payload) => {
    assert.ok(node && !node.disabled, 'only enabled user-visible controls may be activated')
    const handler = node[event] || node.events?.[event.replace(/^on/, '').toLowerCase()]
    assert.equal(typeof handler, 'function', `rendered ${event} handler must exist`)
    const pending = Promise.resolve(handler(payload || { target: node, currentTarget: node }))
    world.pending.push(pending); return pending
  }
  world.beginClick = (label, within) => world.fire(world.button(label, within), 'onClick')
  world.click = async (label, within) => { await world.beginClick(label, within); await flush() }
  world.chooseRun = async id => {
    const select = nodes(world.root, node => node.tag === 'select' && node['aria-label'] === '选择执行记录')[0]
    assert.ok(select, 'the real run selector must be visible')
    world.explicitlySelectedRun = id
    await world.fire(select, 'onChange', { target: { value: String(id) } }); await flush()
  }
  configure(world)
  const previousDocument = globalThis.document
  globalThis.document = world.env.document
  t.after(async () => {
    world.unmount(); world.waits.forEach(wait => wait.resolve(null)); await Promise.allSettled(world.pending); await flush()
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument
    assert.equal(world.env.intervals.size, 0, 'all controlled timers must be released on unmount')
    assert.deepEqual(world.unexpected, [], 'caught forbidden API rejections still fail the test')
    assert.deepEqual(world.argumentErrors, [], 'caught mismatched API arguments still fail the test')
  })
  world.mount(); await flush(); return world
}
function assertSourceChain(world) {
  for (const key of ['workspace', 'source', 'localization', 'plan', 'run']) {
    const instance = world.find(key)
    assert.ok(instance?.isMounted && !instance.isUnmounted, `ordinary page must mount real ${key}`)
  }
  assert.equal(world.value.work.current_step, 1)
}
function releaseRoot(world) {
  for (const key of ['edit', 'release']) assert.ok(world.find(key)?.isMounted && !world.find(key).isUnmounted, `real ${key} must be mounted`)
  return world.find('release').subTree.el
}
function assertReadOnly(world, reviews = 0) {
  assert.equal(world.calls.filter(call => call.name === 'reviewExecutionUnitCandidate').length, reviews)
  assert.deepEqual(writeCalls(world).filter(call => call.name !== 'reviewExecutionUnitCandidate'), [], 'no execute, compose, quote, download or TTS writes')
  assert.deepEqual(legacyCalls(world), [], 'unit mode must not initialize legacy quote, task, first export or release readiness')
  if (world.find('edit')) {
    const dangerous = nodes(world.find('edit').subTree.el, node => node.tag === 'button'
      && /生成.*配音|合成成片|创建整集 release|确认并推进|下载/.test(visibleText(node)))
    assert.ok(dangerous.every(node => node.disabled), 'future compose/download/TTS actions must be absent or disabled')
    assert.equal(nodes(world.find('edit').subTree.el, node => node.tag === 'video').length, 0, 'read-only preparation must not pretend to be a finished film')
  }
}
function assertUnverified(world) {
  const text = visibleText(releaseRoot(world))
  assert.doesNotMatch(text, /已核验|可合成|可发布|成片已完成/)
  assert.match(text, /未核验|核验中|正在.*核|失效|缺少|失败|阻断|不一致|不可用|重新.*核验/)
}
function assertVerified(world, revision = world.value.selected.revision, audioMode = world.value.preview.capability.audio_mode) {
  const text = visibleText(releaseRoot(world))
  assert.match(text, /已核验/)
  assert.match(text, /执行\s*#21/)
  assert.match(text, new RegExp(`修订\\s*${revision}(?:\\D|$)`))
  assert.doesNotMatch(text, /执行\s*#20|可合成|可发布|成片已完成/)
  assert.match(text, ({ native: /native|原生音轨/, not_required: /not_required|无对白/, replace: /replace|独立配音|配音替换/ })[audioMode])
  assert.match(text, /缺口|尚未|未.*(?:合成|听审|验收)|仍需/)
}
async function selectCurrent(world) {
  assertSourceChain(world)
  await world.click('刷新执行记录')
  const options = nodes(world.root, node => node.tag === 'select' && node['aria-label'] === '选择执行记录')[0].options
  assert.deepEqual(options.filter(node => node.value !== '').map(node => Number(node.value)), [20, 21], 'selected current run is deliberately not first')
  await world.chooseRun(21)
  assert.match(visibleText(world.find('run').subTree.el), /执行\s*#21/)
}
async function openDelivery(world) { await selectCurrent(world); await world.click(entryText); assertVerified(world); assertReadOnly(world) }
function ownerABA(world, dimension) {
  const key = dimension === 'user' ? 'moli_mama_session' : 'moli_mama_tenant_id', oldValue = world.env.local.getItem(key)
  const otherValue = dimension === 'user' ? JSON.stringify({ token: 'synthetic-token-b', user: { id: 'user-b' } }) : 'tenant-b'
  // The real auth helper reads the final A while both queued storage events must still invalidate it.
  world.env.window.dispatch('storage', { key, oldValue, newValue: otherValue, storageArea: world.env.local })
  world.env.window.dispatch('storage', { key, oldValue: otherValue, newValue: oldValue, storageArea: world.env.local })
}
function contextABA(world, dimension) {
  if (dimension === 'user' || dimension === 'tenant') ownerABA(world, dimension)
  if (dimension === 'work') { world.route.params.workId = '2'; world.route.params.workId = '1' }
  if (dimension === 'version') {
    const work = world.find('workspace').setupState.work
    work.version_id = 11; work.version_id = 10
  }
  if (dimension === 'policy') {
    const project = world.find('workspace').setupState.project
    project.execution_mode = 'auto'; project.execution_mode = 'safe'
  }
  if (dimension === 'access') {
    const oldValue = world.env.local.getItem('moli_mama_session')
    world.env.auth.clearSession(); world.env.auth.saveSession(JSON.parse(oldValue)); world.env.auth.saveCurrentTenantId('tenant-a')
    world.env.window.dispatch('storage', { key: 'moli_mama_session', oldValue, newValue: null, storageArea: world.env.local })
    world.env.window.dispatch('storage', { key: 'moli_mama_session', oldValue: null, newValue: oldValue, storageArea: world.env.local })
  }
}

test('current_step=1 user selects non-first run, rereads it, leaves Source and needs an independent fourth-step GET', async t => {
  const world = await scenario(t)
  await selectCurrent(world)
  const oldSource = world.find('source'), entryRead = world.defer(), deliveryRead = world.defer(), before = runReads(world).length
  let read = 0
  world.handlers.getExecutionRun = (_version, id) => {
    assert.equal(id, 21)
    return ++read === 1 ? entryRead.promise : deliveryRead.promise
  }
  const navigation = world.beginClick(entryText)
  await flush()
  assert.equal(String(world.route.query.step), '1', 'navigation cannot use the previously selected GET as authorization')
  assert.equal(world.find('source'), oldSource); assert.equal(runReads(world).length, before + 1)
  entryRead.resolve(clone(world.value.selected)); await navigation; await flush()
  assert.deepEqual(world.route.query, queryFor(world.value))
  assert.equal(world.find('source'), null); assert.equal(oldSource.isUnmounted, true)
  assert.equal(world.value.work.current_step, 1, 'never write legacy current_step')
  assertUnverified(world)
  const fresh = runReads(world).at(-1)
  assert.equal(fresh.step, '4'); assert.equal(fresh.sourceMounted, false); assert.equal(fresh.args[1], 21)
  assert.equal(runReads(world).length, before + 2)
  deliveryRead.resolve(clone(world.value.selected)); await flush()
  assertVerified(world); await world.env.runTimers(); assertReadOnly(world)
})

test('same URL reload clears component memory and waits for project/work plus fresh localization/plan/queue/list/detail proof', async t => {
  const world = await scenario(t)
  await openDelivery(world)
  const query = clone(world.route.query), previousEdit = world.find('edit'), project = world.defer(), work = world.defer(), detail = world.defer()
  world.unmount(); await flush()
  world.calls.length = 0
  world.handlers.getProject = () => project.promise; world.handlers.getWork = () => work.promise
  world.handlers.getExecutionRun = () => detail.promise
  world.route.query = query; world.mount(); await flush()
  assert.equal(previousEdit.isUnmounted, true)
  assert.equal(world.calls.some(call => call.name === 'getWork'), false, 'project must resolve before work')
  assert.equal(runReads(world).length, 0)
  project.resolve(clone(world.value.project)); await flush()
  assert.equal(world.calls.filter(call => call.name === 'getWork').length, 1)
  assert.equal(runReads(world).length, 0, 'route hints and persistent storage cannot bypass work proof')
  work.resolve(clone(world.value.work)); await flush()
  assertUnverified(world)
  const proofNames = ['getProject', 'getWork', 'getLocalization', 'getExecutionPlanReview', 'getExecutionQueue', 'listExecutionRuns', 'getExecutionRun']
  const indexes = proofNames.map(name => world.calls.findIndex(call => call.name === name))
  assert.ok(indexes.every(index => index >= 0), `all existing GETs must be used: ${proofNames}`)
  assert.ok(indexes.every((index, ordinal) => !ordinal || index > indexes[ordinal - 1]), 'proof must respect the dependency order')
  assert.deepEqual(runReads(world).map(call => call.args.slice(0, 2)), [[10, 21]])
  detail.resolve(clone(world.value.selected)); await flush()
  assertVerified(world); assert.deepEqual(world.route.query, query); assertReadOnly(world)
})

test('default tenant is proved again by the real project response after a same-URL reload', async t => {
  const world = await scenario(t, current => current.env.auth.saveCurrentTenantId(null))
  await openDelivery(world)
  assert.equal(world.env.auth.readCurrentTenantId(), null)
  const query = clone(world.route.query)
  world.unmount(); world.calls.length = 0
  world.handlers.getProject = async () => ({ ...clone(world.value.project), tenant_id: 'different-default-tenant' })
  world.route.query = query; world.mount(); await flush()
  assertUnverified(world); assert.equal(world.env.auth.readCurrentTenantId(), null); assertReadOnly(world)
})

for (const audioMode of ['native', 'not_required', 'replace']) {
  test(`fresh fourth-step ${audioMode} summary uses the saved plan audio branch and leaves every execution/finalization port idle`, async t => {
    const world = await scenario(t, current => { current.value = fixture(audioMode); current.route.query = queryFor(current.value) })
    assertVerified(world, 7, audioMode)
    if (audioMode === 'replace') assert.match(visibleText(releaseRoot(world)), /(?:配音|音轨).*(?:缺口|未|尚|仍需)|(?:缺口|未|尚|仍需).*(?:配音|音轨)/)
    await world.env.runTimers(); assertReadOnly(world)
  })
}

test('deleting every selection hint in an entered unit page revokes proof and never falls back to legacy fourth-step initialization', async t => {
  const world = await scenario(t)
  await openDelivery(world)
  world.route.query = { step: '4' }; await flush()
  assertUnverified(world); await world.env.runTimers(); assertReadOnly(world)
})

for (const [name, mutate] of [
  ['missing run', query => { delete query.unit_run }], ['zero run', query => { query.unit_run = '0' }],
  ['multiple run values', query => { query.unit_run = ['21', '20'] }], ['malformed run', query => { query.unit_run = '21oops' }],
  ['noncanonical run', query => { query.unit_run = '021' }], ['wrong version', query => { query.unit_version = '11' }],
  ['missing version', query => { delete query.unit_version }], ['multiple versions', query => { query.unit_version = ['10', '10'] }],
  ['missing plan', query => { delete query.unit_plan }], ['uppercase plan', query => { query.unit_plan = digest('A') }],
  ['wrong plan', query => { query.unit_plan = digest('f') }], ['missing revision', query => { delete query.unit_revision }],
  ['negative revision', query => { query.unit_revision = '-1' }], ['fractional revision', query => { query.unit_revision = '7.1' }],
  ['multiple revisions', query => { query.unit_revision = ['7', '8'] }], ['newer requested revision', query => { query.unit_revision = '8' }],
]) {
  test(`URL intent ${name} remains unverified instead of selecting first/latest or normalizing the original identity`, async t => {
    const world = await scenario(t, current => { current.route.query = queryFor(current.value); mutate(current.route.query) })
    assertUnverified(world); assertReadOnly(world)
    assert.equal(runReads(world).some(call => call.args[1] === 20), false)
  })
}

const invalidBindings = [
  ['project owner', 'getProject', value => { value.user_id = 'user-b' }],
  ['project tenant', 'getProject', value => { value.tenant_id = 'tenant-b' }],
  ['project identity', 'getProject', value => { value.id = 6 }],
  ['project policy', 'getProject', value => { value.policy_version = 0 }],
  ['work identity', 'getWork', value => { value.id = 2 }],
  ['work project', 'getWork', value => { value.project_id = 6 }],
  ['work version', 'getWork', value => { value.version_id = 11 }],
  ['localization work', 'getLocalization', value => { value.work_id = 2 }],
  ['localization version', 'getLocalization', value => { value.version_id = 11 }],
  ['localization hash', 'getLocalization', value => { value.localization_hash = digest('9') }],
  ['localization revision', 'getLocalization', value => { value.updated_at = 'changed' }],
  ['preview owner', 'getExecutionPlanReview', value => { value.preview.bindings.user_id = 'user-b' }],
  ['preview tenant', 'getExecutionPlanReview', value => { value.preview.bindings.tenant_id = 'tenant-b' }],
  ['preview plan', 'getExecutionPlanReview', value => { value.preview.plan_hash = digest('9') }],
  ['preview blocked', 'getExecutionPlanReview', value => { value.preview.status = 'blocked' }],
  ['review stale', 'getExecutionPlanReview', value => { value.saved_review.status = 'stale' }],
  ['review plan snapshot', 'getExecutionPlanReview', value => { value.saved_review.plan.units[0].generated_duration_ms += 1000 }],
  ['queue review identity', 'getExecutionQueue', value => { value.saved_review.id = 99 }],
  ['queue plan snapshot', 'getExecutionQueue', value => { value.preview.units[0].retained_duration_ms += 1000 }],
  ['queue work', 'getExecutionQueue', value => { value.queue.work_id = 2 }],
  ['queue stale', 'getExecutionQueue', value => { value.queue.status = 'stale' }],
  ['queue units', 'getExecutionQueue', value => { value.queue.units[0].plan_unit.source_end_ms += 1 }],
  ['empty run list', 'listExecutionRuns', value => { value.runs = []; value.current_run_id = null }],
  ['missing selected run', 'listExecutionRuns', value => { value.runs = value.runs.slice(0, 1); value.current_run_id = null }],
  ['duplicate selected run', 'listExecutionRuns', value => { value.runs.push(clone(value.runs[1])) }],
  ['multiple current runs', 'listExecutionRuns', value => { value.runs[0] = { ...clone(value.runs[1]), id: 22 } }],
  ['historical selection', 'listExecutionRuns', value => { value.current_run_id = null; value.runs[1].binding_status = 'stale' }],
  ['wrong current pointer', 'listExecutionRuns', value => { value.current_run_id = 20 }],
  ['wrong list version', 'listExecutionRuns', value => { value.version_id = 11 }],
  ['wrong detail identity', 'getExecutionRun', value => { value.id = 20 }],
  ['wrong detail work', 'getExecutionRun', value => { value.work_id = 2 }],
  ['wrong detail version', 'getExecutionRun', value => { value.version_id = 11 }],
  ['wrong detail queue', 'getExecutionRun', value => { value.queue_id = 7 }],
  ['wrong detail review', 'getExecutionRun', value => { value.review_id = 3 }],
  ['wrong detail plan', 'getExecutionRun', value => { value.plan_hash = digest('f') }],
  ['stale detail', 'getExecutionRun', value => { value.binding_status = 'stale' }],
  ['newer detail revision', 'getExecutionRun', value => { value.revision = 8 }],
  ['string detail revision', 'getExecutionRun', value => { value.revision = '7' }],
  ['wrong detail unit hash', 'getExecutionRun', value => { value.units[0].unit_hash = digest('9') }],
  ['wrong detail unit identity', 'getExecutionRun', value => { value.units[0].id = 'unit-other' }],
  ['wrong detail unit ordinal', 'getExecutionRun', value => { value.units[0].ordinal = 1 }],
  ['missing detail units', 'getExecutionRun', value => { value.units = [] }],
]
for (const [name, apiName, mutate] of invalidBindings) {
  test(`fresh fourth-step proof rejects ${name}`, async t => {
    const world = await scenario(t, current => {
      current.route.query = queryFor(current.value)
      const original = current.handlers[apiName]
      current.handlers[apiName] = async (...args) => { const value = await original(...args); mutate(value); return value }
    })
    assertUnverified(world); assertReadOnly(world)
    assert.equal(world.route.query.unit_revision, '7', 'a failed proof must never silently upgrade the requested revision')
    assert.equal(runReads(world).some(call => call.args[1] !== 21), false, 'no historical or latest fallback detail')
  })
}

for (const name of ['getProject', 'getWork', 'getLocalization', 'getExecutionPlanReview', 'getExecutionQueue', 'listExecutionRuns', 'getExecutionRun']) {
  test(`fourth-step ${name} failure cannot leave a success summary or enter legacy initialization`, async t => {
    const world = await scenario(t, current => {
      current.route.query = queryFor(current.value)
      current.handlers[name] = async () => { throw Object.assign(Error('synthetic proof access failure'), { response: { status: 403 } }) }
    })
    assertUnverified(world); await world.env.runTimers(); assertReadOnly(world)
  })
}

for (const dimension of ['user', 'tenant', 'work', 'version', 'policy', 'access']) {
  test(`${dimension} same-tick ABA directly revokes an idle verified fourth-step summary without a manual refresh`, async t => {
    const world = await scenario(t)
    await openDelivery(world)
    const nextDetail = world.defer()
    world.handlers.getExecutionRun = () => nextDetail.promise
    assertVerified(world)
    contextABA(world, dimension)
    await vue.nextTick()
    assertUnverified(world)
    nextDetail.resolve(null)
    await flush(); await world.env.runTimers()
    assertUnverified(world); assertReadOnly(world)
  })
  test(`${dimension} same-tick ABA revokes fourth-step qualification and discards the original pending detail`, async t => {
    const world = await scenario(t)
    await openDelivery(world)
    const stale = clone(world.value.selected), wait = world.defer()
    world.handlers.getExecutionRun = () => wait.promise
    const refresh = world.beginClick(/重新.*核验/, world.find('edit').subTree.el)
    await flush(); assertUnverified(world)
    world.handlers.getExecutionRun = async () => { throw Error('new proof deliberately unavailable after ABA') }
    contextABA(world, dimension)
    await flush(); wait.resolve(stale); await refresh; await flush()
    assertUnverified(world); await world.env.runTimers(); assertReadOnly(world)
  })
}

test('owner ABA during the entry run GET cannot navigate using its late response', async t => {
  const world = await scenario(t)
  await selectCurrent(world)
  const wait = world.defer(), before = runReads(world).length
  world.handlers.getExecutionRun = () => wait.promise
  const pending = world.beginClick(entryText)
  await flush(); assert.equal(runReads(world).length, before + 1)
  ownerABA(world, 'tenant'); wait.resolve(clone(world.value.selected)); await pending; await flush()
  assert.equal(String(world.route.query.step), '1'); assert.equal(world.find('edit'), null); assertReadOnly(world)
})

test('changing the selected run during entry verification cannot publish the earlier run intent', async t => {
  const world = await scenario(t)
  await selectCurrent(world)
  const wait = world.defer()
  world.handlers.getExecutionRun = (_version, id) => id === 21 ? wait.promise : clone(world.value.historical)
  const pending = world.beginClick(entryText)
  await flush(); await world.chooseRun(20)
  wait.resolve(clone(world.value.selected)); await pending; await flush()
  assert.equal(String(world.route.query.step), '1'); assert.equal(world.find('edit'), null); assertReadOnly(world)
})

test('unmount during fourth-step detail revokes qualification and never publishes late data into a fresh mount', async t => {
  const world = await scenario(t, current => {
    current.route.query = queryFor(current.value); current.detail = current.defer(); current.handlers.getExecutionRun = () => current.detail.promise
  })
  assertUnverified(world)
  const previousRelease = world.find('release'), stale = clone(world.value.selected)
  world.unmount(); world.handlers.getExecutionRun = async () => { throw Error('new mount detail denied') }
  world.mount(); await flush()
  world.detail.resolve(stale); await flush()
  assert.equal(previousRelease.isUnmounted, true); assert.notEqual(world.find('release'), previousRelease)
  assertUnverified(world); assertReadOnly(world)
})

test('review receipt revision is not run proof: actual candidate approval still requires a fresh selected-run GET before entering step four', async t => {
  const media = new TextEncoder().encode('synthetic bytes only; renderer loadeddata is not real playback acceptance')
  const world = await scenario(t, current => {
    current.value.selected.status = 'waiting_review'; current.value.selected.revision = 6
    current.value.selected.units[0].status = 'waiting_review'; current.value.selected.units[0].attempts[0].status = 'waiting_review'
    current.candidate = { schema_version: 'redraw-execution-unit-candidate-review-v1', run_id: 21, run_revision: 6,
      unit_id: 'unit-1', ordinal: 0, attempt_id: 30, status: 'waiting_review', candidate_hash: digest('c'),
      asset: { id: 50, sha256: createHash('sha256').update(media).digest('hex'), bytes: media.length, mime_type: 'video/mp4',
        duration_ms: 5000, width: 720, height: 1280, video_codec: 'h264', audio_codec: 'aac' },
      required_checks: ['scene_action_continuity', 'character_identity'], review: null,
      review_policy: { execution_mode: 'safe', policy_version: 2, human_required: true },
      technical_qa: { method: 'ffprobe', status: 'passed' }, content_qa: { machine_evidence: 'not_available', final_audio_review: 'not_composed' },
      target_contract: { character_name_map: { 'character-1': 'Maya' }, dialogues: [], shots: [] } }
    current.handlers.getExecutionUnitCandidate = async () => clone(current.candidate)
    current.handlers.getExecutionUnitCandidateMedia = async () => new Blob([media], { type: 'video/mp4' })
    current.handlers.reviewExecutionUnitCandidate = async (version, id, unit, body) => {
      assert.deepEqual([version, id, unit, body.expected_revision, body.decision], [10, 21, 'unit-1', 6, 'approved'])
      current.value.selected.status = 'completed'; current.value.selected.revision = 7
      current.value.selected.units[0].status = 'approved'; current.value.selected.units[0].attempts[0].status = 'approved'
      return { ...clone(current.candidate), run_revision: 7, status: 'approved', newly_reviewed: true,
        review: { decision: 'approved', checks: body.checks, review_hash: digest('8'), reviewed_by: 'user-a' } }
    }
  })
  await selectCurrent(world); await world.click('读取候选 1（只读）')
  const video = nodes(world.root, node => node.tag === 'video' && node['aria-label'] === '受控候选视频')[0]
  assert.ok(video)
  await world.fire(video, 'onLoadeddata', { currentTarget: video }); await flush()
  for (const select of nodes(world.root, node => node.tag === 'select' && node['data-review-check'])) {
    await world.fire(select, 'onChange', { target: { value: 'passed' } })
  }
  const acknowledge = nodes(world.root, node => node.tag === 'input' && node['aria-label'] === '我已实际播放并逐项听看本候选')[0]
  await world.fire(acknowledge, 'onChange', { target: { checked: true } }); await flush()
  const before = runReads(world).length
  await world.click('批准本候选（不推进）')
  assert.equal(runReads(world).length, before, 'POST receipt must not pretend to have read the new run')
  assert.equal(String(world.route.query.step), '1')
  const wait = world.defer()
  world.handlers.getExecutionRun = () => wait.promise
  const pending = world.beginClick(entryText)
  await flush(); assert.equal(runReads(world).length, before + 1)
  assert.equal(String(world.route.query.step), '1'); assert.equal(world.find('edit'), null)
  world.handlers.getExecutionRun = async () => clone(world.value.selected)
  wait.resolve(clone(world.value.selected)); await pending; await flush()
  assert.equal(world.route.query.unit_revision, '7'); assertVerified(world, 7); assertReadOnly(world, 1)
  assert.equal(world.env.created.length, 1); assert.equal(world.env.revoked.length, 1)
})

test('explicit upload-new-work action leaves verified unit delivery and restores an unblocked ordinary Source upload entry', async t => {
  const world = await scenario(t)
  await openDelivery(world)
  const oldRelease = world.find('release'), before = world.calls.length
  await world.click('上传新作品')
  assert.equal(world.route.params.workId, 'new'); assert.equal(String(world.route.query.step), '1')
  const sourceStep = world.find('source')
  assert.ok(sourceStep?.isMounted && !sourceStep.isUnmounted, 'the real new-work Source must mount')
  assert.equal(sourceStep.props.blocked, false, 'leaving unit delivery must not reject the legitimate null new-work context')
  assert.equal(sourceStep.props.initialWork, null)
  assert.equal(oldRelease.isUnmounted, true); assert.equal(world.find('edit'), null); assert.equal(world.find('run'), null)
  for (const key of ['unit_run', 'unit_version', 'unit_plan', 'unit_revision']) {
    assert.equal(Object.hasOwn(world.route.query, key), false, 'explicitly choosing a new work clears every old unit locator')
  }
  assert.equal(world.button(/04.*导出交付/).disabled, true, 'new work must not retain the prior unit step-four bypass')
  const sourceRoot = sourceStep.subTree.el
  assert.match(visibleText(sourceRoot), /上传源片并锁定转绘基础设置/)
  const fileInput = nodes(sourceRoot, node => node.tag === 'input' && node.type === 'file')[0]
  assert.ok(fileInput)
  await world.fire(fileInput, 'onChange', { target: { files: [{ name: 'synthetic-new-work.mp4', type: 'video/mp4', size: 4 }] } })
  await flush()
  assert.equal(world.button('上传源片', sourceRoot).disabled, false, 'choosing a local fixture file enables the ordinary upload control')
  assert.deepEqual(world.calls.slice(before).filter(call => /Execution|Localization|Dialogue|Exports|Export|Release/.test(call.name)), [],
    'leaving unit delivery must not read its old run/plan or initialize legacy quote, composition, export or TTS')
  await world.env.runTimers(); assertReadOnly(world)
})
