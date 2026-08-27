const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  createPrivateAvatarAsset,
  createPrivateAvatarGroup,
  ensurePrivateAvatarAsset,
  fetchPrivateAvatarAsset,
} = require('../src/services/toapisPrivateAvatarService');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return typeof payload === 'string' ? payload : JSON.stringify(payload); },
  };
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE toapis_private_avatar_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ai_service_config_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    source_kind TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    source_url TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    group_id TEXT,
    asset_id TEXT,
    asset_url TEXT,
    status TEXT NOT NULL,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    activated_at TEXT,
    UNIQUE(ai_service_config_id, source_kind, source_id, asset_type)
  )`);
  return db;
}

const config = {
  id: 70,
  base_url: 'https://toapis.xyz/v1',
  api_key: 'secret-key',
};

test('ToAPIs 虚拟人像客户端使用官方建组、建素材和查询路径', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/private-avatar/groups')) {
      return response(200, { success: true, data: { group_id: 'pg_group1' } });
    }
    if (url.endsWith('/private-avatar/assets') && init.method === 'POST') {
      return response(200, {
        success: true,
        data: {
          group_id: 'pg_group1',
          asset_id: 'pa_asset1',
          asset_url: 'asset://pa_asset1',
          asset_type: 'image',
          status: 'processing',
        },
      });
    }
    return response(200, {
      success: true,
      data: {
        group_id: 'pg_group1',
        asset_id: 'pa_asset1',
        asset_url: 'asset://pa_asset1',
        asset_type: 'image',
        status: 'active',
      },
    });
  };

  const group = await createPrivateAvatarGroup(config, {
    name: 'drama-48-image_generation-9',
    description: '茉莉妈妈 AI 虚拟人物素材',
  }, { fetchImpl });
  assert.equal(group.group_id, 'pg_group1');

  const asset = await createPrivateAvatarAsset(config, {
    group_id: group.group_id,
    asset_type: 'image',
    source_url: 'https://molimama.vip/static/projects/0048/a.png',
    name: 'image-generation-9',
  }, { fetchImpl });
  assert.equal(asset.asset_id, 'pa_asset1');
  assert.equal(asset.status, 'processing');

  const active = await fetchPrivateAvatarAsset(config, asset.asset_id, { fetchImpl });
  assert.equal(active.status, 'active');
  assert.equal(active.asset_url, 'asset://pa_asset1');

  assert.deepEqual(calls.map((item) => [item.init.method, item.url]), [
    ['POST', 'https://toapis.xyz/v1/videos/doubao-seedance-2-0/private-avatar/groups'],
    ['POST', 'https://toapis.xyz/v1/videos/doubao-seedance-2-0/private-avatar/assets'],
    ['GET', 'https://toapis.xyz/v1/videos/doubao-seedance-2-0/private-avatar/assets/pa_asset1'],
  ]);
  assert.equal(calls.every((item) => item.init.headers.Authorization === 'Bearer secret-key'), true);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    group_id: 'pg_group1',
    asset_type: 'image',
    source_url: 'https://molimama.vip/static/projects/0048/a.png',
    name: 'image-generation-9',
  });
});

test('ToAPIs 虚拟人像素材完成后写入缓存且同一平台素材不会重复提交', async () => {
  const db = makeDb();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/private-avatar/groups')) {
      return response(200, { data: { group_id: 'pg_cache1' } });
    }
    if (url.endsWith('/private-avatar/assets') && init.method === 'POST') {
      return response(200, {
        data: { group_id: 'pg_cache1', asset_id: 'pa_cache1', asset_url: 'asset://pa_cache1', status: 'processing' },
      });
    }
    return response(200, {
      data: { group_id: 'pg_cache1', asset_id: 'pa_cache1', asset_url: 'asset://pa_cache1', status: 'active' },
    });
  };
  const input = {
    dramaId: 48,
    sourceKind: 'image_generation',
    sourceId: 9,
    sourceUrl: 'https://molimama.vip/static/projects/0048/a.png',
    assetType: 'image',
  };

  const first = await ensurePrivateAvatarAsset(db, config, input, {
    fetchImpl,
    pollIntervalMs: 0,
    maxPolls: 2,
  });
  assert.deepEqual(first, {
    asset_id: 'pa_cache1',
    asset_url: 'asset://pa_cache1',
    group_id: 'pg_cache1',
    status: 'active',
  });
  assert.equal(calls.length, 3);

  const second = await ensurePrivateAvatarAsset(db, config, input, {
    fetchImpl: async () => { throw new Error('缓存命中不应联网'); },
  });
  assert.deepEqual(second, first);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM toapis_private_avatar_assets').get().count, 1);
  db.close();
});

test('ToAPIs 虚拟人像 failed 和处理超时会阻止视频提交', async () => {
  for (const scenario of [
    { status: 'failed', expected: /虚拟人像素材处理失败/ },
    { status: 'processing', expected: /仍在处理中/ },
  ]) {
    const db = makeDb();
    const fetchImpl = async (url, init = {}) => {
      if (url.endsWith('/private-avatar/groups')) return response(200, { data: { group_id: 'pg_stop1' } });
      if (url.endsWith('/private-avatar/assets') && init.method === 'POST') {
        return response(200, {
          data: { group_id: 'pg_stop1', asset_id: 'pa_stop1', asset_url: 'asset://pa_stop1', status: 'processing' },
        });
      }
      return response(200, {
        data: {
          group_id: 'pg_stop1', asset_id: 'pa_stop1', asset_url: 'asset://pa_stop1',
          status: scenario.status, message: scenario.status === 'failed' ? 'bad image' : '',
        },
      });
    };
    await assert.rejects(
      ensurePrivateAvatarAsset(db, config, {
        dramaId: 48,
        sourceKind: 'image_generation',
        sourceId: scenario.status === 'failed' ? 10 : 11,
        sourceUrl: 'https://molimama.vip/static/projects/0048/b.png',
        assetType: 'image',
      }, { fetchImpl, pollIntervalMs: 0, maxPolls: 1 }),
      scenario.expected,
    );
    db.close();
  }
});

test('ToAPIs 虚拟人像创建结果不确定时不泄露 Key 和素材 URL', async () => {
  await assert.rejects(
    createPrivateAvatarGroup(config, { name: 'x' }, {
      fetchImpl: async () => { throw new Error('secret-key https://molimama.vip/static/a.png'); },
    }),
    (error) => {
      assert.equal(error.code, 'TOAPIS_AVATAR_SUBMISSION_INDETERMINATE');
      assert.doesNotMatch(error.message, /secret-key|molimama\.vip/);
      return true;
    },
  );

  await assert.rejects(
    createPrivateAvatarAsset(config, {
      group_id: 'pg_x', asset_type: 'image', source_url: 'https://molimama.vip/static/a.png',
    }, {
      fetchImpl: async () => response(502, '<html>bad</html>'),
    }),
    (error) => {
      assert.equal(error.code, 'TOAPIS_AVATAR_SUBMISSION_INDETERMINATE');
      assert.doesNotMatch(error.message, /secret-key|molimama\.vip|<html>/);
      return true;
    },
  );
});
