import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeCreditAccount } from '../src/utils/billingDisplay.js'

test('积分账户只显示非负整数且缺失值归零', () => {
  assert.deepEqual(normalizeCreditAccount({ available: 18, held: 2, spent: 7 }), { available: 18, held: 2, spent: 7 })
  assert.deepEqual(normalizeCreditAccount({ available: -1, held: 1.5 }), { available: 0, held: 0, spent: 0 })
});
