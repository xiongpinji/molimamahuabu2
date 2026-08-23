const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  buildGeneratedCoverageManifest,
  canonicalCoverageSha256,
} = require('../src/services/redrawFullFrameCoverageService');
const {
  canonicalizeModelLock,
  canonicalSha256: canonicalModelLockSha256,
} = require('../src/services/redrawFullFrameModelLockService');
const {
  evaluatePreparationGate,
  preparationEvidenceHash,
} = require('../src/services/redrawPreparationGateService');
const { prepareReferenceCleanRequirement } = require('../src/services/redrawAssetService');
const { reviewAsset } = require('../src/services/redrawReviewService');
const {
  buildTrustedReferenceBundleInput,
  canonicalBundleHash,
  loadReviewedReferenceCoverage,
  saveReferenceBundle,
} = require('../src/services/redrawReferenceBundleService');
const {
  prepareVersionReferences,
  quoteVersionPreparation,
  reconcileInterruptedPreparations,
  startVersionPreparation,
} = require('../src/services/redrawReferencePreparationOrchestrator');

const NOW = '2026-08-22T08:00:00.000Z';
const NEXT = '2026-08-22T08:00:01.000Z';
const PLAN_HASH = 'a'.repeat(64);
const FAKE_COVERAGE_SHA = 'b'.repeat(64);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function confidence(value = 0.99) {
  return {
    character_mapping: value,
    speaker_mapping: value,
    text_regions: value,
    shot_boundary: value,
  };
}

function setup(options = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const mode = options.mode || 'auto';
  const thresholds = confidence(0.9);
  db.prepare(`INSERT INTO redraw_projects
    (id, tenant_id, user_id, title, execution_mode, budget_limit_credits,
     max_auto_attempts_per_shot, policy_version, automation_policy_json, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 'reference preparation', ?, 100, 1, 3, ?, ?, ?)`)
    .run(mode, JSON.stringify({ analysis_confidence_thresholds: thresholds }), NOW, NOW);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (1, 1, 'tenant-a', 'user-a', 'episode', 101, ?, 15000, 1, 2,
      'asset_review', ?, ?)`)
    .run('f'.repeat(64), NOW, NOW);
  const facts = {
    schema_version: '2.0',
    shots: [1, 2, 3].map((index) => ({ id: `shot-${index}`, confidence: confidence(index === 2 && options.lowConfidence ? 0.7 : 0.99) })),
  };
  db.prepare(`INSERT INTO redraw_versions
    (id, work_id, tenant_id, user_id, version, locale, market, source_facts_json,
     facts_hash, reference_bundle_required, status, created_at, updated_at)
    VALUES (1, 1, 'tenant-a', 'user-a', 1, 'en-US', 'US', ?, ?, 1,
      'asset_review', ?, ?)`)
    .run(JSON.stringify(facts), sha256(stableJson(facts)), NOW, NOW);
  for (let index = 1; index <= 3; index += 1) {
    db.prepare(`INSERT INTO redraw_shots
      (id, work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index,
       start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
       references_json, preparation_state, preparation_version, preparation_snapshot_json,
       reference_bundle_json, created_at, updated_at)
      VALUES (?, 1, 1, 'tenant-a', 'user-a', ?, 1, ?, ?, ?, 5000, '[]', '[]', '[]',
        'localized', 1, '{}', '{}', ?, ?)`)
      .run(index, `shot-${index}`, index, (index - 1) * 5000, index * 5000, NOW, NOW);
  }
  if (options.readyFirst !== false) markReady(db, 1, options.referenceBundleSchemaVersion);
  return {
    db,
    ctx: { db, tenantId: 'tenant-a', userId: 'user-a', versionId: 1, now: () => NEXT },
    close() { db.close(); },
  };
}

function markReady(db, shotId, schemaVersion = 'redraw-reference-bundle-v2') {
  const bundle = { schema_version: schemaVersion, version_id: 1, shot_id: shotId };
  const referenceHash = canonicalBundleHash(bundle);
  const shot = db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(shotId);
  const snapshot = {
    schema_version: 'redraw-reference-preparation-v2',
    version_id: 1,
    shot_id: shotId,
    preparation_version: Number(shot.preparation_version),
    character_plan_hash: PLAN_HASH,
    reference_bundle_hash: referenceHash,
    request_hash: sha256(`ready:${shotId}`),
    status: 'completed',
    coverage_analysis_sha256: FAKE_COVERAGE_SHA,
    coverage_approved_by: 'user-a',
    coverage_approved_at: NOW,
    coverage_facts_hash: db.prepare('SELECT facts_hash FROM redraw_versions WHERE id = 1').get().facts_hash,
    coverage_source_fingerprint: db.prepare('SELECT source_fingerprint FROM redraw_works WHERE id = 1').get().source_fingerprint,
    coverage_requirement_keys: [`person_clean:people-${shotId}`],
    coverage_requirement_hash: sha256(stableJson([`person_clean:people-${shotId}`])),
  };
  const projected = {
    ...shot,
    reference_bundle_hash: referenceHash,
    preparation_snapshot_json: stableJson(snapshot),
  };
  db.prepare(`UPDATE redraw_shots
    SET preparation_state = 'reference_ready', reference_bundle_json = ?,
        reference_bundle_hash = ?, reference_bundle_updated_at = ?,
        preparation_snapshot_json = ?, preparation_evidence_hash = ?, updated_at = ?
    WHERE id = ?`)
    .run(
      stableJson(bundle), referenceHash, NOW, stableJson(snapshot),
      preparationEvidenceHash(projected), NOW, shotId,
    );
}

function coverageFor(db, requirements = {}) {
  const shots = db.prepare('SELECT id, shot_id FROM redraw_shots ORDER BY id').all();
  const factsHash = db.prepare('SELECT facts_hash FROM redraw_versions WHERE id = 1').get().facts_hash;
  const sourceFingerprint = db.prepare('SELECT source_fingerprint FROM redraw_works WHERE id = 1').get().source_fingerprint;
  const descriptors = shots.map((shot) => ({
    shot_id: shot.id,
    source_shot_id: shot.shot_id,
    requirements: requirements[shot.id] || [{ kind: 'person_clean', key: `people-${shot.id}` }],
  }));
  return {
    status: 'approved',
    shots: descriptors,
    coverage_binding: {
      schema_version: 'redraw-coverage-preparation-binding-v1', version_id: 1,
      analysis_sha256: FAKE_COVERAGE_SHA, approved_by: 'user-a', approved_at: NOW,
      facts_hash: factsHash, source_fingerprint: sourceFingerprint,
      shots: descriptors.map((descriptor) => {
        const keys = descriptor.requirements.map((item) => `${item.kind}:${item.key}`).sort();
        return { shot_id: descriptor.shot_id, requirement_keys: keys, requirement_hash: sha256(stableJson(keys)) };
      }),
    },
  };
}

function insertReadableImage(db, id) {
  db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, metadata, created_at, updated_at)
    VALUES (?, ?, 'image', 'redraw', ?, 'image/png', '{}', ?, ?)`)
    .run(id, `asset-${id}`, `redraw/asset-${id}.png`, NOW, NOW);
}

function writeStoredFile(storageRoot, relativePath, bytes) {
  const target = path.join(storageRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return sha256(bytes);
}

function insertStoredAsset(db, input) {
  db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'redraw', ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.name || `asset-${input.id}`,
      input.type,
      input.localPath,
      input.mimeType,
      JSON.stringify({ sha256: input.sha256, ...(input.metadata || {}) }),
      NOW,
      NOW,
    );
}

function validModelLock() {
  const projects = {
    face_detector: ['MediaPipe face detection', 'google-ai-edge/mediapipe'],
    person_detector: ['YOLOX', 'Megvii-BaseDetection/YOLOX'],
    text_detector: ['PaddleOCR', 'PaddlePaddle/PaddleOCR'],
    tracker: ['ByteTrack', 'FoundationVision/ByteTrack'],
  };
  const components = ['tracker', 'text_detector', 'person_detector', 'face_detector'].map((component) => ({
    component,
    project: projects[component][0],
    repository: projects[component][1],
    revision: `rev-${component}-20260816`,
    artifact_name: `${component}.bin`,
    artifact_path: `${component}/model.bin`,
    artifact_sha256: 'a'.repeat(64),
    license_name: `${component}-LICENSE`,
    license_evidence_path: `${component}/LICENSE.txt`,
    license_evidence_sha256: 'b'.repeat(64),
  }));
  const lock = {
    schema_version: 'redraw-full-frame-model-lock-v2',
    runtimes: {
      main: {
        python_version: 'Python 3.11.9',
        interpreter_path: 'runtime/main/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/main/pip-freeze.txt',
        pip_freeze_sha256: '1'.repeat(64),
      },
      text: {
        python_version: 'Python 3.11.9',
        interpreter_path: 'runtime/text/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/text/pip-freeze.txt',
        pip_freeze_sha256: '2'.repeat(64),
      },
    },
    components,
  };
  return { ...lock, canonical_sha256: canonicalModelLockSha256(canonicalizeModelLock(lock)) };
}

function identityPack(input) {
  const pack = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: 'char-a',
    target_actor_label: 'Alice Carter',
    artifact: { asset_id: 301, sha256: input.identitySha, width: 64, height: 96, mime_type: 'image/png' },
    wardrobe: {
      label: '整集主服装',
      reference_asset_id: 401,
      reference_sha256: input.wardrobeSha,
      consistency_confirmed: true,
    },
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    persona_origin: 'fictional_ai_generated',
    target_country: 'US',
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: NOW,
  };
  pack.pack_sha256 = sha256(stableJson({
    artifact: pack.artifact,
    adult_status: pack.adult_status,
    confirmed_views: pack.confirmed_views,
    identity_consistency_confirmed: pack.identity_consistency_confirmed,
    live_action_human_confirmed: pack.live_action_human_confirmed,
    persona_origin: pack.persona_origin,
    ready: pack.ready,
    reviewed_at: pack.reviewed_at,
    reviewed_by: pack.reviewed_by,
    schema_version: pack.schema_version,
    source_character_key: pack.source_character_key,
    target_actor_label: pack.target_actor_label,
    target_country: pack.target_country,
    wardrobe: pack.wardrobe,
  }));
  return pack;
}

function textCleanPack(input) {
  const pack = {
    schema_version: 'text-clean-plate-reference-v1',
    region_key: 'subtitle-a',
    kind: 'text_subtitle',
    artifact: { asset_id: 302, sha256: input.cleanSha, width: 64, height: 64, mime_type: 'image/png' },
    source_fingerprint: input.sourceSha,
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: NOW,
  };
  pack.pack_sha256 = sha256(stableJson(pack));
  return pack;
}

async function setupDefaultServerPath(options = {}) {
  const includePerson = options.includePerson === true;
  const includeText = options.includeText !== false;
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-reference-default-'));
  const sourceSha = writeStoredFile(storageRoot, 'source/source.mp4', Buffer.from('source-video'));
  const identitySha = writeStoredFile(storageRoot, 'redraw/identity.png', Buffer.from('identity'));
  const wardrobeSha = writeStoredFile(storageRoot, 'redraw/wardrobe.png', Buffer.from('wardrobe'));
  const voiceSha = writeStoredFile(storageRoot, 'redraw/voice.mp3', Buffer.from('voice'));
  const cleanSha = writeStoredFile(storageRoot, 'redraw/text-clean.png', Buffer.from('text-clean'));
  const personCleanSha = writeStoredFile(storageRoot, 'redraw/person-clean.png', Buffer.from('person-clean'));
  const motionBytes = Buffer.from('motion-reference');
  const motionSha = writeStoredFile(storageRoot, `redraw-conditioning/${sha256(motionBytes)}.mp4`, motionBytes);
  const evidenceBase = 'redraw-full-frame/version-1';
  const frameBytes = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 40, b: 50 } },
  }).png().toBuffer();
  const maskPixels = Buffer.alloc(64 * 64);
  for (let y = 48; y < 58; y += 1) {
    for (let x = 4; x < 40; x += 1) maskPixels[(y * 64) + x] = 255;
  }
  const maskBytes = await sharp(maskPixels, { raw: { width: 64, height: 64, channels: 1 } })
    .toColourspace('b-w').png().toBuffer();
  const personMaskPixels = Buffer.alloc(64 * 64);
  for (let y = 8; y < 40; y += 1) {
    for (let x = 8; x < 28; x += 1) personMaskPixels[(y * 64) + x] = 255;
  }
  const personMaskBytes = await sharp(personMaskPixels, { raw: { width: 64, height: 64, channels: 1 } })
    .toColourspace('b-w').png().toBuffer();
  const frameSha = writeStoredFile(storageRoot, `${evidenceBase}/frames/frame-0.png`, frameBytes);
  const maskSha = writeStoredFile(storageRoot, `${evidenceBase}/masks/text-0.png`, maskBytes);
  const personMaskSha = writeStoredFile(storageRoot, `${evidenceBase}/masks/person-0.png`, personMaskBytes);

  for (const asset of [
    { id: 101, type: 'video', mimeType: 'video/mp4', localPath: 'source/source.mp4', sha256: sourceSha },
    { id: 301, type: 'image', mimeType: 'image/png', localPath: 'redraw/identity.png', sha256: identitySha },
    { id: 401, type: 'image', mimeType: 'image/png', localPath: 'redraw/wardrobe.png', sha256: wardrobeSha },
    { id: 501, type: 'audio', mimeType: 'audio/mpeg', localPath: 'redraw/voice.mp3', sha256: voiceSha },
    { id: 302, type: 'image', mimeType: 'image/png', localPath: 'redraw/text-clean.png', sha256: cleanSha },
    { id: 303, type: 'image', mimeType: 'image/png', localPath: 'redraw/person-clean.png', sha256: personCleanSha },
    { id: 801, type: 'image', mimeType: 'image/png', localPath: `${evidenceBase}/frames/frame-0.png`, sha256: frameSha },
    { id: 802, type: 'image', mimeType: 'image/png', localPath: `${evidenceBase}/masks/text-0.png`, sha256: maskSha },
    { id: 803, type: 'image', mimeType: 'image/png', localPath: `${evidenceBase}/masks/person-0.png`, sha256: personMaskSha },
  ]) insertStoredAsset(db, asset);
  db.prepare(`INSERT INTO redraw_projects
    (id, tenant_id, user_id, title, execution_mode, budget_limit_credits,
     max_auto_attempts_per_shot, policy_version, automation_policy_json, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 'default path', 'auto', 100, 1, 1, ?, ?, ?)`)
    .run(JSON.stringify({ analysis_confidence_thresholds: confidence(0.9) }), NOW, NOW);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (1, 1, 'tenant-a', 'user-a', 'episode', 101, ?, 12000, 1, 2, 'asset_review', ?, ?)`)
    .run(sourceSha, NOW, NOW);
  const nameMap = { 'char-a': 'Alice Carter' };
  const facts = {
    schema_version: '2.0',
    script_sha256: '9'.repeat(64),
    name_map_source_sha256: sha256(stableJson(nameMap)),
    characters: [{
      source_character_key: 'char-a',
      source_name: 'Alice',
    }],
    shots: [{ id: 'shot-1', confidence: confidence(0.99) }],
  };
  const factsHash = sha256(stableJson(facts));
  db.prepare(`INSERT INTO redraw_versions
    (id, work_id, tenant_id, user_id, version, locale, market, name_map_json,
     source_facts_json, facts_hash, reference_bundle_required, status, created_at, updated_at)
    VALUES (1, 1, 'tenant-a', 'user-a', 1, 'en-US', 'US', ?, ?, ?, 1, 'asset_review', ?, ?)`)
    .run(JSON.stringify(nameMap), JSON.stringify(facts), factsHash, NOW, NOW);
  db.prepare(`INSERT INTO redraw_shots
    (id, work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
     references_json, preparation_state, preparation_version, preparation_snapshot_json,
     reference_bundle_json, created_at, updated_at)
    VALUES (1, 1, 1, 'tenant-a', 'user-a', 'shot-1', 1, 1, 0, 12000, 12000,
      '[]', '[]', '[]', 'localized', 1, '{}', '{}', ?, ?)`)
    .run(NOW, NOW);

  const pack = identityPack({ identitySha, wardrobeSha });
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, voice_asset_id, version_number, approval_status, approved_by,
     approved_at, status, created_at, updated_at)
    VALUES (201, 1, 'tenant-a', 'user-a', 'character', ?, 'Alice Carter',
      301, 501, 1, 'approved', 'user-a', ?, 'generated', ?, ?)`)
    .run(JSON.stringify({
      source_ref: { stable_id: 'char-a' },
      identity_pack: pack,
      snapshot: { voice_snapshot: {
        locale: 'en-US', market: 'US', audio_sha256: voiceSha, audio_asset_id: 501,
        language_verified: true, detected_locale: 'en-US',
      } },
    }), NOW, NOW, NOW);
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     voice_asset_id, version_number, approval_status, approved_by, approved_at,
     status, created_at, updated_at)
    VALUES (203, 1, 'tenant-a', 'user-a', 'voice', ?, 'voice char-a', 501, 1,
      'approved', 'user-a', ?, 'generated', ?, ?)`)
    .run(JSON.stringify({ source_ref: { stable_id: 'char-a' } }), NOW, NOW, NOW);
  const cleanPack = textCleanPack({ cleanSha, sourceSha });
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     clean_plate_asset_id, version_number, approval_status, approved_by, approved_at,
     status, created_at, updated_at)
    VALUES (202, 1, 'tenant-a', 'user-a', 'scene', ?, 'subtitle clean', 302, 1,
      'approved', 'user-a', ?, 'generated', ?, ?)`)
    .run(JSON.stringify({
      source_ref: { stable_id: 'subtitle-a', kind: 'text_subtitle' },
      snapshot: { mode: 'text_clean_plate' },
      text_clean_plate_pack: cleanPack,
    }), NOW, NOW, NOW);

  const generated = await buildGeneratedCoverageManifest({
    evidenceRoot: path.join(storageRoot, evidenceBase),
    source: { sha256: sourceSha, duration_ms: 12000, width: 64, height: 64, frame_count: 1, time_base: { numerator: 1, denominator: 1 } },
    shots: [{ shot_id: 'shot-1', start_ms: 0, end_ms: 12000 }],
    frames: [{
      frame_index: 0, timestamp_ticks: 0, timestamp_ms: 0, shot_id: 'shot-1',
      path: 'frames/frame-0.png', sha256: frameSha, width: 64, height: 64,
      person_region_ids: includePerson ? ['person-region-0'] : [],
      text_region_ids: includeText ? ['text-region-0'] : [],
      review_point_reasons: [], review_status: 'not_required',
    }],
    personTracks: includePerson ? [{
      track_key: 'person-a', kind: 'story_role', source_character_key: 'char-a',
      target_strategy: 'fixed_actor', frame_ranges: [{ start_frame: 0, end_frame: 0 }],
      visibility: [{ start_frame: 0, end_frame: 0, state: 'visible' }],
      regions: [{
        region_id: 'person-region-0', frame_index: 0,
        bbox: { x: 8, y: 8, width: 20, height: 32 },
        mask: { path: 'masks/person-0.png', sha256: personMaskSha, width: 64, height: 64, mime_type: 'image/png' },
        association_confidence: 0.99, detector_disagreement: false,
      }],
      review_status: 'pending', reviewer: null,
    }] : [],
    textTracks: includeText ? [{
      region_key: 'subtitle-a', kind: 'subtitle', treatment: 'translate_subtitle',
      target_text_key: 'subtitle-a', frame_ranges: [{ start_frame: 0, end_frame: 0 }],
      regions: [{
        region_id: 'text-region-0', frame_index: 0,
        polygon: [{ x: 4, y: 48 }, { x: 40, y: 48 }, { x: 40, y: 58 }],
        mask: { path: 'masks/text-0.png', sha256: maskSha, width: 64, height: 64, mime_type: 'image/png' },
      }],
      review_status: 'pending', reviewer: null,
    }] : [],
    modelLock: validModelLock(),
  });
  const reviewed = JSON.parse(JSON.stringify(generated));
  reviewed.status = 'reviewed';
  reviewed.frames[0].review_status = reviewed.frames[0].review_point_reasons.length ? 'reviewed' : 'not_required';
  for (const track of [...reviewed.person_tracks, ...reviewed.text_tracks]) {
    track.review_status = 'reviewed';
    track.reviewer = 'codex-local-review';
  }
  reviewed.review = {
    status: 'reviewed', reviewed: true,
    required_review_point_count: reviewed.frames[0].review_point_reasons.length ? 1 : 0,
    reviewed_point_count: reviewed.frames[0].review_point_reasons.length ? 1 : 0,
    reviewer: 'codex-local-review',
  };
  reviewed.approval_status = 'pending';
  reviewed.ready_for_reference = false;
  reviewed.analysis_sha256 = canonicalCoverageSha256(reviewed);
  const manifestBytes = Buffer.from(`${JSON.stringify(reviewed, null, 2)}\n`);
  const manifestPath = `${evidenceBase}/redraw-full-frame-reviewed-manifest.json`;
  const manifestSha = writeStoredFile(storageRoot, manifestPath, manifestBytes);
  insertStoredAsset(db, {
    id: 701, type: 'document', mimeType: 'application/json', localPath: manifestPath, sha256: manifestSha,
  });
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, version_number, approval_status, approved_by, approved_at,
     status, created_at, updated_at)
    VALUES (204, 1, 'tenant-a', 'user-a', 'scene', ?, 'reviewed full frame coverage',
      701, 1, 'approved', 'user-a', ?, 'generated', ?, ?)`)
    .run(JSON.stringify({
      source_ref: { stable_id: 'full-frame-reviewed-coverage' },
      snapshot: {
        mode: 'full_frame_reviewed_coverage', version_id: 1, facts_hash: factsHash,
        source_fingerprint: sourceSha, analysis_sha256: reviewed.analysis_sha256,
      },
    }), NOW, NOW, NOW);

  const faceHash = sha256(stableJson(includePerson ? [{
    track_key: 'person-a', source_character_key: 'char-a', time_ranges: [[0, 12000]],
    identity_redraw_asset_id: 201,
  }] : []));
  const textHash = sha256(stableJson(includeText ? [{
    kind: 'text_subtitle', region_key: 'subtitle-a', text_clean_redraw_asset_id: 202,
    time_ranges: [[0, 12000]],
  }] : []));
  insertStoredAsset(db, {
    id: 601,
    type: 'video',
    mimeType: 'video/mp4',
    localPath: `redraw-conditioning/${motionSha}.mp4`,
    sha256: motionSha,
    metadata: { redraw_motion_reference: {
      schema_version: 'redraw-motion-reference-v1', tenant_id: 'tenant-a', user_id: 'user-a',
      version_id: 1, shot_id: 1, source_asset_id: 101, source_fingerprint: sourceSha,
      clip_start_ms: 0, clip_end_ms: 12000,
      face_coverage_sha256: faceHash, text_coverage_sha256: textHash,
    } },
  });
  return {
    db,
    ctx: {
      db, tenantId: 'tenant-a', userId: 'user-a', versionId: 1, storageRoot,
      now: () => NEXT,
      assetReader: {
        canRead: (asset) => Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path))),
        owns: () => true,
      },
      probeRunner: async () => ({
        duration_ms: 12000, width: 64, height: 64, mime_type: 'video/mp4',
        video_codec: 'h264', audio_stream_count: 0,
      }),
    },
    personCleanSha,
    cleanup() {
      db.close();
      fs.rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

function fakeDeps(state, options = {}) {
  const cleanCalls = [];
  const bundleCalls = [];
  const quoteCalls = [];
  const outcomes = options.outcomes || new Map();
  return {
    cleanCalls,
    bundleCalls,
    quoteCalls,
    getCharacterPlan() {
      return { ready: true, version_id: 1, plan_hash: PLAN_HASH, characters: [] };
    },
    getReviewedCoverage() {
      return coverageFor(state.db, options.requirements);
    },
    quoteCleanRequirement({ shot, requirement }) {
      quoteCalls.push({ shot_id: shot.id, key: requirement.key });
      return { priced: true, credits: 2 };
    },
    async prepareCleanRequirement(payload) {
      cleanCalls.push({ shot_id: payload.shot.id, key: payload.requirement.key, operation_key: payload.operation_key });
      const outcome = outcomes.get(payload.shot.id);
      if (typeof outcome === 'function') return outcome(payload);
      return outcome || { status: 'completed', redraw_asset_id: 1000 + payload.shot.id };
    },
    buildReferenceBundleInput({ shot, clean_results: cleanResults }) {
      return {
        shot_id: shot.id,
        clean_results: cleanResults.map((item) => ({ key: item.key, redraw_asset_id: item.redraw_asset_id })),
      };
    },
    async saveReferenceBundle(_ctx, input) {
      bundleCalls.push(input.shot_id);
      const bundle = {
        schema_version: 'redraw-reference-bundle-v2',
        version_id: 1,
        shot_id: input.shot_id,
        clean_results: input.clean_results,
      };
      const hash = canonicalBundleHash(bundle);
      state.db.prepare(`UPDATE redraw_shots
        SET reference_bundle_json = ?, reference_bundle_hash = ?,
            reference_bundle_updated_at = ?, updated_at = ? WHERE id = ?`)
        .run(stableJson(bundle), hash, NEXT, NEXT, input.shot_id);
      return {
        shot_id: input.shot_id,
        reference_bundle_hash: hash,
        reference_bundle_updated_at: NEXT,
        bundle,
      };
    },
    isCleanResultCurrent() {
      return true;
    },
    ...options.overrides,
  };
}

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error?.code === code);
}

test('auto 只准备缺失镜头并在证据完整后保存参考包', async () => {
  const state = setup();
  try {
    const deps = fakeDeps(state);
    const result = await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'prep-v1',
    }, deps);
    assert.deepEqual(result.prepared_shot_ids, [2, 3]);
    assert.deepEqual(result.reused_shot_ids, [1]);
    assert.equal(deps.cleanCalls.length, 2);
    assert.deepEqual(deps.bundleCalls, [2, 3]);
    assert.deepEqual(state.db.prepare('SELECT preparation_state FROM redraw_shots ORDER BY id').all().map((row) => row.preparation_state), [
      'reference_ready', 'reference_ready', 'reference_ready',
    ]);
  } finally {
    state.close();
  }
});

test('旧 V1 参考包不可复用且必须重新准备为 V2', async () => {
  const state = setup({ referenceBundleSchemaVersion: 'redraw-reference-bundle-v1' });
  try {
    const deps = fakeDeps(state);
    const result = await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'replace-legacy-v1',
    }, deps);
    assert.deepEqual(result.prepared_shot_ids, [1, 2, 3]);
    assert.deepEqual(result.reused_shot_ids, []);
    assert.deepEqual(deps.bundleCalls, [1, 2, 3]);
    const bundle = JSON.parse(state.db.prepare('SELECT reference_bundle_json FROM redraw_shots WHERE id = 1').get().reference_bundle_json);
    assert.equal(bundle.schema_version, 'redraw-reference-bundle-v2');
  } finally {
    state.close();
  }
});

test('safe 模式等待服务端报价确认后才创建净景任务', async () => {
  const state = setup({ mode: 'safe' });
  try {
    const deps = fakeDeps(state);
    const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    assert.equal(quote.confirmation_required, true);
    assert.equal(quote.effective_mode, 'safe');
    await rejectsCode(() => prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'safe-no-confirmation',
    }, deps), 'REDRAW_REFERENCE_PREPARATION_CONFIRMATION_REQUIRED');
    assert.equal(deps.cleanCalls.length, 0);
    const result = await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'safe-confirmed',
      quote_hash: quote.quote_hash,
    }, deps);
    assert.deepEqual(result.prepared_shot_ids, [2, 3]);
  } finally {
    state.close();
  }
});

test('auto 低置信度降级 safe 且未确认时零生成调用', async () => {
  const state = setup({ lowConfidence: true });
  try {
    const deps = fakeDeps(state);
    const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    assert.equal(quote.effective_mode, 'safe');
    assert.equal(quote.confirmation_required, true);
    assert.ok(quote.reason_codes.includes('character_mapping_low_confidence'));
    await rejectsCode(() => prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'low-confidence',
    }, deps), 'REDRAW_REFERENCE_PREPARATION_CONFIRMATION_REQUIRED');
    assert.equal(deps.cleanCalls.length, 0);
    assert.equal(deps.bundleCalls.length, 0);
  } finally {
    state.close();
  }
});

test('净景明确失败不回滚其他已完成镜头', async () => {
  const state = setup();
  try {
    const deps = fakeDeps(state, {
      outcomes: new Map([[2, { status: 'failed', error_code: 'CLEAN_PLATE_FAILED' }]]),
    });
    const result = await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'partial-failed',
    }, deps);
    assert.deepEqual(result.prepared_shot_ids, [3]);
    assert.deepEqual(result.failed_shot_ids, [2]);
    assert.equal(state.db.prepare('SELECT preparation_state FROM redraw_shots WHERE id = 2').get().preparation_state, 'failed');
    assert.equal(state.db.prepare('SELECT preparation_state FROM redraw_shots WHERE id = 3').get().preparation_state, 'reference_ready');
  } finally {
    state.close();
  }
});

test('结果未知进入 needs_attention 并禁止同键或换键重复提交', async () => {
  const state = setup();
  try {
    const outcomes = new Map([[2, {
      status: 'unknown', provider_task_id: 'provider-2', reservation_id: 'reservation-2', redraw_asset_id: 2002,
    }]]);
    const deps = fakeDeps(state, { outcomes });
    const first = await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'unknown-first',
      shot_ids: [2],
    }, deps);
    assert.deepEqual(first.needs_attention_shot_ids, [2]);
    assert.equal(deps.cleanCalls.length, 1);
    await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'unknown-first',
      shot_ids: [2],
    }, deps);
    await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'unknown-second',
      shot_ids: [2],
    }, deps);
    assert.equal(deps.cleanCalls.length, 1);
    const row = state.db.prepare('SELECT preparation_state, preparation_snapshot_json FROM redraw_shots WHERE id = 2').get();
    assert.equal(row.preparation_state, 'needs_attention');
    const snapshot = JSON.parse(row.preparation_snapshot_json);
    assert.equal(snapshot.reservation_id, 'reservation-2');
    assert.equal(snapshot.provider_task_id, 'provider-2');
  } finally {
    state.close();
  }
});

test('默认净景适配保留供应商未知任务且换幂等键也不重复派发', async () => {
  const state = setup();
  let providerCalls = 0;
  try {
    insertReadableImage(state.db, 501);
    insertReadableImage(state.db, 502);
    state.ctx.assetReader = { canRead: () => true };
    const deps = fakeDeps(state, {
      requirements: {
        2: [{
          kind: 'person_clean',
          key: 'people-2',
          scene_asset: { source_asset_id: 501, source_fingerprint: 'frame-2', width: 640, height: 360 },
          options: { mask_asset_id: 502 },
        }],
      },
      overrides: {
        provider: async () => {
          providerCalls += 1;
          return { status: 'processing', provider_task_id: 'clean-provider-2' };
        },
      },
    });
    delete deps.prepareCleanRequirement;
    const first = await prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'default-unknown-one', shot_ids: [2],
    }, deps);
    assert.deepEqual(first.needs_attention_shot_ids, [2]);
    const assetAttempt = state.db.prepare('SELECT status, generation_task_id, credit_reservation_id FROM redraw_assets').get();
    assert.equal(assetAttempt.status, 'needs_attention');
    assert.equal(assetAttempt.generation_task_id, 'clean-provider-2');
    const second = await prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'default-unknown-two', shot_ids: [2],
    }, deps);
    assert.deepEqual(second.needs_attention_shot_ids, [2]);
    assert.equal(providerCalls, 1);
  } finally {
    state.close();
  }
});

test('部分成功后使用新幂等键只恢复明确失败镜头', async () => {
  const state = setup();
  try {
    const outcomes = new Map([[2, { status: 'failed', error_code: 'CLEAN_PLATE_FAILED' }]]);
    const deps = fakeDeps(state, { outcomes });
    await prepareVersionReferences(state.ctx, { version_id: 1, idempotency_key: 'partial-one' }, deps);
    outcomes.set(2, { status: 'completed', redraw_asset_id: 2002 });
    const recovered = await prepareVersionReferences(state.ctx, { version_id: 1, idempotency_key: 'partial-two' }, deps);
    assert.deepEqual(recovered.prepared_shot_ids, [2]);
    assert.deepEqual(recovered.reused_shot_ids, [1, 3]);
    assert.deepEqual(deps.cleanCalls.map((call) => call.shot_id), [2, 3, 2]);
  } finally {
    state.close();
  }
});

test('同镜头部分成功后新幂等键只补仍缺净景要求', async () => {
  const state = setup();
  let textAttempts = 0;
  try {
    const deps = fakeDeps(state, {
      requirements: {
        2: [
          { kind: 'person_clean', key: 'people-2' },
          { kind: 'text_clean', key: 'text-2' },
        ],
      },
      overrides: {
        async prepareCleanRequirement(payload) {
          deps.cleanCalls.push({ shot_id: payload.shot.id, key: payload.requirement.key });
          if (payload.requirement.kind === 'text_clean' && textAttempts++ === 0) {
            return { status: 'failed', error_code: 'TEXT_CLEAN_FAILED' };
          }
          return { status: 'completed', redraw_asset_id: payload.requirement.kind === 'person_clean' ? 2002 : 3002 };
        },
      },
    });
    const first = await prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'same-shot-partial-one', shot_ids: [2],
    }, deps);
    assert.deepEqual(first.failed_shot_ids, [2]);
    const recovered = await prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'same-shot-partial-two', shot_ids: [2],
    }, deps);
    assert.deepEqual(recovered.prepared_shot_ids, [2]);
    assert.deepEqual(deps.cleanCalls.map((call) => call.key), ['people-2', 'text-2', 'text-2']);
  } finally {
    state.close();
  }
});

test('同一幂等键完成重放不新增净景、包或事件', async () => {
  const state = setup();
  try {
    const deps = fakeDeps(state);
    const input = { version_id: 1, idempotency_key: 'same-replay' };
    await prepareVersionReferences(state.ctx, input, deps);
    const eventCount = state.db.prepare("SELECT COUNT(*) AS count FROM redraw_workflow_events WHERE reason_code = 'reference_preparation_completed'").get().count;
    const replay = await prepareVersionReferences(state.ctx, input, deps);
    assert.deepEqual(replay.prepared_shot_ids, []);
    assert.deepEqual(replay.reused_shot_ids, [1, 2, 3]);
    assert.equal(deps.cleanCalls.length, 2);
    assert.equal(deps.bundleCalls.length, 2);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM redraw_workflow_events WHERE reason_code = 'reference_preparation_completed'").get().count, eventCount);
  } finally {
    state.close();
  }
});

test('并发 CAS 只允许一个调用认领镜头并派发净景', async () => {
  const state = setup();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  try {
    const deps = fakeDeps(state, {
      overrides: {
        async prepareCleanRequirement(payload) {
          deps.cleanCalls.push({ shot_id: payload.shot.id, key: payload.requirement.key });
          started();
          await blocked;
          return { status: 'completed', redraw_asset_id: 2002 };
        },
      },
    });
    const first = prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'concurrent-one', shot_ids: [2],
    }, deps);
    await entered;
    const second = await prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'concurrent-two', shot_ids: [2],
    }, deps);
    assert.deepEqual(second.needs_attention_shot_ids, [2]);
    assert.equal(deps.cleanCalls.length, 1);
    release();
    const completed = await first;
    assert.deepEqual(completed.prepared_shot_ids, [2]);
  } finally {
    release?.();
    state.close();
  }
});

test('上游版本或角色哈希漂移时中止且绝不保存参考包', async () => {
  const state = setup();
  try {
    const deps = fakeDeps(state, {
      overrides: {
        async prepareCleanRequirement(payload) {
          deps.cleanCalls.push({ shot_id: payload.shot.id, key: payload.requirement.key });
          state.db.prepare('UPDATE redraw_versions SET updated_at = ? WHERE id = 1')
            .run('2026-08-22T08:00:02.000Z');
          return { status: 'completed', redraw_asset_id: 2002 };
        },
      },
    });
    await rejectsCode(() => prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'drift', shot_ids: [2],
    }, deps), 'REDRAW_REFERENCE_PREPARATION_DRIFT');
    assert.equal(deps.bundleCalls.length, 0);
    assert.equal(state.db.prepare('SELECT preparation_state FROM redraw_shots WHERE id = 2').get().preparation_state, 'needs_attention');
  } finally {
    state.close();
  }
});

test('start 幂等复用异步任务，reconcile 将中断任务和镜头收口为 needs_attention', async () => {
  const state = setup();
  let scheduledJob;
  try {
    const deps = fakeDeps(state, {
      overrides: {
        schedule(job) {
          scheduledJob = job;
          return new Promise(() => {});
        },
      },
    });
    const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    const first = await startVersionPreparation(state.ctx, {
      version_id: 1,
      idempotency_key: 'start-once',
      quote_hash: quote.quote_hash,
    }, deps);
    const replay = await startVersionPreparation(state.ctx, {
      version_id: 1,
      idempotency_key: 'start-once',
      quote_hash: quote.quote_hash,
    }, deps);
    assert.equal(replay.task_id, first.task_id);
    assert.equal(typeof scheduledJob, 'function');
    const reconciled = reconcileInterruptedPreparations(state.ctx);
    assert.equal(reconciled.needs_attention, 1);
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(first.task_id).status, 'needs_attention');
  } finally {
    state.close();
  }
});

test('start 调度同步抛错会脱敏收口且任务不悬挂', async () => {
  const state = setup();
  try {
    const deps = fakeDeps(state, {
      overrides: {
        schedule() {
          throw new Error('Authorization: Bearer sk-local C:\\Users\\canqu\\private-key.txt');
        },
      },
    });
    const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    const started = await startVersionPreparation(state.ctx, {
      version_id: 1,
      idempotency_key: 'schedule-sync-failure',
      quote_hash: quote.quote_hash,
    }, deps);
    assert.equal(started.status, 'needs_attention');
    await assert.rejects(started.completion, (error) => {
      assert.equal(error.code, 'REDRAW_REFERENCE_PREPARATION_SCHEDULE_FAILED');
      assert.equal(String(error.message).includes('sk-local'), false);
      assert.equal(String(error.message).includes('C:\\Users'), false);
      return true;
    });
    const task = state.db.prepare('SELECT status, message, error FROM async_tasks WHERE id = ?').get(started.task_id);
    assert.equal(task.status, 'needs_attention');
    assert.equal(['pending', 'processing'].includes(task.status), false);
    assert.equal(JSON.stringify(task).includes('sk-local'), false);
    assert.equal(JSON.stringify(task).includes('C:\\Users'), false);
  } finally {
    state.close();
  }
});

test('start 调度 Promise 拒绝会脱敏收口且任务不悬挂', async () => {
  const state = setup();
  try {
    const deps = fakeDeps(state, {
      overrides: {
        schedule() {
          return Promise.reject(new Error('Key=sk-local; path=C:\\Users\\canqu\\provider.env'));
        },
      },
    });
    const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    const started = await startVersionPreparation(state.ctx, {
      version_id: 1,
      idempotency_key: 'schedule-async-failure',
      quote_hash: quote.quote_hash,
    }, deps);
    await assert.rejects(started.completion, (error) => {
      assert.equal(error.code, 'REDRAW_REFERENCE_PREPARATION_SCHEDULE_FAILED');
      assert.equal(String(error.message).includes('sk-local'), false);
      assert.equal(String(error.message).includes('C:\\Users'), false);
      return true;
    });
    const task = state.db.prepare('SELECT status, message, error FROM async_tasks WHERE id = ?').get(started.task_id);
    assert.equal(['pending', 'processing'].includes(task.status), false);
    assert.equal(task.status, 'needs_attention');
    assert.equal(JSON.stringify(task).includes('sk-local'), false);
    assert.equal(JSON.stringify(task).includes('C:\\Users'), false);
  } finally {
    state.close();
  }
});

test('默认服务端路径从已批准全帧证据读取覆盖并用当前净景结果保存严格参考包', async () => {
  const state = await setupDefaultServerPath();
  try {
    const initial = await quoteVersionPreparation(state.ctx, { version_id: 1 });
    assert.equal(initial.priced, false);
    assert.equal(initial.action, 'blocked');
    assert.deepEqual(initial.items.map((item) => [item.kind, item.key]), [['text_clean', 'subtitle-a']]);
    assert.equal(JSON.stringify(initial).includes(state.ctx.storageRoot), false);
    const coverage = await loadReviewedReferenceCoverage(state.ctx);
    const coverageShot = coverage.coverage_binding.shots[0];

    const snapshot = {
      schema_version: 'redraw-reference-preparation-v2',
      version_id: 1,
      shot_id: 1,
      preparation_version: 1,
      character_plan_hash: initial.character_plan_hash,
      version_snapshot_hash: initial.version_snapshot_hash,
      request_hash: sha256('previous-attempt'),
      idempotency_key_hash: sha256('previous-attempt'),
      coverage_analysis_sha256: coverage.coverage_binding.analysis_sha256,
      coverage_approved_by: coverage.coverage_binding.approved_by,
      coverage_approved_at: coverage.coverage_binding.approved_at,
      coverage_facts_hash: coverage.coverage_binding.facts_hash,
      coverage_source_fingerprint: coverage.coverage_binding.source_fingerprint,
      coverage_requirement_keys: coverageShot.requirement_keys,
      coverage_requirement_hash: coverageShot.requirement_hash,
      status: 'failed',
      requirements: [{ kind: 'text_clean', key: 'subtitle-a' }],
      clean_results: [{ kind: 'text_clean', key: 'subtitle-a', status: 'completed', redraw_asset_id: 202 }],
      error_code: 'REDRAW_REFERENCE_PREPARATION_CLEAN_FAILED',
    };
    state.db.prepare(`UPDATE redraw_shots
      SET preparation_state = 'failed', preparation_snapshot_json = ?, preparation_evidence_hash = ?
      WHERE id = 1`).run(stableJson(snapshot), sha256(stableJson(snapshot)));

    const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 });
    assert.equal(quote.priced, true);
    assert.equal(quote.credits, 0);
    assert.equal(quote.action, 'advance');
    assert.deepEqual(quote.items, []);
    const result = await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'default-server-path',
      quote_hash: quote.quote_hash,
    });
    assert.deepEqual(result.prepared_shot_ids, [1]);
    const shot = state.db.prepare(`SELECT preparation_state, reference_bundle_json,
      reference_bundle_hash, preparation_snapshot_json, preparation_evidence_hash
      FROM redraw_shots WHERE id = 1`).get();
    const bundle = JSON.parse(shot.reference_bundle_json);
    assert.equal(shot.preparation_state, 'reference_ready');
    assert.equal(canonicalBundleHash(bundle), shot.reference_bundle_hash);
    assert.equal(bundle.coverage_review.reviewed_by, 'user-a');
    assert.equal(bundle.coverage_review.mapped_text_region_count, 1);
    assert.equal(bundle.text_regions[0].region_key, 'subtitle-a');
    assert.equal(bundle.text_regions[0].text_clean_redraw_asset_id, 202);
    assert.equal(preparationEvidenceHash({ ...shot, id: 1, version_id: 1, preparation_version: 1 }), shot.preparation_evidence_hash);
  } finally {
    state.cleanup();
  }
});

test('默认服务端路径对未批准或不匹配的全帧持久化证据稳定 fail closed', async () => {
  const state = await setupDefaultServerPath();
  try {
    state.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 204").run();
    await rejectsCode(
      () => quoteVersionPreparation(state.ctx, { version_id: 1 }),
      'REDRAW_REFERENCE_PREPARATION_COVERAGE_NOT_APPROVED',
    );
  } finally {
    state.cleanup();
  }
});

test('真实人物净景经人工批准后可恢复，且物理文件删除或漂移会关闭准备门禁', async () => {
  const state = await setupDefaultServerPath({ includePerson: true, includeText: false });
  try {
    let providerCalls = 0;
    const deps = {
      quoteCleanRequirement: () => ({ priced: true, credits: 0 }),
      provider: async () => {
        providerCalls += 1;
        return {
          status: 'completed',
          asset_id: 303,
          provider_task_id: 'person-clean-task-1',
          quality: { width: 64, height: 64, mask_area_changed: true, non_mask_similarity: 0.99 },
        };
      },
    };
    const firstQuote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    const first = await prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'person-clean-first', quote_hash: firstQuote.quote_hash,
    }, deps);
    assert.deepEqual(first.needs_attention_shot_ids, [1]);
    assert.equal(providerCalls, 1);
    const interrupted = JSON.parse(state.db.prepare('SELECT preparation_snapshot_json FROM redraw_shots WHERE id = 1').get().preparation_snapshot_json);
    const unknownResult = interrupted.clean_results.find((item) => item.kind === 'person_clean');
    assert.equal(unknownResult.status, 'unknown');
    assert.ok(Number.isSafeInteger(unknownResult.redraw_asset_id));
    const pending = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(unknownResult.redraw_asset_id);
    assert.equal(pending.status, 'needs_attention');
    assert.equal(pending.approval_status, 'pending');
    assert.ok(JSON.parse(pending.source_ref_json).person_clean_plate_pack, pending.source_ref_json);
    const approved = reviewAsset(state.db, unknownResult.redraw_asset_id, {
      action: 'approved', reviewer_id: 'user-a', tenant_id: 'tenant-a', user_id: 'user-a',
      expected_updated_at: pending.updated_at, preparationContext: state.ctx,
    });
    assert.equal(approved.status, 'needs_attention');
    assert.equal(approved.approval_status, 'approved');
    const recoveredQuote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    assert.equal(recoveredQuote.action, 'advance');
    assert.equal(recoveredQuote.priced, true);
    assert.deepEqual(recoveredQuote.items, []);
    assert.deepEqual(recoveredQuote.needs_attention_shot_ids, []);
    const result = await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'person-clean-resume',
      quote_hash: recoveredQuote.quote_hash,
    }, deps);
    assert.deepEqual(result.prepared_shot_ids, [1]);
    assert.equal(providerCalls, 1);
    const shot = state.db.prepare('SELECT * FROM redraw_shots WHERE id = 1').get();
    const snapshot = JSON.parse(shot.preparation_snapshot_json);
    const cleanResult = snapshot.clean_results.find((item) => item.kind === 'person_clean');
    assert.equal(cleanResult.status, 'completed');
    assert.equal(cleanResult.evidence.redraw_asset_id, unknownResult.redraw_asset_id);
    assert.equal(cleanResult.evidence.clean_plate_asset_id, 303);
    assert.equal(cleanResult.evidence.clean_plate_sha256, state.personCleanSha);
    const gate = evaluatePreparationGate(state.ctx, 1);
    assert.equal(gate.ok, true, JSON.stringify(gate));

    fs.writeFileSync(path.join(state.ctx.storageRoot, 'redraw/person-clean.png'), 'tampered-person-clean');
    const drifted = evaluatePreparationGate(state.ctx, 1);
    assert.equal(drifted.ok, false);
    assert.ok(drifted.missing.some((item) => item.reason_code === 'person_cleanup_not_current'));
  } finally {
    state.cleanup();
  }
});

test('provider unknown 的人物净景即使人工批准也绝不恢复复用', async () => {
  const state = await setupDefaultServerPath({ includePerson: true, includeText: false });
  try {
    const firstQuote = await quoteVersionPreparation(state.ctx, { version_id: 1 });
    const coverage = await loadReviewedReferenceCoverage(state.ctx);
    const requirement = coverage.shots[0].requirements.find((item) => item.kind === 'person_clean');
    const outcome = await prepareReferenceCleanRequirement({
      ...state.ctx,
      provider: async () => ({ status: 'unknown', provider_task_id: 'unknown-task-1' }),
    }, { requirement, operation_key: 'unknown-person-clean-op' });
    assert.equal(outcome.status, 'unknown');
    assert.ok(Number.isSafeInteger(outcome.redraw_asset_id));
    const pending = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(outcome.redraw_asset_id);
    reviewAsset(state.db, outcome.redraw_asset_id, {
      action: 'approved', reviewer_id: 'user-a', tenant_id: 'tenant-a', user_id: 'user-a',
      expected_updated_at: pending.updated_at, preparationContext: state.ctx,
    });
    const interrupted = {
      schema_version: 'redraw-reference-preparation-v1', version_id: 1, shot_id: 1,
      preparation_version: 1, character_plan_hash: firstQuote.character_plan_hash,
      version_snapshot_hash: firstQuote.version_snapshot_hash,
      request_hash: sha256('unknown-attempt'), idempotency_key_hash: sha256('unknown-attempt'),
      status: 'unknown', requirements: [{ kind: 'person_clean', key: 'person-a' }],
      clean_results: [{ kind: 'person_clean', key: 'person-a', status: 'unknown', redraw_asset_id: outcome.redraw_asset_id }],
    };
    state.db.prepare(`UPDATE redraw_shots
      SET preparation_state = 'needs_attention', preparation_snapshot_json = ?,
          preparation_evidence_hash = ? WHERE id = 1`)
      .run(stableJson(interrupted), sha256(stableJson(interrupted)));
    const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 });
    assert.deepEqual(quote.needs_attention_shot_ids, [1]);
    assert.equal(quote.items.length, 0);
  } finally {
    state.cleanup();
  }
});

test('真实文字净景经人工批准后可恢复为当前完成结果', async () => {
  const state = await setupDefaultServerPath();
  try {
    let providerCalls = 0;
    const deps = {
      quoteCleanRequirement: () => ({ priced: true, credits: 0 }),
      provider: async () => {
        providerCalls += 1;
        return {
          status: 'completed', asset_id: 302, provider_task_id: 'text-clean-task-1',
          quality: { width: 64, height: 64, mask_area_changed: true, non_mask_similarity: 0.99 },
        };
      },
    };
    const firstQuote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    const first = await prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'text-clean-first', quote_hash: firstQuote.quote_hash,
    }, deps);
    assert.deepEqual(first.needs_attention_shot_ids, [1]);
    const snapshot = JSON.parse(state.db.prepare('SELECT preparation_snapshot_json FROM redraw_shots WHERE id = 1').get().preparation_snapshot_json);
    const unknownResult = snapshot.clean_results.find((item) => item.kind === 'text_clean');
    const pending = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(unknownResult.redraw_asset_id);
    assert.ok(JSON.parse(pending.source_ref_json).text_clean_plate_pack);
    reviewAsset(state.db, pending.id, {
      action: 'approved', reviewer_id: 'user-a', tenant_id: 'tenant-a', user_id: 'user-a',
      expected_updated_at: pending.updated_at, preparationContext: state.ctx,
    });
    const recovered = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    assert.deepEqual(recovered.needs_attention_shot_ids, []);
    assert.deepEqual(recovered.items, []);
    assert.equal(providerCalls, 1);
  } finally {
    state.cleanup();
  }
});

test('同镜头人物与文字净景可逐项批准恢复且只生成剩余项', async () => {
  const state = await setupDefaultServerPath({ includePerson: true, includeText: true });
  try {
    const calls = [];
    const deps = {
      quoteCleanRequirement: () => ({ priced: true, credits: 0 }),
      provider: async ({ input }) => {
        calls.push(input.mode);
        return {
          status: 'completed',
          asset_id: input.mode === 'clean_plate' ? 303 : 302,
          quality: { width: 64, height: 64, mask_area_changed: true, non_mask_similarity: 0.99 },
        };
      },
    };
    const runAndApprove = async (idempotencyKey) => {
      const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
      const result = await prepareVersionReferences(state.ctx, {
        version_id: 1, idempotency_key: idempotencyKey, quote_hash: quote.quote_hash,
      }, deps);
      assert.deepEqual(result.needs_attention_shot_ids, [1]);
      const snapshot = JSON.parse(state.db.prepare('SELECT preparation_snapshot_json FROM redraw_shots WHERE id = 1').get().preparation_snapshot_json);
      const unknown = snapshot.clean_results.find((item) => item.status === 'unknown');
      const pending = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(unknown.redraw_asset_id);
      reviewAsset(state.db, pending.id, {
        action: 'approved', reviewer_id: 'user-a', tenant_id: 'tenant-a', user_id: 'user-a',
        expected_updated_at: pending.updated_at, preparationContext: state.ctx,
      });
    };
    await runAndApprove('mixed-clean-first');
    await runAndApprove('mixed-clean-second');
    assert.deepEqual(calls, ['clean_plate', 'text_clean_plate']);
    const finalQuote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
    assert.deepEqual(finalQuote.needs_attention_shot_ids, []);
    assert.deepEqual(finalQuote.items, []);
  } finally {
    state.cleanup();
  }
});

test('版本漂移只由原 unknown 的最新批准解释且更早 completed 仍按当前证据复用', async () => {
  const state = await setupDefaultServerPath({ includePerson: true, includeText: true });
  try {
    let providerCalls = 0;
    const provider = async ({ input }) => {
      providerCalls += 1;
      return {
        status: 'completed',
        asset_id: input.mode === 'clean_plate' ? 303 : 302,
        provider_task_id: `sequential-${providerCalls}`,
        quality: { width: 64, height: 64, mask_area_changed: true, non_mask_similarity: 0.99 },
      };
    };
    const deps = { quoteCleanRequirement: () => ({ priced: true, credits: 0 }), provider };
    const prepareUntilUnknown = async (idempotencyKey) => {
      const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 }, deps);
      const result = await prepareVersionReferences(state.ctx, {
        version_id: 1, idempotency_key: idempotencyKey, quote_hash: quote.quote_hash,
      }, deps);
      assert.deepEqual(result.needs_attention_shot_ids, [1]);
      return JSON.parse(state.db.prepare('SELECT preparation_snapshot_json FROM redraw_shots WHERE id = 1').get().preparation_snapshot_json);
    };

    const firstSnapshot = await prepareUntilUnknown('sequential-first');
    const pendingPersonResult = firstSnapshot.clean_results.find((item) => item.status === 'unknown');
    assert.equal(pendingPersonResult.kind, 'person_clean');
    const pendingPerson = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(pendingPersonResult.redraw_asset_id);
    reviewAsset(state.db, pendingPerson.id, {
      action: 'approved', reviewer_id: 'user-a', tenant_id: 'tenant-a', user_id: 'user-a',
      expected_updated_at: pendingPerson.updated_at, preparationContext: state.ctx,
    });

    const interrupted = await prepareUntilUnknown('sequential-second');
    const completedPerson = interrupted.clean_results.find((item) => item.kind === 'person_clean');
    const pendingTextResult = interrupted.clean_results.find((item) => item.status === 'unknown');
    assert.equal(completedPerson.status, 'completed');
    assert.equal(pendingTextResult.kind, 'text_clean');
    const priorVersionTime = interrupted.version_updated_at;
    const priorVersionTimestamp = Date.parse(priorVersionTime);
    assert.ok(Number.isFinite(priorVersionTimestamp));
    const earlierApproval = new Date(priorVersionTimestamp - 1000).toISOString();
    const latestApproval = new Date(priorVersionTimestamp + 1000).toISOString();
    state.db.prepare('UPDATE redraw_assets SET approved_at = ? WHERE id = ?')
      .run(earlierApproval, completedPerson.redraw_asset_id);

    const motionAsset = state.db.prepare('SELECT metadata FROM assets WHERE id = 601').get();
    const motionMetadata = JSON.parse(motionAsset.metadata);
    motionMetadata.redraw_motion_reference.text_coverage_sha256 = sha256(stableJson([{
      kind: 'text_subtitle',
      region_key: pendingTextResult.key,
      text_clean_redraw_asset_id: pendingTextResult.redraw_asset_id,
      time_ranges: [[0, 12000]],
    }]));
    state.db.prepare('UPDATE assets SET metadata = ? WHERE id = 601').run(JSON.stringify(motionMetadata));
    const pendingText = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(pendingTextResult.redraw_asset_id);
    reviewAsset(state.db, pendingText.id, {
      action: 'approved', reviewer_id: 'user-a', tenant_id: 'tenant-a', user_id: 'user-a',
      expected_updated_at: pendingText.updated_at, preparationContext: state.ctx,
    });
    state.db.prepare('UPDATE redraw_assets SET approved_at = ? WHERE id = ?')
      .run(latestApproval, pendingTextResult.redraw_asset_id);
    state.db.prepare('UPDATE redraw_versions SET updated_at = ? WHERE id = 1').run(latestApproval);

    const persistInterrupted = (value) => state.db.prepare(`UPDATE redraw_shots
      SET preparation_state = 'needs_attention', preparation_snapshot_json = ?, preparation_evidence_hash = ?
      WHERE id = 1`).run(stableJson(value), sha256(stableJson(value)));
    const withoutNewApproval = {
      ...interrupted,
      clean_results: interrupted.clean_results.map((item) => ({ ...item, status: 'completed' })),
    };
    persistInterrupted(withoutNewApproval);
    assert.deepEqual(
      (await quoteVersionPreparation(state.ctx, { version_id: 1 })).needs_attention_shot_ids,
      [1],
    );
    persistInterrupted(interrupted);

    for (const invalidApprovalTime of [
      'not-a-time',
      new Date(priorVersionTimestamp - 500).toISOString(),
      new Date(priorVersionTimestamp + 500).toISOString(),
    ]) {
      state.db.prepare('UPDATE redraw_assets SET approved_at = ? WHERE id = ?')
        .run(invalidApprovalTime, pendingTextResult.redraw_asset_id);
      assert.deepEqual(
        (await quoteVersionPreparation(state.ctx, { version_id: 1 })).needs_attention_shot_ids,
        [1],
      );
    }
    state.db.prepare('UPDATE redraw_assets SET approved_at = ? WHERE id = ?')
      .run(latestApproval, pendingTextResult.redraw_asset_id);

    state.db.prepare('UPDATE redraw_projects SET policy_version = 2 WHERE id = 1').run();
    assert.deepEqual(
      (await quoteVersionPreparation(state.ctx, { version_id: 1 })).needs_attention_shot_ids,
      [1],
    );
    state.db.prepare('UPDATE redraw_projects SET policy_version = 1 WHERE id = 1').run();

    fs.writeFileSync(path.join(state.ctx.storageRoot, 'redraw/person-clean.png'), 'tampered-person-clean');
    const evidenceDriftQuote = await quoteVersionPreparation(state.ctx, { version_id: 1 });
    assert.deepEqual(
      evidenceDriftQuote.items.map((item) => [item.kind, item.key]),
      [[completedPerson.kind, completedPerson.key]],
    );
    fs.writeFileSync(path.join(state.ctx.storageRoot, 'redraw/person-clean.png'), 'person-clean');

    const recoveredQuote = await quoteVersionPreparation(state.ctx, { version_id: 1 });
    assert.ok(Date.parse(earlierApproval) < Date.parse(priorVersionTime));
    assert.equal(
      state.db.prepare('SELECT approved_at FROM redraw_assets WHERE id = ?').get(completedPerson.redraw_asset_id).approved_at,
      earlierApproval,
    );
    assert.equal(
      state.db.prepare('SELECT approved_at FROM redraw_assets WHERE id = ?').get(pendingTextResult.redraw_asset_id).approved_at,
      latestApproval,
    );
    assert.deepEqual(recoveredQuote.needs_attention_shot_ids, []);
    assert.deepEqual(recoveredQuote.items, []);
    const recovered = await prepareVersionReferences(state.ctx, {
      version_id: 1,
      idempotency_key: 'sequential-recovery',
      quote_hash: recoveredQuote.quote_hash,
    }, deps);
    assert.deepEqual(recovered.prepared_shot_ids, [1]);
    assert.equal(providerCalls, 2);
    assert.equal(state.db.prepare('SELECT preparation_state FROM redraw_shots WHERE id = 1').get().preparation_state, 'reference_ready');
  } finally {
    state.cleanup();
  }
});

test('受信参考包 builder 拒绝客户端路径、URL、哈希、供应商和价格字段', async () => {
  const state = await setupDefaultServerPath();
  try {
    for (const [field, value] of [
      ['path', 'redraw/client.png'],
      ['url', 'https://example.test/client.png'],
      ['hash', 'a'.repeat(64)],
      ['provider', 'client-provider'],
      ['price', 1],
    ]) {
      await rejectsCode(
        () => buildTrustedReferenceBundleInput(state.ctx, {
          shot_id: 1,
          clean_results: [],
          [field]: value,
        }),
        'REDRAW_REFERENCE_BUNDLE_INPUT_INVALID',
      );
    }
  } finally {
    state.cleanup();
  }
});

test('当前覆盖含人物时旧 ready 空 requirements 即使旧哈希自洽也必须 fail closed', async () => {
  const state = await setupDefaultServerPath({ includePerson: true, includeText: false });
  try {
    const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 });
    const input = await buildTrustedReferenceBundleInput(state.ctx, { shot_id: 1, clean_results: [] });
    const saved = await saveReferenceBundle(state.ctx, { ...input, expected_updated_at: NOW });
    const current = state.db.prepare('SELECT * FROM redraw_shots WHERE id = 1').get();
    const legacy = {
      schema_version: 'redraw-reference-preparation-v1', version_id: 1, shot_id: 1,
      preparation_version: 1, character_plan_hash: quote.character_plan_hash,
      reference_bundle_hash: saved.reference_bundle_hash, status: 'completed',
      requirements: [], clean_results: [],
    };
    const projected = { ...current, preparation_snapshot_json: stableJson(legacy) };
    state.db.prepare(`UPDATE redraw_shots SET preparation_state = 'reference_ready',
      preparation_snapshot_json = ?, preparation_evidence_hash = ? WHERE id = 1`)
      .run(stableJson(legacy), preparationEvidenceHash(projected));
    const gate = evaluatePreparationGate(state.ctx, 1);
    assert.equal(gate.ok, false);
    assert.ok(gate.missing.some((item) => item.reason_code === 'coverage_binding_not_current'));
  } finally {
    state.cleanup();
  }
});

test('当前覆盖无净景要求时合法新 coverage binding 仍可 reference_ready', async () => {
  const state = await setupDefaultServerPath({ includePerson: false, includeText: false });
  try {
    const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 });
    const result = await prepareVersionReferences(state.ctx, {
      version_id: 1, idempotency_key: 'empty-current-coverage', quote_hash: quote.quote_hash,
    });
    assert.deepEqual(result.prepared_shot_ids, [1]);
    const snapshot = JSON.parse(state.db.prepare('SELECT preparation_snapshot_json FROM redraw_shots WHERE id = 1').get().preparation_snapshot_json);
    assert.match(snapshot.coverage_analysis_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(snapshot.coverage_requirement_keys, []);
    assert.match(snapshot.coverage_requirement_hash, /^[a-f0-9]{64}$/);
    const gate = evaluatePreparationGate(state.ctx, 1);
    assert.equal(gate.ok, true, JSON.stringify(gate));
  } finally {
    state.cleanup();
  }
});

test('当前覆盖索引缺少 approved_by 或 approved_at 时准备门禁 fail closed', async () => {
  for (const column of ['approved_by', 'approved_at']) {
    const state = await setupDefaultServerPath({ includePerson: false, includeText: false });
    try {
      const quote = await quoteVersionPreparation(state.ctx, { version_id: 1 });
      await prepareVersionReferences(state.ctx, {
        version_id: 1, idempotency_key: `coverage-approval-${column}`, quote_hash: quote.quote_hash,
      });
      state.db.prepare(`UPDATE redraw_assets SET ${column} = NULL WHERE id = 204`).run();
      const gate = evaluatePreparationGate(state.ctx, 1);
      assert.equal(gate.ok, false);
      assert.ok(gate.missing.some((item) => item.reason_code === 'coverage_binding_not_current'));
    } finally {
      state.cleanup();
    }
  }
});
