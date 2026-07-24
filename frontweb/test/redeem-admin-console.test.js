import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const adminSource = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const redeemOperationsSource = fs.readFileSync(
  new URL('../src/components/RedeemOperationsPanel.vue', import.meta.url),
  'utf8',
)
const tenantSource = fs.readFileSync(new URL('../src/views/TenantConsole.vue', import.meta.url), 'utf8')
const billingApi = fs.readFileSync(new URL('../src/api/billing.js', import.meta.url), 'utf8')

test('统一管理后台提供账号、兑换码、积分和模型计费入口', () => {
  for (const label of ['账号管理', '兑换码', '积分流水', '模型计费']) {
    assert.match(adminSource, new RegExp(label))
  }
  assert.doesNotMatch(adminSource, /订阅套餐/)
  assert.match(redeemOperationsSource, /createRedeemCodes/)
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

test('未配置的默认模型首次保存时按启用状态提交', () => {
  assert.match(
    adminSource,
    /status:\s*item\.status === 'unconfigured' \? 'enabled' : item\.status/,
  )
})

test('管理端支持批量签发后一次性本地导出并清除明文', () => {
  assert.match(adminSource, /RedeemOperationsPanel/)
  assert.match(redeemOperationsSource, /批量生成并导出/)
  assert.match(redeemOperationsSource, /createRedeemCodes/)
  assert.match(redeemOperationsSource, /URL\.createObjectURL/)
  assert.match(redeemOperationsSource, /URL\.revokeObjectURL/)
  assert.match(redeemOperationsSource, /delete item\.code/)
  assert.doesNotMatch(redeemOperationsSource, /localStorage.*code/i)
  assert.match(billingApi, /\/billing\/admin\/redeem-codes\/batch/)
})

test('管理端可维护有效期并查询兑换人时间与账本', () => {
  assert.match(redeemOperationsSource, /保存有效期/)
  assert.match(redeemOperationsSource, /兑换明细/)
  assert.match(redeemOperationsSource, /兑换用户/)
  assert.match(redeemOperationsSource, /兑换时间/)
  assert.match(redeemOperationsSource, /账本记录/)
  assert.match(redeemOperationsSource, /listRedeemCodeUsages/)
  assert.match(billingApi, /\/billing\/admin\/redeem-codes\/\$\{encodeURIComponent\(codeId\)\}\/usages/)
})

test('批量签发可选择平台通用或指定租户且列表显示绑定目标', () => {
  assert.match(redeemOperationsSource, /平台通用/)
  assert.match(redeemOperationsSource, /指定租户/)
  assert.match(redeemOperationsSource, /newCode\.tenant_id/)
  assert.match(redeemOperationsSource, /row\.tenant_id/)
})
