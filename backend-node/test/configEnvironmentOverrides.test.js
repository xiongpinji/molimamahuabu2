const test = require('node:test');
const assert = require('node:assert/strict');

const { applyEnvironmentOverrides } = require('../src/config');

test('生产环境变量只覆盖部署相关配置且不修改输入对象', () => {
  const source = {
    app: { name: 'LocalMiniDrama API', debug: true },
    server: {
      insecure_tls: true,
      cors_origins: ['http://localhost:3013'],
    },
    database: { type: 'sqlite', path: './data/dev.sqlite' },
    storage: {
      type: 'local',
      local_path: './data/storage',
      base_url: 'http://localhost:5679/static',
    },
  };

  const result = applyEnvironmentOverrides(source, {
    APP_DEBUG: 'false',
    SERVER_INSECURE_TLS: 'false',
    SERVER_CORS_ORIGINS: 'https://studio.example.com, https://admin.example.com',
    DATABASE_PATH: '/var/lib/molimama/drama.sqlite',
    STORAGE_LOCAL_PATH: '/var/lib/molimama/storage',
    STORAGE_BASE_URL: 'https://studio.example.com/static',
  });

  assert.equal(result.app.debug, false);
  assert.equal(result.server.insecure_tls, false);
  assert.deepEqual(result.server.cors_origins, [
    'https://studio.example.com',
    'https://admin.example.com',
  ]);
  assert.equal(result.database.path, '/var/lib/molimama/drama.sqlite');
  assert.equal(result.storage.local_path, '/var/lib/molimama/storage');
  assert.equal(result.storage.base_url, 'https://studio.example.com/static');
  assert.equal(source.app.debug, true);
  assert.equal(source.database.path, './data/dev.sqlite');
});

test('未设置部署变量时保留原配置', () => {
  const source = {
    app: { name: 'LocalMiniDrama API', debug: true },
    server: { insecure_tls: true, cors_origins: ['http://localhost:3013'] },
    database: { type: 'sqlite', path: './data/dev.sqlite' },
    storage: { type: 'local', local_path: './data/storage', base_url: 'http://localhost:5679/static' },
  };

  assert.deepEqual(applyEnvironmentOverrides(source, {}), source);
});

test('布尔和 CORS 环境变量格式非法时明确拒绝启动', () => {
  const source = {
    app: { name: 'LocalMiniDrama API', debug: true },
    server: {},
    database: {},
    storage: {},
  };

  assert.throws(
    () => applyEnvironmentOverrides(source, { APP_DEBUG: 'sometimes' }),
    /APP_DEBUG/,
  );
  assert.throws(
    () => applyEnvironmentOverrides(source, { SERVER_CORS_ORIGINS: ' , ' }),
    /SERVER_CORS_ORIGINS/,
  );
});
