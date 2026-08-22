const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const sharp = require('sharp');

const {
  prepareUsmercariImageReleaseEvidence,
} = require('../scripts/prepare-usmercari-image-release-evidence');
const {
  mountReleaseEvidenceAssets,
} = require('../src/middleware/releaseEvidenceAssets');

const CASES = [
  ['gpt-image-2-2-4k', 'text-to-image', '1k'],
  ['gpt-image-2-2-4k', 'text-to-image', '2k'],
  ['gpt-image-2-2-4k', 'image-to-image', '1k'],
  ['nano-banana-2', 'text-to-image', '1k'],
  ['nano-banana-2', 'text-to-image', '2k'],
  ['nano-banana-2', 'text-to-image', '4k'],
  ['nano-banana-2', 'image-to-image', '1k'],
];

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function withEvidenceServer(allowedRoot, publicRoot, callback) {
  const app = express();
  mountReleaseEvidenceAssets(app, { allowedRoot, publicRoot });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-usmercari-evidence-'));
  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets);
  const baseTime = Date.now() - 60 * 60 * 1000;
  const results = [];
  for (let index = 0; index < CASES.length; index += 1) {
    const [model, capability, resolution] = CASES[index];
    const edge = resolution === '4k' ? 4096 : resolution === '2k' ? 2048 : 1024;
    const bytes = await sharp({
      create: {
        width: edge,
        height: edge,
        channels: 3,
        background: { r: 20 + index * 20, g: 40 + index * 5, b: 80 + index * 10 },
      },
    }).jpeg({ quality: 60 }).toBuffer();
    const outputFile = `${model}-${capability}-${resolution}.png`;
    fs.writeFileSync(path.join(assets, outputFile), bytes);
    results.push({
      marker: `${model}|${capability}|${resolution}|verified`,
      model,
      capability,
      requested_resolution: resolution,
      requested_aspect_ratio: '1:1',
      quantity: 1,
      started_at: new Date(baseTime + index * 10_000).toISOString(),
      completed_at: new Date(baseTime + index * 10_000 + 5_000).toISOString(),
      provider_credits_used: model.startsWith('gpt-') ? 8 : 80,
      provider_model_id: model.startsWith('gpt-') ? '135b2740-a20b-48c8-8f86-6f68199e06c5' : model,
      result_url_origin: 'https://chat-ai.mercarimx.com',
      output_file: outputFile,
      content_type: 'image/jpeg',
      bytes: bytes.length,
      width: edge,
      height: edge,
      format: 'jpeg',
      sha256: hash(bytes),
    });
  }

  const gptText = results.filter((item) => item.model.startsWith('gpt-') && item.capability === 'text-to-image');
  const nanoText = results.filter((item) => item.model.startsWith('nano-') && item.capability === 'text-to-image');
  const references = results.filter((item) => item.capability === 'image-to-image');
  const rawFiles = {
    gpt: path.join(root, 'gpt.json'),
    nano: path.join(root, 'nano.json'),
    references: path.join(root, 'references.json'),
    gpt4k: path.join(root, 'gpt4k.json'),
  };
  fs.writeFileSync(rawFiles.gpt, JSON.stringify({
    base_url: 'https://chat-ai.mercarimx.com',
    failed_at: new Date(baseTime + 30_000).toISOString(),
    completed_results: gptText,
    error: 'USMercari image failed (400): legacy structured error was unavailable',
  }));
  fs.writeFileSync(rawFiles.nano, JSON.stringify({
    base_url: 'https://chat-ai.mercarimx.com',
    failed_at: new Date(baseTime + 70_000).toISOString(),
    completed_results: nanoText,
    error: 'USMercari image failed (400): reference endpoint rejected',
  }));
  fs.writeFileSync(rawFiles.references, JSON.stringify({
    base_url: 'https://chat-ai.mercarimx.com',
    generated_at: new Date(baseTime + 90_000).toISOString(),
    selected_cases: references.map((item) => `${item.model}|${item.capability}|${item.requested_resolution}`),
    results: references,
  }));
  fs.writeFileSync(rawFiles.gpt4k, JSON.stringify({
    base_url: 'https://chat-ai.mercarimx.com',
    failed_at: new Date(baseTime + 100_000).toISOString(),
    failed_case: 'gpt-image-2-2-4k|text-to-image|4k',
    completed_results: [],
    error: 'USMercari image failed (400): generation failed: PROVIDER_INVALID_REQUEST',
  }));
  return { root, assets, rawFiles };
}

test('builds a redacted strong release envelope from the seven real image artifacts without network I/O', async () => {
  const current = await fixture();
  const outputRoot = path.join(current.root, 'release-evidence');
  const fetchBefore = global.fetch;
  try {
    let networkCalls = 0;
    global.fetch = async () => {
      networkCalls += 1;
      throw new Error('network access is forbidden in evidence preparation');
    };
    const result = await prepareUsmercariImageReleaseEvidence({
      sourceFiles: [current.rawFiles.gpt, current.rawFiles.nano, current.rawFiles.references],
      rejectionFiles: [current.rawFiles.gpt, current.rawFiles.gpt4k],
      assetRoots: [current.assets],
      outputRoot,
    });
    global.fetch = fetchBefore;
    assert.equal(networkCalls, 0);
    assert.equal(result.contract_version, 'usmercari-image-real-verification-v1');
    assert.equal(result.provider_origin, 'https://chat-ai.mercarimx.com');
    assert.equal(result.generated_at, JSON.parse(fs.readFileSync(current.rawFiles.gpt4k, 'utf8')).failed_at);
    assert.equal(result.results.length, 7);
    assert.equal(result.rejected_capabilities[0].attempts, 2);
    assert.equal(result.rejected_capabilities[0].error_code, 'PROVIDER_INVALID_REQUEST');
    assert.equal(result.verified_capabilities['gpt-image-2-2-4k'].maxReferences, 1);
    assert.equal(result.verified_capabilities['nano-banana-2'].maxReferences, 1);
    assert.equal(Date.parse(result.valid_until) - Date.parse(result.generated_at), 7 * 24 * 60 * 60 * 1000);
    assert.deepEqual(result.pricing.map((item) => item.credits_per_image), [70, 87, 70, 87, 105]);
    for (const item of result.results) {
      assert.equal(item.public_url, `https://molimama.vip/verification-assets/usmercari/${encodeURIComponent(item.output_file)}`);
      assert.equal(path.extname(item.output_file), '.jpg');
      assert.equal(item.format, 'jpeg');
      assert.equal(item.content_type, 'image/jpeg');
      assert.match(item.raw_source_sha256, /^[a-f0-9]{64}$/);
      assert.equal(item.reference_count, item.capability === 'image-to-image' ? 1 : 0);
      assert.equal(fs.existsSync(path.join(outputRoot, 'public', 'usmercari', item.output_file)), true);
      assert.equal(hash(fs.readFileSync(path.join(outputRoot, 'public', 'usmercari', item.output_file))), item.sha256);
    }
    assert.equal(
      result.results.find((item) => item.model === 'gpt-image-2-2-4k').provider_model_id,
      '135b2740-a20b-48c8-8f86-6f68199e06c5',
    );
    assert.equal(result.rejected_capabilities[0].raw_source_sha256.length, 2);
    const raw = fs.readFileSync(path.join(outputRoot, 'usmercari-image-verification.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw), result);
    assert.doesNotMatch(raw, /cookie#|AppData|prepare-usmercari-evidence|verification-failure|api[_-]?key|\berror\b/i);
    await withEvidenceServer(current.root, path.join(outputRoot, 'public'), async (baseUrl) => {
      const item = result.results[0];
      const response = await fetch(`${baseUrl}/verification-assets/usmercari/${encodeURIComponent(item.output_file)}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /^image\/jpeg\b/i);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(hash(Buffer.from(await response.arrayBuffer())), item.sha256);
    });
  } finally {
    global.fetch = fetchBefore;
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('rejects a tampered artifact instead of emitting partial release evidence', async () => {
  const current = await fixture();
  const outputRoot = path.join(current.root, 'tampered-output');
  try {
    fs.appendFileSync(path.join(current.assets, 'nano-banana-2-text-to-image-2k.png'), 'tampered');
    await assert.rejects(prepareUsmercariImageReleaseEvidence({
      sourceFiles: [current.rawFiles.gpt, current.rawFiles.nano, current.rawFiles.references],
      rejectionFiles: [current.rawFiles.gpt, current.rawFiles.gpt4k],
      assetRoots: [current.assets],
      outputRoot,
    }), /SHA-256|bytes/);
    assert.equal(fs.existsSync(outputRoot), false);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('requires two independent GPT 4K rejection records', async () => {
  const current = await fixture();
  try {
    await assert.rejects(prepareUsmercariImageReleaseEvidence({
      sourceFiles: [current.rawFiles.gpt, current.rawFiles.nano, current.rawFiles.references],
      rejectionFiles: [current.rawFiles.gpt4k],
      assetRoots: [current.assets],
      outputRoot: path.join(current.root, 'one-rejection'),
    }), /两次|2 次|rejection/i);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('rejects untrusted provider origins and never leaves a partial output', async () => {
  const current = await fixture();
  const outputRoot = path.join(current.root, 'wrong-origin');
  try {
    const raw = JSON.parse(fs.readFileSync(current.rawFiles.gpt, 'utf8'));
    raw.base_url = 'https://example.com';
    fs.writeFileSync(current.rawFiles.gpt, JSON.stringify(raw));
    await assert.rejects(prepareUsmercariImageReleaseEvidence({
      sourceFiles: [current.rawFiles.gpt, current.rawFiles.nano, current.rawFiles.references],
      rejectionFiles: [current.rawFiles.gpt, current.rawFiles.gpt4k],
      assetRoots: [current.assets],
      outputRoot,
    }), /official|provider|origin|域名/i);
    assert.equal(fs.existsSync(outputRoot), false);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('requires result_url_origin to be the exact official origin, not an API path', async () => {
  const current = await fixture();
  try {
    const raw = JSON.parse(fs.readFileSync(current.rawFiles.gpt, 'utf8'));
    raw.completed_results[0].result_url_origin = 'https://chat-ai.mercarimx.com/v1';
    fs.writeFileSync(current.rawFiles.gpt, JSON.stringify(raw));
    await assert.rejects(prepareUsmercariImageReleaseEvidence({
      sourceFiles: [current.rawFiles.gpt, current.rawFiles.nano, current.rawFiles.references],
      rejectionFiles: [current.rawFiles.gpt, current.rawFiles.gpt4k],
      assetRoots: [current.assets],
      outputRoot: path.join(current.root, 'api-path-origin'),
    }), /result origin|official|exact/i);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('requires every artifact basename to resolve to exactly one local file', async () => {
  const current = await fixture();
  const duplicateRoot = path.join(current.root, 'duplicate-assets');
  fs.mkdirSync(duplicateRoot);
  fs.copyFileSync(
    path.join(current.assets, 'gpt-image-2-2-4k-text-to-image-1k.png'),
    path.join(duplicateRoot, 'gpt-image-2-2-4k-text-to-image-1k.png'),
  );
  try {
    await assert.rejects(prepareUsmercariImageReleaseEvidence({
      sourceFiles: [current.rawFiles.gpt, current.rawFiles.nano, current.rawFiles.references],
      rejectionFiles: [current.rawFiles.gpt, current.rawFiles.gpt4k],
      assetRoots: [current.assets, duplicateRoot],
      outputRoot: path.join(current.root, 'ambiguous-output'),
    }), /exactly one|唯一|1 个/i);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('publishes the exact bytes that were verified even if the source changes before staging write', async () => {
  const current = await fixture();
  const outputRoot = path.join(current.root, 'source-race-output');
  const sourceAsset = path.join(current.assets, 'gpt-image-2-2-4k-text-to-image-1k.png');
  const verifiedBytes = fs.readFileSync(sourceAsset);
  const mkdirSyncBefore = fs.mkdirSync;
  let mutatedAfterValidation = false;
  fs.mkdirSync = function mkdirAndMutate(target, ...args) {
    const result = mkdirSyncBefore.call(fs, target, ...args);
    const normalized = String(target).replaceAll('\\', '/');
    if (!mutatedAfterValidation && /\.source-race-output\.staging-[^/]+\/public\/usmercari$/.test(normalized)) {
      fs.appendFileSync(sourceAsset, 'changed-after-validation');
      mutatedAfterValidation = true;
    }
    return result;
  };
  try {
    const evidence = await prepareUsmercariImageReleaseEvidence({
      sourceFiles: [current.rawFiles.gpt, current.rawFiles.nano, current.rawFiles.references],
      rejectionFiles: [current.rawFiles.gpt, current.rawFiles.gpt4k],
      assetRoots: [current.assets],
      outputRoot,
    });
    assert.equal(mutatedAfterValidation, true);
    const item = evidence.results.find((entry) => entry.marker === 'gpt-image-2-2-4k|text-to-image|1k|verified');
    const publishedBytes = fs.readFileSync(path.join(outputRoot, 'public', 'usmercari', item.output_file));
    assert.equal(hash(publishedBytes), item.sha256);
    assert.deepEqual(publishedBytes, verifiedBytes);
  } finally {
    fs.mkdirSync = mkdirSyncBefore;
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});
