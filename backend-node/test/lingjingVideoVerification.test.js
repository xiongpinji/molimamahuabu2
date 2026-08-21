'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildReleaseEvidence,
  buildVerificationCase,
  buildVerificationRequest,
  decideResumeAction,
  downloadAndInspect,
  fetchPublicPricing,
  hasCompleteRequiredMatrix,
  runVerification,
} = require('../scripts/verify-lingjing-video-model');

function completedResult() {
  const startedAt = new Date('2026-08-10T00:00:00.000Z');
  const completedAt = new Date('2026-08-10T00:01:02.000Z');
  const item = buildVerificationCase();
  const request = buildVerificationRequest(item, {
    requestId: '69be7d12-f993-4ad9-bfc9-7f3201231119',
    reference: { bytes: Buffer.from('reference'), mimeType: 'image/png', filename: 'reference.png' },
  });
  return {
    id: item.id,
    model: item.model,
    upstream_model: item.upstreamModel,
    mode: item.mode,
    requested_duration: item.duration,
    requested_aspect_ratio: item.aspectRatio,
    requested_resolution: null,
    reference_count: 1,
    request_id: request.request_id,
    request: {
      model_key: 'relay',
      duration: 4,
      ratio: '16:9',
      reference_count: 1,
      request_id: request.request_id,
    },
    status: 'completed',
    submission_state: 'accepted',
    provider_task_id: '19502',
    provider_audit: {
      request_body_sha256: '1'.repeat(64),
      creation_response_sha256: '2'.repeat(64),
      creation_http_status: 200,
      terminal_response_sha256: '3'.repeat(64),
      terminal_http_status: 200,
      uploads: [{
        reference_sha256: '4'.repeat(64),
        upload_path: 'uploads/reference.png',
        upload_response_sha256: '5'.repeat(64),
        upload_http_status: 200,
      }],
      supplier_cost_unavailable: true,
      supplier_cost_fields: [],
    },
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
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
}

function pricingSnapshot() {
  return {
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
  };
}

test('Lingjing verification is exactly one 4-second image-reference case without resolution', () => {
  const item = buildVerificationCase();
  assert.deepEqual(item, {
    id: 'relay-image-4s',
    model: 'lingjing-video-v1',
    upstreamModel: 'relay',
    mode: 'omni',
    duration: 4,
    aspectRatio: '16:9',
  });
  const request = buildVerificationRequest(item, {
    requestId: '69be7d12-f993-4ad9-bfc9-7f3201231119',
    reference: { bytes: Buffer.from('reference'), mimeType: 'image/png', filename: 'reference.png' },
  });
  assert.equal(request.model, 'lingjing-video-v1');
  assert.equal(request.duration, 4);
  assert.equal(request.aspect_ratio, '16:9');
  assert.equal(request.reference_images.length, 1);
  assert.equal(request.resolution, undefined);
  assert.equal(request.generate_audio, undefined);
  assert.equal(request.reference_audio_urls, undefined);
  assert.equal(request.reference_audios, undefined);
});

test('Lingjing verification never retries an accepted, rejected or uncertain paid submission', () => {
  assert.equal(decideResumeAction(null), 'submit');
  assert.equal(decideResumeAction({ submission_state: 'submitting' }), 'stop-indeterminate');
  assert.equal(decideResumeAction({ submission_state: 'indeterminate' }), 'stop-indeterminate');
  assert.equal(decideResumeAction({ submission_state: 'rejected' }), 'stop-rejected');
  assert.equal(decideResumeAction({ status: 'failed' }), 'stop-rejected');
  assert.equal(decideResumeAction({ provider_task_id: '19502', status: 'processing' }), 'poll');
  assert.equal(decideResumeAction({ status: 'completed', artifact: { sha256: 'a'.repeat(64) } }), 'finalize');
});

test('Lingjing public pricing is bound to the documented relay capability snapshot', async () => {
  const raw = JSON.stringify({
    api_model_name: 'lingjing-video-v1',
    rmb_per_credit: 0.17,
    models: [{
      key: 'relay',
      billing_mode: 'per_second',
      price_per_second: 1,
      max_images: 9,
      max_videos: 0,
      max_audios: 0,
      audio_supported: false,
      allowed_durations: [4, 5, 6, 8, 10, 11, 15],
      allowed_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      resolutions: [],
    }],
  });
  const result = await fetchPublicPricing(async () => ({ ok: true, status: 200, text: async () => raw }), new Date('2026-08-10T00:01:05.000Z'));
  assert.equal(result.response_sha256, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.cost_yuan_per_second, 0.17);
  assert.equal(result.credits_per_second, 149);
  assert.deepEqual(result.allowed_durations, [4, 5, 6, 8, 10, 11, 15]);
  assert.deepEqual(result.resolutions, []);
});

test('Lingjing release evidence binds provider task, artifact, measured speed and public price', () => {
  const result = completedResult();
  assert.equal(hasCompleteRequiredMatrix([result]), true);
  const evidence = buildReleaseEvidence([result], pricingSnapshot(), new Date('2026-08-10T00:02:00.000Z'));
  assert.equal(evidence.contract_version, 'lingjing-video-real-verification-v1');
  assert.deepEqual(evidence.verification_scope.documented_capabilities.max_image_references, 9);
  assert.deepEqual(evidence.verification_scope.documented_capabilities.resolutions, []);
  assert.equal(evidence.results[0].provider_task_id, '19502');
  assert.equal(evidence.pricing.cost_yuan_per_second, 0.17);
  assert.equal(evidence.pricing.credits_per_second, 149);
  assert.equal(evidence.speed_evidence.cases[0].generation_elapsed_seconds, 62);
  assert.equal(evidence.results[0].provider_audit.request_body_sha256, '1'.repeat(64));
  assert.equal(evidence.results[0].provider_audit.creation_response_sha256, '2'.repeat(64));
  assert.equal(evidence.results[0].provider_audit.terminal_response_sha256, '3'.repeat(64));
  assert.equal(evidence.results[0].provider_audit.uploads[0].reference_sha256, '4'.repeat(64));
  assert.equal(evidence.results[0].provider_audit.supplier_cost_unavailable, true);
});

test('Lingjing output audio track is not treated as an audio-reference capability', () => {
  const result = completedResult();
  result.artifact.ffprobe.has_audio = true;
  result.artifact.ffprobe.audio_codec = 'aac';
  assert.equal(hasCompleteRequiredMatrix([result]), true);

  const evidence = buildReleaseEvidence([result], pricingSnapshot(), new Date('2026-08-10T00:02:00.000Z'));
  assert.equal(evidence.verification_scope.documented_capabilities.max_audio_references, 0);
  assert.equal(evidence.verification_scope.documented_capabilities.supports_audio, false);
  assert.equal(evidence.results[0].artifact.ffprobe.has_audio, true);
  assert.equal(evidence.results[0].artifact.ffprobe.audio_codec, 'aac');
});

test('Lingjing evidence fails closed when any request, response, upload or supplier-cost receipt binding is missing', () => {
  const fields = [
    'request_body_sha256',
    'creation_response_sha256',
    'terminal_response_sha256',
  ];
  for (const field of fields) {
    const result = completedResult();
    delete result.provider_audit[field];
    assert.equal(hasCompleteRequiredMatrix([result]), false, field);
  }
  const noUploadBinding = completedResult();
  noUploadBinding.provider_audit.uploads[0].reference_sha256 = 'invalid';
  assert.equal(hasCompleteRequiredMatrix([noUploadBinding]), false);
  const noCostDeclaration = completedResult();
  delete noCostDeclaration.provider_audit.supplier_cost_unavailable;
  assert.equal(hasCompleteRequiredMatrix([noCostDeclaration]), false);
});

test('Lingjing paid verification refuses to start without the exact explicit confirmation', async () => {
  let fetchCalls = 0;
  await assert.rejects(() => runVerification({
    env: {},
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
  }), /LINGJING_ONE_PAID_4S_IMAGE/);
  assert.equal(fetchCalls, 0);
});

test('Lingjing artifact download never overwrites an existing protected file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingjing-download-'));
  const target = path.join(root, 'relay-image-4s-19502.mp4');
  fs.writeFileSync(target, 'existing');
  let fetchCalls = 0;
  try {
    await assert.rejects(() => downloadAndInspect(
      { base_url: 'https://seed.alimyun.xyz/api/open/v1', api_key: 'redacted-test-key' },
      '19502',
      target,
      'https://molimama.vip/verification-assets/lingjing/relay-image-4s-19502.mp4',
      { fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); } },
    ), /已存在/);
    assert.equal(fetchCalls, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), 'existing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
