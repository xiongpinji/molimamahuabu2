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

test('AIHubCC high-resolution image models use async video task contract', () => {
  assert.equal(client.isAsyncImageModel('gpt-image-2-2k'), true);
  const body = client.buildImageBody({
    model: 'gpt-image-2-3.5k',
    prompt: 'portrait',
    size: '1024x1536',
    referenceUrls: ['https://example.com/character.png'],
  });
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(body.image_url, 'https://example.com/character.png');
  assert.equal('image' in body, false);
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

test('AIHubCC extracts direct, nested and relative media URLs', () => {
  const config = { base_url: 'https://aihubcc.cc/v1' };
  assert.equal(client.extractMediaUrl({ video_url: 'https://cdn.example.com/a.mp4' }, config), 'https://cdn.example.com/a.mp4');
  assert.equal(client.extractMediaUrl({ data: [{ url: '/files/a.png' }] }, config), 'https://aihubcc.cc/v1/files/a.png');
  assert.equal(client.extractTaskId({ data: { id: 'task_123' } }), 'task_123');
  assert.equal(client.extractStatus({ data: { task_status: 'SUCCESS' } }), 'success');
});
