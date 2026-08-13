const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { getFfmpegPath, hasLocalFfmpeg, hasLocalFfprobe } = require('../src/utils/ffmpegPath');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const redrawOrchestrator = require('../src/services/redrawOrchestrator');
const { identityBindingForAsset } = require('../src/services/redrawCharacterIdentityService');
const { resetGenerationConcurrencyForTests } = require('../src/services/generationConcurrency');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');
const {
  generateShot,
  generateBatch,
  retryShot,
  recoverInterruptedShotGenerations,
  markInterruptedShotGenerationsNeedsAttention,
  runShotGeneration,
  verifyVideoArtifact,
  classifyVideoOutcome,
  reviewNativeAudio,
  assertVideoConditioningCapability,
} = require('../src/services/redrawGenerationService');

const log = { info() {}, warn() {}, error() {} };
const FEITUO_FAST_MODEL = 'sdas-my-seedance-2.0-fast-upscaled-1080p';
const TOAPIS_NATIVE_MODEL = 'seedance-2-fast';
const ICREAT_MINI_MODEL = 'bytedance/seedance-2-0-mini';
const SIGNED_SOURCE_VIDEO_URL = 'https://media.example.test/api/redraw-provider-assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4?expires=1786147800&signature=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalIdentityPack(input = {}) {
  const {
    sourceCharacterKey = 'source-character-1',
    targetActorLabel = 'Actor Maya',
    artifactAssetId = 101,
    artifactSeed = 'canonical actor portrait',
    ...overrides
  } = input;
  const pack = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: sourceCharacterKey,
    target_actor_label: targetActorLabel,
    artifact: {
      asset_id: Number(artifactAssetId),
      sha256: crypto.createHash('sha256').update(artifactSeed).digest('hex'),
      width: 640,
      height: 960,
      mime_type: 'image/png',
    },
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
  return {
    ...pack,
    pack_sha256: crypto.createHash('sha256').update(stableJson(pack)).digest('hex'),
  };
}

function setup(overrides = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  prices.set(db, 'seedance 2.0', 2, {
    category: 'video',
    billing_unit: 'second',
    resolution_prices: { '720p': { credits: 3 }, '480p': { credits: 2 } },
  });
  addVerifiedGenerationCapability(db, 'seedance 2.0');
  credits.setTenantAccountBalance(db, 'tenant-a', 500);
  credits.setAccountBalance(db, 'user-a', 500);
  const now = new Date('2026-08-06T00:00:00.000Z').toISOString();
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '转绘项目', ?, ?)`).run(now, now);
  const projectId = db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '转绘作品', 1, ?, 15000, 1, 3, 'ready_to_generate', ?, ?)`)
    .run(projectId, `source-${Math.random()}`, now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, style_snapshot_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'zh-CN', 'CN', ?, 'ready_to_generate', ?, ?)`)
    .run(workId, JSON.stringify(overrides.styleSnapshot || { tone: 'warm', lens: '35mm' }), now, now);
  const versionId = db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id;
  return { db, now, workId, versionId };
}

function addBaseAsset(db, input) {
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO assets
    (name, type, category, url, local_path, created_at, updated_at)
    VALUES (?, 'image', ?, ?, ?, ?, ?)`)
    .run(input.name, input.category || 'redraw', input.url || '', input.localPath || null, now, now)
    .lastInsertRowid;
}

function addRedrawAsset(db, versionId, input) {
  const now = new Date().toISOString();
  const hasIdentityPack = Object.hasOwn(input, 'identityPack');
  const identityPack = input.kind === 'character'
    ? (hasIdentityPack ? input.identityPack : canonicalIdentityPack({
        sourceCharacterKey: input.sourceCharacterKey || `source-character-${input.assetId}`,
        targetActorLabel: input.targetActorLabel || input.name || 'Actor Maya',
        artifactAssetId: input.assetId,
        artifactSeed: `canonical actor portrait ${input.assetId}`,
      }))
    : null;
  const sourceRef = input.kind === 'character'
    ? {
        source_ref: { stable_id: identityPack?.source_character_key || `source-character-${input.assetId}` },
        ...(identityPack ? { identity_pack: identityPack } : {}),
      }
    : {};
  return db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, clean_plate_asset_id, approval_status, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      versionId,
      input.kind,
      JSON.stringify(sourceRef),
      input.name || input.kind,
      input.assetId || null,
      input.cleanPlateAssetId || null,
      input.approvalStatus || 'approved',
      input.status || 'generated',
      now,
      now,
    ).lastInsertRowid;
}

function addShot(db, versionId, overrides = {}) {
  const now = new Date().toISOString();
  const durationMs = overrides.durationMs || overrides.duration_ms || 6000;
  const startMs = overrides.startMs || overrides.start_ms || 0;
  const endMs = overrides.endMs || overrides.end_ms || (startMs + durationMs);
  const references = (overrides.references || []).map((reference) => {
    const historicalCharacterId = reference?.character_asset_id ?? reference?.characterAssetId;
    const referenceKind = String(reference?.kind || (historicalCharacterId != null ? 'character' : ''));
    if (referenceKind !== 'character' || overrides.bindCharacterIdentity === false) {
      return reference;
    }
    const redrawAssetId = Number(
      reference.redraw_asset_id ?? reference.redrawAssetId ?? reference.asset_id ?? reference.assetId
        ?? historicalCharacterId,
    );
    const row = db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(redrawAssetId);
    const binding = identityBindingForAsset(row);
    if (!binding) return reference;
    return {
      ...reference,
      source_character_key: binding.source_character_key,
      target_actor_label: binding.target_actor_label,
      identity_pack_sha256: binding.pack_sha256,
    };
  });
  const compiled = overrides.compiledPrompt || {
    text: 'compiled hero prompt',
    negative_prompt: 'low quality',
    model: 'seedance 2.0',
    duration: 6,
    resolution: '720p',
    aspect_ratio: '9:16',
  };
  const draft = overrides.draft || { attempt: 1, model: 'seedance 2.0' };
  const shotId = db.prepare(`INSERT INTO redraw_shots
    (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     references_json, prompt, negative_prompt, compiled_prompt_json, draft_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      versionId,
      overrides.shotIndex || 1,
      startMs,
      endMs,
      durationMs,
      JSON.stringify(references),
      overrides.prompt || 'fallback prompt',
      overrides.negativePrompt || '',
      typeof compiled === 'string' ? compiled : JSON.stringify(compiled),
      typeof draft === 'string' ? draft : JSON.stringify(draft),
      overrides.status || 'draft',
      now,
      now,
    ).lastInsertRowid;
  if (Object.prototype.hasOwnProperty.call(overrides, 'localized_dialogue_json')) {
    db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE id = ?')
      .run(overrides.localized_dialogue_json, shotId);
  }
  return shotId;
}

function nativePack(overrides = {}) {
  return {
    id: 'es@1',
    language: 'es',
    locale: null,
    scope: 'language',
    prompt_language_label: '西班牙语',
    model_manifest_sha256: 'a'.repeat(64),
    calibration_manifest_sha256: 'b'.repeat(64),
    thresholds: {
      language_probability_min: 0.8,
      dialogue_similarity_min: 0.8,
      speech_chars_per_second_max: 20,
    },
    ...overrides,
  };
}

function nativeAudioEvidence(overrides = {}) {
  return {
    contract: 'redraw-native-audio-validation-v1',
    artifact_sha256: 'a'.repeat(64),
    audio_stream: { codec: 'aac', channels: 2, sample_rate: 44100, duration_ms: 4980 },
    video_duration_ms: 5000,
    silence: { rms_db: -24.1, threshold_db: -45 },
    verification: {
      detected_language: 'es',
      detected_locale: null,
      language_verified: true,
      locale_verified: false,
      transcript_sha256: 'b'.repeat(64),
      dialogue_similarity: 0.91,
      speech_chars_per_second: 8,
    },
    validation_hash: 'c'.repeat(64),
    ...overrides,
  };
}

function writeTinyMp4(t, storageRoot, relativePath, options = {}) {
  if (!hasLocalFfmpeg() || !hasLocalFfprobe()) {
    t.skip('ffmpeg/ffprobe unavailable');
    return false;
  }
  const output = path.join(storageRoot, relativePath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const args = options.audio === false
    ? [
        '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=size=16x16:rate=1:duration=1',
        '-c:v', 'mpeg4',
        output,
      ]
    : [
        '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=size=16x16:rate=1:duration=1',
        '-f', 'lavfi',
        '-i', 'sine=frequency=1000:duration=1',
        '-shortest',
        '-c:v', 'mpeg4',
        '-c:a', 'aac',
        output,
      ];
  execFileSync(getFfmpegPath(), args, { stdio: 'ignore' });
  return true;
}

function addNativeDialogueCapability(db, overrides = {}) {
  const now = overrides.updatedAt || new Date('2026-08-06T00:00:00.000Z').toISOString();
  const model = overrides.model || TOAPIS_NATIVE_MODEL;
  const provider = overrides.provider || 'toapis';
  const protocol = overrides.protocol || 'toapis_video';
  const language = overrides.language || 'es';
  const inserted = db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, model, default_model, base_url, api_key,
       is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video', ?, ?, '原生对白验证', ?, ?, ?, 'secret', 1, 1, 0, '{}', ?, ?)
  `).run(provider, protocol, model, model, overrides.baseUrl || 'https://toapis.com', now, now);
  const configId = Number(inserted.lastInsertRowid);
  const evidence = {
    contract: 'redraw-native-dialogue-audio-v1',
    provider,
    protocol,
    model,
    config_id: configId,
    config_updated_at: overrides.evidenceUpdatedAt || now,
    provider_task_id: 'provider-native-dialogue-real',
    terminal_status: 'completed',
    artifact_id: overrides.artifactId || 771,
    artifact_sha256: 'd'.repeat(64),
    media: { video_stream: true, audio_stream: true },
    locale_verification: {
      language,
      language_verified: true,
      locale_verified: false,
    },
    human_review: {
      status: 'passed',
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
    },
  };
  db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify({
    redraw_locale_capabilities: [{
      language,
      locale: language,
      target_language: language,
      target_locale: null,
      market: '',
      status: 'verified',
      evidence: {
        video: {
          config_id: configId,
          config_updated_at: now,
          provider,
          model,
          task_id: 'video-task',
          terminal_status: 'completed',
          artifact_id: 772,
        },
        native_dialogue_audio: overrides.evidence || evidence,
      },
    }],
  }), configId);
  db.prepare(`UPDATE ai_service_configs
    SET verification_status = 'verified',
        verification_checked_at = ?,
        verified_at = ?,
        verified_capabilities = ?,
        updated_at = ?
    WHERE id = ?`)
    .run(now, now, JSON.stringify({
      [model]: withExternalModelEvidence(model, {
        durations: overrides.durations || [5],
        resolutions: ['480p', '720p'],
        supportsAudio: true,
        supportsVideoReference: true,
      }),
    }), now, configId);
  return { configId, updatedAt: now, model };
}

function ctx(db, overrides = {}) {
  return {
    db,
    log,
    tenantId: 'tenant-a',
    userId: 'user-a',
    clock: () => '2026-08-06T00:00:00.000Z',
    canReadArtifact: () => true,
    localeVerifier: {
      assertReady: () => nativePack(),
    },
    resolveVideoConditioningCapability: (_database, model, capability) => ({
      config_id: capability?.config_id,
      config_updated_at: capability?.config_updated_at,
      provider: capability?.provider || 'feituo',
      model,
      protocol: 'feituo_open',
      max_videos: 3,
    }),
    storageBaseUrl: 'https://media.example.test/static',
    providerAssetSecret: 'redraw-generation-test-provider-secret-32-bytes',
    prepareSourceConditioning: async ({ shot }) => ({
      referenceVideoUrl: SIGNED_SOURCE_VIDEO_URL,
      billingSnapshot: {
        source_asset_id: Number(shot.source_asset_id || 1),
        source_fingerprint: 'f'.repeat(64),
        start_ms: Number(shot.start_ms),
        end_ms: Number(shot.end_ms),
        segment_sha256: 'a'.repeat(64),
      },
      auditSnapshot: {
        schema_version: '1.0',
        shot_id: Number(shot.id),
        source_asset_id: Number(shot.source_asset_id || 1),
        source_fingerprint: 'f'.repeat(64),
        start_ms: Number(shot.start_ms),
        end_ms: Number(shot.end_ms),
        segment_sha256: 'a'.repeat(64),
        segment_local_path: `redraw-conditioning/${'a'.repeat(64)}.mp4`,
        provider_asset_path: `/api/v1/redraw-provider-assets/${'a'.repeat(64)}.mp4`,
      },
    }),
    ...overrides,
  };
}

function count(db, table, where = '1=1') {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count;
}

function nativeAudit(db, shotId, taskId) {
  const draft = JSON.parse(db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
  if (draft.native_audio_validation) return draft.native_audio_validation;
  const task = db.prepare('SELECT result FROM async_tasks WHERE id = ?').get(taskId);
  if (!task?.result) return null;
  return JSON.parse(task.result).native_audio_validation || null;
}

function workflowState(db, versionId) {
  return db.prepare(`
    SELECT v.status AS version_status, w.status AS work_status, w.current_step
    FROM redraw_versions v
    JOIN redraw_works w ON w.id = v.work_id
    WHERE v.id = ?
  `).get(versionId);
}

function addVerifiedGenerationCapability(db, model, overrides = {}) {
  const now = new Date('2026-08-06T00:00:00.000Z').toISOString();
  const provider = overrides.provider || 'feituo';
  const apiProtocol = overrides.apiProtocol || 'feituo_open';
  const configModel = overrides.configModel || model;
  const inserted = db.prepare(`
    INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES (?, 'video', ?, ?, '转绘生成能力', ?, ?, 1, 1, 0, ?, ?, ?)
  `).run(
    overrides.id ?? null,
    provider,
    apiProtocol,
    configModel,
    configModel,
    '{}',
    now,
    now,
  );
  const configId = Number(overrides.id ?? inserted.lastInsertRowid);
  db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(
    JSON.stringify({
      redraw_locale_capabilities: [{
        locale: overrides.locale || 'zh-CN',
        market: overrides.market || 'CN',
        status: 'verified',
        evidence: {
          video: {
            config_id: overrides.evidenceConfigId ?? configId,
            config_updated_at: overrides.evidenceConfigUpdatedAt || now,
            provider: overrides.evidenceProvider || provider,
            model: overrides.evidenceModel || model,
            task_id: `verified-${model}`,
            terminal_status: 'completed',
            artifact_id: `artifact-${model}`,
          },
        },
      }],
    }),
    configId,
  );
  return configId;
}

test('ID9 iCreat verified 模型在 reserve/video row/provider 前以 conditioning unsupported fail closed', async () => {
  const state = setup();
  const model = 'icreat-redraw-video-v1';
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    prices.set(state.db, model, 3, { category: 'video', billing_unit: 'second' });
    addVerifiedGenerationCapability(state.db, model, {
      id: 9,
      provider: 'icreat',
      apiProtocol: 'icreat_task',
    });
    const shotId = addShot(state.db, state.versionId);
    let conditioningCalls = 0;

    await assert.rejects(
      () => generateShot(ctx(state.db, {
        resolveVideoConditioningCapability: null,
        prepareSourceConditioning: async () => {
          conditioningCalls += 1;
          throw new Error('conditioning must not run');
        },
        schedule() {},
      }), { shotId }),
      (error) => error.code === 'REDRAW_VIDEO_CONDITIONING_UNSUPPORTED',
    );

    assert.equal(conditioningCalls, 0);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
    assert.equal(count(state.db, 'async_tasks', "type = 'redraw_shot'"), 0);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0);
  } finally {
    state.db.close();
  }
});

test('仅精确 iCreat Mini capability 支持源片 conditioning', () => {
  const exact = {
    config_id: 7,
    config_updated_at: '2026-08-11T00:00:00.000Z',
    provider: 'icreat',
    protocol: 'icreat_task',
    model: ICREAT_MINI_MODEL,
  };

  assert.deepEqual(assertVideoConditioningCapability(exact), { ...exact, max_videos: 3 });
  for (const patch of [
    { protocol: 'openai' },
    { model: 'bytedance/seedance-2-0-fast' },
    { model: 'bytedance/seedance-2-0' },
  ]) {
    assert.throws(
      () => assertVideoConditioningCapability({ ...exact, ...patch }),
      (error) => error.code === 'REDRAW_VIDEO_CONDITIONING_UNSUPPORTED',
    );
  }
});

test('视频能力证据必须绑定 exact config/provider/model 才能在 conditioning 与 reserve 前通过', async () => {
  for (const mismatch of ['provider', 'model', 'config_id', 'config_updated_at']) {
    const state = setup();
    try {
      state.db.prepare('DELETE FROM ai_service_configs').run();
      const configUpdatedAt = '2026-08-08T10:00:00.000Z';
      const rowModel = mismatch === 'model' ? 'another-video-model' : FEITUO_FAST_MODEL;
      const evidence = {
        config_id: mismatch === 'config_id' ? 99 : 14,
        config_updated_at: mismatch === 'config_updated_at' ? '2026-08-08T09:59:59.000Z' : configUpdatedAt,
        provider: mismatch === 'provider' ? 'icreat' : 'feituo',
        model: FEITUO_FAST_MODEL,
        task_id: `mismatch-${mismatch}`,
        terminal_status: 'completed',
        artifact_id: `artifact-${mismatch}`,
      };
      state.db.prepare(`INSERT INTO ai_service_configs
        (id, service_type, provider, api_protocol, name, model, default_model, base_url, api_key,
         is_active, is_default, priority, settings, created_at, updated_at)
        VALUES (14, 'video', 'feituo', 'feituo_open', 'Feituo', ?, ?, 'https://feituokuajing.com',
                'secret', 1, 1, 0, ?, ?, ?)`)
        .run(
          JSON.stringify([rowModel]),
          rowModel,
          JSON.stringify({
            redraw_locale_capabilities: [{
              locale: 'zh-CN',
              market: 'CN',
              status: 'verified',
              evidence: { video: evidence },
            }],
          }),
          configUpdatedAt,
          configUpdatedAt,
        );
      prices.set(state.db, FEITUO_FAST_MODEL, 4, {
        category: 'video',
        billing_unit: 'second',
        resolution_prices: { '720p': { credits: 4 } },
      });
      const shotId = addShot(state.db, state.versionId, {
        compiledPrompt: {
          text: 'verified evidence binding',
          model: FEITUO_FAST_MODEL,
          duration: 6,
          resolution: '720p',
          aspect_ratio: '9:16',
        },
      });
      let conditioningCalls = 0;

      await assert.rejects(
        () => generateShot(ctx(state.db, {
          resolveVideoConditioningCapability: null,
          prepareSourceConditioning: async () => { conditioningCalls += 1; },
          schedule() {},
        }), { shotId }),
        (error) => error.code === 'REDRAW_NO_VERIFIED_VIDEO_MODEL',
      );

      assert.equal(conditioningCalls, 0, mismatch);
      assert.equal(count(state.db, 'tenant_usage_reservations'), 0, mismatch);
      assert.equal(count(state.db, 'video_generations'), 0, mismatch);
      assert.equal(count(state.db, 'async_tasks', "type = 'redraw_shot'"), 0, mismatch);
    } finally {
      state.db.close();
    }
  }
});

test('原生对白单镜拒绝客户端覆盖 prompt/model/locale/generate_audio/config/provider/价格且零副作用', async () => {
  const state = setup();
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    const shotId = addShot(state.db, state.versionId, {
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 1000, end_ms: 2200, text: 'Hola, pequeño.' },
      ]),
    });
    const forbiddenInputs = [
      { model: TOAPIS_NATIVE_MODEL },
      { locale: 'en-US' },
      { prompt: 'attacker prompt' },
      { generate_audio: false },
      { ai_service_config_id: 1 },
      { provider: 'attacker' },
      { credits: 1 },
    ];

    for (const input of forbiddenInputs) {
      await assert.rejects(
        () => generateShot(ctx(state.db, { videoProcessor: async () => assert.fail('provider must not run') }), { shotId, ...input }),
        (error) => error.code === 'REDRAW_GENERATION_INPUT_INVALID',
        JSON.stringify(input),
      );
    }

    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
    assert.equal(count(state.db, 'async_tasks', "type = 'redraw_shot'"), 0);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0);
  } finally {
    state.db.close();
  }
});

test('原生对白生成在 reserve 前要求 ready pack、verified native capability、supportsAudio、pinned config 和合法对白窗口', async () => {
  for (const scenario of ['pack', 'capability', 'configDrift', 'supportsAudio', 'dialogue']) {
    const state = setup();
    try {
      state.db.prepare('DELETE FROM ai_service_configs').run();
      addNativeDialogueCapability(state.db, scenario === 'capability'
        ? { evidence: { contract: 'redraw-native-dialogue-audio-v1' } }
        : scenario === 'configDrift'
          ? { evidenceUpdatedAt: '2026-08-06T00:00:01.000Z' }
        : {});
      state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
      const shotId = addShot(state.db, state.versionId, {
        durationMs: 6000,
        startMs: 0,
        endMs: 6000,
        localized_dialogue_json: JSON.stringify(scenario === 'dialogue'
          ? [{ speaker_id: 'Valeria', start_ms: 5000, end_ms: 7000, text: 'Hola, pequeño.' }]
          : [{ speaker_id: 'Valeria', start_ms: 1000, end_ms: 2200, text: 'Hola, pequeño.' }]),
      });
      const localeVerifier = scenario === 'pack'
        ? { assertReady: () => { const error = new Error('not ready'); error.code = 'REDRAW_LOCALE_VERIFIER_NOT_READY'; throw error; } }
        : { assertReady: () => nativePack() };
      const resolveVideoConditioningCapability = scenario === 'supportsAudio'
        ? () => ({ provider: 'toapis', protocol: 'toapis_video', model: TOAPIS_NATIVE_MODEL, config_id: 1, config_updated_at: state.now, supportsAudio: false, maxVideoReferences: 1 })
        : undefined;

      await assert.rejects(
        () => generateShot(ctx(state.db, {
          localeVerifier,
          resolveVideoConditioningCapability,
          videoProcessor: async () => assert.fail('provider must not run'),
        }), { shotId }),
        (error) => [
          'REDRAW_LOCALE_VERIFIER_NOT_READY',
          'REDRAW_NO_VERIFIED_NATIVE_AUDIO',
          'REDRAW_NATIVE_AUDIO_UNSUPPORTED',
          'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID',
        ].includes(error.code),
        scenario,
      );

      assert.equal(count(state.db, 'tenant_usage_reservations'), 0, scenario);
      assert.equal(count(state.db, 'video_generations'), 0, scenario);
      assert.equal(count(state.db, 'async_tasks', "type = 'redraw_shot'"), 0, scenario);
      assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0, scenario);
    } finally {
      state.db.close();
    }
  }
});

test('原生对白生成持久化 generate_audio、prompt/dialogue/config/locale pack 快照且强制 ToAPIs 同步音频', async () => {
  const state = setup();
  const originalCallVideoApi = videoClient.callVideoApi;
  let scheduled;
  let captured;
  try {
    videoClient.callVideoApi = async (_db, _log, opts) => {
      captured = opts;
      return { task_id: 'provider-native-shot-1', status: 'queued' };
    };
    state.db.prepare('DELETE FROM ai_service_configs').run();
    const native = addNativeDialogueCapability(state.db);
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
      compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
      ]),
    });

    const created = await generateShot(ctx(state.db, {
      resolveVideoConditioningCapability: undefined,
      evidenceRoots,
      schedule(callback) { scheduled = callback; },
    }), { shotId });
    const video = state.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.video_generation_id);
    const snapshot = JSON.parse(video.request_snapshot);

    assert.equal(video.generate_audio, 1);
    assert.equal(snapshot.generate_audio, true);
    assert.match(snapshot.prompt_hash, /^[0-9a-f]{64}$/);
    assert.match(snapshot.dialogue_snapshot_hash, /^[0-9a-f]{64}$/);
    assert.equal(snapshot.ai_service_config_id, native.configId);
    assert.equal(snapshot.config_updated_at, native.updatedAt);
    assert.equal(snapshot.locale_pack, 'es@1');
    assert.equal(snapshot.model, TOAPIS_NATIVE_MODEL);
    assert.equal(snapshot.locale, 'es');

    await scheduled();
    assert.equal(captured.generate_audio, true);
    assert.equal(captured.prompt, snapshot.prompt);
    assert.equal(captured.ai_service_config_id, native.configId);
  } finally {
    videoClient.callVideoApi = originalCallVideoApi;
    state.db.close();
  }
});

test('已验证 iCreat Mini 原生英文路径使用 4 秒无源音轨 conditioning 并固定配置证据', async () => {
  const state = setup();
  let scheduled;
  let capturedConditioning;
  let capturedVideoRequest;
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    const native = addNativeDialogueCapability(state.db, {
      provider: 'icreat',
      protocol: 'icreat_task',
      model: ICREAT_MINI_MODEL,
      baseUrl: 'https://api.icreat.ai',
      language: 'en',
      durations: [4],
    });
    prices.set(state.db, ICREAT_MINI_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'en-US', market = 'US' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 4000,
      startMs: 0,
      endMs: 4000,
      compiledPrompt: {
        text: 'Keep the live-action school entrance shot.',
        duration: 4,
        resolution: '480p',
        aspect_ratio: '9:16',
      },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Mateo', start_ms: 700, end_ms: 2400, text: 'Dude, who are you?' },
      ]),
    });

    const created = await generateShot(ctx(state.db, {
      resolveVideoConditioningCapability: undefined,
      evidenceRoots,
      localeVerifier: {
        assertReady: () => nativePack({
          id: 'en@1',
          language: 'en',
          prompt_language_label: '美式英语',
        }),
      },
      prepareSourceConditioning: async (input) => {
        capturedConditioning = input;
        return {
          referenceVideoUrl: SIGNED_SOURCE_VIDEO_URL,
          billingSnapshot: {
            source_asset_id: 1,
            source_fingerprint: 'f'.repeat(64),
            start_ms: 0,
            end_ms: 4000,
            segment_sha256: 'a'.repeat(64),
            audio_mode: input.audioMode,
          },
          auditSnapshot: {
            schema_version: '1.0',
            shot_id: Number(input.shot.id),
            source_asset_id: 1,
            source_fingerprint: 'f'.repeat(64),
            start_ms: 0,
            end_ms: 4000,
            segment_sha256: 'a'.repeat(64),
            audio_mode: input.audioMode,
          },
        };
      },
      videoProcessor: async (db, _log, videoGenerationId) => {
        const row = db.prepare('SELECT request_snapshot FROM video_generations WHERE id = ?')
          .get(videoGenerationId);
        capturedVideoRequest = JSON.parse(row.request_snapshot);
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'test stop' WHERE id = ?")
          .run(videoGenerationId);
      },
      schedule(callback) { scheduled = callback; },
    }), { shotId });
    const video = state.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.video_generation_id);
    const snapshot = JSON.parse(video.request_snapshot);

    assert.equal(capturedConditioning.audioMode, 'strip');
    assert.equal(video.model, ICREAT_MINI_MODEL);
    assert.equal(video.duration, 4);
    assert.equal(video.generate_audio, 1);
    assert.equal(snapshot.config_updated_at, native.updatedAt);
    assert.equal(snapshot.generate_audio, true);
    assert.equal(JSON.parse(video.source_conditioning_json).audio_mode, 'strip');

    await scheduled();
    assert.equal(capturedVideoRequest.model, ICREAT_MINI_MODEL);
    assert.equal(capturedVideoRequest.duration, 4);
    assert.equal(capturedVideoRequest.generate_audio, true);
    assert.deepEqual(capturedVideoRequest.reference_video_urls, [SIGNED_SOURCE_VIDEO_URL]);
  } finally {
    state.db.close();
  }
});

test('同语言有原生声画能力但当前镜头无对白时走普通视频路径', async () => {
  const state = setup();
  let providerCalls = 0;
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    prices.set(state.db, FEITUO_FAST_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 4 } },
    });
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 4 } },
    });
    addVerifiedGenerationCapability(state.db, FEITUO_FAST_MODEL, {
      id: 14,
      provider: 'feituo',
      apiProtocol: 'feituo_open',
      locale: 'es',
      market: '',
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 6000,
      startMs: 0,
      endMs: 6000,
      compiledPrompt: { text: 'silent cinematic shot', duration: 6, resolution: '720p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([]),
    });

    const created = await generateShot(ctx(state.db, {
      schedule() {},
      videoProcessor: async () => { providerCalls += 1; },
    }), { shotId });
    const video = state.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.video_generation_id);
    const snapshot = JSON.parse(video.request_snapshot);

    assert.equal(providerCalls, 0);
    assert.equal(video.prompt, 'silent cinematic shot');
    assert.equal(video.generate_audio, 0);
    assert.equal(snapshot.generate_audio, false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'prompt_hash'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'dialogue_snapshot_hash'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'locale_pack'), false);
    assert.equal(state.db.prepare('SELECT amount, status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).amount, 24);

    await runShotGeneration(ctx(state.db, {
      videoProcessor: async () => { providerCalls += 1; },
    }), created.task_id);
    assert.equal(providerCalls, 1);
  } finally {
    state.db.close();
  }
});

test('同一原生对白/config 快照跨幂等键只保留一条 active generation，快照改变不误复用', async () => {
  const state = setup();
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
      compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
      ]),
    });

    const first = await generateShot(ctx(state.db, { schedule() {}, resolveVideoConditioningCapability: undefined }), { shotId });
    const second = await generateShot(ctx(state.db, { schedule() {}, resolveVideoConditioningCapability: undefined }), { shotId, idempotency_key: 'different-client-key' });
    assert.equal(second.video_generation_id, first.video_generation_id);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);

    const snapshot = JSON.parse(state.db.prepare('SELECT request_snapshot FROM video_generations WHERE id = ?').get(first.video_generation_id).request_snapshot);
    state.db.prepare("UPDATE redraw_shots SET status = 'draft', video_generation_id = NULL, localized_dialogue_json = ? WHERE id = ?")
      .run(JSON.stringify([{ speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: '¿Te has perdido?' }]), shotId);
    await generateShot(ctx(state.db, { schedule() {}, resolveVideoConditioningCapability: undefined }), { shotId });
    const snapshots = state.db.prepare('SELECT request_snapshot FROM video_generations ORDER BY id').all()
      .map((row) => JSON.parse(row.request_snapshot));
    assert.equal(snapshots.length, 2);
    assert.notEqual(snapshots[1].dialogue_snapshot_hash, snapshot.dialogue_snapshot_hash);
  } finally {
    state.db.close();
  }
});

test('原生对白视频 completed 后先验证音轨，写入 draft evidence 后再入库资产并确认结算', async () => {
  const state = setup();
  let validationInput = null;
  let importerCalls = 0;
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
      compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
      ]),
    });

    const result = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      resolveVideoConditioningCapability: undefined,
      videoProcessor: async (db, _log, videoId) => {
        db.prepare(`UPDATE video_generations
          SET status = 'completed', provider_task_id = 'provider-native-ok',
              video_url = 'https://cdn.test/native.mp4', local_path = 'videos/native.mp4'
          WHERE id = ?`).run(videoId);
      },
      artifactVerifier: async () => ({ duration: 5, width: 720, height: 1280 }),
      nativeAudioValidator: async (input) => {
        validationInput = input;
        return {
          contract: 'redraw-native-audio-validation-v1',
          artifact_sha256: 'a'.repeat(64),
          audio_stream: { codec: 'aac', channels: 2, sample_rate: 44100, duration_ms: 4980 },
          video_duration_ms: 5000,
          silence: { rms_db: -24.1, threshold_db: -45 },
          verification: {
            detected_language: 'es',
            detected_locale: null,
            language_verified: true,
            locale_verified: false,
            transcript_sha256: 'b'.repeat(64),
            dialogue_similarity: 0.91,
            speech_chars_per_second: 8,
          },
          validation_hash: 'c'.repeat(64),
        };
      },
      assetImporter: () => {
        importerCalls += 1;
        const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
        assert.equal(draft.native_audio_validation.status, 'verified');
        return { id: 818 };
      },
    }), { shotId });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(importerCalls, 1);
    assert.equal(validationInput.videoPath, 'videos/native.mp4');
    assert.equal(validationInput.approvedText, 'Hola, pequeño.');
    assert.equal(validationInput.localePack.id, 'es@1');
    assert.equal(validationInput.expectedLanguage, 'es');
    assert.equal(validationInput.videoInvocation.providerTaskId, 'provider-native-ok');
    assert.equal(validationInput.videoInvocation.model, TOAPIS_NATIVE_MODEL);
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    assert.equal(draft.native_audio_validation.status, 'verified');
    assert.deepEqual(draft.native_audio_validation.human_review, { status: 'pending' });
    assert.equal(draft.native_audio_validation.validation_hash, 'c'.repeat(64));
    assert.equal(draft.new_video_ref.asset_id, 818);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(result.reservation_id).status, 'confirmed');
  } finally {
    state.db.close();
  }
});

test('原生对白 post-provider 音轨验证失败保持 candidate、needs_attention 和 held，跨 key 不重提', async () => {
  const state = setup();
  let providerCalls = 0;
  let validationCalls = 0;
  let importerCalls = 0;
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
      compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
      ]),
    });

    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      resolveVideoConditioningCapability: undefined,
      videoProcessor: async (db, _log, videoId) => {
        providerCalls += 1;
        db.prepare(`UPDATE video_generations
          SET status = 'completed', provider_task_id = 'provider-native-bad',
              video_url = 'https://cdn.test/native-bad.mp4', local_path = 'videos/native-bad.mp4'
          WHERE id = ?`).run(videoId);
      },
      artifactVerifier: async () => ({ duration: 5, width: 720, height: 1280 }),
      nativeAudioValidator: async () => {
        validationCalls += 1;
        const error = new Error('语言/台词验证失败');
        error.code = 'REDRAW_NATIVE_AUDIO_WORKER_EVIDENCE_INVALID';
        throw error;
      },
      assetImporter: () => {
        importerCalls += 1;
        return { id: 919 };
      },
    }), { shotId });

    assert.equal(first.status, 'needs_attention');
    assert.equal(providerCalls, 1);
    assert.equal(validationCalls, 1);
    assert.equal(importerCalls, 0);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(first.video_generation_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id).status, 'held');
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    assert.equal(draft.native_audio_validation.status, 'failed');
    assert.equal(draft.native_audio_validation.human_review.status, 'available');
    assert.equal(draft.native_audio_validation.candidate.provider_task_id_sha256.length, 64);
    assert.equal(JSON.stringify(draft.native_audio_validation).includes('provider-native-bad'), false);
    assert.equal(JSON.stringify(draft.native_audio_validation).includes('videos/native-bad.mp4'), false);

    const second = await generateShot(ctx(state.db, {
      resolveVideoConditioningCapability: undefined,
      videoProcessor: async () => { providerCalls += 1; },
    }), { shotId, idempotency_key: 'different-client-key-after-validation-failure' });
    assert.equal(second.video_generation_id, first.video_generation_id);
    assert.equal(second.status, 'needs_attention');
    assert.equal(providerCalls, 1);
  } finally {
    state.db.close();
  }
});

test('原生对白人工批准用 validation hash 和 updated_at 做 CAS，一次导入结算且重复同决定幂等', async () => {
  const state = setup();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-native-review-cas-'));
  let providerCalls = 0;
  let importerCalls = 0;
  try {
    fs.mkdirSync(path.join(storageRoot, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'videos', 'native-manual.mp4'), 'native manual artifact');
    const artifactSha256 = crypto.createHash('sha256').update('native manual artifact').digest('hex');
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
      compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
      ]),
    });
    state.db.prepare(`
      CREATE TRIGGER block_native_audio_settlement_once
      BEFORE UPDATE OF status ON tenant_usage_reservations
      WHEN NEW.status = 'confirmed'
      BEGIN
        SELECT RAISE(ABORT, 'settlement blocked');
      END
    `).run();

    const held = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      resolveVideoConditioningCapability: undefined,
      videoProcessor: async (db, _log, videoId) => {
        providerCalls += 1;
        db.prepare(`UPDATE video_generations
          SET status = 'completed', provider_task_id = 'provider-native-manual',
              video_url = 'https://cdn.test/native-manual.mp4', local_path = 'videos/native-manual.mp4'
          WHERE id = ?`).run(videoId);
      },
      artifactVerifier: async () => ({ duration: 5, width: 720, height: 1280 }),
      nativeAudioValidator: async () => nativeAudioEvidence({
        artifact_sha256: artifactSha256,
        verification: {
          detected_language: 'es',
          detected_locale: null,
          language_verified: false,
          locale_verified: false,
          transcript_sha256: 'b'.repeat(64),
          dialogue_similarity: 0.61,
          speech_chars_per_second: 8,
        },
      }),
      assetImporter: () => { throw new Error('manual review required'); },
    }), { shotId });
    assert.equal(held.status, 'needs_attention');
    state.db.prepare('DROP TRIGGER block_native_audio_settlement_once').run();
    const beforeReview = state.db.prepare('SELECT updated_at FROM redraw_shots WHERE id = ?').get(shotId).updated_at;

    await assert.rejects(
      () => reviewNativeAudio(ctx(state.db), {
        shotId,
        validation_hash: 'd'.repeat(64),
        expected_updated_at: beforeReview,
        decision: 'approved',
        speaker_order: 'passed',
        lip_sync: 'passed',
        extra_dialogue: 'passed',
      }),
      (error) => error.code === 'REDRAW_NATIVE_AUDIO_REVIEW_CONFLICT',
    );
    await assert.rejects(
      () => reviewNativeAudio(ctx(state.db), {
        shotId,
        validation_hash: 'c'.repeat(64),
        expected_updated_at: '2026-08-05T00:00:00.000Z',
        decision: 'approved',
        speaker_order: 'passed',
        lip_sync: 'passed',
        extra_dialogue: 'passed',
      }),
      (error) => error.code === 'REDRAW_NATIVE_AUDIO_REVIEW_CONFLICT',
    );

    state.db.prepare(`
      CREATE TRIGGER block_native_audio_manual_settlement_once
      BEFORE UPDATE OF status ON tenant_usage_reservations
      WHEN NEW.status = 'confirmed'
      BEGIN
        SELECT RAISE(ABORT, 'manual settlement blocked');
      END
    `).run();
    await assert.rejects(
      () => reviewNativeAudio(ctx(state.db, {
        storageRoot,
        artifactVerifier: async () => ({ duration: 5, width: 720, height: 1280 }),
        assetImporter: () => {
          importerCalls += 1;
          return { id: 1100 };
        },
      }), {
        shotId,
        validation_hash: 'c'.repeat(64),
        expected_updated_at: beforeReview,
        decision: 'approved',
        speaker_order: 'passed',
        lip_sync: 'passed',
        extra_dialogue: 'passed',
      }),
      /manual settlement blocked/,
    );
    state.db.prepare('DROP TRIGGER block_native_audio_manual_settlement_once').run();
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(held.reservation_id).status, 'held');
    assert.equal(state.db.prepare('SELECT updated_at FROM redraw_shots WHERE id = ?').get(shotId).updated_at, beforeReview);
    assert.equal(importerCalls, 1);

    const approved = await reviewNativeAudio(ctx(state.db, {
      storageRoot,
      artifactVerifier: async () => ({ duration: 5, width: 720, height: 1280 }),
      assetImporter: (db, _log, videoId) => {
        importerCalls += 1;
        assert.equal(videoId, held.video_generation_id);
        return { id: 1200 };
      },
    }), {
      shotId,
      validation_hash: 'c'.repeat(64),
      expected_updated_at: beforeReview,
      decision: 'approved',
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
    });

    assert.equal(approved.status, 'completed');
    assert.equal(providerCalls, 1);
    assert.equal(importerCalls, 2);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(held.reservation_id).status, 'confirmed');
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    assert.equal(draft.new_video_ref.asset_id, 1200);
    assert.deepEqual(draft.native_audio_validation.human_review, {
      status: 'approved',
      reviewer_id: 'user-a',
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
      manual_override: true,
      reviewed_at: '2026-08-06T00:00:00.001Z',
    });

    const duplicate = await reviewNativeAudio(ctx(state.db, {
      assetImporter: () => {
        importerCalls += 1;
        return { id: 1300 };
      },
    }), {
      shotId,
      validation_hash: 'c'.repeat(64),
      expected_updated_at: beforeReview,
      decision: 'approved',
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
    });
    assert.equal(duplicate.status, 'completed');
    assert.equal(duplicate.asset_id, 1200);
    assert.equal(importerCalls, 2);
  } finally {
    state.db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('原生对白人工批准使用默认本地 MP4 verifier 接受 needs_attention 候选但仍拒绝不可读和无音轨', async (t) => {
  const state = setup();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-native-review-'));
  t.after(() => {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  if (!writeTinyMp4(t, storageRoot, 'videos/native-manual-default.mp4')) {
    state.db.close();
    return;
  }
  if (!writeTinyMp4(t, storageRoot, 'videos/native-manual-no-audio.mp4', { audio: false })) {
    state.db.close();
    return;
  }
  let providerCalls = 0;
  let importerCalls = 0;
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
      compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
      ]),
    });
    state.db.prepare(`
      CREATE TRIGGER block_native_audio_default_settlement_once
      BEFORE UPDATE OF status ON tenant_usage_reservations
      WHEN NEW.status = 'confirmed'
      BEGIN
        SELECT RAISE(ABORT, 'default verifier settlement blocked');
      END
    `).run();
    const held = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      resolveVideoConditioningCapability: undefined,
      videoProcessor: async (db, _log, videoId) => {
        providerCalls += 1;
        db.prepare(`UPDATE video_generations
          SET status = 'completed', provider_task_id = 'provider-native-default-review',
              video_url = 'https://cdn.test/native-manual-default.mp4',
              local_path = 'videos/native-manual-default.mp4'
          WHERE id = ?`).run(videoId);
      },
      artifactVerifier: async () => ({ duration: 1, width: 16, height: 16 }),
      nativeAudioValidator: async () => nativeAudioEvidence({
        verification: {
          detected_language: 'es',
          detected_locale: null,
          language_verified: false,
          locale_verified: false,
          transcript_sha256: 'b'.repeat(64),
          dialogue_similarity: 0.61,
          speech_chars_per_second: 8,
        },
      }),
      assetImporter: () => { throw new Error('manual review required'); },
    }), { shotId });
    state.db.prepare('DROP TRIGGER block_native_audio_default_settlement_once').run();
    assert.equal(held.status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(held.video_generation_id).status, 'needs_attention');
    const beforeReview = state.db.prepare('SELECT updated_at FROM redraw_shots WHERE id = ?').get(shotId).updated_at;

    state.db.prepare("UPDATE video_generations SET local_path = 'videos/missing-native-review.mp4' WHERE id = ?")
      .run(held.video_generation_id);
    await assert.rejects(
      () => reviewNativeAudio(ctx(state.db, { storageRoot }), {
        shotId,
        validation_hash: 'c'.repeat(64),
        expected_updated_at: beforeReview,
        decision: 'approved',
        speaker_order: 'passed',
        lip_sync: 'passed',
        extra_dialogue: 'passed',
      }),
      (error) => error.code === 'REDRAW_NATIVE_AUDIO_REVIEW_UNAVAILABLE',
    );
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(held.reservation_id).status, 'held');

    const draftWithoutAudio = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    const originalAudit = draftWithoutAudio.native_audio_validation;
    draftWithoutAudio.native_audio_validation = {
      ...draftWithoutAudio.native_audio_validation,
      audio_stream: null,
      candidate: {
        ...draftWithoutAudio.native_audio_validation.candidate,
        artifact_sha256: null,
      },
    };
    state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE id = ?')
      .run(JSON.stringify(draftWithoutAudio), shotId);
    state.db.prepare("UPDATE video_generations SET local_path = 'videos/native-manual-default.mp4' WHERE id = ?")
      .run(held.video_generation_id);
    await assert.rejects(
      () => reviewNativeAudio(ctx(state.db, { storageRoot }), {
        shotId,
        validation_hash: 'c'.repeat(64),
        expected_updated_at: beforeReview,
        decision: 'approved',
        speaker_order: 'passed',
        lip_sync: 'passed',
        extra_dialogue: 'passed',
      }),
      (error) => error.code === 'REDRAW_NATIVE_AUDIO_REVIEW_UNAVAILABLE',
    );
    state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE id = ?')
      .run(JSON.stringify({
        ...draftWithoutAudio,
        native_audio_validation: nativeAudioEvidence({
          status: 'verified',
          human_review: { status: 'available' },
          candidate: originalAudit.candidate,
        }),
      }), shotId);
    state.db.prepare("UPDATE video_generations SET local_path = 'videos/native-manual-no-audio.mp4' WHERE id = ?")
      .run(held.video_generation_id);
    await assert.rejects(
      () => reviewNativeAudio(ctx(state.db, { storageRoot }), {
        shotId,
        validation_hash: 'c'.repeat(64),
        expected_updated_at: beforeReview,
        decision: 'approved',
        speaker_order: 'passed',
        lip_sync: 'passed',
        extra_dialogue: 'passed',
      }),
      (error) => error.code === 'REDRAW_NATIVE_AUDIO_REVIEW_UNAVAILABLE',
    );
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(held.reservation_id).status, 'held');

    state.db.prepare("UPDATE video_generations SET local_path = 'videos/native-manual-default.mp4' WHERE id = ?")
      .run(held.video_generation_id);
    const defaultSha256 = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(storageRoot, 'videos/native-manual-default.mp4')))
      .digest('hex');
    const draftWithActualHash = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    draftWithActualHash.native_audio_validation.artifact_sha256 = defaultSha256;
    draftWithActualHash.native_audio_validation.candidate.artifact_sha256 = defaultSha256;
    state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE id = ?')
      .run(JSON.stringify(draftWithActualHash), shotId);
    const approved = await reviewNativeAudio(ctx(state.db, {
      storageRoot,
      assetImporter: (db, _log, videoId) => {
        importerCalls += 1;
        assert.equal(videoId, held.video_generation_id);
        return { id: 1400 };
      },
    }), {
      shotId,
      validation_hash: 'c'.repeat(64),
      expected_updated_at: beforeReview,
      decision: 'approved',
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
    });

    assert.equal(approved.status, 'completed');
    assert.equal(providerCalls, 1);
    assert.equal(importerCalls, 1);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(held.video_generation_id).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(held.reservation_id).status, 'confirmed');
  } finally {
    state.db.close();
  }
});

test('原生对白人工批准 verifier await 期间分镜证据变化则 409 且不完成不结算', async () => {
  const state = setup();
  let providerCalls = 0;
  let importerCalls = 0;
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
      compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
      ]),
    });
    state.db.prepare(`
      CREATE TRIGGER block_native_audio_race_settlement_once
      BEFORE UPDATE OF status ON tenant_usage_reservations
      WHEN NEW.status = 'confirmed'
      BEGIN
        SELECT RAISE(ABORT, 'manual review required');
      END
    `).run();
    const held = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      resolveVideoConditioningCapability: undefined,
      videoProcessor: async (db, _log, videoId) => {
        providerCalls += 1;
        db.prepare(`UPDATE video_generations
          SET status = 'completed', provider_task_id = 'provider-native-race',
              video_url = 'https://cdn.test/native-race.mp4', local_path = 'videos/native-race.mp4'
          WHERE id = ?`).run(videoId);
      },
      artifactVerifier: async () => ({ duration: 5, width: 720, height: 1280 }),
      nativeAudioValidator: async () => nativeAudioEvidence({
        verification: {
          detected_language: 'es',
          detected_locale: null,
          language_verified: false,
          locale_verified: false,
          transcript_sha256: 'b'.repeat(64),
          dialogue_similarity: 0.61,
          speech_chars_per_second: 8,
        },
      }),
      assetImporter: () => ({ id: 1000 }),
    }), { shotId });
    state.db.prepare('DROP TRIGGER block_native_audio_race_settlement_once').run();
    const beforeReview = state.db.prepare('SELECT updated_at FROM redraw_shots WHERE id = ?').get(shotId).updated_at;

    await assert.rejects(
      () => reviewNativeAudio(ctx(state.db, {
        artifactVerifier: async () => {
          const row = state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId);
          const draft = JSON.parse(row.draft_json);
          draft.native_audio_validation.validation_hash = 'e'.repeat(64);
          draft.native_audio_validation.candidate.artifact_sha256 = 'f'.repeat(64);
          state.db.prepare('UPDATE redraw_shots SET draft_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(draft), '2026-08-06T00:00:00.001Z', shotId);
          return { duration: 5, width: 720, height: 1280 };
        },
        assetImporter: () => {
          importerCalls += 1;
          return { id: 1500 };
        },
      }), {
        shotId,
        validation_hash: 'c'.repeat(64),
        expected_updated_at: beforeReview,
        decision: 'approved',
        speaker_order: 'passed',
        lip_sync: 'passed',
        extra_dialogue: 'passed',
      }),
      (error) => error.code === 'REDRAW_NATIVE_AUDIO_REVIEW_CONFLICT',
    );

    assert.equal(providerCalls, 1);
    assert.equal(importerCalls, 0);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(held.video_generation_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(held.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(held.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('原生对白人工批准在导入前重新校验 artifact sha，文件替换则拒绝且不导入不结算', async () => {
  const state = setup();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-native-review-sha-'));
  let providerCalls = 0;
  let importerCalls = 0;
  try {
    fs.mkdirSync(path.join(storageRoot, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'videos', 'native-sha.mp4'), 'original artifact');
    const expectedSha256 = crypto.createHash('sha256').update('original artifact').digest('hex');
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
      compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
      ]),
    });
    state.db.prepare(`
      CREATE TRIGGER block_native_audio_sha_settlement_once
      BEFORE UPDATE OF status ON tenant_usage_reservations
      WHEN NEW.status = 'confirmed'
      BEGIN
        SELECT RAISE(ABORT, 'manual review required');
      END
    `).run();
    const held = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      resolveVideoConditioningCapability: undefined,
      videoProcessor: async (db, _log, videoId) => {
        providerCalls += 1;
        db.prepare(`UPDATE video_generations
          SET status = 'completed', provider_task_id = 'provider-native-sha',
              video_url = 'https://cdn.test/native-sha.mp4', local_path = 'videos/native-sha.mp4'
          WHERE id = ?`).run(videoId);
      },
      artifactVerifier: async () => ({ duration: 5, width: 720, height: 1280 }),
      nativeAudioValidator: async () => nativeAudioEvidence({ artifact_sha256: expectedSha256 }),
      assetImporter: () => ({ id: 1000 }),
    }), { shotId });
    state.db.prepare('DROP TRIGGER block_native_audio_sha_settlement_once').run();
    const beforeReview = state.db.prepare('SELECT updated_at FROM redraw_shots WHERE id = ?').get(shotId).updated_at;

    await assert.rejects(
      () => reviewNativeAudio(ctx(state.db, {
        storageRoot,
        probeRunner: async () => {
          fs.writeFileSync(path.join(storageRoot, 'videos', 'native-sha.mp4'), 'tampered artifact');
          return { duration: 5, width: 720, height: 1280, hasAudio: true };
        },
        assetImporter: () => {
          importerCalls += 1;
          return { id: 1600 };
        },
      }), {
        shotId,
        validation_hash: 'c'.repeat(64),
        expected_updated_at: beforeReview,
        decision: 'approved',
        speaker_order: 'passed',
        lip_sync: 'passed',
        extra_dialogue: 'passed',
      }),
      (error) => error.code === 'REDRAW_NATIVE_AUDIO_REVIEW_UNAVAILABLE',
    );

    assert.equal(providerCalls, 1);
    assert.equal(importerCalls, 0);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(held.video_generation_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(held.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(held.reservation_id).status, 'held');
  } finally {
    state.db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('原生对白人工驳回只记录审核原因，保留候选和 held 且拒绝不同决定冲突', async () => {
  const state = setup();
  let providerCalls = 0;
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addNativeDialogueCapability(state.db);
    prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '480p': { credits: 4 } },
    });
    state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
      compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
      localized_dialogue_json: JSON.stringify([
        { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
      ]),
    });

    const held = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      resolveVideoConditioningCapability: undefined,
      videoProcessor: async (db, _log, videoId) => {
        providerCalls += 1;
        db.prepare(`UPDATE video_generations
          SET status = 'completed', provider_task_id = 'provider-native-rejected',
              video_url = 'https://cdn.test/native-rejected.mp4', local_path = 'videos/native-rejected.mp4'
          WHERE id = ?`).run(videoId);
      },
      artifactVerifier: async () => ({ duration: 5, width: 720, height: 1280 }),
      nativeAudioValidator: async () => nativeAudioEvidence({
        verification: {
          detected_language: 'es',
          detected_locale: null,
          language_verified: false,
          locale_verified: false,
          transcript_sha256: 'b'.repeat(64),
          dialogue_similarity: 0.61,
          speech_chars_per_second: 8,
        },
      }),
      assetImporter: () => { throw new Error('asset register failed'); },
    }), { shotId });
    const beforeReview = state.db.prepare('SELECT updated_at FROM redraw_shots WHERE id = ?').get(shotId).updated_at;

    const rejected = await reviewNativeAudio(ctx(state.db), {
      shotId,
      validation_hash: 'c'.repeat(64),
      expected_updated_at: beforeReview,
      decision: 'rejected',
      reason: '对白顺序不可接受',
    });

    assert.equal(rejected.status, 'needs_attention');
    assert.equal(providerCalls, 1);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(held.reservation_id).status, 'held');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(held.video_generation_id).status, 'needs_attention');
    const audit = nativeAudit(state.db, shotId, held.task_id);
    assert.equal(audit.candidate.provider_task_id_sha256.length, 64);
    assert.deepEqual(audit.human_review, {
      status: 'rejected',
      reviewer_id: 'user-a',
      reason: '对白顺序不可接受',
      reviewed_at: '2026-08-06T00:00:00.001Z',
    });

    await assert.rejects(
      () => reviewNativeAudio(ctx(state.db), {
        shotId,
        validation_hash: 'c'.repeat(64),
        expected_updated_at: beforeReview,
        decision: 'approved',
        speaker_order: 'passed',
        lip_sync: 'passed',
        extra_dialogue: 'passed',
      }),
      (error) => error.code === 'REDRAW_NATIVE_AUDIO_REVIEW_CONFLICT',
    );
  } finally {
    state.db.close();
  }
});

test('原生对白 post-provider 故障矩阵均保留 held/attention/candidate/验证证据且跨 key 不重提', async () => {
  const cases = [
    {
      mode: 'artifact_failed',
      stage: 'artifact_verification',
      humanReview: 'unavailable',
      artifactVerifier: async () => {
        throw Object.assign(new Error('artifact unreadable'), { code: 'REDRAW_VIDEO_ARTIFACT_INVALID' });
      },
      expectVerifiedEvidence: false,
    },
    {
      mode: 'native_validator_failed',
      stage: 'native_audio_validation',
      humanReview: 'available',
      nativeAudioValidator: async () => {
        throw Object.assign(new Error('dialogue mismatch'), { code: 'REDRAW_NATIVE_AUDIO_WORKER_EVIDENCE_INVALID' });
      },
      expectVerifiedEvidence: false,
    },
    {
      mode: 'evidence_transaction_write_failed',
      stage: 'native_audio_evidence_write',
      humanReview: 'available',
      beforeRun(db) {
        db.prepare(`
          CREATE TRIGGER block_native_audio_draft
          BEFORE UPDATE OF draft_json ON redraw_shots
          WHEN NEW.draft_json LIKE '%native_audio_validation%'
          BEGIN
            SELECT RAISE(ABORT, 'native evidence write blocked');
          END
        `).run();
      },
      expectVerifiedEvidence: true,
    },
    {
      mode: 'asset_register_failed',
      stage: 'asset_register',
      humanReview: 'available',
      assetImporter: () => {
        throw new Error('asset register failed');
      },
      expectVerifiedEvidence: true,
    },
    {
      mode: 'settlement_failed',
      stage: 'settlement',
      humanReview: 'available',
      assetImporter: (db) => {
        db.prepare(`
          CREATE TRIGGER block_native_audio_settlement
          BEFORE UPDATE OF status ON tenant_usage_reservations
          WHEN NEW.status = 'confirmed'
          BEGIN
            SELECT RAISE(ABORT, 'settlement blocked');
          END
        `).run();
        return { id: 1000 };
      },
      expectVerifiedEvidence: true,
    },
  ];

  for (const scenario of cases) {
    const state = setup();
    let providerCalls = 0;
    let validationCalls = 0;
    let importerCalls = 0;
    try {
      state.db.prepare('DELETE FROM ai_service_configs').run();
      addNativeDialogueCapability(state.db);
      prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
        category: 'video',
        billing_unit: 'second',
        resolution_prices: { '480p': { credits: 4 } },
      });
      state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
      const shotId = addShot(state.db, state.versionId, {
        durationMs: 5000,
        startMs: 0,
        endMs: 5000,
        compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
        localized_dialogue_json: JSON.stringify([
          { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
        ]),
      });
      scenario.beforeRun?.(state.db);

      const first = await generateShot(ctx(state.db, {
        awaitCompletion: true,
        resolveVideoConditioningCapability: undefined,
        videoProcessor: async (db, _log, videoId) => {
          providerCalls += 1;
          db.prepare(`UPDATE video_generations
            SET status = 'completed', provider_task_id = ?,
                video_url = ?, local_path = ?
            WHERE id = ?`).run(`provider-${scenario.mode}`, `https://cdn.test/${scenario.mode}.mp4`, `videos/${scenario.mode}.mp4`, videoId);
        },
        artifactVerifier: scenario.artifactVerifier || (async () => ({ duration: 5, width: 720, height: 1280 })),
        nativeAudioValidator: async (...args) => {
          validationCalls += 1;
          if (scenario.nativeAudioValidator) return scenario.nativeAudioValidator(...args);
          return nativeAudioEvidence();
        },
        assetImporter: (...args) => {
          importerCalls += 1;
          if (scenario.assetImporter) return scenario.assetImporter(...args);
          return { id: 1000 };
        },
      }), { shotId });

      assert.equal(first.status, 'needs_attention', scenario.mode);
      assert.equal(providerCalls, 1, scenario.mode);
      assert.equal(validationCalls, scenario.mode === 'artifact_failed' ? 0 : 1, scenario.mode);
      assert.equal(importerCalls, ['asset_register_failed', 'settlement_failed'].includes(scenario.mode) ? 1 : 0, scenario.mode);
      assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention', scenario.mode);
      assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(first.task_id).status, 'needs_attention', scenario.mode);
      assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(first.video_generation_id).status, 'needs_attention', scenario.mode);
      assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id).status, 'held', scenario.mode);

      const audit = nativeAudit(state.db, shotId, first.task_id);
      assert.equal(audit.status, scenario.expectVerifiedEvidence ? 'verified' : 'failed', scenario.mode);
      assert.equal(audit.failure_stage, scenario.stage, scenario.mode);
      assert.equal(audit.human_review.status, scenario.humanReview, scenario.mode);
      assert.equal(audit.candidate.provider_task_id_sha256.length, 64, scenario.mode);
      assert.equal(audit.candidate.provider, 'toapis', scenario.mode);
      assert.equal(audit.candidate.model, TOAPIS_NATIVE_MODEL, scenario.mode);
      assert.equal(audit.candidate.config_id > 0, true, scenario.mode);
      assert.equal(audit.candidate.artifact_locator_sha256.length, 64, scenario.mode);
      assert.equal(JSON.stringify(audit).includes(`provider-${scenario.mode}`), false, scenario.mode);
      assert.equal(JSON.stringify(audit).includes(`videos/${scenario.mode}.mp4`), false, scenario.mode);
      if (scenario.expectVerifiedEvidence) {
        assert.equal(audit.validation_hash, 'c'.repeat(64), scenario.mode);
        assert.equal(audit.candidate.artifact_sha256, 'a'.repeat(64), scenario.mode);
        assert.equal(audit.verification.transcript_sha256, 'b'.repeat(64), scenario.mode);
      }

      const second = await generateShot(ctx(state.db, {
        resolveVideoConditioningCapability: undefined,
        videoProcessor: async () => { providerCalls += 1; },
      }), { shotId, idempotency_key: `different-key-${scenario.mode}` });
      assert.equal(second.status, 'needs_attention', scenario.mode);
      assert.equal(second.video_generation_id, first.video_generation_id, scenario.mode);
      assert.equal(providerCalls, 1, scenario.mode);
    } finally {
      state.db.close();
    }
  }
});

test('原生对白 provider completed 后下载保存失败保留 held/attention/download candidate 且跨 key 不重提', async (t) => {
  const state = setup();
  const originalCallVideoApi = videoClient.callVideoApi;
  const originalPollVideoTask = videoClient.pollVideoTask;
  const originalFetch = global.fetch;
  let providerSubmits = 0;
  t.after(() => {
    videoClient.callVideoApi = originalCallVideoApi;
    videoClient.pollVideoTask = originalPollVideoTask;
    global.fetch = originalFetch;
    state.db.close();
  });
  state.db.prepare('DELETE FROM ai_service_configs').run();
  addNativeDialogueCapability(state.db);
  prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
    category: 'video',
    billing_unit: 'second',
    resolution_prices: { '480p': { credits: 4 } },
  });
  state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
  const shotId = addShot(state.db, state.versionId, {
    durationMs: 5000,
    startMs: 0,
    endMs: 5000,
    compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
    localized_dialogue_json: JSON.stringify([
      { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
    ]),
  });

  videoClient.callVideoApi = async (_db, _log, input) => {
    providerSubmits += 1;
    assert.equal(input.generate_audio, true);
    assert.equal(input.model, TOAPIS_NATIVE_MODEL);
    return { task_id: 'provider-native-download-failure' };
  };
  videoClient.pollVideoTask = async () => ({
    video_url: 'https://cdn.test/native-download-failure.mp4?signature=secret',
  });
  global.fetch = async () => {
    throw new Error('provider artifact download failed');
  };

  const first = await generateShot(ctx(state.db, {
    awaitCompletion: true,
    resolveVideoConditioningCapability: undefined,
    evidenceRoots,
    nativeAudioValidator: async () => assert.fail('native validator must not run when download failed'),
    assetImporter: () => assert.fail('asset import must not run when download failed'),
  }), { shotId });

  assert.equal(first.status, 'needs_attention', first.error);
  assert.equal(providerSubmits, 1);
  assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(first.task_id).status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(first.video_generation_id).status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id).status, 'held');
  const audit = nativeAudit(state.db, shotId, first.task_id);
  assert.equal(audit.status, 'failed');
  assert.equal(audit.failure_stage, 'download');
  assert.equal(audit.human_review.status, 'unavailable');
  assert.equal(audit.candidate.provider_task_id_sha256.length, 64);
  assert.equal(audit.candidate.artifact_locator_sha256.length, 64);
  assert.equal(JSON.stringify(audit).includes('provider-native-download-failure'), false);
  assert.equal(JSON.stringify(audit).includes('native-download-failure.mp4'), false);
  assert.equal(JSON.stringify(audit).includes('signature=secret'), false);

  const second = await generateShot(ctx(state.db, {
    resolveVideoConditioningCapability: undefined,
    videoProcessor: async () => { providerSubmits += 1; },
  }), { shotId, idempotency_key: 'different-key-after-native-download-failure' });
  assert.equal(second.status, 'needs_attention');
  assert.equal(second.video_generation_id, first.video_generation_id);
  assert.equal(providerSubmits, 1);
});

test('generate_audio 行但缺少原生快照证据时下载失败仍按 legacy failed/refund', async (t) => {
  const state = setup();
  const originalCallVideoApi = videoClient.callVideoApi;
  const originalPollVideoTask = videoClient.pollVideoTask;
  const originalFetch = global.fetch;
  let providerSubmits = 0;
  t.after(() => {
    videoClient.callVideoApi = originalCallVideoApi;
    videoClient.pollVideoTask = originalPollVideoTask;
    global.fetch = originalFetch;
    state.db.close();
  });
  state.db.prepare('DELETE FROM ai_service_configs').run();
  addNativeDialogueCapability(state.db);
  prices.set(state.db, TOAPIS_NATIVE_MODEL, 4, {
    category: 'video',
    billing_unit: 'second',
    resolution_prices: { '480p': { credits: 4 } },
  });
  state.db.prepare("UPDATE redraw_versions SET locale = 'es', market = '' WHERE id = ?").run(state.versionId);
  const shotId = addShot(state.db, state.versionId, {
    durationMs: 5000,
    startMs: 0,
    endMs: 5000,
    compiledPrompt: { text: 'plano cinematografico', duration: 5, resolution: '480p', aspect_ratio: '16:9' },
    localized_dialogue_json: JSON.stringify([
      { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
    ]),
  });
  const created = await generateShot(ctx(state.db, {
    resolveVideoConditioningCapability: undefined,
    schedule() {},
  }), { shotId });
  state.db.prepare('UPDATE video_generations SET request_snapshot = ? WHERE id = ?')
    .run(JSON.stringify({ generate_audio: true, model: TOAPIS_NATIVE_MODEL }), created.video_generation_id);

  videoClient.callVideoApi = async (_db, _log, input) => {
    providerSubmits += 1;
    assert.equal(input.generate_audio, true);
    return { task_id: 'provider-body-audio-not-native-snapshot' };
  };
  videoClient.pollVideoTask = async () => ({ video_url: 'https://cdn.test/legacy-download-failure.mp4' });
  global.fetch = async () => { throw new Error('provider artifact download failed'); };

  const result = await runShotGeneration(ctx(state.db, {
    resolveVideoConditioningCapability: undefined,
    evidenceRoots,
  }), created.task_id);

  assert.equal(result.status, 'failed');
  assert.equal(providerSubmits, 1);
  assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'failed');
  assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(result.task_id).status, 'failed');
  assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(result.video_generation_id).status, 'failed');
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'refunded');
  assert.equal(nativeAudit(state.db, shotId, result.task_id), null);
});

test('ID14 Feituo Fast 将服务端 source segment 与已审批图片引用共同持久化且计费快照不含签名', async () => {
  const state = setup();
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    prices.set(state.db, FEITUO_FAST_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 4 } },
    });
    addVerifiedGenerationCapability(state.db, FEITUO_FAST_MODEL, {
      id: 14,
      provider: 'feituo',
      apiProtocol: 'feituo_open',
    });
    const imageAssetId = addBaseAsset(state.db, {
      name: 'approved-character',
      url: 'https://cdn.example.test/character.png',
    });
    const redrawAssetId = addRedrawAsset(state.db, state.versionId, {
      kind: 'character',
      assetId: imageAssetId,
    });
    const shotId = addShot(state.db, state.versionId, {
      startMs: 2000,
      endMs: 8000,
      references: [{ kind: 'character', redraw_asset_id: redrawAssetId }],
    });

    const result = await generateShot(ctx(state.db, {
      resolveVideoConditioningCapability: null,
      schedule() {},
    }), { shotId });
    const video = state.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(result.video_generation_id);
    const task = state.db.prepare('SELECT metadata FROM async_tasks WHERE id = ?').get(result.task_id);
    const metadata = JSON.parse(task.metadata).redraw_shot;
    const requestSnapshot = JSON.parse(video.request_snapshot);
    const identityPack = JSON.parse(
      state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?').get(redrawAssetId).source_ref_json,
    ).identity_pack;

    assert.equal(video.model, FEITUO_FAST_MODEL);
    assert.deepEqual(JSON.parse(video.reference_image_urls), ['https://cdn.example.test/character.png']);
    assert.deepEqual(requestSnapshot.identity_bindings, [{
      redraw_asset_id: Number(redrawAssetId),
      source_character_key: identityPack.source_character_key,
      target_actor_label: identityPack.target_actor_label,
      identity_pack_sha256: identityPack.pack_sha256,
    }]);
    assert.equal(JSON.stringify(requestSnapshot).includes('identity_pack'), true);
    assert.equal(JSON.stringify(requestSnapshot).includes('artifact'), false);
    assert.equal(JSON.stringify(requestSnapshot).includes('local_path'), false);
    assert.deepEqual(JSON.parse(video.reference_video_urls), [SIGNED_SOURCE_VIDEO_URL]);
    assert.equal(JSON.parse(video.source_conditioning_json).start_ms, 2000);
    assert.equal(JSON.parse(video.source_conditioning_json).end_ms, 8000);
    assert.equal(JSON.parse(video.source_conditioning_json).shot_id, shotId);
    assert.equal(metadata.quote.snapshot.source_conditioning.start_ms, 2000);
    assert.equal(metadata.quote.snapshot.source_conditioning.end_ms, 8000);
    assert.equal(JSON.stringify(metadata.quote.snapshot).includes('signature='), false);
  } finally {
    state.db.close();
  }
});

test('同一 locale 同时验证 ID9 与 ID14 时选择支持 source video 的 ID14', async () => {
  const state = setup();
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    const icreatModel = 'icreat-redraw-video-v1';
    prices.set(state.db, icreatModel, 3, { category: 'video', billing_unit: 'second' });
    prices.set(state.db, FEITUO_FAST_MODEL, 4, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 4 } },
    });
    addVerifiedGenerationCapability(state.db, icreatModel, {
      id: 9,
      provider: 'icreat',
      apiProtocol: 'icreat_task',
    });
    addVerifiedGenerationCapability(state.db, FEITUO_FAST_MODEL, {
      id: 14,
      provider: 'feituo',
      apiProtocol: 'feituo_open',
    });
    const shotId = addShot(state.db, state.versionId);

    const result = await generateShot(ctx(state.db, {
      resolveVideoConditioningCapability: null,
      schedule() {},
    }), { shotId });

    assert.equal(result.status, 'processing');
    const video = state.db.prepare('SELECT model, provider, ai_service_config_id, source_conditioning_json FROM video_generations').get();
    assert.equal(video.model, FEITUO_FAST_MODEL);
    assert.equal(video.provider, 'feituo');
    assert.equal(video.ai_service_config_id, 14);
    assert.deepEqual(JSON.parse(video.source_conditioning_json).video_capability, {
      config_id: 14,
      config_updated_at: '2026-08-06T00:00:00.000Z',
      provider: 'feituo',
      protocol: 'feituo_open',
      model: FEITUO_FAST_MODEL,
    });
    assert.equal(state.db.prepare('SELECT model FROM tenant_usage_reservations').get().model, FEITUO_FAST_MODEL);
  } finally {
    state.db.close();
  }
});

test('冻结配置在首次供应商提交前被改写时零提交并保持 held needs_attention', async (t) => {
  const state = setup();
  const originalCallVideoApi = videoClient.callVideoApi;
  let providerCalls = 0;
  let scheduled;
  t.after(() => { videoClient.callVideoApi = originalCallVideoApi; });
  t.after(() => state.db.close());
  videoClient.callVideoApi = async () => {
    providerCalls += 1;
    return { error: '配置已被改写时不得调用供应商' };
  };
  const shotId = addShot(state.db, state.versionId);
  const created = await generateShot(ctx(state.db, {
    schedule(callback) { scheduled = callback; },
  }), { shotId });
  state.db.prepare("UPDATE ai_service_configs SET provider = 'icreat', api_protocol = 'icreat_task' WHERE id = ?")
    .run(state.db.prepare('SELECT ai_service_config_id FROM video_generations WHERE id = ?').get(created.video_generation_id).ai_service_config_id);

  await scheduled();

  assert.equal(providerCalls, 0);
  assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.video_generation_id).status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
});

test('冻结配置在首次供应商提交前停用或删除时 needs_attention 保持 held 且不重提', async (t) => {
  const originalCallVideoApi = videoClient.callVideoApi;
  t.after(() => { videoClient.callVideoApi = originalCallVideoApi; });

  for (const unavailable of ['inactive', 'deleted']) {
    const state = setup();
    let providerCalls = 0;
    let scheduled;
    try {
      videoClient.callVideoApi = async () => {
        providerCalls += 1;
        return { error: '固定配置不可用时不得调用供应商' };
      };
      const shotId = addShot(state.db, state.versionId);
      const created = await generateShot(ctx(state.db, {
        schedule(callback) { scheduled = callback; },
      }), { shotId });
      const configId = state.db.prepare('SELECT ai_service_config_id FROM video_generations WHERE id = ?')
        .get(created.video_generation_id).ai_service_config_id;
      if (unavailable === 'inactive') {
        state.db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = ?').run(configId);
      } else {
        state.db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE id = ?').run(state.now, configId);
      }

      await scheduled();

      assert.equal(providerCalls, 0, unavailable);
      assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.video_generation_id).status, 'needs_attention', unavailable);
      assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention', unavailable);
      assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'needs_attention', unavailable);
      assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held', unavailable);

      const rerun = await runShotGeneration(ctx(state.db), created.task_id);
      assert.equal(rerun.status, 'needs_attention', unavailable);
      await assert.rejects(
        () => retryShot(ctx(state.db, {
          videoProcessor: async () => { providerCalls += 1; },
        }), { shotId }),
        (error) => error.code === 'REDRAW_SHOT_RETRY_REQUIRED',
        unavailable,
      );
      assert.equal(providerCalls, 0, unavailable);
    } finally {
      state.db.close();
    }
  }
});

test('无 pinned config 的旧视频配置缺失仍按明确失败退款路径处理', async () => {
  const state = setup();
  const originalCallVideoApi = videoClient.callVideoApi;
  let providerCalls = 0;
  try {
    videoClient.callVideoApi = async () => {
      providerCalls += 1;
      return { error: '缺配置时不得调用供应商' };
    };
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare('UPDATE video_generations SET ai_service_config_id = NULL, source_conditioning_json = NULL WHERE id = ?')
      .run(created.video_generation_id);
    state.db.prepare('UPDATE ai_service_configs SET deleted_at = ?').run(state.now);

    const result = await runShotGeneration(ctx(state.db), created.task_id);

    assert.equal(providerCalls, 0);
    assert.equal(result.status, 'failed');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.video_generation_id).status, 'failed');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'failed');
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'failed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'refunded');
  } finally {
    videoClient.callVideoApi = originalCallVideoApi;
    state.db.close();
  }
});

test('冻结配置的 key 或 endpoint 在首次提交前轮换时零提交并保持 held', async (t) => {
  const state = setup();
  const originalCallVideoApi = videoClient.callVideoApi;
  let providerCalls = 0;
  let scheduled;
  t.after(() => { videoClient.callVideoApi = originalCallVideoApi; });
  t.after(() => state.db.close());
  videoClient.callVideoApi = async () => {
    providerCalls += 1;
    return { error: '未验证的新 key/endpoint 不得提交' };
  };
  const shotId = addShot(state.db, state.versionId);
  const created = await generateShot(ctx(state.db, {
    schedule(callback) { scheduled = callback; },
  }), { shotId });
  const configId = state.db.prepare('SELECT ai_service_config_id FROM video_generations WHERE id = ?')
    .get(created.video_generation_id).ai_service_config_id;
  state.db.prepare(`UPDATE ai_service_configs
    SET api_key = 'rotated-unverified-key', base_url = 'https://new-endpoint.example.test', updated_at = ?
    WHERE id = ?`).run('2026-08-08T12:00:00.000Z', configId);

  await scheduled();

  assert.equal(providerCalls, 0);
  assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.video_generation_id).status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
});

test('Feituo 确定性画幅与图片数量限制在 conditioning 后 reserve 前拒绝', async () => {
  for (const mode of ['ratio', 'images']) {
    const state = setup();
    try {
      state.db.prepare('DELETE FROM ai_service_configs').run();
      prices.set(state.db, FEITUO_FAST_MODEL, 4, {
        category: 'video',
        billing_unit: 'second',
        resolution_prices: { '720p': { credits: 4 } },
      });
      addVerifiedGenerationCapability(state.db, FEITUO_FAST_MODEL, {
        id: 14,
        provider: 'feituo',
        apiProtocol: 'feituo_open',
      });
      const references = [];
      if (mode === 'images') {
        for (let index = 0; index < 5; index += 1) {
          const assetId = addBaseAsset(state.db, {
            name: `character-${index}`,
            url: `https://cdn.example.test/character-${index}.png`,
          });
          const redrawAssetId = addRedrawAsset(state.db, state.versionId, {
            kind: 'character',
            name: `character-${index}`,
            assetId,
          });
          references.push({ kind: 'character', redraw_asset_id: Number(redrawAssetId) });
        }
      }
      const shotId = addShot(state.db, state.versionId, {
        references,
        compiledPrompt: {
          text: 'deterministic preflight',
          model: FEITUO_FAST_MODEL,
          duration: 6,
          resolution: '720p',
          aspect_ratio: mode === 'ratio' ? '2:1' : '9:16',
        },
      });
      let conditioningCalls = 0;

      await assert.rejects(
        () => generateShot(ctx(state.db, {
          resolveVideoConditioningCapability: null,
          prepareSourceConditioning: async (input) => {
            conditioningCalls += 1;
            return ctx(state.db).prepareSourceConditioning(input);
          },
          schedule() {},
        }), { shotId }),
        (error) => error.code === 'REDRAW_GENERATION_INPUT_INVALID',
        mode,
      );

      assert.equal(conditioningCalls, 1, mode);
      assert.equal(count(state.db, 'tenant_usage_reservations'), 0, mode);
      assert.equal(count(state.db, 'video_generations'), 0, mode);
      assert.equal(count(state.db, 'async_tasks', "type = 'redraw_shot'"), 0, mode);
      assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0, mode);
    } finally {
      state.db.close();
    }
  }
});

test('客户端提交 reference/source video URL 在任何冻结和行写入前被拒绝', async () => {
  for (const [field, value] of [
    ['reference_video_urls', ['https://evil.example.test/source.mp4']],
    ['referenceVideoUrls', ['https://evil.example.test/source.mp4']],
    ['source_video_url', 'https://evil.example.test/source.mp4'],
    ['sourceVideoRef', { url: 'https://evil.example.test/source.mp4' }],
  ]) {
    const state = setup();
    try {
      const shotId = addShot(state.db, state.versionId);
      await assert.rejects(
        () => generateShot(ctx(state.db, { schedule() {} }), { shotId, [field]: value }),
        (error) => error.code === 'REDRAW_CLIENT_VIDEO_CONDITIONING_FORBIDDEN',
      );
      assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
      assert.equal(count(state.db, 'video_generations'), 0);
      assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0);
    } finally {
      state.db.close();
    }
  }
});

function addRawVideoConfig(db, settings, model = 'raw-config-model') {
  const now = new Date('2026-08-06T00:00:00.000Z').toISOString();
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video', 'test-provider', 'raw config', ?, ?, 1, 0, 0, ?, ?, ?)
  `).run(model, model, settings, now, now);
}

test('verified 生成模型跳过坏配置并按确定顺序选中后续有效非 seedance 模型', async () => {
  const state = setup();
  const model = 'verified-later-video-v1';
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addRawVideoConfig(state.db, '{bad-settings-json', 'bad-settings');
    addRawVideoConfig(state.db, JSON.stringify({
      redraw_locale_capabilities: [{
        locale: 'zh-CN',
        market: 'CN',
        status: 'verified',
        video_evidence_json: '{bad-evidence-json',
      }],
    }), 'bad-evidence');
    prices.set(state.db, model, 5, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 7 } },
    });
    addVerifiedGenerationCapability(state.db, model);
    const shotId = addShot(state.db, state.versionId, {
      draft: { model: 'draft-stale-model', duration: 6, resolution: '720p' },
    });

    const result = await generateShot(ctx(state.db, {
      canReadArtifact: (artifactId) => artifactId === `artifact-${model}`,
      schedule() {},
    }), { shotId });

    assert.equal(result.status, 'processing');
    assert.equal(state.db.prepare('SELECT model FROM tenant_usage_reservations').get().model, model);
    assert.equal(state.db.prepare('SELECT model FROM video_generations').get().model, model);
    assert.equal(state.db.prepare("SELECT model FROM async_tasks WHERE type = 'redraw_shot'").get().model, model);
  } finally {
    state.db.close();
  }
});

test('批量生成全是坏 capability 配置时 fail closed 且不冻结不提交 provider', async () => {
  const state = setup();
  let providerCalls = 0;
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addRawVideoConfig(state.db, '{bad-settings-json', 'bad-settings');
    addRawVideoConfig(state.db, JSON.stringify({
      redraw_locale_capabilities: [{
        locale: 'zh-CN',
        market: 'CN',
        status: 'verified',
        video_evidence_json: '{bad-evidence-json',
      }],
    }), 'bad-evidence');
    const shotId = addShot(state.db, state.versionId);

    const batch = await generateBatch(ctx(state.db, {
      videoProcessor: async () => { providerCalls += 1; },
    }), {
      versionId: state.versionId,
      shotIds: [shotId],
    });

    assert.equal(batch.results[0].error_code, 'REDRAW_NO_VERIFIED_VIDEO_MODEL');
    assert.notEqual(batch.results[0].status, 'processing');
    assert.equal(providerCalls, 0);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(count(state.db, 'async_tasks'), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0);
  } finally {
    state.db.close();
  }
});

test('未审批 gate 不冻结、不建任务或视频、不调用处理器', async () => {
  const state = setup();
  let calls = 0;
  try {
    const baseId = addBaseAsset(state.db, { name: 'char', url: 'https://cdn.test/char.png' });
    const redrawAssetId = addRedrawAsset(state.db, state.versionId, {
      kind: 'character',
      assetId: baseId,
      approvalStatus: 'pending',
    });
    const shotId = addShot(state.db, state.versionId, {
      references: [{ kind: 'character', asset_id: redrawAssetId }],
    });

    await assert.rejects(
      () => generateShot(ctx(state.db, {
        awaitCompletion: true,
        videoProcessor: async () => { calls += 1; },
      }), { shotId }),
      (error) => {
        assert.equal(error.code, 'REDRAW_ASSET_REVIEW_REQUIRED');
        assert.equal(error.details.missing.length, 1);
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(count(state.db, 'async_tasks'), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
  } finally {
    state.db.close();
  }
});

test('gate 通过后只创建 redraw_shot task 和单条 video row，供应商输入受控', async () => {
  const state = setup();
  const processorInputs = [];
  try {
    const character = addBaseAsset(state.db, { name: 'char', url: 'https://cdn.test/char.png' });
    const prop = addBaseAsset(state.db, { name: 'prop', localPath: 'props/knife.png' });
    const sceneDirty = addBaseAsset(state.db, { name: 'scene-raw', url: 'https://cdn.test/raw.png' });
    const sceneClean = addBaseAsset(state.db, { name: 'scene-clean', localPath: 'scenes/clean.png' });
    const voice = addBaseAsset(state.db, { name: 'voice', url: 'https://cdn.test/voice.mp3' });
    const characterRef = addRedrawAsset(state.db, state.versionId, { kind: 'character', assetId: character });
    const propRef = addRedrawAsset(state.db, state.versionId, { kind: 'prop', assetId: prop });
    const sceneRef = addRedrawAsset(state.db, state.versionId, {
      kind: 'scene',
      assetId: sceneDirty,
      cleanPlateAssetId: sceneClean,
    });
    const voiceRef = addRedrawAsset(state.db, state.versionId, { kind: 'voice', assetId: voice });
    const shotId = addShot(state.db, state.versionId, {
      references: [
        { kind: 'character', asset_id: characterRef },
        { kind: 'prop', asset_id: propRef },
        { kind: 'scene', asset_id: sceneRef },
        { kind: 'voice', asset_id: voiceRef },
      ],
      draft: { model: 'seedance 2.0', reference_image_urls: ['https://evil.test/free.png'] },
    });

    const result = await generateShot(ctx(state.db, {
      awaitCompletion: false,
      schedule: () => {},
      videoProcessor: async (db, _log, videoGenerationId) => {
        processorInputs.push(db.prepare('SELECT * FROM video_generations WHERE id = ?').get(videoGenerationId));
      },
    }), { shotId, count: 9 });

    assert.equal(result.status, 'processing');
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, "async_tasks", "type = 'video_generation'"), 0);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
    const task = state.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_shot'").get();
    const video = state.db.prepare('SELECT * FROM video_generations').get();
    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations').get();
    const metadata = JSON.parse(task.metadata);
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);

    assert.equal(video.task_id, task.id);
    assert.equal(video.credit_reservation_id, null);
    assert.equal(video.model, 'seedance 2.0');
    assert.equal(video.duration, 6);
    assert.equal(video.resolution, '720p');
    assert.equal(video.aspect_ratio, '9:16');
    assert.match(video.prompt, /compiled hero prompt/);
    assert.match(video.prompt, /Negative prompt: low quality/);
    assert.deepEqual(JSON.parse(video.reference_image_urls), [
      'https://cdn.test/char.png',
      '/static/props/knife.png',
      '/static/scenes/clean.png',
    ]);
    assert.equal(reservation.status, 'held');
    assert.equal(reservation.amount, 18);
    assert.equal(metadata.redraw_shot.reservation_id, reservation.id);
    assert.equal(draft.generation.reservation_id, reservation.id);
    assert.equal(draft.generation.count, 1);
    assert.deepEqual(processorInputs, []);
  } finally {
    state.db.close();
  }
});

test('重复相同 attempt 复用已有 processing task/video/reservation', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    const second = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });

    assert.equal(second.reused, true);
    assert.equal(second.task_id, first.task_id);
    assert.equal(second.video_generation_id, first.video_generation_id);
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
  } finally {
    state.db.close();
  }
});

test('旧非角色 generation 快照缺少 identity_bindings 时仍按空集合复用', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, { schedule() {} }), { shotId });
    const video = state.db.prepare('SELECT request_snapshot FROM video_generations WHERE id = ?')
      .get(first.video_generation_id);
    const legacySnapshot = JSON.parse(video.request_snapshot);
    delete legacySnapshot.identity_bindings;
    state.db.prepare('UPDATE video_generations SET request_snapshot = ? WHERE id = ?')
      .run(JSON.stringify(legacySnapshot), first.video_generation_id);

    const second = await generateShot(ctx(state.db, { schedule() {} }), { shotId });

    assert.equal(second.reused, true);
    assert.equal(second.video_generation_id, first.video_generation_id);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
  } finally {
    state.db.close();
  }
});

test('角色 generation 快照缺少 identity_bindings 时保持 fail closed', async () => {
  const state = setup();
  try {
    const baseAssetId = addBaseAsset(state.db, { name: 'actor', url: 'https://cdn.test/actor.png' });
    const redrawAssetId = addRedrawAsset(state.db, state.versionId, {
      kind: 'character',
      name: 'Actor Maya',
      assetId: baseAssetId,
    });
    const shotId = addShot(state.db, state.versionId, {
      references: [{ kind: 'character', asset_id: Number(redrawAssetId) }],
    });
    const first = await generateShot(ctx(state.db, { schedule() {} }), { shotId });
    const video = state.db.prepare('SELECT request_snapshot FROM video_generations WHERE id = ?')
      .get(first.video_generation_id);
    const legacySnapshot = JSON.parse(video.request_snapshot);
    delete legacySnapshot.identity_bindings;
    state.db.prepare('UPDATE video_generations SET request_snapshot = ? WHERE id = ?')
      .run(JSON.stringify(legacySnapshot), first.video_generation_id);

    await assert.rejects(
      () => generateShot(ctx(state.db, { schedule() {} }), { shotId }),
      (error) => error.code === 'REDRAW_SHOT_CONFLICT',
    );
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
  } finally {
    state.db.close();
  }
});

test('角色身份 hash 更新会先关闭旧镜头门禁，重绑后 request snapshot 也不会误复用旧生成', async () => {
  const state = setup();
  try {
    const baseAssetId = addBaseAsset(state.db, { name: 'actor', url: 'https://cdn.test/actor.png' });
    const firstPack = canonicalIdentityPack({
      sourceCharacterKey: 'source-character-stable',
      targetActorLabel: 'Actor Maya',
      artifactAssetId: baseAssetId,
      artifactSeed: 'actor portrait revision one',
    });
    const redrawAssetId = addRedrawAsset(state.db, state.versionId, {
      kind: 'character',
      name: 'Actor Maya',
      assetId: baseAssetId,
      identityPack: firstPack,
    });
    const shotId = addShot(state.db, state.versionId, {
      references: [{ character_asset_id: Number(redrawAssetId) }],
    });
    const first = await generateShot(ctx(state.db, { schedule() {} }), { shotId });
    const firstSnapshot = JSON.parse(
      state.db.prepare('SELECT request_snapshot FROM video_generations WHERE id = ?').get(first.video_generation_id).request_snapshot,
    );
    assert.deepEqual(firstSnapshot.identity_bindings, [{
      redraw_asset_id: Number(redrawAssetId),
      source_character_key: firstPack.source_character_key,
      target_actor_label: firstPack.target_actor_label,
      identity_pack_sha256: firstPack.pack_sha256,
    }]);

    const secondPack = canonicalIdentityPack({
      sourceCharacterKey: firstPack.source_character_key,
      targetActorLabel: firstPack.target_actor_label,
      artifactAssetId: baseAssetId,
      artifactSeed: 'actor portrait revision two',
      reviewed_at: '2026-08-06T01:00:00.000Z',
    });
    state.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = ?')
      .run(JSON.stringify({
        source_ref: { stable_id: firstPack.source_character_key },
        identity_pack: secondPack,
      }), redrawAssetId);

    await assert.rejects(
      () => generateShot(ctx(state.db, { schedule() {} }), { shotId }),
      (error) => error.code === 'REDRAW_ASSET_REVIEW_REQUIRED'
        && error.details.missing[0].code === 'character_identity_binding_stale',
    );

    const binding = identityBindingForAsset(
      state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(redrawAssetId),
    );
    state.db.prepare(`UPDATE redraw_shots
      SET status = 'draft', references_json = ?
      WHERE id = ?`).run(JSON.stringify([{
      character_asset_id: Number(redrawAssetId),
      source_character_key: binding.source_character_key,
      target_actor_label: binding.target_actor_label,
      identity_pack_sha256: binding.pack_sha256,
    }]), shotId);

    await assert.rejects(
      () => generateShot(ctx(state.db, { schedule() {} }), { shotId }),
      (error) => error.code === 'REDRAW_SHOT_CONFLICT',
    );
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
  } finally {
    state.db.close();
  }
});

test('角色 identity bindings 按集合 canonical 排序，A/B 引用反序仍复用同一生成', async () => {
  const state = setup();
  try {
    const baseA = addBaseAsset(state.db, { name: 'actor-a', url: 'https://cdn.test/actor-a.png' });
    const baseB = addBaseAsset(state.db, { name: 'actor-b', url: 'https://cdn.test/actor-b.png' });
    const redrawA = addRedrawAsset(state.db, state.versionId, {
      kind: 'character',
      name: 'Actor A',
      assetId: baseA,
    });
    const redrawB = addRedrawAsset(state.db, state.versionId, {
      kind: 'character',
      name: 'Actor B',
      assetId: baseB,
    });
    const shotId = addShot(state.db, state.versionId, {
      references: [
        { kind: 'character', asset_id: Number(redrawB) },
        { kind: 'character', asset_id: Number(redrawA) },
      ],
    });

    const first = await generateShot(ctx(state.db, { schedule() {} }), { shotId });
    const firstSnapshot = JSON.parse(
      state.db.prepare('SELECT request_snapshot FROM video_generations WHERE id = ?').get(first.video_generation_id).request_snapshot,
    );
    assert.deepEqual(
      firstSnapshot.identity_bindings.map((binding) => binding.redraw_asset_id),
      [Number(redrawA), Number(redrawB)],
    );

    const storedReferences = JSON.parse(
      state.db.prepare('SELECT references_json FROM redraw_shots WHERE id = ?').get(shotId).references_json,
    );
    state.db.prepare('UPDATE redraw_shots SET references_json = ? WHERE id = ?')
      .run(JSON.stringify(storedReferences.reverse()), shotId);
    const second = await generateShot(ctx(state.db, { schedule() {} }), { shotId });

    assert.equal(second.reused, true);
    assert.equal(second.video_generation_id, first.video_generation_id);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
  } finally {
    state.db.close();
  }
});

test('两个 draft 并发生成由 CAS 保证 loser 复用 winner 且只冻结调度一次', async () => {
  const state = setup();
  let hookCalls = 0;
  let scheduled = 0;
  let releaseFirst;
  let firstEnteredResolve;
  const firstEntered = new Promise((resolve) => { firstEnteredResolve = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const beforeCreateTransaction = async () => {
    hookCalls += 1;
    if (hookCalls === 1) {
      firstEnteredResolve();
      await firstBlocked;
    }
  };
  try {
    const shotId = addShot(state.db, state.versionId);
    const context = ctx(state.db, {
      beforeCreateTransaction,
      schedule: () => { scheduled += 1; },
    });
    const firstPromise = generateShot(context, { shotId });
    await firstEntered;
    assert.equal(hookCalls, 1, 'beforeCreateTransaction hook must pause the first creator');
    const winner = await generateShot(context, { shotId });
    releaseFirst();
    const loser = await firstPromise;

    assert.equal(loser.reused, true);
    assert.equal(loser.task_id, winner.task_id);
    assert.equal(loser.video_generation_id, winner.video_generation_id);
    assert.equal(loser.reservation_id, winner.reservation_id);
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 18);
    assert.equal(scheduled, 1);
  } finally {
    releaseFirst?.();
    state.db.close();
  }
});

test('并发 loser 传入不同客户端模型时仍复用 verified 生成链且不产生第二冻结', async () => {
  const state = setup();
  prices.set(state.db, 'other-video-model', 4, {
    category: 'video',
    billing_unit: 'second',
    resolution_prices: { '720p': { credits: 4 } },
  });
  let hookCalls = 0;
  let scheduled = 0;
  let releaseFirst;
  let firstEnteredResolve;
  const firstEntered = new Promise((resolve) => { firstEnteredResolve = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const beforeCreateTransaction = async () => {
    hookCalls += 1;
    if (hookCalls === 1) {
      firstEnteredResolve();
      await firstBlocked;
    }
  };
  try {
    const shotId = addShot(state.db, state.versionId);
    const context = ctx(state.db, {
      beforeCreateTransaction,
      schedule: () => { scheduled += 1; },
    });
    const loserPromise = generateShot(context, { shotId });
    await firstEntered;
    assert.equal(hookCalls, 1, 'beforeCreateTransaction hook must pause the first creator');
    const winner = await generateShot(context, { shotId });
    releaseFirst();
    const loser = await loserPromise;

    assert.equal(loser.reused, true);
    assert.equal(loser.task_id, winner.task_id);
    assert.equal(loser.video_generation_id, winner.video_generation_id);
    assert.equal(loser.reservation_id, winner.reservation_id);
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 18);
    assert.equal(scheduled, 1);
    assert.equal(winner.status, 'processing');
  } finally {
    releaseFirst?.();
    state.db.close();
  }
});

test('创建事务前 updated_at 被改变时 CAS 回滚且不冻结不调度', async () => {
  const state = setup();
  let scheduled = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    await assert.rejects(
      () => generateShot(ctx(state.db, {
        beforeCreateTransaction: async () => {
          state.db.prepare('UPDATE redraw_shots SET updated_at = ? WHERE id = ?')
            .run('2026-08-06T00:00:01.000Z', shotId);
        },
        schedule: () => { scheduled += 1; },
      }), { shotId }),
      (error) => error.code === 'REDRAW_SHOT_CONFLICT',
    );
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0);
    assert.equal(scheduled, 0);
  } finally {
    state.db.close();
  }
});

test('跨租户调用 redraw_shot task fail closed 且不调用处理器不改状态账单', async () => {
  const state = setup();
  let calls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    const beforeTask = state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(created.task_id);
    const beforeShot = state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId);
    const beforeVideo = state.db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.video_generation_id);
    const beforeReservation = state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id);

    await assert.rejects(
      () => runShotGeneration(ctx(state.db, {
        tenantId: 'tenant-b',
        userId: 'user-b',
        videoProcessor: async () => { calls += 1; },
      }), created.task_id),
      (error) => ['REDRAW_SHOT_NOT_FOUND', 'UNAUTHORIZED', 'REDRAW_SHOT_TASK_NOT_FOUND'].includes(error.code),
    );

    assert.equal(calls, 0);
    assert.deepEqual(state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(created.task_id), beforeTask);
    assert.deepEqual(state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId), beforeShot);
    assert.deepEqual(state.db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.video_generation_id), beforeVideo);
    assert.deepEqual(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id), beforeReservation);
  } finally {
    state.db.close();
  }
});

test('awaitCompletion 成功后写回成片素材、task result 并确认账单', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const result = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', 'https://cdn.test/video.mp4', 'videos/shot.mp4', id);
      },
      artifactVerifier: async () => ({ duration: 6.1, width: 720, height: 1280 }),
      assetImporter: () => ({ id: 77 }),
    }), { shotId });

    const shot = state.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(shotId);
    const task = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(result.task_id);
    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations').get();
    const draft = JSON.parse(shot.draft_json);
    assert.equal(result.status, 'completed');
    assert.equal(shot.status, 'completed');
    assert.equal(draft.new_video_ref.asset_id, 77);
    assert.equal(draft.new_video_ref.video_url, 'https://cdn.test/video.mp4');
    assert.equal(JSON.parse(task.result).asset_id, 77);
    assert.equal(reservation.status, 'confirmed');
  } finally {
    state.db.close();
  }
});

test('单镜开始生成时后端将 work/version 固定回第三步', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    state.db.prepare("UPDATE redraw_versions SET status = 'composing' WHERE id = ?").run(state.versionId);
    state.db.prepare("UPDATE redraw_works SET status = 'composing', current_step = 4 WHERE id = ?").run(state.workId);

    const result = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });

    assert.equal(result.status, 'processing');
    assert.deepEqual(workflowState(state.db, state.versionId), {
      version_status: 'generating',
      work_status: 'generating',
      current_step: 3,
    });
  } finally {
    state.db.close();
  }
});

test('只有最后一个完成且全部分镜有 video_generation_id 才推进第四步', async () => {
  const state = setup();
  try {
    const firstShotId = addShot(state.db, state.versionId, { shotIndex: 1 });
    const secondShotId = addShot(state.db, state.versionId, { shotIndex: 2, startMs: 6000 });
    const completeCtx = ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', `https://cdn.test/${id}.mp4`, `videos/${id}.mp4`, id);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: (_db, _log, id) => ({ id: 7000 + Number(id) }),
    });

    await generateShot(completeCtx, { shotId: firstShotId });
    assert.deepEqual(workflowState(state.db, state.versionId), {
      version_status: 'generating',
      work_status: 'generating',
      current_step: 3,
    });

    await generateShot(completeCtx, { shotId: secondShotId });
    assert.deepEqual(workflowState(state.db, state.versionId), {
      version_status: 'composing',
      work_status: 'composing',
      current_step: 4,
    });
  } finally {
    state.db.close();
  }
});

test('第四步推进只统计当前 owner/version 的有效分镜', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const now = new Date().toISOString();
    state.db.prepare(`INSERT INTO redraw_shots
      (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
       references_json, prompt, negative_prompt, compiled_prompt_json, draft_json, status, created_at, updated_at)
      VALUES (?, 'tenant-b', 'user-b', 1, 99, 0, 6000, 6000, '[]', 'foreign', '', '{}', '{}', 'draft', ?, ?)`)
      .run(state.versionId, now, now);

    await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', 'https://cdn.test/owner.mp4', 'videos/owner.mp4', id);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: () => ({ id: 88 }),
    }), { shotId });

    assert.deepEqual(workflowState(state.db, state.versionId), {
      version_status: 'composing',
      work_status: 'composing',
      current_step: 4,
    });
    assert.equal(
      state.db.prepare("SELECT status FROM redraw_shots WHERE version_id = ? AND tenant_id = 'tenant-b'").get(state.versionId).status,
      'draft',
    );
  } finally {
    state.db.close();
  }
});

test('失败和重试都会把旧第四步降级回第三步', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    state.db.prepare("UPDATE redraw_versions SET status = 'composing' WHERE id = ?").run(state.versionId);
    state.db.prepare("UPDATE redraw_works SET status = 'composing', current_step = 4 WHERE id = ?").run(state.workId);
    const failed = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, error_msg = ? WHERE id = ?')
          .run('failed', 'provider failed', id);
      },
    }), { shotId });

    assert.equal(failed.status, 'failed');
    assert.deepEqual(workflowState(state.db, state.versionId), {
      version_status: 'generating',
      work_status: 'generating',
      current_step: 3,
    });

    state.db.prepare("UPDATE redraw_versions SET status = 'composing' WHERE id = ?").run(state.versionId);
    state.db.prepare("UPDATE redraw_works SET status = 'composing', current_step = 4 WHERE id = ?").run(state.workId);
    const retried = await retryShot(ctx(state.db, { schedule: () => {} }), { shotId });

    assert.equal(retried.status, 'processing');
    assert.deepEqual(workflowState(state.db, state.versionId), {
      version_status: 'generating',
      work_status: 'generating',
      current_step: 3,
    });
  } finally {
    state.db.close();
  }
});

test('completed 终态再次 run 直接复用结果不重跑处理器也不重复确认账单', async () => {
  const state = setup();
  let calls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        calls += 1;
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', 'https://cdn.test/video.mp4', 'videos/shot.mp4', id);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: () => ({ id: 77 }),
    }), { shotId });
    const before = {
      task: state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(first.task_id),
      shot: state.db.prepare('SELECT status, draft_json FROM redraw_shots WHERE id = ?').get(shotId),
      video: state.db.prepare('SELECT status, video_url, local_path, error_msg FROM video_generations WHERE id = ?').get(first.video_generation_id),
      confirms: count(state.db, 'tenant_credit_ledger', "event_type = 'confirm'"),
    };

    const second = await runShotGeneration(ctx(state.db, {
      videoProcessor: async () => { calls += 1; },
    }), first.task_id);

    assert.equal(second.status, 'completed');
    assert.equal(second.task_id, first.task_id);
    assert.equal(second.video_generation_id, first.video_generation_id);
    assert.equal(second.asset_id, 77);
    assert.equal(calls, 1);
    assert.deepEqual(state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(first.task_id), before.task);
    assert.deepEqual(state.db.prepare('SELECT status, draft_json FROM redraw_shots WHERE id = ?').get(shotId), before.shot);
    assert.deepEqual(state.db.prepare('SELECT status, video_url, local_path, error_msg FROM video_generations WHERE id = ?').get(first.video_generation_id), before.video);
    assert.equal(count(state.db, 'tenant_credit_ledger', "event_type = 'confirm'"), before.confirms);
  } finally {
    state.db.close();
  }
});

test('同一 task 两个 runner 并发成功收口只导入一次素材并只确认一次账单', async () => {
  const state = setup();
  let processorArrivals = 0;
  let releaseProcessors;
  const processorBarrier = new Promise((resolve) => { releaseProcessors = resolve; });
  let importCalls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    const runnerContext = ctx(state.db, {
      videoProcessor: async (db, _log, videoId) => {
        processorArrivals += 1;
        if (processorArrivals === 2) releaseProcessors();
        await processorBarrier;
        db.prepare("UPDATE video_generations SET status = 'completed', video_url = 'https://cdn.test/race.mp4', local_path = 'videos/race.mp4' WHERE id = ?")
          .run(videoId);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: (db, _log, videoId) => {
        importCalls += 1;
        const assetId = addBaseAsset(db, { name: `race-${importCalls}`, category: 'video', localPath: 'videos/race.mp4' });
        db.prepare('UPDATE assets SET video_gen_id = ? WHERE id = ?').run(videoId, assetId);
        return { id: assetId };
      },
    });
    const results = await Promise.all([
      runShotGeneration(runnerContext, created.task_id),
      runShotGeneration(runnerContext, created.task_id),
    ]);
    assert.deepEqual(results.map((result) => result.status), ['completed', 'completed']);
    assert.equal(importCalls, 1);
    assert.equal(count(state.db, 'assets', `video_gen_id = ${created.video_generation_id}`), 1);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'confirmed');
    assert.equal(count(state.db, 'tenant_credit_ledger', `reservation_id = '${created.reservation_id}' AND event_type = 'confirm'`), 1);
  } finally {
    releaseProcessors?.();
    state.db.close();
  }
});

test('明确失败会标记 shot failed 并退款', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const result = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, error_msg = ? WHERE id = ?')
          .run('failed', 'provider rejected prompt', id);
      },
    }), { shotId });

    assert.equal(result.status, 'failed');
    assert.equal(state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId).status, 'failed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'refunded');
  } finally {
    state.db.close();
  }
});

test('失败结算异常会回滚 failed 终态并原子降级 needs_attention 且保持 held', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare('UPDATE tenant_credit_accounts SET held = 0 WHERE tenant_id = ?').run('tenant-a');
    const result = await runShotGeneration(ctx(state.db, {
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, error_msg = ? WHERE id = ?')
          .run('failed', 'provider rejected prompt', id);
      },
    }), created.task_id);

    assert.equal(result.status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status, error FROM async_tasks WHERE id = ?').get(created.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.video_generation_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('未知或仍 processing 保持 held 并转 needs_attention，不重提', async () => {
  for (const errorMsg of ['供应商结果未知，请勿重新提交', '状态未知', '仍可能处理中']) {
    const state = setup();
    let calls = 0;
    try {
      const shotId = addShot(state.db, state.versionId);
      const result = await generateShot(ctx(state.db, {
        awaitCompletion: true,
        videoProcessor: async (db, _log, id) => {
          calls += 1;
          db.prepare('UPDATE video_generations SET status = ?, error_msg = ? WHERE id = ?')
            .run('processing', errorMsg, id);
        },
      }), { shotId });

      assert.equal(result.status, 'needs_attention');
      assert.equal(calls, 1);
      assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
      assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
    } finally {
      state.db.close();
    }
  }
});

test('Feituo 提交结果 indeterminate 优先于 error，保持 held 且禁止重试', async (t) => {
  const state = setup();
  const originalCallVideoApi = videoClient.callVideoApi;
  let providerCalls = 0;
  t.after(() => { videoClient.callVideoApi = originalCallVideoApi; });
  t.after(() => state.db.close());
  videoClient.callVideoApi = async () => {
    providerCalls += 1;
    return {
      indeterminate: true,
      error: '飞拓提交响应未知，供应商任务可能已创建，不得自动重试',
    };
  };
  const shotId = addShot(state.db, state.versionId);

  const result = await generateShot(ctx(state.db, { awaitCompletion: true }), { shotId });

  assert.equal(result.status, 'needs_attention', JSON.stringify({
    result,
    video: state.db.prepare('SELECT status, error_msg, provider, ai_service_config_id, source_conditioning_json FROM video_generations').get(),
  }));
  assert.equal(providerCalls, 1);
  assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
  const videoOutcome = state.db.prepare('SELECT status, error_msg, provider, ai_service_config_id, source_conditioning_json FROM video_generations').get();
  assert.equal(videoOutcome.status, 'needs_attention', JSON.stringify(videoOutcome));
  assert.equal(state.db.prepare("SELECT status FROM async_tasks WHERE type = 'redraw_shot'").get().status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  await assert.rejects(
    () => retryShot(ctx(state.db, { schedule() {} }), { shotId }),
    (error) => error.code === 'REDRAW_SHOT_RETRY_REQUIRED',
  );
  assert.equal(providerCalls, 1);
  assert.equal(count(state.db, 'video_generations'), 1);
});

test('completed 但成片校验或素材导入不完整时 needs_attention 且保持 held', async () => {
  for (const mode of ['missing_local_path', 'artifact_failed', 'import_failed']) {
    const state = setup();
    try {
      const shotId = addShot(state.db, state.versionId);
      const result = await generateShot(ctx(state.db, {
        awaitCompletion: true,
        videoProcessor: async (db, _log, id) => {
          db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
            .run('completed', 'https://cdn.test/video.mp4', mode === 'missing_local_path' ? null : 'videos/shot.mp4', id);
        },
        artifactVerifier: async () => {
          if (mode === 'artifact_failed') throw Object.assign(new Error('bad artifact'), { code: 'REDRAW_VIDEO_ARTIFACT_INVALID' });
          return { duration: 6, width: 720, height: 1280 };
        },
        assetImporter: () => (mode === 'import_failed' ? null : { id: 91 }),
      }), { shotId });
      const video = state.db.prepare(`
        SELECT status, error_msg, video_url, local_path
        FROM video_generations
        WHERE id = ?
      `).get(result.video_generation_id);
      assert.equal(result.status, 'needs_attention');
      assert.equal(video.status, 'needs_attention');
      assert.match(video.error_msg, mode === 'import_failed' ? /素材入库失败/ : /视频|artifact|bad artifact|不完整/);
      assert.equal(video.video_url, 'https://cdn.test/video.mp4');
      if (mode !== 'missing_local_path') assert.equal(video.local_path, 'videos/shot.mp4');
      assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
    } finally {
      state.db.close();
    }
  }
});

test('素材导入写入后抛错会回滚新增 asset 并降级 needs_attention 保持 held', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const result = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', 'https://cdn.test/video.mp4', 'videos/shot.mp4', id);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: (db, _log, id) => {
        addBaseAsset(db, { name: 'orphan-video', category: 'video', localPath: 'videos/shot.mp4' });
        db.prepare('UPDATE assets SET video_gen_id = ? WHERE name = ?').run(id, 'orphan-video');
        throw new Error('asset import exploded');
      },
    }), { shotId });

    assert.equal(result.status, 'needs_attention');
    assert.equal(count(state.db, 'assets', "video_gen_id IS NOT NULL"), 0);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(result.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(result.video_generation_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  } finally {
    state.db.close();
  }
});

test('processor 先写 completed result 后成片校验失败会清理 task 终态并保持 held', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const result = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        const taskId = db.prepare('SELECT task_id FROM video_generations WHERE id = ?').get(id).task_id;
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', 'https://cdn.test/video.mp4', 'videos/shot.mp4', id);
        taskService.updateTaskResult(db, taskId, { status: 'completed', video_generation_id: id });
      },
      artifactVerifier: async () => {
        throw Object.assign(new Error('ffprobe failed'), { code: 'REDRAW_VIDEO_ARTIFACT_INVALID' });
      },
    }), { shotId });

    const task = state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(result.task_id);
    const video = state.db.prepare('SELECT status, error_msg, video_url, local_path FROM video_generations WHERE id = ?').get(result.video_generation_id);
    assert.equal(result.status, 'needs_attention');
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.result, null);
    assert.equal(task.completed_at, null);
    assert.equal(video.status, 'needs_attention');
    assert.match(video.error_msg, /ffprobe failed/);
    assert.equal(video.video_url, 'https://cdn.test/video.mp4');
    assert.equal(video.local_path, 'videos/shot.mp4');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  } finally {
    state.db.close();
  }
});

test('processor 写入互相矛盾终态时原子降级 needs_attention 且不重跑第二次', async () => {
  const state = setup();
  let calls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE redraw_shots SET status = 'completed' WHERE id = ?").run(shotId);
    state.db.prepare("UPDATE async_tasks SET status = 'completed', result = '{}' WHERE id = ?").run(created.task_id);
    state.db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(created.video_generation_id);

    const result = await runShotGeneration(ctx(state.db, {
      videoProcessor: async () => { calls += 1; },
    }), created.task_id);

    assert.equal(result.status, 'needs_attention');
    assert.equal(calls, 0);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.video_generation_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('resumeRedrawTasks 先将中断 redraw_shot 降级 needs_attention，避免视频恢复误失败和退款', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });

    const resumed = await redrawOrchestrator.resumeRedrawTasks(state.db, log);
    videoService.resumeProcessingVideoGenerations(state.db, log);

    const task = state.db.prepare('SELECT status, result, completed_at, error FROM async_tasks WHERE id = ?').get(created.task_id);
    const shot = state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId);
    const video = state.db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.video_generation_id);
    const reservation = state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id);

    assert.equal(resumed.shot_needs_attention, 1);
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.result, null);
    assert.equal(task.completed_at, null);
    assert.match(task.error, /请勿重新提交/);
    assert.equal(shot.status, 'needs_attention');
    assert.match(shot.error_message, /请勿重新提交/);
    assert.equal(video.status, 'needs_attention');
    assert.match(video.error_msg, /请勿重新提交/);
    assert.equal(reservation.status, 'held');
  } finally {
    state.db.close();
  }
});

test('启动恢复无 provider_task_id 路径会把旧第四步降回第三步', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE redraw_versions SET status = 'composing' WHERE id = ?").run(state.versionId);
    state.db.prepare("UPDATE redraw_works SET status = 'composing', current_step = 4 WHERE id = ?").run(state.workId);

    const changed = markInterruptedShotGenerationsNeedsAttention(state.db, log);

    assert.equal(changed, 1);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.deepEqual(workflowState(state.db, state.versionId), {
      version_status: 'generating',
      work_status: 'generating',
      current_step: 3,
    });
  } finally {
    state.db.close();
  }
});

test('verifyVideoArtifact 使用 realpath 阻止指向根外的 symlink 但允许根内 symlink', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-video-symlink-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-video-outside-'));
  try {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const realInside = path.join(tempRoot, 'real', 'inside.mp4');
    const realOutside = path.join(outsideRoot, 'outside.mp4');
    const linkInside = path.join(tempRoot, 'videos', 'inside-link.mp4');
    const linkOutside = path.join(tempRoot, 'videos', 'outside-link.mp4');
    fs.mkdirSync(path.dirname(realInside), { recursive: true });
    fs.mkdirSync(path.dirname(linkInside), { recursive: true });
    fs.writeFileSync(realInside, Buffer.from('video'));
    fs.writeFileSync(realOutside, Buffer.from('video'));
    try {
      fs.symlinkSync(realInside, linkInside);
      fs.symlinkSync(realOutside, linkOutside);
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      db.close();
      return;
    }
    const now = new Date().toISOString();
    const insideId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', 'videos/inside-link.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;
    const outsideId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', 'videos/outside-link.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;

    const verified = await verifyVideoArtifact({
      db,
      storageRoot: tempRoot,
      probeRunner: async () => ({ duration: 6, width: 720, height: 1280 }),
    }, insideId);
    assert.deepEqual(verified, { duration: 6, width: 720, height: 1280 });
    await assert.rejects(
      () => verifyVideoArtifact({
        db,
        storageRoot: tempRoot,
        probeRunner: async () => ({ duration: 6, width: 720, height: 1280 }),
      }, outsideId),
      (error) => error.code === 'REDRAW_VIDEO_ARTIFACT_INVALID',
    );
    db.close();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('default ffprobe 调用设置超时、buffer、killSignal 和 Windows 隐藏窗口', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'redrawGenerationService.js'), 'utf8');
  assert.match(source, /timeout:\s*15000/);
  assert.match(source, /maxBuffer:\s*1024\s*\*\s*1024/);
  assert.match(source, /killSignal:\s*'SIGKILL'/);
  assert.match(source, /windowsHide:\s*true/);
});

test('verifyVideoArtifact 默认不要求音轨，requireAudio 时拒绝无音轨 MP4', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-video-no-audio-'));
  let db;
  try {
    if (!writeTinyMp4(t, tempRoot, 'videos/no-audio.mp4', { audio: false })) return;
    db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const now = new Date().toISOString();
    const videoId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', 'videos/no-audio.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;

    const verified = await verifyVideoArtifact({ db, storageRoot: tempRoot }, videoId);
    assert.equal(verified.width, 16);
    assert.equal(verified.height, 16);
    assert.ok(verified.duration > 0);
    await assert.rejects(
      () => verifyVideoArtifact({ db, storageRoot: tempRoot }, videoId, { requireAudio: true }),
      (error) => error.code === 'REDRAW_VIDEO_ARTIFACT_INVALID',
    );
  } finally {
    db?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('verifyVideoArtifact 路径越界和缺文件 fail closed，probeRunner 成功时返回元数据', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-video-artifact-'));
  try {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const inside = path.join(tempRoot, 'videos', 'ok.mp4');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, Buffer.from('video'));
    const now = new Date().toISOString();
    const insideId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', 'videos/ok.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;
    const missingId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', 'videos/missing.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;
    const outsideId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', '../outside.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;

    await assert.rejects(
      () => verifyVideoArtifact({ db, storageRoot: tempRoot }, outsideId),
      (error) => error.code === 'REDRAW_VIDEO_ARTIFACT_INVALID',
    );
    await assert.rejects(
      () => verifyVideoArtifact({ db, storageRoot: tempRoot }, missingId),
      (error) => error.code === 'REDRAW_VIDEO_ARTIFACT_INVALID',
    );
    const verified = await verifyVideoArtifact({
      db,
      storageRoot: tempRoot,
      probeRunner: async () => ({ duration: 6, width: 720, height: 1280 }),
    }, insideId);
    assert.deepEqual(verified, { duration: 6, width: 720, height: 1280 });
    db.close();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('坏 JSON 在冻结前失败并保持事务无写入', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId, { compiledPrompt: '{bad json' });
    await assert.rejects(
      () => generateShot(ctx(state.db, { awaitCompletion: true }), { shotId }),
      (error) => error.code === 'REDRAW_INVALID_JSON',
    );
    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(count(state.db, 'async_tasks'), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
  } finally {
    state.db.close();
  }
});

test('classifyVideoOutcome 不把不完整 completed 当 completed', () => {
  assert.equal(classifyVideoOutcome({ status: 'completed', local_path: 'videos/a.mp4' }, { duration: 1, width: 1, height: 1 }).status, 'completed');
  assert.equal(classifyVideoOutcome({ status: 'completed', local_path: '' }, null).status, 'needs_attention');
  assert.equal(classifyVideoOutcome({ status: 'failed', error_msg: 'bad prompt' }, null).status, 'failed');
  assert.equal(classifyVideoOutcome({ status: 'processing', error_msg: '结果未知，请勿重新提交' }, null).status, 'needs_attention');
});

test('批量只提交同版本中通过门禁且未完成未处理的镜头，并逐镜独立计费', async () => {
  const state = setup();
  const submitted = [];
  let scheduled = null;
  try {
    const shot1 = addShot(state.db, state.versionId, { shotIndex: 1 });
    const shot2 = addShot(state.db, state.versionId, { shotIndex: 2, status: 'completed' });
    const shot3 = addShot(state.db, state.versionId, { shotIndex: 3 });
    const shot4 = addShot(state.db, state.versionId, { shotIndex: 4, status: 'processing' });
    const result = await generateBatch(ctx(state.db, {
      generationConcurrency: 2,
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        const row = db.prepare(`SELECT t.resource_id FROM video_generations v JOIN async_tasks t ON t.id = v.task_id WHERE v.id = ?`).get(videoId);
        submitted.push(Number(row.resource_id));
        db.prepare("UPDATE video_generations SET status = 'processing', error_msg = '状态未知' WHERE id = ?").run(videoId);
      },
    }), { versionId: state.versionId, shotIds: [shot1, shot2, shot3, shot4] });

    assert.equal(result.results.every((item) => item.status === 'processing'), true);
    assert.equal(typeof scheduled, 'function');
    await scheduled();
    assert.deepEqual(submitted.sort((a, b) => a - b), [shot1, shot3]);
    assert.deepEqual(result.results.map((item) => item.shot_id), [shot1, shot3]);
    assert.equal(result.skipped.length, 2);
    assert.equal(result.results.every((item) => item.task_id && item.billing.held === 18), true);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 2);
  } finally {
    state.db.close();
  }
});

test('批量生成使用 verified capability 模型贯穿报价、冻结、视频任务和分镜快照', async () => {
  const state = setup();
  const model = 'verified-redraw-video-v9';
  let scheduled = null;
  try {
    prices.set(state.db, model, 5, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 7 } },
    });
    addVerifiedGenerationCapability(state.db, model);
    const shotId = addShot(state.db, state.versionId, {
      draft: { model: 'client-stale-draft-model', duration: 6, resolution: '720p' },
      compiledPrompt: {
        text: 'compiled hero prompt',
        model: 'compiled-stale-model',
        duration: 6,
        resolution: '720p',
        aspect_ratio: '9:16',
      },
    });

    const batch = await generateBatch(ctx(state.db, {
      canReadArtifact: (artifactId) => artifactId === `artifact-${model}`,
      batchScheduler: (callback) => { scheduled = callback; },
    }), {
      versionId: state.versionId,
      shotIds: [shotId],
    });

    assert.equal(typeof scheduled, 'function');
    assert.equal(batch.results[0].status, 'processing');
    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations').get();
    const video = state.db.prepare('SELECT * FROM video_generations').get();
    const task = state.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_shot'").get();
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    const metadata = JSON.parse(task.metadata).redraw_shot;

    assert.equal(reservation.model, model);
    assert.equal(reservation.amount, 42);
    assert.equal(video.model, model);
    assert.equal(task.model, model);
    assert.equal(draft.generation.model, model);
    assert.equal(metadata.quote.snapshot.model, model);
    assert.equal(metadata.quote.amount, 42);
  } finally {
    state.db.close();
  }
});

test('批量生成在本地化物化镜头缺省 duration 时从 duration_ms 推导 12 秒并保持幂等键稳定', async () => {
  const state = setup();
  const model = 'verified-redraw-video-12s';
  let scheduled = null;
  try {
    prices.set(state.db, model, 5, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 7 } },
    });
    addVerifiedGenerationCapability(state.db, model);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 12000,
      endMs: 12000,
      draft: { revision: 1, resolution: '720p' },
      compiledPrompt: {
        text: 'localized materialized prompt',
        resolution: '720p',
        aspect_ratio: '9:16',
      },
    });

    const batch = await generateBatch(ctx(state.db, {
      canReadArtifact: (artifactId) => artifactId === `artifact-${model}`,
      batchScheduler: (callback) => { scheduled = callback; },
    }), {
      versionId: state.versionId,
      shotIds: [shotId],
    });

    assert.equal(typeof scheduled, 'function');
    assert.equal(batch.results[0].status, 'processing');
    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations').get();
    const video = state.db.prepare('SELECT * FROM video_generations').get();
    const task = state.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_shot'").get();
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    const metadata = JSON.parse(task.metadata).redraw_shot;

    assert.equal(reservation.model, model);
    assert.equal(reservation.amount, 84);
    assert.match(reservation.operation_key, /redraw-shot:/);
    assert.equal(video.model, model);
    assert.equal(video.duration, 12);
    assert.equal(task.model, model);
    assert.equal(draft.generation.model, model);
    assert.equal(draft.generation.duration, 12);
    assert.equal(metadata.quote.snapshot.model, model);
    assert.equal(metadata.quote.snapshot.duration, 12);
    assert.equal(metadata.quote.snapshot.attempt, 1);
    assert.equal(metadata.quote.amount, 84);
    assert.equal(metadata.operation_key, reservation.operation_key);

    const duplicate = await generateShot(ctx(state.db, {
      canReadArtifact: (artifactId) => artifactId === `artifact-${model}`,
      schedule() {},
    }), { shotId });
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.reservation_id, reservation.id);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
    assert.equal(count(state.db, 'async_tasks', "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, 'video_generations'), 1);
  } finally {
    state.db.close();
  }
});

test('批量显式镜头包含跨租户、跨版本或缺失时 fail closed 且零冻结', async () => {
  for (const invalidKind of ['other_version', 'other_owner', 'missing']) {
    const state = setup();
    try {
      const validShot = addShot(state.db, state.versionId, { shotIndex: 1 });
      let invalidShot = 999999;
      if (invalidKind !== 'missing') {
        const now = new Date().toISOString();
        state.db.prepare(`INSERT INTO redraw_versions
          (work_id, tenant_id, user_id, version, locale, market, style_snapshot_json, status, created_at, updated_at)
          SELECT work_id, tenant_id, user_id, 2, locale, market, style_snapshot_json, status, ?, ? FROM redraw_versions WHERE id = ?`)
          .run(now, now, state.versionId);
        const otherVersionId = state.db.prepare('SELECT MAX(id) AS id FROM redraw_versions').get().id;
        invalidShot = addShot(state.db, otherVersionId, { shotIndex: 2 });
        if (invalidKind === 'other_owner') {
          state.db.prepare("UPDATE redraw_shots SET tenant_id = 'tenant-b', user_id = 'user-b', version_id = ? WHERE id = ?")
            .run(state.versionId, invalidShot);
        }
      }
      await assert.rejects(
        () => generateBatch(ctx(state.db), { versionId: state.versionId, shotIds: [validShot, invalidShot] }),
        (error) => error.code === 'REDRAW_BATCH_SHOT_INVALID',
      );
      assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
      assert.equal(count(state.db, 'async_tasks'), 0);
    } finally {
      state.db.close();
    }
  }
});

test('批量同时携带 singular shot_id 或 shotId 时在任何冻结和任务创建前 fail closed', async () => {
  for (const singularKey of ['shot_id', 'shotId']) {
    const state = setup();
    try {
      const shotA = addShot(state.db, state.versionId, { shotIndex: 1 });
      const now = new Date().toISOString();
      state.db.prepare(`INSERT INTO redraw_versions
        (work_id, tenant_id, user_id, version, locale, market, style_snapshot_json, status, created_at, updated_at)
        SELECT work_id, tenant_id, user_id, 2, locale, market, style_snapshot_json, status, ?, ?
        FROM redraw_versions WHERE id = ?`).run(now, now, state.versionId);
      const versionB = state.db.prepare('SELECT MAX(id) AS id FROM redraw_versions').get().id;
      const shotB = addShot(state.db, versionB, { shotIndex: 2 });
      const before = state.db.prepare('SELECT id, status FROM redraw_shots ORDER BY id').all();

      await assert.rejects(
        () => generateBatch(ctx(state.db), {
          versionId: state.versionId,
          shotIds: [shotA],
          [singularKey]: shotB,
        }),
        (error) => error.code === 'REDRAW_BATCH_INPUT_INVALID',
      );
      assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
      assert.equal(count(state.db, 'async_tasks'), 0);
      assert.deepEqual(state.db.prepare('SELECT id, status FROM redraw_shots ORDER BY id').all(), before);
    } finally {
      state.db.close();
    }
  }
});

test('批量生成遵守 generationConcurrency 有界并发', async () => {
  const state = setup();
  let active = 0;
  let maxActive = 0;
  let scheduled = null;
  try {
    const shotIds = Array.from({ length: 5 }, (_, index) => addShot(state.db, state.versionId, { shotIndex: index + 1 }));
    await generateBatch(ctx(state.db, {
      generationConcurrency: 2,
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
        active -= 1;
      },
    }), { versionId: state.versionId, shotIds });
    await scheduled();
    assert.equal(maxActive, 2);
  } finally {
    state.db.close();
  }
});

test('批量单镜处理器异常不影响其他镜头且如实返回 held 账单', async () => {
  const state = setup();
  let scheduled = null;
  try {
    const shotIds = [
      addShot(state.db, state.versionId, { shotIndex: 1 }),
      addShot(state.db, state.versionId, { shotIndex: 2 }),
    ];
    let calls = 0;
    const result = await generateBatch(ctx(state.db, {
      generationConcurrency: 1,
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        calls += 1;
        if (calls === 1) throw new Error('processor exploded');
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
      },
    }), { versionId: state.versionId, shotIds });
    assert.equal(result.results[0].status, 'processing');
    assert.equal(result.results[0].billing.held, 18);
    assert.equal(result.results[1].status, 'processing');
    assert.equal(result.results[1].billing.held, 18);
    await scheduled();
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotIds[0]).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotIds[1]).status, 'failed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(result.results[0].reservation_id).status, 'held');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(result.results[1].reservation_id).status, 'refunded');
  } finally {
    state.db.close();
  }
});

test('批量创建不等待供应商终态即可返回 processing，并将后台执行交给批次调度器', async () => {
  const state = setup();
  let scheduled = null;
  let providerCalls = 0;
  try {
    const shotIds = [
      addShot(state.db, state.versionId, { shotIndex: 1 }),
      addShot(state.db, state.versionId, { shotIndex: 2 }),
    ];
    const batch = generateBatch(ctx(state.db, {
      videoProcessor: async () => {
        providerCalls += 1;
        await new Promise(() => {});
      },
      batchScheduler: (callback) => { scheduled = callback; },
    }), { versionId: state.versionId, shotIds });
    const result = await Promise.race([
      batch,
      new Promise((_, reject) => setTimeout(() => reject(new Error('batch waited for provider')), 250)),
    ]);
    assert.equal(providerCalls, 0);
    assert.equal(typeof scheduled, 'function');
    assert.equal(result.results.length, 2);
    assert.equal(result.results.every((item) => item.status === 'processing' && item.task_id && item.billing.held === 18), true);
    assert.equal(count(state.db, 'async_tasks', "status = 'processing'"), 2);
    assert.equal(count(state.db, 'tenant_usage_reservations', "status = 'held'"), 2);
  } finally {
    state.db.close();
  }
});

test('批量后台 drain 按 generationConcurrency 限流并与返回生命周期解耦', async () => {
  const state = setup();
  let scheduled = null;
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    const shotIds = Array.from({ length: 4 }, (_, index) => addShot(state.db, state.versionId, { shotIndex: index + 1 }));
    const result = await generateBatch(ctx(state.db, {
      generationConcurrency: 2,
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
        active -= 1;
      },
    }), { versionId: state.versionId, shotIds });
    assert.equal(result.results.every((item) => item.status === 'processing'), true);
    const drain = scheduled();
    for (let index = 0; index < 20 && active < 2; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(active, 2);
    assert.equal(maxActive, 2);
    release();
    await drain;
    assert.equal(maxActive, 2);
  } finally {
    state.db.close();
  }
});

test('两个批次同时 drain 共享全局 redraw_video 并发上限', async () => {
  const state = setup();
  const previousLimit = process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY;
  let drainA = null;
  let drainB = null;
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY = '2';
  resetGenerationConcurrencyForTests();
  try {
    const shots = Array.from({ length: 4 }, (_, index) => addShot(state.db, state.versionId, { shotIndex: index + 1 }));
    const common = {
      generationConcurrency: 8,
      videoProcessor: async (db, _log, videoId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
        active -= 1;
      },
    };
    await generateBatch(ctx(state.db, { ...common, batchScheduler: (callback) => { drainA = callback; } }), {
      versionId: state.versionId,
      shotIds: shots.slice(0, 2),
    });
    await generateBatch(ctx(state.db, { ...common, batchScheduler: (callback) => { drainB = callback; } }), {
      versionId: state.versionId,
      shotIds: shots.slice(2),
    });
    const runningA = drainA();
    const runningB = drainB();
    for (let index = 0; index < 20 && active < 2; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 2);
    assert.equal(maxActive, 2);
    release();
    await Promise.all([runningA, runningB]);
    assert.equal(maxActive, 2);
  } finally {
    release?.();
    resetGenerationConcurrencyForTests();
    if (previousLimit == null) delete process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY;
    else process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY = previousLimit;
    state.db.close();
  }
});

test('全局 redraw_video 队列满时未执行任务转 needs_attention 且保持 held', async () => {
  const state = setup();
  const previousLimit = process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY;
  const previousQueue = process.env.GENERATION_REDRAW_VIDEO_MAX_QUEUE_SIZE;
  let scheduled = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY = '1';
  process.env.GENERATION_REDRAW_VIDEO_MAX_QUEUE_SIZE = '1';
  resetGenerationConcurrencyForTests();
  try {
    const shots = Array.from({ length: 3 }, (_, index) => addShot(state.db, state.versionId, { shotIndex: index + 1 }));
    const batch = await generateBatch(ctx(state.db, {
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        await gate;
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
      },
    }), { versionId: state.versionId, shotIds: shots });
    const draining = scheduled();
    for (let index = 0; index < 20; index += 1) {
      if (state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shots[2]).status === 'needs_attention') break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shots[2]).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(batch.results[2].reservation_id).status, 'held');
    release();
    await draining;
  } finally {
    release?.();
    resetGenerationConcurrencyForTests();
    if (previousLimit == null) delete process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY;
    else process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY = previousLimit;
    if (previousQueue == null) delete process.env.GENERATION_REDRAW_VIDEO_MAX_QUEUE_SIZE;
    else process.env.GENERATION_REDRAW_VIDEO_MAX_QUEUE_SIZE = previousQueue;
    state.db.close();
  }
});

test('批量中的明确 failed 镜头通过 retry 创建 attempt=2 新链且旧账保持原终态', async () => {
  const state = setup();
  let scheduled = null;
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, videoId) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'first failed' WHERE id = ?").run(videoId);
      },
    }), { shotId });
    const oldTask = state.db.prepare('SELECT status, error, result FROM async_tasks WHERE id = ?').get(first.task_id);
    const oldVideo = state.db.prepare('SELECT status, provider_task_id FROM video_generations WHERE id = ?').get(first.video_generation_id);
    const oldReservation = state.db.prepare('SELECT status, operation_key FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id);

    const batch = await generateBatch(ctx(state.db, {
      batchScheduler: (callback) => { scheduled = callback; },
    }), { versionId: state.versionId, shotIds: [shotId] });
    const retried = batch.results[0];
    assert.equal(typeof scheduled, 'function');
    assert.equal(retried.status, 'processing');
    assert.equal(retried.attempt, 2);
    assert.notEqual(retried.task_id, first.task_id);
    assert.notEqual(retried.video_generation_id, first.video_generation_id);
    assert.notEqual(retried.reservation_id, first.reservation_id);
    assert.notEqual(
      state.db.prepare('SELECT operation_key FROM tenant_usage_reservations WHERE id = ?').get(retried.reservation_id).operation_key,
      oldReservation.operation_key,
    );
    assert.deepEqual(state.db.prepare('SELECT status, error, result FROM async_tasks WHERE id = ?').get(first.task_id), oldTask);
    assert.deepEqual(state.db.prepare('SELECT status, provider_task_id FROM video_generations WHERE id = ?').get(first.video_generation_id), oldVideo);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id).status, oldReservation.status);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(retried.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('批量创建失败返回状态与数据库真实旧链一致，不伪报 needs_attention', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, videoId) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'first failed' WHERE id = ?").run(videoId);
      },
    }), { shotId });
    state.db.prepare("DELETE FROM model_credit_prices WHERE model = 'seedance 2.0'").run();
    const batch = await generateBatch(ctx(state.db, { batchScheduler: () => {} }), {
      versionId: state.versionId,
      shotIds: [shotId],
    });
    const item = batch.results[0];
    assert.equal(item.status, 'failed');
    assert.equal(item.billing.released, 18);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, item.status);
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(first.task_id).status, item.status);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id).status, 'refunded');
  } finally {
    state.db.close();
  }
});

test('重试只对明确 failed 镜头创建 attempt=2 新任务新冻结且旧账不二次结算', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'first failed' WHERE id = ?").run(id);
      },
    }), { shotId });
    const oldTask = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(first.task_id);
    const oldVideo = state.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(first.video_generation_id);
    const oldReservation = state.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id);

    const retried = await retryShot(ctx(state.db, {
      schedule: () => {},
      videoProcessor: async (db, _log, id) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'second failed' WHERE id = ?").run(id);
      },
    }), { shotId });

    assert.equal(retried.attempt, 2);
    assert.notEqual(retried.task_id, first.task_id);
    assert.notEqual(retried.video_generation_id, first.video_generation_id);
    assert.notEqual(retried.reservation_id, first.reservation_id);
    assert.notEqual(
      state.db.prepare('SELECT operation_key FROM tenant_usage_reservations WHERE id = ?').get(retried.reservation_id).operation_key,
      oldReservation.operation_key,
    );
    assert.deepEqual(state.db.prepare('SELECT status, result, error FROM async_tasks WHERE id = ?').get(first.task_id), {
      status: oldTask.status, result: oldTask.result, error: oldTask.error,
    });
    assert.equal(state.db.prepare('SELECT status, provider_task_id FROM video_generations WHERE id = ?').get(first.video_generation_id).status, oldVideo.status);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id).status, oldReservation.status);
    assert.equal(count(state.db, 'tenant_credit_ledger', "reservation_id = '" + first.reservation_id + "' AND event_type = 'refund'"), 1);
  } finally {
    state.db.close();
  }
});

test('重试使用 failed 分镜当前持久 attempt 加一并写入 reservation task draft 快照', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 12000,
      endMs: 12000,
      draft: { revision: 1, resolution: '720p' },
      compiledPrompt: {
        text: 'retry localized prompt',
        resolution: '720p',
        aspect_ratio: '9:16',
      },
    });
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'first failed' WHERE id = ?").run(id);
      },
    }), { shotId });
    const failedDraft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    failedDraft.generation.attempt = 4;
    state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE id = ?')
      .run(JSON.stringify(failedDraft), shotId);
    const oldReservation = state.db.prepare('SELECT operation_key FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id);

    const retried = await retryShot(ctx(state.db, {
      schedule: () => {},
    }), { shotId });

    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id = ?').get(retried.reservation_id);
    const task = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(retried.task_id);
    const video = state.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(retried.video_generation_id);
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    const metadata = JSON.parse(task.metadata).redraw_shot;

    assert.equal(retried.attempt, 5);
    assert.equal(reservation.amount, 36);
    assert.notEqual(reservation.operation_key, oldReservation.operation_key);
    assert.equal(video.duration, 12);
    assert.equal(draft.generation.attempt, 5);
    assert.equal(draft.generation.duration, 12);
    assert.equal(metadata.attempt, 5);
    assert.equal(metadata.quote.snapshot.attempt, 5);
    assert.equal(metadata.quote.snapshot.duration, 12);
    assert.equal(metadata.operation_key, reservation.operation_key);
  } finally {
    state.db.close();
  }
});

test('旧重试终态不明确时降级 needs_attention 并保持 held，绝不重提', async () => {
  const state = setup();
  let submissions = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE redraw_shots SET status = 'failed' WHERE id = ?").run(shotId);
    await assert.rejects(
      () => retryShot(ctx(state.db, { videoProcessor: async () => { submissions += 1; } }), { shotId }),
      (error) => error.code === 'REDRAW_RETRY_UNCERTAIN',
    );
    assert.equal(submissions, 0);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('旧重试缺 task/video 的 fallback 也会把旧第四步降回第三步', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId, { status: 'failed' });
    state.db.prepare("UPDATE redraw_versions SET status = 'composing' WHERE id = ?").run(state.versionId);
    state.db.prepare("UPDATE redraw_works SET status = 'composing', current_step = 4 WHERE id = ?").run(state.workId);

    await assert.rejects(
      () => retryShot(ctx(state.db), { shotId }),
      (error) => error.code === 'REDRAW_RETRY_UNCERTAIN',
    );

    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.deepEqual(workflowState(state.db, state.versionId), {
      version_status: 'generating',
      work_status: 'generating',
      current_step: 3,
    });
  } finally {
    state.db.close();
  }
});

test('有 provider_task_id 的恢复只回读零提交，并复用成片校验入库与账单确认', async () => {
  const state = setup();
  let recoverCalls = 0;
  let submitCalls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE video_generations SET provider_task_id = 'provider-1' WHERE id = ?").run(created.video_generation_id);
    const results = await recoverInterruptedShotGenerations(ctx(state.db, {
      videoProcessor: async () => { submitCalls += 1; },
      videoRecoveryProcessor: async (db, _log, videoId) => {
        recoverCalls += 1;
        db.prepare("UPDATE video_generations SET status = 'completed', video_url = 'https://cdn.test/recovered.mp4', local_path = 'videos/recovered.mp4' WHERE id = ?")
          .run(videoId);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: () => ({ id: 202 }),
    }));
    assert.equal(recoverCalls, 1);
    assert.equal(submitCalls, 0);
    assert.equal(results[0].status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'confirmed');
  } finally {
    state.db.close();
  }
});

test('恢复未知供应商状态转 needs_attention 且 held；无 provider ID 的启动任务不重提', async () => {
  const state = setup();
  let recoverCalls = 0;
  let scheduled = 0;
  try {
    const withProviderShot = addShot(state.db, state.versionId, { shotIndex: 1 });
    const withProvider = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId: withProviderShot });
    state.db.prepare("UPDATE video_generations SET provider_task_id = 'provider-unknown' WHERE id = ?").run(withProvider.video_generation_id);
    const results = await recoverInterruptedShotGenerations(ctx(state.db, {
      videoRecoveryProcessor: async () => { recoverCalls += 1; },
    }));
    assert.equal(results[0].status, 'needs_attention');
    assert.equal(recoverCalls, 1);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(withProvider.reservation_id).status, 'held');

    const noProviderShot = addShot(state.db, state.versionId, { shotIndex: 2 });
    const noProvider = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId: noProviderShot });
    const marked = markInterruptedShotGenerationsNeedsAttention(state.db, log, {
      schedule: () => { scheduled += 1; },
    });
    assert.equal(marked, 1);
    assert.equal(scheduled, 0);
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(noProvider.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(noProvider.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('启动孤儿清理排除带 provider_task_id 的 redraw_shot，交由转绘恢复收口', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE video_generations SET provider_task_id = 'provider-recoverable' WHERE id = ?").run(created.video_generation_id);
    const failed = taskService.failOrphanedAsyncTasksOnStartup(state.db, log);
    assert.equal(failed, 0);
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'processing');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('启动孤儿清理遇到跨租户 resource_id 混淆时不更新其他租户镜头', async () => {
  const state = setup();
  try {
    const protectedShotId = addShot(state.db, state.versionId, { status: 'draft' });
    const dirtyTask = taskService.createTask(state.db, log, 'redraw_shot', String(protectedShotId));
    state.db.prepare(`UPDATE async_tasks
      SET status = 'processing', tenant_id = 'tenant-b', user_id = 'user-b'
      WHERE id = ?`).run(dirtyTask.id);
    const now = new Date().toISOString();
    const dirtyVideoId = state.db.prepare(`INSERT INTO video_generations
      (status, task_id, tenant_id, user_id, created_at, updated_at)
      VALUES ('processing', ?, 'tenant-b', 'user-b', ?, ?)`)
      .run(dirtyTask.id, now, now).lastInsertRowid;

    taskService.failOrphanedAsyncTasksOnStartup(state.db, log);

    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(dirtyTask.id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(protectedShotId).status, 'draft');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(dirtyVideoId).status, 'processing');
  } finally {
    state.db.close();
  }
});

test('启动 mark 对带 provider_task_id 的镜头安排只回读恢复并完成本地收口', async () => {
  const state = setup();
  let scheduled = null;
  let recoveryCalls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE video_generations SET provider_task_id = 'provider-startup' WHERE id = ?").run(created.video_generation_id);
    const marked = markInterruptedShotGenerationsNeedsAttention(state.db, log, {
      schedule: (callback) => { scheduled = callback; },
      recoveryContext: {
        videoRecoveryProcessor: async (db, _log, videoId) => {
          recoveryCalls += 1;
          db.prepare("UPDATE video_generations SET status = 'completed', video_url = 'https://cdn.test/startup.mp4', local_path = 'videos/startup.mp4' WHERE id = ?")
            .run(videoId);
        },
        artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
        assetImporter: () => ({ id: 303 }),
      },
    });
    assert.equal(marked, 0);
    assert.equal(typeof scheduled, 'function');
    await scheduled();
    assert.equal(recoveryCalls, 1);
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'confirmed');
  } finally {
    state.db.close();
  }
});

test('供应商回读已先落 completed 终态时启动 mark 仍安排 shot 与账单收口', async () => {
  const state = setup();
  let recoveryCalls = 0;
  let scheduled = null;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare(`UPDATE video_generations
      SET status = 'completed', provider_task_id = 'provider-race', video_url = 'https://cdn.test/race.mp4', local_path = 'videos/race.mp4'
      WHERE id = ?`).run(created.video_generation_id);
    taskService.updateTaskResult(state.db, created.task_id, { status: 'completed', video_generation_id: created.video_generation_id });
    const marked = markInterruptedShotGenerationsNeedsAttention(state.db, log, {
      schedule: (callback) => { scheduled = callback; },
      recoveryContext: ctx(state.db, {
        videoRecoveryProcessor: async () => { recoveryCalls += 1; },
        artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
        assetImporter: () => ({ id: 404 }),
      }),
    });
    assert.equal(marked, 0);
    assert.equal(typeof scheduled, 'function');
    const results = await scheduled();
    assert.equal(recoveryCalls, 0);
    assert.equal(results[0].status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'confirmed');
  } finally {
    state.db.close();
  }
});
