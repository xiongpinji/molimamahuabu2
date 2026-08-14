const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { verifyMotionReference } = require('../src/services/redrawMotionReferenceService');

const VIDEO_BYTES = Buffer.from('redraw-motion-reference-fixture');
const VIDEO_SHA256 = crypto.createHash('sha256').update(VIDEO_BYTES).digest('hex');
const SOURCE_FINGERPRINT = 'a'.repeat(64);
const FACE_COVERAGE_SHA256 = 'b'.repeat(64);
const TEXT_COVERAGE_SHA256 = 'c'.repeat(64);
const STALE_CODE = 'REDRAW_REFERENCE_BUNDLE_MOTION_REFERENCE_STALE';
const INPUT_CODE = 'REDRAW_REFERENCE_BUNDLE_INPUT_INVALID';
const STALE_MESSAGE = '运动参考不可用或已失效';

const DEFAULT_PROBE = Object.freeze({
  duration_ms: 5000,
  width: 864,
  height: 496,
  mime_type: 'video/mp4',
  video_codec: 'h264',
  audio_stream_count: 0,
});

const db = new Database(':memory:');
runMigrationsAndEnsure(db);
test.after(() => db.close());

let nextAssetId = 10000;

function createFixture(t) {
  const assetId = nextAssetId++;
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-motion-reference-'));
  const conditioningRoot = path.join(storageRoot, 'redraw-conditioning');
  const relativePath = `redraw-conditioning/${VIDEO_SHA256}.mp4`;
  const absolutePath = path.join(conditioningRoot, `${VIDEO_SHA256}.mp4`);
  fs.mkdirSync(conditioningRoot, { recursive: true });
  fs.writeFileSync(absolutePath, VIDEO_BYTES);

  const metadata = {
    redraw_motion_reference: {
      schema_version: 'redraw-motion-reference-v1',
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      version_id: 1,
      shot_id: 1,
      source_asset_id: 101,
      source_fingerprint: SOURCE_FINGERPRINT,
      clip_start_ms: 0,
      clip_end_ms: 5000,
      face_coverage_sha256: FACE_COVERAGE_SHA256,
      text_coverage_sha256: TEXT_COVERAGE_SHA256,
    },
  };

  db.prepare(`
    INSERT INTO assets (
      id, name, type, local_path, mime_type, metadata, created_at, updated_at
    ) VALUES (?, ?, 'video', ?, 'video/mp4', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(assetId, 'motion-reference', relativePath, JSON.stringify(metadata));

  t.after(() => {
    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  const input = {
    db,
    storageRoot,
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: 1,
    shotId: 1,
    assetId,
    expected: {
      source_asset_id: 101,
      source_fingerprint: SOURCE_FINGERPRINT,
      clip_start_ms: 0,
      clip_end_ms: 5000,
      face_coverage_sha256: FACE_COVERAGE_SHA256,
      text_coverage_sha256: TEXT_COVERAGE_SHA256,
    },
    probeRunner: async () => ({ ...DEFAULT_PROBE }),
  };

  return {
    assetId,
    storageRoot,
    conditioningRoot,
    relativePath,
    absolutePath,
    metadata,
    input,
  };
}

function updateAsset(fixture, fields) {
  const entries = Object.entries(fields);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE assets SET ${assignments} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), fixture.assetId);
}

function updateMotionMetadata(fixture, fields) {
  const metadata = {
    ...fixture.metadata,
    redraw_motion_reference: {
      ...fixture.metadata.redraw_motion_reference,
      ...fields,
    },
  };
  updateAsset(fixture, { metadata: JSON.stringify(metadata) });
}

async function captureError(input) {
  try {
    await verifyMotionReference(input);
  } catch (error) {
    return error;
  }
  assert.fail('expected verifyMotionReference to reject');
}

function assertRootRedacted(error, storageRoot) {
  const serialized = JSON.stringify(error);
  const escapedRoot = JSON.stringify(storageRoot).slice(1, -1);
  assert.equal(error.message.includes(storageRoot), false);
  assert.equal(serialized.includes(storageRoot), false);
  assert.equal(serialized.includes(escapedRoot), false);
  assert.equal(Object.hasOwn(error, 'cause'), false);
}

async function expectStale(fixture, input = fixture.input) {
  const error = await captureError(input);
  assert.equal(error.code, STALE_CODE);
  assert.equal(error.message, STALE_MESSAGE);
  assertRootRedacted(error, fixture.storageRoot);
  return error;
}

test('运动参考成功返回仅白名单媒体与绑定证据', async (t) => {
  const fixture = createFixture(t);

  const verified = await verifyMotionReference(fixture.input);

  assert.deepEqual(Object.keys(verified).sort(), [
    'asset_id',
    'audio_stream_count',
    'clip_end_ms',
    'clip_start_ms',
    'duration_ms',
    'face_coverage_sha256',
    'height',
    'mime_type',
    'sha256',
    'source_asset_id',
    'source_fingerprint',
    'text_coverage_sha256',
    'video_codec',
    'width',
  ].sort());
  assert.deepEqual(verified, {
    asset_id: fixture.assetId,
    sha256: VIDEO_SHA256,
    duration_ms: 5000,
    width: 864,
    height: 496,
    mime_type: 'video/mp4',
    video_codec: 'h264',
    audio_stream_count: 0,
    source_asset_id: 101,
    source_fingerprint: SOURCE_FINGERPRINT,
    clip_start_ms: 0,
    clip_end_ms: 5000,
    face_coverage_sha256: FACE_COVERAGE_SHA256,
    text_coverage_sha256: TEXT_COVERAGE_SHA256,
  });
  assert.equal(verified.path, undefined);
  assert.match(verified.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(verified).includes(fixture.storageRoot), false);
});

test('时长在 100ms 容差边界内可接受', async (t) => {
  const fixture = createFixture(t);
  fixture.input.probeRunner = async () => ({ ...DEFAULT_PROBE, duration_ms: 5100 });

  const verified = await verifyMotionReference(fixture.input);

  assert.equal(verified.duration_ms, 5100);
});

test('明显非法调用上下文返回输入错误且不泄露 root', async (t) => {
  const fixture = createFixture(t);

  const error = await captureError({ ...fixture.input, tenantId: '' });

  assert.equal(error.code, INPUT_CODE);
  assertRootRedacted(error, fixture.storageRoot);
});

test('绝对 local_path fail closed', async (t) => {
  const fixture = createFixture(t);
  updateAsset(fixture, { local_path: fixture.absolutePath });
  await expectStale(fixture);
});

test('包含 .. 的 local_path fail closed', async (t) => {
  const fixture = createFixture(t);
  updateAsset(fixture, { local_path: `redraw-conditioning/../${VIDEO_SHA256}.mp4` });
  await expectStale(fixture);
});

test('redraw-conditioning 符号链接逃逸 storage root fail closed', async (t) => {
  const fixture = createFixture(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-motion-outside-'));
  fs.writeFileSync(path.join(outsideRoot, `${VIDEO_SHA256}.mp4`), VIDEO_BYTES);
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

  fs.rmSync(fixture.conditioningRoot, { recursive: true, force: true });
  try {
    fs.symlinkSync(outsideRoot, fixture.conditioningRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`platform does not permit directory symlinks: ${error.code}`);
      return;
    }
    throw error;
  }

  await expectStale(fixture);
});

test('资产不存在 fail closed', async (t) => {
  const fixture = createFixture(t);
  db.prepare('DELETE FROM assets WHERE id = ?').run(fixture.assetId);
  await expectStale(fixture);
});

test('资产已删除 fail closed', async (t) => {
  const fixture = createFixture(t);
  updateAsset(fixture, { deleted_at: new Date().toISOString() });
  await expectStale(fixture);
});

test('参考文件不存在 fail closed', async (t) => {
  const fixture = createFixture(t);
  fs.unlinkSync(fixture.absolutePath);
  await expectStale(fixture);
});

for (const [name, field, value] of [
  ['tenant', 'tenant_id', 'tenant-b'],
  ['user', 'user_id', 'user-b'],
  ['version', 'version_id', 2],
  ['shot', 'shot_id', 2],
]) {
  test(`跨 ${name} 运动参考 fail closed`, async (t) => {
    const fixture = createFixture(t);
    updateMotionMetadata(fixture, { [field]: value });
    await expectStale(fixture);
  });
}

test('资产 type 非 video fail closed', async (t) => {
  const fixture = createFixture(t);
  updateAsset(fixture, { type: 'image' });
  await expectStale(fixture);
});

test('资产 mime_type 非 video/mp4 fail closed', async (t) => {
  const fixture = createFixture(t);
  updateAsset(fixture, { mime_type: 'video/quicktime' });
  await expectStale(fixture);
});

test('损坏的 metadata JSON fail closed', async (t) => {
  const fixture = createFixture(t);
  updateAsset(fixture, { metadata: '{' });
  await expectStale(fixture);
});

test('缺失必需 metadata 字段 fail closed', async (t) => {
  const fixture = createFixture(t);
  const motion = { ...fixture.metadata.redraw_motion_reference };
  delete motion.text_coverage_sha256;
  updateAsset(fixture, { metadata: JSON.stringify({ redraw_motion_reference: motion }) });
  await expectStale(fixture);
});

test('文件内容 hash 与文件名漂移 fail closed', async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(fixture.absolutePath, Buffer.from('drifted-before-verification'));
  await expectStale(fixture);
});

for (const [name, field, value] of [
  ['source asset', 'source_asset_id', 102],
  ['source fingerprint', 'source_fingerprint', 'd'.repeat(64)],
  ['clip start', 'clip_start_ms', 1],
  ['clip end', 'clip_end_ms', 4999],
  ['face coverage hash', 'face_coverage_sha256', 'd'.repeat(64)],
  ['text coverage hash', 'text_coverage_sha256', 'd'.repeat(64)],
]) {
  test(`${name} 与期望绑定不符 fail closed`, async (t) => {
    const fixture = createFixture(t);
    updateMotionMetadata(fixture, { [field]: value });
    await expectStale(fixture);
  });
}

for (const [name, field, value] of [
  ['duration', 'duration_ms', 5101],
  ['width', 'width', 0],
  ['height', 'height', -1],
  ['mime', 'mime_type', 'video/quicktime'],
  ['codec', 'video_codec', 'hevc'],
  ['audio stream', 'audio_stream_count', 1],
]) {
  test(`probe ${name} 不符媒体合同 fail closed`, async (t) => {
    const fixture = createFixture(t);
    fixture.input.probeRunner = async () => ({ ...DEFAULT_PROBE, [field]: value });
    await expectStale(fixture);
  });
}

test('probe 抛错统一 fail closed', async (t) => {
  const fixture = createFixture(t);
  fixture.input.probeRunner = async () => {
    throw new Error(`ffprobe failed at ${fixture.absolutePath}`);
  };
  await expectStale(fixture);
});

test('验证中 realpath 逃逸 fail closed', async (t) => {
  const fixture = createFixture(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-motion-drift-outside-'));
  fs.writeFileSync(path.join(outsideRoot, `${VIDEO_SHA256}.mp4`), VIDEO_BYTES);
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

  fixture.input.probeRunner = async () => {
    fs.rmSync(fixture.conditioningRoot, { recursive: true, force: true });
    try {
      fs.symlinkSync(outsideRoot, fixture.conditioningRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        t.skip(`platform does not permit directory symlinks: ${error.code}`);
        return { ...DEFAULT_PROBE };
      }
      throw error;
    }
    return { ...DEFAULT_PROBE };
  };

  const error = await captureError(fixture.input);
  if (t.skipped) return;
  assert.equal(error.code, STALE_CODE);
  assert.equal(error.message, STALE_MESSAGE);
  assertRootRedacted(error, fixture.storageRoot);
});

test('验证中 stat 时间证据漂移 fail closed', async (t) => {
  const fixture = createFixture(t);
  fixture.input.probeRunner = async () => {
    fs.utimesSync(fixture.absolutePath, new Date(1000), new Date(2000));
    return { ...DEFAULT_PROBE };
  };
  await expectStale(fixture);
});

test('验证中文件身份漂移 fail closed', async (t) => {
  const fixture = createFixture(t);
  fixture.input.probeRunner = async () => {
    fs.unlinkSync(fixture.absolutePath);
    fs.writeFileSync(fixture.absolutePath, VIDEO_BYTES);
    return { ...DEFAULT_PROBE };
  };
  await expectStale(fixture);
});

test('验证中 hash 与 size 漂移 fail closed', async (t) => {
  const fixture = createFixture(t);
  fixture.input.probeRunner = async () => {
    fs.writeFileSync(fixture.absolutePath, Buffer.from('drifted-during-verification'));
    return { ...DEFAULT_PROBE };
  };
  await expectStale(fixture);
});
