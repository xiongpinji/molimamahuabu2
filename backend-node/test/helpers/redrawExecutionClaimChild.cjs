'use strict';

// Local concurrency worker only. The caller supplies a newly created fixture database
// and absolute local media binaries; this file never runs migrations or the app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const Database = require('better-sqlite3');
const service = require('../../src/services/redrawExecutionRunService');
const payload = JSON.parse(process.argv[2]);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
assert.ok(path.isAbsolute(payload.databaseFile) && path.isAbsolute(payload.storageRoot));
assert.ok(path.resolve(payload.databaseFile).startsWith(path.resolve(payload.storageRoot) + path.sep));
assert.ok(path.resolve(payload.storageRoot).startsWith(path.resolve(os.tmpdir(), '..') + path.sep));
for (const name of ['FFMPEG_PATH', 'FFPROBE_PATH']) {
  assert.ok(path.isAbsolute(process.env[name]) && fs.statSync(process.env[name]).isFile());
}
assert.equal(process.env.PATH, '');
const guards = [];
for (const [name, methods, kind] of [
  ['../../src/config/index.js', ['loadConfig'], 'DEFAULT_CONFIG'],
  ['../../src/db/index.js', ['getDb', 'closeDb'], 'DEFAULT_DATABASE'],
]) {
  const cached = require.cache[require.resolve(name)];
  assert.ok(cached?.loaded, 'defaults must already be guarded, never imported');
  for (const method of methods) guards.push([cached.exports[method], kind]);
}
guards.push([global.fetch, 'NETWORK']);
for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get']) guards.push([require(name)[method], 'NETWORK']);
for (const name of ['node:net', 'node:tls']) for (const method of ['connect', 'createConnection']) {
  if (require(name)[method]) guards.push([require(name)[method], 'NETWORK']);
}
for (const [fn, kind] of guards) {
  assert.match(fn.toString(), /REDRAW_EXECUTION_TEST_FORBIDS_/);
  assert.throws(() => fn(), { message: 'REDRAW_EXECUTION_TEST_FORBIDS_' + kind });
}
const db = new Database(payload.databaseFile, { fileMustExist: true, timeout: 15000 });
db.pragma('foreign_keys = ON');
let announced = false, probes = 0;
const guardedDb = new Proxy(db, { get(target, key) {
  if (key === 'transaction') return callback => {
    const transaction = target.transaction(callback), immediate = transaction.immediate;
    assert.equal(Object.getOwnPropertyDescriptor(transaction, 'immediate').writable, false);
    const wrapped = Object.assign((...args) => transaction(...args), {
      default: transaction.default, deferred: transaction.deferred, exclusive: transaction.exclusive, database: target,
    });
    wrapped.immediate = (...args) => {
      if (!announced) {
        announced = true;
        // Both workers reach this point after their asynchronous media checks while
        // the parent holds a separate real WAL writer. Prove actual lock contention.
        target.pragma('busy_timeout = 0');
        let contention;
        try { target.exec('BEGIN IMMEDIATE'); target.exec('ROLLBACK'); }
        catch (error) { contention = error.code; }
        finally { target.pragma('busy_timeout = 15000'); }
        assert.equal(contention, 'SQLITE_BUSY');
        emit({ type: 'claim_transaction_waiting', contention, probes,
          initial_attempts: target.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts WHERE run_id=?').get(payload.runId).n });
      }
      return immediate(...args);
    };
    return wrapped;
  };
  const value = target[key];
  return typeof value === 'function' ? value.bind(target) : value;
} });
const ctx = { db: guardedDb, tenantId: 'tenant-a', userId: 'user-a', storageRoot: payload.storageRoot,
  tempRoot: process.cwd(), env: {}, log: {}, execFile: (binary, args, options, callback) => {
    assert.equal(binary, process.env.FFPROBE_PATH, 'claim inspection cannot encode'); probes += 1;
    return execFile(binary, args, options, callback);
  }, canReadArtifact: id => {
    const row = db.prepare('SELECT local_path FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(id));
    return Boolean(row && fs.existsSync(path.join(payload.storageRoot, row.local_path)));
  } };
emit({ type: 'started', guard_count: guards.length, node: process.execPath,
  environment_names: Object.keys(process.env).sort(), databaseFile: payload.databaseFile });
service.claimNextUnit(ctx, payload.versionId, payload.runId, payload.input).then(result => {
  emit({ type: 'result', result });
}, error => {
  emit({ type: 'failure', code: error.code || error.name });
  process.exitCode = 1;
}).finally(() => db.close());
