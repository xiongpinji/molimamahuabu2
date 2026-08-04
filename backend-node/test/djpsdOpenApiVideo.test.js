const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildDjpsdOpenApiSubmitBody,
  callDjpsdOpenApiVideoApi,
  callVideoApi,
  getSupportedVideoDurationsForModel,
  normalizeVideoDurationForModel,
  pollVideoTask,
} = require('../src/services/videoClient');

const log = {
  info() {},
  warn() {},
  error() {},
};

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('视频客户端保留分镜服务依赖的模型时长能力接口', () => {
  assert.equal(getSupportedVideoDurationsForModel('seedance 2.0'), null);
  assert.deepEqual(
    getSupportedVideoDurationsForModel('lingjing-video-v1'),
    [4, 5, 6, 8, 10, 11, 15],
  );
  assert.equal(normalizeVideoDurationForModel('seedance 2.0', 9), 9);
  assert.equal(normalizeVideoDurationForModel('lingjing-video-v1', 9), 10);
});

test('DJPSD 开放 API 保留平台参数并默认启用自动人脸处理', () => {
  assert.deepEqual(buildDjpsdOpenApiSubmitBody({
    model: 'video-v1',
    prompt: '母女在花园中缓慢前行',
    duration: 7,
    aspect_ratio: '9:16',
    images: ['/uploads/reference.png'],
  }), {
    model: 'video-v1',
    prompt: '母女在花园中缓慢前行',
    params: {
      duration: 7,
      aspect_ratio: '9:16',
      auto_face_mask: true,
      images: ['/uploads/reference.png'],
    },
  });

  assert.equal(buildDjpsdOpenApiSubmitBody({
    auto_face_mask: false,
  }).params.auto_face_mask, false);
});

test('DJPSD 开放 API 上传参考图后创建 video-v1 异步任务', async () => {
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/v1/media/upload')) {
      assert.equal(options.headers.Authorization, 'Bearer secret');
      assert.equal(options.body.get('file') instanceof Blob, true);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ url: '/uploads/reference.png' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        request_id: 'req-1',
        task_id: 321,
        task_status: 'PENDING',
      }),
    };
  };

  const result = await callDjpsdOpenApiVideoApi({
    provider: 'djpsd_openapi',
    api_protocol: 'djpsd_openapi',
    base_url: 'https://shiping.djpsd.com/v1',
    api_key: 'secret',
  }, log, {
    model: 'video-v1',
    prompt: '镜头缓慢推进',
    duration: 9,
    aspect_ratio: '16:9',
    first_frame_url: 'data:image/png;base64,aGVsbG8=',
  });

  assert.equal(requests[0].url, 'https://shiping.djpsd.com/v1/media/upload');
  assert.equal(requests[1].url, 'https://shiping.djpsd.com/v1/media/generate');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    model: 'video-v1',
    prompt: '镜头缓慢推进',
    params: {
      duration: 9,
      aspect_ratio: '16:9',
      auto_face_mask: true,
      images: ['/uploads/reference.png'],
    },
  });
  assert.deepEqual(result, { task_id: '321', status: 'PENDING' });
});

test('DJPSD 开放 API 优先从本地存储读取受保护的 static 参考图', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djpsd-static-ref-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const relativePath = path.join('projects', 'test', 'reference.jpg');
  const localFile = path.join(storageRoot, relativePath);
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]));

  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/v1/media/upload')) {
      const uploaded = Buffer.from(await options.body.get('file').arrayBuffer());
      assert.deepEqual(uploaded, fs.readFileSync(localFile));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ url: '/uploads/local-reference.jpg' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ task_id: 987, task_status: 'PENDING' }),
    };
  };

  const result = await callDjpsdOpenApiVideoApi({
    base_url: 'https://shiping.djpsd.com',
    api_key: 'secret',
  }, log, {
    model: 'video-v1',
    prompt: '测试本地参考图',
    duration: 10,
    first_frame_url: '/static/projects/test/reference.jpg',
    files_base_url: 'https://molimama.vip/static',
    storage_local_path: storageRoot,
  });

  assert.deepEqual(result, { task_id: '987', status: 'PENDING' });
  assert.deepEqual(requests.map((item) => item.url), [
    'https://shiping.djpsd.com/v1/media/upload',
    'https://shiping.djpsd.com/v1/media/generate',
  ]);
});

test('DJPSD 开放 API 拒绝把 Bearer 发送到跨域自定义端点', async () => {
  let requested = false;
  global.fetch = async () => {
    requested = true;
    throw new Error('不应发起请求');
  };

  const result = await callDjpsdOpenApiVideoApi({
    base_url: 'https://shiping.djpsd.com',
    api_key: 'secret',
    endpoint: 'https://example.com/v1/media/generate',
  }, log, {
    model: 'video-v1',
    prompt: '测试',
    duration: 5,
  });

  assert.equal(requested, false);
  assert.match(result.error, /必须与 Base URL 同源/);
});

test('DJPSD 开放 API 拒绝把非图片 data URL 作为参考图上传', async () => {
  let requested = false;
  global.fetch = async () => {
    requested = true;
    throw new Error('不应发起请求');
  };

  const result = await callDjpsdOpenApiVideoApi({
    base_url: 'https://shiping.djpsd.com',
    api_key: 'secret',
  }, log, {
    model: 'video-v1',
    prompt: '测试',
    duration: 5,
    first_frame_url: 'data:text/plain;base64,aGVsbG8=',
  });

  assert.equal(requested, false);
  assert.match(result.error, /只允许图片 data URL/);
});

test('video-v1 通过生产 callVideoApi 入口路由到 DJPSD 开放 API', async () => {
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ task_id: 654, task_status: 'PENDING' }),
    };
  };
  const row = {
    id: 7,
    service_type: 'video',
    provider: 'djpsd_openapi',
    api_protocol: 'djpsd_openapi',
    name: 'DJPSD 开放 API',
    base_url: 'https://shiping.djpsd.com',
    api_key: 'secret',
    model: JSON.stringify(['video-v1']),
    default_model: 'video-v1',
    endpoint: '/v1/media/generate',
    query_endpoint: '/v1/media/status?task_id={taskId}',
    priority: 0,
    is_default: 1,
    is_active: 1,
    settings: null,
  };
  const db = {
    prepare(sql) {
      return {
        all: () => sql.includes('SELECT * FROM ai_service_configs') ? [row] : [],
      };
    },
  };

  const result = await callVideoApi(db, log, {
    model: 'video-v1',
    prompt: '测试路由',
    duration: 10,
  });

  assert.equal(requestedUrl, 'https://shiping.djpsd.com/v1/media/generate');
  assert.deepEqual(result, { task_id: '654', status: 'PENDING' });
});

test('DJPSD 开放 API 轮询使用 state/is_final 并补全相对视频地址', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        task_id: 321,
        state: 'success',
        is_final: true,
        progress: '100%',
        result_url: '/uploads/video/result.mp4',
        video_url: '',
        result_type: 'video',
        error: '',
      }),
    };
  };

  const result = await pollVideoTask(null, log, 1, '321', {
    provider: 'djpsd_openapi',
    api_protocol: 'djpsd_openapi',
    base_url: 'https://shiping.djpsd.com/v1',
    api_key: 'secret',
    query_endpoint: '/v1/media/status?task_id={taskId}',
  }, 1, 0);

  assert.equal(request.url, 'https://shiping.djpsd.com/v1/media/status?task_id=321');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(result, {
    video_url: 'https://shiping.djpsd.com/uploads/video/result.mp4',
  });
});
