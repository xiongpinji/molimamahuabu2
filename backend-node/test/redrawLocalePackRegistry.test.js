const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const signer = require('../scripts/sign-redraw-locale-manifest');
const {
  createRedrawLocalePackRegistry,
  createDisabledRedrawLocaleVerifier,
} = require('../src/services/redrawLocalePackRegistry');

function writeFixture(options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-locale-registry-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = options.manifest || {
    schema_version: 1,
    enabled_packs: [{
      id: 'en-US@1',
      locale: 'en-US',
      model_manifest_sha256: 'a'.repeat(64),
      calibration_manifest_sha256: 'b'.repeat(64),
    }],
  };
  const socketPath = options.socketPath || path.join(tmp, 'verifier.sock');
  const ready = {
    locale_pack: 'en-US@1',
    model_manifest_sha256: 'a'.repeat(64),
    calibration_manifest_sha256: 'b'.repeat(64),
    manifest_sha256: sha256(signer.canonicalPayload(manifest)),
    expires_at: 2_000,
    pid: process.pid,
    ...options.ready,
  };
  const registryPath = path.join(tmp, 'enabled-packs.json');
  const signaturePath = path.join(tmp, 'enabled-packs.sig');
  const publicKeyPath = path.join(tmp, 'public.pem');
  const readyPath = path.join(tmp, 'ready.json');
  fs.writeFileSync(registryPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(signaturePath, `${crypto.sign(null, signer.canonicalPayload(manifest), privateKey).toString('base64')}\n`);
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(readyPath, JSON.stringify(ready, null, 2));
  return { tmp, privateKey, manifest, registryPath, signaturePath, publicKeyPath, readyPath, socketPath };
}

function registryFor(fixture, overrides = {}) {
  return createRedrawLocalePackRegistry({
    enabled: true,
    registryPath: fixture.registryPath,
    signaturePath: fixture.signaturePath,
    publicKeyPath: fixture.publicKeyPath,
    readyPath: fixture.readyPath,
    socketPath: fixture.socketPath,
    now: () => 1_000_000,
    isProcessAlive: (pid) => pid === process.pid,
    isSocketPath: (socketPath) => socketPath === fixture.socketPath,
    ...overrides,
  });
}

test('registry accepts a signed en-US ready attestation', () => {
  const fixture = writeFixture();
  const pack = registryFor(fixture).assertReady('en-US');
  assert.equal(pack.id, 'en-US@1');
  assert.equal(pack.locale, 'en-US');
  assert.equal(pack.model_manifest_sha256, 'a'.repeat(64));
});

test('registry accepts Task4 ready payload without socket_path', () => {
  const fixture = writeFixture();
  const ready = JSON.parse(fs.readFileSync(fixture.readyPath, 'utf8'));
  assert.equal(Object.hasOwn(ready, 'socket_path'), false);
  assert.equal(registryFor(fixture).assertReady('en-US').id, 'en-US@1');
});

test('registry re-reads and re-verifies enabled packs on every ready check', () => {
  const fixture = writeFixture();
  const registry = registryFor(fixture);
  assert.equal(registry.assertReady('en-US').id, 'en-US@1');

  const revoked = { schema_version: 1, enabled_packs: [] };
  fs.writeFileSync(fixture.registryPath, JSON.stringify(revoked, null, 2));
  fs.writeFileSync(
    fixture.signaturePath,
    `${crypto.sign(null, signer.canonicalPayload(revoked), fixture.privateKey).toString('base64')}\n`,
  );

  assert.throws(() => registry.assertReady('en-US'), {
    code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  });
});

test('registry rejects expired and hash-mismatched ready attestations', () => {
  const expired = writeFixture({ ready: { expires_at: 1 } });
  assert.throws(() => registryFor(expired).assertReady('en-US'), {
    code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  });

  const drifted = writeFixture({ ready: { calibration_manifest_sha256: 'c'.repeat(64) } });
  assert.throws(() => registryFor(drifted).assertReady('en-US'), {
    code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  });
});

test('registry rejects invalid signatures, dead pids, non-socket paths, and unsupported packs', () => {
  const badSignature = writeFixture();
  fs.writeFileSync(badSignature.signaturePath, `${Buffer.from('bad').toString('base64')}\n`);
  assert.throws(() => registryFor(badSignature).assertReady('en-US'), {
    code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  });

  const deadPid = writeFixture({ ready: { pid: 999_999_999 } });
  assert.throws(() => registryFor(deadPid, { isProcessAlive: () => false }).assertReady('en-US'), {
    code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  });

  const notSocket = writeFixture({ socketPath: path.join(os.tmpdir(), 'wrong-redraw-locale.sock') });
  assert.throws(() => registryFor(notSocket, { isSocketPath: () => false }).assertReady('en-US'), {
    code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  });

  const unsupported = writeFixture({
    manifest: {
      schema_version: 1,
      enabled_packs: [{
        id: 'en-GB@1',
        locale: 'en-GB',
        model_manifest_sha256: 'a'.repeat(64),
        calibration_manifest_sha256: 'b'.repeat(64),
      }],
    },
  });
  assert.throws(() => registryFor(unsupported).assertReady('en-US'), {
    code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  });
});

test('disabled verifier fails closed without trusting TTS locale fields', async () => {
  const verifier = createDisabledRedrawLocaleVerifier();
  assert.throws(() => verifier.assertReady('en-US'), {
    code: 'REDRAW_LOCALE_VERIFIER_DISABLED',
  });
  await assert.rejects(() => verifier.verify({
    locale: 'en-US',
    detectedLocale: 'en-US',
    languageVerified: true,
  }), { code: 'REDRAW_LOCALE_VERIFIER_DISABLED' });
});

test('registry accepts only exact historical evidence for the enabled pack', () => {
  const fixture = writeFixture();
  const registry = registryFor(fixture);
  const evidence = {
    source: 'offline-worker',
    locale_pack: 'en-US@1',
    model_manifest_sha256: 'a'.repeat(64),
    calibration_manifest_sha256: 'b'.repeat(64),
  };
  assert.deepEqual(registry.assertEvidenceTrusted(evidence), evidence);
  assert.throws(() => registry.assertEvidenceTrusted({ ...evidence, model_manifest_sha256: 'c'.repeat(64) }), {
    code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  });
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
