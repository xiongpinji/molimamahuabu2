const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { saveReferenceBundle } = require('../src/services/redrawReferenceBundleService');

const INITIAL_UPDATED_AT = '2026-08-14T00:00:00.000Z';
const REVIEWED_AT = '2026-08-14T00:05:00.000Z';
const SOURCE_FINGERPRINT = '1'.repeat(64);
const MOTION_SHA256 = '2'.repeat(64);
const FACE_COVERAGE_SHA256 = '3'.repeat(64);
const TEXT_COVERAGE_SHA256 = '4'.repeat(64);

function setup(overrides = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = INITIAL_UPDATED_AT;
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
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 'reference bundle work', ?, ?, 5000, ?, ?)`)
    .run(projectId, sourceAssetId, SOURCE_FINGERPRINT, now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, name_map_json, source_facts_json,
     facts_hash, reference_bundle_required, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, ?, ?, ?, ?, ?, 1, 'asset_review', ?, ?)`)
    .run(
      workId,
      overrides.locale || 'en-US',
      overrides.market || 'US',
      JSON.stringify(overrides.nameMap || { 'character-001': 'Ethan', 'character-002': 'Maya' }),
      JSON.stringify(sourceFacts(overrides.sourceFacts || {})),
      factsHash(sourceFacts(overrides.sourceFacts || {})),
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
      JSON.stringify([{ speaker_id: 'character-001', text: '跟我走。', start_ms: 0, end_ms: 2400 }]),
      JSON.stringify(overrides.dialogue || [
        { speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 0, end_ms: 2400 },
        { speaker_id: 'character-002', localized_text: 'Not without proof.', start_ms: 2500, end_ms: 5000 },
      ]),
      now,
      now,
    ).lastInsertRowid);

  const actorAId = insertCharacterRedrawAsset(db, versionId, {
    id: 201,
    sourceCharacterKey: 'character-001',
    targetActorLabel: 'Actor Ethan',
    assetId: 301,
    sha256: 'a'.repeat(64),
  });
  const actorBId = insertCharacterRedrawAsset(db, versionId, {
    id: 202,
    sourceCharacterKey: 'character-002',
    targetActorLabel: 'Actor Maya',
    assetId: 302,
    sha256: 'b'.repeat(64),
  });
  const subtitleCleanId = insertTextCleanAsset(db, versionId, {
    id: 203,
    regionKey: 'text-001',
    kind: 'text_subtitle',
    assetId: 303,
    sha256: 'c'.repeat(64),
  });
  const screenCleanId = insertTextCleanAsset(db, versionId, {
    id: 204,
    regionKey: 'text-002',
    kind: 'text_screen',
    assetId: 304,
    sha256: 'd'.repeat(64),
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

function sourceFacts(overrides = {}) {
  return {
    script_sha256: '5'.repeat(64),
    name_map_source_sha256: '6'.repeat(64),
    dialogue_sha256: '7'.repeat(64),
    ...overrides,
  };
}

function factsHash(value) {
  return sha256(stableJson(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function insertAsset(db, input) {
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

function identityPack(input = {}) {
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
  pack.pack_sha256 = input.packSha256 || sha256(stableJson({
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
  }));
  return pack;
}

function insertCharacterRedrawAsset(db, versionId, input) {
  insertAsset(db, {
    id: input.assetId,
    localPath: `redraw/identity-${input.assetId}.png`,
    mimeType: 'image/png',
    sha256: input.sha256,
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
    now: REVIEWED_AT,
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

async function assertRejectsUnchanged(state, input, code, contextOverrides = {}) {
  const before = currentShot(state.db, state.shotId);
  const error = await captureError(() => saveReferenceBundle(ctx(state, contextOverrides), input));
  assert.equal(error.code, code);
  assertShotUnchanged(state.db, state.shotId, before);
  assert.equal(JSON.stringify(error).includes('C:\\'), false);
  assert.equal(JSON.stringify(error).includes('Authorization'), false);
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
    assert.equal(bundle.schema_version, 'redraw-reference-bundle-v1');
    assert.equal(bundle.locale, 'en-US');
    assert.equal(bundle.market, 'US');
    assert.deepEqual(bundle.face_tracks.map((entry) => entry.track_key), ['face-001', 'face-002']);
    assert.deepEqual(bundle.text_regions.map((entry) => entry.region_key), ['text-001', 'text-002']);
    assert.deepEqual(bundle.dialogue.map((entry) => entry.speaker_id), ['character-001', 'character-002']);
    assert.deepEqual(bundle.name_map, { 'character-001': 'Ethan', 'character-002': 'Maya' });
    assert.match(bundle.coverage_sha256, /^[0-9a-f]{64}$/);

    const serialized = JSON.stringify(bundle);
    assert.equal(/[\u3400-\u9fff]/.test(serialized), false);
    assert.equal(/[A-Za-z]:[\\/]/.test(serialized), false);
    assert.equal(serialized.includes('sk-'), false);
    assert.equal(serialized.includes('Authorization'), false);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes('http://'), false);
  } finally {
    state.db.close();
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
        'REDRAW_REFERENCE_BUNDLE_FACE_INVALID',
      );
    } finally {
      state.db.close();
    }
  }
});

test('角色身份一对一映射与 9 个引用上限 fail closed', async () => {
  const cases = [
    {
      code: 'REDRAW_REFERENCE_BUNDLE_FACE_INVALID',
      mutate(input) { input.face_tracks[1].identity_redraw_asset_id = input.face_tracks[0].identity_redraw_asset_id; },
    },
    {
      code: 'REDRAW_REFERENCE_BUNDLE_FACE_INVALID',
      mutate(input) { input.face_tracks[1].source_character_key = 'character-001'; },
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
      await assertRejectsUnchanged(state, mutateInput(state, entry.mutate), entry.code);
    } finally {
      state.db.close();
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
        });
      },
    },
    {
      name: 'not fictional ai',
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
          payload.identity_pack.persona_origin = 'real_person';
        });
      },
    },
    {
      name: 'not US',
      mutateDb(state) {
        updateJsonColumn(state.db, 'redraw_assets', state.actorAId, 'source_ref_json', (payload) => {
          payload.identity_pack.target_country = 'GB';
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
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      entry.mutateDb(state);
      await assertRejectsUnchanged(
        state,
        validInput(state),
        'REDRAW_REFERENCE_BUNDLE_IDENTITY_INVALID',
      );
    } finally {
      state.db.close();
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
      name: 'time gap',
      mutate(input) { input.text_regions[1].time_ranges = [[3000, 5000]]; },
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
        'REDRAW_REFERENCE_BUNDLE_TEXT_INVALID',
      );
    } finally {
      state.db.close();
    }
  }
});

test('语言市场、名字映射、对白绑定或剧本证据漂移时拒绝', async () => {
  const cases = [
    {
      name: 'locale drift',
      setup: () => setup({ locale: 'zh-CN' }),
    },
    {
      name: 'market drift',
      setup: () => setup({ market: 'CN' }),
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
      name: 'script drift',
      setup: () => setup({ sourceFacts: { script_sha256: '8'.repeat(64) } }),
      mutateDb(state) {
        state.db.prepare("UPDATE redraw_versions SET source_facts_json = json_set(source_facts_json, '$.script_sha256', ?) WHERE id = ?")
          .run('9'.repeat(64), state.versionId);
      },
    },
    {
      name: 'name map drift',
      setup: () => setup(),
      mutateDb(state) {
        state.db.prepare('UPDATE redraw_versions SET name_map_json = ? WHERE id = ?')
          .run(JSON.stringify({ 'character-001': 'Ethan', 'character-002': 'Mia' }), state.versionId);
      },
    },
  ];
  for (const entry of cases) {
    const state = entry.setup();
    try {
      if (entry.mutateDb) entry.mutateDb(state);
      await assertRejectsUnchanged(
        state,
        validInput(state),
        'REDRAW_REFERENCE_BUNDLE_DIALOGUE_INVALID',
      );
    } finally {
      state.db.close();
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
    state.db.close();
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
      state.db.close();
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
      mutate(input) { input.local_path = 'C:\\secret\\reference.mp4'; },
    },
    {
      name: 'url',
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
      );
    } finally {
      state.db.close();
    }
  }
});
