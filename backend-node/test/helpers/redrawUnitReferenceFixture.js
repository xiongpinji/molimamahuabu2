'use strict';

// Synthetic approved metadata, real local FFmpeg/Sharp bytes; no provider or human acceptance evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createFixture, probeVideo } = require('../../scripts/run-redraw-reference-bundle-local-case');
const { getFfmpegPath } = require('../../src/utils/ffmpegPath');
const { normalizeEpisodeBlueprint } = require('../../src/services/redrawEpisodeBlueprintService');
const { episodeLocalizationHash } = require('../../src/services/localizationService');
const { previewVersionExecutionPlan } = require('../../src/services/redrawExecutionPlanPreviewService');
const { saveExecutionPlanReview } = require('../../src/services/redrawExecutionPlanReviewService');
const { prepareExecutionQueue, getExecutionQueue } = require('../../src/services/redrawExecutionQueueService');
const { bindReadyMotionReference } = require('../../src/services/redrawReferenceArtifactImportService');
const run = promisify(execFile);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = '2026-09-07T00:00:00.000Z';
const cleanResults = [
  { kind: 'person_clean', key: 'face-001', status: 'completed', redraw_asset_id: 206 },
  { kind: 'person_clean', key: 'face-002', status: 'completed', redraw_asset_id: 207 },
  { kind: 'text_clean', key: 'text-001', status: 'completed', redraw_asset_id: 203 },
  { kind: 'text_clean', key: 'text-002', status: 'completed', redraw_asset_id: 204 },
];

function blueprintFor(h, crossParent) {
  const evidence = ['visual'];
  const spoken = crossParent ? [{ id: 'dialogue-cross-parent', speaker_id: 'character-002',
    speaker_kind: 'character', off_screen: true, start_ms: 5000, end_ms: 7000,
    source_text: '等我回来。', source_language: 'zh', emotion: 'calm', evidence_refs: ['audio-source'],
    confidence: 0.99, review_status: 'approved' }] : [];
  return {
    schema_version: 'episode-blueprint-v1',
    source: { asset_id: 101, sha256: h.sourceFingerprint, duration_ms: 12000,
      width: 864, height: 496, fps: 25, video_codec: 'h264', audio_codec: 'aac',
      audio_sample_rate_hz: 48000, audio_channels: 1 },
    evidence_manifest: { items: [{ id: 'visual', kind: 'visual', asset_id: 401,
      sha256: hash(fs.readFileSync(path.join(h.root, 'coverage/version-1/frames/frame-0.png'))),
      tool: 'synthetic-fixture', tool_version: '1' }] },
    story: { summary: 'Two synthetic parent shots.', beats: ['First shot', 'Second shot'], evidence_refs: evidence, confidence: 0.99 },
    characters: ['001', '002'].map(id => ({ id: `character-${id}`, source_name: `Character ${id}`,
      display_name: `Character ${id}`, relationship: 'witness', relationships: [], face_track_ids: [`face-${id}`],
      evidence_refs: evidence, confidence: 0.99, review_status: 'approved' })),
    scenes: [{ id: 'scene-1', location: 'room', time: 'day', source_ranges: [{ start_ms: 0, end_ms: 12000 }],
      evidence_refs: evidence, confidence: 0.99 }],
    props: [{ id: 'prop-1', name: 'fixture card', evidence_ranges: [{ start_ms: 0, end_ms: 12000 }],
      evidence_refs: evidence, confidence: 0.99 }],
    shots: [[0, 5000], [5000, 12000]].map(([start, end], index) => ({
      id: `shot-${index + 1}`, index: index + 1, start_ms: start, end_ms: end,
      composition: 'Synthetic geometry', camera_movement: 'static', opening_state: 'start',
      continuous_action: 'hold', ending_state: 'end',
      visible_character_ids: index === 0 ? ['character-001', 'character-002'] : [],
      dialogue: index === 1 ? spoken : [], text_regions: [],
      audio_contract: { dialogue_mode: index === 1 && spoken.length ? 'spoken' : 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.99, speaker_mapping: 0.99, text_regions: 0.99, shot_boundary: 0.99 },
      evidence_refs: evidence,
    })),
    causal_chain: [{ id: 'causal-1', cause: 'first shot', effect: 'second shot', evidence_refs: evidence, confidence: 0.99 }],
    locked_facts: [{ id: 'fact-1', text: 'two shots', evidence_refs: evidence, confidence: 0.99 }],
    reversals: [{ id: 'reversal-1', text: 'second shot', evidence_refs: evidence, confidence: 0.99 }],
    episode_hook: { text: 'End of fixture', evidence_refs: evidence, confidence: 0.99 },
    review: { status: 'locked', reviewer: h.owner.userId },
  };
}

async function registerEvidence(h, blueprint, crossParent) {
  const audioPath = path.join(h.root, 'source-audio.wav');
  await run(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', path.join(h.root, 'source/source.mp4'),
    '-vn', '-c:a', 'pcm_s16le', audioPath], { windowsHide: true, timeout: 120000 });
  const segments = crossParent ? [{ id: 'dialogue-cross-parent', start_ms: 4500, end_ms: 7000,
    source_text: '等我回来。', speaker_cluster_id: 'speaker-cluster-2' }] : [];
  const transcript = JSON.stringify(segments);
  fs.writeFileSync(path.join(h.root, 'source-transcript.json'), transcript);
  const evidence = { schema_version: 'redraw-source-audio-evidence-v1', task_id: 'synthetic-source-dialogue',
    work_id: 1, tenant_id: h.owner.tenantId, user_id: h.owner.userId, source_asset_id: 101,
    source_video_sha256: h.sourceFingerprint, audio_sha256: hash(fs.readFileSync(audioPath)),
    transcript_sha256: hash(transcript), source_language: 'zh', language_probability: 0.98,
    dialogue_mode: crossParent ? 'spoken' : 'silent', created_at: now,
    segments,
  };
  const bytes = JSON.stringify(evidence);
  fs.writeFileSync(path.join(h.root, 'source-evidence.json'), bytes);
  const metadata = { ...evidence, evidence_sha256: hash(bytes) }; delete metadata.segments;
  h.db.prepare(`INSERT INTO assets (id, type, category, local_path, metadata)
    VALUES (501, 'json', 'redraw_source_audio_evidence', 'source-evidence.json', ?)`).run(JSON.stringify(metadata));
  blueprint.evidence_manifest.items.push({ id: 'audio-source', kind: 'audio_transcript', asset_id: 501,
    sha256: hash(bytes), tool: 'synthetic-source-evidence', tool_version: '1' });
}

function saveBlueprint(h, raw, revision = 1) {
  const blueprint = normalizeEpisodeBlueprint(raw);
  const localization = { schema_version: 'episode-localization-v1', blueprint_hash: blueprint.blueprint_hash,
    locale: 'en-US', market: 'US', character_name_map: { 'character-001': 'Ethan', 'character-002': 'Maya' },
    dialogue_map: blueprint.shots.flatMap(shot => shot.dialogue.map(turn => ({
      source_dialogue_id: turn.id, shot_id: shot.id, target_text: 'Wait for me.', estimated_duration_ms: 1000,
    }))), text_region_map: [], cultural_adaptations: [], glossary: [], locked_terms: [],
    review: { status: 'review', updated_at: now } };
  localization.localization_hash = episodeLocalizationHash(localization);
  h.db.prepare(`INSERT INTO redraw_episode_blueprints (work_id, tenant_id, user_id, revision, status,
    blueprint_json, blueprint_hash, created_at, updated_at) VALUES (1, @fixtureTenant, @fixtureUser, ?, 'locked', ?, ?, ?, ?)`)
    .run({ fixtureTenant: h.owner.tenantId, fixtureUser: h.owner.userId }, revision, JSON.stringify(blueprint), blueprint.blueprint_hash, now, now);
  h.db.prepare(`UPDATE redraw_versions SET version = ?, blueprint_hash = ?, localization_hash = ?, localization_review_json = ? WHERE id = ?`)
    .run(revision, blueprint.blueprint_hash, localization.localization_hash, JSON.stringify(localization), h.versionId);
  h.blueprint = blueprint; h.localization = localization;
}

function configurePlan(h, durations, crossParent) {
  const model = 'fumin-seedance-2.0-mini';
  const videoEvidence = { config_id: 41, config_updated_at: now, provider: 'fumin', model,
    task_id: 'synthetic-video-evidence', terminal_status: 'completed', artifact_id: 305 };
  const capabilities = { [model]: { durations, resolutions: ['480p'], aspectRatios: ['16:9'],
    supportsAudio: true, supportsImageReference: true, supportsVideoReference: true, supportsAudioReference: true,
    maxReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3 } };
  h.db.prepare(`INSERT INTO ai_service_configs (id, service_type, provider, api_protocol, name, model, default_model,
    is_active, verification_status, settings, verified_capabilities, created_at, updated_at)
    VALUES (41, 'video', 'fumin', 'fumin_video', 'synthetic-local-only', ?, ?, 1, 'verified', ?, ?, ?, ?)`)
    .run(JSON.stringify([model]), model, JSON.stringify({ redraw_locale_capabilities: [
      { locale: 'en-US', market: 'US', status: 'verified', evidence: { video: videoEvidence } },
    ] }), JSON.stringify(capabilities), now, now);
  if (crossParent) {
    const tts = { config_id: 42, config_updated_at: now, provider: 'minimax', model: 'synthetic-tts',
      task_id: 'synthetic-audio-evidence', terminal_status: 'completed', artifact_id: 101 };
    h.db.prepare(`INSERT INTO ai_service_configs (id, service_type, provider, name, model, default_model,
      is_active, verification_status, settings, created_at, updated_at)
      VALUES (42, 'tts', 'minimax', 'synthetic-local-only', ?, 'synthetic-tts', 1, 'verified', ?, ?, ?)`)
      .run(JSON.stringify(['synthetic-tts']), JSON.stringify({ redraw_locale_capabilities: [
        { locale: 'en-US', market: 'US', status: 'verified', evidence: { tts } },
      ] }), now, now);
  }
}

async function fixture(t, { durations = [5], crossParent = false, secondMotion = false, sourceAssetAsString = false,
  beforeBlueprint, beforeReview, createActor } = {}) {
  const h = await createFixture({ createActor, execFile: (command, args, options) => {
    // Add actual AAC to the synthetic mother video BEFORE the original fixture hashes/binds it.
    // Motion remains H264/no-audio; this is a real FFmpeg invocation, never a fake probe result.
    const next = [...args];
    if (next.some(arg => String(arg).startsWith('testsrc2='))) {
      const at = next.indexOf('-t'); next.splice(at, 0, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
      next.splice(next.indexOf('-an'), 1, '-c:a', 'aac', '-ac', '1');
    }
    return run(command, next, options);
  } });
  t.after(() => { h.db.close(); fs.rmSync(h.root, { recursive: true, force: true }); });
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-unit-reference-snapshots-'));
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  h.ctx = { db: h.db, tenantId: h.owner.tenantId, userId: h.owner.userId, versionId: h.versionId, storageRoot: h.root,
    tempRoot: snapshotRoot,
    canReadArtifact: id => {
      const row = h.db.prepare('SELECT local_path FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(id));
      return Boolean(row && fs.existsSync(path.join(h.root, row.local_path)));
    } };
  if (!createActor) {
    h.db.prepare(`INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
      VALUES ('tenant-a', 'fixture', 'fixture-tenant-a', 'active', ?, ?)`).run(now, now);
    h.db.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role, status, created_at, updated_at)
      VALUES ('tenant-a', 'user-a', 'owner', 'active', ?, ?)`).run(now, now);
  }
  h.db.prepare(`UPDATE assets SET category = 'redraw_source', width = 864, height = 496, duration = 12,
    file_size = ?, metadata = ? WHERE id = 101`).run(fs.statSync(path.join(h.root, 'source/source.mp4')).size,
    JSON.stringify({ tenant_id: h.owner.tenantId, user_id: h.owner.userId, sha256: h.sourceFingerprint }));
  const motionRow = h.db.prepare('SELECT metadata FROM assets WHERE id = 305').get();
  const motionMetadata = { ...JSON.parse(motionRow.metadata), source: 'redraw_motion_reference_import',
    tenant_id: h.owner.tenantId, user_id: h.owner.userId, version_id: h.versionId, scope_type: 'shot', scope_id: h.shotId, purpose: 'motion' };
  h.db.prepare('UPDATE assets SET duration = 5, file_size = ?, metadata = ? WHERE id = 305')
    .run(fs.statSync(h.motionPath).size, JSON.stringify(motionMetadata));
  h.secondShotId = h.db.prepare("SELECT id FROM redraw_shots WHERE shot_id = 'shot-2'").get().id;
  if (secondMotion) {
    const draft = path.join(h.root, 'redraw-conditioning', 'second-draft.mp4');
    await run(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'smptebars=size=864x496:rate=25',
      '-t', '7', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', draft], { windowsHide: true, timeout: 120000 });
    const sha256 = hash(fs.readFileSync(draft)); const local = `redraw-conditioning/${sha256}.mp4`;
    fs.renameSync(draft, path.join(h.root, local));
    const metadata = structuredClone(motionMetadata); delete metadata.redraw_motion_reference;
    metadata.sha256 = sha256; metadata.scope_id = h.secondShotId;
    Object.assign(metadata.redraw_motion_import, { shot_id: h.secondShotId, clip_start_ms: 5000,
      clip_end_ms: 12000, duration_ms: 7000, file_sha256: sha256 });
    h.db.prepare(`INSERT INTO assets (id, name, type, category, local_path, mime_type, width, height,
      duration, file_size, metadata) VALUES (502, 'second-motion', 'video', 'redraw', ?, 'video/mp4', 864, 496, 7, ?, ?)`)
      .run(local, fs.statSync(path.join(h.root, local)).size, JSON.stringify(metadata));
    h.db.prepare(`INSERT INTO redraw_reference_artifact_imports (tenant_id, user_id, version_id, scope_type, scope_id,
      purpose, idempotency_hash, request_hash, file_sha256, stored_asset_id, status, created_at, updated_at)
      VALUES (@fixtureTenant, @fixtureUser, ?, 'shot', ?, 'motion', ?, ?, ?, 502, 'completed', ?, ?)`)
      .run({ fixtureTenant: h.owner.tenantId, fixtureUser: h.owner.userId }, h.versionId, h.secondShotId, hash('second-import'), hash('second-request'), sha256, now, now);
    await bindReadyMotionReference(h.ctx, { shot_id: h.secondShotId, clean_results: [] });
  }
  // Product lookup IDs only. Intentionally NOT a readiness assertion or saved parent dialogue bundle.
  h.db.prepare("UPDATE redraw_shots SET preparation_snapshot_json = ?, reference_bundle_json = '{}', reference_bundle_hash = NULL WHERE id = ?")
    .run(JSON.stringify({ clean_results: cleanResults }), h.shotId);
  h.db.prepare("UPDATE redraw_shots SET preparation_snapshot_json = ? WHERE id = ?")
    .run(JSON.stringify({ clean_results: [] }), h.secondShotId);
  const raw = blueprintFor(h, crossParent);
  if (sourceAssetAsString) raw.source.asset_id = String(raw.source.asset_id);
  if (beforeBlueprint) await beforeBlueprint(h, raw);
  await registerEvidence(h, raw, crossParent); saveBlueprint(h, raw);
  configurePlan(h, durations, crossParent);
  if (beforeReview) await beforeReview(h);
  const preview = previewVersionExecutionPlan(h.ctx, h.versionId);
  assert.equal(preview.status, 'ready', JSON.stringify(preview.blocking_reasons));
  saveExecutionPlanReview(h.ctx, h.versionId, { expected_plan_hash: preview.plan_hash });
  prepareExecutionQueue(h.ctx, h.versionId, { expected_plan_hash: preview.plan_hash });
  h.queueState = getExecutionQueue(h.ctx, h.versionId);
  h.expected = index => ({ version_id: h.versionId, review_id: h.queueState.saved_review.id,
    queue_id: h.queueState.queue.id, plan_hash: h.queueState.preview.plan_hash,
    unit_id: h.queueState.queue.units[index].id, unit_hash: h.queueState.queue.units[index].unit_hash });
  h.sourceProbe = await probeVideo(path.join(h.root, 'source/source.mp4'));
  return h;
}

module.exports = { fixture, hash, saveBlueprint, cleanResults };
