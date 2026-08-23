'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { verifyAudio } = require('../src/services/providerCanaryArtifactService');
const validMp3Bytes = require('./fixtures/minimalMp3');

function tempStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moli-provider-canary-audio-'));
}

test('TTS verification accepts only a readable MP3 inside the exact isolated run directory', (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const runId = 'run-tts-audio';
  const relativePath = `_system/provider-canary/runs/${runId}/tts_sbx_fixture.mp3`;
  const filePath = path.join(storageRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, validMp3Bytes);

  const summary = verifyAudio(relativePath, { storageRoot, runId });
  assert.deepEqual(Object.keys(summary).sort(), ['bytes', 'media_type', 'relative_path', 'sha256']);
  assert.equal(summary.relative_path, relativePath);
  assert.equal(summary.media_type, 'audio/mpeg');
  assert.equal(summary.bytes, validMp3Bytes.length);
  assert.match(summary.sha256, /^[a-f0-9]{64}$/);

  const otherRun = '_system/provider-canary/runs/run-other/tts.mp3';
  const otherPath = path.join(storageRoot, ...otherRun.split('/'));
  fs.mkdirSync(path.dirname(otherPath), { recursive: true });
  fs.writeFileSync(otherPath, validMp3Bytes);
  assert.throws(() => verifyAudio(otherRun, { storageRoot, runId }), /run|path|artifact/i);

  const userRelative = 'audio/user.mp3';
  const userPath = path.join(storageRoot, ...userRelative.split('/'));
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, validMp3Bytes);
  assert.throws(() => verifyAudio(userRelative, { storageRoot, runId }), /run|path|artifact/i);

  fs.writeFileSync(filePath, Buffer.from('not an mp3'));
  assert.throws(() => verifyAudio(relativePath, { storageRoot, runId }), /MP3|audio|artifact/i);
});

test('TTS verification rejects a run directory junction that escapes the storage root', (t) => {
  const storageRoot = tempStorage();
  const outside = tempStorage();
  const runId = 'run-tts-junction';
  const runDirectory = path.join(storageRoot, '_system', 'provider-canary', 'runs', runId);
  fs.mkdirSync(path.dirname(runDirectory), { recursive: true });
  fs.writeFileSync(path.join(outside, 'escaped.mp3'), validMp3Bytes);
  fs.symlinkSync(outside, runDirectory, 'junction');
  t.after(() => {
    try { fs.unlinkSync(runDirectory); } catch (_) { /* already removed */ }
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  assert.throws(
    () => verifyAudio(`_system/provider-canary/runs/${runId}/escaped.mp3`, { storageRoot, runId }),
    /escape|run|path|artifact/i,
  );
});
