const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { synthesize } = require('../src/services/ttsService');
const { createRedrawProviderAdapters } = require('../src/services/redrawProviderAdapters');
const validMp3Bytes = require('./fixtures/minimalMp3');

function listen(server) {
  return new Promise((resolve, reject) => {
    const running = server.listen(0, '127.0.0.1', () => resolve(running));
    running.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function minimaxOptions(storageRoot, port) {
  return {
    text: 'Welcome home.',
    storyboard_id: null,
    storage_base: storageRoot,
    config: {
      provider: 'minimax',
      base_url: `http://127.0.0.1:${port}/v1`,
      api_key: 'server-side-test-key',
      default_model: 'speech-2.8-hd',
      settings: '{}',
    },
    voice_id: 'English_Trustworthy_Man',
  };
}

function openaiOptions(storageRoot, port) {
  return {
    text: 'Welcome home.',
    storyboard_id: null,
    storage_base: storageRoot,
    config: {
      provider: 'openai',
      base_url: `http://127.0.0.1:${port}/v1`,
      api_key: 'server-side-test-key',
      default_model: 'tts-1',
      settings: '{}',
    },
    voice_id: 'alloy',
  };
}

function isUnknownWithoutFabricatedTaskId(error) {
  return error?.code === 'PROVIDER_STATUS_UNKNOWN'
    && error?.unknown === true
    && error?.provider_task_id == null;
}

test('MiniMax T2A 使用管理员 Base URL 并传递音频节点参数', async (t) => {
  let capturedPath = '';
  let capturedAuth = '';
  let capturedBody = null;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      capturedPath = req.url;
      capturedAuth = req.headers.authorization;
      capturedBody = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: { audio: validMp3Bytes.toString('hex'), status: 2 },
        extra_info: { audio_length: 1250 },
        trace_id: 'minimax-trace-real-1',
        base_resp: { status_code: 0, status_msg: 'success' },
      }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-tts-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const result = await synthesize({}, { info() {} }, {
    text: '重庆银行欢迎您',
    storyboard_id: null,
    storage_base: storageRoot,
    config: {
      provider: 'minimax',
      base_url: `http://127.0.0.1:${server.address().port}/v1`,
      api_key: 'server-side-test-key',
      default_model: 'speech-2.8-hd',
      settings: '{}',
    },
    voice_id: 'Chinese (Mandarin)_Reliable_Executive',
    speed: 1.15,
    volume: 1.2,
    pitch: -2,
    emotion: 'disgusted',
    pronunciation_tones: ['重庆/(chong2)(qing4)', '银行/(yin2)(hang2)'],
    locale: 'en-US',
  });

  assert.equal(capturedPath, '/v1/t2a_v2');
  assert.equal(capturedAuth, 'Bearer server-side-test-key');
  assert.deepEqual(capturedBody, {
    model: 'speech-2.8-hd',
    text: '重庆银行欢迎您',
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: 'Chinese (Mandarin)_Reliable_Executive',
      speed: 1.15,
      vol: 1.2,
      pitch: -2,
      emotion: 'disgusted',
    },
    pronunciation_dict: {
      tone: ['重庆/(chong2)(qing4)', '银行/(yin2)(hang2)'],
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  });
  assert.match(result.local_path, /^audio\/tts_sbx_/);
  assert.deepEqual(fs.readFileSync(path.join(storageRoot, result.local_path)), validMp3Bytes);
  assert.equal(result.status, 'completed');
  assert.equal(result.provider_task_id, 'minimax-trace-real-1');
  assert.equal(result.invocation_id, 'minimax-trace-real-1');
  assert.equal(result.voice_id, 'Chinese (Mandarin)_Reliable_Executive');
  assert.equal(result.duration, 1.25);
  assert.equal(result.provider, 'minimax');
  assert.equal(result.model, 'speech-2.8-hd');
  assert.equal(result.language_verified, false);
  assert.equal(result.detected_locale, null);
  assert.equal(result.locale, undefined);
  assert.deepEqual(result.metadata, {
    provider: 'minimax',
    model: 'speech-2.8-hd',
    provider_task_id: 'minimax-trace-real-1',
    provider_status: 2,
    voice_id: 'Chinese (Mandarin)_Reliable_Executive',
    voice_id_source: 'provider_request',
    duration: 1.25,
    duration_source: 'provider_extra_info_audio_length',
    language_verified: false,
    detected_locale: null,
  });
});

test('MiniMax 未返回 trace id 或语言检测时不伪造本地任务 ID 或请求 locale', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: { audio: validMp3Bytes.toString('hex'), status: 2 },
        extra_info: { audio_length: 500 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-tts-no-trace-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const result = await synthesize({}, { info() {} }, {
    text: 'Welcome home.',
    storyboard_id: null,
    storage_base: storageRoot,
    config: {
      provider: 'minimax',
      base_url: `http://127.0.0.1:${server.address().port}/v1`,
      api_key: 'server-side-test-key',
      default_model: 'speech-2.8-hd',
      settings: '{}',
    },
    voice_id: 'English_Trustworthy_Man',
    locale: 'en-US',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.provider_task_id, null);
  assert.equal(result.invocation_id, null);
  assert.equal(result.language_verified, false);
  assert.equal(result.detected_locale, null);
  assert.equal(result.locale, undefined);
  assert.equal(result.metadata.provider_task_id, null);
});

test('转绘适配器使用真实 ttsService 返回 MiniMax 审计字段并对语言验证 fail closed', async (t) => {
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.voice_setting.voice_id, 'English_Trustworthy_Man');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: { audio: validMp3Bytes.toString('hex'), status: 2 },
        extra_info: { audio_length: 1250 },
        trace_id: 'minimax-trace-adapter-1',
        base_resp: { status_code: 0, status_msg: 'success' },
      }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-redraw-adapter-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const adapter = createRedrawProviderAdapters({
    db: {},
    log: { info() {}, warn() {}, error() {} },
    cfg: { storage: { local_path: storageRoot } },
    ttsConfig: {
      provider: 'minimax',
      base_url: `http://127.0.0.1:${server.address().port}/v1`,
      api_key: 'server-side-test-key',
      default_model: 'speech-2.8-hd',
      settings: '{}',
    },
    assetService: {
      create(_db, _log, payload) {
        return { id: 88, ...payload };
      },
    },
  });

  const result = await adapter.generateAsset({
    taskId: 123,
    versionId: 8,
    model: 'speech-2.8-hd',
    provider: 'minimax',
    locale: 'en-US',
    market: 'US',
    asset: {
      id: 6,
      kind: 'voice',
      prompt: 'Welcome home.',
      source_ref_json: JSON.stringify({
        source_ref: { voice_id: 'English_Trustworthy_Man' },
        snapshot: { model: 'speech-2.8-hd', provider: 'minimax' },
      }),
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.provider_task_id, 'minimax-trace-adapter-1');
  assert.equal(result.duration, 1.25);
  assert.equal(result.voice_evidence.provider, 'minimax');
  assert.equal(result.voice_evidence.model, 'speech-2.8-hd');
  assert.equal(result.voice_evidence.voice_id, 'English_Trustworthy_Man');
  assert.equal(result.voice_evidence.task_id, 'minimax-trace-adapter-1');
  assert.equal(result.voice_evidence.terminal_status, 'completed');
  assert.equal(result.voice_evidence.duration_ms, 1250);
  assert.equal(result.voice_evidence.language_verified, false);
  assert.equal(result.voice_evidence.detected_locale, null);
});

test('MiniMax 200 非 JSON 响应作为供应商状态未知返回而不异步崩溃', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":');
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-invalid-json-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, minimaxOptions(storageRoot, server.address().port)),
    isUnknownWithoutFabricatedTaskId,
  );
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('MiniMax 2xx 成功响应缺少音频时保留真实 trace 并标记状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'trace-id': 'minimax-missing-audio-trace',
      });
      res.end(JSON.stringify({
        data: { status: 2 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-missing-audio-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, minimaxOptions(storageRoot, server.address().port)),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.provider_task_id === 'minimax-missing-audio-trace',
  );
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('MiniMax 200 JSON 缺少明确业务状态码时保留 body trace 并标记状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ trace_id: 'minimax-missing-status-trace', data: {} }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-missing-status-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, minimaxOptions(storageRoot, server.address().port)),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.provider_task_id === 'minimax-missing-status-trace',
  );
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('MiniMax 2xx 成功响应的非法 hex 或损坏 MP3 均标记状态未知', async (t) => {
  for (const [name, audio] of [['invalid-hex', 'zz11'], ['invalid-mp3', '00010203']]) {
    await t.test(name, async (subtest) => {
      const provider = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, {
            'content-type': 'application/json',
            'trace-id': `minimax-${name}-trace`,
          });
          res.end(JSON.stringify({
            data: { audio, status: 2 },
            base_resp: { status_code: 0, status_msg: 'success' },
          }));
        });
      });
      const server = await listen(provider);
      subtest.after(() => close(server));
      const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `minimax-${name}-`));
      subtest.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

      await assert.rejects(
        () => synthesize({}, { info() {} }, minimaxOptions(storageRoot, server.address().port)),
        (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
          && error?.provider_task_id === `minimax-${name}-trace`,
      );
      assert.deepEqual(fs.readdirSync(storageRoot), []);
    });
  }
});

test('OpenAI-compatible 2xx 空或损坏音频保留 request id 并标记状态未知', async (t) => {
  for (const [name, audio] of [['empty', Buffer.alloc(0)], ['invalid', Buffer.from('not-an-mp3')]]) {
    await t.test(name, async (subtest) => {
      const provider = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, {
            'content-type': 'audio/mpeg',
            'x-request-id': `openai-${name}-audio-request-id`,
          });
          res.end(audio);
        });
      });
      const server = await listen(provider);
      subtest.after(() => close(server));
      const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `openai-${name}-audio-`));
      subtest.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

      await assert.rejects(
        () => synthesize({}, { info() {} }, openaiOptions(storageRoot, server.address().port)),
        (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
          && error?.provider_task_id === `openai-${name}-audio-request-id`,
      );
      assert.deepEqual(fs.readdirSync(storageRoot), []);
    });
  }
});

test('MiniMax 已完成后本地写入失败保留 trace 并标记 provider completed 状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: { audio: validMp3Bytes.toString('hex'), status: 2 },
        trace_id: 'minimax-local-write-trace',
        base_resp: { status_code: 0, status_msg: 'success' },
      }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const invalidStorageRoot = path.join(os.tmpdir(), `minimax-storage-file-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(invalidStorageRoot, 'not a directory');
  t.after(() => fs.rmSync(invalidStorageRoot, { force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, minimaxOptions(invalidStorageRoot, server.address().port)),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.provider_completed === true
      && error?.provider_task_id === 'minimax-local-write-trace',
  );
});

test('OpenAI-compatible 已完成后本地写入失败保留 request id 并标记状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'x-request-id': 'openai-local-write-request-id',
      });
      res.end(validMp3Bytes);
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const invalidStorageRoot = path.join(os.tmpdir(), `openai-storage-file-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(invalidStorageRoot, 'not a directory');
  t.after(() => fs.rmSync(invalidStorageRoot, { force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, openaiOptions(invalidStorageRoot, server.address().port)),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.provider_completed === true
      && error?.provider_task_id === 'openai-local-write-request-id',
  );
});

test('MiniMax 5xx 响应保留真实 trace header 并标记供应商状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(503, {
        'content-type': 'application/json',
        'trace-id': 'minimax-503-trace',
      });
      res.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'busy' } }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-5xx-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, minimaxOptions(storageRoot, server.address().port)),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.unknown === true
      && error?.provider_task_id === 'minimax-503-trace',
  );
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('MiniMax 200 响应读取中断标记供应商状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'trace-id': 'minimax-aborted-trace',
      });
      res.flushHeaders();
      res.write('{"data":');
      setImmediate(() => res.destroy());
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-aborted-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, minimaxOptions(storageRoot, server.address().port)),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.unknown === true
      && error?.provider_task_id === 'minimax-aborted-trace',
  );
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('MiniMax POST 网络错误标记供应商状态未知且不伪造 task id', async () => {
  const provider = http.createServer();
  const server = await listen(provider);
  const port = server.address().port;
  await close(server);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-network-error-'));
  try {
    await assert.rejects(
      () => synthesize({}, { info() {} }, minimaxOptions(storageRoot, port)),
      isUnknownWithoutFabricatedTaskId,
    );
    assert.deepEqual(fs.readdirSync(storageRoot), []);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('MiniMax 建连后无响应在受控超时内标记状态未知且不重提', { timeout: 1000 }, async (t) => {
  let requestCount = 0;
  const sockets = new Set();
  const provider = http.createServer((req) => {
    requestCount += 1;
    req.resume();
  });
  provider.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const server = await listen(provider);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await close(server);
  });
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-no-response-timeout-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, {
      ...minimaxOptions(storageRoot, server.address().port),
      timeout_ms: 40,
    }),
    (error) => isUnknownWithoutFabricatedTaskId(error)
      && /timeout|超时/i.test(error?.message || ''),
  );
  assert.equal(requestCount, 1);
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('MiniMax 收到 trace 响应头但 body 不结束时超时保留真实 task id', { timeout: 1000 }, async (t) => {
  let requestCount = 0;
  const sockets = new Set();
  const provider = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'trace-id': 'minimax-hanging-body-trace',
      });
      res.flushHeaders();
      res.write('{"data":');
    });
  });
  provider.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const server = await listen(provider);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await close(server);
  });
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-hanging-body-timeout-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const options = minimaxOptions(storageRoot, server.address().port);
  options.config.settings = JSON.stringify({ timeout_ms: 40 });

  await assert.rejects(
    () => synthesize({}, { info() {} }, options),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.unknown === true
      && error?.provider_task_id === 'minimax-hanging-body-trace'
      && /timeout|超时/i.test(error?.message || ''),
  );
  assert.equal(requestCount, 1);
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('OpenAI-compatible 建连后无响应在受控超时内标记状态未知且不重提', { timeout: 1000 }, async (t) => {
  let requestCount = 0;
  const sockets = new Set();
  const provider = http.createServer((req) => {
    requestCount += 1;
    req.resume();
  });
  provider.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const server = await listen(provider);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await close(server);
  });
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-no-response-timeout-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, {
      ...openaiOptions(storageRoot, server.address().port),
      timeout_ms: 40,
    }),
    (error) => isUnknownWithoutFabricatedTaskId(error)
      && /timeout|超时/i.test(error?.message || ''),
  );
  assert.equal(requestCount, 1);
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('OpenAI-compatible 响应读取中断保留真实 request id 并标记状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'x-request-id': 'openai-aborted-request-id',
      });
      res.flushHeaders();
      res.write(validMp3Bytes.subarray(0, 8));
      setImmediate(() => res.destroy());
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-aborted-response-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, {
      ...openaiOptions(storageRoot, server.address().port),
      timeout_ms: 500,
    }),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.unknown === true
      && error?.provider_task_id === 'openai-aborted-request-id',
  );
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('OpenAI-compatible 5xx 保留真实 request id 并标记供应商状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(502, {
        'content-type': 'application/json',
        'x-request-id': 'openai-502-request-id',
      });
      res.end(JSON.stringify({ error: { message: 'upstream unavailable' } }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-5xx-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, openaiOptions(storageRoot, server.address().port)),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.unknown === true
      && error?.provider_task_id === 'openai-502-request-id',
  );
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('MiniMax 响应 Content-Length 超限时保留真实 trace 并标记状态未知', async (t) => {
  let requestCount = 0;
  const provider = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '4096',
        'trace-id': 'minimax-oversize-length-trace',
      });
      res.end('x'.repeat(4096));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-oversize-length-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const options = minimaxOptions(storageRoot, server.address().port);
  options.config.settings = JSON.stringify({ max_response_bytes: 128 });

  await assert.rejects(
    () => synthesize({}, { info() {} }, options),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.provider_task_id === 'minimax-oversize-length-trace'
      && /too large|limit|超限|超过/i.test(error?.message || ''),
  );
  assert.equal(requestCount, 1);
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('MiniMax 分块响应累计超限时中止读取且不重提', async (t) => {
  let requestCount = 0;
  const provider = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'trace-id': 'minimax-oversize-stream-trace',
      });
      res.write('{"data":{"audio":"');
      res.write('a'.repeat(128));
      res.end('"}}');
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-oversize-stream-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const options = minimaxOptions(storageRoot, server.address().port);
  options.config.settings = JSON.stringify({ max_response_bytes: 64 });

  await assert.rejects(
    () => synthesize({}, { info() {} }, options),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.provider_task_id === 'minimax-oversize-stream-trace',
  );
  assert.equal(requestCount, 1);
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('OpenAI-compatible 分块音频累计超限时保留 request id 且不重提', async (t) => {
  let requestCount = 0;
  const provider = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'x-request-id': 'openai-oversize-stream-request-id',
      });
      res.write(Buffer.alloc(48, 0xff));
      res.write(Buffer.alloc(48, 0xff));
      res.end(Buffer.alloc(48, 0xff));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-oversize-stream-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const options = openaiOptions(storageRoot, server.address().port);
  options.config.settings = JSON.stringify({ max_response_bytes: 64 });

  await assert.rejects(
    () => synthesize({}, { info() {} }, options),
    (error) => error?.code === 'PROVIDER_STATUS_UNKNOWN'
      && error?.provider_task_id === 'openai-oversize-stream-request-id',
  );
  assert.equal(requestCount, 1);
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('OpenAI-compatible POST 网络错误标记状态未知且不伪造 task id', async () => {
  const provider = http.createServer();
  const server = await listen(provider);
  const port = server.address().port;
  await close(server);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-network-error-'));
  try {
    await assert.rejects(
      () => synthesize({}, { info() {} }, openaiOptions(storageRoot, port)),
      isUnknownWithoutFabricatedTaskId,
    );
    assert.deepEqual(fs.readdirSync(storageRoot), []);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('OpenAI-compatible 4xx 是确定失败而非状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad request' } }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-4xx-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, openaiOptions(storageRoot, server.address().port)),
    (error) => /OpenAI TTS HTTP 400/.test(error?.message || '')
      && error?.code !== 'PROVIDER_STATUS_UNKNOWN'
      && error?.unknown !== true,
  );
});

test('MiniMax 4xx 是确定失败而非状态未知', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'bad request' } }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-4xx-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => synthesize({}, { info() {} }, minimaxOptions(storageRoot, server.address().port)),
    (error) => /MiniMax TTS HTTP 400/.test(error?.message || '')
      && error?.code !== 'PROVIDER_STATUS_UNKNOWN'
      && error?.unknown !== true,
  );
});
