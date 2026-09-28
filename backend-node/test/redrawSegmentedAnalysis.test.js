'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const assetService = require('../src/services/assetService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const redraw = require('../src/services/redrawOrchestrator');
const nativeAnalysis = require('../src/services/redrawNativeSourceAnalysisService');
const {
  MAX_SOURCE_MS,
  planSegments,
  segmentCountForDuration,
} = require('../src/services/redrawAnalysisSegmentation');
const { knownCastFrom, mergeSegmentFacts } = require('../src/services/redrawSegmentFactsMerge');

const log = { info() {}, warn() {}, error() {} };

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

test('segment count follows duration and plan keeps count, contiguity and snaps to nearby cuts', () => {
  assert.equal(segmentCountForDuration(15_000), 1);
  assert.equal(segmentCountForDuration(25_000), 1);
  assert.equal(segmentCountForDuration(25_001), 2);
  assert.equal(segmentCountForDuration(68_733), 4);
  assert.equal(segmentCountForDuration(MAX_SOURCE_MS), 15);

  const plan = planSegments(68_733, 4, [16_500, 19_000, 35_900, 52_000, 60_000]);
  assert.equal(plan.length, 4);
  assert.equal(plan[0].start_ms, 0);
  assert.equal(plan[3].end_ms, 68_733);
  for (let index = 1; index < plan.length; index += 1) assert.equal(plan[index].start_ms, plan[index - 1].end_ms);
  assert.equal(plan[0].end_ms, 16_500, 'nearest cut within 3s of 17183');
  assert.equal(plan[1].end_ms, 35_900);
  assert.equal(plan[2].end_ms, 52_000);

  const noCuts = planSegments(40_000, 2, []);
  assert.deepEqual(noCuts, [{ start_ms: 0, end_ms: 20_000 }, { start_ms: 20_000, end_ms: 40_000 }]);
});

function segmentFacts({ names, durationMs, subtitle }) {
  return {
    schema_version: '2.0',
    duration_ms: durationMs,
    story: ['story'],
    characters: names.map((name, index) => ({
      id: `c${index + 1}`,
      source_name: name,
      display_name: name,
      relationship: 'r',
      relationships: index ? ['c1: friend'] : [],
      ...(index === 0 ? { appearance: `${name} outfit` } : {}),
    })),
    scenes: [{ id: 's1', location: 'Street', time: 'Day', source_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    props: [{ id: 'p1', name: 'bicycle', evidence_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    shots: [
      {
        id: 'shot-1', index: 1, start_ms: 0, end_ms: Math.round(durationMs / 2), composition: 'a', camera_movement: 'static',
        opening_state: 'o', continuous_action: 'c', ending_state: 'e',
        visible_character_ids: ['c1'], dialogue: [{ id: 't1', speaker_id: 'c1', source_text: subtitle, start_ms: 100, end_ms: 900 }],
        text_regions: [{
          id: 'txt1', kind: 'subtitle', source_text: subtitle, speaker_id: 'c1', polygon: [[0.1, 0.8], [0.9, 0.8], [0.9, 0.9]],
        }],
        audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
        confidence: { character_mapping: 0.8, speaker_mapping: 0.5, text_regions: 0.8, shot_boundary: 0.8 },
      },
      {
        id: 'shot-2', index: 2, start_ms: Math.round(durationMs / 2), end_ms: durationMs - 40, composition: 'b', camera_movement: 'static',
        opening_state: 'o', continuous_action: 'c', ending_state: 'e',
        visible_character_ids: names.map((_, index) => `c${index + 1}`), dialogue: [], text_regions: [],
        audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
        confidence: { character_mapping: 0.8, speaker_mapping: 0.5, text_regions: 0.8, shot_boundary: 0.8 },
      },
    ],
    causal_chain: ['cause'],
    locked_facts: ['c1 rides'],
    reversals: ['turn'],
    episode_hook: 'hook',
  };
}

test('merge renumbers ids, joins same-named characters across segments and keeps the timeline gap-free', () => {
  const merged = mergeSegmentFacts([
    { start_ms: 0, end_ms: 20_000, facts: segmentFacts({ names: ['林江'], durationMs: 20_000, subtitle: '你谁啊' }) },
    { start_ms: 20_000, end_ms: 40_000, facts: segmentFacts({ names: ['林江', '陆飞宇'], durationMs: 20_000, subtitle: '走吧' }) },
  ], 40_000);
  assert.deepEqual(merged.characters.map((c) => [c.id, c.source_name]), [['c1', '林江'], ['c2', '陆飞宇']]);
  assert.equal(merged.characters[0].appearance, '林江 outfit');
  assert.deepEqual(merged.shots.map((s) => [s.id, s.index, s.start_ms, s.end_ms]), [
    ['shot-1', 1, 0, 10_000], ['shot-2', 2, 10_000, 20_000], ['shot-3', 3, 20_000, 30_000], ['shot-4', 4, 30_000, 40_000],
  ]);
  assert.deepEqual(merged.shots[3].visible_character_ids, ['c1', 'c2']);
  assert.equal(merged.shots[2].dialogue[0].id, 'seg2-t1');
  assert.deepEqual([merged.shots[2].dialogue[0].start_ms, merged.shots[2].dialogue[0].end_ms], [20_100, 20_900]);
  assert.equal(merged.shots[2].text_regions[0].id, 'seg2-txt1');
  assert.equal(merged.shots[2].text_regions[0].speaker_id, 'c1');
  assert.equal(merged.scenes.length, 1);
  assert.deepEqual(merged.scenes[0].source_ranges, [{ start_ms: 0, end_ms: 20_000 }, { start_ms: 20_000, end_ms: 40_000 }]);
  assert.equal(merged.props.length, 1);
  assert.deepEqual(merged.characters[1].relationships, ['c1: friend']);
  assert.deepEqual(knownCastFrom(merged), [{ name: '林江', appearance: '林江 outfit' }, { name: '陆飞宇', appearance: '' }]);
});

function createVideo(storageRoot, seconds) {
  const relative = 'uploads/long-source.mp4';
  const absolute = path.join(storageRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `testsrc=size=160x284:rate=6:duration=${seconds}`, '-pix_fmt', 'yuv420p', absolute], { stdio: 'pipe' });
  return relative;
}

test('analyzeNativeSource splits a long source, passes the known cast forward and merges the segments', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-analysis-'));
  const db = createDb();
  try {
    const localPath = createVideo(storageRoot, 40);
    const asset = assetService.create(db, log, {
      name: 'long.mp4', type: 'video', category: 'redraw_source', local_path: localPath,
      metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
    });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
      VALUES (1, 'tenant-1', 'user-1', 'p', 'draft', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO redraw_works (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
      duration_ms, status, current_step, created_at, updated_at)
      VALUES (1, 1, 'tenant-1', 'user-1', 'w', ?, 'fp', 40000, 'draft', 1, ?, ?)`).run(asset.id, now, now);

    const prompts = [];
    const progress = [];
    const result = await nativeAnalysis.analyzeNativeSource({
      db,
      log,
      storageRoot,
      assetService,
      onProgress: (item) => progress.push(item),
      visionDetailed: async (payload) => {
        prompts.push(payload.userPrompt);
        const isEnrichment = /adding recreation details/.test(payload.userPrompt);
        if (isEnrichment) {
          return { text: JSON.stringify({ shots: [{ id: 'shot-1', shot_size: 'close-up' }] }), provider_task_id: `enrich-${prompts.length}` };
        }
        const duration = Number(/duration_ms=(\d+)/.exec(payload.userPrompt)[1]);
        const names = prompts.filter((p) => !/adding recreation details/.test(p)).length === 1 ? ['林江'] : ['林江', '陆飞宇'];
        const facts = segmentFacts({ names, durationMs: duration, subtitle: '你好' });
        facts.shots[1].end_ms = duration;
        return { text: JSON.stringify({ source_facts: facts }), provider_task_id: `pass1-${prompts.length}`, model: 'm' };
      },
    }, { workId: 1, tenantId: 'tenant-1', userId: 'user-1', taskId: 'task-seg', model: 'm', segmentCount: 2 });

    assert.equal(prompts.length, 4, 'two segments x (first pass + enrichment)');
    assert.doesNotMatch(prompts[0], /already identified in earlier parts/);
    assert.match(prompts[2], /already identified in earlier parts/);
    assert.match(prompts[2], /林江/);
    assert.deepEqual(progress, [{ completed: 1, total: 2 }, { completed: 2, total: 2 }]);
    assert.equal(result.status, 'completed');
    const saved = JSON.parse(fs.readFileSync(path.join(storageRoot, db.prepare('SELECT local_path FROM assets WHERE id = ?')
      .get(result.result_asset_id).local_path), 'utf8'));
    // 线上版把 v2 结果存在 facts_v2，main 直接存在 facts。
    const factsOut = saved.facts_v2 || saved.facts;
    assert.equal(saved.segments.length, 2);
    assert.equal(saved.enrichment.status, 'completed');
    assert.equal(factsOut.shots.length, 4);
    assert.equal(factsOut.shots[0].start_ms, 0);
    assert.equal(factsOut.shots.at(-1).end_ms, saved.facts.duration_ms);
    assert.deepEqual(factsOut.characters.map((c) => c.source_name), ['林江', '陆飞宇']);
    assert.equal(factsOut.shots[0].shot_size, 'close-up');
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function addVerifiedConfig(db) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs (service_type, provider, name, model, default_model, is_active, is_default,
    priority, settings, created_at, updated_at)
    VALUES ('video_understanding', 'test', 'v', 'GPT-5.5', 'GPT-5.5', 1, 1, 0, ?, ?, ?)`).run(JSON.stringify({
    real_generation_verified: true,
    evidence: { provider_task_id: 't', result_asset_id: 'r', result_asset_readable: true, completed_at: now },
  }), now, now);
}

function addWork(db, durationMs) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO assets (id, local_path, created_at, updated_at) VALUES (501, 'uploads/source.mp4', ?, ?)").run(now, now);
  db.prepare("INSERT INTO assets (id, local_path, created_at, updated_at) VALUES (502, 'uploads/result.json', ?, ?)").run(now, now);
  db.prepare(`INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, 'tenant-1', 'user-1', 'p', 'draft', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
    status, current_step, created_at, updated_at) VALUES (1, 1, 'tenant-1', 'user-1', 'w', 501, 'fp', ?, 'draft', 1, ?, ?)`)
    .run(durationMs, now, now);
}

test('quote and reservation charge per segment and long sources are refused before any reservation', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  prices.set(db, 'GPT-5.5', 10);
  creditLedger.setTenantAccountBalance(db, 'tenant-1', 1000);
  const quote = redraw.quoteAnalysis(db, log, { duration_ms: 68_733 });
  assert.deepEqual([quote.credits, quote.unit_credits, quote.segments, quote.exceeds_max_duration], [40, 10, 4, false]);
  assert.equal(redraw.quoteAnalysis(db, log).credits, 10, 'no work means a single segment');

  addWork(db, MAX_SOURCE_MS + 1);
  await assert.rejects(
    redraw.startAnalysis(db, log, { workId: 1, userId: 'user-1' }, { provider: { startAnalysis: async () => ({}) } }),
    (error) => error.code === 'REDRAW_SOURCE_TOO_LONG',
  );
  assert.equal(creditLedger.getTenantAccount(db, 'tenant-1').held, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type = 'redraw_analysis'").get().n, 0);
});

test('a multi-segment analysis runs in the background, reserves per segment and settles when it completes', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  prices.set(db, 'GPT-5.5', 10);
  creditLedger.setTenantAccountBalance(db, 'tenant-1', 1000);
  addWork(db, 68_733);
  let finishRun;
  const runFinished = new Promise((resolve) => { finishRun = resolve; });
  let providerRequest;
  const started = await redraw.startAnalysis(db, log, { workId: 1, userId: 'user-1' }, {
    provider: {
      startAnalysis: (request) => {
        providerRequest = request;
        return redraw.startBackgroundAnalysis(db, log, request, async () => {
          await runFinished;
          return {
            status: 'completed',
            provider_task_id: 'pass1-1',
            result_asset_id: 502,
            facts: {
              duration_ms: 10_000,
              characters: [{ id: 'c1', source_name: '阿岚', relationships: [] }],
              scenes: [{ id: 's1', location: '天台', time: '夜', source_ranges: [{ start_ms: 0, end_ms: 10_000 }] }],
              props: [{ id: 'p1', name: '旧手机', evidence_ranges: [{ start_ms: 0, end_ms: 1_000 }] }],
              shots: [{
                id: 'sh1', start_ms: 0, end_ms: 10_000, dialogue: [], screen_text: '',
                opening_state: 'a', continuous_action: 'b', ending_state: 'c',
              }],
              causal_chain: ['c'], locked_facts: ['l'], reversals: ['r'], episode_hook: 'h',
            },
          };
        }, { assetReader: { canRead: (asset) => Boolean(asset?.local_path) } });
      },
    },
  });
  assert.equal(providerRequest.segmentCount, 4);
  assert.equal(started.status, 'processing');
  assert.equal(started.billing.held, 40);
  const task = db.prepare('SELECT status, provider_task_id, metadata FROM async_tasks WHERE id = ?').get(started.task_id);
  assert.equal(task.status, 'processing');
  assert.match(task.provider_task_id, /^native-segmented:/);
  assert.equal(JSON.parse(task.metadata).redraw_analysis_segments, 4);

  redraw.reportAnalysisProgress(db, started.task_id, 2, 4);
  assert.equal(db.prepare('SELECT message FROM async_tasks WHERE id = ?').get(started.task_id).message, '分段分析 2/4');

  finishRun();
  const deadline = Date.now() + 2000;
  while (db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(started.task_id).status === 'processing') {
    if (Date.now() > deadline) throw new Error('background analysis did not finalize');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(started.task_id).status, 'completed');
  assert.equal(creditLedger.getTenantAccount(db, 'tenant-1').spent, 40);
  assert.equal(creditLedger.getTenantAccount(db, 'tenant-1').held, 0);
});
