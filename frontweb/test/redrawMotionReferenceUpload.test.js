import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as shotState from '../src/utils/redrawShotState.js'
import { projectRedrawCharacterIdentityPack } from '../src/utils/redrawCharacterIdentity.js'
import { readSession, saveSession, clearSession, readCurrentTenantId, saveCurrentTenantId } from '../src/utils/authSession.js'
const processingPath = new URL('../src/utils/redrawMotionProcessing.js', import.meta.url)
const processingParser = existsSync(processingPath) ? await import(processingPath) : {}
const originalProcessingReport = JSON.parse(readFileSync(new URL('./fixtures/redraw-motion-processing-report-v1.json', import.meta.url), 'utf8'))

const read = name => readFileSync(new URL(`../src/components/redraw/${name}.vue`, import.meta.url), 'utf8')
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }
const settle = async () => { for (let index = 0; index < 12; index += 1) await tick() }
const sha = 'a'.repeat(64), newSha = 'b'.repeat(64)
const confirmations = { full_frame_reviewed: true, source_identity_obscured: true, source_text_obscured: true, motion_preserved: true }
const file = () => new File(['mp4'], 'processed.mp4', { type: 'video/mp4' })
const shot = id => ({ id, version_id: 812, updated_at: 'shot-CAS', start_ms: 0, end_ms: 5000, status: 'draft', model: 'snapshot', localized_dialogue: [] })
const work = () => ({ id: 710, version_id: 812, source_fingerprint: sha, reference_bundle_required: true, shots: [shot(1301), shot(1302)] })
const asset = () => ({ id: 2301, type: 'video', mime_type: 'video/mp4', sha256: newSha, duration_ms: 5000, width: 320, height: 240, file_size: 3 })
const candidate = (id = 1301) => ({ shot_id: id, version_id: 812, shot_updated_at: 'shot-CAS', source_sha256: sha, status: 'available', candidate: { import_id: 61, asset: asset() } })
const uploaded = () => ({ purpose: 'motion', asset: asset(), billing: { credits: 0, held: 0, charged: 0 } })
const bundle = (id = 1301, motion = asset()) => ({ shot_id: id, version_id: 812, shot_updated_at: 'shot-CAS', source_sha256: sha,
  reference_bundle_hash: sha, reference_bundle_updated_at: 'bundle-CAS', bundle: {
  schema_version: 'redraw-reference-bundle-v2', motion_reference: { asset_id: motion.id, sha256: motion.sha256, audio_stream_count: 0 },
  face_tracks: [], text_regions: [], coverage_review: { recognizable_face_count: 0, mapped_face_count: 0, unresolved_face_count: 0,
    recognizable_text_region_count: 0, mapped_text_region_count: 0, unresolved_text_region_count: 0 },
  locale: 'en-US', market: 'US', dialogue: { target_locale: 'en-US', target_market: 'US', turns: [] },
} })
function storage() {
  const values = new Map()
  return { get length() { return values.size }, key: index => [...values.keys()][index], getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }
}
function compile(name, bindings, withTemplate = false) {
  const descriptor = parse(read(name)).descriptor
  const compiled = compileScript(descriptor, { id: 'motion-test' })
  const script = compiled.content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
  const entries = Object.entries(bindings).filter(([key]) => /^[A-Za-z_$][\w$]*$/.test(key) && key !== 'default')
  const component = new Function(...entries.map(([key]) => key), script)(...entries.map(([, value]) => value))
  if (withTemplate) {
    const template = compileTemplate({ source: descriptor.template.content, filename: `${name}.vue`, id: 'motion-test',
      compilerOptions: { bindingMetadata: compiled.bindings } }).code
      .replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
      .replace('export function render', 'return function render')
    component.render = new Function('Vue', template)(vue)
  }
  return component
}
function runtime(t, name, props, extra = {}) {
  const scope = vue.effectScope(), hooks = [], mounted = [], emitted = [], revoked = [], messages = []
  let serial = 0
  const bindings = { ...vue, ...shotState, ...processingParser, Refresh: {}, RedrawBatchPanel: {}, RedrawShotEditor: {}, RedrawShotPreview: {},
    RedrawShotPreparationPanel: {}, RedrawGenerationQueuePanel: {}, RedrawQualityReviewPanel: {},
    readSession: () => ({ user: { id: 'ordinary-user' } }), readCurrentTenantId: () => null,
    onMounted(fn) { mounted.push(fn) }, onBeforeUnmount(fn) { hooks.push(fn) },
    URL: { createObjectURL: () => `blob:motion-${++serial}`, revokeObjectURL: url => revoked.push(url) },
    ElMessage: Object.fromEntries(['error', 'warning', 'success'].map(kind => [kind, message => messages.push([kind, message])])), ...extra }
  const component = compile(name, bindings), reactiveProps = vue.reactive(props)
  const state = scope.run(() => component.setup(reactiveProps, { expose() {}, emit: (...args) => {
    emitted.push(args); extra.onEmit?.(...args)
  } }))
  let closed = false
  const dispose = () => { if (!closed) { closed = true; hooks.forEach(fn => fn()); scope.stop() } }
  t.after(dispose)
  return { state, props: reactiveProps, emitted, revoked, messages, dispose,
    mount: async () => { for (const fn of mounted) await fn() } }
}
function panel(t) { return runtime(t, 'RedrawReferenceBundlePanel', { state: { evidence: {} }, motionScope: 'scope-A', motionState: {}, saving: false }) }
async function selectPanel(ctx, selected = file()) {
  assert.equal(typeof ctx.state.selectMotionFile, 'function', '普通素材选择尚未实现')
  await ctx.state.selectMotionFile({ target: { files: selected ? [selected] : [], value: '' } })
}
async function parent(t, api = {}, store = storage(), extra = {}) {
  const calls = [], defaults = { getWork: () => work(), getMotionReference: id => candidate(id), getReferenceBundle: id => bundle(id),
    getGenerationGate: () => ({ ok: true, missing: [] }), getMotionReferenceMedia: () => new Blob(['mp4'], { type: 'video/mp4' }),
    getMotionDraft: () => new Blob(['draft'], { type: 'video/mp4' }), uploadMotionReference: () => uploaded(), listAssets: () => [],
    getGenerationSummary: () => null, getPreparationGate: () => ({}), quoteReferencePreparation: () => null,
    generateShot: () => ({}), generateBatch: () => ({}), updateShot: () => shot(1301) }
  const redrawAPI = Object.fromEntries(Object.entries({ ...defaults, ...api }).map(([name, fn]) => [name, (...args) => {
    calls.push([name, ...args]); return Promise.resolve().then(() => fn(...args))
  }]))
  const ctx = runtime(t, 'RedrawShotStep', { work: work(), versionId: 812, executionMode: 'safe' }, { redrawAPI, sessionStorage: store, ...extra })
  await settle(); calls.length = 0
  return { ...ctx, calls, store }
}
function selectParent(ctx) {
  assert.equal(typeof ctx.state.handleMotionSelection, 'function', '父级必须拥有待选替换锁')
  const selected = file()
  ctx.state.handleMotionSelection({ scope: ctx.state.motionScope.value, file: selected, readable: true })
  return selected
}
function submit(ctx, selected) { return ctx.state.uploadMotionReference({ scope: ctx.state.motionScope.value, file: selected, confirmations }) }

function processingEnvelope() {
  const report = { ...structuredClone(originalProcessingReport),
    owner: { tenant_id: 'default', user_id: 'ordinary-user' }, work_id: 710, version_id: 812, shot_id: 1301,
    source_fingerprint: sha, shot: { ...originalProcessingReport.shot, expected_updated_at: 'shot-CAS' },
    output: { mime: 'video/mp4', size: 3, sha256: newSha } }
  const json = new TextEncoder().encode(JSON.stringify(report)), header = new Uint8Array(12)
  header.set(new TextEncoder().encode('RDMO0001')); new DataView(header.buffer).setUint32(8, json.length)
  return new Blob([header, json, 'mp4'], { type: 'application/vnd.moli.redraw-motion-processing.v1' })
}
function processMotion(ctx) {
  assert.equal(typeof ctx.state.processMotionReference, 'function', '页面尚无显式动作处理 handler')
  return ctx.state.processMotionReference()
}
function liveMotionAuth() {
  const store = storage(), events = new EventTarget()
  const listeners = new Map(), add = events.addEventListener.bind(events), remove = events.removeEventListener.bind(events)
  events.addEventListener = (name, handler) => { listeners.set(name, handler); add(name, handler) }
  events.removeEventListener = (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); remove(name, handler) }
  saveSession({ token: 'synthetic-local-test-token', user: { id: 'ordinary-user' } }, store)
  saveCurrentTenantId('default', store)
  return { store, events, listeners, bindings: { readSession: () => readSession(store), readCurrentTenantId: () => readCurrentTenantId(store), window: events } }
}
function switchMotionAuth(auth, kind) {
  if (kind === 'logout') clearSession(auth.store)
  else if (kind === 'tenant') saveCurrentTenantId('next-tenant', auth.store)
  else saveSession({ token: 'synthetic-new-test-token', user: { id: kind === 'token' ? 'ordinary-user' : 'next-user' } }, auth.store)
}
function authStorageEvent(auth, key = 'moli_mama_session', newValue) {
  auth.events.dispatchEvent(Object.assign(new Event('storage'), { key, newValue }))
}
for (const kind of ['user', 'tenant', 'logout']) test(`storage事件排队时auth ${kind} 已A→B→A仍撤销旧请求`, async t => {
  const auth = liveMotionAuth(), pending = defer(), ctx = await parent(t, { getMotionProcessing: () => pending.promise }, storage(), auth.bindings)
  await ctx.mount(); await settle()
  const running = processMotion(ctx); await settle()
  const signal = ctx.calls.find(([name]) => name === 'getMotionProcessing')[3].signal
  switchMotionAuth(auth, kind)
  const key = kind === 'tenant' ? 'moli_mama_tenant_id' : 'moli_mama_session', changedValue = auth.store.getItem(key)
  saveSession({ token: 'synthetic-return-token', user: { id: 'ordinary-user' } }, auth.store)
  saveCurrentTenantId('default', auth.store)
  authStorageEvent(auth, key, changedValue)
  assert.equal(signal.aborted, true)
  authStorageEvent(auth, key, auth.store.getItem(key))
  pending.resolve(processingEnvelope()); await running
  assert.equal(ctx.state.motionState.value.processingResult, null)
})
for (const kind of ['user', 'tenant', 'logout']) for (const boundary of ['HTTP', 'parser', 'error-parser']) {
  test(`真实auth helper ${kind} 在${boundary}等待后丢弃旧身份结果`, async t => {
    const auth = liveMotionAuth(), pending = defer()
    const ctx = await parent(t, { getMotionProcessing: () => boundary === 'HTTP' ? pending.promise
      : boundary === 'parser' ? processingEnvelope() : Promise.reject(new Error('private-old-owner-error')) }, storage(), {
      ...auth.bindings,
      ...(boundary === 'parser' ? { parseMotionProcessingEnvelope: () => pending.promise } : {}),
      ...(boundary === 'error-parser' ? { motionProcessingErrorMessage: () => pending.promise } : {}),
    })
    const running = processMotion(ctx); await settle()
    const signal = ctx.calls.find(([name]) => name === 'getMotionProcessing')[3].signal
    switchMotionAuth(auth, kind)
    pending.resolve(boundary === 'HTTP' ? processingEnvelope() : boundary === 'parser'
      ? { file: file(), processingReport: 'private-old-owner-report' } : 'private-old-owner-error')
    await running; await settle()
    assert.equal(ctx.state.motionState.value.processingResult, null)
    assert.equal(ctx.state.motionState.value.processingLoading, false)
    assert.equal(signal.aborted, true)
    assert.doesNotMatch(ctx.state.motionState.value.error, /private-old-owner/)
    assert.equal(ctx.calls.filter(([name]) => name === 'uploadMotionReference').length, 0)
  })
}
for (const kind of ['user', 'tenant', 'logout']) for (const boundary of ['selection', 'upload']) {
  test(`真实auth helper ${kind} 在返回后的${boundary}前禁止旧File报告上传`, async t => {
    const auth = liveMotionAuth(), ctx = await parent(t, { getMotionProcessing: processingEnvelope }, storage(), auth.bindings)
    await processMotion(ctx)
    const result = ctx.state.motionState.value.processingResult
    const input = { scope: ctx.state.motionScope.value, file: result.file, readable: true, processing_report: result.processingReport, confirmations }
    if (boundary === 'upload') ctx.state.handleMotionSelection(input)
    switchMotionAuth(auth, kind)
    if (boundary === 'selection') ctx.state.handleMotionSelection(input)
    await ctx.state.uploadMotionReference(input); await settle()
    assert.equal(ctx.state.motionState.value.processingResult, null)
    assert.equal(ctx.state.motionSelection.value, null)
    assert.equal(ctx.calls.filter(([name]) => name === 'uploadMotionReference').length, 0)
    ctx.calls.length = 0
    await processMotion(ctx); await ctx.state.refreshMotionReference(); await ctx.state.loadMotionDraft(); await settle()
    assert.equal(ctx.calls.length, 0, '新auth不得继续自动或手工读取旧work动作素材')
  })
}
for (const kind of ['user', 'tenant', 'logout']) test(`真实storage事件 ${kind} 清理Panel File/URL/报告/四确认`, async t => {
  const auth = liveMotionAuth(), ctx = await parent(t, { getMotionProcessing: processingEnvelope }, storage(), auth.bindings)
  await ctx.mount(); await settle()
  const child = runtime(t, 'RedrawReferenceBundlePanel', { state: { evidence: {} }, motionScope: ctx.state.motionScope.value,
    motionState: ctx.state.motionState.value, saving: false }, { onEmit: (name, input) => {
    if (name === 'motion-selection') ctx.state.handleMotionSelection(input)
  } })
  t.after(vue.watch(ctx.state.motionState, value => { child.props.motionState = value }))
  await processMotion(ctx); await settle()
  const oldUrl = child.state.motionLocalUrl.value
  assert.ok(oldUrl); child.state.motionPreviewLoaded(); Object.assign(child.state.motionConfirmations, confirmations)
  ctx.calls.length = 0; switchMotionAuth(auth, kind)
  authStorageEvent(auth, kind === 'tenant' ? 'moli_mama_tenant_id' : kind === 'logout' ? null : 'moli_mama_session')
  await settle()
  assert.equal(child.state.motionFile.value, null); assert.equal(child.state.motionProcessingReport.value, null)
  assert.equal(child.state.motionLocalUrl.value, ''); assert.ok(child.revoked.includes(oldUrl))
  assert.ok(Object.values(child.state.motionConfirmations).every(value => value === false))
  assert.equal(ctx.calls.length, 0)
})
test('storage事件在尚无File时立即abort；focus补查且卸载移除监听', async t => {
  const auth = liveMotionAuth(), pending = defer(), ctx = await parent(t, { getMotionProcessing: () => pending.promise }, storage(), auth.bindings)
  await ctx.mount(); await settle()
  assert.deepEqual([...auth.listeners.keys()].sort(), ['focus', 'storage'])
  const running = processMotion(ctx); await settle()
  const signal = ctx.calls.find(([name]) => name === 'getMotionProcessing')[3].signal
  switchMotionAuth(auth, 'tenant'); auth.events.dispatchEvent(new Event('focus'))
  assert.equal(signal.aborted, true)
  pending.resolve(processingEnvelope()); await running
  const before = ctx.state.motionState.value.resetSelection
  ctx.dispose(); switchMotionAuth(auth, 'user'); authStorageEvent(auth); auth.events.dispatchEvent(new Event('focus'))
  assert.equal(auth.listeners.size, 0)
  assert.equal(ctx.state.motionState.value.resetSelection, before)
})
test('已提交上传的成功响应遇live owner变化不采纳为awaiting-refresh且保留marker', async t => {
  const auth = liveMotionAuth(), pending = defer(), ctx = await parent(t, { uploadMotionReference: () => pending.promise }, storage(), auth.bindings)
  const selected = selectParent(ctx), scope = ctx.state.motionOperationScope.value
  const running = submit(ctx, selected); await settle()
  const marker = ctx.store.getItem(scope)
  switchMotionAuth(auth, 'user'); pending.resolve(uploaded()); await running
  assert.equal(ctx.state.motionOperations.value[scope].phase, 'unknown')
  assert.equal(ctx.store.getItem(scope), marker)
  assert.equal(ctx.state.motionSelection.value, null)
  assert.equal(ctx.calls.filter(([name]) => name === 'getWork').length, 0)
})
test('auth A→B→A的storage事件撤销旧读取，同work新CAS不能重绑新owner', async t => {
  const auth = liveMotionAuth(), pending = defer(), ctx = await parent(t, { getMotionProcessing: () => pending.promise }, storage(), auth.bindings)
  await ctx.mount(); await settle()
  const running = processMotion(ctx); await settle()
  switchMotionAuth(auth, 'user'); authStorageEvent(auth)
  saveSession({ token: 'synthetic-return-token', user: { id: 'ordinary-user' } }, auth.store)
  saveCurrentTenantId('default', auth.store); authStorageEvent(auth)
  pending.resolve(processingEnvelope()); await running
  assert.equal(ctx.state.motionState.value.processingResult, null)
  switchMotionAuth(auth, 'user')
  ctx.props.work = { ...work(), shots: [ { ...shot(1301), updated_at: 'new-CAS' }, shot(1302) ] }
  await settle(); ctx.calls.length = 0
  await processMotion(ctx); await ctx.state.startReferencePreparation({ shot_ids: [1301] }); await settle()
  assert.equal(ctx.calls.length, 0)
})
test('切到真正新work时使用新auth入口快照，旧work身份不被重写', async t => {
  const auth = liveMotionAuth(), pending = defer(), ctx = await parent(t, { getMotionProcessing: () => pending.promise }, storage(), auth.bindings)
  switchMotionAuth(auth, 'user'); saveCurrentTenantId('next-tenant', auth.store)
  ctx.props.work = { ...work(), id: 711, user_id: 'next-user', tenant_id: 'next-tenant' }
  await settle(); ctx.calls.length = 0
  const running = processMotion(ctx); await settle()
  assert.equal(ctx.calls.filter(([name]) => name === 'getMotionProcessing').length, 1)
  assert.match(ctx.state.motionStoragePrefix.value, /next-user:next-tenant:711:/)
  ctx.state.cancelMotionProcessing(); pending.resolve(processingEnvelope()); await running
})
test('auth变化保留已提交unknown marker原字节与单次POST', async t => {
  const auth = liveMotionAuth(), pending = defer(), ctx = await parent(t, { uploadMotionReference: () => pending.promise }, storage(), auth.bindings)
  await ctx.mount(); await settle()
  const selected = selectParent(ctx), operationScope = ctx.state.motionOperationScope.value
  const running = submit(ctx, selected); await settle()
  const marker = ctx.store.getItem(operationScope); assert.ok(marker)
  switchMotionAuth(auth, 'user'); authStorageEvent(auth); await settle()
  assert.equal(ctx.state.motionSelection.value, null)
  assert.equal(ctx.store.getItem(operationScope), marker)
  pending.reject(new Error('unknown')); await running
  assert.equal(ctx.store.getItem(operationScope), marker)
  saveSession({ token: 'synthetic-return-token', user: { id: 'ordinary-user' } }, auth.store)
  saveCurrentTenantId('default', auth.store); authStorageEvent(auth); await settle()
  await submit(ctx, selected)
  assert.equal(ctx.store.getItem(operationScope), marker)
  assert.equal(ctx.state.hasPendingMotionOperation.value, true)
  assert.equal(ctx.calls.filter(([name]) => name === 'uploadMotionReference').length, 1)
})
test('同owner的token刷新及无关storage事件不撤销处理中或已返回File', async t => {
  const auth = liveMotionAuth(), pending = defer(), ctx = await parent(t, { getMotionProcessing: () => pending.promise }, storage(), auth.bindings)
  await ctx.mount(); await settle()
  const running = processMotion(ctx); await settle()
  const signal = ctx.calls.find(([name]) => name === 'getMotionProcessing')[3].signal
  switchMotionAuth(auth, 'token'); authStorageEvent(auth, 'moli_mama_session', auth.store.getItem('moli_mama_session')); authStorageEvent(auth, 'unrelated')
  assert.equal(signal.aborted, false)
  pending.resolve(processingEnvelope()); await running
  const result = ctx.state.motionState.value.processingResult; assert.ok(result)
  const input = { scope: ctx.state.motionScope.value, file: result.file, readable: true, processing_report: result.processingReport, confirmations }
  ctx.state.handleMotionSelection(input)
  switchMotionAuth(auth, 'token'); authStorageEvent(auth, 'moli_mama_session', auth.store.getItem('moli_mama_session')); auth.events.dispatchEvent(new Event('focus'))
  assert.equal(ctx.state.motionState.value.processingResult.file, result.file)
  await ctx.state.uploadMotionReference(input)
  assert.equal(ctx.calls.filter(([name]) => name === 'uploadMotionReference').length, 1)
})
for (const field of ['user_id', 'tenant_id']) test(`显式work ${field} 不匹配当前auth时禁止处理`, async t => {
  const auth = liveMotionAuth(), ctx = await parent(t, { getMotionProcessing: processingEnvelope }, storage(), auth.bindings)
  ctx.props.work = { ...work(), user_id: 'ordinary-user', tenant_id: 'default', [field]: 'another' }
  await settle(); ctx.calls.length = 0
  await processMotion(ctx)
  assert.equal(ctx.calls.filter(([name]) => name === 'getMotionProcessing').length, 0)
})
for (const phase of ['idle', 'processing', 'processed']) test(`父子真实事件桥接 ${phase}：手工选择不得清掉新 File/URL 或携带旧报告`, async t => {
  const pending = defer(), ctx = await parent(t, { getMotionProcessing: () => phase === 'processing' ? pending.promise : processingEnvelope() })
  const child = runtime(t, 'RedrawReferenceBundlePanel', { state: { evidence: {} }, motionScope: ctx.state.motionScope.value,
    motionState: ctx.state.motionState.value, saving: false }, { onEmit: (name, input) => {
    if (name === 'motion-cancel') ctx.state.cancelMotionProcessing()
    if (name === 'motion-selection') ctx.state.handleMotionSelection(input)
  } })
  t.after(vue.watch(ctx.state.motionState, value => { child.props.motionState = value }))
  const processing = phase === 'idle' ? null : processMotion(ctx)
  if (phase === 'processed') await processing
  await settle()
  if (phase === 'processed') { assert.ok(child.state.motionProcessingReport.value); Object.assign(child.state.motionConfirmations, confirmations) }
  const selected = file()
  await selectPanel(child, selected); await settle()
  assert.equal(child.state.motionFile.value, selected)
  assert.ok(child.state.motionLocalUrl.value)
  assert.equal(ctx.state.motionSelection.value.file, selected)
  assert.equal(child.state.motionProcessingReport.value, null)
  assert.ok(Object.values(child.state.motionConfirmations).every(value => value === false))
  if (phase === 'processing') { pending.resolve(processingEnvelope()); await processing; await settle() }
  assert.equal(child.state.motionFile.value, selected)
  child.state.motionPreviewLoaded(); Object.assign(child.state.motionConfirmations, confirmations); child.state.submitMotion()
  const input = child.emitted.filter(([name]) => name === 'motion-upload').at(-1)[1]
  assert.equal('processing_report' in input, false)
  await ctx.state.uploadMotionReference(input)
  assert.equal('processing_report' in ctx.calls.find(([name]) => name === 'uploadMotionReference')[3], false)
})
test('显式处理单次读取，待审 File 不自动上传/prepare/生成且处理无 File 期间冻结', async t => {
  const pending = defer(), ctx = await parent(t, { getMotionProcessing: () => pending.promise })
  const processing = processMotion(ctx); await tick(); await processMotion(ctx)
  assert.equal(ctx.state.motionState.value.processingLoading, true)
  assert.equal(ctx.state.motionGenerationBlocked.value, true); assert.equal(ctx.state.motionPreparationBlocked.value, true)
  await ctx.state.generateBatch([1301]); await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  pending.resolve(processingEnvelope()); await processing
  assert.ok(ctx.state.motionState.value.processingResult.file instanceof File)
  assert.equal(ctx.calls.filter(([name]) => name === 'getMotionProcessing').length, 1)
  assert.equal(ctx.calls.some(([name]) => ['uploadMotionReference', 'startReferencePreparation', 'generateBatch'].includes(name)), false)
  assert.equal(ctx.store.length, 0)
})
for (const change of ['cancel-empty', 'manual-file', 'shot-A-B-A', 'source-A-B-A', 'CAS-A-B-A', 'owner', 'unmount']) {
  test(`处理 HTTP 等待中 ${change} 必须撤销且迟到结果不得恢复`, async t => {
    const pending = defer(), ctx = await parent(t, { getMotionProcessing: () => pending.promise })
    const processing = processMotion(ctx); await tick()
    const signal = ctx.calls.find(([name]) => name === 'getMotionProcessing')[3].signal
    let manual
    if (change === 'cancel-empty') { assert.equal(typeof ctx.state.cancelMotionProcessing, 'function'); ctx.state.cancelMotionProcessing() }
    if (change === 'manual-file') manual = selectParent(ctx)
    if (change === 'shot-A-B-A') { ctx.state.selectedShotId.value = 1302; ctx.state.selectedShotId.value = 1301 }
    if (change === 'source-A-B-A') { ctx.props.work = { ...work(), source_fingerprint: newSha }; ctx.props.work = work() }
    if (change === 'CAS-A-B-A') { ctx.state.localWork.value.shots[0].updated_at = 'other'; ctx.state.localWork.value.shots[0].updated_at = 'shot-CAS' }
    if (change === 'owner') ctx.props.work = { ...work(), user_id: 'different-owner' }
    if (change === 'unmount') ctx.dispose()
    pending.resolve(processingEnvelope()); await processing; await settle()
    assert.equal(signal.aborted, true); assert.equal(ctx.state.motionState.value.processingResult, null)
    assert.equal(ctx.state.motionState.value.processingLoading, false)
    if (manual) assert.equal(ctx.state.motionSelection.value.file, manual)
    assert.equal(ctx.calls.some(([name]) => name === 'uploadMotionReference'), false)
  })
}
test('parser 等待中取消，旧解析结果不能越过 epoch 恢复；无重试', async t => {
  const pending = defer(), ctx = await parent(t, { getMotionProcessing: processingEnvelope }, storage(), {
    parseMotionProcessingEnvelope: () => pending.promise,
  })
  const processing = processMotion(ctx); await settle(); ctx.state.cancelMotionProcessing()
  pending.resolve({ file: file(), processingReport: '{}' }); await processing
  assert.equal(ctx.state.motionState.value.processingResult, null)
  assert.equal(ctx.calls.filter(([name]) => name === 'getMotionProcessing').length, 1)
})
test('处理结果接入真实 Panel 状态，报告和 File/URL/四确认同寿命', async t => {
  const ctx = panel(t)
  const selected = file(), processingReport = '{"approval_status":"pending"}'
  ctx.props.motionState = { processingResult: { scope: 'scope-A', file: selected, processingReport } }; await settle()
  assert.equal(ctx.state.motionFile.value, selected); assert.equal(ctx.state.motionProcessingReport.value, processingReport)
  assert.equal(ctx.state.canUploadMotion.value, false)
  assert.ok(Object.values(ctx.state.motionConfirmations).every(value => value === false))
  ctx.state.motionPreviewLoaded(); Object.assign(ctx.state.motionConfirmations, confirmations); ctx.state.submitMotion()
  const submission = ctx.emitted.find(([name]) => name === 'motion-upload')[1]
  assert.equal(submission.processing_report, processingReport); assert.equal(submission.file, selected)
  await selectPanel(ctx)
  assert.equal(ctx.state.motionProcessingReport.value, null); assert.equal(ctx.state.canUploadMotion.value, false)
  ctx.state.cancelMotionSelection()
  assert.ok(ctx.emitted.some(([name]) => name === 'motion-cancel'))
  assert.equal(ctx.state.motionFile.value, null); assert.equal(ctx.state.motionProcessingReport.value, null)
})
test('处理报告必须绑定当前精确 File，四确认后显式上传才附带报告；手工不携带', async t => {
  const ctx = await parent(t, { getMotionProcessing: processingEnvelope })
  await processMotion(ctx)
  const result = ctx.state.motionState.value.processingResult
  ctx.state.handleMotionSelection({ scope: ctx.state.motionScope.value, file: result.file, readable: true, processing_report: result.processingReport })
  await ctx.state.uploadMotionReference({ scope: ctx.state.motionScope.value, file: result.file, confirmations, processing_report: 'tampered' })
  assert.equal(ctx.calls.some(([name]) => name === 'uploadMotionReference'), false)
  await ctx.state.uploadMotionReference({ scope: ctx.state.motionScope.value, file: result.file, confirmations, processing_report: result.processingReport })
  assert.equal(ctx.calls.find(([name]) => name === 'uploadMotionReference')[3].processing_report, result.processingReport)
  assert.equal(ctx.state.motionState.value.processingResult, null, '完整新包核对成功后释放旧待审 File 和报告')
  assert.equal(ctx.state.motionGenerationBlocked.value, false)
  const manual = await parent(t); await submit(manual, selectParent(manual))
  assert.equal('processing_report' in manual.calls.find(([name]) => name === 'uploadMotionReference')[3], false)
})
test('错误 Blob 解析等待中取消不会抛出未处理拒绝，也不会恢复旧错误', async t => {
  const pending = defer(), ctx = await parent(t, { getMotionProcessing: () => { throw new Error('http failed') } }, storage(), {
    motionProcessingErrorMessage: () => pending.promise,
  })
  const processing = processMotion(ctx); await settle(); ctx.state.cancelMotionProcessing()
  pending.reject(new DOMException('canceled', 'AbortError'))
  await assert.doesNotReject(processing)
  assert.equal(ctx.state.motionState.value.processingLoading, false)
  assert.equal(ctx.state.motionState.value.error, '')
})
test('处理期间只读刷新不能提前释放生成锁，重复处理和卸载均不恢复报告', async t => {
  const pending = defer(), ctx = await parent(t, { getMotionProcessing: () => pending.promise })
  const processing = processMotion(ctx); await tick(); await ctx.state.refreshMotionReference()
  assert.equal(ctx.state.motionState.value.processingLoading, true)
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
  pending.resolve(processingEnvelope()); await processing
  ctx.dispose(); assert.equal(ctx.state.motionState.value.processingResult, null)
})
test('视频只有真实 loadeddata 且有效解码尺寸才可上传，旧 URL 的加载事件不恢复确认', async t => {
  const ctx = panel(t); await selectPanel(ctx)
  const oldUrl = ctx.state.motionLocalUrl.value
  ctx.state.motionPreviewLoaded({ target: { getAttribute: () => oldUrl, readyState: 1, videoWidth: 320, videoHeight: 180 } })
  assert.equal(ctx.state.motionReadable.value, false)
  await selectPanel(ctx)
  ctx.state.motionPreviewLoaded({ target: { getAttribute: () => oldUrl, readyState: 2, videoWidth: 320, videoHeight: 180 } })
  assert.equal(ctx.state.motionReadable.value, false)
  ctx.state.motionPreviewLoaded({ target: { getAttribute: () => ctx.state.motionLocalUrl.value, readyState: 2, videoWidth: 320, videoHeight: 180 } })
  assert.equal(ctx.state.motionReadable.value, true)
})
test('业务 JSON Blob 和畸形成功 envelope 失败均友好提示且不重试/不上传', async t => {
  for (const failure of ['http', 'envelope']) {
    const ctx = await parent(t, { getMotionProcessing: () => {
      if (failure === 'http') throw { response: { data: new Blob(['{"message":"逐帧覆盖未审核"}'], { type: 'application/json' }) } }
      return new Blob(['bad'], { type: 'video/mp4' })
    } })
    await processMotion(ctx)
    assert.match(ctx.state.motionState.value.error, failure === 'http' ? /逐帧覆盖未审核/ : /动作处理/)
    assert.equal(ctx.calls.filter(([name]) => name === 'getMotionProcessing').length, 1)
    assert.equal(ctx.state.motionState.value.processingResult, null); assert.equal(ctx.store.length, 0)
  }
})

test('四项声明从 false 开始；预览可读后仍必须逐项确认，取消零上传', async t => {
  const ctx = panel(t); await selectPanel(ctx)
  assert.deepEqual({ ...ctx.state.motionConfirmations }, Object.fromEntries(Object.keys(confirmations).map(key => [key, false])))
  assert.equal(ctx.state.canUploadMotion.value, false)
  ctx.state.motionPreviewLoaded(); Object.assign(ctx.state.motionConfirmations, confirmations)
  assert.equal(ctx.state.canUploadMotion.value, true)
  ctx.state.cancelMotionSelection()
  assert.equal(ctx.state.motionFile.value, null)
  assert.equal(ctx.emitted.filter(([event]) => event === 'motion-upload').length, 0)
  assert.equal(ctx.revoked.length, 1)
})
test('换文件、CAS/来源/镜头 scope 和卸载均重置确认并释放实际 Blob URL', async t => {
  const ctx = panel(t); await selectPanel(ctx); Object.assign(ctx.state.motionConfirmations, confirmations)
  await selectPanel(ctx); assert.equal(ctx.state.motionConfirmations.full_frame_reviewed, false)
  Object.assign(ctx.state.motionConfirmations, confirmations); ctx.props.motionScope = 'scope-B'; await tick()
  assert.equal(ctx.state.motionFile.value, null); assert.equal(ctx.state.motionConfirmations.source_identity_obscured, false)
  await selectPanel(ctx); ctx.dispose(); assert.equal(ctx.revoked.length, 3)
})
for (const invalid of [new File(['x'], 'bad.mov', { type: 'video/quicktime' }), new File([], 'empty.mp4', { type: 'video/mp4' })]) {
  test(`本地格式/大小检查拒绝 ${invalid.name}`, async t => {
    const ctx = panel(t); await selectPanel(ctx, invalid)
    ctx.state.motionPreviewLoaded(); Object.assign(ctx.state.motionConfirmations, confirmations)
    ctx.state.submitMotion(); assert.equal(ctx.emitted.filter(([name]) => name === 'motion-upload').length, 0)
  })
}
test('待选替换锁阻止真实单镜、批次、队列重试 handler；取消恢复且零 POST', async t => {
  const ctx = await parent(t); selectParent(ctx)
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
  await ctx.state.generateShot({ update: {}, retry: false }); await ctx.state.generateBatch([1301])
  await ctx.state.retryDeliveryShot({ shot_id: 1301, can_start_next_attempt: true })
  assert.equal(ctx.calls.length, 0)
  ctx.state.handleMotionSelection({ scope: ctx.state.motionScope.value, file: null })
  assert.equal(ctx.state.motionGenerationBlocked.value, false)
})
test('一次显式上传先持久化 marker；双击不重发；刷新依次 work→candidate→bundle/gate→media', async t => {
  const response = defer(), ctx = await parent(t, { uploadMotionReference: () => { assert.equal(ctx.store.length, 1); return response.promise } })
  const selected = selectParent(ctx), pending = submit(ctx, selected); await tick(); await submit(ctx, selected)
  assert.equal(ctx.calls.filter(([name]) => name === 'uploadMotionReference').length, 1)
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
  const marker = JSON.parse([...ctx.store.values.values()][0]); assert.ok(marker.idempotencyKey)
  assert.equal(JSON.stringify(marker).includes('processed.mp4'), false)
  response.resolve(uploaded()); await pending; await tick()
  assert.deepEqual(ctx.calls.map(([name]) => name), ['uploadMotionReference', 'getWork', 'getMotionReference', 'getReferenceBundle', 'getGenerationGate', 'getMotionReferenceMedia'])
  assert.equal(ctx.store.length, 0); assert.equal(ctx.state.motionGenerationBlocked.value, false)
  assert.ok(ctx.state.motionState.value.candidateUrl)
})
test('已成功上传 B 但旧 ready A 包不匹配保持锁，不能以 available 代替 ready', async t => {
  const ctx = await parent(t, { getReferenceBundle: id => bundle(id, { id: 2201, sha256: 'c'.repeat(64) }) })
  await submit(ctx, selectParent(ctx))
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
  assert.equal(ctx.state.selectedReferenceBundleState.value.ready, false)
  assert.equal(ctx.store.length, 1)
  await ctx.state.generateBatch([1301]); assert.equal(ctx.calls.filter(([name]) => name === 'generateBatch').length, 0)
})
for (const response of ['network', 'conflict']) test(`${response} 状态跨切镜头和重建恢复冻结，GET 旧候选永不认作 POST 终态`, async t => {
  const store = storage(), ctx = await parent(t, { uploadMotionReference: () => { throw Object.assign(new Error('unknown'), response === 'conflict' ? { response: { status: 409 } } : {}) } }, store)
  await submit(ctx, selectParent(ctx)); ctx.state.selectedShotId.value = 1302; await tick()
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
  ctx.state.selectedShotId.value = 1301; await tick(); await ctx.state.refreshMotionReference()
  assert.equal(ctx.state.motionGenerationBlocked.value, true); assert.equal(store.length, 1)
  ctx.dispose(); const restored = await parent(t, {}, store)
  assert.equal(restored.state.motionGenerationBlocked.value, true)
  await restored.state.refreshMotionReference(); assert.equal(store.length, 1)
})
test('sessionStorage 不可写或损坏一律 fail closed，零上传', async t => {
  for (const mode of ['write', 'corrupt']) {
    const store = storage(), ctx = await parent(t, {}, store)
    if (mode === 'write') store.setItem = () => { throw new Error('storage disabled') }
    else store.setItem(`${ctx.state.motionStoragePrefix.value}1301`, '{broken')
    await submit(ctx, selectParent(ctx))
    assert.equal(ctx.calls.filter(([name]) => name === 'uploadMotionReference').length, 0)
    assert.equal(ctx.state.motionGenerationBlocked.value, true)
  }
})
test('A→B→A 后草稿迟到应拒绝且 Abort，草稿不选择不确认不上传', async t => {
  const response = defer(), ctx = await parent(t, { getMotionDraft: () => response.promise })
  assert.equal(typeof ctx.state.loadMotionDraft, 'function')
  const request = ctx.state.loadMotionDraft(); await tick()
  const signal = ctx.calls.find(([name]) => name === 'getMotionDraft')[3].signal
  ctx.state.selectedShotId.value = 1302; ctx.state.selectedShotId.value = 1301
  response.resolve(new Blob(['old'], { type: 'video/mp4' })); await request; await tick()
  assert.equal(signal.aborted, true); assert.equal(ctx.state.motionState.value.draftUrl, '')
  assert.equal(ctx.calls.some(([name]) => name === 'uploadMotionReference'), false)
})
test('POST 切镜头迟到仍保留 submitted 锁，取消或卸载不能消除 marker', async t => {
  const response = defer(), ctx = await parent(t, { uploadMotionReference: () => response.promise })
  const request = submit(ctx, selectParent(ctx)); await tick(); ctx.state.selectedShotId.value = 1302; await tick()
  ctx.state.handleMotionSelection({ scope: ctx.state.motionScope.value, file: null })
  response.resolve(uploaded()); await request
  assert.equal(ctx.state.motionGenerationBlocked.value, true); assert.equal(ctx.store.length, 1)
  ctx.dispose(); assert.equal(ctx.store.length, 1)
})
test('已在 pollRequestActive 中也必须发新 GET work，上传屏障不能借用提前开始的旧刷新', async t => {
  const old = defer(); let reads = 0
  const ctx = await parent(t, { getWork: () => ++reads === 1 ? old.promise : work() })
  const polling = ctx.state.refreshWork({ quiet: true }); await tick()
  await submit(ctx, selectParent(ctx)); assert.equal(reads, 2)
  old.resolve({ ...work(), source_fingerprint: 'c'.repeat(64) }); await polling
  assert.equal(ctx.state.localWork.value.source_fingerprint, sha)
})
test('取消正在读取的草稿释放 busy；文件选择取消后也不能复活旧生成 handler', async t => {
  const draft = defer(), saved = defer()
  const ctx = await parent(t, { getMotionDraft: () => draft.promise, updateShot: () => saved.promise })
  const draftRead = ctx.state.loadMotionDraft(); await tick(); selectParent(ctx)
  assert.equal(ctx.state.motionState.value.draftLoading, false)
  ctx.state.handleMotionSelection({ scope: ctx.state.motionScope.value, file: null })
  const generation = ctx.state.generateShot({ update: {}, retry: false }); await tick()
  selectParent(ctx); ctx.state.handleMotionSelection({ scope: ctx.state.motionScope.value, file: null })
  saved.resolve(shot(1301)); await generation
  assert.equal(ctx.calls.some(([name]) => name === 'generateShot'), false)
  draft.resolve(new Blob(['old'], { type: 'video/mp4' })); await draftRead
})
test('未上传的正常生成允许本次 save 导致 CAS 更新，不被动作读取 epoch 永久禁用', async t => {
  let currentCAS = 'shot-CAS'
  const ctx = await parent(t, { updateShot: () => { currentCAS = 'saved-CAS'; return { ...shot(1301), updated_at: currentCAS } },
    getMotionReference: id => ({ ...candidate(id), shot_updated_at: currentCAS }) })
  await settle(); assert.equal(ctx.state.selectedReferenceBundleState.value.ready, true)
  await ctx.state.generateShot({ update: {}, retry: false })
  assert.equal(ctx.calls.filter(([name]) => name === 'generateShot').length, 1)
})
test('上传屏障 work/bundle/gate GET 也传递 AbortSignal 与 silentError，卸载取消而保留待核对', async t => {
  const pending = defer(), ctx = await parent(t, { getGenerationGate: () => pending.promise })
  const uploading = submit(ctx, selectParent(ctx)); await tick(); await tick()
  const gets = ctx.calls.filter(([name]) => ['getWork', 'getReferenceBundle', 'getGenerationGate'].includes(name))
  assert.equal(gets.length, 3)
  for (const [, , options] of gets) { assert.ok(options?.signal instanceof AbortSignal); assert.equal(options.silentError, true) }
  ctx.dispose(); for (const [, , options] of gets) assert.equal(options.signal.aborted, true)
  pending.resolve({ ok: true }); await uploading; assert.equal(ctx.store.length, 1)
})
test('无 randomUUID 的本地浏览器仍通过项目既有安全幂等键生成器提交一次', async t => {
  let randomReads = 0
  const ctx = await parent(t, {}, storage(), { crypto: { getRandomValues(bytes) { randomReads += 1; bytes.fill(7); return bytes } } })
  await submit(ctx, selectParent(ctx))
  const uploads = ctx.calls.filter(([name]) => name === 'uploadMotionReference')
  assert.equal(uploads.length, 1); assert.match(uploads[0][3].idempotencyKey, /^[\w-]{20,}$/); assert.equal(randomReads, 1)
})

for (const handler of ['single', 'batch', 'queue']) test(`候选 GET pending 时旧 ready 包不能放行 ${handler}`, async t => {
  const deferred = defer(), ctx = await parent(t, { getMotionReference: () => deferred.promise })
  await settle()
  const readyBefore = ctx.state.selectedReferenceBundleState.value.ready
  if (handler === 'single') await ctx.state.generateShot({ update: {}, retry: false })
  if (handler === 'batch') await ctx.state.generateBatch([1301])
  if (handler === 'queue') await ctx.state.retryDeliveryShot({ shot_id: 1301, can_start_next_attempt: true })
  const posted = ctx.calls.filter(([name]) => ['generateShot', 'generateBatch'].includes(name)).length
  deferred.resolve({ ...candidate(), status: 'unavailable', candidate: null }); await settle()
  assert.equal(posted, 0)
  assert.equal(readyBefore, false, '等待最新候选时不能展示旧 ready')
})

for (const change of ['source', 'CAS', 'version', 'work']) test(`${change} 变更即时撤销旧候选 proof，重读未完成时禁止三个生成 handler`, async t => {
  let reads = 0; const deferred = defer()
  const ctx = await parent(t, { getMotionReference: id => ++reads === 1 ? candidate(id) : deferred.promise })
  await settle(); assert.equal(ctx.state.selectedReferenceBundleState.value.ready, true)
  const changed = work()
  if (change === 'source') changed.source_fingerprint = 'c'.repeat(64)
  if (change === 'CAS') changed.shots[0].updated_at = 'external-CAS'
  if (change === 'version') { changed.version_id = 813; ctx.props.versionId = 813 }
  if (change === 'work') changed.id = 711
  ctx.props.work = changed; await settle()
  const readyBefore = ctx.state.selectedReferenceBundleState.value.ready
  await ctx.state.generateShot({ update: {}, retry: false }); await ctx.state.generateBatch([1301])
  await ctx.state.retryDeliveryShot({ shot_id: 1301, can_start_next_attempt: true })
  const posted = ctx.calls.filter(([name]) => ['generateShot', 'generateBatch'].includes(name)).length
  deferred.resolve({ ...candidate(), status: 'unavailable', candidate: null }); await settle()
  assert.equal(posted, 0); assert.equal(readyBefore, false)
})

test('最新 unavailable 动作素材不能经队列实际重试 handler 旁路', async t => {
  const ctx = await parent(t, { getMotionReference: id => ({ ...candidate(id), status: 'unavailable', candidate: null }) })
  await settle(); await ctx.state.retryDeliveryShot({ shot_id: 1301, can_start_next_attempt: true })
  assert.equal(ctx.calls.filter(([name]) => name === 'generateShot').length, 0)
})
test('队列逐镜门禁：有效证据正常重试一次，不可用的其它镜头保持禁用且零提交', async t => {
  const ctx = await parent(t, { getMotionReference: id => id === 1302 ? { ...candidate(id), status: 'unavailable', candidate: null } : candidate(id) })
  await ctx.state.retryDeliveryShot({ shot_id: 1302, can_start_next_attempt: true })
  assert.equal(ctx.calls.filter(([name]) => name === 'generateShot').length, 0)
  await ctx.state.retryDeliveryShot({ shot_id: 1301, can_start_next_attempt: true })
  assert.equal(ctx.calls.filter(([name]) => name === 'generateShot').length, 1)
})
test('普通用户无需逐镜点击，初始完整只读证据可放行整批两个镜头', async t => {
  const ctx = await parent(t)
  await ctx.state.generateBatch([1301, 1302])
  const submitted = ctx.calls.filter(([name]) => name === 'generateBatch')
  assert.equal(submitted.length, 1); assert.deepEqual(submitted[0][2].shot_ids, [1301, 1302])
})
test('自动准备的服务端动作参考包无需手工导入候选即可放行整批镜头', async t => {
  const missing = Object.assign(new Error('动作参考候选不存在'), {
    response: { status: 404, data: { error: { code: 'REDRAW_MOTION_CANDIDATE_NOT_FOUND' } } },
  })
  const ctx = await parent(t, { getMotionReference: () => { throw missing } })
  assert.equal(ctx.state.motionReferenceReady(1301), true, JSON.stringify({ candidates: ctx.state.motionCandidates.value,
    scopes: ctx.state.motionCandidateScopes.value, bundles: ctx.state.referenceBundles.value, messages: ctx.messages }))
  assert.equal(ctx.state.motionReferenceReady(1302), true, JSON.stringify({ candidates: ctx.state.motionCandidates.value,
    scopes: ctx.state.motionCandidateScopes.value, bundles: ctx.state.referenceBundles.value, messages: ctx.messages }))
  await ctx.state.generateBatch([1301, 1302])
  const submitted = ctx.calls.filter(([name]) => name === 'generateBatch')
  assert.equal(submitted.length, 1)
  assert.deepEqual(submitted[0][2].shot_ids, [1301, 1302])
  assert.equal(ctx.calls.some(([name]) => name === 'getMotionReferenceMedia'), false)
})
test('服务端参考包的版本、镜头 CAS 或源片哈希不匹配时仍保持零提交', async t => {
  const missing = Object.assign(new Error('动作参考候选不存在'), {
    response: { status: 404, data: { error: { code: 'REDRAW_MOTION_CANDIDATE_NOT_FOUND' } } },
  })
  for (const field of ['version_id', 'shot_updated_at', 'source_sha256']) {
    const ctx = await parent(t, {
      getMotionReference: () => { throw missing },
      getReferenceBundle: id => ({ ...bundle(id), [field]: field === 'version_id' ? 999 : 'c'.repeat(64) }),
    })
    await ctx.state.generateBatch([1301])
    assert.equal(ctx.calls.filter(([name]) => name === 'generateBatch').length, 0, field)
    ctx.dispose()
  }
})
test('未选中的其它镜头有当前完整证据时可正常队列重试一次', async t => {
  const ctx = await parent(t)
  await ctx.state.retryDeliveryShot({ shot_id: 1302, can_start_next_attempt: true })
  const submitted = ctx.calls.filter(([name]) => name === 'generateShot')
  assert.equal(submitted.length, 1); assert.equal(submitted[0][1], 1302)
})
for (const action of ['queue', 'batch-target', 'batch-filtered']) test(`已选镜头 unavailable 不阻断其它 ready 目标：${action}`, async t => {
  const ctx = await parent(t, { getMotionReference: id => id === 1301 ? { ...candidate(id), status: 'unavailable', candidate: null } : candidate(id) })
  assert.equal(ctx.state.motionReferenceReady(1301), false); assert.equal(ctx.state.motionReferenceReady(1302), true)
  assert.equal(ctx.state.motionSubmissionBlocked.value, false)
  await ctx.state.generateShot({ update: {}, retry: false })
  assert.equal(ctx.calls.some(([name]) => ['updateShot', 'generateShot'].includes(name)), false, '选中镜头自身仍禁止生成')
  if (action === 'queue') await ctx.state.retryDeliveryShot({ shot_id: 1302, can_start_next_attempt: true })
  else await ctx.state.generateBatch(action === 'batch-target' ? [1302] : [1301, 1302])
  const submitted = ctx.calls.filter(([name]) => ['generateShot', 'generateBatch'].includes(name))
  assert.equal(submitted.length, 1)
  if (action === 'queue') assert.equal(submitted[0][1], 1302)
  else assert.deepEqual(submitted[0][2].shot_ids, [1302])
  assert.equal(ctx.state.motionGenerationBlocked.value, false, '已结束的非目标 unavailable 不能升级全局阻断')
})
test('候选读取未完成仍暂时全局冻结；结束为 unavailable 后只隔离自身目标', async t => {
  const deferred = defer(), ctx = await parent(t, { getMotionReference: id => id === 1301 ? deferred.promise : candidate(id) })
  assert.equal(ctx.state.motionReferenceReady(1302), true)
  await ctx.state.retryDeliveryShot({ shot_id: 1302, can_start_next_attempt: true }); await ctx.state.generateBatch([1302])
  assert.equal(ctx.calls.some(([name]) => ['generateShot', 'generateBatch'].includes(name)), false)
  deferred.resolve({ ...candidate(), status: 'unavailable', candidate: null }); await settle()
  await ctx.state.retryDeliveryShot({ shot_id: 1302, can_start_next_attempt: true })
  assert.equal(ctx.calls.filter(([name]) => name === 'generateShot').length, 1)
})
for (const phase of ['unknown', 'uploading', 'awaiting-refresh', 'conflict']) test(`同版本 ${phase} 待核对跨镜头阻断选择 UI 和新上传 handler`, async t => {
  const deferred = defer(); let uploads = 0
  const ctx = await parent(t, {
    uploadMotionReference: () => {
      uploads += 1
      if (phase === 'uploading' && uploads === 1) return deferred.promise
      if (phase === 'awaiting-refresh') return uploaded()
      throw Object.assign(new Error('pending review'), phase === 'conflict' ? { response: { status: 409 } } : {})
    },
    getReferenceBundle: id => phase === 'awaiting-refresh' ? bundle(id, { id: 2201, sha256: sha }) : bundle(id),
  })
  const first = submit(ctx, selectParent(ctx)); await settle()
  if (phase !== 'uploading') await first
  assert.equal(uploads, 1, '未提交选择不能把正常首次上传自己锁住')
  const firstScope = ctx.state.motionOperationScope.value
  assert.equal(ctx.state.motionOperations.value[firstScope].phase, phase)
  ctx.state.selectedShotId.value = 1302; await settle()
  const lockedUI = ctx.state.motionState.value.locked
  const second = selectParent(ctx)
  const selectionAccepted = Boolean(ctx.state.motionSelection.value?.file)
  // Exercise the upload handler independently of the selection handler, as if a selection event was already queued.
  ctx.state.motionSelection.value = { scope: ctx.state.motionScope.value, file: second, readable: true }
  await submit(ctx, second)
  const secondUploadCount = uploads, markerCount = ctx.store.length
  if (phase === 'uploading') { deferred.resolve(uploaded()); await first }
  await ctx.state.refreshMotionReference()
  assert.equal(secondUploadCount, 1); assert.equal(markerCount, 1)
  assert.equal(lockedUI, true); assert.equal(selectionAccepted, false)
  assert.equal(ctx.state.motionState.value.locked, true, '纯 GET 核对仍可运行，但不能清除其它镜头的 pending operation')
})
for (const change of ['work', 'version']) test(`其它 ${change} scope 不继承旧 scope 的新上传阻断`, async t => {
  const ctx = await parent(t, { uploadMotionReference: () => { throw new Error('unknown') } })
  await submit(ctx, selectParent(ctx)); assert.equal(ctx.store.length, 1)
  const next = work()
  if (change === 'work') next.id = 711
  else { next.version_id = 813; next.shots = next.shots.map(item => ({ ...item, version_id: 813 })); ctx.props.versionId = 813 }
  ctx.props.work = next; await settle()
  assert.equal(ctx.state.motionState.value.locked, false)
  await submit(ctx, selectParent(ctx))
  assert.equal(ctx.calls.filter(([name]) => name === 'uploadMotionReference').length, 2)
  assert.equal(ctx.store.length, 2)
})
test('同一 tick 的 work 来源 A→B→A 仍使旧草稿请求失效', async t => {
  const deferred = defer(), ctx = await parent(t, { getMotionDraft: () => deferred.promise })
  const reading = ctx.state.loadMotionDraft(); await tick()
  const signal = ctx.calls.find(([name]) => name === 'getMotionDraft')[3].signal
  ctx.props.work = { ...work(), source_fingerprint: 'c'.repeat(64) }; ctx.props.work = work()
  deferred.resolve(new Blob(['old'], { type: 'video/mp4' })); await reading; await settle()
  assert.equal(signal.aborted, true); assert.equal(ctx.state.motionState.value.draftUrl, '')
})
test('生成保存期间外部 CAS A→B→A 不得恢复旧 handler，合法自身保存不受影响', async t => {
  const deferred = defer(), ctx = await parent(t, { updateShot: () => deferred.promise })
  const generating = ctx.state.generateShot({ update: {}, retry: false }); await tick()
  const changed = work(); changed.shots[0].updated_at = 'external-CAS'
  ctx.props.work = changed; ctx.props.work = work()
  deferred.resolve(shot(1301)); await generating; await settle()
  assert.equal(ctx.calls.filter(([name]) => name === 'generateShot').length, 0)
})

test('真实 Queue 模板在父级冻结或逐镜证据不完整时禁用重试按钮', t => {
  const descriptor = parse(read('RedrawGenerationQueuePanel')).descriptor
  const template = compileTemplate({ source: descriptor.template.content, filename: 'Queue.vue', id: 'motion-queue-test' }).code
    .replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
    .replace('export function render', 'return function render')
  const render = new Function('Vue', template)({ ...vue, resolveComponent: name => name })
  for (const [disabled, ready, expected] of [[true, true, true], [false, false, true], [false, true, false]]) {
    const nodes = [], tree = render({ budget: {}, items: [{ shot_id: 1301, motion_reference_ready: ready }], retryingShotId: null,
      generationDisabled: disabled, providerDeliveryState: () => ({ canRetry: true }), $emit() {} }, [])
    const walk = node => { if (!node || typeof node !== 'object') return; if (node.type === 'el-button') nodes.push(node)
      if (Array.isArray(node.children)) node.children.forEach(walk) }
    walk(tree); assert.equal(nodes.length, 1); assert.equal(nodes[0].props.disabled, expected)
  }
  assert.match(read('RedrawShotStep').match(/<RedrawGenerationQueuePanel\b[\s\S]*?\/>/)[0], /:generation-disabled="motionGenerationBlocked"/)
})

test('真实 mounted Parent→Editor→Panel 被动 reset 不取消新 scope 候选，A→B→A 三次均恢复媒体', async t => {
  const calls = [], signals = []
  let state, urlIndex = 0
  const stub = vue.defineComponent({ setup: (_props, { slots }) => () => vue.h('stub', slots.default?.()) })
  const api = { getMotionReference: async (id, identity, options) => { calls.push(['candidate', id]); signals.push(options.signal); return candidate(id) },
    getReferenceBundle: async id => bundle(id), getGenerationGate: async () => ({ ok: true }),
    getMotionReferenceMedia: async id => { calls.push(['media', id]); return new Blob(['mp4'], { type: 'video/mp4' }) },
    listAssets: async () => [], getPreparationGate: async () => ({}), quoteReferencePreparation: async () => null,
    getGenerationSummary: async () => null }
  const bindings = { ...vue, ...shotState, projectRedrawCharacterIdentityPack, redrawAPI: api,
    readSession: () => ({ user: { id: 'ordinary-user' } }), readCurrentTenantId: () => null, sessionStorage: storage(),
    URL: { createObjectURL: () => `blob:mounted-${++urlIndex}`, revokeObjectURL() {} },
    ElMessage: { error() {}, warning() {}, success() {} }, Refresh: {}, DocumentChecked: {}, RefreshRight: {}, VideoPlay: {},
    RedrawBatchPanel: stub, RedrawShotPreview: stub, RedrawShotPreparationPanel: stub, RedrawGenerationQueuePanel: stub, RedrawQualityReviewPanel: stub }
  const panelDef = compile('RedrawReferenceBundlePanel', bindings, true)
  const editorDef = compile('RedrawShotEditor', { ...bindings, RedrawReferenceBundlePanel: panelDef }, true)
  const parentDef = compile('RedrawShotStep', { ...bindings, RedrawShotEditor: editorDef }, true)
  const setup = parentDef.setup
  parentDef.setup = (props, context) => { state = setup(props, context); return state }
  const renderer = vue.createRenderer({ insert() {}, remove() {}, createElement: type => ({ type, props: {}, addEventListener() {}, removeEventListener() {},
    getAttribute(key) { return this.props[key] } }), createText: () => ({}),
    createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
    patchProp(node, key, _previous, next) { node.props[key] = next } })
  const app = renderer.createApp(parentDef, { work: work(), versionId: 812, executionMode: 'safe' })
  for (const name of ['el-alert', 'el-button', 'el-tag', 'el-form-item', 'el-input-number', 'el-input', 'el-select', 'el-option']) app.component(name, stub)
  app.mount({}); t.after(() => app.unmount()); await settle()
  assert.ok(state.motionState.value.candidateUrl)
  state.selectedShotId.value = 1302; await settle(); state.selectedShotId.value = 1301; await settle()
  assert.ok(state.motionState.value.candidateUrl)
  assert.deepEqual(calls.filter(([kind]) => kind === 'media').map(([, id]) => id), [1301, 1302, 1301])
  assert.equal(signals.at(-1).aborted, false)
})

test('已确认上传经 fresh GET 核对但尚未绑定时，显式准备应提交一次且不能提前解冻生成', async t => {
  const quote = { schema_version: 'redraw-reference-preparation-quote-v1', version_id: 812,
    version_snapshot_hash: sha, character_plan_hash: sha, effective_mode: 'safe', action: 'needs_review',
    priced: true, credits: 0, confirmation_required: true, quote_hash: newSha,
    selected_shot_ids: [1301], missing_shot_ids: [1301], reused_shot_ids: [], needs_attention_shot_ids: [], items: [] }
  const ctx = await parent(t, {
    getWork: () => ownedWork(),
    getReferenceBundle: id => bundle(id, { id: 2201, sha256: sha }),
    getGenerationGate: () => ({ version_id: 812, ok: true, missing: [] }),
    quoteReferencePreparation: () => quote,
    startReferencePreparation: () => ({ task_id: 'reference-preparation-1', status: 'pending', quote }),
  })
  ctx.props.work = ownedWork(); await settle(); ctx.calls.length = 0
  await submit(ctx, selectParent(ctx))
  const operationScope = ctx.state.motionOperationScope.value
  assert.equal(ctx.state.motionOperations.value[operationScope].phase, 'awaiting-refresh')
  assert.ok(ctx.state.motionState.value.candidateUrl, 'fresh GET 已读取本次上传的 MP4')
  for (const name of ['getWork', 'getMotionReference', 'getReferenceBundle', 'getGenerationGate', 'getMotionReferenceMedia']) {
    assert.ok(ctx.calls.some(([called]) => called === name), `上传后必须实际经过 ${name} 读取屏障`)
  }
  assert.equal(ctx.calls.some(([name]) => ['quoteReferencePreparation', 'startReferencePreparation'].includes(name)), false,
    '上传回调不能自动报价或准备')
  const marker = ctx.store.getItem(operationScope)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 1,
    '已核实但未绑定的上传不能永久挡住用户显式 prepare')
  assert.equal(ctx.state.motionGenerationBlocked.value, true, '202 pending 不能当作绑定完成')
  assert.equal(ctx.store.getItem(operationScope), marker, '准备受理不能删除上传待核对标记')
})

function ownedWork() {
  return { ...work(), user_id: 'ordinary-user', tenant_id: 'default',
    shots: work().shots.map(item => ({ ...item, preparation_version: 1 })) }
}
const preparationQuote = () => ({ schema_version: 'redraw-reference-preparation-quote-v1', version_id: 812,
  version_snapshot_hash: sha, character_plan_hash: sha, execution_mode: 'safe', effective_mode: 'safe', action: 'needs_review',
  priced: true, credits: 0, confirmation_required: true, quote_hash: newSha,
  selected_shot_ids: [1301], missing_shot_ids: [1301], reused_shot_ids: [], needs_attention_shot_ids: [], items: [] })
function completedTask() {
  return { id: 'reference-preparation-1', type: 'redraw_reference_preparation', tenant_id: 'default', user_id: 'ordinary-user',
    resource_id: `redraw_reference_preparation:812:${sha}`, status: 'completed', completed_at: '2026-09-06T10:00:00.000Z',
    metadata: JSON.stringify({ quote_hash: newSha, version_snapshot_hash: sha }),
    result: JSON.stringify({ version_id: 812, quote_hash: newSha, prepared_shot_ids: [1301], reused_shot_ids: [],
      failed_shot_ids: [], needs_attention_shot_ids: [] }) }
}
function preparedWork() {
  const next = ownedWork()
  next.shots[0] = { ...next.shots[0], updated_at: 'prepared-CAS', preparation_state: 'reference_ready',
    preparation: { status: 'completed', requirements: [], clean_results: [] }, stale_reason_code: null,
    reference_bundle_hash: sha, reference_bundle_updated_at: 'bundle-CAS' }
  return next
}
async function preparationParent(t, options = {}) {
  const initialWork = options.initialWork || ownedWork
  const current = { completed: false, task: completedTask(), work: preparedWork(),
    candidate: { ...candidate(), shot_updated_at: 'prepared-CAS' }, bundle: bundle(),
    gate: { version_id: 812, ok: true, missing: [] }, blob: new Blob(['mp4'], { type: 'video/mp4' }), ...options }
  const taskCalls = []
  const ctx = await parent(t, {
    getWork: () => current.completed ? current.work : initialWork(),
    getMotionReference: id => current.completed && id === 1301 ? current.candidate : candidate(id),
    getReferenceBundle: id => {
      const error = current.completed ? current.bundleError : options.initialBundleError
      if (error) throw error
      return current.completed && id === 1301 ? current.bundle : bundle(id, { id: 2201, sha256: sha })
    },
    getGenerationGate: () => current.gate,
    getMotionReferenceMedia: () => current.blob,
    quoteReferencePreparation: () => preparationQuote(),
    startReferencePreparation: () => ({ task_id: 'reference-preparation-1', status: 'pending', quote: preparationQuote() }),
    ...options.api,
  }, storage(), { taskAPI: { get: async id => { taskCalls.push(id); return options.taskRead && current.completed ? options.taskRead(id)
    : current.completed ? current.task : { ...completedTask(), status: 'pending', result: null, completed_at: null } } } })
  ctx.props.work = initialWork(); await settle(); ctx.calls.length = 0
  await submit(ctx, selectParent(ctx))
  return { ...ctx, current, taskCalls }
}

const missingBundleError = (status = 404, code = 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND') => Object.assign(new Error('reference bundle read failed'),
  { isAxiosError: true, response: { status, data: { success: false, error: { code, message: '尚无完整参考包' } } } })
function initialBundleWork() {
  const next = ownedWork()
  Object.assign(next.shots[0], { preparation_state: 'needs_attention', reference_bundle_hash: null, reference_bundle_updated_at: null })
  return next
}
const initialBundleParent = (t, options = {}) => preparationParent(t, {
  initialWork: initialBundleWork, initialBundleError: missingBundleError(), ...options,
})

test('首次无包精确 404 仍核验本次上传媒体，仅开放显式报价和准备，不伪造 ready', async t => {
  const ctx = await initialBundleParent(t)
  const scope = ctx.state.motionOperationScope.value, marker = ctx.store.getItem(scope)
  assert.equal(ctx.state.motionOperations.value[scope].phase, 'awaiting-refresh')
  assert.equal(ctx.state.canPrepareUploadedMotion.value, true, '精确首次缺包不能阻断本次已核实上传的显式准备')
  assert.ok(ctx.state.motionState.value.candidateUrl)
  assert.equal(ctx.state.selectedReferenceBundleState.value.response, null)
  assert.equal(ctx.state.selectedReferenceBundleState.value.ready, false)
  assert.equal(ctx.state.localWork.value.shots[0].reference_bundle_hash, null)
  assert.equal(ctx.state.localWork.value.shots[0].reference_bundle_updated_at, null)
  assert.equal(ctx.calls.some(([name]) => ['quoteReferencePreparation', 'startReferencePreparation'].includes(name)), false)
  assert.equal(ctx.taskCalls.length, 0, '上传回调不得自动轮询任务')
  await ctx.state.generateShot({ update: {}, retry: false }); await ctx.state.generateBatch([1301])
  await ctx.state.retryDeliveryShot({ shot_id: 1301, can_start_next_attempt: true })
  assert.equal(ctx.calls.some(([name]) => ['generateShot', 'generateBatch'].includes(name)), false)
  await ctx.state.refreshReferencePreparation()
  assert.equal(ctx.calls.filter(([name]) => name === 'quoteReferencePreparation').length, 1)
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 0)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 1)
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
  assert.equal(ctx.store.getItem(scope), marker)
})

for (const [name, error] of [
  ['other-404', missingBundleError(404, 'REDRAW_SHOT_NOT_FOUND')],
  ['403', missingBundleError(403)], ['409', missingBundleError(409)], ['500', missingBundleError(500)],
  ['network', new Error('network error')],
  ['missing-status', { response: { data: { error: { code: 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND' } } } }],
  ['noncanonical-code', { response: { status: 404, data: { code: 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND' } } }],
]) test(`首次无包不吞掉 ${name}，报价和准备保持冻结`, async t => {
  const ctx = await initialBundleParent(t, { initialBundleError: error })
  await ctx.state.refreshReferencePreparation(); await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.state.canPrepareUploadedMotion.value, false)
  assert.equal(ctx.state.motionGenerationBlocked.value, true); assert.equal(ctx.store.length, 1)
  assert.equal(ctx.calls.some(([name]) => ['quoteReferencePreparation', 'startReferencePreparation', 'getMotionReferenceMedia'].includes(name)), false)
})

for (const field of ['reference_bundle_hash', 'reference_bundle_updated_at']) for (const state of ['registered', 'absent']) {
  test(`首次无包要求公开 ${field} 明确 null，${state} 加同码 404 仍冻结`, async t => {
    const ctx = await initialBundleParent(t, { initialWork: () => {
      const next = initialBundleWork()
      if (state === 'registered') next.shots[0][field] = field === 'reference_bundle_hash' ? sha : 'existing-bundle-CAS'
      else delete next.shots[0][field]
      return next
    } })
    await ctx.state.startReferencePreparation({ shot_ids: [1301] })
    assert.equal(ctx.state.canPrepareUploadedMotion.value, false); assert.equal(ctx.store.length, 1)
    assert.equal(ctx.calls.some(([name]) => ['startReferencePreparation', 'getMotionReferenceMedia'].includes(name)), false)
  })
}

for (const phase of ['unknown', 'conflict']) test(`首次无包但上传 ${phase} 不可由当前候选反推成功`, async t => {
  const ctx = await initialBundleParent(t, { api: { uploadMotionReference: () => {
    throw Object.assign(new Error('upload not confirmed'), phase === 'conflict' ? { response: { status: 409 } } : {})
  } } })
  await ctx.state.refreshMotionReference(); await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.state.canPrepareUploadedMotion.value, false); assert.equal(ctx.store.length, 1)
  assert.equal(ctx.calls.some(([name]) => ['startReferencePreparation', 'getMotionReferenceMedia'].includes(name)), false)
})

test('首次无包只有文件选择而没有本次成功上传，不获得 preparation proof', async t => {
  const ctx = await parent(t, { getWork: initialBundleWork, getReferenceBundle: () => { throw missingBundleError() } })
  ctx.props.work = initialBundleWork(); await settle(); ctx.calls.length = 0
  selectParent(ctx); await ctx.state.refreshMotionReference(); await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.state.canPrepareUploadedMotion.value, false); assert.equal(ctx.store.length, 0)
  assert.equal(ctx.calls.some(([name]) => ['uploadMotionReference', 'startReferencePreparation', 'getMotionReferenceMedia'].includes(name)), false)
})

for (const invalid of ['candidate', 'media', 'owner', 'gate-version']) test(`首次无包仍拒绝 ${invalid} 证据漂移`, async t => {
  const api = {}
  if (invalid === 'candidate') api.getMotionReference = id => ({ ...candidate(id), candidate: { import_id: 61, asset: { ...asset(), id: 999 } } })
  if (invalid === 'media') api.getMotionReferenceMedia = () => new Blob([], { type: 'video/mp4' })
  if (invalid === 'owner') api.getWork = () => ({ ...initialBundleWork(), user_id: 'other-user' })
  if (invalid === 'gate-version') api.getGenerationGate = () => ({ version_id: 813, ok: true, missing: [] })
  const ctx = await initialBundleParent(t, { api })
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.state.canPrepareUploadedMotion.value, false); assert.equal(ctx.store.length, 1)
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
  assert.equal(ctx.calls.some(([name]) => name === 'startReferencePreparation'), false)
})

test('首次无包媒体等待时 A→B→A 不接受迟到 proof', async t => {
  const pending = defer(), ctx = await initialBundleParent(t)
  assert.equal(ctx.state.canPrepareUploadedMotion.value, true)
  ctx.current.blob = pending.promise
  const reading = ctx.state.refreshMotionReference(); await settle()
  const media = ctx.calls.filter(([name]) => name === 'getMotionReferenceMedia').at(-1)
  assert.ok(media)
  ctx.state.selectedShotId.value = 1302; ctx.state.selectedShotId.value = 1301
  pending.resolve(new Blob(['mp4'], { type: 'video/mp4' })); await reading; await settle()
  assert.equal(media[3].signal.aborted, true)
  assert.equal(ctx.state.canPrepareUploadedMotion.value, false); assert.equal(ctx.store.length, 1)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.calls.some(([name]) => name === 'startReferencePreparation'), false)
})

test('首次无包准备任务完成仍缺包时保留 marker，实际完整包出现才采纳新 CAS', async t => {
  const ctx = await initialBundleParent(t)
  assert.equal(ctx.state.canPrepareUploadedMotion.value, true)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  const scope = ctx.state.motionOperationScope.value, marker = ctx.store.getItem(scope)
  ctx.current.completed = true; ctx.current.bundleError = missingBundleError()
  await ctx.state.refreshMotionReference(); await settle()
  assert.equal(ctx.state.selectedShot.value.updated_at, 'shot-CAS')
  assert.equal(ctx.store.getItem(scope), marker); assert.equal(ctx.state.motionGenerationBlocked.value, true)
  assert.equal(ctx.state.selectedReferenceBundleState.value.ready, false)
  ctx.current.bundleError = null
  await ctx.state.refreshMotionReference(); await settle()
  assert.equal(ctx.state.selectedShot.value.updated_at, 'prepared-CAS')
  assert.equal(ctx.store.length, 0); assert.equal(ctx.state.selectedReferenceBundleState.value.ready, true)
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 1)
})

test('动作已核对后显式刷新报价只报价；确认 prepare 后 pending 锁保持，完成刷新才采纳新 CAS 与 B 包', async t => {
  const ctx = await preparationParent(t)
  assert.equal(typeof ctx.state.refreshReferencePreparation, 'function', '页面需要显式刷新准备报价入口')
  await ctx.state.refreshReferencePreparation()
  assert.equal(ctx.calls.filter(([name]) => name === 'quoteReferencePreparation').length, 1)
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 0)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 1)
  assert.equal(ctx.store.length, 1); assert.equal(ctx.state.selectedShot.value.updated_at, 'shot-CAS')
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
  ctx.current.completed = true
  await ctx.state.refreshMotionReference(); await settle()
  assert.ok(ctx.taskCalls.includes('reference-preparation-1'), '必须实际 GET 本次 task')
  assert.equal(ctx.state.selectedShot.value.updated_at, 'prepared-CAS')
  assert.equal(ctx.store.length, 0); assert.equal(ctx.state.motionGenerationBlocked.value, false)
  assert.equal(ctx.state.selectedReferenceBundleState.value.ready, true)
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 1, '刷新不得重发 prepare')
})

for (const invalid of ['id', 'owner', 'tenant', 'type', 'resource', 'metadata-quote', 'metadata-snapshot', 'result-version',
  'result-quote', 'target', 'failed', 'attention', 'pending', 'unknown']) test(`动作准备任务证据 ${invalid} 不匹配时不采纳 CAS、不清 marker、不重发`, async t => {
  const ctx = await preparationParent(t)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 1)
  const key = ctx.state.preparationIdempotencyKey.value
  const task = ctx.current.task, metadata = JSON.parse(task.metadata), result = JSON.parse(task.result)
  if (invalid === 'id') task.id = 'other-task'
  if (invalid === 'owner') task.user_id = 'other-user'
  if (invalid === 'tenant') task.tenant_id = 'other-tenant'
  if (invalid === 'type') task.type = 'redraw_shot'
  if (invalid === 'resource') task.resource_id = `redraw_reference_preparation:813:${sha}`
  if (invalid === 'metadata-quote') metadata.quote_hash = sha
  if (invalid === 'metadata-snapshot') metadata.version_snapshot_hash = newSha
  if (invalid === 'result-version') result.version_id = 813
  if (invalid === 'result-quote') result.quote_hash = sha
  if (invalid === 'target') result.prepared_shot_ids = [1302]
  if (invalid === 'failed') result.failed_shot_ids = [1301]
  if (invalid === 'attention') result.needs_attention_shot_ids = [1301]
  if (['pending', 'unknown'].includes(invalid)) task.status = invalid
  task.metadata = JSON.stringify(metadata); task.result = JSON.stringify(result); ctx.current.completed = true
  await ctx.state.refreshMotionReference(); await ctx.state.openPreparationReview(1301)
  assert.equal(ctx.state.selectedShot.value.updated_at, 'shot-CAS'); assert.equal(ctx.store.length, 1)
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
  assert.equal(ctx.state.preparationIdempotencyKey.value, key)
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 1)
})

for (const invalid of ['work', 'owner', 'tenant', 'source', 'version', 'shot', 'business', 'preparation-version',
  'import', 'asset', 'SHA', 'bundle-asset', 'bundle-hash', 'bundle-state', 'media', 'gate-version', 'gate-shape']) test(`动作准备完成后的 fresh ${invalid} 漂移保持冻结`, async t => {
  const ctx = await preparationParent(t)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 1)
  const next = ctx.current.work, item = next.shots[0]
  if (invalid === 'work') next.id = 711
  if (invalid === 'owner') next.user_id = 'other-user'
  if (invalid === 'tenant') next.tenant_id = 'other-tenant'
  if (invalid === 'source') next.source_fingerprint = newSha
  if (invalid === 'version') next.version_id = 813
  if (invalid === 'shot') item.id = 1401
  if (invalid === 'business') item.model = 'changed-model'
  if (invalid === 'preparation-version') item.preparation_version = 2
  if (invalid === 'import') ctx.current.candidate.candidate.import_id += 1
  if (invalid === 'asset') ctx.current.candidate.candidate.asset.id += 1
  if (invalid === 'SHA') ctx.current.candidate.candidate.asset.sha256 = sha
  if (invalid === 'bundle-asset') ctx.current.bundle.bundle.motion_reference.asset_id += 1
  if (invalid === 'bundle-hash') ctx.current.bundle.reference_bundle_hash = newSha
  if (invalid === 'bundle-state') item.preparation.status = 'processing'
  if (invalid === 'media') ctx.current.blob = new Blob([], { type: 'video/mp4' })
  if (invalid === 'gate-version') ctx.current.gate.version_id = 813
  if (invalid === 'gate-shape') delete ctx.current.gate.ok
  ctx.current.completed = true
  await ctx.state.refreshMotionReference(); await settle()
  assert.ok(ctx.taskCalls.length > 0)
  assert.equal(ctx.state.selectedShot.value.updated_at, 'shot-CAS'); assert.equal(ctx.store.length, 1)
  assert.equal(ctx.state.motionGenerationBlocked.value, true)
})

test('准备完成允许其它镜头无关进度变化，但明确 POST unknown 后刷新只能只读且保留幂等键', async t => {
  const ctx = await preparationParent(t)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  ctx.current.work.shots[1].status = 'completed'; ctx.current.completed = true
  await ctx.state.refreshMotionReference(); await settle()
  assert.equal(ctx.store.length, 0)
  const unknown = await preparationParent(t, { api: { startReferencePreparation: () => { throw new Error('timeout') } } })
  await unknown.state.startReferencePreparation({ shot_ids: [1301] })
  const key = unknown.state.preparationIdempotencyKey.value
  await unknown.state.openPreparationReview(1301); await unknown.state.startReferencePreparation({ shot_ids: [1301] })
  assert.ok(key); assert.equal(unknown.state.preparationIdempotencyKey.value, key)
  assert.equal(unknown.store.length, 1)
  assert.equal(unknown.calls.filter(([name]) => name === 'startReferencePreparation').length, 1)
})

for (const change of ['shot', 'source', 'work', 'version']) test(`准备报价等待中 ${change} A→B→A 使迟到 quote 不能提交`, async t => {
  const pending = defer(), ctx = await preparationParent(t, { api: { quoteReferencePreparation: () => pending.promise } })
  const starting = ctx.state.startReferencePreparation({ shot_ids: [1301] }); await tick()
  assert.equal(ctx.calls.filter(([name]) => name === 'quoteReferencePreparation').length, 1)
  if (change === 'shot') { ctx.state.selectedShotId.value = 1302; ctx.state.selectedShotId.value = 1301 }
  if (change === 'source') { ctx.props.work = { ...ownedWork(), source_fingerprint: newSha }; ctx.props.work = ownedWork() }
  if (change === 'work') { ctx.props.work = { ...ownedWork(), id: 711 }; ctx.props.work = ownedWork() }
  if (change === 'version') { ctx.props.versionId = 813; ctx.props.versionId = 812 }
  pending.resolve(preparationQuote()); await starting; await settle()
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 0)
  assert.equal(ctx.state.preparationSubmissionLocked.value, false, '尚未 POST 的撤销不能留下提交锁')
  assert.equal(ctx.store.length, 1)
})

for (const field of ['tenant_id', 'user_id']) test(`上传 fresh work 的 ${field} 与当前 owner 不同不得切 scope 或释放 marker`, async t => {
  const ctx = await preparationParent(t)
  const scope = ctx.state.motionOperationScope.value
  ctx.current.work = { ...ownedWork(), [field]: 'other-owner' }; ctx.current.completed = true
  ctx.current.candidate = candidate()
  await ctx.state.refreshMotionReference(); await settle()
  assert.equal(ctx.state.motionOperationScope.value, scope)
  assert.equal(ctx.state.localWork.value[field], ownedWork()[field])
  assert.equal(ctx.store.length, 1); assert.equal(ctx.state.motionGenerationBlocked.value, true)
})

for (const boundary of ['task', 'media']) for (const change of ['shot', 'source', 'business']) {
  test(`准备 ${boundary} GET 等待中 ${change} A→B→A 不得接受迟到完成`, async t => {
    const pending = defer(), ctx = await preparationParent(t, boundary === 'task' ? { taskRead: () => pending.promise } : {})
    await ctx.state.startReferencePreparation({ shot_ids: [1301] })
    ctx.current.completed = true
    if (boundary === 'media') ctx.current.blob = pending.promise
    const reading = ctx.state.refreshMotionReference(); await settle()
    if (change === 'shot') { ctx.state.selectedShotId.value = 1302; ctx.state.selectedShotId.value = 1301 }
    if (change === 'source') { ctx.props.work = { ...ownedWork(), source_fingerprint: newSha }; ctx.props.work = ownedWork() }
    if (change === 'business') { ctx.state.localWork.value.shots[0].model = 'changed'; ctx.state.localWork.value.shots[0].model = 'snapshot' }
    pending.resolve(boundary === 'task' ? completedTask() : new Blob(['mp4'], { type: 'video/mp4' }))
    await reading; await settle()
    assert.equal(ctx.store.length, 1); assert.equal(ctx.state.motionGenerationBlocked.value, true)
    assert.equal(ctx.state.selectedShot.value.updated_at, 'shot-CAS')
  })
}

test('未知准备同会话切 work 后返回仍保留原准备幂等键，另一 work 不连坐', async t => {
  const ctx = await preparationParent(t, { api: { startReferencePreparation: () => { throw new Error('timeout') } } })
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  const key = ctx.state.preparationIdempotencyKey.value
  ctx.props.work = { ...ownedWork(), id: 711 }; await settle()
  assert.equal(ctx.state.preparationSubmissionLocked.value, false); assert.equal(ctx.state.motionSubmissionBlocked.value, false)
  ctx.props.work = ownedWork(); await settle()
  assert.equal(ctx.state.preparationIdempotencyKey.value, key)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.calls.filter(([name]) => name === 'startReferencePreparation').length, 1)
})

test('准备完成不把动态 quote/billing/generation_availability 误当业务漂移', async t => {
  const ctx = await preparationParent(t)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  Object.assign(ctx.current.work.shots[0], { quote: { changed_read_model: true }, billing: { quote: { credits: 7 } },
    generation_snapshot: { price: 7 }, generation_availability: { ok: true } })
  ctx.current.completed = true; await ctx.state.refreshMotionReference(); await settle()
  assert.equal(ctx.store.length, 0); assert.equal(ctx.state.selectedReferenceBundleState.value.ready, true)
})

test('普通无 motion pending 的显式准备仍复用原 scoped quote、幂等键与受理锁', async t => {
  const ctx = await parent(t, { quoteReferencePreparation: () => preparationQuote(),
    startReferencePreparation: () => ({ task_id: 'ordinary-preparation', status: 'pending', quote: preparationQuote() }) })
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  const calls = ctx.calls.filter(([name]) => name === 'startReferencePreparation')
  assert.equal(calls.length, 1); assert.deepEqual(calls[0][2].shot_ids, [1301])
  assert.equal(calls[0][2].quote_hash, newSha); assert.ok(calls[0][2].idempotency_key)
  assert.equal(ctx.state.preparationSubmissionLocked.value, true); assert.equal(ctx.store.length, 0)
})

test('真实父模板对已确认待绑定、未知与已受理准备显示一致的 UI 锁及显式刷新入口', async t => {
  const descriptor = parse(read('RedrawShotStep')).descriptor
  const compiled = compileTemplate({ source: descriptor.template.content, filename: 'RedrawShotStep.vue', id: 'preparation-ui' }).code
    .replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
    .replace('export function render', 'return function render')
  const render = new Function('Vue', compiled)({ ...vue, resolveComponent: name => name })
  const ctx = await preparationParent(t)
  const controls = () => {
    const nodes = [], tree = render({ ...Object.fromEntries(Object.entries(ctx.state).map(([key, value]) => [key, vue.unref(value)])), executionMode: 'safe' }, [])
    const walk = node => { if (!node || typeof node !== 'object') return; nodes.push(node)
      if (Array.isArray(node.children)) node.children.forEach(walk) }
    walk(tree)
    return { panel: nodes.find(node => node.type === 'RedrawShotPreparationPanel'),
      refresh: nodes.find(node => node.props?.['data-testid'] === 'redraw-reference-preparation-refresh') }
  }
  assert.equal(controls().panel.props['submission-locked'], false)
  assert.equal(controls().refresh.props.disabled, false)
  await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(controls().panel.props['submission-locked'], true)
  assert.equal(controls().refresh.props.disabled, false, '受理后允许只读刷新而非再次prepare')
  const operation = ctx.state.motionOperations.value[ctx.state.motionOperationScope.value]
  delete operation.preparation; operation.phase = 'unknown'
  assert.equal(controls().panel.props['submission-locked'], true)
  assert.equal(controls().refresh.props.disabled, true)
})

for (const phase of ['unknown', 'uploading', 'conflict']) test(`上传 ${phase} 保持 quote 和 prepare 的 handler 冻结`, async t => {
  const ctx = await preparationParent(t), operation = ctx.state.motionOperations.value[ctx.state.motionOperationScope.value]
  operation.phase = phase
  await ctx.state.refreshReferencePreparation(); await ctx.state.startReferencePreparation({ shot_ids: [1301] })
  assert.equal(ctx.calls.some(([name]) => ['quoteReferencePreparation', 'startReferencePreparation'].includes(name)), false)
  assert.equal(ctx.store.length, 1)
})

test('准备只读 GET 迟迟未结束时切 work 不继承旧刷新 busy', async t => {
  const pending = defer(), ctx = await preparationParent(t, { taskRead: () => pending.promise })
  await ctx.state.startReferencePreparation({ shot_ids: [1301] }); ctx.current.completed = true
  const reading = ctx.state.refreshMotionReference(); await tick()
  assert.equal(ctx.state.preparationRefreshing.value, true)
  ctx.props.work = { ...ownedWork(), id: 711 }; await settle()
  const inheritedBusy = ctx.state.preparationRefreshing.value
  pending.resolve(completedTask()); await reading
  assert.equal(inheritedBusy, false)
  assert.equal(ctx.state.localWork.value.id, 711); assert.equal(ctx.store.length, 1)
})
