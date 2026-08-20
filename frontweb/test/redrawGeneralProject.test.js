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

test('项目策略输入必须是 safe/auto、单一 locale/market，market 归一为两位国家码', () => {
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    execution_mode: 'manual',
    default_locale: 'en-US',
    default_market: 'US',
  }), /执行模式/)
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    execution_mode: 'safe',
    default_locale: '',
    default_market: 'US',
  }), /目标语言/)
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    execution_mode: 'safe',
    default_locale: 'en-US,es-ES',
    default_market: 'US',
  }), /目标语言/)
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    execution_mode: 'safe',
    default_locale: 'en/US',
    default_market: 'US',
  }), /目标语言/)
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    execution_mode: 'safe',
    default_locale: 'en-US',
    default_market: 'USA',
  }), /目标市场/)
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    execution_mode: 'safe',
    default_locale: 'en-US',
    default_market: 'US,ES',
  }), /目标市场/)
  assert.equal(workspaceState.buildCreateProjectPayload({
    execution_mode: 'safe',
    default_locale: 'es-ES',
    default_market: 'es',
  }).default_market, 'ES')
})

test('auto 自动尝试上限必须锁定在 1 到 5', () => {
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    execution_mode: 'auto',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 6,
    default_locale: 'en-US',
    default_market: 'US',
  }), /尝试上限/)
  assert.throws(() => workspaceState.buildCreateProjectPayload({
    execution_mode: 'auto',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 0,
    default_locale: 'en-US',
    default_market: 'US',
  }), /尝试上限/)
  assert.match(listSource, /:max="5"/)
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

test('未知 workflow_phase 失败关闭且 source version 不伪装本地化完成', () => {
  const unknown = workspaceState.resolveEightStageState({ workflow_phase: 'unknown_phase', version_id: 42 })
  assert.equal(unknown.some((stage) => stage.status === 'active'), false)
  assert.equal(unknown.every((stage) => stage.status === 'pending'), true)
  assert.equal(workspaceState.resolveEightStageState({
    workflow_phase: 'source',
    version_id: 42,
  }).find((stage) => stage.key === 'localization').status, 'pending')
})

test('八阶段状态保留后端兼容 phase 别名', () => {
  const cases = [
    ['source', 'project_input'],
    ['analyzing', 'source_analysis'],
    ['analysis_review', 'source_analysis'],
    ['localizing', 'localization'],
    ['assets', 'character_assets'],
    ['asset_review', 'character_assets'],
    ['generating', 'generation'],
    ['video_generation', 'generation'],
    ['export', 'episode_export'],
  ]
  for (const [phase, activeKey] of cases) {
    const active = workspaceState.resolveEightStageState({ workflow_phase: phase })
      .find((stage) => stage.status === 'active')
    assert.equal(active?.key, activeKey, phase)
  }
})

test('needs_attention 事件必须逐条独立匹配，不能跨事件串扰', () => {
  assert.notEqual(workspaceState.resolveEightStageState({
    workflow_phase: 'generation',
    events: [
      { reason_code: 'localization_completed', to_state: 'localization' },
      { reason_code: 'generation_needs_attention', to_state: 'generation' },
    ],
  }).find((stage) => stage.key === 'localization').status, 'needs_attention')
  assert.equal(workspaceState.resolveEightStageState({
    workflow_phase: 'generation',
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

test('项目概览 effective mode 优先读取工作分析和本地化决策', () => {
  assert.match(stateSource, /analysis_decision\?\.effective_mode/)
  assert.match(stateSource, /localization_decision\?\.effective_mode/)
  assert.match(overviewSource, /resolveProjectEffectiveMode/)
  assert.doesNotMatch(overviewSource, /effective_execution_mode \|\| rawMode\.value/)
})

test('项目事件读取失败保留旧事件并暴露错误状态', () => {
  assert.equal(typeof workspaceState.resolveProjectEventsState, 'function')
  assert.deepEqual(workspaceState.resolveProjectEventsState({
    previousEvents: [{ reason_code: 'old' }],
    nextEvents: [{ reason_code: 'new' }],
  }), {
    events: [{ reason_code: 'new' }],
    error: '',
  })
  assert.deepEqual(workspaceState.resolveProjectEventsState({
    previousEvents: [{ reason_code: 'old' }],
    error: new Error('server down'),
  }), {
    events: [{ reason_code: 'old' }],
    error: 'server down',
  })
  assert.match(workspaceSource, /projectEventsError/)
  assert.match(workspaceSource, /el-alert/)
  assert.doesNotMatch(workspaceSource, /listProjectEvents\(projectId\.value\)\.catch\(\(\) => \[\]\)/)
})

test('effective mode 按工作决策、项目有效模式、policy、raw 逐级回退', () => {
  assert.equal(typeof workspaceState.resolveProjectEffectiveMode, 'function')
  assert.equal(workspaceState.resolveProjectEffectiveMode({
    project: {
      execution_mode: 'auto',
      effective_execution_mode: 'safe',
      effective_policy: { execution_mode: 'auto' },
    },
    work: {},
  }), 'safe')
  assert.equal(workspaceState.resolveProjectEffectiveMode({
    project: {
      execution_mode: 'auto',
      effective_execution_mode: 'safe',
      effective_policy: { execution_mode: 'safe' },
    },
    work: { analysis_decision: { effective_mode: 'auto' } },
  }), 'auto')
  assert.equal(workspaceState.resolveProjectEffectiveMode({
    project: { execution_mode: 'safe' },
    work: { localization_decision: { effective_mode: 'auto' } },
  }), 'auto')
})

test('needs_attention 有限聚合计数优先，包括 0，不与事件相加', () => {
  assert.equal(typeof workspaceState.resolveNeedsAttentionCount, 'function')
  assert.equal(workspaceState.resolveNeedsAttentionCount({
    project: { needs_attention_count: 0 },
    work: { needs_attention_count: 3 },
    events: [{ reason_code: 'generation_needs_attention' }],
  }), 0)
  assert.equal(workspaceState.resolveNeedsAttentionCount({
    project: {},
    work: { needs_attention_count: 2 },
    events: [{ reason_code: 'generation_needs_attention' }],
  }), 2)
  assert.equal(workspaceState.resolveNeedsAttentionCount({
    project: { needs_attention_count: Number.NaN },
    work: {},
    events: [{ reason_code: 'generation_needs_attention' }],
  }), 1)
})
