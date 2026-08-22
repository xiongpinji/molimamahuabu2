const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { evaluatePreparationGate } = require('../src/services/redrawPreparationGateService');
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
      JSON.stringify({ sha256: input.sha256, width: 640, height: 360 }),
      NOW,
      NOW,
    );
}

function textCleanPack(input) {
  const pack = {
    schema_version: 'text-clean-plate-reference-v1',
    region_key: input.regionKey,
    kind: input.kind,
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
  writeFile(storageRoot, 'redraw/identity.png', imageBytes);
  writeFile(storageRoot, 'redraw/wardrobe.png', wardrobeBytes);
  writeFile(storageRoot, 'redraw/voice.mp3', voiceBytes);
  writeFile(storageRoot, 'redraw/motion.mp4', motionBytes);
  writeFile(storageRoot, 'redraw/text-clean.png', textCleanBytes);
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
    localPath: 'redraw/motion.mp4',
    sha256: sha256(motionBytes),
  });
  insertAsset(db, {
    id: 302,
    type: 'image',
    mimeType: 'image/png',
    localPath: 'redraw/text-clean.png',
    sha256: sha256(textCleanBytes),
  });
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '准备门禁项目', ?, ?)`).run(NOW, NOW);
  const projectId = db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '准备门禁作品', 1, ?, 15000, 1, 2, 'asset_review', ?, ?)`)
    .run(projectId, sha256('source'), NOW, NOW);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  const facts = {
    characters: [{
      source_character_key: 'char-a',
      target_name: 'Alice Carter',
      adult_status: 'verified_18_plus',
      persona_origin: 'fictional_ai_generated',
    }],
  };
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json,
     reference_bundle_required, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', ?, 1, 'asset_review', ?, ?)`)
    .run(workId, JSON.stringify(facts), NOW, NOW).lastInsertRowid);
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
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     clean_plate_asset_id, version_number, approval_status, approved_by,
     approved_at, status, created_at, updated_at)
    VALUES (202, ?, 'tenant-a', 'user-a', 'scene', ?, 'clean plate',
      302, 1, 'approved', 'user-a', ?, 'generated', ?, ?)`)
    .run(versionId, JSON.stringify({
      source_ref: { stable_id: 'text-001', kind: 'text_subtitle' },
      snapshot: { mode: 'text_clean_plate' },
      text_clean_plate_pack: textCleanPack({
        regionKey: 'text-001',
        kind: 'text_subtitle',
        assetId: 302,
        sha256: sha256(textCleanBytes),
        sourceFingerprint: sha256('source'),
      }),
    }), NOW, NOW, NOW);
  const shotId = Number(db.prepare(`INSERT INTO redraw_shots
    (work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, references_json, status, preparation_state,
     preparation_version, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'shot-001', 1, 1, 0, 5000, 5000,
      '[]', 'draft', 'reference_ready', 3, ?, ?)`)
    .run(workId, versionId, NOW, NOW).lastInsertRowid);
  return {
    db,
    storageRoot,
    versionId,
    shotId,
    identityPackHash: pack.pack_sha256,
    motionHash: sha256(motionBytes),
    textCleanPackHash: textCleanPack({
      regionKey: 'text-001',
      kind: 'text_subtitle',
      assetId: 302,
      sha256: sha256(textCleanBytes),
      sourceFingerprint: sha256('source'),
    }).pack_sha256,
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
    assetReader: { owns: () => true },
  };
}

function preparationEvidenceHash(shot) {
  return sha256(stableJson({
    version_id: Number(shot.version_id),
    shot_id: Number(shot.id),
    preparation_version: Number(shot.preparation_version),
    reference_bundle_hash: shot.reference_bundle_hash,
  }));
}

function makeBundle(state, overrides = {}) {
  const bundle = {
    schema_version: 'redraw-reference-bundle-v1',
    version_id: state.versionId,
    shot_id: state.shotId,
    face_tracks: [{
      track_key: 'face-001',
      source_character_key: 'char-a',
      identity_redraw_asset_id: 201,
      identity_pack_sha256: state.identityPackHash,
      time_ranges: [[0, 5000]],
    }],
    text_regions: [],
    motion_reference: {
      asset_id: 601,
      sha256: state.motionHash,
      duration_ms: 5000,
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
  state.db.prepare(`UPDATE redraw_shots
    SET preparation_snapshot_json = ?, preparation_evidence_hash = ?
    WHERE id = ?`)
    .run(
      stableJson({
        version_id: state.versionId,
        shot_id: state.shotId,
        character_plan_hash: plan.character_plan_hash,
        reference_bundle_hash: referenceHash,
      }),
      preparationEvidenceHash(shot),
      state.shotId,
    );
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
        state.db.prepare("UPDATE redraw_shots SET reference_bundle_json = '{\"schema_version\":\"redraw-reference-bundle-v1\"}' WHERE id = ?")
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
      const gate = evaluatePreparationGate(context(state), state.versionId);
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
