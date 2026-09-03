'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  createOrSaveDraft,
  getCurrentBlueprint,
  lockBlueprint,
  saveDraft,
} = require('../src/services/redrawBlueprintWorkflowService');
const {
  normalizeEpisodeBlueprint,
  projectSourceFactsV2,
} = require('../src/services/redrawEpisodeBlueprintService');
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

test('projection failure rolls back the lock and preserves existing source facts', () => {
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

    assert.throws(() => lockBlueprint(state.ctx, {
      workId: state.workId,
      expectedBlueprintHash: draft.blueprint_hash,
      expectedUpdatedAt: draft.updated_at,
    }), { code: 'REDRAW_BLUEPRINT_VERSION_ALREADY_BOUND' });
    assert.equal(getCurrentBlueprint(state.ctx, { workId: state.workId }).status, 'draft');
    assert.deepEqual(state.db.prepare(`
      SELECT source_facts_json, facts_hash, blueprint_hash FROM redraw_versions WHERE id = ?
    `).get(state.versionId), {
      source_facts_json: legacyFacts,
      facts_hash: 'legacy-hash',
      blueprint_hash: null,
    });
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
  } finally {
    state.db.close();
  }
});
