'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  assertSafeBlueprintValue,
  createOrSaveDraft,
  getCurrentBlueprint,
  lockBlueprint,
  saveDraft,
} = require('../src/services/redrawBlueprintWorkflowService');
const {
  normalizeEpisodeBlueprint,
  projectSourceFactsV2,
} = require('../src/services/redrawEpisodeBlueprintService');
const {
  buildLocalizationInput,
  createLocalizationVersion,
} = require('../src/services/localizationService');
const { fixtureBlueprint, lockedBlueprint } = require('./redrawEpisodeBlueprint.test');

const NOW = '2026-09-03T00:00:00.000Z';

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const projectId = Number(db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, default_locale, default_market, localization_level,
       status, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '母本项目', 'en-US', 'US', 'faithful', 'draft', ?, ?)
  `).run(NOW, NOW).lastInsertRowid);
  const workId = Number(db.prepare(`
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '母本', 101, ?, 12000, 1, 1, 'needs_attention', ?, ?)
  `).run(projectId, 'workflow-source', NOW, NOW).lastInsertRowid);
  const versionId = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       source_facts_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'source', '', 'faithful', NULL, 'needs_attention', ?, ?)
  `).run(workId, NOW, NOW).lastInsertRowid);
  return {
    db,
    workId,
    versionId,
    ctx: { db, tenantId: 'tenant-a', userId: 'user-a' },
  };
}

function changedLockedBlueprint(summary) {
  const value = lockedBlueprint();
  value.story.summary = summary;
  delete value.blueprint_hash;
  return normalizeEpisodeBlueprint(value);
}

function insertSourceShot(state, shot, overrides = {}) {
  return state.db.prepare(`
    INSERT INTO redraw_shots
      (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
       start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
       references_json, opening_state, continuous_action, ending_state, status,
       created_at, updated_at)
    VALUES (?, ?, ?, 'tenant-a', 'user-a', 1, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?, ?)
  `).run(
    state.workId,
    overrides.shotId || shot.id,
    state.versionId,
    overrides.shotIndex || shot.index,
    shot.start_ms,
    shot.end_ms,
    shot.end_ms - shot.start_ms,
    JSON.stringify(shot.dialogue),
    shot.opening_state,
    shot.continuous_action,
    shot.ending_state,
    overrides.status || 'draft',
    overrides.createdAt || NOW,
    overrides.updatedAt || NOW,
  );
}

test('creates revision 1 and returns the same row for a repeated blueprint hash', () => {
  const state = setup();
  try {
    const blueprint = normalizeEpisodeBlueprint(fixtureBlueprint());
    const first = createOrSaveDraft(state.ctx, { workId: state.workId, blueprint });
    const repeated = createOrSaveDraft(state.ctx, { workId: state.workId, blueprint });

    assert.equal(first.revision, 1);
    assert.equal(first.status, 'draft');
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.updated_at, first.updated_at);
    assert.equal(state.db.prepare(`
      SELECT COUNT(*) AS count FROM redraw_episode_blueprints WHERE work_id = ?
    `).get(state.workId).count, 1);
    assert.equal(state.db.prepare(`
      SELECT COUNT(*) AS count FROM redraw_versions WHERE work_id = ?
    `).get(state.workId).count, 1);
    assert.deepEqual(repeated.blueprint, blueprint);
  } finally {
    state.db.close();
  }
});

test('all reads and writes are owner scoped and cross-owner access uses safe not found', () => {
  const state = setup();
  try {
    createOrSaveDraft(state.ctx, {
      workId: state.workId,
      blueprint: normalizeEpisodeBlueprint(fixtureBlueprint()),
    });
    const foreignContexts = [
      { db: state.db, tenantId: 'tenant-b', userId: 'user-a' },
      { db: state.db, tenantId: 'tenant-a', userId: 'user-b' },
    ];
    for (const ctx of foreignContexts) {
      assert.throws(
        () => getCurrentBlueprint(ctx, { workId: state.workId }),
        { code: 'REDRAW_BLUEPRINT_NOT_FOUND' },
      );
      assert.throws(
        () => createOrSaveDraft(ctx, {
          workId: state.workId,
          blueprint: normalizeEpisodeBlueprint(fixtureBlueprint()),
        }),
        { code: 'REDRAW_BLUEPRINT_NOT_FOUND' },
      );
    }
  } finally {
    state.db.close();
  }
});

test('updates a draft with CAS and rejects the stale competing save', () => {
  const state = setup();
  try {
    const draft = createOrSaveDraft(state.ctx, {
      workId: state.workId,
      blueprint: normalizeEpisodeBlueprint(fixtureBlueprint()),
    });
    const winnerBlueprint = changedLockedBlueprint('第一位审核者保存。');
    const loserBlueprint = changedLockedBlueprint('第二位审核者覆盖。');
    const winner = saveDraft(state.ctx, {
      workId: state.workId,
      blueprint: winnerBlueprint,
      expectedUpdatedAt: draft.updated_at,
    });

    assert.equal(winner.revision, 1);
    assert.equal(winner.blueprint_hash, winnerBlueprint.blueprint_hash);
    assert.notEqual(winner.updated_at, draft.updated_at);
    assert.throws(() => saveDraft(state.ctx, {
      workId: state.workId,
      blueprint: loserBlueprint,
      expectedUpdatedAt: draft.updated_at,
    }), { code: 'REDRAW_BLUEPRINT_CAS_CONFLICT' });
    assert.equal(getCurrentBlueprint(state.ctx, { workId: state.workId }).blueprint_hash,
      winnerBlueprint.blueprint_hash);
  } finally {
    state.db.close();
  }
});

test('locks an approved draft atomically, projects source facts and makes the revision immutable', () => {
  const state = setup();
  try {
    const draft = createOrSaveDraft(state.ctx, {
      workId: state.workId,
      blueprint: normalizeEpisodeBlueprint(fixtureBlueprint()),
    });
    const approvedBlueprint = lockedBlueprint();
    const reviewed = saveDraft(state.ctx, {
      workId: state.workId,
      blueprint: approvedBlueprint,
      expectedUpdatedAt: draft.updated_at,
    });
    const locked = lockBlueprint(state.ctx, {
      workId: state.workId,
      expectedBlueprintHash: reviewed.blueprint_hash,
      expectedUpdatedAt: reviewed.updated_at,
    });

    assert.equal(locked.status, 'locked');
    assert.equal(locked.reviewed_by, 'user-a');
    assert.ok(locked.reviewed_at);
    const version = state.db.prepare(`
      SELECT source_facts_json, facts_hash, blueprint_hash
      FROM redraw_versions
      WHERE id = ? AND tenant_id = 'tenant-a' AND user_id = 'user-a' AND work_id = ?
    `).get(state.versionId, state.workId);
    const projected = projectSourceFactsV2(approvedBlueprint);
    assert.deepEqual(JSON.parse(version.source_facts_json), projected);
    assert.equal(version.facts_hash, projected.facts_hash);
    assert.equal(version.blueprint_hash, approvedBlueprint.blueprint_hash);

    assert.throws(() => saveDraft(state.ctx, {
      workId: state.workId,
      blueprint: changedLockedBlueprint('锁定后不得覆盖。'),
      expectedUpdatedAt: locked.updated_at,
    }), { code: 'REDRAW_BLUEPRINT_LOCKED' });
    assert.equal(getCurrentBlueprint(state.ctx, { workId: state.workId }).blueprint_hash,
      approvedBlueprint.blueprint_hash);
  } finally {
    state.db.close();
  }
});

test('locked blueprint materializes source shots and directly creates a localization version', () => {
  const state = setup();
  try {
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_shots').get().count, 0);
    const draft = createOrSaveDraft(state.ctx, {
      workId: state.workId,
      blueprint: normalizeEpisodeBlueprint(fixtureBlueprint()),
    });
    const reviewed = saveDraft(state.ctx, {
      workId: state.workId,
      blueprint: lockedBlueprint(),
      expectedUpdatedAt: draft.updated_at,
    });
    lockBlueprint(state.ctx, {
      workId: state.workId,
      expectedBlueprintHash: reviewed.blueprint_hash,
      expectedUpdatedAt: reviewed.updated_at,
    });

    const projected = projectSourceFactsV2(lockedBlueprint());
    const sourceShots = state.db.prepare(`
      SELECT work_id, version_id, tenant_id, user_id, batch_index, shot_index, shot_id,
             start_ms, end_ms, duration_ms, source_dialogue_json,
             localized_dialogue_json, references_json, opening_state,
             continuous_action, ending_state, status, preparation_state, deleted_at
      FROM redraw_shots
      WHERE version_id = ?
      ORDER BY batch_index, shot_index
    `).all(state.versionId);
    assert.equal(sourceShots.length, projected.shots.length);
    sourceShots.forEach((row, index) => {
      const shot = projected.shots[index];
      assert.equal(Number(row.work_id), state.workId);
      assert.equal(row.version_id, state.versionId);
      assert.equal(row.tenant_id, 'tenant-a');
      assert.equal(row.user_id, 'user-a');
      assert.equal(row.batch_index, 1);
      assert.equal(row.shot_index, shot.index);
      assert.equal(row.shot_id, shot.id);
      assert.equal(row.start_ms, shot.start_ms);
      assert.equal(row.end_ms, shot.end_ms);
      assert.equal(row.duration_ms, shot.end_ms - shot.start_ms);
      assert.deepEqual(JSON.parse(row.source_dialogue_json), shot.dialogue);
      assert.deepEqual(JSON.parse(row.localized_dialogue_json), []);
      assert.deepEqual(JSON.parse(row.references_json), []);
      assert.equal(row.opening_state, shot.opening_state);
      assert.equal(row.continuous_action, shot.continuous_action);
      assert.equal(row.ending_state, shot.ending_state);
      assert.equal(row.status, 'draft');
      assert.equal(row.preparation_state, 'parsed');
      assert.equal(row.deleted_at, null);
    });

    const localized = createLocalizationVersion(state.db, state.ctx, state.workId, {
      ...buildLocalizationInput(projected, { locale: 'en-US', market: 'US' }),
      sourceVersionId: state.versionId,
      dialogue: [
        { shot_id: 'shot-1', turns: [{ speaker_id: 'character-qiao-an', target_text: 'Order 87 is here' }] },
        { shot_id: 'shot-2', turns: [{ speaker_id: 'narrator', target_text: 'It was over' }] },
      ],
      textMap: { 'shot-2:text-region-1': 'CASE EIGHTY SEVEN' },
    });
    assert.equal(localized.shot_count, projected.shots.length);
    assert.equal(state.db.prepare(`
      SELECT COUNT(*) AS count FROM redraw_shots WHERE version_id = ?
    `).get(localized.id).count, projected.shots.length);
    assert.equal(state.db.prepare(`
      SELECT COUNT(*) AS count FROM redraw_shots WHERE version_id = ?
    `).get(state.versionId).count, projected.shots.length);
  } finally {
    state.db.close();
  }
});

test('locking preserves an identical source shot and inserts only missing shots', () => {
  const state = setup();
  try {
    const blueprint = lockedBlueprint();
    const projected = projectSourceFactsV2(blueprint);
    const draft = createOrSaveDraft(state.ctx, { workId: state.workId, blueprint });
    const existing = insertSourceShot(state, projected.shots[0], {
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    });

    lockBlueprint(state.ctx, {
      workId: state.workId,
      expectedBlueprintHash: draft.blueprint_hash,
      expectedUpdatedAt: draft.updated_at,
    });

    const rows = state.db.prepare(`
      SELECT id, shot_id, created_at, updated_at
      FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
    `).all(state.versionId);
    assert.equal(rows.length, projected.shots.length);
    assert.deepEqual(rows.map((row) => row.shot_id), projected.shots.map((shot) => shot.id));
    assert.equal(rows[0].id, Number(existing.lastInsertRowid));
    assert.equal(rows[0].created_at, '2026-09-02T00:00:00.000Z');
    assert.equal(rows[0].updated_at, '2026-09-02T00:00:00.000Z');
  } finally {
    state.db.close();
  }
});

test('conflicting source shot rolls back lock and preserves the existing row', () => {
  const state = setup();
  try {
    const blueprint = lockedBlueprint();
    const projected = projectSourceFactsV2(blueprint);
    const draft = createOrSaveDraft(state.ctx, { workId: state.workId, blueprint });
    insertSourceShot(state, projected.shots[0], { shotId: 'conflicting-shot' });

    assert.throws(() => lockBlueprint(state.ctx, {
      workId: state.workId,
      expectedBlueprintHash: draft.blueprint_hash,
      expectedUpdatedAt: draft.updated_at,
    }), { code: 'REDRAW_BLUEPRINT_SOURCE_SHOTS_CONFLICT' });

    assert.equal(getCurrentBlueprint(state.ctx, { workId: state.workId }).status, 'draft');
    assert.deepEqual(state.db.prepare(`
      SELECT source_facts_json, facts_hash, blueprint_hash FROM redraw_versions WHERE id = ?
    `).get(state.versionId), {
      source_facts_json: null,
      facts_hash: null,
      blueprint_hash: null,
    });
    assert.deepEqual(state.db.prepare(`
      SELECT shot_id, shot_index, status FROM redraw_shots WHERE version_id = ?
    `).all(state.versionId), [{ shot_id: 'conflicting-shot', shot_index: 1, status: 'draft' }]);
  } finally {
    state.db.close();
  }
});

test('unresolved review cannot lock and leaves both draft and version unchanged', () => {
  const state = setup();
  try {
    const draft = createOrSaveDraft(state.ctx, {
      workId: state.workId,
      blueprint: normalizeEpisodeBlueprint(fixtureBlueprint()),
    });
    assert.throws(() => lockBlueprint(state.ctx, {
      workId: state.workId,
      expectedBlueprintHash: draft.blueprint_hash,
      expectedUpdatedAt: draft.updated_at,
    }), /BLUEPRINT_(SPEAKER_)?REVIEW_REQUIRED/);

    assert.equal(getCurrentBlueprint(state.ctx, { workId: state.workId }).status, 'draft');
    assert.deepEqual(state.db.prepare(`
      SELECT source_facts_json, facts_hash, blueprint_hash FROM redraw_versions WHERE id = ?
    `).get(state.versionId), {
      source_facts_json: null,
      facts_hash: null,
      blueprint_hash: null,
    });
  } finally {
    state.db.close();
  }
});

test('a new blueprint revision bypasses and preserves an already-bound legacy source version', () => {
  const state = setup();
  try {
    const legacyFacts = JSON.stringify({ schema_version: 'legacy', keep: true });
    state.db.prepare(`
      UPDATE redraw_versions SET source_facts_json = ?, facts_hash = ? WHERE id = ?
    `).run(legacyFacts, 'legacy-hash', state.versionId);
    const draft = createOrSaveDraft(state.ctx, {
      workId: state.workId,
      blueprint: lockedBlueprint(),
    });
    assert.equal(draft.revision, 2);
    const locked = lockBlueprint(state.ctx, {
      workId: state.workId,
      expectedBlueprintHash: draft.blueprint_hash,
      expectedUpdatedAt: draft.updated_at,
    });
    assert.equal(locked.status, 'locked');
    assert.deepEqual(state.db.prepare(`
      SELECT source_facts_json, facts_hash, blueprint_hash FROM redraw_versions WHERE id = ?
    `).get(state.versionId), {
      source_facts_json: legacyFacts,
      facts_hash: 'legacy-hash',
      blueprint_hash: null,
    });
    assert.equal(state.db.prepare(`
      SELECT blueprint_hash FROM redraw_versions
      WHERE tenant_id = 'tenant-a' AND user_id = 'user-a' AND work_id = ? AND version = 2
    `).get(state.workId).blueprint_hash, draft.blueprint_hash);
  } finally {
    state.db.close();
  }
});

test('analysis may create an explicit new draft revision after the previous one is locked', () => {
  const state = setup();
  try {
    const first = createOrSaveDraft(state.ctx, { workId: state.workId, blueprint: lockedBlueprint() });
    const locked = lockBlueprint(state.ctx, {
      workId: state.workId,
      expectedBlueprintHash: first.blueprint_hash,
      expectedUpdatedAt: first.updated_at,
    });
    const nextBlueprint = changedLockedBlueprint('重新分析产生新的修订。');
    const next = createOrSaveDraft(state.ctx, { workId: state.workId, blueprint: nextBlueprint });

    assert.equal(locked.revision, 1);
    assert.equal(next.revision, 2);
    assert.equal(next.status, 'draft');
    assert.equal(state.db.prepare(`
      SELECT status FROM redraw_episode_blueprints WHERE work_id = ? AND revision = 1
    `).get(state.workId).status, 'locked');
    assert.deepEqual(state.db.prepare(`
      SELECT version, source_facts_json, facts_hash, blueprint_hash, locale, status
      FROM redraw_versions
      WHERE tenant_id = 'tenant-a' AND user_id = 'user-a' AND work_id = ? AND version = 2
    `).get(state.workId), {
      version: 2,
      source_facts_json: null,
      facts_hash: null,
      blueprint_hash: null,
      locale: 'source',
      status: 'needs_attention',
    });
    const firstVersionBefore = state.db.prepare(`
      SELECT source_facts_json, facts_hash, blueprint_hash
      FROM redraw_versions
      WHERE tenant_id = 'tenant-a' AND user_id = 'user-a' AND work_id = ? AND version = 1
    `).get(state.workId);
    assert.equal(state.db.prepare('SELECT current_version FROM redraw_works WHERE id = ?')
      .get(state.workId).current_version, 1);
    const lockedNext = lockBlueprint(state.ctx, {
      workId: state.workId,
      expectedBlueprintHash: next.blueprint_hash,
      expectedUpdatedAt: next.updated_at,
    });
    assert.equal(lockedNext.revision, 2);
    assert.equal(lockedNext.status, 'locked');
    assert.deepEqual(state.db.prepare(`
      SELECT source_facts_json, facts_hash, blueprint_hash
      FROM redraw_versions
      WHERE tenant_id = 'tenant-a' AND user_id = 'user-a' AND work_id = ? AND version = 1
    `).get(state.workId), firstVersionBefore);
    assert.equal(state.db.prepare(`
      SELECT blueprint_hash FROM redraw_versions
      WHERE tenant_id = 'tenant-a' AND user_id = 'user-a' AND work_id = ? AND version = 2
    `).get(state.workId).blueprint_hash, next.blueprint_hash);
  } finally {
    state.db.close();
  }
});

test('rejects bounded and confusable blueprint inputs with one stable input error', () => {
  const tooDeep = {};
  let cursor = tooDeep;
  for (let depth = 0; depth <= 64; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  const cycle = {};
  cycle.self = cycle;
  const cases = [
    tooDeep,
    new Array(50_001).fill(null),
    '字'.repeat((4 * 1024 * 1024) + 1),
    cycle,
    { 'ｐｒｏｖｉｄｅｒ': 'client-controlled' },
  ];

  for (const value of cases) {
    assert.throws(
      () => assertSafeBlueprintValue(value),
      { code: 'REDRAW_BLUEPRINT_INPUT_INVALID' },
    );
  }
});
