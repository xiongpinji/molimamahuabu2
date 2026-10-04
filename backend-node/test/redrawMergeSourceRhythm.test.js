const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const dramaService = require('../src/services/dramaService');
const videoMergeService = require('../src/services/videoMergeService');

const log = { info() {}, warn() {}, error() {} };

// #94 第 1 集：切换到最短 4 秒的视频模型后，1~3 秒的分镜时长被改成了 4 秒，合成时没有按原片节奏裁回。
function createProject({ trim, mode }) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const metadata = trim ? { merge_trim_to_storyboard_duration: true, ...(mode ? { merge_trim_mode: mode } : {}) } : {};
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, metadata, created_at, updated_at) VALUES ('合成节奏测试', 'draft', ?, ?, ?)`
  ).run(JSON.stringify(metadata), now, now).lastInsertRowid;
  const episodeId = db.prepare(
    `INSERT INTO episodes (drama_id, episode_number, title, status, created_at, updated_at) VALUES (?, 1, '第1集', 'draft', ?, ?)`
  ).run(dramaId, now, now).lastInsertRowid;
  const addShot = (number, duration, source) => {
    const storyboardId = db.prepare(
      `INSERT INTO storyboards (episode_id, storyboard_number, duration, status, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)`
    ).run(episodeId, number, duration, now, now).lastInsertRowid;
    db.prepare(
      `INSERT INTO video_generations (drama_id, storyboard_id, video_url, local_path, status, created_at, updated_at) VALUES (?, ?, '', ?, 'completed', ?, ?)`
    ).run(dramaId, storyboardId, `projects/test/videos/sb${number}.mp4`, now, now);
    if (source) {
      db.prepare(
        `INSERT INTO assets (drama_id, storyboard_id, name, type, category, url, local_path, duration, metadata, created_at, updated_at)
         VALUES (?, ?, ?, 'video', 'storyboard_reference_video', ?, ?, ?, ?, ?, ?)`
      ).run(dramaId, storyboardId, `分镜${number} 样片参考`, `/static/ref${number}.mp4`, `ref${number}.mp4`, 2,
        JSON.stringify({ source: 'redraw_sample_clip', source_start_ms: source[0], source_end_ms: source[1], clip_start_ms: 0, clip_end_ms: 2000 }),
        now, now);
    }
    return storyboardId;
  };
  return { db, episodeId, addShot };
}

async function finalize(db, episodeId) {
  const original = videoMergeService.processVideoMerge;
  videoMergeService.processVideoMerge = () => {};
  try {
    const result = dramaService.finalizeEpisode(db, log, episodeId, 'https://example.test', {});
    // finalizeEpisode 用 setImmediate 启动合成；等这一拍跑完（走替身）再恢复，避免真的去跑 ffmpeg。
    await new Promise((resolve) => setImmediate(resolve));
    const row = db.prepare('SELECT scenes, merge_options FROM video_merges WHERE id = ?').get(Number(result.merge_id));
    return { scenes: JSON.parse(row.scenes), options: JSON.parse(row.merge_options) };
  } finally {
    videoMergeService.processVideoMerge = original;
  }
}

describe('redraw merge trims to the source shot rhythm', () => {
  it('uses the source shot length when the project chose the source rhythm', async () => {
    const { db, episodeId, addShot } = createProject({ trim: true, mode: 'source_rhythm' });
    try {
      addShot(1, 4, [0, 1200]);        // 原片 1.2 秒，切换模型后被改成 4 秒
      addShot(2, 4, [1200, 4700]);     // 原片 3.5 秒
      addShot(3, 6, null);             // 没有样片参考片段：仍按分镜时长
      addShot(4, 1, [4700, 5900]);     // 用户把分镜收紧到 1 秒（比原片 1.2 秒短）：按分镜时长
      const { scenes, options } = await finalize(db, episodeId);
      assert.equal(options.trim_to_storyboard_duration, true);
      assert.equal(options.smooth_audio, true);
      assert.deepEqual(scenes.map((scene) => scene.duration), [1.2, 3.5, 6, 1]);
    } finally {
      db.close();
    }
  });

  // R91：#98 第 1 集按原片节奏裁短后，第 5、13、19、20 镜的关键动作和第 9 镜的台词都在被裁掉的后半段。
  it('keeps whole shots and smooths the sound for redraw projects by default', async () => {
    const { db, episodeId, addShot } = createProject({ trim: true });
    try {
      addShot(1, 4, [0, 1200]);
      addShot(2, 4, [1200, 4700]);
      addShot(3, 6, null);
      const { scenes, options } = await finalize(db, episodeId);
      assert.equal(options.trim_to_storyboard_duration, false);
      assert.equal(options.smooth_audio, true);
      assert.deepEqual(scenes.map((scene) => scene.duration), [4, 4, 6]);
    } finally {
      db.close();
    }
  });

  it('keeps storyboard durations for ordinary factory projects without the redraw trim switch', async () => {
    const { db, episodeId, addShot } = createProject({ trim: false });
    try {
      addShot(1, 4, [0, 1200]);
      addShot(2, 5, null);
      const { scenes, options } = await finalize(db, episodeId);
      assert.equal(options.trim_to_storyboard_duration, false);
      assert.equal(options.smooth_audio, undefined, 'ordinary factory merges keep their sound untouched');
      assert.deepEqual(scenes.map((scene) => scene.duration), [4, 5]);
    } finally {
      db.close();
    }
  });
});
