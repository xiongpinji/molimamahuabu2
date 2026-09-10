import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

const location = new URL('../src/components/redraw/RedrawUnitReferenceMaterialsPanel.vue', import.meta.url)
const hash = value => createHash('sha256').update(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
const digest = char => char.repeat(64)
function document() {
  const units = [1, 2].map((id, ordinal) => ({ id: `unit-${id}`, source_start_ms: ordinal * 5000, source_end_ms: id * 5000,
    parent_shots: [{ id: 'shot-1' }], reference_requirements: [{ id: 'motion-shot-1', kind: 'video' }] }))
  const bindings = { tenant_id: 'tenant-a', user_id: 'user-a', work_id: 1, version_id: 10,
    source_asset_id: 101, source_sha256: digest('d'), blueprint_hash: digest('b'), localization_hash: digest('c'),
    capability_hash: digest('e'), localization_updated_at: 'saved' }
  const preview = { schema_version: 'redraw-execution-plan-preview-v1', status: 'ready', executable: false,
    plan_hash: digest('a'), bindings, units }
  return { record: { version_id: 10, blueprint_hash: bindings.blueprint_hash, localization_hash: bindings.localization_hash, updated_at: 'saved' },
    preview, savedReview: { id: 4, status: 'current', plan_hash: preview.plan_hash, plan: structuredClone(preview) },
    queue: { id: 8, version_id: 10, work_id: 1, status: 'waiting_readiness', executable: false, plan_hash: preview.plan_hash,
      units: units.map((plan_unit, ordinal) => ({ id: plan_unit.id, ordinal, status: 'pending', unit_hash: hash(plan_unit), plan_unit })) }, blocked: false }
}
function inspection(props, unitId = 'unit-1', prepared = false, materialsHash = digest('f')) {
  const unit = props.queue.units.find(item => item.id === unitId), planBindings = props.preview.bindings
  const bindings = { ...planBindings, review_id: props.savedReview.id, queue_id: props.queue.id,
    plan_hash: props.preview.plan_hash, unit_id: unitId, unit_hash: unit.unit_hash, production_pack_hash: digest('9') }
  delete bindings.localization_updated_at
  const data = { schema_version: 'redraw-unit-prepared-reference-inspection-v1', bindings, materials_hash: materialsHash,
    status: prepared ? 'prepared' : 'needs_preparation' }
  if (prepared) {
    const value = { schema_version: 'redraw-unit-prepared-reference-materials-v1', bindings: structuredClone(bindings),
      materials_hash: materialsHash, references: [{ requirement_id: 'motion-shot-1', kind: 'video', state: 'ready', asset_id: 600, sha256: digest('8') }] }
    data.prepared_materials = { ...value, prepared_materials_hash: hash(value) }
  } else data.missing_requirement_ids = ['motion-shot-1']
  return data
}
const tick = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function runtime(t, api = {}) {
  assert.ok(existsSync(location), 'ordinary-user unit materials component must exist')
  const source = readFileSync(location, 'utf8'), props = vue.reactive(document()), calls = [], unmount = [], scope = vue.effectScope()
  let prepared = false
  const bindings = { ref: vue.ref, computed: vue.computed, watch: vue.watch, onUnmounted: fn => unmount.push(fn), crypto: webcrypto,
    redrawAPI: { getUnitReferenceMaterials: async (v, q, u, body) => { calls.push(['get', v, q, u, body]); return inspection(props, u, prepared) },
      prepareUnitReferenceMaterials: async (v, q, u, body) => { calls.push(['post', v, q, u, body]); prepared = true; return inspection(props, u, true).prepared_materials }, ...api } }
  const script = compileScript(parse(source).descriptor, { id: 'unit-materials' }).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
  const component = new Function(...Object.keys(bindings), script)(...Object.values(bindings))
  const state = scope.run(() => component.setup(props, { expose() {}, emit() {} }))
  const dispose = () => { unmount.forEach(fn => fn()); scope.stop() }; t.after(dispose)
  return { state, props, calls, dispose, source }
}

test('API forwards only exact bindings to the unit GET/POST and never retries POST', async () => {
  const calls = [], response = {}
  const source = readFileSync(new URL('../src/api/redraw.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/export /g, '').replace('const redrawAPI =', 'return')
  const api = new Function('request', source)({ get: (...args) => { calls.push(['get', ...args]); return response }, post: (...args) => { calls.push(['post', ...args]); return response } })
  assert.equal(typeof api.getUnitReferenceMaterials, 'function')
  assert.equal(typeof api.prepareUnitReferenceMaterials, 'function')
  const input = { review_id: 4, plan_hash: digest('a'), unit_hash: digest('b'), expected_materials_hash: digest('c'), path: 'forbidden', model: 'forbidden', key: 'forbidden' }
  assert.equal(await api.getUnitReferenceMaterials(10, 8, 'unit/1', input), response)
  assert.equal(await api.prepareUnitReferenceMaterials(10, 8, 'unit/1', input), response)
  const url = '/redraw/versions/10/execution-queues/8/units/unit%2F1/reference-materials'
  assert.deepEqual(calls, [['get', url, { params: { review_id: 4, plan_hash: input.plan_hash, unit_hash: input.unit_hash }, silentError: true }],
    ['post', url, { review_id: 4, plan_hash: input.plan_hash, unit_hash: input.unit_hash, expected_materials_hash: input.expected_materials_hash }, { silentError: true }]])
})

test('selected unit has no implicit probe; explicit check then prepare then GET verification', async t => {
  const h = runtime(t); await tick(); assert.equal(h.calls.length, 0)
  assert.equal(h.state.canPrepare.value, false)
  await h.state.checkMaterials(); assert.deepEqual(h.calls.map(call => call[0]), ['get'])
  assert.equal(h.state.materials.value.status, 'needs_preparation'); assert.equal(h.state.canPrepare.value, true)
  await h.state.prepareMaterials(); assert.deepEqual(h.calls.map(call => call[0]), ['get', 'post', 'get'])
  assert.equal(h.calls[1][4].expected_materials_hash, digest('f'))
  assert.equal(h.state.materials.value.status, 'prepared'); assert.equal(h.state.canPrepare.value, false)
  await h.state.checkMaterials(); assert.deepEqual(h.calls.map(call => call[0]), ['get', 'post', 'get', 'get'])
  assert.match(h.source, /检查素材/); assert.match(h.source, /本地准备/); assert.match(h.source, /不生成、不扣费/)
  assert.match(h.source, /source_start_ms/); assert.match(h.source, /ordinal/)
})

test('double click has only one POST and late POST cannot revive A after A -> B -> A', async t => {
  const wait = deferred(); let posts = 0
  const h = runtime(t, { prepareUnitReferenceMaterials: () => { posts++; return wait.promise } })
  await h.state.checkMaterials(); const original = structuredClone(vue.toRaw(h.props)); const response = inspection(original, 'unit-1', true).prepared_materials
  const pending = h.state.prepareMaterials(); h.state.prepareMaterials(); assert.equal(posts, 1)
  h.state.selectedUnitId.value = 'unit-2'; h.state.selectedUnitId.value = 'unit-1'
  assert.equal(h.state.materials.value, null); assert.equal(h.state.canPrepare.value, false)
  wait.resolve(response); await pending
  assert.equal(h.state.materials.value, null); assert.equal(h.calls.filter(call => call[0] === 'get').length, 1)
  assert.equal(h.state.canPrepare.value, false)
})

test('unknown POST remains unconfirmed with no retry; read-only refresh reconciles it', async t => {
  let posts = 0, prepared = false
  const h = runtime(t, { prepareUnitReferenceMaterials: async () => { posts++; prepared = true; throw new Error('network lost') },
    getUnitReferenceMaterials: async (_v, _q, u) => inspection(h.props, u, prepared) })
  await h.state.checkMaterials(); await h.state.prepareMaterials()
  assert.match(h.state.error.value, /未确认/); assert.equal(h.state.materials.value, null)
  await h.state.prepareMaterials(); assert.equal(posts, 1)
  await h.state.checkMaterials(); assert.equal(h.state.materials.value.status, 'prepared'); assert.equal(posts, 1)
})

test('slow GET, dirty/block, version/review/queue updates and unmount never refill stale state', async t => {
  for (const mutate of [h => { h.state.selectedUnitId.value = 'unit-2'; h.state.selectedUnitId.value = 'unit-1' },
    h => { h.props.blocked = true; h.props.blocked = false }, h => { h.props.record.version_id = 11; h.props.record.version_id = 10 },
    h => { h.props.savedReview.id++ }, h => { h.props.queue.id++ }, h => h.dispose()]) {
    const wait = deferred(), entered = deferred(), h = runtime(t, { getUnitReferenceMaterials: () => { entered.resolve(); return wait.promise } })
    const response = inspection(h.props); const pending = h.state.checkMaterials(); await entered.promise
    mutate(h); wait.resolve(response); await pending
    assert.equal(h.state.materials.value, null); assert.equal(h.state.canPrepare.value, false)
  }
})

test('invalid current context never invokes an API', async t => {
  for (const mutate of [p => { p.blocked = true }, p => { p.queue.status = 'stale' }, p => { p.savedReview.status = 'stale' },
    p => { p.queue.plan_hash = digest('0') }, p => { p.queue.work_id = 999 }, p => { p.record.updated_at = 'dirty' },
    p => { p.queue.units[0].unit_hash = 'wrong' }, p => { p.queue.units[0].ordinal = 1 }, p => { p.preview.executable = true }]) {
    const h = runtime(t); mutate(h.props); await h.state.checkMaterials(); await h.state.prepareMaterials(); assert.equal(h.calls.length, 0)
  }
})

test('review plan content must still equal the current preview, not merely reuse its hash', async t => {
  const h = runtime(t); h.props.savedReview.plan.units[0].source_end_ms++
  await h.state.checkMaterials(); assert.equal(h.calls.length, 0)
})

test('response outer bindings and nested prepared hash/materials/bindings are independently checked', async t => {
  for (const mutate of [d => { d.bindings.unit_id = 'unit-2' }, d => { d.bindings.review_id++ }, d => { d.materials_hash = 'bad' },
    d => { d.prepared_materials.bindings.queue_id++ }, d => { d.prepared_materials.materials_hash = digest('0') },
    d => { d.prepared_materials.prepared_materials_hash = digest('0') }, d => { d.prepared_materials.references[0].asset_id++ }]) {
    const h = runtime(t, { getUnitReferenceMaterials: async () => { const data = inspection(h.props, 'unit-1', true); mutate(data); return data } })
    await h.state.checkMaterials(); assert.equal(h.state.materials.value, null); assert.equal(h.state.canPrepare.value, false); assert.match(h.state.error.value, /失效|校验/)
  }
})

test('POST DTO with an old materials hash never becomes success or triggers implicit POST retry', async t => {
  let posts = 0
  const h = runtime(t, { prepareUnitReferenceMaterials: async () => { posts++; return inspection(h.props, 'unit-1', true, digest('0')).prepared_materials } })
  await h.state.checkMaterials(); await h.state.prepareMaterials(); await h.state.prepareMaterials()
  assert.equal(h.state.materials.value, null); assert.equal(posts, 1); assert.match(h.state.error.value, /未确认/)
})

test('ordinary execution-plan parent mounts the narrow materials child with its own busy/blocked gate', () => {
  const source = readFileSync(new URL('../src/components/redraw/RedrawExecutionPlanReviewPanel.vue', import.meta.url), 'utf8')
  assert.match(source, /<RedrawUnitReferenceMaterialsPanel/)
  for (const binding of [':record="record"', ':preview="preview"', ':saved-review="savedReview"', ':queue="queue"', ':blocked="materialsBlocked"']) assert.ok(source.includes(binding))
})

test('real parent refresh preserves the materials instance and its pending POST until explicit reconciliation', async t => {
  const props = document()
  Object.assign(props.preview, { capability: { model: 'fixture', audio_mode: 'native', resolutions: ['480p'], aspect_ratios: ['9:16'] },
    blocking_reasons: [], execution_blockers: ['PREVIEW_ONLY'] })
  for (const unit of props.preview.units) Object.assign(unit, { retained_duration_ms: 5000, generated_duration_ms: 5000, padding_ms: 0, dialogues: [] })
  props.savedReview.plan = structuredClone(props.preview)
  props.queue.execution_blockers = ['PREVIEW_ONLY']
  for (const unit of props.queue.units) unit.unit_hash = hash(unit.plan_unit)
  const pending = [], operations = [], calls = []
  let prepared = false
  const api = {
    getExecutionPlanReview: async () => ({ preview: structuredClone(props.preview), saved_review: structuredClone(props.savedReview) }),
    getExecutionQueue: async () => ({ preview: structuredClone(props.preview), saved_review: structuredClone(props.savedReview), queue: structuredClone(props.queue) }),
    getUnitReferenceMaterials: async (_v, _q, unit) => { calls.push('get'); return inspection(props, unit, prepared) },
    prepareUnitReferenceMaterials: (_v, _q, unit) => {
      calls.push('post'); const wait = deferred(); pending.push({ wait, unit }); return wait.promise
    },
  }
  function compile(name, child) {
    const filename = new URL(`../src/components/redraw/${name}.vue`, import.meta.url).pathname
    const { descriptor } = parse(readFileSync(new URL(`../src/components/redraw/${name}.vue`, import.meta.url), 'utf8'))
    const script = compileScript(descriptor, { id: name })
    const bindings = { computed: vue.computed, onUnmounted: vue.onUnmounted, ref: vue.ref, watch: vue.watch,
      redrawAPI: api, RedrawUnitReferenceMaterialsPanel: child, RedrawExecutionRunPanel: { render: () => null }, crypto: webcrypto }
    const body = script.content.replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
    const component = new Function(...Object.keys(bindings), body)(...Object.values(bindings))
    const template = compileTemplate({ id: name, filename, source: descriptor.template.content, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    const render = template.code.replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"]vue['"]/g,
      (_all, names) => `const {${names.replace(/\s+as\s+/g, ':')}} = vue;`).replace('export function render', 'return function render')
    component.render = new Function('vue', render)(vue)
    return component
  }
  const child = compile('RedrawUnitReferenceMaterialsPanel')
  const parent = compile('RedrawExecutionPlanReviewPanel', child)
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, tagName: tag.toUpperCase(), children: [], parent: null, addEventListener() {}, removeEventListener() {},
      get options() { return this.children.filter(node => node.tag === 'option') } }),
    createText: text => ({ text, parent: null }), createComment: comment => ({ comment, parent: null }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _old, value) => { node[key] = value }, parentNode: node => node.parent,
    nextSibling: node => { const siblings = node.parent?.children || []; return siblings[siblings.indexOf(node) + 1] || null },
    insert: (node, target, anchor = null) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = target; const index = target.children.indexOf(anchor)
      if (index < 0) target.children.push(node); else target.children.splice(index, 0, node)
    },
    remove: node => { if (node.parent) { node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null } },
  })
  function find(vnode) {
    if (!vnode) return null
    if (vnode.type === child) return vnode.component
    const nested = vnode.component && find(vnode.component.subTree)
    if (nested) return nested
    for (const node of Array.isArray(vnode.children) ? vnode.children : []) { const match = find(node); if (match) return match }
    return null
  }
  const flush = async () => { for (let i = 0; i < 8; i++) await tick() }
  const app = renderer.createApp(parent, { record: props.record, blocked: false })
  app.component('el-button', { setup: (_props, { slots }) => () => vue.h('button', null, slots.default?.()) })
  app.config.warnHandler = message => { if (!message.startsWith('Runtime directive')) throw Error(message) }
  t.after(async () => { app.unmount(); pending.forEach(({ wait }) => wait.resolve(null)); await Promise.all(operations); await flush() })
  app.mount({ children: [] }); await flush()
  const first = find(app._instance.subTree)
  assert.ok(first)
  await first.setupState.checkMaterials()
  assert.equal(first.setupState.canPrepare, true)
  operations.push(first.setupState.prepareMaterials())
  assert.deepEqual(calls, ['get', 'post'])
  await app._instance.setupState.load(); await flush()
  const current = find(app._instance.subTree)
  assert.ok(current)
  await current.setupState.checkMaterials()
  operations.push(current.setupState.prepareMaterials())
  assert.equal(calls.filter(value => value === 'post').length, 1, 'parent refresh must not permit a second POST while the original is pending')
  assert.equal(current, first)
  assert.equal(first.isUnmounted, false)
  assert.deepEqual(calls, ['get', 'post'])
  assert.equal(current.setupState.canCheck, false)
  assert.equal(current.setupState.canPrepare, false)
  prepared = true
  pending[0].wait.resolve(inspection(props, pending[0].unit, true).prepared_materials)
  await Promise.all(operations); await flush()
  assert.equal(current.setupState.materials, null, 'late POST cannot refill success after parent context reset')
  assert.equal(current.setupState.canCheck, true)
  assert.equal(current.setupState.canPrepare, false)
  assert.deepEqual(calls, ['get', 'post'], 'late POST must not trigger automatic verification in the reset context')
  await current.setupState.checkMaterials()
  assert.equal(current.setupState.materials.status, 'prepared')
  assert.deepEqual(calls, ['get', 'post', 'get'])
})
