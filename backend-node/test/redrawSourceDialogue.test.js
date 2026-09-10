const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const assetService = require('../src/services/assetService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { fuseEpisodeEvidence } = require('../src/services/redrawEvidenceFusionService');
const { analyzeSourceAudio } = require('../src/services/redrawSourceAudioEvidenceService');
const servicePath = path.join(__dirname, '../src/services/redrawSourceDialogueService.js');
const service = fs.existsSync(servicePath) ? require(servicePath) : {};
const log = { info() {}, warn() {}, error() {} };
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const now = '2026-09-05T01:02:03.000Z';
let schemaBytes;

function createDatabase() {
  if (!schemaBytes) {
    const seed = new Database(':memory:');
    runMigrationsAndEnsure(seed);
    schemaBytes = seed.serialize();
    seed.close();
  }
  return new Database(schemaBytes);
}

function createHarness(t, { start = 2500, end = 4500, cuts = [0, 3000, 12000], explicitId = true } = {}) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-source-dialogue-'));
  const db = createDatabase();
  t.after(() => {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(storageRoot, 'uploads'));
  fs.writeFileSync(path.join(storageRoot, 'uploads/source.mp4'), 'source-video');
  const sourceSha = hash('source-video');
  const sourceAsset = assetService.create(db, log, {
    name: 'source', type: 'video', category: 'redraw_source', local_path: 'uploads/source.mp4',
    metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
  });
  db.prepare(`INSERT INTO redraw_projects
    (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, 'tenant-1', 'user-1', 'dialogue', 'draft', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, status, current_step, created_at, updated_at)
    VALUES (1, 1, 'tenant-1', 'user-1', 'dialogue', ?, ?, ?, 'draft', 1, ?, ?)`)
    .run(sourceAsset.id, sourceSha, cuts.at(-1), now, now);
  const evidence = {
    schema_version: 'redraw-source-audio-evidence-v1', task_id: 'task-original-1',
    work_id: 1, tenant_id: 'tenant-1', user_id: 'user-1', source_asset_id: sourceAsset.id,
    source_video_sha256: sourceSha, audio_sha256: hash('audio'), transcript_sha256: hash('transcript'),
    source_language: 'zh', language_probability: 0.98, dialogue_mode: 'spoken', created_at: now,
    segments: [{
      ...(explicitId ? { id: 'original-line-1' } : {}), start_ms: start, end_ms: end,
      source_text: '不要打开那封信。', speaker_cluster_id: 'speaker-cluster-1',
    }],
  };
  const evidencePath = path.join(storageRoot, 'evidence.json');
  const metadata = {
    schema_version: evidence.schema_version, tenant_id: evidence.tenant_id, user_id: evidence.user_id,
    work_id: evidence.work_id, source_asset_id: evidence.source_asset_id,
    source_video_sha256: evidence.source_video_sha256, audio_sha256: evidence.audio_sha256,
    transcript_sha256: evidence.transcript_sha256,
  };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  metadata.evidence_sha256 = hash(fs.readFileSync(evidencePath));
  const evidenceAsset = assetService.create(db, log, {
    name: 'evidence', type: 'json', category: 'redraw_source_audio_evidence',
    local_path: 'evidence.json', file_size: fs.statSync(evidencePath).size, metadata,
  });
  const source = {
    asset_id: sourceAsset.id, sha256: sourceSha, duration_ms: cuts.at(-1), width: 1080, height: 1920,
    fps: 25, video_codec: 'h264', audio_codec: 'aac', audio_sample_rate_hz: 48000, audio_channels: 2,
  };
  const visualFacts = {
    duration_ms: source.duration_ms, result_asset_id: 901, sha256: hash('visual'),
    story: ['她发现了一封信。', '她想要拆开信封。'],
    characters: [{ id: 'character-1', source_name: '林娜', relationship: '主人公' }],
    scenes: [{ id: 'scene-1', location: '客厅', time: '白天', source_ranges: [{ start_ms: 0, end_ms: source.duration_ms }] }],
    props: [{ id: 'prop-1', name: '信封', evidence_ranges: [{ start_ms: 0, end_ms: source.duration_ms }] }],
    shots: cuts.slice(0, -1).map((cut, index) => ({
      id: `shot-${index + 1}`, index: index + 1, start_ms: cut, end_ms: cuts[index + 1],
      composition: '信封特写', camera_movement: '固定', opening_state: '信封在桌上',
      continuous_action: '伸手取信', ending_state: '拿起信封', visible_character_ids: [],
      text_regions: [], confidence: {},
    })),
    causal_chain: ['她发现信封'], locked_facts: ['信封在桌上'], reversals: ['信中藏着秘密'], episode_hook: '信里写了什么？',
  };
  const evidenceItems = [{
    id: 'visual-1', kind: 'visual', asset_id: 901, sha256: hash('visual'), tool: 'visual', tool_version: '1',
  }, {
    id: 'audio-1', kind: 'audio_transcript', asset_id: evidenceAsset.id,
    sha256: metadata.evidence_sha256, tool: 'source-audio-evidence', tool_version: '1',
  }];
  const blueprint = fuseEpisodeEvidence({ source, visualFacts, audioEvidence: evidence, evidenceAssets: evidenceItems });
  return {
    ctx: { db, tenantId: 'tenant-1', userId: 'user-1', storageRoot }, db, storageRoot,
    sourceAsset, evidenceAsset, evidencePath, evidence, metadata, blueprint, visualFacts,
    turn: blueprint.shots.flatMap((shot) => shot.dialogue)[0],
    rewriteEvidence() {
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));
      metadata.evidence_sha256 = hash(fs.readFileSync(evidencePath));
      db.prepare('UPDATE assets SET metadata = ?, file_size = ? WHERE id = ?')
        .run(JSON.stringify(metadata), fs.statSync(evidencePath).size, evidenceAsset.id);
      blueprint.evidence_manifest.items.find((item) => item.id === 'audio-1').sha256 = metadata.evidence_sha256;
    },
    rewriteMetadata() {
      db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), evidenceAsset.id);
    },
  };
}

function resolve(h, blueprint = h.blueprint) {
  assert.equal(typeof service.resolveBlueprintDialogueSources, 'function', 'read-only source dialogue resolver is missing');
  const before = JSON.stringify(blueprint);
  const changesBefore = h.db.prepare('SELECT total_changes() AS count').get().count;
  const result = service.resolveBlueprintDialogueSources(h.ctx, { workId: 1, blueprint });
  assert.equal(JSON.stringify(blueprint), before, 'resolver must not mutate blueprint or its hash');
  assert.equal(h.db.prepare('SELECT total_changes() AS count').get().count, changesBefore, 'resolver must not write to the database');
  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, blueprint.shots.flatMap((shot) => shot.dialogue || []).length);
  assert.doesNotMatch(JSON.stringify(result), /redraw-source-dialogue-|local_path|metadata|task-original-1/);
  return result;
}

const rangeCases = [
  ['two shots', { start: 2500, end: 4500 }, 'shot-2', 3000, 4500, true],
  ['three shots', { start: 1000, end: 5000, cuts: [0, 2000, 4000, 12000] }, 'shot-2', 2000, 4000, true],
  ['midpoint at cut', { start: 2000, end: 4000 }, 'shot-2', 3000, 4000, true],
  ['sentence ends at cut', { start: 1000, end: 3000 }, 'shot-1', 1000, 3000, false],
  ['ordinary same-shot line', { start: 3200, end: 4000 }, 'shot-2', 3200, 4000, false],
  ['automatic ID roundtrip', { start: 2500, end: 4500, explicitId: false }, 'shot-2', 3000, 4500, true],
];
for (const [label, options, shotId, projectionStart, projectionEnd, crossShot] of rangeCases) {
  test(`resolves full original source interval for ${label}`, (t) => {
    const h = createHarness(t, options);
    assert.deepEqual(resolve(h), [{
      dialogue_id: h.turn.id, shot_id: shotId, status: 'resolved', reason: 'SOURCE_DIALOGUE_RESOLVED',
      source_start_ms: options.start, source_end_ms: options.end, source_text: '不要打开那封信。',
      source_language: 'zh', projection_start_ms: projectionStart, projection_end_ms: projectionEnd,
      cross_shot: crossShot, evidence_ref: 'audio-1', evidence_sha256: h.metadata.evidence_sha256,
    }]);
  });
}

const invalidCases = [
  ['forged dialogue ID', (h) => { h.turn.id = 'forged-line'; }],
  ['forged evidence reference', (h) => { h.turn.evidence_refs = ['forged-evidence']; }],
  ['source text drift with same ID', (h) => { h.turn.source_text = '改写后的句子'; }],
  ['source language drift with same ID', (h) => { h.turn.source_language = 'en'; }],
  ['projection drift', (h) => { h.turn.start_ms = 3001; }],
  ['fractional projection', (h) => { h.turn.end_ms = 4499.5; }],
  ['projection string', (h) => { h.turn.start_ms = '3000'; }],
  ['negative shot start', (h) => { h.blueprint.shots[1].start_ms = -1; }],
  ['out-of-range shot end', (h) => { h.blueprint.shots[1].end_ms = 12001; }],
  ['source duration drift', (h) => { h.blueprint.source.duration_ms = 12001; }],
  ['invalid source duration', (h) => { h.blueprint.source.duration_ms = '12000'; }],
  ['blueprint source ID drift', (h) => { h.blueprint.source.asset_id = 999; }],
  ['blueprint source SHA drift', (h) => { h.blueprint.source.sha256 = hash('different-source'); }],
  ['work fingerprint absent', (h) => { h.db.prepare("UPDATE redraw_works SET source_fingerprint = '' WHERE id = 1").run(); }],
  ['deleted work', (h) => { h.db.prepare('UPDATE redraw_works SET deleted_at = ? WHERE id = 1').run(now); }],
  ['different requesting owner', (h) => { h.ctx.userId = 'user-2'; }],
  ['missing manifest asset', (h) => { h.blueprint.evidence_manifest.items.find((item) => item.id === 'audio-1').asset_id = 999; }],
  ['deleted evidence asset', (h) => { h.db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ?').run(now, h.evidenceAsset.id); }],
  ['wrong evidence category', (h) => { h.db.prepare("UPDATE assets SET category = 'redraw_source' WHERE id = ?").run(h.evidenceAsset.id); }],
  ['different metadata tenant', (h) => { h.metadata.tenant_id = 'tenant-2'; h.rewriteMetadata(); }],
  ['different metadata user', (h) => { h.metadata.user_id = 'user-2'; h.rewriteMetadata(); }],
  ['different metadata work', (h) => { h.metadata.work_id = 2; h.rewriteMetadata(); }],
  ['different metadata source', (h) => { h.metadata.source_asset_id = 999; h.rewriteMetadata(); }],
  ['different metadata source hash', (h) => { h.metadata.source_video_sha256 = hash('other'); h.rewriteMetadata(); }],
  ['metadata evidence hash drift', (h) => { h.metadata.evidence_sha256 = hash('other'); h.rewriteMetadata(); }],
  ['file hash drift', (h) => { fs.appendFileSync(h.evidencePath, ' '); }],
  ['missing file', (h) => { fs.unlinkSync(h.evidencePath); }],
  ['invalid JSON with matching manifest hash', (h) => {
    fs.writeFileSync(h.evidencePath, '{');
    h.metadata.evidence_sha256 = hash('{'); h.rewriteMetadata();
    h.blueprint.evidence_manifest.items.find((item) => item.id === 'audio-1').sha256 = hash('{');
  }],
  ['wrong evidence schema', (h) => { h.evidence.schema_version = 'other-v1'; h.rewriteEvidence(); }],
  ['different evidence owner', (h) => { h.evidence.user_id = 'other'; h.rewriteEvidence(); }],
  ['different evidence work', (h) => { h.evidence.work_id = 2; h.rewriteEvidence(); }],
  ['different evidence source', (h) => { h.evidence.source_asset_id = 999; h.rewriteEvidence(); }],
  ['different evidence source hash', (h) => { h.evidence.source_video_sha256 = hash('other'); h.rewriteEvidence(); }],
  ['evidence audio hash drift', (h) => { h.evidence.audio_sha256 = hash('other'); h.rewriteEvidence(); }],
  ['evidence transcript hash drift', (h) => { h.evidence.transcript_sha256 = hash('other'); h.rewriteEvidence(); }],
  ['duplicate original ID', (h) => { h.evidence.segments.push({ ...h.evidence.segments[0], start_ms: 4500, end_ms: 5000 }); h.rewriteEvidence(); }],
  ['duplicate manifest ID', (h) => { h.blueprint.evidence_manifest.items.push({ ...h.blueprint.evidence_manifest.items.find((item) => item.id === 'audio-1') }); }],
  ['duplicate dialogue ID', (h) => { h.blueprint.shots[0].dialogue.push({ ...h.turn, start_ms: 2500, end_ms: 3000 }); }],
  ['original range outside source duration', (h) => { h.evidence.segments[0].end_ms = 13000; h.rewriteEvidence(); }],
  ['original fractional start', (h) => { h.evidence.segments[0].start_ms = 2500.5; h.rewriteEvidence(); }],
  ['original string start', (h) => { h.evidence.segments[0].start_ms = '2500'; h.rewriteEvidence(); }],
  ['original negative start', (h) => { h.evidence.segments[0].start_ms = -1; h.rewriteEvidence(); }],
  ['original invalid speaker', (h) => { h.evidence.segments[0].speaker_cluster_id = 'unknown'; h.rewriteEvidence(); }],
  ['missing transcript hash', (h) => { delete h.evidence.transcript_sha256; h.rewriteEvidence(); }],
  ['missing language confidence', (h) => { delete h.evidence.language_probability; h.rewriteEvidence(); }],
];
for (const [label, mutate] of invalidCases) {
  test(`fails closed without leaking evidence for ${label}`, (t) => {
    const h = createHarness(t);
    mutate(h);
    for (const item of resolve(h)) {
      assert.equal(item.status, 'unresolved');
      assert.match(item.reason, /^SOURCE_DIALOGUE_[A-Z_]+$/);
      assert.equal(Object.hasOwn(item, 'source_start_ms'), false);
      assert.equal(Object.hasOwn(item, 'source_text'), false);
    }
  });
}

test('does not read foreign asset bytes before rejecting ownership', (t) => {
  const h = createHarness(t);
  h.metadata.user_id = 'user-2'; h.rewriteMetadata();
  let reads = 0;
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args) => { reads += 1; return originalRead(...args); });
  assert.equal(resolve(h)[0].status, 'unresolved');
  assert.equal(reads, 0);
});

test('reads and parses a shared evidence asset only once per resolution', (t) => {
  const h = createHarness(t, { start: 1000, end: 1500 });
  h.evidence.segments.push({ id: 'original-line-2', start_ms: 3500, end_ms: 4000, source_text: '等等。', speaker_cluster_id: 'speaker-cluster-1' });
  h.rewriteEvidence();
  h.blueprint.shots[1].dialogue.push({ ...h.turn, id: 'original-line-2', source_text: '等等。', start_ms: 3500, end_ms: 4000 });
  let reads = 0;
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args) => { reads += 1; return originalRead(...args); });
  assert.deepEqual(resolve(h).map((item) => item.status), ['resolved', 'resolved']);
  assert.equal(reads, 1);
});

for (const escape of ['parent', 'absolute', 'junction', 'storage-junction', 'directory']) {
  test(`rejects evidence path ${escape} without disclosing the path`, (t) => {
    const h = createHarness(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-dialogue-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'evidence.json'), fs.readFileSync(h.evidencePath));
    let localPath;
    if (escape === 'parent') localPath = path.relative(h.storageRoot, path.join(outside, 'evidence.json'));
    if (escape === 'absolute') localPath = path.join(outside, 'evidence.json');
    if (escape === 'junction') {
      fs.symlinkSync(outside, path.join(h.storageRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      localPath = 'linked/evidence.json';
    }
    if (escape === 'storage-junction') {
      const link = path.join(outside, 'storage');
      fs.symlinkSync(h.storageRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
      h.ctx.storageRoot = link;
      localPath = 'evidence.json';
    }
    if (escape === 'directory') localPath = 'uploads';
    h.db.prepare('UPDATE assets SET local_path = ? WHERE id = ?').run(localPath, h.evidenceAsset.id);
    assert.equal(resolve(h)[0].status, 'unresolved');
  });
}

test('legacy manual dialogue explicitly has no available original audio source', (t) => {
  const h = createHarness(t);
  h.db.prepare('DELETE FROM assets WHERE id = ?').run(h.evidenceAsset.id);
  h.blueprint.evidence_manifest.items = h.blueprint.evidence_manifest.items.filter((item) => item.id !== 'audio-1');
  h.turn.id = 'manual-line'; h.turn.evidence_refs = ['visual-1'];
  const result = resolve(h);
  assert.deepEqual(result, [{
    dialogue_id: 'manual-line', shot_id: 'shot-2', status: 'not_available', reason: 'SOURCE_DIALOGUE_EVIDENCE_NOT_AVAILABLE',
  }]);
});

test('legacy owned manual blueprint may omit both source and evidence when no ASR was ever registered', (t) => {
  const h = createHarness(t);
  h.db.prepare('DELETE FROM assets WHERE id = ?').run(h.evidenceAsset.id);
  h.db.prepare("UPDATE redraw_works SET source_fingerprint = '' WHERE id = 1").run();
  const blueprint = { shots: [{ id: 'old-shot', dialogue: [{ id: 'old-line', source_text: '旧人工对白' }] }] };
  assert.deepEqual(resolve(h, blueprint), [{
    dialogue_id: 'old-line', shot_id: 'old-shot', status: 'not_available', reason: 'SOURCE_DIALOGUE_EVIDENCE_NOT_AVAILABLE',
  }]);
  h.ctx.userId = 'other';
  assert.equal(resolve(h, blueprint)[0].status, 'unresolved');
});

function createLegacyWorkHarness(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE redraw_works (
    id INTEGER PRIMARY KEY, tenant_id TEXT, user_id TEXT, source_asset_id INTEGER,
    source_fingerprint TEXT, duration_ms INTEGER, deleted_at TEXT
  );
  INSERT INTO redraw_works VALUES (1, 'tenant-1', 'user-1', NULL, NULL, 12000, NULL);`);
  return { db, ctx: { db, tenantId: 'tenant-1', userId: 'user-1' },
    blueprint: { shots: [{ id: 'legacy-shot', dialogue: [{ id: 'legacy-line' }] }] } };
}

test('legacy work-only database without assets returns not_available after owner verification', (t) => {
  const h = createLegacyWorkHarness(t);
  assert.deepEqual(resolve(h), [{ dialogue_id: 'legacy-line', shot_id: 'legacy-shot',
    status: 'not_available', reason: 'SOURCE_DIALOGUE_EVIDENCE_NOT_AVAILABLE' }]);
  h.ctx.userId = 'other';
  assert.equal(resolve(h)[0].reason, 'SOURCE_DIALOGUE_WORK_NOT_FOUND');
  h.ctx.userId = 'user-1';
  h.db.prepare('UPDATE redraw_works SET deleted_at = ? WHERE id = 1').run(now);
  assert.equal(resolve(h)[0].reason, 'SOURCE_DIALOGUE_WORK_NOT_FOUND');
});

for (const declaration of ['manifest', 'audio-segment-ID']) {
  test(`legacy work-only database without assets cannot resolve declared ASR (${declaration})`, (t) => {
    const h = createLegacyWorkHarness(t);
    if (declaration === 'manifest') {
      h.blueprint.evidence_manifest = { items: [{ id: 'audio-1', kind: 'audio_transcript',
        asset_id: 1, sha256: hash('audio'), tool: 'source-audio-evidence', tool_version: '1' }] };
    } else {
      h.blueprint.shots[0].dialogue[0].id = 'audio-segment-legacy';
    }
    assert.equal(resolve(h)[0].status, 'unresolved');
  });
}

test('legacy work-only compatibility does not swallow other assets SQL errors', (t) => {
  const h = createLegacyWorkHarness(t);
  h.db.exec('CREATE TABLE assets (id INTEGER PRIMARY KEY)');
  assert.deepEqual(resolve(h), [{ dialogue_id: 'legacy-line', shot_id: 'legacy-shot',
    status: 'unresolved', reason: 'SOURCE_DIALOGUE_EVIDENCE_INVALID' }]);
});

for (const deleted of [false, true]) {
  test(`registered ASR cannot downgrade to manual by removing manifest and changing ID (deleted=${deleted})`, (t) => {
    const h = createHarness(t, { explicitId: false });
    if (deleted) h.db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ?').run(now, h.evidenceAsset.id);
    delete h.blueprint.evidence_manifest;
    h.turn.id = 'claimed-manual';
    h.turn.evidence_refs = [];
    const result = resolve(h);
    assert.equal(result[0].status, 'unresolved');
  });
}

test('an audio-segment ID without an audio manifest is unresolved, not legacy fallback', (t) => {
  const h = createHarness(t, { explicitId: false });
  h.blueprint.evidence_manifest.items = h.blueprint.evidence_manifest.items.filter((item) => item.id !== 'audio-1');
  h.turn.evidence_refs = ['visual-1'];
  assert.equal(resolve(h)[0].status, 'unresolved');
});

test('declared audio manifest without a turn audio reference stays unresolved', (t) => {
  const h = createHarness(t);
  h.turn.evidence_refs = ['visual-1'];
  assert.equal(resolve(h)[0].status, 'unresolved');
});

test('silent blueprint without dialogue returns an empty collection', (t) => {
  const h = createHarness(t);
  h.blueprint.shots.forEach((shot) => { shot.dialogue = []; });
  assert.deepEqual(resolve(h), []);
});

test('real persisted source evidence and fusion automatic IDs roundtrip without a new evidence contract', async (t) => {
  const h = createHarness(t, { explicitId: false });
  const privateAudioRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-dialogue-private-'));
  t.after(() => fs.rmSync(privateAudioRoot, { recursive: true, force: true }));
  const evidence = await analyzeSourceAudio({
    ...h.ctx, privateAudioRoot, log, ffmpegPath: 'test-ffmpeg',
    execFile: async (command, args) => { fs.writeFileSync(args.at(-1), 'pcm-audio'); },
    workerClient: { async analyzeSourceAudio(input) {
      return { requestId: input.requestId, audioSha256: input.audioSha256, transcriptSha256: hash('transcript'),
        sourceLanguage: 'zh', languageProbability: 0.98,
        segments: [{ startMs: 2500, endMs: 4500, text: '不要打开那封信。', speakerClusterId: 'speaker-cluster-1' }] };
    } },
  }, { workId: 1, sourceAssetId: h.sourceAsset.id, tenantId: 'tenant-1', userId: 'user-1' });
  const items = h.blueprint.evidence_manifest.items.map((item) => item.id === 'audio-1'
    ? { ...item, asset_id: evidence.result_asset_id, sha256: evidence.evidence_sha256 } : item);
  const blueprint = fuseEpisodeEvidence({ source: h.blueprint.source, visualFacts: h.visualFacts, audioEvidence: evidence, evidenceAssets: items });
  const result = resolve(h, blueprint);
  assert.equal(result[0].status, 'resolved');
  assert.match(result[0].dialogue_id, /^audio-segment-/);
  assert.equal(result[0].source_start_ms, 2500);
  assert.equal(result[0].source_end_ms, 4500);
  assert.equal(result[0].projection_start_ms, 3000);
  assert.equal(result[0].evidence_sha256, evidence.evidence_sha256);
});
