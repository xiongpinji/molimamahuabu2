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
