const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  canonicalBundleHash,
  loadCurrentReferenceBundle,
  projectReferenceBundleForGeneration,
  saveReferenceBundle,
} = require('../src/services/redrawReferenceBundleService');

const INITIAL_UPDATED_AT = '2026-08-14T00:00:00.000Z';
const REVIEWED_AT = '2026-08-14T00:05:00.000Z';
const SOURCE_BYTES = Buffer.from('reference-bundle-source-video');
const SOURCE_FINGERPRINT = sha256(SOURCE_BYTES);
const MOTION_BYTES = Buffer.from('reference-bundle-motion-reference');
const MOTION_SHA256 = sha256(MOTION_BYTES);
const FACE_COVERAGE_SHA256 = sha256(stableJson([
  { identity_redraw_asset_id: 201, source_character_key: 'character-001', time_ranges: [[0, 5000]], track_key: 'face-001' },
  { identity_redraw_asset_id: 202, source_character_key: 'character-002', time_ranges: [[2500, 5000]], track_key: 'face-002' },
]));
const TEXT_COVERAGE_SHA256 = sha256(stableJson([
  { kind: 'text_subtitle', region_key: 'text-001', text_clean_redraw_asset_id: 203, time_ranges: [[0, 2500]] },
  { kind: 'text_screen', region_key: 'text-002', text_clean_redraw_asset_id: 204, time_ranges: [[2500, 5000]] },
]));
const PNG_BYTES = Buffer.from('reference-bundle-image');
const LOCALIZATION_BINDING_CONTRACT = 'redraw-localization-binding-v1';

function setup(overrides = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-reference-bundle-'));
  currentStorageRoot = storageRoot;
  fs.mkdirSync(path.join(storageRoot, 'source'), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, 'redraw'), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, 'redraw-conditioning'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'source', 'source.mp4'), SOURCE_BYTES);
  fs.writeFileSync(path.join(storageRoot, 'redraw-conditioning', `${MOTION_SHA256}.mp4`), MOTION_BYTES);
  const now = INITIAL_UPDATED_AT;
  const nameMap = overrides.nameMap || { ' character-002 ': ' Maya ', 'character-001': ' Ethan ' };
  const facts = sourceFacts(nameMap, overrides.sourceFacts || {});
  const sourceDialogueJson = Object.prototype.hasOwnProperty.call(overrides, 'source_dialogue_json')
    ? overrides.source_dialogue_json
    : JSON.stringify(Object.prototype.hasOwnProperty.call(overrides, 'sourceDialogue')
      ? overrides.sourceDialogue
      : [{ speaker_id: 'character-001', text: '跟我走。', start_ms: 0, end_ms: 2400 }]);
  const localizedDialogueJson = Object.prototype.hasOwnProperty.call(overrides, 'localized_dialogue_json')
    ? overrides.localized_dialogue_json
    : JSON.stringify(Object.prototype.hasOwnProperty.call(overrides, 'dialogue')
      ? overrides.dialogue
      : [
        { speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 0, end_ms: 2400 },
        { speaker_id: 'character-002', localized_text: 'Not without proof.', start_ms: 2500, end_ms: 5000 },
      ]);
  const sourceAssetId = insertAsset(db, {
    id: 101,
    type: 'video',
    localPath: 'source/source.mp4',
    mimeType: 'video/mp4',
    sha256: SOURCE_FINGERPRINT,
  });
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, default_locale, default_market, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'reference bundle project', 'en-US', 'US', ?, ?)`).run(now, now);
  const projectId = db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, ?, 'tenant-a', 'user-a', 'reference bundle work', ?, ?, 15000, ?, ?)`)
    .run(projectId, sourceAssetId, SOURCE_FINGERPRINT, now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, name_map_json, source_facts_json,
     facts_hash, reference_bundle_required, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, ?, ?, ?, ?, ?, 1, 'asset_review', ?, ?)`)
    .run(
      workId,
      Object.prototype.hasOwnProperty.call(overrides, 'locale') ? overrides.locale : 'en-US',
      Object.prototype.hasOwnProperty.call(overrides, 'market') ? overrides.market : 'US',
      JSON.stringify(nameMap),
      JSON.stringify(facts),
      Object.prototype.hasOwnProperty.call(overrides, 'factsHash') ? overrides.factsHash : factsHash(facts),
      now,
      now,
    ).lastInsertRowid);
  const shotId = Number(db.prepare(`INSERT INTO redraw_shots
    (work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index, start_ms,
     end_ms, duration_ms, source_dialogue_json, localized_dialogue_json, references_json,
     reference_bundle_json, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'shot-001', 1, 1, 0, 5000, 5000, ?, ?, '[]',
      '{}', ?, ?)`)
    .run(
      workId,
      versionId,
      sourceDialogueJson,
      localizedDialogueJson,
      now,
      now,
    ).lastInsertRowid);

  const actorAId = insertCharacterRedrawAsset(db, versionId, {
    id: 201,
    sourceCharacterKey: 'character-001',
    targetActorLabel: 'Actor Ethan',
    targetCountry: overrides.market || 'US',
    assetId: 301,
    sha256: assetSha(301),
  });
  const actorBId = insertCharacterRedrawAsset(db, versionId, {
    id: 202,
    sourceCharacterKey: 'character-002',
    targetActorLabel: 'Actor Maya',
    targetCountry: overrides.market || 'US',
    assetId: 302,
    sha256: assetSha(302),
  });
  const subtitleCleanId = insertTextCleanAsset(db, versionId, {
    id: 203,
    regionKey: 'text-001',
    kind: 'text_subtitle',
    assetId: 303,
    sha256: assetSha(303),
  });
  const screenCleanId = insertTextCleanAsset(db, versionId, {
    id: 204,
    regionKey: 'text-002',
    kind: 'text_screen',
    assetId: 304,
    sha256: assetSha(304),
  });
  const motionAssetId = insertAsset(db, {
    id: 305,
    type: 'video',
    localPath: `redraw-conditioning/${MOTION_SHA256}.mp4`,
    mimeType: 'video/mp4',
    sha256: MOTION_SHA256,
    metadata: {
      redraw_motion_reference: {
        schema_version: 'redraw-motion-reference-v1',
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        version_id: versionId,
        shot_id: shotId,
        source_asset_id: sourceAssetId,
        source_fingerprint: SOURCE_FINGERPRINT,
        clip_start_ms: 0,
        clip_end_ms: 5000,
        face_coverage_sha256: FACE_COVERAGE_SHA256,
        text_coverage_sha256: TEXT_COVERAGE_SHA256,
      },
    },
  });

  return {
    db,
    cleanup() {
      db.close();
      fs.rmSync(storageRoot, { recursive: true, force: true });
      if (currentStorageRoot === storageRoot) currentStorageRoot = null;
    },
    storageRoot,
    workId,
    versionId,
    shotId,
    sourceAssetId,
    motionAssetId,
    actorAId,
    actorBId,
    subtitleCleanId,
    screenCleanId,
  };
}

function sourceFacts(_nameMap, overrides = {}) {
  return {
    schema_version: '2.0',
    duration_ms: 5000,
    characters: [
      { id: 'character-001', source_name: '角色一', display_name: '角色一', relationship: '主角' },
      { id: 'character-002', source_name: '角色二', display_name: '角色二', relationship: '证人' },
    ],
    shots: [{
      id: 'shot-001',
      index: 1,
      start_ms: 0,
      end_ms: 5000,
      dialogue: [{
        id: 'turn-001',
        speaker_id: 'character-001',
        source_text: '跟我走。',
        start_ms: 0,
        end_ms: 2400,
      }],
    }],
    ...overrides,
  };
}

function factsHash(value) {
  return sha256(stableJson(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assetBytes(id) {
  return Buffer.from(`${PNG_BYTES}:${id}`);
}

function assetSha(id) {
  return sha256(assetBytes(id));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalSourceDialogue(value, shotStartMs = 0) {
  return value.map((entry) => ({
    id: String(entry.id || '').trim(),
    speaker_id: String(entry.speaker_id || '').trim(),
    source_text: String(entry.source_text ?? entry.text ?? '').trim(),
    start_ms: Number(entry.start_ms) - shotStartMs,
    end_ms: Number(entry.end_ms) - shotStartMs,
  })).sort((left, right) => left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.speaker_id.localeCompare(right.speaker_id)
    || left.id.localeCompare(right.id));
}

function canonicalLocalizedDialogue(value, shotStartMs = 0) {
  return value.map((entry) => ({
    speaker_id: String(entry.speaker_id || '').trim(),
    localized_text: String(entry.localized_text || '').trim(),
    start_ms: Number(entry.start_ms) - shotStartMs,
    end_ms: Number(entry.end_ms) - shotStartMs,
  })).sort((left, right) => left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.speaker_id.localeCompare(right.speaker_id));
}

function canonicalNameMap(value) {
  return Object.fromEntries(Object.keys(value).map((rawKey) => [
    String(rawKey).trim(),
    String(value[rawKey] || '').trim(),
  ]).sort(([left], [right]) => left.localeCompare(right)));
}

function expectedDialogueEvidence(state) {
  const row = state.db.prepare(`
    SELECT s.id, s.shot_id, s.start_ms, s.end_ms, s.duration_ms,
           s.source_dialogue_json, s.localized_dialogue_json,
           v.id AS version_id, v.locale, v.market, v.name_map_json, v.facts_hash
    FROM redraw_shots s
    JOIN redraw_versions v ON v.id = s.version_id
    WHERE s.id = ?
  `).get(state.shotId);
  const sourceDialogueSha256 = sha256(stableJson(
    canonicalSourceDialogue(JSON.parse(row.source_dialogue_json), Number(row.start_ms)),
  ));
  const scriptSha256 = sha256(stableJson(
    canonicalLocalizedDialogue(JSON.parse(row.localized_dialogue_json), Number(row.start_ms)),
  ));
  const characterNameMapSha256 = sha256(stableJson(canonicalNameMap(JSON.parse(row.name_map_json))));
  const binding = {
    contract: LOCALIZATION_BINDING_CONTRACT,
    version_id: Number(row.version_id),
    facts_hash: row.facts_hash,
    target: { locale: row.locale, market: row.market },
    shot: {
      id: Number(row.id),
      shot_id: row.shot_id,
      start_ms: Number(row.start_ms),
      end_ms: Number(row.end_ms),
      duration_ms: Number(row.duration_ms),
    },
    source_dialogue_sha256: sourceDialogueSha256,
    script_sha256: scriptSha256,
    character_name_map_sha256: characterNameMapSha256,
  };
  return {
    source_dialogue_sha256: sourceDialogueSha256,
    script_sha256: scriptSha256,
    character_name_map_sha256: characterNameMapSha256,
    localization_binding_sha256: sha256(stableJson(binding)),
  };
}

function assertDialogueEvidence(dialogue, expected, locale, market) {
  assert.equal(dialogue.target_locale, locale);
  assert.equal(dialogue.target_market, market);
  assert.equal(dialogue.source_dialogue_sha256, expected.source_dialogue_sha256);
  assert.equal(dialogue.script_sha256, expected.script_sha256);
  assert.equal(dialogue.character_name_map_sha256, expected.character_name_map_sha256);
  assert.equal(dialogue.localization_binding_sha256, expected.localization_binding_sha256);
}

function textCoverageHash(input) {
  return sha256(stableJson(input.text_regions.map((entry) => ({
    kind: entry.kind,
    region_key: entry.region_key,
    text_clean_redraw_asset_id: entry.text_clean_redraw_asset_id,
    time_ranges: [...entry.time_ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  })).sort((a, b) => a.region_key.localeCompare(b.region_key))));
}

function syncMotionTextCoverage(state, input) {
  const row = state.db.prepare('SELECT metadata FROM assets WHERE id = ?').get(state.motionAssetId);
  const metadata = JSON.parse(row.metadata);
  metadata.redraw_motion_reference.text_coverage_sha256 = textCoverageHash(input);
  state.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), state.motionAssetId);
}

function insertAsset(db, input) {
  if (input.localPath?.startsWith('redraw/')) {
    const root = input.storageRoot || currentStorageRoot;
    if (root) fs.writeFileSync(path.join(root, input.localPath), assetBytes(input.id));
  }
  db.prepare(`INSERT INTO assets
    (id, name, type, category, url, local_path, mime_type, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'redraw', '', ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.name || `asset-${input.id}`,
      input.type || 'image',
      input.localPath,
      input.mimeType || 'image/png',
      JSON.stringify(input.metadata || {
        sha256: input.sha256,
        width: input.width || 864,
        height: input.height || 496,
      }),
      INITIAL_UPDATED_AT,
      INITIAL_UPDATED_AT,
    );
  return input.id;
}

let currentStorageRoot = null;

function identityPack(input = {}) {
  const wardrobeAssetId = input.wardrobeAssetId || ((input.assetId || 301) + 1000);
  const pack = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: input.sourceCharacterKey || 'character-001',
    target_actor_label: input.targetActorLabel || 'Actor Ethan',
    artifact: {
      asset_id: input.assetId || 301,
      sha256: input.sha256 || 'a'.repeat(64),
      width: 864,
      height: 1296,
      mime_type: 'image/png',
    },
    wardrobe: {
      label: '整集主服装',
      reference_asset_id: wardrobeAssetId,
      reference_sha256: input.wardrobeSha256 || assetSha(wardrobeAssetId),
      consistency_confirmed: input.wardrobeConsistencyConfirmed ?? true,
    },
    confirmed_views: input.confirmedViews || ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: input.adultStatus || 'verified_18_plus',
    identity_consistency_confirmed: true,
    persona_origin: input.personaOrigin || 'fictional_ai_generated',
    target_country: input.targetCountry || 'US',
    ready: input.ready ?? true,
    reviewed_by: 'user-a',
    reviewed_at: REVIEWED_AT,
  };
  pack.pack_sha256 = input.packSha256 || identityPackHash(pack);
  return pack;
}

function identityPackHash(pack) {
  return sha256(stableJson({
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
}

function recalcIdentityPackHash(payload) {
  payload.identity_pack.pack_sha256 = identityPackHash(payload.identity_pack);
}

function insertCharacterRedrawAsset(db, versionId, input) {
  const wardrobeAssetId = input.wardrobeAssetId || (input.assetId + 1000);
  insertAsset(db, {
    id: input.assetId,
    localPath: `redraw/identity-${input.assetId}.png`,
    mimeType: 'image/png',
    sha256: input.sha256,
    width: 864,
    height: 1296,
  });
  insertAsset(db, {
    id: wardrobeAssetId,
    localPath: `redraw/wardrobe-${wardrobeAssetId}.png`,
    mimeType: 'image/png',
    sha256: input.wardrobeSha256 || assetSha(wardrobeAssetId),
    width: 864,
    height: 1296,
  });
  const pack = identityPack(input);
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     localized_description, prompt, asset_id, version_number, approval_status,
     approved_by, approved_at, status, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'character', ?, ?, 'fictional adult target actor',
      'identity redraw prompt', ?, 1, ?, 'user-a', ?, 'generated', ?, ?)`)
    .run(
      input.id,
      versionId,
      JSON.stringify({ source_ref: { stable_id: input.sourceCharacterKey }, identity_pack: pack }),
      input.targetActorLabel,
      input.assetId,
      input.approvalStatus || 'approved',
      REVIEWED_AT,
      INITIAL_UPDATED_AT,
      INITIAL_UPDATED_AT,
    );
  return input.id;
}

function textCleanPack(input = {}) {
  const pack = {
    schema_version: 'text-clean-plate-reference-v1',
    region_key: input.regionKey || 'text-001',
    kind: input.kind || 'text_subtitle',
    artifact: {
      asset_id: input.assetId || 303,
      sha256: input.sha256 || 'c'.repeat(64),
      width: 864,
      height: 496,
      mime_type: 'image/png',
    },
    source_fingerprint: SOURCE_FINGERPRINT,
    ready: input.ready ?? true,
    reviewed_by: 'user-a',
    reviewed_at: REVIEWED_AT,
  };
  pack.pack_sha256 = input.packSha256 || sha256(stableJson(pack));
  return pack;
}

function recalcTextCleanPackHash(payload) {
  const pack = { ...payload.text_clean_plate_pack };
  delete pack.pack_sha256;
  payload.text_clean_plate_pack.pack_sha256 = sha256(stableJson(pack));
}

function insertTextCleanAsset(db, versionId, input) {
  insertAsset(db, {
    id: input.assetId,
    localPath: `redraw/text-clean-${input.assetId}.png`,
    mimeType: 'image/png',
    sha256: input.sha256,
  });
  const pack = textCleanPack(input);
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     localized_description, prompt, clean_plate_asset_id, version_number, approval_status,
     approved_by, approved_at, status, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'scene', ?, ?, 'text clean plate',
      'remove localized text only', ?, 1, ?, 'user-a', ?, 'generated', ?, ?)`)
    .run(
      input.id,
      versionId,
      JSON.stringify({
        source_ref: { stable_id: input.regionKey, kind: input.kind },
        snapshot: { mode: 'text_clean_plate' },
        text_clean_plate_pack: pack,
      }),
      input.regionKey,
      input.assetId,
      input.approvalStatus || 'approved',
      REVIEWED_AT,
      INITIAL_UPDATED_AT,
      INITIAL_UPDATED_AT,
    );
  return input.id;
}

function ctx(state, overrides = {}) {
  return {
    db: state.db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: state.versionId,
    storageRoot: state.storageRoot,
    now: REVIEWED_AT,
    probeRunner: async () => ({
      duration_ms: state.shotDurationMs || 5000,
      width: 864,
      height: 496,
      mime_type: 'video/mp4',
      video_codec: 'h264',
      audio_stream_count: 0,
    }),
    ...overrides,
  };
}

function validInput(state, overrides = {}) {
  return {
    shot_id: state.shotId,
    expected_updated_at: currentShot(state.db, state.shotId).updated_at,
    motion_reference_asset_id: state.motionAssetId,
    face_tracks: [
      {
        track_key: 'face-002',
        source_character_key: 'character-002',
        time_ranges: [[2500, 5000]],
        identity_redraw_asset_id: state.actorBId,
      },
      {
        track_key: 'face-001',
        source_character_key: 'character-001',
        time_ranges: [[0, 5000]],
        identity_redraw_asset_id: state.actorAId,
      },
    ],
    text_regions: [
      {
        region_key: 'text-002',
        kind: 'text_screen',
        time_ranges: [[2500, 5000]],
        text_clean_redraw_asset_id: state.screenCleanId,
      },
      {
        region_key: 'text-001',
        kind: 'text_subtitle',
        time_ranges: [[0, 2500]],
        text_clean_redraw_asset_id: state.subtitleCleanId,
      },
    ],
    coverage_review: {
      recognizable_face_count: 2,
      mapped_face_count: 2,
      unresolved_face_count: 0,
      recognizable_text_region_count: 2,
      mapped_text_region_count: 2,
      unresolved_text_region_count: 0,
      status: 'approved',
    },
    ...overrides,
  };
}

function faceCoverageHash(input) {
  return sha256(stableJson(input.face_tracks.map((entry) => ({
    identity_redraw_asset_id: entry.identity_redraw_asset_id,
    source_character_key: entry.source_character_key,
    time_ranges: [...entry.time_ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    track_key: entry.track_key,
  })).sort((a, b) => a.track_key.localeCompare(b.track_key))));
}

function setupSecondShot(overrides = {}) {
  const sourceDialogue = overrides.sourceDialogue || [{
    id: 'turn-002',
    speaker_id: 'character-001',
    text: '跟我走。',
    start_ms: 4800,
    end_ms: 6500,
  }];
  const dialogue = overrides.dialogue || [{
    speaker_id: 'character-001',
    localized_text: 'Come with me.',
    start_ms: 4800,
    end_ms: 6500,
  }];
  const state = setup({
    sourceDialogue,
    dialogue,
    sourceFacts: {
      duration_ms: 8000,
      shots: [
        {
          id: 'shot-001', index: 1, start_ms: 0, end_ms: 4000, dialogue: [],
        },
        {
          id: 'shot-002',
          index: 2,
          start_ms: 4000,
          end_ms: 8000,
          dialogue: sourceDialogue.map((turn) => ({
            id: turn.id || 'turn-002',
            speaker_id: turn.speaker_id,
            source_text: turn.source_text ?? turn.text,
            start_ms: turn.start_ms,
            end_ms: turn.end_ms,
          })),
        },
      ],
    },
  });
  state.shotDurationMs = 4000;
  state.db.prepare(`UPDATE redraw_shots
    SET shot_id = 'shot-002', shot_index = 2, start_ms = 4000, end_ms = 8000, duration_ms = 4000
    WHERE id = ?`).run(state.shotId);
  const input = validInput(state, {
    face_tracks: [
      {
        track_key: 'face-002',
        source_character_key: 'character-002',
        time_ranges: [[2000, 4000]],
        identity_redraw_asset_id: state.actorBId,
      },
      {
        track_key: 'face-001',
        source_character_key: 'character-001',
        time_ranges: [[0, 4000]],
        identity_redraw_asset_id: state.actorAId,
      },
    ],
    text_regions: [
      {
        region_key: 'text-002',
        kind: 'text_screen',
        time_ranges: [[2000, 4000]],
        text_clean_redraw_asset_id: state.screenCleanId,
      },
      {
        region_key: 'text-001',
        kind: 'text_subtitle',
        time_ranges: [[0, 2000]],
        text_clean_redraw_asset_id: state.subtitleCleanId,
      },
    ],
  });
  const row = state.db.prepare('SELECT metadata FROM assets WHERE id = ?').get(state.motionAssetId);
  const metadata = JSON.parse(row.metadata);
  Object.assign(metadata.redraw_motion_reference, {
    clip_start_ms: 4000,
    clip_end_ms: 8000,
    face_coverage_sha256: faceCoverageHash(input),
    text_coverage_sha256: textCoverageHash(input),
  });
  state.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(metadata), state.motionAssetId);
  return { state, input };
}

function updateSecondShotTimeline(state, overrides = {}) {
  const timeline = {
    start_ms: 4000,
    end_ms: 8000,
    duration_ms: 4000,
    ...overrides,
  };
  state.db.pragma('ignore_check_constraints = ON');
  try {
    state.db.prepare(`UPDATE redraw_shots
      SET start_ms = ?, end_ms = ?, duration_ms = ?
      WHERE id = ?`).run(timeline.start_ms, timeline.end_ms, timeline.duration_ms, state.shotId);
  } finally {
    state.db.pragma('ignore_check_constraints = OFF');
  }
}

function currentShot(db, shotId) {
  return db.prepare(`SELECT reference_bundle_json, reference_bundle_hash,
    reference_bundle_updated_at, updated_at FROM redraw_shots WHERE id = ?`).get(shotId);
}

function assertShotUnchanged(db, shotId, before) {
  assert.deepEqual(currentShot(db, shotId), before);
}

async function captureError(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected saveReferenceBundle to reject');
}

async function captureAnyError(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected function to reject');
}

async function assertRejectsUnchanged(state, input, code, contextOverrides = {}, forbiddenValues = []) {
  const before = currentShot(state.db, state.shotId);
  const error = await captureError(() => saveReferenceBundle(ctx(state, contextOverrides), input));
  assert.equal(error.code, code);
  assertShotUnchanged(state.db, state.shotId, before);
  const serialized = JSON.stringify(error);
  assert.equal(/[A-Za-z]:[\\/]/.test(serialized), false);
  assert.equal(serialized.includes('sk-'), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('http://'), false);
  assert.equal(serialized.includes('https://'), false);
  for (const value of forbiddenValues) {
    assert.equal(serialized.includes(value), false);
  }
}

function mutateInput(state, mutate) {
  const input = JSON.parse(JSON.stringify(validInput(state)));
  mutate(input);
  return input;
}

function updateJsonColumn(db, table, id, column, mutate) {
  const row = db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id);
  const payload = JSON.parse(row.value);
  mutate(payload);
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(JSON.stringify(payload), id);
}

function updateRedrawAsset(db, id, fields) {
  const entries = Object.entries(fields);
  db.prepare(`UPDATE redraw_assets SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), id);
}

test('第二镜绝对对白保存和重读时规范为镜头相对时间并绑定稳定哈希', async () => {
  const { state, input } = setupSecondShot();
  try {
    const saved = await saveReferenceBundle(ctx(state), input);
    const expectedTurns = [{
      speaker_id: 'character-001',
      localized_text: 'Come with me.',
      start_ms: 800,
      end_ms: 2500,
    }];
    const expected = expectedDialogueEvidence(state);

    assert.deepEqual(saved.bundle.dialogue.turns, expectedTurns);
    assertDialogueEvidence(saved.bundle.dialogue, expected, 'en-US', 'US');
    assert.deepEqual(saved.bundle.source, {
      asset_id: state.sourceAssetId,
      sha256: SOURCE_FINGERPRINT,
      clip_start_ms: 4000,
      clip_end_ms: 8000,
    });
    assert.equal(saved.bundle.duration_ms, 4000);
    assert.equal(saved.bundle.dialogue.source_dialogue_sha256, sha256(stableJson([{
      id: 'turn-002',
      speaker_id: 'character-001',
      source_text: '跟我走。',
      start_ms: 800,
      end_ms: 2500,
    }])));
    assert.equal(saved.bundle.dialogue.script_sha256, sha256(stableJson(expectedTurns)));

    const loaded = await loadCurrentReferenceBundle(ctx(state), state.shotId);
    assert.deepEqual(loaded.bundle.dialogue.turns, expectedTurns);
    assertDialogueEvidence(loaded.bundle.dialogue, expected, 'en-US', 'US');
  } finally {
    state.cleanup();
  }
});

test('第二镜源和目标对白仅接受镜头绝对整数时间且拒绝时零写入', async () => {
  const cases = [
    {
      name: 'source starts before shot',
      sourceDialogue: [{ speaker_id: 'character-001', text: '跟我走。', start_ms: 3999, end_ms: 6500 }],
    },
    {
      name: 'source ends after shot',
      sourceDialogue: [{ speaker_id: 'character-001', text: '跟我走。', start_ms: 4800, end_ms: 8001 }],
    },
    {
      name: 'source mistakenly uses relative time',
      sourceDialogue: [{ speaker_id: 'character-001', text: '跟我走。', start_ms: 800, end_ms: 2500 }],
    },
    {
      name: 'localized starts before shot',
      dialogue: [{ speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 3999, end_ms: 6500 }],
    },
    {
      name: 'localized ends after shot',
      dialogue: [{ speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 4800, end_ms: 8001 }],
    },
    {
      name: 'localized mistakenly uses relative time',
      dialogue: [{ speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 800, end_ms: 2500 }],
    },
    {
      name: 'source start is not an integer',
      sourceDialogue: [{ speaker_id: 'character-001', text: '跟我走。', start_ms: 4800.5, end_ms: 6500 }],
    },
    {
      name: 'source start is a numeric string',
      sourceDialogue: [{ speaker_id: 'character-001', text: '跟我走。', start_ms: '4800', end_ms: 6500 }],
    },
    {
      name: 'source range is empty',
      sourceDialogue: [{ speaker_id: 'character-001', text: '跟我走。', start_ms: 6500, end_ms: 6500 }],
    },
    {
      name: 'localized end is not an integer',
      dialogue: [{ speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 4800, end_ms: 6500.5 }],
    },
    {
      name: 'localized end is a numeric string',
      dialogue: [{ speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 4800, end_ms: '6500' }],
    },
    {
      name: 'localized range is reversed',
      dialogue: [{ speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 6500, end_ms: 4800 }],
    },
  ];

  for (const entry of cases) {
    const { state, input } = setupSecondShot(entry);
    try {
      await assertRejectsUnchanged(
        state,
        input,
        'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
      );
    } finally {
      state.cleanup();
    }
  }
});

test('第二镜重读时拒绝绝对原始对白或相对参考包对白漂移', async () => {
  const cases = [
    {
      name: 'source raw absolute drift',
      mutate(state) {
        state.db.prepare('UPDATE redraw_shots SET source_dialogue_json = ? WHERE id = ?').run(JSON.stringify([{
          id: 'turn-002', speaker_id: 'character-001', text: '跟我走。', start_ms: 4900, end_ms: 6500,
        }]), state.shotId);
      },
    },
    {
      name: 'localized raw absolute drift',
      mutate(state) {
        state.db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE id = ?').run(JSON.stringify([{
          speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 4900, end_ms: 6500,
        }]), state.shotId);
      },
    },
    {
      name: 'bundle relative drift',
      mutate(state) {
        const row = currentShot(state.db, state.shotId);
        const bundle = JSON.parse(row.reference_bundle_json);
        bundle.dialogue.turns[0].start_ms = 900;
        state.db.prepare('UPDATE redraw_shots SET reference_bundle_json = ?, reference_bundle_hash = ? WHERE id = ?')
          .run(JSON.stringify(bundle), canonicalBundleHash(bundle), state.shotId);
      },
    },
  ];

  for (const entry of cases) {
    const { state, input } = setupSecondShot();
    try {
      await saveReferenceBundle(ctx(state), input);
      const before = currentShot(state.db, state.shotId);
      entry.mutate(state);
      await assert.rejects(
        () => loadCurrentReferenceBundle(ctx(state), state.shotId),
        (error) => error.code === 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
        entry.name,
      );
      assert.equal(currentShot(state.db, state.shotId).updated_at, before.updated_at);
    } finally {
      state.cleanup();
    }
  }
});

test('第二镜保存时拒绝不安全或不自洽的镜头时间线且零写入', async () => {
  const cases = [
    { name: 'duration mismatch', timeline: { duration_ms: 3999 } },
    { name: 'fractional start', timeline: { start_ms: 4000.5 } },
    { name: 'fractional end', timeline: { end_ms: 8000.5 } },
    { name: 'fractional duration', timeline: { duration_ms: 4000.5 } },
    { name: 'unsafe start', timeline: { start_ms: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'unsafe end', timeline: { end_ms: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'unsafe duration', timeline: { duration_ms: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'negative start', timeline: { start_ms: -1, end_ms: 3999 } },
    { name: 'empty range', timeline: { end_ms: 4000, duration_ms: 0 } },
  ];

  for (const entry of cases) {
    const { state, input } = setupSecondShot();
    try {
      updateSecondShotTimeline(state, entry.timeline);
      await assertRejectsUnchanged(
        state,
        input,
        'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
      );
    } finally {
      state.cleanup();
    }
  }
});

test('第二镜重读时拒绝当前镜头时间线漂移为非法值', async () => {
  const cases = [
    { name: 'duration mismatch', timeline: { duration_ms: 3999 } },
    { name: 'fractional end', timeline: { end_ms: 8000.5 } },
    { name: 'unsafe duration', timeline: { duration_ms: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'negative start', timeline: { start_ms: -1, end_ms: 3999 } },
  ];

  for (const entry of cases) {
    const { state, input } = setupSecondShot();
    try {
      await saveReferenceBundle(ctx(state), input);
      updateSecondShotTimeline(state, entry.timeline);
      const before = currentShot(state.db, state.shotId);
      await assert.rejects(
        () => loadCurrentReferenceBundle(ctx(state), state.shotId),
        (error) => error.code === 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
        entry.name,
      );
      assertShotUnchanged(state.db, state.shotId, before);
    } finally {
      state.cleanup();
    }
  }
});

test('保存参考包时规范排序、脱敏并写入稳定哈希', async () => {
  const state = setup();
  try {
    const saved = await saveReferenceBundle(ctx(state), validInput(state));
    const row = currentShot(state.db, state.shotId);
    const bundle = JSON.parse(row.reference_bundle_json);

    assert.equal(saved.shot_id, state.shotId);
    assert.equal(saved.reference_bundle_hash, row.reference_bundle_hash);
    assert.equal(saved.reference_bundle_updated_at, REVIEWED_AT);
    assert.equal(row.reference_bundle_updated_at, REVIEWED_AT);
    assert.match(row.reference_bundle_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(bundle).sort(), [
      'coverage_review',
      'coverage_sha256',
      'dialogue',
      'duration_ms',
      'face_tracks',
      'locale',
      'market',
      'motion_reference',
      'name_map',
      'schema_version',
      'shot_id',
      'source',
      'text_regions',
      'version_id',
    ].sort());
    assert.equal(bundle.schema_version, 'redraw-reference-bundle-v2');
    assert.equal(bundle.locale, 'en-US');
    assert.equal(bundle.market, 'US');
    assert.deepEqual(bundle.face_tracks.map((entry) => entry.track_key), ['face-001', 'face-002']);
    assert.deepEqual(bundle.face_tracks.map((entry) => ({
      target_character_name: entry.target_character_name,
      identity_asset_id: entry.identity_asset_id,
      identity_pack_sha256: entry.identity_pack_sha256,
      persona_origin: entry.persona_origin,
      target_country: entry.target_country,
      adult_status: entry.adult_status,
    })), [
      {
        target_character_name: 'Ethan',
        identity_asset_id: 301,
        identity_pack_sha256: bundle.face_tracks[0].identity.pack_sha256,
        persona_origin: 'fictional_ai_generated',
        target_country: 'US',
        adult_status: 'verified_18_plus',
      },
      {
        target_character_name: 'Maya',
        identity_asset_id: 302,
        identity_pack_sha256: bundle.face_tracks[1].identity.pack_sha256,
        persona_origin: 'fictional_ai_generated',
        target_country: 'US',
        adult_status: 'verified_18_plus',
      },
    ]);
    assert.match(bundle.face_tracks[0].identity_pack_sha256, /^[0-9a-f]{64}$/);
    assert.match(bundle.face_tracks[1].identity_pack_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(bundle.text_regions.map((entry) => entry.region_key), ['text-001', 'text-002']);
    assert.equal(bundle.dialogue.localized_script_version_id, state.versionId);
    const expectedDialogue = expectedDialogueEvidence(state);
    assertDialogueEvidence(bundle.dialogue, expectedDialogue, 'en-US', 'US');
    assert.equal(bundle.dialogue.kind, 'spoken');
    assert.equal(bundle.dialogue.speech_required, true);
    assert.deepEqual(bundle.dialogue.turns.map((entry) => entry.speaker_id), ['character-001', 'character-002']);
    assert.deepEqual(bundle.name_map, { 'character-001': 'Ethan', 'character-002': 'Maya' });
    assert.match(bundle.coverage_sha256, /^[0-9a-f]{64}$/);

    const persistedFacts = JSON.parse(state.db.prepare(
      'SELECT source_facts_json FROM redraw_versions WHERE id = ?',
    ).get(state.versionId).source_facts_json);
    assert.equal(Object.hasOwn(persistedFacts, 'script_sha256'), false);
    assert.equal(Object.hasOwn(persistedFacts, 'name_map_source_sha256'), false);

    const serialized = JSON.stringify(bundle);
    assert.equal(/[\u3400-\u9fff]/.test(serialized), false);
    assert.equal(/[A-Za-z]:[\\/]/.test(serialized), false);
    assert.equal(serialized.includes('sk-'), false);
    assert.equal(serialized.includes('Authorization'), false);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes('http://'), false);
  } finally {
    state.cleanup();
  }
});
test('重读参考包时重新校验并投影生成用白名单 URL', async () => {
  const state = setup();
  try {
    const saved = await saveReferenceBundle(ctx(state), validInput(state));

    const loaded = await loadCurrentReferenceBundle(ctx(state), state.shotId);
    assert.equal(loaded.reference_bundle_hash, saved.reference_bundle_hash);
    assert.equal(loaded.reference_bundle_updated_at, saved.reference_bundle_updated_at);
    assert.equal(canonicalBundleHash(loaded.bundle), saved.reference_bundle_hash);

    const referenceKinds = [];
    const projected = await projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl({ asset_id: assetId, sha256: digest, kind }) {
        referenceKinds.push(kind);
        return `/static/redraw-reference/${kind}/${assetId}-${digest.slice(0, 8)}`;
      },
    }), state.shotId);

    assert.deepEqual(Object.keys(projected).sort(), [
      'identityBindings',
      'generateAudio',
      'prompt',
      'referenceBundleSnapshot',
      'referenceImageUrls',
      'referenceVideoUrl',
      'targetLocale',
    ].sort());
    assert.equal(projected.targetLocale, 'en-US');
    assert.equal(projected.generateAudio, true);
    assert.match(projected.prompt, /Dialogue mode: spoken\./);
    assert.match(projected.prompt, /Target locale: en-US\./);
    assert.match(projected.prompt, /target locale en-US and market US/);
    assert.match(projected.prompt, /Dialogue timing:/);
    assert.match(projected.prompt, /Generate synchronized en-US speech audio for the approved dialogue timing only\./);
    assert.match(projected.prompt, /Ethan/);
    assert.match(projected.prompt, /Maya/);
    assert.match(projected.prompt, /Come with me\./);
    assert.match(projected.prompt, /Not without proof\./);
    assert.match(projected.prompt, /0-2400ms/);
    assert.equal(/[\u3400-\u9fff]/.test(projected.prompt), false);
    assert.equal(projected.prompt.includes('source/source.mp4'), false);
    assert.equal(projected.prompt.includes('http://'), false);
    assert.equal(projected.prompt.includes('https://'), false);
    assert.equal(projected.prompt.includes('sk-'), false);
    const projectedAgain = await projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl({ asset_id: assetId, sha256: digest, kind }) {
        return `/static/redraw-reference/${kind}/${assetId}-${digest.slice(0, 8)}`;
      },
    }), state.shotId);
    assert.equal(projectedAgain.prompt, projected.prompt);
    assert.equal(projected.referenceImageUrls.length, 2);
    assert.equal(projected.referenceVideoUrl.startsWith('/static/'), true);
    assert.deepEqual(referenceKinds.sort(), ['identity', 'identity', 'motion']);
    assert.equal(projected.identityBindings.length, 2);
    assert.deepEqual(projected.identityBindings.map((entry) => entry.target_character_name), ['Ethan', 'Maya']);
    assert.deepEqual(projected.referenceBundleSnapshot, {
      schema_version: 'redraw-reference-bundle-v2',
      coverage_sha256: loaded.bundle.coverage_sha256,
      source_sha256: SOURCE_FINGERPRINT,
      motion_sha256: MOTION_SHA256,
      dialogue_kind: 'spoken',
      speech_required: true,
      source_dialogue_sha256: loaded.bundle.dialogue.source_dialogue_sha256,
      dialogue_script_sha256: loaded.bundle.dialogue.script_sha256,
      character_name_map_sha256: loaded.bundle.dialogue.character_name_map_sha256,
      localization_binding_sha256: loaded.bundle.dialogue.localization_binding_sha256,
    });
    assert.equal(JSON.stringify(projected).includes('source/source.mp4'), false);
    assert.equal(JSON.stringify(projected).includes('sk-'), false);
  } finally {
    state.cleanup();
  }
});

test('不同源角色允许映射同一非中文目标名且绑定哈希与投影稳定', async () => {
  const state = setup({
    nameMap: { 'character-001': 'Alex', 'character-002': 'Alex' },
  });
  try {
    await saveReferenceBundle(ctx(state), validInput(state));
    const loaded = await loadCurrentReferenceBundle(ctx(state), state.shotId);
    const expectedDialogue = expectedDialogueEvidence(state);
    assert.deepEqual(loaded.bundle.name_map, {
      'character-001': 'Alex',
      'character-002': 'Alex',
    });
    assert.equal(
      loaded.bundle.dialogue.character_name_map_sha256,
      expectedDialogue.character_name_map_sha256,
    );
    assert.equal(
      loaded.bundle.dialogue.localization_binding_sha256,
      expectedDialogue.localization_binding_sha256,
    );

    const createReferenceUrl = ({ asset_id: assetId, sha256: digest, kind }) => (
      `/static/redraw-reference/${kind}/${assetId}-${digest.slice(0, 8)}`
    );
    const first = await projectReferenceBundleForGeneration(ctx(state, { createReferenceUrl }), state.shotId);
    const second = await projectReferenceBundleForGeneration(ctx(state, { createReferenceUrl }), state.shotId);
    assert.deepEqual(first.identityBindings.map((entry) => entry.target_character_name), ['Alex', 'Alex']);
    assert.deepEqual(second.referenceBundleSnapshot, first.referenceBundleSnapshot);
  } finally {
    state.cleanup();
  }
});

test('es-ES/ES 参考包对白、身份国家和投影 locale 使用当前版本合同', async () => {
  const state = setup({
    locale: 'es-ES',
    market: 'ES',
    nameMap: { 'character-001': 'Diego', 'character-002': 'Lucía' },
    dialogue: [
      { speaker_id: 'character-001', localized_text: 'Ven conmigo.', start_ms: 0, end_ms: 2400 },
      { speaker_id: 'character-002', localized_text: 'No sin pruebas.', start_ms: 2500, end_ms: 5000 },
    ],
  });
  try {
    updateRedrawAsset(state.db, state.actorAId, { localized_name: 'Actor Diego' });
    updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
      payload.identity_pack.target_actor_label = 'Actor Diego';
      recalcIdentityPackHash(payload);
    });
    updateRedrawAsset(state.db, state.actorBId, { localized_name: 'Actor Lucía' });
    updateJsonColumn(state.db, 'redraw_assets', state.actorBId, 'source_ref_json', (payload) => {
      payload.identity_pack.target_actor_label = 'Actor Lucía';
      recalcIdentityPackHash(payload);
    });

    const saved = await saveReferenceBundle(ctx(state), validInput(state));
    const expectedDialogue = expectedDialogueEvidence(state);

    assert.equal(saved.bundle.locale, 'es-ES');
    assert.equal(saved.bundle.market, 'ES');
    assertDialogueEvidence(saved.bundle.dialogue, expectedDialogue, 'es-ES', 'ES');
    assert.deepEqual(saved.bundle.face_tracks.map((entry) => entry.target_country), ['ES', 'ES']);
    assert.deepEqual(saved.bundle.dialogue.turns.map((entry) => entry.localized_text), ['Ven conmigo.', 'No sin pruebas.']);

    const projected = await projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl({ asset_id: assetId, kind }) {
        return `/static/redraw-reference/${kind}/${assetId}`;
      },
    }), state.shotId);

    assert.equal(projected.targetLocale, 'es-ES');
    assert.match(projected.prompt, /Target locale: es-ES\./);
    assert.match(projected.prompt, /target locale es-ES and market ES/);
    assert.match(projected.prompt, /Dialogue timing:/);
    assert.match(projected.prompt, /Generate synchronized es-ES speech audio for the approved dialogue timing only\./);
    assert.match(projected.prompt, /Diego: Ven conmigo\./);
    assert.match(projected.prompt, /Lucía: No sin pruebas\./);
    assert.equal(projected.prompt.includes('US English'), false);
    assert.equal(projected.prompt.includes('Target locale: en-US.'), false);
    assert.equal(/[\u3400-\u9fff]/.test(projected.prompt), false);
  } finally {
    state.cleanup();
  }
});

test('本地化对白可保留中文源文审计字段且目标证据仅绑定规范字段', async () => {
  const state = setup({
    locale: 'es-ES',
    market: 'ES',
    dialogue: [{
      speaker_id: 'character-001',
      source_text: '他最后出现的地方就是这里',
      localized_text: 'Fue aqui.',
      start_ms: 900,
      end_ms: 2300,
      emotion: null,
      overlap_group: null,
      estimated_duration_ms: 600,
    }],
  });
  try {
    const canonicalTurns = [{
      speaker_id: 'character-001',
      localized_text: 'Fue aqui.',
      start_ms: 900,
      end_ms: 2300,
    }];
    const expectedScriptSha256 = sha256(stableJson(canonicalTurns));

    const saved = await saveReferenceBundle(ctx(state), validInput(state));
    assert.deepEqual(saved.bundle.dialogue.turns, canonicalTurns);
    assert.equal(saved.bundle.dialogue.script_sha256, expectedScriptSha256);
    assert.equal(JSON.stringify(saved.bundle).includes('他最后出现的地方就是这里'), false);
    for (const field of ['source_text', 'emotion', 'overlap_group', 'estimated_duration_ms']) {
      assert.equal(Object.hasOwn(saved.bundle.dialogue.turns[0], field), false);
    }

    const loaded = await loadCurrentReferenceBundle(ctx(state), state.shotId);
    assert.deepEqual(loaded.bundle.dialogue.turns, canonicalTurns);
    assert.equal(loaded.bundle.dialogue.script_sha256, expectedScriptSha256);
  } finally {
    state.cleanup();
  }
});

test('V2 身份素材允许 source_ref.source_character_key 且无 stable_id', async () => {
  const state = setup();
  try {
    updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
      payload.source_ref = { source_character_key: 'character-001' };
    });

    const saved = await saveReferenceBundle(ctx(state), validInput(state));
    assert.equal(saved.bundle.face_tracks[0].source_character_key, 'character-001');
    assert.equal(saved.bundle.face_tracks[0].identity.target_actor_label, 'Actor Ethan');

    const projected = await projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl({ asset_id: assetId, kind }) {
        return `/static/redraw-reference/${kind}/${assetId}`;
      },
    }), state.shotId);

    assert.equal(projected.targetLocale, 'en-US');
    assert.deepEqual(projected.identityBindings.map((entry) => entry.source_character_key), ['character-001', 'character-002']);
    assert.match(projected.prompt, /Actor Ethan/);
  } finally {
    state.cleanup();
  }
});

test('静默对白保存、重读并投影为非人声环境音合同', async () => {
  const state = setup({ sourceDialogue: [], dialogue: [] });
  try {
    const saved = await saveReferenceBundle(ctx(state), validInput(state));
    const expectedDialogue = expectedDialogueEvidence(state);
    assert.equal(saved.bundle.dialogue.kind, 'silent');
    assert.equal(saved.bundle.dialogue.speech_required, false);
    assert.deepEqual(saved.bundle.dialogue.turns, []);
    assertDialogueEvidence(saved.bundle.dialogue, expectedDialogue, 'en-US', 'US');
    assert.equal(canonicalBundleHash(saved.bundle), saved.reference_bundle_hash);

    const loaded = await loadCurrentReferenceBundle(ctx(state), state.shotId);
    assert.deepEqual(loaded.bundle.dialogue, saved.bundle.dialogue);

    const projected = await projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl({ asset_id: assetId, kind }) {
        return `/static/redraw-reference/${kind}/${assetId}`;
      },
    }), state.shotId);
    assert.equal(projected.generateAudio, true);
    assert.equal(projected.identityBindings.length, 2);
    assert.equal(projected.referenceImageUrls.length, 2);
    assert.match(projected.prompt, /Dialogue mode: silent\./);
    assert.match(projected.prompt, /Do not generate spoken dialogue, voiceover, narration, chanting, or intelligible vocalization\./);
    assert.match(projected.prompt, /Generate only scene-appropriate non-speech ambience and action sound effects\./);
    assert.equal(projected.prompt.includes('English dialogue timing:'), false);
    assert.equal(projected.prompt.includes('Generate synchronized US English speech audio'), false);
    assert.equal(/[\u3400-\u9fff]/.test(projected.prompt), false);
    assert.equal(projected.prompt.includes('source/source.mp4'), false);
    assert.equal(projected.prompt.includes('http://'), false);
    assert.equal(projected.prompt.includes('https://'), false);
    assert.equal(projected.prompt.includes('sk-'), false);
    assert.equal(projected.prompt.includes('Authorization'), false);
    assert.deepEqual(projected.referenceBundleSnapshot, {
      schema_version: 'redraw-reference-bundle-v2',
      coverage_sha256: loaded.bundle.coverage_sha256,
      source_sha256: SOURCE_FINGERPRINT,
      motion_sha256: MOTION_SHA256,
      dialogue_kind: 'silent',
      speech_required: false,
      source_dialogue_sha256: loaded.bundle.dialogue.source_dialogue_sha256,
      dialogue_script_sha256: loaded.bundle.dialogue.script_sha256,
      character_name_map_sha256: loaded.bundle.dialogue.character_name_map_sha256,
      localization_binding_sha256: loaded.bundle.dialogue.localization_binding_sha256,
    });
  } finally {
    state.cleanup();
  }
});

test('源与本地化对白空值不一致、非法 JSON 或非数组时拒绝且不写入', async () => {
  const cases = [
    { name: 'source only empty', overrides: { sourceDialogue: [] } },
    { name: 'localized only empty', overrides: { dialogue: [] } },
    { name: 'source invalid json', overrides: { source_dialogue_json: '{' } },
    { name: 'localized invalid json', overrides: { localized_dialogue_json: '[' } },
    { name: 'source non-array', overrides: { source_dialogue_json: '{}' } },
    { name: 'localized non-array', overrides: { localized_dialogue_json: '"dialogue"' } },
    { name: 'source speaker empty', overrides: { sourceDialogue: [{ speaker_id: ' ', text: '跟我走。', start_ms: 0, end_ms: 2400 }] } },
    { name: 'source text empty', overrides: { sourceDialogue: [{ speaker_id: 'character-001', text: ' ', start_ms: 0, end_ms: 2400 }] } },
    { name: 'source time non-integer', overrides: { sourceDialogue: [{ speaker_id: 'character-001', text: '跟我走。', start_ms: 0.5, end_ms: 2400 }] } },
    { name: 'source time out of duration', overrides: { sourceDialogue: [{ speaker_id: 'character-001', text: '跟我走。', start_ms: 0, end_ms: 5001 }] } },
    { name: 'localized text empty', overrides: { dialogue: [{ speaker_id: 'character-001', localized_text: ' ', start_ms: 0, end_ms: 2400 }] } },
    { name: 'localized Chinese residue', overrides: { dialogue: [{
      speaker_id: 'character-001', source_text: 'source audit', localized_text: '等一下。',
      start_ms: 0, end_ms: 2400, emotion: null, estimated_duration_ms: 600,
    }] } },
    { name: 'localized text object', overrides: { dialogue: [{
      speaker_id: 'character-001', localized_text: { text: '等一下。' }, start_ms: 0, end_ms: 2400,
    }] } },
    { name: 'localized text array', overrides: { dialogue: [{
      speaker_id: 'character-001', localized_text: ['Wait.'], start_ms: 0, end_ms: 2400,
    }] } },
    { name: 'localized text number', overrides: { dialogue: [{
      speaker_id: 'character-001', localized_text: 123, start_ms: 0, end_ms: 2400,
    }] } },
    { name: 'target text alias', overrides: { dialogue: [{
      speaker_id: 'character-001', target_text: 'Wait.', start_ms: 0, end_ms: 2400,
    }] } },
    { name: 'text alias', overrides: { dialogue: [{
      speaker_id: 'character-001', text: 'Wait.', start_ms: 0, end_ms: 2400,
    }] } },
    { name: 'localized time out of duration', overrides: { dialogue: [{ speaker_id: 'character-001', localized_text: 'Wait.', start_ms: 0, end_ms: 5001 }] } },
  ];
  for (const entry of cases) {
    const state = setup(entry.overrides);
    try {
      await assertRejectsUnchanged(
        state,
        validInput(state),
        'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
      );
    } finally {
      state.cleanup();
    }
  }
});

test('spoken 对白拒绝六种精确静默伪装文本且不写入', async () => {
  const tokens = [' SILENCE ', ' [SILENCE] ', '(silence)', ' silent ', 'no   dialogue', ' [no\tdialogue] '];
  for (const localizedText of tokens) {
    const state = setup({
      dialogue: [{ speaker_id: 'character-001', localized_text: localizedText, start_ms: 0, end_ms: 1000 }],
    });
    try {
      await assertRejectsUnchanged(
        state,
        validInput(state),
        'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
      );
    } finally {
      state.cleanup();
    }
  }
});

test('静默对白不绕过人脸、身份、文字或运动参考门禁', async () => {
  const state = setup({ sourceDialogue: [], dialogue: [] });
  try {
    await assertRejectsUnchanged(
      state,
      mutateInput(state, (input) => { input.face_tracks.pop(); }),
      'REDRAW_REFERENCE_BUNDLE_FACE_COVERAGE_REQUIRED',
    );

    updateRedrawAsset(state.db, state.actorAId, { approval_status: 'pending' });
    await assertRejectsUnchanged(
      state,
      validInput(state),
      'REDRAW_REFERENCE_BUNDLE_IDENTITY_PACK_REQUIRED',
    );
    updateRedrawAsset(state.db, state.actorAId, { approval_status: 'approved' });

    updateRedrawAsset(state.db, state.subtitleCleanId, { approval_status: 'pending' });
    await assertRejectsUnchanged(
      state,
      validInput(state),
      'REDRAW_REFERENCE_BUNDLE_TEXT_COVERAGE_REQUIRED',
    );
    updateRedrawAsset(state.db, state.subtitleCleanId, { approval_status: 'approved' });

    updateJsonColumn(state.db, 'assets', state.motionAssetId, 'metadata', (metadata) => {
      metadata.redraw_motion_reference.source_fingerprint = '0'.repeat(64);
    });
    await assertRejectsUnchanged(
      state,
      validInput(state),
      'REDRAW_REFERENCE_BUNDLE_MOTION_REFERENCE_STALE',
    );
  } finally {
    state.cleanup();
  }
});

test('旧包缺少对白模式字段时即使重算哈希也拒绝重读和投影且不升级 DB', async () => {
  const state = setup();
  try {
    await saveReferenceBundle(ctx(state), validInput(state));
    const legacyBundle = JSON.parse(currentShot(state.db, state.shotId).reference_bundle_json);
    delete legacyBundle.dialogue.kind;
    delete legacyBundle.dialogue.speech_required;
    state.db.prepare('UPDATE redraw_shots SET reference_bundle_json = ?, reference_bundle_hash = ? WHERE id = ?')
      .run(JSON.stringify(legacyBundle), canonicalBundleHash(legacyBundle), state.shotId);
    const before = currentShot(state.db, state.shotId);

    const loadError = await captureAnyError(() => loadCurrentReferenceBundle(ctx(state), state.shotId));
    assert.equal(loadError.code, 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED');
    const projectionError = await captureAnyError(() => projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl() {
        return '/static/redraw-reference/unused';
      },
    }), state.shotId));
    assert.equal(projectionError.code, 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED');
    assertShotUnchanged(state.db, state.shotId, before);
  } finally {
    state.cleanup();
  }
});

test('重读参考包时拒绝保存后仍有效的身份证据漂移', async () => {
  const state = setup();
  try {
    await saveReferenceBundle(ctx(state), validInput(state));
    const before = currentShot(state.db, state.shotId);
    updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
      payload.identity_pack.target_actor_label = 'Actor Ethan II';
      recalcIdentityPackHash(payload);
    });
    updateRedrawAsset(state.db, state.actorAId, { localized_name: 'Actor Ethan II' });

    const loadError = await captureAnyError(() => loadCurrentReferenceBundle(ctx(state), state.shotId));
    assert.equal(loadError.code, 'REDRAW_REFERENCE_BUNDLE_IDENTITY_PACK_REQUIRED');

    const projectionError = await captureAnyError(() => projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl() {
        return '/static/redraw-reference/unused';
      },
    }), state.shotId));
    assert.equal(projectionError.code, 'REDRAW_REFERENCE_BUNDLE_IDENTITY_PACK_REQUIRED');
    assertShotUnchanged(state.db, state.shotId, before);
  } finally {
    state.cleanup();
  }
});

test('重读参考包时拒绝保存后仍有效的文字净景证据漂移', async () => {
  const state = setup();
  try {
    await saveReferenceBundle(ctx(state), validInput(state));
    const before = currentShot(state.db, state.shotId);
    updateJsonColumn(state.db, 'redraw_assets', state.subtitleCleanId, 'source_ref_json', (payload) => {
      payload.text_clean_plate_pack.reviewed_at = '2026-08-14T00:06:00.000Z';
      recalcTextCleanPackHash(payload);
    });

    const loadError = await captureAnyError(() => loadCurrentReferenceBundle(ctx(state), state.shotId));
    assert.equal(loadError.code, 'REDRAW_REFERENCE_BUNDLE_TEXT_COVERAGE_REQUIRED');
    assertShotUnchanged(state.db, state.shotId, before);
  } finally {
    state.cleanup();
  }
});

test('V2 目标绑定任一当前组成漂移都拒绝旧参考包', async () => {
  const cases = [
    ['name map', (state) => state.db.prepare('UPDATE redraw_versions SET name_map_json = ? WHERE id = ?')
      .run(JSON.stringify({ 'character-001': 'Ethan II', 'character-002': 'Maya' }), state.versionId)],
    ['localized dialogue', (state) => state.db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE id = ?')
      .run(JSON.stringify([{ speaker_id: 'character-001', localized_text: 'Wait.', start_ms: 0, end_ms: 2400 }]), state.shotId)],
    ['source dialogue', (state) => state.db.prepare('UPDATE redraw_shots SET source_dialogue_json = ? WHERE id = ?')
      .run(JSON.stringify([{ speaker_id: 'character-001', text: '等一下。', start_ms: 0, end_ms: 2400 }]), state.shotId)],
    ['locale', (state) => state.db.prepare("UPDATE redraw_versions SET locale = 'es-MX' WHERE id = ?").run(state.versionId)],
    ['market', (state) => state.db.prepare("UPDATE redraw_versions SET market = 'MX' WHERE id = ?").run(state.versionId)],
    ['facts hash', (state) => {
      state.db.exec('DROP TRIGGER redraw_versions_facts_immutable_update');
      state.db.prepare('UPDATE redraw_versions SET facts_hash = ? WHERE id = ?').run('f'.repeat(64), state.versionId);
    }],
    ['timeline', (state) => state.db.prepare('UPDATE redraw_shots SET end_ms = 4900, duration_ms = 4900 WHERE id = ?')
      .run(state.shotId)],
  ];
  for (const [name, mutate] of cases) {
    const state = setup();
    try {
      await saveReferenceBundle(ctx(state), validInput(state));
      mutate(state);
      await assert.rejects(
        () => loadCurrentReferenceBundle(ctx(state), state.shotId),
        (error) => error.code === 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
        name,
      );
    } finally {
      state.cleanup();
    }
  }
});

test('旧 V1 包即使重算 bundle hash 也要求重建', async () => {
  const state = setup();
  try {
    await saveReferenceBundle(ctx(state), validInput(state));
    const legacy = JSON.parse(currentShot(state.db, state.shotId).reference_bundle_json);
    legacy.schema_version = 'redraw-reference-bundle-v1';
    delete legacy.dialogue.source_dialogue_sha256;
    delete legacy.dialogue.localization_binding_sha256;
    state.db.prepare('UPDATE redraw_shots SET reference_bundle_json = ?, reference_bundle_hash = ? WHERE id = ?')
      .run(JSON.stringify(legacy), canonicalBundleHash(legacy), state.shotId);

    await assert.rejects(
      () => loadCurrentReferenceBundle(ctx(state), state.shotId),
      (error) => error.code === 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND',
    );
  } finally {
    state.cleanup();
  }
});

test('重读参考包时将已存包哈希不一致报告为冲突且投影保留根因', async () => {
  const state = setup();
  try {
    await saveReferenceBundle(ctx(state), validInput(state));
    const before = currentShot(state.db, state.shotId);
    const bundle = JSON.parse(before.reference_bundle_json);
    bundle.coverage_sha256 = '0'.repeat(64);
    state.db.prepare('UPDATE redraw_shots SET reference_bundle_json = ? WHERE id = ?')
      .run(JSON.stringify(bundle), state.shotId);
    const afterTamper = currentShot(state.db, state.shotId);

    const loadError = await captureAnyError(() => loadCurrentReferenceBundle(ctx(state), state.shotId));
    assert.equal(loadError.code, 'REDRAW_REFERENCE_BUNDLE_CONFLICT');

    const projectionError = await captureAnyError(() => projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl() {
        return '/static/redraw-reference/unused';
      },
    }), state.shotId));
    assert.equal(projectionError.code, 'REDRAW_REFERENCE_BUNDLE_CONFLICT');
    assertShotUnchanged(state.db, state.shotId, afterTamper);
  } finally {
    state.cleanup();
  }
});

test('投影允许 HTTPS 参考 URL 并拒绝源 URL 相同或非 HTTPS 外链', async () => {
  const httpsState = setup();
  try {
    await saveReferenceBundle(ctx(httpsState), validInput(httpsState));
    const projected = await projectReferenceBundleForGeneration(ctx(httpsState, {
      createReferenceUrl({ asset_id: assetId, kind }) {
        return `https://cdn.example.test/redraw/${kind}/${assetId}.png`;
      },
    }), httpsState.shotId);
    assert.equal(projected.referenceVideoUrl.startsWith('https://cdn.example.test/'), true);
    assert.equal(projected.referenceImageUrls.every((url) => url.startsWith('https://cdn.example.test/')), true);
  } finally {
    httpsState.cleanup();
  }

  const sameSourceState = setup();
  try {
    await saveReferenceBundle(ctx(sameSourceState), validInput(sameSourceState));
    const sourceUrl = 'https://cdn.example.test/source/original.mp4';
    sameSourceState.db.prepare('UPDATE assets SET url = ? WHERE id = ?').run(sourceUrl, sameSourceState.sourceAssetId);
    const error = await captureAnyError(() => projectReferenceBundleForGeneration(ctx(sameSourceState, {
      createReferenceUrl() {
        return sourceUrl;
      },
    }), sameSourceState.shotId));
    assert.equal(error.code, 'REDRAW_REFERENCE_BUNDLE_PROJECTION_FAILED');
    assert.equal(JSON.stringify(error).includes(sourceUrl), false);
  } finally {
    sameSourceState.cleanup();
  }

  const httpState = setup();
  try {
    await saveReferenceBundle(ctx(httpState), validInput(httpState));
    const leakedUrl = 'http://cdn.example.test/redraw/identity/201.png';
    const error = await captureAnyError(() => projectReferenceBundleForGeneration(ctx(httpState, {
      createReferenceUrl() {
        return leakedUrl;
      },
    }), httpState.shotId));
    assert.equal(error.code, 'REDRAW_REFERENCE_BUNDLE_PROJECTION_FAILED');
    assert.equal(JSON.stringify(error).includes(leakedUrl), false);
  } finally {
    httpState.cleanup();
  }
});

test('文字覆盖允许无文字、片段 gap 和不同区域重叠', async () => {
  const cases = [
    {
      name: 'zero text',
      mutate(input) {
        input.text_regions = [];
        input.coverage_review.recognizable_text_region_count = 0;
        input.coverage_review.mapped_text_region_count = 0;
      },
      assertBundle(bundle) {
        assert.deepEqual(bundle.text_regions, []);
      },
    },
    {
      name: 'single text gap',
      mutate(input) {
        input.text_regions = [{
          region_key: 'text-001',
          kind: 'text_subtitle',
          time_ranges: [[1000, 2000]],
          text_clean_redraw_asset_id: 203,
        }];
        input.coverage_review.recognizable_text_region_count = 1;
        input.coverage_review.mapped_text_region_count = 1;
      },
      assertBundle(bundle) {
        assert.deepEqual(bundle.text_regions[0].time_ranges, [[1000, 2000]]);
      },
    },
    {
      name: 'overlap across regions',
      mutate(input) {
        input.text_regions[0].time_ranges = [[0, 3000]];
        input.text_regions[1].time_ranges = [[2000, 5000]];
      },
      assertBundle(bundle) {
        assert.deepEqual(bundle.text_regions.map((entry) => entry.time_ranges), [[[2000, 5000]], [[0, 3000]]]);
      },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      const input = validInput(state);
      entry.mutate(input);
      syncMotionTextCoverage(state, input);
      const saved = await saveReferenceBundle(ctx(state), input);
      assert.match(saved.reference_bundle_hash, /^[0-9a-f]{64}$/);
      entry.assertBundle(saved.bundle);
    } finally {
      state.cleanup();
    }
  }
});

test('人脸覆盖缺失、重复、非法时间、未批准或 unresolved 时拒绝且不写入', async () => {
  const cases = [
    {
      name: 'missing face',
      mutate(input) { input.face_tracks.pop(); },
    },
    {
      name: 'duplicate face',
      mutate(input) { input.face_tracks[1].track_key = 'face-002'; },
    },
    {
      name: 'invalid range',
      mutate(input) { input.face_tracks[0].time_ranges = [[5000, 2500]]; },
    },
    {
      name: 'coverage not approved',
      mutate(input) { input.coverage_review.status = 'pending'; },
    },
    {
      name: 'count mismatch',
      mutate(input) { input.coverage_review.mapped_face_count = 1; },
    },
    {
      name: 'unresolved face',
      mutate(input) { input.coverage_review.unresolved_face_count = 1; },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      await assertRejectsUnchanged(
        state,
        mutateInput(state, entry.mutate),
        'REDRAW_REFERENCE_BUNDLE_FACE_COVERAGE_REQUIRED',
      );
    } finally {
      state.cleanup();
    }
  }
});

test('角色身份一对一映射与 9 个引用上限 fail closed', async () => {
  const cases = [
    {
      code: 'REDRAW_REFERENCE_BUNDLE_FACE_COVERAGE_REQUIRED',
      mutate(input) { input.face_tracks[1].identity_redraw_asset_id = input.face_tracks[0].identity_redraw_asset_id; },
    },
    {
      code: 'REDRAW_REFERENCE_BUNDLE_FACE_COVERAGE_REQUIRED',
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.actorBId, 'source_ref_json', (payload) => {
          payload.source_ref.stable_id = 'character-001';
          payload.identity_pack.source_character_key = 'character-001';
          recalcIdentityPackHash(payload);
        });
      },
      mutate(input) { input.face_tracks[0].source_character_key = 'character-001'; },
    },
    {
      code: 'REDRAW_REFERENCE_BUNDLE_REFERENCE_LIMIT_EXCEEDED',
      mutate(input) {
        input.face_tracks = Array.from({ length: 10 }, (_, index) => ({
          track_key: `face-${String(index + 1).padStart(3, '0')}`,
          source_character_key: `character-${String(index + 1).padStart(3, '0')}`,
          time_ranges: [[0, 5000]],
          identity_redraw_asset_id: 200 + index,
        }));
        input.coverage_review.recognizable_face_count = 10;
        input.coverage_review.mapped_face_count = 10;
      },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      if (entry.mutateDb) entry.mutateDb(state);
      await assertRejectsUnchanged(state, mutateInput(state, entry.mutate), entry.code);
    } finally {
      state.cleanup();
    }
  }
});

test('身份包缺视图、未批准、非成年、非虚构 AI、非 US 或哈希漂移时拒绝', async () => {
  const cases = [
    {
      name: 'missing views',
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
          payload.identity_pack.confirmed_views = ['front', 'profile'];
          recalcIdentityPackHash(payload);
        });
      },
    },
    {
      name: 'not approved',
      mutateDb(state) { updateRedrawAsset(state.db, state.actorAId, { approval_status: 'pending' }); },
    },
    {
      name: 'not adult',
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
          payload.identity_pack.adult_status = 'unknown';
          recalcIdentityPackHash(payload);
        });
      },
    },
    {
      name: 'not fictional ai',
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
          payload.identity_pack.persona_origin = 'real_person';
          recalcIdentityPackHash(payload);
        });
      },
    },
    {
      name: 'not US',
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
          payload.identity_pack.target_country = 'GB';
          recalcIdentityPackHash(payload);
        });
      },
    },
    {
      name: 'hash drift',
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
          payload.identity_pack.target_actor_label = 'Drifted Actor';
        });
      },
    },
    {
      name: 'wardrobe hash drift',
      mutateDb(state) {
        fs.writeFileSync(path.join(state.storageRoot, 'redraw', 'wardrobe-1301.png'), Buffer.from('drifted wardrobe'));
      },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      entry.mutateDb(state);
      await assertRejectsUnchanged(
        state,
        validInput(state),
        'REDRAW_REFERENCE_BUNDLE_IDENTITY_PACK_REQUIRED',
      );
    } finally {
      state.cleanup();
    }
  }
});

test('文字净景缺失、重复、数量、unresolved、类型、时间、审批或哈希异常时拒绝', async () => {
  const cases = [
    {
      name: 'missing text',
      mutate(input) { input.text_regions.pop(); },
    },
    {
      name: 'duplicate text',
      mutate(input) { input.text_regions[1].region_key = 'text-002'; },
    },
    {
      name: 'count mismatch',
      mutate(input) { input.coverage_review.mapped_text_region_count = 1; },
    },
    {
      name: 'unresolved text',
      mutate(input) { input.coverage_review.unresolved_text_region_count = 1; },
    },
    {
      name: 'kind mismatch',
      mutate(input) { input.text_regions[0].kind = 'text_subtitle'; },
    },
    {
      name: 'same region overlap',
      mutate(input) { input.text_regions[1].time_ranges = [[2500, 4000], [3900, 5000]]; },
    },
    {
      name: 'not approved',
      mutateDb(state) { updateRedrawAsset(state.db, state.subtitleCleanId, { approval_status: 'pending' }); },
    },
    {
      name: 'hash drift',
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.subtitleCleanId, 'source_ref_json', (payload) => {
          payload.text_clean_plate_pack.kind = 'text_screen';
        });
      },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      if (entry.mutateDb) entry.mutateDb(state);
      await assertRejectsUnchanged(
        state,
        entry.mutate ? mutateInput(state, entry.mutate) : validInput(state),
        'REDRAW_REFERENCE_BUNDLE_TEXT_COVERAGE_REQUIRED',
      );
    } finally {
      state.cleanup();
    }
  }
});

test('无效语言市场、姓名映射、对白绑定或 facts hash 时拒绝', async () => {
  const cases = [
    {
      name: 'locale missing',
      setup: () => setup({ locale: '' }),
    },
    {
      name: 'market missing',
      setup: () => setup({ market: '' }),
    },
    {
      name: 'market invalid',
      setup: () => setup({ market: 'usa' }),
    },
    {
      name: 'identity country mismatch',
      setup: () => setup({ locale: 'es-ES', market: 'ES' }),
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
          payload.identity_pack.target_country = 'US';
          recalcIdentityPackHash(payload);
        });
      },
      code: 'REDRAW_REFERENCE_BUNDLE_IDENTITY_PACK_REQUIRED',
    },
    {
      name: 'name missing',
      setup: () => setup({ nameMap: { 'character-001': 'Ethan' } }),
    },
    {
      name: 'dialogue speaker unbound',
      setup: () => setup({ dialogue: [{ speaker_id: 'character-999', localized_text: 'Wait.', start_ms: 0, end_ms: 1000 }] }),
    },
    {
      name: 'facts hash invalid',
      setup: () => setup({ factsHash: 'not-a-sha256' }),
    },
    {
      name: 'name map duplicate trimmed key',
      setup: () => setup({
        nameMap: { 'character-001': 'Ethan', ' character-001 ': 'Ethan II', 'character-002': 'Maya' },
      }),
    },
    {
      name: 'name map Chinese target',
      setup: () => setup({ nameMap: { 'character-001': '伊森', 'character-002': 'Maya' } }),
    },
  ];
  for (const entry of cases) {
    const state = entry.setup();
    try {
      if (entry.mutateDb) entry.mutateDb(state);
      await assertRejectsUnchanged(
        state,
        validInput(state),
        entry.code || 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
      );
    } finally {
      state.cleanup();
    }
  }
});

test('跨租户用户不可见且不会写入镜头', async () => {
  const state = setup();
  try {
    await assertRejectsUnchanged(
      state,
      validInput(state),
      'REDRAW_REFERENCE_BUNDLE_NOT_FOUND',
      { tenantId: 'tenant-b' },
    );
    await assertRejectsUnchanged(
      state,
      validInput(state),
      'REDRAW_REFERENCE_BUNDLE_NOT_FOUND',
      { userId: 'user-b' },
    );
  } finally {
    state.cleanup();
  }
});

test('缺少 expected_updated_at 或 CAS 冲突时拒绝', async () => {
  const cases = [
    {
      name: 'missing expected_updated_at',
      mutate(input) { delete input.expected_updated_at; },
    },
    {
      name: 'cas conflict',
      mutate(input) { input.expected_updated_at = '2026-08-13T00:00:00.000Z'; },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      await assertRejectsUnchanged(
        state,
        mutateInput(state, entry.mutate),
        'REDRAW_REFERENCE_BUNDLE_CONFLICT',
      );
    } finally {
      state.cleanup();
    }
  }
});

test('未知字段、客户端 hash、路径、URL、reviewer 或 status 注入时拒绝', async () => {
  const cases = [
    {
      name: 'unknown field',
      mutate(input) { input.client_note = 'unknown'; },
    },
    {
      name: 'client hash',
      mutate(input) { input.reference_bundle_hash = 'f'.repeat(64); },
    },
    {
      name: 'path',
      forbiddenValues: ['secret', 'reference.mp4'],
      mutate(input) { input.local_path = 'C:\\secret\\reference.mp4'; },
    },
    {
      name: 'url',
      forbiddenValues: ['example.test', 'private.png'],
      mutate(input) { input.url = 'https://example.test/private.png'; },
    },
    {
      name: 'reviewer',
      mutate(input) { input.reviewed_by = 'client-reviewer'; },
    },
    {
      name: 'status',
      mutate(input) { input.status = 'approved'; },
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      await assertRejectsUnchanged(
        state,
        mutateInput(state, entry.mutate),
        'REDRAW_REFERENCE_BUNDLE_INPUT_INVALID',
        {},
        entry.forbiddenValues || [],
      );
    } finally {
      state.cleanup();
    }
  }
});
