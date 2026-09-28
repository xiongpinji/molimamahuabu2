import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultLocalizationTarget,
  localizationActionLabel,
  localizationBody,
  localizationStatusText,
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
