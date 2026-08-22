const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  REQUIRED_CASES,
  auditReleaseContract,
} = require('../scripts/verify-usmercari-image-release-contract');

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function completeEvidence() {
  const generatedAtMs = Date.now() - 60 * 60 * 1000;
  const generatedAt = new Date(generatedAtMs).toISOString();
  return {
    contract_version: 'usmercari-image-real-verification-v1',
    provider_origin: 'https://chat-ai.mercarimx.com',
    generated_at: generatedAt,
    valid_until: new Date(generatedAtMs + 6 * 24 * 60 * 60 * 1000).toISOString(),
    results: REQUIRED_CASES.map(({ model, capability, resolution }) => {
      const edge = resolution === '4k' ? 4096 : resolution === '2k' ? 2048 : 1024;
      const id = `${model}|${capability}|${resolution}`;
      return {
        marker: `${id}|verified`,
        model,
        capability,
        requested_resolution: resolution,
        requested_aspect_ratio: '1:1',
        quantity: 1,
        reference_count: capability === 'image-to-image' ? 1 : 0,
        started_at: generatedAt,
        completed_at: generatedAt,
        provider_model_id: model,
        public_url: `https://molimama.vip/verification-assets/usmercari/${model}-${capability}-${resolution}.png`,
        output_file: `${model}-${capability}-${resolution}.png`,
        content_type: 'image/jpeg',
        bytes: edge,
        width: edge,
        height: edge,
        format: 'jpeg',
        sha256: crypto.createHash('sha256').update(id).digest('hex'),
      };
    }),
    rejected_capabilities: [{
      marker: 'gpt-image-2-2-4k|text-to-image|4k|failed',
      attempts: 2,
      http_status: 400,
      error_code: 'PROVIDER_INVALID_REQUEST',
    }],
    pricing: [
      ['gpt-image-2-2-4k', '1k', 0.08, 70],
      ['gpt-image-2-2-4k', '2k', 0.10, 87],
      ['nano-banana-2', '1k', 0.08, 70],
      ['nano-banana-2', '2k', 0.10, 87],
      ['nano-banana-2', '4k', 0.12, 105],
    ].map(([model, resolution, cost, credits]) => ({
      model,
      resolution,
      cost_yuan_per_image: cost,
      credits_per_image: credits,
      reviewed: true,
    })),
  };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usmercari-image-release-'));
  write(root, 'backend-node/src/services/usmercariImageClient.js', `
    const USMERCARI_IMAGE_MODELS = {
      'gpt-image-2-2-4k': { resolutions: ['1k', '2k'], maxReferences: 6 },
      'nano-banana-2': { resolutions: ['1k', '2k', '4k'], maxReferences: 6 },
    };
  `);
  write(root, 'backend-node/src/services/imageClient.js', `
    if (protocol === 'usmercari_image') return callUsmercariImageApi(config, log, payload);
    if (config.verification_status !== 'verified') return false;
  `);
  write(root, 'backend-node/src/services/imageService.js', `
    if (!config || config.verification_status !== 'verified') {
      throw imageRequestError('MODEL_NOT_VERIFIED', 'not verified');
    }
    const verified_capabilities = config.verified_capabilities;
  `);
  write(root, 'backend-node/src/services/canvasModelCatalogService.js', `
    const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video']);
    if (config.verification_status !== 'verified' || !hasConnectionCredential(config)) return false;
    const verified_capabilities = config.verified_capabilities;
    const resolution_prices = price.resolution_prices;
  `);
  write(root, 'backend-node/src/services/modelPriceService.js', `
    const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video']);
    if (protocol === 'usmercari_image' && price.category !== 'image') return false;
    if (config.verification_status !== 'verified') return false;
  `);
  write(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', '<strong class="canvas-credit-callout-v1">本次预计扣除</strong>');
  write(root, 'frontweb/src/views/FilmCreate.vue', '<strong class="canvas-credit-callout-v1">本次预计扣除</strong>');
  const evidencePath = path.join(root, 'docs/evidence/usmercari-image-verification.json');
  write(root, 'docs/evidence/usmercari-image-verification.json', JSON.stringify(completeEvidence()));
  return { root, evidencePath };
}

describe('USMercari image protected release contract', () => {
  it('accepts the exact seven-case image matrix and reviewed prices', () => {
    const fixture = makeFixture();
    try {
      assert.deepEqual(auditReleaseContract(fixture), []);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const [name, mutate, expected] of [
    ['one verified case', ({ evidencePath }) => {
      const evidence = JSON.parse(fs.readFileSync(evidencePath));
      evidence.results.pop();
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    }, '真实验证组合'],
    ['GPT 4K rejection proof', ({ evidencePath }) => {
      const evidence = JSON.parse(fs.readFileSync(evidencePath));
      evidence.rejected_capabilities = [];
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    }, 'GPT 4K'],
    ['exact image pricing', ({ evidencePath }) => {
      const evidence = JSON.parse(fs.readFileSync(evidencePath));
      evidence.pricing[0].credits_per_image = 69;
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    }, '价格'],
    ['official provider origin', ({ evidencePath }) => {
      const evidence = JSON.parse(fs.readFileSync(evidencePath));
      evidence.provider_origin = 'https://example.com';
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    }, '官方域名'],
    ['public artifact hash', ({ evidencePath }) => {
      const evidence = JSON.parse(fs.readFileSync(evidencePath));
      evidence.results[0].sha256 = 'bad';
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    }, '成品'],
    ['strict public catalog', ({ root }) => write(root, 'backend-node/src/services/canvasModelCatalogService.js', 'module.exports = {}'), '目录'],
    ['pre-insert verification gate', ({ root }) => write(root, 'backend-node/src/services/imageService.js', 'module.exports = {}'), '生成前'],
    ['explicit provider dispatch', ({ root }) => write(root, 'backend-node/src/services/imageClient.js', 'module.exports = {}'), '协议'],
    ['canvas credit contract', ({ root }) => {
      write(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', '<span>cost</span>');
      write(root, 'frontweb/src/views/FilmCreate.vue', '<span>cost</span>');
    }, 'canvas-credit-callout-v1'],
  ]) it(`rejects removal of ${name}`, () => {
    const fixture = makeFixture();
    try {
      mutate(fixture);
      assert.match(auditReleaseContract(fixture).join('\n'), new RegExp(expected, 'i'));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects GPT 4K exposure and extra image price tiers', () => {
    const fixture = makeFixture();
    try {
      const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath));
      evidence.results.push({
        ...evidence.results[0],
        marker: 'gpt-image-2-2-4k|text-to-image|4k|verified',
        requested_resolution: '4k',
        output_file: 'forbidden.png',
        public_url: 'https://molimama.vip/verification-assets/usmercari/forbidden.png',
      });
      fs.writeFileSync(fixture.evidencePath, JSON.stringify(evidence));
      assert.match(auditReleaseContract(fixture).join('\n'), /GPT 4K|真实验证组合/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects stale evidence and a validity window longer than seven days', () => {
    for (const mutate of [
      (evidence) => {
        const generatedAt = Date.now() - 25 * 60 * 60 * 1000;
        evidence.generated_at = new Date(generatedAt).toISOString();
        evidence.valid_until = new Date(generatedAt + 6 * 24 * 60 * 60 * 1000).toISOString();
      },
      (evidence) => {
        evidence.valid_until = new Date(Date.parse(evidence.generated_at) + 8 * 24 * 60 * 60 * 1000).toISOString();
      },
    ]) {
      const fixture = makeFixture();
      try {
        const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath));
        mutate(evidence);
        fs.writeFileSync(fixture.evidencePath, JSON.stringify(evidence));
        assert.match(auditReleaseContract(fixture).join('\n'), /过期|24 小时|7 天|有效期/);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('requires the exact protected public URL and matching safe output basename', () => {
    for (const mutate of [
      (item) => { item.public_url = item.public_url.replace('molimama.vip', 'assets.molimama.vip'); },
      (item) => { item.public_url = item.public_url.replace('/verification-assets/usmercari/', '/static/'); },
      (item) => { item.public_url = `${item.public_url}?download=1`; },
      (item) => { item.output_file = 'different.png'; },
      (item) => { item.output_file = 'unsafe.html'; item.public_url = 'https://molimama.vip/verification-assets/usmercari/unsafe.html'; },
    ]) {
      const fixture = makeFixture();
      try {
        const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath));
        mutate(evidence.results[0]);
        fs.writeFileSync(fixture.evidencePath, JSON.stringify(evidence));
        assert.match(auditReleaseContract(fixture).join('\n'), /公网绑定|成品/);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('requires two independent GPT 4K rejection attempts', () => {
    const fixture = makeFixture();
    try {
      const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath));
      evidence.rejected_capabilities[0].attempts = 1;
      fs.writeFileSync(fixture.evidencePath, JSON.stringify(evidence));
      assert.match(auditReleaseContract(fixture).join('\n'), /GPT 4K/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
