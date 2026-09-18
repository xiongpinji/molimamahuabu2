'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONFIRM_CANARY,
  CONFIRM_PROMOTE,
  dryRunCanary,
  dryRunPromote,
  assertNativeEvidenceShape,
} = require('../src/services/redrawNativeDialogueOps');
const verifyMain = require('../scripts/verify-redraw-native-dialogue-audio.js').main;
const promoteMain = require('../scripts/promote-redraw-native-dialogue-evidence.js').main;

test('canary 默认 dry-run：零网络、零写入、零产物', () => {
  const report = dryRunCanary({});
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.sideEffects.fetchCalls, 0);
  assert.equal(report.sideEffects.providerSubmissions, 0);
  assert.equal(report.sideEffects.dbWriteCalls, 0);
  assert.deepEqual(report.sideEffects.outputFiles, []);
  assert.equal(report.required_confirm, CONFIRM_CANARY);
  assert.equal(report.plan.generate_audio, true);
  assert.equal(report.plan.locale_pack, 'es@1');
});

test('canary 仅在确认串匹配时 arm，仍不自动 submit', () => {
  const report = dryRunCanary({ confirm: CONFIRM_CANARY, model: 'seedance-2-mini' });
  assert.equal(report.mode, 'armed');
  assert.equal(report.ready, true);
  assert.equal(report.sideEffects.providerSubmissions, 0);
  assert.equal(report.plan.model, 'seedance-2-mini');
  assert.equal(report.plan.max_submits, 1);
});

test('promote 默认 dry-run 且校验 evidence 形状', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-promote-'));
  try {
    const evidencePath = path.join(dir, 'evidence.json');
    fs.writeFileSync(evidencePath, JSON.stringify({
      contract: 'redraw-native-audio-validation-v1',
      artifact_sha256: 'a'.repeat(64),
      validation_hash: 'b'.repeat(64),
      verification: { language_verified: true, detected_language: 'es' },
      human_review: { status: 'approved', reviewer_id: 'user-a' },
      config: {
        provider: 'toapis',
        model: 'seedance-2-fast',
        ai_service_config_id: 41,
        config_updated_at: '2026-09-18T00:00:00.000Z',
      },
      api_key: 'sk-secret-should-redact',
    }));
    const report = dryRunPromote({ evidencePath });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.ready, true);
    assert.equal(report.reason, 'missing_commit');
    assert.equal(report.sideEffects.dbWriteCalls, 0);
    assert.equal(report.redacted.api_key, '[redacted]');
    assert.deepEqual(assertNativeEvidenceShape(JSON.parse(fs.readFileSync(evidencePath, 'utf8'))), []);

    const armed = dryRunPromote({
      evidencePath,
      commit: true,
      confirm: CONFIRM_PROMOTE,
    });
    assert.equal(armed.mode, 'armed');
    assert.equal(armed.sideEffects.dbWriteCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI scripts 默认 dry-run 且退出码稳定', () => {
  const previousCode = process.exitCode;
  try {
    const canary = verifyMain([]);
    assert.equal(canary.mode, 'dry-run');
    assert.equal(process.exitCode, 0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-promote-cli-'));
    const evidencePath = path.join(dir, 'bad.json');
    fs.writeFileSync(evidencePath, JSON.stringify({ contract: 'x' }));
    const promote = promoteMain([`--evidence=${evidencePath}`]);
    assert.equal(promote.mode, 'dry-run');
    assert.equal(promote.ready, false);
    assert.equal(process.exitCode, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    process.exitCode = previousCode;
  }
});
