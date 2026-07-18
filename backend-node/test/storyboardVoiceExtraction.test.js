const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { getFfmpegPath, hasLocalFfmpeg } = require('../src/utils/ffmpegPath');
const storageLayout = require('../src/services/storageLayout');
const voiceService = require('../src/services/storyboardVoiceExtractionService');

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at) VALUES ('音色提取测试', 'draft', ?, ?)`
  ).run(now, now).lastInsertRowid;
  const episodeId = db.prepare(
    `INSERT INTO episodes (drama_id, episode_number, title, status, created_at, updated_at) VALUES (?, 1, '第1集', 'draft', ?, ?)`
  ).run(dramaId, now, now).lastInsertRowid;
  const storyboardId = db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, characters, status, created_at, updated_at) VALUES (?, 1, '[]', 'completed', ?, ?)`
  ).run(episodeId, now, now).lastInsertRowid;
  const characterId = db.prepare(
    `INSERT INTO characters (drama_id, name, created_at, updated_at) VALUES (?, '小岚', ?, ?)`
  ).run(dramaId, now, now).lastInsertRowid;
  db.prepare('UPDATE storyboards SET characters = ? WHERE id = ?').run(JSON.stringify([characterId]), storyboardId);
  return { db, dramaId, storyboardId, characterId };
}

function makeVideo(storageRoot, db, dramaId, storyboardId) {
  const projectSubdir = storageLayout.getProjectStorageSubdir(db, dramaId);
  const relPath = `${projectSubdir}/videos/test-with-audio.mp4`;
  const absPath = path.join(storageRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const generated = spawnSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=12',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000',
    '-t', '0.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', absPath,
  ], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  const now = new Date().toISOString();
  const videoId = db.prepare(
    `INSERT INTO video_generations (drama_id, storyboard_id, video_url, local_path, status, created_at, updated_at) VALUES (?, ?, '', ?, 'completed', ?, ?)`
  ).run(dramaId, storyboardId, relPath, now, now).lastInsertRowid;
  return { videoId, relPath };
}

describe('storyboardVoiceExtractionService', () => {
  it('extracts an mp3 from a completed storyboard video and binds it to the only character', async (t) => {
    if (!hasLocalFfmpeg()) return t.skip('ffmpeg unavailable');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-voice-test-'));
    const { db, dramaId, storyboardId, characterId } = createDb();
    try {
      const { videoId } = makeVideo(root, db, dramaId, storyboardId);
      const result = await voiceService.extractStoryboardVoice({
        db,
        cfg: { storage: { local_path: root } },
        log: { info() {}, warn() {}, error() {} },
        storyboardId,
        videoId,
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.character_id, characterId);
      assert.equal(result.asset.source, 'storyboard_video');
      assert.equal(result.asset.source_video_id, videoId);
      assert.equal(result.asset.source_storyboard_id, storyboardId);
      assert.equal(fs.existsSync(path.join(root, result.asset.local_path)), true);
      const saved = JSON.parse(db.prepare('SELECT seedance2_voice_asset FROM characters WHERE id = ?').get(characterId).seedance2_voice_asset);
      assert.equal(saved.url, result.asset.url);
      assert.equal(saved.status, 'active');
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a target when a storyboard contains multiple characters', async () => {
    const { db, storyboardId, characterId } = createDb();
    try {
      const second = db.prepare(
        `INSERT INTO characters (drama_id, name, created_at, updated_at)
         SELECT drama_id, '阿澈', created_at, updated_at FROM characters WHERE id = ?`
      ).run(characterId).lastInsertRowid;
      db.prepare('UPDATE storyboards SET characters = ? WHERE id = ?').run(JSON.stringify([characterId, second]), storyboardId);
      const result = await voiceService.extractStoryboardVoice({
        db,
        cfg: { storage: { local_path: os.tmpdir() } },
        log: { info() {}, warn() {}, error() {} },
        storyboardId,
        videoId: 1,
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'MULTIPLE_CHARACTERS');
      assert.equal(result.details.candidates.length, 2);
    } finally {
      db.close();
    }
  });

  it('falls back to the storyboard character link table when the JSON field is empty', () => {
    const { db, dramaId, storyboardId, characterId } = createDb();
    try {
      db.prepare('UPDATE storyboards SET characters = ? WHERE id = ?').run('[]', storyboardId);
      db.prepare(
        'INSERT INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)'
      ).run(storyboardId, characterId, new Date().toISOString());
      const target = voiceService.resolveTargetCharacter(
        db,
        { id: storyboardId, characters: '[]', drama_id: dramaId },
      );
      assert.equal(target.ok, true);
      assert.equal(target.character.id, characterId);
    } finally {
      db.close();
    }
  });
});
