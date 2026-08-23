import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { packageCreditMetrics } from '../src/utils/rechargePresentation.js'

const adminPanel = fs.readFileSync(new URL('../src/components/RechargePackageAdminPanel.vue', import.meta.url), 'utf8')
const packageCard = fs.readFileSync(new URL('../src/components/RechargePackageCard.vue', import.meta.url), 'utf8')
const rechargeCenter = fs.readFileSync(new URL('../src/views/RechargeCenter.vue', import.meta.url), 'utf8')

test('套餐指标展示永久基础积分和每日赠送而不再计算一次性赠送', () => {
  assert.deepEqual(packageCreditMetrics({
    amount_cents: 10000,
    credits: 10000,
    daily_bonus_credits: 1000,
  }), {
    amountYuan: 100,
    baseCredits: 10000,
    dailyBonusCredits: 1000,
    benefitDays: 30,
    creditsPerYuan: 100,
  })
})

test('管理员只编辑每日赠送且基础积分由售价派生', () => {
  assert.match(adminPanel, /基础积分（永久）/)
  assert.match(adminPanel, /:model-value="baseCreditsPreview"/)
  assert.match(adminPanel, /每日赠送积分/)
  assert.match(adminPanel, /daily_bonus_credits/)
  assert.doesNotMatch(adminPanel, /v-model="draft\.credits"/)
})

test('用户套餐卡明确展示30天每日赠送和当日清零', () => {
  assert.match(packageCard, /充值到账/)
  assert.match(packageCard, /永久积分/)
  assert.match(packageCard, /连续 30 天/)
  assert.match(packageCard, /次日 00:00 清零/)
  assert.doesNotMatch(packageCard, /额外赠送/)
})

test('会员有效期内套餐全部禁用但自定义充值不禁用', () => {
  assert.match(rechargeCenter, /:disabled="!rechargeConfig\.configured \|\| membership\.active"/)
  assert.match(rechargeCenter, /有效期内不可重复购买会员档/)
  assert.match(rechargeCenter, /<CustomRechargePanel[\s\S]*?:disabled="!rechargeConfig\.configured"/)
})
