const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { buildVerificationCases, verificationReferenceSource } = require('../scripts/verify-usmercari-image-models');

describe('USMercari image real-verification case selection', () => {
  it('runs all eight gates by default', () => {
    assert.equal(buildVerificationCases('').length, 8);
  });

  it('selects exact unpaid or unverified cases without repeating prior calls', () => {
    assert.deepEqual(buildVerificationCases(
      'gpt-image-2-2-4k|text-to-image|4k;nano-banana-2|image-to-image|1k',
    ), [
      { model: 'gpt-image-2-2-4k', capability: 'text-to-image', resolution: '4k' },
      { model: 'nano-banana-2', capability: 'image-to-image', resolution: '1k' },
    ]);
  });

  it('rejects unknown or duplicate cases', () => {
    assert.throws(() => buildVerificationCases('unknown|text-to-image|1k'), /未知验证用例/);
    assert.throws(() => buildVerificationCases(
      'nano-banana-2|text-to-image|1k;nano-banana-2|text-to-image|1k',
    ), /不能重复/);
  });

  it('uses an explicit public reference URL when supplied', async () => {
    assert.equal(
      await verificationReferenceSource('C:\\temp', 'https://assets.example/reference.png'),
      'https://assets.example/reference.png',
    );
  });
});
