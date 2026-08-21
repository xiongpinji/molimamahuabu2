const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const config = require('../src/config');
const taskService = require('../src/services/taskService');
const imageClient = require('../src/services/imageClient');
const propService = require('../src/services/propService');
const uploadService = require('../src/services/uploadService');
const storageLayout = require('../src/services/storageLayout');
const { processPropImageGeneration } = require('../src/services/propImageGenerationService');

test('道具重新生成开始时清除旧错误，成功后保持错误为空', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE props (
      id INTEGER PRIMARY KEY,
      image_url TEXT,
      local_path TEXT,
      extra_images TEXT,
      error_msg TEXT,
      updated_at TEXT
    )
  `);
  db.prepare(`
    INSERT INTO props (id, image_url, local_path, extra_images, error_msg, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, null, null, null, '上一次生成失败', '2026-01-01T00:00:00.000Z');

  const originals = {
    loadConfig: config.loadConfig,
    updateTaskStatus: taskService.updateTaskStatus,
    updateTaskError: taskService.updateTaskError,
    updateTaskResult: taskService.updateTaskResult,
    getTask: taskService.getTask,
    getById: propService.getById,
    resolveAssetUserNegativeForApi: imageClient.resolveAssetUserNegativeForApi,
    callImageApi: imageClient.callImageApi,
    downloadImageToLocal: uploadService.downloadImageToLocal,
    getProjectStorageSubdir: storageLayout.getProjectStorageSubdir,
  };

  let taskResult;
  try {
    config.loadConfig = () => ({
      ai: {},
      style: { default_image_size: '1920x1920' },
      storage: { local_path: './data/storage' },
    });
    taskService.updateTaskStatus = () => {};
    taskService.updateTaskError = (_db, _taskId, message) => {
      throw new Error(`不应写入任务错误: ${message}`);
    };
    taskService.updateTaskResult = (_db, _taskId, result) => {
      taskResult = result;
    };
    taskService.getTask = () => null;
    propService.getById = () => ({
      id: 1,
      drama_id: null,
      prompt: '一枚古铜色护身符',
      negative_prompt: '',
    });
    imageClient.resolveAssetUserNegativeForApi = () => '';
    imageClient.callImageApi = async () => {
      const row = db.prepare('SELECT error_msg FROM props WHERE id = ?').get(1);
      assert.equal(row.error_msg, null, '调用图片模型前应清除旧错误');
      return { image_url: 'https://example.com/prop.png' };
    };
    uploadService.downloadImageToLocal = async () => 'projects/7/props/prop.png';
    storageLayout.getProjectStorageSubdir = () => 'projects/7';

    await processPropImageGeneration(db, { info() {}, error() {} }, 'task-1', 1, {});

    const saved = db.prepare(`
      SELECT image_url, local_path, extra_images, error_msg
      FROM props
      WHERE id = ?
    `).get(1);
    assert.equal(saved.image_url, 'https://example.com/prop.png');
    assert.equal(saved.local_path, 'projects/7/props/prop.png');
    assert.equal(saved.error_msg, null);
    assert.equal(saved.extra_images, null);
    assert.deepEqual(taskResult, {
      image_url: 'https://example.com/prop.png',
      local_path: 'projects/7/props/prop.png',
      prop_id: 1,
    });
  } finally {
    Object.assign(config, { loadConfig: originals.loadConfig });
    Object.assign(taskService, {
      updateTaskStatus: originals.updateTaskStatus,
      updateTaskError: originals.updateTaskError,
      updateTaskResult: originals.updateTaskResult,
      getTask: originals.getTask,
    });
    propService.getById = originals.getById;
    imageClient.resolveAssetUserNegativeForApi = originals.resolveAssetUserNegativeForApi;
    imageClient.callImageApi = originals.callImageApi;
    uploadService.downloadImageToLocal = originals.downloadImageToLocal;
    storageLayout.getProjectStorageSubdir = originals.getProjectStorageSubdir;
    db.close();
  }
});
