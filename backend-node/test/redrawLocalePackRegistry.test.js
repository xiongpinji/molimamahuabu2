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

function modernEnPack(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function spanishPack(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function multiPackFixture(options = {}) {
  const manifest = options.manifest || {
    schema_version: 1,
    enabled_packs: [spanishPack(), modernEnPack()],
  };
  const sortedPacks = [...manifest.enabled_packs].sort((left, right) => left.id.localeCompare(right.id));
  return writeFixture({
    manifest,
    ready: {
      enabled_pack_ids: sortedPacks.map((pack) => pack.id),
      pack_attestations: sortedPacks.map((pack) => ({
        id: pack.id,
        model_manifest_sha256: pack.model_manifest_sha256,
        calibration_manifest_sha256: pack.calibration_manifest_sha256,
      })),
      ...options.ready,
    },
  });
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

  const socketProbeError = writeFixture();
  assert.throws(
    () => registryFor(socketProbeError, { isSocketPath: () => { throw new Error('secret path'); } })
      .assertReady('en-US'),
    { code: 'REDRAW_LOCALE_VERIFIER_NOT_READY' },
  );

  for (const pid of [String(process.pid), true, 0]) {
    const invalidPid = writeFixture({ ready: { pid } });
    assert.throws(() => registryFor(invalidPid).assertReady('en-US'), {
      code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
    });
  }

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
  await assert.rejects(() => verifier.verifyNativeAudio({
    packId: 'es@1',
    expectedLanguage: 'es',
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

test('registry resolves signed language packs without promoting them to locales', () => {
  const fixture = multiPackFixture();
  const registry = registryFor(fixture);

  const pack = registry.assertReady({ packId: 'es@1', language: 'es', scope: 'language' });
  assert.deepEqual(pack, spanishPack());
  assert.throws(
    () => registry.assertReady({
      packId: 'es@1', language: 'es', locale: 'es-MX', scope: 'locale',
    }),
    { code: 'REDRAW_LOCALE_VERIFIER_NOT_READY' },
  );
  assert.throws(
    () => registry.assertReady({ language: 'es', locale: 'es-MX', scope: 'locale' }),
    { code: 'REDRAW_LOCALE_VERIFIER_NOT_READY' },
  );
});

test('registry lists only the exact sorted signed packs attested by a multi-pack ready payload', () => {
  const fixture = multiPackFixture();
  const packs = registryFor(fixture).listReadyPacks();

  assert.deepEqual(packs.map((pack) => pack.id), ['en-US@1', 'es@1']);
  assert.deepEqual(packs.find((pack) => pack.id === 'es@1'), spanishPack());
  assert.equal(registryFor(fixture).assertReady('en-US').id, 'en-US@1');
});

test('registry keeps the legacy en-US signed pack compatible without trusting legacy extensions', () => {
  const fixture = writeFixture({
    manifest: {
      schema_version: 1,
      enabled_packs: [{
        id: 'en-US@1',
        locale: 'en-US',
        model_manifest_sha256: 'a'.repeat(64),
        calibration_manifest_sha256: 'b'.repeat(64),
        thresholds: {
          language_probability_min: 0.95,
          word_error_rate_max: 0.05,
          character_error_rate_max: 0.05,
          us_accent_probability_min: 0.9,
        },
        models: { absolute_path: 'C:\\secret\\model.bin' },
        us_accent_label: 'us',
      }],
    },
  });

  assert.deepEqual(registryFor(fixture).assertReady('en-US'), {
    id: 'en-US@1',
    locale: 'en-US',
    model_manifest_sha256: 'a'.repeat(64),
    calibration_manifest_sha256: 'b'.repeat(64),
  });
});

test('registry rejects missing, extra, duplicate, and hash-drifted multi-pack ready attestations', () => {
  const valid = [
    {
      id: 'en-US@1',
      model_manifest_sha256: 'a'.repeat(64),
      calibration_manifest_sha256: 'b'.repeat(64),
    },
    {
      id: 'es@1',
      model_manifest_sha256: 'c'.repeat(64),
      calibration_manifest_sha256: 'd'.repeat(64),
    },
  ];
  const cases = [
    { enabled_pack_ids: ['en-US@1'], pack_attestations: valid.slice(0, 1) },
    {
      enabled_pack_ids: ['en-US@1', 'es@1', 'fr@1'],
      pack_attestations: [...valid, { ...valid[1], id: 'fr@1' }],
    },
    {
      enabled_pack_ids: ['en-US@1', 'es@1'],
      pack_attestations: [valid[0], { ...valid[0] }],
    },
    {
      enabled_pack_ids: ['en-US@1', 'es@1'],
      pack_attestations: [valid[0], { ...valid[1], model_manifest_sha256: 'e'.repeat(64) }],
    },
    {
      enabled_pack_ids: ['es@1', 'en-US@1'],
      pack_attestations: [valid[1], valid[0]],
    },
    {
      locale_pack: 'es@1',
      model_manifest_sha256: 'c'.repeat(64),
      calibration_manifest_sha256: 'd'.repeat(64),
      enabled_pack_ids: ['en-US@1', 'es@1'],
      pack_attestations: valid,
    },
  ];

  for (const ready of cases) {
    const fixture = multiPackFixture({ ready });
    assert.throws(() => registryFor(fixture).listReadyPacks(), {
      code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
    });
  }
});

test('registry rejects duplicate signed identities and invalid modern pack fields', () => {
  const invalidManifests = [
    { schema_version: 1, enabled_packs: [spanishPack(), spanishPack()] },
    {
      schema_version: 1,
      enabled_packs: [spanishPack(), spanishPack({ id: 'es@2' })],
    },
    {
      schema_version: 1,
      enabled_packs: [spanishPack({ language: 'ES' })],
    },
    {
      schema_version: 1,
      enabled_packs: [spanishPack({ locale: 'es-MX' })],
    },
    {
      schema_version: 1,
      enabled_packs: [spanishPack({ prompt_language_label: ' ' })],
    },
    {
      schema_version: 1,
      enabled_packs: [spanishPack({ thresholds: {
        language_probability_min: 0.8,
        dialogue_similarity_min: 0.8,
        speech_chars_per_second_max: 20,
        extra: 1,
      } })],
    },
    {
      schema_version: 1,
      enabled_packs: [spanishPack({ thresholds: {
        language_probability_min: 2,
        dialogue_similarity_min: 0.8,
        speech_chars_per_second_max: 20,
      } })],
    },
  ];

  for (const manifest of invalidManifests) {
    const onlyPack = manifest.enabled_packs[0];
    const fixture = writeFixture({
      manifest,
      ready: {
        locale_pack: onlyPack.id,
        model_manifest_sha256: onlyPack.model_manifest_sha256,
        calibration_manifest_sha256: onlyPack.calibration_manifest_sha256,
      },
    });
    assert.throws(() => registryFor(fixture).listReadyPacks(), {
      code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
    });
  }
});

test('registry returns a trusted pack projection and validates historical language evidence', () => {
  const manifest = {
    schema_version: 1,
    enabled_packs: [spanishPack({ signed_but_untrusted_extension: 'must-not-leak' })],
  };
  const fixture = writeFixture({
    manifest,
    ready: {
      locale_pack: 'es@1',
      model_manifest_sha256: 'c'.repeat(64),
      calibration_manifest_sha256: 'd'.repeat(64),
      enabled_pack_ids: ['es@1'],
      pack_attestations: [{
        id: 'es@1',
        model_manifest_sha256: 'c'.repeat(64),
        calibration_manifest_sha256: 'd'.repeat(64),
      }],
    },
  });
  const registry = registryFor(fixture);
  const pack = registry.assertReady({ packId: 'es@1', language: 'es', scope: 'language' });
  assert.equal(Object.hasOwn(pack, 'signed_but_untrusted_extension'), false);

  const evidence = {
    source: 'offline-worker',
    locale_pack: 'es@1',
    detected_language: 'es',
    detected_locale: null,
    language_verified: true,
    locale_verified: false,
    model_manifest_sha256: 'c'.repeat(64),
    calibration_manifest_sha256: 'd'.repeat(64),
  };
  assert.deepEqual(
    registry.assertEvidenceTrusted(evidence, {
      packId: 'es@1', language: 'es', scope: 'language', locale: null,
    }),
    evidence,
  );
  assert.throws(
    () => registry.assertEvidenceTrusted({ ...evidence, detected_language: 'en' }, {
      packId: 'es@1', language: 'es', scope: 'language', locale: null,
    }),
    { code: 'REDRAW_LOCALE_VERIFIER_NOT_READY' },
  );
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
