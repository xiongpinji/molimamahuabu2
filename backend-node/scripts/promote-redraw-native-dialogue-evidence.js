#!/usr/bin/env node
'use strict';

/**
 * 原生对白 evidence 提升工具（默认 dry-run，不写库）。
 * 真正写入需同时：
 *   --commit --confirm=PROMOTE_NATIVE_DIALOGUE_EVIDENCE --evidence=<path> --config-id=<id> [--db=<sqlite>]
 */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  CONFIRM_PROMOTE,
  parseArgs,
  dryRunPromote,
  commitPromoteLocaleCapabilities,
} = require('../src/services/redrawNativeDialogueOps');

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = dryRunPromote({
    evidencePath: args.values.evidence,
    confirm: args.values.confirm,
    commit: args.flags.has('commit'),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.mode === 'dry-run') {
    process.stderr.write(
      `promote dry-run only; require --commit --confirm=${CONFIRM_PROMOTE} --evidence=<file> --config-id=<id> after human review.\n`,
    );
    process.exitCode = report.ready ? 0 : 1;
    return report;
  }

  const configId = Number(args.values['config-id'] || args.values.configId);
  if (!Number.isSafeInteger(configId) || configId <= 0) {
    process.stderr.write('promote armed but missing --config-id; refuse write.\n');
    process.exitCode = 1;
    return report;
  }
  const dbPath = path.resolve(args.values.db || './data/drama_generator.db');
  const evidence = JSON.parse(fs.readFileSync(path.resolve(args.values.evidence), 'utf8'));
  const db = new Database(dbPath);
  try {
    const written = commitPromoteLocaleCapabilities(db, {
      configId,
      evidence,
      packId: args.values.pack || args.values['pack-id'],
      language: args.values.language,
    });
    process.stdout.write(`${JSON.stringify({ promote_write: written }, null, 2)}\n`);
    process.stderr.write('promote wrote settings.redraw_locale_capabilities; api keys not printed.\n');
    process.exitCode = 0;
    return { ...report, write: written };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
