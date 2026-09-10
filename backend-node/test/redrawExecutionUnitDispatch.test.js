'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { setup, dispatch, readPublished, attemptRow, runRow, hash, KEY } = require('./helpers/redrawExecutionUnitDispatchFixture');

test('real reviewed unit pack, owned identity and motion bytes reach one marked POST, then exact replay is inert', async t => {
  const h = await setup(t);
  let posts = 0;
  let transportAssertion;
  const fetchImpl = (url, init) => (async () => {
    posts += 1;
    assert.equal(h.db.inTransaction, false, 'no SQLite transaction may cross actual transport');
    assert.equal(init.method, 'POST');
    assert.equal(url, 'https://video.dispatch.synthetic.invalid/api/v3/contents/generations/tasks');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    const attempt = attemptRow(h);
    assert.equal(attempt.status, 'submitting');
    assert.equal(attempt.request_hash, hash(Buffer.from(init.body, 'utf8')));
    assert.ok(Number.isFinite(Date.parse(attempt.submit_started_at)));
    assert.equal(attempt.task_id, h.binding.task_id);
    assert.equal(h.db.prepare('SELECT metadata FROM async_tasks WHERE id=?').get(attempt.task_id).metadata, h.taskMetadata);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'seedance-2.0-mini');
    assert.equal(body.duration * 1000, h.pack.timeline.generated_duration_ms);
    assert.equal(body.generate_audio, true);
    const prompt = body.content.find(value => value.type === 'text').text;
    for (const dialogue of h.pack.dialogues) {
      assert.ok(prompt.includes(dialogue.target_text), 'every full approved target sentence must reach the actual body');
      assert.ok(prompt.includes(dialogue.target_speaker_name));
      assert.ok(prompt.includes(String(dialogue.unit_start_ms)) && prompt.includes(String(dialogue.unit_end_ms)));
      assert.equal(prompt.includes(dialogue.source_text), false, 'source dialogue must not be sent');
    }
    for (const name of Object.values(h.pack.character_name_map)) assert.ok(prompt.includes(name));
    assert.equal(prompt.includes(h.root), false);
    const supplied = body.content.filter(value => value.type !== 'text');
    assert.deepEqual(supplied.map(value => value.type).sort(), ['image_url', 'image_url', 'video_url']);
    const expectedHashes = h.prepared.prepared_materials.references.map(value => value.sha256).sort();
    const actualHashes = [];
    for (const reference of supplied) {
      const media = await readPublished(h, reference[reference.type].url);
      assert.equal(media.status, 200, JSON.stringify(media.failure));
      assert.ok(media.bytes?.length > 0, 'the real provider handler must serve readable material bytes');
      actualHashes.push(hash(media.bytes));
      assert.notEqual(hash(media.bytes), h.sourceFingerprint, 'never publish the unapproved mother video');
      assert.equal(media.headers['Content-Type'], reference.type === 'image_url' ? 'image/png' : 'video/mp4');
    }
    assert.deepEqual(actualHashes.sort(), expectedHashes);
    return new Response(JSON.stringify({ id: 'synthetic-dispatch-job', status: 'queued' }), { status: 200 });
  })().catch(error => { transportAssertion = error; throw error; });
  const result = await dispatch(h, fetchImpl);
  assert.ifError(transportAssertion);
  assert.equal(posts, 1);
  assert.equal(result.status, 'running');
  assert.equal(result.executable, false);
  assert.doesNotMatch(JSON.stringify(result), /claim_token|api_key|local_path|synthetic-dispatch-video-key/);
  assert.equal(attemptRow(h).provider_task_id, 'synthetic-dispatch-job');
  assert.equal(h.db.prepare('SELECT provider_task_id FROM async_tasks WHERE id=?').get(h.binding.task_id).provider_task_id, 'synthetic-dispatch-job');
  assert.equal(attemptRow(h).approved_at, null);
  assert.equal(runRow(h).status, 'running');
  assert.equal(h.db.prepare("SELECT count(*) n FROM async_tasks WHERE type='redraw_execution_unit'").get().n, 1);
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n, 1);
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(attemptRow(h).reservation_id).status, 'held');
  const before = h.db.serialize();
  const replay = await dispatch(h, () => assert.fail('exact replay cannot POST, query or upload'));
  assert.equal(replay.newly_submitted, false);
  assert.deepEqual(h.db.serialize(), before, 'replay must be strictly read-only');
  assert.equal(posts, 1);
});

test('free execution creates no reservation and keeps one bound task', async t => {
  const h = await setup(t, 'free');
  const result = await dispatch(h, async () => new Response(JSON.stringify({ id: 'free-unit', status: 'running' }), { status: 200 }));
  assert.equal(result.status, 'running');
  assert.equal(attemptRow(h).reservation_id, null);
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n, 0);
  assert.equal(h.db.prepare("SELECT count(*) n FROM async_tasks WHERE type='redraw_execution_unit'").get().n, 1);
});

test('owner and stale confirmation cannot publish or submit the bound unit', async t => {
  const h = await setup(t);
  for (const [label, input, ctx] of [
    ['owner', h.input, { ...h.ctx, userId: 'another-user' }],
    ['revision', { ...h.input, expected_revision: h.input.expected_revision + 1 }, h.ctx],
    ['plan', { ...h.input, expected_plan_hash: '0'.repeat(64) }, h.ctx],
    ['quote', { ...h.input, expected_quote_hash: '0'.repeat(64) }, h.ctx],
  ]) await t.test(label, async () => {
    const before = h.db.serialize();
    const files = fs.readdirSync(path.join(h.root, 'redraw-conditioning')).sort();
    await assert.rejects(dispatch(h, () => assert.fail('invalid dispatch must never reach transport'), input, ctx));
    assert.deepEqual(h.db.serialize(), before);
    assert.deepEqual(fs.readdirSync(path.join(h.root, 'redraw-conditioning')).sort(), files);
    assert.equal(attemptRow(h).request_hash, null);
  });
});

test('pause during asynchronous publication blocks the final marker without refunding', async t => {
  const h = await setup(t);
  let changed = false;
  Object.defineProperty(h.ctx.providerAssets, 'nowMs', { enumerable: true, get() {
    if (!changed) {
      changed = true;
      h.db.prepare('UPDATE redraw_execution_runs SET pause_requested=1,revision=revision+1 WHERE id=?').run(h.run.id);
    }
    return Date.parse('2026-09-07T00:00:00.000Z');
  } });
  await assert.rejects(dispatch(h, () => assert.fail('paused publication must not POST')));
  assert.equal(changed, true);
  assert.equal(attemptRow(h).request_hash, null);
  assert.equal(attemptRow(h).submit_started_at, null);
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(attemptRow(h).reservation_id).status, 'held');
});

test('two real WAL connections contend for one final submission marker', async t => {
  const h = await setup(t);
  h.db.pragma('journal_mode=WAL');
  const other = new Database(path.join(h.root, 'fixture.sqlite')); other.pragma('busy_timeout=5000');
  const ctx = { ...h.ctx, db: other };
  let posts = 0;
  const fetchImpl = async () => {
    posts += 1;
    const committed = other.prepare('SELECT request_hash,submit_started_at FROM redraw_execution_unit_attempts WHERE id=?').get(h.attemptId);
    assert.match(committed.request_hash, /^[a-f0-9]{64}$/); assert.ok(committed.submit_started_at);
    return new Response(JSON.stringify({ id: 'wal-single-job', status: 'running' }), { status: 200 });
  };
  try {
    const results = await Promise.allSettled([dispatch(h, fetchImpl), dispatch(h, fetchImpl, h.input, ctx)]);
    assert.equal(posts, 1);
    assert.ok(results.some(value => value.status === 'fulfilled'));
    assert.equal(attemptRow(h).provider_task_id, 'wal-single-job');
    assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n, 1);
    assert.equal(h.db.prepare("SELECT count(*) n FROM async_tasks WHERE type='redraw_execution_unit'").get().n, 1);
  } finally { other.close(); }
});

test('publication await rechecks actual material bytes, source binding, selected key and current price before marker', async t => {
  const h = await setup(t);
  const image = h.prepared.prepared_materials.references.find(value => value.kind === 'image');
  const asset = h.db.prepare('SELECT local_path FROM assets WHERE id=?').get(image.asset_id);
  const file = path.join(h.root, asset.local_path), bytes = fs.readFileSync(file);
  const source = h.db.prepare('SELECT local_path FROM assets WHERE id=101').get();
  const price = h.db.prepare('SELECT credits FROM model_credit_prices WHERE model=?').get(h.model);
  for (const [label, mutate, restore] of [
    ['material-bytes', () => fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from('changed')])), () => fs.writeFileSync(file, bytes)],
    ['source-binding', () => h.db.prepare("UPDATE assets SET local_path='missing-source.mp4' WHERE id=101").run(),
      () => h.db.prepare('UPDATE assets SET local_path=? WHERE id=101').run(source.local_path)],
    ['selected-key', () => h.db.prepare("UPDATE ai_service_configs SET api_key='different-synthetic-key' WHERE id=41").run(),
      () => h.db.prepare('UPDATE ai_service_configs SET api_key=? WHERE id=41').run(KEY)],
    ['current-price', () => h.db.prepare('UPDATE model_credit_prices SET credits=credits+1 WHERE model=?').run(h.model),
      () => h.db.prepare('UPDATE model_credit_prices SET credits=? WHERE model=?').run(price.credits, h.model)],
  ]) await t.test(label, async () => {
    let changed = false, posts = 0;
    Object.defineProperty(h.ctx.providerAssets, 'nowMs', { configurable: true, enumerable: true, get() {
      if (!changed) { changed = true; mutate(); }
      return Date.parse('2026-09-07T00:00:00.000Z');
    } });
    try {
      await assert.rejects(dispatch(h, async () => { posts += 1; return new Response('{}'); }));
      assert.equal(changed, true); assert.equal(posts, 0);
      assert.equal(attemptRow(h).request_hash, null); assert.equal(attemptRow(h).submit_started_at, null);
      assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(attemptRow(h).reservation_id).status, 'held');
    } finally {
      restore();
      Object.defineProperty(h.ctx.providerAssets, 'nowMs', { configurable: true, enumerable: true, writable: true,
        value: Date.parse('2026-09-07T00:00:00.000Z') });
    }
  });
});

for (const drift of ['selected-key', 'current-price']) test(`marker-write ${drift} trigger rolls back the entire submission before POST`, async t => {
  const h = await setup(t);
  const config = h.db.prepare('SELECT api_key,updated_at FROM ai_service_configs WHERE id=41').get();
  const price = h.db.prepare('SELECT credits,updated_at FROM model_credit_prices WHERE model=?').get(h.model);
  assert.equal(h.db.prepare('SELECT model FROM async_tasks WHERE id=?').get(h.binding.task_id).model, h.model);
  const mutation = drift === 'selected-key'
    ? "UPDATE ai_service_configs SET api_key='marker-trigger-synthetic-key' WHERE id=41;"
    : 'UPDATE model_credit_prices SET credits=credits+1 WHERE model=(SELECT model FROM async_tasks WHERE id=NEW.task_id);';
  h.db.exec(`CREATE TRIGGER drift_after_submission_marker AFTER UPDATE OF request_hash ON redraw_execution_unit_attempts
    WHEN OLD.request_hash IS NULL AND NEW.request_hash IS NOT NULL BEGIN ${mutation} END`);
  const before = h.db.serialize(), originalRun = runRow(h), originalAttempt = attemptRow(h);
  let posts = 0, rejected = false;
  try {
    await dispatch(h, async () => { posts += 1; return new Response(JSON.stringify({ id: 'must-not-submit', status: 'running' })); });
  } catch (_) { rejected = true; }
  assert.equal(posts, 0, 'a trigger changing the effective key or current quote must abort before transport');
  assert.equal(rejected, true);
  assert.deepEqual(attemptRow(h), originalAttempt);
  assert.equal(attemptRow(h).request_hash, null); assert.equal(attemptRow(h).submit_started_at, null);
  assert.deepEqual(runRow(h), originalRun, 'the marker transaction must not advance run revision');
  assert.deepEqual(h.db.prepare('SELECT api_key,updated_at FROM ai_service_configs WHERE id=41').get(), config);
  assert.deepEqual(h.db.prepare('SELECT credits,updated_at FROM model_credit_prices WHERE model=?').get(h.model), price);
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(originalAttempt.reservation_id).status, 'held');
  assert.deepEqual(h.db.serialize(), before, 'task, account, ledger and trigger writes must all roll back');
});

for (const drift of ['task-credit-reservation', 'held-reservation-status', 'run-revision', 'claim-token']) {
  test(`marker-write ${drift} binding trigger rolls back the entire submission before POST`, async t => {
    const h = await setup(t);
    const taskRow = () => h.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(h.binding.task_id);
    const originalRun = runRow(h), originalAttempt = attemptRow(h), originalTask = taskRow();
    const reservationRow = () => h.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=?').get(originalAttempt.reservation_id);
    const originalReservation = reservationRow();
    assert.equal(h.db.name, path.join(h.root, 'fixture.sqlite'), 'only the explicit isolated synthetic database is in scope');
    assert.deepEqual(h.db.prepare('SELECT tenant_id FROM tenant_credit_accounts').all(), [{ tenant_id: h.ctx.tenantId }]);
    assert.equal(originalTask.status, 'pending');
    assert.equal(originalTask.tenant_id, h.ctx.tenantId); assert.equal(originalTask.user_id, h.ctx.userId);
    assert.equal(originalTask.credit_reservation_id, originalReservation.id);
    assert.equal(originalReservation.status, 'held');
    assert.equal(originalReservation.tenant_id, h.ctx.tenantId); assert.equal(originalReservation.actor_user_id, h.ctx.userId);
    assert.equal(originalReservation.resource_id, String(originalAttempt.id));
    assert.equal(originalAttempt.request_hash, null); assert.equal(originalAttempt.status, 'claimed');
    assert.equal(originalRun.revision, h.input.expected_revision);
    const target = {
      'task-credit-reservation': {
        table: 'async_tasks', column: 'status', id: originalTask.id,
        condition: "OLD.status='pending' AND NEW.status='processing'", update: "status='processing'",
        mutation: 'UPDATE async_tasks SET credit_reservation_id=NULL WHERE id=NEW.id;',
        changed: () => taskRow().credit_reservation_id, expected: null,
      },
      'held-reservation-status': {
        table: 'async_tasks', column: 'status', id: originalTask.id,
        condition: "OLD.status='pending' AND NEW.status='processing'", update: "status='processing'",
        mutation: "UPDATE tenant_usage_reservations SET status='refunded' WHERE id=NEW.credit_reservation_id;",
        changed: () => reservationRow().status, expected: 'refunded',
      },
      'run-revision': {
        table: 'redraw_execution_runs', column: 'revision', id: originalRun.id,
        condition: `OLD.revision=${originalRun.revision} AND NEW.revision=OLD.revision+1`, update: 'revision=revision+1',
        mutation: 'UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=NEW.id;',
        changed: () => runRow(h).revision, expected: originalRun.revision + 2,
      },
      'claim-token': {
        table: 'redraw_execution_unit_attempts', column: 'request_hash', id: originalAttempt.id,
        condition: 'OLD.request_hash IS NULL AND NEW.request_hash IS NOT NULL', update: `request_hash='${'f'.repeat(64)}'`,
        mutation: "UPDATE redraw_execution_unit_attempts SET claim_token='marker-trigger-synthetic-claim' WHERE id=NEW.id;",
        changed: () => attemptRow(h).claim_token, expected: 'marker-trigger-synthetic-claim',
      },
    }[drift];
    h.db.exec(`CREATE TRIGGER drift_after_marker_binding AFTER UPDATE OF ${target.column} ON ${target.table}
      WHEN NEW.id='${target.id}' AND ${target.condition} BEGIN ${target.mutation} END`);
    const before = h.db.serialize();
    const probeRollback = new Error('rollback verified marker binding trigger probe');
    assert.throws(() => h.db.transaction(() => {
      assert.equal(h.db.prepare(`UPDATE ${target.table} SET ${target.update} WHERE id=?`).run(target.id).changes, 1);
      assert.equal(target.changed(), target.expected, 'the exact SQLite trigger condition must actually mutate its target');
      throw probeRollback;
    }).immediate(), error => error === probeRollback);
    assert.deepEqual(h.db.serialize(), before, 'trigger preflight must restore every database byte before real dispatch');
    assert.deepEqual(reservationRow(), originalReservation);
    assert.equal(h.db.inTransaction, false);
    let posts = 0, rejected;
    try {
      await dispatch(h, async () => {
        posts += 1;
        return new Response(JSON.stringify({ id: 'must-not-submit-binding-drift', status: 'running' }), { status: 200 });
      });
    } catch (error) { rejected = error; }
    assert.equal(posts, 0, 'binding drift from the marker transaction must be rejected before the first POST');
    assert.equal(rejected?.code, 'REDRAW_UNIT_VIDEO_PREFLIGHT_INVALID');
    assert.equal(h.db.inTransaction, false);
    assert.deepEqual(attemptRow(h), originalAttempt, 'claim, reservation and submission marker must roll back');
    assert.deepEqual(runRow(h), originalRun, 'only the exact expected run/CAS write may commit');
    assert.deepEqual(taskRow(), originalTask, 'the bound task must retain its original held reservation');
    assert.deepEqual(reservationRow(), originalReservation);
    assert.equal(reservationRow().status, 'held');
    assert.deepEqual(h.db.serialize(), before, 'run, attempt, task, account, ledger and trigger writes must all roll back');
  });
}
