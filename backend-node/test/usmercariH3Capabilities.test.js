const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const usmercariVideoClient = require('../src/services/usmercariVideoClient');
const canvasModelCatalogService = require('../src/services/canvasModelCatalogService');
const videoReferenceCapabilityService = require('../src/services/videoReferenceCapabilityService');

test('MiniMax H3 只开放供应商实际支持的 1440P 与 5-15 秒', () => {
  const spec = usmercariVideoClient.USMERCARI_MODELS['MiniMax H3'];
  assert.deepEqual(spec.resolutions, ['1440p']);
  assert.deepEqual(spec.durations, Array.from({ length: 11 }, (_, index) => index + 5));
  assert.equal(spec.maxImages, 3);

  assert.deepEqual(
    canvasModelCatalogService.providerCapabilities('usmercari', 'MiniMax H3').resolutions,
    ['1440p'],
  );
  const catalogCapability = canvasModelCatalogService.providerCapabilities('usmercari', 'MiniMax H3');
  assert.equal(catalogCapability.maxReferences, 3);
  assert.equal(catalogCapability.maxImageReferences, 3);

  const resolvedCapability = videoReferenceCapabilityService.resolve({
    provider: 'usmercari',
    api_protocol: 'usmercari_media',
  }, 'MiniMax H3');
  assert.equal(resolvedCapability.maxReferences, 3);
  assert.equal(resolvedCapability.maxImageReferences, 3);
  assert.deepEqual(
    canvasModelCatalogService.providerCapabilities('usmercari', 'MiniMax H3').durations,
    Array.from({ length: 11 }, (_, index) => index + 5),
  );
});

test('MiniMax H3 请求保留 1440P 与参考图，拒绝 480P 和 4 秒', () => {
  const body = usmercariVideoClient.buildUsmercariVideoBody({
    model: 'MiniMax H3',
    prompt: 'safe cat reference',
    duration: 5,
    resolution: '1440p',
    aspect_ratio: '16:9',
    image_ids: ['image-1'],
  });
  assert.equal(body.metadata.resolution, '1440p');
  assert.deepEqual(body.metadata.image_ids, ['image-1']);

  const threeReferences = usmercariVideoClient.buildUsmercariVideoBody({
    model: 'MiniMax H3',
    prompt: 'three verified references',
    duration: 15,
    resolution: '1440p',
    aspect_ratio: '16:9',
    image_ids: ['image-1', 'image-2', 'image-3'],
  });
  assert.deepEqual(threeReferences.metadata.image_ids, ['image-1', 'image-2', 'image-3']);
  assert.throws(() => usmercariVideoClient.buildUsmercariVideoBody({
    model: 'MiniMax H3',
    prompt: 'four references must stop locally',
    duration: 15,
    resolution: '1440p',
    aspect_ratio: '16:9',
    image_ids: ['image-1', 'image-2', 'image-3', 'image-4'],
  }), /最多支持 3 张参考图/);

  assert.throws(() => usmercariVideoClient.buildUsmercariVideoBody({
    model: 'MiniMax H3', duration: 5, resolution: '480p', aspect_ratio: '16:9',
  }), /只开放已实测的 1440p/);
  assert.throws(() => usmercariVideoClient.buildUsmercariVideoBody({
    model: 'MiniMax H3', duration: 4, resolution: '1440p', aspect_ratio: '16:9',
  }), /时长必须是 5 到 15 秒/);
});

test('Seedance 2.0 仍保留 480P/720P 与 4-15 秒能力', () => {
  for (const model of ['seedance-2.0-fast', 'seedance-2.0-mini']) {
    const spec = usmercariVideoClient.USMERCARI_MODELS[model];
    assert.deepEqual(spec.resolutions, ['480p', '720p']);
    assert.deepEqual(spec.durations, Array.from({ length: 12 }, (_, index) => index + 4));
  }
});

test('画布目录直接复用 USMercari 客户端规格，不维护第二份模型能力表', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/services/canvasModelCatalogService.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /USMERCARI_MODEL_MEDIA_LIMITS/);

  for (const [model, spec] of Object.entries(usmercariVideoClient.USMERCARI_MODELS)) {
    const capability = canvasModelCatalogService.providerCapabilities('usmercari', model);
    assert.equal(capability.maxReferences, spec.maxImages);
    assert.equal(capability.maxVideoReferences, spec.maxVideos);
    assert.equal(capability.maxAudioReferences, spec.maxAudio);
    assert.equal(capability.supportsVideoReference, spec.maxVideos > 0);
    assert.deepEqual(capability.resolutions, spec.resolutions);
    assert.deepEqual(capability.durations, spec.durations);
  }
});
