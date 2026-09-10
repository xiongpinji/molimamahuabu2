import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

const panelPath = new URL('../src/components/redraw/RedrawExecutionPlanReviewPanel.vue', import.meta.url)
const source = existsSync(panelPath) ? readFileSync(panelPath, 'utf8') : ''
const hash = 'a'.repeat(64)
const record = { version_id: 10, blueprint_hash: 'b'.repeat(64), localization_hash: 'c'.repeat(64), updated_at: 'review-1' }
function document(versionId = 10) {
  return { preview: { schema_version: 'redraw-execution-plan-preview-v1', status: 'ready', executable: false,
    plan_hash: hash, bindings: { version_id: versionId, blueprint_hash: record.blueprint_hash,
      localization_hash: record.localization_hash, localization_updated_at: record.updated_at, locale: 'en-US', market: 'US' },
    capability: { model: 'fixture-video', audio_mode: 'native', resolutions: ['480p'], aspect_ratios: ['9:16'] },
    blocking_reasons: [], execution_blockers: ['PREVIEW_ONLY', 'REFERENCE_ASSETS_NOT_VERIFIED', 'TARGET_REGION_AUDIO_NOT_VERIFIED'],
    units: [{ id: 'unit-1', source_start_ms: 0, source_end_ms: 12000, retained_duration_ms: 12000,
      generated_duration_ms: 15000, padding_ms: 3000, parent_shots: [{id: 'shot-a'}, {id: 'shot-b'}],
      dialogues: [{ id: 'turn-a', start_ms: 2500, end_ms: 4700, source_text: '等等我。', target_text: 'Wait for me.' }],
      reference_requirements: [{id: 'identity-a', kind: 'image', requirement_hash: 'd'.repeat(64)}] }] }, saved_review: null }
}
function deferred() { let resolve; let reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const tick = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }

function runtime(t, api = {}) {
  assert.ok(source, 'execution plan review panel must exist')
  const scope = vue.effectScope()
  const unmount = []
  const calls = []
  const bindings = {
    RedrawUnitReferenceMaterialsPanel: {},
    RedrawExecutionRunPanel: {},
    ref: vue.ref, computed: vue.computed, watch: vue.watch,
    onUnmounted: (callback) => unmount.push(callback),
    redrawAPI: {
      getExecutionPlanReview: async () => document(),
      saveExecutionPlanReview: async (id, body) => { calls.push({id, body}); return { ...document(id), saved_review: {id:1, status:'current', plan_hash:hash, saved_at:'now'} } },
      ...api,
    },
  }
  const { descriptor } = parse(source)
  const script = compileScript(descriptor, { id:'execution-review-test' }).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
  const component = new Function(...Object.keys(bindings), script)(...Object.values(bindings))
  const props = vue.reactive({ record: structuredClone(record), blocked: false })
  const state = scope.run(() => component.setup(props, { expose() {}, emit() {} }))
  t.after(() => { unmount.forEach((fn) => fn()); scope.stop() })
  return { state, props, calls, dispose: () => { unmount.forEach((fn) => fn()); scope.stop() } }
}

test('plan review displays full dialogue, source/generated durations and explicit non-execution scope', async (t) => {
  const {state, calls} = runtime(t); await tick()
  assert.equal(state.preview.value.units[0].dialogues[0].start_ms, 2500)
  assert.equal(state.canSave.value, false)
  await state.save(); assert.equal(calls.length, 0)
  state.confirmedHash.value = hash
  assert.equal(state.canSave.value, true)
  await state.save()
  assert.deepEqual(calls, [{id:10, body:{expected_plan_hash:hash}}])
  assert.equal(state.savedReview.value.status, 'current')
  assert.equal(state.preview.value.executable, false)
  assert.equal(state.canSave.value, false)
  for (const text of ['source_start_ms', 'retained_duration_ms', 'generated_duration_ms', 'padding_ms', 'target_text', 'source_text', 'reference_requirements']) assert.ok(source.includes(text), text)
  assert.match(source, /保存不启动生成/)
})

test('unsaved localization clears approval and stale in-flight read cannot re-enable saving', async (t) => {
  const pending = deferred(); const {state, props, calls} = runtime(t, { getExecutionPlanReview: () => pending.promise })
  props.blocked = true; await tick()
  pending.resolve(document()); await tick()
  assert.equal(state.preview.value, null)
  state.confirmedHash.value = hash; await state.save()
  assert.equal(calls.length, 0)
  props.blocked = false; await tick()
  assert.equal(state.confirmedHash.value, '')
  assert.equal(state.canSave.value, false)
})

test('switching version discards late read and resets checked approval', async (t) => {
  const old = deferred(); const newer = deferred()
  const {state, props} = runtime(t, { getExecutionPlanReview: (id) => id === 10 ? old.promise : newer.promise })
  props.record = {...record, version_id:11}; await tick()
  newer.resolve(document(11)); await tick()
  state.confirmedHash.value=hash
  old.resolve(document()); await tick()
  assert.equal(state.preview.value.bindings.version_id, 11)
  assert.equal(state.canSave.value, true)
})

test('loaded server localization differing from displayed record requires refresh before confirmation', async (t) => {
  const next = document(); next.preview.bindings.localization_hash='e'.repeat(64)
  const {state,calls}=runtime(t,{ getExecutionPlanReview:async()=>next }); await tick()
  state.confirmedHash.value=hash; await state.save()
  assert.equal(state.canSave.value,false); assert.equal(calls.length,0)
  assert.ok(state.error.value.includes('本地化'))
})

test('blocked preview or invalid stored snapshot never appears approved', async (t) => {
  const next=document(); next.preview.status='blocked'; next.preview.units=[]
  next.preview.blocking_reasons=[{code:'AUDIO_CAPABILITY_UNAVAILABLE'}]
  next.saved_review={id:2,status:'invalid',plan:null,plan_hash:hash,saved_at:'old'}
  const {state,calls}=runtime(t,{getExecutionPlanReview:async()=>next}); await tick()
  state.confirmedHash.value=hash; await state.save()
  assert.equal(state.canSave.value,false); assert.equal(calls.length,0)
  assert.equal(state.savedReview.value.status,'invalid')
})

test('double click is one save, upstream edit during save discards late success', async (t) => {
  const pending=deferred(); let count=0
  const {state,props}=runtime(t,{saveExecutionPlanReview:()=>{count++; return pending.promise}}); await tick()
  state.confirmedHash.value=hash
  const first=state.save(); await state.save(); assert.equal(count,1)
  props.blocked=true; await tick()
  pending.resolve({...document(),saved_review:{id:1,status:'current',plan_hash:hash}}); await first
  assert.equal(state.preview.value,null); assert.equal(state.confirmedHash.value,'')
})

for(const status of [409,500]) test(`save failure ${status} revokes confirmation without automatic retry`, async(t)=>{
  let count=0; const {state}=runtime(t,{saveExecutionPlanReview:async()=>{count++; throw {response:{status}}}}); await tick()
  state.confirmedHash.value=hash; await state.save(); await state.save()
  assert.equal(count,1); assert.equal(state.confirmedHash.value,''); assert.equal(state.canSave.value,false)
  assert.ok(state.error.value)
})

test('refresh failure removes prior success', async(t)=>{
  let count=0; const {state}=runtime(t,{getExecutionPlanReview:async()=>{if(count++) throw Error('network'); return document()}}); await tick()
  state.confirmedHash.value=hash; await state.load()
  assert.equal(state.preview.value,null); assert.equal(state.confirmedHash.value,''); assert.equal(state.canSave.value,false)
})

test('component unmount rejects late read and late save results', async(t)=>{
  const read=deferred()
  const first=runtime(t,{getExecutionPlanReview:()=>read.promise})
  first.dispose(); read.resolve(document()); await tick()
  assert.equal(first.state.preview.value,null)
  const pending=deferred()
  const second=runtime(t,{saveExecutionPlanReview:()=>pending.promise}); await tick()
  second.state.confirmedHash.value=hash
  const save=second.state.save(); second.dispose()
  pending.resolve({...document(),saved_review:{id:1,status:'current',plan_hash:hash}}); await save
  assert.equal(second.state.savedReview.value,null)
})

test('localization embeds review with dirty/busy guard and API only sends expected hash', () => {
  const parent=readFileSync(new URL('../src/components/redraw/RedrawLocalizationReviewPanel.vue',import.meta.url),'utf8')
  assert.match(parent, /<RedrawExecutionPlanReviewPanel[\s\S]*?:record="record"[\s\S]*?:blocked="blocked \|\| dirty \|\| saving \|\| locking"/)
  const apiSource=readFileSync(new URL('../src/api/redraw.js',import.meta.url),'utf8')
  const requests=[]
  const evaluated=apiSource.replace(/^import .*$/gm,'').replace(/export /g,'')+'\nreturn redrawAPI;'
  const api=new Function('request',evaluated)({get:(...args)=>requests.push(['get',...args]),post:(...args)=>requests.push(['post',...args])})
  api.getExecutionPlanReview(10); api.saveExecutionPlanReview(10,{expected_plan_hash:hash,model:'injected',plan:{executable:true}})
  assert.equal(requests[0][1],'/redraw/versions/10/execution-plan/review')
  assert.deepEqual(requests[1][2],{expected_plan_hash:hash})
})

function localizationRuntime(t, pending) {
  const parent = readFileSync(new URL('../src/components/redraw/RedrawLocalizationReviewPanel.vue', import.meta.url), 'utf8')
  const scope=vue.effectScope(); const events=[]; const cleanups=[]
  const bindings={ ref:vue.ref, computed:vue.computed, watch:vue.watch, onUnmounted:fn=>cleanups.push(fn),
    ElMessage:{error(){},success(){}}, RedrawExecutionPlanReviewPanel:{}, redrawAPI:{saveLocalization:()=>pending.promise} }
  const script=compileScript(parse(parent).descriptor,{id:'localization-save-binding-test'}).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g,'').replace('export default','return')
  const component=new Function(...Object.keys(bindings),script)(...Object.values(bindings))
  const props=vue.reactive({record:{...record,localization:{locale:'en-US',character_name_map:{lead:'Alex'},review:{}}},blueprint:null})
  const state=scope.run(()=>component.setup(props,{expose(){},emit:(...args)=>events.push(args)}))
  t.after(()=>{cleanups.forEach(fn=>fn());scope.stop()})
  return {state,props,events}
}
test('localization save cannot overwrite a newer edit and thereby approve the wrong plan',async(t)=>{
  const pending=deferred(); const {state,props,events}=localizationRuntime(t,pending)
  state.draft.value.character_name_map.lead='Blake'
  const saving=state.save()
  state.draft.value.character_name_map.lead='Casey'
  pending.resolve({...props.record,localization:{...props.record.localization,character_name_map:{lead:'Blake'}}})
  await saving
  assert.equal(state.draft.value.character_name_map.lead,'Casey')
  assert.equal(events.length,0); assert.ok(state.conflictMessage.value)
})
test('late localization save from old version never changes current record or emits updated',async(t)=>{
  const pending=deferred(); const {state,props,events}=localizationRuntime(t,pending)
  const old=structuredClone(vue.toRaw(props.record))
  state.draft.value.character_name_map.lead='Blake'; const saving=state.save()
  props.record={...old,version_id:11}; await tick()
  pending.resolve({...old,localization:{...old.localization,character_name_map:{lead:'Blake'}}}); await saving
  assert.equal(state.draft.value.character_name_map.lead,'Alex'); assert.equal(events.length,0)
})
