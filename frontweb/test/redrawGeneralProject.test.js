import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as workspaceState from '../src/utils/redrawWorkspaceState.js'

function readSource(path) {
  const url = new URL(path, import.meta.url)
  return existsSync(url) ? readFileSync(url, 'utf8') : ''
}

const apiSource = readSource('../src/api/redraw.js')
const listSource = readSource('../src/views/RedrawProjectList.vue')
const workspaceSource = readSource('../src/views/RedrawWorkspace.vue')
const sourceStepSource = readSource('../src/components/redraw/RedrawSourceStep.vue')
const stateSource = readSource('../src/utils/redrawWorkspaceState.js')
const overviewSource = readSource('../src/components/redraw/RedrawProjectOverview.vue')

test('项目创建必须提交单一市场、模式、预算和自动尝试上限', () => {
  for (const field of [
    'execution_mode',
    'budget_limit_credits',
    'max_auto_attempts_per_shot',
    'default_locale',
    'default_market',
  ]) {
    assert.match(listSource, new RegExp(field), field)
  }
  assert.match(listSource, /buildCreateProjectPayload/)
})

test('项目创建 payload 只发送策略输入字段且 safe 可省略预算', () => {
  assert.equal(typeof workspaceState.buildCreateProjectPayload, 'function')
  assert.deepEqual(workspaceState.buildCreateProjectPayload({
    title: ' Demo ',
    execution_mode: 'safe',
    budget_limit_credits: '',
    max_auto_attempts_per_shot: '',
    default_locale: ' en-US ',
    default_market: ' US ',
    spent_credits: 900,
    provider: 'forbidden',
    model: 'forbidden',
    reservation: { credits: 12 },
  }), {
    title: 'Demo',
    execution_mode: 'safe',
    default_locale: 'en-US',
    default_market: 'US',
    localization_level: 'faithful',
  })
})

test('auto 项目创建必须有预算和自动尝试上限', () => {
  assert.equal(typeof workspaceState.buildCreateProjectPayload, 'function')
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    title: 'auto',
    execution_mode: 'auto',
    budget_limit_credits: '',
    max_auto_attempts_per_shot: 2,
    default_locale: 'en-US',
    default_market: 'US',
  }), /预算/)
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    title: 'auto',
    execution_mode: 'auto',
    budget_limit_credits: 120,
    max_auto_attempts_per_shot: '',
    default_locale: 'en-US',
    default_market: 'US',
  }), /尝试上限/)
  assert.deepEqual(workspaceState.buildCreateProjectPayload({
    title: 'auto',
    execution_mode: 'auto',
    budget_limit_credits: 120,
    max_auto_attempts_per_shot: 2,
    default_locale: 'en-US',
    default_market: 'US',
    spent_credits: 1,
    provider: 'forbidden',
    model: 'forbidden',
    reservation: { credits: 9 },
  }), {
    title: 'auto',
    execution_mode: 'auto',
    budget_limit_credits: 120,
    max_auto_attempts_per_shot: 2,
    default_locale: 'en-US',
    default_market: 'US',
    localization_level: 'faithful',
  })
})

test('通用项目 API 暴露策略更新和事件读取入口', () => {
  assert.match(apiSource, /updateProjectPolicy\(projectId,\s*body\)/)
  assert.match(apiSource, /request\.put\(`\/redraw\/projects\/\$\{projectId\}\/policy`,\s*body\)/)
  assert.match(apiSource, /listProjectEvents\(projectId\)/)
  assert.match(apiSource, /request\.get\(`\/redraw\/projects\/\$\{projectId\}\/events`\)/)
})

test('工作台显示六个工作区和八阶段状态且不使用本地缓存越权', () => {
  for (const label of ['项目设置', '分析本地化', '角色资产库', '逐镜工作台', '生成与 QA', '合并与导出']) {
    assert.match(workspaceSource, new RegExp(label), label)
  }
  for (const phase of [
    'project_input',
    'source_analysis',
    'localization',
    'character_assets',
    'reference_preparation',
    'generation',
    'shot_quality',
    'episode_export',
  ]) {
    assert.match(stateSource, new RegExp(phase), phase)
  }
  assert.match(stateSource, /resolveEightStageState/)
  assert.doesNotMatch(stateSource, /localStorage|sessionStorage/)
})

test('八阶段状态只从服务端 workflow_phase、版本和事件投影', () => {
  assert.equal(typeof workspaceState.resolveEightStageState, 'function')
  assert.deepEqual(workspaceState.resolveEightStageState({
    workflow_phase: 'localization',
    version_id: 42,
    events: [{ reason_code: 'localization_completed', to_state: 'localization' }],
  }).map((stage) => stage.key), [
    'project_input',
    'source_analysis',
    'localization',
    'character_assets',
    'reference_preparation',
    'generation',
    'shot_quality',
    'episode_export',
  ])
  assert.equal(workspaceState.resolveEightStageState({
    workflow_phase: 'generation',
    version_id: 42,
    events: [{ reason_code: 'localization_failed', to_state: 'localization_needs_attention' }],
  }).find((stage) => stage.key === 'localization').status, 'needs_attention')
})

test('项目概览显示原始模式、有效模式、预算、版本和审核计数', () => {
  for (const label of [
    '原始模式',
    '有效模式',
    '预算上限',
    '已用积分',
    '预留积分',
    'policy/version',
    '待审核',
    'needs_attention',
  ]) {
    assert.match(overviewSource, new RegExp(label), label)
  }
  assert.match(workspaceSource, /RedrawProjectOverview/)
  assert.match(sourceStepSource, /resolveEightStageState/)
})
