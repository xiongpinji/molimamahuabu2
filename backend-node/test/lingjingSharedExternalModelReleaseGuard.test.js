'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  LINGJING_CASE,
  PROVIDERS,
  auditLingjingRuntime,
} = require('../../deploy/release-guard/verify-external-model-release');

const GUARD = path.resolve(__dirname, '../../deploy/release-guard/verify-external-model-release.js');
const CONTRACT = 'lingjing-video-real-verification-v1';
const EVIDENCE_FILE = 'lingjing-video-verification.json';

function testRootEvidence(name, fn) {
  const requiresRootFixture = process.platform !== 'win32'
    && typeof process.getuid === 'function'
    && process.getuid() !== 0;
  return test(name, requiresRootFixture
    ? { skip: 'requires a root-owned release evidence fixture' }
    : {}, fn);
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function runtime(candidate) {
  write(candidate, 'backend-node/src/services/externalModelEvidenceService.js', `
    const MANIFEST_CONTRACT = 'external-model-release-evidence-manifest-v1';
    const contracts = ['toapis-video-real-verification-v1', 'usmercari-image-real-verification-v1', 'lingjing-video-real-verification-v1'];
    const MANIFEST_FILE = 'manifest.json';
    function hasTrustedEvidenceBinding(model, capabilities) {
      const trusted = readTrustedEvidence(model);
      return capabilities.evidence_contract === trusted.contract
        && capabilities.evidence_sha256 === trusted.sha256;
    }
  `);
  write(candidate, 'backend-node/src/services/lingjingVideoClient.js', `
    const PUBLIC_MODEL = 'lingjing-video-v1';
    const UPSTREAM_MODEL = 'relay';
    const OFFICIAL_ORIGIN = 'https://seed.alimyun.xyz';
    const OFFICIAL_BASE_URL = OFFICIAL_ORIGIN + '/api/open/v1';
    const DURATIONS = Object.freeze([4, 5, 6, 8, 10, 11, 15]);
    const RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);
    const MAX_IMAGE_REFERENCES = 9;
    function normalizeLingjingBaseUrl(value) {
      const parsed = new URL(value || OFFICIAL_BASE_URL);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'seed.alimyun.xyz') throw new Error('official only');
      return OFFICIAL_BASE_URL;
    }
    function buildLingjingUploadUrl(base) { return normalizeLingjingBaseUrl(base) + '/uploads'; }
    function buildLingjingCreateUrl(base) { return normalizeLingjingBaseUrl(base) + '/videos'; }
    function buildLingjingStatusUrl(base, id) { return normalizeLingjingBaseUrl(base) + '/videos/' + id; }
    function buildLingjingDownloadUrl(base, id) { return normalizeLingjingBaseUrl(base) + '/videos/' + id + '/download'; }
    function callLingjingVideoApi(config, log, opts, runtime) {
      if (runtime.captureAudit) return { provider_audit: { request_body_sha256: '', creation_response_sha256: '', reference_sha256: '', supplier_cost_unavailable: true } };
    }
    function fetchLingjingTask(config, id, runtime) {
      if (runtime.captureAudit) return { provider_audit: { terminal_response_sha256: '' } };
    }
  `);
  write(candidate, 'backend-node/src/services/videoClient.js', `
    function assertLingjingVideoSubmitReady(db, config, model, request) {
      if (config.verification_status !== 'verified') throw gate('MODEL_NOT_VERIFIED');
      if (!hasConnectionCredential(config)) throw gate('MODEL_CREDENTIAL_MISSING');
      const capabilities = config.verified_capabilities[model];
      if (!hasTrustedEvidenceBinding(model, capabilities)) throw gate('MODEL_NOT_VERIFIED');
      if (request.reference_urls.length > MAX_IMAGE_REFERENCES) throw gate('VIDEO_REFERENCE_LIMIT_EXCEEDED');
      const price = findPrice(model);
      if (!price) throw gate('MODEL_PRICE_NOT_CONFIGURED');
      calculateCharge(db, model, request.duration);
      return request;
    }
    async function callVideoApi(protocol, config, log, opts) {
      if (protocol === 'lingjing_open') {
        const checked = assertLingjingVideoSubmitReady(db, config, opts.model, opts);
        return lingjingVideoClient.callLingjingVideoApi(config, log, checked);
      }
      return null;
    }
  `);
  write(candidate, 'backend-node/src/services/videoService.js', `
    function verifiedCapabilitiesForModel(config, model) { return config.verified_capabilities[model]; }
    function lingjingReadyState(db, model) {
      const config = findConfig(model);
      const capabilities = verifiedCapabilitiesForModel(config, model);
      if (!config || config.verification_status !== 'verified' || !hasConnectionCredential(config)
          || !hasTrustedEvidenceBinding(model, capabilities)) throw videoRequestError('MODEL_NOT_VERIFIED');
      return { config, capabilities };
    }
    function create(db, body) {
      const state = lingjingReadyState(db, body.model);
      return reserveCredits(db, state, body);
    }
  `);
  for (const file of ['canvasModelCatalogService.js', 'modelPriceService.js']) {
    write(candidate, `backend-node/src/services/${file}`, `
      const STRICT_VERIFIED_PROTOCOLS = new Set(['lingjing_open']);
      function ready(config, price) {
        if (config.verification_status !== 'verified' || !hasConnectionCredential(config)) return false;
        const verified_capabilities = config.verified_capabilities;
        if (!hasTrustedEvidenceBinding(price.model, verified_capabilities[price.model])) return false;
        if (config.api_protocol === 'lingjing_open' && price.category === 'video') {
          return Object.values(price.resolution_prices || {}).every((item) => item.credits > 0);
        }
        return false;
      }
    `);
  }
  write(candidate, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', `
    <template><span v-if="canGenerate" class="billing-cost"><template v-if="estimatedCredits">本次预计扣除 <strong>{{ estimatedCredits }}</strong> 积分</template><template v-else>积分待管理员配置</template></span></template>
  `);
  write(candidate, 'frontweb/src/views/FilmCreate.vue', `
    <template>
      <span class="billing-cost canvas-credit-callout-v1"><strong>本次预计扣除 {{ imageCredits }}</strong><strong>积分待管理员配置</strong></span>
      <span class="billing-cost canvas-credit-callout-v1"><strong>本次预计扣除 {{ videoCredits }}</strong><strong>积分待管理员配置</strong></span>
    </template>
  `);
}

function makeEvidence(evidenceRoot, mutate = () => {}) {
  const now = Date.now();
  const startedAt = new Date(now - 63_000).toISOString();
  const completedAt = new Date(now - 1_000).toISOString();
  const generatedAt = new Date(now).toISOString();
  const outputFile = 'relay-image-4s-19502.mp4';
  const asset = Buffer.from('synthetic-lingjing-mp4-artifact');
  write(evidenceRoot, path.join('public', 'lingjing', outputFile), asset);
  const result = {
    id: 'relay-image-4s', model: 'lingjing-video-v1', upstream_model: 'relay', mode: 'omni',
    requested_duration: 4, requested_aspect_ratio: '16:9', requested_resolution: null,
    reference_count: 1, request_id: '69be7d12-f993-4ad9-bfc9-7f3201231119',
    request: { model_key: 'relay', duration: 4, ratio: '16:9', reference_count: 1, request_id: '69be7d12-f993-4ad9-bfc9-7f3201231119' },
    status: 'completed', submission_state: 'accepted', provider_task_id: '19502',
    provider_audit: {
      request_body_sha256: '1'.repeat(64), creation_response_sha256: '2'.repeat(64), creation_http_status: 200,
      terminal_response_sha256: '3'.repeat(64), terminal_http_status: 200,
      uploads: [{ reference_sha256: 'b'.repeat(64), upload_path: 'uploads/reference.png', upload_response_sha256: '4'.repeat(64), upload_http_status: 200 }],
      supplier_cost_unavailable: true, supplier_cost_fields: [],
    },
    started_at: startedAt, completed_at: completedAt,
    speed: { submit_latency_ms: 450, generation_elapsed_seconds: 62, download_latency_ms: 120, total_elapsed_seconds: 62.12 },
    artifact: {
      public_url: `https://molimama.vip/verification-assets/lingjing/${outputFile}`,
      output_file: outputFile, content_type: 'video/mp4', bytes: asset.length, sha256: sha256(asset),
      ffprobe: { format: 'mov,mp4,m4a,3gp,3g2,mj2', width: 1280, height: 720, duration_seconds: 4.1, video_codec: 'h264', has_audio: false, audio_codec: null },
    },
  };
  const evidence = {
    contract_version: CONTRACT, provider_origin: 'https://seed.alimyun.xyz', generated_at: generatedAt,
    valid_until: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    verification_scope: {
      public_model: 'lingjing-video-v1', upstream_model: 'relay',
      real_case: { duration: 4, aspect_ratio: '16:9', reference_images: 1, resolution: null },
      documented_capabilities: {
        durations: [4, 5, 6, 8, 10, 11, 15], aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], resolutions: [],
        max_image_references: 9, max_video_references: 0, max_audio_references: 0,
        supports_first_frame: false, supports_last_frame: false, supports_audio: false,
      },
      reference_image_sha256: 'b'.repeat(64),
    },
    results: [result],
    pricing: {
      provider_settings_url: 'https://seed.alimyun.xyz/api/public/settings', response_sha256: 'a'.repeat(64), captured_at: generatedAt,
      model_key: 'relay', public_model: 'lingjing-video-v1', billing_mode: 'per_second', price_per_second_credits: 1,
      rmb_per_credit: 0.17, cost_yuan_per_second: 0.17, credits_per_second: 149, reviewed: true,
    },
    speed_evidence: {
      measurement_basis: 'actual_paid_verification_run_not_provider_sla',
      cases: [{ id: result.id, model: result.model, submit_latency_ms: 450, generation_elapsed_seconds: 62, download_latency_ms: 120, total_elapsed_seconds: 62.12 }],
    },
  };
  mutate(evidence);
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  write(evidenceRoot, EVIDENCE_FILE, bytes);
  write(evidenceRoot, 'manifest.json', `${JSON.stringify({
    contract_version: 'external-model-release-evidence-manifest-v1',
    evidence: { [CONTRACT]: { file: EVIDENCE_FILE, sha256: sha256(bytes) } },
  }, null, 2)}\n`);
}

function fixture(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingjing-shared-guard-'));
  if (process.platform !== 'win32') fs.chmodSync(root, 0o755);
  const candidate = path.join(root, 'candidate');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(candidate);
  fs.mkdirSync(evidenceRoot);
  runtime(candidate);
  makeEvidence(evidenceRoot, mutate);
  return { root, candidate, evidenceRoot };
}

function run(item, expectedCurrent = item.candidate) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/evidence.*(?:path|root)|(?:path|root).*evidence|verify.*output.*dir/i.test(key)) delete env[key];
  return spawnSync(process.execPath, [GUARD, item.candidate, item.evidenceRoot, expectedCurrent], { encoding: 'utf8', env, windowsHide: true });
}

test('shared external-model guard registers the isolated Lingjing evidence contract', () => {
  assert.deepEqual(PROVIDERS.lingjing, {
    label: 'Lingjing video',
    contract: 'lingjing-video-real-verification-v1',
    evidenceFile: 'lingjing-video-verification.json',
    clientFile: 'backend-node/src/services/lingjingVideoClient.js',
    markers: PROVIDERS.lingjing.markers,
    surfaceFiles: PROVIDERS.lingjing.surfaceFiles,
  });
  assert.deepEqual(LINGJING_CASE, {
    id: 'relay-image-4s',
    model: 'lingjing-video-v1',
    upstreamModel: 'relay',
    mode: 'omni',
    duration: 4,
    aspectRatio: '16:9',
  });
});

test('shared guard audits the real candidate Lingjing runtime without changing legacy providers', () => {
  assert.doesNotThrow(() => auditLingjingRuntime(path.resolve(__dirname, '..', '..')));
});

testRootEvidence('shared guard accepts the complete isolated Lingjing runtime and evidence', () => {
  const item = fixture();
  try {
    const result = run(item);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /providers=lingjing/);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

testRootEvidence('shared guard accepts an output audio track while Lingjing audio-reference input stays disabled', () => {
  const item = fixture((evidence) => {
    evidence.results[0].artifact.ffprobe.has_audio = true;
    evidence.results[0].artifact.ffprobe.audio_codec = 'aac';
  });
  try {
    const result = run(item);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('providers=lingjing'), true);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

for (const [name, mutate, expected] of [
  ['task id', (value) => { value.results[0].provider_task_id = ''; }, /task/i],
  ['task-to-artifact binding', (value) => { value.results[0].provider_task_id = 'other-task'; }, /output|artifact/i],
  ['request binding', (value) => { value.results[0].request.reference_count = 2; }, /request|binding/i],
  ['request digest', (value) => { value.results[0].provider_audit.request_body_sha256 = ''; }, /request|digest|binding/i],
  ['creation response digest', (value) => { value.results[0].provider_audit.creation_response_sha256 = ''; }, /response|digest|binding/i],
  ['terminal response digest', (value) => { value.results[0].provider_audit.terminal_response_sha256 = ''; }, /response|digest|binding/i],
  ['upload binding', (value) => { value.results[0].provider_audit.uploads[0].reference_sha256 = 'c'.repeat(64); }, /upload|reference|binding/i],
  ['supplier cost declaration', (value) => { delete value.results[0].provider_audit.supplier_cost_unavailable; }, /cost|supplier/i],
  ['capability', (value) => { value.verification_scope.documented_capabilities.max_image_references = 30; }, /capability/i],
  ['speed', (value) => { value.speed_evidence.cases[0].generation_elapsed_seconds = 1; }, /speed/i],
  ['price', (value) => { value.pricing.credits_per_second = 150; }, /price/i],
]) testRootEvidence(`shared guard rejects Lingjing ${name} drift`, () => {
  const item = fixture(mutate);
  try {
    const result = run(item);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, expected);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

testRootEvidence('shared guard rejects a missing Lingjing evidence file', () => {
  const item = fixture();
  try {
    fs.rmSync(path.join(item.evidenceRoot, EVIDENCE_FILE));
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Lingjing|evidence|missing/i);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

testRootEvidence('shared guard recomputes the Lingjing artifact hash', () => {
  const item = fixture();
  try {
    fs.appendFileSync(path.join(item.evidenceRoot, 'public', 'lingjing', 'relay-image-4s-19502.mp4'), 'tamper');
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bytes|SHA-256|asset/i);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

testRootEvidence('shared guard rejects a configurable Lingjing provider origin', () => {
  const item = fixture();
  try {
    const target = path.join(item.candidate, 'backend-node/src/services/lingjingVideoClient.js');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('https://seed.alimyun.xyz', 'https://attacker.example'));
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /origin|official|host/i);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

testRootEvidence('shared guard rejects a Lingjing client that cannot capture immutable request and response receipts', () => {
  const item = fixture();
  try {
    const target = path.join(item.candidate, 'backend-node/src/services/lingjingVideoClient.js');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/request_body_sha256/g, 'request_digest_removed'));
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /audit|receipt|request/i);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

testRootEvidence('shared guard rejects the Lingjing final gate moved after provider submission', () => {
  const item = fixture();
  try {
    const target = path.join(item.candidate, 'backend-node/src/services/videoClient.js');
    const source = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, source.replace(
      `const checked = assertLingjingVideoSubmitReady(db, config, opts.model, opts);\n        return lingjingVideoClient.callLingjingVideoApi(config, log, checked);`,
      `const response = lingjingVideoClient.callLingjingVideoApi(config, log, opts);\n        assertLingjingVideoSubmitReady(db, config, opts.model, opts);\n        return response;`,
    ));
    const result = run(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /before provider submission|final.*gate/i);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
