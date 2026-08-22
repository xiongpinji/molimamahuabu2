const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { preparationEvidenceHash } = require('../src/services/redrawPreparationGateService');
const { canonicalBundleHash } = require('../src/services/redrawReferenceBundleService');
const {
  prepareVersionReferences,
  quoteVersionPreparation,
  reconcileInterruptedPreparations,
  startVersionPreparation,
} = require('../src/services/redrawReferencePreparationOrchestrator');

const NOW = '2026-08-22T08:00:00.000Z';
const NEXT = '2026-08-22T08:00:01.000Z';
const PLAN_HASH = 'a'.repeat(64);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
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
  if (options.readyFirst !== false) markReady(db, 1);
  return {
    db,
    ctx: { db, tenantId: 'tenant-a', userId: 'user-a', versionId: 1, now: () => NEXT },
    close() { db.close(); },
  };
}

function markReady(db, shotId) {
  const bundle = { schema_version: 'redraw-reference-bundle-v1', version_id: 1, shot_id: shotId };
  const referenceHash = canonicalBundleHash(bundle);
  const shot = db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(shotId);
  const snapshot = {
    schema_version: 'redraw-reference-preparation-v1',
    version_id: 1,
    shot_id: shotId,
    preparation_version: Number(shot.preparation_version),
    character_plan_hash: PLAN_HASH,
    reference_bundle_hash: referenceHash,
    request_hash: sha256(`ready:${shotId}`),
    status: 'completed',
  };
  const projected = {
    ...shot,
    reference_bundle_hash: referenceHash,
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
  return {
    status: 'approved',
    shots: shots.map((shot) => ({
      shot_id: shot.id,
      source_shot_id: shot.shot_id,
      requirements: requirements[shot.id] || [{ kind: 'person_clean', key: `people-${shot.id}` }],
    })),
  };
}

function insertReadableImage(db, id) {
  db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, metadata, created_at, updated_at)
    VALUES (?, ?, 'image', 'redraw', ?, 'image/png', '{}', ?, ?)`)
    .run(id, `asset-${id}`, `redraw/asset-${id}.png`, NOW, NOW);
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
        schema_version: 'redraw-reference-bundle-v1',
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
