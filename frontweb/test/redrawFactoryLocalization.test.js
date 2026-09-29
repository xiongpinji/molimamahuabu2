import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultLocalizationTarget,
  defaultSeriesTarget,
  importSuccessMessage,
  localizationActionLabel,
  localizationBody,
  localizationStatusText,
  seriesImportBlocker,
  seriesImportCredits,
  seriesImportSteps,
  seriesImportSummary,
  seriesImportTarget,
  seriesLockText,
  seriesProgressText,
  seriesTargetLabel,
} from '../src/utils/redrawFactoryLocalization.js'

const TARGETS = [
  { key: 'es-MX', locale: 'es', market: 'MX', label: '西班牙语（墨西哥）' },
  { key: 'es-ES', locale: 'es', market: 'ES', label: '西班牙语（西班牙）' },
  { key: 'pt-BR', locale: 'pt', market: 'BR', label: '葡萄牙语（巴西）' },
]

test('完全转绘默认选分析时的语言与国家，只有语言时选该语言第一个国家', () => {
  assert.equal(defaultLocalizationTarget(TARGETS, 'es', 'ES'), 'es-ES')
  assert.equal(defaultLocalizationTarget(TARGETS, 'es', ''), 'es-MX')
  assert.equal(defaultLocalizationTarget(TARGETS, 'pt', null), 'pt-BR')
  assert.equal(defaultLocalizationTarget(TARGETS, 'fr', 'FR'), 'es-MX')
  assert.equal(defaultLocalizationTarget([], 'es', 'MX'), '')
})

test('完全转绘按钮文案与状态说明随状态变化', () => {
  assert.equal(localizationActionLabel({ status: 'none' }), '生成并导入')
  assert.equal(localizationActionLabel({ status: 'localizing' }), '转绘中…')
  assert.equal(localizationActionLabel({ status: 'ready' }), '导入目标国家版本')
  assert.equal(localizationActionLabel({ status: 'failed' }), '重新生成并导入')
  assert.match(localizationStatusText({ status: 'none' }, '西班牙语（墨西哥）'), /人物名字、人物形象、台词、场景和道具全部换成西班牙语（墨西哥）的/)
  assert.match(localizationStatusText({ status: 'failed', error: '模型超时' }), /积分已退回：模型超时/)
})

test('完全转绘请求体只接受列表里的目标', () => {
  assert.deepEqual(localizationBody(TARGETS, 'es-MX', 'start', { expected_credits: 10 }), {
    action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10,
  })
  assert.equal(localizationBody(TARGETS, 'fr-FR', 'status'), null)
})

test('整部剧：默认追加到最近一个还没有本集的项目，本集已在所有项目里时默认新建', () => {
  const targets = [
    { drama_id: 92, title: '墨西哥版', episodes: 1, this_work_episode: null },
    { drama_id: 90, title: '旧版', episodes: 1, this_work_episode: null },
  ]
  assert.equal(defaultSeriesTarget(targets), 92)
  assert.equal(defaultSeriesTarget([{ drama_id: 92, episodes: 2, this_work_episode: 1 }]), 0)
  assert.equal(defaultSeriesTarget([]), 0)
  assert.equal(seriesTargetLabel(targets[0]), '追加到《墨西哥版》（#92）作为第 2 集')
  assert.equal(seriesTargetLabel({ drama_id: 92, title: '墨西哥版', episodes: 2, this_work_episode: 1 }), '《墨西哥版》（#92）（本集已是第 1 集）')
  assert.equal(seriesTargetLabel({ drama_id: 93, title: '', episodes: 1 }), '追加到项目 #93作为第 2 集')
})

const PLAN = {
  episodes: [
    { work_id: 6, episode: 1, analysis_ready: true, status: 'ready', credits: 10 },
    { work_id: 7, episode: 2, analysis_ready: true, status: 'failed', credits: 10 },
    { work_id: 8, episode: 3, analysis_ready: true, status: 'none', credits: 10 },
  ],
  series_targets: [
    { drama_id: 90, title: '旧版', episodes: 1, work_episodes: { 7: 1 } },
    { drama_id: 94, title: '哥伦比亚版', episodes: 1, work_episodes: { 6: 1 } },
  ],
}

test('整部导入：追加到已含第 1 集的项目，只处理还没导入的集，没生成的才计价', () => {
  assert.equal(seriesImportTarget(PLAN), 94)
  const steps = seriesImportSteps(PLAN, 94)
  assert.deepEqual(steps.map((item) => [item.episode, item.needs_localization]), [[2, true], [3, true]])
  assert.equal(seriesImportCredits(steps), 20)
  assert.equal(seriesImportBlocker(PLAN, 94, steps), '')
  const summary = seriesImportSummary(PLAN, 94, steps, '西班牙语（哥伦比亚）')
  assert.match(summary, /按集号把第 2、3 集转绘为西班牙语（哥伦比亚）版本，追加到《哥伦比亚版》（#94）（全剧共 3 集）/)
  assert.match(summary, /需新生成 2 集，本次预计扣除 20 积分/)
  assert.equal(seriesProgressText(steps[0], 0, 2, 'localizing'), '整部导入 1/2：第 2 集正在转绘，通常 1~3 分钟…')
  assert.equal(seriesProgressText(steps[1], 1, 2, 'importing'), '整部导入 2/2：第 3 集正在导入短剧工厂…')
})

test('整部导入：没有含第 1 集的项目就新建；已生成的集不计价；没分析或顺序对不上的不能开始', () => {
  const fresh = { ...PLAN, series_targets: [PLAN.series_targets[0]] }
  assert.equal(seriesImportTarget(fresh), 0)
  const steps = seriesImportSteps(fresh, 0)
  assert.deepEqual(steps.map((item) => item.episode), [1, 2, 3])
  assert.equal(seriesImportCredits(steps), 20, 'episode 1 is already generated')
  assert.match(seriesImportSummary(fresh, 0, steps), /新建一个短剧工厂项目/)
  assert.equal(seriesImportTarget({ episodes: [] }), 0)

  const unanalyzed = { ...PLAN, episodes: [...PLAN.episodes.slice(0, 2), { work_id: 8, episode: 3, analysis_ready: false, status: 'unavailable', credits: null }] }
  assert.equal(seriesImportBlocker(unanalyzed, 94, seriesImportSteps(unanalyzed, 94)), '第 3 集还没完成样片分析，请先分析这一集再整部导入')

  const gap = { ...PLAN, series_targets: [{ drama_id: 94, title: '哥伦比亚版', episodes: 2, work_episodes: { 6: 1, 8: 2 } }] }
  assert.equal(seriesImportBlocker(gap, 94, seriesImportSteps(gap, 94)), '第 2 集排在项目里已有的第 3 集之前，不能按顺序追加')
  const done = { ...PLAN, series_targets: [{ drama_id: 94, title: '哥伦比亚版', episodes: 3, work_episodes: { 6: 1, 7: 2, 8: 3 } }] }
  assert.deepEqual(seriesImportSteps(done, 94), [])
  assert.match(seriesImportSummary(done, 94, []), /各集都已生成，导入不扣积分/)
})

test('整部剧：显示沿用的老角色和追加结果', () => {
  assert.equal(seriesLockText({ status: 'ready', series_lock: { characters: ['Mateo', 'Mamá'] } }), '沿用前几集的角色：Mateo、Mamá（名字、形象不变）。')
  assert.equal(seriesLockText({ status: 'ready' }), '')
  assert.equal(importSuccessMessage({ appended: true, episode_number: 2, reused_character_names: ['Mateo'], new_character_names: ['Pedro'] }),
    '已追加为第 2 集，沿用角色 Mateo，新角色 Pedro')
  assert.equal(importSuccessMessage({ created: false, episode_number: 2 }), '本集已是该项目第 2 集，打开短剧工厂项目')
  assert.equal(importSuccessMessage({ created: false }), '已导入过，打开现有短剧工厂项目')
  assert.equal(importSuccessMessage({ created: true }, '西班牙语（墨西哥）'), '已按西班牙语（墨西哥）导入短剧工厂')
})
