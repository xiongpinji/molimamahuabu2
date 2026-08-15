import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const apiSource = fs.readFileSync(path.join(root, 'src/api/providerStability.js'), 'utf8')
const panelSource = fs.readFileSync(path.join(root, 'src/components/ProviderStabilityPanel.vue'), 'utf8')
const configSource = fs.readFileSync(path.join(root, 'src/components/AIConfigContent.vue'), 'utf8')
const routerSource = fs.readFileSync(path.join(root, 'src/router/index.js'), 'utf8')

test('管理员 AI 配置页提供稳定性页签及安全状态和操作', () => {
  assert.match(configSource, /label="稳定性"/)
  assert.match(configSource, /<ProviderStabilityPanel/)
  for (const label of ['逻辑模型', '关联中转站', '健康', '熔断', '最近切换', '任务状态', '积分状态']) {
    assert.match(panelSource, new RegExp(label))
  }
  assert.match(panelSource, /resetHealth/)
  assert.match(panelSource, /verifyFromGeneration/)
  assert.doesNotMatch(panelSource, /api_key|提示词全文|signed_url/i)
});

test('稳定性 API 只调用管理员端点且不提供普通用户入口', () => {
  for (const endpoint of [
    '/admin/provider-stability/routes',
    '/admin/provider-stability/events',
    '/reset-health',
    '/verify-from-generation',
  ]) assert.match(apiSource, new RegExp(endpoint.replaceAll('/', '\\/')))
  assert.match(routerSource, /path: '\/ai-config'[\s\S]*roles: \['admin'\]/)
  assert.doesNotMatch(routerSource, /path: '\/(?:factory|canvas|script-analysis)'[\s\S]{0,180}ProviderStabilityPanel/)
});
