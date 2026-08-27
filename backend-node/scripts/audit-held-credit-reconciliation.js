#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const dryRun = require('../src/services/billingReconciliationDryRunService');

const HELP = `Usage:
  node scripts/audit-held-credit-reconciliation.js --db <sqlite>
    [--older-than-minutes <minutes>] [--limit <count>] [--now <iso>]
    [--output <json>]
`;

function argumentError() {
  const error = new Error('参数不完整、重复或无法识别');
  error.code = 'INVALID_ARGUMENTS';
  return error;
}

function parseInteger(value, min, max) {
  if (!/^\d+$/.test(String(value || ''))) throw argumentError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw argumentError();
  return parsed;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const values = {};
  const allowed = new Set(['--db', '--older-than-minutes', '--limit', '--now', '--output']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument) || Object.hasOwn(values, argument)) throw argumentError();
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw argumentError();
    values[argument] = value;
    index += 1;
  }
  if (!values['--db']) throw argumentError();
  const now = values['--now'];
  if (now && Number.isNaN(new Date(now).getTime())) throw argumentError();
  const databasePath = path.resolve(values['--db']);
  const outputPath = values['--output'] ? path.resolve(values['--output']) : null;
  if (outputPath && outputPath === databasePath) throw argumentError();
  return {
    help: false,
    databasePath,
    outputPath,
    olderThanMinutes: values['--older-than-minutes']
      ? parseInteger(values['--older-than-minutes'], 5, 10080)
      : 60,
    limit: values['--limit'] ? parseInteger(values['--limit'], 1, 500) : 100,
    now,
  };
}

function atomicWriteJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = path.join(path.dirname(outputPath), `${path.basename(outputPath)}.tmp-${process.pid}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, outputPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
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
    const report = dryRun.buildDryRunReport(db, {
      olderThanMinutes: args.olderThanMinutes,
      limit: args.limit,
      now: args.now,
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
      code: error?.code === 'INVALID_ARGUMENTS' ? 'INVALID_ARGUMENTS' : 'AUDIT_FAILED',
      message: error?.code === 'INVALID_ARGUMENTS'
        ? '参数不完整、重复或无法识别'
        : '冻结积分只读对账失败',
    },
  };
}

if (require.main === module) {
  try {
    const result = run(process.argv.slice(2));
    if (result.help) {
      process.stdout.write(HELP);
    } else if (result.outputPath) {
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
