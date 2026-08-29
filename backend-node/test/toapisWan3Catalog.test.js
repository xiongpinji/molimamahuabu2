'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfig = require('../src/services/aiConfigService');
const catalog = require('../src/services/canvasModelCatalogService');
const prices = require('../src/services/modelPriceService');

const MODEL = 'wan3.0-video';
const CONTRACT = 'toapis-wan3-video-real-verification-v1';
const log = { info() {}, warn() {}, error() {} };

function evidenceRoot(t) {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wan3-catalog-evidence-'));
  const root = path.join(allowedRoot, 'external-models-v1');
  const publicDir = path.join(root, 'public', 'toapis');
  const evidenceFile = 'toapis-wan3-video-verification.json';
  const outputFile = 'wan3-video.mp4';
  fs.mkdirSync(publicDir, { recursive: true });
  const evidence = Buffer.from(JSON.stringify({
    contract_version: CONTRACT,
    results: [{ artifact: { output_file: outputFile } }],
  }));
  const sha256 = crypto.createHash('sha256').update(evidence).digest('hex');
  fs.writeFileSync(path.join(root, evidenceFile), evidence);
  fs.writeFileSync(path.join(publicDir, outputFile), 'wan3\n');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    contract_version: 'external-model-release-evidence-manifest-v1',
    evidence: { [CONTRACT]: { file: evidenceFile, sha256 } },
  }));
  t.after(() => fs.rmSync(allowedRoot, { recursive: true, force: true }));
  return { roots: { allowedRoot, root }, sha256 };
}

function setup(t) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  t.after(() => db.close());
  const evidence = evidenceRoot(t);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_wan3_video',
    name: 'ToAPIs Wan 3.0',
    base_url: 'https://toapis.xyz',
    api_key: 'wan3-test-key',
    model: [MODEL],
    default_model: MODEL,
    is_active: true,
    is_default: true,
  });
  aiConfig.recordVerification(db, config.id, {
    status: 'verified',
    capabilities: {
      [MODEL]: {
        durations: [2],
        resolutions: ['480p'],
        aspectRatios: ['16:9'],
        audio_values: [false],
        maxReferences: 0,
        maxVideoReferences: 0,
        maxAudioReferences: 0,
        supportsFirstFrame: false,
        supportsLastFrame: false,
        supportsImageReference: false,
        supportsVideoReference: false,
        supportsAudioReference: false,
        supportsAudio: false,
        evidence_contract: CONTRACT,
        evidence_sha256: evidence.sha256,
      },
    },
  });
  prices.set(db, MODEL, 10, {
    category: 'video',
    billing_unit: 'second',
    cost_unit: 'second',
    resolution_prices: {
      '480p': { credits: 10, cost_micros_per_second: 50000 },
    },
  });
  return { db, evidence, configId: config.id };
}

test('Wan 3.0 public catalog exposes only the paid 480P capability and price', (t) => {
  const { db, evidence } = setup(t);
  const item = catalog.list(db, { evidenceRoots: evidence.roots })
    .find((entry) => entry.model === MODEL);
  assert.ok(item);
  assert.equal(item.kind, 'video');
  assert.deepEqual(item.capabilities.resolutions, ['480p']);
  assert.deepEqual(item.capabilities.durations, [2]);
  assert.deepEqual(item.capabilities.aspectRatios, ['16:9']);
  assert.equal(item.capabilities.supportsAudio, false);
  assert.deepEqual(Object.keys(item.resolution_prices), ['480p']);
  assert.equal(JSON.stringify(item).includes('toapis.xyz'), false);
  assert.equal(JSON.stringify(item).includes('wan3-test-key'), false);

  const publicPrice = prices.listPublic(db, { evidenceRoots: evidence.roots })
    .find((entry) => entry.model === MODEL);
  assert.ok(publicPrice);
  assert.deepEqual(Object.keys(publicPrice.resolution_prices), ['480p']);
});

test('Wan 3.0 public catalog fails closed when the verified tier has no matching price', (t) => {
  const { db, evidence, configId } = setup(t);
  aiConfig.recordVerification(db, configId, {
    status: 'verified',
    capabilities: {
      [MODEL]: {
        durations: [2],
        resolutions: ['720p'],
        aspectRatios: ['16:9'],
        audio_values: [false],
        supportsAudio: false,
        evidence_contract: CONTRACT,
        evidence_sha256: evidence.sha256,
      },
    },
  });
  assert.equal(catalog.list(db, { evidenceRoots: evidence.roots })
    .some((entry) => entry.model === MODEL), false);
  assert.equal(prices.listPublic(db, { evidenceRoots: evidence.roots })
    .some((entry) => entry.model === MODEL), false);
});
