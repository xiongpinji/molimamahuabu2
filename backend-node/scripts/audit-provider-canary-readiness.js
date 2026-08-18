#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const inventory = require('../src/services/providerCanaryInventoryService');
const runtimeFingerprintService = require('../src/services/providerRuntimeFingerprintService');

const HELP = `Usage:
  node scripts/audit-provider-canary-readiness.js --database <sqlite> --out <json> [--allow-blocked]

Options:
  --database       SQLite readiness source
  --out            JSON report destination
  --allow-blocked  Return exit code 0 even when blockers exist
  --help           Show this help
`;

function argumentError() {
  const error = new Error('参数不完整、重复或无法识别');
  error.code = 'INVALID_ARGUMENTS';
  return error;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  let databasePath;
  let outputPath;
  let allowBlocked = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database' || argument === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw argumentError();
      if (argument === '--database') {
        if (databasePath) throw argumentError();
        databasePath = value;
      } else {
        if (outputPath) throw argumentError();
        outputPath = value;
      }
      index += 1;
    } else if (argument === '--allow-blocked') {
      if (allowBlocked) throw argumentError();
      allowBlocked = true;
    } else {
      throw argumentError();
    }
  }
  if (!databasePath || !outputPath || path.resolve(databasePath) === path.resolve(outputPath)) {
    throw argumentError();
  }
  return { databasePath, outputPath, allowBlocked, help: false };
}

function atomicWriteJson(outputPath, value) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `${path.basename(resolved)}.tmp-${process.pid}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, resolved);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function run(argv) {
  const args = parseArguments(argv);
  if (args.help) return { help: true, exitCode: 0 };
  let db;
  try {
    db = new Database(args.databasePath, { readonly: true, fileMustExist: true });
    const report = inventory.buildCanaryReadiness(db, {
      runtimeFingerprintResolver: (config) => runtimeFingerprintService.runtimeFingerprintForConfig(
        config,
        { repoRoot: path.resolve(__dirname, '..') },
      ),
    });
    atomicWriteJson(args.outputPath, report);
    return {
      help: false,
      exitCode: report.summary.blocked_routes > 0 && !args.allowBlocked ? 2 : 0,
      report,
    };
  } finally {
    if (db) db.close();
  }
}

function safeFailure(error) {
  return {
    ok: false,
    error: {
      code: error?.code === 'INVALID_ARGUMENTS' ? 'INVALID_ARGUMENTS' : 'AUDIT_FAILED',
      message: error?.code === 'INVALID_ARGUMENTS'
        ? '参数不完整、重复或无法识别'
        : '巡检准备度审计失败',
    },
  };
}

if (require.main === module) {
  try {
    const result = run(process.argv.slice(2));
    if (result.help) {
      process.stdout.write(HELP);
    } else {
      process.stdout.write(`${JSON.stringify({ ok: true, summary: result.report.summary })}\n`);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  atomicWriteJson,
  parseArguments,
  run,
};
