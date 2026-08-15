const test = require('node:test');
const assert = require('node:assert/strict');

const { targetVideoPixelsForAspect } = require('../src/services/videoService');

test('视频归一化按用户选择的清晰度输出目标像素', () => {
  assert.deepEqual(targetVideoPixelsForAspect('16:9', '480p'), { w: 854, h: 480 });
  assert.deepEqual(targetVideoPixelsForAspect('9:16', '480p'), { w: 480, h: 854 });
  assert.deepEqual(targetVideoPixelsForAspect('16:9', '720p'), { w: 1280, h: 720 });
  assert.deepEqual(targetVideoPixelsForAspect('1:1', '720p'), { w: 720, h: 720 });
  assert.deepEqual(targetVideoPixelsForAspect('16:9', '2k'), { w: 2560, h: 1440 });
});

test('未声明清晰度时保留既有 2K 画幅归一化合同', () => {
  assert.deepEqual(targetVideoPixelsForAspect('16:9'), { w: 2560, h: 1440 });
  assert.deepEqual(targetVideoPixelsForAspect('9:16'), { w: 1440, h: 2560 });
});
