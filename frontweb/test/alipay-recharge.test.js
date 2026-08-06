import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const billingApi = fs.readFileSync(new URL('../src/api/billing.js', import.meta.url), 'utf8')
const tenantConsole = fs.readFileSync(new URL('../src/views/TenantConsole.vue', import.meta.url), 'utf8')
const billingAdmin = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const platformHeader = fs.readFileSync(new URL('../src/components/PlatformHeader.vue', import.meta.url), 'utf8')
const routerSource = fs.readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')
const uploadApi = fs.readFileSync(new URL('../src/api/upload.js', import.meta.url), 'utf8')
const rechargeCenterPath = new URL('../src/views/RechargeCenter.vue', import.meta.url)

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
  assert.match(platformHeader, /name:\s*'recharge-center'/)
  assert.match(platformHeader, /name:\s*'tenant-console',\s*query:\s*\{\s*section:\s*'redeem'\s*\}/)
})

test('独立充值中心保留旧入口兼容并提供套餐管理 API', () => {
  assert.match(routerSource, /path:\s*['"]\/recharge['"]/)
  assert.match(routerSource, /name:\s*['"]recharge-center['"]/)
  assert.match(routerSource, /import\(['"]@\/views\/RechargeCenter\.vue['"]\)/)
  assert.match(routerSource, /title:\s*['"]充值中心['"],\s*requiresAuth:\s*true/)
  assert.match(routerSource, /legacyRechargeRedirect\(to\)/)
  assert.match(routerSource, /if\s*\(legacyRedirect\)\s*return\s+legacyRedirect/)
  assert.match(billingApi, /function\s+reorderRechargePackages\(packageIds\)/)
  assert.match(billingApi, /request\.put\(\s*['"]\/billing\/admin\/recharge-packages\/order['"]\s*,\s*\{\s*package_ids:\s*packageIds\s*\}/s)
  assert.match(uploadApi, /function\s+uploadRechargePackageImage\(file\)/)
  assert.match(uploadApi, /form\.append\(\s*['"]file['"]\s*,\s*file\s*\)/)
  assert.match(uploadApi, /request\.post\(\s*['"]\/billing\/admin\/recharge-packages\/image['"]\s*,\s*form\s*,/s)
})

test('充值中心占位页可供路由构建且不会提前发起业务请求', () => {
  assert.equal(fs.existsSync(rechargeCenterPath), true)
  const rechargeCenter = fs.readFileSync(rechargeCenterPath, 'utf8')
  assert.match(rechargeCenter, /充值中心/)
  assert.match(rechargeCenter, /支付通道准备中/)
  assert.doesNotMatch(rechargeCenter, /@\/api\/|request\.|fetch\(/)
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
  assert.match(panel, /:min="0\.01"/)
  assert.match(panel, /请填写广告图片/)
  assert.match(panel, /updateRechargePackage/)
  assert.match(panel, /createRechargePackage/)
})
