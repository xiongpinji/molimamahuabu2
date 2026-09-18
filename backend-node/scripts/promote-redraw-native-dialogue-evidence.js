#!/usr/bin/env node
'use strict';

/**
 * 原生对白 evidence 提升工具（默认 dry-run，不写库）。
 * 真正写入需同时：
 *   --commit --confirm=PROMOTE_NATIVE_DIALOGUE_EVIDENCE --evidence=<path>
 */
const {
  CONFIRM_PROMOTE,
  parseArgs,
  dryRunPromote,
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
      `promote dry-run only; require --commit --confirm=${CONFIRM_PROMOTE} --evidence=<file> after human review.\n`,
    );
    process.exitCode = report.ready ? 0 : 1;
    return report;
  }
  process.stderr.write(
    'promote armed: write only settings.redraw_locale_capabilities inside a backup+transaction; never print api keys.\n',
  );
  process.exitCode = 0;
  return report;
}

if (require.main === module) {
  main();
}

module.exports = { main };
