const path = require('path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');
const { runProductionPreflight } = require('../src/services/productionPreflightService');

const config = loadConfig();
const dbPath = path.resolve(process.cwd(), config.database?.path || '');
let db;

try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const report = runProductionPreflight({ config, env: process.env, db });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ready ? 0 : 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ready: false,
    error: error.code || 'PREPRODUCTION_CHECK_FAILED',
    message: error.message,
  }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  db?.close();
}
