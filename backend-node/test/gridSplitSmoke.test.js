const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const { splitConfiguredGridToImages } = require('../src/services/imageService');

const GRID_CASES = [
  ['fourteen_grid', 14],
  ['sixteen_grid', 16],
  ['twentyfive_grid', 25],
];

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id INTEGER,
      drama_id INTEGER,
      scene_id INTEGER,
      character_id INTEGER,
      provider TEXT,
      prompt TEXT,
      model TEXT,
      frame_type TEXT,
      image_url TEXT,
      local_path TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT
    )
  `);
  return db;
}

test('expanded grid crops local image into configured panel counts', async () => {
  for (const [frameType, expectedCount] of GRID_CASES) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-grid-'));
    const inputPath = path.join(tempDir, `${frameType}.jpg`);
    const db = createDb();
    try {
      await sharp({
        create: {
          width: 100,
          height: 80,
          channels: 3,
          background: { r: 40, g: 120, b: 200 },
        },
      }).jpeg().toFile(inputPath);

      const now = new Date().toISOString();
      const original = {
        id: 1,
        storyboard_id: 10,
        drama_id: 20,
        scene_id: 30,
        character_id: null,
        provider: 'local-smoke',
        prompt: 'deterministic grid smoke test',
        model: 'fixture',
        frame_type: frameType,
        image_url: '/static/projects/smoke/original.jpg',
        local_path: inputPath,
        status: 'completed',
        created_at: now,
        updated_at: now,
        completed_at: now,
      };

      await splitConfiguredGridToImages(
        db,
        { warn() {}, info() {} },
        original,
        inputPath,
        tempDir,
        original.image_url,
      );

      const rows = db.prepare('SELECT frame_type, local_path FROM image_generations ORDER BY id').all();
      assert.equal(rows.length, expectedCount);
      for (const row of rows) {
        assert.match(row.frame_type, new RegExp(`^${frameType.replace('_grid', '')}_panel_`));
        const panelPath = path.join(tempDir, row.local_path);
        assert.equal(fs.existsSync(panelPath), true);
        const metadata = await sharp(panelPath).metadata();
        assert.equal(metadata.width > 0, true);
        assert.equal(metadata.height > 0, true);
      }
    } finally {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
