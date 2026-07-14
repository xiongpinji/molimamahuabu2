const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { bindStoryboardFrameImage } = require('../src/services/storyboardFrameBinding');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
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
    INSERT INTO storyboards (id, error_msg) VALUES (1, '结果未知，请勿连续重试');
  `);
  return db;
}

for (const frameType of ['storyboard_first', 'storyboard_last']) {
  test(`${frameType} 成功绑定后清除旧图片错误`, () => {
    const db = createDb();
    try {
      bindStoryboardFrameImage(db, 1, frameType, 10, '/files/image.jpg', 'images/image.jpg');
      const row = db.prepare('SELECT error_msg FROM storyboards WHERE id = 1').get();
      assert.equal(row.error_msg, null);
    } finally {
      db.close();
    }
  });
}
