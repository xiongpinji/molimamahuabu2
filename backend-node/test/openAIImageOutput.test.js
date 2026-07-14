const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getOpenAIImageOutputOptions,
  normalizeGptImageSize,
  imageMimeFromOutputFormat,
  formatGptImageUnknownResultError,
} = require('../src/services/imageClient');

test('GPT Image 使用压缩 JPEG，缩短同步响应时间并减小返回体', () => {
  assert.deepEqual(getOpenAIImageOutputOptions('gpt-image-2', null), {
    output_format: 'jpeg',
    output_compression: 85,
    quality: 'low',
  });
  assert.equal(getOpenAIImageOutputOptions('gpt-image-2', 'high').quality, undefined);
  assert.deepEqual(getOpenAIImageOutputOptions('dall-e-3', null), {});
});

test('GPT Image 将项目尺寸映射到模型支持的较小尺寸', () => {
  assert.equal(normalizeGptImageSize('2560x1440'), '1536x1024');
  assert.equal(normalizeGptImageSize('1440x2560'), '1024x1536');
  assert.equal(normalizeGptImageSize('1024x1024'), '1024x1024');
});

test('base64 图片 MIME 与请求输出格式保持一致', () => {
  assert.equal(imageMimeFromOutputFormat('jpeg'), 'image/jpeg');
  assert.equal(imageMimeFromOutputFormat('webp'), 'image/webp');
  assert.equal(imageMimeFromOutputFormat(), 'image/png');
});

test('GPT Image 同步连接中断明确提示结果未知与重复扣费风险', () => {
  const message = formatGptImageUnknownResultError(new Error('socket hang up'));
  assert.match(message, /结果未知/);
  assert.match(message, /不要连续重试/);
  assert.match(message, /重复扣费/);
  assert.match(message, /socket hang up/);
});
