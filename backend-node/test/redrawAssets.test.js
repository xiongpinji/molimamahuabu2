const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  createAssetAttempt,
  finalizeAssetAttempt,
  failAssetAttempt,
  generateAsset,
  generateCleanPlate,
  listAssets,
  updateAsset,
  listAssetVersions,
} = require('../src/services/redrawAssetService');

const TTS_CONFIG_ID = 41;
const TTS_CONFIG_UPDATED_AT = '2026-08-08T00:00:00.000Z';
const MODEL_MANIFEST_SHA256 = 'a'.repeat(64);
const CALIBRATION_MANIFEST_SHA256 = 'b'.repeat(64);
const AUDIO_SHA256 = 'c'.repeat(64);
const TRANSCRIPT_SHA256 = 'd'.repeat(64);

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  credits.setAccountBalance(db, 'user-a', 100);
  credits.setAccountBalance(db, 'user-b', 100);
  credits.setTenantAccountBalance(db, 'tenant-a', 100);
  credits.setTenantAccountBalance(db, 'tenant-b', 100);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '测试项目', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', '测试作品', 1, 'source-a', 15000, ?, ?)`).run(now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', '{}', 'facts-a', 'asset_review', ?, ?)`)
    .run(workId, now, now);
  const versionId = db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id;
  db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, name, model, default_model, is_active, created_at, updated_at)
    VALUES (?, 'tts', 'fake-tts', '测试 TTS', ?, ?, 1, ?, ?)`)
    .run(
      TTS_CONFIG_ID,
      JSON.stringify(['model-tts']),
      'model-tts',
      TTS_CONFIG_UPDATED_AT,
      TTS_CONFIG_UPDATED_AT,
    );
  return { db, workId, versionId, ttsConfigId: TTS_CONFIG_ID, ttsConfigUpdatedAt: TTS_CONFIG_UPDATED_AT };
}

function addAsset(db, id, localPath) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO assets (id, name, type, category, url, local_path, mime_type, created_at, updated_at)
    VALUES (?, '生成图片', 'image', 'redraw', '', ?, 'image/png', ?, ?)`)
    .run(id, localPath, now, now);
}

function addTypedAsset(db, id, localPath, type, mimeType, duration = null) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO assets (id, name, type, category, url, local_path, mime_type, duration, created_at, updated_at)
    VALUES (?, '生成资产', ?, 'redraw', '', ?, ?, ?, ?, ?)`)
    .run(id, type, localPath, mimeType, duration, now, now);
}

function addDraftPlaceholder(db, state, input = {}) {
  const now = new Date().toISOString();
  const result = db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     localized_description, prompt, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', ?, ?, ?, ?, ?, 1, 'pending', 'draft', ?, ?)`)
    .run(
      state.versionId,
      input.kind || 'character',
      JSON.stringify({ source_ref: input.sourceRef || { id: 'c-placeholder' } }),
      input.localizedName || 'Maya',
      input.localizedDescription || 'localized character',
      input.prompt || 'placeholder prompt',
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

function addReadyDialogueShot(state, sourceCharacterKey = 'voice-character-1') {
  state.db.prepare(`INSERT INTO video_generations
    (id, provider, model, status, tenant_id, user_id, created_at, updated_at)
    VALUES (801, 'fake', 'redraw-local', 'completed', 'tenant-a', 'user-a', ?, ?)`)
    .run(TTS_CONFIG_UPDATED_AT, TTS_CONFIG_UPDATED_AT);
  state.db.prepare(`INSERT INTO redraw_shots
    (id, work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
     references_json, reference_bundle_json, reference_bundle_hash, reference_bundle_updated_at,
     video_generation_id, preparation_state, preparation_version, status, created_at, updated_at)
    VALUES (701, ?, ?, 'tenant-a', 'user-a', 'shot-voice', 1, 1,
      0, 5000, 5000, '[]', '[]', ?, ?, ?, ?, 801, 'reference_ready', 2, 'completed', ?, ?)`)
    .run(
      state.workId,
      state.versionId,
      JSON.stringify([{ kind: 'voice', source_character_key: sourceCharacterKey }]),
      JSON.stringify({
        schema_version: 'redraw-reference-bundle-v1',
        face_tracks: [],
        dialogue: {
          kind: 'spoken',
          turns: [{ speaker_id: sourceCharacterKey, localized_text: 'Line', start_ms: 0, end_ms: 900 }],
        },
        text_regions: [],
      }),
      'b'.repeat(64),
      TTS_CONFIG_UPDATED_AT,
      TTS_CONFIG_UPDATED_AT,
      TTS_CONFIG_UPDATED_AT,
    );
}

function dialogueShotState(db) {
  return db.prepare(`SELECT preparation_state, preparation_version, reference_bundle_hash,
    video_generation_id, stale_reason_code FROM redraw_shots WHERE id = 701`).get();
}

function context(setupResult, root, userId = 'user-a', tenantId = 'tenant-a') {
  return {
    db: setupResult.db,
    versionId: setupResult.versionId,
    tenantId,
    userId,
    assetReader: {
      canRead(asset) {
        return Boolean(asset?.local_path && fs.existsSync(path.join(root, asset.local_path)));
      },
    },
    localeRegistry: trustedRegistry(),
    creditAmount: 5,
  };
}

function trustedRegistry() {
  return {
    assertEvidenceTrusted(evidence) {
      if (evidence.source !== 'offline-worker'
        || evidence.locale_pack !== 'en-US@fixture'
        || evidence.model_manifest_sha256 !== MODEL_MANIFEST_SHA256
        || evidence.calibration_manifest_sha256 !== CALIBRATION_MANIFEST_SHA256) {
        throw Object.assign(new Error('worker evidence not trusted'), {
          code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
        });
      }
      return evidence;
    },
  };
}

function voiceInput(state, sourceRef) {
  return {
    kind: 'voice',
    sourceRef,
    snapshot: {
      provider: 'fake-tts',
      model: 'model-tts',
      ai_service_config_id: state.ttsConfigId,
      config_updated_at: state.ttsConfigUpdatedAt,
    },
  };
}

function voiceResult(assetId, providerTaskId = 'provider-voice-1', voiceEvidenceOverrides = {}) {
  return {
    status: 'completed',
    provider_task_id: providerTaskId,
    voice_asset_id: assetId,
    duration: 3.2,
    voice_evidence: {
      source: 'offline-worker',
      locale: 'en-US',
      market: 'US',
      locale_pack: 'en-US@fixture',
      audio_sha256: AUDIO_SHA256,
      transcript_sha256: TRANSCRIPT_SHA256,
      model_manifest_sha256: MODEL_MANIFEST_SHA256,
      calibration_manifest_sha256: CALIBRATION_MANIFEST_SHA256,
      asr_model_revision: 'asr-en-20260808',
      accent_model_revision: 'accent-en-20260808',
      metrics: { word_error_rate: 0, accent_confidence: 0.99 },
      completed_at: '2026-08-08T00:00:01.000Z',
      provider: 'fake-tts',
      model: 'model-tts',
      ai_service_config_id: TTS_CONFIG_ID,
      config_updated_at: TTS_CONFIG_UPDATED_AT,
      voice_id: 'fixture-voice',
      task_id: providerTaskId,
      terminal_status: 'completed',
      audio_asset_id: assetId,
      duration_ms: 3200,
      real_generation_verified: true,
      language_verified: true,
      detected_locale: 'en-US',
      is_cloned: false,
      authorization_asset_id: null,
      ...voiceEvidenceOverrides,
    },
  };
}

test('资产重绘追加版本且不覆盖上一可用产物', async () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-'));
  fs.mkdirSync(path.join(root, 'redraw'), { recursive: true });
  fs.writeFileSync(path.join(root, 'redraw', 'v1.png'), 'v1');
  fs.writeFileSync(path.join(root, 'redraw', 'v2.png'), 'v2');
  addAsset(state.db, 101, 'redraw/v1.png');
  addAsset(state.db, 102, 'redraw/v2.png');
  const ctx = context(state, root);
  const character = { kind: 'character', sourceRef: { id: 'c1' }, prompt: '角色正面、侧面、背面三视图' };
  addDraftPlaceholder(state.db, state, character);

  const v1 = await generateAsset({ ...ctx, provider: async () => ({ status: 'completed', asset_id: 101, metadata: { views: ['front', 'side', 'back'] } }) }, {
    ...character,
    generationTaskId: 'provider-task-1',
  });
  const v2 = await generateAsset({ ...ctx, provider: async () => ({ status: 'completed', asset_id: 102, metadata: { views: ['front', 'side', 'back'] } }) }, { ...character, prompt: '更新后的角色三视图' });

  assert.equal(v1.version_number, 1);
  assert.equal(v2.version_number, 2);
  const billingFields = state.db.prepare('SELECT generation_task_id, credit_reservation_id FROM redraw_assets WHERE id = ?').get(v1.id);
  assert.equal(billingFields.generation_task_id, 'provider-task-1');
  assert.equal(typeof billingFields.credit_reservation_id, 'string');
  assert.equal(credits.getReservation(state.db, billingFields.credit_reservation_id).status, 'confirmed');
  assert.equal(state.db.prepare('SELECT asset_id FROM redraw_assets WHERE id = ?').get(v1.id).asset_id, 101);
  assert.deepEqual(listAssetVersions(state.db, ctx, v2.id).map((row) => row.version_number), [2, 1]);
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('首次生成原子认领本地化草稿且并发重复提交 fail closed', async () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-placeholder-'));
  fs.writeFileSync(path.join(root, 'asset.png'), 'asset');
  addAsset(state.db, 109, 'asset.png');
  const placeholderId = addDraftPlaceholder(state.db, state, {
    sourceRef: { id: 'c-placeholder' },
  });
  let releaseProvider;
  let providerCalls = 0;
  const provider = async () => {
    providerCalls += 1;
    await new Promise((resolve) => { releaseProvider = resolve; });
    return { status: 'completed', asset_id: 109, metadata: { views: ['front', 'side', 'back'] } };
  };
  const ctx = { ...context(state, root), provider };
  const first = generateAsset(ctx, {
    kind: 'character',
    sourceRef: { id: 'c-placeholder' },
    prompt: 'generated prompt',
  });

  await assert.rejects(
    () => generateAsset(ctx, {
      kind: 'character',
      sourceRef: { id: 'c-placeholder' },
      prompt: 'duplicate prompt',
    }),
    (error) => error.code === 'REDRAW_ASSET_ATTEMPT_IN_PROGRESS',
  );
  assert.equal(providerCalls, 1);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_assets').get().count, 1);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 1);

  releaseProvider();
  const generated = await first;
  assert.equal(generated.id, placeholderId);
  assert.equal(generated.version_number, 1);
  assert.equal(generated.status, 'generated');
  assert.equal(generated.prompt, 'generated prompt');
  assert.deepEqual(listAssetVersions(state.db, ctx, generated.id).map((row) => row.version_number), [1]);
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('首次生成缺少本地化草稿时零冻结且不调用 provider', async () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-no-placeholder-'));
  let providerCalls = 0;
  const ctx = {
    ...context(state, root),
    provider: async () => {
      providerCalls += 1;
      return { status: 'failed', error: 'should not run' };
    },
  };

  await assert.rejects(
    () => generateAsset(ctx, { kind: 'character', sourceRef: { id: 'missing-draft' } }),
    (error) => error.code === 'REDRAW_ASSET_PLACEHOLDER_REQUIRED',
  );
  assert.equal(providerCalls, 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_assets').get().count, 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('资产来源对象键顺序变化仍追加同一来源的下一版本', async () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-source-order-'));
  fs.writeFileSync(path.join(root, 'asset.png'), 'asset');
  addAsset(state.db, 111, 'asset.png');
  addAsset(state.db, 112, 'asset.png');
  const ctx = { ...context(state, root), creditAmount: 0 };
  addDraftPlaceholder(state.db, state, { kind: 'prop', sourceRef: { id: 'p-order', type: 'prop' } });
  const first = await generateAsset({ ...ctx, provider: async () => ({ status: 'completed', asset_id: 111 }) }, {
    kind: 'prop',
    sourceRef: { id: 'p-order', type: 'prop' },
  });
  const second = await generateAsset({ ...ctx, provider: async () => ({ status: 'completed', asset_id: 112 }) }, {
    kind: 'prop',
    sourceRef: { type: 'prop', id: 'p-order' },
  });

  assert.equal(first.version_number, 1);
  assert.equal(second.version_number, 2);
  assert.deepEqual(listAssetVersions(state.db, ctx, second.id).map((row) => row.version_number), [2, 1]);
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('图片不可读时任务失败并释放积分', async () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-missing-'));
  addAsset(state.db, 201, 'redraw/missing.png');
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, { kind: 'scene', sourceRef: { id: 's1' } });
  await assert.rejects(
    () => generateAsset({ ...ctx, provider: async () => ({ status: 'completed', asset_id: 201 }) }, {
      kind: 'scene',
      sourceRef: { id: 's1' },
      prompt: '场景背景',
    }),
    /不可读取/,
  );
  const row = state.db.prepare('SELECT status, credit_reservation_id FROM redraw_assets').get();
  assert.equal(row.status, 'failed');
  assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'refunded');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('资产读取和更新按租户用户隔离', async () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-owner-'));
  fs.writeFileSync(path.join(root, 'asset.png'), 'asset');
  addAsset(state.db, 301, 'asset.png');
  const ownerCtx = context(state, root);
  addDraftPlaceholder(state.db, state, { kind: 'prop', sourceRef: { id: 'p1' } });
  const created = await generateAsset({ ...ownerCtx, provider: async () => ({ status: 'completed', asset_id: 301 }) }, {
    kind: 'prop',
    sourceRef: { id: 'p1' },
    localizedName: '旧手机',
    prompt: '道具',
  });
  assert.equal(listAssets(state.db, ownerCtx).length, 1);
  assert.equal(listAssets(state.db, context(state, root, 'user-b', 'tenant-b')).length, 0);
  assert.equal(updateAsset(state.db, context(state, root, 'user-b', 'tenant-b'), created.id, { localizedName: '越权' }), null);
  assert.equal(updateAsset(state.db, ownerCtx, created.id, { localizedName: '手机' }).localized_name, '手机');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('去人净景使用人物遮罩并保留源场景版本', async () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-clean-plate-'));
  for (const file of ['scene.png', 'mask.png', 'clean.png']) fs.writeFileSync(path.join(root, file), file);
  addAsset(state.db, 401, 'scene.png');
  addAsset(state.db, 402, 'mask.png');
  addAsset(state.db, 403, 'clean.png');
  const ctx = context(state, root);
  const sceneAsset = {
    source_asset_id: 401,
    source_fingerprint: 'frame-1',
    width: 1280,
    height: 720,
  };
  const result = await generateCleanPlate({
    ...ctx,
    provider: async ({ input }) => {
      assert.equal(input.mask_asset_id, 402);
      assert.equal(input.source_asset_id, 401);
      return {
        status: 'completed',
        asset_id: 403,
        provider_task_id: 'clean-task-1',
        quality: {
          width: 1280,
          height: 720,
          mask_area_changed: true,
          non_mask_similarity: 0.97,
        },
      };
    },
  }, sceneAsset, { mask_asset_id: 402, prompt: '去除人物并保留场景结构' });

  assert.equal(result.clean_plate_asset_id, 403);
  assert.equal(result.source_asset_id, 401);
  assert.equal(result.mask_asset_id, 402);
  assert.equal(result.generation_task_id, 'clean-task-1');
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.approval_status, 'pending');
  assert.equal(result.review_status, 'needs_review');
  const snapshot = JSON.parse(result.source_ref_json).snapshot;
  assert.equal(snapshot.mode, 'clean_plate');
  assert.equal(snapshot.source_asset_id, 401);
  assert.equal(snapshot.mask_asset_id, 402);
  assert.equal(snapshot.input_frame_fingerprint, 'frame-1');
  assert.equal(snapshot.model, 'redraw-clean-plate');
  assert.equal(state.db.prepare('SELECT local_path FROM assets WHERE id = 401').get().local_path, 'scene.png');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('文字净景快照只保留脱敏模式、类型和区域', async () => {
  for (const [shotId, textKind, sourceId, maskId, cleanId] of [
    ['shot-4', 'text_subtitle', 431, 432, 433],
    ['shot-8', 'text_screen', 435, 436, 437],
  ]) {
    const state = setup();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-text-clean-plate-'));
    for (const [id, file] of [[sourceId, 'source.png'], [maskId, 'mask.png'], [cleanId, 'clean.png']]) {
      fs.writeFileSync(path.join(root, file), file);
      addAsset(state.db, id, file);
    }
    const ctx = context(state, root);
    const textRegions = [{
      kind: textKind,
      shape: 'polygon',
      points: [[120, 590], [1160, 590], [1160, 690], [120, 690]],
      source: 'manual_fixture',
    }];
    const result = await generateCleanPlate({
      ...ctx,
      provider: async ({ input }) => {
        assert.equal(input.source_asset_id, sourceId);
        assert.equal(input.mask_asset_id, maskId);
        assert.equal(input.mode, 'text_clean_plate');
        return {
          status: 'completed',
          asset_id: cleanId,
          quality: {
            width: 1280,
            height: 720,
            mask_area_changed: true,
            non_mask_similarity: 0.98,
          },
        };
      },
    }, {
      shotId,
      source_asset_id: sourceId,
      width: 1280,
      height: 720,
    }, {
      mode: 'text_clean_plate',
      mask_asset_id: maskId,
      textKind,
      textRegions,
    });

    const snapshot = JSON.parse(result.source_ref_json).snapshot;
    assert.deepEqual(Object.keys(snapshot).sort(), ['mode', 'text_kind', 'text_regions']);
    assert.equal(snapshot.mode, 'text_clean_plate');
    assert.equal(snapshot.text_kind, textKind);
    assert.deepEqual(snapshot.text_regions, textRegions);
    assert.equal(JSON.stringify(snapshot).includes('ocr_text'), false);
    assert.equal(JSON.stringify(snapshot).includes(root), false);
    assert.equal(result.clean_plate_asset_id, cleanId);
    assert.equal(result.approval_status, 'pending');
    assert.equal(state.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(sourceId).local_path, 'source.png');
    fs.rmSync(root, { recursive: true, force: true });
    state.db.close();
  }
});

test('文字净景拒绝未知类型、混入 region/OCR、绝对路径和未知字段且不调用 provider', async () => {
  const cases = [
    { name: '未知文字类型', mutate: (input) => { input.textKind = 'text_unknown'; } },
    { name: '混入 region', mutate: (input) => { input.region = { kind: 'text_subtitle', polygon: [[0, 0], [1, 0], [1, 1]] }; } },
    { name: '混入 ocr_text', mutate: (input) => { input.textRegions[0].ocr_text = '不得落盘的原文'; } },
    { name: '混入绝对路径', mutate: (input) => { input.textRegions[0].path = path.resolve('/tmp/ocr.json'); } },
    { name: '混入未知字段', mutate: (input) => { input.textRegions[0].unexpected = 'reject'; } },
  ];
  for (const invalidCase of cases) {
    const state = setup();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-text-clean-plate-invalid-'));
    for (const [id, file] of [[431, 'source.png'], [432, 'mask.png'], [433, 'clean.png']]) {
      fs.writeFileSync(path.join(root, file), file);
      addAsset(state.db, id, file);
    }
    let providerCalls = 0;
    const ctx = {
      ...context(state, root),
      provider: async () => { providerCalls += 1; return { status: 'completed', asset_id: 433 }; },
    };
    const input = {
      mode: 'text_clean_plate',
      mask_asset_id: 432,
      textKind: 'text_subtitle',
      textRegions: [{
        kind: 'text_subtitle',
        shape: 'polygon',
        points: [[0, 0], [100, 0], [100, 100]],
      }],
    };
    invalidCase.mutate(input);
    await assert.rejects(
      () => generateCleanPlate(ctx, { shotId: 'shot-4', source_asset_id: 431, width: 1280, height: 720 }, input),
      (error) => String(error.code || '').startsWith('REDRAW_TEXT_CLEAN_PLATE_'),
      invalidCase.name,
    );
    assert.equal(providerCalls, 0);
    fs.rmSync(root, { recursive: true, force: true });
    state.db.close();
  }
});

test('文字净景质量或 provider 失败保留源文件、清景为空且审批待处理', async () => {
  for (const providerResult of [
    {
      status: 'completed',
      asset_id: 433,
      quality: { width: 640, height: 720, mask_area_changed: true, non_mask_similarity: 0.98 },
    },
    { status: 'failed', error: '供应商拒绝' },
  ]) {
    const state = setup();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-text-clean-plate-failure-'));
    for (const [id, file] of [[431, 'source.png'], [432, 'mask.png'], [433, 'clean.png']]) {
      fs.writeFileSync(path.join(root, file), file);
      addAsset(state.db, id, file);
    }
    const ctx = {
      ...context(state, root),
      provider: async () => providerResult,
    };
    await assert.rejects(
      () => generateCleanPlate(ctx, { shotId: 'shot-4', source_asset_id: 431, width: 1280, height: 720 }, {
        mode: 'text_clean_plate',
        mask_asset_id: 432,
        textKind: 'text_subtitle',
        textRegions: [{ kind: 'text_subtitle', shape: 'polygon', points: [[0, 0], [100, 0], [100, 100]] }],
      }),
    );
    const row = state.db.prepare('SELECT status, approval_status, clean_plate_asset_id FROM redraw_assets').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.approval_status, 'pending');
    assert.equal(row.clean_plate_asset_id, null);
    assert.equal(state.db.prepare('SELECT local_path FROM assets WHERE id = 431').get().local_path, 'source.png');
    fs.rmSync(root, { recursive: true, force: true });
    state.db.close();
  }
});

test('没有可审计遮罩时不提交去人生成', async () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-clean-plate-no-mask-'));
  let calls = 0;
  await assert.rejects(
    () => generateCleanPlate({
      ...context(state, root),
      provider: async () => { calls += 1; return { status: 'completed' }; },
    }, { source_asset_id: 401 }, {}),
    /人物遮罩/,
  );
  assert.equal(calls, 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_assets').get().count, 0);
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('去人净景质量门禁失败时只退回本次积分', async () => {
  const cases = [
    { width: 640, height: 720, mask_area_changed: true, non_mask_similarity: 0.97 },
    { width: 1280, height: 720, mask_area_changed: false, non_mask_similarity: 0.97 },
    { width: 1280, height: 720, mask_area_changed: true, non_mask_similarity: 0.5 },
  ];
  for (const quality of cases) {
    const state = setup();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-clean-plate-quality-'));
    for (const file of ['scene.png', 'mask.png', 'clean.png']) fs.writeFileSync(path.join(root, file), file);
    addAsset(state.db, 411, 'scene.png');
    addAsset(state.db, 412, 'mask.png');
    addAsset(state.db, 413, 'clean.png');
    const ctx = context(state, root);
    await assert.rejects(
      () => generateCleanPlate({
        ...ctx,
        provider: async () => ({ status: 'completed', asset_id: 413, quality }),
      }, { source_asset_id: 411, width: 1280, height: 720 }, { mask_asset_id: 412 }),
      /质量/,
    );
    const row = state.db.prepare('SELECT status, approval_status, clean_plate_asset_id, credit_reservation_id FROM redraw_assets').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.approval_status, 'pending');
    assert.equal(row.clean_plate_asset_id, null);
    assert.equal(state.db.prepare('SELECT local_path FROM assets WHERE id = 411').get().local_path, 'scene.png');
    assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'refunded');
    fs.rmSync(root, { recursive: true, force: true });
    state.db.close();
  }
});

test('去人 provider 明确失败时按生成失败退款', async () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-clean-plate-provider-failure-'));
  fs.writeFileSync(path.join(root, 'scene.png'), 'scene');
  fs.writeFileSync(path.join(root, 'mask.png'), 'mask');
  addAsset(state.db, 421, 'scene.png');
  addAsset(state.db, 422, 'mask.png');
  const ctx = context(state, root);
  await assert.rejects(
    () => generateCleanPlate({
      ...ctx,
      provider: async () => ({ status: 'failed', error: '供应商拒绝' }),
    }, { source_asset_id: 421 }, { mask_asset_id: 422 }),
    /供应商拒绝/,
  );
  const row = state.db.prepare('SELECT status, approval_status, clean_plate_asset_id, error_code, credit_reservation_id FROM redraw_assets').get();
  assert.equal(row.status, 'failed');
  assert.equal(row.approval_status, 'pending');
  assert.equal(row.clean_plate_asset_id, null);
  assert.equal(state.db.prepare('SELECT local_path FROM assets WHERE id = 421').get().local_path, 'scene.png');
  assert.equal(row.error_code, 'REDRAW_ASSET_GENERATION_FAILED');
  assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'refunded');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('finalizeAssetAttempt 按资产类型写入 voice 与 clean plate 目标字段', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-finalize-kind-'));
  for (const file of ['voice.mp3', 'clean.png']) fs.writeFileSync(path.join(root, file), file);
  addTypedAsset(state.db, 501, 'voice.mp3', 'audio', 'audio/mpeg', 3.2);
  addAsset(state.db, 502, 'clean.png');
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, {
    kind: 'voice',
    sourceRef: { id: 'v1', voice_id: 'fixture-voice', is_cloned: false },
  });
  addDraftPlaceholder(state.db, state, { kind: 'scene', sourceRef: { id: 's-clean' } });
  const voiceAttempt = createAssetAttempt(ctx, voiceInput(state, {
    id: 'v1',
    voice_id: 'fixture-voice',
    is_cloned: false,
  }));
  const sceneAttempt = createAssetAttempt(ctx, { kind: 'scene', sourceRef: { id: 's-clean' } });

  const voice = finalizeAssetAttempt(ctx, voiceAttempt.id, voiceResult(501));
  const scene = finalizeAssetAttempt(ctx, sceneAttempt.id, {
    status: 'completed',
    clean_plate_asset_id: 502,
    clean_plate: true,
    quality: {
      width: 1280,
      height: 720,
      mask_area_changed: true,
      non_mask_similarity: 0.97,
    },
  });

  assert.equal(voice.voice_asset_id, 501);
  assert.equal(voice.asset_id, null);
  assert.equal(voice.status, 'generated');
  assert.equal(scene.clean_plate_asset_id, 502);
  assert.equal(scene.asset_id, null);
  assert.equal(scene.status, 'needs_attention');
  assert.equal(scene.review_status, 'needs_review');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('finalizeAssetAttempt allows provider-generated voice evidence without preselected voice id', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-provider-voice-'));
  fs.writeFileSync(path.join(root, 'voice.mp3'), 'voice');
  addTypedAsset(state.db, 511, 'voice.mp3', 'audio', 'audio/mpeg', 3.2);
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, {
    kind: 'voice',
    sourceRef: { id: 'v-provider-generated', is_cloned: false },
  });
  const voiceAttempt = createAssetAttempt(ctx, voiceInput(state, {
    id: 'v-provider-generated',
    is_cloned: false,
  }));

  const voice = finalizeAssetAttempt(ctx, voiceAttempt.id, voiceResult(511));

  assert.equal(voice.voice_asset_id, 511);
  assert.equal(voice.status, 'generated');
  const sourcePayload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
    .get(voiceAttempt.id).source_ref_json);
  assert.equal(sourcePayload.snapshot.voice_evidence.voice_id, 'fixture-voice');
  assert.equal(credits.getReservation(state.db, voice.credit_reservation_id).status, 'confirmed');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('finalizeAssetAttempt 成功保存语音证据后精准失效声音依赖镜头', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-voice-invalidate-'));
  fs.writeFileSync(path.join(root, 'voice.mp3'), 'voice');
  addTypedAsset(state.db, 514, 'voice.mp3', 'audio', 'audio/mpeg', 3.2);
  addReadyDialogueShot(state);
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, {
    kind: 'voice',
    sourceRef: { id: 'v-invalidate', source_character_key: 'voice-character-1', voice_id: 'fixture-voice', is_cloned: false },
  });
  const voiceAttempt = createAssetAttempt(ctx, voiceInput(state, {
    id: 'v-invalidate',
    source_character_key: 'voice-character-1',
    voice_id: 'fixture-voice',
    is_cloned: false,
  }));

  const voice = finalizeAssetAttempt(ctx, voiceAttempt.id, voiceResult(514));

  assert.equal(voice.status, 'generated');
  assert.equal(credits.getReservation(state.db, voice.credit_reservation_id).status, 'confirmed');
  assert.deepEqual(dialogueShotState(state.db), {
    preparation_state: 'stale',
    preparation_version: 3,
    reference_bundle_hash: null,
    video_generation_id: null,
    stale_reason_code: 'voice_changed',
  });
  const event = state.db.prepare('SELECT reason_code, metadata_json FROM redraw_workflow_events').get();
  assert.equal(event.reason_code, 'voice_changed');
  assert.equal(JSON.parse(event.metadata_json).old_bundle_hash, 'b'.repeat(64));
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('finalizeAssetAttempt rejects provider voice id that differs from explicit expected voice id', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-voice-mismatch-'));
  fs.writeFileSync(path.join(root, 'voice.mp3'), 'voice');
  addTypedAsset(state.db, 512, 'voice.mp3', 'audio', 'audio/mpeg', 3.2);
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, {
    kind: 'voice',
    sourceRef: { id: 'v-expected', voice_id: 'expected-voice', is_cloned: false },
  });
  const voiceAttempt = createAssetAttempt(ctx, voiceInput(state, {
    id: 'v-expected',
    voice_id: 'expected-voice',
    is_cloned: false,
  }));

  const voice = finalizeAssetAttempt(ctx, voiceAttempt.id, voiceResult(512));

  assert.equal(voice.status, 'needs_attention');
  const row = state.db.prepare('SELECT error_code, voice_asset_id, credit_reservation_id FROM redraw_assets WHERE id = ?')
    .get(voiceAttempt.id);
  assert.equal(row.error_code, 'REDRAW_VOICE_EVIDENCE_INCOMPLETE');
  assert.equal(row.voice_asset_id, 512);
  assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'held');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('finalizeAssetAttempt rejects provider-generated voice evidence with empty voice id', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-empty-voice-'));
  fs.writeFileSync(path.join(root, 'voice.mp3'), 'voice');
  addTypedAsset(state.db, 513, 'voice.mp3', 'audio', 'audio/mpeg', 3.2);
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, {
    kind: 'voice',
    sourceRef: { id: 'v-empty', is_cloned: false },
  });
  const voiceAttempt = createAssetAttempt(ctx, voiceInput(state, {
    id: 'v-empty',
    is_cloned: false,
  }));

  const voice = finalizeAssetAttempt(ctx, voiceAttempt.id, voiceResult(513, 'provider-voice-empty', {
    voice_id: '',
  }));

  assert.equal(voice.status, 'needs_attention');
  const row = state.db.prepare('SELECT error_code, voice_asset_id, credit_reservation_id FROM redraw_assets WHERE id = ?')
    .get(voiceAttempt.id);
  assert.equal(row.error_code, 'REDRAW_VOICE_EVIDENCE_INCOMPLETE');
  assert.equal(row.voice_asset_id, 513);
  assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'held');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('finalizeAssetAttempt holds non-audio voice output without confirming credits', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-voice-type-'));
  fs.writeFileSync(path.join(root, 'not-audio.png'), 'not-audio');
  addAsset(state.db, 503, 'not-audio.png');
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, { kind: 'voice', sourceRef: { id: 'voice-image' } });
  const voiceAttempt = createAssetAttempt(ctx, voiceInput(state, { id: 'voice-image' }));

  const finalized = finalizeAssetAttempt(ctx, voiceAttempt.id, { status: 'completed', voice_asset_id: 503 });
  assert.equal(finalized.status, 'needs_attention');
  const row = state.db.prepare('SELECT status, error_code, credit_reservation_id FROM redraw_assets WHERE id = ?').get(voiceAttempt.id);
  assert.equal(row.status, 'needs_attention');
  assert.equal(row.error_code, 'VOICE_ASSET_TYPE_INVALID');
  assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'held');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('finalizeAssetAttempt holds zero-duration voice output without confirming credits', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-voice-duration-'));
  fs.writeFileSync(path.join(root, 'silent.mp3'), 'silent');
  addTypedAsset(state.db, 505, 'silent.mp3', 'audio', 'audio/mpeg', 0);
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, { kind: 'voice', sourceRef: { id: 'voice-zero' } });
  const voiceAttempt = createAssetAttempt(ctx, voiceInput(state, { id: 'voice-zero' }));

  const finalized = finalizeAssetAttempt(ctx, voiceAttempt.id, { status: 'completed', voice_asset_id: 505 });
  assert.equal(finalized.status, 'needs_attention');
  const row = state.db.prepare('SELECT status, error_code, credit_reservation_id FROM redraw_assets WHERE id = ?').get(voiceAttempt.id);
  assert.equal(row.status, 'needs_attention');
  assert.equal(row.error_code, 'VOICE_ASSET_DURATION_INVALID');
  assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'held');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('finalizeAssetAttempt requires clean plate quality before settlement', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-clean-quality-'));
  fs.writeFileSync(path.join(root, 'clean.png'), 'clean');
  addAsset(state.db, 504, 'clean.png');
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, { kind: 'scene', sourceRef: { id: 'scene-clean-quality' } });
  const sceneAttempt = createAssetAttempt(ctx, {
    kind: 'scene',
    sourceRef: { id: 'scene-clean-quality' },
    snapshot: { width: 1280, height: 720 },
  });

  assert.throws(
    () => finalizeAssetAttempt(ctx, sceneAttempt.id, { status: 'completed', clean_plate_asset_id: 504, clean_plate: true }),
    (error) => error.code === 'CLEAN_PLATE_QUALITY_UNVERIFIED',
  );
  const row = state.db.prepare('SELECT status, error_code, credit_reservation_id FROM redraw_assets WHERE id = ?').get(sceneAttempt.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'CLEAN_PLATE_QUALITY_UNVERIFIED');
  assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'refunded');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('failAssetAttempt 标记失败并复用生成结算退款', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-fail-attempt-'));
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, { kind: 'prop', sourceRef: { id: 'p-fail' } });
  const attempt = createAssetAttempt(ctx, { kind: 'prop', sourceRef: { id: 'p-fail' } });

  const failed = failAssetAttempt(ctx, attempt.id, Object.assign(new Error('provider rejected'), { code: 'FAKE_FAILED' }));
  const reservation = state.db.prepare('SELECT credit_reservation_id FROM redraw_assets WHERE id = ?').get(attempt.id);

  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'FAKE_FAILED');
  assert.equal(failed.error_message, 'provider rejected');
  assert.equal(credits.getReservation(state.db, reservation.credit_reservation_id).status, 'refunded');
  const failedAgain = failAssetAttempt(ctx, attempt.id, Object.assign(new Error('provider rejected again'), { code: 'FAKE_FAILED_AGAIN' }));
  assert.equal(failedAgain.status, 'failed');
  assert.equal(credits.getReservation(state.db, reservation.credit_reservation_id).status, 'refunded');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});
