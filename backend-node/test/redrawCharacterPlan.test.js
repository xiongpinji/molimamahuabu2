const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { saveIdentityPack } = require('../src/services/redrawCharacterIdentityService');
const {
  assertCharacterPlanReady,
  buildCharacterPlan,
} = require('../src/services/redrawCharacterPlanService');

const NOW = '2026-08-22T00:00:00.000Z';
const TTS_CONFIG_ID = 91;
const TTS_CONFIG_UPDATED_AT = '2026-08-20T00:00:00.000Z';
const MODEL_SHA = 'a'.repeat(64);
const CALIBRATION_SHA = 'b'.repeat(64);
const TRANSCRIPT_SHA = 'd'.repeat(64);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function defaultSourceFacts() {
  return {
    characters: [
      { source_character_key: 'char-b', target_name: 'Brian Miller', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
      { source_character_key: 'char-a', target_name: 'Alice Carter', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
    ],
  };
}

function setup(sourceFacts = defaultSourceFacts()) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-character-plan-'));
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '角色计划项目', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', '角色计划作品', 1, 'source-a', 15000, ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO dramas
    (id, title, tenant_id, user_id, created_at, updated_at)
    VALUES (11, 'same owner', 'tenant-a', 'user-a', ?, ?)`).run(NOW, NOW);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json, facts_hash,
     name_map_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', ?, 'facts-a', '{}',
      'asset_review', ?, ?)`)
    .run(workId, typeof sourceFacts === 'string' ? sourceFacts : JSON.stringify(sourceFacts), NOW, NOW);
  db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, name, model, default_model, is_active, created_at, updated_at)
    VALUES (?, 'tts', 'fake-tts', 'TTS', ?, 'model-tts', 1, ?, ?)`)
    .run(TTS_CONFIG_ID, JSON.stringify(['model-tts']), TTS_CONFIG_UPDATED_AT, TTS_CONFIG_UPDATED_AT);
  return { db, root, versionId: Number(db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id) };
}

function close(state, extraPaths = []) {
  state.db.close();
  fs.rmSync(state.root, { recursive: true, force: true });
  for (const extraPath of extraPaths) fs.rmSync(extraPath, { recursive: true, force: true });
}

function context(state, overrides = {}) {
  return {
    db: state.db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: state.versionId,
    storageRoot: state.root,
    now: NOW,
    localeRegistry: {
      assertEvidenceTrusted(evidence) {
        assert.equal(evidence.source, 'offline-worker');
        assert.equal(evidence.locale_pack, 'en-US@fixture');
        return evidence;
      },
    },
    assetReader: {
      canRead(asset) {
        return Boolean(asset?.local_path && fs.existsSync(path.join(state.root, asset.local_path)));
      },
    },
    ...overrides,
  };
}

function addProviderAsset(state, id, file, input = {}) {
  fs.writeFileSync(path.join(state.root, file), input.bytes || Buffer.from(`asset-${id}`));
  state.db.prepare(`INSERT INTO assets
    (id, drama_id, name, type, category, url, local_path, mime_type, width, height, duration, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'redraw', '', ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      Object.hasOwn(input, 'dramaId') ? input.dramaId : 11,
      input.name || `asset-${id}`,
      input.type || 'image',
      file,
      input.mimeType || 'image/png',
      input.width ?? 640,
      input.height ?? 960,
      input.duration ?? null,
      NOW,
      NOW,
    );
}

function addCharacter(state, sourceKey, targetName, input = {}) {
  addProviderAsset(state, input.assetId || sourceKey.charCodeAt(sourceKey.length - 1) + 100, `${sourceKey}.png`, {
    bytes: Buffer.from(`identity-${sourceKey}`),
  });
  addProviderAsset(state, input.wardrobeAssetId || sourceKey.charCodeAt(sourceKey.length - 1) + 200, `${sourceKey}-wardrobe.png`, {
    bytes: Buffer.from(`wardrobe-${sourceKey}`),
  });
  const assetId = input.assetId || sourceKey.charCodeAt(sourceKey.length - 1) + 100;
  const id = Number(state.db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name, localized_description,
     prompt, asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 'character', ?, ?, 'character', 'prompt', ?, 1,
      'approved', 'generated', ?, ?)`)
    .run(
      state.versionId,
      JSON.stringify({ source_ref: { source_character_key: sourceKey } }),
      targetName,
      assetId,
      NOW,
      NOW,
    ).lastInsertRowid);
  return saveIdentityPack(context(state), id, {
    expected_updated_at: NOW,
    target_actor_label: targetName,
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: input.adultStatus || 'verified_18_plus',
    identity_consistency_confirmed: true,
    persona_origin: input.personaOrigin || 'fictional_ai_generated',
    target_country: 'US',
    wardrobe_reference_asset_id: input.wardrobeAssetId || sourceKey.charCodeAt(sourceKey.length - 1) + 200,
    wardrobe_consistency_confirmed: input.wardrobeConfirmed !== false,
  });
}

function addVoice(state, sourceKey, input = {}) {
  const audioAssetId = input.audioAssetId || sourceKey.charCodeAt(sourceKey.length - 1) + 300;
  const audioBytes = Buffer.from(`voice-${sourceKey}`);
  addProviderAsset(state, audioAssetId, `${sourceKey}.mp3`, {
    type: 'audio',
    mimeType: 'audio/mpeg',
    duration: 3.2,
    width: null,
    height: null,
    bytes: audioBytes,
  });
  const evidence = {
    source: 'offline-worker',
    locale: input.locale || 'en-US',
    market: input.market || 'US',
    locale_pack: 'en-US@fixture',
    audio_sha256: input.audioSha256 || sha256(audioBytes),
    transcript_sha256: TRANSCRIPT_SHA,
    model_manifest_sha256: MODEL_SHA,
    calibration_manifest_sha256: CALIBRATION_SHA,
    asr_model_revision: 'asr-en-20260820',
    accent_model_revision: 'accent-en-20260820',
    metrics: { word_error_rate: 0, accent_confidence: 0.99 },
    completed_at: NOW,
    provider: 'fake-tts',
    model: 'model-tts',
    ai_service_config_id: TTS_CONFIG_ID,
    config_updated_at: TTS_CONFIG_UPDATED_AT,
    voice_id: `voice-${sourceKey}`,
    task_id: `task-${sourceKey}`,
    terminal_status: 'completed',
    audio_asset_id: audioAssetId,
    duration_ms: 3200,
    real_generation_verified: true,
    language_verified: input.languageVerified !== false,
    detected_locale: input.detectedLocale || input.locale || 'en-US',
    is_cloned: false,
    authorization_asset_id: null,
  };
  state.db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     voice_asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 'voice', ?, ?, ?, 1, ?, 'generated', ?, ?)`)
    .run(
      state.versionId,
      JSON.stringify({ source_ref: { source_character_key: sourceKey }, snapshot: { voice_evidence: evidence } }),
      `voice ${sourceKey}`,
      audioAssetId,
      input.approvalStatus || 'approved',
      NOW,
      NOW,
    );
  const character = state.db.prepare(`SELECT id, source_ref_json, updated_at FROM redraw_assets
    WHERE kind = 'character' AND version_id = ? AND localized_name = ?`)
    .get(state.versionId, sourceKey === 'char-a' ? 'Alice Carter' : 'Brian Miller');
  const payload = JSON.parse(character.source_ref_json);
  payload.snapshot = { ...(payload.snapshot || {}), voice_snapshot: evidence };
  state.db.prepare(`UPDATE redraw_assets SET voice_asset_id = ?, source_ref_json = ?, updated_at = ?
    WHERE id = ?`).run(audioAssetId, JSON.stringify(payload), `${NOW}.${sourceKey}`, character.id);
}

function makeReadyState(factPatch = null) {
  const facts = defaultSourceFacts();
  if (factPatch) {
    facts.characters = facts.characters.map((character) => (
      character.source_character_key === factPatch.sourceKey
        ? { ...character, ...factPatch.patch }
        : character
    ));
  }
  const state = setup(facts);
  addCharacter(state, 'char-b', 'Brian Miller');
  addCharacter(state, 'char-a', 'Alice Carter');
  addVoice(state, 'char-a');
  addVoice(state, 'char-b');
  return state;
}

test('buildCharacterPlan 返回严格白名单、稳定排序和 plan_hash', () => {
  const state = makeReadyState();
  try {
    const plan = buildCharacterPlan(context(state), state.versionId);

    assert.equal(plan.version_id, state.versionId);
    assert.equal(plan.ready, true);
    assert.deepEqual(plan.missing, []);
    assert.deepEqual(plan.characters.map((item) => item.source_character_key), ['char-a', 'char-b']);
    assert.deepEqual(Object.keys(plan).sort(), ['characters', 'missing', 'plan_hash', 'ready', 'version_id']);
    for (const character of plan.characters) {
      assert.deepEqual(Object.keys(character).sort(), [
        'adult_status',
        'identity_pack_sha256',
        'source_character_key',
        'target_name',
        'voice',
        'wardrobe',
      ]);
      assert.deepEqual(Object.keys(character.voice).sort(), ['asset_id', 'language', 'ready', 'sha256']);
      assert.deepEqual(Object.keys(character.wardrobe).sort(), ['asset_id', 'label', 'ready', 'sha256']);
      assert.equal(character.adult_status, 'verified_18_plus');
      assert.equal(character.voice.language, 'en-US');
      assert.equal(character.voice.ready, true);
      assert.equal(character.wardrobe.label, '整集主服装');
      assert.equal(character.wardrobe.ready, true);
      assert.match(character.identity_pack_sha256, /^[0-9a-f]{64}$/);
      assert.match(character.voice.sha256, /^[0-9a-f]{64}$/);
      assert.match(character.wardrobe.sha256, /^[0-9a-f]{64}$/);
    }
    assert.match(plan.plan_hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(plan).includes(state.root), false);
    assert.equal(JSON.stringify(plan).includes('source_ref_json'), false);
  } finally {
    close(state);
  }
});

test('assertCharacterPlanReady fail closed 并带稳定缺口', () => {
  const state = makeReadyState();
  try {
    state.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE kind = 'voice' AND localized_name = 'voice char-a'")
      .run();

    const plan = buildCharacterPlan(context(state), state.versionId);

    assert.equal(plan.ready, false);
    assert.deepEqual(plan.missing, ['char-a:voice_not_approved']);
    assert.throws(
      () => assertCharacterPlanReady(context(state), state.versionId),
      (error) => error.code === 'REDRAW_CHARACTER_PLAN_NOT_READY'
        && error.missing[0] === 'char-a:voice_not_approved',
    );
  } finally {
    close(state);
  }
});

test('assertCharacterPlanReady 不泄露完整计划、资产 ID、哈希和角色名', () => {
  const state = makeReadyState();
  try {
    state.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE kind = 'voice' AND localized_name = 'voice char-a'")
      .run();

    assert.throws(
      () => assertCharacterPlanReady(context(state), state.versionId),
      (error) => {
        const serialized = JSON.stringify(error);
        assert.equal(error.code, 'REDRAW_CHARACTER_PLAN_NOT_READY');
        assert.deepEqual(error.missing, ['char-a:voice_not_approved']);
        assert.equal(Object.hasOwn(error, 'plan'), false);
        assert.equal(serialized.includes('Alice Carter'), false);
        assert.equal(serialized.includes('identity_pack_sha256'), false);
        assert.equal(serialized.includes('asset_id'), false);
        assert.equal(serialized.includes('sha256'), false);
        return true;
      },
    );
  } finally {
    close(state);
  }
});

test('角色计划拒绝缺角色、重复键、目标名漂移和复用身份包', () => {
  const cases = [
    ['missing_character', (state) => state.db.prepare("DELETE FROM redraw_assets WHERE kind = 'character' AND localized_name = 'Alice Carter'").run()],
    ['duplicate_source_character_key', (state) => addCharacter(state, 'char-a', 'Alicia Carter', { assetId: 501, wardrobeAssetId: 601 })],
    ['target_name_mismatch', (state) => state.db.prepare("UPDATE redraw_assets SET localized_name = 'Alice Carter' WHERE kind = 'character' AND localized_name = 'Brian Miller'").run()],
    ['identity_pack_reused', (state) => {
      const first = state.db.prepare("SELECT source_ref_json FROM redraw_assets WHERE kind = 'character' AND localized_name = 'Alice Carter'").get();
      const payload = JSON.parse(first.source_ref_json);
      payload.source_ref = { source_character_key: 'char-b' };
      payload.identity_pack.source_character_key = 'char-b';
      state.db.prepare("UPDATE redraw_assets SET source_ref_json = ? WHERE kind = 'character' AND localized_name = 'Brian Miller'")
        .run(JSON.stringify(payload));
    }],
  ];
  for (const [reason, mutate] of cases) {
    const state = makeReadyState();
    try {
      mutate(state);
      const plan = buildCharacterPlan(context(state), state.versionId);
      assert.equal(plan.ready, false, reason);
      assert.equal(plan.missing.some((item) => item.includes(reason)), true, reason);
    } finally {
      close(state);
    }
  }
});

test('角色计划拒绝年龄、真人来源、声音语言和服装证据问题', () => {
  const cases = [
    ['age_not_adult', (state) => {
      const row = state.db.prepare("SELECT source_ref_json FROM redraw_assets WHERE kind = 'character' AND localized_name = 'Alice Carter'").get();
      const payload = JSON.parse(row.source_ref_json);
      payload.identity_pack.adult_status = 'unknown';
      state.db.prepare("UPDATE redraw_assets SET source_ref_json = ? WHERE kind = 'character' AND localized_name = 'Alice Carter'")
        .run(JSON.stringify(payload));
    }],
    ['persona_not_fictional_ai', (state) => {
      const row = state.db.prepare("SELECT source_ref_json FROM redraw_assets WHERE kind = 'character' AND localized_name = 'Alice Carter'").get();
      const payload = JSON.parse(row.source_ref_json);
      delete payload.identity_pack.persona_origin;
      state.db.prepare("UPDATE redraw_assets SET source_ref_json = ? WHERE kind = 'character' AND localized_name = 'Alice Carter'")
        .run(JSON.stringify(payload));
    }],
    ['voice_language_mismatch', (state) => addVoice(state, 'char-a', {
      audioAssetId: 701,
      locale: 'es-ES',
      market: 'ES',
      detectedLocale: 'es-ES',
    })],
    ['wardrobe_missing_reference', (state) => {
      const row = state.db.prepare("SELECT source_ref_json FROM redraw_assets WHERE kind = 'character' AND localized_name = 'Alice Carter'").get();
      const payload = JSON.parse(row.source_ref_json);
      delete payload.identity_pack.wardrobe;
      state.db.prepare("UPDATE redraw_assets SET source_ref_json = ? WHERE kind = 'character' AND localized_name = 'Alice Carter'")
        .run(JSON.stringify(payload));
    }],
    ['wardrobe_hash_drift', (state) => {
      const row = state.db.prepare("SELECT source_ref_json FROM redraw_assets WHERE kind = 'character' AND localized_name = 'Alice Carter'").get();
      const payload = JSON.parse(row.source_ref_json);
      payload.identity_pack.wardrobe.reference_sha256 = sha256('tampered');
      state.db.prepare("UPDATE redraw_assets SET source_ref_json = ? WHERE kind = 'character' AND localized_name = 'Alice Carter'")
        .run(JSON.stringify(payload));
    }],
  ];
  for (const [reason, mutate] of cases) {
    const state = makeReadyState();
    try {
      mutate(state);
      const plan = buildCharacterPlan(context(state), state.versionId);
      assert.equal(plan.ready, false, reason);
      assert.equal(plan.missing.some((item) => item.includes(reason)), true, reason);
    } finally {
      close(state);
    }
  }
});

test('角色计划拒绝声音哈希漂移和不可证明 owner 的声音资产', () => {
  const cases = [
    ['voice_hash_drift', (state) => {
      const row = state.db.prepare("SELECT source_ref_json FROM redraw_assets WHERE kind = 'character' AND localized_name = 'Alice Carter'").get();
      const payload = JSON.parse(row.source_ref_json);
      payload.snapshot.voice_snapshot.audio_sha256 = 'f'.repeat(64);
      state.db.prepare("UPDATE redraw_assets SET source_ref_json = ? WHERE kind = 'character' AND localized_name = 'Alice Carter'")
        .run(JSON.stringify(payload));
    }],
    ['voice_audio_unreadable', (state) => {
      state.db.prepare("UPDATE assets SET drama_id = NULL WHERE local_path = 'char-a.mp3'").run();
    }],
    ['voice_audio_unreadable', (state) => {
      state.db.prepare(`INSERT INTO dramas
        (id, title, tenant_id, user_id, created_at, updated_at)
        VALUES (88, 'other voice', 'tenant-b', 'user-b', ?, ?)`).run(NOW, NOW);
      state.db.prepare("UPDATE assets SET drama_id = 88 WHERE local_path = 'char-a.mp3'").run();
    }],
  ];
  for (const [expectedMissing, mutate] of cases) {
    const state = makeReadyState();
    try {
      mutate(state);
      const plan = buildCharacterPlan(context(state), state.versionId);
      assert.equal(plan.ready, false, expectedMissing);
      assert.equal(plan.missing.includes(`char-a:${expectedMissing}`), true, expectedMissing);
      assert.equal(plan.characters.find((item) => item.source_character_key === 'char-a').voice.ready, false);
    } finally {
      close(state);
    }
  }
});

test('角色计划在声音文件读取期间 realpath 漂移时 fail closed', () => {
  const state = makeReadyState();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-plan-voice-toctou-'));
  try {
    const audio = path.join(state.root, 'char-a.mp3');
    const outsideFile = path.join(outside, 'replaced.mp3');
    fs.writeFileSync(outsideFile, Buffer.from('replaced-voice'));
    let audioRealpathCalls = 0;
    const injectedFs = {
      constants: fs.constants,
      realpathSync(value) {
        if (path.resolve(value) === path.resolve(audio)) {
          audioRealpathCalls += 1;
          if (audioRealpathCalls > 1) return fs.realpathSync(outsideFile);
        }
        return fs.realpathSync(value);
      },
      openSync: (...args) => fs.openSync(...args),
      fstatSync: (...args) => fs.fstatSync(...args),
      statSync: (...args) => fs.statSync(...args),
      readFileSync: (...args) => fs.readFileSync(...args),
      closeSync: (...args) => fs.closeSync(...args),
    };

    const plan = buildCharacterPlan(context(state, { fs: injectedFs }), state.versionId);

    assert.equal(plan.ready, false);
    assert.equal(plan.missing.includes('char-a:voice_audio_unreadable'), true);
    assert.equal(plan.characters.find((item) => item.source_character_key === 'char-a').voice.ready, false);
  } finally {
    close(state, [outside]);
  }
});

test('角色计划拒绝源事实中的未成年、未知年龄和真人来源', () => {
  const cases = [
    ['minor', { adult_status: 'minor' }, 'char-a:source_age_not_adult'],
    ['unknown', { adult_status: 'unknown' }, 'char-a:source_age_not_adult'],
    ['empty', { adult_status: '' }, 'char-a:source_age_not_adult'],
    ['real_person', { persona_origin: 'real_person' }, 'char-a:source_persona_not_fictional_ai'],
  ];
  for (const [reason, patch, expectedMissing] of cases) {
    const state = makeReadyState({ sourceKey: 'char-a', patch });
    try {
      const plan = buildCharacterPlan(context(state), state.versionId);
      assert.equal(plan.ready, false, reason);
      assert.equal(plan.missing.includes(expectedMissing), true, reason);
    } finally {
      close(state);
    }
  }
});

test('角色计划拒绝无效、空缺、重复或不可作为唯一合同的源事实', () => {
  const invalidFactsCases = [
    ['invalid_json', '{bad json', 'source_facts_invalid'],
    ['not_array', { characters: {} }, 'source_characters_missing'],
    ['empty', { characters: [] }, 'source_characters_missing'],
    ['missing_key', {
      characters: [
        { target_name: 'Alice Carter', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
        { source_character_key: 'char-b', target_name: 'Brian Miller', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
      ],
    }, 'source_character_key_missing'],
    ['duplicate_key', {
      characters: [
        { source_character_key: 'char-a', target_name: 'Alice Carter', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
        { source_character_key: 'char-a', target_name: 'Alicia Carter', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
        { source_character_key: 'char-b', target_name: 'Brian Miller', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
      ],
    }, 'char-a:source_duplicate_character_key'],
    ['blank_target', {
      characters: [
        { source_character_key: 'char-a', target_name: ' ', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
        { source_character_key: 'char-b', target_name: 'Brian Miller', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
      ],
    }, 'char-a:source_target_name_missing'],
    ['duplicate_target', {
      characters: [
        { source_character_key: 'char-a', target_name: 'Alice Carter', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
        { source_character_key: 'char-b', target_name: 'Alice Carter', adult_status: 'verified_18_plus', persona_origin: 'fictional_ai_generated' },
      ],
    }, 'char-b:source_duplicate_target_name'],
  ];
  for (const [reason, facts, expectedMissing] of invalidFactsCases) {
    const state = setup(facts);
    try {
      addCharacter(state, 'char-b', 'Brian Miller');
      addCharacter(state, 'char-a', 'Alice Carter');
      addVoice(state, 'char-a');
      addVoice(state, 'char-b');

      const plan = buildCharacterPlan(context(state), state.versionId);

      assert.equal(plan.ready, false, reason);
      assert.equal(plan.missing.includes(expectedMissing), true, reason);
    } finally {
      close(state);
    }
  }
});

test('角色计划以源事实 target_name 为准并拒绝 row 或 pack 名称漂移', () => {
  const state = makeReadyState({
    sourceKey: 'char-a',
    patch: { target_name: 'Canonical Alice' },
  });
  try {
    const plan = buildCharacterPlan(context(state), state.versionId);
    const character = plan.characters.find((item) => item.source_character_key === 'char-a');

    assert.equal(plan.ready, false);
    assert.equal(plan.missing.includes('char-a:target_name_mismatch'), true);
    assert.equal(character.target_name, 'Canonical Alice');
  } finally {
    close(state);
  }
});

test('角色计划拒绝跨 owner 服装资产', () => {
  const state = setup();
  try {
    state.db.prepare(`INSERT INTO dramas
      (id, title, tenant_id, user_id, created_at, updated_at)
      VALUES (77, 'other', 'tenant-b', 'user-b', ?, ?)`).run(NOW, NOW);
    addProviderAsset(state, 301, 'char-a.png', { bytes: Buffer.from('identity-char-a') });
    addProviderAsset(state, 401, 'char-a-wardrobe.png', { bytes: Buffer.from('wardrobe-char-a'), dramaId: 77 });
    const id = Number(state.db.prepare(`INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name, prompt,
       asset_id, version_number, approval_status, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', 'character', ?, 'Alice Carter', 'prompt', 301,
        1, 'approved', 'generated', ?, ?)`)
      .run(state.versionId, JSON.stringify({ source_ref: { source_character_key: 'char-a' } }), NOW, NOW).lastInsertRowid);
    assert.throws(
      () => saveIdentityPack(context(state), id, {
        expected_updated_at: NOW,
        target_actor_label: 'Alice Carter',
        confirmed_views: ['front', 'profile', 'full_body'],
        live_action_human_confirmed: true,
        adult_status: 'verified_18_plus',
        identity_consistency_confirmed: true,
        persona_origin: 'fictional_ai_generated',
        target_country: 'US',
        wardrobe_reference_asset_id: 401,
        wardrobe_consistency_confirmed: true,
      }),
      (error) => error.code === 'REDRAW_IDENTITY_WARDROBE_NOT_OWNED',
    );
  } finally {
    close(state);
  }
});

test('角色计划再验证拒绝缺少 owner 绑定或跨 owner 漂移的服装资产', () => {
  const cases = [
    ['wardrobe_owner_missing', null],
    ['wardrobe_owner_mismatch', 77],
  ];
  for (const [reason, dramaId] of cases) {
    const state = makeReadyState();
    try {
      if (dramaId !== null) {
        state.db.prepare(`INSERT INTO dramas
          (id, title, tenant_id, user_id, created_at, updated_at)
          VALUES (?, 'other', 'tenant-b', 'user-b', ?, ?)`).run(dramaId, NOW, NOW);
      }
      state.db.prepare("UPDATE assets SET drama_id = ? WHERE local_path = 'char-a-wardrobe.png'")
        .run(dramaId);

      const plan = buildCharacterPlan(context(state), state.versionId);

      assert.equal(plan.ready, false, reason);
      assert.equal(plan.missing.includes('char-a:wardrobe_missing_reference'), true, reason);
    } finally {
      close(state);
    }
  }
});
