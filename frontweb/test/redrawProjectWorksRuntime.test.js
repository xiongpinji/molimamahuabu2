import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Real mounted Source/Workspace code; only new project-works entry behavior.
// Request/router, browser, media and application config are never imported.
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
  return { local, session, auth, timers, listeners,
    setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id },
    clearInterval: id => timers.delete(id),
    window: { localStorage: local, sessionStorage: session,
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
      dispatch: (name, event) => [...(listeners.get(name) || [])].forEach(fn => fn(event)) } }
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

const NOW = '2026-09-08T00:00:00.000Z'
const ITEM_KEYS = ['id', 'project_id', 'title', 'duration_ms', 'current_step', 'status', 'created_at', 'updated_at']
function work(projectId = 5, id = 11) {
  return { id, project_id: projectId, version_id: 100 + id, title: 'Source ' + id,
    duration_ms: 12000, current_step: 1, status: 'draft', workflow_phase: 'source',
    created_at: NOW, updated_at: NOW, analysis_quote: { credits: 6 } }
}
function publicWork(value) { return Object.fromEntries(ITEM_KEYS.map(key => [key, value[key]])) }
function project(id) {
  return { id: Number(id), title: 'Project ' + id, execution_mode: 'safe', policy_version: 2,
    default_locale: 'en-US', default_market: 'US' }
}
function nodes(root, predicate) {
  const result = predicate(root) ? [root] : []
  for (const child of root.children || []) result.push(...nodes(child, predicate))
  return result
}
function textOf(node) { return String(node.text || '') + (node.children || []).map(textOf).join('') }
function button(world, name) {
  const matches = nodes(world.root, node => node.tag === 'button' && textOf(node).trim() === name)
  assert.equal(matches.length, 1, 'one visible ' + name + ' button is required')
  return matches[0]
}
function selector(world) {
  const matches = nodes(world.root, node => node.tag === 'select' && node['aria-label'] === '选择作品')
  assert.equal(matches.length, 1, 'the real Workspace must expose an accessible work selector')
  return matches[0]
}
function optionIds(world) {
  return nodes(selector(world), node => node.tag === 'option').map(node => String(node.value))
    .filter(value => value !== 'new' && value !== '')
}
function snapshot(world) {
  return { work: clone(world.workspace.work), blueprint: clone(world.workspace.blueprintRecord),
    events: clone(world.workspace.projectEvents), navigation: clone(world.navigation) }
}
const namedCalls = (world, name) => world.calls.filter(call => call.name === name)
const writes = world => world.calls.filter(call => !['getProject', 'getWork', 'getBlueprint',
  'listProjectWorks', 'listProjectEvents', 'listStylePresets', 'listLocales'].includes(call.name))

async function scenario(t, options = {}) {
  const env = environment(), calls = [], unexpected = [], errors = [], messages = [], navigation = []
  const records = new Map((options.records || [work(5, 11), work(5, 12), work(6, 21)]).map(item => [item.id, clone(item)]))
  const pending = [], waits = []
  const route = vue.reactive({ params: { projectId: String(options.projectId || 5),
    workId: String(options.workId || 'new') }, query: { step: '1' } })
  const handlers = {
    getProject: async id => project(id),
    getWork: async id => { assert.ok(records.has(Number(id))); return clone(records.get(Number(id))) },
    getBlueprint: async () => null,
    listProjectEvents: async () => [],
    listProjectWorks: async id => [...records.values()].filter(item => String(item.project_id) === String(id)).map(publicWork),
    listStylePresets: async () => [{ id: 7, name: 'Synthetic style' }],
    listLocales: async () => [{ locale: 'en-US', market: 'US', status: 'full_output', blocking: [] }],
  }
  const api = new Proxy({}, { get: (_target, name) => (...args) => {
    calls.push({ name, args: clone(args) })
    if (!Object.hasOwn(handlers, name)) {
      unexpected.push(name)
      const rejected = Promise.reject(Error('PROJECT_WORKS_UNAPPROVED_API_' + name))
      rejected.catch(() => {}); pending.push(rejected); return rejected
    }
    const request = Promise.resolve().then(() => handlers[name](...args))
    request.catch(() => {}); pending.push(request); return request
  } })
  const world = { env, records, calls, unexpected, errors, messages, navigation, handlers, route,
    defer() {
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      const wait = { promise, resolve, reject }; waits.push(wait); return wait
    },
    async visit(projectId, workId = 'new') {
      Object.assign(route.params, { projectId: String(projectId), workId: String(workId) })
      await flush()
    },
  }
  const stub = { inheritAttrs: false, setup: () => () => vue.h('div') }
  const modules = { '@/api/redraw': { redrawAPI: api }, '@/utils/authSession': env.auth,
    '@/utils/redrawWorkspaceState': workspaceState, '@/utils/redrawBlueprintReviewState': blueprintState,
    '@/utils/redrawSourceAudioSeamReview': sourceAudioSeamReview,
    'element-plus': { ElMessage: Object.fromEntries(['error', 'warning', 'success'].map(kind =>
      [kind, value => messages.push({ kind, value })])) },
    'vue-router': { useRoute: () => route, useRouter: () => ({ replace(next) {
      navigation.push(clone(next))
      if (next.params) Object.assign(route.params, next.params)
      if (next.query) Object.assign(route.query, next.query)
      return Promise.resolve()
    } }) } }
  for (const name of ['PlatformHeader', 'RedrawProjectOverview', 'RedrawAssetStep', 'RedrawShotStep', 'RedrawEditStep',
    'RedrawBlueprintReviewPanel', 'RedrawLocalizationReviewPanel', 'StylePresetPicker']) {
    modules['@/components/' + (name === 'PlatformHeader' ? '' : 'redraw/') + name + '.vue'] = stub
  }
  const Source = compile('../src/components/redraw/RedrawSourceStep.vue', modules, env)
  modules['@/components/redraw/RedrawSourceStep.vue'] = Source
  const Workspace = compile('../src/views/RedrawWorkspace.vue', modules, env)
  const root = { children: [] }, app = renderer().createApp(Workspace)
  for (const [name, tag] of [['el-button', 'button'], ['el-select', 'select'], ['el-option', 'option'],
    ['el-tag', 'span'], ['el-alert', 'div'], ['el-progress', 'div'], ['el-segmented', 'div'],
    ['el-radio', 'input'], ['el-radio-group', 'div']]) {
    app.component(name, { props: ['disabled', 'loading', 'title', 'value', 'modelValue', 'label', 'options'],
      setup: (props, { attrs, slots }) => () => vue.h(tag, { ...attrs, disabled: props.disabled || props.loading,
        value: props.value ?? props.modelValue }, [props.title || props.label || '', ...(slots.default?.() || [])]) })
  }
  app.directive('loading', {})
  app.config.warnHandler = message => { throw Error('Project works Vue warning: ' + message) }
  app.config.errorHandler = error => errors.push(error)
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  let mounted = true
  world.root = root
  world.findSource = () => findInstance(app._instance?.subTree, Source)
  world.unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  world.invokeSource = (name, ...args) => {
    const instance = world.findSource()
    assert.ok(instance?.isMounted && !instance.isUnmounted, 'the real Source must be mounted')
    const task = Promise.resolve(instance.setupState[name](...args))
    task.catch(() => {}); pending.push(task); return task
  }
  world.click = name => {
    const action = (async () => {
      const target = button(world, name)
      assert.equal(Boolean(target.disabled), false, name + ' is disabled')
      assert.equal(typeof target.onClick, 'function')
      const result = Promise.resolve(target.onClick())
      result.catch(() => {}); pending.push(result)
      await flush()
      return result
    })()
    action.catch(() => {}); pending.push(action)
    return action
  }
  world.choose = async id => {
    const target = selector(world)
    assert.equal(Boolean(target.disabled), false)
    assert.equal(typeof target.onChange, 'function', 'native select change must use the real Workspace handler')
    const action = Promise.resolve(target.onChange({ target: { value: String(id) } }))
    action.catch(() => {}); pending.push(action)
    await action; await flush()
  }
  t.after(async () => {
    world.unmount(); waits.forEach(wait => wait.resolve(null)); await Promise.allSettled(pending); await flush()
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument
    assert.deepEqual(unexpected, [], 'every unapproved API call is recorded even when product catches rejection')
    assert.deepEqual(errors, [], 'mounted component errors must not be swallowed')
    assert.equal(env.timers.size, 0, 'Source timers must be cleaned on unmount')
    assert.equal([...env.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0)
  })
  if (options.configure) options.configure(world)
  app.mount(root); await flush()
  world.workspace = app._instance.setupState
  assert.ok(world.findSource()?.isMounted)
  return world
}

test('real API wrapper lists a project with one GET and no write or extra options', async () => {
  const calls = [], expected = Promise.resolve([publicWork(work())])
  const request = new Proxy({}, { get: (_target, method) => (...args) => {
    calls.push({ method, args }); return expected
  } })
  const modules = { '@/utils/request': request,
    '@/utils/redrawTimelineState': pureModule('../src/utils/redrawTimelineState.js') }
  const code = bindImports(readSource('../src/api/redraw.js'), modules).replace(/^export /gm, '')
  const api = new Function('Vue', 'modules', code + '\nreturn redrawAPI')(vue, modules)
  assert.equal(typeof api.listProjectWorks, 'function')
  assert.equal(api.listProjectWorks(5), expected)
  await expected
  assert.deepEqual(calls, [{ method: 'get', args: ['/redraw/projects/5/works'] }])
})

test('new empty project stays new and exposes the works entry without automatic work creation', async t => {
  const world = await scenario(t, { records: [] })
  assert.deepEqual(optionIds(world), [])
  assert.equal(namedCalls(world, 'listProjectWorks').length, 1)
  assert.equal(world.route.params.workId, 'new')
  assert.equal(world.workspace.work, null)
  assert.deepEqual(world.navigation, []); assert.deepEqual(writes(world), [])
})

test('two works appear on a new project route without silently choosing the first', async t => {
  const world = await scenario(t)
  assert.deepEqual(optionIds(world), ['11', '12'])
  assert.equal(world.route.params.workId, 'new')
  assert.deepEqual(world.navigation, []); assert.deepEqual(writes(world), [])
  assert.equal(namedCalls(world, 'getWork').length, 0)
})

test('selecting the second work navigates by name, remounts Source and reads its real version', async t => {
  const world = await scenario(t), previousSource = world.findSource()
  world.records.get(12).version_id = 912
  await world.choose(12)
  assert.equal(world.navigation.at(-1).name, 'redraw-workspace')
  assert.deepEqual(Object.fromEntries(Object.entries(world.navigation.at(-1).params).map(([key, value]) => [key, String(value)])),
    { projectId: '5', workId: '12' })
  assert.equal(String(world.route.params.workId), '12')
  assert.equal(world.workspace.work.version_id, 912)
  assert.ok(namedCalls(world, 'getWork').some(call => String(call.args[0]) === '12'))
  assert.notEqual(world.findSource().uid, previousSource.uid)
  assert.equal(previousSource.isUnmounted, true)
  assert.equal(world.findSource().setupState.workState.id, 12)
  assert.deepEqual(writes(world), [])
})

test('reopening the second-work route restores that work rather than the list first item', async t => {
  const world = await scenario(t, { workId: 12 })
  assert.deepEqual(optionIds(world), ['11', '12'])
  assert.equal(String(selector(world).value), '12')
  assert.equal(world.workspace.work.id, 12)
  assert.equal(world.workspace.work.version_id, 112)
  assert.equal(world.findSource().setupState.workState.id, 12)
  assert.equal(namedCalls(world, 'getWork').some(call => String(call.args[0]) === '11'), false)
  assert.deepEqual(writes(world), [])
})

test('explicit new-work navigation discards the selected Source draft without deleting registered works', async t => {
  const world = await scenario(t, { workId: 12 }), previousSource = world.findSource()
  await world.click('上传新作品')
  assert.equal(world.navigation.at(-1).name, 'redraw-workspace')
  assert.equal(world.route.params.workId, 'new')
  assert.equal(world.workspace.work, null)
  assert.notEqual(world.findSource().uid, previousSource.uid); assert.equal(previousSource.isUnmounted, true)
  assert.equal(world.findSource().setupState.workState, null)
  assert.deepEqual(optionIds(world), ['11', '12']); assert.deepEqual(writes(world), [])
})

test('readonly works refresh preserves the mounted Source and current route', async t => {
  const world = await scenario(t, { workId: 12 }), previousSource = world.findSource()
  const navigation = clone(world.navigation)
  world.records.set(13, work(5, 13))
  await world.click('刷新作品列表')
  assert.deepEqual(optionIds(world), ['11', '12', '13'])
  assert.equal(world.findSource(), previousSource)
  assert.equal(previousSource.isUnmounted, false)
  assert.deepEqual(world.navigation, navigation); assert.equal(String(world.route.params.workId), '12')
  assert.deepEqual(writes(world), [])
})

test('upload response keeps first navigation compatible while a readonly list reveals every new work', async t => {
  const world = await scenario(t, { records: [] })
  world.handlers.createWorks = async () => {
    const created = [work(5, 31), work(5, 32)]
    created.forEach(item => world.records.set(item.id, item))
    return { items: clone(created) }
  }
  const source = world.findSource().setupState
  source.onFileChange({ target: { files: [new File(['synthetic bytes, not ZIP acceptance'], 'sources.zip')] } })
  await world.invokeSource('uploadSource'); await flush()
  assert.equal(namedCalls(world, 'createWorks').length, 1)
  assert.equal(String(world.route.params.workId), '31')
  assert.deepEqual(optionIds(world), ['31', '32'])
  await world.choose(32)
  assert.equal(world.workspace.work.id, 32)
  assert.deepEqual(writes(world).map(call => call.name), ['createWorks'])
})

for (const aba of [false, true]) {
  test('late works list cannot cross a project visit' + (aba ? ' after ABA' : ''), async t => {
    const world = await scenario(t), stale = world.defer()
    const originalList = world.handlers.listProjectWorks
    let first = true
    world.handlers.listProjectWorks = id => {
      if (first && String(id) === '5') { first = false; return stale.promise }
      return originalList(id)
    }
    const refresh = world.click('刷新作品列表'); await flush()
    await world.visit(6)
    if (aba) await world.visit(5)
    const before = optionIds(world), navigation = clone(world.navigation)
    stale.resolve([publicWork({ ...work(5, 98), title: 'Stale visit source' })])
    await refresh; await flush()
    assert.deepEqual(optionIds(world), before)
    assert.deepEqual(world.navigation, navigation); assert.deepEqual(writes(world), [])
  })
}

test('a failed list refresh is visible, has no automatic retry and does not change work selection', async t => {
  const world = await scenario(t, { workId: 12 })
  world.handlers.listProjectWorks = async () => { throw Error('Synthetic list unavailable') }
  const count = namedCalls(world, 'listProjectWorks').length
  await world.click('刷新作品列表'); await flush(); await flush()
  assert.equal(namedCalls(world, 'listProjectWorks').length, count + 1)
  assert.match(textOf(world.root), /Synthetic list unavailable|作品列表.*失败/)
  assert.equal(String(world.route.params.workId), '12'); assert.equal(world.workspace.work.id, 12)
  assert.deepEqual(writes(world), [])
})

for (const routeKind of ['work ABA', 'project ABA', 'new route ABA']) {
  test('captured child event from ' + routeKind + ' cannot mutate the current visit', async t => {
    const initialId = routeKind === 'new route ABA' ? 'new' : 11
    const world = await scenario(t, { workId: initialId }), oldSource = world.findSource()
    const oldWorkUpdate = oldSource.vnode.props.onWorkUpdated
    const oldBlueprintUpdate = oldSource.vnode.props.onBlueprintUpdated
    assert.equal(typeof oldWorkUpdate, 'function'); assert.equal(typeof oldBlueprintUpdate, 'function')
    if (routeKind === 'work ABA') { await world.visit(5, 12); await world.visit(5, 11) }
    else { await world.visit(6); await world.visit(5, initialId) }
    assert.equal(oldSource.isUnmounted, true); assert.notEqual(world.findSource().uid, oldSource.uid)
    const before = snapshot(world), count = world.calls.length
    oldWorkUpdate({ ...work(5, 11), title: 'Stale captured work' })
    oldBlueprintUpdate({ work_id: 11, status: 'draft', blueprint_hash: 'b'.repeat(64) })
    await flush()
    assert.deepEqual(snapshot(world), before); assert.equal(world.calls.length, count)
    assert.deepEqual(writes(world), [])
  })
}

for (const dimension of ['user', 'tenant']) {
  test('pure owner ' + dimension + ' ABA preserves Source while rejecting the pre-visit callback after reload', async t => {
    const world = await scenario(t, { workId: 11 }), instance = world.findSource()
    const oldWorkUpdate = instance.vnode.props.onWorkUpdated
    const key = dimension === 'user' ? 'moli_mama_session' : 'moli_mama_tenant_id'
    const oldValue = world.env.local.getItem(key)
    if (dimension === 'user') world.env.auth.saveSession({ token: 'synthetic-b', user: { id: 'other-user' } })
    else world.env.auth.saveCurrentTenantId('other-tenant')
    const otherValue = world.env.local.getItem(key)
    world.env.auth.saveSession({ token: 'synthetic-g3-token', user: { id: 'g3-user' } })
    world.env.auth.saveCurrentTenantId('g3-tenant')
    world.env.window.dispatch('storage', { key, oldValue, newValue: otherValue, storageArea: world.env.local })
    world.env.window.dispatch('storage', { key, oldValue: otherValue, newValue: oldValue, storageArea: world.env.local })
    await flush()
    assert.equal(world.findSource(), instance); assert.equal(instance.isUnmounted, false)
    assert.ok(world.workspace.workspaceError)
    await world.workspace.loadWorkspace(); await flush()
    assert.equal(world.findSource(), instance)
    const before = snapshot(world), count = world.calls.length
    oldWorkUpdate({ ...work(5, 11), title: 'Stale owner callback' }); await flush()
    assert.deepEqual(snapshot(world), before); assert.equal(world.calls.length, count)
    assert.deepEqual(writes(world), [])
  })
}

test('same-tick work route ABA remounts Source even when the final route text is unchanged', async t => {
  const world = await scenario(t, { workId: 11 }), previousSource = world.findSource()
  const oldWorkUpdate = previousSource.vnode.props.onWorkUpdated
  world.route.params.workId = '12'; world.route.params.workId = '11'
  await flush()
  assert.equal(previousSource.isUnmounted, true)
  assert.notEqual(world.findSource().uid, previousSource.uid)
  const before = snapshot(world), count = world.calls.length
  oldWorkUpdate({ ...work(5, 11), title: 'Same-tick stale visit' }); await flush()
  assert.deepEqual(snapshot(world), before); assert.equal(world.calls.length, count)
  assert.deepEqual(writes(world), [])
})

test('ordinary workspace reread does not unmount the selected work subtree', async t => {
  const world = await scenario(t, { workId: 12 }), instance = world.findSource()
  await world.workspace.loadWorkspace(); await flush()
  assert.equal(world.findSource(), instance); assert.equal(instance.isUnmounted, false)
  assert.equal(world.workspace.work.id, 12); assert.deepEqual(writes(world), [])
})

test('unmounted workspace ignores its pending work-list result and leaves no timers or listeners', async t => {
  const world = await scenario(t), stale = world.defer()
  world.handlers.listProjectWorks = () => stale.promise
  const refresh = world.click('刷新作品列表'); await flush()
  const before = snapshot(world), count = world.calls.length
  world.unmount(); stale.resolve([publicWork(work(5, 98))]); await refresh; await flush()
  assert.deepEqual(snapshot(world), before); assert.equal(world.calls.length, count)
})
