'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFuminVideoBody } = require('../src/services/fuminVideoClient');

test('Fumin Seedance Mini 保留有声开关和多参考合同', () => {
  const body = buildFuminVideoBody({
    model: 'fumin-seedance-2.0-mini',
    prompt: 'Diego Santos says exactly in Spanish: No sigas.',
    duration: 5,
    resolution: '480p',
    aspect_ratio: '16:9',
    generate_audio: true,
    reference_urls: ['https://assets.example.test/diego.png'],
    reference_video_urls: ['https://assets.example.test/motion.mp4'],
  });

  assert.equal(body.model, 'seedance-2.0-mini');
  assert.equal(body.generate_audio, true);
  assert.equal(body.content.filter((item) => item.type === 'image_url').length, 1);
  assert.equal(body.content.filter((item) => item.type === 'video_url').length, 1);
});
test('Fumin 有声开关 false 不被丢失', () => {
  const body = buildFuminVideoBody({
    model: 'fumin-seedance-2.0-mini',
    prompt: 'silent shot',
    duration: 5,
    resolution: '480p',
    aspect_ratio: '16:9',
    generate_audio: false,
  });

  assert.equal(body.generate_audio, false);
});

test('Fumin Seedance Mini 允许已在供应商页面核验的 9:16 竖屏合同', () => {
  const body = buildFuminVideoBody({
    model: 'fumin-seedance-2.0-mini',
    prompt: 'Mateo says exactly in English: We leave tonight.',
    duration: 8,
    resolution: '480p',
    aspect_ratio: '9:16',
    generate_audio: true,
    reference_urls: ['https://assets.example.test/cast.png'],
    reference_video_urls: ['https://assets.example.test/shot-01.mp4'],
  });

  assert.equal(body.model, 'seedance-2.0-mini');
  assert.equal(body.ratio, '9:16');
  assert.equal(body.duration, 8);
  assert.equal(body.resolution, '480p');
  assert.equal(body.generate_audio, true);
});

test('Fumin 继续拒绝未核验的视频比例', () => {
  assert.throws(() => buildFuminVideoBody({
    model: 'fumin-seedance-2.0-mini',
    prompt: 'unsupported ratio',
    duration: 8,
    resolution: '480p',
    aspect_ratio: '1:1',
    generate_audio: true,
  }), /仅开放已核验的 16:9 和 9:16/);
});
