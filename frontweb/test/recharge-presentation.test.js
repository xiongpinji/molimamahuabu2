import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CUSTOM_RECHARGE_RATIO,
  QUICK_RECHARGE_AMOUNTS,
  creditsForCustomAmount,
  normalizeAccentColor,
  packageCreditMetrics,
  validCustomAmount,
} from '../src/utils/rechargePresentation.js'

test('自定义充值始终按 1 元兑换 100 积分且小数换算准确', () => {
  assert.equal(CUSTOM_RECHARGE_RATIO, 100)
  assert.deepEqual(QUICK_RECHARGE_AMOUNTS, [10, 30, 50, 100, 300, 500])
  assert.equal(creditsForCustomAmount(12.34), 1234)
  assert.equal(creditsForCustomAmount('0.29'), 29)
})

test('自定义充值金额只接受范围内且最多两位小数的数字格式', () => {
  for (const amount of [1, 12.34, '50000.00']) {
    assert.equal(validCustomAmount(amount, '1.00', '50000.00'), true)
  }
  for (const amount of [0.99, '50000.01', '12.345', '1e2', ' 10 ', '', 'abc']) {
    assert.equal(validCustomAmount(amount, '1.00', '50000.00'), false)
  }
})

test('套餐基础与赠送积分不会显示负赠送', () => {
  assert.deepEqual(packageCreditMetrics({ amount_cents: 9900, credits: 12800 }), {
    amountYuan: 99,
    baseCredits: 9900,
    bonusCredits: 2900,
    creditsPerYuan: 129.29,
  })
  assert.equal(packageCreditMetrics({ amount_cents: 1000, credits: 900 }).bonusCredits, 0)
})

test('管理员强调色不合法时回退茉莉橙', () => {
  assert.equal(normalizeAccentColor('#2A8CFF'), '#2a8cff')
  assert.equal(normalizeAccentColor('red'), '#ff7139')
})
