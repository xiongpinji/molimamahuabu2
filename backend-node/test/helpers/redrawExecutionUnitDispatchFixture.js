'use strict';

// Synthetic review/evidence only; real isolated SQLite, media, pack, claim and binding.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fixture, hash } = require('./redrawUnitReferenceFixture');
const { fixture: derivationFixture } = require('./redrawUnitReferenceDerivationFixture');
const { episodeLocalizationHash } = require('../../src/services/localizationService');
const { inspectUnitReferenceMaterials } = require('../../src/services/redrawUnitReferenceService');
const { inspectPreparedUnitReferenceMaterials,
  prepareUnitReferenceMaterials } = require('../../src/services/redrawUnitReferenceDerivationService');
const { compileUnitProductionPack } = require('../../src/services/redrawUnitProductionPackService');
const { createProviderAssetHandler } = require('../../src/routes/redrawProviderAssets');
const { getFfmpegPath, getFfprobePath } = require('../../src/utils/ffmpegPath');
const { canonicalModel } = require('../../src/services/modelPriceService');
const ledger = require('../../src/services/creditLedgerService');
const runs = require('../../src/services/redrawExecutionRunService');
const runMedia = promisify(execFile);
const NOW = '2026-09-07T00:00:00.000Z';
const SECRET = 'synthetic-dispatch-provider-signing-secret-only';
const BASE_URL = 'https://assets.dispatch.synthetic.invalid';
const KEY = 'synthetic-dispatch-video-key';
const parameters = { resolution: '480p', aspect_ratio: '16:9' };
const log = { info() {}, warn() {}, error() {} };
const targets = ['Maya, bring the blue folder. Do not leave anything behind.',
  'Ethan, I have the folder. We can leave together now.'];
const attemptRow = h => h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(h.attemptId);
const runRow = h => h.db.prepare('SELECT * FROM redraw_execution_runs WHERE id=?').get(h.run.id);

async function addDialogueEvidence(h, raw, assemblyCase = false) {
  h.ctx.env = {}; h.ctx.log = log;
  const segments = assemblyCase ? [
    { id: 'assembly-dialogue-cross-max', start_ms: 8000, end_ms: 11000,
      source_text: '源对白跨越默认切点，不应外发。', speaker_cluster_id: 'speaker-cluster-1' },
  ] : [
    { id: 'dispatch-turn-a', start_ms: 0, end_ms: 2200, source_text: '源对白甲，不应外发。', speaker_cluster_id: 'speaker-cluster-1' },
    { id: 'dispatch-turn-b', start_ms: 2500, end_ms: 4700, source_text: '源对白乙，不应外发。', speaker_cluster_id: 'speaker-cluster-2' },
  ];
  const audioPath = path.join(h.root, 'dispatch-source-audio.wav');
  await runMedia(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', path.join(h.root, 'source/source.mp4'),
    '-vn', '-c:a', 'pcm_s16le', audioPath], { windowsHide: true, timeout: 120000 });
  const evidence = { schema_version: 'redraw-source-audio-evidence-v1', task_id: 'synthetic-dispatch-source-evidence',
    tenant_id: h.ctx.tenantId, user_id: h.ctx.userId, work_id: 1, source_asset_id: 101,
    source_video_sha256: h.sourceFingerprint, audio_sha256: hash(fs.readFileSync(audioPath)),
    transcript_sha256: hash(JSON.stringify(segments)), source_language: 'zh', language_probability: 0.99,
    dialogue_mode: 'spoken', created_at: NOW, segments };
  const bytes = Buffer.from(JSON.stringify(evidence));
  fs.writeFileSync(path.join(h.root, 'dispatch-source-evidence.json'), bytes, { flag: 'wx' });
  const metadata = { ...evidence, evidence_sha256: hash(bytes) }; delete metadata.segments;
  h.db.prepare(`INSERT INTO assets (id,type,category,local_path,metadata)
    VALUES (503,'json','redraw_source_audio_evidence','dispatch-source-evidence.json',?)`).run(JSON.stringify(metadata));
  raw.evidence_manifest.items.push({ id: 'dispatch-source-audio', kind: 'audio_transcript', asset_id: 503,
    sha256: hash(bytes), tool: 'synthetic-fixture-not-asr', tool_version: '1' });
  const targetShot = raw.shots[assemblyCase ? 1 : 0];
  targetShot.dialogue = segments.map((segment, index) => ({ id: segment.id, start_ms: segment.start_ms,
    end_ms: segment.end_ms, source_text: segment.source_text, speaker_id: `character-00${index + 1}`,
    speaker_kind: 'character', off_screen: assemblyCase, source_language: 'zh', emotion: 'calm',
    evidence_refs: ['dispatch-source-audio'], confidence: 0.99, review_status: 'approved' }));
  targetShot.audio_contract.dialogue_mode = 'spoken';
}

function configureBeforeReview(h, audioMode = 'native', dialogueTargets = targets) {
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_plan_reviews').get().n, 0);
  h.localization.dialogue_map.forEach((dialogue, index) => { dialogue.target_text = dialogueTargets[index]; });
  h.localization.localization_hash = episodeLocalizationHash(h.localization);
  h.db.prepare('UPDATE redraw_versions SET localization_hash=?,localization_review_json=? WHERE id=?')
    .run(h.localization.localization_hash, JSON.stringify(h.localization), h.versionId);
  const row = h.db.prepare('SELECT * FROM ai_service_configs WHERE id=41').get();
  const settings = JSON.parse(row.settings);
  if (audioMode === 'native') settings.redraw_locale_capabilities.push({ locale: 'en', language: 'en', market: '', target_locale: null,
    status: 'verified', evidence: { native_dialogue_audio: {
      contract: 'redraw-native-dialogue-audio-v1', config_id: 41, config_updated_at: row.updated_at,
      provider: row.provider, protocol: row.api_protocol, model: row.default_model,
      provider_task_id: 'synthetic-native-capability', terminal_status: 'completed',
      artifact_id: 101, artifact_sha256: h.sourceFingerprint,
      media: { video_stream: true, audio_stream: true },
      locale_verification: { language: 'en', language_verified: true, locale_verified: false },
      human_review: { status: 'passed', speaker_order: 'passed', lip_sync: 'passed', extra_dialogue: 'passed' },
    } } });
  h.db.prepare('UPDATE ai_service_configs SET settings=?,api_key=?,base_url=? WHERE id=41')
    .run(JSON.stringify(settings), KEY, 'https://video.dispatch.synthetic.invalid');
  if (audioMode === 'replace') {
    const tts = { config_id: 42, config_updated_at: NOW, provider: 'minimax', model: 'synthetic-tts',
      task_id: 'synthetic-audio-evidence', terminal_status: 'completed', artifact_id: 101 };
    h.db.prepare(`INSERT INTO ai_service_configs (id, service_type, provider, name, model, default_model,
      is_active, verification_status, settings, api_key, base_url, created_at, updated_at)
      VALUES (42, 'tts', 'minimax', 'synthetic-local-only', ?, 'synthetic-tts', 1, 'verified', ?, ?, ?, ?, ?)`)
      .run(JSON.stringify(['synthetic-tts']), JSON.stringify({ redraw_locale_capabilities: [
        { locale: 'en-US', market: 'US', status: 'verified', evidence: { tts } },
      ] }), 'synthetic-assembly-tts-key', 'https://tts.synthetic.invalid', NOW, NOW);
  }
}

async function setup(t, mode = 'paid', sequential = false, stage = 'bound', { createActor, assemblyCase = false,
  audioMode = 'native', dialogueTargets = targets, assemblyParentRanges, assemblyDurations } = {}) {
  assert.ok(['queued', 'idle', 'unbound', 'bound'].includes(stage));
  assert.ok(['native', 'replace', 'not_required'].includes(audioMode));
  assert.ok(assemblyCase || audioMode === 'native');
  const beforeReview = sequential && !assemblyCase ? h => {
      configureBeforeReview(h, audioMode, dialogueTargets);
      const row = h.db.prepare('SELECT default_model,verified_capabilities FROM ai_service_configs WHERE id=41').get();
      const capabilities = JSON.parse(row.verified_capabilities);
      capabilities[row.default_model].maxVideoReferences = 1;
      h.db.prepare('UPDATE ai_service_configs SET verified_capabilities=? WHERE id=41').run(JSON.stringify(capabilities));
    } : h => configureBeforeReview(h, audioMode, dialogueTargets);
  const h = assemblyCase
    ? await derivationFixture(t, { createActor, parentRanges: assemblyParentRanges || [[0, 5000], [5000, 12000]],
      durations: assemblyDurations || [5, 10],
      beforeBlueprint: (h, raw) => audioMode === 'not_required' ? undefined : addDialogueEvidence(h, raw, true), beforeReview })
    : await fixture(t, { createActor, ...(sequential ? { secondMotion: true, durations: [5, 7] } : {}),
      beforeBlueprint: (h, raw) => addDialogueEvidence(h, raw), beforeReview });
  assert.equal(path.basename(h.root).startsWith('redraw-reference-bundle-fixture-'), true);
  h.ctx.env = {}; h.ctx.log = log;
  h.ctx.providerAssets = { storageRoot: h.root, storageBaseUrl: BASE_URL, signingSecret: SECRET, nowMs: Date.parse(NOW) };
  h.pack = compileUnitProductionPack({ owner: { tenantId: h.ctx.tenantId, userId: h.ctx.userId,
    workId: 1, versionId: h.versionId }, expected: h.expected(0), queueState: h.queueState,
  blueprint: h.blueprint, localization: h.localization });
  assert.equal(h.pack.dialogues.length, assemblyCase ? 0 : 2);
  assert.deepEqual(h.pack.dialogues.map(value => value.target_text), assemblyCase ? [] : dialogueTargets);
  assert.equal(h.queueState.saved_review.plan.capability.audio_mode, audioMode);
  assert.equal(h.queueState.saved_review.plan.capability.audio_verification.locale_verified, audioMode === 'replace');
  h.materials = await inspectUnitReferenceMaterials(h.ctx, h.expected(0));
  h.prepared = await inspectPreparedUnitReferenceMaterials(h.ctx, h.expected(0));
  if (assemblyCase && h.prepared.status === 'needs_preparation') {
    await prepareUnitReferenceMaterials(h.ctx, { ...h.expected(0), expected_materials_hash: h.prepared.materials_hash });
    h.prepared = await inspectPreparedUnitReferenceMaterials(h.ctx, h.expected(0));
  }
  assert.equal(h.prepared.status, 'prepared');
  assert.deepEqual(h.prepared.prepared_materials.references.map(value => value.kind).sort(),
    assemblyCase ? ['video', 'video'] : ['image', 'image', 'video']);
  h.model = canonicalModel(h.queueState.saved_review.plan.capability.model);
  h.db.prepare(`INSERT INTO model_credit_prices(model,display_name,category,credits,pricing_mode,status,billing_unit,updated_at)
    VALUES (?,'synthetic dispatch','video',?,?,'enabled','second',?)
    ON CONFLICT(model) DO UPDATE SET category='video',credits=excluded.credits,pricing_mode=excluded.pricing_mode,status='enabled',billing_unit='second'`)
    .run(h.model, mode === 'free' ? 0 : 3, mode, NOW);
  h.db.prepare('DELETE FROM model_resolution_prices WHERE model=?').run(h.model);
  ledger.setTenantAccountBalance(h.db, h.ctx.tenantId, 100);
  if (stage === 'queued') return h;
  h.run = runs.createExecutionRun(h.ctx, h.versionId,
    { expected_plan_hash: h.expected(0).plan_hash, expected_queue_id: h.expected(0).queue_id });
  if (stage === 'idle') return h;
  const ready = await runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id, { output_parameters: parameters });
  assert.equal(ready.status, 'ready');
  const claim = await runs.claimNextUnit(h.ctx, h.versionId, h.run.id, { expected_revision: ready.revision,
    expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash, output_parameters: parameters });
  h.attemptId = claim.attempt_id;
  h.bindInput = { attempt_id: h.attemptId, expected_revision: runRow(h).revision,
    expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash };
  if (stage === 'unbound') return h;
  h.binding = await runs.bindClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, h.bindInput);
  h.input = { ...h.bindInput, expected_revision: runRow(h).revision };
  h.taskMetadata = h.db.prepare('SELECT metadata FROM async_tasks WHERE id=?').get(h.binding.task_id).metadata;
  return h;
}

async function readPublished(h, rawUrl) {
  const url = new URL(rawUrl); let status = 200, headers = {}, bytes, sentPath, failure;
  const handler = createProviderAssetHandler({ cfg: {}, ...h.ctx.providerAssets });
  await handler({ originalUrl: `${url.pathname}${url.search}`, params: { filename: path.basename(url.pathname) },
    headers: { host: url.host }, socket: { encrypted: true, remoteAddress: '192.0.2.2' } }, {
    set(value) { headers = { ...headers, ...value }; return this; },
    status(value) { status = value; return this; },
    json(value) { failure = value; return this; },
    sendFile(file) { sentPath = file; bytes = fs.readFileSync(file); return this; },
    send(value) { bytes = Buffer.from(value); return this; },
    end(value) { if (value) bytes = Buffer.from(value); return this; },
  });
  return { status, headers, bytes, sentPath, failure };
}

function dispatch(h, fetchImpl, input = h.input, ctx = h.ctx) {
  assert.equal(typeof runs.dispatchClaimedExecutionUnitTask, 'function', 'real bound-unit dispatch entry must exist');
  return runs.dispatchClaimedExecutionUnitTask(ctx, h.versionId, h.run.id, input, { fetchImpl });
}

async function makeCandidateMedia(h, variant = 'valid', profile = {}) {
  assert.ok(['valid', 'silent', 'short', 'webm', 'alternate-codecs', 'wrong-sar', 'rotated', 'valid-sar'].includes(variant));
  assert.ok(profile && typeof profile === 'object' && !Array.isArray(profile));
  assert.ok(profile.color === undefined || ['red', 'blue'].includes(profile.color));
  assert.ok(profile.frequency === undefined || [440, 880].includes(profile.frequency));
  assert.ok(profile.antiPhaseStereo === undefined || profile.antiPhaseStereo === true);
  assert.ok(profile.audioDelayMs === undefined || profile.audioDelayMs === 500);
  assert.ok(profile.commonStartMs === undefined || profile.commonStartMs === 1000);
  const file = path.join(h.root, `synthetic-result-${variant}.${variant === 'webm' ? 'webm' : 'mp4'}`);
  const encodedFile = variant === 'rotated' ? path.join(h.root, 'synthetic-result-before-rotation.mp4') : file;
  const videoSource = profile.color ? `color=c=${profile.color}:size=854x480:rate=24` : 'testsrc2=size=854x480:rate=24';
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', videoSource];
  if (variant !== 'silent') {
    if (profile.audioDelayMs) args.push('-itsoffset', String(profile.audioDelayMs / 1000));
    args.push('-f', 'lavfi', '-i', profile.antiPhaseStereo
      ? `aevalsrc=sin(2*PI*${profile.frequency || 880}*t)|-sin(2*PI*${profile.frequency || 880}*t):s=48000:c=stereo`
      : `sine=frequency=${profile.frequency || 880}:sample_rate=48000`);
  }
  args.push('-t', String(variant === 'short' ? 1 : h.pack.timeline.generated_duration_ms / 1000 + (variant === 'alternate-codecs' ? 0.2 : 0)),
    '-c:v', variant === 'webm' ? 'libvpx' : variant === 'alternate-codecs' ? 'mpeg4' : 'libx264');
  if (!['webm', 'alternate-codecs'].includes(variant)) args.push('-preset', 'ultrafast');
  if (variant !== 'webm') args.push('-movflags', '+faststart');
  if (variant === 'wrong-sar') args.push('-vf', 'setsar=2');
  if (variant === 'valid-sar') args.push('-vf', 'setsar=1280/1281:max=2000');
  args.push('-pix_fmt', 'yuv420p');
  if (variant === 'silent') args.push('-an'); else args.push('-c:a', variant === 'webm' ? 'libopus' : variant === 'alternate-codecs' ? 'libmp3lame' : 'aac');
  if (profile.commonStartMs) args.push('-output_ts_offset', String(profile.commonStartMs / 1000));
  args.push(encodedFile);
  await runMedia(getFfmpegPath(), args, { windowsHide: true, timeout: 120000 });
  if (profile.audioDelayMs) {
    const { stdout } = await runMedia(getFfprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', file],
      { windowsHide: true, timeout: 120000 });
    const streams = JSON.parse(stdout).streams;
    const video = streams.find(stream => stream.codec_type === 'video');
    const audio = streams.find(stream => stream.codec_type === 'audio');
    assert.ok(Math.abs(Number(video.start_time) - (profile.commonStartMs || 0) / 1000) < 0.001);
    assert.ok(Math.abs(Number(audio.start_time) - Number(video.start_time) - 0.5) < 0.03,
      'the real MP4 audio must begin 0.5s after video, allowing AAC encoder priming');
    assert.ok(Math.abs(Number(video.duration) * 1000 - h.pack.timeline.generated_duration_ms) < 100);
  }
  if (variant === 'rotated') await runMedia(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-display_rotation:v:0', '90', '-i', encodedFile,
    '-c', 'copy', file], { windowsHide: true, timeout: 120000 });
  if (['wrong-sar', 'rotated', 'valid-sar'].includes(variant)) {
    const { stdout } = await runMedia(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { windowsHide: true, timeout: 120000 });
    const actual = JSON.parse(stdout), video = actual.streams.find(value => value.codec_type === 'video');
    assert.equal(video.width, 854); assert.equal(video.height, 480);
    assert.ok(actual.streams.some(value => value.codec_type === 'audio'));
    assert.ok(Math.abs(Number(actual.format.duration) * 1000 - h.pack.timeline.generated_duration_ms) < 100);
    if (variant === 'wrong-sar') {
      assert.equal(video.sample_aspect_ratio, '2:1');
      assert.equal(video.display_aspect_ratio, '427:120');
    } else if (variant === 'valid-sar') {
      assert.equal(video.sample_aspect_ratio, '1280:1281');
      assert.equal(video.display_aspect_ratio, '16:9');
    } else assert.equal(Math.abs(Number(video.side_data_list?.find(value => value.side_data_type === 'Display Matrix')?.rotation)), 90,
      'the real MP4 must carry display rotation, not merely a filename or synthetic probe');
  }
  return fs.readFileSync(file);
}

module.exports = { setup, dispatch, readPublished, attemptRow, runRow, hash, makeCandidateMedia, KEY, SECRET, BASE_URL, NOW };
