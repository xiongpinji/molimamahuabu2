const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const storyboardRoutes = require('../src/routes/storyboards');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup({ withPrice = true } = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, style, status, created_at, updated_at)
     VALUES ('测试项目', 'realistic', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const episodeId = db.prepare(
    `INSERT INTO episodes
      (drama_id, episode_number, title, script_content, created_at, updated_at)
     VALUES (?, 1, '第一集', '母女在雨后的庭院相遇。', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid;
  const storyboardId = db.prepare(
    `INSERT INTO storyboards
      (episode_id, storyboard_number, title, action, dialogue, duration,
        creation_mode, created_at, updated_at)
     VALUES (?, 1, '相遇', '母亲走进庭院', '妈妈：你回来了。', 5, 'classic', ?, ?)`,
  ).run(episodeId, now, now).lastInsertRowid;
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '测试文本模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['GPT-5.5'],
    default_model: 'GPT-5.5',
    is_default: true,
  });
  credits.setTenantAccountBalance(db, 'tenant-a', 20);
  if (withPrice) prices.set(db, 'GPT-5.5', 5);
  return { db, storyboardId };
}

function request(storyboardId, body = {}) {
  return {
    params: { id: storyboardId },
    body: { model: 'GPT-5.5', force_without_reference_images: true, ...body },
    user: { id: 'user-1' },
    tenant: { id: 'tenant-a' },
  };
}

function captureJson() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

function captureStream() {
  const result = { chunks: [], headers: {} };
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
      setHeader(name, value) { result.headers[name] = value; },
      flushHeaders() {},
      write(chunk) { result.chunks.push(String(chunk)); return true; },
      end() { result.ended = true; return this; },
    },
  };
}

test('分镜全能提示词按实际文本模型计费并确认积分', async (t) => {
  const { db, storyboardId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => '分镜1：5秒。镜头缓慢推进，母亲走进雨后庭院并说出对白。';
  const { res, result } = captureJson();

  await storyboardRoutes(db, log, { billingEnabled: true })
    .generateUniversalSegmentPrompt(request(storyboardId), res);

  assert.equal(result.status, 200);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'storyboard_prompt' AND resource_id = ?`,
  ).get(String(storyboardId));
  assert.equal(reservation.model, 'GPT-5.5');
  assert.equal(reservation.status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('分镜全能提示词在模型未定价时返回 503 且不调用供应商', async (t) => {
  const { db, storyboardId } = setup({ withPrice: false });
  const original = aiClient.generateText;
  let calls = 0;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => { calls += 1; return '不应调用'; };
  const { res, result } = captureJson();

  await storyboardRoutes(db, log, { billingEnabled: true })
    .generateUniversalSegmentPrompt(request(storyboardId), res);

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('分镜流式提示词供应商失败时退回预扣积分', async (t) => {
  const { db, storyboardId } = setup();
  const original = aiClient.streamGenerateText;
  t.after(() => { aiClient.streamGenerateText = original; db.close(); });
  aiClient.streamGenerateText = async () => { throw new Error('供应商明确失败'); };
  const { res, result } = captureStream();

  await storyboardRoutes(db, log, { billingEnabled: true })
    .generateUniversalSegmentStream(request(storyboardId), res);

  assert.equal(result.status, 200);
  assert.match(result.chunks.join(''), /"type":"error"/);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'storyboard_prompt' AND resource_id = ?`,
  ).get(String(storyboardId));
  assert.equal(reservation.status, 'refunded');
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 20, held: 0, spent: 0,
  });
});

test('五个分镜文本入口均声明独立计费操作', () => {
  const source = require('fs').readFileSync(
    require.resolve('../src/routes/storyboards'),
    'utf8',
  );
  for (const operation of [
    'storyboard_image_polish',
    'storyboard_universal_prompt',
    'storyboard_universal_prompt_stream',
    'storyboard_universal_polish_stream',
    'storyboard_classic_video_polish_stream',
  ]) {
    assert.match(source, new RegExp(`beginStoryboardTextBilling\\([^\\n]+${operation}`));
  }
});
