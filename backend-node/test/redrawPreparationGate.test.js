const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { buildCharacterPlan } = require('../src/services/redrawCharacterPlanService');
const {
  evaluatePreparationGate,
  preparationEvidenceHash,
  shotCharacterPlanHash,
} = require('../src/services/redrawPreparationGateService');
const { canonicalCoverageSha256 } = require('../src/services/redrawFullFrameCoverageService');
const { canonicalBundleHash } = require('../src/services/redrawReferenceBundleService');

const NOW = '2026-08-22T00:00:00.000Z';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeFile(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function insertAsset(db, input) {
  db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'redraw', ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      `asset-${input.id}`,
      input.type,
      input.localPath,
      input.mimeType,
      JSON.stringify(input.metadata || { sha256: input.sha256, width: 640, height: 360 }),
      NOW,
      NOW,
    );
}

function textCleanPack(input) {
  const pack = {
    schema_version: 'text-clean-plate-reference-v1',
    region_key: input.regionKey,
    kind: input.kind,
    analysis_sha256: input.analysisSha256,
    frame_index: input.frameIndex,
    input_frame_fingerprint: input.sourceSha256,
    source: {
      asset_id: input.sourceAssetId,
      sha256: input.sourceSha256,
    },
    mask: {
      asset_id: input.maskAssetId,
      sha256: input.maskSha256,
    },
    artifact: {
      asset_id: input.assetId,
      sha256: input.sha256,
      width: 640,
      height: 360,
      mime_type: 'image/png',
    },
    source_fingerprint: input.sourceFingerprint,
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: NOW,
  };
  pack.pack_sha256 = sha256(stableJson(pack));
  return pack;
}

function identityPack(input) {
  const pack = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: input.sourceKey,
    target_actor_label: input.targetName,
    artifact: {
      asset_id: input.assetId,
      sha256: input.assetSha,
      width: 640,
      height: 960,
      mime_type: 'image/png',
    },
    wardrobe: {
      label: '整集主服装',
      reference_asset_id: input.wardrobeAssetId,
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

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-preparation-gate-'));
  const imageBytes = Buffer.from('identity-image');
  const wardrobeBytes = Buffer.from('wardrobe-image');
  const voiceBytes = Buffer.from('voice-audio');
  const motionBytes = Buffer.from('motion-reference-video');
  const textCleanBytes = Buffer.from('text-clean-image');
  const textCleanSourceBytes = Buffer.from('text-clean-source-image');
  const textCleanMaskBytes = Buffer.from('text-clean-mask-image');
  const sourceFingerprint = sha256('source');
  const sourceAssetId = 101;
  writeFile(storageRoot, 'redraw/identity.png', imageBytes);
  writeFile(storageRoot, 'redraw/wardrobe.png', wardrobeBytes);
  writeFile(storageRoot, 'redraw/voice.mp3', voiceBytes);
  writeFile(storageRoot, `redraw-conditioning/${sha256(motionBytes)}.mp4`, motionBytes);
  writeFile(storageRoot, 'redraw/text-clean.png', textCleanBytes);
  writeFile(storageRoot, 'redraw/text-clean-source.png', textCleanSourceBytes);
  writeFile(storageRoot, 'redraw/text-clean-mask.png', textCleanMaskBytes);
  insertAsset(db, {
    id: sourceAssetId,
    type: 'video',
    mimeType: 'video/mp4',
    localPath: 'source/source.mp4',
    sha256: sourceFingerprint,
  });
  insertAsset(db, {
    id: 301,
    type: 'image',
    mimeType: 'image/png',
    localPath: 'redraw/identity.png',
    sha256: sha256(imageBytes),
  });
  insertAsset(db, {
    id: 401,
    type: 'image',
    mimeType: 'image/png',
    localPath: 'redraw/wardrobe.png',
    sha256: sha256(wardrobeBytes),
  });
  insertAsset(db, {
    id: 501,
    type: 'audio',
    mimeType: 'audio/mpeg',
    localPath: 'redraw/voice.mp3',
    sha256: sha256(voiceBytes),
  });
  insertAsset(db, {
    id: 601,
    type: 'video',
    mimeType: 'video/mp4',
    localPath: `redraw-conditioning/${sha256(motionBytes)}.mp4`,
    sha256: sha256(motionBytes),
    metadata: {
      sha256: sha256(motionBytes),
      width: 640,
      height: 360,
      duration_ms: 5000,
      mime_type: 'video/mp4',
      video_codec: 'h264',
      audio_stream_count: 0,
      redraw_motion_reference: {
        schema_version: 'redraw-motion-reference-v1',
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        version_id: 1,
        shot_id: 1,
        source_asset_id: sourceAssetId,
        source_fingerprint: sourceFingerprint,
        clip_start_ms: 0,
        clip_end_ms: 5000,
        face_coverage_sha256: '0'.repeat(64),
        text_coverage_sha256: sha256(stableJson([])),
      },
    },
  });
  insertAsset(db, {
    id: 302,
    type: 'image',
    mimeType: 'image/png',
    localPath: 'redraw/text-clean.png',
    sha256: sha256(textCleanBytes),
  });
  insertAsset(db, {
    id: 303,
    type: 'image',
    mimeType: 'image/png',
    localPath: 'redraw/text-clean-source.png',
    sha256: sha256(textCleanSourceBytes),
  });
  insertAsset(db, {
    id: 304,
    type: 'image',
    mimeType: 'image/png',
    localPath: 'redraw/text-clean-mask.png',
    sha256: sha256(textCleanMaskBytes),
  });
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '准备门禁项目', ?, ?)`).run(NOW, NOW);
  const projectId = db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '准备门禁作品', ?, ?, 15000, 1, 2, 'asset_review', ?, ?)`)
    .run(projectId, sourceAssetId, sourceFingerprint, NOW, NOW);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  const facts = {
    characters: [{
      source_character_key: 'char-a',
      source_name: 'Alice',
    }],
  };
  const factsHash = sha256(stableJson(facts));
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json,
     facts_hash, reference_bundle_required, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', ?, ?, 1, 'asset_review', ?, ?)`)
    .run(workId, JSON.stringify(facts), factsHash, NOW, NOW).lastInsertRowid);
  const pack = identityPack({
    sourceKey: 'char-a',
    targetName: 'Alice Carter',
    assetId: 301,
    assetSha: sha256(imageBytes),
    wardrobeAssetId: 401,
    wardrobeSha: sha256(wardrobeBytes),
  });
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, voice_asset_id, version_number, approval_status, approved_by,
     approved_at, status, created_at, updated_at)
    VALUES (201, ?, 'tenant-a', 'user-a', 'character', ?, 'Alice Carter',
      301, 501, 1, 'approved', 'user-a', ?, 'generated', ?, ?)`)
    .run(versionId, JSON.stringify({
      source_ref: { source_character_key: 'char-a' },
      identity_pack: pack,
      snapshot: {
        voice_snapshot: {
          locale: 'en-US',
          market: 'US',
          audio_sha256: sha256(voiceBytes),
          audio_asset_id: 501,
          language_verified: true,
          detected_locale: 'en-US',
        },
      },
    }), NOW, NOW, NOW);
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     voice_asset_id, version_number, approval_status, approved_by,
     approved_at, status, created_at, updated_at)
    VALUES (203, ?, 'tenant-a', 'user-a', 'voice', ?, 'voice char-a',
      501, 1, 'approved', 'user-a', ?, 'generated', ?, ?)`)
    .run(versionId, JSON.stringify({
      source_ref: { source_character_key: 'char-a' },
    }), NOW, NOW, NOW);
  const shotId = Number(db.prepare(`INSERT INTO redraw_shots
    (work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, references_json, status, preparation_state,
     preparation_version, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'shot-001', 1, 1, 0, 5000, 5000,
      '[]', 'draft', 'reference_ready', 3, ?, ?)`)
    .run(workId, versionId, NOW, NOW).lastInsertRowid);
  const coverageManifest = {
    schema_version: 'redraw-full-frame-coverage-v1',
    status: 'reviewed',
    source: { sha256: sourceFingerprint, duration_ms: 15000 },
    models: {},
    shots: [{ shot_id: 'shot-001', start_ms: 0, end_ms: 5000 }],
    frames: [],
    person_tracks: [],
    text_tracks: [],
    review: {
      status: 'reviewed', reviewed: true, required_review_point_count: 0,
      reviewed_point_count: 0, reviewer: 'codex-local-review',
    },
    unresolved_person_count: 0,
    unresolved_text_region_count: 0,
    approval_status: 'pending',
    ready_for_reference: false,
    analysis_sha256: null,
  };
  coverageManifest.analysis_sha256 = canonicalCoverageSha256(coverageManifest);
  const coverageBytes = Buffer.from(`${JSON.stringify(coverageManifest)}\n`);
  const coveragePath = 'redraw-full-frame/version-1/redraw-full-frame-reviewed-manifest.json';
  writeFile(storageRoot, coveragePath, coverageBytes);
  insertAsset(db, {
    id: 701,
    type: 'document',
    mimeType: 'application/json',
    localPath: coveragePath,
    sha256: sha256(coverageBytes),
  });
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, version_number, approval_status, approved_by, approved_at,
     status, created_at, updated_at)
    VALUES (204, ?, 'tenant-a', 'user-a', 'scene', ?, 'reviewed coverage', 701, 1,
      'approved', 'user-a', ?, 'generated', ?, ?)`)
    .run(versionId, JSON.stringify({
      source_ref: { stable_id: 'full-frame-reviewed-coverage' },
      snapshot: {
        mode: 'full_frame_reviewed_coverage', version_id: versionId, facts_hash: factsHash,
        source_fingerprint: sourceFingerprint, analysis_sha256: coverageManifest.analysis_sha256,
      },
    }), NOW, NOW, NOW);
  const completeTextCleanPack = textCleanPack({
    regionKey: 'text-001',
    kind: 'text_subtitle',
    assetId: 302,
    sha256: sha256(textCleanBytes),
    sourceFingerprint,
    sourceAssetId: 303,
    sourceSha256: sha256(textCleanSourceBytes),
    maskAssetId: 304,
    maskSha256: sha256(textCleanMaskBytes),
    analysisSha256: coverageManifest.analysis_sha256,
    frameIndex: 0,
  });
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     clean_plate_asset_id, mask_asset_id, version_number, approval_status, approved_by,
     approved_at, status, created_at, updated_at)
    VALUES (202, ?, 'tenant-a', 'user-a', 'scene', ?, 'clean plate',
      302, 304, 1, 'approved', 'user-a', ?, 'generated', ?, ?)`)
    .run(versionId, JSON.stringify({
      source_ref: {
        stable_id: 'text-001',
        kind: 'text_subtitle',
        source_asset_id: 303,
        source_fingerprint: sha256(textCleanSourceBytes),
        analysis_sha256: coverageManifest.analysis_sha256,
        frame_index: 0,
      },
      snapshot: { mode: 'text_clean_plate' },
      text_clean_plate_pack: completeTextCleanPack,
    }), NOW, NOW, NOW);
  return {
    db,
    storageRoot,
    versionId,
    shotId,
    sourceAssetId,
    sourceFingerprint,
    identityPackHash: pack.pack_sha256,
    motionHash: sha256(motionBytes),
    textCleanPackHash: completeTextCleanPack.pack_sha256,
    coverageBinding: {
      analysis_sha256: coverageManifest.analysis_sha256,
      approved_by: 'user-a',
      approved_at: NOW,
      facts_hash: factsHash,
      source_fingerprint: sourceFingerprint,
      requirement_keys: [],
      requirement_hash: sha256(stableJson([])),
    },
    cleanup() {
      db.close();
      fs.rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

function context(state) {
  return {
    db: state.db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    storageRoot: state.storageRoot,
    canReadArtifact: () => true,
    assetReader: {
      canRead: () => true,
      owns: () => true,
    },
  };
}

function makeBundle(state, overrides = {}) {
  const defaultFaces = [{
    track_key: 'face-001',
    source_character_key: 'char-a',
    identity_redraw_asset_id: 201,
    identity_pack_sha256: state.identityPackHash,
    time_ranges: [[0, 5000]],
  }];
  const defaultTexts = [];
  const faceTracks = Object.prototype.hasOwnProperty.call(overrides, 'face_tracks') ? overrides.face_tracks : defaultFaces;
  const textRegions = Object.prototype.hasOwnProperty.call(overrides, 'text_regions') ? overrides.text_regions : defaultTexts;
  const faceCoverageSha256 = sha256(stableJson(faceTracks.map((entry) => ({
    identity_redraw_asset_id: Number(entry?.identity_redraw_asset_id),
    source_character_key: String(entry?.source_character_key || ''),
    time_ranges: entry?.time_ranges || [],
    track_key: String(entry?.track_key || ''),
  })).sort((a, b) => a.track_key.localeCompare(b.track_key))));
  const textCoverageSha256 = sha256(stableJson(textRegions.map((entry) => ({
    kind: String(entry?.kind || ''),
    region_key: String(entry?.region_key || ''),
    text_clean_redraw_asset_id: Number(entry?.text_clean_redraw_asset_id),
    time_ranges: entry?.time_ranges || [],
  })).sort((a, b) => a.region_key.localeCompare(b.region_key))));
  const metadataRow = state.db.prepare('SELECT metadata FROM assets WHERE id = 601').get();
  const metadata = JSON.parse(metadataRow.metadata);
  metadata.redraw_motion_reference.version_id = state.versionId;
  metadata.redraw_motion_reference.shot_id = state.shotId;
  metadata.redraw_motion_reference.face_coverage_sha256 = faceCoverageSha256;
  metadata.redraw_motion_reference.text_coverage_sha256 = textCoverageSha256;
  state.db.prepare('UPDATE assets SET metadata = ? WHERE id = 601').run(JSON.stringify(metadata));
  const bundle = {
    schema_version: 'redraw-reference-bundle-v2',
    version_id: state.versionId,
    shot_id: state.shotId,
    face_tracks: faceTracks,
    text_regions: textRegions,
    motion_reference: {
      asset_id: 601,
      sha256: state.motionHash,
      duration_ms: 5000,
      width: 640,
      height: 360,
      mime_type: 'video/mp4',
      codec: 'h264',
      audio_tracks: 0,
      face_coverage_sha256: faceCoverageSha256,
      text_coverage_sha256: textCoverageSha256,
      reviewed_at: NOW,
    },
    coverage_review: {
      status: 'approved',
      reviewed_by: 'user-a',
      reviewed_at: NOW,
      recognizable_face_count: 1,
      mapped_face_count: 1,
      unresolved_face_count: 0,
      recognizable_text_region_count: 0,
      mapped_text_region_count: 0,
      unresolved_text_region_count: 0,
    },
    dialogue: {
      kind: 'silent',
      speech_required: false,
      turns: [],
    },
    ...overrides,
  };
  const referenceHash = canonicalBundleHash(bundle);
  state.db.prepare(`UPDATE redraw_shots
    SET reference_bundle_json = ?, reference_bundle_hash = ?,
        reference_bundle_updated_at = ?
    WHERE id = ?`)
    .run(stableJson(bundle), referenceHash, NOW, state.shotId);
  const shot = state.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(state.shotId);
  const plan = evaluatePreparationGate(context(state), state.versionId);
  const currentPlan = buildCharacterPlan(context(state), state.versionId);
  const snapshot = {
    schema_version: 'redraw-reference-preparation-v2',
    version_id: state.versionId,
    shot_id: state.shotId,
    character_plan_hash: plan.character_plan_hash,
    shot_character_plan_hash: shotCharacterPlanHash(shot, bundle, currentPlan),
    reference_bundle_hash: referenceHash,
    status: 'completed',
    requirements: [],
    clean_results: [],
    coverage_analysis_sha256: state.coverageBinding.analysis_sha256,
    coverage_approved_by: state.coverageBinding.approved_by,
    coverage_approved_at: state.coverageBinding.approved_at,
    coverage_facts_hash: state.coverageBinding.facts_hash,
    coverage_source_fingerprint: state.coverageBinding.source_fingerprint,
    coverage_requirement_keys: state.coverageBinding.requirement_keys,
    coverage_requirement_hash: state.coverageBinding.requirement_hash,
  };
  state.db.prepare(`UPDATE redraw_shots
    SET preparation_snapshot_json = ?, preparation_evidence_hash = ?
    WHERE id = ?`)
    .run(
      stableJson(snapshot),
      preparationEvidenceHash({ ...shot, preparation_snapshot_json: stableJson(snapshot) }),
      state.shotId,
    );
}

function replaceCharacterIdentity(state, suffix) {
  const row = state.db.prepare('SELECT * FROM redraw_assets WHERE id = 201').get();
  const payload = JSON.parse(row.source_ref_json);
  const pack = identityPack({
    sourceKey: 'char-a',
    targetName: `Alice Carter ${suffix}`,
    assetId: 301,
    assetSha: payload.identity_pack.artifact.sha256,
    wardrobeAssetId: 401,
    wardrobeSha: payload.identity_pack.wardrobe.reference_sha256,
  });
  payload.identity_pack = pack;
  state.db.prepare('UPDATE redraw_assets SET localized_name = ?, source_ref_json = ?, updated_at = ? WHERE id = 201')
    .run(pack.target_actor_label, JSON.stringify(payload), `2026-08-22T00:00:0${suffix}.000Z`);
  return pack;
}

function makeTextBundle(state) {
  makeBundle(state, {
    text_regions: [{
      region_key: 'text-001',
      kind: 'text_subtitle',
      time_ranges: [[0, 5000]],
      text_clean_redraw_asset_id: 202,
      clean_plate: { pack_sha256: state.textCleanPackHash },
    }],
    coverage_review: {
      status: 'approved',
      reviewed_by: 'user-a',
      reviewed_at: NOW,
      recognizable_face_count: 1,
      mapped_face_count: 1,
      unresolved_face_count: 0,
      recognizable_text_region_count: 1,
      mapped_text_region_count: 1,
      unresolved_text_region_count: 0,
    },
  });
}

test('准备门禁返回严格白名单、稳定排序和当前角色计划哈希', () => {
  const state = setup();
  try {
    makeBundle(state);

    const gate = evaluatePreparationGate(context(state), state.versionId);

    assert.equal(gate.ok, true);
    assert.equal(gate.version_id, state.versionId);
    assert.match(gate.character_plan_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(gate.ready_shot_ids, [state.shotId]);
    assert.deepEqual(gate.missing, []);
    assert.deepEqual(Object.keys(gate).sort(), [
      'character_plan_hash',
      'missing',
      'ok',
      'ready_shot_ids',
      'version_id',
    ]);
    assert.equal(JSON.stringify(gate).includes(state.storageRoot), false);
    assert.equal(JSON.stringify(gate).includes('Alice Carter'), false);
  } finally {
    state.cleanup();
  }
});

test('准备门禁按逐镜角色依赖复核计划，未引用角色变化不失效且引用或依赖键漂移 fail closed', async (t) => {
  await t.test('无角色依赖镜头不被未引用角色的全局计划变化误伤', () => {
    const state = setup();
    try {
      makeBundle(state, {
        face_tracks: [],
        coverage_review: {
          status: 'approved', reviewed_by: 'user-a', reviewed_at: NOW,
          recognizable_face_count: 0, mapped_face_count: 0, unresolved_face_count: 0,
          recognizable_text_region_count: 0, mapped_text_region_count: 0, unresolved_text_region_count: 0,
        },
      });
      const before = evaluatePreparationGate(context(state), state.versionId);
      assert.equal(before.ok, true, JSON.stringify(before));
      replaceCharacterIdentity(state, 2);

      const after = evaluatePreparationGate(context(state), state.versionId);
      assert.notEqual(after.character_plan_hash, before.character_plan_hash);
      assert.equal(after.ok, true, JSON.stringify(after));
      assert.deepEqual(after.ready_shot_ids, [state.shotId]);
    } finally {
      state.cleanup();
    }
  });

  await t.test('引用角色变化但 snapshot 与 bundle 未重建时拒绝', () => {
    const state = setup();
    try {
      makeBundle(state);
      replaceCharacterIdentity(state, 3);
      const gate = evaluatePreparationGate(context(state), state.versionId);
      assert.equal(gate.ok, false);
      assert.deepEqual(gate.ready_shot_ids, []);
      assert.ok(gate.missing.some((item) => item.reason_code === 'preparation_evidence_mismatch'));
    } finally {
      state.cleanup();
    }
  });

  await t.test('服务端 dialogue 依赖键漂移到计划外角色时拒绝', () => {
    const state = setup();
    try {
      makeBundle(state);
      state.db.prepare('UPDATE redraw_shots SET source_dialogue_json = ? WHERE id = ?')
        .run(JSON.stringify([{ speaker_id: 'char-missing', text: 'hi' }]), state.shotId);
      const gate = evaluatePreparationGate(context(state), state.versionId);
      assert.equal(gate.ok, false);
      assert.deepEqual(gate.ready_shot_ids, []);
      assert.ok(gate.missing.some((item) => item.reason_code === 'preparation_evidence_mismatch'));
    } finally {
      state.cleanup();
    }
  });

  await t.test('references_json 的 voice 依赖绑定完整角色规范', () => {
    const state = setup();
    try {
      state.db.prepare('UPDATE redraw_shots SET references_json = ? WHERE id = ?')
        .run(JSON.stringify([{ kind: 'voice', speaker_id: 'char-a' }]), state.shotId);
      makeBundle(state, {
        face_tracks: [],
        coverage_review: {
          status: 'approved', reviewed_by: 'user-a', reviewed_at: NOW,
          recognizable_face_count: 0, mapped_face_count: 0, unresolved_face_count: 0,
          recognizable_text_region_count: 0, mapped_text_region_count: 0, unresolved_text_region_count: 0,
        },
      });
      replaceCharacterIdentity(state, 4);
      const gate = evaluatePreparationGate(context(state), state.versionId);
      assert.equal(gate.ok, false);
      assert.deepEqual(gate.ready_shot_ids, []);
      assert.ok(gate.missing.some((item) => item.reason_code === 'preparation_evidence_mismatch'));
    } finally {
      state.cleanup();
    }
  });
});

test('准备门禁接受已批准且证据完整的 needs_attention 文字净景', () => {
  const state = setup();
  try {
    makeTextBundle(state);
    state.db.prepare(`UPDATE redraw_assets
      SET status = 'needs_attention', error_code = NULL, error_message = NULL
      WHERE id = 202`).run();

    const gate = evaluatePreparationGate(context(state), state.versionId);

    assert.equal(gate.ok, true);
    assert.deepEqual(gate.ready_shot_ids, [state.shotId]);
    assert.deepEqual(gate.missing, []);
  } finally {
    state.cleanup();
  }
});

test('准备门禁拒绝未完成或证据漂移的 needs_attention 文字净景', async (t) => {
  const cases = [
    {
      label: '错误码未清空',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = 'TEXT_CLEAN_FAILED', error_message = NULL
          WHERE id = 202`).run();
      },
    },
    {
      label: '错误信息未清空',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = 'provider failed'
          WHERE id = 202`).run();
      },
    },
    {
      label: '仍待批准',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', approval_status = 'pending', error_code = NULL, error_message = NULL
          WHERE id = 202`).run();
      },
    },
    {
      label: '已拒绝',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', approval_status = 'rejected', error_code = NULL, error_message = NULL
          WHERE id = 202`).run();
      },
    },
    {
      label: '生成失败',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'failed', approval_status = 'approved', error_code = NULL, error_message = NULL
          WHERE id = 202`).run();
      },
    },
    {
      label: '缺少净景资产',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL,
              clean_plate_asset_id = NULL
          WHERE id = 202`).run();
      },
    },
    {
      label: '净景包哈希漂移',
      mutate(state) {
        const row = state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 202').get();
        const payload = JSON.parse(row.source_ref_json);
        payload.text_clean_plate_pack.pack_sha256 = '0'.repeat(64);
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL,
              source_ref_json = ?
          WHERE id = 202`).run(JSON.stringify(payload));
      },
    },
    {
      label: '净景物理文件漂移',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL
          WHERE id = 202`).run();
        fs.writeFileSync(path.join(state.storageRoot, 'redraw/text-clean.png'), 'tampered text clean');
      },
    },
    {
      label: '源帧文件缺失',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL
          WHERE id = 202`).run();
        fs.rmSync(path.join(state.storageRoot, 'redraw/text-clean-source.png'));
      },
    },
    {
      label: '源帧文件哈希漂移',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL
          WHERE id = 202`).run();
        fs.writeFileSync(path.join(state.storageRoot, 'redraw/text-clean-source.png'), 'tampered source');
      },
    },
    {
      label: '遮罩文件缺失',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL
          WHERE id = 202`).run();
        fs.rmSync(path.join(state.storageRoot, 'redraw/text-clean-mask.png'));
      },
    },
    {
      label: '遮罩文件哈希漂移',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL
          WHERE id = 202`).run();
        fs.writeFileSync(path.join(state.storageRoot, 'redraw/text-clean-mask.png'), 'tampered mask');
      },
    },
    {
      label: '遮罩资产缺失',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL,
              mask_asset_id = NULL
          WHERE id = 202`).run();
      },
    },
    {
      label: '遮罩资产与净景包不一致',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL,
              mask_asset_id = 303
          WHERE id = 202`).run();
      },
    },
    {
      label: '分析绑定漂移',
      mutate(state) {
        const row = state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 202').get();
        const payload = JSON.parse(row.source_ref_json);
        payload.source_ref.analysis_sha256 = 'f'.repeat(64);
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL,
              source_ref_json = ?
          WHERE id = 202`).run(JSON.stringify(payload));
      },
    },
    {
      label: '帧绑定漂移',
      mutate(state) {
        const row = state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 202').get();
        const payload = JSON.parse(row.source_ref_json);
        payload.source_ref.frame_index = 1;
        state.db.prepare(`UPDATE redraw_assets
          SET status = 'needs_attention', error_code = NULL, error_message = NULL,
              source_ref_json = ?
          WHERE id = 202`).run(JSON.stringify(payload));
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, () => {
      const state = setup();
      try {
        makeTextBundle(state);
        entry.mutate(state);

        const gate = evaluatePreparationGate(context(state), state.versionId);

        assert.equal(gate.ok, false);
        assert.equal(
          gate.missing.some((item) => item.reason_code === 'text_cleanup_missing'),
          true,
        );
      } finally {
        state.cleanup();
      }
    });
  }
});

test('准备门禁同步复核身份、净景和运动物理文件 SHA', () => {
  const textBundle = (state) => makeBundle(state, {
    text_regions: [{
      region_key: 'text-001',
      kind: 'text_subtitle',
      time_ranges: [[0, 5000]],
      text_clean_redraw_asset_id: 202,
      clean_plate: { pack_sha256: state.textCleanPackHash },
    }],
    coverage_review: {
      status: 'approved',
      reviewed_by: 'user-a',
      reviewed_at: NOW,
      recognizable_face_count: 1,
      mapped_face_count: 1,
      unresolved_face_count: 0,
      recognizable_text_region_count: 1,
      mapped_text_region_count: 1,
      unresolved_text_region_count: 0,
    },
  });
  const cases = [
    {
      reason: 'character_reference_invalid',
      mutate(state) {
        makeBundle(state);
        fs.rmSync(path.join(state.storageRoot, 'redraw/identity.png'));
      },
    },
    {
      reason: 'text_cleanup_missing',
      mutate(state) {
        textBundle(state);
        fs.writeFileSync(path.join(state.storageRoot, 'redraw/text-clean.png'), 'tampered clean plate');
      },
    },
    {
      reason: 'motion_reference_not_current',
      mutate(state) {
        makeBundle(state);
        fs.writeFileSync(path.join(state.storageRoot, `redraw-conditioning/${state.motionHash}.mp4`), 'tampered motion');
      },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      entry.mutate(state);
      const gate = evaluatePreparationGate(context(state), state.versionId);
      assert.equal(gate.ok, false, entry.reason);
      assert.equal(gate.missing.some((item) => item.reason_code === entry.reason), true, entry.reason);
      const serialized = JSON.stringify(gate);
      assert.equal(serialized.includes(state.storageRoot), false);
      assert.equal(serialized.includes('tampered'), false);
    } finally {
      state.cleanup();
    }
  }
});

test('准备门禁物理复核绑定当前路径文件身份并拒绝关闭失败', () => {
  const cases = [
    {
      reason: 'character_reference_invalid',
      expectedStatCalls: true,
      makeFs() {
        let statCalls = 0;
        const fakeFdStat = {
          dev: 1,
          ino: 10,
          size: 14,
          mtimeMs: 100,
          ctimeMs: 100,
          isFile: () => true,
        };
        return {
          statCalls: () => statCalls,
          fs: {
            realpathSync: fs.realpathSync.bind(fs),
            openSync: fs.openSync.bind(fs),
            readSync: fs.readSync.bind(fs),
            closeSync: fs.closeSync.bind(fs),
            fstatSync: () => fakeFdStat,
            statSync: () => {
              statCalls += 1;
              return statCalls === 1 ? fakeFdStat : { ...fakeFdStat, ino: 99 };
            },
          },
        };
      },
    },
    {
      reason: 'character_reference_invalid',
      makeFs() {
        return {
          statCalls: () => 0,
          fs: {
            realpathSync: fs.realpathSync.bind(fs),
            openSync: fs.openSync.bind(fs),
            readSync: fs.readSync.bind(fs),
            fstatSync: fs.fstatSync.bind(fs),
            statSync: fs.statSync.bind(fs),
            closeSync: () => {
              throw new Error('private close failure path C:\\secret\\asset.png');
            },
          },
        };
      },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      makeBundle(state);
      const injected = entry.makeFs();
      const gate = evaluatePreparationGate({
        ...context(state),
        fs: injected.fs,
      }, state.versionId);
      assert.equal(gate.ok, false, entry.reason);
      assert.equal(gate.missing.some((item) => item.reason_code === entry.reason), true, entry.reason);
      if (entry.expectedStatCalls) assert.equal(injected.statCalls() > 0, true);
      const serialized = JSON.stringify(gate);
      assert.equal(serialized.includes('private close failure'), false);
      assert.equal(serialized.includes('C:\\secret'), false);
      assert.equal(serialized.includes(state.storageRoot), false);
    } finally {
      state.cleanup();
    }
  }
});

test('准备门禁 fail closed：角色计划未锁、stale、缺人脸、缺文字净化、hash 漂移和旧候选均阻断', () => {
  const cases = [
    {
      reason: 'character_plan_not_ready',
      mutate(state) {
        state.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE kind = 'voice'").run();
      },
    },
    {
      reason: 'shot_stale',
      mutate(state) {
        makeBundle(state);
        state.db.prepare("UPDATE redraw_shots SET preparation_state = 'stale' WHERE id = ?").run(state.shotId);
      },
    },
    {
      reason: 'face_coverage_missing',
      mutate(state) {
        makeBundle(state, {
          face_tracks: [],
          coverage_review: {
            status: 'approved',
            reviewed_by: 'user-a',
            reviewed_at: NOW,
            recognizable_face_count: 1,
            mapped_face_count: 0,
            unresolved_face_count: 1,
            recognizable_text_region_count: 0,
            mapped_text_region_count: 0,
            unresolved_text_region_count: 0,
          },
        });
      },
    },
    {
      reason: 'text_cleanup_missing',
      mutate(state) {
        makeBundle(state, {
          text_regions: [],
          coverage_review: {
            status: 'approved',
            reviewed_by: 'user-a',
            reviewed_at: NOW,
            recognizable_face_count: 1,
            mapped_face_count: 1,
            unresolved_face_count: 0,
            recognizable_text_region_count: 1,
            mapped_text_region_count: 0,
            unresolved_text_region_count: 1,
          },
        });
      },
    },
    {
      reason: 'reference_hash_drift',
      mutate(state) {
        makeBundle(state);
        state.db.prepare("UPDATE redraw_shots SET reference_bundle_json = '{\"schema_version\":\"redraw-reference-bundle-v2\"}' WHERE id = ?")
          .run(state.shotId);
      },
    },
    {
      reason: 'preparation_required',
      mutate(state) {
        state.db.prepare("UPDATE redraw_shots SET video_generation_id = 99, preparation_state = 'parsed' WHERE id = ?").run(state.shotId);
      },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      entry.mutate(state);
      const gate = evaluatePreparationGate(context(state), state.versionId);
      assert.equal(gate.ok, false, entry.reason);
      assert.equal(gate.missing.some((item) => item.reason_code === entry.reason), true, entry.reason);
    } finally {
      state.cleanup();
    }
  }
});

test('准备门禁稳定报告 bundle 版本镜头错配、owner 错配、空镜头和 malformed JSON', () => {
  const cases = [
    {
      reason: 'bundle_version_mismatch',
      mutate(state) { makeBundle(state, { version_id: state.versionId + 1 }); },
    },
    {
      reason: 'bundle_shot_mismatch',
      mutate(state) { makeBundle(state, { shot_id: state.shotId + 1 }); },
    },
    {
      reason: 'owner_mismatch',
      mutate(state) {
        makeBundle(state);
        state.db.prepare("UPDATE redraw_shots SET user_id = 'user-b' WHERE id = ?").run(state.shotId);
      },
    },
    {
      reason: 'shots_missing',
      mutate(state) { state.db.prepare('DELETE FROM redraw_shots WHERE id = ?').run(state.shotId); },
    },
    {
      reason: 'reference_bundle_malformed',
      mutate(state) {
        state.db.prepare(`UPDATE redraw_shots
          SET reference_bundle_json = '{bad-json', reference_bundle_hash = ?, preparation_state = 'reference_ready'
          WHERE id = ?`).run('c'.repeat(64), state.shotId);
      },
    },
    {
      reason: 'reference_bundle_malformed',
      mutate(state) {
        makeBundle(state, { schema_version: 'redraw-reference-bundle-v1' });
      },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      entry.mutate(state);
      const gate = evaluatePreparationGate(context(state), state.versionId);
      assert.equal(gate.ok, false, entry.reason);
      assert.equal(gate.missing.some((item) => item.reason_code === entry.reason), true, entry.reason);
    } finally {
      state.cleanup();
    }
  }
});

test('准备门禁拒绝伪造的人物、文字和运动证据', () => {
  const cases = [
    {
      reason: 'motion_reference_not_current',
      mutate(state) {
        makeBundle(state);
        delete context(state).assetReader;
      },
      run(state) {
        return evaluatePreparationGate({
          db: state.db,
          tenantId: 'tenant-a',
          userId: 'user-a',
          storageRoot: state.storageRoot,
        }, state.versionId);
      },
    },
    {
      reason: 'face_coverage_missing',
      mutate(state) {
        makeBundle(state, {
          face_tracks: [null],
        });
      },
    },
    {
      reason: 'character_reference_invalid',
      mutate(state) {
        makeBundle(state, {
          face_tracks: [
            {
              track_key: 'face-001',
              source_character_key: 'char-a',
              identity_redraw_asset_id: 201,
              identity_pack_sha256: state.identityPackHash,
              time_ranges: [[0, 2500]],
            },
            {
              track_key: 'face-001',
              source_character_key: 'char-a',
              identity_redraw_asset_id: 201,
              identity_pack_sha256: state.identityPackHash,
              time_ranges: [[2500, 5000]],
            },
          ],
          coverage_review: {
            status: 'approved',
            reviewed_by: 'user-a',
            reviewed_at: NOW,
            recognizable_face_count: 2,
            mapped_face_count: 2,
            unresolved_face_count: 0,
            recognizable_text_region_count: 0,
            mapped_text_region_count: 0,
            unresolved_text_region_count: 0,
          },
        });
      },
    },
    {
      reason: 'character_reference_invalid',
      mutate(state) {
        makeBundle(state, {
          face_tracks: [{
            track_key: 'face-001',
            source_character_key: 'char-a',
            identity_redraw_asset_id: 999,
            identity_pack_sha256: state.identityPackHash,
            time_ranges: [[0, 5000]],
          }],
        });
      },
    },
    {
      reason: 'character_reference_invalid',
      mutate(state) {
        makeBundle(state);
        state.db.prepare("UPDATE redraw_assets SET user_id = 'user-b' WHERE id = 201").run();
      },
    },
    {
      reason: 'character_reference_invalid',
      mutate(state) {
        makeBundle(state, {
          face_tracks: [{
            track_key: 'face-001',
            source_character_key: 'char-a',
            identity_redraw_asset_id: 201,
            identity_pack_sha256: '0'.repeat(64),
            time_ranges: [[0, 5000]],
          }],
        });
      },
    },
    {
      reason: 'text_cleanup_missing',
      mutate(state) {
        makeBundle(state, {
          text_regions: [null],
          coverage_review: {
            status: 'approved',
            reviewed_by: 'user-a',
            reviewed_at: NOW,
            recognizable_face_count: 1,
            mapped_face_count: 1,
            unresolved_face_count: 0,
            recognizable_text_region_count: 1,
            mapped_text_region_count: 1,
            unresolved_text_region_count: 0,
          },
        });
      },
    },
    {
      reason: 'text_cleanup_missing',
      mutate(state) {
        makeBundle(state, {
          text_regions: [
            {
              region_key: 'text-001',
              kind: 'text_subtitle',
              time_ranges: [[0, 2500]],
              text_clean_redraw_asset_id: 202,
              clean_plate: { pack_sha256: state.textCleanPackHash },
            },
            {
              region_key: 'text-001',
              kind: 'text_subtitle',
              time_ranges: [[2500, 5000]],
              text_clean_redraw_asset_id: 202,
              clean_plate: { pack_sha256: state.textCleanPackHash },
            },
          ],
          coverage_review: {
            status: 'approved',
            reviewed_by: 'user-a',
            reviewed_at: NOW,
            recognizable_face_count: 1,
            mapped_face_count: 1,
            unresolved_face_count: 0,
            recognizable_text_region_count: 2,
            mapped_text_region_count: 2,
            unresolved_text_region_count: 0,
          },
        });
      },
    },
    {
      reason: 'text_cleanup_missing',
      mutate(state) {
        makeBundle(state, {
          text_regions: [{
            region_key: 'text-001',
            kind: 'text_subtitle',
            time_ranges: [[0, 5000]],
            text_clean_redraw_asset_id: 999,
            clean_plate: { pack_sha256: state.textCleanPackHash },
          }],
          coverage_review: {
            status: 'approved',
            reviewed_by: 'user-a',
            reviewed_at: NOW,
            recognizable_face_count: 1,
            mapped_face_count: 1,
            unresolved_face_count: 0,
            recognizable_text_region_count: 1,
            mapped_text_region_count: 1,
            unresolved_text_region_count: 0,
          },
        });
      },
    },
    {
      reason: 'motion_reference_not_current',
      mutate(state) {
        makeBundle(state, {
          motion_reference: {
            asset_id: 999,
            sha256: state.motionHash,
            duration_ms: 5000,
            reviewed_at: NOW,
          },
        });
      },
    },
    {
      reason: 'motion_reference_not_current',
      mutate(state) {
        makeBundle(state, {
          motion_reference: {
            asset_id: 601,
            sha256: 'f'.repeat(64),
            duration_ms: 5000,
            reviewed_at: NOW,
          },
        });
      },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      entry.mutate(state);
      const gate = entry.run ? entry.run(state) : evaluatePreparationGate(context(state), state.versionId);
      assert.equal(gate.ok, false, entry.reason);
      assert.equal(gate.missing.some((item) => item.reason_code === entry.reason), true, entry.reason);
      const serialized = JSON.stringify(gate);
      assert.equal(serialized.includes('Alice Carter'), false);
      assert.equal(serialized.includes(state.storageRoot), false);
    } finally {
      state.cleanup();
    }
  }
});
