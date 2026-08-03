const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readStoredMediaReference } = require('../src/services/mediaReferenceResolver');

function fixture(t, relativePath, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-reference-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { root, file };
}

test('统一读取受保护 static 下的图片、音频和视频参考', (t) => {
  const image = fixture(t, path.join('projects', 'demo', 'ref.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
  const audio = fixture(t, path.join('projects', 'demo', 'voice.wav'), Buffer.from('RIFF0000WAVEfmt ', 'ascii'));
  const video = fixture(t, path.join('projects', 'demo', 'motion.mp4'), Buffer.from('0000ftypisom', 'ascii'));

  assert.equal(readStoredMediaReference('/static/projects/demo/ref.jpg', {
    storageLocalPath: image.root,
    expectedType: 'image',
  }).mimeType, 'image/jpeg');
  assert.equal(readStoredMediaReference('https://molimama.vip/static/projects/demo/voice.wav', {
    filesBaseUrl: 'https://molimama.vip/static',
    storageLocalPath: audio.root,
    expectedType: 'audio',
  }).mimeType, 'audio/wav');
  assert.equal(readStoredMediaReference('/static/projects/demo/motion.mp4', {
    storageLocalPath: video.root,
    expectedType: 'video',
  }).mimeType, 'video/mp4');
});

test('统一媒体读取拒绝目录越界和错误媒体类型', (t) => {
  const stored = fixture(t, 'voice.wav', Buffer.from('RIFF0000WAVEfmt ', 'ascii'));

  assert.throws(() => readStoredMediaReference('/static/../voice.wav', {
    storageLocalPath: stored.root,
    expectedType: 'audio',
  }), /路径无效/);
  assert.throws(() => readStoredMediaReference('/static/voice.wav', {
    storageLocalPath: stored.root,
    expectedType: 'image',
  }), /不是有效的图片/);
});
