const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const canvasText = require('../src/services/canvas-text-generation-service');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

test('独立画布文本节点调用真实文本模型并返回生成内容', async (t) => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '画布文本模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['GPT-5.5'],
    default_model: 'GPT-5.5',
    is_default: true,
  });
  const original = aiClient.generateText;
  t.after(() => {
    aiClient.generateText = original;
    db.close();
  });
  aiClient.generateText = async (_db, _log, serviceType, prompt, systemPrompt, options) => {
    assert.equal(serviceType, 'text');
    assert.equal(prompt, '写一段雨夜车站的开场旁白');
    assert.match(systemPrompt, /独立画布文本节点/);
    assert.equal(options.model, 'GPT-5.5');
    return '雨幕落下，最后一班列车驶入站台。';
  };

  const result = await canvasText.generate(db, log, {
    dramaId: 7,
    prompt: '写一段雨夜车站的开场旁白',
    model: 'GPT-5.5',
    billingEnabled: false,
  });

  assert.deepEqual(result, {
    content: '雨幕落下，最后一班列车驶入站台。',
    model: 'GPT-5.5',
  });
});

test('独立画布文本节点拒绝空提示词', async () => {
  const db = new Database(':memory:');
  try {
    await assert.rejects(
      canvasText.generate(db, log, { dramaId: 7, prompt: '   ', billingEnabled: false }),
      /请输入文本生成要求/,
    );
  } finally {
    db.close();
  }
});
