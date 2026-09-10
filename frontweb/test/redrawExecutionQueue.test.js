import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

const source = readFileSync(new URL('../src/components/redraw/RedrawExecutionPlanReviewPanel.vue', import.meta.url), 'utf8')
const hash = 'a'.repeat(64)
const record = {version_id:10,blueprint_hash:'b'.repeat(64),localization_hash:'c'.repeat(64),updated_at:'saved-1'}
function document(versionId = 10) {
  const unit = {id:'unit-1',source_start_ms:0,source_end_ms:12000,retained_duration_ms:12000,
    generated_duration_ms:15000,padding_ms:3000,parent_shots:[{id:'shot-a'},{id:'shot-b'}],dialogues:[],reference_requirements:[]}
  return {preview:{schema_version:'redraw-execution-plan-preview-v1',status:'ready',executable:false,plan_hash:hash,
    bindings:{...record,version_id:versionId,work_id:1,localization_updated_at:record.updated_at,locale:'en-US',market:'US'},
    capability:{model:'fixture',audio_mode:'native',resolutions:['480p'],aspect_ratios:['9:16']},units:[unit],
    execution_blockers:['PREVIEW_ONLY','REFERENCE_ASSETS_NOT_VERIFIED'],blocking_reasons:[]},
    saved_review:{id:4,status:'current',plan_hash:hash,saved_at:'saved'},queue:null}
}
function withQueue(versionId = 10, status = 'waiting_readiness') {
  const d = document(versionId)
  d.queue = {id:8,work_id:1,version_id:versionId,plan_hash:hash,status,executable:false,created_at:'created',
    execution_blockers:[...d.preview.execution_blockers],
    units:status==='invalid'?[]:d.preview.units.map((plan_unit,ordinal)=>({id:plan_unit.id,ordinal,status:'pending',unit_hash:'d'.repeat(64),plan_unit}))}
  return d
}
const tick=async()=>{await vue.nextTick();await Promise.resolve();await vue.nextTick()}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function runtime(t,api={}) {
  const scope=vue.effectScope(),unmount=[],calls=[]
  const bindings={RedrawUnitReferenceMaterialsPanel:{},RedrawExecutionRunPanel:{},ref:vue.ref,computed:vue.computed,watch:vue.watch,onUnmounted:fn=>unmount.push(fn),redrawAPI:{
    getExecutionPlanReview:async id=>document(id),getExecutionQueue:async id=>document(id),
    prepareExecutionQueue:async(id,body)=>{calls.push({id,body});return withQueue(id)},...api}}
  const script=compileScript(parse(source).descriptor,{id:'queue-test'}).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g,'').replace('export default','return')
  const component=new Function(...Object.keys(bindings),script)(...Object.values(bindings))
  const props=vue.reactive({record:structuredClone(record),blocked:false})
  const state=scope.run(()=>component.setup(props,{expose(){},emit(){}}))
  const dispose=()=>{unmount.forEach(fn=>fn());scope.stop()};t.after(dispose)
  return{state,props,calls,dispose}
}

test('reviewed plan can explicitly register pending units, never automatically generates',async t=>{
  const {state,calls}=runtime(t);await tick()
  assert.equal(state.canPrepareQueue?.value,true,'queue registration must be available after current review')
  assert.equal(calls.length,0)
  await state.prepareQueue()
  assert.deepEqual(calls,[{id:10,body:{expected_plan_hash:hash}}])
  assert.equal(state.queue.value.id,8)
  assert.equal(state.queue.value.executable,false)
  assert.equal(state.queue.value.units[0].status,'pending')
  assert.equal(state.queue.value.units[0].plan_unit.parent_shots.length,2)
  assert.equal(state.canPrepareQueue.value,false)
  assert.match(source,/登记执行队列（不生成）/)
  assert.match(source,/等待素材与执行条件就绪/)
})
test('refresh recovers the same queue using GET without new registration',async t=>{
  let reads=0;const {state,calls}=runtime(t,{getExecutionQueue:async()=>{reads++;return withQueue()}});await tick()
  assert.equal(state.queue?.value?.id,8)
  await state.load();await tick()
  assert.equal(state.queue.value.id,8);assert.equal(reads,2);assert.equal(calls.length,0)
})
test('server-blocked preview still reads and displays stale queue without enabling registration',async t=>{
  let blocked=false,reads=0
  const response=()=>{
    const d=withQueue(10,blocked?'stale':'waiting_readiness')
    if(blocked){d.preview.status='blocked';d.preview.units=[];d.preview.blocking_reasons=[{code:'VIDEO_CAPABILITY_UNAVAILABLE'}];d.saved_review.status='stale'}
    return d
  }
  const {state,calls}=runtime(t,{getExecutionPlanReview:async()=>response(),getExecutionQueue:async()=>{reads++;return response()}});await tick()
  assert.equal(state.queue.value.id,8);assert.equal(reads,1)
  blocked=true;await state.load();await tick()
  assert.equal(reads,2,'blocked server preview must still query registered history')
  assert.equal(state.queue.value.id,8);assert.equal(state.queue.value.status,'stale')
  assert.equal(state.queue.value.units.length,1);assert.equal(state.canPrepareQueue.value,false)
  await state.prepareQueue();assert.equal(calls.length,0)
  assert.doesNotMatch(source,/<div\s+v-if="preview\.status === 'ready'"\s+class="execution-queue"/)
})
for(const status of ['stale','invalid','missing'])test(`review ${status} cannot register`,async t=>{
  const d=document();d.saved_review=status==='missing'?null:{...d.saved_review,status}
  const {state,calls}=runtime(t,{getExecutionPlanReview:async()=>d,getExecutionQueue:async()=>d});await tick()
  assert.equal(state.canPrepareQueue?.value,false)
  await state.prepareQueue();assert.equal(calls.length,0)
})
test('invalid queue cannot register over corrupt history',async t=>{
  const {state,calls}=runtime(t,{getExecutionQueue:async()=>withQueue(10,'invalid')});await tick()
  assert.equal(state.canPrepareQueue?.value,false)
  await state.prepareQueue();assert.equal(calls.length,0)
})
test('double click registers once; edits invalidate late response',async t=>{
  const pending=deferred();let calls=0
  const {state,props}=runtime(t,{prepareExecutionQueue:()=>{calls++;return pending.promise}});await tick()
  assert.equal(typeof state.prepareQueue,'function')
  const first=state.prepareQueue();await state.prepareQueue();assert.equal(calls,1)
  props.blocked=true;await tick();pending.resolve(withQueue());await first
  assert.equal(state.queue.value,null);assert.equal(state.canPrepareQueue.value,false)
})
test('version switch ignores old queue read response',async t=>{
  const old=deferred();const {state,props}=runtime(t,{getExecutionQueue:id=>id===10?old.promise:Promise.resolve(withQueue(id))});await tick()
  assert.equal(state.queue?.value,null)
  props.record={...record,version_id:11};await tick();old.resolve(withQueue(10));await tick()
  assert.equal(state.queue.value.version_id,11)
})
test('version switch ignores old registration while retaining the new version queue',async t=>{
  const pending=deferred();let calls=0
  const {state,props}=runtime(t,{getExecutionQueue:id=>Promise.resolve(id===10?document(id):withQueue(id)),
    prepareExecutionQueue:()=>{calls++;return pending.promise}});await tick()
  const request=state.prepareQueue();assert.equal(calls,1)
  props.record={...record,version_id:11};await tick()
  assert.equal(state.queue.value.version_id,11)
  pending.resolve(withQueue(10));await request
  assert.equal(state.queue.value.version_id,11)
  assert.equal(state.queueSaving.value,false);assert.equal(state.canPrepareQueue.value,false)
})
for(const status of [409,500])test(`registration failure ${status} requires refresh, no auto retry`,async t=>{
  let count=0;const {state}=runtime(t,{prepareExecutionQueue:async()=>{count++;throw{response:{status}}}});await tick()
  assert.equal(typeof state.prepareQueue,'function')
  await state.prepareQueue();await state.prepareQueue()
  assert.equal(count,1);assert.equal(state.canPrepareQueue.value,false);assert.ok(state.queueError.value)
})
test('queue read failure or mismatched upstream hash cannot enable preparation',async t=>{
  for(const api of [{getExecutionQueue:async()=>{throw Error('offline')}},{getExecutionQueue:async()=>{
    const d=document();d.preview.plan_hash='e'.repeat(64);return d}}]){
    const {state,calls}=runtime(t,api);await tick()
    assert.equal(state.canPrepareQueue?.value,false)
    await state.prepareQueue();assert.equal(calls.length,0);assert.ok(state.queueError.value)
  }
})
test('unmount ignores a pending queue registration',async t=>{
  const pending=deferred();const {state,dispose}=runtime(t,{prepareExecutionQueue:()=>pending.promise});await tick()
  assert.equal(typeof state.prepareQueue,'function')
  const request=state.prepareQueue();dispose();pending.resolve(withQueue());await request
  assert.equal(state.queue.value,null)
})
test('queue API forwards only server-approved hash and fixed version path',()=>{
  const code=readFileSync(new URL('../src/api/redraw.js',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/export /g,'')+'\nreturn redrawAPI;'
  const calls=[];const api=new Function('request',code)({get:(...args)=>calls.push(['get',...args]),post:(...args)=>calls.push(['post',...args])})
  assert.equal(typeof api.prepareExecutionQueue,'function')
  api.getExecutionQueue(10);api.prepareExecutionQueue(10,{expected_plan_hash:hash,ready:true,key:'forbidden',plan:{}})
  assert.equal(calls[0][1],'/redraw/versions/10/execution-queue')
  assert.deepEqual(calls[1][2],{expected_plan_hash:hash})
})
