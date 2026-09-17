'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TTS_DISABLED_CODE,
  TTS_DISABLED_MESSAGE,
  isTtsEnabled,
  assertTtsEnabled,
  createTtsDisabledError,
} = require('../src/services/ttsPolicy');

test('默认停用独立 TTS，仅 TTS_ENABLED 显式开启', () => {
  assert.equal(isTtsEnabled({}), false);
  assert.equal(isTtsEnabled({ TTS_ENABLED: '' }), false);
  assert.equal(isTtsEnabled({ TTS_ENABLED: '0' }), false);
  assert.equal(isTtsEnabled({ TTS_ENABLED: 'false' }), false);
  assert.equal(isTtsEnabled({ TTS_ENABLED: '1' }), true);
  assert.equal(isTtsEnabled({ TTS_ENABLED: 'true' }), true);
  assert.equal(isTtsEnabled({ TTS_ENABLED: 'YES' }), true);
});

test('assertTtsEnabled 在停用时抛出稳定业务码', () => {
  assert.throws(
    () => assertTtsEnabled({}),
    (error) => error.code === TTS_DISABLED_CODE && error.message === TTS_DISABLED_MESSAGE,
  );
  assert.doesNotThrow(() => assertTtsEnabled({ TTS_ENABLED: '1' }));
});

test('createTtsDisabledError 保持合同码与文案', () => {
  const error = createTtsDisabledError();
  assert.equal(error.code, 'TTS_DISABLED');
  assert.equal(error.message, TTS_DISABLED_MESSAGE);
});
