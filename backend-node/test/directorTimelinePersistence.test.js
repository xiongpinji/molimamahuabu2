const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const dramaService = require('../src/services/dramaService');

const log = { info() {}, warn() {}, error() {} };

test('3D 导演台时间线通过画布布局保存后可从剧本 metadata 恢复', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const now = new Date().toISOString();
    const dramaId = db.prepare(
      `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?)`,
    ).run('导演台闭环', 'realistic', JSON.stringify({ aspect_ratio: '16:9' }), now, now).lastInsertRowid;
    const directorTimeline = {
      version: 2,
      sequence: { name: '主序列', fps: 24, currentTime: 1, duration: 6, activeCameraId: 'cam-1' },
      shots: [
        { id: 'shot-1', name: '开场', sceneId: 'scene-1', camera: 'wide', cameraId: 'cam-1', transition: 'cut', transitionDuration: 0, start: 0, duration: 3 },
        { id: 'shot-2', name: '反打', sceneId: 'scene-2', camera: 'close', cameraId: 'cam-2', transition: 'dissolve', transitionDuration: 0.5, start: 3, duration: 3 },
      ],
      tracks: [{
        id: 'track-1',
        characterId: 'hero',
        clips: [{ id: 'clip-1', characterId: 'hero', action: 'Wave', start: 1, duration: 2 }],
      }],
      objects: [{ id: 'hero-object', type: 'character', name: '主角', visible: true, locked: false, assetRef: { kind: 'project-character', characterId: 'hero' }, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      cameras: [
        { id: 'cam-1', name: '全景机位', objectId: '', fov: 50, aspect: 1.777 },
        { id: 'cam-2', name: '近景机位', objectId: '', fov: 42, aspect: 1.777 },
      ],
    };

    const saved = dramaService.saveCanvasLayout(db, log, dramaId, {
      base_updated_at: now,
      canvas_layout: {
        nodes: { 'node-1': { x: 12, y: 24 } },
        viewport: { x: 0, y: 0, zoom: 0.8 },
        director_timeline: directorTimeline,
      },
    });
    const restored = dramaService.getDramaById(db, dramaId);

    assert.equal(saved.metadata.aspect_ratio, '16:9');
    assert.deepEqual(restored.metadata.canvas_layout.director_timeline.shots, directorTimeline.shots);
    assert.deepEqual(restored.metadata.canvas_layout.director_timeline.tracks, directorTimeline.tracks);
    assert.deepEqual(restored.metadata.canvas_layout.director_timeline.objects, directorTimeline.objects);
    assert.deepEqual(restored.metadata.canvas_layout.director_timeline.cameras, directorTimeline.cameras);
  } finally {
    db.close();
  }
});
