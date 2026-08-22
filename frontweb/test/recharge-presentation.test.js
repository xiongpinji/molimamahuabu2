import test from 'node:test'
import assert from 'node:assert/strict'
import * as rechargePresentation from '../src/utils/rechargePresentation.js'
import {
  CUSTOM_RECHARGE_RATIO,
  QUICK_RECHARGE_AMOUNTS,
  creditsForCustomAmount,
  legacyRechargeRedirect,
  normalizeAccentColor,
  packageCreditMetrics,
  validCustomAmount,
} from '../src/utils/rechargePresentation.js'

test('支付跳转只接受支付宝官方生产与新版沙箱网关并保留查询参数', () => {
  assert.equal(typeof rechargePresentation.normalizePaymentRedirectUrl, 'function')
  const { normalizePaymentRedirectUrl } = rechargePresentation
  assert.equal(
    normalizePaymentRedirectUrl('https://openapi.alipay.com/gateway.do?app_id=demo&method=pay'),
    'https://openapi.alipay.com/gateway.do?app_id=demo&method=pay',
  )
  assert.equal(
    normalizePaymentRedirectUrl('https://openapi-sandbox.dl.alipaydev.com/gateway.do?app_id=demo'),
    'https://openapi-sandbox.dl.alipaydev.com/gateway.do?app_id=demo',
  )
  for (const value of [
    'http://openapi.alipay.com/gateway.do',
    'https://pay.example.com/gateway.do',
    'https://openapi.alipay.com.example.com/gateway.do',
    'https://openapi.alipay.com:444/gateway.do',
    'https://user@openapi.alipay.com/gateway.do',
    'https://openapi.alipay.com/not-gateway.do',
    'javascript:alert(1)',
    '/api/v1/billing/recharge',
    '',
    null,
    'not a url',
  ]) {
    assert.equal(normalizePaymentRedirectUrl(value), '')
  }
})

test('旧充值入口移除 section 并保留其他查询参数和 hash', () => {
  const query = { section: 'recharge', source: 'campaign', tag: ['summer', 'vip'] }
  assert.deepEqual(legacyRechargeRedirect({
    name: 'tenant-console',
    query,
    hash: '#orders',
  }), {
    name: 'recharge-center',
    query: { source: 'campaign', tag: ['summer', 'vip'] },
    hash: '#orders',
  })
  assert.deepEqual(query, { section: 'recharge', source: 'campaign', tag: ['summer', 'vip'] })
  assert.equal(legacyRechargeRedirect({
    name: 'tenant-console',
    query: { section: 'redeem' },
    hash: '#codes',
  }), null)
})

test('自定义充值始终按 1 元兑换 100 积分且小数换算准确', () => {
  assert.equal(CUSTOM_RECHARGE_RATIO, 100)
  assert.deepEqual(QUICK_RECHARGE_AMOUNTS, [10, 30, 50, 100, 300, 500])
  assert.equal(creditsForCustomAmount(12.34), 1234)
  assert.equal(creditsForCustomAmount('0.29'), 29)
})

test('自定义充值金额只接受范围内且最多两位小数的数字格式', () => {
  for (const amount of [1, 12.34, '50000', '50000.00', '00001.00', ' 10 ']) {
    assert.equal(validCustomAmount(amount, '1.00', '50000.00'), true)
  }
  for (const amount of [0.99, '50000.01', '12.345', '1e2', '000001', '', 'abc']) {
    assert.equal(validCustomAmount(amount, '1.00', '50000.00'), false)
  }
  assert.equal(validCustomAmount('100000', '1.00', '999999.00'), false)
})

test('套餐基础与每日赠送积分不会显示负赠送', () => {
  assert.deepEqual(packageCreditMetrics({ amount_cents: 9900, daily_bonus_credits: 2900 }), {
    amountYuan: 99,
    baseCredits: 9900,
    dailyBonusCredits: 2900,
    benefitDays: 30,
    creditsPerYuan: 100,
  })
  assert.equal(packageCreditMetrics({ amount_cents: 1000, daily_bonus_credits: -1 }).dailyBonusCredits, 0)
  assert.deepEqual(packageCreditMetrics(), {
    amountYuan: 0,
    baseCredits: 0,
    dailyBonusCredits: 0,
    benefitDays: 30,
    creditsPerYuan: 0,
  })
  assert.deepEqual(packageCreditMetrics({ amount_cents: 'not-a-number', daily_bonus_credits: 'invalid' }), {
    amountYuan: 0,
    baseCredits: 0,
    dailyBonusCredits: 0,
    benefitDays: 30,
    creditsPerYuan: 0,
  })
  assert.equal(packageCreditMetrics({ amount_cents: 0, daily_bonus_credits: 100 }).creditsPerYuan, 0)
})

test('管理员强调色不合法时回退茉莉橙', () => {
  assert.equal(normalizeAccentColor('#2A8CFF'), '#2a8cff')
  assert.equal(normalizeAccentColor('red'), '#ff7139')
  assert.equal(normalizeAccentColor('#ff7139;background:url(javascript:alert(1))'), '#ff7139')
  assert.equal(normalizeAccentColor('<script>alert(1)</script>'), '#ff7139')
})
