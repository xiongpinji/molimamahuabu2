#!/usr/bin/env node
'use strict';

/**
 * 原生对白 canary 门禁（默认 dry-run，零网络/零写入）。
 * 真机提交需显式：
 *   node scripts/verify-redraw-native-dialogue-audio.js --confirm=RUN_NATIVE_DIALOGUE_CANARY ...
 */
const {
  CONFIRM_CANARY,
  parseArgs,
  dryRunCanary,
} = require('../src/services/redrawNativeDialogueOps');

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = dryRunCanary({
    confirm: args.values.confirm,
    model: args.values.model,
    packId: args.values.pack || args.values['pack-id'],
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.mode === 'dry-run') {
    process.stderr.write(
      `native dialogue canary dry-run only; pass --confirm=${CONFIRM_CANARY} to arm (still no auto-submit).\n`,
    );
    process.exitCode = 0;
    return report;
  }
  process.stderr.write(
    'canary armed: use isolated storage/DB and a single ToAPIs submit with generate_audio=true; do not retry on unknown.\n',
  );
  process.exitCode = 0;
  return report;
}

if (require.main === module) {
  main();
}

module.exports = { main };
