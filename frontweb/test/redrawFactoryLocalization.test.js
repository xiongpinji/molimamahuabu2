import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultLocalizationTarget,
  defaultSeriesTarget,
  importSuccessMessage,
  localizationActionLabel,
  localizationBody,
  localizationStatusText,
  seriesLockText,
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
  assert.equal(seriesTargetLabel(targets[0]), '追加到《墨西哥版》作为第 2 集')
  assert.equal(seriesTargetLabel({ drama_id: 92, title: '墨西哥版', episodes: 2, this_work_episode: 1 }), '《墨西哥版》（本集已是第 1 集）')
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
