'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LINGJING_VIDEO_SPEC,
  normalizeLingjingBaseUrl,
  buildLingjingModelsUrl,
  buildLingjingUploadUrl,
  buildLingjingCreateUrl,
  buildLingjingStatusUrl,
  buildLingjingDownloadUrl,
  buildLingjingVideoBody,
  parseLingjingTask,
  callLingjingVideoApi,
  fetchLingjingTask,
} = require('../src/services/lingjingVideoClient');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test('Lingjing contract pins official origin and endpoints', () => {
  assert.equal(normalizeLingjingBaseUrl('https://seed.alimyun.xyz/api/open/v1/'), 'https://seed.alimyun.xyz/api/open/v1');
  assert.equal(buildLingjingModelsUrl(), 'https://seed.alimyun.xyz/api/open/v1/models');
  assert.equal(buildLingjingUploadUrl(), 'https://seed.alimyun.xyz/api/open/v1/uploads');
  assert.equal(buildLingjingCreateUrl(), 'https://seed.alimyun.xyz/api/open/v1/videos');
  assert.equal(buildLingjingStatusUrl(undefined, 'task/1'), 'https://seed.alimyun.xyz/api/open/v1/videos/task%2F1');
  assert.equal(buildLingjingDownloadUrl(undefined, 'task/1'), 'https://seed.alimyun.xyz/api/open/v1/videos/task%2F1/download');
  for (const baseUrl of [
    'http://seed.alimyun.xyz/api/open/v1',
    'https://evil.example/api/open/v1',
    'https://seed.alimyun.xyz.evil.example/api/open/v1',
    'https://user:pass@seed.alimyun.xyz/api/open/v1',
    'https://seed.alimyun.xyz/api/open/v2',
  ]) {
    assert.throws(() => normalizeLingjingBaseUrl(baseUrl), /官方已审核域名/);
  }
});

test('Lingjing builds relay request without unsupported fields', () => {
  assert.deepEqual(buildLingjingVideoBody({
    model: 'lingjing-video-v1',
    prompt: '雨后森林中的小猫缓慢前行',
    duration: 4,
    aspect_ratio: '16:9',
    reference_image_paths: ['uploads/a.png'],
    request_id: 'audit-uuid',
    resolution: '720p',
    generate_audio: true,
  }), {
    model_key: 'relay',
    prompt: '雨后森林中的小猫缓慢前行',
    duration: 4,
    ratio: '16:9',
    reference_images: ['uploads/a.png'],
    request_id: 'audit-uuid',
  });
  assert.deepEqual(LINGJING_VIDEO_SPEC.resolutions, []);
});

test('Lingjing rejects unverified capabilities instead of truncating or coercing', () => {
  const base = {
    model: 'lingjing-video-v1',
    prompt: 'animate',
    duration: 4,
    aspect_ratio: '16:9',
    reference_image_paths: ['uploads/a.png'],
    request_id: 'request-1',
  };
  assert.throws(() => buildLingjingVideoBody({ ...base, model: 'relay' }), /公开模型/);
  assert.throws(() => buildLingjingVideoBody({ ...base, duration: 7 }), /不支持 7 秒/);
  assert.throws(() => buildLingjingVideoBody({ ...base, aspect_ratio: '2:1' }), /不支持画幅/);
  assert.throws(() => buildLingjingVideoBody({ ...base, request_id: '' }), /request_id/);
  assert.throws(() => buildLingjingVideoBody({ ...base, reference_image_paths: Array.from({ length: 10 }, (_, index) => `uploads/${index}.png`) }), /最多支持 9 张/);
  assert.throws(() => buildLingjingVideoBody({ ...base, reference_video_urls: ['https://example.com/ref.mp4'] }), /不支持视频参考/);
  assert.throws(() => buildLingjingVideoBody({ ...base, reference_audio_urls: ['https://example.com/ref.mp3'] }), /不支持音频参考/);
  assert.throws(() => buildLingjingVideoBody({ ...base, first_frame_url: 'https://example.com/first.png' }), /不支持首尾帧/);
  assert.throws(() => buildLingjingVideoBody({ ...base, last_frame_url: 'https://example.com/last.png' }), /不支持首尾帧/);
});

test('Lingjing uploads ordered images then creates one relay task', async () => {
  const calls = [];
  let uploadIndex = 0;
  const result = await callLingjingVideoApi({
    base_url: 'https://seed.alimyun.xyz/api/open/v1',
    api_key: 'secret-test-key',
  }, { info() {} }, {
    model: 'lingjing-video-v1',
    prompt: 'animate reference',
    duration: 4,
    aspect_ratio: '9:16',
    request_id: 'request-1',
    reference_images: [
      { bytes: Buffer.from('one'), mimeType: 'image/png', filename: 'one.png' },
      { bytes: Buffer.from('two'), mimeType: 'image/jpeg', filename: 'two.jpg' },
    ],
  }, {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/uploads')) {
        uploadIndex += 1;
        return jsonResponse({ path: `uploads/ref-${uploadIndex}.png` });
      }
      return jsonResponse({ id: 19502, status: 'pending' });
    },
  });

  assert.deepEqual(result, { task_id: '19502', status: 'pending' });
  assert.equal(calls.filter((call) => call.url.endsWith('/uploads')).length, 2);
  assert.equal(calls.filter((call) => call.url.endsWith('/videos')).length, 1);
  assert.equal(calls[0].options.body instanceof FormData, true);
  const submitted = JSON.parse(calls[2].options.body);
  assert.equal(submitted.model_key, 'relay');
  assert.equal(submitted.request_id, 'request-1');
  assert.deepEqual(submitted.reference_images, ['uploads/ref-1.png', 'uploads/ref-2.png']);
  assert.equal('resolution' in submitted, false);
});

test('Lingjing verification capture binds the exact request, responses and uploaded reference without changing normal callers', async () => {
  const uploadRaw = JSON.stringify({ path: 'uploads/ref-1.png' });
  const createRaw = JSON.stringify({ id: 19502, status: 'pending' });
  const result = await callLingjingVideoApi({
    base_url: 'https://seed.alimyun.xyz/api/open/v1',
    api_key: 'secret-test-key',
  }, { info() {} }, {
    model: 'lingjing-video-v1',
    prompt: 'animate reference',
    duration: 4,
    aspect_ratio: '16:9',
    request_id: 'request-1',
    reference_images: [
      { bytes: Buffer.from('one'), mimeType: 'image/png', filename: 'one.png' },
    ],
  }, {
    captureAudit: true,
    fetchImpl: async (url) => String(url).endsWith('/uploads')
      ? { ok: true, status: 200, text: async () => uploadRaw }
      : { ok: true, status: 200, text: async () => createRaw },
  });

  assert.equal(result.task_id, '19502');
  assert.match(result.provider_audit.request_body_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.provider_audit.creation_response_sha256,
    require('node:crypto').createHash('sha256').update(createRaw).digest('hex'));
  assert.equal(result.provider_audit.creation_http_status, 200);
  assert.deepEqual(result.provider_audit.uploads, [{
    reference_sha256: require('node:crypto').createHash('sha256').update('one').digest('hex'),
    upload_path: 'uploads/ref-1.png',
    upload_response_sha256: require('node:crypto').createHash('sha256').update(uploadRaw).digest('hex'),
    upload_http_status: 200,
  }]);
  assert.equal(result.provider_audit.supplier_cost_unavailable, true);
  assert.deepEqual(result.provider_audit.supplier_cost_fields, []);
});

test('Lingjing terminal audit hashes the exact provider response and preserves explicit cost fields without interpreting currency', async () => {
  const raw = JSON.stringify({ id: 19502, status: 'completed', cost: 4 });
  const result = await fetchLingjingTask({
    base_url: 'https://seed.alimyun.xyz/api/open/v1',
    api_key: 'secret-test-key',
  }, '19502', {
    captureAudit: true,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => raw }),
  });

  assert.equal(result.state, 'completed');
  assert.equal(result.provider_audit.terminal_response_sha256,
    require('node:crypto').createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.provider_audit.terminal_http_status, 200);
  assert.equal(result.provider_audit.supplier_cost_unavailable, false);
  assert.deepEqual(result.provider_audit.supplier_cost_fields, [
    { source: 'terminal', field: 'cost', value: 4 },
  ]);
});

test('Lingjing parses terminal status and uses fixed download endpoint only', () => {
  assert.deepEqual(parseLingjingTask({ id: 7, status: 'pending' }), { state: 'processing', taskId: '7' });
  assert.deepEqual(parseLingjingTask({ id: 7, status: 'completed', video_url: 'https://cdn.example.com/out.mp4' }), {
    state: 'completed', taskId: '7', videoUrl: 'https://cdn.example.com/out.mp4', needsDownload: false,
  });
  assert.deepEqual(parseLingjingTask({ id: 7, status: 'completed' }), {
    state: 'completed', taskId: '7', videoUrl: '', needsDownload: true,
  });
  assert.deepEqual(parseLingjingTask({ id: 7, status: 'failed', error: 'bad request' }), {
    state: 'failed', taskId: '7', error: 'bad request',
  });
});
