const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const taskService = require('../src/services/taskService');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const { MINIMAL_MP4, isoBmffTopLevelBoxes } = require('./fixtures/media');

const log = { info() {}, warn() {}, error() {} };

function waitFor(predicate, timeoutMs = 3000, intervalMs = 20) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error('等待视频恢复轮询完成超时'));
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

test('服务重启后按 provider_task_id 恢复轮询且不重复提交供应商任务', async () => {
  const previousCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-video-recovery-'));
  const configRoot = path.join(tempRoot, 'configs');
  const storageRoot = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, 'config.yaml'),
    [
      'app:',
      '  name: LocalMiniDrama video recovery test',
      '  version: test',
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      'storage:',
      '  type: local',
      `  local_path: ${storageRoot}`,
      '  base_url: http://127.0.0.1:0/static',
    ].join('\n'),
    'utf8'
  );

  const db = new Database(':memory:');
  const originalPoll = videoClient.pollVideoTask;
  const originalCall = videoClient.callVideoApi;
  const originalFetch = global.fetch;
  const configModulePath = require.resolve('../src/config');
  let pollCount = 0;
  let submitCount = 0;
  try {
    process.chdir(tempRoot);
    delete require.cache[configModulePath];
    runMigrationsAndEnsure(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         is_active, is_default, priority, created_at, updated_at)
       VALUES ('video', 'djpsd', 'djpsd', ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
    ).run(
      '本地恢复轮询供应商',
      'http://127.0.0.1:9',
      'test-only',
      JSON.stringify(['seedance 2.0']),
      'seedance 2.0',
      now,
      now
    );
    const task = taskService.createTask(db, log, 'video_generation', 'recovery-drama');
    taskService.updateTaskStatus(db, task.id, 'processing', 90, '供应商处理中');
    const videoId = Number(
      db.prepare(
        `INSERT INTO video_generations
          (provider, prompt, model, status, task_id, provider_task_id, created_at, updated_at)
         VALUES ('djpsd', ?, 'seedance 2.0', 'processing', ?, ?, ?, ?)`
      ).run('恢复轮询测试', task.id, 'provider-task-83047', now, now).lastInsertRowid
    );

    videoClient.callVideoApi = async () => {
      submitCount += 1;
      return { error: '恢复路径不应重新提交' };
    };
    videoClient.pollVideoTask = async (_db, _log, receivedVideoId, providerTaskId) => {
      pollCount += 1;
      assert.equal(receivedVideoId, videoId);
      assert.equal(providerTaskId, 'provider-task-83047');
      return { video_url: 'https://cdn.example/resumed.mp4' };
    };
    global.fetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => MINIMAL_MP4,
    });

    videoService.resumeProcessingVideoGenerations(db, log);
    const completed = await waitFor(() => {
      const row = db.prepare(
        'SELECT status, provider_task_id, video_url, local_path FROM video_generations WHERE id = ?'
      ).get(videoId);
      return row.status === 'completed' ? row : null;
    });

    assert.equal(submitCount, 0);
    assert.equal(pollCount, 1);
    assert.equal(completed.provider_task_id, 'provider-task-83047');
    assert.equal(completed.video_url, 'https://cdn.example/resumed.mp4');
    assert.ok(completed.local_path);
    const localVideoBytes = fs.readFileSync(path.join(storageRoot, completed.local_path.replace(/^\/static\//, '')));
    assert.ok(localVideoBytes.length > 16);
    const boxes = isoBmffTopLevelBoxes(localVideoBytes);
    assert.equal(boxes[0]?.type, 'ftyp');
    assert.ok(boxes.some((box) => box.type === 'moov' && box.size > 16));
    assert.ok(boxes.some((box) => box.type === 'mdat' && box.size > 8));
    const completedTask = taskService.getTask(db, task.id);
    assert.equal(completedTask.status, 'completed');
    assert.equal(JSON.parse(completedTask.result).video_generation_id, videoId);
  } finally {
    videoClient.pollVideoTask = originalPoll;
    videoClient.callVideoApi = originalCall;
    global.fetch = originalFetch;
    delete require.cache[configModulePath];
    db.close();
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
