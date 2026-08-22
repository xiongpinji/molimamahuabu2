const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldNormalizeVideoAfterDownload,
} = require('../src/services/videoService');

test('ToAPIs 已验证分辨率成片不得被二次放大到 2K', () => {
  assert.equal(shouldNormalizeVideoAfterDownload({ model: 'seedance-2-fast', resolution: '480p' }), false);
  assert.equal(shouldNormalizeVideoAfterDownload({ model: 'seedance-2-mini', resolution: '720p' }), false);
});

test('既有非 ToAPIs 视频仍保留统一画幅处理', () => {
  assert.equal(shouldNormalizeVideoAfterDownload({ model: 'video-v1', resolution: '720p' }), true);
});
