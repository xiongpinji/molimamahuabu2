const test = require('node:test');
const assert = require('node:assert/strict');

const { getVideoArtifactFetchOptions } = require('../src/services/videoClient');

test('AIHubCC 视频成品下载仅向同源地址附加供应商鉴权', () => {
  const config = {
    provider: 'aihubcc_video',
    api_protocol: 'aihubcc',
    base_url: 'https://seed.alimyun.xyz/api/open/v1',
    api_key: 'artifact-secret',
  };

  assert.deepEqual(
    getVideoArtifactFetchOptions(
      config,
      'https://seed.alimyun.xyz/api/open/v1/videos/task-1/content'
    ),
    { headers: { Authorization: 'Bearer artifact-secret' } }
  );
  assert.deepEqual(
    getVideoArtifactFetchOptions(config, 'https://untrusted.example/video.mp4'),
    {}
  );
  assert.deepEqual(
    getVideoArtifactFetchOptions(
      { ...config, provider: 'openai', api_protocol: 'openai' },
      'https://seed.alimyun.xyz/video.mp4'
    ),
    {}
  );
});
