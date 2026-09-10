const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const assetService = require('../src/services/assetService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const sourceAudio = require('../src/services/redrawSourceAudioEvidenceService');
const { planAnalysisWindows } = require('../src/services/redrawAnalysisWindowService');
const { buildPrompt } = require('../src/services/redrawNativeSourceAnalysisService');
const fusion = require('../src/services/redrawEvidenceFusionService');
const blueprintService = require('../src/services/redrawEpisodeBlueprintService');
const dialogueService = require('../src/services/redrawSourceDialogueService');
const workflow = require('../src/services/redrawBlueprintWorkflowService');
const redraw = require('../src/services/redrawOrchestrator');
const prices = require('../src/services/modelPriceService');
const creditLedger = require('../src/services/creditLedgerService');

const log = { info() {}, warn() {}, error() {} };
const now = '2026-09-09T02:03:04.000Z';
const V2 = 'redraw-source-audio-evidence-v2';
const durationMs = 1800000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fullText = '  保留这一整句，不能自动裁剪。 Full original sentence. \n';
const plans = [
  { window_id: 'aw000001', index: 0, analysis_range_ms: { start_ms: 0, end_ms: 1530000 },
    commit_range_ms: { start_ms: 0, end_ms: 1500000 } },
  { window_id: 'aw000002', index: 1, analysis_range_ms: { start_ms: 1470000, end_ms: durationMs },
    commit_range_ms: { start_ms: 1500000, end_ms: durationMs } },
];

function aggregateFixture({ silent = false, integer = false } = {}) {
  const groups = silent ? [[], []] : [
    [{ start: integer ? 1499 : 1499.1254, end: integer ? 1502 : 1502.1256,
      text: fullText, speaker_cluster_id: 'speaker-cluster-1' }],
    [{ start: integer ? 29.5 : 29.6254, end: integer ? 32.5 : 32.6256,
      text: fullText.trim(), speaker_cluster_id: 'speaker-cluster-1' },
    { start: integer ? 120 : 120.1254, end: integer ? 121 : 121.1256,
      text: '另一窗口同编号不代表同一人。', speaker_cluster_id: 'speaker-cluster-1' }],
  ];
  const input = { audioDurationMs: durationMs, audioSha256: hash('complete synthetic PCM'),
    windows: plans.map((plan, index) => {
      const requestId = `local-v2-window-${index + 1}`;
      const raw = { audio_sha256: hash(`synthetic audio ${index}`),
        // These are opaque Worker receipt hashes, not a Node recreation of Python JSON hashing.
        transcript_sha256: silent ? hash('[]') : hash(`opaque transcript receipt ${index}`),
        source_language: silent ? null : 'zh', language_probability: silent ? null : 0.92,
        segments: groups[index], ...(silent ? { no_speech_evidence: { method: 'faster-whisper-vad',
          audio_duration_ms: plan.analysis_range_ms.end_ms - plan.analysis_range_ms.start_ms,
          speech_duration_ms: 0 } } : {}) };
      return { ...structuredClone(plan), request_id: requestId, audio_sha256: raw.audio_sha256,
        workerEvidence: { requestId, audioSha256: raw.audio_sha256,
          transcriptSha256: raw.transcript_sha256, sourceLanguage: raw.source_language,
          languageProbability: raw.language_probability,
          segments: raw.segments.map(segment => ({ startMs: Math.round(segment.start * 1000),
            endMs: Math.round(segment.end * 1000), text: segment.text.trim(),
            speakerClusterId: segment.speaker_cluster_id })),
          ...(silent ? { noSpeechEvidence: structuredClone(raw.no_speech_evidence) } : {}),
          rawSourceEvidence: structuredClone(raw) } };
    }) };
  const evidence = { ...sourceAudio.aggregateSourceAudioWindows(input), task_id: 'local-v2-source-task',
    work_id: 1, tenant_id: 'tenant-1', user_id: 'user-1', source_asset_id: 1,
    source_video_sha256: hash('LOCAL SYNTHETIC SOURCE VIDEO'), created_at: now };
  return { input, evidence };
}

function validate(evidence) {
  assert.equal(typeof sourceAudio.validatePersistedSourceAudioV2, 'function',
    'persisted v2 must be verified by reconstructing its actual producer inputs');
  return sourceAudio.validatePersistedSourceAudioV2(evidence);
}

function visualFacts() {
  return { duration_ms: durationMs, story: ['她发现一封信。', '她保留完整线索。'],
    characters: [{ id: 'character-1', source_name: '林娜', relationship: '主人公' }],
    scenes: [{ id: 'scene-1', location: '客厅', time: '白天',
      source_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    props: [{ id: 'prop-1', name: '信封', evidence_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    shots: [0, 1500000].map((start, index) => ({ id: `shot-${index + 1}`, index: index + 1,
      start_ms: start, end_ms: index === 0 ? 1500000 : durationMs,
      composition: '信封特写', camera_movement: '固定', opening_state: '信封在桌上',
      continuous_action: '伸手取信', ending_state: '拿起信封',
      visible_character_ids: ['character-1'], text_regions: [], confidence: {} })),
    causal_chain: ['发现信封'], locked_facts: ['信封在桌上'], reversals: ['信里藏着秘密'], episode_hook: '信里写了什么？' };
}

function createHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-v2-review-'));
  const ownedRoot = fs.realpathSync.native(root);
  const storageRoot = path.join(root, 'storage');
  fs.mkdirSync(storageRoot, { mode: 0o700 });
  const db = new Database(':memory:', {
    nativeBinding: path.resolve(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  });
  t.after(() => {
    db.close();
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(root), ownedRoot);
    assert.equal(path.dirname(ownedRoot), fs.realpathSync.native(os.tmpdir()));
    assert.match(path.basename(ownedRoot), /^g2-v2-review-/);
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  });
  runMigrationsAndEnsure(db);
  creditLedger.ensureSchema(db);
  const sourceBytes = 'LOCAL SYNTHETIC SOURCE VIDEO';
  fs.writeFileSync(path.join(storageRoot, 'source.mp4'), sourceBytes);
  const sourceAsset = assetService.create(db, log, { name: 'local source', type: 'video',
    category: 'redraw_source', local_path: 'source.mp4',
    metadata: { tenant_id: 'tenant-1', user_id: 'user-1' } });
  db.prepare(`INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, 'tenant-1', 'user-1', 'v2 review fixture', 'draft', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, status, current_step, created_at, updated_at)
    VALUES (1, 1, 'tenant-1', 'user-1', 'v2 review fixture', ?, ?, ?, 'draft', 1, ?, ?)`)
    .run(sourceAsset.id, hash(sourceBytes), durationMs, now, now);
  const { evidence } = aggregateFixture(options);
  evidence.source_asset_id = sourceAsset.id;
  const evidencePath = path.join(storageRoot, 'audio-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const metadata = Object.fromEntries(['schema_version', 'tenant_id', 'user_id', 'work_id',
    'source_asset_id', 'source_video_sha256', 'audio_sha256', 'transcript_sha256']
    .map(key => [key, evidence[key]]));
  metadata.evidence_sha256 = hash(fs.readFileSync(evidencePath));
  const evidenceAsset = assetService.create(db, log, { name: 'local aggregate audio evidence', type: 'json',
    category: 'redraw_source_audio_evidence', local_path: 'audio-evidence.json', metadata,
    file_size: fs.statSync(evidencePath).size });
  const source = { asset_id: sourceAsset.id, sha256: hash(sourceBytes), duration_ms: durationMs,
    width: 1080, height: 1920, fps: 25, video_codec: 'h264', audio_codec: 'aac',
    audio_sample_rate_hz: 48000, audio_channels: 2 };
  const evidenceAssets = [{ id: 'visual-1', kind: 'visual', asset_id: 901, sha256: hash('local visual'),
    tool: 'synthetic-visual', tool_version: '1' }, { id: 'aggregate-audio-1', kind: 'audio_transcript',
    asset_id: evidenceAsset.id, sha256: metadata.evidence_sha256, tool: 'source-audio-evidence', tool_version: '1' }];
  const facts = visualFacts();
  const compatibleAudio = { schema_version: 'redraw-source-audio-evidence-v1',
    dialogue_mode: evidence.dialogue_mode, source_language: evidence.source_language,
    language_probability: evidence.language_probability,
    segments: evidence.segments.map(segment => ({ id: segment.id,
      start_ms: Math.round(segment.start_ms), end_ms: Math.round(segment.end_ms),
      source_text: segment.source_text, speaker_cluster_id: 'speaker-cluster-1' })) };
  // A valid v1 blueprint shell avoids making every rejection test depend on v2 Fusion already working.
  const blueprint = fusion.fuseEpisodeEvidence({ source, visualFacts: facts,
    audioEvidence: compatibleAudio, evidenceAssets });
  const originals = new Map(evidence.segments.map(segment => [segment.id, segment]));
  for (const shot of blueprint.shots) for (const turn of shot.dialogue) {
    const original = originals.get(turn.id);
    Object.assign(turn, { start_ms: Math.max(shot.start_ms, original.start_ms),
      end_ms: Math.min(shot.end_ms, original.end_ms), source_text: original.source_text.trim(),
      speaker_id: original.speaker_cluster_id });
  }
  delete blueprint.blueprint_hash;
  const h = { db, root, storageRoot, evidence, metadata, evidenceAsset, evidencePath, source, evidenceAssets,
    facts, blueprint, compatibleAudio, ctx: { db, storageRoot, tenantId: 'tenant-1', userId: 'user-1' },
    rewriteMetadata() {
      db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), evidenceAsset.id);
    },
    rewriteEvidence() {
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));
      metadata.evidence_sha256 = hash(fs.readFileSync(evidencePath));
      h.rewriteMetadata();
      db.prepare('UPDATE assets SET file_size = ? WHERE id = ?').run(fs.statSync(evidencePath).size, evidenceAsset.id);
      for (const item of [...evidenceAssets, ...blueprint.evidence_manifest.items]) {
        if (item.id === 'aggregate-audio-1') item.sha256 = metadata.evidence_sha256;
      }
    } };
  return h;
}

function audioContext(h, blueprint = h.blueprint) {
  assert.equal(typeof dialogueService.loadVerifiedBlueprintAudioContext, 'function',
    'v2 precision requires owner/source/file-verified server audio context');
  return dialogueService.loadVerifiedBlueprintAudioContext(h.ctx, { workId: 1, blueprint });
}

function fuse(h, context = audioContext(h)) {
  return fusion.fuseEpisodeEvidence({ source: h.source, visualFacts: h.facts,
    audioEvidence: { ...h.evidence, result_asset_id: h.evidenceAsset.id,
      evidence_sha256: h.metadata.evidence_sha256, evidence_ref: 'aggregate-audio-1' },
    evidenceAssets: h.evidenceAssets }, context);
}

function databaseSnapshot(h) {
  const tables = ['assets', 'redraw_works', 'redraw_episode_blueprints', 'redraw_versions', 'redraw_shots',
    'redraw_workflow_events', 'async_tasks', 'credit_accounts', 'tenant_credit_accounts',
    'usage_reservations', 'tenant_usage_reservations', 'credit_ledger', 'tenant_credit_ledger'];
  return Object.fromEntries(tables.map(table => [table, h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('persisted v2 revalidation preserves raw receipt JSON, fractional times and physical versus commit ownership', () => {
  const { evidence } = aggregateFixture();
  const before = JSON.stringify(evidence);
  assert.deepEqual(validate(evidence), evidence);
  assert.equal(JSON.stringify(evidence), before);
  const first = evidence.segments[0];
  assert.equal(first.start_ms, 1499.1254 * 1000);
  assert.equal(first.end_ms, 1502.1256 * 1000);
  assert.equal(first.source_text, fullText);
  assert.equal(first.commit_window_id, 'aw000002');
  assert.equal(first.source_bindings[0].window_id, 'aw000001');
  assert.deepEqual(first.source_bindings.map(binding => binding.role), ['selected_source', 'deduplicated_overlap']);
  assert.deepEqual(evidence.segments.map(segment => segment.speaker_cluster_id),
    ['aw000001-speaker-cluster-1', 'aw000002-speaker-cluster-1']);
});

const invalidV2Cases = [
  ['forged schema', evidence => { evidence.schema_version = 'redraw-source-audio-evidence-v3'; }],
  ['missing raw windows', evidence => { delete evidence.windows; }],
  ['extra raw receipt property', evidence => { evidence.windows[0].raw_source_evidence.claimed_verified = true; }],
  ['missing coverage', evidence => { delete evidence.coverage; }],
  ['forged full coverage', evidence => { evidence.coverage.full_coverage = false; }],
  ['altered committed range', evidence => { evidence.coverage.committed_ranges[1].start_ms += 1; }],
  ['unreviewed seam', evidence => { evidence.coverage.seam_checks[0].status = 'needs_review'; }],
  ['altered window range', evidence => { evidence.windows[1].analysis_range_ms.start_ms += 1; }],
  ['altered window status', evidence => { evidence.windows[0].worker_status = 'needs_review'; }],
  ['altered segment count', evidence => { evidence.windows[0].segment_count += 1; }],
  ['raw receipt hash mismatch', evidence => { evidence.windows[0].transcript_sha256 = hash('changed'); }],
  ['whole transcript hash mismatch', evidence => { evidence.transcript_sha256 = hash('changed'); }],
  ['changed raw seconds', evidence => { evidence.windows[0].raw_source_evidence.segments[0].start += 0.0001; }],
  ['selected binding drift', evidence => { evidence.segments[0].selected_source_binding_index = 1; }],
  ['forged binding role', evidence => { evidence.segments[0].source_bindings[0].role = 'deduplicated_overlap'; }],
  ['dropped deduplicated binding', evidence => { evidence.segments[0].source_bindings.pop(); }],
  ['forged request provenance', evidence => { evidence.segments[0].evidence_ref = 'invented#segment-0'; }],
  ['altered text', evidence => { evidence.segments[0].source_text = '裁剪原文'; }],
  ['altered aggregate range', evidence => { evidence.segments[0].end_ms -= 0.1; }],
  ['overlapping aggregate segments', evidence => { evidence.segments[1].start_ms = evidence.segments[0].start_ms; }],
  ['false cross-window speaker identity', evidence => { evidence.speaker_cluster_policy.cross_window_identity = 'confirmed'; }],
  ['unexpected success review flag', evidence => { evidence.status = 'needs_review'; }],
];
for (const [label, mutate] of invalidV2Cases) {
  test(`persisted v2 rejects ${label} without rewriting source receipts`, () => {
    const { evidence } = aggregateFixture(); mutate(evidence);
    const before = JSON.stringify(evidence);
    assert.throws(() => validate(evidence), { code: 'SOURCE_AUDIO_EVIDENCE_INVALID' });
    assert.equal(JSON.stringify(evidence), before);
  });
}

test('AnalysisWindow sends validated v2 original fractions, source text and namespaced IDs into the actual native prompt', () => {
  const { evidence } = aggregateFixture();
  const before = JSON.stringify(evidence);
  const windows = planAnalysisWindows({ duration_ms: durationMs, width: 1080, height: 1920 }, evidence, buildPrompt);
  assert.equal(windows.length, 75);
  assert.ok(windows.every(window => Number.isSafeInteger(window.start_ms) && Number.isSafeInteger(window.end_ms)));
  const summaries = windows.map(window => JSON.parse(window.prompt.split('BEGIN UNTRUSTED TRANSCRIPT DATA\n')[1]
    .split('\nEND UNTRUSTED TRANSCRIPT DATA')[0]));
  for (const original of evidence.segments) {
    const matching = summaries.flatMap(summary => summary.segments).filter(segment => segment.id === original.id);
    assert.ok(matching.length > 0);
    for (const segment of matching) {
      assert.equal(segment.start_ms, original.start_ms); assert.equal(segment.end_ms, original.end_ms);
      assert.equal(segment.source_text_preview, original.source_text);
      assert.equal(segment.speaker_cluster_id, original.speaker_cluster_id);
      assert.equal(segment.evidence_ref, original.evidence_ref);
    }
  }
  assert.equal(JSON.stringify(evidence), before);
});

test('AnalysisWindow rejects schema-only v2 claims and retains strict integer visual and v1 ASR times', () => {
  const { evidence } = aggregateFixture();
  const forged = { schema_version: V2, segments: evidence.segments };
  assert.throws(() => planAnalysisWindows({ duration_ms: durationMs }, forged, buildPrompt));
  assert.throws(() => planAnalysisWindows({ duration_ms: durationMs + 0.1 }, evidence, buildPrompt));
  assert.throws(() => planAnalysisWindows({ duration_ms: durationMs }, {
    schema_version: 'redraw-source-audio-evidence-v1', segments: [{ start_ms: 0.1, end_ms: 1.2 }],
  }, buildPrompt), { code: 'REDRAW_NATIVE_AUDIO_TIMING_INVALID' });
});

test('actual Fusion uses the aggregate manifest ref, stable IDs and full fractional source while preserving all raw provenance', t => {
  const h = createHarness(t);
  const before = fs.readFileSync(h.evidencePath, 'utf8');
  const context = audioContext(h);
  const blueprint = fuse(h, context);
  assert.deepEqual(fuse(h, context), blueprint);
  assert.equal(blueprint.schema_version, 'episode-blueprint-v1');
  assert.equal(blueprint.review.status, 'needs_review');
  const turns = blueprint.shots.flatMap(shot => shot.dialogue);
  assert.deepEqual(turns.map(turn => turn.id), h.evidence.segments.map(segment => segment.id));
  assert.deepEqual(turns.map(turn => turn.speaker_id), h.evidence.segments.map(segment => segment.speaker_cluster_id));
  assert.ok(turns.every(turn => turn.review_status === 'needs_review'));
  assert.ok(turns.every(turn => turn.evidence_refs.length === 1 && turn.evidence_refs[0] === 'aggregate-audio-1'));
  assert.equal(turns[0].start_ms, 1500000); assert.equal(turns[0].end_ms, h.evidence.segments[0].end_ms);
  assert.equal(turns[0].source_text, fullText.trim());
  assert.equal(turns[1].start_ms, h.evidence.segments[1].start_ms);
  for (const item of blueprint.evidence_manifest.items) {
    assert.deepEqual(Object.keys(item).sort(), ['asset_id', 'id', 'kind', 'sha256', 'tool', 'tool_version']);
  }
  assert.equal(fs.readFileSync(h.evidencePath, 'utf8'), before);
  assert.equal(JSON.stringify(h.evidence), before);
});

test('v1 Fusion and ordinary blueprint normalization reject fractional and namespaced speaker inputs', t => {
  const h = createHarness(t);
  for (const mutate of [audio => { audio.segments[0].start_ms += 0.1; },
    audio => { audio.segments[0].speaker_cluster_id = 'aw000001-speaker-cluster-1'; }]) {
    const audio = structuredClone(h.compatibleAudio); mutate(audio);
    assert.throws(() => fusion.fuseEpisodeEvidence({ source: h.source, visualFacts: h.facts,
      audioEvidence: audio, evidenceAssets: h.evidenceAssets }));
  }
  assert.throws(() => blueprintService.normalizeEpisodeBlueprint(h.blueprint));
  const integer = structuredClone(h.blueprint);
  for (const shot of integer.shots) for (const turn of shot.dialogue) {
    turn.start_ms = Math.round(turn.start_ms); turn.end_ms = Math.round(turn.end_ms);
  }
  assert.throws(() => blueprintService.normalizeEpisodeBlueprint(integer));
});

test('a serializable forged audio context cannot authorize v2 precision or bypass actual asset loading', t => {
  const h = createHarness(t);
  const forged = { 'aggregate-audio-1': { schemaVersion: V2, assetId: h.evidenceAsset.id,
    sha256: h.metadata.evidence_sha256, evidence: h.evidence } };
  assert.throws(() => blueprintService.normalizeEpisodeBlueprint(h.blueprint, forged));
  assert.throws(() => fusion.fuseEpisodeEvidence({ source: h.source, visualFacts: h.facts,
    audioEvidence: h.evidence, evidenceAssets: h.evidenceAssets, verifiedAudioContext: forged }));
  assert.throws(() => fuse(h, JSON.parse(JSON.stringify(forged))));
  fs.appendFileSync(h.evidencePath, ' ');
  const before = databaseSnapshot(h);
  assert.throws(() => workflow.createOrSaveDraft({ ...h.ctx, verifiedAudioContext: forged },
    { workId: 1, blueprint: h.blueprint, verifiedAudioContext: forged }));
  assert.deepEqual(databaseSnapshot(h), before);
});

test('actual Workflow creates, saves and re-reads v2 fractional dialogue after human speaker mapping', t => {
  const h = createHarness(t);
  const before = fs.readFileSync(h.evidencePath, 'utf8');
  const draft = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: fuse(h) });
  assert.equal(draft.status, 'draft'); assert.equal(draft.revision, 1);
  const mapped = structuredClone(draft.blueprint);
  for (const character of mapped.characters) character.review_status = 'approved';
  for (const shot of mapped.shots) for (const turn of shot.dialogue) {
    turn.speaker_kind = 'character'; turn.speaker_id = 'character-1'; turn.review_status = 'approved';
  }
  mapped.review.status = 'approved';
  assert.throws(() => workflow.saveDraft(h.ctx, { workId: 1, expectedUpdatedAt: draft.updated_at, blueprint: mapped }),
    { code: 'REDRAW_BLUEPRINT_INPUT_INVALID' });
  mapped.review.reviewer = 'local-synthetic-human-reviewer';
  const saved = workflow.saveDraft(h.ctx, { workId: 1, expectedUpdatedAt: draft.updated_at, blueprint: mapped });
  assert.equal(saved.id, draft.id); assert.equal(saved.status, 'draft');
  assert.notEqual(saved.blueprint_hash, draft.blueprint_hash);
  const reread = workflow.getCurrentBlueprint(h.ctx, { workId: 1 });
  assert.deepEqual(reread, saved);
  const resolved = dialogueService.resolveBlueprintDialogueSources(h.ctx, { workId: 1, blueprint: reread.blueprint });
  assert.equal(resolved.length, 2);
  for (const [index, item] of resolved.entries()) {
    const original = h.evidence.segments[index];
    assert.equal(item.status, 'resolved'); assert.equal(item.source_start_ms, original.start_ms);
    assert.equal(item.source_end_ms, original.end_ms); assert.equal(item.source_text, original.source_text.trim());
    assert.equal(item.evidence_ref, 'aggregate-audio-1'); assert.equal(item.evidence_sha256, h.metadata.evidence_sha256);
    assert.equal(item.audio_evidence_schema_version, V2);
  }
  assert.equal(resolved[0].projection_start_ms, 1500000); assert.equal(resolved[0].cross_shot, true);
  assert.equal(fs.readFileSync(h.evidencePath, 'utf8'), before);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM redraw_versions').get().n, 1);
});

test('v2 manual source corrections create, save and resolve fractional original anchors and explicit effective projections', t => {
  const h = createHarness(t);
  const before = fs.readFileSync(h.evidencePath, 'utf8');
  const original = h.evidence.segments[0];
  const turn = h.blueprint.shots.flatMap(shot => shot.dialogue).find(item => item.id === original.id);
  const correction = { evidence_ref: 'aggregate-audio-1', evidence_sha256: h.metadata.evidence_sha256,
    original_source_text: original.source_text.trim(), original_start_ms: original.start_ms,
    original_end_ms: original.end_ms, source_start_ms: original.start_ms + 0.125,
    source_end_ms: original.end_ms + 100.25 };
  Object.assign(turn, { source_text: '人工确认的完整一句。', start_ms: 1500000,
    end_ms: correction.source_end_ms, source_correction: correction });
  const draft = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: h.blueprint });
  const changed = structuredClone(draft.blueprint);
  const edited = changed.shots.flatMap(shot => shot.dialogue).find(item => item.id === original.id);
  edited.source_text = '再次人工确认的完整一句。';
  edited.source_correction.source_start_ms += 0.125;
  edited.source_correction.source_end_ms += 0.25;
  edited.end_ms = edited.source_correction.source_end_ms;
  const saved = workflow.saveDraft(h.ctx, { workId: 1, expectedUpdatedAt: draft.updated_at, blueprint: changed });
  const reread = workflow.getCurrentBlueprint(h.ctx, { workId: 1 });
  assert.deepEqual(reread, saved);
  const resolved = dialogueService.resolveBlueprintDialogueSources(h.ctx, { workId: 1, blueprint: reread.blueprint })[0];
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.reason, 'SOURCE_DIALOGUE_MANUAL_CORRECTION_RESOLVED');
  assert.equal(resolved.source_origin, 'manual_correction');
  assert.equal(resolved.original_source_text, original.source_text.trim());
  assert.equal(resolved.original_start_ms, original.start_ms); assert.equal(resolved.original_end_ms, original.end_ms);
  assert.equal(resolved.source_start_ms, edited.source_correction.source_start_ms);
  assert.equal(resolved.source_end_ms, edited.source_correction.source_end_ms);
  assert.equal(resolved.projection_start_ms, 1500000); assert.equal(resolved.projection_end_ms, edited.end_ms);
  assert.equal(resolved.source_text, edited.source_text); assert.equal(resolved.cross_shot, true);
  assert.equal(resolved.audio_evidence_schema_version, V2);
  assert.equal(fs.readFileSync(h.evidencePath, 'utf8'), before);
});

test('Workflow checks real owner and CAS before loading or normalizing v2 evidence', t => {
  const h = createHarness(t);
  assert.throws(() => workflow.createOrSaveDraft({ ...h.ctx, userId: 'foreign-user' },
    { workId: 1, blueprint: h.blueprint }), { code: 'REDRAW_BLUEPRINT_NOT_FOUND' });
  const draft = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: h.blueprint });
  const before = databaseSnapshot(h);
  fs.appendFileSync(h.evidencePath, ' ');
  assert.throws(() => workflow.saveDraft(h.ctx, { workId: 1, expectedUpdatedAt: 'stale', blueprint: h.blueprint }),
    { code: 'REDRAW_BLUEPRINT_CAS_CONFLICT' });
  assert.throws(() => workflow.saveDraft({ ...h.ctx, userId: 'foreign-user' },
    { workId: 1, expectedUpdatedAt: draft.updated_at, blueprint: h.blueprint }), { code: 'REDRAW_BLUEPRINT_NOT_FOUND' });
  assert.deepEqual(databaseSnapshot(h), before);
});

const assetFailureCases = [
  ['foreign evidence metadata owner', h => { h.metadata.user_id = 'other'; h.rewriteMetadata(); }],
  ['foreign evidence payload owner', h => { h.evidence.user_id = 'other'; h.rewriteEvidence(); }],
  ['wrong metadata source', h => { h.metadata.source_asset_id += 1; h.rewriteMetadata(); }],
  ['wrong payload source', h => { h.evidence.source_asset_id += 1; h.rewriteEvidence(); }],
  ['metadata schema mismatch', h => { h.metadata.schema_version = 'redraw-source-audio-evidence-v1'; h.rewriteMetadata(); }],
  ['payload schema downgrade', h => { h.evidence.schema_version = 'redraw-source-audio-evidence-v1'; h.rewriteEvidence(); }],
  ['metadata transcript mismatch', h => { h.metadata.transcript_sha256 = hash('other'); h.rewriteMetadata(); }],
  ['changed actual file SHA', h => { fs.appendFileSync(h.evidencePath, ' '); }],
  ['same-file-hash forged selected source', h => { h.evidence.segments[0].selected_source_binding_index = 1; h.rewriteEvidence(); }],
  ['same-file-hash forged coverage', h => { h.evidence.coverage.gap_ms = 1; h.rewriteEvidence(); }],
  ['same-file-hash forged raw receipt', h => { h.evidence.windows[0].raw_source_evidence.segments[0].text = 'forged'; h.rewriteEvidence(); }],
  ['same-file-hash forged transcript', h => {
    h.evidence.transcript_sha256 = hash('forged'); h.metadata.transcript_sha256 = h.evidence.transcript_sha256; h.rewriteEvidence();
  }],
];
for (const [label, mutate] of assetFailureCases) {
  test(`v2 ${label} cannot produce draft/version/settlement or resolve source text`, t => {
    const h = createHarness(t); mutate(h);
    const before = databaseSnapshot(h);
    if (label === 'metadata schema mismatch') {
      let context;
      try { context = audioContext(h); } catch { /* Rejecting the binding also grants no v2 permission. */ }
      assert.ok(!context || (context instanceof Map && !context.has('aggregate-audio-1')));
    } else assert.throws(() => audioContext(h));
    assert.throws(() => workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: h.blueprint }));
    const result = dialogueService.resolveBlueprintDialogueSources(h.ctx, { workId: 1, blueprint: h.blueprint });
    assert.equal(result.length, 2);
    assert.ok(result.every(item => item.status === 'unresolved' && !Object.hasOwn(item, 'source_text')));
    assert.deepEqual(databaseSnapshot(h), before);
  });
}

test('all silent v2 windows are valid review evidence without fabricating top-level VAD', t => {
  const h = createHarness(t, { silent: true });
  assert.deepEqual(validate(h.evidence), h.evidence);
  assert.equal(Object.hasOwn(h.evidence, 'no_speech_evidence'), false);
  const blueprint = fuse(h);
  const draft = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint });
  const corrected = structuredClone(draft.blueprint);
  corrected.shots[0].end_ms -= 1; corrected.shots[1].start_ms -= 1;
  const saved = workflow.saveDraft(h.ctx, { workId: 1, expectedUpdatedAt: draft.updated_at, blueprint: corrected });
  assert.ok(saved.blueprint.shots.every(shot => shot.manual_boundary && shot.dialogue.length === 0));
  assert.ok(h.evidence.windows.every(window => window.raw_source_evidence.no_speech_evidence.speech_duration_ms === 0));
  assert.equal(JSON.stringify(h.evidence), fs.readFileSync(h.evidencePath, 'utf8'));
});

for (const [label, mutate] of [
  ['missing window VAD', evidence => { delete evidence.windows[1].raw_source_evidence.no_speech_evidence; }],
  ['nonzero window speech', evidence => { evidence.windows[1].raw_source_evidence.no_speech_evidence.speech_duration_ms = 1; }],
  ['incomplete silent coverage', evidence => { evidence.coverage.committed_ranges.pop(); }],
  ['invented top-level VAD', evidence => { evidence.no_speech_evidence = evidence.windows[0].raw_source_evidence.no_speech_evidence; }],
]) {
  test(`silent v2 rejects ${label} rather than authorizing manual boundary review`, t => {
    const h = createHarness(t, { silent: true }); mutate(h.evidence); h.rewriteEvidence();
    const before = databaseSnapshot(h);
    assert.throws(() => validate(h.evidence), { code: 'SOURCE_AUDIO_EVIDENCE_INVALID' });
    assert.throws(() => workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: h.blueprint }));
    assert.deepEqual(databaseSnapshot(h), before);
  });
}

test('verified v2 locks only after approved human speaker mappings and an explicit reviewer', t => {
  const h = createHarness(t, { integer: true });
  const blueprint = h.blueprint;
  for (const character of blueprint.characters) character.review_status = 'approved';
  for (const shot of blueprint.shots) for (const turn of shot.dialogue) {
    turn.speaker_id = 'character-1'; turn.speaker_kind = 'character'; turn.review_status = 'approved';
  }
  blueprint.review.status = 'approved';
  assert.throws(() => workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint }),
    { code: 'REDRAW_BLUEPRINT_INPUT_INVALID' });
  blueprint.review.reviewer = 'local-synthetic-human-reviewer';
  const draft = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint });
  const locked = workflow.lockBlueprint(h.ctx, { workId: 1, expectedUpdatedAt: draft.updated_at,
    expectedBlueprintHash: draft.blueprint_hash });
  assert.equal(locked.status, 'locked');
  assert.ok(h.db.prepare('SELECT source_facts_json, facts_hash FROM redraw_versions').get().source_facts_json);
});

test('actual Orchestrator carries private storageRoot through real Fusion and Workflow with one reservation and one ASR invocation', async t => {
  const h = createHarness(t);
  // Synthetic in-memory eligibility is never evidence of a real provider/model being verified.
  h.db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, is_active, is_default, settings, created_at, updated_at)
    VALUES ('video_understanding', 'synthetic-local-double', 'TEST ONLY', 'GPT-5.5', 'GPT-5.5', 1, 1, ?, ?, ?)`)
    .run(JSON.stringify({ test_only: true, real_generation_verified: true, evidence: {
      provider_task_id: 'LOCAL-DOUBLE-ONLY', result_asset_id: 'LOCAL-DOUBLE-ONLY',
      result_asset_readable: true, completed_at: now } }), now, now);
  prices.set(h.db, 'GPT-5.5', 6);
  creditLedger.setTenantAccountBalance(h.db, 'tenant-1', 100);
  const before = fs.readFileSync(h.evidencePath, 'utf8');
  let audioCalls = 0, visualCalls = 0;
  const result = await redraw.startAnalysis(h.db, log, { workId: 1, tenantId: 'tenant-1', userId: 'user-1' }, {
    analysisContext: { storageRoot: h.storageRoot },
    sourceAudioEvidenceService: { async analyzeSourceAudio(ctx, input) {
      audioCalls += 1; assert.equal(ctx.storageRoot, h.storageRoot); assert.equal(input.sourceAssetId, h.source.asset_id);
      return { ...h.evidence, result_asset_id: h.evidenceAsset.id, evidence_sha256: h.metadata.evidence_sha256,
        evidence_asset: h.evidenceAssets[1] };
    } },
    nativeSourceAnalysisService: { async analyzeNativeSource(ctx, input, audio) {
      visualCalls += 1; assert.equal(ctx.storageRoot, h.storageRoot); assert.equal(input.workId, 1);
      assert.equal(audio.schema_version, V2);
      planAnalysisWindows(h.source, audio, buildPrompt);
      return { status: 'completed', provider_task_id: 'LOCAL-SYNTHETIC-VISUAL', source: h.source,
        facts: h.facts, evidence_asset: h.evidenceAssets[0], result_asset_id: 901 };
    } },
    evidenceFusionService: fusion,
  });
  assert.equal(result.status, 'completed'); assert.equal(result.review_status, 'needs_review');
  assert.equal(audioCalls, 1); assert.equal(visualCalls, 1);
  assert.deepEqual(result.billing, { charged: 6, held: 0, released: 0 });
  const draft = workflow.getCurrentBlueprint(h.ctx, { workId: 1 });
  assert.equal(draft.status, 'draft'); assert.equal(draft.blueprint_hash, result.blueprint_hash);
  const resolved = dialogueService.resolveBlueprintDialogueSources(h.ctx, { workId: 1, blueprint: draft.blueprint });
  assert.equal(resolved[0].status, 'resolved'); assert.equal(resolved[0].source_start_ms, h.evidence.segments[0].start_ms);
  assert.equal(resolved[0].source_text, fullText.trim());
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations').get().n, 1);
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'confirmed');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM redraw_versions').get().n, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM redraw_shots').get().n, 0);
  assert.deepEqual(h.db.prepare('SELECT source_facts_json, facts_hash, blueprint_hash FROM redraw_versions').get(),
    { source_facts_json: null, facts_hash: null, blueprint_hash: null });
  assert.equal(fs.readFileSync(h.evidencePath, 'utf8'), before);
});

function createApprovedIntegralDraft(h) {
  const blueprint = structuredClone(h.blueprint);
  for (const character of blueprint.characters) character.review_status = 'approved';
  for (const shot of blueprint.shots) for (const turn of shot.dialogue) {
    turn.speaker_id = 'character-1'; turn.speaker_kind = 'character'; turn.review_status = 'approved';
    assert.ok(Number.isSafeInteger(turn.start_ms) && Number.isSafeInteger(turn.end_ms));
  }
  blueprint.review = { status: 'approved', reviewer: 'local-synthetic-human-reviewer' };
  return workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint });
}

function registerAdditionalAudio(h, evidence, localPath) {
  assert.ok(['known-v1-evidence.json', 'new-v2-evidence.json'].includes(localPath));
  const bytes = JSON.stringify(evidence);
  fs.writeFileSync(path.join(h.storageRoot, localPath), bytes);
  const metadata = Object.fromEntries(['schema_version', 'tenant_id', 'user_id', 'work_id',
    'source_asset_id', 'source_video_sha256', 'audio_sha256', 'transcript_sha256']
    .map(key => [key, evidence[key]]));
  metadata.evidence_sha256 = hash(bytes);
  const asset = assetService.create(h.db, log, { name: 'additional synthetic audio evidence', type: 'json',
    category: 'redraw_source_audio_evidence', local_path: localPath, metadata, file_size: Buffer.byteLength(bytes) });
  return { asset, metadata };
}

const v2BindingEscapeCases = [
  ['kind-only downgrade to subtitle', (h, blueprint) => {
    blueprint.evidence_manifest.items.find(item => item.id === 'aggregate-audio-1').kind = 'subtitle';
  }],
  ['delete audio and relabel all dialogue references as visual subtitle', (h, blueprint) => {
    blueprint.evidence_manifest.items = blueprint.evidence_manifest.items.filter(item => item.id !== 'aggregate-audio-1');
    blueprint.evidence_manifest.items.find(item => item.id === 'visual-1').kind = 'subtitle';
    for (const shot of blueprint.shots) {
      shot.evidence_refs = [...new Set(shot.evidence_refs.map(ref => ref === 'aggregate-audio-1' ? 'visual-1' : ref))];
      for (const turn of shot.dialogue) turn.evidence_refs = ['visual-1'];
    }
  }],
  ['replace the bound aggregate ref with a known owned v1 asset', (h, blueprint) => {
    const evidence = { ...h.compatibleAudio, task_id: 'known-local-v1-task', work_id: 1,
      tenant_id: 'tenant-1', user_id: 'user-1', source_asset_id: h.source.asset_id,
      source_video_sha256: h.source.sha256, audio_sha256: hash('known local v1 audio'),
      transcript_sha256: hash('known local v1 transcript'), created_at: now };
    const known = registerAdditionalAudio(h, evidence, 'known-v1-evidence.json');
    const manifest = blueprint.evidence_manifest.items.find(item => item.id === 'aggregate-audio-1');
    manifest.asset_id = known.asset.id; manifest.sha256 = known.metadata.evidence_sha256;
  }],
  ['forge the source while retaining the bound v2 ref', (h, blueprint) => {
    blueprint.source.sha256 = hash('forged source');
  }],
];
for (const [label, mutate] of v2BindingEscapeCases) {
  test(`ordinary save cannot escape an existing approved integral v2 draft by ${label}`, t => {
    const h = createHarness(t, { integer: true });
    const draft = createApprovedIntegralDraft(h);
    const candidate = structuredClone(draft.blueprint); mutate(h, candidate);
    const before = databaseSnapshot(h);
    let stage = 'save';
    assert.throws(() => {
      const saved = workflow.saveDraft(h.ctx, { workId: 1, expectedUpdatedAt: draft.updated_at, blueprint: candidate });
      stage = 'lock';
      workflow.lockBlueprint(h.ctx, { workId: 1, expectedUpdatedAt: saved.updated_at,
        expectedBlueprintHash: saved.blueprint_hash });
    });
    assert.equal(stage, 'save', 'ordinary draft editing must reject removal of its verified v2 binding before writing');
    assert.deepEqual(databaseSnapshot(h), before, 'failed save/lock must not change work, draft, version, shots or settlement');
    assert.deepEqual(workflow.getCurrentBlueprint(h.ctx, { workId: 1 }), draft);
  });
}

test('a genuine internal new analysis can create a new v2 revision and actual evidence asset without editing current draft bindings', async t => {
  const h = createHarness(t, { integer: true });
  const originalDraft = createApprovedIntegralDraft(h);
  const originalBytes = fs.readFileSync(h.evidencePath, 'utf8');
  const nextEvidence = { ...structuredClone(h.evidence), task_id: 'new-local-v2-analysis-task' };
  const next = registerAdditionalAudio(h, nextEvidence, 'new-v2-evidence.json');
  const nextManifest = { ...h.evidenceAssets[1], asset_id: next.asset.id, sha256: next.metadata.evidence_sha256 };
  h.db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, is_active, is_default, settings, created_at, updated_at)
    VALUES ('video_understanding', 'synthetic-local-double', 'TEST ONLY', 'GPT-5.5', 'GPT-5.5', 1, 1, ?, ?, ?)`)
    .run(JSON.stringify({ test_only: true, real_generation_verified: true, evidence: {
      provider_task_id: 'LOCAL-DOUBLE-ONLY', result_asset_id: 'LOCAL-DOUBLE-ONLY',
      result_asset_readable: true, completed_at: now } }), now, now);
  prices.set(h.db, 'GPT-5.5', 6);
  creditLedger.setTenantAccountBalance(h.db, 'tenant-1', 100);
  let audioCalls = 0;
  const result = await redraw.startAnalysis(h.db, log, { workId: 1, tenantId: 'tenant-1', userId: 'user-1' }, {
    analysisContext: { storageRoot: h.storageRoot },
    sourceAudioEvidenceService: { async analyzeSourceAudio() {
      audioCalls += 1;
      return { ...nextEvidence, result_asset_id: next.asset.id, evidence_sha256: next.metadata.evidence_sha256,
        evidence_asset: nextManifest };
    } },
    nativeSourceAnalysisService: { async analyzeNativeSource() {
      return { status: 'completed', provider_task_id: 'LOCAL-SYNTHETIC-NEW-VISUAL', source: h.source,
        facts: h.facts, evidence_asset: h.evidenceAssets[0], result_asset_id: 901 };
    } },
    evidenceFusionService: fusion,
  });
  assert.equal(audioCalls, 1); assert.equal(result.status, 'completed'); assert.equal(result.blueprint_revision, 2);
  const current = workflow.getCurrentBlueprint(h.ctx, { workId: 1 });
  assert.equal(current.status, 'draft'); assert.equal(current.revision, 2);
  assert.equal(current.blueprint.evidence_manifest.items.find(item => item.id === 'aggregate-audio-1').asset_id, next.asset.id);
  const oldRow = h.db.prepare('SELECT blueprint_json, blueprint_hash, status FROM redraw_episode_blueprints WHERE id = ?')
    .get(originalDraft.id);
  assert.deepEqual(JSON.parse(oldRow.blueprint_json), originalDraft.blueprint);
  assert.equal(oldRow.blueprint_hash, originalDraft.blueprint_hash); assert.equal(oldRow.status, 'draft');
  assert.ok(dialogueService.resolveBlueprintDialogueSources(h.ctx, { workId: 1, blueprint: current.blueprint })
    .every(item => item.status === 'resolved' && item.evidence_sha256 === next.metadata.evidence_sha256));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM redraw_versions').get().n, 2);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM redraw_shots').get().n, 0);
  assert.ok(h.db.prepare('SELECT source_facts_json, facts_hash, blueprint_hash FROM redraw_versions').all()
    .every(version => version.source_facts_json === null && version.facts_hash === null && version.blueprint_hash === null));
  assert.equal(fs.readFileSync(h.evidencePath, 'utf8'), originalBytes);
});

test('multiple real v2 source corrections resolve using one verified context construction per shared evidence ref', t => {
  const h = createHarness(t);
  const blueprint = structuredClone(h.blueprint);
  for (const shot of blueprint.shots) for (const turn of shot.dialogue) {
    const original = h.evidence.segments.find(segment => segment.id === turn.id);
    const correction = { evidence_ref: 'aggregate-audio-1', evidence_sha256: h.metadata.evidence_sha256,
      original_source_text: original.source_text.trim(), original_start_ms: original.start_ms,
      original_end_ms: original.end_ms, source_start_ms: original.start_ms + 0.125,
      source_end_ms: original.end_ms + 0.25 };
    Object.assign(turn, { source_text: `人工确认-${turn.id}`, source_correction: correction,
      start_ms: Math.max(shot.start_ms, correction.source_start_ms),
      end_ms: Math.min(shot.end_ms, correction.source_end_ms) });
  }
  const before = databaseSnapshot(h);
  const fileBefore = fs.readFileSync(h.evidencePath, 'utf8');
  const factory = sourceAudio.createVerifiedSourceAudioContext;
  const modulePath = require.resolve('../src/services/redrawSourceDialogueService');
  const cached = require.cache[modulePath];
  let constructions = 0;
  try {
    sourceAudio.createVerifiedSourceAudioContext = (...args) => {
      constructions += 1;
      return Reflect.apply(factory, sourceAudio, args);
    };
    delete require.cache[modulePath];
    const realResolver = require('../src/services/redrawSourceDialogueService');
    const resolved = realResolver.resolveBlueprintDialogueSources(h.ctx, { workId: 1, blueprint });
    assert.equal(resolved.length, 2);
    for (const [index, item] of resolved.entries()) {
      const original = h.evidence.segments[index];
      assert.equal(item.status, 'resolved'); assert.equal(item.reason, 'SOURCE_DIALOGUE_MANUAL_CORRECTION_RESOLVED');
      assert.equal(item.original_start_ms, original.start_ms); assert.equal(item.original_end_ms, original.end_ms);
      assert.equal(item.source_start_ms, original.start_ms + 0.125); assert.equal(item.source_end_ms, original.end_ms + 0.25);
      assert.equal(item.source_text, `人工确认-${original.id}`);
      assert.equal(item.evidence_ref, 'aggregate-audio-1'); assert.equal(item.evidence_sha256, h.metadata.evidence_sha256);
      assert.equal(item.audio_evidence_schema_version, V2);
    }
    assert.equal(constructions, 1, 'shared evidence must not clone, aggregate and hash the entire track once per corrected turn');
  } finally {
    sourceAudio.createVerifiedSourceAudioContext = factory;
    if (cached) require.cache[modulePath] = cached;
    else delete require.cache[modulePath];
  }
  assert.equal(sourceAudio.createVerifiedSourceAudioContext, factory);
  assert.equal(require.cache[modulePath], cached);
  assert.deepEqual(databaseSnapshot(h), before);
  assert.equal(fs.readFileSync(h.evidencePath, 'utf8'), fileBefore);
});

test('real blueprint lock route materializes approved verified v2 Facts', t => {
  const h = createHarness(t, { integer: true });
  const draft = createApprovedIntegralDraft(h);
  const redrawRoutes = require('../src/routes/redraw');
  const handlers = redrawRoutes(h.db, log, { cfg: { storage: { local_path: h.storageRoot } },
    referenceArtifactTempRoot: path.join(h.root, 'reference-imports') });
  const result = { statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  handlers.lockBlueprint({ params: { id: '1' }, tenant: { id: 'tenant-1' }, user: { id: 'user-1' },
    body: { expected_updated_at: draft.updated_at, expected_blueprint_hash: draft.blueprint_hash } }, result);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.data.status, 'locked');
  assert.doesNotMatch(JSON.stringify(result.body), /INTERNAL_ERROR|g2-v2-review-|local_path|audio-evidence\.json|[A-Za-z]:[\\/]/);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM redraw_shots').get().n, 2);
  const version = h.db.prepare('SELECT source_facts_json, facts_hash, blueprint_hash FROM redraw_versions').get();
  assert.ok(version.source_facts_json);
  assert.match(version.facts_hash, /^[a-f0-9]{64}$/);
  assert.equal(version.blueprint_hash, draft.blueprint_hash);
});

test('fully approved v2 dialogue locks into Facts without losing fractional source timing', t => {
  const h = createHarness(t);
  const blueprint = structuredClone(h.blueprint);
  for (const character of blueprint.characters) character.review_status = 'approved';
  for (const shot of blueprint.shots) for (const turn of shot.dialogue) {
    turn.speaker_id = 'character-1';
    turn.speaker_kind = 'character';
    turn.review_status = 'approved';
  }
  blueprint.review = { status: 'approved', reviewer: 'local-synthetic-human-reviewer' };
  const draft = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint });
  const locked = workflow.lockBlueprint(h.ctx, { workId: 1, expectedUpdatedAt: draft.updated_at,
    expectedBlueprintHash: draft.blueprint_hash });
  assert.equal(locked.status, 'locked');
  const version = h.db.prepare('SELECT * FROM redraw_versions WHERE work_id = 1').get();
  const facts = JSON.parse(version.source_facts_json);
  assert.equal(facts.facts_hash, version.facts_hash);
  assert.equal(facts.shots[1].dialogue[0].start_ms, 1500000);
  assert.equal(facts.shots[1].dialogue[0].end_ms, h.evidence.segments[0].end_ms);
  const rows = h.db.prepare('SELECT start_ms, end_ms, source_dialogue_json FROM redraw_shots ORDER BY shot_index').all();
  assert.equal(JSON.parse(rows[1].source_dialogue_json)[0].end_ms, h.evidence.segments[0].end_ms);
});
