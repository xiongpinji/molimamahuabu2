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
