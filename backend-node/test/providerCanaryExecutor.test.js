'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const aiConfigService = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const videoClient = require('../src/services/videoClient');
const budget = require('../src/services/providerCanaryBudgetService');
const evidence = require('../src/services/providerCanaryEvidenceService');
const modelPrice = require('../src/services/modelPriceService');
const routeCost = require('../src/services/providerRouteCostService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const validMp3Bytes = require('./fixtures/minimalMp3');

const NOW = '2026-08-18T00:00:00.000Z';
const log = { info() {}, warn() {}, error() {} };

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function loadExecutor() {
  return require('../src/services/providerCanaryExecutor');
}

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function addConfig(db, serviceType, suffix = 'a') {
  const config = aiConfigService.createConfig(db, log, {
    service_type: serviceType,
    provider: `fixture-${serviceType}-${suffix}`,
    api_protocol: 'openai',
    name: `fixture-${serviceType}-${suffix}`,
    base_url: `https://${serviceType}-${suffix}.fixture.invalid/v1`,
    api_key: `sk-private-${serviceType}-${suffix}`,
    model: [`upstream-${serviceType}-${suffix}`],
    default_model: `upstream-${serviceType}-${suffix}`,
    endpoint: serviceType === 'text' ? '/chat/completions' : null,
    query_endpoint: serviceType === 'video' ? '/video/task/{taskId}' : null,
    logical_model_id: `logical-${serviceType}-${suffix}`,
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  modelPrice.set(db, config.logical_model_id, 10, {
    category: serviceType === 'tts' ? 'audio' : serviceType,
    billing_unit: serviceType === 'video' ? 'second' : 'request',
    cost_unit: serviceType === 'video'
      ? 'second'
      : serviceType === 'text'
        ? 'token'
        : serviceType === 'tts'
          ? 'request'
          : 'image',
    cost_micros_per_unit: serviceType === 'text' ? 0 : 1000,
    input_cost_micros_per_1k: serviceType === 'text' ? 1000 : 0,
    output_cost_micros_per_1k: serviceType === 'text' ? 2000 : 0,
  });
  routeCost.setRouteCost(db, config.id,
    serviceType === 'text'
      ? {
        cost_unit: 'token',
        input_cost_micros_per_1k: 1000,
        output_cost_micros_per_1k: 2000,
      }
      : {
        cost_unit: serviceType === 'video'
          ? 'second'
          : serviceType === 'tts'
            ? 'request'
            : 'image',
        micros_per_unit: 1000,
      },
    { now: NOW });
  return aiConfigService.getConfig(db, config.id);
}

function addHttpImageConfig(db, server, suffix) {
  const model = `local-image-${suffix}`;
  const config = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: `local-image-${suffix}`,
    api_protocol: 'openai',
    name: `local-image-${suffix}`,
    base_url: `http://127.0.0.1:${server.address().port}`,
    api_key: `local-private-${suffix}`,
    model: [model],
    default_model: model,
    endpoint: '/images/generations',
    logical_model_id: 'logical-local-image',
    settings: JSON.stringify({ canvas_capabilities: { maxReferences: 2 } }),
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  modelPrice.set(db, 'logical-local-image', 10, {
    category: 'image',
    billing_unit: 'request',
    cost_unit: 'image',
    cost_micros_per_unit: 1000,
  });
  routeCost.setRouteCost(db, config.id, {
    cost_unit: 'image', micros_per_unit: 1000,
  }, { now: NOW });
  return aiConfigService.getConfig(db, config.id);
}

function addHttpVideoConfig(db, server, suffix) {
  const model = `local-video-${suffix}`;
  const config = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: `local-video-${suffix}`,
    api_protocol: 'openai',
    name: `local-video-${suffix}`,
    base_url: `http://127.0.0.1:${server.address().port}`,
    api_key: `local-private-${suffix}`,
    model: [model],
    default_model: model,
    endpoint: '/video/generations',
    query_endpoint: '/video/generations/{taskId}',
    logical_model_id: 'logical-local-video',
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  modelPrice.set(db, 'logical-local-video', 10, {
    category: 'video',
    billing_unit: 'second',
    cost_unit: 'second',
    cost_micros_per_unit: 1000,
  });
  routeCost.setRouteCost(db, config.id, {
    cost_unit: 'second', micros_per_unit: 1000,
  }, { now: NOW });
  return aiConfigService.getConfig(db, config.id);
}

function capabilityFor(serviceType) {
  const hasMediaReferences = !['text', 'tts'].includes(serviceType);
  const capability = {
    serviceType,
    generationType: ['text', 'tts'].includes(serviceType) ? serviceType : `${serviceType}_generation`,
    count: 1,
    referenceImageCount: hasMediaReferences ? 2 : 0,
    referenceVideoCount: serviceType === 'video' ? 1 : 0,
    referenceAudioCount: serviceType === 'video' ? 1 : 0,
    firstFrame: serviceType === 'video',
    lastFrame: false,
  };
  if (hasMediaReferences) {
    capability.resolution = serviceType === 'video' ? '720p' : '1k';
    capability.aspectRatio = '16:9';
  }
  if (serviceType === 'video') capability.duration = 5;
  return capability;
}

function reserveRun(db, config, capability, suffix = '1', scope = `scope-${suffix}`) {
  const run = {
    id: `run-${suffix}`,
    idempotencyKey: `idem-${suffix}`,
    route: {
      configId: config.id,
      logicalModelId: config.logical_model_id,
      serviceType: config.service_type,
      capabilityFingerprint: evidence.capabilityFingerprint(config.service_type, capability),
      configFingerprint: `config-${suffix}`,
      costFingerprint: `cost-${suffix}`,
      runtimeFingerprint: `runtime-${suffix}`,
      providerScopeKey: scope,
    },
    reservedCostMicros: 50_000,
    currency: 'CNY',
    now: NOW,
  };
  return budget.reserve(db, run);
}

function rowCounts(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
    .map(({ name }) => name)
    .filter((name) => !/^provider_canary_/i.test(name)
      && /(user|tenant|credit|usage|reservation|account|ledger)/i.test(name));
  return Object.fromEntries(tables.map((name) => [
    name,
    db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count,
  ]));
}

function fixtures() {
  return {
    imageUrls: ['https://fixtures.invalid/image-1.png', 'https://fixtures.invalid/image-2.png'],
    videoUrls: ['https://fixtures.invalid/video-1.mp4'],
    audioUrls: ['https://fixtures.invalid/audio-1.wav'],
    firstFrameUrl: 'https://fixtures.invalid/first.png',
    lastFrameUrl: null,
  };
}

function fixturesFor(capability) {
  const all = fixtures();
  return {
    imageUrls: all.imageUrls.slice(0, capability.referenceImageCount || 0),
    videoUrls: all.videoUrls.slice(0, capability.referenceVideoCount || 0),
    audioUrls: all.audioUrls.slice(0, capability.referenceAudioCount || 0),
    firstFrameUrl: capability.firstFrame ? all.firstFrameUrl : null,
    lastFrameUrl: capability.lastFrame ? all.lastFrameUrl : null,
  };
}

function baseOptions(capability, overrides = {}) {
  return {
    capability,
    fixtures: fixturesFor(capability),
    storageRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'moli-canary-executor-')),
    now: NOW,
    actualCostMicros: 40_000,
    clients: {},
    artifacts: {},
    ...overrides,
  };
}

test('buildCanaryRequest is fixed safe input and pins image, video, and TTS requests to one config', () => {
  const executor = loadExecutor();
  const db = createDb();
  try {
    const image = addConfig(db, 'image');
    const video = addConfig(db, 'video');
    const tts = addConfig(db, 'tts');
    const imageCapability = capabilityFor('image');
    const videoCapability = capabilityFor('video');
    const ttsCapability = capabilityFor('tts');
    const imageRequest = executor.buildCanaryRequest(
      db, image, imageCapability, fixturesFor(imageCapability),
    );
    const videoRequest = executor.buildCanaryRequest(
      db, video, videoCapability, fixturesFor(videoCapability),
    );
    const ttsRequest = executor.buildCanaryRequest(
      db, tts, ttsCapability, fixturesFor(ttsCapability),
    );

    assert.equal(imageRequest.config_id, image.id);
    assert.equal(videoRequest.config_id, video.id);
    assert.equal(ttsRequest.config_id, tts.id);
    assert.equal(typeof ttsRequest.text, 'string');
    assert.ok(ttsRequest.text.length > 0);
    assert.equal(imageRequest.size, imageCapability.resolution);
    assert.deepEqual(imageRequest.reference_image_urls, fixtures().imageUrls);
    assert.deepEqual(videoRequest.reference_urls, fixtures().imageUrls);
    assert.deepEqual(videoRequest.reference_video_urls, fixtures().videoUrls);
    assert.deepEqual(videoRequest.reference_audio_urls, fixtures().audioUrls);
    assert.equal(videoRequest.first_frame_url, fixtures().firstFrameUrl);
    const serialized = JSON.stringify({ imageRequest, videoRequest, ttsRequest });
    assert.match(serialized, /蓝色圆形|blue circle/i);
    assert.doesNotMatch(serialized, /人物|人像|user|sk-private/);
  } finally {
    db.close();
  }
});

for (const serviceType of ['image', 'video', 'tts']) {
  test(`${serviceType} canary fails closed before submission when output count is not one`, async (t) => {
    const executor = loadExecutor();
    const db = createDb();
    t.after(() => db.close());
    const config = addConfig(db, serviceType, `multi-output-${serviceType}`);
    const capability = { ...capabilityFor(serviceType), count: 2 };
    const expected = (error) => error.code === 'PROVIDER_CANARY_OUTPUT_COUNT_UNSUPPORTED';

    assert.throws(
      () => executor.buildCanaryRequest(db, config, capability, fixturesFor(capability)),
      expected,
    );
    assert.throws(() => executor.estimateCanaryCost(db, config, capability), expected);

    const run = reserveRun(db, config, capability, `multi-output-${serviceType}`);
    let submissions = 0;
    const options = baseOptions(capability, {
      clients: {
        async callImageApi() { submissions += 1; },
        async callVideoApi() { submissions += 1; },
        async synthesizeTts() { submissions += 1; },
      },
    });
    t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

    await assert.rejects(
      () => executor.executeCanaryRun(db, log, run, options),
      expected,
    );
    assert.equal(submissions, 0);
    assert.equal(
      db.prepare('SELECT state FROM provider_canary_runs WHERE id = ?').get(run.id).state,
      'reserved',
    );
  });
}

test('estimateCanaryCost uses the configured model cost and rejects zero or missing cost', () => {
  const executor = loadExecutor();
  const db = createDb();
  try {
    const image = addConfig(db, 'image');
    const video = addConfig(db, 'video');
    const tts = addConfig(db, 'tts');
    assert.equal(executor.estimateCanaryCost(db, image, capabilityFor('image')), 1000);
    assert.equal(executor.estimateCanaryCost(db, video, capabilityFor('video')), 5000);
    assert.equal(executor.estimateCanaryCost(db, tts, capabilityFor('tts')), 1000);
    db.prepare('UPDATE model_credit_prices SET cost_micros_per_unit = 0 WHERE model = ?')
      .run(image.logical_model_id);
    db.prepare('UPDATE provider_route_costs SET micros_per_unit = 0 WHERE config_id = ?')
      .run(image.id);
    assert.throws(
      () => executor.estimateCanaryCost(db, image, capabilityFor('image')),
      (error) => error.code === 'PROVIDER_CANARY_COST_NOT_POSITIVE',
    );
  } finally {
    db.close();
  }
});

test('estimateCanaryCost uses exact config route cost for configs sharing one logical model', () => {
  const executor = loadExecutor();
  const db = createDb();
  try {
    const first = addConfig(db, 'image', 'shared-a');
    const secondInitial = addConfig(db, 'image', 'shared-b');
    db.prepare('UPDATE ai_service_configs SET logical_model_id = ? WHERE id = ?')
      .run(first.logical_model_id, secondInitial.id);
    routeCost.setRouteCost(db, first.id, {
      cost_unit: 'image', micros_per_unit: 46_000,
    }, { now: NOW });
    routeCost.setRouteCost(db, secondInitial.id, {
      cost_unit: 'image', micros_per_unit: 100_000,
    }, { now: NOW });
    const second = aiConfigService.getConfig(db, secondInitial.id);

    assert.equal(executor.estimateCanaryCost(db, first, capabilityFor('image')), 46_000);
    assert.equal(executor.estimateCanaryCost(db, second, capabilityFor('image')), 100_000);
  } finally {
    db.close();
  }
});

test('estimateCanaryCost quotes TTS by the exact fixed canary text character count', () => {
  const executor = loadExecutor();
  const db = createDb();
  try {
    const tts = addConfig(db, 'tts', 'character-cost');
    const capability = capabilityFor('tts');
    const request = executor.buildCanaryRequest(db, tts, capability, fixturesFor(capability));
    routeCost.setRouteCost(db, tts.id, {
      cost_unit: 'character',
      micros_per_unit: 200,
    }, { now: NOW });

    assert.equal(
      executor.estimateCanaryCost(db, tts, capability),
      Array.from(request.text).length * 200,
    );
  } finally {
    db.close();
  }
});

test('video task is submitted once, accepted, polled only, verified, and writes fresh evidence', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'video');
  const capability = capabilityFor('video');
  const run = reserveRun(db, config, capability, 'video-success');
  const before = rowCounts(db);
  const seen = { submit: [], poll: [] };
  const options = baseOptions(capability, {
    clients: {
      async callVideoApi(_db, _log, request) {
        seen.submit.push(request);
        return { task_id: 'provider-task-1', status: 'processing' };
      },
      async pollVideoTask(_db, _log, videoGenId, taskId, polledConfig) {
        seen.poll.push({ videoGenId, taskId, configId: polledConfig.id });
        return { video_url: 'https://artifacts.invalid/result.mp4' };
      },
    },
    artifacts: {
      async materializeVideo(url) {
        assert.equal(url, 'https://artifacts.invalid/result.mp4');
        return { relative_path: '_system/provider-canary/runs/run-video-success/video.mp4', sha256: 'a'.repeat(64), bytes: 24 };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);

  assert.equal(result.state, 'succeeded');
  assert.equal(result.submitCount, 1);
  assert.equal(seen.submit.length, 1);
  assert.equal(seen.submit[0].config_id, config.id);
  assert.deepEqual(seen.poll, [{ videoGenId: null, taskId: 'provider-task-1', configId: config.id }]);
  assert.deepEqual(db.prepare(`SELECT state, provider_task_id, artifact_path
    FROM provider_canary_runs WHERE id = ?`).get(run.id), {
    state: 'succeeded',
    provider_task_id: 'provider-task-1',
    artifact_path: '_system/provider-canary/runs/run-video-success/video.mp4',
  });
  assert.equal(db.prepare('SELECT state FROM provider_canary_evidence').get().state, 'fresh');
  assert.deepEqual(rowCounts(db), before);
});

test('2xx without a parseable artifact becomes result_unknown and blocks the provider scope', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'image');
  const capability = capabilityFor('image');
  const first = reserveRun(db, config, capability, 'empty-result', 'shared-scope');
  const before = rowCounts(db);
  let submissions = 0;
  const options = baseOptions(capability, {
    clients: {
      async callImageApi(_db, _log, request) {
        submissions += 1;
        assert.equal(request.config_id, config.id);
        return { route_meta: { httpStatus: 200 } };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, first, options);
  assert.equal(result.state, 'result_unknown');
  assert.equal(result.submitCount, 1);
  assert.equal(submissions, 1);
  assert.equal(db.prepare('SELECT state FROM provider_canary_evidence').get().state, 'submission_unknown');

  const second = reserveRun(db, config, capability, 'scope-blocked', 'shared-scope');
  await assert.rejects(
    () => executor.executeCanaryRun(db, log, second, options),
    (error) => error.code === 'PROVIDER_CANARY_SCOPE_BLOCKED',
  );
  assert.equal(submissions, 1);
  assert.equal(db.prepare('SELECT state FROM provider_canary_runs WHERE id = ?').get(second.id).state, 'reserved');
  assert.deepEqual(rowCounts(db), before);
});

test('two file-backed executor workers permit only the atomic claim owner to submit', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-canary-executor-claim-'));
  const filename = path.join(directory, 'canary.sqlite');
  const first = new Database(filename);
  runMigrationsAndEnsure(first);
  const second = new Database(filename);
  first.pragma('busy_timeout = 1000');
  second.pragma('busy_timeout = 1000');
  t.after(() => {
    second.close();
    first.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const executor = loadExecutor();
  const config = addConfig(first, 'image', 'claim-race');
  const capability = capabilityFor('image');
  const run = reserveRun(first, config, capability, 'claim-race');
  let releaseSubmission;
  const submissionGate = new Promise((resolve) => { releaseSubmission = resolve; });
  let submissions = 0;
  const firstOptions = baseOptions(capability, {
    clients: {
      async callImageApi() {
        submissions += 1;
        await submissionGate;
        return { route_meta: { httpStatus: 200 } };
      },
    },
  });
  const secondOptions = baseOptions(capability, {
    clients: {
      async callImageApi() { submissions += 1; },
    },
  });
  t.after(() => {
    fs.rmSync(firstOptions.storageRoot, { recursive: true, force: true });
    fs.rmSync(secondOptions.storageRoot, { recursive: true, force: true });
  });

  const ownerExecution = executor.executeCanaryRun(first, log, run, firstOptions);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => executor.executeCanaryRun(second, log, run, secondOptions),
    (error) => error.code === 'PROVIDER_CANARY_EXECUTION_NOT_CLAIMED',
  );
  assert.equal(submissions, 1);
  releaseSubmission();
  const ownerResult = await ownerExecution;
  assert.equal(ownerResult.state, 'result_unknown');
  assert.equal(ownerResult.submitCount, 1);
  assert.equal(submissions, 1);
});

test('internal exact image entry keeps route metadata while public callImageApi strips it', async (t) => {
  let requests = 0;
  const server = await listen((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ request_id: 'local-empty-result', data: [] }));
  });
  t.after(() => close(server));
  const db = createDb();
  t.after(() => db.close());
  const config = addHttpImageConfig(db, server, 'meta');
  const request = {
    config_id: config.id,
    prompt: 'fixed local canary prompt',
    size: '1024x1024',
  };

  const internal = await imageClient.callImageApiForConfigId(
    db, log, config.id, request,
  );
  const publicResult = await imageClient.callImageApi(db, log, request);

  assert.equal(requests, 2);
  assert.equal(internal.route_meta.httpStatus, 200);
  assert.equal(internal.route_meta.artifactReadable, false);
  assert.equal(Object.hasOwn(publicResult, 'route_meta'), false);
  assert.equal(Object.hasOwn(publicResult, 'provider_task_id'), false);
});

test('internal exact video entry keeps route metadata while public callVideoApi strips it', async (t) => {
  let requests = 0;
  const server = await listen((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'local-video-task', status: 'processing' }));
  });
  t.after(() => close(server));
  const db = createDb();
  t.after(() => db.close());
  const config = addHttpVideoConfig(db, server, 'meta');
  const request = {
    config_id: config.id,
    prompt: 'fixed local canary prompt',
    duration: 5,
    resolution: '720p',
    aspect_ratio: '16:9',
  };

  const internal = await videoClient.callVideoApiForConfigId(
    db, log, config.id, request,
  );
  const publicResult = await videoClient.callVideoApi(db, log, request);

  assert.equal(requests, 2);
  assert.equal(internal.task_id, 'local-video-task');
  assert.equal(internal.route_meta.httpStatus, 200);
  assert.equal(internal.route_meta.providerTaskId, 'local-video-task');
  assert.equal(Object.hasOwn(publicResult, 'route_meta'), false);
  assert.equal(Object.hasOwn(publicResult, 'provider_task_id'), false);
});

test('internal exact video entry rejects inactive and wrong-type configs before HTTP', async (t) => {
  let requests = 0;
  const server = await listen((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'must-not-submit' }));
  });
  t.after(() => close(server));
  const db = createDb();
  t.after(() => db.close());
  const inactive = addHttpVideoConfig(db, server, 'inactive');
  const wrongType = addHttpImageConfig(db, server, 'wrong-type');
  db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = ?').run(inactive.id);

  await assert.rejects(
    () => videoClient.callVideoApiForConfigId(db, log, inactive.id, { prompt: 'safe' }),
    /不存在|停用/,
  );
  await assert.rejects(
    () => videoClient.callVideoApiForConfigId(db, log, wrongType.id, { prompt: 'safe' }),
    /video|视频/,
  );
  assert.equal(requests, 0);
});

test('real internal image path classifies 2xx without artifact as result_unknown once without failover', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    requests.push('primary');
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ request_id: 'local-empty-result', data: [] }));
  });
  const backup = await listen((req, res) => {
    requests.push('backup');
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: 'https://artifacts.invalid/must-not-run.png' }] }));
  });
  t.after(async () => Promise.all([close(primary), close(backup)]));
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addHttpImageConfig(db, primary, 'primary');
  addHttpImageConfig(db, backup, 'backup');
  const capability = { ...capabilityFor('image'), referenceImageCount: 0 };
  const run = reserveRun(db, config, capability, 'real-image-empty', 'real-image-scope');
  const options = baseOptions(capability);
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, safe_error_summary FROM provider_canary_runs
    WHERE id = ?`).get(run.id);

  assert.equal(result.state, 'result_unknown');
  assert.equal(result.submitCount, 1);
  assert.deepEqual(requests, ['primary']);
  assert.equal(stored.state, 'result_unknown');
  assert.equal(stored.safe_error_summary, 'category=result_unknown status=200');
});

test('uncertain submit response stays submission_unknown without pretending verification started', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'image');
  const capability = capabilityFor('image');
  const run = reserveRun(db, config, capability, 'submit-unknown');
  const before = rowCounts(db);
  const options = baseOptions(capability, {
    clients: {
      async callImageApi() {
        return {
          indeterminate: true,
          error: 'gateway outcome unknown https://private.invalid key=sk-private',
          route_meta: {
            httpStatus: 503,
            phase: 'submit',
            requestBodySent: true,
          },
        };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, provider_task_id, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.equal(result.state, 'submission_unknown');
  assert.equal(result.submitCount, 1);
  assert.equal(stored.state, 'submission_unknown');
  assert.equal(stored.provider_task_id, null);
  assert.equal(stored.safe_error_summary, 'category=submission_unknown status=503');
  assert.doesNotMatch(JSON.stringify(stored), /private|sk-private|gateway outcome/);
  assert.deepEqual(rowCounts(db), before);
});

test('poll timeout never resubmits and stays result_unknown with the accepted task id', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'video');
  const capability = capabilityFor('video');
  const run = reserveRun(db, config, capability, 'poll-timeout');
  const before = rowCounts(db);
  let submitCount = 0;
  let pollCount = 0;
  const options = baseOptions(capability, {
    clients: {
      async callVideoApi() {
        submitCount += 1;
        return { task_id: 'task-timeout', status: 'processing' };
      },
      async pollVideoTask() {
        pollCount += 1;
        return {
          indeterminate: true,
          provider_task_id: 'task-timeout',
          error: 'secret https://relay.invalid/task?key=sk-private',
        };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, provider_task_id, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.equal(result.state, 'result_unknown');
  assert.equal(result.submitCount, 1);
  assert.equal(submitCount, 1);
  assert.equal(pollCount, 1);
  assert.equal(stored.provider_task_id, 'task-timeout');
  assert.match(stored.safe_error_summary, /^category=result_unknown/);
  assert.doesNotMatch(stored.safe_error_summary, /relay|sk-private|secret/);
  assert.deepEqual(rowCounts(db), before);
});

test('artifact download interruption becomes artifact_unreadable and never writes fresh evidence', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'image');
  const capability = capabilityFor('image');
  const run = reserveRun(db, config, capability, 'download-interrupt');
  const before = rowCounts(db);
  const options = baseOptions(capability, {
    clients: {
      async callImageApi() {
        return { image_url: 'https://private.invalid/result.png?key=sk-private' };
      },
    },
    artifacts: {
      async materializeImage() {
        throw new Error('download interrupted https://private.invalid key=sk-private prompt=secret');
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, safe_error_summary FROM provider_canary_runs
    WHERE id = ?`).get(run.id);
  assert.equal(result.state, 'artifact_unreadable');
  assert.equal(result.submitCount, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_canary_evidence WHERE state = 'fresh'").get().count, 0);
  assert.equal(db.prepare('SELECT state FROM provider_canary_evidence').get().state, 'submission_unknown');
  assert.match(stored.safe_error_summary, /^category=artifact_unreadable/);
  assert.doesNotMatch(stored.safe_error_summary, /private|sk-|prompt|secret/);
  assert.deepEqual(rowCounts(db), before);
});

test('definitive 4xx not accepted fails once, costs zero, and stores only a safe summary', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'image');
  const capability = capabilityFor('image');
  const run = reserveRun(db, config, capability, 'definitive-4xx');
  const before = rowCounts(db);
  const options = baseOptions(capability, {
    clients: {
      async callImageApi() {
        return {
          error: '图片生成请求失败: 400 - private https://relay.invalid sk-private safe prompt leaked',
          route_meta: {
            httpStatus: 400,
            phase: 'submit',
            requestBodySent: false,
            explicitlyRejected: true,
          },
        };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, actual_cost_micros, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.submitCount, 1);
  assert.equal(stored.actual_cost_micros, 0);
  assert.equal(stored.safe_error_summary, 'category=validation_error status=400');
  assert.equal(db.prepare('SELECT state FROM provider_canary_evidence').get().state, 'failing');
  assert.doesNotMatch(JSON.stringify(stored), /relay|sk-private|prompt leaked/);
  assert.deepEqual(rowCounts(db), before);
});

test('unstructured error text that looks like HTTP 400 remains submission_unknown', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'image');
  const capability = capabilityFor('image');
  const run = reserveRun(db, config, capability, 'unstructured-4xx');
  const options = baseOptions(capability, {
    clients: {
      async callImageApi() {
        return { error: '图片生成请求失败: 400 - private https://relay.invalid sk-private' };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, actual_cost_micros, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.equal(result.state, 'submission_unknown');
  assert.equal(result.submitCount, 1);
  assert.equal(stored.state, 'submission_unknown');
  assert.equal(stored.actual_cost_micros, null);
  assert.equal(stored.safe_error_summary, 'category=submission_unknown');
  assert.doesNotMatch(JSON.stringify(stored), /relay|sk-private/);
});

for (const status of [400, 413, 422]) {
  test(`real internal video HTTP ${status} is definitive failure once without failover`, async (t) => {
    const requests = [];
    const primary = await listen((req, res) => {
      requests.push('primary');
      req.resume();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'invalid input' } }));
    });
    const backup = await listen((req, res) => {
      requests.push('backup');
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'must-not-run', status: 'processing' }));
    });
    t.after(async () => Promise.all([close(primary), close(backup)]));
    const executor = loadExecutor();
    const db = createDb();
    t.after(() => db.close());
    const config = addHttpVideoConfig(db, primary, `status-${status}`);
    addHttpVideoConfig(db, backup, `backup-${status}`);
    const capability = capabilityFor('video');
    const run = reserveRun(db, config, capability, `video-${status}`, `video-status-${status}`);
    const options = baseOptions(capability);
    t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

    const result = await executor.executeCanaryRun(db, log, run, options);
    const stored = db.prepare(`SELECT state, actual_cost_micros, safe_error_summary
      FROM provider_canary_runs WHERE id = ?`).get(run.id);
    assert.equal(result.state, 'failed');
    assert.equal(result.submitCount, 1);
    assert.deepEqual(requests, ['primary']);
    assert.equal(stored.state, 'failed');
    assert.equal(stored.actual_cost_micros, 0);
    assert.equal(
      stored.safe_error_summary,
      `category=validation_error status=${status} code=BAD_REQUEST`,
    );
  });
}

test('success terminal state rolls back when fresh evidence cannot be written', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'image');
  const capability = capabilityFor('image');
  const run = reserveRun(db, config, capability, 'success-evidence-rollback');
  db.exec(`CREATE TRIGGER fail_canary_success_evidence
    BEFORE INSERT ON provider_canary_evidence
    BEGIN SELECT RAISE(ABORT, 'forced evidence failure'); END`);
  const options = baseOptions(capability, {
    clients: { async callImageApi() { return { image_url: 'https://artifacts.invalid/result.png' }; } },
    artifacts: {
      async materializeImage() {
        return { relative_path: '_system/provider-canary/runs/success/image.png', sha256: 'c'.repeat(64), bytes: 10 };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => executor.executeCanaryRun(db, log, run, options),
    /forced evidence failure/,
  );
  const stored = db.prepare(`SELECT state, actual_cost_micros, artifact_path, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.deepEqual(stored, {
    state: 'verifying', actual_cost_micros: null, artifact_path: null, safe_error_summary: null,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_evidence').get().count, 0);
});

test('failure terminal state rolls back when failing evidence cannot be written', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'image');
  const capability = capabilityFor('image');
  const run = reserveRun(db, config, capability, 'failure-evidence-rollback');
  db.exec(`CREATE TRIGGER fail_canary_failure_evidence
    BEFORE INSERT ON provider_canary_evidence
    BEGIN SELECT RAISE(ABORT, 'forced evidence failure'); END`);
  const options = baseOptions(capability, {
    clients: {
      async callImageApi() {
        return { error: 'invalid', route_meta: { httpStatus: 400, explicitlyRejected: true } };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => executor.executeCanaryRun(db, log, run, options),
    /forced evidence failure/,
  );
  const stored = db.prepare(`SELECT state, actual_cost_micros, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.deepEqual(stored, {
    state: 'submitting', actual_cost_micros: null, safe_error_summary: null,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_evidence').get().count, 0);
});

test('unknown terminal state and evidence roll back when the event cannot be written', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'image');
  const capability = capabilityFor('image');
  const run = reserveRun(db, config, capability, 'unknown-event-rollback');
  db.exec(`CREATE TRIGGER fail_canary_unknown_event
    BEFORE INSERT ON provider_stability_events
    WHEN NEW.event_type = 'provider_canary_unknown'
    BEGIN SELECT RAISE(ABORT, 'forced event failure'); END`);
  const options = baseOptions(capability, {
    clients: { async callImageApi() { return { route_meta: { httpStatus: 200 } }; } },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => executor.executeCanaryRun(db, log, run, options),
    /forced event failure/,
  );
  const stored = db.prepare(`SELECT state, actual_cost_micros, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.deepEqual(stored, {
    state: 'verifying', actual_cost_micros: null, safe_error_summary: null,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_evidence').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_stability_events').get().count, 0);
});

test('text success verifies a non-empty digest, writes fresh evidence, and never changes user credit tables', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'text');
  const capability = capabilityFor('text');
  const run = reserveRun(db, config, capability, 'text-success');
  const before = rowCounts(db);
  const calls = [];
  const options = baseOptions(capability, {
    clients: {
      async generateTextForConfigId(_db, _log, configId, userPrompt, systemPrompt, requestOptions) {
        calls.push({ configId, userPrompt, systemPrompt, requestOptions });
        return 'CANARY_OK';
      },
    },
    artifacts: {
      verifyText(text) {
        assert.equal(text, 'CANARY_OK');
        return { sha256: 'b'.repeat(64), bytes: 9, media_type: 'text/plain' };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.submitCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].configId, config.id);
  assert.match(calls[0].userPrompt, /CANARY_OK/);
  assert.doesNotMatch(JSON.stringify(calls[0]), /sk-private|人物|用户/);
  assert.equal(db.prepare('SELECT state FROM provider_canary_evidence').get().state, 'fresh');
  assert.deepEqual(rowCounts(db), before);
});

test('TTS canary submits once to the exact config, verifies the isolated MP3, and writes fresh evidence', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'tts', 'success');
  const capability = capabilityFor('tts');
  const run = reserveRun(db, config, capability, 'tts-success');
  const before = rowCounts(db);
  const calls = [];
  const options = baseOptions(capability, {
    clients: {
      async synthesizeTts(_db, _log, request) {
        calls.push(request);
        const relativePath = `${request.storage_subdir}/tts_sbx_success.mp3`;
        const filePath = path.join(request.storage_base, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, validMp3Bytes);
        return {
          local_path: relativePath,
          provider_task_id: 'tts-task-success',
          status: 'completed',
        };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, provider_task_id, artifact_path, actual_cost_micros
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.submitCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.id, config.id);
  assert.equal(calls[0].storage_base, options.storageRoot);
  assert.equal(calls[0].storage_subdir, `_system/provider-canary/runs/${run.id}`);
  assert.equal(calls[0].storyboard_id, null);
  assert.match(calls[0].text, /测试/);
  assert.doesNotMatch(calls[0].text, /人物|人像|用户/);
  assert.deepEqual(stored, {
    state: 'succeeded',
    provider_task_id: 'tts-task-success',
    artifact_path: `_system/provider-canary/runs/${run.id}/tts_sbx_success.mp3`,
    actual_cost_micros: 40_000,
  });
  assert.equal(db.prepare('SELECT state FROM provider_canary_evidence').get().state, 'fresh');
  assert.deepEqual(rowCounts(db), before);
});

test('TTS completed without a readable MP3 stays held as artifact_unreadable and is never retried', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'tts', 'bad-audio');
  const capability = capabilityFor('tts');
  const run = reserveRun(db, config, capability, 'tts-bad-audio');
  let submissions = 0;
  const options = baseOptions(capability, {
    clients: {
      async synthesizeTts(_db, _log, request) {
        submissions += 1;
        const relativePath = `${request.storage_subdir}/tts_sbx_invalid.mp3`;
        const filePath = path.join(request.storage_base, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, Buffer.from('not mp3'));
        return { local_path: relativePath, provider_task_id: 'tts-task-invalid' };
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, provider_task_id, actual_cost_micros, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.equal(result.state, 'artifact_unreadable');
  assert.equal(result.submitCount, 1);
  assert.equal(submissions, 1);
  assert.equal(stored.state, 'artifact_unreadable');
  assert.equal(stored.provider_task_id, 'tts-task-invalid');
  assert.equal(stored.actual_cost_micros, null);
  assert.match(stored.safe_error_summary, /^category=artifact_unreadable/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_canary_evidence WHERE state = 'fresh'").get().count, 0);
});

test('TTS unknown submit outcome stays held with its provider task id and is never retried', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'tts', 'unknown');
  const capability = capabilityFor('tts');
  const run = reserveRun(db, config, capability, 'tts-unknown');
  let submissions = 0;
  const options = baseOptions(capability, {
    clients: {
      async synthesizeTts() {
        submissions += 1;
        const error = new Error('private relay URL and key must not be stored');
        error.code = 'PROVIDER_STATUS_UNKNOWN';
        error.status = 'unknown';
        error.unknown = true;
        error.provider_task_id = 'tts-task-unknown';
        throw error;
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, provider_task_id, actual_cost_micros, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.equal(result.state, 'submission_unknown');
  assert.equal(result.submitCount, 1);
  assert.equal(submissions, 1);
  assert.equal(stored.provider_task_id, 'tts-task-unknown');
  assert.equal(stored.actual_cost_micros, null);
  assert.doesNotMatch(stored.safe_error_summary, /private|relay|key/);
});

test('TTS explicit pre-acceptance rejection refunds the canary budget once', async (t) => {
  const executor = loadExecutor();
  const db = createDb();
  t.after(() => db.close());
  const config = addConfig(db, 'tts', 'rejected');
  const capability = capabilityFor('tts');
  const run = reserveRun(db, config, capability, 'tts-rejected');
  let submissions = 0;
  const options = baseOptions(capability, {
    clients: {
      async synthesizeTts() {
        submissions += 1;
        const error = new Error('private provider response');
        error.route_meta = {
          httpStatus: 400,
          phase: 'submit',
          requestBodySent: false,
          explicitlyRejected: true,
        };
        throw error;
      },
    },
  });
  t.after(() => fs.rmSync(options.storageRoot, { recursive: true, force: true }));

  const result = await executor.executeCanaryRun(db, log, run, options);
  const stored = db.prepare(`SELECT state, actual_cost_micros, safe_error_summary
    FROM provider_canary_runs WHERE id = ?`).get(run.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.submitCount, 1);
  assert.equal(submissions, 1);
  assert.equal(stored.actual_cost_micros, 0);
  assert.equal(stored.safe_error_summary, 'category=validation_error status=400');
});
