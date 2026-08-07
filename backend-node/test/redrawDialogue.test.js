const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const {
  buildDialoguePlan,
  quoteDialoguePlan,
  synthesizeDialogueForVersion,
} = require('../src/services/redrawDialogueService');

function setup(options = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  credits.setTenantAccountBalance(db, 'tenant-a', options.balance ?? 100);
  credits.setTenantAccountBalance(db, 'tenant-b', 100);
  prices.set(db, 'speech-2.8-turbo', 4, { category: 'audio', billingUnit: 'request' });
  prices.set(db, 'client-fake-model', 99, { category: 'audio', billingUnit: 'request' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '配音项目', ?, ?)`).run(now, now);
  const projectId = db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '配音作品', 1, 'dialogue-source', 15000, ?, ?)`).run(projectId, now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', '{}', 'facts-dialogue', 'asset_review', ?, ?)`)
    .run(workId, now, now).lastInsertRowid);
  addVoiceSample(db, 501, 'voice-a.mp3');
  addVoiceSample(db, 502, 'voice-b.mp3');
  addCharacter(db, versionId, 701, 'c-1', voiceSnapshot(501, 'voice-c1'));
  addCharacter(db, versionId, 702, 'c-2', voiceSnapshot(502, 'voice-c2'));
  addShot(db, versionId, {
    id: 801,
    shot_id: 'shot-1',
    batch_index: 1,
    shot_index: 1,
    start_ms: 0,
    end_ms: 3000,
    dialogue: [{ speaker_id: 'c-1', localized_text: 'Come with me.', start_ms: 100, end_ms: 1200, estimated_duration_ms: 900 }],
  });
  addShot(db, versionId, {
    id: 802,
    shot_id: 'shot-2',
    batch_index: 1,
    shot_index: 2,
    start_ms: 3000,
    end_ms: 7000,
    dialogue: [
      { speaker_id: 'c-1', localized_text: 'No.', start_ms: 3100, end_ms: 3700, estimated_duration_ms: 500 },
      { speaker_id: 'c-2', localized_text: 'Then stay quiet.', start_ms: 3800, end_ms: 5200, estimated_duration_ms: 1200 },
    ],
  });
  return { db, versionId };
}

function addVoiceSample(db, id, localPath) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, duration, created_at, updated_at)
    VALUES (?, '样音', 'audio', 'voice', ?, 'audio/mpeg', 1.2, ?, ?)`).run(id, localPath, now, now);
}

function addAudioAsset(db, id, duration = 1.1) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, duration, created_at, updated_at)
    VALUES (?, '生成配音', 'audio', 'redraw_dialogue', ?, 'audio/mpeg', ?, ?, ?)`)
    .run(id, `dialogue-${id}.mp3`, duration, now, now);
}

function voiceSnapshot(audioAssetId, voiceId) {
  return {
    locale: 'en-US',
    market: 'US',
    provider: 'minimax',
    model: 'speech-2.8-turbo',
    voice_id: voiceId,
    task_id: `verified-${voiceId}`,
    terminal_status: 'completed',
    audio_asset_id: audioAssetId,
    duration_ms: 1200,
    real_generation_verified: true,
    language_verified: true,
  };
}

function addCharacter(db, versionId, id, speakerId, snapshot) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'character', ?, '角色', ?, 1, 'pending', 'generated', ?, ?)`).run(
    id,
    versionId,
    JSON.stringify({ source_ref: { character_id: speakerId }, snapshot: { voice_snapshot: snapshot } }),
    id + 1000,
    now,
    now,
  );
}

function addShot(db, versionId, input) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO redraw_shots
    (id, work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
     references_json, draft_json, created_at, updated_at)
    VALUES (?, 1, ?, ?, 'tenant-a', 'user-a', ?, ?, ?, ?, ?, '[]', ?, '[]', '{}', ?, ?)`).run(
    input.id,
    input.shot_id,
    versionId,
    input.batch_index,
    input.shot_index,
    input.start_ms,
    input.end_ms,
    input.end_ms - input.start_ms,
    JSON.stringify(input.dialogue),
    now,
    now,
  );
}

function ctx(state, overrides = {}) {
  return {
    db: state.db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: state.versionId,
    canReadAudioAsset: (asset) => Number(asset.duration) > 0,
    ...overrides,
  };
}

test('buildDialoguePlan fixes speaker voices from server snapshots and orders constrained segments', () => {
  const state = setup();
  const plan = buildDialoguePlan(state.db, ctx(state));

  assert.equal(plan.status, 'ready');
  assert.equal(plan.version.locale, 'en-US');
  assert.deepEqual(plan.tracks.map((track) => track.speaker_id), ['c-1', 'c-2']);
  assert.deepEqual(plan.segments.map((segment) => segment.segment_id), ['801:0', '802:0', '802:1']);
  assert.equal(plan.segments[0].voice_snapshot.voice_id, 'voice-c1');
  assert.equal(plan.segments[1].voice_snapshot.voice_id, 'voice-c1');
  assert.equal(plan.segments[2].voice_snapshot.voice_id, 'voice-c2');
  assert.equal(plan.segments[0].start_ms >= 0 && plan.segments[0].end_ms <= 3000, true);
  state.db.close();
});

test('buildDialoguePlan returns needs_rewrite for invalid or overlong dialogue without generation segments', async () => {
  const state = setup();
  state.db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE id = 801')
    .run(JSON.stringify([{ speaker_id: 'c-1', localized_text: '', start_ms: 0, end_ms: 1000, estimated_duration_ms: 800 }]));
  state.db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE id = 802')
    .run(JSON.stringify([{ speaker_id: 'c-2', localized_text: 'This line is too long.', start_ms: 3000, end_ms: 3400, estimated_duration_ms: 900 }]));
  let providerCalls = 0;
  const plan = buildDialoguePlan(state.db, ctx(state));
  const quote = quoteDialoguePlan(state.db, ctx(state));

  assert.equal(plan.status, 'needs_rewrite');
  assert.deepEqual(plan.segments, []);
  assert.deepEqual(plan.issues.map((issue) => issue.reason), ['dialogue_text_invalid', 'dialogue_duration_exceeded']);
  assert.equal(quote.total_credits, 0);
  await assert.rejects(
    () => synthesizeDialogueForVersion(ctx(state, {
      synthesizeSegment: async () => { providerCalls += 1; },
    }), { quoteHash: quote.quote_hash, idempotencyKey: 'idem-invalid' }),
    (error) => error.code === 'REDRAW_DIALOGUE_PLAN_NOT_READY',
  );
  assert.equal(providerCalls, 0);
  state.db.close();
});

test('quoteDialoguePlan prices only server-side voice snapshot models', () => {
  const state = setup();
  const quote = quoteDialoguePlan(state.db, ctx(state, { model: 'client-fake-model', credits: 99 }));

  assert.equal(quote.total_credits, 12);
  assert.equal(quote.segment_count, 3);
  assert.match(quote.quote_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(quote.models, [{ model: 'speech-2.8-turbo', credits: 4, segments: 3 }]);
  state.db.close();
});

test('synthesizeDialogueForVersion reserves, calls provider with snapshot voice, validates asset, confirms, and writes audit draft', async () => {
  const state = setup();
  const quote = quoteDialoguePlan(state.db, ctx(state));
  const providerCalls = [];
  let nextAssetId = 901;
  const result = await synthesizeDialogueForVersion(ctx(state, {
    synthesizeSegment: async (segment) => {
      providerCalls.push(segment);
      addAudioAsset(state.db, nextAssetId, 1.2);
      return { asset_id: nextAssetId++, provider_task_id: `provider-${segment.segment_id}` };
    },
  }), { quoteHash: quote.quote_hash, idempotencyKey: 'idem-success' });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls.length, 3);
  assert.equal(providerCalls[0].model, 'speech-2.8-turbo');
  assert.equal(providerCalls[0].provider, 'minimax');
  assert.equal(providerCalls[0].voice_id, 'voice-c1');
  assert.equal(providerCalls[0].voice_snapshot.voice_id, 'voice-c1');
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = ?').get('confirmed').count, 3);
  const shotOne = state.db.prepare('SELECT audio_asset_id, draft_json FROM redraw_shots WHERE id = 801').get();
  assert.equal(shotOne.audio_asset_id, 901);
  assert.equal(JSON.parse(shotOne.draft_json).dialogue_generation.segments[0].reservation_status, 'confirmed');
  const shotTwo = state.db.prepare('SELECT audio_asset_id, draft_json FROM redraw_shots WHERE id = 802').get();
  assert.equal(shotTwo.audio_asset_id, null);
  assert.equal(JSON.parse(shotTwo.draft_json).dialogue_generation.segments.length, 2);
  state.db.close();
});

test('explicit provider failure refunds only that segment reservation and records failure audit', async () => {
  const state = setup();
  const quote = quoteDialoguePlan(state.db, ctx(state));

  await assert.rejects(
    () => synthesizeDialogueForVersion(ctx(state, {
      synthesizeSegment: async () => {
        const error = new Error('provider rejected');
        error.code = 'PROVIDER_FAILED';
        throw error;
      },
    }), { quoteHash: quote.quote_hash, idempotencyKey: 'idem-fail' }),
    (error) => error.code === 'PROVIDER_FAILED',
  );
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = ?').get('refunded').count, 1);
  const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = 801').get().draft_json);
  assert.equal(draft.dialogue_generation.segments[0].status, 'failed');
  assert.equal(draft.dialogue_generation.segments[0].reservation_status, 'refunded');
  state.db.close();
});

test('unknown provider result stays held, needs_attention, and same idempotency does not resubmit completed segments', async () => {
  const state = setup();
  const quote = quoteDialoguePlan(state.db, ctx(state));
  let calls = 0;

  await assert.rejects(
    () => synthesizeDialogueForVersion(ctx(state, {
      synthesizeSegment: async (segment) => {
        calls += 1;
        if (calls === 1) {
          addAudioAsset(state.db, 911, 1.2);
          return { asset_id: 911, provider_task_id: 'provider-ok' };
        }
        const error = new Error('供应商任务仍可能处理中');
        error.code = 'PROVIDER_STATUS_UNKNOWN';
        error.unknown = true;
        error.provider_task_id = 'provider-unknown';
        throw error;
      },
    }), { quoteHash: quote.quote_hash, idempotencyKey: 'idem-unknown' }),
    (error) => error.code === 'PROVIDER_STATUS_UNKNOWN',
  );
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = ?').get('confirmed').count, 1);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = ?').get('held').count, 1);
  const firstCalls = calls;

  await assert.rejects(
    () => synthesizeDialogueForVersion(ctx(state, {
      synthesizeSegment: async () => {
        calls += 1;
        throw Object.assign(new Error('still unknown'), { code: 'PROVIDER_STATUS_UNKNOWN', unknown: true });
      },
    }), { quoteHash: quote.quote_hash, idempotencyKey: 'idem-unknown' }),
    (error) => error.code === 'REDRAW_DIALOGUE_NEEDS_ATTENTION',
  );
  assert.equal(calls, firstCalls);
  state.db.close();
});

test('same idempotency returns completed readable segments without duplicate provider calls or reservations', async () => {
  const state = setup();
  const quote = quoteDialoguePlan(state.db, ctx(state));
  let calls = 0;
  let nextAssetId = 921;
  const first = await synthesizeDialogueForVersion(ctx(state, {
    synthesizeSegment: async () => {
      calls += 1;
      addAudioAsset(state.db, nextAssetId, 1.1);
      return { asset_id: nextAssetId++, provider_task_id: `provider-${calls}` };
    },
  }), { quoteHash: quote.quote_hash, idempotencyKey: 'idem-replay' });
  const second = await synthesizeDialogueForVersion(ctx(state, {
    synthesizeSegment: async () => {
      calls += 1;
      throw new Error('must not run');
    },
  }), { quoteHash: quote.quote_hash, idempotencyKey: 'idem-replay' });

  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(calls, 3);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 3);
  state.db.close();
});

test('cross tenant access is rejected before quote or synthesis side effects', async () => {
  const state = setup();

  assert.throws(
    () => buildDialoguePlan(state.db, ctx(state, { tenantId: 'tenant-b' })),
    (error) => error.code === 'REDRAW_DIALOGUE_VERSION_NOT_FOUND',
  );
  assert.throws(
    () => quoteDialoguePlan(state.db, ctx(state, { tenantId: 'tenant-b' })),
    (error) => error.code === 'REDRAW_DIALOGUE_VERSION_NOT_FOUND',
  );
  await assert.rejects(
    () => synthesizeDialogueForVersion(ctx(state, { tenantId: 'tenant-b' }), {
      quoteHash: 'bad',
      idempotencyKey: 'idem-cross',
    }),
    (error) => error.code === 'REDRAW_DIALOGUE_VERSION_NOT_FOUND',
  );
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE tenant_id = ?').get('tenant-b').count, 0);
  state.db.close();
});
