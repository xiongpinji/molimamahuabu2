import test from 'node:test'
import assert from 'node:assert/strict'

import { formatModelPrice, normalizeCreditAccount } from '../src/utils/billingDisplay.js'

test('积分账户只显示非负整数且缺失值归零', () => {
  assert.deepEqual(normalizeCreditAccount({ available: 18, held: 2, spent: 7 }), {
    available: 18, held: 2, spent: 7,
    permanentAvailable: 0, dailyBonusAvailable: 0,
    dailyBonusExpiresAt: null, membershipEndsOn: null,
  })
  assert.deepEqual(normalizeCreditAccount({ available: -1, held: 1.5 }), {
    available: 0, held: 0, spent: 0,
    permanentAvailable: 0, dailyBonusAvailable: 0,
    dailyBonusExpiresAt: null, membershipEndsOn: null,
  })
});

test('积分账户保留总余额并规范化每日赠送明细', () => {
  assert.deepEqual(normalizeCreditAccount({
    available: 130, held: 4, spent: 20,
    permanent_available: 100, daily_bonus_available: 30,
    daily_bonus_expires_at: '2026-08-12T00:00:00+08:00',
    membership_ends_on: '2026-09-10',
  }), {
    available: 130, held: 4, spent: 20,
    permanentAvailable: 100, dailyBonusAvailable: 30,
    dailyBonusExpiresAt: '2026-08-12T00:00:00+08:00',
    membershipEndsOn: '2026-09-10',
  })
})

test('视频模型价格显示为每秒积分且其他模型仍显示每次积分', () => {
  assert.equal(formatModelPrice({ credits: 3, billing_unit: 'second' }), '当前 3 积分/秒')
  assert.equal(formatModelPrice({ credits: 6, billing_unit: 'request' }), '当前 6 积分/次')
  assert.equal(formatModelPrice({ credits: null, billing_unit: 'second' }), '尚未定价（按秒），当前禁止生成')
})

test('视频模型配置分辨率价格后同时显示 480P 和 720P 每秒积分', () => {
  assert.equal(formatModelPrice({
    category: 'video',
    credits: 2,
    billing_unit: 'second',
    resolution_prices: {
      '480p': { credits: 2 },
      '720p': { credits: 5 },
    },
  }), '480P 2 积分/秒 · 720P 5 积分/秒')
})
