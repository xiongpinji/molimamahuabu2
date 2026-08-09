const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const signer = require('../scripts/sign-redraw-locale-manifest');

function manifest() {
  return {
    thresholds: {
      word_error_rate_max: 0.02,
      language_probability_min: 0.96,
    },
    locale_pack: 'en-US@1',
    schema_version: 1,
    nested: { z: 1, a: 2 },
  };
}

test('signs canonical manifest and mutation fails verification', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-locale-sign-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(tmp, 'private.pem');
  const manifestPath = path.join(tmp, 'manifest.json');
  const signaturePath = path.join(tmp, 'manifest.sig');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(privateKeyPath, privatePem, { mode: 0o600 });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest(), null, 2));

  signer.main(['--manifest', manifestPath, '--private-key', privateKeyPath, '--signature', signaturePath], {
    stdout: { write() {} },
    stderr: { write(value) { throw new Error(`unexpected stderr: ${value}`); } },
  });

  const signature = Buffer.from(fs.readFileSync(signaturePath, 'utf8').trim(), 'base64');
  assert.equal(fs.readFileSync(signaturePath, 'utf8').endsWith('\n'), true);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(signaturePath).mode & 0o777), 0o600);
  }
  assert.equal(crypto.verify(null, signer.canonicalPayload(manifest()), publicKey, signature), true);

  const changed = manifest();
  changed.thresholds.language_probability_min = 0.97;
  assert.equal(crypto.verify(null, signer.canonicalPayload(changed), publicKey, signature), false);
});

test('canonical key order is stable and arrays keep order', () => {
  const left = { b: 1, a: { z: 2, y: [ { d: 4, c: 3 } ] } };
  const right = { a: { y: [ { c: 3, d: 4 } ], z: 2 }, b: 1 };
  assert.deepEqual(signer.canonicalize(left), signer.canonicalize(right));
  assert.equal(signer.canonicalPayload(left).equals(signer.canonicalPayload(right)), true);
});

test('signed multi-pack manifest binds language scope thresholds and pack array order', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signed = {
    schema_version: 1,
    enabled_packs: [
      {
        id: 'en-US@1',
        language: 'en',
        locale: 'en-US',
        scope: 'locale',
        prompt_language_label: '英语（美国）',
        model_manifest_sha256: 'a'.repeat(64),
        calibration_manifest_sha256: 'b'.repeat(64),
        thresholds: {
          language_probability_min: 0.96,
          dialogue_similarity_min: 0.98,
          speech_chars_per_second_max: 18,
        },
      },
      {
        id: 'es@1',
        language: 'es',
        locale: null,
        scope: 'language',
        prompt_language_label: '西班牙语',
        model_manifest_sha256: 'c'.repeat(64),
        calibration_manifest_sha256: 'd'.repeat(64),
        thresholds: {
          language_probability_min: 0.8,
          dialogue_similarity_min: 0.8,
          speech_chars_per_second_max: 20,
        },
      },
    ],
  };
  const signature = crypto.sign(null, signer.canonicalPayload(signed), privateKey);
  assert.equal(crypto.verify(null, signer.canonicalPayload(signed), publicKey, signature), true);

  const reordered = { ...signed, enabled_packs: [...signed.enabled_packs].reverse() };
  const changedThreshold = structuredClone(signed);
  changedThreshold.enabled_packs[1].thresholds.dialogue_similarity_min = 0.81;
  assert.equal(crypto.verify(null, signer.canonicalPayload(reordered), publicKey, signature), false);
  assert.equal(crypto.verify(null, signer.canonicalPayload(changedThreshold), publicKey, signature), false);
});

test('private key content is not written to logs or manifest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-locale-secret-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(tmp, 'private.pem');
  const manifestPath = path.join(tmp, 'manifest.json');
  const signaturePath = path.join(tmp, 'manifest.sig');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const writes = [];
  fs.writeFileSync(privateKeyPath, privatePem, { mode: 0o600 });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest()));

  signer.main(['--manifest', manifestPath, '--private-key', privateKeyPath, '--signature', signaturePath], {
    stdout: { write(value) { writes.push(String(value)); } },
    stderr: { write(value) { writes.push(String(value)); } },
  });

  assert.equal(writes.join('').includes(privatePem.trim()), false);
  assert.equal(fs.readFileSync(manifestPath, 'utf8').includes(privatePem.trim()), false);
  assert.equal(fs.readFileSync(signaturePath, 'utf8').includes(privatePem.trim()), false);
});

test('overwriting an existing signature keeps private file mode', () => {
  if (process.platform === 'win32') {
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-locale-overwrite-'));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(tmp, 'private.pem');
  const manifestPath = path.join(tmp, 'manifest.json');
  const signaturePath = path.join(tmp, 'manifest.sig');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest()));
  fs.writeFileSync(signaturePath, 'old\n', { mode: 0o644 });
  fs.chmodSync(signaturePath, 0o644);

  signer.main(['--manifest', manifestPath, '--private-key', privateKeyPath, '--signature', signaturePath], {
    stdout: { write() {} },
    stderr: { write(value) { throw new Error(`unexpected stderr: ${value}`); } },
  });

  assert.equal((fs.statSync(signaturePath).mode & 0o777), 0o600);
});

test('signature writer does not use predictable pid timestamp temp path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-locale-collision-'));
  const signaturePath = path.join(tmp, 'manifest.sig');
  const collisionPath = path.join(tmp, `.manifest.sig.${process.pid}.123456.tmp`);
  fs.writeFileSync(collisionPath, 'collision');
  const originalNow = Date.now;
  Date.now = () => 123456;
  try {
    signer.writeSignatureFile(signaturePath, 'new-signature\n');
  } finally {
    Date.now = originalNow;
  }
  assert.equal(fs.readFileSync(signaturePath, 'utf8'), 'new-signature\n');
  assert.equal(fs.readFileSync(collisionPath, 'utf8'), 'collision');
});

test('signature writer does not follow predictable temp symlink', () => {
  if (process.platform === 'win32') {
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-locale-symlink-'));
  const signaturePath = path.join(tmp, 'manifest.sig');
  const victimPath = path.join(tmp, 'victim.txt');
  const symlinkPath = path.join(tmp, `.manifest.sig.${process.pid}.789.tmp`);
  fs.writeFileSync(victimPath, 'victim');
  fs.symlinkSync(victimPath, symlinkPath);
  const originalNow = Date.now;
  Date.now = () => 789;
  try {
    signer.writeSignatureFile(signaturePath, 'new-signature\n');
  } finally {
    Date.now = originalNow;
  }
  assert.equal(fs.readFileSync(signaturePath, 'utf8'), 'new-signature\n');
  assert.equal(fs.readFileSync(victimPath, 'utf8'), 'victim');
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
});
