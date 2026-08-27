const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const reconciliation = require('../src/services/billingReconciliationService');
const dryRun = require('../src/services/billingReconciliationDryRunService');

const NOW = '2026-08-27T12:00:00.000Z';
const OLD = '2026-08-27T09:00:00.000Z';
const SECRET_ERROR = 'SECRET-UPSTREAM-ERROR-9917';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-reconciliation-dry-run-'));
  const databasePath = path.join(directory, 'billing.sqlite');
  const db = new Database(databasePath);
  credits.ensureSchema(db);
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      message TEXT,
      error TEXT,
      provider_task_id TEXT,
      credit_reservation_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY,
      status TEXT,
      error_msg TEXT,
      credit_reservation_id TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY,
      status TEXT,
      error_msg TEXT,
      provider_task_id TEXT,
      credit_reservation_id TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE generation_route_requests (
      id TEXT PRIMARY KEY,
      service_type TEXT,
      state TEXT,
      credit_reservation_id TEXT,
      updated_at TEXT
    );
    CREATE TABLE generation_route_attempts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      state TEXT,
      provider_task_id TEXT
    );
  `);
  credits.setAccountBalance(db, 'dry-run-user', 1000);
  credits.setTenantAccountBalance(db, 'dry-run-tenant', 1000);

  function reserve(operationKey, amount, options = {}) {
    const reservation = credits.reserve(db, {
      userId: options.tenant ? undefined : 'dry-run-user',
      tenantId: options.tenant ? 'dry-run-tenant' : undefined,
      actorUserId: options.tenant ? 'dry-run-user' : undefined,
      operationKey,
      amount,
      model: options.model || 'test-model',
      resourceType: options.resourceType || 'image',
      resourceId: `${operationKey}-resource`,
    });
    const table = options.tenant ? 'tenant_usage_reservations' : 'usage_reservations';
    db.prepare(`UPDATE ${table} SET created_at = ?, updated_at = ? WHERE id = ?`)
      .run(OLD, OLD, reservation.id);
    return reservation;
  }

  function linkTask(reservation, status, error = '') {
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, message, error, credit_reservation_id,
        created_at, updated_at, completed_at, deleted_at)
      VALUES (?, 'generation', ?, '', ?, ?, ?, ?, ?, NULL)`)
      .run(
        `task-${reservation.operation_key}`,
        status,
        error,
        reservation.id,
        OLD,
        OLD,
        ['failed', 'completed'].includes(status) ? OLD : null,
      );
  }

  const safe = reserve('safe-failure', 10);
  linkTask(safe, 'failed', `供应商明确拒绝 ${SECRET_ERROR}`);

  const needsAttention = reserve('needs-attention', 20, { tenant: true });
  db.prepare(`INSERT INTO generation_route_requests
    (id, service_type, state, credit_reservation_id, updated_at)
    VALUES ('route-needs-attention', 'image', 'needs_attention', ?, ?)`)
    .run(needsAttention.id, OLD);

  const running = reserve('running', 30);
  linkTask(running, 'processing');

  const completed = reserve('completed', 40);
  linkTask(completed, 'completed');

  reserve('missing-evidence', 50);

  const providerTask = reserve('provider-task-failure', 60, { resourceType: 'video' });
  db.prepare(`INSERT INTO video_generations
    (id, status, error_msg, provider_task_id, credit_reservation_id, updated_at, deleted_at)
    VALUES (1, 'failed', ?, 'provider-task-001', ?, ?, NULL)`)
    .run(`provider failed ${SECRET_ERROR}`, providerTask.id, OLD);

  const unknown = reserve('submission-unknown', 70);
  linkTask(unknown, 'submission_unknown', SECRET_ERROR);

  db.close();
  return { directory, databasePath };
}

function removeFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

test('只读扫描和 dry-run 报告固定四类建议，未知状态及供应商任务号永不建议退款', (t) => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  const beforeHash = sha256(fixture.databasePath);
  const db = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });

  const rows = reconciliation.listAnomaliesReadOnly(db, {
    olderThanMinutes: 60,
    now: NOW,
  });
  const report = dryRun.buildDryRunReport(db, {
    olderThanMinutes: 60,
    now: NOW,
  });
  const eventTable = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'billing_reconciliation_events'`).get();
  db.close();

  assert.equal(rows.length, 7);
  assert.equal(eventTable, undefined);
  assert.equal(sha256(fixture.databasePath), beforeHash);
  assert.deepEqual(report.summary, {
    total_records: 7,
    total_credits: 280,
    categories: {
      safe_refund_candidate: { records: 1, credits: 10 },
      hold_for_provider_review: { records: 3, credits: 150 },
      missing_terminal_evidence: { records: 1, credits: 50 },
      completed_or_running_do_not_touch: { records: 2, credits: 70 },
    },
  });

  const byResource = Object.fromEntries(report.items.map((item) => [item.resource_id, item]));
  const rawProviderTask = rows.find((row) => row.resource_id === 'provider-task-failure-resource');
  assert.equal(rawProviderTask.refundable, true);
  assert.equal(rawProviderTask.safety_status, 'definite_failure');
  assert.equal(byResource['safe-failure-resource'].recommendation, 'safe_refund_candidate');
  assert.equal(byResource['safe-failure-resource'].refundable, true);
  assert.equal(byResource['needs-attention-resource'].scope, 'tenant');
  assert.equal(byResource['needs-attention-resource'].recommendation, 'hold_for_provider_review');
  assert.equal(byResource['provider-task-failure-resource'].evidence.video_generations.has_provider_task_id, true);
  assert.equal(byResource['provider-task-failure-resource'].refundable, false);
  assert.equal(byResource['provider-task-failure-resource'].recommendation, 'hold_for_provider_review');
  assert.equal(byResource['submission-unknown-resource'].recommendation, 'hold_for_provider_review');
  assert.equal(byResource['missing-evidence-resource'].recommendation, 'missing_terminal_evidence');
  assert.equal(byResource['running-resource'].recommendation, 'completed_or_running_do_not_touch');
  assert.equal(byResource['completed-resource'].recommendation, 'completed_or_running_do_not_touch');
  assert.equal(JSON.stringify(report).includes(SECRET_ERROR), false);
});

test('CLI 只读打开数据库并原子写出脱敏报告，不改变数据库哈希或 mtime', (t) => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  const outputPath = path.join(fixture.directory, 'report.json');
  const scriptPath = path.resolve(__dirname, '../scripts/audit-held-credit-reconciliation.js');
  const beforeHash = sha256(fixture.databasePath);
  const beforeMtime = fs.statSync(fixture.databasePath, { bigint: true }).mtimeNs;

  const result = spawnSync(process.execPath, [
    scriptPath,
    '--db', fixture.databasePath,
    '--older-than-minutes', '60',
    '--limit', '100',
    '--now', NOW,
    '--output', outputPath,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(sha256(fixture.databasePath), beforeHash);
  assert.equal(fs.statSync(fixture.databasePath, { bigint: true }).mtimeNs, beforeMtime);
  const reportText = fs.readFileSync(outputPath, 'utf8');
  assert.equal(reportText.includes(SECRET_ERROR), false);
  assert.equal(result.stdout.includes(SECRET_ERROR), false);
  assert.equal(JSON.parse(reportText).summary.total_records, 7);
});

test('缺少账本或关联业务表时只读扫描显式失败且不补建 schema', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-dry-run-schema-drift-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'drift.sqlite');
  new Database(databasePath).close();
  const beforeHash = sha256(databasePath);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });

  assert.throws(() => dryRun.buildDryRunReport(db, {
    olderThanMinutes: 60,
    now: NOW,
  }), (error) => error.code === 'RECONCILIATION_READONLY_SCHEMA_MISMATCH');
  db.close();
  assert.equal(sha256(databasePath), beforeHash);
});

test('供应商路由证据表或任务号列缺失时 dry-run 必须失败关闭', (t) => {
  const mutations = [
    'DROP TABLE generation_route_attempts',
    `CREATE TABLE async_tasks_rebuilt AS
      SELECT id, type, status, message, error, credit_reservation_id,
        created_at, updated_at, completed_at, deleted_at
      FROM async_tasks;
     DROP TABLE async_tasks;
     ALTER TABLE async_tasks_rebuilt RENAME TO async_tasks`,
  ];

  for (const mutation of mutations) {
    const fixture = createFixture();
    t.after(() => removeFixture(fixture));
    const writable = new Database(fixture.databasePath);
    writable.exec(mutation);
    writable.close();
    const beforeHash = sha256(fixture.databasePath);
    const db = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });

    assert.throws(() => dryRun.buildDryRunReport(db, {
      olderThanMinutes: 60,
      now: NOW,
    }), (error) => error.code === 'RECONCILIATION_READONLY_SCHEMA_MISMATCH');
    db.close();
    assert.equal(sha256(fixture.databasePath), beforeHash);
  }
});
