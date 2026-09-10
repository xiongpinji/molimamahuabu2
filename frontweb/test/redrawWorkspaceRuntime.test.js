import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Real mounted Source/Workspace code; API, storage and timers are local doubles.
// No API/request/router module, browser, media decoder or application config is imported.
const readSource = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
async function flush() {
  for (let index = 0; index < 12; index++) { await vue.nextTick(); await Promise.resolve() }
}
function pureModule(relative) {
  const text = readSource(relative)
  assert.doesNotMatch(text, /^import\s/m, 'state helpers must stay import-free in this isolated fixture')
  const names = [...text.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1])
  assert.ok(names.length)
  return new Function(text.replace(/^export /gm, '') + `\nreturn {${names.join(',')}}`)()
}
const workspaceState = pureModule('../src/utils/redrawWorkspaceState.js')
const blueprintState = pureModule('../src/utils/redrawBlueprintReviewState.js')
const sourceAudioSeamReview = pureModule('../src/utils/redrawSourceAudioSeamReview.js')
const authSource = readSource('../src/utils/authSession.js')
const importPattern = /^import[ \t]+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"\r\n]+)\2[ \t]*;?[ \t]*(?:\r?\n|$)/gm
function bindImports(text, modules) {
  const result = text.replace(importPattern, (_whole, names, _quote, specifier) => {
    if (specifier === 'vue') {
      assert.ok(names.startsWith('{'))
      return `const ${names.replace(/\s+as\s+/g, ':')} = Vue;\n`
    }
    assert.ok(Object.hasOwn(modules, specifier), `unapproved SFC import: ${specifier}`)
    return `const ${names.replace(/\s+as\s+/g, ':')} = modules[${JSON.stringify(specifier)}];\n`
  })
  assert.doesNotMatch(result, /^import\s/m)
  return result
}
function compile(relative, modules, env) {
  const { descriptor } = parse(readSource(relative))
  const script = compileScript(descriptor, { id: relative })
  const template = compileTemplate({ id: relative, filename: relative, source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const component = new Function('Vue', 'modules', 'crypto', 'window', 'localStorage', 'sessionStorage',
    'setInterval', 'clearInterval', bindImports(script.content, modules).replace('export default', 'return'))(
    vue, modules, webcrypto, env.window, env.local, env.session, env.setInterval, env.clearInterval)
  component.render = new Function('Vue', bindImports(template.code, {}).replace('export function render', 'return function render'))(vue)
  return component
}
function memoryStorage() {
  const values = new Map()
  return { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key) }
}
function environment() {
  const local = memoryStorage(), session = memoryStorage(), listeners = new Map(), timers = new Map()
  let nextTimer = 0
  const auth = new Function('localStorage', 'sessionStorage', authSource.replace(/^export /gm, '')
    + '\nreturn {readSession,readCurrentTenantId,saveSession,saveCurrentTenantId}')(local, session)
  auth.saveSession({ token: 'synthetic-g3-token', user: { id: 'g3-user' } })
  auth.saveCurrentTenantId('g3-tenant')
  return { local, session, auth, timers,
    setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id },
    clearInterval: id => timers.delete(id),
    window: { localStorage: local, sessionStorage: session,
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn) } }
}
function renderer() {
  return vue.createRenderer({
    createElement: tag => ({ tag, tagName: tag.toUpperCase(), children: [], parent: null,
      get options() { return this.children.filter(child => child.tag === 'option') } }),
    createText: text => ({ text, parent: null }), createComment: comment => ({ comment, parent: null }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _old, value) => { node[key] = value }, parentNode: node => node.parent,
    nextSibling: node => { const siblings = node.parent?.children || []; return siblings[siblings.indexOf(node) + 1] || null },
    insert(node, parent, anchor = null) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = parent.children.indexOf(anchor)
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node)
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
function work(projectId = 5, id = 11, phase = 'source') {
  return { id, project_id: projectId, version_id: 10, title: `work-${projectId}-${id}`,
    current_step: 1, status: 'completed', workflow_phase: phase,
    analysis_quote: { credits: 6 },
    ...(phase === 'analysis_review' ? { analysis_task: { id: `analysis-${id}`, status: 'completed', progress: 100 },
      localization_quote: { priced: true, credits: 9, quote_hash: 'g3-quote-a' } } : {}) }
}
function project(id) { return { id: Number(id), title: `project-${id}`, execution_mode: 'safe', policy_version: 2,
  default_locale: 'en-US', default_market: 'US' } }
function failure(status) {
  return status === 'unknown' ? Error('synthetic unknown transport result')
    : Object.assign(Error(`synthetic HTTP ${status}`), { response: { status } })
}
async function scenario(t, options = {}) {
  const env = environment(), records = new Map(), calls = [], unexpected = [], messages = [], errors = []
  const pending = [], waits = [], events = [], navigation = []
  const initial = options.initial === undefined ? work() : options.initial
  if (initial) records.set(initial.id, clone(initial))
  const sourceProps = vue.reactive({ projectId: '5', defaultLocale: 'en-US', defaultMarket: 'US',
    initialWork: clone(initial), blueprintRecord: null, blueprintLoading: false, blueprintError: '', events: [], blocked: false,
    projectPolicy: { project_id: 5, execution_mode: 'safe', policy_version: 2, epoch: 1 } })
  const route = vue.reactive({ params: { projectId: '5', workId: initial ? String(initial.id) : 'new' }, query: { step: '1' } })
  const handlers = {
    listStylePresets: async () => [{ id: 7, name: 'synthetic style' }],
    listLocales: async () => [{ locale: 'en-US', market: 'US', status: 'full_output', blocking: [] },
      { locale: 'ja-JP', market: 'JP', status: 'full_output', blocking: [] }],
    getProject: async id => project(id), listProjectEvents: async () => [], getBlueprint: async () => null,
    listProjectWorks: async projectId => [...records.values()]
      .filter(item => String(item.project_id) === String(projectId))
      .map(item => Object.fromEntries(['id', 'project_id', 'title', 'duration_ms', 'current_step', 'status', 'created_at', 'updated_at']
        .map(key => [key, item[key] ?? null]))),
    getWork: async id => { assert.ok(records.has(Number(id)), `missing work fixture ${id}`); return clone(records.get(Number(id))) },
    quoteLocalization: async id => clone(records.get(Number(id))?.localization_quote),
  }
  const api = new Proxy({}, { get: (_target, name) => (...args) => {
    calls.push({ name, args })
    if (!Object.hasOwn(handlers, name)) { unexpected.push(name); return Promise.reject(Error(`G3_UNAPPROVED_API_${name}`)) }
    return Promise.resolve(handlers[name](...args))
  } })
  const stub = { inheritAttrs: false, setup: () => () => vue.h('div') }
  const modules = { '@/api/redraw': { redrawAPI: api }, '@/utils/authSession': env.auth,
    '@/utils/redrawWorkspaceState': workspaceState, '@/utils/redrawBlueprintReviewState': blueprintState,
    '@/utils/redrawSourceAudioSeamReview': sourceAudioSeamReview,
    'element-plus': { ElMessage: Object.fromEntries(['error', 'warning', 'success'].map(kind => [kind, text => messages.push({ kind, text })])) },
    'vue-router': { useRoute: () => route, useRouter: () => ({ replace(next) {
      navigation.push(clone(next)); if (next.params) Object.assign(route.params, next.params)
      if (next.query) Object.assign(route.query, next.query)
    } }) } }
  for (const name of ['PlatformHeader', 'RedrawProjectOverview', 'RedrawAssetStep', 'RedrawShotStep', 'RedrawEditStep',
    'RedrawBlueprintReviewPanel', 'RedrawLocalizationReviewPanel', 'StylePresetPicker']) {
    modules[`@/components/${name === 'PlatformHeader' ? '' : 'redraw/'}${name}.vue`] = stub
  }
  const Source = compile('../src/components/redraw/RedrawSourceStep.vue', modules, env)
  modules['@/components/redraw/RedrawSourceStep.vue'] = Source
  const Workspace = compile('../src/views/RedrawWorkspace.vue', modules, env)
  const Host = options.workspace ? Workspace : { setup: () => () => vue.h(Source, { ...sourceProps }) }
  const root = { children: [] }, app = renderer().createApp(Host)
  for (const [name, tag] of [['el-button', 'button'], ['el-select', 'select'], ['el-option', 'option'],
    ['el-radio', 'input'], ['el-radio-group', 'div'], ['el-tag', 'span'], ['el-alert', 'div'],
    ['el-progress', 'div'], ['el-segmented', 'div']]) {
    app.component(name, { props: ['disabled', 'loading', 'title', 'value', 'modelValue', 'label', 'options'],
      setup: (props, { attrs, slots }) => () => vue.h(tag, { ...attrs, disabled: props.disabled || props.loading,
        value: props.value ?? props.modelValue }, [props.title || props.label || '', ...(slots.default?.() || [])]) })
  }
  app.directive('loading', {})
  app.config.warnHandler = message => { throw Error(`G3 Vue warning: ${message}`) }
  app.config.errorHandler = error => errors.push(error)
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  let mounted = true
  const world = { env, records, calls, unexpected, messages, errors, events, navigation, handlers, sourceProps, route, root,
    defer() {
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      const wait = { promise, resolve, reject }; waits.push(wait); return wait
    },
    invoke(name, ...args) {
      assert.equal(typeof world.state[name], 'function', `missing real Source action ${name}`)
      const promise = Promise.resolve(world.state[name](...args)); promise.catch(() => {}); pending.push(promise); return promise
    },
    unmount() { if (mounted) { mounted = false; app.unmount() } },
    async visit(projectId, nextWork = null) {
      if (nextWork) records.set(nextWork.id, clone(nextWork))
      if (options.workspace) Object.assign(route.params, { projectId: String(projectId), workId: nextWork ? String(nextWork.id) : 'new' })
      else {
        sourceProps.projectPolicy.epoch += 1
        sourceProps.projectPolicy.project_id = Number(projectId)
        sourceProps.projectId = String(projectId); sourceProps.initialWork = clone(nextWork)
      }
      await flush()
    },
  }
  t.after(async () => {
    world.unmount(); waits.forEach(wait => wait.resolve(null)); await Promise.allSettled(pending); await flush()
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument
    assert.deepEqual(unexpected, [], 'unapproved API calls remain visible even when product catches rejection')
    assert.deepEqual(errors, [], 'mounted lifecycle failures must not be swallowed')
    assert.equal(env.timers.size, 0, 'unmount must clear every Source polling timer')
  })
  app.mount(root); await flush()
  world.workspace = options.workspace ? app._instance.setupState : null
  world.source = findInstance(app._instance.subTree, Source)
  assert.ok(world.source?.isMounted && !world.source.isUnmounted)
  world.state = world.source.setupState
  const originalEmit = world.source.emit
  world.source.emit = (name, ...args) => { events.push({ name, args: clone(args) }); return originalEmit(name, ...args) }
  return world
}
const namedCalls = (world, name) => world.calls.filter(call => call.name === name)
const writes = world => world.calls.filter(call => ['createWorks', 'analyzeWork', 'createVersion'].includes(call.name))
function selectFile(world, name = 'source-a.mp4') {
  const file = new File(['synthetic source bytes; not media acceptance'], name, { type: 'video/mp4' })
  world.state.onFileChange({ target: { files: [file] } }); return file
}
function readyAnalysis(world) {
  world.state.selectedPreset = { id: 7, name: 'synthetic style' }
  assert.ok(world.state.workState?.id, 'analysis uses a real identified work, never a quote-only invented DTO')
  assert.equal(world.state.canStartAnalysis, true)
}
function visibleState(world) {
  return { work: clone(world.state.workState), task: clone(world.state.taskState), localization: clone(world.state.localizationState),
    phase: world.state.workflowPhase, file: world.state.selectedFile, style: clone(world.state.freeStyle),
    locale: world.state.locale, market: world.state.market }
}
function acceptAnalysis(world) {
  world.handlers.analyzeWork = async id => {
    const task = { id: `analysis-current-${id}`, status: 'processing', progress: 0 }
    world.records.set(id, { ...clone(world.records.get(id)), workflow_phase: 'analyzing', analysis_task: task })
    return { task_id: task.id }
  }
}
function acceptLocalization(world) {
  world.handlers.createVersion = async id => {
    const task = { id: `localization-current-${id}`, status: 'processing', progress: 0 }
    world.records.set(id, { ...clone(world.records.get(id)), workflow_phase: 'localizing', localization_task: task })
    return { task_id: task.id, status: task.status }
  }
}

for (const aba of [false, true]) {
  test(`pending upload cannot publish into another Workspace visit${aba ? ' after project ABA' : ''}`, async t => {
    const world = await scenario(t, { workspace: true, initial: null }), wait = world.defer()
    const oldFile = selectFile(world)
    world.handlers.createWorks = () => wait.promise
    const pending = world.invoke('uploadSource')
    assert.equal(namedCalls(world, 'createWorks').length, 1)
    assert.equal(namedCalls(world, 'createWorks')[0].args[1], oldFile)
    await world.visit(6)
    if (aba) await world.visit(5)
    selectFile(world, 'current-visit.mp4'); world.state.freeStyle = { positivePrompt: 'current draft' }
    const before = visibleState(world), navCount = world.navigation.length, eventCount = world.events.length
    wait.resolve({ items: [work(5, 31)] }); await pending; await flush()
    assert.deepEqual(visibleState(world), before)
    assert.equal(world.workspace.work, null)
    assert.equal(world.navigation.length, navCount); assert.equal(world.events.length, eventCount)
    assert.equal(namedCalls(world, 'analyzeWork').length, 0)
  })
}
test('unmounted upload discards its response and notifications', async t => {
  const world = await scenario(t, { initial: null }), wait = world.defer()
  selectFile(world); world.handlers.createWorks = () => wait.promise
  const pending = world.invoke('uploadSource'), before = visibleState(world)
  world.unmount(); wait.resolve({ items: [work(5, 31)] }); await pending; await flush()
  assert.deepEqual(visibleState(world), before); assert.deepEqual(world.events, [])
  assert.deepEqual(world.messages, []); assert.equal(namedCalls(world, 'analyzeWork').length, 0)
})
test('current upload publishes exactly its current project work without automatic analysis', async t => {
  const world = await scenario(t, { initial: null }), created = work(5, 31)
  selectFile(world); world.handlers.createWorks = async () => ({ items: [created] })
  await world.invoke('uploadSource'); await flush()
  assert.equal(world.state.workState.id, 31); assert.equal(world.events.length, 1)
  assert.deepEqual(world.events[0], { name: 'work-updated', args: [created] })
  assert.equal(world.state.uploading, false); assert.equal(namedCalls(world, 'analyzeWork').length, 0)
})
test('old upload finally cannot release the busy state of a new visit upload', async t => {
  const world = await scenario(t, { initial: null }), old = world.defer(), current = world.defer()
  selectFile(world); world.handlers.createWorks = id => String(id) === '5' ? old.promise : current.promise
  const oldPending = world.invoke('uploadSource')
  await world.visit(6); selectFile(world, 'new.mp4')
  const currentPending = world.invoke('uploadSource')
  assert.equal(world.state.uploading, true); assert.equal(namedCalls(world, 'createWorks').length, 2)
  old.resolve({ items: [work(5, 31)] }); await oldPending; await flush()
  assert.equal(world.state.uploading, true); assert.equal(world.state.workState, null)
  current.resolve({ items: [work(6, 32)] }); await currentPending; await flush()
  assert.equal(world.state.uploading, false); assert.equal(world.state.workState.id, 32)
  assert.deepEqual(world.events.map(event => event.args[0].id), [32])
})

for (const boundary of ['visit', 'unmount']) {
  test(`analysis cannot POST after ${boundary} at the real ensureWork await boundary`, async t => {
    const world = await scenario(t); readyAnalysis(world); acceptAnalysis(world)
    const pending = world.invoke('startAnalysis')
    // No deferred/fake ensureWork: its async return yields naturally for a valid existing work.
    if (boundary === 'visit') await world.visit(6, work(6, 22)); else world.unmount()
    await pending; await flush()
    assert.equal(namedCalls(world, 'analyzeWork').length, 0)
    assert.equal(namedCalls(world, 'createWorks').length, 0)
    assert.equal(world.messages.filter(message => message.kind === 'success').length, 0)
  })
}
for (const outcome of ['success', 'error']) {
  test(`late analysis ${outcome} and finally cannot overwrite a new visit operation`, async t => {
    const world = await scenario(t), old = world.defer(), current = world.defer()
    readyAnalysis(world); world.handlers.analyzeWork = id => id === 11 ? old.promise : current.promise
    const oldPending = world.invoke('startAnalysis'); await flush()
    assert.equal(namedCalls(world, 'analyzeWork').length, 1)
    await world.visit(6, work(6, 22)); readyAnalysis(world)
    const currentPending = world.invoke('startAnalysis'); await flush()
    assert.equal(namedCalls(world, 'analyzeWork').length, 2)
    const before = visibleState(world), reads = namedCalls(world, 'getWork').length, messages = world.messages.length
    if (outcome === 'success') old.resolve({ task_id: 'old-analysis' }); else old.reject(failure('unknown'))
    await oldPending; await flush()
    assert.deepEqual(visibleState(world), before); assert.equal(world.state.submitting, true)
    assert.equal(namedCalls(world, 'getWork').length, reads); assert.equal(world.messages.length, messages)
    current.resolve({ task_id: 'current-analysis' }); await currentPending; await flush()
    assert.equal(world.state.submitting, false)
  })
}
test('current analysis accepts one rapid double-click and keeps the real output payload', async t => {
  const world = await scenario(t), wait = world.defer(); readyAnalysis(world)
  world.handlers.analyzeWork = () => wait.promise
  const first = world.invoke('startAnalysis'), second = world.invoke('startAnalysis'); await flush()
  assert.equal(namedCalls(world, 'analyzeWork').length, 1)
  assert.deepEqual(namedCalls(world, 'analyzeWork')[0].args, [11,
    { locale: 'en-US', market: 'US', aspect_ratio: '16:9', style_preset_id: 7 }])
  wait.resolve({ task_id: 'current-analysis' }); await Promise.all([first, second]); await flush()
  assert.equal(world.state.submitting, false)
})
for (const status of [409, 429, 'unknown']) {
  test(`analysis ${status} failure never causes an automatic repeat POST`, async t => {
    const world = await scenario(t); readyAnalysis(world)
    world.handlers.analyzeWork = async () => { throw failure(status) }
    await world.invoke('startAnalysis'); await flush(); await flush()
    assert.equal(namedCalls(world, 'analyzeWork').length, 1); assert.equal(world.state.submitting, false)
  })
}

for (const boundary of ['work ABA', 'target ABA', 'unmount']) {
  test(`confirmation quote cannot authorize createVersion after ${boundary}`, async t => {
    const original = work(5, 11, 'analysis_review'), world = await scenario(t, { initial: original }), wait = world.defer()
    assert.equal(world.state.canSubmitLocalization, true)
    world.handlers.quoteLocalization = () => wait.promise; acceptLocalization(world)
    const pending = world.invoke('confirmLocalization'); await flush()
    assert.equal(namedCalls(world, 'quoteLocalization').length, 1)
    if (boundary === 'work ABA') { await world.visit(6, work(6, 22, 'analysis_review')); await world.visit(5, original) }
    else if (boundary === 'target ABA') {
      world.state.locale = 'ja-JP'; world.state.market = 'JP'; await flush()
      world.state.locale = 'en-US'; world.state.market = 'US'; await flush()
    } else world.unmount()
    const before = visibleState(world), eventCount = world.events.length
    wait.resolve(clone(original.localization_quote)); await pending; await flush()
    assert.equal(namedCalls(world, 'createVersion').length, 0)
    assert.deepEqual(visibleState(world), before); assert.equal(world.events.length, eventCount)
  })
}
test('current confirmation survives an ordinary readonly work refresh and deduplicates double-click', async t => {
  const original = work(5, 11, 'analysis_review'), world = await scenario(t, { initial: original }), quote = world.defer()
  world.handlers.quoteLocalization = () => quote.promise; acceptLocalization(world)
  const first = world.invoke('confirmLocalization'), second = world.invoke('confirmLocalization'); await flush()
  assert.equal(namedCalls(world, 'quoteLocalization').length, 1)
  await world.invoke('refreshWork'); await flush()
  quote.resolve(clone(original.localization_quote)); await Promise.all([first, second]); await flush()
  assert.equal(namedCalls(world, 'createVersion').length, 1)
  const [id, payload] = namedCalls(world, 'createVersion')[0].args
  assert.equal(id, 11); assert.deepEqual(Object.keys(payload).sort(), ['idempotency_key', 'locale', 'localization_level', 'market', 'quote_hash'])
  assert.deepEqual({ ...payload, idempotency_key: 'checked' }, { idempotency_key: 'checked', locale: 'en-US', market: 'US',
    localization_level: 'faithful', quote_hash: 'g3-quote-a' })
  assert.ok(payload.idempotency_key); assert.equal(world.state.localizationSubmitting, false)
  assert.equal(world.state.localizationState.task_id, 'localization-current-11')
})
test('old createVersion response and finally cannot clear a new confirmation or refresh its work', async t => {
  const world = await scenario(t, { initial: work(5, 11, 'analysis_review') }), old = world.defer(), current = world.defer()
  world.handlers.createVersion = id => id === 11 ? old.promise : current.promise
  const oldPending = world.invoke('confirmLocalization'); await flush()
  assert.equal(namedCalls(world, 'createVersion').length, 1)
  await world.visit(6, work(6, 22, 'analysis_review'))
  const currentPending = world.invoke('confirmLocalization'); await flush()
  assert.equal(namedCalls(world, 'createVersion').length, 2)
  const before = visibleState(world), reads = namedCalls(world, 'getWork').length
  old.resolve({ task_id: 'old-localization', status: 'processing' }); await oldPending; await flush()
  assert.deepEqual(visibleState(world), before); assert.equal(world.state.localizationSubmitting, true)
  assert.equal(namedCalls(world, 'getWork').length, reads)
  current.resolve({ task_id: 'current-localization', status: 'processing' }); await currentPending; await flush()
  assert.equal(world.state.localizationSubmitting, false)
})
for (const stage of ['quoteLocalization', 'createVersion']) {
  for (const status of [409, 429, 'unknown']) {
    test(`${stage} ${status} fails without automatic retry or losing an issued idempotency key`, async t => {
      const world = await scenario(t, { initial: work(5, 11, 'analysis_review') })
      acceptLocalization(world); world.handlers[stage] = async () => { throw failure(status) }
      await world.invoke('confirmLocalization'); await flush()
      const count = writes(world).length, key = world.state.localizationIdempotencyKey
      await world.invoke('refreshWork'); await flush(); await flush()
      assert.equal(namedCalls(world, stage).length, 1); assert.equal(writes(world).length, count)
      assert.equal(namedCalls(world, 'createVersion').length, stage === 'quoteLocalization' ? 0 : 1)
      if (stage === 'createVersion') { assert.ok(key); assert.equal(world.state.localizationIdempotencyKey, key) }
      assert.equal(world.state.localizationSubmitting, false)
    })
  }
}

test('Workspace new route rejects a work explicitly belonging to another project before events or navigation', async t => {
  const world = await scenario(t, { workspace: true, initial: null })
  const before = clone(world.workspace.work), calls = world.calls.length, navigation = world.navigation.length
  world.workspace.onWorkUpdated(work(6, 22)); await flush()
  assert.deepEqual(world.workspace.work, before); assert.equal(world.calls.length, calls)
  assert.equal(world.navigation.length, navigation); assert.equal(world.route.params.workId, 'new')
})
test('Workspace new route accepts a legitimate same-project work and navigates once', async t => {
  const world = await scenario(t, { workspace: true, initial: null }), created = work(5, 31)
  world.records.set(created.id, created)
  world.workspace.onWorkUpdated(created); await flush()
  assert.equal(world.workspace.work.id, 31); assert.equal(world.route.params.workId, 31)
  assert.equal(world.navigation.filter(item => item.params?.workId === 31).length, 1)
  assert.equal(writes(world).length, 0)
})
test('existing Source refreshWork guard rejects a late read after a project visit', async t => {
  const world = await scenario(t), wait = world.defer()
  world.handlers.getWork = () => wait.promise
  const pending = world.invoke('refreshWork')
  await world.visit(6, work(6, 22))
  const before = visibleState(world), count = world.events.length
  wait.resolve({ ...work(5, 11), title: 'late old read' }); await pending; await flush()
  assert.deepEqual(visibleState(world), before); assert.equal(world.events.length, count)
  assert.equal(writes(world).length, 0)
})
test('existing Workspace events await guard rejects a result from the previous project', async t => {
  const world = await scenario(t, { workspace: true, initial: null }), wait = world.defer()
  world.handlers.listProjectEvents = id => String(id) === '5' ? wait.promise : Promise.resolve([])
  const pending = world.workspace.loadWorkspace(); await flush()
  await world.visit(6)
  wait.resolve([{ id: 90, stage: 'old-project-event' }]); await pending; await flush()
  assert.equal(world.workspace.project.id, 6); assert.deepEqual(world.workspace.projectEvents, [])
  assert.equal(writes(world).length, 0)
})
