'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runs = require('../src/services/redrawExecutionRunService');
const { setup, dispatch, attemptRow, runRow, hash, makeCandidateMedia, KEY } = require('./helpers/redrawExecutionUnitDispatchFixture');

const response = body => new Response(JSON.stringify(body), { status: 200 });
const hold = h => h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(attemptRow(h).reservation_id).status;
function recover(h, fetchImpl, ctx = h.ctx, download = undefined) {
  return runs.recoverExecutionUnitTask(ctx, h.versionId, h.run.id, { attempt_id: h.attemptId },
    { fetchImpl, ...(download ? { download } : {}) });
}

test('known ID recovery performs one exact selected GET and never another submit or reservation', async t => {
  const h = await setup(t);
  let posts = 0, gets = 0;
  await dispatch(h, async () => { posts += 1; return response({ id: 'recover-known', status: 'running' }); });
  const marked = attemptRow(h);
  const result = await recover(h, async (url, init) => {
    gets += 1;
    assert.equal(h.db.inTransaction, false);
    assert.equal(init.method, 'GET');
    assert.equal(url, 'https://video.dispatch.synthetic.invalid/api/v3/contents/generations/tasks/recover-known');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    return response({ id: 'recover-known', status: 'running' });
  });
  assert.equal(result.status, 'running');
  assert.equal(result.newly_submitted, false);
  assert.equal(posts, 1); assert.equal(gets, 1);
  assert.equal(attemptRow(h).request_hash, marked.request_hash);
  assert.equal(attemptRow(h).submit_started_at, marked.submit_started_at);
  assert.equal(hold(h), 'held');
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n, 1);
  await assert.rejects(recover(h, () => assert.fail('wrong owner must not query'), { ...h.ctx, userId: 'other-user' }));
  h.db.prepare("UPDATE ai_service_configs SET api_key='changed-synthetic-key' WHERE id=41").run();
  const before = h.db.serialize();
  const blocked = await recover(h, () => assert.fail('connection drift must not query another key'));
  assert.equal(blocked.status, 'needs_attention');
  assert.equal(blocked.reason_code, 'SELECTED_CAPABILITY_STALE');
  assert.equal(blocked.provider_task_id, 'recover-known');
  assert.deepEqual(h.db.serialize(), before, 'credential drift does not mutate submitted facts');
});

test('unknown submit without ID stays frozen and recovery has zero transport', async t => {
  const h = await setup(t);
  let posts = 0;
  const result = await dispatch(h, async () => { posts += 1; throw new Error('synthetic connection lost'); });
  assert.equal(result.status, 'needs_attention');
  const marked = attemptRow(h), before = h.db.serialize();
  assert.ok(marked.request_hash && marked.submit_started_at);
  assert.equal(marked.provider_task_id, null);
  await dispatch(h, () => assert.fail('unknown cannot resubmit'));
  const recovered = await recover(h, () => assert.fail('without ID recovery cannot query'));
  assert.equal(recovered.status, 'needs_attention');
  assert.deepEqual(h.db.serialize(), before);
  assert.equal(posts, 1); assert.equal(hold(h), 'held');
});

test('one-shot unknown, conflicting-ID and result-unavailable queries retain known ID and hold', async t => {
  const h = await setup(t);
  await dispatch(h, async () => response({ id: 'uncertain-known', status: 'running' }));
  let gets = 0;
  for (const body of [{ id: 'uncertain-known', status: 'unknown' },
    { id: 'different-job', status: 'failed' }, { id: 'uncertain-known', status: 'succeeded' }]) {
    const result = await recover(h, async (_url, init) => { gets += 1; assert.equal(init.method, 'GET'); return response(body); });
    assert.equal(result.status, 'needs_attention'); assert.equal(result.provider_task_id, 'uncertain-known');
    assert.equal(hold(h), 'held'); assert.equal(attemptRow(h).output_asset_id, null);
  }
  assert.equal(gets, 3, 'each explicit recovery invocation has exactly one GET');
  assert.equal(h.db.prepare("SELECT count(*) n FROM tenant_credit_ledger WHERE event_type='refund'").get().n, 0);
  await dispatch(h, () => assert.fail('uncertain query cannot resubmit'));
});

test('post-return ID survives paused run, stale plan, changed key and deleted mutable task projection', async t => {
  const h = await setup(t);
  const result = await dispatch(h, async () => {
    h.db.prepare('UPDATE redraw_execution_runs SET pause_requested=1,revision=revision+1 WHERE id=?').run(h.run.id);
    h.db.prepare("UPDATE redraw_versions SET localization_hash=? WHERE id=?").run('0'.repeat(64), h.versionId);
    h.db.prepare("UPDATE ai_service_configs SET api_key='changed-after-post' WHERE id=41").run();
    h.db.prepare("UPDATE async_tasks SET metadata='{}',deleted_at=? WHERE id=?").run('2026-09-07T00:01:00.000Z', h.binding.task_id);
    return response({ id: 'post-drift-known', status: 'running' });
  });
  assert.equal(result.receipt_persisted, true);
  assert.equal(attemptRow(h).provider_task_id, 'post-drift-known');
  assert.equal(h.db.prepare('SELECT provider_task_id FROM async_tasks WHERE id=?').get(h.binding.task_id).provider_task_id, 'post-drift-known');
  assert.equal(runRow(h).pause_requested, 1);
  assert.equal(hold(h), 'held');
});

test('explicit terminal failure refunds once and terminal recovery is strictly inert', async t => {
  const h = await setup(t);
  await dispatch(h, async () => response({ id: 'explicit-failure', status: 'running' }));
  const result = await recover(h, async () => response({ id: 'explicit-failure', status: 'failed' }));
  assert.equal(result.status, 'failed');
  assert.equal(hold(h), 'refunded');
  assert.equal(h.db.prepare("SELECT count(*) n FROM tenant_credit_ledger WHERE event_type='refund'").get().n, 1);
  const before = h.db.serialize();
  await recover(h, () => assert.fail('terminal failure cannot query again'));
  await dispatch(h, () => assert.fail('terminal failure cannot submit again'));
  assert.deepEqual(h.db.serialize(), before);
});

test('failed attempt receipt retains known ID in independently bound task receipt for recovery', async t => {
  const h = await setup(t);
  h.db.exec(`CREATE TRIGGER fail_attempt_receipt BEFORE UPDATE OF provider_task_id ON redraw_execution_unit_attempts
    WHEN NEW.provider_task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
  const result = await dispatch(h, async () => response({ id: 'recoverable-receipt', status: 'running' }));
  assert.equal(result.receipt_persisted, false);
  assert.equal(result.provider_task_id, 'recoverable-receipt');
  const task = h.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(h.binding.task_id);
  assert.equal(task.provider_task_id, 'recoverable-receipt');
  assert.equal(task.metadata, h.taskMetadata);
  const safeReceipt = JSON.parse(task.result);
  assert.equal(safeReceipt.request_hash, attemptRow(h).request_hash);
  assert.equal(safeReceipt.provider_task_id, 'recoverable-receipt');
  assert.doesNotMatch(task.result, /api_key|claim_token|connection|fingerprint|result_url|synthetic-dispatch-video-key/);
  h.db.exec('DROP TRIGGER fail_attempt_receipt');
  let gets = 0;
  await recover(h, async () => { gets += 1; return response({ id: 'recoverable-receipt', status: 'running' }); });
  assert.equal(gets, 1); assert.equal(attemptRow(h).provider_task_id, 'recoverable-receipt');
  assert.equal(hold(h), 'held');
});

test('receipt fallback does not overwrite an existing mismatched task result', async t => {
  const h = await setup(t);
  h.db.exec(`CREATE TRIGGER fail_attempt_receipt BEFORE UPDATE OF provider_task_id ON redraw_execution_unit_attempts
    WHEN NEW.provider_task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
  const existing = JSON.stringify({ schema_version: 'redraw-execution-unit-safe-receipt-v1', request_hash: '0'.repeat(64) });
  const result = await dispatch(h, async () => {
    h.db.prepare('UPDATE async_tasks SET result=? WHERE id=?').run(existing, h.binding.task_id);
    return response({ id: 'not-overwritten-known', status: 'running' });
  });
  assert.equal(result.provider_task_id, 'not-overwritten-known');
  assert.equal(result.fallback_receipt_persisted, false);
  const task = h.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(h.binding.task_id);
  assert.equal(task.result, existing); assert.equal(task.provider_task_id, null);
  assert.equal(attemptRow(h).provider_task_id, null); assert.equal(hold(h), 'held');
});

test('one known-ID query accepts compatible MP4 codecs and duration into the same owner candidate despite post-query drift', async t => {
  const h = await setup(t), bytes = await makeCandidateMedia(h, 'alternate-codecs');
  await dispatch(h, async () => response({ id: 'candidate-known', status: 'running' }));
  const marked = attemptRow(h);
  let gets = 0, downloads = 0, lookups = 0;
  const result = await recover(h, async (_url, init) => {
    gets += 1; assert.equal(init.method, 'GET');
    return response({ id: 'candidate-known', status: 'succeeded', content: { video_url: 'https://result.synthetic.invalid/unit.mp4' } });
  }, h.ctx, {
    _dnsLookupForTest: async (hostname, options) => {
      lookups += 1; assert.equal(hostname, 'result.synthetic.invalid'); assert.equal(options.all, true);
      return [{ address: '8.8.8.8', family: 4 }];
    },
    fetchImpl: async (_url, init) => {
      downloads += 1; assert.equal(h.db.inTransaction, false); assert.equal(init.method, 'GET');
      assert.equal(init.headers, undefined, 'supplier key never reaches the artifact host');
      assert.equal(attemptRow(h).provider_task_id, 'candidate-known', 'ID must persist before the asynchronous download');
      h.db.prepare('UPDATE redraw_execution_runs SET pause_requested=1,revision=revision+1 WHERE id=?').run(h.run.id);
      h.db.prepare('UPDATE model_credit_prices SET credits=credits+1 WHERE model=?').run(h.model);
      h.db.prepare("UPDATE async_tasks SET metadata='{}' WHERE id=?").run(h.binding.task_id);
      return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
    },
  });
  assert.equal(gets, 1); assert.equal(downloads, 1); assert.equal(lookups, 1);
  assert.equal(result.status, 'waiting_review'); assert.equal(result.newly_submitted, false);
  const attempt = attemptRow(h);
  assert.equal(attempt.request_hash, marked.request_hash); assert.equal(attempt.submit_started_at, marked.submit_started_at);
  assert.equal(attempt.approved_at, null); assert.equal(attempt.approved_by, null);
  assert.equal(attempt.output_sha256, hash(bytes)); assert.match(attempt.candidate_hash, /^[a-f0-9]{64}$/);
  const asset = h.db.prepare('SELECT * FROM assets WHERE id=?').get(attempt.output_asset_id);
  assert.equal(asset.type, 'video'); assert.equal(asset.mime_type, 'video/mp4');
  assert.equal(asset.width, 854); assert.equal(asset.height, 480);
  assert.match(asset.local_path, new RegExp(`^redraw-execution-results/${h.run.id}/${h.attemptId}/[a-f0-9]{64}\\.mp4$`));
  assert.deepEqual(fs.readFileSync(path.join(h.root, asset.local_path)), bytes);
  const metadata = JSON.parse(asset.metadata);
  assert.equal(metadata.tenant_id, h.ctx.tenantId); assert.equal(metadata.user_id, h.ctx.userId);
  assert.equal(metadata.work_id, 1); assert.equal(metadata.version_id, h.versionId);
  assert.equal(metadata.run_id, h.run.id); assert.equal(metadata.attempt_id, h.attemptId);
  const quality = JSON.parse(attempt.quality_json);
  assert.equal(quality.candidate.review_status, 'pending');
  assert.equal(quality.candidate.qa_status, 'not_checked');
  assert.equal(quality.candidate.video_codec, 'mpeg4'); assert.equal(quality.candidate.audio_codec, 'mp3');
  assert.ok(quality.candidate.duration_ms > h.pack.timeline.generated_duration_ms + 100);
  assert.doesNotMatch(JSON.stringify(quality.candidate), /locale_verified|language_verified/);
  assert.equal(hold(h), 'held'); assert.equal(runRow(h).pause_requested, 1);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts').get().n, 1);
  assert.equal(fs.existsSync(path.join(h.root, '_system')), false, 'canary namespace must not enter formal storage');
  const before = h.db.serialize();
  await recover(h, () => assert.fail('candidate cannot auto-query or advance'));
  assert.deepEqual(h.db.serialize(), before);
});

test('a late running query cannot overwrite an in-progress download or regress its candidate', async t => {
  const h = await setup(t), bytes = await makeCandidateMedia(h);
  await dispatch(h, async () => response({ id: 'late-query', status: 'running' }));
  let gets = 0, downloads = 0, releaseLate, releaseDownload, entered;
  const lateResponse = new Promise(resolve => { releaseLate = resolve; });
  const downloadResponse = new Promise(resolve => { releaseDownload = resolve; });
  const downloadEntered = new Promise(resolve => { entered = resolve; });
  const query = async () => {
    gets += 1;
    return gets === 1 ? response({ id: 'late-query', status: 'succeeded', content: { video_url: 'https://result.synthetic.invalid/unit.mp4' } }) : lateResponse;
  };
  const download = { _dnsLookupForTest: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => { downloads += 1; entered(); return downloadResponse; } };
  const first = recover(h, query, h.ctx, download), late = recover(h, query, h.ctx, download);
  try {
    await downloadEntered;
    const marker = JSON.parse(attemptRow(h).quality_json).download_started_at;
    releaseLate(response({ id: 'late-query', status: 'running' }));
    await late;
    const during = JSON.parse(attemptRow(h).quality_json);
    assert.equal(during.download_started_at, marker);
    assert.equal(during.observation.status, 'completed_candidate');
    releaseDownload(new Response(bytes, { status: 200 }));
    assert.equal((await first).status, 'waiting_review');
    assert.equal(attemptRow(h).status, 'waiting_review'); assert.equal(hold(h), 'held');
    assert.equal(gets, 2); assert.equal(downloads, 1);
  } finally {
    releaseLate(response({ id: 'late-query', status: 'running' }));
    releaseDownload(new Response(bytes, { status: 200 }));
    await Promise.allSettled([first, late]);
  }
});

test('unreadable returned media retains ID and hold without a second GET, download or POST', async t => {
  const h = await setup(t);
  await dispatch(h, async () => response({ id: 'bad-media', status: 'running' }));
  let gets = 0, downloads = 0;
  const result = await recover(h, async () => {
    gets += 1; return response({ id: 'bad-media', status: 'succeeded', content: { video_url: 'https://result.synthetic.invalid/bad.mp4' } });
  }, h.ctx, { _dnsLookupForTest: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async () => {
    downloads += 1; return new Response('<html>not a video</html>', { status: 200 });
  } });
  assert.equal(result.status, 'needs_attention'); assert.equal(attemptRow(h).provider_task_id, 'bad-media');
  assert.equal(attemptRow(h).output_asset_id, null); assert.equal(hold(h), 'held');
  assert.equal(JSON.parse(attemptRow(h).quality_json).observation.status, 'result_unavailable');
  await recover(h, () => assert.fail('failed download is frozen, not retried'));
  await dispatch(h, () => assert.fail('failed download cannot resubmit'));
  assert.equal(gets, 1); assert.equal(downloads, 1);
});

test('candidate validation rejects real WebM, silent native MP4, short MP4 and non-public result URL', async t => {
  const h = await setup(t);
  const { materializeExecutionUnitCandidate } = require('../src/services/redrawSourceConditioningService');
  for (const variant of ['webm', 'silent', 'short']) await t.test(variant, async () => {
    const bytes = await makeCandidateMedia(h, variant);
    await assert.rejects(materializeExecutionUnitCandidate({ storageRoot: h.root, tempRoot: h.ctx.tempRoot,
      runId: h.run.id, attemptId: h.attemptId, durationMs: h.pack.timeline.generated_duration_ms,
      audioMode: 'native', resolution: '480p', aspectRatio: '16:9', url: 'https://result.synthetic.invalid/unit.mp4',
      download: { _dnsLookupForTest: async () => [{ address: '8.8.8.8', family: 4 }],
        fetchImpl: async () => new Response(bytes, { status: 200 }) } }));
  });
  await assert.rejects(materializeExecutionUnitCandidate({ storageRoot: h.root, tempRoot: h.ctx.tempRoot,
    runId: h.run.id, attemptId: h.attemptId, durationMs: h.pack.timeline.generated_duration_ms,
    audioMode: 'native', resolution: '480p', aspectRatio: '16:9', url: 'http://127.0.0.1/private.mp4',
    download: { _dnsLookupForTest: async () => assert.fail('literal local address requires no DNS'),
      fetchImpl: async () => assert.fail('non-public result must not reach transport') } }));
  assert.equal(fs.existsSync(path.join(h.root, 'redraw-execution-results')), false);
  await t.test('non-square pixels with trustworthy matching DAR remain valid', async () => {
    const bytes = await makeCandidateMedia(h, 'valid-sar');
    const candidate = await materializeExecutionUnitCandidate({ storageRoot: h.root, tempRoot: h.ctx.tempRoot,
      runId: h.run.id, attemptId: h.attemptId, durationMs: h.pack.timeline.generated_duration_ms,
      audioMode: 'native', resolution: '480p', aspectRatio: '16:9', url: 'https://result.synthetic.invalid/unit.mp4',
      download: { _dnsLookupForTest: async () => [{ address: '8.8.8.8', family: 4 }],
        fetchImpl: async () => new Response(bytes, { status: 200 }) } });
    assert.equal(candidate.width, 854); assert.equal(candidate.height, 480);
    assert.equal(candidate.video_codec, 'h264'); assert.equal(candidate.audio_codec, 'aac');
    assert.equal(candidate.sha256, hash(bytes));
    assert.deepEqual(fs.readFileSync(path.join(h.root, candidate.relative_path)), bytes);
  });
});

for (const variant of ['wrong-sar', 'rotated']) test(`actual ${variant} MP4 cannot become a candidate or trigger a recovery retry`, async t => {
  const h = await setup(t), bytes = await makeCandidateMedia(h, variant), id = `geometry-${variant}`;
  let posts = 0, gets = 0, downloads = 0;
  await dispatch(h, async () => { posts += 1; return response({ id, status: 'running' }); });
  const marked = attemptRow(h), assetsBefore = h.db.prepare('SELECT count(*) n FROM assets').get().n;
  const result = await recover(h, async (_url, init) => {
    gets += 1; assert.equal(init.method, 'GET');
    return response({ id, status: 'succeeded', content: { video_url: 'https://result.synthetic.invalid/geometry.mp4' } });
  }, h.ctx, { _dnsLookupForTest: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async () => {
    downloads += 1; return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
  } });
  assert.equal(result.status, 'needs_attention', 'display geometry must match the approved output contract');
  const attempt = attemptRow(h), quality = JSON.parse(attempt.quality_json);
  assert.equal(attempt.provider_task_id, id); assert.equal(attempt.request_hash, marked.request_hash);
  assert.equal(attempt.submit_started_at, marked.submit_started_at); assert.equal(attempt.output_asset_id, null);
  assert.equal(attempt.candidate_hash, null); assert.equal(attempt.approved_at, null); assert.equal(hold(h), 'held');
  assert.equal(quality.observation.status, 'result_unavailable'); assert.ok(quality.download_started_at);
  assert.equal(quality.candidate, undefined); assert.equal(h.db.prepare('SELECT count(*) n FROM assets').get().n, assetsBefore);
  assert.equal(fs.existsSync(path.join(h.root, 'redraw-execution-results')), false);
  const before = h.db.serialize();
  await recover(h, () => assert.fail('rejected geometry cannot query or download again'));
  await dispatch(h, () => assert.fail('rejected geometry cannot submit again'));
  assert.deepEqual(h.db.serialize(), before);
  assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(downloads, 1);
});
