'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { fixture, hash } = require('./helpers/redrawUnitReferenceDerivationFixture');
const materials = require('../src/services/redrawUnitReferenceDerivationService');
const runs = require('../src/services/redrawExecutionRunService');
const { hashPlanValue } = require('../src/services/redrawExecutionPlanService');
const { canonicalModel } = require('../src/services/modelPriceService');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const parameters = { resolution: '480p', aspect_ratio: '16:9' };
const rejected = error => /^(?:EXECUTION_|REDRAW_|SOURCE_|BLUEPRINT_|LOCALIZATION_)/.test(error.code || '');
const changes = db => db.prepare('SELECT total_changes() n').get().n;
const attemptRows = h => h.db.prepare('SELECT * FROM redraw_execution_unit_attempts ORDER BY id').all();
const runRow = h => h.db.prepare('SELECT * FROM redraw_execution_runs WHERE id = ?').get(h.run.id);
const state = h => ({ run: runRow(h), attempts: attemptRows(h) });
const entry = name => { assert.equal(typeof runs[name], 'function', name + ' must be implemented'); return runs[name]; };
const inspect = (h, input = { output_parameters: parameters }, ctx = h.ctx) => entry('inspectExecutionRunReadiness')(ctx, h.versionId, h.run.id, input);
const claim = (h, input, ctx = h.ctx) => entry('claimNextUnit')(ctx, h.versionId, h.run.id, input);
const request = ready => ({ expected_revision: ready.revision, expected_plan_hash: ready.plan_hash,
  expected_quote_hash: ready.quote_hash, output_parameters: ready.output_parameters });
async function prepare(h, index) {
  return materials.prepareUnitReferenceMaterials(h.ctx, { ...h.expected(index), expected_materials_hash: (await h.materials(index)).materials_hash });
}
async function setup(t, prepared = true) {
  const h = await fixture(t);
  h.ctx.env = {};
  h.db.prepare("UPDATE ai_service_configs SET api_key='synthetic-claim-key',base_url='https://claim.synthetic.invalid' WHERE id=41").run();
  h.model = canonicalModel(h.queueState.saved_review.plan.capability.model);
  h.db.prepare(`INSERT INTO model_credit_prices(model,display_name,category,credits,pricing_mode,status,billing_unit,updated_at)
    VALUES (?,'synthetic local claim','video',3,'paid','enabled','second','2026-09-07T00:00:00.000Z')
    ON CONFLICT(model) DO UPDATE SET category='video',credits=3,pricing_mode='paid',status='enabled',billing_unit='second'`).run(h.model);
  h.db.prepare('DELETE FROM model_resolution_prices WHERE model=?').run(h.model);
  h.run = runs.createExecutionRun(h.ctx, h.versionId, { expected_plan_hash: h.expected(0).plan_hash, expected_queue_id: h.expected(0).queue_id });
  if (prepared) h.prepared = await prepare(h, 0);
  return h;
}
async function branch(h, action) {
  h.db.exec('SAVEPOINT claim_case');
  try { return await action(); } finally { h.db.pragma('query_only=OFF'); h.db.exec('ROLLBACK TO claim_case; RELEASE claim_case'); }
}
// Deliberately unchecked storage labels: never authoritative candidate/review evidence.
// The real first -> review -> next claim/CAS positive control is in redrawExecutionUnitReview.test.js.
function approveSynthetic(h, id) {
  const ref = h.prepared.references[0];
  h.db.prepare(`UPDATE redraw_execution_unit_attempts SET status='approved',output_asset_id=?,output_sha256=?,
    candidate_hash=?,quality_json=?,approved_by='synthetic-reviewer',approved_at='2026-09-07T01:00:00.000Z' WHERE id=?`)
    .run(ref.asset_id,ref.sha256,hashPlanValue({ synthetic: id }),JSON.stringify({ synthetic_authoritative_state: true }),id);
  h.db.prepare("UPDATE redraw_execution_runs SET status='running' WHERE id=?").run(h.run.id);
}

test('readiness is a real prepared-material read, zero DML on query_only and readonly connections, with two independent hashes', async t => {
  const h = await setup(t), before = state(h), count = changes(h.db);
  const reader = new Database(h.db.name, { readonly: true, fileMustExist: true });
  try {
    h.db.pragma('query_only=ON');
    const ready = await inspect(h), again = await inspect(h, { output_parameters: parameters }, { ...h.ctx, db: reader });
    assert.equal(ready.status, 'ready'); assert.equal(ready.executable, false); assert.deepEqual(again, ready);
    assert.equal(ready.unit.id, h.expected(0).unit_id);
    assert.equal(ready.unit.queue_unit_id, h.db.prepare('SELECT id FROM redraw_execution_queue_units WHERE queue_id=? ORDER BY ordinal').get(h.run.queue_id).id);
    const { quote_hash: unitHash, ...unitBody } = ready.unit_quote;
    assert.equal(unitBody.schema_version, 'redraw-execution-unit-quote-v1');
    assert.equal(unitHash, hashPlanValue(unitBody)); assert.notEqual(ready.quote_hash, unitHash);
    assert.match(ready.readiness_hash, /^[a-f0-9]{64}$/); assert.match(ready.quote_hash, /^[a-f0-9]{64}$/);
    assert.equal(ready.unit_quote.units[0].amount, 15); assert.equal(ready.unit_quote.amount, 45);
    assert.doesNotMatch(JSON.stringify(ready), /synthetic-claim-key|https?:|private_binding|connection_fingerprint|claim_token|local_path/);
    assert.deepEqual(state(h), before); assert.equal(changes(h.db), count); assert.equal(changes(reader), 0);
    assert.equal(runs.getExecutionRun(h.ctx,h.versionId,h.run.id).executable,false);
    assert.ok(runs.getExecutionRun(h.ctx,h.versionId,h.run.id).execution_blockers.includes('EXECUTION_RUN_STORAGE_ONLY'));
  } finally { reader.close(); h.db.pragma('query_only=OFF'); }
});

test('new interfaces reject nonnumeric IDs, foreign owner and extra fields without writing', async t => {
  const h = await setup(t), ready = await inspect(h), input = request(ready), before = state(h), count = changes(h.db);
  for (const value of [String(h.versionId), true, 0, -1, 1.5]) {
    await assert.rejects(entry('inspectExecutionRunReadiness')(h.ctx,value,h.run.id,{ output_parameters: parameters }),rejected);
    await assert.rejects(entry('claimNextUnit')(h.ctx,h.versionId,value,input),rejected);
  }
  for (const extra of [{ model:'client-model' },{ [Symbol('hidden')]:true }]) {
    await assert.rejects(inspect(h,{ output_parameters:parameters,...extra }),rejected);
    await assert.rejects(claim(h,{ ...input,...extra }),rejected);
  }
  await assert.rejects(inspect(h,Object.assign(Object.create({ inherited:true }),{ output_parameters:parameters })),rejected);
  await assert.rejects(inspect(h,{ output_parameters:{ ...parameters,key:'client' } }),rejected);
  await assert.rejects(inspect(h,{}, { ...h.ctx,userId:'foreign' }),rejected);
  await assert.rejects(claim(h,input,{ ...h.ctx,tenantId:'foreign' }),rejected);
  assert.deepEqual(state(h),before); assert.equal(changes(h.db),count);
});

test('first parameters are mandatory and missing preparation, selected credential, or pricing cannot issue a confirmation', async t => {
  const h = await setup(t,false);
  const absent = await inspect(h,{}); assert.equal(absent.status,'blocked'); assert.equal(Object.hasOwn(absent,'quote_hash'),false);
  const pending = await inspect(h); assert.equal(pending.status,'blocked'); assert.equal(Object.hasOwn(pending,'quote_hash'),false);
  h.prepared=await prepare(h,0);
  const ready = await inspect(h), input=request(ready);
  for (const [name,mutate] of [
    ['missing price',()=>h.db.prepare('DELETE FROM model_credit_prices WHERE model=?').run(h.model)],
    ['missing selected credential',()=>h.db.prepare("UPDATE ai_service_configs SET api_key='' WHERE id=41").run()],
  ]) await t.test(name,()=>branch(h,async()=>{
    mutate(); const before=state(h),count=changes(h.db),result=await inspect(h);
    assert.equal(result.status,'blocked'); assert.equal(Object.hasOwn(result,'quote_hash'),false);
    await assert.rejects(claim(h,input),rejected); assert.deepEqual(state(h),before); assert.equal(changes(h.db),count);
  }));
  const noParams={...input}; delete noParams.output_parameters;
  await assert.rejects(claim(h,noParams),rejected); assert.equal(runRow(h).output_parameters_json,null);
});

test('first claim atomically freezes parameters and one paid or no-charge attempt; exact replay never probes or resumes', async t => {
  const h=await setup(t);
  for(const mode of ['paid','free']) await t.test(mode,()=>branch(h,async()=>{
    h.db.prepare('UPDATE model_credit_prices SET pricing_mode=?,credits=? WHERE model=?').run(mode,mode==='free'?0:3,h.model);
    const ready=await inspect(h),input=request(ready),result=await claim(h,input);
    assert.equal(result.newly_claimed,true); assert.equal(result.status,'claimed');
    const row=attemptRows(h)[0],run=runRow(h);
    assert.equal(attemptRows(h).length,1); assert.equal(row.attempt_no,1); assert.equal(row.readiness_hash,ready.readiness_hash);
    assert.equal(row.quote_hash,ready.quote_hash); assert.equal(row.quoted_amount,mode==='free'?0:15);
    assert.equal(row.billing_mode,mode==='free'?'no_charge':'paid'); assert.equal(row.reservation_id,null); assert.equal(row.task_id,null);
    assert.ok(row.claim_token.length>=32); assert.equal(run.revision,1); assert.equal(run.status,'running');
    assert.deepEqual(JSON.parse(run.output_parameters_json),parameters); assert.equal(run.output_parameters_hash,hashPlanValue(parameters));
    const originalOpen=fs.promises.open;
    fs.promises.open=async()=>assert.fail('exact replay must not open/probe materials');
    try {
      for(const status of ['claimed','needs_attention','failed','waiting_review']) {
        h.db.prepare('UPDATE redraw_execution_unit_attempts SET status=? WHERE id=?').run(status,row.id);
        h.db.prepare("UPDATE redraw_execution_runs SET status='paused',pause_requested=1,revision=revision+7 WHERE id=?").run(h.run.id);
        const count=changes(h.db),before=state(h),omit={...input}; delete omit.output_parameters;
        assert.deepEqual(await claim(h,omit),{ attempt_id:row.id,status,newly_claimed:false });
        assert.deepEqual(state(h),before); assert.equal(changes(h.db),count);
      }
    } finally {fs.promises.open=originalOpen;}
    for(const altered of [{ expected_revision:1 },{ expected_revision:77 },{ expected_quote_hash:'f'.repeat(64) },
      { expected_plan_hash:'e'.repeat(64) },{ output_parameters:{resolution:'720p',aspect_ratio:'16:9'} }]) {
      const before=state(h); await assert.rejects(claim(h,{...input,...altered}),rejected); assert.deepEqual(state(h),before);
    }
    assert.doesNotMatch(JSON.stringify(result),/claim_token|quote_hash|reservation_id|provider/);
  }));
});

test('changed price or selected connection invalidates the old confirmation without fallback or writes', async t => {
  const h=await setup(t),ready=await inspect(h),input=request(ready);
  for(const [name,mutate] of [
    ['price',()=>h.db.prepare('UPDATE model_credit_prices SET credits=4 WHERE model=?').run(h.model)],
    ['connection',()=>h.db.prepare("UPDATE ai_service_configs SET api_key='synthetic-changed-key' WHERE id=41").run()],
  ]) await t.test(name,()=>branch(h,async()=>{
    mutate();const next=await inspect(h),before=state(h),count=changes(h.db);
    assert.equal(next.status,'ready');assert.notEqual(next.readiness_hash,ready.readiness_hash);assert.notEqual(next.quote_hash,ready.quote_hash);
    await assert.rejects(claim(h,input),rejected);assert.deepEqual(state(h),before);assert.equal(changes(h.db),count);
  }));
  await branch(h,async()=>{
    const alternate=h.db.prepare('SELECT * FROM ai_service_configs WHERE id=41').get();alternate.id=141;
    const settings=JSON.parse(alternate.settings);settings.redraw_locale_capabilities[0].evidence.video.config_id=141;
    alternate.settings=JSON.stringify(settings);const keys=Object.keys(alternate);
    h.db.prepare(`INSERT INTO ai_service_configs(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>alternate[key]));
    h.db.prepare('UPDATE ai_service_configs SET canary_paused=1 WHERE id=41').run();
    const before=state(h),count=changes(h.db);const blocked=await inspect(h);
    assert.equal(blocked.status,'blocked');await assert.rejects(claim(h,input),rejected);
    assert.deepEqual(state(h),before);assert.equal(changes(h.db),count);
    assert.equal(h.db.prepare('SELECT canary_paused FROM ai_service_configs WHERE id=41').get().canary_paused,1);
  });
});

test('paused, failed, unknown, waiting review, active attempts and synthetic approvals block successors', async t => {
  const h=await setup(t),ready=await inspect(h),input=request(ready);
  for(const status of ['paused','failed','needs_attention','waiting_review','stale','completed']) await t.test('run '+status,()=>branch(h,async()=>{
    h.db.prepare('UPDATE redraw_execution_runs SET status=? WHERE id=?').run(status,h.run.id);
    const before=state(h);assert.equal((await inspect(h)).status,'blocked');await assert.rejects(claim(h,input),rejected);assert.deepEqual(state(h),before);
  }));
  await branch(h,async()=>{
    h.db.prepare('UPDATE redraw_execution_runs SET pause_requested=1 WHERE id=?').run(h.run.id);
    assert.equal((await inspect(h)).status,'blocked');await assert.rejects(claim(h,input),rejected);
  });
  const first=await claim(h,input);await prepare(h,1);
  for(const status of ['claimed','submitting','running','waiting_review','rejected','failed','needs_attention']) await t.test('attempt '+status,()=>branch(h,async()=>{
    h.db.prepare('UPDATE redraw_execution_unit_attempts SET status=? WHERE id=?').run(status,first.attempt_id);
    assert.equal((await inspect(h,{})).status,'blocked');
  }));
  h.db.prepare("UPDATE redraw_execution_unit_attempts SET status='approved' WHERE id=?").run(first.attempt_id);
  assert.equal((await inspect(h,{})).status,'blocked','a bare approved label is not a complete authoritative review record');
  approveSynthetic(h,first.attempt_id);
  const before=state(h);assert.equal((await inspect(h,{})).status,'blocked');
  await assert.rejects(claim(h,{...input,expected_revision:runRow(h).revision}),rejected);assert.deepEqual(state(h),before);
});

test('last cleanup await and post-insert drift reject; parameter, attempt and run CAS changes all roll back', async t => {
  const h=await setup(t),ready=await inspect(h),input=request(ready),originalOpen=fs.promises.open;
  const candidate=path.resolve(h.root,h.db.prepare('SELECT local_path FROM assets WHERE id=?').get(h.processed[0].imported.asset.id).local_path);
  await branch(h,async()=>{
    let changed=false;
    fs.promises.open=async function(file,...args){const handle=await originalOpen.call(this,file,...args);
      if(path.resolve(String(file))===candidate){const close=handle.close.bind(handle);handle.close=async()=>{const result=await close();
        if(!changed){changed=true;h.db.prepare("UPDATE redraw_assets SET approval_status='pending' WHERE id=205").run();}return result;};}return handle;};
    try {await assert.rejects(claim(h,input),rejected);assert.equal(changed,true);assert.equal(attemptRows(h).length,0);assert.equal(runRow(h).output_parameters_json,null);}
    finally {fs.promises.open=originalOpen;}
  });
  for(const [name,statement] of [
    ['price',"UPDATE model_credit_prices SET credits=4 WHERE category='video'"],
    ['selected',"UPDATE ai_service_configs SET api_key='synthetic-drift-during-transaction' WHERE id=41"],
    ['approval',"UPDATE redraw_assets SET approval_status='pending' WHERE id=205"],
    ['explicit failure',"SELECT RAISE(ABORT,'synthetic-claim-write-failure')"],
  ]) await t.test(name,()=>branch(h,async()=>{
    h.db.exec(`CREATE TEMP TRIGGER claim_drift AFTER INSERT ON redraw_execution_unit_attempts BEGIN ${statement}; END`);
    const before=state(h),price=h.db.prepare('SELECT credits FROM model_credit_prices WHERE model=?').get(h.model);
    await assert.rejects(claim(h,input));assert.deepEqual(state(h),before);
    assert.deepEqual(h.db.prepare('SELECT credits FROM model_credit_prices WHERE model=?').get(h.model),price);
    assert.equal(runRow(h).output_parameters_json,null);
  }));
});

function absoluteBinary(binary) {
  if(path.isAbsolute(binary)) return binary;
  const file=(process.env.PATH||'').split(path.delimiter).map(directory=>path.join(directory,binary)).find(candidate=>fs.existsSync(candidate));
  assert.ok(file,'test requires an explicit existing local media binary');return path.resolve(file);
}
test('revision-only changes preserve semantic readiness', async t => {
  const h = await setup(t), first = await inspect(h), oldInput = request(first);
  h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+2 WHERE id=?').run(h.run.id);
  const next = await inspect(h);
  assert.equal(next.readiness_hash, first.readiness_hash, 'revision belongs to confirmation CAS, not semantic readiness');
  assert.notEqual(next.quote_hash, first.quote_hash);
  assert.equal(next.revision, 2);
  const count = changes(h.db), before = state(h);
  await assert.rejects(claim(h, oldInput), rejected);
  assert.deepEqual(state(h), before); assert.equal(changes(h.db), count);
  const input = request(next), result = await claim(h, input);
  assert.equal(attemptRows(h)[0].readiness_hash, first.readiness_hash);
  const originalOpen = fs.promises.open;
  fs.promises.open = async () => assert.fail('exact replay after revision changes must not probe');
  try {
    for (let index = 0; index < 2; index += 1) {
      h.db.prepare("UPDATE redraw_execution_runs SET revision=revision+7,status='paused',pause_requested=1 WHERE id=?").run(h.run.id);
      const replayCount = changes(h.db), replayState = state(h);
      assert.deepEqual(await claim(h, input), { attempt_id: result.attempt_id, status: 'claimed', newly_claimed: false });
      assert.equal((await inspect(h, {})).status, 'blocked');
      assert.deepEqual(state(h), replayState); assert.equal(changes(h.db), replayCount);
    }
  } finally { fs.promises.open = originalOpen; }
});
function child(t,h,input) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'g4-claim-child-'));
  const env={TEMP:cwd,TMP:cwd,TMPDIR:cwd,NODE_ENV:'test',NODE_OPTIONS:'',PATH:'',
    FFMPEG_PATH:absoluteBinary(getFfmpegPath()),FFPROBE_PATH:absoluteBinary(getFfprobePath())};
  if(process.platform==='win32')for(const name of ['SystemRoot','WINDIR'])if(process.env[name])env[name]=process.env[name];
  const preload=path.join(__dirname,'helpers/redrawExecutionChildPreload.cjs');
  assert.equal(hash(fs.readFileSync(preload)),'4d918353b528d3457433734cdc3c5cbf1b01442cd186f3e4edb3acb57e23942e');
  const payload={databaseFile:h.db.name,storageRoot:h.root,versionId:h.versionId,runId:h.run.id,input};
  const proc=spawn(process.execPath,['--require',preload,path.join(__dirname,'helpers/redrawExecutionClaimChild.cjs'),JSON.stringify(payload)],
    {cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',buffer='',done=false;const messages=[],waiters=[];
  const timer=setTimeout(()=>{if(!done)proc.kill();},30000);
  const result=new Promise((resolve,reject)=>{
    proc.on('error',reject);proc.stdout.on('data',bytes=>{stdout+=bytes;buffer+=bytes;
      for(;;){const index=buffer.indexOf('\n');if(index<0)break;const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;
        const message=JSON.parse(line);messages.push(message);for(const waiter of [...waiters])if(waiter.type===message.type){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message);}}
    });proc.stderr.on('data',bytes=>{stderr+=bytes;});proc.on('close',(code,signal)=>{
      done=true;clearTimeout(timer);for(const waiter of waiters)waiter.reject(new Error('child ended before '+waiter.type+': '+stdout+' '+stderr));
      const prefix=path.join(process.env.G4_CLAIM_EVIDENCE_DIR||cwd,path.basename(cwd));
      fs.writeFileSync(prefix+'.stdout.jsonl',stdout,{flag:'wx'});fs.writeFileSync(prefix+'.stderr.txt',stderr,{flag:'wx'});
      fs.writeFileSync(prefix+'.native.json',JSON.stringify({code,signal,cwd,environment_names:Object.keys(env).sort()}),{flag:'wx'});
      resolve({code,signal,messages,stderr});
    });
  });
  t.after(async()=>{if(!done)proc.kill();await result;});
  return {result,wait:type=>{const message=messages.find(value=>value.type===type);return message?Promise.resolve(message):new Promise((resolve,reject)=>waiters.push({type,resolve,reject}));}};
}
test('two guarded real child processes contend on a real WAL lock and produce one claim and one exact replay', async t=>{
  const h=await setup(t),ready=await inspect(h),input=request(ready);
  assert.equal(h.db.pragma('journal_mode=WAL',{simple:true}),'wal');h.db.exec('BEGIN IMMEDIATE');
  const a=child(t,h,input),b=child(t,h,input);
  try {
    const barriers=await Promise.all([a.wait('claim_transaction_waiting'),b.wait('claim_transaction_waiting')]);
    assert.ok(barriers.every(value=>value.contention==='SQLITE_BUSY'&&value.initial_attempts===0&&value.probes>=3),JSON.stringify(barriers));
  }
  finally {h.db.exec('COMMIT');}
  const results=await Promise.all([a.result,b.result]);
  assert.deepEqual(results.map(value=>value.code),[0,0],JSON.stringify(results));
  const claims=results.map(value=>value.messages.find(message=>message.type==='result').result);
  assert.deepEqual(claims.map(value=>value.newly_claimed).sort(),[false,true]);assert.equal(claims[0].attempt_id,claims[1].attempt_id);
  assert.equal(attemptRows(h).length,1);assert.equal(runRow(h).revision,1);
  assert.ok(results.every(value=>value.messages.find(message=>message.type==='started').guard_count===11));
});
