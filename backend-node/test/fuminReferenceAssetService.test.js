'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveFuminReference,
} = require('../src/services/fuminReferenceAssetService');

function createStorage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-reference-assets-'));
  fs.mkdirSync(path.join(root, 'redraw'), { recursive: true });
  fs.writeFileSync(path.join(root, 'redraw', 'identity.png'), Buffer.from('approved-image'));
  fs.writeFileSync(path.join(root, 'redraw', 'motion.mp4'), Buffer.from('approved-video'));
  return root;
}

test('同源 static 身份图从受控存储读取并在生成前上传到 Fumin', async () => {
  const root = createStorage();
  const calls = [];
  try {
    const result = await resolveFuminReference({
      rawUrl: 'https://assets.example.test/static/redraw/identity.png?provider_asset_signature=signed',
      filesBaseUrl: 'https://assets.example.test',
      storageRoot: root,
      kind: 'image',
      index: 0,
      uploadAsset: async (input) => {
        calls.push(input);
        return { asset_id: 'image-asset', url: 'https://fumin.ai/files/image-asset.png' };
      },
    });

    assert.equal(result, 'https://fumin.ai/files/image-asset.png');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].filename, 'identity.png');
    assert.equal(calls[0].mimeType, 'image/png');
    assert.deepEqual(calls[0].bytes, Buffer.from('approved-image'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('本地 static 动作参考上传为视频，外部 HTTPS 与服务端 asset URI 保持不变', async () => {
  const root = createStorage();
  let uploads = 0;
  try {
    const uploadAsset = async ({ mimeType }) => {
      uploads += 1;
      assert.equal(mimeType, 'video/mp4');
      return { asset_id: 'video-asset', url: 'https://fumin.ai/files/video-asset.mp4' };
    };
    assert.equal(await resolveFuminReference({
      rawUrl: '/static/redraw/motion.mp4',
      filesBaseUrl: '',
      storageRoot: root,
      kind: 'video',
      index: 0,
      uploadAsset,
    }), 'https://fumin.ai/files/video-asset.mp4');
    assert.equal(await resolveFuminReference({
      rawUrl: 'https://trusted-cdn.example/reference/motion.mp4',
      filesBaseUrl: 'https://assets.example.test',
      storageRoot: root,
      kind: 'video',
      index: 0,
      uploadAsset,
    }), 'https://trusted-cdn.example/reference/motion.mp4');
    assert.equal(await resolveFuminReference({
      rawUrl: 'asset://server-owned-reference',
      filesBaseUrl: '',
      storageRoot: root,
      kind: 'video',
      index: 0,
      uploadAsset,
    }), 'asset://server-owned-reference');
    assert.equal(uploads, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('路径穿越、符号链接和错误媒体类型在上传前 fail closed', async (t) => {
  const root = createStorage();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-reference-outside-'));
  fs.writeFileSync(path.join(outside, 'outside.mp4'), Buffer.from('outside'));
  let uploads = 0;
  const uploadAsset = async () => {
    uploads += 1;
    return { asset_id: 'forbidden', url: 'https://fumin.ai/files/forbidden' };
  };
  try {
    try {
      fs.symlinkSync(path.join(outside, 'outside.mp4'), path.join(root, 'redraw', 'linked.mp4'));
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.diagnostic('symbolic link creation is unavailable on this Windows host');
      } else {
        throw error;
      }
    }
    for (const rawUrl of [
      '/static/%2e%2e/outside.mp4',
      '/static/redraw/identity.png',
      ...(fs.existsSync(path.join(root, 'redraw', 'linked.mp4')) ? ['/static/redraw/linked.mp4'] : []),
    ]) {
      await assert.rejects(() => resolveFuminReference({
        rawUrl,
        filesBaseUrl: '',
        storageRoot: root,
        kind: 'video',
        index: 0,
        uploadAsset,
      }), { code: 'FUMIN_REFERENCE_ASSET_INVALID' });
    }
    assert.equal(uploads, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('本地 static 素材缺少隔离存储根目录时拒绝上传', async () => {
  let uploads = 0;
  await assert.rejects(() => resolveFuminReference({
    rawUrl: '/static/redraw/identity.png',
    filesBaseUrl: '',
    storageRoot: '',
    kind: 'image',
    uploadAsset: async () => {
      uploads += 1;
      return { url: 'https://fumin.ai/files/forbidden.png' };
    },
  }), {
    code: 'FUMIN_REFERENCE_ASSET_INVALID',
    message: 'Fumin 参考素材缺少隔离存储根目录',
  });
  assert.equal(uploads, 0);
});

test('超过平台媒体上限的本地素材在读入内存和上传前拒绝', async () => {
  const root = createStorage();
  const oversizedImage = path.join(root, 'redraw', 'oversized.png');
  fs.writeFileSync(oversizedImage, Buffer.alloc(1));
  fs.truncateSync(oversizedImage, (16 * 1024 * 1024) + 1);
  let uploads = 0;
  try {
    await assert.rejects(() => resolveFuminReference({
      rawUrl: '/static/redraw/oversized.png',
      filesBaseUrl: '',
      storageRoot: root,
      kind: 'image',
      uploadAsset: async () => {
        uploads += 1;
        return { url: 'https://fumin.ai/files/forbidden.png' };
      },
    }), {
      code: 'FUMIN_REFERENCE_ASSET_TOO_LARGE',
      message: 'Fumin 图片参考素材不能超过 16MB',
    });
    assert.equal(uploads, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
