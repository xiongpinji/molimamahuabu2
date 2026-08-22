'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { auditReleaseContract } = require('../scripts/verify-lingjing-video-release-contract');

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function evidence() {
  const requestId = '69be7d12-f993-4ad9-bfc9-7f3201231119';
  const result = {
    id: 'relay-image-4s',
    model: 'lingjing-video-v1',
    upstream_model: 'relay',
    mode: 'omni',
    requested_duration: 4,
    requested_aspect_ratio: '16:9',
    requested_resolution: null,
    reference_count: 1,
    request_id: requestId,
    request: { model_key: 'relay', duration: 4, ratio: '16:9', reference_count: 1, request_id: requestId },
    status: 'completed',
    submission_state: 'accepted',
    provider_task_id: '19502',
    provider_audit: {
      request_body_sha256: '1'.repeat(64), creation_response_sha256: '2'.repeat(64), creation_http_status: 200,
      terminal_response_sha256: '3'.repeat(64), terminal_http_status: 200,
      uploads: [{ reference_sha256: 'b'.repeat(64), upload_path: 'uploads/reference.png', upload_response_sha256: '4'.repeat(64), upload_http_status: 200 }],
      supplier_cost_unavailable: true, supplier_cost_fields: [],
    },
    started_at: '2026-08-10T00:00:00.000Z',
    completed_at: '2026-08-10T00:01:02.000Z',
    speed: {
      submit_latency_ms: 450,
      generation_elapsed_seconds: 62,
      download_latency_ms: 120,
      total_elapsed_seconds: 62.12,
    },
    artifact: {
      public_url: 'https://molimama.vip/verification-assets/lingjing/relay-image-4s-19502.mp4',
      output_file: 'relay-image-4s-19502.mp4',
      content_type: 'video/mp4',
      bytes: 4096,
      sha256: crypto.createHash('sha256').update('video').digest('hex'),
      ffprobe: {
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        width: 1280,
        height: 720,
        duration_seconds: 4.1,
        video_codec: 'h264',
        has_audio: false,
        audio_codec: null,
      },
    },
  };
  return {
    contract_version: 'lingjing-video-real-verification-v1',
    provider_origin: 'https://seed.alimyun.xyz',
    generated_at: '2026-08-10T00:02:00.000Z',
    valid_until: '2026-08-17T00:02:00.000Z',
    verification_scope: {
      public_model: 'lingjing-video-v1',
      upstream_model: 'relay',
      real_case: { duration: 4, aspect_ratio: '16:9', reference_images: 1, resolution: null },
      documented_capabilities: {
        durations: [4, 5, 6, 8, 10, 11, 15],
        aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
        resolutions: [],
        max_image_references: 9,
        max_video_references: 0,
        max_audio_references: 0,
        supports_first_frame: false,
        supports_last_frame: false,
        supports_audio: false,
      },
      reference_image_sha256: 'b'.repeat(64),
    },
    results: [result],
    pricing: {
      provider_settings_url: 'https://seed.alimyun.xyz/api/public/settings',
      response_sha256: 'a'.repeat(64),
      captured_at: '2026-08-10T00:01:05.000Z',
      model_key: 'relay',
      public_model: 'lingjing-video-v1',
      billing_mode: 'per_second',
      price_per_second_credits: 1,
      rmb_per_credit: 0.17,
      cost_yuan_per_second: 0.17,
      credits_per_second: 149,
      reviewed: true,
    },
    speed_evidence: {
      measurement_basis: 'actual_paid_verification_run_not_provider_sla',
      cases: [{
        id: result.id,
        model: result.model,
        submit_latency_ms: 450,
        generation_elapsed_seconds: 62,
        download_latency_ms: 120,
        total_elapsed_seconds: 62.12,
      }],
    },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingjing-release-contract-'));
  write(root, 'backend-node/src/services/lingjingVideoClient.js', `
    const PUBLIC_MODEL = 'lingjing-video-v1';
    const UPSTREAM_MODEL = 'relay';
    const OFFICIAL_ORIGIN = 'https://seed.alimyun.xyz';
    const OFFICIAL_BASE_URL = \`\${OFFICIAL_ORIGIN}/api/open/v1\`;
    const DURATIONS = [4, 5, 6, 8, 10, 11, 15];
    const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
    const MAX_IMAGE_REFERENCES = 9;
    function callLingjingVideoApi() {}
    function fetchLingjingTask() {}
  `);
  write(root, 'backend-node/src/services/videoClient.js', `
    if (protocol === 'lingjing_open') return lingjingVideoClient.callLingjingVideoApi(config, log, opts);
    function assertLingjingVideoSubmitReady() {}
  `);
  write(root, 'backend-node/src/services/videoService.js', `
    function lingjingReadyState() {
      return hasTrustedEvidenceBinding(model, capabilities, evidenceRoots)
        && maxReferences <= lingjingVideoClient.MAX_IMAGE_REFERENCES;
    }
  `);
  write(root, 'backend-node/src/services/canvasModelCatalogService.js', `
    const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video', 'feituo_open', 'lingjing_open']);
    const verified_capabilities = config.verified_capabilities;
    if (config.verification_status !== 'verified') return false;
  `);
  write(root, 'backend-node/src/services/modelPriceService.js', `
    const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video', 'feituo_open', 'lingjing_open']);
    if (protocol === 'lingjing_open' && price.category === 'video' && price.price > 0 && price.cost > 0) return true;
  `);
  write(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', '<strong class="canvas-credit-callout-v1">本次预计扣除</strong>');
  write(root, 'frontweb/src/views/FilmCreate.vue', '<strong class="canvas-credit-callout-v1">本次预计扣除</strong>');
  const evidencePath = path.join(root, 'docs/evidence/lingjing-video-verification.json');
  write(root, 'docs/evidence/lingjing-video-verification.json', `${JSON.stringify(evidence(), null, 2)}\n`);
  return { root, evidencePath };
}

function editEvidence(item, mutate) {
  const value = JSON.parse(fs.readFileSync(item.evidencePath, 'utf8'));
  mutate(value);
  fs.writeFileSync(item.evidencePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe('Lingjing protected release contract', () => {
  it('accepts the complete isolated contract', () => {
    const item = fixture();
    try { assert.deepEqual(auditReleaseContract(item), []); } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
  });

  for (const [name, mutate, expected] of [
    ['dedicated protocol dispatch', ({ root }) => write(root, 'backend-node/src/services/videoClient.js', 'module.exports = {}'), '协议'],
    ['pre-side-effect evidence gate', ({ root }) => write(root, 'backend-node/src/services/videoService.js', 'function lingjingReadyState() { return true; }'), '创建前'],
    ['strict catalog gate', ({ root }) => write(root, 'backend-node/src/services/canvasModelCatalogService.js', 'module.exports = {}'), '目录'],
    ['exact one paid case', (item) => editEvidence(item, (value) => value.results.push(value.results[0])), '一个'],
    ['request binding', (item) => editEvidence(item, (value) => { value.results[0].request.model_key = 'other'; }), '请求'],
    ['normalized request digest', (item) => editEvidence(item, (value) => { value.results[0].provider_audit.request_body_sha256 = ''; }), '请求|绑定'],
    ['creation response digest', (item) => editEvidence(item, (value) => { value.results[0].provider_audit.creation_response_sha256 = ''; }), '请求|绑定'],
    ['terminal response digest', (item) => editEvidence(item, (value) => { value.results[0].provider_audit.terminal_response_sha256 = ''; }), '请求|绑定'],
    ['reference upload binding', (item) => editEvidence(item, (value) => { value.results[0].provider_audit.uploads[0].reference_sha256 = 'c'.repeat(64); }), '上传|能力'],
    ['supplier cost declaration', (item) => editEvidence(item, (value) => { delete value.results[0].provider_audit.supplier_cost_unavailable; }), '请求|绑定'],
    ['unique task id', (item) => editEvidence(item, (value) => { value.results[0].provider_task_id = ''; }), '任务'],
    ['task-to-artifact binding', (item) => editEvidence(item, (value) => { value.results[0].provider_task_id = 'other-task'; }), '任务|成品'],
    ['readable artifact metadata', (item) => editEvidence(item, (value) => { value.results[0].artifact.ffprobe.video_codec = ''; }), '成品'],
    ['measured speed', (item) => editEvidence(item, (value) => { value.speed_evidence.cases[0].generation_elapsed_seconds = 1; }), '速度'],
    ['documented capability', (item) => editEvidence(item, (value) => { value.verification_scope.documented_capabilities.max_image_references = 30; }), '能力'],
    ['exact reviewed price', (item) => editEvidence(item, (value) => { value.pricing.credits_per_second = 150; }), '价格'],
    ['canvas credit contract', ({ root }) => {
      write(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', '<span>cost</span>');
      write(root, 'frontweb/src/views/FilmCreate.vue', '<span>cost</span>');
    }, 'canvas-credit-callout-v1'],
  ]) {
    it(`rejects mutated ${name}`, () => {
      const item = fixture();
      try {
        mutate(item);
        assert.match(auditReleaseContract(item).join('\n'), new RegExp(expected));
      } finally {
        fs.rmSync(item.root, { recursive: true, force: true });
      }
    });
  }
});
