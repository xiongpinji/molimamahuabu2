const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  CONTRACT_VERSION,
  createSupplementalDialogueApproval,
  publicSupplementalDialogueApproval,
  revokeSupplementalDialogueApproval,
} = require('../src/services/redrawSupplementalDialogueApprovalService');

const NOW = '2026-08-28T00:00:00.000Z';
const REVOKED_AT = '2026-08-28T00:05:00.000Z';
const FACTS_HASH = 'a'.repeat(64);
const TARGET_TEXT_SHA256 = '0db551260fc347500da0b407379d2eba5fa696bf12b2fbf83092437402cbcea2';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function expectCode(code) {
  return (error) => error?.code === code && error.message === code;
}

function setup(overrides = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const tenantId = 'tenant-a';
  const userId = 'user-a';
  const decision = {
    action: 'advance',
    effective_mode: 'auto',
    reason_codes: [],
    policy_version: 7,
    evidence_hash: FACTS_HASH,
    ...(overrides.decision || {}),
  };
  const sourceFacts = {
    schema_version: '2.0',
    facts_hash: FACTS_HASH,
    characters: [
      { id: 'mateo', source_name: 'Mateo' },
      { id: 'rafael', source_name: 'Rafael' },
    ],
    shots: [{
      id: 'shot-6',
      index: 6,
      visible_character_ids: ['rafael', 'mateo'],
      dialogue: [],
    }],
    ...(overrides.sourceFacts || {}),
  };
  if (overrides.visibleCharacterIds) {
    sourceFacts.shots[0].visible_character_ids = overrides.visibleCharacterIds;
  }
  db.prepare(`
    INSERT INTO redraw_projects
      (id, tenant_id, user_id, title, default_locale, default_market, localization_level,
       status, policy_version, created_at, updated_at)
    VALUES (1, ?, ?, 'Supplemental dialogue', 'en-US', 'US', 'faithful', 'active', ?, ?, ?)
  `).run(tenantId, userId, overrides.policyVersion || 7, NOW, NOW);
  db.prepare(`
    INSERT INTO redraw_works
      (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (1, 1, ?, ?, 'Episode', 1, ?, 12000, ?, 2, 'asset_review', ?, ?)
  `).run(tenantId, userId, 'b'.repeat(64), overrides.workCurrentVersion || 1, NOW, NOW);
  const versionId = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       source_facts_json, facts_hash, localization_task_id, status, created_at, updated_at)
    VALUES (1, ?, ?, 1, 'en-US', 'US', 'faithful', ?, ?, 'localization-task-1',
            ?, ?, ?)
  `).run(
    tenantId,
    userId,
    JSON.stringify(sourceFacts),
    overrides.versionFactsHash || FACTS_HASH,
    overrides.versionStatus || 'asset_review',
    NOW,
    NOW,
  ).lastInsertRowid);
  const shotRowId = Number(db.prepare(`
    INSERT INTO redraw_shots
      (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
       start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
       status, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, 1, 6, 0, 4000, 4000, '[]', '[]', 'draft', ?, ?)
  `).run(overrides.shotStableId === undefined ? 'shot-6' : overrides.shotStableId, versionId, tenantId, userId, NOW, NOW).lastInsertRowid);
  const voiceAssetId = Number(db.prepare(`
    INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
       localized_description, prompt, version_number, approval_status, status,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Rafael', '', '', 1, 'pending', 'draft', ?, ?)
  `).run(
    versionId,
    tenantId,
    userId,
    overrides.voiceKind || 'voice',
    JSON.stringify({ source_ref: { kind: 'voice', source_character_key: overrides.voiceCharacterKey || 'rafael' } }),
    NOW,
    NOW,
  ).lastInsertRowid);
  const result = {
    status: overrides.taskResultStatus || 'completed',
    work_id: 1,
    version_id: versionId,
    facts_hash: FACTS_HASH,
    localization_decision: decision,
  };
  db.prepare(`
    INSERT INTO async_tasks
      (id, type, status, progress, result, resource_id, tenant_id, user_id,
       created_at, updated_at, completed_at)
    VALUES ('localization-task-1', 'redraw_localization', ?, 100, ?, '1', ?, ?, ?, ?, ?)
  `).run(overrides.taskStatus || 'completed', JSON.stringify(result), tenantId, userId, NOW, NOW, NOW);
  return {
    db,
    tenantId,
    userId,
    versionId,
    shotRowId,
    voiceAssetId,
    decision,
    sourceFacts,
  };
}

function createInput(state, overrides = {}) {
  return {
    db: state.db,
    tenantId: state.tenantId,
    userId: state.userId,
    versionId: state.versionId,
    shotRowId: state.shotRowId,
    voiceAssetId: state.voiceAssetId,
    idempotencyKey: 'approve-rafael-shot-6',
    targetText: '  Welcome home, son.  ',
    sourceTranslation: false,
    expectedShotUpdatedAt: NOW,
    expectedVoiceUpdatedAt: NOW,
    now: () => NOW,
    ...overrides,
  };
}

function expectedHashes(state, approvalId, status = 'active') {
  const ownerSha256 = sha256(Buffer.from(stableJson({
    tenant_id: state.tenantId,
    user_id: state.userId,
  }), 'utf8'));
  const localizationDecisionSha256 = sha256(Buffer.from(stableJson(state.decision), 'utf8'));
  const context = {
    contract_version: CONTRACT_VERSION,
    owner_sha256: ownerSha256,
    work_id: 1,
    version_id: state.versionId,
    redraw_shot_id: state.shotRowId,
    shot_id: 'shot-6',
    batch_index: 1,
    shot_index: 6,
    voice_redraw_asset_id: state.voiceAssetId,
    source_character_key: 'rafael',
    visible_character_ids: ['mateo', 'rafael'],
    source_dialogue_sha256: sha256(Buffer.from('[]', 'utf8')),
    localized_dialogue_sha256: sha256(Buffer.from('[]', 'utf8')),
    localization_task_id: 'localization-task-1',
    localization_decision_sha256: localizationDecisionSha256,
    facts_hash: FACTS_HASH,
    policy_version: 7,
    target_locale: 'en-US',
    target_market: 'US',
    shot_updated_at: NOW,
    voice_updated_at: NOW,
  };
  const dialogueContextSha256 = sha256(Buffer.from(stableJson(context), 'utf8'));
  const evidence = {
    contract_version: CONTRACT_VERSION,
    approval_id: approvalId,
    status,
    dialogue_context_sha256: dialogueContextSha256,
    target_text_sha256: TARGET_TEXT_SHA256,
    source_translation: false,
    approval_source: 'owner_http',
    approval_decision: 'approved',
    approved_by_sha256: sha256(Buffer.from(stableJson({
      tenant_id: state.tenantId,
      user_id: state.userId,
      approved_by: state.userId,
    }), 'utf8')),
    approved_at: NOW,
  };
  return {
    localizationDecisionSha256,
    dialogueContextSha256,
    approvalEvidenceSha256: sha256(Buffer.from(stableJson(evidence), 'utf8')),
  };
}

test('owner/current version/stable shot/visible voice role creates a fixed private approval record', (t) => {
  const state = setup();
  t.after(() => state.db.close());

  const result = createSupplementalDialogueApproval(createInput(state));
  const expected = expectedHashes(state, result.approval.id);
  assert.equal(result.idempotentReplay, false);
  assert.equal(result.approval.contract_version, CONTRACT_VERSION);
  assert.equal(result.approval.target_text, 'Welcome home, son.');
  assert.equal(result.approval.target_text_sha256, TARGET_TEXT_SHA256);
  assert.equal(result.approval.source_translation, 0);
  assert.equal(result.approval.localization_decision_sha256, expected.localizationDecisionSha256);
  assert.equal(result.approval.dialogue_context_sha256, expected.dialogueContextSha256);
  assert.equal(result.approval.approval_evidence_sha256, expected.approvalEvidenceSha256);
  assert.equal(result.approval.shot_id, 'shot-6');
  assert.equal(result.approval.source_character_key, 'rafael');
  assert.equal(result.approval.approval_source, 'owner_http');
  assert.equal(result.approval.approval_decision, 'approved');
  assert.equal(result.approval.status, 'active');

  const publicResult = publicSupplementalDialogueApproval(state.db, result);
  assert.deepEqual(Object.keys(publicResult), [
    'approval_id',
    'contract_version',
    'version_id',
    'redraw_shot_id',
    'voice_redraw_asset_id',
    'status',
    'source_translation',
    'target_text_sha256',
    'approval_evidence_sha256',
    'approved_at',
    'updated_at',
    'idempotent_replay',
  ]);
  assert.equal(publicResult.source_translation, false);
  assert.equal(JSON.stringify(publicResult).includes('Welcome home'), false);
  assert.equal(JSON.stringify(publicResult).includes(state.tenantId), false);
  assert.equal(JSON.stringify(publicResult).includes(state.userId), false);
});

test('create is idempotent by owner/version key and rejects request or active-scope conflicts', (t) => {
  const state = setup();
  t.after(() => state.db.close());
  const first = createSupplementalDialogueApproval(createInput(state));
  const replay = createSupplementalDialogueApproval(createInput(state));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.approval.id, first.approval.id);
  assert.throws(
    () => createSupplementalDialogueApproval(createInput(state, { targetText: 'Different approved line.' })),
    expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_IDEMPOTENCY_CONFLICT'),
  );
  assert.throws(
    () => createSupplementalDialogueApproval(createInput(state, { idempotencyKey: 'second-approval' })),
    expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_ACTIVE_CONFLICT'),
  );
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_supplemental_dialogue_approvals').get().count, 1);
});

test('create rejects owner and scope mismatches without exposing private text', (t) => {
  const fields = [
    ['tenantId', 'tenant-other'],
    ['userId', 'user-other'],
    ['versionId', 999],
    ['shotRowId', 999],
    ['voiceAssetId', 999],
  ];
  for (const [field, value] of fields) {
    const state = setup();
    t.after(() => state.db.close());
    assert.throws(
      () => createSupplementalDialogueApproval(createInput(state, { [field]: value })),
      (error) => expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND')(error)
        && !error.message.includes('Welcome home'),
    );
  }
});

test('create fails closed for current-version, character visibility and voice-slot drift', (t) => {
  const cases = [
    ['draft version', { versionStatus: 'draft' }],
    ['non-current version', { workCurrentVersion: 2 }],
    ['missing stable shot id', { shotStableId: null }],
    ['character hidden in shot', { visibleCharacterIds: ['mateo'] }],
    ['voice role unknown', { voiceCharacterKey: 'unknown' }],
    ['voice kind changed', { voiceKind: 'character' }],
  ];
  for (const [name, overrides] of cases) {
    const state = setup(overrides);
    t.after(() => state.db.close());
    assert.throws(
      () => createSupplementalDialogueApproval(createInput(state)),
      (error) => ['REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND', 'REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY'].includes(error?.code),
      name,
    );
  }
});

test('create requires completed advance localization with exact facts, policy and decision binding', (t) => {
  const cases = [
    ['task incomplete', { taskStatus: 'processing' }],
    ['task result incomplete', { taskResultStatus: 'processing' }],
    ['decision blocked', { decision: { action: 'block' } }],
    ['facts drift', { versionFactsHash: 'c'.repeat(64) }],
    ['policy drift', { policyVersion: 8 }],
    ['decision evidence drift', { decision: { evidence_hash: 'd'.repeat(64) } }],
    ['decision version drift', { decision: { version_id: 999 } }],
  ];
  for (const [name, overrides] of cases) {
    const state = setup(overrides);
    t.after(() => state.db.close());
    assert.throws(
      () => createSupplementalDialogueApproval(createInput(state)),
      expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY'),
      name,
    );
  }
});

test('create validates explicit false, private text bounds, exact service input and both CAS values', (t) => {
  const invalidCases = [
    [{ sourceTranslation: true }, 'REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID'],
    [{ sourceTranslation: undefined }, 'REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID'],
    [{ targetText: '   ' }, 'REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID'],
    [{ targetText: 'x'.repeat(501) }, 'REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID'],
    [{ targetText: 'x\0private' }, 'REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID'],
    [{ expectedShotUpdatedAt: '2026-08-27T00:00:00.000Z' }, 'REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT'],
    [{ expectedVoiceUpdatedAt: '2026-08-27T00:00:00.000Z' }, 'REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT'],
    [{ unexpectedTextEcho: 'secret' }, 'REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID'],
  ];
  for (const [overrides, code] of invalidCases) {
    const state = setup();
    t.after(() => state.db.close());
    assert.throws(
      () => createSupplementalDialogueApproval(createInput(state, overrides)),
      (error) => expectCode(code)(error)
        && !error.message.includes(String(overrides.targetText || 'Welcome home')),
    );
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_supplemental_dialogue_approvals').get().count, 0);
  }
});

test('every persisted approval read recomputes private text, context and evidence hashes', (t) => {
  const cases = [
    ['create replay target text tamper', 'target_text', 'Tampered private line.', (state, created) => (
      createSupplementalDialogueApproval(createInput(state))
    )],
    ['revoke evidence tamper', 'approval_evidence_sha256', 'f'.repeat(64), (state, created) => (
      revokeSupplementalDialogueApproval({
        db: state.db,
        tenantId: state.tenantId,
        userId: state.userId,
        versionId: state.versionId,
        approvalId: created.approval.id,
        idempotencyKey: 'revoke-tampered',
        expectedUpdatedAt: NOW,
        now: () => REVOKED_AT,
      })
    )],
    ['public projection context tamper', 'dialogue_context_sha256', 'e'.repeat(64), (state, created) => (
      publicSupplementalDialogueApproval(state.db, {
        approval: state.db.prepare('SELECT * FROM redraw_supplemental_dialogue_approvals WHERE id = ?')
          .get(created.approval.id),
        idempotentReplay: false,
      })
    )],
  ];
  for (const [name, field, value, read] of cases) {
    const state = setup();
    t.after(() => state.db.close());
    const created = createSupplementalDialogueApproval(createInput(state));
    state.db.prepare(`UPDATE redraw_supplemental_dialogue_approvals SET ${field} = ? WHERE id = ?`)
      .run(value, created.approval.id);
    assert.throws(() => read(state, created), expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY'), name);
  }
});

test('persisted approval reads fail closed after facts, policy, localization, shot or voice context drift', (t) => {
  const cases = [
    ['facts', (state) => {
      state.db.exec('DROP TRIGGER redraw_versions_facts_immutable_update');
      const facts = structuredClone(state.sourceFacts);
      facts.facts_hash = 'c'.repeat(64);
      state.db.prepare('UPDATE redraw_versions SET source_facts_json = ?, facts_hash = ? WHERE id = ?')
        .run(JSON.stringify(facts), 'c'.repeat(64), state.versionId);
    }],
    ['policy', (state) => state.db.prepare('UPDATE redraw_projects SET policy_version = 8 WHERE id = 1').run()],
    ['localization', (state) => {
      const result = JSON.parse(state.db.prepare("SELECT result FROM async_tasks WHERE id = 'localization-task-1'").get().result);
      result.localization_decision.action = 'block';
      state.db.prepare("UPDATE async_tasks SET result = ? WHERE id = 'localization-task-1'").run(JSON.stringify(result));
    }],
    ['shot CAS', (state) => state.db.prepare('UPDATE redraw_shots SET updated_at = ? WHERE id = ?')
      .run('2026-08-28T00:01:00.000Z', state.shotRowId)],
    ['voice CAS', (state) => state.db.prepare('UPDATE redraw_assets SET updated_at = ? WHERE id = ?')
      .run('2026-08-28T00:01:00.000Z', state.voiceAssetId)],
  ];
  for (const [name, mutate] of cases) {
    const state = setup();
    t.after(() => state.db.close());
    const created = createSupplementalDialogueApproval(createInput(state));
    mutate(state);
    const row = state.db.prepare('SELECT * FROM redraw_supplemental_dialogue_approvals WHERE id = ?')
      .get(created.approval.id);
    assert.throws(
      () => createSupplementalDialogueApproval(createInput(state)),
      (error) => ['REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY', 'REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT']
        .includes(error?.code),
      `${name} create replay`,
    );
    assert.throws(
      () => revokeSupplementalDialogueApproval({
        db: state.db,
        tenantId: state.tenantId,
        userId: state.userId,
        versionId: state.versionId,
        approvalId: created.approval.id,
        idempotencyKey: `revoke-drift-${name}`,
        expectedUpdatedAt: NOW,
        now: () => REVOKED_AT,
      }),
      expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY'),
      `${name} revoke`,
    );
    assert.throws(
      () => publicSupplementalDialogueApproval(state.db, { approval: row, idempotentReplay: false }),
      expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY'),
      `${name} public projection`,
    );
    assert.equal(state.db.prepare('SELECT status FROM redraw_supplemental_dialogue_approvals WHERE id = ?')
      .get(created.approval.id).status, 'active');
  }
});

test('revoke is owner-scoped, CAS protected, replayable and preserves private audit history', (t) => {
  const state = setup();
  t.after(() => state.db.close());
  const created = createSupplementalDialogueApproval(createInput(state));
  const revoked = revokeSupplementalDialogueApproval({
    db: state.db,
    tenantId: state.tenantId,
    userId: state.userId,
    versionId: state.versionId,
    approvalId: created.approval.id,
    idempotencyKey: 'revoke-rafael-shot-6',
    expectedUpdatedAt: NOW,
    now: () => REVOKED_AT,
  });
  const expected = expectedHashes(state, created.approval.id, 'revoked');
  assert.equal(revoked.idempotentReplay, false);
  assert.equal(revoked.approval.status, 'revoked');
  assert.equal(revoked.approval.target_text, 'Welcome home, son.');
  assert.equal(revoked.approval.revoked_by, state.userId);
  assert.equal(revoked.approval.revoked_at, REVOKED_AT);
  assert.equal(revoked.approval.approval_evidence_sha256, expected.approvalEvidenceSha256);
  assert.equal(revoked.approval.deleted_at, null);

  const replay = revokeSupplementalDialogueApproval({
    db: state.db,
    tenantId: state.tenantId,
    userId: state.userId,
    versionId: state.versionId,
    approvalId: created.approval.id,
    idempotencyKey: 'revoke-rafael-shot-6',
    expectedUpdatedAt: NOW,
    now: () => '2026-08-28T00:06:00.000Z',
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.approval.updated_at, REVOKED_AT);
  const publicResult = publicSupplementalDialogueApproval(state.db, replay);
  assert.deepEqual(Object.keys(publicResult), [
    'approval_id',
    'contract_version',
    'version_id',
    'status',
    'target_text_sha256',
    'approval_evidence_sha256',
    'revoked_at',
    'updated_at',
    'idempotent_replay',
  ]);
  assert.equal(JSON.stringify(publicResult).includes('Welcome home'), false);

  assert.throws(() => revokeSupplementalDialogueApproval({
    db: state.db,
    tenantId: state.tenantId,
    userId: state.userId,
    versionId: state.versionId,
    approvalId: created.approval.id,
    idempotencyKey: 'different-revoke-key',
    expectedUpdatedAt: REVOKED_AT,
    now: () => REVOKED_AT,
  }), expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_IDEMPOTENCY_CONFLICT'));
  assert.throws(
    () => state.db.prepare("UPDATE redraw_supplemental_dialogue_approvals SET status = 'active' WHERE id = ?")
      .run(created.approval.id),
    /cannot reactivate/i,
  );
});

test('revoke rejects stale CAS and cross-owner lookup without changing the active row', (t) => {
  const stale = setup();
  t.after(() => stale.db.close());
  const created = createSupplementalDialogueApproval(createInput(stale));
  const input = {
    db: stale.db,
    tenantId: stale.tenantId,
    userId: stale.userId,
    versionId: stale.versionId,
    approvalId: created.approval.id,
    idempotencyKey: 'revoke-rafael-shot-6',
    expectedUpdatedAt: '2026-08-27T00:00:00.000Z',
    now: () => REVOKED_AT,
  };
  assert.throws(() => revokeSupplementalDialogueApproval(input), expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT'));
  assert.throws(
    () => revokeSupplementalDialogueApproval({ ...input, userId: 'user-other', expectedUpdatedAt: NOW }),
    expectCode('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND'),
  );
  assert.equal(stale.db.prepare('SELECT status FROM redraw_supplemental_dialogue_approvals WHERE id = ?')
    .get(created.approval.id).status, 'active');
});
