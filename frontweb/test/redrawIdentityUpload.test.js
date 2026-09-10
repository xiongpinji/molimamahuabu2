import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as identity from '../src/utils/redrawCharacterIdentity.js'
import * as assetState from '../src/utils/redrawAssetState.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const cardSource = read('../src/components/redraw/RedrawAssetCard.vue')
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }
const file = (name = 'identity.png', type = 'image/png', size = 20) => ({ name, type, size })
const row = (overrides = {}) => ({ id: 1201, version_id: 812, kind: 'character', asset_id: null,
  status: 'pending', approval_status: 'pending', updated_at: '2026-09-06T10:00:00.000Z', ...overrides })
const uploadedRow = () => row({ asset_id: 2301, status: 'generated', updated_at: '2026-09-06T10:01:00.000Z' })
const uploaded = () => ({ purpose: 'identity', asset: { id: 2301, type: 'image', mime_type: 'image/png', sha256: 'a'.repeat(64),
  width: 200, height: 200, file_size: 20 }, redraw_asset: { id: 1201, asset_id: 2301, status: 'generated',
  approval_status: 'pending', approved_by: null, approved_at: null, error_code: null, updated_at: uploadedRow().updated_at },
  billing: { credits: 0, held: 0, charged: 0 } })

function compile(source, bindings) {
  const script = compileScript(parse(source).descriptor, { id: 'identity-upload-test' }).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
  const entries = Object.entries(bindings).filter(([key]) => /^[A-Za-z_$][\w$]*$/.test(key) && key !== 'default')
  return new Function(...entries.map(([key]) => key), script)(...entries.map(([, value]) => value))
}
function runtime(t, api = {}, initial = row(), onEmit = () => {}) {
  const scope = vue.effectScope(), hooks = [], calls = [], emitted = [], messages = []
  const bindings = { ...vue, ...identity, ...assetState, Check: {}, CloseBold: {}, Refresh: {},
    onBeforeUnmount(fn) { hooks.push(fn) }, ElMessage: Object.fromEntries(['success', 'warning', 'error'].map(kind => [kind, message => messages.push([kind, message])])),
    redrawAPI: { getAssetPreview: async (...args) => { calls.push(['preview', ...args]); return new Blob(['image']) },
      uploadIdentityReference: async (...args) => { calls.push(['upload', ...args]); return uploaded() },
      saveRedrawCharacterIdentityPack: async (...args) => { calls.push(['save', ...args]) }, ...api } }
  const component = compile(cardSource, bindings)
  const props = vue.reactive({ asset: initial, versionId: 812, quote: 8, wardrobeReferenceAssets: [] })
  const state = scope.run(() => component.setup(props, { expose() {}, emit(...args) { emitted.push(args); onEmit(...args) } }))
  let closed = false
  const dispose = () => { if (!closed) { closed = true; hooks.forEach(fn => fn()); scope.stop() } }
  t.after(dispose)
  return { state, props, calls, emitted, messages, dispose }
}
function select(state, chosen = file()) {
  assert.equal(typeof state.selectIdentityFile, 'function', '真实角色卡必须支持显式选择身份图')
  state.selectIdentityFile({ target: { files: chosen ? [chosen] : [], value: chosen?.name || '' } })
}
function refreshRequest(ctx) {
  const request = ctx.emitted.findLast(item => item[0] === 'identity-saved')?.[1]
  assert.equal(typeof request?.complete, 'function', '上传必须等待父级只读刷新确认')
  return request
}
async function completeRefresh(ctx, asset = uploadedRow()) {
  const result = refreshRequest(ctx).complete({ asset })
  ctx.props.asset = asset
  await result
  await tick()
}

test('API 上传只发送角色行 ID、file、identity purpose、CAS 和稳定幂等头，覆盖默认 JSON', async () => {
  const source = read('../src/api/redraw.js').replace(/^import[^\n]*\n/gm, '').replace(/export /g, '').replace('const redrawAPI =', 'return')
  const calls = [], api = new Function('request', source)({ post: (...args) => { calls.push(args); return 'response' } })
  assert.equal(typeof api.uploadIdentityReference, 'function', 'reference-artifact API 尚未接线')
  const image = new File(['png'], 'identity.png', { type: 'image/png' })
  assert.equal(await api.uploadIdentityReference(1201, image, { expected_updated_at: 'revision-1', idempotencyKey: 'stable-operation-key',
    purpose: 'wardrobe', version_id: 99, owner: 'forbidden', model: 'forbidden', key: 'forbidden', path: 'secret', source: {} }), 'response')
  assert.equal(calls.length, 1)
  const [url, body, options] = calls[0]
  assert.equal(url, '/redraw/assets/1201/reference-artifact')
  assert.ok(body instanceof FormData)
  assert.deepEqual([...body.keys()].sort(), ['expected_updated_at', 'file', 'purpose'])
  assert.equal(body.get('file'), image); assert.equal(body.get('purpose'), 'identity'); assert.equal(body.get('expected_updated_at'), 'revision-1')
  assert.deepEqual(options.headers, { 'Content-Type': 'multipart/form-data', 'Idempotency-Key': 'stable-operation-key' })
  assert.equal(options.silentError, true, '上传错误只由作用域有效的卡片显示')
})

test('身份图只读聚合 API 只发四条既有 GET 且禁止全局错误消息', async () => {
  const source = read('../src/api/redraw.js').replace(/^import[^\n]*\n/gm, '').replace(/export /g, '').replace('const redrawAPI =', 'return')
  const calls = [], api = new Function('request', source)({ get: (...args) => calls.push(args) })
  assert.equal(typeof api.getIdentityReferenceState, 'function')
  await api.getIdentityReferenceState(812, 710)
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(call => call[0]), ['/redraw/versions/812/assets', '/redraw/versions/812/generation-gate',
    '/redraw/versions/812/character-plan', '/redraw/works/710'])
  for (const call of calls) assert.equal(call[1]?.silentError, true)
})

test('真实 SFC 选择和取消零 POST，显式上传使用角色行 ID，一次操作防双击并冻结冲突动作', async (t) => {
  const pending = defer(), ctx = runtime(t, { uploadIdentityReference: (...args) => { ctx.calls.push(['upload', ...args]); return pending.promise } })
  select(ctx.state); assert.equal(ctx.state.identityFile.value.name, 'identity.png'); assert.equal(ctx.calls.length, 0)
  select(ctx.state, null); assert.equal(ctx.state.identityFile.value, null); assert.equal(ctx.calls.length, 0)
  select(ctx.state); const submit = ctx.state.uploadIdentityReference(); ctx.state.uploadIdentityReference()
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.calls[0][1], 1201)
  assert.equal(ctx.calls[0][3].expected_updated_at, ctx.props.asset.updated_at)
  assert.match(ctx.calls[0][3].idempotencyKey, /^[\w-]{20,}$/)
  assert.equal(ctx.state.identityRefreshRequired.value, true); assert.equal(ctx.state.approveDisabled.value, true)
  await ctx.state.saveIdentityPack(); assert.equal(ctx.calls.length, 1)
  pending.resolve(uploaded()); await submit
  assert.equal(ctx.messages.some(([kind]) => kind === 'success'), false)
  assert.equal(ctx.state.identityRefreshRequired.value, true)
  await completeRefresh(ctx)
  assert.equal(ctx.state.identityRefreshRequired.value, false)
  assert.equal(ctx.state.identityForm.value.live_action_human_confirmed, false)
  assert.deepEqual(ctx.state.identityForm.value.confirmed_views, [])
  assert.equal(ctx.state.approveDisabled.value, true)
  assert.equal(ctx.calls.filter(item => item[0] === 'upload').length, 1)
  assert.ok(ctx.calls.some(item => item[0] === 'preview' && item[1] === 1201 && item[2] === 'primary'))
})

for (const [name, chosen, overrides] of [
  ['缺文件', null, {}], ['GIF', file('image.gif', 'image/gif'), {}], ['扩展名非法', file('image.svg'), {}],
  ['MIME 不匹配', file('image.png', 'image/jpeg'), {}], ['缺 MIME', file('image.png', ''), {}],
  ['超 20 MiB', file('image.png', 'image/png', 20 * 1024 * 1024 + 1), {}], ['缺 CAS', file(), { updated_at: '' }],
  ['非角色', file(), { kind: 'scene' }],
]) test(`本地拒绝${name}，零上传`, async (t) => {
  const ctx = runtime(t, {}, row(overrides)); select(ctx.state, chosen)
  await ctx.state.uploadIdentityReference()
  assert.equal(ctx.calls.filter(item => item[0] === 'upload').length, 0)
})

for (const status of [400, 403, 409, 'network']) test(`上传 ${status} 不自动重发，仅只读刷新，刷新失败保持冻结`, async (t) => {
  const ctx = runtime(t, { uploadIdentityReference: async () => { ctx.calls.push(['upload']); throw Object.assign(new Error('request failed'), status === 'network' ? {} : { response: { status } }) } })
  select(ctx.state); await ctx.state.uploadIdentityReference()
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.state.identityRefreshRequired.value, true)
  const request = refreshRequest(ctx); request.complete({ error: new Error('refresh failed') }); await tick()
  assert.equal(ctx.state.identityRefreshRequired.value, true); assert.match(ctx.state.identityUploadError.value, /刷新|核对/)
  await ctx.state.uploadIdentityReference(); await ctx.state.saveIdentityPack(); assert.equal(ctx.calls.length, 1)
  ctx.state.refreshIdentityReference(); await completeRefresh(ctx, row())
  assert.equal(ctx.state.identityRefreshRequired.value, false)
  assert.equal(ctx.state.identityFile.value, null)
  assert.equal(ctx.messages.some(([kind]) => kind === 'success'), false)
})

test('不完整上传响应不冒称成功；成功响应后的旧 CAS 刷新也不得解冻结', async (t) => {
  const ctx = runtime(t, { uploadIdentityReference: async () => ({ asset: { id: 2301 } }) })
  select(ctx.state); await ctx.state.uploadIdentityReference()
  assert.equal(ctx.messages.some(([kind]) => kind === 'success'), false); assert.equal(ctx.state.identityRefreshRequired.value, true)
  refreshRequest(ctx).complete({ error: new Error('failed') }); await tick()
  const valid = runtime(t); select(valid.state); await valid.state.uploadIdentityReference(); await completeRefresh(valid, row())
  assert.equal(valid.state.identityRefreshRequired.value, true)
  assert.equal(valid.messages.some(([kind]) => kind === 'success'), false)
})

for (const change of ['selection', 'role', 'version', 'ABA', 'revision', 'unmount']) test(`真实 SFC ${change} 使迟到上传失效且零刷新/成功消息`, async (t) => {
  const pending = defer(), ctx = runtime(t, { uploadIdentityReference: () => pending.promise })
  select(ctx.state); const submit = ctx.state.uploadIdentityReference()
  if (change === 'selection') select(ctx.state, file('next.png'))
  if (change === 'role') ctx.props.asset = row({ id: 1202 })
  if (change === 'version') ctx.props.versionId = 813
  if (change === 'ABA') { ctx.props.asset = row({ id: 1202 }); ctx.props.asset = row() }
  if (change === 'revision') ctx.props.asset.updated_at = 'new-revision'
  if (change === 'unmount') ctx.dispose()
  pending.resolve(uploaded()); await submit; await tick()
  assert.equal(ctx.emitted.filter(item => item[0] === 'identity-saved').length, 0); assert.equal(ctx.messages.length, 0)
})

test('父级刷新期间 ABA 或选图变化同样不能回填新上下文', async (t) => {
  for (const change of ['ABA', 'selection']) {
    const ctx = runtime(t); select(ctx.state); await ctx.state.uploadIdentityReference(); const request = refreshRequest(ctx)
    if (change === 'ABA') { ctx.props.asset = row({ id: 1202 }); ctx.props.asset = row() }
    else select(ctx.state, file('changed.png'))
    await request.complete({ asset: uploadedRow() }); await tick()
    assert.equal(ctx.state.identityRefreshRequired.value, true); assert.equal(ctx.messages.some(([kind]) => kind === 'success'), false)
  }
})

test('服务器换图移除旧身份包，完整只读刷新后仍需重新人工确认和保存', async (t) => {
  const previous = row({ asset_id: 2201, identity_pack: { target_actor_label: 'Actor', confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true, adult_status: 'verified_18_plus', identity_consistency_confirmed: true,
    wardrobe: { reference_asset_id: 2203, consistency_confirmed: true } }, identity_pack_status: { ready: true } })
  const asset = { ...uploadedRow(), identity_pack: null, identity_pack_status: { has_identity_pack: false, ready: false, hash_valid: false,
    missing_views: ['front', 'profile', 'full_body'], missing_confirmations: ['live_action_human_confirmed', 'adult_status', 'identity_consistency_confirmed', 'wardrobe'] } }
  const ctx = runtime(t, {}, previous)
  select(ctx.state); await ctx.state.uploadIdentityReference(); await completeRefresh(ctx, asset)
  assert.equal(ctx.state.approveDisabled.value, true)
  assert.equal(ctx.state.identityPack.value.ready, false)
  assert.deepEqual(ctx.state.identityForm.value.confirmed_views, [])
  assert.equal(ctx.state.identityForm.value.live_action_human_confirmed, false)
  assert.equal(ctx.state.identityForm.value.wardrobe_reference_asset_id, null)
  assert.equal(ctx.state.identityForm.value.wardrobe_consistency_confirmed, false)
})

function stepRuntime(t, api = {}) {
  const scope = vue.effectScope(), hooks = [], calls = [], emitted = [], messages = []
  const record = uploadedRow(), work = { id: 710, version_id: 812 }
  const defaults = { listAssets: [record], getGenerationGate: { ok: false, missing: [] }, getCharacterPlan: null, getWork: work }
  const bindings = { ...vue, ...assetState, ...identity, onMounted() {}, onUnmounted(fn) { hooks.push(fn) },
    RedrawAssetCard: {}, RedrawCharacterLibraryPanel: {}, RedrawReviewGate: {}, RedrawVoicePicker: {},
    ElMessage: Object.fromEntries(['error', 'warning', 'success'].map(kind => [kind, message => messages.push([kind, message])])),
    redrawAPI: Object.fromEntries([...Object.keys(defaults), 'getAssetQuote', 'quoteAssetBatch', 'createAssetBatch', 'generateAsset'].map(name => [name, async (...args) => {
      calls.push([name, ...args]); return api[name] ? api[name](...args) : defaults[name]
    }])) }
  bindings.redrawAPI.getIdentityReferenceState = (versionId, workId) => Promise.all([
    bindings.redrawAPI.listAssets(versionId), bindings.redrawAPI.getGenerationGate(versionId),
    bindings.redrawAPI.getCharacterPlan(versionId), bindings.redrawAPI.getWork(workId),
  ])
  const component = compile(read('../src/components/redraw/RedrawAssetStep.vue'), bindings)
  const props = vue.reactive({ versionId: 812, work })
  const state = scope.run(() => component.setup(props, { expose() {}, emit(...args) { emitted.push(args) } }))
  const dispose = () => { hooks.forEach(fn => fn()); scope.stop() }; t.after(dispose)
  return { state, props, calls, emitted, messages, dispose, scope }
}

test('真实父 SFC 上传刷新完整读取四个 DTO；零单项/批次报价且清除旧批次授权', async (t) => {
  const workRead = defer(), ctx = stepRuntime(t, { getWork: () => workRead.promise }), completions = []
  const publishedAtCompletion = []
  ctx.state.batchQuote.value = { quote_hash: 'old', total_credits: 8 }
  const refreshing = ctx.state.handleIdentitySaved({ assetId: 1201, versionId: 812, isCurrent: () => true, complete: result => {
    publishedAtCompletion.push(ctx.state.assets.value[0]?.asset_id)
    completions.push(result)
  } })
  await tick(); assert.equal(completions.length, 0)
  workRead.resolve({ id: 710, version_id: 812 }); await refreshing
  assert.deepEqual(ctx.calls.map(item => item[0]).sort(), ['getCharacterPlan', 'getGenerationGate', 'getWork', 'listAssets'])
  assert.equal(completions.length, 1); assert.equal(completions[0].asset.asset_id, 2301)
  assert.deepEqual(publishedAtCompletion, [2301], '先排队父级 DTO 更新，再让卡片 nextTick 等待实际 props 更新')
  assert.equal(ctx.state.batchQuote.value, null)
})

test('真实父 SFC 完整刷新失败不发布半份新资产，迟到 ABA 不调用成功回调', async (t) => {
  const failed = stepRuntime(t, { getWork: () => Promise.reject(new Error('work read failed')) }), errors = []
  await failed.state.handleIdentitySaved({ assetId: 1201, versionId: 812, isCurrent: () => true, complete: result => errors.push(result) })
  assert.equal(errors.length, 1); assert.ok(errors[0].error); assert.equal(failed.state.assets.value.length, 0)
  const pending = defer(), ctx = stepRuntime(t, { getWork: () => pending.promise }), completions = []
  const refreshing = ctx.state.handleIdentitySaved({ assetId: 1201, versionId: 812, isCurrent: () => true, complete: result => completions.push(result) })
  ctx.props.versionId = 813; ctx.props.versionId = 812
  pending.resolve({ id: 710, version_id: 812 }); await refreshing
  assert.equal(completions.length, 0)
})

test('上传的只读刷新隔离先发普通刷新，旧 CAS 和旧报价不得迟到覆盖新图', async (t) => {
  const oldRead = defer(); let assetReads = 0
  const ctx = stepRuntime(t, { listAssets: () => ++assetReads === 1 ? oldRead.promise : [uploadedRow()] })
  const oldRefresh = ctx.state.refresh()
  await ctx.state.handleIdentitySaved({ assetId: 1201, versionId: 812, isCurrent: () => true, complete() {} })
  assert.equal(ctx.state.assets.value[0].asset_id, 2301)
  oldRead.resolve([row({ asset_id: 2201 })]); await oldRefresh
  assert.equal(ctx.state.assets.value[0].asset_id, 2301)
  assert.equal(ctx.calls.some(item => item[0] === 'getAssetQuote' || item[0] === 'quoteAssetBatch'), false)
})

test('角色上传的冻结状态接线到父级，批次按钮和真实 handler 均零报价/零生成', async (t) => {
  const ctx = stepRuntime(t)
  assert.equal(typeof ctx.state.handleIdentityUploadState, 'function', '父级必须接收上传冻结状态')
  ctx.state.handleIdentityUploadState({ assetId: 1201, versionId: 812, blocked: true })
  assert.equal(ctx.state.identityUploadsBlocked.value, true)
  ctx.state.batchQuote.value = { priced: true, total_credits: 8, quote_hash: 'old', items: [{ asset_id: 1201, credits: 8 }] }
  assert.equal(ctx.state.batchReady.value, false)
  await ctx.state.startAssetBatch(); await ctx.state.startAssetBatch(); await ctx.state.retryFailedAssets()
  assert.equal(ctx.calls.length, 0)
  const card = runtime(t); select(card.state); await card.state.uploadIdentityReference()
  assert.deepEqual(card.emitted.filter(item => item[0] === 'identity-upload-state'), [['identity-upload-state', { assetId: 1201, versionId: 812, blocked: true }]])
  await completeRefresh(card)
  assert.deepEqual(card.emitted.filter(item => item[0] === 'identity-upload-state').at(-1), ['identity-upload-state', { assetId: 1201, versionId: 812, blocked: false }])
  ctx.state.handleIdentityUploadState({ assetId: 1201, versionId: 813, blocked: false })
  assert.equal(ctx.state.identityUploadsBlocked.value, true, '其它版本的解冻消息无效')
  ctx.state.handleIdentityUploadState({ assetId: 1201, versionId: 812, blocked: false })
  assert.equal(ctx.state.identityUploadsBlocked.value, false)
})

test('先发单卡报价后开始身份上传，迟到报价不能提交生成或刷新旧角色', async (t) => {
  const quoted = defer(), ctx = stepRuntime(t, { getAssetQuote: () => quoted.promise })
  const generating = ctx.state.generate(row())
  ctx.state.handleIdentityUploadState({ assetId: 1201, versionId: 812, blocked: true })
  quoted.resolve({ priced: true, credits: 8, quote_hash: 'before-upload' }); await generating
  assert.equal(ctx.calls.filter(call => call[0] === 'generateAsset').length, 0)
  assert.equal(ctx.calls.filter(call => call[0] === 'listAssets').length, 0)
  const before = ctx.calls.length; await ctx.state.generate(row())
  assert.equal(ctx.calls.length, before, '冻结后进入的单卡处理器连报价也不能请求')
})

test('同作品同版本的进度 DTO 对象替换不取消当前刷新或清除上传冻结', async (t) => {
  const assetsRead = defer(), ctx = stepRuntime(t, { listAssets: () => assetsRead.promise })
  ctx.state.pendingIdentityUploads.value.add('1201')
  const refreshing = ctx.state.refresh({ quoteBatch: false })
  ctx.props.work = { ...ctx.props.work, task_progress: 75, status: 'asset_review' }
  await tick()
  assetsRead.resolve([uploadedRow()]); await refreshing
  assert.equal(ctx.state.assets.value[0]?.asset_id, 2301, '同值作用域更新应完成原刷新')
  assert.equal(ctx.state.identityUploadsBlocked.value, true, '进度更新不能清除尚未核对的上传')
})

for (const outcome of ['success', 'failure']) test(`双 SFC 同 CAS 普通刷新抢占 quiet ${outcome}，释放读取 busy 但保持冻结并允许显式重核`, async (t) => {
  const firstWork = defer(), secondWork = defer(), pending = []; let reads = 0, uploads = 0
  const parent = stepRuntime(t, { listAssets: () => [row()], getWork: () => ++reads === 1 ? firstWork.promise : secondWork.promise })
  parent.state.assets.value = [row()]
  const card = runtime(t, { uploadIdentityReference: async () => { uploads += 1; throw new Error('network result unknown') } }, row(), (name, payload) => {
    if (name === 'identity-upload-state') parent.state.handleIdentityUploadState(payload)
    if (name === 'identity-saved') pending.push(parent.state.handleIdentitySaved(payload))
  })
  parent.scope.run(() => {
    vue.watch(() => parent.state.assets.value[0], asset => { card.props.asset = asset })
    vue.watch(() => parent.state.pendingIdentityUploads.value.has('1201'), blocked => { card.props.identityUploadBlocked = blocked })
  })
  select(card.state); await card.state.uploadIdentityReference()
  assert.equal(card.state.refreshingIdentity.value, true)
  await parent.state.refresh({ quoteBatch: false }); await tick()
  assert.equal(card.props.asset.updated_at, row().updated_at)
  if (outcome === 'success') firstWork.resolve({ id: 710, version_id: 812 })
  else firstWork.reject(new Error('late read failed'))
  await pending[0]; await tick()
  assert.equal(card.state.refreshingIdentity.value, false, '被抢占的本次读取必须结束')
  assert.equal(card.state.identityRefreshRequired.value, true)
  assert.equal(parent.state.identityUploadsBlocked.value, true)
  assert.equal(card.messages.some(([kind]) => kind === 'success'), false)
  card.state.refreshIdentityReference(); await tick()
  assert.equal(pending.length, 2, '允许一次显式只读重核，不得永久 busy')
  assert.equal(card.state.identityRefreshRequired.value, true)
  secondWork.resolve({ id: 710, version_id: 812 }); await pending[1]; await tick()
  assert.equal(card.state.identityRefreshRequired.value, false)
  assert.equal(parent.state.identityUploadsBlocked.value, false)
  assert.equal(uploads, 1)
  assert.equal(card.messages.some(([kind]) => kind === 'success'), false)
})

test('上传前旧批次报价不得经同范围上下文 ABA 回盖上传后新报价', async (t) => {
  const oldQuote = defer(), freshQuote = defer(), oldStarted = defer(), freshStarted = defer()
  let uploaded = false, quoteCalls = 0
  const prop = row({ id: 1203, kind: 'prop', status: 'draft', updated_at: 'prop-CAS' })
  const ctx = stepRuntime(t, {
    listAssets: () => [uploaded ? uploadedRow() : row({ status: 'draft' }), prop],
    getAssetQuote: () => ({ priced: true, credits: 8, quote_hash: 'single-current' }),
    quoteAssetBatch: () => { if (++quoteCalls === 1) { oldStarted.resolve(); return oldQuote.promise } freshStarted.resolve(); return freshQuote.promise },
  })
  const before = ctx.state.refresh(); await oldStarted.promise
  ctx.state.handleIdentityUploadState({ assetId: 1201, versionId: 812, blocked: true }); uploaded = true
  await ctx.state.handleIdentitySaved({ assetId: 1201, versionId: 812, isCurrent: () => true, complete() {
    ctx.state.handleIdentityUploadState({ assetId: 1201, versionId: 812, blocked: false })
  } })
  assert.equal(ctx.state.batchQuote.value, null)
  const after = ctx.state.handleIdentitySaved(); await freshStarted.promise
  freshQuote.resolve({ priced: true, total_credits: 8, quote_hash: 'after-upload', blocked: [], items: [{ asset_id: 1203, credits: 8 }] })
  await after
  oldQuote.resolve({ priced: true, total_credits: 16, quote_hash: 'before-upload', blocked: [], items: [{ asset_id: 1201, credits: 8 }, { asset_id: 1203, credits: 8 }] })
  await before
  assert.equal(ctx.state.assets.value[0].updated_at, uploadedRow().updated_at)
  assert.equal(ctx.state.batchQuote.value.quote_hash, 'after-upload')
})

test('批次等待报价期间上传冻结且同范围新报价恢复 context，旧 handler 必须静默终止且零提交', async (t) => {
  const oldQuote = defer(), freshQuote = defer(), freshStarted = defer(); let quoteCalls = 0
  const quote = hash => ({ priced: true, total_credits: 8, quote_hash: hash, blocked: [], items: [{ asset_id: 1201, credits: 8 }] })
  const ctx = stepRuntime(t, { listAssets: () => [row({ status: 'draft' })],
    getAssetQuote: () => ({ priced: true, credits: 8, quote_hash: 'single-current' }),
    quoteAssetBatch: () => { if (++quoteCalls === 1) return oldQuote.promise; freshStarted.resolve(); return freshQuote.promise },
    createAssetBatch: () => { throw new Error('fixture rejects unexpected batch submission') },
  })
  ctx.state.batchQuote.value = quote('before-upload')
  const submitting = ctx.state.startAssetBatch()
  ctx.state.handleIdentityUploadState({ assetId: 1201, versionId: 812, blocked: true })
  const refreshing = ctx.state.refresh(); await freshStarted.promise
  oldQuote.resolve(quote('before-upload')); await submitting
  freshQuote.resolve(quote('after-upload')); await refreshing
  assert.equal(ctx.state.identityUploadsBlocked.value, true)
  assert.equal(ctx.calls.filter(call => call[0] === 'createAssetBatch').length, 0)
  assert.equal(ctx.state.batchIdempotencyKey.value, null)
  assert.deepEqual(ctx.messages, [], '旧 handler 即使拿到 null 报价也不能冒出重新确认或成功消息')
})
