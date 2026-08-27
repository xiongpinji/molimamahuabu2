#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { buildRemediationPlan } = require('../src/services/providerCanaryRemediationPlanService');
const runtimeFingerprintService = require('../src/services/providerRuntimeFingerprintService');

const HELP = `Usage:
  node scripts/plan-provider-canary-remediation.js --db <sqlite> [--output <json>]

Options:
  --db      Existing SQLite database opened read-only
  --output  Optional JSON destination; defaults to stdout
  --help    Show this help
`;

function argumentError() {
  const error = new Error('INVALID_ARGUMENTS');
  error.code = 'INVALID_ARGUMENTS';
  return error;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  let databasePath;
  let outputPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--db' && argument !== '--output') throw argumentError();
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw argumentError();
    if (argument === '--db') {
      if (databasePath) throw argumentError();
      databasePath = value;
    } else {
      if (outputPath) throw argumentError();
      outputPath = value;
    }
    index += 1;
  }
  if (!databasePath) throw argumentError();
  if (outputPath && path.resolve(databasePath) === path.resolve(outputPath)) throw argumentError();
  return { databasePath, outputPath, help: false };
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
  if (args.help) return { help: true };
  let db;
  try {
    db = new Database(args.databasePath, { readonly: true, fileMustExist: true });
    const report = buildRemediationPlan(db, {
      runtimeFingerprintResolver: (config) => runtimeFingerprintService.runtimeFingerprintForConfig(
        config,
        { repoRoot: path.resolve(__dirname, '..') },
      ),
    });
    if (args.outputPath) atomicWriteJson(args.outputPath, report);
    return { help: false, outputPath: args.outputPath, report };
  } finally {
    if (db) db.close();
  }
}

function safeFailure(error) {
  return {
    ok: false,
    error: {
      code: error?.code === 'INVALID_ARGUMENTS' ? 'INVALID_ARGUMENTS' : 'PLAN_FAILED',
      message: error?.code === 'INVALID_ARGUMENTS'
        ? '参数不完整、重复或无法识别'
        : '供应商修复规划失败',
    },
  };
}

if (require.main === module) {
  try {
    const result = run(process.argv.slice(2));
    if (result.help) process.stdout.write(HELP);
    else if (result.outputPath) {
      process.stdout.write(`${JSON.stringify({ ok: true, summary: result.report.summary })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    }
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
