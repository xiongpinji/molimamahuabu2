const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigRoutes = require('../src/routes/aiConfig');
const {
  classifyVideoVoicePolicy,
  enrichVideoConfig,
  policyForConfig,
} = require('../src/services/videoVoicePolicyService');

test('Seedance 2 使用分镜锁定的参考音频策略', () => {
  assert.equal(
    classifyVideoVoicePolicy({ protocol: 'icreat_task', provider: 'icreat', model: 'bytedance/seedance-2-0-fast' }).key,
    'reference_audio'
  );
});

test('Veo 2 明确标记为静音后期配音', () => {
  assert.equal(
    classifyVideoVoicePolicy({ protocol: 'gemini', provider: 'gemini', model: 'veo-2.0-generate-001' }).key,
    'silent'
  );
});

test('Veo 3 和 Grok 视频使用文字声线提示策略', () => {
  assert.equal(
    classifyVideoVoicePolicy({ protocol: 'veo3', provider: 'gemini', model: 'veo-3.1-generate-preview' }).key,
    'native_audio_prompt'
  );
  assert.equal(
    classifyVideoVoicePolicy({ protocol: 'deepwl_grok_openai', provider: 'deepwl', model: 'grok-video-3' }).key,
    'native_audio_prompt'
  );
});

test('多模型配置按默认模型返回主策略并保留每个模型的策略', () => {
  const enriched = enrichVideoConfig({
    provider: 'gemini',
    api_protocol: 'gemini',
    model: ['veo-2.0-generate-001', 'veo-3.1-generate-preview'],
    default_model: 'veo-3.1-generate-preview',
  });
  assert.equal(enriched.voice_policy, 'native_audio_prompt');
  assert.equal(enriched.voice_policies[0].key, 'silent');
  assert.equal(enriched.voice_policies[1].key, 'native_audio_prompt');
  assert.equal(policyForConfig(enriched).key, 'native_audio_prompt');
});

test('公开视频模型接口返回声音策略，供前端按模型提示用户', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, is_active, is_default, created_at, updated_at)
     VALUES ('video', 'gemini', 'gemini', 'Veo', 'https://example.com', 'secret', ?, ?, 1, 1, ?, ?)`
  ).run(JSON.stringify(['veo-2.0-generate-001', 'veo-3.1-generate-preview']), 'veo-3.1-generate-preview', now, now);
  let payload;
  const res = {
    status() { return this; },
    json(value) { payload = value; },
  };
  aiConfigRoutes(db, { info() {} }, {}).listPublicVideoModels({}, res);
  assert.equal(payload.success, true);
  assert.equal(payload.data[0].voice_policy, 'native_audio_prompt');
  assert.deepEqual(
    payload.data[0].voice_policies.map((item) => item.key),
    ['silent', 'native_audio_prompt']
  );
  db.close();
});
