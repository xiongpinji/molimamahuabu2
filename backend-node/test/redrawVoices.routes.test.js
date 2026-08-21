const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const redrawRoutes = require('../src/routes/redraw');
const redrawVoiceService = require('../src/services/redrawVoiceService');

const NOW = '2026-08-08T00:00:00.000Z';
const TTS_CONFIG_ID = 41;
const MODEL_MANIFEST_SHA256 = 'a'.repeat(64);
const CALIBRATION_MANIFEST_SHA256 = 'b'.repeat(64);
const AUDIO_SHA256 = 'c'.repeat(64);
const TRANSCRIPT_SHA256 = 'd'.repeat(64);

function captureResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request({ id, tenantId = 'tenant-a', userId = 'user-a', body = {}, query = {} } = {}) {
  return {
    params: { id: String(id) },
    tenant: { id: tenantId },
    user: { id: userId },
    body,
    query,
  };
}

function insertOwnerVersion(db, {
  tenantId = 'tenant-a',
  userId = 'user-a',
  locale = 'fr-FR',
  market = 'FR',
  version = 1,
} = {}) {
  const projectId = Number(db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, created_at, updated_at)
    VALUES (?, ?, '音色路由测试项目', ?, ?)
  `).run(tenantId, userId, NOW, NOW).lastInsertRowid);
  const workId = Number(db.prepare(`
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, ?, ?, '音色路由测试作品', 1, ?, 15000, ?, 2, 'asset_review', ?, ?)
  `).run(projectId, tenantId, userId, `voice-source-${projectId}`, version, NOW, NOW).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'asset_review', ?, ?)
  `).run(workId, tenantId, userId, version, locale, market, NOW, NOW).lastInsertRowid);
}

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, name, model, default_model, is_active, created_at, updated_at)
    VALUES (?, 'tts', 'verified-tts', 'verified route TTS', ?, 'voice-model-1', 1, ?, ?)`)
    .run(TTS_CONFIG_ID, JSON.stringify(['voice-model-1']), NOW, NOW);
  const versionId = insertOwnerVersion(db);
  const otherVersionId = insertOwnerVersion(db, { version: 2 });
  const otherUserVersionId = insertOwnerVersion(db, { userId: 'user-b' });
  const otherTenantVersionId = insertOwnerVersion(db, { tenantId: 'tenant-b' });
  return {
    db,
    versionId,
    otherVersionId,
    otherUserVersionId,
    otherTenantVersionId,
    readableAudioIds: new Set(),
  };
}

function addAudioAsset(db, id, { url = `/static/redraw-voices/${id}.mp3` } = {}) {
  db.prepare(`
    INSERT INTO assets
      (id, name, type, category, url, local_path, mime_type, duration, created_at, updated_at)
    VALUES (?, ?, 'audio', 'voice', ?, ?, 'audio/mpeg', 1.2, ?, ?)
  `).run(id, `音色样音 ${id}`, url, `redraw-voices/${id}.mp3`, NOW, NOW);
}

function verifiedVoice(audioAssetId, voiceId = `fr-voice-${audioAssetId}`, overrides = {}) {
  return {
    source: 'offline-worker',
    locale: 'fr-FR',
    market: 'FR',
    locale_pack: 'fr-FR@fixture',
    audio_sha256: AUDIO_SHA256,
    transcript_sha256: TRANSCRIPT_SHA256,
    model_manifest_sha256: MODEL_MANIFEST_SHA256,
    calibration_manifest_sha256: CALIBRATION_MANIFEST_SHA256,
    asr_model_revision: 'asr-fr-20260808',
    accent_model_revision: 'accent-fr-20260808',
    metrics: { word_error_rate: 0, accent_confidence: 0.99 },
    completed_at: '2026-08-08T00:00:01.000Z',
    provider: 'verified-tts',
    model: 'voice-model-1',
    ai_service_config_id: TTS_CONFIG_ID,
    config_updated_at: NOW,
    voice_id: voiceId,
    task_id: `tts-${voiceId}`,
    terminal_status: 'completed',
    audio_asset_id: audioAssetId,
    duration_ms: 1200,
    real_generation_verified: true,
    language_verified: true,
    detected_locale: 'fr-FR',
    ...overrides,
  };
}

function addVoiceAsset(db, versionId, id, evidence, {
  tenantId = 'tenant-a',
  userId = 'user-a',
  status = 'generated',
  name = `生产音色 ${id}`,
  voiceAssetId = evidence.audio_asset_id,
} = {}) {
  db.prepare(`
    INSERT INTO redraw_assets
      (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
       voice_asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'voice', ?, ?, ?, 1, 'approved', ?, ?, ?)
  `).run(
    id,
    versionId,
    tenantId,
    userId,
    JSON.stringify({ source_ref: { voice_id: evidence.voice_id }, snapshot: { evidence } }),
    name,
    voiceAssetId,
    status,
    NOW,
    NOW,
  );
}

function addCharacterAsset(db, versionId, id, {
  tenantId = 'tenant-a',
  userId = 'user-a',
  kind = 'character',
  updatedAt = NOW,
} = {}) {
  db.prepare(`
    INSERT INTO redraw_assets
      (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
       asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '角色 Alice', ?, 1, 'approved', 'generated', ?, ?)
  `).run(
    id,
    versionId,
    tenantId,
    userId,
    kind,
    JSON.stringify({ source_ref: { character_id: 'alice' }, snapshot: {} }),
    id + 1000,
    NOW,
    updatedAt,
  );
}

function handlersFor(state, options = {}) {
  redrawVoiceService.setDefaultEvidenceRegistry(options.localeRegistry || trustedRegistry());
  return redrawRoutes(state.db, { error() {} }, {
    canReadArtifact: (assetId) => state.readableAudioIds.has(Number(assetId)),
    ...options,
  });
}

function trustedRegistry() {
  return {
    assertEvidenceTrusted(evidence) {
      if (evidence.source !== 'offline-worker'
        || evidence.locale_pack !== 'fr-FR@fixture'
        || evidence.model_manifest_sha256 !== MODEL_MANIFEST_SHA256
        || evidence.calibration_manifest_sha256 !== CALIBRATION_MANIFEST_SHA256) {
        const error = new Error('worker evidence not trusted');
        error.code = 'REDRAW_LOCALE_VERIFIER_NOT_READY';
        throw error;
      }
      return evidence;
    },
  };
}

test('生产音色列表只返回当前 owner、当前版本、同 locale/market 且证据和音频均有效的 redraw 音色', () => {
  const state = setup();
  try {
    for (const id of [501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511]) addAudioAsset(state.db, id);
    state.readableAudioIds.add(501);
    state.readableAudioIds.add(502);
    state.readableAudioIds.add(503);
    state.readableAudioIds.add(504);
    state.readableAudioIds.add(506);
    state.readableAudioIds.add(507);
    state.readableAudioIds.add(508);
    state.readableAudioIds.add(509);
    state.readableAudioIds.add(510);
    state.readableAudioIds.add(511);
    addVoiceAsset(state.db, state.versionId, 601, verifiedVoice(501), { name: '有效法语音色' });
    addVoiceAsset(state.db, state.otherVersionId, 602, verifiedVoice(502));
    addVoiceAsset(state.db, state.otherUserVersionId, 603, verifiedVoice(503), { userId: 'user-b' });
    addVoiceAsset(state.db, state.otherTenantVersionId, 607, verifiedVoice(507), { tenantId: 'tenant-b' });
    addVoiceAsset(state.db, state.versionId, 604, verifiedVoice(504, 'en-voice', { locale: 'en-US', market: 'US' }));
    addVoiceAsset(state.db, state.versionId, 605, verifiedVoice(505, 'unreadable-voice'));
    addVoiceAsset(state.db, state.versionId, 606, verifiedVoice(506, 'processing-voice', {
      terminal_status: 'processing',
      real_generation_verified: false,
    }));
    addVoiceAsset(state.db, state.versionId, 608, verifiedVoice(508, 'needs-attention-voice'), { status: 'needs_attention' });
    addVoiceAsset(state.db, state.versionId, 609, verifiedVoice(509, 'mismatch-voice'), { voiceAssetId: 508 });
    addVoiceAsset(state.db, state.versionId, 610, verifiedVoice(510, 'config-id-mismatch', {
      ai_service_config_id: 999,
    }));
    addVoiceAsset(state.db, state.versionId, 612, verifiedVoice(511, 'config-version-mismatch', {
      config_updated_at: '2026-08-08T00:00:01.000Z',
    }));
    state.db.prepare(`
      INSERT INTO characters (drama_id, name, seedance2_voice_asset, created_at, updated_at)
      VALUES (1, 'Legacy Alice', ?, ?, ?)
    `).run(JSON.stringify({ status: 'active', url: '/static/legacy-voice.mp3' }), NOW, NOW);

    const handlers = handlersFor(state);
    assert.equal(typeof handlers.listProductionVoices, 'function');
    const res = captureResponse();
    handlers.listProductionVoices(request({ id: state.versionId }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.map((voice) => voice.id), [601]);
    assert.equal(res.body.data[0].localized_name, '有效法语音色');
    assert.equal(res.body.data[0].voice_id, 'fr-voice-501');
    assert.equal(res.body.data[0].preview_url, `/api/v1/redraw/versions/${state.versionId}/voices/601/preview`);
    assert.equal(res.body.data[0].audio_readable, true);
    assert.equal('audio_asset' in res.body.data[0], false);
    assert.equal('local_path' in res.body.data[0], false);
  } finally {
    state.db.close();
  }
});

test('版本缺少 market 时生产音色目录 fail closed，不把其他地区音色当作匹配', () => {
  const state = setup();
  try {
    const incompleteVersionId = insertOwnerVersion(state.db, { market: '' });
    addAudioAsset(state.db, 508);
    state.readableAudioIds.add(508);
    addVoiceAsset(state.db, incompleteVersionId, 608, verifiedVoice(508));
    const handlers = handlersFor(state);
    const res = captureResponse();
    handlers.listProductionVoices(request({ id: incompleteVersionId }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, []);
  } finally {
    state.db.close();
  }
});

test('voice preview is owner/version scoped and never exposes the raw public static URL', () => {
  const state = setup();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-voice-preview-'));
  try {
    fs.mkdirSync(path.join(storageRoot, 'redraw-voices'), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'redraw-voices', '521.mp3'), 'preview audio');
    addAudioAsset(state.db, 521, { url: '/static/redraw-assets/raw-521.mp3' });
    state.readableAudioIds.add(521);
    addVoiceAsset(state.db, state.versionId, 621, verifiedVoice(521, 'fr-preview'));
    const handlers = handlersFor(state, { cfg: { storage: { local_path: storageRoot } } });
    const list = captureResponse();
    handlers.listProductionVoices(request({ id: state.versionId }), list);
    assert.equal(list.body.data[0].preview_url, `/api/v1/redraw/versions/${state.versionId}/voices/621/preview`);
    assert.equal(list.body.data[0].preview_url.includes('/static/'), false);

    const sent = { path: null, headers: {} };
    const ownerResponse = captureResponse();
    ownerResponse.setHeader = (name, value) => { sent.headers[name] = value; };
    ownerResponse.sendFile = (filename, callback) => {
      sent.path = filename;
      callback?.();
      return ownerResponse;
    };
    handlers.previewProductionVoice({
      params: { versionId: String(state.versionId), voiceAssetId: '621' },
      tenant: { id: 'tenant-a' },
      user: { id: 'user-a' },
    }, ownerResponse);
    assert.equal(sent.path, fs.realpathSync(path.join(storageRoot, 'redraw-voices', '521.mp3')));
    assert.equal(sent.headers['Content-Type'], 'audio/mpeg');
    assert.equal(sent.headers['Cache-Control'], 'private, no-store, max-age=0');

    state.db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = ?').run(TTS_CONFIG_ID);
    const disabledList = captureResponse();
    handlers.listProductionVoices(request({ id: state.versionId }), disabledList);
    assert.deepEqual(disabledList.body.data, []);
    const disabledPreview = captureResponse();
    handlers.previewProductionVoice({
      params: { versionId: String(state.versionId), voiceAssetId: '621' },
      tenant: { id: 'tenant-a' },
      user: { id: 'user-a' },
    }, disabledPreview);
    assert.equal(disabledPreview.statusCode, 404);

    const foreignResponse = captureResponse();
    handlers.previewProductionVoice({
      params: { versionId: String(state.versionId), voiceAssetId: '621' },
      tenant: { id: 'tenant-b' },
      user: { id: 'user-a' },
    }, foreignResponse);
    assert.equal(foreignResponse.statusCode, 404);
  } finally {
    state.db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('绑定只接受安全字段，并从同 owner 同版本的 redraw voice 数据库证据写入角色快照', () => {
  const state = setup();
  try {
    addAudioAsset(state.db, 511);
    state.readableAudioIds.add(511);
    addVoiceAsset(state.db, state.versionId, 611, verifiedVoice(511, 'fr-alice'));
    addCharacterAsset(state.db, state.versionId, 711);
    const handlers = handlersFor(state);
    assert.equal(typeof handlers.assignVoice, 'function');

    const rejected = captureResponse();
    handlers.assignVoice(request({
      id: 711,
      body: {
        voice_asset_id: 611,
        expected_updated_at: NOW,
        provider: 'client-forged-provider',
        model: 'client-forged-model',
        evidence: { real_generation_verified: true },
        audio_path: 'C:\\secret\\voice.mp3',
        credits: 0,
      },
    }), rejected);
    assert.equal(rejected.statusCode, 400);
    assert.equal(state.db.prepare('SELECT voice_asset_id FROM redraw_assets WHERE id = 711').get().voice_asset_id, null);

    const bound = captureResponse();
    handlers.assignVoice(request({
      id: 711,
      body: { voice_asset_id: 611, expected_updated_at: NOW },
    }), bound);
    assert.equal(bound.statusCode, 200);
    assert.equal(bound.body.data.conflict, false);
    assert.equal(bound.body.data.asset.id, 711);
    assert.equal(bound.body.data.asset.voice_asset_id, 511);
    assert.equal(bound.body.data.voice_snapshot.voice_id, 'fr-alice');
    assert.equal(bound.body.data.voice_snapshot.provider, 'verified-tts');
    const stored = state.db.prepare('SELECT * FROM redraw_assets WHERE id = 711').get();
    assert.equal(stored.voice_asset_id, 511);
    assert.equal(JSON.parse(stored.source_ref_json).snapshot.voice_snapshot.task_id, 'tts-fr-alice');
  } finally {
    state.db.close();
  }
});

test('绑定拒绝非当前 owner 的目标、非角色目标以及跨版本或非生产音色', () => {
  const state = setup();
  try {
    for (const id of [521, 522, 523, 524, 525]) {
      addAudioAsset(state.db, id);
      if (id !== 525) state.readableAudioIds.add(id);
    }
    addVoiceAsset(state.db, state.versionId, 621, verifiedVoice(521));
    addVoiceAsset(state.db, state.otherVersionId, 622, verifiedVoice(522));
    addVoiceAsset(state.db, state.versionId, 623, verifiedVoice(523, 'not-verified', {
      terminal_status: 'processing',
      real_generation_verified: false,
    }));
    addVoiceAsset(state.db, state.versionId, 624, verifiedVoice(524), { tenantId: 'tenant-b' });
    addVoiceAsset(state.db, state.versionId, 625, verifiedVoice(525, 'unreadable-voice'));
    addCharacterAsset(state.db, state.versionId, 721);
    addCharacterAsset(state.db, state.versionId, 722, { userId: 'user-b' });
    addCharacterAsset(state.db, state.versionId, 723, { kind: 'prop' });
    const handlers = handlersFor(state);
    assert.equal(typeof handlers.assignVoice, 'function');

    const otherOwner = captureResponse();
    handlers.assignVoice(request({ id: 722, body: { voice_asset_id: 621 } }), otherOwner);
    assert.equal(otherOwner.statusCode, 404);

    const wrongKind = captureResponse();
    handlers.assignVoice(request({ id: 723, body: { voice_asset_id: 621 } }), wrongKind);
    assert.equal(wrongKind.statusCode, 404);

    const otherVersion = captureResponse();
    handlers.assignVoice(request({ id: 721, body: { voice_asset_id: 622 } }), otherVersion);
    assert.equal(otherVersion.statusCode, 404);

    const otherTenant = captureResponse();
    handlers.assignVoice(request({ id: 721, body: { voice_asset_id: 624 } }), otherTenant);
    assert.equal(otherTenant.statusCode, 404);

    const notProduction = captureResponse();
    handlers.assignVoice(request({ id: 721, body: { voice_asset_id: 623 } }), notProduction);
    assert.equal(notProduction.statusCode, 409);
    assert.equal(notProduction.body.error.code, 'REDRAW_VOICE_NOT_PRODUCTION');

    const unreadable = captureResponse();
    handlers.assignVoice(request({ id: 721, body: { voice_asset_id: 625 } }), unreadable);
    assert.equal(unreadable.statusCode, 409);
    assert.equal(unreadable.body.error.code, 'REDRAW_VOICE_NOT_PRODUCTION');
  } finally {
    state.db.close();
  }
});

test('相同音色绑定幂等，不同绑定或过期 expected_updated_at 返回 409 且不覆盖', () => {
  const state = setup();
  try {
    for (const id of [531, 532]) {
      addAudioAsset(state.db, id);
      state.readableAudioIds.add(id);
    }
    addVoiceAsset(state.db, state.versionId, 631, verifiedVoice(531, 'fr-first'));
    addVoiceAsset(state.db, state.versionId, 632, verifiedVoice(532, 'fr-second'));
    addCharacterAsset(state.db, state.versionId, 731);
    const handlers = handlersFor(state);
    assert.equal(typeof handlers.assignVoice, 'function');

    const first = captureResponse();
    handlers.assignVoice(request({
      id: 731,
      body: { voice_asset_id: 631, expected_updated_at: NOW },
    }), first);
    assert.equal(first.statusCode, 200);

    const same = captureResponse();
    handlers.assignVoice(request({ id: 731, body: { voice_asset_id: 631 } }), same);
    assert.equal(same.statusCode, 200);
    assert.equal(same.body.data.conflict, false);

    const different = captureResponse();
    handlers.assignVoice(request({ id: 731, body: { voice_asset_id: 632 } }), different);
    assert.equal(different.statusCode, 409);
    assert.equal(different.body.error.code, 'REDRAW_VOICE_BIND_CONFLICT');

    const stale = captureResponse();
    handlers.assignVoice(request({
      id: 731,
      body: { voice_asset_id: 631, expected_updated_at: NOW },
    }), stale);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.error.code, 'REDRAW_VOICE_BIND_CONFLICT');

    const stored = state.db.prepare('SELECT * FROM redraw_assets WHERE id = 731').get();
    assert.equal(stored.voice_asset_id, 531);
    assert.equal(JSON.parse(stored.source_ref_json).snapshot.voice_snapshot.voice_id, 'fr-first');
  } finally {
    state.db.close();
  }
});
