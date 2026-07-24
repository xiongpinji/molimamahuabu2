import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const adminSource = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const tenantSource = fs.readFileSync(new URL('../src/views/TenantConsole.vue', import.meta.url), 'utf8')
const billingApi = fs.readFileSync(new URL('../src/api/billing.js', import.meta.url), 'utf8')

test('统一管理后台提供账号、兑换码、积分和模型计费入口', () => {
  for (const label of ['账号管理', '兑换码', '积分流水', '模型计费']) {
    assert.match(adminSource, new RegExp(label))
  }
  assert.doesNotMatch(adminSource, /订阅套餐/)
  assert.match(adminSource, /createRedeemCode/)
  assert.match(adminSource, /adjustTenantCredits/)
  assert.match(adminSource, /updatePlatformUser/)
})

test('租户控制台使用兑换码而不是创建支付订单', () => {
  assert.match(tenantSource, /兑换码/)
  assert.match(tenantSource, /redeemCredits/)
  assert.doesNotMatch(tenantSource, /createBillingOrder/)
  assert.doesNotMatch(tenantSource, /待支付订单/)
})

test('前端 API 覆盖兑换和管理员控制接口', () => {
  for (const endpoint of [
    '/billing/redeem',
    '/billing/credit-transactions',
    '/billing/admin/users',
    '/billing/admin/tenants',
    '/billing/admin/redeem-codes',
    '/billing/admin/credit-transactions',
  ]) {
    assert.match(billingApi, new RegExp(endpoint.replaceAll('/', '\\/')))
  }
})
