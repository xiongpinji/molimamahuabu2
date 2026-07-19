const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const videoService = require('../src/services/videoService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO dramas (title, style, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`).run('视频测试', 'realistic', now, now);
  db.prepare(`INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, ?, ?, ?)`).run('第一集', now, now);
  db.prepare(`INSERT INTO storyboards (episode_id, storyboard_number, title, created_at, updated_at) VALUES (1, 1, ?, ?, ?)`).run('首尾帧视频段', now, now);
  credits.setAccountBalance(db, 'user-1', 40);
  credits.setAccountBalance(db, 'user-2', 40);
  prices.set(db, 'seedance 2.0', 12);
  return db;
}

function create(db, userId) {
  return videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance 2.0',
    prompt: '固定首帧与尾帧之间的连续动作',
    first_frame_url: 'https://example.com/first.jpg',
    last_frame_url: 'https://example.com/last.jpg',
  }, { billingEnabled: true, userId, schedule() {} });
}

test('seedance 2.0 首尾帧视频任务按用户隔离幂等预扣', () => {
  const db = setup();
  const first = create(db, 'user-1');
  const sameUser = create(db, 'user-1');
  const otherUser = create(db, 'user-2');

  assert.equal(sameUser.id, first.id);
  assert.equal(sameUser.reused, true);
  assert.notEqual(otherUser.id, first.id);
  const rows = db.prepare('SELECT id, user_id, model, first_frame_url, last_frame_url, credit_reservation_id FROM video_generations ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.user_id), ['user-1', 'user-2']);
  assert.deepEqual(rows.map((row) => row.model), ['seedance 2.0', 'seedance 2.0']);
  assert.equal(rows[0].first_frame_url, 'https://example.com/first.jpg');
  assert.equal(rows[0].last_frame_url, 'https://example.com/last.jpg');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 2);
  assert.equal(credits.getAccount(db, 'user-1').held, 12);
  assert.equal(credits.getAccount(db, 'user-2').held, 12);

  videoService.settleVideoCredit(db, log, rows[0], 'completed');
  videoService.settleVideoCredit(db, log, rows[1], 'failed', '供应商明确失败');
  assert.equal(credits.getReservation(db, rows[0].credit_reservation_id).status, 'confirmed');
  assert.equal(credits.getReservation(db, rows[1].credit_reservation_id).status, 'refunded');
  assert.equal(credits.getAccount(db, 'user-1').spent, 12);
  assert.equal(credits.getAccount(db, 'user-2').available, 40);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type IN ('generation.video.completed', 'generation.video.failed')").get().count, 2);
  db.close();
});

test('公开计费视频创建缺少用户身份时拒绝，不泄露处理中任务', () => {
  const db = setup();
  assert.throws(() => videoService.create(db, log, {
    drama_id: 1, storyboard_id: 1, model: 'seedance 2.0', prompt: 'test',
  }, { billingEnabled: true, schedule() {} }), (error) => error.code === 'UNAUTHORIZED');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count, 0);
  db.close();
});

test('视频请求缺少提示词和模型时读取分镜持久化配置并固化声线', () => {
  const db = setup();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(1, '小狐狸', 'bright youthful voice, clear diction', now, now);
  const characterId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    `UPDATE storyboards
     SET characters = ?, dialogue = ?, video_prompt = ?, video_model = ?
     WHERE id = 1`
  ).run(
    JSON.stringify([characterId]),
    '小狐狸：我们继续往前走。',
    '雨后森林，镜头跟随小狐狸向前走。',
    'grok-video-3'
  );

  const created = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
  }, { billingEnabled: false, schedule() {} });

  assert.equal(created.model, 'grok-video-3');
  assert.match(created.prompt, /雨后森林/);
  assert.match(created.prompt, /VOICE CONTINUITY/);
  assert.match(created.prompt, /bright youthful voice, clear diction/);
  const persisted = db.prepare('SELECT video_prompt FROM storyboards WHERE id = 1').get();
  assert.match(persisted.video_prompt, /VOICE CONTINUITY/);

  db.prepare("UPDATE video_generations SET status = 'failed' WHERE id = ?").run(created.id);
  const explicit = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    prompt: '显式覆盖后的镜头动作',
    model: 'explicit-video-model',
  }, { billingEnabled: false, schedule() {} });
  assert.equal(explicit.model, 'explicit-video-model');
  assert.equal(explicit.prompt, '显式覆盖后的镜头动作');
  db.close();
});
