const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('../src/services/aihubccClient');

test('AIHubCC URL joins /v1 exactly once', () => {
  const config = { base_url: 'https://aihubcc.cc/v1', endpoint: '/v1/videos' };
  assert.equal(client.getSubmitUrl(config), 'https://aihubcc.cc/v1/videos');
  assert.equal(client.getQueryUrl(config, 'task/1'), 'https://aihubcc.cc/v1/videos/task%2F1');
  assert.equal(client.getSubmitUrl({ base_url: 'https://aihubcc.cc', endpoint: '/videos' }), 'https://aihubcc.cc/v1/videos');
});

test('AIHubCC 1K image body keeps reference images and quality', () => {
  const body = client.buildImageBody({
    model: 'gpt-image-2-1k',
    prompt: 'a continuous forest shot',
    size: '1536x1024',
    quality: 'high',
    referenceUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
  });
  assert.equal(body.model, 'gpt-image-2-1k');
  assert.equal(body.quality, 'high');
  assert.deepEqual(body.reference_image_urls, ['https://example.com/a.png', 'https://example.com/b.png']);
  assert.equal('image' in body, false);
});

test('AIHubCC gpt-image-2-2k uses synchronous chat image contract', () => {
  assert.equal(client.isFlowImageModel('gpt-image-2-2k'), true);
  const body = client.buildFlowImageBody({
    model: 'gpt-image-2-2k',
    prompt: 'portrait',
  });
  assert.equal(body.model, 'gpt-image-2-2k');
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content, 'portrait');
});

test('AIHubCC Flow image uses chat completion multimodal contract', () => {
  assert.equal(client.isFlowImageModel('gemini-3.1-flash-image-landscape'), true);
  assert.equal(client.isFlowImageModel('imagen-4.0-generate-preview-portrait'), true);
  assert.equal(client.isFlowImageModel('gpt-image-2'), false);
  const body = client.buildFlowImageBody({
    model: 'gemini-3.1-flash-image-landscape',
    prompt: 'keep the same character',
    referenceUrls: ['https://example.com/character.png'],
  });
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.deepEqual(body.messages[0].content[1], {
    type: 'image_url',
    image_url: { url: 'https://example.com/character.png' },
  });
  assert.equal(
    client.extractFlowImageUrl({
      choices: [{ message: { content: '![Generated Image](https://cdn.example.com/flow.png?sig=1)' } }],
    }),
    'https://cdn.example.com/flow.png?sig=1'
  );
});

test('AIHubCC video body maps Omni and Seedance fields', () => {
  const omni = client.buildVideoBody({
    model: 'omni-fast',
    prompt: 'camera slowly pushes in',
    duration: 8,
    aspect_ratio: '9:16',
    image_url: 'https://example.com/first.png',
    reference_urls: ['https://example.com/scene.png'],
  });
  assert.equal(omni.seconds, 8);
  assert.equal(omni.duration, undefined);
  assert.equal(omni.images.length, 1);

  const seedance = client.buildVideoBody({
    model: 'Seedance-2.0-720p',
    prompt: 'walk forward',
    duration: 6,
    first_frame_url: 'https://example.com/first.png',
    last_frame_url: 'https://example.com/last.png',
    reference_urls: ['https://example.com/character.png'],
  });
  assert.equal(seedance.duration, 6);
  assert.equal(seedance.first_image_url, 'https://example.com/first.png');
  assert.equal(seedance.image_url, undefined);
  assert.equal(seedance.last_image_url, 'https://example.com/last.png');
  assert.deepEqual(seedance.reference_image_urls, ['https://example.com/character.png']);
});

test('lingjing video body uses ratio and ordered reference_images', () => {
  assert.deepEqual(client.buildVideoBody({
    model: 'lingjing-video-v1',
    prompt: 'animate',
    duration: 15,
    aspect_ratio: '9:16',
    reference_urls: ['uploads/one.png', 'uploads/two.png'],
  }), {
    model: 'lingjing-video-v1',
    prompt: 'animate',
    duration: 15,
    ratio: '9:16',
    reference_images: ['uploads/one.png', 'uploads/two.png'],
  });
});

test('lingjing video body advances unsupported durations to the next supported value', () => {
  assert.equal(client.buildVideoBody({
    model: 'lingjing-video-v1',
    prompt: 'nine seconds',
    duration: 9,
  }).duration, 10);
  assert.equal(client.buildVideoBody({
    model: 'lingjing-video-v1',
    prompt: 'twelve seconds',
    duration: 12,
  }).duration, 15);
});


test('AIHubCC Flow video relies on model name for duration and aspect ratio', () => {
  const flow = client.buildVideoBody({
    model: 'veo_3_1_i2v_s_fast_portrait_6s_fl',
    prompt: 'walk forward',
    duration: 10,
    aspect_ratio: '16:9',
    first_image_url: 'https://example.com/first.png',
    last_image_url: 'https://example.com/last.png',
    reference_urls: ['https://example.com/ref.png'],
  });
  assert.equal(flow.duration, undefined);
  assert.equal(flow.seconds, undefined);
  assert.equal(flow.aspect_ratio, undefined);
  assert.equal(flow.first_image_url, 'https://example.com/first.png');
  assert.equal(flow.last_image_url, 'https://example.com/last.png');
  assert.equal(flow.reference_image_urls, undefined);

  const r2v = client.buildVideoBody({
    model: 'veo_3_1_r2v_fast_portrait',
    prompt: 'merge references',
    reference_urls: [
      'https://example.com/1.png',
      'https://example.com/2.png',
      'https://example.com/3.png',
      'https://example.com/4.png',
    ],
  });
  assert.deepEqual(r2v.images, [
    'https://example.com/1.png',
    'https://example.com/2.png',
    'https://example.com/3.png',
  ]);
});

test('AIHubCC extracts direct, nested and relative media URLs', () => {
  const config = { base_url: 'https://aihubcc.cc/v1' };
  assert.equal(client.extractMediaUrl({ video_url: 'https://cdn.example.com/a.mp4' }, config), 'https://cdn.example.com/a.mp4');
  assert.equal(client.extractMediaUrl({ data: [{ url: '/files/a.png' }] }, config), 'https://aihubcc.cc/v1/files/a.png');
  assert.equal(client.extractTaskId({ data: { id: 'task_123' } }), 'task_123');
  assert.equal(client.extractStatus({ data: { task_status: 'SUCCESS' } }), 'success');
  assert.equal(client.extractUploadPath({ path: 'uploads/a.png' }), 'uploads/a.png');
  assert.equal(client.extractUploadPath({ data: { path: 'uploads/b.png' } }), 'uploads/b.png');
});
