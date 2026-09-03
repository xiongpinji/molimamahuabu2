import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const view = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const api = fs.readFileSync(new URL('../src/api/billing.js', import.meta.url), 'utf8')

test('管理员经营台账展示模型成本、Token 用量和预计利润', () => {
  assert.match(view, /经营台账/)
  assert.match(view, /输入 Token/)
  assert.match(view, /输出 Token/)
  assert.match(view, /推理 Token/)
  assert.match(view, /预计利润/)
  assert.match(view, /按秒/)
  assert.match(view, /按张/)
})

test('前端使用专用经营台账设置和报表接口', () => {
  assert.match(api, /billing\/admin\/ledger\/settings/)
  assert.match(api, /billing\/admin\/ledger\/report/)
})

test('模型计费恢复完整列表并按中转站分组', () => {
  assert.match(view, /groupModelPricesByProvider/)
  assert.match(view, /filteredPriceGroups/)
  assert.match(view, /model-provider-group/)
  assert.match(view, /v-for="group in filteredPriceGroups"/)
  assert.match(view, /v-for="item in group.items"/)
  assert.match(view, /syncProviderPricingNow/)
  assert.match(view, /中转站成本：未同步/)
  assert.match(view, /usdCnyRate/)
})
