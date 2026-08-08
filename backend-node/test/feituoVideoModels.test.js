const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FEITUO_MODELS,
  buildFeituoVideoBody,
} = require('../src/services/feituoVideoClient');

test('飞拓新视频模型使用精确上游 ID 和独立分辨率时长能力', () => {
  assert.deepEqual(
    FEITUO_MODELS['xuan-video-v1-6e7b4763634e6206'].resolutions,
    ['2k'],
  );
  assert.deepEqual(
    FEITUO_MODELS['xuan-video-v1-6e7b4763634e6206'].durations,
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  assert.deepEqual(FEITUO_MODELS['xuan-seedance-2.5'].resolutions, ['480p', '720p']);
  assert.deepEqual(
    FEITUO_MODELS['xuan-seedance-2.5'].durations,
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  assert.equal(FEITUO_MODELS['seedance-2.5'], undefined);
});

test('MiniMax H3-2K 请求只接受固定 2K 档位', () => {
  const body = buildFeituoVideoBody({
    model: 'xuan-video-v1-6e7b4763634e6206',
    prompt: '森林中的人物镜头',
    resolution: '2K',
    duration: 5,
    aspect_ratio: '16:9',
  });

  assert.equal(body.model, 'xuan-video-v1-6e7b4763634e6206');
  assert.equal(body.resolution, '2k');
  assert.equal(body.duration, 5);
  assert.throws(
    () => buildFeituoVideoBody({
      model: 'xuan-video-v1-6e7b4763634e6206',
      prompt: 'x',
      resolution: '720p',
      duration: 5,
    }),
    /不支持分辨率 720p/,
  );
  assert.throws(
    () => buildFeituoVideoBody({
      model: 'xuan-video-v1-6e7b4763634e6206',
      prompt: 'x',
      resolution: '2k',
      duration: 4,
    }),
    /不支持 4 秒/,
  );
});

test('Seedance 2.5 仅接受 xuan 渠道的 480P/720P', () => {
  const body = buildFeituoVideoBody({
    model: 'xuan-seedance-2.5',
    prompt: '镜头缓慢推进',
    resolution: '720P',
    duration: 4,
    ratio: '9:16',
  });

  assert.equal(body.model, 'xuan-seedance-2.5');
  assert.equal(body.resolution, '720p');
  assert.equal(body.duration, 4);
  assert.throws(
    () => buildFeituoVideoBody({
      model: 'seedance-2.5',
      prompt: 'x',
      resolution: '720p',
      duration: 5,
    }),
    /未经真实生成验证/,
  );
  assert.throws(
    () => buildFeituoVideoBody({
      model: 'xuan-seedance-2.5',
      prompt: 'x',
      resolution: '1080p',
      duration: 5,
    }),
    /不支持分辨率 1080p/,
  );
});
