const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const dialogueService = require('../src/services/redrawDialogueService');
const taskService = require('../src/services/taskService');
const {
  quoteDialogue,
  startDialogue,
  reconcileOrphanedDialogueTasks,
} = require('../src/services/redrawDialogueOrchestrator');

function log() {
  return { info() {}, warn() {}, error() {} };
}

function setup(options = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  creditLedger.setTenantAccountBalance(db, 'tenant-a', options.balance ?? 100);
  prices.set(db, 'speech-2.8-turbo', 4, { category: 'audio', billingUnit: 'request' });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO redraw_projects (tenant_id, user_id, title, created_at, updated_at) VALUES ('tenant-a', 'user-a', 'P', ?, ?)")
    .run(now, now);
  const projectId = db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id;
  db.prepare("INSERT INTO redraw_works (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, current_version, created_at, updated_at) VALUES (?, 'tenant-a', 'user-a', 'W', 1, ?, 15000, 1, ?, ?)")
    .run(projectId, 'd'.repeat(64), now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  const versionId = Number(db.prepare("INSERT INTO redraw_versions (work_id, tenant_id, user_id, version, locale, market, source_facts_json, facts_hash, status, created_at, updated_at) VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', '{}', 'facts', 'asset_review', ?, ?)")
    .run(workId, now, now).lastInsertRowid);
  db.prepare("INSERT INTO assets (id, name, type, category, local_path, mime_type, duration, created_at, updated_at) VALUES (501, 'voice', 'audio', 'voice', 'voice.mp3', 'audio/mpeg', 1, ?, ?)")
    .run(now, now);
  const voiceSnapshot = {
    locale: 'en-US',
    market: 'US',
    provider: 'minimax',
    model: 'speech-2.8-turbo',
    voice_id: 'voice-c1',
    task_id: 'verified-voice',
    terminal_status: 'completed',
    audio_asset_id: 501,
    duration_ms: 1000,
    real_generation_verified: true,
    language_verified: true,
  };
  db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name, asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 'character', ?, 'Maya', 701, 1, 'pending', 'generated', ?, ?)`)
    .run(versionId, JSON.stringify({ source_ref: { character_id: 'c-1' }, snapshot: { voice_snapshot: voiceSnapshot } }), now, now);
  db.prepare(`INSERT INTO redraw_shots
    (id, work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     source_dialogue_json, localized_dialogue_json, references_json, draft_json, created_at, updated_at)
    VALUES (801, ?, 'shot-1', ?, 'tenant-a', 'user-a', 1, 1, 0, 2000, 2000, '[]', ?, '[]', '{}', ?, ?)`)
    .run(workId, versionId, JSON.stringify([{ speaker_id: 'c-1', localized_text: 'Come with me.', start_ms: 100, end_ms: 1200, estimated_duration_ms: 900 }]), now, now);
  return { db, workId, versionId };
}

function ctx(state, overrides = {}) {
  return {
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: state.versionId,
    ...overrides,
  };
}

function insertDialogueAsset(db, id, segment, providerTaskId = 'provider-dialogue') {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, duration, metadata, created_at, updated_at)
    VALUES (?, 'dialogue', 'audio', 'redraw_dialogue', ?, 'audio/mpeg', 1.1, ?, ?, ?)`)
    .run(id, `dialogue-${id}.mp3`, JSON.stringify({
      redraw_dialogue: {
        tenant_id: segment.tenant_id,
        user_id: segment.user_id,
        version_id: segment.version_id,
        segment_id: segment.segment_id,
        idempotency_key: segment.idempotency_key,
        reservation_id: segment.reservation_id,
        provider_task_id: providerTaskId,
      },
    }), now, now);
  return { asset_id: id, provider_task_id: providerTaskId, duration: 1.1 };
}

test('quoteDialogue uses server-side dialogue service pricing', () => {
  const state = setup();
  try {
    const quote = quoteDialogue(state.db, ctx(state, { model: 'client-model', credits: 999 }));
    assert.equal(quote.status, 'ready');
    assert.equal(quote.total_credits, 4);
    assert.equal(quote.models[0].model, 'speech-2.8-turbo');
  } finally {
    state.db.close();
  }
});

test('startDialogue creates an owned async task, completes in scheduled work, and reuses the same idempotency key', async () => {
  const state = setup();
  const quote = dialogueService.quoteDialoguePlan(state.db, ctx(state));
  const scheduled = [];
  const providerCalls = [];
  try {
    const first = startDialogue(state.db, log(), ctx(state), {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'idem-start',
    }, {
      schedule: (job) => {
        scheduled.push(job);
        return Promise.resolve().then(job);
      },
      synthesizeSegment: async (segment) => {
        providerCalls.push(segment);
        return insertDialogueAsset(state.db, 901, segment);
      },
      canReadAudioAsset: (asset) => Number(asset.duration) > 0,
    });
    const replay = startDialogue(state.db, log(), ctx(state), {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'idem-start',
    }, {
      schedule: () => { throw new Error('replay must not schedule'); },
      synthesizeSegment: async () => { throw new Error('replay must not call provider'); },
      canReadAudioAsset: () => true,
    });
    await first.completion;

    assert.equal(first.task_id, replay.task_id);
    assert.equal(providerCalls.length, 1);
    assert.equal(scheduled.length, 1);
    const task = taskService.getTask(state.db, first.task_id);
    assert.equal(task.type, 'redraw_dialogue');
    assert.equal(task.tenant_id, 'tenant-a');
    assert.equal(task.user_id, 'user-a');
    assert.equal(task.status, 'completed');
    assert.match(task.resource_id, /^redraw_dialogue:/);
    assert.equal(task.resource_id.includes('idem-start'), false);
  } finally {
    state.db.close();
  }
});

test('startDialogue maps unknown provider result to needs_attention and keeps held credits', async () => {
  const state = setup();
  const quote = dialogueService.quoteDialoguePlan(state.db, ctx(state));
  try {
    const started = startDialogue(state.db, log(), ctx(state), {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'idem-unknown',
    }, {
      schedule: (job) => Promise.resolve().then(job),
      synthesizeSegment: async () => {
        throw Object.assign(new Error('opaque provider state'), { unknown: true, provider_task_id: 'provider-unknown' });
      },
      canReadAudioAsset: () => false,
    });
    await assert.rejects(started.completion, /opaque provider state/);
    const task = taskService.getTask(state.db, started.task_id);
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.provider_task_id, 'provider-unknown');
    assert.equal(creditLedger.getTenantAccount(state.db, 'tenant-a').held, 4);
  } finally {
    state.db.close();
  }
});

test('startDialogue maps explicit provider failure to failed and refunded credits', async () => {
  const state = setup();
  const quote = dialogueService.quoteDialoguePlan(state.db, ctx(state));
  try {
    const started = startDialogue(state.db, log(), ctx(state), {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'idem-failed',
    }, {
      schedule: (job) => Promise.resolve().then(job),
      synthesizeSegment: async () => {
        throw Object.assign(new Error('provider rejected'), { code: 'PROVIDER_FAILED' });
      },
      canReadAudioAsset: () => false,
    });
    await assert.rejects(started.completion, /provider rejected/);
    assert.equal(taskService.getTask(state.db, started.task_id).status, 'failed');
    assert.equal(creditLedger.getTenantAccount(state.db, 'tenant-a').held, 0);
    assert.equal(creditLedger.getTenantAccount(state.db, 'tenant-a').available, 100);
  } finally {
    state.db.close();
  }
});

test('reconcileOrphanedDialogueTasks marks owner processing audits needs_attention without refunding held credits', () => {
  const state = setup();
  const quote = dialogueService.quoteDialoguePlan(state.db, ctx(state));
  const reservation = creditLedger.reserve(state.db, {
    tenantId: 'tenant-a',
    userId: 'user-a',
    actorUserId: 'user-a',
    operationKey: 'orphan-dialogue',
    model: 'speech-2.8-turbo',
    resourceType: 'redraw_dialogue',
    resourceId: `${state.versionId}:801:0`,
    amount: 4,
  });
  state.db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, tenant_id, user_id, created_at, updated_at)
    VALUES ('task-orphan-dialogue', 'redraw_dialogue', 'processing', 50, 'running', ?, 'tenant-a', 'user-a', ?, ?)`)
    .run(`redraw_dialogue:${state.versionId}:abc`, new Date().toISOString(), new Date().toISOString());
  state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE id = 801').run(JSON.stringify({
    dialogue_generation: {
      status: 'processing',
      segments: [{
        segment_id: '801:0',
        status: 'processing',
        idempotency_key: 'idem-orphan',
        quote_hash: quote.quote_hash,
        reservation_id: reservation.id,
      }],
    },
  }));

  const result = reconcileOrphanedDialogueTasks(state.db, log());
  const task = taskService.getTask(state.db, 'task-orphan-dialogue');
  const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = 801').get().draft_json);

  assert.equal(result.needs_attention, 1);
  assert.equal(task.status, 'needs_attention');
  assert.equal(draft.dialogue_generation.status, 'needs_attention');
  assert.equal(draft.dialogue_generation.segments[0].status, 'needs_attention');
  assert.equal(creditLedger.getReservation(state.db, reservation.id).status, 'held');
  state.db.close();
});
