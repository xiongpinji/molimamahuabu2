const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  normalizeProjectPolicy,
  projectPolicySnapshot,
  updateProjectPolicy,
} = require('../src/services/redrawProjectPolicyService');
const {
  appendWorkflowEvent,
  listProjectWorkflowEvents,
} = require('../src/services/redrawWorkflowEventService');

const NOW = '2026-08-06T00:00:00.000Z';

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function insertProject(db, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, default_locale, default_market, localization_level,
       status, execution_mode, budget_limit_credits, max_auto_attempts_per_shot,
       policy_version, created_at, updated_at, deleted_at)
    VALUES
      (@tenant_id, @user_id, @title, @default_locale, @default_market, @localization_level,
       @status, @execution_mode, @budget_limit_credits, @max_auto_attempts_per_shot,
       @policy_version, @created_at, @updated_at, @deleted_at)
  `).run({
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    title: '转绘项目',
    default_locale: 'en-US',
    default_market: 'US',
    localization_level: 'faithful',
    status: 'draft',
    execution_mode: 'safe',
    budget_limit_credits: null,
    max_auto_attempts_per_shot: null,
    policy_version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

test('auto 项目必须同时提供预算和自动尝试上限', () => {
  assert.throws(
    () => normalizeProjectPolicy({ execution_mode: 'auto', budget_limit_credits: 100 }),
    (error) => error.code === 'REDRAW_PROJECT_POLICY_INCOMPLETE',
  );
  assert.deepEqual(normalizeProjectPolicy({
    execution_mode: 'auto',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 2,
  }), {
    execution_mode: 'auto',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 2,
  });
});

test('策略输入严格拒绝未知字段和非法数值', () => {
  const badInputs = [
    [{ execution_mode: 'manual' }, 'REDRAW_PROJECT_POLICY_INVALID'],
    [{ execution_mode: 'safe', unknown: true }, 'REDRAW_PROJECT_POLICY_UNKNOWN_FIELD'],
    [{ execution_mode: 'safe', default_market: 'CN' }, 'REDRAW_PROJECT_POLICY_UNKNOWN_FIELD'],
    [{ execution_mode: 'safe', default_locale: 'zh-CN' }, 'REDRAW_PROJECT_POLICY_UNKNOWN_FIELD'],
    [{ execution_mode: 'safe', spent_credits: 1 }, 'REDRAW_PROJECT_POLICY_UNKNOWN_FIELD'],
    [{ execution_mode: 'safe', reservation_id: 'client-reservation' }, 'REDRAW_PROJECT_POLICY_UNKNOWN_FIELD'],
    [{ execution_mode: 'safe', budget_limit_credits: -1 }, 'REDRAW_PROJECT_POLICY_INVALID'],
    [{ execution_mode: 'safe', budget_limit_credits: 1.5 }, 'REDRAW_PROJECT_POLICY_INVALID'],
    [{ execution_mode: 'auto', budget_limit_credits: 100, max_auto_attempts_per_shot: 0 }, 'REDRAW_PROJECT_POLICY_INVALID'],
    [{ execution_mode: 'auto', budget_limit_credits: 100, max_auto_attempts_per_shot: 1.5 }, 'REDRAW_PROJECT_POLICY_INVALID'],
    [{ execution_mode: 'auto', budget_limit_credits: 100, max_auto_attempts_per_shot: 6 }, 'REDRAW_PROJECT_POLICY_INVALID'],
  ];
  for (const [input, code] of badInputs) {
    assert.throws(() => normalizeProjectPolicy(input), (error) => error.code === code, JSON.stringify(input));
  }
  assert.deepEqual(normalizeProjectPolicy({ execution_mode: 'safe' }), {
    execution_mode: 'safe',
    budget_limit_credits: null,
    max_auto_attempts_per_shot: null,
  });
  assert.deepEqual(normalizeProjectPolicy({
    execution_mode: 'safe',
    budget_limit_credits: 10,
    max_auto_attempts_per_shot: 1,
  }), {
    execution_mode: 'safe',
    budget_limit_credits: 10,
    max_auto_attempts_per_shot: 1,
  });
});

test('策略输入只接受 own property 且拒绝原型污染键', () => {
  const inheritedSafe = Object.create({ execution_mode: 'safe' });
  assert.throws(
    () => normalizeProjectPolicy(inheritedSafe),
    (error) => error.code === 'REDRAW_PROJECT_POLICY_INVALID',
  );

  const inheritedAuto = Object.create({
    execution_mode: 'auto',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 2,
  });
  assert.throws(
    () => normalizeProjectPolicy(inheritedAuto),
    (error) => error.code === 'REDRAW_PROJECT_POLICY_INVALID',
  );

  const literalProto = { __proto__: { execution_mode: 'safe' } };
  assert.throws(
    () => normalizeProjectPolicy(literalProto),
    (error) => error.code === 'REDRAW_PROJECT_POLICY_INVALID',
  );

  const jsonProto = JSON.parse('{"__proto__":{"execution_mode":"safe"},"execution_mode":"safe"}');
  assert.throws(
    () => normalizeProjectPolicy(jsonProto),
    (error) => error.code === 'REDRAW_PROJECT_POLICY_INVALID',
  );

  const nullPrototype = Object.assign(Object.create(null), { execution_mode: 'safe' });
  assert.deepEqual(normalizeProjectPolicy(nullPrototype), {
    execution_mode: 'safe',
    budget_limit_credits: null,
    max_auto_attempts_per_shot: null,
  });
});

test('策略更新使用 owner 与 updated_at CAS 且不改写目标国家语言', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const before = db.prepare(`
      SELECT default_market, default_locale, updated_at
      FROM redraw_projects WHERE id = ?
    `).get(projectId);
    const updated = updateProjectPolicy(db, {
      tenantId: 'tenant-a',
      userId: 'user-a',
      projectId,
      expectedUpdatedAt: before.updated_at,
      input: {
        execution_mode: 'auto',
        budget_limit_credits: 100,
        max_auto_attempts_per_shot: 2,
      },
      now: () => '2026-08-06T00:00:01.000Z',
    });

    assert.deepEqual(updated, {
      execution_mode: 'auto',
      budget_limit_credits: 100,
      max_auto_attempts_per_shot: 2,
      policy_version: 2,
      updated_at: '2026-08-06T00:00:01.000Z',
    });
    assert.deepEqual(db.prepare(`
      SELECT default_market, default_locale FROM redraw_projects WHERE id = ?
    `).get(projectId), {
      default_market: 'US',
      default_locale: 'en-US',
    });
    assert.deepEqual(projectPolicySnapshot(db.prepare('SELECT * FROM redraw_projects WHERE id = ?').get(projectId)), updated);
  } finally {
    db.close();
  }
});

test('策略更新在 now 未推进时仍生成单调 updated_at 并阻止旧 token 重放', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const updated = updateProjectPolicy(db, {
      tenantId: 'tenant-a',
      userId: 'user-a',
      projectId,
      expectedUpdatedAt: NOW,
      input: {
        execution_mode: 'auto',
        budget_limit_credits: 100,
        max_auto_attempts_per_shot: 2,
      },
      now: () => NOW,
    });
    assert.notEqual(updated.updated_at, NOW);
    assert.ok(new Date(updated.updated_at).getTime() > new Date(NOW).getTime());
    assert.equal(updated.policy_version, 2);

    assert.throws(
      () => updateProjectPolicy(db, {
        tenantId: 'tenant-a',
        userId: 'user-a',
        projectId,
        expectedUpdatedAt: NOW,
        input: { execution_mode: 'safe' },
        now: () => NOW,
      }),
      (error) => error.code === 'REDRAW_PROJECT_POLICY_CONFLICT',
    );
    assert.deepEqual(projectPolicySnapshot(db.prepare('SELECT * FROM redraw_projects WHERE id = ?').get(projectId)), updated);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_workflow_events').get().count, 1);
  } finally {
    db.close();
  }
});

test('策略更新对跨 owner 统一 404，CAS 冲突 409 且零部分写入', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const before = db.prepare('SELECT * FROM redraw_projects WHERE id = ?').get(projectId);
    assert.throws(
      () => updateProjectPolicy(db, {
        tenantId: 'tenant-b',
        userId: 'user-a',
        projectId,
        expectedUpdatedAt: before.updated_at,
        input: { execution_mode: 'safe' },
      }),
      (error) => error.code === 'REDRAW_PROJECT_NOT_FOUND',
    );
    assert.throws(
      () => updateProjectPolicy(db, {
        tenantId: 'tenant-a',
        userId: 'user-a',
        projectId,
        expectedUpdatedAt: '2026-08-05T00:00:00.000Z',
        input: {
          execution_mode: 'auto',
          budget_limit_credits: 100,
          max_auto_attempts_per_shot: 2,
        },
      }),
      (error) => error.code === 'REDRAW_PROJECT_POLICY_CONFLICT',
    );
    const after = db.prepare('SELECT * FROM redraw_projects WHERE id = ?').get(projectId);
    assert.equal(after.execution_mode, before.execution_mode);
    assert.equal(after.budget_limit_credits, before.budget_limit_credits);
    assert.equal(after.max_auto_attempts_per_shot, before.max_auto_attempts_per_shot);
    assert.equal(after.policy_version, before.policy_version);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_workflow_events').get().count, 0);
  } finally {
    db.close();
  }
});

test('策略成功更新在同一事务追加脱敏 workflow event', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    updateProjectPolicy(db, {
      tenantId: 'tenant-a',
      userId: 'user-a',
      projectId,
      expectedUpdatedAt: NOW,
      input: {
        execution_mode: 'auto',
        budget_limit_credits: 100,
        max_auto_attempts_per_shot: 2,
      },
      now: () => '2026-08-06T00:00:01.000Z',
    });
    const events = listProjectWorkflowEvents(db, {
      tenantId: 'tenant-a',
      userId: 'user-a',
      projectId,
    });
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0]), [
      'id',
      'project_id',
      'resource_type',
      'resource_id',
      'from_state',
      'to_state',
      'reason_code',
      'evidence_hash',
      'created_at',
    ]);
    assert.equal(events[0].resource_type, 'project');
    assert.equal(events[0].reason_code, 'project_policy_updated');
    assert.match(events[0].evidence_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(events[0]).includes('metadata_json'), false);
  } finally {
    db.close();
  }
});

test('workflow event 服务拒绝敏感 metadata、危险 reason 和非法 evidence', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const badInputs = [
      { resourceType: 'file', reasonCode: 'project_policy_updated', evidenceHash: null, metadata: {} },
      { resourceType: 'project', reasonCode: 'Bad Reason', evidenceHash: null, metadata: {} },
      { resourceType: 'project', reasonCode: 'project_policy_updated', evidenceHash: 'sha256:abc', metadata: {} },
      { resourceType: 'project', reasonCode: 'project_policy_updated', evidenceHash: null, metadata: { apiKey: 'secret' } },
      { resourceType: 'project', reasonCode: 'project_policy_updated', evidenceHash: null, metadata: { callback_url: 'https://provider.example/response' } },
      { resourceType: 'project', reasonCode: 'project_policy_updated', evidenceHash: null, metadata: { path: 'C:\\private\\file.json' } },
    ];
    const circular = {};
    circular.self = circular;
    badInputs.push({ resourceType: 'project', reasonCode: 'project_policy_updated', evidenceHash: null, metadata: circular });

    for (const input of badInputs) {
      assert.throws(() => appendWorkflowEvent(db, {
        tenantId: 'tenant-a',
        userId: 'user-a',
        projectId,
        resourceId: String(projectId),
        fromState: 'safe',
        toState: 'auto',
        createdAt: NOW,
        ...input,
      }), (error) => error.code === 'REDRAW_WORKFLOW_EVENT_INVALID');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_workflow_events').get().count, 0);
  } finally {
    db.close();
  }
});

test('workflow event metadata 仅接受安全 JSON 数据模型并规范化检查敏感内容', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const customPrototype = Object.create({ inherited: true });
    customPrototype.safe = 'value';
    const badMetadata = [
      { 'apiＫey': 'secret' },
      { link: 'https:\u200b//provider.example/task' },
      { blob: Buffer.from('apiKey=secret https://provider.example/task') },
      { blob: new ArrayBuffer(8) },
      { blob: new Uint8Array([1, 2, 3]) },
      { when: new Date(NOW) },
      { map: new Map([['safe', 'value']]) },
      { set: new Set(['safe']) },
      { fn: () => 'nope' },
      { sym: Symbol('nope') },
      { big: 1n },
      { value: Number.NaN },
      { value: Infinity },
      customPrototype,
      { raw: 'ordinary provider text' },
      { raw_response: 'ordinary provider text' },
      { response_body: 'ordinary provider text' },
      { provider_response: 'ordinary provider text' },
      { auth: 'ordinary' },
      { auth_token: 'ordinary' },
      { auth_header: 'ordinary' },
      { authorization: 'ordinary' },
      { authorization_header: 'ordinary' },
      { bearer: 'ordinary' },
      { note: 'provider\u200b response body' },
      { file: '/var/tmp/provider.json' },
      { file: 'C:\\private\\provider.json' },
      { file: '\\\\server\\share\\provider.json' },
    ];
    const circular = {};
    circular.self = circular;
    badMetadata.push(circular);

    for (const metadata of badMetadata) {
      assert.throws(() => appendWorkflowEvent(db, {
        tenantId: 'tenant-a',
        userId: 'user-a',
        projectId,
        resourceType: 'project',
        resourceId: String(projectId),
        fromState: 'safe',
        toState: 'auto',
        reasonCode: 'project_policy_updated',
        evidenceHash: null,
        metadata,
        createdAt: NOW,
      }), (error) => error.code === 'REDRAW_WORKFLOW_EVENT_INVALID');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_workflow_events').get().count, 0);

    assert.doesNotThrow(() => appendWorkflowEvent(db, {
      tenantId: 'tenant-a',
      userId: 'user-a',
      projectId,
      resourceType: 'project',
      resourceId: String(projectId),
      fromState: 'safe',
      toState: 'auto',
      reasonCode: 'project_policy_updated',
      evidenceHash: null,
      metadata: Object.assign(Object.create(null), {
        label: 'ordinary relative metadata',
        author: 'ordinary person',
        authority: 'ordinary unit',
        reference: 'redraw-assets/candidate.json',
        nested: [{ count: 1, ok: true, empty: null }],
      }),
      createdAt: NOW,
    }));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_workflow_events').get().count, 1);
  } finally {
    db.close();
  }
});
