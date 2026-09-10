import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

const digest = value => value.repeat(64)
const clone = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
const tick = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }
async function flush() { for (let index = 0; index < 12; index++) await tick() }
const source = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
function pureModule(relative) {
  const text = source(relative), exports = [...text.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1])
  assert.ok(exports.length > 0)
  assert.doesNotMatch(text, /^import\s/m, 'the two real state helpers must remain import-free')
  return new Function(text.replace(/^export /gm, '') + `\nreturn {${exports.join(',')}}`)()
}
const stateHelpers = pureModule('../src/utils/redrawWorkspaceState.js')
const blueprintHelpers = pureModule('../src/utils/redrawBlueprintReviewState.js')
const sourceAudioSeamReview = pureModule('../src/utils/redrawSourceAudioSeamReview.js')
const authSource = source('../src/utils/authSession.js')
function fixture(projectId = 5, workId = 1, versionId = 10) {
  const unit = { id: 'unit-1', source_start_ms: 0, source_end_ms: 5000, parent_shots: [{ id: 'shot-1' }],
    retained_duration_ms: 5000, generated_duration_ms: 5000, padding_ms: 0, dialogues: [],
    reference_requirements: [{ id: 'motion-shot-1', kind: 'video' }] }
  const bindings = { tenant_id: 'tenant-a', user_id: 'user-a', work_id: workId, version_id: versionId, source_asset_id: 101,
    source_sha256: digest('d'), blueprint_hash: digest('b'), localization_hash: digest('c'), capability_hash: digest('e'),
    localization_updated_at: 'saved', locale: 'en', market: 'US' }
  const preview = { schema_version: 'redraw-execution-plan-preview-v1', status: 'ready', executable: false,
    plan_hash: digest('a'), bindings, units: [unit], blocking_reasons: [], execution_blockers: ['PREVIEW_ONLY'],
    capability: { model: 'fixture', audio_mode: 'native', resolutions: ['480p', '720p'], aspect_ratios: ['9:16', '16:9'] } }
  return {
    project: { id: projectId, title: 'Generic redraw fixture', execution_mode: 'safe', policy_version: 2, default_locale: 'en', default_market: 'US' },
    work: { id: workId, project_id: projectId, version_id: versionId, current_step: 1, status: 'completed',
      analysis_task: { status: 'completed' }, localization_task: { id: 'localization-fixture', status: 'completed' }, localization_review_status: 'needs_review' },
    blueprint: { work_id: workId, status: 'locked', blueprint_hash: digest('b'), blueprint: { characters: [{ id: 'character-1', source_name: '林岚' }], shots: [] } },
    record: { work_id: workId, version_id: versionId, status: 'needs_review', blueprint_hash: digest('b'), localization_hash: digest('c'), updated_at: 'saved',
      localization: { locale: 'en', market: 'US', character_name_map: { 'character-1': 'Maya' }, dialogue_map: [], text_region_map: [],
        cultural_adaptations: [], glossary: [], locked_terms: [], review: { status: 'needs_review', character_name_map: { 'character-1': true },
          dialogue_map: {}, text_region_map: {}, cultural_adaptations: {}, glossary: {}, locked_terms: {} } } },
    preview, savedReview: { id: 4, status: 'current', plan_hash: preview.plan_hash, plan: clone(preview) },
    queue: { id: 8, version_id: versionId, work_id: workId, status: 'waiting_readiness', executable: false, plan_hash: preview.plan_hash,
      execution_blockers: ['PREVIEW_ONLY'], units: [{ id: unit.id, ordinal: 0, status: 'pending', unit_hash: hash(unit), plan_unit: unit }] },
  }
}
function run(value) {
  return { id: 20, work_id: value.work.id, version_id: value.record.version_id, queue_id: value.queue.id, review_id: value.savedReview.id,
    plan_hash: value.preview.plan_hash, status: 'ready', binding_status: 'current', pause_requested: false, revision: 0,
    created_at: 'created', updated_at: 'updated', executable: false, output_parameters: null,
    units: [{ id: 'unit-1', ordinal: 0, unit_hash: value.queue.units[0].unit_hash, status: 'pending', attempts: [] }],
    execution_blockers: ['PREVIEW_ONLY', 'EXECUTION_RUN_STORAGE_ONLY'] }
}
function readiness(world, output) {
  return { schema_version: 'redraw-execution-run-advance-readiness-v1', status: 'ready', executable: false, action: 'advance',
    phase: 'idle', run_id: 20, run_revision: world.server.revision, plan_hash: world.value.preview.plan_hash, unit_id: 'unit-1', attempt_id: null,
    output_parameters: output, amount: 12, billing_mode: 'paid', quote_hash: digest('6'), confirmation_hash: world.confirmationHash,
    policy: { execution_mode: world.value.project.execution_mode, policy_version: world.value.project.policy_version } }
}
function inspection(value, prepared = false) {
  const bindings = { ...value.preview.bindings, review_id: value.savedReview.id, queue_id: value.queue.id,
    plan_hash: value.preview.plan_hash, unit_id: 'unit-1', unit_hash: value.queue.units[0].unit_hash, production_pack_hash: digest('9') }
  delete bindings.localization_updated_at; delete bindings.locale; delete bindings.market
  const result = { schema_version: 'redraw-unit-prepared-reference-inspection-v1', bindings, materials_hash: digest('f'),
    status: prepared ? 'prepared' : 'needs_preparation' }
  if (prepared) {
    const material = { schema_version: 'redraw-unit-prepared-reference-materials-v1', bindings: clone(bindings), materials_hash: digest('f'),
      references: [{ requirement_id: 'motion-shot-1', kind: 'video', state: 'ready', asset_id: 600, sha256: digest('8') }] }
    result.prepared_materials = { ...material, prepared_materials_hash: hash(material) }
  } else result.missing_requirement_ids = ['motion-shot-1']
  return result
}
const mediaBytes = new TextEncoder().encode('fixture only, not a decodable MP4; no playback or content acceptance')
function candidate(world) {
  return { schema_version: 'redraw-execution-unit-candidate-review-v1', run_id: 20, run_revision: 6, unit_id: 'unit-1', ordinal: 0,
    attempt_id: 30, status: 'waiting_review', candidate_hash: digest('c'),
    asset: { id: 50, sha256: createHash('sha256').update(mediaBytes).digest('hex'), bytes: mediaBytes.length, mime_type: 'video/mp4',
      duration_ms: 5000, width: 720, height: 1280, video_codec: 'h264', audio_codec: 'aac' },
    required_checks: ['scene_action_continuity', 'character_identity'], review: null,
    review_policy: { execution_mode: world.value.project.execution_mode, policy_version: 2, human_required: true },
    technical_qa: { method: 'ffprobe', status: 'passed' }, content_qa: { machine_evidence: 'not_available', final_audio_review: 'not_composed' },
    target_contract: { character_name_map: { 'character-1': 'Maya' }, dialogues: [], shots: [] } }
}
function storage() {
  const values = new Map()
  return { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
    snapshot: () => Object.fromEntries(values) }
}
function environment() {
  const local = storage(), session = storage(), listeners = new Map(), revoked = []
  const auth = new Function('localStorage', 'sessionStorage', authSource.replace(/^export /gm, '')
    + '\nreturn { readSession, readCurrentTenantId, saveSession, saveCurrentTenantId }')(local, session)
  auth.saveSession({ token: 'fixture-token', user: { id: 'user-a' } }); auth.saveCurrentTenantId('tenant-a')
  return { local, session, auth, revoked, urls: { createObjectURL: () => 'blob:parent-fixture', revokeObjectURL: url => revoked.push(url) },
    window: { localStorage: local, sessionStorage: session,
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
      dispatch: (name, event) => [...(listeners.get(name) || [])].forEach(fn => fn(event)) } }
}

// Closed, anchored import conversion supports multiline named imports and Vue aliases.
// It never imports router, Element Plus, request, Vite, or application API code.
const importPattern = /^import[ \t]+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"\r\n]+)\2[ \t]*;?[ \t]*(?:\r?\n|$)/gm
function bindImports(text, modules) {
  const transformed = text.replace(importPattern, (_whole, names, _quote, specifier) => {
    if (specifier === 'vue') {
      assert.ok(names.startsWith('{'), 'only named Vue bindings are supported')
      return `const ${names.replace(/\s+as\s+/g, ':')} = Vue;\n`
    }
    assert.ok(Object.hasOwn(modules, specifier), `unapproved SFC import: ${specifier}`)
    return `const ${names.replace(/\s+as\s+/g, ':')} = modules[${JSON.stringify(specifier)}];\n`
  })
  assert.doesNotMatch(transformed, /^import\s/m, 'unhandled imports must fail closed')
  return transformed
}
function compile(name, relative, modules, env) {
  const { descriptor } = parse(source(relative)), script = compileScript(descriptor, { id: name })
  const body = bindImports(script.content, modules).replace('export default', 'return')
  const template = compileTemplate({ id: name, filename: relative, source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const component = new Function('Vue', 'modules', 'crypto', 'window', 'localStorage', 'sessionStorage', 'URL', 'setInterval', body)(
    vue, modules, webcrypto, env.window, env.local, env.session, env.urls, () => { throw Error('PARENT_FIXTURE_FORBIDS_POLLING') })
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
function visibleText(node) { return [node.text || '', ...(node.children || []).map(visibleText)].join(' ') }
const posts = world => world.calls.filter(call => !/^(get|list)/.test(call.name))
const operations = world => Object.values(world.env.session.snapshot()).map(raw => JSON.parse(raw)).filter(item => item.action)
async function scenario(t, configure = () => {}) {
  const env = environment(), value = fixture(), calls = [], unexpected = [], pending = [], waits = [], components = {}
  const world = { env, value, calls, unexpected, confirmationHash: digest('7'), components }
  world.server = run(value)
  const route = vue.reactive({ params: { projectId: '5', workId: '1' }, query: { step: '1' } })
  const handlers = {
    getProject: async () => clone(world.value.project), getWork: async () => clone(world.value.work), listProjectEvents: async () => [],
    listProjectWorks: async projectId => [world.value.work]
      .filter(item => String(item.project_id) === String(projectId))
      .map(item => Object.fromEntries(['id', 'project_id', 'title', 'duration_ms', 'current_step', 'status', 'created_at', 'updated_at']
        .map(key => [key, item[key] ?? null]))),
    getBlueprint: async () => clone(world.value.blueprint), listStylePresets: async () => [],
    listLocales: async () => [{ locale: 'en', market: 'US', status: 'full_output', blocking: [] }],
    getLocalization: async () => clone(world.value.record),
    getExecutionPlanReview: async () => ({ preview: clone(world.value.preview), saved_review: clone(world.value.savedReview) }),
    getExecutionQueue: async () => ({ preview: clone(world.value.preview), saved_review: clone(world.value.savedReview), queue: clone(world.value.queue) }),
  }
  const api = new Proxy({}, { get: (_target, name) => (...args) => {
    calls.push({ name, args, storageAtEntry: env.session.snapshot() })
    if (!Object.hasOwn(handlers, name)) { unexpected.push(name); return Promise.reject(Error(`PARENT_FIXTURE_FORBIDS_API_${name}`)) }
    return Promise.resolve(handlers[name](...args))
  } })
  const stub = { inheritAttrs: false, setup: () => () => vue.h('div') }
  const modules = { '@/api/redraw': { redrawAPI: api }, '@/utils/authSession': env.auth,
    '@/utils/redrawWorkspaceState': stateHelpers, '@/utils/redrawBlueprintReviewState': blueprintHelpers,
    '@/utils/redrawSourceAudioSeamReview': sourceAudioSeamReview,
    'element-plus': { ElMessage: { error() {}, warning() {}, success() {} } },
    'vue-router': { useRoute: () => route, useRouter: () => ({ replace(next) {
      if (next.params) Object.assign(route.params, next.params)
      if (next.query) Object.assign(route.query, next.query)
    } }) } }
  for (const name of ['PlatformHeader', 'RedrawProjectOverview', 'RedrawAssetStep', 'RedrawShotStep', 'RedrawEditStep', 'RedrawBlueprintReviewPanel', 'StylePresetPicker']) {
    modules[`@/components/${name === 'PlatformHeader' ? '' : 'redraw/'}${name}.vue`] = stub
  }
  for (const [key, name] of [['materials', 'RedrawUnitReferenceMaterialsPanel'], ['run', 'RedrawExecutionRunPanel'],
    ['plan', 'RedrawExecutionPlanReviewPanel'], ['localization', 'RedrawLocalizationReviewPanel'], ['source', 'RedrawSourceStep']]) {
    components[key] = compile(name, `../src/components/redraw/${name}.vue`, modules, env)
    modules[`@/components/redraw/${name}.vue`] = components[key]; modules[`./${name}.vue`] = components[key]
  }
  components.workspace = compile('RedrawWorkspace', '../src/views/RedrawWorkspace.vue', modules, env)
  world.handlers = handlers; world.route = route
  world.defer = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no }), wait = { promise, resolve, reject }
    waits.push(wait); return wait
  }
  world.invoke = (instance, name, ...args) => {
    assert.equal(typeof instance?.setupState?.[name], 'function', `real component action ${name} must exist`)
    const promise = Promise.resolve(instance.setupState[name](...args)); pending.push(promise); return promise
  }
  world.allowRuns = () => Object.assign(handlers, {
    listExecutionRuns: async () => ({ version_id: world.value.record.version_id, current_run_id: 20, runs: [clone(world.server)] }),
    getExecutionRun: async () => clone(world.server), getExecutionRunReadiness: async (_version, _run, output) => readiness(world, output),
  })
  world.allowMaterials = () => {
    let prepared = false
    Object.assign(handlers, { getUnitReferenceMaterials: async () => inspection(world.value, prepared),
      prepareUnitReferenceMaterials: async () => { prepared = true; return inspection(world.value, true).prepared_materials } })
  }
  configure(world)
  const root = { children: [] }, app = renderer().createApp(components.workspace)
  for (const [name, tag] of [['el-button', 'button'], ['el-select', 'select'], ['el-option', 'option'], ['el-tag', 'span'],
    ['el-alert', 'div'], ['el-progress', 'div'], ['el-segmented', 'div'], ['el-radio', 'input'], ['el-radio-group', 'div']]) {
    app.component(name, { props: ['disabled', 'loading', 'title', 'value', 'modelValue', 'label', 'options'],
      setup: (props, { attrs, slots }) => () => vue.h(tag, { ...attrs, disabled: props.disabled, value: props.value ?? props.modelValue },
        [props.title || props.label || '', ...(slots.default?.() || [])]) })
  }
  app.directive('loading', {})
  app.config.warnHandler = message => { throw Error(`Vue parent fixture warning: ${message}`) }
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  t.after(async () => {
    app.unmount(); waits.forEach(wait => wait.resolve(null)); await Promise.allSettled(pending); await flush()
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument
    assert.deepEqual(unexpected, [], 'every unapproved API is recorded even if application code catches its rejection')
  })
  app.mount(root)
  world.root = root; world.workspace = app._instance
  world.find = key => key === 'workspace' ? app._instance : findInstance(app._instance.subTree, components[key])
  await flush()
  return world
}
function chain(world) {
  const result = Object.fromEntries(['source', 'localization', 'plan', 'materials', 'run'].map(key => [key, world.find(key)]))
  for (const [key, instance] of Object.entries(result)) assert.ok(instance?.isMounted && !instance.isUnmounted, `ordinary Workspace must mount the real ${key} component`)
  return result
}
async function select(world, instance = chain(world).run) {
  world.allowRuns(); await world.invoke(instance, 'refreshRuns'); await world.invoke(instance, 'selectRun', 20)
  assert.equal(instance.setupState.currentRun, true)
  instance.setupState.selectedResolution = '720p'; instance.setupState.selectedAspectRatio = '16:9'
  return instance
}
async function confirm(world, instance = chain(world).run) {
  await select(world, instance); await world.invoke(instance, 'loadReadiness'); await world.invoke(instance, 'confirmAction')
  assert.equal(instance.setupState.canAdvance, true, 'fixture must reach genuine explicit confirmation before invalidation')
  return instance
}
function expectSameBlocked(world, original) {
  assert.equal(world.find('run'), original, 'loading/error must preserve the exact mounted Run instance')
  assert.equal(original.isUnmounted, false); assert.equal(original.setupState.contextReady, false)
  assert.equal(original.setupState.confirmation, null); assert.equal(original.setupState.readiness, null)
  assert.equal(original.setupState.canAdvance, false); assert.equal(original.setupState.canCreate, false)
}
async function beginRefresh(world, layer) {
  const target = layer === 'plan' ? world.find('plan') : layer === 'source' ? world.find('source') : world.workspace
  const method = layer === 'plan' ? 'load' : layer === 'source' ? 'loadLocalization' : 'loadWorkspace'
  const port = layer === 'plan' ? 'getExecutionPlanReview' : layer === 'source' ? 'getLocalization' : 'getProject'
  const originalHandler = world.handlers[port], response = await originalHandler(), wait = world.defer()
  world.handlers[port] = () => wait.promise
  const promise = world.invoke(target, method, ...(layer === 'source' ? [true] : []))
  await flush()
  return { response, wait, promise, restore: () => { world.handlers[port] = originalHandler }, target, method }
}

test('loader binds multiline imports and aliases without swallowing neighboring application imports', () => {
  const modules = { app: { item: 4 }, helper: { first: 2, second: 3 } }
  const code = bindImports("import { item } from 'app'\nimport {\n first,\n second as other\n} from 'helper'\nimport { ref as localRef } from 'vue'\nreturn [item, first, other, localRef(9).value]", modules)
  assert.deepEqual(new Function('Vue', 'modules', code)(vue, modules), [4, 2, 3, 9])
  assert.equal(stateHelpers.resolveAllowedStep(4, 1), 1)
  assert.equal(stateHelpers.redrawWorkflowPhase(fixture().work, fixture().blueprint), 'localization_review')
  assert.equal(blueprintHelpers.canStartLocalization({ status: 'draft' }), false)
})
test('ordinary Workspace mounts four real parents plus frozen Run and passes one source-owned reactive policy object', async t => {
  const world = await scenario(t), instances = chain(world), policy = world.workspace.setupState.projectPolicy
  assert.ok(vue.isReactive(policy)); assert.deepEqual(Object.keys(policy).sort(), ['epoch', 'execution_mode', 'policy_version', 'project_id'])
  assert.equal(policy.project_id, 5); assert.equal(policy.execution_mode, 'safe'); assert.equal(policy.policy_version, 2)
  assert.ok(Number.isSafeInteger(policy.epoch) && policy.epoch >= 0)
  for (const key of ['source', 'localization', 'plan', 'materials', 'run']) assert.equal(instances[key].props.projectPolicy, policy, `same object at ${key}`)
  assert.equal(instances.run.props.record, instances.plan.props.record)
  assert.equal(instances.run.props.preview, instances.plan.setupState.preview)
  assert.equal(instances.run.props.savedReview, instances.plan.setupState.savedReview)
  assert.equal(instances.run.props.queue, instances.plan.setupState.queue)
  assert.equal(instances.run.setupState.contextReady, true)
  assert.equal(posts(world).length, 0)
  assert.deepEqual(world.calls.filter(call => /ExecutionRun|UnitReference/.test(call.name)), [], 'mount only performs existing parent GETs')
  assert.doesNotMatch(visibleText(world.root), /当前面板尚未接入普通页面/)
})
for (const field of ['execution_mode', 'policy_version', 'id']) {
  test(`real source ${field} same-tick ABA advances epoch and irreversibly clears old confirmation before nextTick`, async t => {
    const world = await scenario(t), instance = await confirm(world), policy = world.workspace.setupState.projectPolicy
    const before = policy.epoch, project = world.workspace.setupState.project, old = project[field]
    project[field] = field === 'execution_mode' ? 'auto' : old + 1; project[field] = old
    assert.ok(policy.epoch >= before + 2, 'source must observe both synchronous transitions')
    assert.equal(instance.props.projectPolicy, policy); assert.equal(instance.setupState.confirmation, null)
    await flush(); assert.equal(world.find('run'), instance); assert.equal(instance.setupState.canAdvance, false)
    assert.equal(posts(world).length, 0)
  })
}
for (const invalid of ['missing_mode', 'bad_mode', 'missing_version', 'zero_version', 'wrong_project', 'empty_response']) {
  test(`invalid actual project response ${invalid} blocks Run with no safe fallback or implicit request`, async t => {
    const world = await scenario(t, world => {
      const project = clone(world.value.project)
      if (invalid === 'missing_mode') delete project.execution_mode
      if (invalid === 'bad_mode') project.execution_mode = 'unknown'
      if (invalid === 'missing_version') delete project.policy_version
      if (invalid === 'zero_version') project.policy_version = 0
      if (invalid === 'wrong_project') project.id = 6
      world.handlers.getProject = async () => invalid === 'empty_response' ? null : project
    })
    const instance = chain(world).run
    assert.equal(instance.setupState.contextReady, false)
    await world.invoke(instance, 'refreshRuns'); await world.invoke(instance, 'createRun'); await world.invoke(instance, 'loadReadiness')
    assert.deepEqual(world.calls.filter(call => /ExecutionRun/.test(call.name)), [])
    assert.match(visibleText(world.root), /项目策略.*失效|项目策略.*不可用|项目策略.*未就绪/)
  })
}
test('late getProject response cannot replace a newer project or resurrect its old policy', async t => {
  const world = await scenario(t), old = clone(world.value.project), wait = world.defer()
  old.policy_version = 99
  world.handlers.getProject = () => wait.promise
  const pending = world.invoke(world.workspace, 'loadWorkspace')
  world.value = fixture(6, 2, 11); world.server = run(world.value)
  world.handlers.getProject = async () => clone(world.value.project)
  world.route.params.projectId = '6'; world.route.params.workId = '2'
  await flush(); wait.resolve(old); await pending; await flush()
  const policy = world.workspace.setupState.projectPolicy
  assert.equal(policy.project_id, 6); assert.equal(policy.policy_version, 2)
  assert.equal(world.workspace.setupState.project.id, 6); assert.equal(posts(world).length, 0)
})
test('same-tick route project ABA invalidates an already-pending A response even when final route is A', async t => {
  const world = await scenario(t), instance = await confirm(world), policy = world.workspace.setupState.projectPolicy, before = policy.epoch
  const wait = world.defer(), stale = { ...clone(world.value.project), policy_version: 99 }
  world.handlers.getProject = () => wait.promise
  const pending = world.invoke(world.workspace, 'loadWorkspace')
  world.handlers.getProject = async () => clone(world.value.project)
  world.route.params.projectId = '6'; world.route.params.projectId = '5'
  assert.ok(policy.epoch >= before + 2)
  await flush(); wait.resolve(stale); await pending; await flush()
  assert.notEqual(policy.policy_version, 99); assert.equal(policy.project_id, 5)
  assert.equal(instance.setupState.confirmation, null); assert.equal(posts(world).length, 0)
})
for (const dimension of ['user', 'tenant']) {
  test(`owner ${dimension} ABA preserves the parent-mounted instance but clears its old confirmation`, async t => {
    const world = await scenario(t), instance = await confirm(world), key = dimension === 'user' ? 'moli_mama_session' : 'moli_mama_tenant_id'
    const oldValue = world.env.local.getItem(key)
    if (dimension === 'user') world.env.auth.saveSession({ token: 'fixture-b', user: { id: 'user-b' } })
    else world.env.auth.saveCurrentTenantId('tenant-b')
    const otherValue = world.env.local.getItem(key)
    world.env.auth.saveSession({ token: 'fixture-token', user: { id: 'user-a' } }); world.env.auth.saveCurrentTenantId('tenant-a')
    world.env.window.dispatch('storage', { key, oldValue, newValue: otherValue, storageArea: world.env.local })
    world.env.window.dispatch('storage', { key, oldValue: otherValue, newValue: oldValue, storageArea: world.env.local })
    await flush(); assert.equal(world.find('run'), instance); assert.equal(instance.setupState.confirmation, null)
    assert.equal(instance.setupState.canAdvance, false); assert.equal(posts(world).length, 0)
  })
}
for (const layer of ['plan', 'source', 'workspace']) {
  test(`${layer} GET loading then failure keeps the same Run mounted and cannot restore old confirmation`, async t => {
    const world = await scenario(t), instance = await confirm(world), refresh = await beginRefresh(world, layer)
    expectSameBlocked(world, instance)
    if (layer === 'plan') assert.equal(world.find('plan').setupState.preview, null)
    const caught = refresh.promise.catch(() => {})
    refresh.wait.reject(Error('fixture parent read failed')); await caught; await flush()
    expectSameBlocked(world, instance)
    refresh.restore(); await world.invoke(refresh.target, refresh.method, ...(layer === 'source' ? [true] : [])); await flush()
    assert.equal(world.find('run'), instance); assert.equal(instance.setupState.confirmation, null)
    assert.equal(instance.setupState.canAdvance, false); assert.equal(posts(world).length, 0)
  })
  test(`${layer} refresh preserves the actual in-flight advance intent and blocks a second POST after restored GETs`, async t => {
    const world = await scenario(t), instance = await confirm(world), wait = world.defer()
    world.handlers.advanceExecutionRun = () => wait.promise
    const pending = world.invoke(instance, 'advanceRun')
    assert.equal(posts(world).length, 1); assert.equal(operations(world)[0].status, 'pending')
    const durable = clone(world.env.session.snapshot()), refresh = await beginRefresh(world, layer)
    expectSameBlocked(world, instance)
    assert.deepEqual(world.env.session.snapshot(), durable)
    refresh.restore(); refresh.wait.resolve(refresh.response); await refresh.promise; await flush()
    assert.equal(world.find('run'), instance)
    world.confirmationHash = digest('8'); await select(world, instance); await world.invoke(instance, 'loadReadiness'); await world.invoke(instance, 'confirmAction')
    assert.equal(instance.setupState.canConfirm, false); await world.invoke(instance, 'advanceRun')
    assert.equal(posts(world).length, 1); assert.deepEqual(world.env.session.snapshot(), durable)
    wait.resolve(null); await pending; await flush()
    assert.equal(operations(world)[0].status, 'unknown'); assert.equal(posts(world).length, 1)
  })
  test(`${layer} refresh stops and revokes old controlled media and human checks without unmounting Run`, async t => {
    const world = await scenario(t), instance = chain(world).run
    world.server.status = 'waiting_review'; world.server.revision = 6
    world.server.units[0].status = 'waiting_review'; world.server.units[0].attempts = [{ id: 30, status: 'waiting_review' }]
    world.handlers.getExecutionUnitCandidate = async () => candidate(world)
    world.handlers.getExecutionUnitCandidateMedia = async () => new Blob([mediaBytes], { type: 'video/mp4' })
    await select(world, instance); await world.invoke(instance, 'loadCandidate', 'unit-1'); await flush()
    const player = nodes(world.root, node => node.tag === 'video')[0]
    assert.ok(player); player.onLoadeddata({ currentTarget: player })
    for (const key of instance.setupState.candidate.required_checks) await world.invoke(instance, 'setReviewCheck', key, 'passed')
    await world.invoke(instance, 'acknowledgeReview', true); assert.equal(instance.setupState.canApproveCandidate, true)
    const refresh = await beginRefresh(world, layer)
    expectSameBlocked(world, instance); assert.equal(instance.setupState.candidate, null); assert.deepEqual(instance.setupState.reviewChecks, {})
    assert.equal(instance.setupState.reviewAcknowledged, false); assert.ok(player.pauseCount > 0); assert.ok(player.loadCount > 0)
    assert.equal(player.src, undefined); assert.deepEqual(world.env.revoked, ['blob:parent-fixture'])
    refresh.restore(); refresh.wait.resolve(refresh.response); await refresh.promise; await flush()
    assert.equal(world.find('run'), instance); assert.equal(instance.setupState.candidate, null); assert.equal(posts(world).length, 0)
  })
}
test('localization draft dirty and then restored changes revoke old Run confirmation without remount', async t => {
  const world = await scenario(t), instance = await confirm(world), localization = world.find('localization')
  localization.setupState.draft.character_name_map['character-1'] = 'Maya edited'
  await flush(); expectSameBlocked(world, instance)
  localization.setupState.draft.character_name_map['character-1'] = 'Maya'
  await flush(); assert.equal(world.find('run'), instance); assert.equal(instance.setupState.confirmation, null)
  assert.equal(instance.setupState.canAdvance, false); assert.equal(posts(world).length, 0)
})
test('queue GET loading and failure keep Run mounted and block every action', async t => {
  const world = await scenario(t), instance = await confirm(world), wait = world.defer()
  world.handlers.getExecutionQueue = () => wait.promise
  const pending = world.invoke(world.find('plan'), 'load'); await flush(); expectSameBlocked(world, instance)
  wait.reject(Error('fixture queue read failed')); await pending; await flush(); expectSameBlocked(world, instance)
  assert.equal(posts(world).length, 0)
})
test('Source late getWork after work route ABA cannot publish the old work or trigger old localization reads', async t => {
  const world = await scenario(t), instance = await confirm(world), sourceStep = world.find('source'), wait = world.defer()
  const stale = { ...clone(world.value.work), version_id: 999 }
  world.handlers.getWork = () => wait.promise
  const pending = world.invoke(sourceStep, 'refreshWork')
  world.handlers.getWork = async () => clone(world.value.work)
  world.route.params.workId = '2'; world.route.params.workId = '1'
  await flush(); wait.resolve(stale); await pending; await flush()
  assert.equal(world.workspace.setupState.work.version_id, 10)
  assert.equal(world.find('source').setupState.workState.version_id, 10)
  assert.equal(world.calls.some(call => call.name === 'getLocalization' && call.args[0] === 999), false)
  assert.equal(instance.setupState.confirmation, null); assert.equal(posts(world).length, 0)
})
test('Source late localization success and failure cannot overwrite another work with the same version number', async t => {
  const world = await scenario(t), sourceStep = world.find('source'), first = world.defer(), second = world.defer()
  world.handlers.getLocalization = () => first.promise
  const pendingFirst = world.invoke(sourceStep, 'loadLocalization', true)
  world.handlers.getLocalization = () => second.promise
  const pendingSecond = world.invoke(sourceStep, 'loadLocalization', true)
  world.value = fixture(6, 2, 10); world.server = run(world.value)
  world.handlers.getLocalization = async () => clone(world.value.record)
  world.route.params.projectId = '6'; world.route.params.workId = '2'
  await flush()
  first.resolve({ ...fixture().record, updated_at: 'stale-A' }); second.reject(Error('stale-A-error'))
  await Promise.all([pendingFirst, pendingSecond]); await flush()
  const currentSource = world.find('source')
  assert.equal(currentSource.setupState.workState.id, 2)
  assert.equal(currentSource.setupState.localizationRecord.work_id, 2)
  assert.equal(currentSource.setupState.localizationRecord.updated_at, 'saved')
  assert.equal(currentSource.setupState.localizationError, '')
  assert.equal(posts(world).length, 0)
})
test('Source rejects updated and locked events from a different work even when their version matches', async t => {
  const world = await scenario(t), sourceStep = world.find('source'), before = clone(sourceStep.setupState.localizationRecord)
  const stale = { ...clone(before), work_id: 2, updated_at: 'wrong-work' }, count = world.calls.length
  await world.invoke(sourceStep, 'onLocalizationUpdated', stale)
  await world.invoke(sourceStep, 'onLocalizationLocked', stale)
  await flush()
  assert.deepEqual(sourceStep.setupState.localizationRecord, before)
  assert.equal(world.calls.length, count, 'wrong-work locked event must not refresh or publish work')
  assert.equal(posts(world).length, 0)
})
async function preparedEvent(world) {
  world.allowMaterials()
  const materials = chain(world).materials, emitted = [], originalEmit = materials.emit
  materials.emit = (name, ...args) => { emitted.push({ name, args: clone(args) }); return originalEmit(name, ...args) }
  await world.invoke(materials, 'checkMaterials'); assert.equal(materials.setupState.canPrepare, true)
  return { materials, emitted }
}
test('same-scope material prepare emits only after POST plus real verified GET and then refreshes readiness by GET only', async t => {
  const world = await scenario(t), instance = await confirm(world), { materials, emitted } = await preparedEvent(world)
  const wait = world.defer(), enteredGet = world.defer(), originalGet = world.handlers.getUnitReferenceMaterials
  world.handlers.getUnitReferenceMaterials = () => { enteredGet.resolve(); return wait.promise }
  const start = world.calls.length, pending = world.invoke(materials, 'prepareMaterials')
  await Promise.race([enteredGet.promise, pending])
  assert.deepEqual(world.calls.slice(start).map(call => call.name), ['prepareUnitReferenceMaterials', 'getUnitReferenceMaterials'])
  assert.deepEqual(emitted, [], 'POST success alone must never emit verified success')
  wait.resolve(await originalGet()); await pending; await flush()
  assert.equal(materials.setupState.materials.status, 'prepared')
  assert.equal(emitted.length, 1); assert.equal(emitted[0].name, 'prepared')
  assert.equal(emitted[0].args[0].bindings.queue_id, world.value.queue.id)
  assert.deepEqual(emitted[0].args[0].projectPolicy, clone(world.workspace.setupState.projectPolicy))
  assert.deepEqual(world.calls.slice(start).map(call => call.name), ['prepareUnitReferenceMaterials', 'getUnitReferenceMaterials', 'getExecutionRunReadiness'])
  assert.equal(instance.setupState.confirmation, null); assert.equal(instance.setupState.canAdvance, false)
  assert.equal(posts(world).filter(call => call.name !== 'prepareUnitReferenceMaterials').length, 0)
  assert.match(visibleText(world.root), /本次预计扣除 12 积分/)
})
test('verified material event without a selected run or output parameters stays blocked until explicit read', async t => {
  const world = await scenario(t), instance = chain(world).run, { materials, emitted } = await preparedEvent(world)
  await world.invoke(materials, 'prepareMaterials'); await flush()
  assert.equal(emitted.length, 1); assert.equal(instance.setupState.readiness, null); assert.equal(instance.setupState.canAdvance, false)
  assert.deepEqual(world.calls.filter(call => /ExecutionRun/.test(call.name)), [])
  assert.equal(posts(world).length, 1); assert.equal(posts(world)[0].name, 'prepareUnitReferenceMaterials')
})
for (const mismatch of ['materials_hash', 'prepared_hash', 'queue_id', 'unit_hash']) {
  test(`material recheck ${mismatch} mismatch never emits or refreshes readiness`, async t => {
    const world = await scenario(t), instance = await confirm(world), { materials, emitted } = await preparedEvent(world)
    world.handlers.getUnitReferenceMaterials = async () => {
      const next = inspection(world.value, true)
      if (mismatch === 'materials_hash') next.materials_hash = digest('0')
      if (mismatch === 'prepared_hash') next.prepared_materials.prepared_materials_hash = digest('0')
      if (mismatch === 'queue_id') next.bindings.queue_id++
      if (mismatch === 'unit_hash') next.bindings.unit_hash = digest('0')
      return next
    }
    const start = world.calls.length; await world.invoke(materials, 'prepareMaterials'); await flush()
    assert.equal(materials.setupState.materials, null); assert.deepEqual(emitted, [])
    assert.equal(world.calls.slice(start).filter(call => call.name === 'getExecutionRunReadiness').length, 0)
    assert.equal(posts(world).length, 1); assert.equal(world.find('run'), instance)
  })
}
for (const dimension of ['work', 'version', 'queue', 'policy']) {
  test(`material prepare late success after ${dimension} ABA does not emit into the new scope`, async t => {
    const world = await scenario(t), instance = await confirm(world), { materials, emitted } = await preparedEvent(world)
    const wait = world.defer(), response = inspection(world.value, true).prepared_materials
    world.handlers.prepareUnitReferenceMaterials = () => wait.promise
    const pending = world.invoke(materials, 'prepareMaterials'), start = world.calls.length
    if (dimension === 'policy') {
      const project = world.workspace.setupState.project; project.execution_mode = 'auto'; project.execution_mode = 'safe'
    } else {
      const target = dimension === 'queue' ? world.find('plan').setupState.queue : world.find('source').setupState.localizationRecord
      const key = dimension === 'work' ? 'work_id' : dimension === 'version' ? 'version_id' : 'id'
      const old = target[key]; target[key] = old + 1; target[key] = old
    }
    await flush(); wait.resolve(response); await pending; await flush()
    assert.deepEqual(emitted, []); assert.equal(world.calls.slice(start).filter(call => call.name === 'getExecutionRunReadiness').length, 0)
    assert.equal(instance.setupState.confirmation, null); assert.equal(posts(world).length, 1)
  })
}
for (const dimension of ['work_id', 'version_id', 'queue_id', 'policy', 'policy_epoch']) {
  test(`parent rejects a replay of a genuinely emitted material event with wrong ${dimension}`, async t => {
    const world = await scenario(t), instance = await confirm(world), { materials, emitted } = await preparedEvent(world)
    await world.invoke(materials, 'prepareMaterials'); await flush(); assert.equal(emitted.length, 1)
    const replay = clone(emitted[0].args[0]), start = world.calls.length
    if (dimension === 'policy') world.workspace.setupState.project.policy_version = 0
    else if (dimension === 'policy_epoch') replay.projectPolicy.epoch--
    else replay.bindings[dimension]++
    await flush(); materials.emit('prepared', replay); await flush()
    assert.equal(world.calls.slice(start).filter(call => call.name === 'getExecutionRunReadiness').length, 0)
    assert.equal(instance.setupState.confirmation, null); assert.equal(instance.setupState.canAdvance, false)
    assert.equal(posts(world).length, 1)
  })
}

test('failed localization read stays blocked across policy ABA until an explicit forced read succeeds', async t => {
  const world = await scenario(t), instance = await confirm(world), sourceStep = world.find('source')
  const durable = clone(world.env.session.snapshot()), start = world.calls.length
  world.handlers.getLocalization = async () => { throw Error('fixture explicit localization read failed') }
  await world.invoke(sourceStep, 'loadLocalization', true); await flush()
  expectSameBlocked(world, instance)
  const originalError = sourceStep.setupState.localizationError
  assert.ok(originalError)
  world.workspace.setupState.project.execution_mode = 'auto'; world.workspace.setupState.project.execution_mode = 'safe'
  await flush(); expectSameBlocked(world, instance)
  assert.equal(sourceStep.setupState.localizationError, originalError)
  await world.invoke(sourceStep, 'loadLocalization'); await flush(); expectSameBlocked(world, instance)
  assert.equal(world.calls.slice(start).filter(call => call.name === 'getLocalization').length, 1, 'policy ABA and cached reads cannot confirm a failed GET')
  world.handlers.getLocalization = async () => clone(world.value.record)
  await world.invoke(sourceStep, 'loadLocalization', true); await flush()
  assert.equal(world.find('run'), instance); assert.equal(sourceStep.setupState.localizationError, '')
  assert.equal(instance.setupState.contextReady, true); assert.equal(instance.setupState.confirmation, null)
  assert.equal(instance.setupState.canAdvance, false); assert.equal(posts(world).length, 0)
  assert.deepEqual(world.env.session.snapshot(), durable)
})

test('pending localization read invalidated by policy ABA stays blocked after its late success until forced reread', async t => {
  const world = await scenario(t), instance = await confirm(world), sourceStep = world.find('source'), wait = world.defer()
  const durable = clone(world.env.session.snapshot()), start = world.calls.length
  world.handlers.getLocalization = () => wait.promise
  const pending = world.invoke(sourceStep, 'loadLocalization', true); await flush()
  expectSameBlocked(world, instance); assert.equal(sourceStep.setupState.localizationLoading, true)
  world.workspace.setupState.project.execution_mode = 'auto'; world.workspace.setupState.project.execution_mode = 'safe'
  await flush(); expectSameBlocked(world, instance)
  assert.ok(sourceStep.setupState.localizationLoading || sourceStep.setupState.localizationError, 'an invalidated pending read must remain visibly unconfirmed')
  wait.resolve({ ...clone(world.value.record), updated_at: 'late-superseded' }); await pending; await flush()
  expectSameBlocked(world, instance); assert.equal(sourceStep.setupState.localizationRecord.updated_at, 'saved')
  await world.invoke(sourceStep, 'loadLocalization'); await flush(); expectSameBlocked(world, instance)
  assert.equal(world.calls.slice(start).filter(call => call.name === 'getLocalization').length, 1, 'no automatic replacement GET or cached recovery')
  world.handlers.getLocalization = async () => clone(world.value.record)
  await world.invoke(sourceStep, 'loadLocalization', true); await flush()
  assert.equal(world.find('run'), instance); assert.equal(sourceStep.setupState.localizationLoading, false)
  assert.equal(sourceStep.setupState.localizationError, ''); assert.equal(instance.setupState.contextReady, true)
  assert.equal(instance.setupState.confirmation, null); assert.equal(instance.setupState.canAdvance, false)
  assert.equal(posts(world).length, 0); assert.deepEqual(world.env.session.snapshot(), durable)
})

function switchOwner(world, dimension, eventType = 'storage') {
  const key = dimension === 'user' ? 'moli_mama_session' : 'moli_mama_tenant_id'
  const oldValue = world.env.local.getItem(key)
  if (dimension === 'user') {
    world.env.auth.saveSession({ token: 'fixture-b', user: { id: 'user-b' } })
    world.env.auth.saveCurrentTenantId('tenant-a')
  } else world.env.auth.saveCurrentTenantId('tenant-b')
  world.env.window.dispatch(eventType, { type: eventType, key, oldValue,
    newValue: world.env.local.getItem(key), storageArea: world.env.local })
}
async function rereadCurrentOwner(world) {
  const identity = { user_id: world.env.auth.readSession().user.id, tenant_id: world.env.auth.readCurrentTenantId() }
  Object.assign(world.value.preview.bindings, identity)
  world.value.savedReview.plan = clone(world.value.preview)
  const button = nodes(world.root, node => node.tag === 'button' && /重新读取工作台/.test(visibleText(node)))[0]
  assert.ok(button && !button.disabled, 'the blocked Workspace must expose an explicit current-owner reread')
  await button.onClick(); await flush()
  assert.equal(world.workspace.setupState.workspaceError, '')
  await world.invoke(world.find('source'), 'loadLocalization', true); await flush()
}
for (const dimension of ['user', 'tenant']) {
  for (const outcome of ['success', 'error']) {
    test(`same-route ${dimension} change rejects late Source localization/work ${outcome} until explicit current-owner reads`, async t => {
      const world = await scenario(t), instance = await confirm(world), sourceStep = world.find('source')
      const localization = world.defer(), workRead = world.defer(), before = clone(sourceStep.setupState.localizationRecord)
      const durable = clone(world.env.session.snapshot()), epoch = world.workspace.setupState.projectPolicy.epoch
      world.handlers.getLocalization = () => localization.promise; world.handlers.getWork = () => workRead.promise
      const pendingLocalization = world.invoke(sourceStep, 'loadLocalization', true)
      const pendingWork = world.invoke(sourceStep, 'refreshWork').catch(() => {})
      const count = world.calls.length
      switchOwner(world, dimension, dimension === 'user' ? 'storage' : 'focus'); await flush()
      assert.ok(world.workspace.setupState.projectPolicy.epoch > epoch, 'actual owner change must invalidate the shared parent policy epoch')
      assert.ok(world.workspace.setupState.workspaceError, 'the old parent scope stays visibly blocked')
      assert.equal(world.calls.length, count, 'owner events cannot automatically reload or submit')
      expectSameBlocked(world, instance)
      if (outcome === 'success') {
        localization.resolve({ ...clone(before), updated_at: 'old-owner-localization' })
        workRead.resolve({ ...clone(world.value.work), title: 'old-owner-work' })
      } else {
        localization.reject(Error('old-owner-localization-error')); workRead.reject(Error('old-owner-work-error'))
      }
      await Promise.all([pendingLocalization, pendingWork]); await flush()
      assert.deepEqual(sourceStep.setupState.localizationRecord, before)
      assert.notEqual(world.workspace.setupState.work.title, 'old-owner-work')
      assert.notEqual(sourceStep.setupState.workState.title, 'old-owner-work')
      assert.doesNotMatch(sourceStep.setupState.localizationError, /old-owner/)
      assert.equal(world.calls.length, count, 'old work cannot emit and trigger event or localization refreshes')
      expectSameBlocked(world, instance)
      world.handlers.getLocalization = async () => clone(world.value.record)
      world.handlers.getWork = async () => clone(world.value.work)
      await rereadCurrentOwner(world)
      assert.equal(world.find('run'), instance); assert.equal(instance.setupState.contextReady, true)
      assert.equal(instance.setupState.confirmation, null); assert.equal(instance.setupState.canAdvance, false)
      assert.equal(posts(world).length, 0); assert.deepEqual(world.env.session.snapshot(), durable)
    })
  }
}
for (const action of ['save', 'lock']) {
  test(`owner change prevents a real pending localization ${action} from emitting or refreshing work`, async t => {
    const world = await scenario(t), instance = await confirm(world), local = world.find('localization'), wait = world.defer()
    const before = clone(world.find('source').setupState.localizationRecord), emitted = [], originalEmit = local.emit
    local.emit = (name, ...args) => { emitted.push(name); return originalEmit(name, ...args) }
    if (action === 'save') local.setupState.draft.character_name_map['character-1'] = 'Edited Maya'
    await flush(); assert.equal(local.setupState[action === 'save' ? 'canSave' : 'canLock'], true)
    world.handlers[action === 'save' ? 'saveLocalization' : 'lockLocalization'] = () => wait.promise
    const pending = world.invoke(local, action), count = world.calls.length
    assert.equal(posts(world).length, 1)
    switchOwner(world, action === 'save' ? 'user' : 'tenant', action === 'save' ? 'storage' : 'focus'); await flush()
    wait.resolve({ ...clone(before), updated_at: 'old-owner-write', status: action === 'lock' ? 'locked' : 'needs_review' })
    await pending; await flush()
    assert.deepEqual(emitted, [], 'the real child must discard the old save/lock response before emit')
    assert.deepEqual(world.find('source').setupState.localizationRecord, before)
    assert.equal(world.calls.length, count); assert.equal(posts(world).length, 1)
    expectSameBlocked(world, instance)
  })
}
for (const boundary of ['project', 'events']) {
  test(`Workspace late ${boundary} response cannot restore a changed owner scope`, async t => {
    const world = await scenario(t), instance = await confirm(world), wait = world.defer()
    const originalProject = clone(world.workspace.setupState.project), originalEvents = clone(world.workspace.setupState.projectEvents)
    if (boundary === 'project') world.handlers.getProject = () => wait.promise
    else world.handlers.listProjectEvents = () => wait.promise
    const pending = world.invoke(world.workspace, 'loadWorkspace'); await flush()
    const count = world.calls.length
    switchOwner(world, 'tenant', 'focus'); await flush()
    wait.resolve(boundary === 'project' ? { ...clone(originalProject), title: 'old-owner-project' } : [{ id: 901, stage: 'old-owner-event' }])
    await pending; await flush()
    assert.deepEqual(world.workspace.setupState.project, originalProject)
    assert.deepEqual(world.workspace.setupState.projectEvents, originalEvents)
    assert.equal(world.calls.length, count); assert.ok(world.workspace.setupState.workspaceError)
    expectSameBlocked(world, instance); assert.equal(posts(world).length, 0)
  })
}
test('queued user and tenant storage ABA invalidates pending parent reads while preserving the sole durable advance slot', async t => {
  const world = await scenario(t), instance = await confirm(world), sourceStep = world.find('source')
  const advance = world.defer(), localization = world.defer()
  world.handlers.advanceExecutionRun = () => advance.promise
  const pendingAdvance = world.invoke(instance, 'advanceRun')
  assert.equal(posts(world).length, 1); assert.equal(operations(world)[0].status, 'pending')
  const durable = clone(world.env.session.snapshot()), epoch = world.workspace.setupState.projectPolicy.epoch
  world.handlers.getLocalization = () => localization.promise
  const pendingLocalization = world.invoke(sourceStep, 'loadLocalization', true), count = world.calls.length
  for (const dimension of ['user', 'tenant']) {
    const key = dimension === 'user' ? 'moli_mama_session' : 'moli_mama_tenant_id', oldValue = world.env.local.getItem(key)
    if (dimension === 'user') world.env.auth.saveSession({ token: 'fixture-b', user: { id: 'user-b' } })
    else world.env.auth.saveCurrentTenantId('tenant-b')
    const otherValue = world.env.local.getItem(key)
    world.env.auth.saveSession({ token: 'fixture-token', user: { id: 'user-a' } }); world.env.auth.saveCurrentTenantId('tenant-a')
    world.env.window.dispatch('storage', { type: 'storage', key, oldValue, newValue: otherValue, storageArea: world.env.local })
    world.env.window.dispatch('storage', { type: 'storage', key, oldValue: otherValue, newValue: oldValue, storageArea: world.env.local })
  }
  assert.ok(world.workspace.setupState.projectPolicy.epoch >= epoch + 4, 'queued ABA transitions matter even when storage already contains A')
  await flush(); localization.resolve({ ...clone(world.value.record), updated_at: 'old-owner-ABA' })
  await pendingLocalization; await flush()
  assert.equal(sourceStep.setupState.localizationRecord.updated_at, 'saved'); assert.equal(world.calls.length, count)
  expectSameBlocked(world, instance); assert.deepEqual(world.env.session.snapshot(), durable)
  world.handlers.getLocalization = async () => clone(world.value.record)
  await rereadCurrentOwner(world)
  assert.equal(world.find('run'), instance); assert.equal(instance.setupState.contextReady, true)
  world.confirmationHash = digest('8'); await select(world, instance); await world.invoke(instance, 'loadReadiness')
  await world.invoke(instance, 'confirmAction'); await world.invoke(instance, 'advanceRun')
  assert.equal(posts(world).length, 1); assert.deepEqual(world.env.session.snapshot(), durable)
  advance.resolve(null); await pendingAdvance; await flush()
  assert.equal(operations(world)[0].status, 'unknown'); assert.equal(posts(world).length, 1)
})

test('a valid session without a selected local tenant still loads the existing Workspace while Run keeps its own owner gate', async t => {
  const world = await scenario(t, current => current.env.auth.saveCurrentTenantId(null))
  assert.equal(world.calls.filter(call => call.name === 'getProject').length, 1)
  assert.equal(world.calls.filter(call => call.name === 'getWork').length, 2, 'Workspace read plus the existing Source onMounted refresh')
  assert.equal(world.workspace.setupState.project.id, 5); assert.equal(world.workspace.setupState.work.id, 1)
  assert.equal(world.workspace.setupState.workspaceError, '')
  const instance = chain(world).run
  assert.equal(instance.setupState.contextReady, false); assert.equal(instance.setupState.canCreate, false)
  assert.equal(instance.setupState.canAdvance, false); assert.equal(posts(world).length, 0)
  assert.equal(world.env.auth.readCurrentTenantId(), null, 'loading cannot invent or persist a default tenant')
})
