import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const apiSource = fs.readFileSync(path.join(root, 'src/api/providerStability.js'), 'utf8')
const panelSource = fs.readFileSync(path.join(root, 'src/components/ProviderStabilityPanel.vue'), 'utf8')
const configSource = fs.readFileSync(path.join(root, 'src/components/AIConfigContent.vue'), 'utf8')
const routerSource = fs.readFileSync(path.join(root, 'src/router/index.js'), 'utf8')

test('管理员稳定性面板完整展示巡检、预算、证据和告警合同', () => {
  assert.match(configSource, /label="稳定性"/)
  assert.match(configSource, /<ProviderStabilityPanel/)
  for (const label of [
    '逻辑模型', '关联中转站', '健康', '熔断', '最近切换', '任务状态', '积分状态',
    '用户目录状态', '最近零成本检查', '最近真实成功', '证据过期时间',
    '今日巡检预算', '本月巡检预算', '结果未知', '对账', '巡检暂停',
    'P0', 'P1', 'P2', 'P3',
  ]) {
    assert.match(panelSource, new RegExp(label))
  }
  assert.match(panelSource, /resetHealth/)
  assert.match(panelSource, /verifyFromGeneration/)
  assert.match(panelSource, /canary_paused/)
  assert.match(panelSource, /ElMessageBox\.confirm/)
  assert.match(panelSource, /next_cursor/)
  assert.match(panelSource, /submission_unknown/)
  assert.match(panelSource, /result_unknown/)
  assert.match(panelSource, /artifact_unreadable/)
  assert.doesNotMatch(panelSource, /api_key|base_url|signed_url|Authorization|提示词全文|完整签名\s*URL/i)
});

test('稳定性 API 支持摘要、游标分页、空体只读对账且保留线路更新', () => {
  for (const endpoint of [
    '/admin/provider-stability/routes',
    '/admin/provider-stability/events',
    '/admin/provider-stability/canary/summary',
    '/admin/provider-stability/canary/runs',
    '/reconcile',
    '/reset-health',
    '/verify-from-generation',
  ]) assert.match(apiSource, new RegExp(endpoint.replaceAll('/', '\\/')))
  assert.match(apiSource, /getCanarySummary\s*\(/)
  assert.match(apiSource, /listCanaryRuns\s*\(params\s*=\s*\{\}\)/)
  assert.match(apiSource, /reconcileCanaryRun\s*\(runId\)/)
  assert.match(apiSource, /request\.post\([^,]+,\s*\{\}\s*\)/s)
  assert.match(apiSource, /request\.patch\(`\/admin\/provider-stability\/routes\/\$\{configId\}`/)
});

test('稳定性面板只挂载在管理员页且窄屏不会向页面横向泄漏', () => {
  assert.match(routerSource, /path: '\/ai-config'[\s\S]*roles: \['admin'\]/)
  for (const relative of [
    'views/DramaCanvas.vue',
    'views/ScriptAnalysis.vue',
    'views/FilmList.vue',
    'views/FilmCreate.vue',
  ]) {
    const source = fs.readFileSync(path.join(root, 'src', relative), 'utf8')
    assert.doesNotMatch(source, /ProviderStabilityPanel|providerStability/)
  }
  assert.match(panelSource, /\.provider-stability\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*hidden/s)
  assert.match(panelSource, /@media\s*\(max-width:\s*760px\)/)
});
