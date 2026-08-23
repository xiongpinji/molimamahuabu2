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
       VALUES ('video', 'aihubcc_video', 'aihubcc', ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
    ).run(
      '本地恢复轮询供应商',
      'https://seed.alimyun.xyz/api/open/v1',
      'artifact-secret',
      JSON.stringify(['legacy-video-v1']),
      'legacy-video-v1',
      now,
      now
    );
    const task = taskService.createTask(db, log, 'video_generation', 'recovery-drama');
    taskService.updateTaskStatus(db, task.id, 'processing', 90, '供应商处理中');
    const videoId = Number(
      db.prepare(
        `INSERT INTO video_generations
          (provider, prompt, model, status, task_id, provider_task_id, created_at, updated_at)
         VALUES ('aihubcc_video', ?, 'legacy-video-v1', 'processing', ?, ?, ?, ?)`
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
      return { video_url: 'https://seed.alimyun.xyz/api/open/v1/videos/provider-task-83047/content' };
    };
    global.fetch = async (_url, options = {}) => {
      assert.equal(options.headers?.Authorization, 'Bearer artifact-secret');
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => MINIMAL_MP4,
      };
    };

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
    assert.equal(
      completed.video_url,
      'https://seed.alimyun.xyz/api/open/v1/videos/provider-task-83047/content'
    );
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

test('已提交任务的固定模型配置不可用时转 needs_attention 且不退款或重提', async () => {
  const db = new Database(':memory:');
  const originalPoll = videoClient.pollVideoTask;
  const originalCall = videoClient.callVideoApi;
  let pollCount = 0;
  let submitCount = 0;
  try {
    runMigrationsAndEnsure(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ai_service_configs
        (id, service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         is_active, is_default, priority, created_at, updated_at)
       VALUES (14, 'video', 'feituo', 'feituo_open', ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
    ).run(
      '固定飞拓配置',
      'https://feituokuajing.com',
      'artifact-secret',
      JSON.stringify(['sdas-my-seedance-2.0-fast-upscaled-1080p']),
      'sdas-my-seedance-2.0-fast-upscaled-1080p',
      now,
      now,
    );
    const task = taskService.createTask(db, log, 'video_generation', 'pinned-config-recovery');
    taskService.updateTaskStatus(db, task.id, 'processing', 90, '供应商处理中');
    const videoId = Number(db.prepare(
      `INSERT INTO video_generations
        (provider, prompt, model, status, task_id, provider_task_id, ai_service_config_id,
         created_at, updated_at)
       VALUES ('feituo', ?, ?, 'processing', ?, ?, 14, ?, ?)`
    ).run(
      '固定模型恢复测试',
      'sdas-my-seedance-2.0-fast-upscaled-1080p',
      task.id,
      'provider-task-pinned-14',
      now,
      now,
    ).lastInsertRowid);
    db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = 14').run();
    videoClient.callVideoApi = async () => { submitCount += 1; return { error: '不得提交' }; };
    videoClient.pollVideoTask = async () => { pollCount += 1; return { error: '不得轮询错误配置' }; };

    videoService.resumeProcessingVideoGenerations(db, log);
    const attention = await waitFor(() => {
      const row = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(videoId);
      return row.status === 'needs_attention' ? row : null;
    });

    assert.match(attention.error_msg, /固定模型配置|请勿重新提交/);
    assert.equal(taskService.getTask(db, task.id).status, 'needs_attention');
    assert.equal(submitCount, 0);
    assert.equal(pollCount, 0);
  } finally {
    videoClient.pollVideoTask = originalPoll;
    videoClient.callVideoApi = originalCall;
    db.close();
  }
});

test('已提交任务的固定配置 key/endpoint 版本被改写时拒绝用未验证配置轮询', async () => {
  const db = new Database(':memory:');
  const originalPoll = videoClient.pollVideoTask;
  const originalCall = videoClient.callVideoApi;
  let pollCount = 0;
  let submitCount = 0;
  try {
    runMigrationsAndEnsure(db);
    const now = new Date().toISOString();
    const model = 'sdas-my-seedance-2.0-fast-upscaled-1080p';
    db.prepare(
      `INSERT INTO ai_service_configs
        (id, service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         is_active, is_default, priority, created_at, updated_at)
       VALUES (14, 'video', 'feituo', 'feituo_open', ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
    ).run('固定飞拓配置', 'https://feituokuajing.com', 'secret', JSON.stringify([model]), model, now, now);
    const task = taskService.createTask(db, log, 'video_generation', 'mutated-config-recovery');
    taskService.updateTaskStatus(db, task.id, 'processing', 90, '供应商处理中');
    const capability = {
      config_id: 14,
      config_updated_at: now,
      provider: 'feituo',
      protocol: 'feituo_open',
      model,
    };
    const videoId = Number(db.prepare(
      `INSERT INTO video_generations
        (provider, prompt, model, source_conditioning_json, status, task_id, provider_task_id,
         ai_service_config_id, created_at, updated_at)
       VALUES ('feituo', ?, ?, ?, 'processing', ?, ?, 14, ?, ?)`
    ).run(
      '固定协议恢复测试',
      model,
      JSON.stringify({ segment_sha256: 'a'.repeat(64), video_capability: capability }),
      task.id,
      'provider-task-mutated-14',
      now,
      now,
    ).lastInsertRowid);
    db.prepare(`UPDATE ai_service_configs
      SET api_key = 'rotated-unverified-key', base_url = 'https://new-endpoint.example.test', updated_at = ?
      WHERE id = 14`).run('2026-08-08T12:00:00.000Z');
    videoClient.callVideoApi = async () => { submitCount += 1; return { error: '不得提交' }; };
    videoClient.pollVideoTask = async () => { pollCount += 1; return { error: '不得使用改写协议轮询' }; };

    videoService.resumeProcessingVideoGenerations(db, log);
    const attention = await waitFor(() => {
      const row = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(videoId);
      return row.status === 'needs_attention' ? row : null;
    });

    assert.match(attention.error_msg, /固定模型配置|配置版本|请勿重新提交/i);
    assert.equal(taskService.getTask(db, task.id).status, 'needs_attention');
    assert.equal(submitCount, 0);
    assert.equal(pollCount, 0);
  } finally {
    videoClient.pollVideoTask = originalPoll;
    videoClient.callVideoApi = originalCall;
    db.close();
  }
});
