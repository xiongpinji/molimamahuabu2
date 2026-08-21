const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.resolve(__dirname, '../../deploy/storage-archive-guard/moli-drama-release-archive');

test('release archiver checks the shared deployment lock and both public services', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /\$\{MOLI_ROOT\}\/shared\/deploy\.lock/);
  assert.match(source, /https:\/\/molimama\.vip\/drama-health/);
  assert.match(source, /http:\/\/127\.0\.0\.1:8787\/health/);
});

test('release archiver pauses cleanly when the data disk reaches its stop threshold', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const thresholdBlock = source.match(/if \(\( data_used_percent >= DATA_STOP_PERCENT \)\); then\r?\n([\s\S]*?)\r?\nfi/);

  assert.ok(thresholdBlock, 'data disk stop-threshold block is required');
  assert.match(thresholdBlock[1], /ALERT/);
  assert.match(thresholdBlock[1], /exit 0/);
  assert.doesNotMatch(thresholdBlock[1], /\bfail\b/);
});
