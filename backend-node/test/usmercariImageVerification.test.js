const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const aiConfig = require('../src/services/aiConfigService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const {
  buildVerificationCases,
  buildVerifiedCapabilities,
  hasCompleteApprovedMatrix,
  requiresReferenceUrl,
  recordVerificationResult,
  buildVerificationReferences,
  verificationReferenceSource,
} = require('../scripts/verify-usmercari-image-models');

describe('USMercari image real-verification case selection', () => {
  it('runs the seven product-approved gates by default', () => {
    assert.equal(buildVerificationCases('').length, 7);
    assert.equal(buildVerificationCases('').some((item) => (
      item.model === 'gpt-image-2-2-4k' && item.resolution === '4k'
    )), false);
  });

  it('selects exact unpaid or unverified cases without repeating prior calls', () => {
    assert.deepEqual(buildVerificationCases(
      'gpt-image-2-2-4k|text-to-image|2k;nano-banana-2|image-to-image|1k',
    ), [
      { model: 'gpt-image-2-2-4k', capability: 'text-to-image', resolution: '2k' },
      { model: 'nano-banana-2', capability: 'image-to-image', resolution: '1k' },
    ]);
  });

  it('rejects unknown or duplicate cases', () => {
    assert.throws(() => buildVerificationCases('unknown|text-to-image|1k'), /未知验证用例/);
    assert.throws(() => buildVerificationCases('gpt-image-2-2-4k|text-to-image|4k'), /未知验证用例/);
    assert.throws(() => buildVerificationCases(
      'nano-banana-2|text-to-image|1k;nano-banana-2|text-to-image|1k',
    ), /不能重复/);
  });

  it('requires a public reference only when selected cases include image-to-image', () => {
    assert.equal(requiresReferenceUrl(buildVerificationCases('gpt-image-2-2-4k|text-to-image|1k')), false);
    assert.equal(requiresReferenceUrl(buildVerificationCases('nano-banana-2|image-to-image|1k')), true);
  });

  it('builds DB verification capabilities only from completed inspected evidence', () => {
    const capabilities = buildVerifiedCapabilities([
      { model: 'gpt-image-2-2-4k', capability: 'text-to-image', requested_resolution: '1k', width: 1024, height: 1024 },
      { model: 'gpt-image-2-2-4k', capability: 'image-to-image', requested_resolution: '1k', width: 1024, height: 1024 },
      { model: 'nano-banana-2', capability: 'text-to-image', requested_resolution: '4k', width: 2200, height: 2200 },
    ]);
    assert.deepEqual(capabilities, {
      'gpt-image-2-2-4k': {
        supportsTextToImage: true,
        supportsImageReference: true,
        maxReferences: 1,
        resolutions: ['1k'],
      },
      'nano-banana-2': {
        supportsTextToImage: true,
        supportsImageReference: false,
        maxReferences: 0,
        resolutions: ['4k'],
      },
    });
  });

  it('does not upgrade DB verified from an incomplete selected subset', () => {
    assert.equal(hasCompleteApprovedMatrix([
      { model: 'gpt-image-2-2-4k', capability: 'text-to-image', requested_resolution: '1k', width: 1024, height: 1024 },
    ]), false);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usmercari-verify-db-'));
    const dbPath = path.join(tempDir, 'verify.sqlite');
    const db = new Database(dbPath);
    runMigrationsAndEnsure(db);
    const config = aiConfig.createConfig(db, { info() {} }, {
      service_type: 'image',
      provider: 'usmercari_image',
      api_protocol: 'usmercari_image',
      name: 'USMercari 图片',
      base_url: 'https://chat-ai.mercarimx.com',
      model: ['gpt-image-2-2-4k', 'nano-banana-2'],
    });
    db.close();
    const previousDb = process.env.USMERCARI_VERIFY_DATABASE_PATH;
    const previousConfig = process.env.USMERCARI_VERIFY_CONFIG_ID;
    process.env.USMERCARI_VERIFY_DATABASE_PATH = dbPath;
    process.env.USMERCARI_VERIFY_CONFIG_ID = String(config.id);
    try {
      const status = recordVerificationResult([
        { model: 'gpt-image-2-2-4k', capability: 'text-to-image', requested_resolution: '1k', width: 1024, height: 1024 },
      ]);
      assert.equal(status, null);
      const verifyDb = new Database(dbPath);
      assert.equal(aiConfig.getConfig(verifyDb, config.id).verification_status, 'unverified');
      verifyDb.close();
    } finally {
      if (previousDb === undefined) delete process.env.USMERCARI_VERIFY_DATABASE_PATH;
      else process.env.USMERCARI_VERIFY_DATABASE_PATH = previousDb;
      if (previousConfig === undefined) delete process.env.USMERCARI_VERIFY_CONFIG_ID;
      else process.env.USMERCARI_VERIFY_CONFIG_ID = previousConfig;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses an explicit public reference URL when supplied', async () => {
    assert.equal(
      await verificationReferenceSource('C:\\temp', 'https://assets.example/reference.png'),
      'https://assets.example/reference.png',
    );
    await assert.rejects(() => verificationReferenceSource('C:\\temp', ''), /HTTPS 公网地址/);
  });

  it('binds the verification reference to the strict public URL allowlist', () => {
    const referenceUrl = 'https://molimama.vip/static/projects/1/reference.png';
    assert.deepEqual(buildVerificationReferences('image-to-image', referenceUrl), {
      reference_image_urls: [referenceUrl],
      allowed_reference_base_url: referenceUrl,
    });
    assert.deepEqual(buildVerificationReferences('text-to-image', referenceUrl), {
      reference_image_urls: [],
    });
  });
});
