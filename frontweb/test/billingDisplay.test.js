import test from 'node:test'
import assert from 'node:assert/strict'

import { formatModelPrice, normalizeCreditAccount } from '../src/utils/billingDisplay.js'

test('积分账户只显示非负整数且缺失值归零', () => {
  assert.deepEqual(normalizeCreditAccount({ available: 18, held: 2, spent: 7 }), { available: 18, held: 2, spent: 7 })
  assert.deepEqual(normalizeCreditAccount({ available: -1, held: 1.5 }), { available: 0, held: 0, spent: 0 })
});

test('视频模型价格显示为每秒积分且其他模型仍显示每次积分', () => {
  assert.equal(formatModelPrice({ credits: 3, billing_unit: 'second' }), '当前 3 积分/秒')
  assert.equal(formatModelPrice({ credits: 6, billing_unit: 'request' }), '当前 6 积分/次')
  assert.equal(formatModelPrice({ credits: null, billing_unit: 'second' }), '尚未定价（按秒），当前禁止生成')
})
