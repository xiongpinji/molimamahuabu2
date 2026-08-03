import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const billingApi = fs.readFileSync(new URL('../src/api/billing.js', import.meta.url), 'utf8')
const tenantConsole = fs.readFileSync(new URL('../src/views/TenantConsole.vue', import.meta.url), 'utf8')
const billingAdmin = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const platformHeader = fs.readFileSync(new URL('../src/components/PlatformHeader.vue', import.meta.url), 'utf8')

test('用户充值与管理员套餐统一使用支付宝充值接口', () => {
  for (const endpoint of [
    '/billing/recharge/alipay/config',
    '/billing/recharge/packages',
    '/billing/recharge/alipay/orders',
    '/billing/admin/recharge-packages',
  ]) {
    assert.match(billingApi, new RegExp(endpoint.replaceAll('/', '\\/')))
  }
})

test('工作区页面同时展示固定比例充值、限时套餐广告图和本人订单', () => {
  assert.match(tenantConsole, /1 元 = 100 积分/)
  assert.match(tenantConsole, /自定义充值/)
  assert.match(tenantConsole, /限时充值套餐/)
  assert.match(tenantConsole, /rechargePackage\.image_url/)
  assert.match(tenantConsole, /createAlipayRechargeOrder/)
  assert.match(tenantConsole, /window\.location\.assign\(result\.payment_url\)/)
  assert.match(tenantConsole, /本人充值记录/)
  assert.match(platformHeader, /充值积分/)
  assert.match(platformHeader, /section: 'recharge'/)
})

test('平台后台保留可编辑充值套餐入口和广告图预览', () => {
  assert.match(billingAdmin, /label="充值套餐" name="recharge"/)
  assert.match(billingAdmin, /RechargePackageAdminPanel/)
  const panel = fs.readFileSync(
    new URL('../src/components/RechargePackageAdminPanel.vue', import.meta.url),
    'utf8',
  )
  for (const text of ['套餐名称', '售价（元）', '到账积分', '开始时间', '结束时间', '广告图片', '启用']) {
    assert.match(panel, new RegExp(text))
  }
  assert.match(panel, /item\.image_url/)
  assert.match(panel, /updateRechargePackage/)
  assert.match(panel, /createRechargePackage/)
})
