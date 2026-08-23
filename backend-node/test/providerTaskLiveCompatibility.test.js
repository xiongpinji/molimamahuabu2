'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyProviderTaskLiveCompatibility,
  inspectProviderTaskLiveCompatibility,
} = require('../scripts/apply-provider-task-live-compat');

const LEGACY_MIGRATE = `const fs = require('fs');
function runMigrations(database) {
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    statements.forEach((stmt, i) => runOne(database, stmt + ';', file, i));
  }
}
/** compatibility anchor */
function ensureColumns() {}
`;

const LEGACY_VIDEO_CLIENT = `function configSupportsVideoModel(config, preferredModel) {
  const models = [
    ...(Array.isArray(config?.model) ? config.model : [config?.model]),
    config?.default_model,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  const requested = String(preferredModel || '').trim().toLowerCase();
  return models.includes(requested);
}
function hasColumn() {}
`;

const LEGACY_VIDEO_CLIENT_LIVE_SHAPE = LEGACY_VIDEO_CLIENT.replace(
  'function hasColumn() {}',
  'function getDefaultVideoConfig() {}',
);

const LEGACY_VIDEO_SERVICE = `async function finalizeSuccessfulVideo(db, log, videoGenId, row) {
  const now = new Date().toISOString();
  let localPath = null;
  let downloadIndeterminate = true;
  if (!localPath) {
    const message = 'held';
    if (downloadIndeterminate || markVideoArtifactUnreadable(db, videoGenId)) {
      db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
        .run('processing', message.slice(0, 500), now, videoGenId);
      markVideoCostUnknown(db, log, row);
      if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 90, message);
      log.warn('Video artifact unreadable; request held for review', { id: videoGenId });
      return false;
    }
  }
  const deliveryWarning = null;
}
function nextFunction() {}
`;

function createFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-task-live-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'backend-node/src/db/migrate.js': overrides.migrate ?? LEGACY_MIGRATE,
    'backend-node/src/services/videoClient.js': overrides.videoClient ?? LEGACY_VIDEO_CLIENT,
    'backend-node/src/services/videoService.js': overrides.videoService ?? LEGACY_VIDEO_SERVICE,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
}

test('候选兼容补丁只修复三处已知线上漂移并保留相邻源码', (t) => {
  const root = createFixture(t);
  const result = applyProviderTaskLiveCompatibility(root);

  assert.deepEqual(result, {
    ready: true,
    changedPaths: [
      'backend-node/src/db/migrate.js',
      'backend-node/src/services/videoClient.js',
      'backend-node/src/services/videoService.js',
    ],
  });
  const migrate = read(root, 'backend-node/src/db/migrate.js');
  assert.match(migrate, /const statements = splitSqlStatements\(sql\);/);
  assert.match(migrate, /function splitSqlStatements\(sql\)/);
  assert.match(migrate, /function ensureColumns\(\) \{\}/);

  const client = read(root, 'backend-node/src/services/videoClient.js');
  assert.match(client, /config\?\.default_model,\s+config\?\.logical_model_id,/);
  assert.match(client, /function hasColumn\(\) \{\}/);

  const service = read(root, 'backend-node/src/services/videoService.js');
  assert.match(service, /setVideoGenNeedsAttention\(db, videoGenId, row\.task_id, message, now\);/);
  assert.doesNotMatch(service, /\.run\('processing'/);
  assert.doesNotMatch(service, /updateTaskStatus\(db, row\.task_id, 'processing'/);
  assert.match(service, /function nextFunction\(\) \{\}/);
});

test('兼容补丁识别实时 current 中视频模型匹配函数的相邻函数边界', (t) => {
  const root = createFixture(t, { videoClient: LEGACY_VIDEO_CLIENT_LIVE_SHAPE });

  const result = applyProviderTaskLiveCompatibility(root);

  assert.deepEqual(result.changedPaths, [
    'backend-node/src/db/migrate.js',
    'backend-node/src/services/videoClient.js',
    'backend-node/src/services/videoService.js',
  ]);
  const client = read(root, 'backend-node/src/services/videoClient.js');
  assert.match(client, /config\?\.default_model,\s+config\?\.logical_model_id,/);
  assert.match(client, /function getDefaultVideoConfig\(\) \{\}/);
});

test('兼容补丁幂等，已正确候选不产生新改动', (t) => {
  const root = createFixture(t);
  applyProviderTaskLiveCompatibility(root);
  const before = Object.fromEntries([
    'backend-node/src/db/migrate.js',
    'backend-node/src/services/videoClient.js',
    'backend-node/src/services/videoService.js',
  ].map((relativePath) => [relativePath, read(root, relativePath)]));

  assert.deepEqual(applyProviderTaskLiveCompatibility(root), { ready: true, changedPaths: [] });
  for (const [relativePath, content] of Object.entries(before)) {
    assert.equal(read(root, relativePath), content);
  }
});

test('只读检查报告待修路径但不写候选', (t) => {
  const root = createFixture(t);
  const before = read(root, 'backend-node/src/db/migrate.js');
  assert.deepEqual(inspectProviderTaskLiveCompatibility(root), {
    ready: false,
    pendingPaths: [
      'backend-node/src/db/migrate.js',
      'backend-node/src/services/videoClient.js',
      'backend-node/src/services/videoService.js',
    ],
  });
  assert.equal(read(root, 'backend-node/src/db/migrate.js'), before);
});

test('任一源码形态未知时整批拒绝且零文件写入', (t) => {
  const root = createFixture(t, { videoClient: 'function unrelated() {}\n' });
  const before = Object.fromEntries([
    'backend-node/src/db/migrate.js',
    'backend-node/src/services/videoClient.js',
    'backend-node/src/services/videoService.js',
  ].map((relativePath) => [relativePath, read(root, relativePath)]));

  assert.throws(
    () => applyProviderTaskLiveCompatibility(root),
    { code: 'UNSUPPORTED_LIVE_DRIFT' },
  );
  for (const [relativePath, content] of Object.entries(before)) {
    assert.equal(read(root, relativePath), content);
  }
});

test('缺失目标文件时拒绝且不部分修改其他文件', (t) => {
  const root = createFixture(t);
  const clientPath = path.join(root, 'backend-node', 'src', 'services', 'videoClient.js');
  fs.rmSync(clientPath);
  const migrateBefore = read(root, 'backend-node/src/db/migrate.js');

  assert.throws(
    () => applyProviderTaskLiveCompatibility(root),
    { code: 'LIVE_COMPAT_TARGET_INVALID' },
  );
  assert.equal(read(root, 'backend-node/src/db/migrate.js'), migrateBefore);
});

test('目标符号链接或重解析点被拒绝', (t) => {
  const root = createFixture(t);
  const services = path.join(root, 'backend-node', 'src', 'services');
  const target = path.join(root, 'linked-services');
  fs.renameSync(services, target);
  fs.symlinkSync(target, services, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => applyProviderTaskLiveCompatibility(root),
    { code: 'LIVE_COMPAT_TARGET_INVALID' },
  );
});
