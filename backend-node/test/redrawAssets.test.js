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
  return { db, workId, versionId };
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
    creditAmount: 5,
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
  assert.equal(state.db.prepare('SELECT local_path FROM assets WHERE id = 401').get().local_path, 'scene.png');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
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
    const row = state.db.prepare('SELECT status, credit_reservation_id FROM redraw_assets').get();
    assert.equal(row.status, 'failed');
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
  const row = state.db.prepare('SELECT status, error_code, credit_reservation_id FROM redraw_assets').get();
  assert.equal(row.status, 'failed');
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
  addDraftPlaceholder(state.db, state, { kind: 'voice', sourceRef: { id: 'v1' } });
  addDraftPlaceholder(state.db, state, { kind: 'scene', sourceRef: { id: 's-clean' } });
  const voiceAttempt = createAssetAttempt(ctx, { kind: 'voice', sourceRef: { id: 'v1' } });
  const sceneAttempt = createAssetAttempt(ctx, { kind: 'scene', sourceRef: { id: 's-clean' } });

  const voice = finalizeAssetAttempt(ctx, voiceAttempt.id, { status: 'completed', voice_asset_id: 501 });
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

test('finalizeAssetAttempt rejects non-audio assets for voice output without confirming credits', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-voice-type-'));
  fs.writeFileSync(path.join(root, 'not-audio.png'), 'not-audio');
  addAsset(state.db, 503, 'not-audio.png');
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, { kind: 'voice', sourceRef: { id: 'voice-image' } });
  const voiceAttempt = createAssetAttempt(ctx, { kind: 'voice', sourceRef: { id: 'voice-image' } });

  assert.throws(
    () => finalizeAssetAttempt(ctx, voiceAttempt.id, { status: 'completed', voice_asset_id: 503 }),
    (error) => error.code === 'VOICE_ASSET_TYPE_INVALID',
  );
  const row = state.db.prepare('SELECT status, error_code, credit_reservation_id FROM redraw_assets WHERE id = ?').get(voiceAttempt.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'VOICE_ASSET_TYPE_INVALID');
  assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'refunded');
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('finalizeAssetAttempt rejects zero-duration voice output without confirming credits', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-voice-duration-'));
  fs.writeFileSync(path.join(root, 'silent.mp3'), 'silent');
  addTypedAsset(state.db, 505, 'silent.mp3', 'audio', 'audio/mpeg', 0);
  const ctx = context(state, root);
  addDraftPlaceholder(state.db, state, { kind: 'voice', sourceRef: { id: 'voice-zero' } });
  const voiceAttempt = createAssetAttempt(ctx, { kind: 'voice', sourceRef: { id: 'voice-zero' } });

  assert.throws(
    () => finalizeAssetAttempt(ctx, voiceAttempt.id, { status: 'completed', voice_asset_id: 505 }),
    (error) => error.code === 'VOICE_ASSET_DURATION_INVALID',
  );
  const row = state.db.prepare('SELECT status, error_code, credit_reservation_id FROM redraw_assets WHERE id = ?').get(voiceAttempt.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'VOICE_ASSET_DURATION_INVALID');
  assert.equal(credits.getReservation(state.db, row.credit_reservation_id).status, 'refunded');
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
