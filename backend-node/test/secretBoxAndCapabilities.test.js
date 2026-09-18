'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptSecret, decryptSecret, isEncrypted } = require('../src/services/secretBox');
const { createPlatformCapabilities, isPublicPlatformMode } = require('../src/services/platformCapabilityService');

test('secretBox round-trip with master key', () => {
  const env = { AI_CONFIG_MASTER_KEY: 'test-master-key-at-least-32-characters!!' };
  const cipher = encryptSecret('sk-live-example', env);
  assert.ok(isEncrypted(cipher));
  assert.equal(decryptSecret(cipher, env), 'sk-live-example');
});

test('secretBox keeps plaintext when master key missing', () => {
  const env = {};
  assert.equal(encryptSecret('plain-key', env), 'plain-key');
  assert.equal(decryptSecret('plain-key', env), 'plain-key');
});

test('platform capability matrix mirrors PUBLIC_PLATFORM_MODE', () => {
  assert.equal(isPublicPlatformMode({ PUBLIC_PLATFORM_MODE: '1' }), true);
  const caps = createPlatformCapabilities({ PUBLIC_PLATFORM_MODE: 'true' });
  assert.equal(caps.publicPlatformEnabled, true);
  assert.equal(caps.billingEnabled, true);
  assert.equal(caps.staticOwnershipEnabled, true);
  const off = createPlatformCapabilities({ PUBLIC_PLATFORM_MODE: '0' });
  assert.equal(off.publicPlatformEnabled, false);
  assert.equal(off.billingEnabled, false);
});
