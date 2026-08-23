const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const dramaDuplicateService = require('../src/services/dramaDuplicateService');

const log = { info() {}, warn() {}, error() {} };

test('完整复制画布项目并将副本隔离到当前租户', (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-canvas-copy-'));
  t.after(() => fs.rmSync(storagePath, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const folderId = db.prepare(
    `INSERT INTO project_folders (tenant_id, name, created_at, updated_at)
     VALUES ('tenant-a', '已验证', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const canvasLayout = {
    nodes: { 'text-1': { x: 120, y: 80 } },
    edges: [],
    viewport: { x: 10, y: 20, zoom: 0.8 },
    director_timeline: { shots: [{ id: 'shot-1', duration: 3 }] },
  };
  const sourceId = db.prepare(
    `INSERT INTO dramas (tenant_id, user_id, folder_id, title, status, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).run(
    'tenant-a',
    'owner-a',
    folderId,
    '森林追踪画布',
    JSON.stringify({
      project_type: 'canvas',
      canvas_layout: canvasLayout,
      workflow_groups: [{ id: 'group-1', title: '开场' }],
    }),
    now,
    now,
  ).lastInsertRowid;
  db.prepare(
    `INSERT INTO dramas (tenant_id, user_id, title, status, metadata, created_at, updated_at)
     VALUES ('tenant-b', 'owner-b', '森林追踪画布 副本', 'draft', '{"project_type":"canvas"}', ?, ?)`,
  ).run(now, now);
  const episodeId = db.prepare(
    `INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at)
     VALUES (?, 1, '第1集', ?, ?)`,
  ).run(sourceId, now, now).lastInsertRowid;
  const storyboardId = db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, title, dialogue, created_at, updated_at)
     VALUES (?, 1, '雨林独行', '小茉：继续前进。', ?, ?)`,
  ).run(episodeId, now, now).lastInsertRowid;
  const sourceProjectDir = path.join(storagePath, 'projects', 'source');
  fs.mkdirSync(sourceProjectDir, { recursive: true });
  fs.writeFileSync(path.join(sourceProjectDir, 'asset.png'), Buffer.from('asset-image'));
  fs.writeFileSync(path.join(sourceProjectDir, 'frame.png'), Buffer.from('generated-image'));
  fs.writeFileSync(path.join(sourceProjectDir, 'clip.mp4'), Buffer.from('generated-video'));
  const sourceImageGenId = db.prepare(
    `INSERT INTO image_generations
      (drama_id, storyboard_id, provider, prompt, status, local_path, created_at, updated_at)
     VALUES (?, ?, 'test', '雨林画面', 'completed', 'projects/source/frame.png', ?, ?)`,
  ).run(sourceId, storyboardId, now, now).lastInsertRowid;
  const sourceVideoGenId = db.prepare(
    `INSERT INTO video_generations
      (drama_id, storyboard_id, provider, prompt, status, local_path, created_at, updated_at)
     VALUES (?, ?, 'test', '向前推进', 'completed', 'projects/source/clip.mp4', ?, ?)`,
  ).run(sourceId, storyboardId, now, now).lastInsertRowid;
  const sourceAssetId = db.prepare(
    `INSERT INTO assets
      (drama_id, storyboard_id, name, type, category, url, local_path, metadata,
       image_gen_id, video_gen_id, created_at, updated_at)
     VALUES (?, ?, '雨林参考', 'image', 'canvas-library-pick', '/static/rainforest.png',
       'projects/source/asset.png', ?, ?, ?, ?, ?)`,
  ).run(
    sourceId,
    storyboardId,
    JSON.stringify({ source: 'canvas_asset_picker', picker_source: 'scene' }),
    sourceImageGenId,
    sourceVideoGenId,
    now,
    now,
  ).lastInsertRowid;
  canvasLayout.nodes[`project-asset:${sourceAssetId}`] = { x: 40, y: 220 };
  canvasLayout.nodes[`episode:${episodeId}`] = { x: 440, y: 80 };
  canvasLayout.nodes[`sb:${storyboardId}`] = { x: 440, y: 180 };
  canvasLayout.manual_edges = [{
    id: `manual:project-asset:${sourceAssetId}|sb:${storyboardId}`,
    source: `project-asset:${sourceAssetId}`,
    target: `sb:${storyboardId}`,
    data: { manual: true },
  }];
  canvasLayout.director_timeline.shots[0].assetRef = { assetId: sourceAssetId };
  db.prepare('UPDATE dramas SET metadata = ? WHERE id = ?').run(JSON.stringify({
    project_type: 'canvas',
    canvas_layout: canvasLayout,
    workflow_groups: [{ id: 'group-1', title: '开场', storyboard_ids: [storyboardId] }],
  }), sourceId);

  const result = dramaDuplicateService.duplicateDrama(
    db,
    { storage: { local_path: storagePath } },
    log,
    sourceId,
    { userId: 'member-a', tenantId: 'tenant-a' },
  );

  assert.ok(result);
  assert.notEqual(result.drama_id, sourceId);
  assert.equal(result.title, '森林追踪画布 副本');

  const copied = db.prepare('SELECT * FROM dramas WHERE id = ?').get(result.drama_id);
  assert.equal(copied.tenant_id, 'tenant-a');
  assert.equal(copied.user_id, 'member-a');
  assert.equal(copied.folder_id, folderId);
  const copiedMetadata = JSON.parse(copied.metadata);
  assert.equal(copiedMetadata.project_type, 'canvas');
  assert.deepEqual(copiedMetadata.canvas_layout.viewport, canvasLayout.viewport);
  assert.deepEqual(copiedMetadata.canvas_layout.nodes['text-1'], canvasLayout.nodes['text-1']);

  const copiedEpisode = db.prepare('SELECT * FROM episodes WHERE drama_id = ?').get(result.drama_id);
  const copiedStoryboard = db.prepare('SELECT * FROM storyboards WHERE episode_id = ?').get(copiedEpisode.id);
  assert.notEqual(copiedEpisode.id, episodeId);
  assert.notEqual(copiedStoryboard.id, storyboardId);
  assert.equal(copiedStoryboard.dialogue, '小茉：继续前进。');
  assert.deepEqual(copiedMetadata.workflow_groups, [{
    id: 'group-1',
    title: '开场',
    storyboard_ids: [copiedStoryboard.id],
  }]);
  assert.deepEqual(copiedMetadata.canvas_layout.nodes[`episode:${copiedEpisode.id}`], { x: 440, y: 80 });
  assert.deepEqual(copiedMetadata.canvas_layout.nodes[`sb:${copiedStoryboard.id}`], { x: 440, y: 180 });
  assert.equal(copiedMetadata.canvas_layout.nodes[`episode:${episodeId}`], undefined);
  assert.equal(copiedMetadata.canvas_layout.nodes[`sb:${storyboardId}`], undefined);

  const copiedAsset = db.prepare('SELECT * FROM assets WHERE drama_id = ?').get(result.drama_id);
  assert.ok(copiedAsset);
  assert.notEqual(copiedAsset.id, sourceAssetId);
  assert.equal(copiedAsset.storyboard_id, copiedStoryboard.id);
  assert.equal(copiedAsset.url, '/static/rainforest.png');
  assert.notEqual(copiedAsset.local_path, 'projects/source/asset.png');
  assert.equal(fs.existsSync(path.join(storagePath, copiedAsset.local_path)), true);
  assert.notEqual(copiedAsset.image_gen_id, sourceImageGenId);
  assert.notEqual(copiedAsset.video_gen_id, sourceVideoGenId);
  assert.deepEqual(copiedMetadata.canvas_layout.nodes[`project-asset:${copiedAsset.id}`], { x: 40, y: 220 });
  assert.equal(copiedMetadata.canvas_layout.nodes[`project-asset:${sourceAssetId}`], undefined);
  assert.equal(copiedMetadata.canvas_layout.manual_edges[0].source, `project-asset:${copiedAsset.id}`);
  assert.equal(copiedMetadata.canvas_layout.manual_edges[0].target, `sb:${copiedStoryboard.id}`);
  assert.equal(copiedMetadata.canvas_layout.director_timeline.shots[0].assetRef.assetId, copiedAsset.id);
  assert.equal(
    db.prepare('SELECT drama_id FROM image_generations WHERE id = ?').get(copiedAsset.image_gen_id).drama_id,
    result.drama_id,
  );
  assert.equal(
    db.prepare('SELECT drama_id FROM video_generations WHERE id = ?').get(copiedAsset.video_gen_id).drama_id,
    result.drama_id,
  );
  assert.deepEqual(JSON.parse(copiedAsset.metadata), {
    source: 'canvas_asset_picker',
    picker_source: 'scene',
  });

  const beforeForeignAttempt = db.prepare('SELECT COUNT(*) AS total FROM dramas').get().total;
  const foreignResult = dramaDuplicateService.duplicateDrama(
    db,
    { storage: { local_path: storagePath } },
    log,
    sourceId,
    { userId: 'owner-b', tenantId: 'tenant-b' },
  );
  assert.equal(foreignResult, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM dramas').get().total, beforeForeignAttempt);
});
