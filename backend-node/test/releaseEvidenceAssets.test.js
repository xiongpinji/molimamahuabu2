const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');

const {
  mountReleaseEvidenceAssets,
  resolveReleaseEvidenceRoot,
} = require('../src/middleware/releaseEvidenceAssets');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-evidence-assets-'));
  const publicRoot = path.join(root, 'public');
  fs.mkdirSync(path.join(publicRoot, 'bootstrap'), { recursive: true });
  fs.mkdirSync(path.join(publicRoot, 'feituo'), { recursive: true });
  fs.mkdirSync(path.join(publicRoot, 'lingjing'), { recursive: true });
  fs.writeFileSync(path.join(publicRoot, 'bootstrap', 'proof.mp4'), 'verified artifact');
  fs.writeFileSync(path.join(publicRoot, 'feituo', 'proof.mp4'), 'verified feituo artifact');
  fs.writeFileSync(path.join(publicRoot, 'lingjing', 'proof.mp4'), 'verified lingjing artifact');
  fs.writeFileSync(path.join(publicRoot, 'bootstrap', 'unsafe.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(publicRoot, 'bootstrap', '.secret.mp4'), 'hidden');
  return { root, publicRoot };
}

test('release evidence public root must stay under its explicit trusted directory', () => {
  const current = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'release-evidence-outside-'));
  try {
    assert.equal(resolveReleaseEvidenceRoot({
      allowedRoot: current.root,
      publicRoot: current.publicRoot,
    }), fs.realpathSync(current.publicRoot));
    assert.throws(() => resolveReleaseEvidenceRoot({
      allowedRoot: current.root,
      publicRoot: outside,
    }), /受保护共享证据目录/);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('verification assets are anonymously readable without exposing dotfiles', async () => {
  const current = fixture();
  const app = express();
  const server = await new Promise((resolve) => {
    mountReleaseEvidenceAssets(app, {
      allowedRoot: current.root,
      publicRoot: current.publicRoot,
    });
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const proof = await fetch(`${base}/verification-assets/bootstrap/proof.mp4`);
    assert.equal(proof.status, 200);
    assert.equal(await proof.text(), 'verified artifact');
    assert.match(String(proof.headers.get('cache-control')), /immutable/);
    const feituo = await fetch(`${base}/verification-assets/feituo/proof.mp4`);
    assert.equal(feituo.status, 200);
    assert.equal(await feituo.text(), 'verified feituo artifact');
    const lingjing = await fetch(`${base}/verification-assets/lingjing/proof.mp4`);
    assert.equal(lingjing.status, 200);
    assert.equal(await lingjing.text(), 'verified lingjing artifact');
    const lingjingHtml = await fetch(`${base}/verification-assets/lingjing/unsafe.html`);
    assert.equal(lingjingHtml.status, 404);
    const hidden = await fetch(`${base}/verification-assets/bootstrap/.secret.mp4`);
    assert.equal(hidden.status, 404);
    const unsafeHtml = await fetch(`${base}/verification-assets/bootstrap/unsafe.html`);
    assert.equal(unsafeHtml.status, 404);
    const unknownDirectory = await fetch(`${base}/verification-assets/other/proof.mp4`);
    assert.equal(unknownDirectory.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('production route does not accept evidence path environment overrides', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'releaseEvidenceAssets.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /process\.env|RELEASE_EVIDENCE_(?:PUBLIC_PATH|ALLOWED_ROOT)/);
  assert.match(source, /\/opt\/moli-drama\/shared\/release-evidence\/external-models-v1\/public/);
  assert.match(source, /stat\.uid\s*!==\s*0|stat\.uid\s*===\s*0/);
  assert.match(source, /0o022/);
});
