const test = require('node:test');
const assert = require('node:assert/strict');

const { callVideoApi, pollVideoTask } = require('../src/services/videoClient');
const { callToapisVideoApi, TOAPIS_VIDEO_MODELS } = require('../src/services/toapisVideoClient');

const log = { info() {}, warn() {}, error() {} };

function configRow(model) {
  return {
    id: model === 'seedance-2-fast' ? 71 : 72,
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_video',
    base_url: 'https://toapis.com',
    api_key: 'secret-key',
    model: JSON.stringify([model]),
    default_model: model,
    is_default: true,
    is_active: true,
  };
}

function configDb(row) {
  return {
    prepare(sql) {
      return { all: () => sql.includes('SELECT * FROM ai_service_configs') ? [row] : [] };
    },
  };
}

test('ToAPIs Fast and Mini both preserve two reference images through the shared video route', async (t) => {
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-fast'].maxReferences, 9);
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-mini'].maxReferences, 9);

  const originalSecret = process.env.PLATFORM_JWT_SECRET;
  process.env.PLATFORM_JWT_SECRET = 'test-provider-asset-secret-at-least-32-characters';
  t.after(() => {
    if (originalSecret == null) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = originalSecret;
  });

  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    const calls = [];
    const submitted = await callVideoApi(configDb(configRow(model)), log, {
      model,
      prompt: '保持两张参考图中的人物和服装一致',
      duration: 4,
      resolution: '480p',
      aspect_ratio: '16:9',
      reference_urls: [
        'https://molimama.vip/static/projects/0039/reference-1.png',
        'https://cdn.example.com/reference-2.png',
      ],
      files_base_url: 'https://molimama.vip/static',
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ task_id: `task-${model}`, status: 'queued' }),
        };
      },
    });

    assert.deepEqual(submitted, { task_id: `task-${model}`, status: 'queued' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://toapis.com/v1/videos/generations');
    assert.equal(calls[0].body.image_with_roles.length, 2);
    assert.deepEqual(calls[0].body.image_with_roles.map((item) => item.role), [
      'reference_image',
      'reference_image',
    ]);
    const signed = new URL(calls[0].body.image_with_roles[0].url);
    assert.equal(signed.pathname, '/static/projects/0039/reference-1.png');
    assert.ok(signed.searchParams.get('provider_asset_signature'));
    assert.equal(calls[0].body.image_with_roles[1].url, 'https://cdn.example.com/reference-2.png');
  }
});

test('shared video polling reads the ToAPIs task endpoint', async () => {
  const row = configRow('seedance-2-fast');
  let requestedUrl = '';
  const completed = await pollVideoTask(null, log, row.id, 'task-fast-1', row, 1, 0, {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: 'completed',
          result: { data: [{ url: 'https://cdn.example.com/result.mp4' }] },
        }),
      };
    },
  });

  assert.equal(requestedUrl, 'https://toapis.com/v1/videos/generations/task-fast-1');
  assert.deepEqual(completed, { video_url: 'https://cdn.example.com/result.mp4' });
});

test('ToAPIs interrupted POST keeps structured submission-unknown metadata', async () => {
  const error = new Error('socket closed');
  error.code = 'ECONNRESET';
  const result = await callToapisVideoApi(configRow('seedance-2-fast'), log, {
    model: 'seedance-2-fast',
    prompt: 'test',
    duration: 4,
    resolution: '480p',
    aspect_ratio: '16:9',
  }, { fetchImpl: async () => { throw error; } });

  assert.equal(result.indeterminate, true);
  assert.match(result.error, /不得自动重试/);
  assert.deepEqual(result.route_meta, {
    phase: 'submit',
    requestBodySent: true,
    transportCode: 'ECONNRESET',
  });
});
