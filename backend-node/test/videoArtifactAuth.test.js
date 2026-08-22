const test = require('node:test');
const assert = require('node:assert/strict');

const { getVideoArtifactFetchOptions } = require('../src/services/videoClient');

test('视频成品下载仅向同源供应商地址附加鉴权', () => {
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
    { headers: { Authorization: 'Bearer artifact-secret' } }
  );
  assert.deepEqual(
    getVideoArtifactFetchOptions(
      { ...config, provider: 'xai', api_protocol: 'xai' },
      'https://seed.alimyun.xyz/api/open/v1/videos/task-2/download'
    ),
    { headers: { Authorization: 'Bearer artifact-secret' } }
  );
  assert.deepEqual(
    getVideoArtifactFetchOptions(
      { ...config, api_key: '' },
      'https://seed.alimyun.xyz/api/open/v1/videos/task-3/download'
    ),
    {}
  );
});
