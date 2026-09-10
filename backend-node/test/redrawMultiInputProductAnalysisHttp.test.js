'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers/redrawMultiInputProductAnalysisHttpGuard').install();
const { createFixture, sha256 } = require('./helpers/redrawMultiInputProductAnalysisHttpFixture');

test('real login and default HTTP ZIP upload bind the second source through audio, visual and fusion, with refresh and owner isolation', async (t) => {
  const f = await createFixture(t);
  const { db, request, calls, sources } = f;
  const data = (response, expected = 200) => {
    assert.equal(response.status, expected, JSON.stringify(response.body));
    assert.equal(response.body.success, true);
    return response.body.data;
  };
  const workRow = (id) => db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(id);
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const readEvidence = (workId, category) => {
    const rows = db.prepare('SELECT * FROM assets WHERE category = ? AND deleted_at IS NULL').all(category)
      .filter((row) => JSON.parse(row.metadata).work_id === workId);
    assert.equal(rows.length, 1, `${category} has exactly one artifact for this work`);
    const asset = rows[0], metadata = JSON.parse(asset.metadata);
    const bytes = fs.readFileSync(path.join(f.storageRoot, asset.local_path));
    assert.equal(sha256(bytes), metadata.evidence_sha256 || metadata.sha256);
    return { asset, metadata, payload: JSON.parse(bytes) };
  };
  const productionCounts = () => ({
    other_tasks: db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type != 'redraw_analysis'").get().n,
    videos: count('video_generations'), images: count('image_generations'), merges: count('video_merges'),
    exports: count('redraw_exports'), generated_assets: count('redraw_assets'),
    audio_assets: db.prepare("SELECT COUNT(*) AS n FROM assets WHERE type = 'audio'").get().n,
  });
  const assertNoProduction = () => assert.deepEqual(productionCounts(), {
    other_tasks: 0, videos: 0, images: 0, merges: 0, exports: 0, generated_assets: 0, audio_assets: 0,
  });
  assertNoProduction();
  assert.equal((await request('GET', '/redraw/projects')).status, 401);
  assert.equal((await request('POST', '/auth/login', { json: {
    email: f.users[0].email, password: 'incorrect-synthetic-password',
  } })).status, 401);
  async function login(user) {
    // Submit the real login form fields over HTTP and replay only its returned
    // token, as Login.vue does. No issueToken, req.user or req.tenant injection.
    const response = await request('POST', '/auth/login', { json: { email: user.email, password: f.password } });
    assert.equal(response.status, 200, 'Synthetic HTTP login must succeed');
    assert.equal(response.body.success, true);
    const session = response.body.data;
    assert.equal(session.user.id, user.id); assert.equal(session.user.role, 'user');
    const cookies = response.headers['set-cookie'];
    assert.equal(cookies.length, 1); assert.match(cookies[0], /^moli_media_session=/);
    assert.ok(typeof session.token === 'string' && session.token.length > 0);
    const token = session.token;
    assert.equal(data(await request('GET', '/auth/me', { token })).id, user.id);
    return token;
  }
  const token = await login(f.users[0]);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(`personal:${f.users[0].id}`);
  assert.ok(tenant, 'real login creates the default personal tenant');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n, 1);
  require('../src/services/creditLedgerService').setTenantAccountBalance(db, tenant.id, 100);
  const project = data(await request('POST', '/redraw/projects', { token, json: { title: 'G3 synthetic multi-input HTTP' } }), 201);
  assert.equal(project.user_id, f.users[0].id); assert.equal(project.tenant_id, tenant.id);
  const uploaded = data(await request('POST', `/redraw/projects/${project.id}/works`, { token, upload: true }), 201).items;
  assert.equal(uploaded.length, 2); assert.equal(count('redraw_works'), 2); assert.equal(count('async_tasks'), 0);
  assert.deepEqual(uploaded.map((work) => work.source_fingerprint), sources.map((source) => source.sha256));
  assert.notEqual(uploaded[0].source_asset_id, uploaded[1].source_asset_id);
  assert.deepEqual(calls, { worker: [], vision: [] });
  // Recover the second item from the default HTTP list, never from items[0].
  const list = data(await request('GET', `/redraw/projects/${project.id}/works`, { token }));
  assert.deepEqual(list.map((work) => work.id), uploaded.map((work) => work.id));
  const second = list.find((work) => work.title === sources[1].name);
  assert.ok(second); assert.equal(second.id, uploaded[1].id); assert.notEqual(second.id, uploaded[0].id);
  const firstId = uploaded[0].id, secondId = second.id;
  const firstBefore = workRow(firstId);
  const firstSourceBefore = db.prepare('SELECT * FROM assets WHERE id = ?').get(firstBefore.source_asset_id);
  assert.equal(firstBefore.status, 'draft'); assert.equal(firstBefore.task_id, null);
  assert.equal(firstBefore.source_fingerprint, sources[0].sha256);
  const settings = { locale: 'en-US', market: 'US', aspect_ratio: '9:16', style_preset_id: 1 };
  const analyzed = data(await request('POST', `/redraw/works/${secondId}/analyze`, { token, json: settings }), 201);
  assert.equal(analyzed.review_status, 'needs_review'); assert.equal(analyzed.current_step, 1);
  assert.deepEqual(analyzed.billing, { charged: 6, held: 0, released: 0 });
  assert.equal(calls.worker.length, 1);
  assert.ok(calls.vision.length > 0 && calls.vision.every((call) => call.work_id === secondId));
  assert.ok(calls.vision.every((call) => call.source_sha256 === sources[1].sha256));
  assert.equal(count('async_tasks'), 1); assert.equal(count('redraw_episode_blueprints'), 1);
  assert.equal(db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(analyzed.task_id).status, 'completed');
  assert.equal(workRow(secondId).status, 'needs_attention'); assert.equal(workRow(secondId).current_step, 1);
  assert.deepEqual(workRow(firstId), firstBefore, 'analyzing the second work must not modify the first work');
  assert.deepEqual(db.prepare('SELECT * FROM assets WHERE id = ?').get(firstBefore.source_asset_id), firstSourceBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redraw_versions WHERE work_id = ?').get(firstId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redraw_episode_blueprints WHERE work_id = ?').get(firstId).n, 0);

  const blueprintRecord = data(await request('GET', `/redraw/works/${secondId}/blueprint`, { token }));
  const blueprint = blueprintRecord.blueprint;
  assert.equal(blueprintRecord.work_id, secondId); assert.equal(blueprintRecord.status, 'draft');
  assert.equal(blueprintRecord.reviewed_at, null); assert.equal(blueprint.review.status, 'needs_review');
  assert.equal(blueprint.source.asset_id, uploaded[1].source_asset_id);
  assert.equal(blueprint.source.sha256, sources[1].sha256);
  assert.equal(blueprint.source.duration_ms, sources[1].durationMs);
  assert.equal(blueprint.source.width, sources[1].width); assert.equal(blueprint.source.height, sources[1].height);
  assert.equal(blueprint.source.audio_codec, 'aac');
  const audio = readEvidence(secondId, 'redraw_source_audio_evidence');
  assert.equal(audio.payload.work_id, secondId); assert.equal(audio.payload.source_asset_id, uploaded[1].source_asset_id);
  assert.equal(audio.payload.source_video_sha256, sources[1].sha256);
  assert.equal(audio.payload.audio_sha256, calls.worker[0].audio_sha256); assert.equal(audio.payload.dialogue_mode, 'spoken');
  const visual = readEvidence(secondId, 'redraw_source_analysis');
  assert.equal(visual.payload.work_id, secondId); assert.equal(visual.payload.source_asset_id, uploaded[1].source_asset_id);
  assert.equal(visual.payload.source.sha256, sources[1].sha256);
  assert.deepEqual(blueprint.evidence_manifest.items.map((item) => item.asset_id).sort((a, b) => a - b),
    [audio.asset.id, visual.asset.id].sort((a, b) => a - b));
  assert.deepEqual(blueprint.shots.flatMap((shot) => shot.dialogue).map((line) => line.source_text), f.segments.map((line) => line.text));
  assert.equal(blueprintRecord.source_dialogue.length, 1);
  assert.equal(blueprintRecord.source_dialogue[0].status, 'resolved');
  assertNoProduction();
  f.write('success-second-source.json', { first_before: firstBefore, first_after: workRow(firstId),
    second: workRow(secondId), analysis: analyzed, blueprint: blueprintRecord,
    audio_asset_id: audio.asset.id, visual_asset_id: visual.asset.id, production_counts: productionCounts() });

  // Existing contract: a new explicit POST /analyze is a fresh analysis, not a
  // refresh/idempotency API. Do not send a second POST or invent a new policy.
  // This regression covers repeated ZIP upload and repeated list/work/blueprint GETs.
  const stableBefore = { tasks: db.prepare('SELECT * FROM async_tasks').all(), second: workRow(secondId),
    first: workRow(firstId), worker: calls.worker.length, vision: calls.vision.length,
    blueprints: count('redraw_episode_blueprints') };
  const repeated = data(await request('POST', `/redraw/projects/${project.id}/works`, { token, upload: true }), 201).items;
  assert.deepEqual(repeated.map((work) => work.id), uploaded.map((work) => work.id));
  assert.ok(repeated.every((work) => work.reused)); assert.equal(count('redraw_works'), 2);
  for (let refresh = 0; refresh < 2; refresh++) {
    assert.deepEqual(data(await request('GET', `/redraw/projects/${project.id}/works`, { token })).map((work) => work.id), list.map((work) => work.id));
    assert.equal(data(await request('GET', `/redraw/works/${secondId}`, { token })).task_id, analyzed.task_id);
    assert.equal(data(await request('GET', `/redraw/works/${secondId}/blueprint`, { token })).blueprint.blueprint_hash, blueprint.blueprint_hash);
  }
  assert.deepEqual({ tasks: db.prepare('SELECT * FROM async_tasks').all(), second: workRow(secondId),
    first: workRow(firstId), worker: calls.worker.length, vision: calls.vision.length,
    blueprints: count('redraw_episode_blueprints') }, stableBefore);
  f.write('repeat-refresh.json', { extra_tasks: 0, extra_worker_calls: 0, extra_vision_calls: 0,
    reused_work_ids: repeated.map((work) => work.id), explicit_reanalysis_post: 'not sent; existing fresh-analysis contract' });

  const otherToken = await login(f.users[1]);
  const foreignResponses = [];
  for (const route of [`/redraw/projects/${project.id}/works`, `/redraw/works/${secondId}`, `/redraw/works/${secondId}/blueprint`]) {
    const denied = await request('GET', route, { token: otherToken });
    assert.equal(denied.status, 404); foreignResponses.push({ method: 'GET', route, status: denied.status });
  }
  const foreignAnalyze = await request('POST', `/redraw/works/${secondId}/analyze`, { token: otherToken, json: settings });
  assert.equal(foreignAnalyze.status, 404);
  assert.equal(count('async_tasks'), 1); assert.equal(calls.worker.length, 1); assert.equal(calls.vision.length, stableBefore.vision);
  assert.deepEqual(workRow(secondId), stableBefore.second); assert.deepEqual(workRow(firstId), firstBefore);
  f.write('cross-owner-denied.json', { reads: foreignResponses, analyze_status: foreignAnalyze.status, extra_tasks: 0, extra_worker_calls: 0 });

  const firstAnalysis = data(await request('POST', `/redraw/works/${firstId}/analyze`, { token, json: settings }), 201);
  assert.equal(firstAnalysis.review_status, 'needs_review'); assert.equal(firstAnalysis.current_step, 1);
  assert.equal(calls.worker.length, 1, 'the first source has no audio track: zero extra Worker calls');
  assert.ok(calls.vision.some((call) => call.work_id === firstId && call.source_sha256 === sources[0].sha256));
  assert.equal(count('async_tasks'), 2); assert.equal(count('redraw_episode_blueprints'), 2);
  assert.notEqual(firstAnalysis.task_id, analyzed.task_id);
  const firstRecord = data(await request('GET', `/redraw/works/${firstId}/blueprint`, { token }));
  assert.equal(firstRecord.status, 'draft'); assert.equal(firstRecord.blueprint.review.status, 'needs_review');
  assert.equal(firstRecord.blueprint.source.sha256, sources[0].sha256);
  assert.equal(firstRecord.blueprint.source.asset_id, uploaded[0].source_asset_id);
  assert.equal(firstRecord.blueprint.source.audio_codec, null);
  assert.deepEqual(firstRecord.blueprint.shots.flatMap((shot) => shot.dialogue), []);
  const firstAudio = readEvidence(firstId, 'redraw_source_audio_evidence');
  assert.equal(firstAudio.payload.source_video_sha256, sources[0].sha256);
  assert.equal(firstAudio.payload.audio_sha256, null); assert.equal(firstAudio.payload.dialogue_mode, 'silent');
  assert.deepEqual(firstAudio.payload.segments, []);
  assert.equal(readEvidence(firstId, 'redraw_source_analysis').payload.source.sha256, sources[0].sha256);
  assert.deepEqual(workRow(secondId), stableBefore.second, 'first analysis cannot replace the second source result');
  assert.equal(workRow(firstId).status, 'needs_attention'); assert.equal(workRow(firstId).current_step, 1);
  assert.ok(db.prepare('SELECT status FROM async_tasks').all().every((row) => row.status === 'completed'));
  assertNoProduction();
  f.write('silent-first-source.json', { first: workRow(firstId), blueprint: firstRecord,
    first_branch_worker_calls: 0, total_worker_calls: calls.worker.length, production_counts: productionCounts() });
});
