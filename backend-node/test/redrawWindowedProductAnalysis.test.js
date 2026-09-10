const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const redrawRoutes = require('../src/routes/redraw');
const prices = require('../src/services/modelPriceService');
const ledger = require('../src/services/creditLedgerService');
const { normalizeSourceFacts, stableStringify } = require('../src/services/redrawAnalysisService');

const log = { info() {}, warn() {}, error() {} };
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function response() {
  return { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function request(id, extra = {}) {
  return { params: { id: String(id) }, tenant: { id: 'window-tenant' }, user: { id: 'window-user' }, body: {}, ...extra };
}
function visualFacts(duration, windowNumber) {
  const narrative = [`Z first event in window ${windowNumber}.`, `A later event in window ${windowNumber}.`];
  return {
    schema_version: '2.0', duration_ms: duration,
    story: narrative,
    characters: [{ id: 'c1', display_name: 'Reader', relationships: [] }],
    scenes: [{ id: 's1', location: 'A room', time: 'Day', source_ranges: [{ start_ms: 0, end_ms: duration }] }],
    props: [{ id: 'p1', name: 'Phone', evidence_ranges: [{ start_ms: 0, end_ms: duration }] }],
    shots: [{
      id: 'shot1', index: 1, start_ms: 0, end_ms: duration, composition: 'Medium shot',
      camera_movement: 'Static', opening_state: 'The reader holds a phone',
      continuous_action: 'The reader looks at a message', ending_state: 'The reader lowers the phone',
      visible_character_ids: ['c1'], dialogue: [], text_regions: [],
      audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.9, speaker_mapping: 0, text_regions: 0.9, shot_boundary: 0.9 },
    }],
    causal_chain: narrative, locked_facts: narrative,
    reversals: narrative, episode_hook: 'The reader awaits another message.',
  };
}

async function fixture(t, { failAt = 0, failMode = 'invalid', workerErrorCode = '' } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-window-product-'));
  const storageRoot = path.join(tempRoot, 'storage');
  const privateAudioRoot = path.join(tempRoot, 'private-audio');
  fs.mkdirSync(storageRoot);
  fs.mkdirSync(privateAudioRoot, { mode: 0o700 });
  const db = new Database(':memory:');
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, is_active, is_default, settings, created_at, updated_at)
    VALUES ('video_understanding', 'local-fixture', 'Local fixture', 'GPT-5.5', 'GPT-5.5', 1, 1, ?, ?, ?)`)
    .run(JSON.stringify({ real_generation_verified: true, evidence: {
      provider_task_id: 'fixture-verification', result_asset_id: 'fixture-result',
      result_asset_readable: true, completed_at: now,
    } }), now, now);
  prices.set(db, 'GPT-5.5', 6);
  ledger.setTenantAccountBalance(db, 'window-tenant', 100);
  const upload = path.join(tempRoot, 'new-input.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:size=160x120:rate=4:duration=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=25',
    '-shortest', '-pix_fmt', 'yuv420p', upload,
  ], { windowsHide: true, stdio: 'pipe' });
  const sourceSha = digest(fs.readFileSync(upload));
  const segments = Array.from({ length: 66 }, (_, i) => ({
    startMs: i * 300, endMs: i * 300 + 200, text: `Original sentence number ${i + 1}.`,
    speakerClusterId: 'speaker-cluster-1',
  }));
  segments.push({
    startMs: 23500, endMs: 24500, text: 'Keep this complete sentence across the window boundary.',
    speakerClusterId: 'speaker-cluster-1',
  });
  const calls = [];
  let workerCalls = 0;
  const handlers = redrawRoutes(db, log, {
    cfg: { storage: { local_path: storageRoot } },
    analysisOptions: { analysisContext: { privateAudioRoot } },
    sourceAudioWorkerClient: {
      async analyzeSourceAudio(input) {
        workerCalls++;
        assert.equal(digest(fs.readFileSync(input.audioPath)), input.audioSha256);
        assert.ok(fs.statSync(input.audioPath).size > 44);
        if (workerErrorCode) {
          throw Object.assign(new Error(`Local worker failed: ${workerErrorCode}`), {
            code: workerErrorCode,
          });
        }
        return {
          requestId: input.requestId, audioSha256: input.audioSha256,
          transcriptSha256: digest(JSON.stringify(segments)), sourceLanguage: 'en', languageProbability: 0.99,
          segments,
        };
      },
    },
    async visionDetailed(payload) {
      calls.push(payload);
      assert.ok(payload.imageSources.length > 0 && payload.imageSources.length <= 6);
      assert.ok(payload.imageSources.every((s) => fs.statSync(s.localAbsPath).size > 0));
      if (failAt === calls.length && failMode === 'unknown') {
        throw Object.assign(new Error('Local window fixture timed out'), {
          code: 'AI_NON_STREAM_TIMEOUT', routeMeta: { phase: 'submit', requestBodySent: true, transportCode: 'ETIMEDOUT' },
        });
      }
      const measured = payload.userPrompt.match(/Measured video metadata: duration_ms=(\d+)/);
      assert.ok(measured, 'window prompt must retain measured local duration');
      return {
        text: failAt === calls.length ? '{invalid-json' : JSON.stringify({ source_facts: visualFacts(Number(measured[1]), calls.length) }),
        provider_task_id: `local-window-${calls.length}`, model: 'GPT-5.5',
        raw_hash: digest(`local response ${calls.length}`), usage: { total_tokens: 10 },
      };
    },
  });
  const project = response();
  handlers.createProject(request(0, { body: { title: 'Independent new input' } }), project);
  assert.equal(project.statusCode, 201, JSON.stringify(project.body));
  const uploaded = response();
  await handlers.createWorks(request(project.body.data.id, {
    file: { path: upload, originalname: 'new-input.mp4', mimetype: 'video/mp4', size: fs.statSync(upload).size },
  }), uploaded);
  assert.equal(uploaded.statusCode, 201, JSON.stringify(uploaded.body));
  const workId = uploaded.body.data.items[0].id;
  const work = db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(workId);
  assert.equal(work.source_fingerprint, sourceSha);
  const analyzed = response();
  await handlers.analyzeWork(request(workId, {
    body: { locale: 'en-US', market: 'US', aspect_ratio: '9:16', style_preset_id: 1 },
  }), analyzed);
  return {
    db, storageRoot, handlers, workId, analyzed, calls, segments, sourceSha,
    get workerCalls() { return workerCalls; },
  };
}

test('new upload uses the default windowed product analysis chain and retains every complete source sentence', async (t) => {
  const f = await fixture(t);
  assert.equal(f.analyzed.statusCode, 201, JSON.stringify(f.analyzed.body));
  assert.equal(f.workerCalls, 1);
  assert.ok(f.calls.length >= 3, 'dense first window and duration tail both require splitting');
  const result = f.analyzed.body.data;
  assert.equal(result.review_status, 'needs_review');
  assert.equal(result.current_step, 1);
  assert.deepEqual(result.billing, { charged: 6, held: 0, released: 0 });
  const read = response();
  f.handlers.getBlueprint(request(f.workId), read);
  assert.equal(read.statusCode, 200);
  const { blueprint, source_dialogue: sources } = read.body.data;
  const narrative = f.calls.flatMap((_, i) => visualFacts(1, i + 1).story);
  assert.deepEqual([blueprint.story.summary, ...blueprint.story.beats], narrative);
  assert.deepEqual(blueprint.causal_chain.map((item) => item.cause), narrative);
  assert.deepEqual(blueprint.locked_facts.map((item) => item.text), narrative);
  assert.deepEqual(blueprint.reversals.map((item) => item.text), narrative);
  const reread = response();
  f.handlers.getBlueprint(request(f.workId), reread);
  assert.equal(reread.body.data.blueprint.blueprint_hash, blueprint.blueprint_hash);
  assert.equal(blueprint.source.sha256, f.sourceSha);
  assert.equal(blueprint.shots[0].start_ms, 0);
  assert.equal(blueprint.shots.at(-1).end_ms, 25000);
  blueprint.shots.slice(1).forEach((shot, i) => assert.equal(shot.start_ms, blueprint.shots[i].end_ms));
  const dialogue = blueprint.shots.flatMap((shot) => shot.dialogue);
  assert.equal(dialogue.length, f.segments.length);
  assert.equal(new Set(dialogue.map((line) => line.id)).size, f.segments.length);
  assert.deepEqual(dialogue.map((line) => line.source_text).sort(), f.segments.map((line) => line.text).sort());
  assert.equal(sources.length, f.segments.length);
  assert.ok(sources.every((item) => item.status === 'resolved'));
  const cross = sources.find((item) => item.source_text === f.segments.at(-1).text);
  assert.equal(cross.source_start_ms, 23500);
  assert.equal(cross.source_end_ms, 24500);
  assert.equal(cross.cross_shot, true);
  const assets = f.db.prepare("SELECT * FROM assets WHERE category = 'redraw_source_analysis'").all();
  assert.equal(assets.length, 1);
  const bytes = fs.readFileSync(path.join(f.storageRoot, assets[0].local_path));
  assert.equal(digest(bytes), JSON.parse(assets[0].metadata).sha256);
  const visual = JSON.parse(bytes);
  const { facts_hash: factsHash, ...facts } = visual.facts;
  assert.equal(normalizeSourceFacts(facts).facts_hash, factsHash);
  assert.deepEqual(visual.diagnostics.ordered_narratives.story, narrative);
  assert.equal(digest(stableStringify(visual.diagnostics.ordered_narratives)), visual.diagnostics.narrative_order_hash);
  const audio = f.db.prepare("SELECT * FROM assets WHERE category = 'redraw_source_audio_evidence'").get();
  const raw = JSON.parse(fs.readFileSync(path.join(f.storageRoot, audio.local_path), 'utf8'));
  assert.deepEqual(raw.segments, f.segments.map((s) => ({
    start_ms: s.startMs, end_ms: s.endMs, source_text: s.text, speaker_cluster_id: s.speakerClusterId,
  })));
  for (const identity of [{ user: { id: 'other' } }, { tenant: { id: 'other' } }]) {
    const foreign = response();
    f.handlers.getBlueprint(request(f.workId, identity), foreign);
    assert.equal(foreign.statusCode, 404);
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type != 'redraw_analysis'").get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
});

test('an invalid second window stops the default product pipeline without a finished blueprint or generation', async (t) => {
  const f = await fixture(t, { failAt: 2 });
  assert.notEqual(f.analyzed.statusCode, 201);
  assert.equal(f.calls.length, 2);
  assert.equal(f.workerCalls, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_analysis'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_audio_evidence'").get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM redraw_episode_blueprints').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type != 'redraw_analysis'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE status = 'held'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE status = 'confirmed'").get().n, 0);
});

test('a timed-out window keeps local credits held and blocks another product analysis submission', async (t) => {
  const f = await fixture(t, { failAt: 2, failMode: 'unknown' });
  assert.notEqual(f.analyzed.statusCode, 201);
  assert.equal(f.calls.length, 2);
  const task = f.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_analysis'").get();
  assert.equal(task.status, 'needs_attention');
  assert.equal(f.db.prepare('SELECT status FROM redraw_works WHERE id = ?').get(f.workId).status, 'needs_attention');
  const reservations = f.db.prepare('SELECT * FROM tenant_usage_reservations').all();
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].status, 'held');
  assert.equal(reservations[0].amount, 6);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_analysis'").get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM redraw_episode_blueprints').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
  const retry = response();
  await f.handlers.analyzeWork(request(f.workId, { body: { locale: 'en-US', market: 'US', aspect_ratio: '9:16', style_preset_id: 1 } }), retry);
  assert.notEqual(retry.statusCode, 201);
  assert.equal(f.calls.length, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type = 'redraw_analysis'").get().n, 1);
  assert.equal(f.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(reservations[0].id).status, 'held');
});

test('a source audio result timeout keeps local credits held and blocks another product analysis submission', async (t) => {
  const f = await fixture(t, { workerErrorCode: 'REDRAW_LOCALE_VERIFIER_TIMEOUT' });
  assert.notEqual(f.analyzed.statusCode, 201);
  assert.equal(f.analyzed.body.error.message, 'SOURCE_AUDIO_RESULT_UNKNOWN');
  assert.equal(f.calls.length, 0);
  assert.equal(f.workerCalls, 1);
  const task = f.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_analysis'").get();
  assert.equal(task.status, 'needs_attention');
  assert.equal(f.db.prepare('SELECT status FROM redraw_works WHERE id = ?').get(f.workId).status, 'needs_attention');
  const reservations = f.db.prepare('SELECT * FROM tenant_usage_reservations').all();
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].status, 'held');
  assert.equal(reservations[0].amount, 6);
  assert.equal(task.credit_reservation_id, reservations[0].id);
  assert.equal(f.db.prepare('SELECT credit_reservation_id FROM redraw_works WHERE id = ?').get(f.workId).credit_reservation_id, reservations[0].id);
  assert.equal(f.db.prepare('SELECT task_id FROM redraw_works WHERE id = ?').get(f.workId).task_id, task.id);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_analysis'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_audio_evidence'").get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM redraw_episode_blueprints').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
  const retry = response();
  await f.handlers.analyzeWork(request(f.workId, {
    body: { locale: 'en-US', market: 'US', aspect_ratio: '9:16', style_preset_id: 1 },
  }), retry);
  assert.notEqual(retry.statusCode, 201);
  assert.match(retry.body.error.message, /结果未知/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type = 'redraw_analysis'").get().n, 1);
  const retryTask = f.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_analysis'").get();
  const retryWork = f.db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(f.workId);
  assert.equal(retryTask.id, task.id);
  assert.equal(retryTask.status, 'needs_attention');
  assert.equal(retryWork.status, 'needs_attention');
  assert.equal(retryWork.task_id, task.id);
  assert.equal(retryTask.credit_reservation_id, reservations[0].id);
  assert.equal(retryWork.credit_reservation_id, reservations[0].id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations').get().n, 1);
  assert.equal(f.db.prepare('SELECT id FROM tenant_usage_reservations').get().id, reservations[0].id);
  assert.equal(f.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(reservations[0].id).status, 'held');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE status = \'refunded\'').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE status = \'confirmed\'').get().n, 0);
  assert.equal(f.workerCalls, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_audio_evidence'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_analysis'").get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM redraw_episode_blueprints').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
});

test('an explicit source audio worker failure releases local credits and fails the product analysis', async (t) => {
  const f = await fixture(t, { workerErrorCode: 'SOURCE_AUDIO_PROVIDER_REJECTED' });
  assert.notEqual(f.analyzed.statusCode, 201);
  assert.equal(f.analyzed.body.error.message, 'SOURCE_AUDIO_ANALYSIS_FAILED');
  assert.equal(f.workerCalls, 1);
  assert.equal(f.calls.length, 0);
  const task = f.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_analysis'").get();
  assert.equal(task.status, 'failed');
  assert.equal(f.db.prepare('SELECT status FROM redraw_works WHERE id = ?').get(f.workId).status, 'failed');
  const reservations = f.db.prepare('SELECT * FROM tenant_usage_reservations').all();
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].status, 'refunded');
  assert.equal(reservations[0].amount, 6);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE status = 'held'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE status = 'confirmed'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category IN ('redraw_source_audio_evidence', 'redraw_source_analysis')").get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM redraw_episode_blueprints').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
});
