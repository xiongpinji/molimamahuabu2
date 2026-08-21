const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const imageRoutes = require('../src/routes/images');
const imageService = require('../src/services/imageService');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id INTEGER,
      drama_id INTEGER,
      provider TEXT,
      prompt TEXT,
      image_url TEXT,
      local_path TEXT,
      frame_type TEXT,
      status TEXT,
      user_id TEXT,
      tenant_id TEXT,
      deleted_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      image_url TEXT,
      local_path TEXT,
      first_frame_image_id INTEGER,
      last_frame_image_url TEXT,
      last_frame_local_path TEXT,
      last_frame_image_id INTEGER,
      error_msg TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    INSERT INTO storyboards (id) VALUES (48);
  `);
  return db;
}

test('上传的分镜首帧继承当前租户，刷新后仍能在租户图片列表中读取', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const log = { error() {} };
  const routes = imageRoutes(db, {}, log, { billingEnabled: true });
  let payload;

  routes.upload({
    body: {
      storyboard_id: 48,
      drama_id: 39,
      image_url: 'https://molimama.vip/static/projects/39/uploads/test.jpg',
      local_path: 'projects/39/uploads/test.jpg',
      frame_type: 'storyboard_first',
    },
    user: { id: 'user-1' },
    tenant: { id: 'personal:user-1' },
  }, {
    status() { return this; },
    json(body) { payload = body; },
  });

  assert.equal(payload.success, true);
  const stored = db.prepare('SELECT user_id, tenant_id FROM image_generations WHERE id = ?')
    .get(payload.data.id);
  assert.deepEqual(stored, { user_id: 'user-1', tenant_id: 'personal:user-1' });

  const visible = imageService.list(db, { storyboard_id: 48 }, {
    billingEnabled: true,
    userId: 'user-1',
    tenantId: 'personal:user-1',
  });
  assert.equal(visible.total, 1);
  assert.equal(visible.items[0].id, payload.data.id);

  const hidden = imageService.list(db, { storyboard_id: 48 }, {
    billingEnabled: true,
    userId: 'user-2',
    tenantId: 'personal:user-2',
  });
  assert.equal(hidden.total, 0);
});
