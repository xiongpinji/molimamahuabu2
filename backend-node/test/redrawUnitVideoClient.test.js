'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const fumin = require('../src/services/fuminVideoClient');
const toapis = require('../src/services/toapisVideoClient');
const feituo = require('../src/services/feituoVideoClient');

// Only the transport boundary is synthetic. No client, builder, parser, DB, or resolver is mocked.
const servicePath = path.join(__dirname, '../src/services/redrawUnitVideoClient.js');
const FIXTURE_KEY = 'g4-fixture-only-not-a-real-key';
const RESULT_URL = 'https://outputs.example.test/candidate.mp4';
const PREFLIGHT = 'REDRAW_UNIT_VIDEO_PREFLIGHT_INVALID';
const protocols = [
  { name: 'fumin_video', base: 'https://fumin.example.test', model: 'fumin-seedance-2.0-fast',
    build: fumin.buildFuminVideoBody, id: (value) => ({ id: value }),
    url: (value) => ({ content: { video_url: value } }) },
  { name: 'toapis_video', base: 'https://toapis.cn', model: 'seedance-2-fast',
    build: toapis.buildToapisVideoBody, id: (value) => ({ task_id: value }),
    url: (value) => ({ result: { data: [{ url: value }] } }) },
  { name: 'feituo_open', base: 'https://feituo.example.test', model: 'xuan-seedance-2.5',
    build: feituo.buildFeituoVideoBody, id: (value) => ({ jobId: value }),
    url: (value) => ({ remoteVideoUrl: value }) },
];

function service() {
  assert.equal(fs.existsSync(servicePath), true, 'G4.4a single-unit transport service is not implemented');
  const value = require(servicePath);
  assert.equal(typeof value.submitRedrawUnitVideo, 'function', 'single-submit export is required');
  assert.equal(typeof value.queryRedrawUnitVideo, 'function', 'single-query export is required');
  return value;
}

function input(protocol, opts = {}) {
  return {
    protocol: protocol.name,
    config: { base_url: protocol.base, api_key: FIXTURE_KEY },
    opts: { model: protocol.model, prompt: 'G4 fixture prompt 中文', duration: 5,
      aspect_ratio: '16:9', resolution: '480p', generate_audio: true, ...opts },
  };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

async function submit(protocol, payload, { status = 200, opts = {}, runtime = {} } = {}) {
  const calls = [];
  const result = await service().submitRedrawUnitVideo(input(protocol, opts), {
    beforeSubmit: () => true,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response(payload, status); },
    ...runtime,
  });
  assert.equal(calls.length, 1, 'one observed POST and no automatic retry');
  assert.equal(calls[0].init.method, 'POST');
  return result;
}

function safeResult(result, expectedStatus, expectedId) {
  assert.equal(result.status, expectedStatus);
  assert.equal(result.provider_task_id, expectedId);
  assert.ok(Object.keys(result).every((key) => ['status', 'provider_task_id', 'result_url', 'safe_stage'].includes(key)));
  assert.doesNotMatch(JSON.stringify(result), /g4-fixture-only|G4 fixture prompt|provider-secret|private-recovery/);
  assert.notEqual(result.status, 'approved');
}

async function rejectedBeforePost(protocol, changeInput, changeRuntime = {}) {
  let posts = 0;
  const value = input(protocol);
  changeInput(value);
  await assert.rejects(() => service().submitRedrawUnitVideo(value, {
    fetchImpl: async () => { posts += 1; return response(protocol.id('unexpected')); },
    beforeSubmit: () => true,
    ...changeRuntime,
  }), (error) => {
    assert.equal(error.code, PREFLIGHT);
    assert.equal(error.message, 'Redraw unit video preflight rejected');
    return true;
  });
  assert.equal(posts, 0);
}

for (const protocol of protocols) {
  test(`${protocol.name}: actual legacy body and exact configured credential reach one POST after synchronous hash marker`, async () => {
    const value = input(protocol, {
      reference_urls: ['https://assets.example.test/ref.png', 'https://assets.example.test/ref.png'],
      reference_video_urls: ['https://assets.example.test/motion.mp4'],
      reference_audio_urls: ['https://assets.example.test/voice.mp3'],
      ...(protocol.name === 'toapis_video' ? { client_business_id: 'private-recovery-1' } : {}),
    });
    const expectedBody = JSON.stringify(protocol.build(value.opts));
    const events = [];
    const result = await service().submitRedrawUnitVideo(value, {
      beforeSubmit(marker) {
        events.push('marker');
        assert.deepEqual(marker, { request_hash: createHash('sha256').update(expectedBody, 'utf8').digest('hex') });
        return true;
      },
      async fetchImpl(url, init) {
        events.push('fetch');
        assert.deepEqual(events, ['marker', 'fetch']);
        const expectedUrl = protocol.name === 'fumin_video' ? fumin.buildFuminCreateUrl(value.config)
          : protocol.name === 'toapis_video' ? 'https://toapis.cn/v1/videos/generations'
            : `${protocol.base}/api/open/v1/video/generate`;
        assert.equal(url, expectedUrl);
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, `Bearer ${FIXTURE_KEY}`);
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.equal(init.body, expectedBody);
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        return response({ ...protocol.id('provider-1'), status: 'queued', message: 'Task created successfully' });
      },
    });
    assert.deepEqual(events, ['marker', 'fetch']);
    safeResult(result, 'accepted', 'provider-1');
  });

  test(`${protocol.name}: legacy ID-only submit remains accepted and business recovery ID never replaces provider ID`, async () => {
    safeResult(await submit(protocol, { ...protocol.id('provider-1'), message: 'Task created successfully' }), 'accepted', 'provider-1');
    safeResult(await submit(protocol, { client_business_id: 'private-recovery-1', recoveryTaskId: 'private-recovery-2' }, {
      opts: protocol.name === 'toapis_video' ? { client_business_id: 'private-recovery-1' } : {},
    }), 'submission_unknown', undefined);
  });

  for (const [state, expected] of [
    ['accepted', 'accepted'], ['queued', 'accepted'], ['submitted', 'accepted'],
    ['processing', 'running'], ['running', 'running'], ['in_progress', 'running'],
    ['failed', 'failed_terminal'], ['cancelled', 'failed_terminal'],
    ['completed', 'result_unavailable'], ['success', 'result_unavailable'],
    ['unknown', 'submission_unknown'], ['invented_status', 'submission_unknown'],
  ]) {
    test(`${protocol.name}: complete payload status ${state} maps to ${expected}`, async () => {
      safeResult(await submit(protocol, { ...protocol.id('provider-1'), status: state }), expected, 'provider-1');
    });
  }

  test(`${protocol.name}: queued or running without real ID is unknown`, async () => {
    for (const status of ['queued', 'processing']) safeResult(await submit(protocol, { status }), 'submission_unknown', undefined);
  });

  test(`${protocol.name}: explicit completion exposes an internal candidate URL, never approval`, async () => {
    const result = await submit(protocol, { ...protocol.id('provider-1'), status: 'completed', ...protocol.url(RESULT_URL) });
    safeResult(result, 'completed_candidate', 'provider-1');
    assert.equal(result.result_url, RESULT_URL);
  });

  test(`${protocol.name}: protocol direct-URL submit compatibility is preserved`, async () => {
    const result = await submit(protocol, protocol.url(RESULT_URL));
    safeResult(result, protocol.name === 'toapis_video' ? 'submission_unknown' : 'completed_candidate', undefined);
    if (protocol.name !== 'toapis_video') assert.equal(result.result_url, RESULT_URL);
  });

  for (const [label, extra] of [
    ['failed plus artifact', { status: 'failed', ...protocol.url(RESULT_URL) }],
    ['success plus structured error', { status: 'success', error: { message: 'provider-secret' }, ...protocol.url(RESULT_URL) }],
    ['accepted plus structured error', { status: 'queued', error: { code: 'REJECTED', message: 'provider-secret' } }],
    ['accepted plus artifact', { status: 'queued', ...protocol.url(RESULT_URL) }],
    ['success false plus artifact', { success: false, ...protocol.url(RESULT_URL) }],
    ['explicit unknown plus artifact', { status: 'unknown', ...protocol.url(RESULT_URL) }],
  ]) {
    test(`${protocol.name}: ${label} is unknown while retaining a valid ID`, async () => {
      safeResult(await submit(protocol, { ...protocol.id('provider-1'), ...extra }), 'submission_unknown', 'provider-1');
    });
  }

  for (const forbidden of ['fetchImpl', 'resolve_image', 'resolve_media', 'request_timeout_ms', 'response_max_bytes', 'apiKey', 'env', 'retry', 'watermark', 'seed']) {
    test(`${protocol.name}: opts.${forbidden} is rejected before any POST`, async () => {
      await rejectedBeforePost(protocol, (value) => { value.opts[forbidden] = () => 'never execute'; });
    });
  }

  test(`${protocol.name}: invalid model and missing exact Key are preflight failures`, async () => {
    await rejectedBeforePost(protocol, (value) => { value.opts.model = 'not-verified'; });
    await rejectedBeforePost(protocol, (value) => { value.config.api_key = ''; });
  });

  for (const [label, callback] of [
    ['missing', undefined], ['false', () => false], ['undefined', () => undefined],
    ['throw', () => { throw new Error('provider-secret'); }], ['async', async () => true],
    ['thenable', () => ({ then() { throw new Error('must not await'); } })],
  ]) {
    test(`${protocol.name}: ${label} beforeSubmit cannot be disguised by legacy client catch`, async () => {
      await rejectedBeforePost(protocol, () => {}, { beforeSubmit: callback });
    });
  }

  test(`${protocol.name}: cancellation before marker or inside marker sends no POST`, async () => {
    const aborted = new AbortController();
    aborted.abort();
    let markers = 0;
    await rejectedBeforePost(protocol, () => {}, { signal: aborted.signal, beforeSubmit() { markers += 1; return true; } });
    assert.equal(markers, 0);
    const controller = new AbortController();
    await rejectedBeforePost(protocol, () => {}, { signal: controller.signal, beforeSubmit() { controller.abort(); return true; } });
  });

  test(`${protocol.name}: input accessors cannot drift a prebuilt body or connection`, async () => {
    for (const [object, key] of [['opts', 'prompt'], ['config', 'base_url']]) {
      let reads = 0;
      await rejectedBeforePost(protocol, (value) => {
        Object.defineProperty(value[object], key, { enumerable: true, get() { reads += 1; return `drift-${reads}`; } });
      });
      assert.equal(reads, 0);
    }
  });

  for (const status of [400, 401, 413, 422, 429]) {
    test(`${protocol.name}: HTTP ${status} only becomes failed for an unambiguous structured rejection`, async () => {
      safeResult(await submit(protocol, { error: { code: 'INVALID_ARGUMENT', message: 'provider-secret' } }, { status }), 'failed_terminal', undefined);
      safeResult(await submit(protocol, { message: 'not accepted' }, { status }), 'submission_unknown', undefined);
      safeResult(await submit(protocol, { ...protocol.id('provider-1'), error: { message: 'provider-secret' } }, { status }), 'submission_unknown', 'provider-1');
      safeResult(await submit(protocol, { status: 'completed', ...protocol.url(RESULT_URL), error: 'provider-secret' }, { status }), 'submission_unknown', undefined);
    });
  }

  for (const status of [302, 403, 404, 408, 500, 503]) {
    test(`${protocol.name}: HTTP ${status} is unknown even with an error-shaped response`, async () => {
      safeResult(await submit(protocol, { ...protocol.id('provider-1'), error: 'provider-secret' }, { status }), 'submission_unknown', 'provider-1');
    });
  }

  for (const [label, fetchImpl] of [
    ['network interruption', async () => { throw new Error('provider-secret'); }],
    ['non-JSON', async () => new Response('provider-secret')],
    ['JSON primitive', async () => response('provider-secret')],
    ['JSON array', async () => response([{ status: 'success' }])],
    ['body read failure', async () => ({ ok: true, status: 200, text: async () => { throw new Error('provider-secret'); } })],
  ]) {
    test(`${protocol.name}: ${label} is safe unknown with exactly one transport attempt`, async () => {
      let calls = 0;
      const result = await service().submitRedrawUnitVideo(input(protocol), {
        beforeSubmit: () => true,
        fetchImpl: (...args) => { calls += 1; return fetchImpl(...args); },
      });
      assert.equal(calls, 1);
      safeResult(result, 'submission_unknown', undefined);
    });
  }

  test(`${protocol.name}: declared and streaming response byte limits produce unknown`, async () => {
    for (const fetchImpl of [
      async () => new Response('x', { headers: { 'content-length': '1024' } }),
      async () => new Response('中'.repeat(100)),
      async () => ({ ok: true, status: 200, text: async () => '中'.repeat(100) }),
    ]) {
      const result = await service().submitRedrawUnitVideo(input(protocol), { beforeSubmit: () => true, fetchImpl, responseMaxBytes: 64 });
      safeResult(result, 'submission_unknown', undefined);
    }
  });

  test(`${protocol.name}: fetch and body-read timeout are bounded even when the substitute ignores abort`, async () => {
    for (const fetchImpl of [
      () => new Promise(() => {}),
      async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) }),
    ]) {
      let requestSignal;
      let calls = 0;
      const result = await service().submitRedrawUnitVideo(input(protocol), {
        beforeSubmit: () => true, requestTimeoutMs: 10,
        fetchImpl: (url, init) => { calls += 1; requestSignal = init.signal; return fetchImpl(url, init); },
      });
      assert.equal(calls, 1);
      assert.equal(requestSignal.aborted, true);
      safeResult(result, 'submission_unknown', undefined);
    }
  });

  test(`${protocol.name}: non-scalar, overlong, control-bearing, or credential-valued IDs are not leaked`, async () => {
    for (const id of [{ nested: 'provider-secret' }, ['provider-secret'], 'x'.repeat(1000), 'id\nunsafe', FIXTURE_KEY]) {
      safeResult(await submit(protocol, { ...protocol.id(id), status: 'queued' }), 'submission_unknown', undefined);
    }
  });

  test(`${protocol.name}: credential echo in result URL is suppressed without damaging ordinary signed URLs`, async () => {
    const leaked = await submit(protocol, { ...protocol.id('provider-1'), status: 'completed', ...protocol.url(`${RESULT_URL}?token=${FIXTURE_KEY}`) });
    safeResult(leaked, 'submission_unknown', 'provider-1');
    assert.equal(leaked.result_url, undefined);
    const signedUrl = `${RESULT_URL}?download_token=ordinary-download-signature`;
    const safe = await submit(protocol, { ...protocol.id('provider-1'), status: 'completed', ...protocol.url(signedUrl) });
    safeResult(safe, 'completed_candidate', 'provider-1');
    assert.equal(safe.result_url, signedUrl);
  });

  test(`${protocol.name}: abnormal status values are bounded unknown instead of implicitly accepted`, async () => {
    for (const status of [{ error: 'provider-secret' }, ['queued'], 'x'.repeat(1000), 'queued\u0000unsafe']) {
      safeResult(await submit(protocol, { ...protocol.id('provider-1'), status }), 'submission_unknown', 'provider-1');
    }
  });

  test(`${protocol.name}: query uses one protocol GET with exact Key and preserves the known ID`, async () => {
    const value = input(protocol);
    const providerId = 'query/id:1';
    let calls = 0;
    const result = await service().queryRedrawUnitVideo({ protocol: protocol.name, config: value.config, provider_task_id: providerId }, {
      async fetchImpl(url, init) {
        calls += 1;
        assert.equal(init.method, 'GET');
        assert.equal(init.body, undefined);
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, `Bearer ${FIXTURE_KEY}`);
        if (protocol.name === 'fumin_video') assert.equal(url, fumin.buildFuminQueryUrl(value.config, providerId));
        if (protocol.name === 'toapis_video') assert.equal(url, `https://toapis.cn/v1/videos/generations/${encodeURIComponent(providerId)}`);
        if (protocol.name === 'feituo_open') {
          const parsed = new URL(url);
          assert.equal(parsed.searchParams.get('jobId'), providerId);
          assert.match(parsed.searchParams.get('_'), /^\d+$/);
          assert.equal(url, feituo.buildFeituoStatusUrl(protocol.base, providerId, parsed.searchParams.get('_')));
        }
        return response({ status: 'completed', ...protocol.url(RESULT_URL) });
      },
    });
    assert.equal(calls, 1);
    safeResult(result, 'completed_candidate', providerId);
    assert.equal(result.result_url, RESULT_URL);
  });

  test(`${protocol.name}: query status omission, response-ID conflict, and HTTP failure preserve input ID`, async () => {
    const value = input(protocol);
    for (const [payload, status, expected] of [
      [{ ...protocol.id('known-1') }, 200, 'submission_unknown'],
      [{ ...protocol.id('other-1'), status: 'completed', ...protocol.url(RESULT_URL) }, 200, 'submission_unknown'],
      [{ status: 'failed' }, 200, 'failed_terminal'],
      [{ status: 'completed' }, 200, 'result_unavailable'],
      [protocol.url(RESULT_URL), 200, 'completed_candidate'],
      [{ error: { message: 'provider-secret' } }, 404, 'submission_unknown'],
      [{ status: 'completed', ...protocol.url(RESULT_URL) }, 503, 'submission_unknown'],
    ]) {
      let calls = 0;
      const result = await service().queryRedrawUnitVideo({ protocol: protocol.name, config: value.config, provider_task_id: 'known-1' }, {
        fetchImpl: async (_url, init) => { calls += 1; assert.equal(init.method, 'GET'); return response(payload, status); },
      });
      assert.equal(calls, 1);
      safeResult(result, expected, 'known-1');
    }
  });

  test(`${protocol.name}: query network, parse, bounded-read and timeout failures stay unknown with known ID`, async () => {
    for (const fetchImpl of [
      async () => { throw new Error('provider-secret'); },
      async () => new Response('not JSON'),
      async () => new Response('x'.repeat(1024)),
      async () => ({ ok: true, status: 200, text: async () => { throw new Error('provider-secret'); } }),
      () => new Promise(() => {}),
    ]) {
      let calls = 0;
      const result = await service().queryRedrawUnitVideo({ protocol: protocol.name, config: input(protocol).config, provider_task_id: 'known-1' }, {
        requestTimeoutMs: 10, responseMaxBytes: 64,
        fetchImpl: (...args) => { calls += 1; return fetchImpl(...args); },
      });
      assert.equal(calls, 1);
      safeResult(result, 'submission_unknown', 'known-1');
    }
  });

  test(`${protocol.name}: query rejects missing ID and cannot accept a submit marker or submit opts`, async () => {
    for (const [extraInput, extraRuntime] of [[{ provider_task_id: '' }, {}], [{ provider_task_id: FIXTURE_KEY }, {}], [{ opts: input(protocol).opts }, {}], [{}, { beforeSubmit: () => true }]]) {
      let calls = 0;
      await assert.rejects(() => service().queryRedrawUnitVideo({ protocol: protocol.name, config: input(protocol).config, provider_task_id: 'known-1', ...extraInput }, {
        fetchImpl: async () => { calls += 1; return response({}); }, ...extraRuntime,
      }), (error) => error.code === PREFLIGHT);
      assert.equal(calls, 0);
    }
  });
}

test('Fumin and ToAPIs retain all documented nested and top-level provider ID forms', async () => {
  for (const protocol of protocols.slice(0, 2)) {
    for (const payload of [{ id: 'provider-1' }, { task_id: 'provider-1' }, { data: { id: 'provider-1' } }, { data: { task_id: 'provider-1' } }]) {
      safeResult(await submit(protocol, payload), 'accepted', 'provider-1');
    }
    safeResult(await submit(protocol, { id: 'provider-1', data: { id: 'provider-2' }, status: 'queued' }), 'submission_unknown', 'provider-1');
    safeResult(await submit(protocol, { id: 'provider-1', status: 'queued', data: { status: 'failed' } }), 'submission_unknown', 'provider-1');
  }
});

test('Fumin reads data.state but ToAPIs does not invent support for state aliases', async () => {
  safeResult(await submit(protocols[0], { data: { id: 'provider-1', state: 'failed' } }), 'failed_terminal', 'provider-1');
  safeResult(await submit(protocols[1], { task_id: 'provider-1', state: 'failed' }), 'submission_unknown', 'provider-1');
  safeResult(await submit(protocols[1], { data: { task_id: 'provider-1', status: 'failed' } }), 'failed_terminal', 'provider-1');
});

test('Feituo data overrides outer payload and taskId is never its polling identity', async () => {
  const protocol = protocols[2];
  safeResult(await submit(protocol, { jobId: 'outer-1', status: 'failed', data: { job_id: 'inner-1', jobId: 'inner-1', status: 'queued' } }), 'accepted', 'inner-1');
  safeResult(await submit(protocol, { data: { job_id: 'provider-1', status: 'processing' }, taskId: 'not-job-id' }), 'running', 'provider-1');
  safeResult(await submit(protocol, { taskId: 'not-job-id', task_id: 'not-job-id', status: 'queued' }), 'submission_unknown', undefined);
});

test('Fumin keeps a caller-validated custom query endpoint', async () => {
  const protocol = protocols[0];
  const value = input(protocol);
  value.config.query_endpoint = '/api/v3/custom/tasks/{task_id}';
  const result = await service().queryRedrawUnitVideo({ protocol: protocol.name, config: value.config, provider_task_id: 'known-1' }, {
    async fetchImpl(url, init) {
      assert.equal(url, fumin.buildFuminQueryUrl(value.config, 'known-1'));
      assert.equal(init.method, 'GET');
      return response({ id: 'known-1', status: 'running' });
    },
  });
  safeResult(result, 'running', 'known-1');
});

test('unknown protocol and absent lowest fetch are rejected without default selection or global fetch', async () => {
  await rejectedBeforePost(protocols[0], (value) => { value.protocol = 'default'; });
  await rejectedBeforePost(protocols[0], () => {}, { fetchImpl: undefined });
});

test('exact config Key wins over a synthetic ambient Key and missing config Key never falls back', async () => {
  for (const [protocol, envName] of [[protocols[0], 'FUMIN_API_KEY'], [protocols[1], 'TOAPIS_API_KEY']]) {
    const previous = process.env[envName];
    process.env[envName] = 'g4-synthetic-ambient-wrong-key';
    try {
      let calls = 0;
      const fetchImpl = async (_url, init) => {
        calls += 1;
        assert.equal(init.headers.Authorization, `Bearer ${FIXTURE_KEY}`);
        return response({ ...protocol.id('provider-1'), status: 'queued' });
      };
      safeResult(await service().submitRedrawUnitVideo(input(protocol), { beforeSubmit: () => true, fetchImpl }), 'accepted', 'provider-1');
      safeResult(await service().queryRedrawUnitVideo({ protocol: protocol.name, config: input(protocol).config, provider_task_id: 'provider-1' }, { fetchImpl }), 'accepted', 'provider-1');
      assert.equal(calls, 2);
      await rejectedBeforePost(protocol, (value) => { value.config.api_key = ''; });
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  }
});

test('declared async marker is rejected without starting its asynchronous side effects', async () => {
  let markers = 0;
  await rejectedBeforePost(protocols[0], () => {}, { beforeSubmit: async () => { markers += 1; return true; } });
  assert.equal(markers, 0);
});

test('a synchronous marker returning a rejected native Promise stays a safe preflight rejection', async () => {
  await rejectedBeforePost(protocols[0], () => {}, { beforeSubmit: () => Promise.reject(new Error('synthetic-marker-rejection')) });
  await new Promise((resolve) => setImmediate(resolve));
});

test('prototype-shaped config fields cannot supply missing exact connection credentials', async () => {
  await rejectedBeforePost(protocols[0], (value) => {
    value.config = JSON.parse(`{"__proto__":{"api_key":"${FIXTURE_KEY}","base_url":"https://fumin.example.test"}}`);
  });
});

for (const protocol of protocols) {
  for (const operation of ['submit', 'query']) {
    for (const [label, key, url, expected] of [
      ['partial uppercase escape', FIXTURE_KEY, `${RESULT_URL}?token=g4%2Dfixture-only-not-a-real-key`, 'submission_unknown'],
      ['partial lowercase escape', FIXTURE_KEY, `${RESULT_URL}?token=g4%2dfixture-only-not-a-real-key`, 'submission_unknown'],
      ['mixed partial escapes', FIXTURE_KEY, `${RESULT_URL}?token=g%34%2dfixture%2Donly-not-a-real-key`, 'submission_unknown'],
      ['form-query plus decodes to space', 'g4 fixture-only-not-a-real-key', `${RESULT_URL}?token=g4+fixture-only-not-a-real-key`, 'submission_unknown'],
      ['encoded literal plus', 'g4+fixture-only-not-a-real-key', `${RESULT_URL}?token=g%34%2bfixture-only-not-a-real-key`, 'submission_unknown'],
      ['path-component credential', FIXTURE_KEY, 'https://outputs.example.test/g4%2Dfixture-only-not-a-real-key/candidate.mp4', 'submission_unknown'],
      ['ordinary encoded signature stays byte-exact', FIXTURE_KEY, `${RESULT_URL}?download_token=ordinary%2bsignature+with%2Fpath&part=02`, 'completed_candidate'],
    ]) {
      test(`${protocol.name}: ${operation} ${label}`, async () => {
        const value = input(protocol);
        value.config.api_key = key;
        let calls = 0;
        const runtime = {
          async fetchImpl(_url, init) {
            calls += 1;
            assert.equal(init.method, operation === 'submit' ? 'POST' : 'GET');
            assert.equal(init.headers.Authorization, `Bearer ${key}`);
            return response({ ...protocol.id('provider-1'), status: 'completed', ...protocol.url(url) });
          },
        };
        const result = operation === 'submit'
          ? await service().submitRedrawUnitVideo(value, { ...runtime, beforeSubmit: () => true })
          : await service().queryRedrawUnitVideo({ protocol: protocol.name, config: value.config, provider_task_id: 'provider-1' }, runtime);
        assert.equal(calls, 1);
        safeResult(result, expected, 'provider-1');
        assert.equal(result.result_url, expected === 'completed_candidate' ? url : undefined);
        assert.equal(JSON.stringify(result).includes(key), false);
      });
    }
  }
}

for (const protocol of protocols) {
  for (const channel of ['submit response ID', 'query input ID', 'query response ID']) {
    test(`${protocol.name}: percent-encoded credential checks cover ${channel} without rewriting opaque IDs`, async () => {
      for (const [key, id, credentialEcho] of [
        [FIXTURE_KEY, 'g4%2Dfixture-only-not-a-real-key', true],
        [FIXTURE_KEY, 'g4%2dfixture-only-not-a-real-key', true],
        [FIXTURE_KEY, 'g%34%2dfixture%2Donly-not-a-real-key', true],
        ['g4+fixture-only-not-a-real-key', 'g%34%2bfixture-only-not-a-real-key', true],
        [FIXTURE_KEY, 'opaque%2Fjob%3Aid', false],
        ['g4 fixture-only-not-a-real-key', 'g4+fixture-only-not-a-real-key', false],
      ]) {
        const value = input(protocol);
        value.config.api_key = key;
        const knownId = channel === 'query response ID' && credentialEcho ? 'known-1' : id;
        let calls = 0;
        const runtime = {
          async fetchImpl(url, init) {
            calls += 1;
            assert.equal(init.method, channel === 'submit response ID' ? 'POST' : 'GET');
            if (channel !== 'submit response ID') assert.ok(url.includes(encodeURIComponent(knownId)));
            return response({ ...protocol.id(id), status: 'queued' });
          },
        };
        if (channel === 'query input ID' && credentialEcho) {
          await assert.rejects(() => service().queryRedrawUnitVideo({ protocol: protocol.name, config: value.config, provider_task_id: knownId }, runtime), {
            code: PREFLIGHT, message: 'Redraw unit video preflight rejected',
          });
          assert.equal(calls, 0);
          continue;
        }
        const result = channel === 'submit response ID'
          ? await service().submitRedrawUnitVideo(value, { ...runtime, beforeSubmit: () => true })
          : await service().queryRedrawUnitVideo({ protocol: protocol.name, config: value.config, provider_task_id: knownId }, runtime);
        assert.equal(calls, 1);
        safeResult(result, credentialEcho ? 'submission_unknown' : 'accepted',
          credentialEcho ? (channel === 'query response ID' ? 'known-1' : undefined) : id);
        assert.equal(result.result_url, undefined);
        assert.equal(JSON.stringify(result).includes(key), false);
      }
    });
  }
}
