const test = require('node:test');
const assert = require('node:assert/strict');

const { toPublicConfig } = require('../src/services/aiConfigService');

test('AI 配置公开视图不返回供应商密钥', () => {
  const output = toPublicConfig({
    id: 1,
    api_key: 'supplier-secret',
    settings: JSON.stringify({ kling_access_key: 'ak', kling_secret_key: 'sk', deepseek_thinking: 'enabled' }),
  });
  assert.equal(output.api_key, undefined);
  assert.equal(output.has_api_key, true);
  const settings = JSON.parse(output.settings);
  assert.equal(settings.kling_access_key, undefined);
  assert.equal(settings.kling_secret_key, undefined);
  assert.equal(settings.deepseek_thinking, 'enabled');
});
