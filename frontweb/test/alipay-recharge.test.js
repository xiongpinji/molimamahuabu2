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
const packageCardPath = new URL('../src/components/RechargePackageCard.vue', import.meta.url)
const customPanelPath = new URL('../src/components/CustomRechargePanel.vue', import.meta.url)
const appSource = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')

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

test('工作区只保留充值中心入口，兑换码和积分流水不受影响', () => {
  assert.doesNotMatch(tenantConsole, /createAlipayRechargeOrder/)
  assert.doesNotMatch(tenantConsole, /listRechargePackages/)
  assert.doesNotMatch(tenantConsole, /listAlipayRechargeOrders/)
  assert.match(tenantConsole, /name:\s*'recharge-center'/)
  assert.match(tenantConsole, /前往充值中心/)
  assert.match(tenantConsole, /redeemCredits/)
  assert.match(tenantConsole, /route\.query\.section\s*===\s*'redeem'/)
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

test('独立充值中心并行加载数据并提供套餐、自定义和订单抽屉', () => {
  assert.equal(fs.existsSync(rechargeCenterPath), true)
  const rechargeCenter = fs.readFileSync(rechargeCenterPath, 'utf8')
  for (const text of ['充值中心', '精选套餐', '自定义充值', '充值记录', '支付通道准备中']) {
    assert.match(rechargeCenter, new RegExp(text))
  }
  assert.match(rechargeCenter, /Promise\.all\(\s*\[\s*getCreditAccount\(\),\s*getAlipayRechargeConfig\(\),\s*listRechargePackages\(\),\s*listAlipayRechargeOrders\(\),?\s*\]\s*\)/s)
  assert.match(rechargeCenter, /<el-drawer/)
  assert.match(rechargeCenter, /RechargePackageCard/)
  assert.match(rechargeCenter, /CustomRechargePanel/)
  assert.match(rechargeCenter, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(rechargeCenter, /@media\s*\(max-width:\s*1024px\)[\s\S]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(rechargeCenter, /@media\s*\(max-width:\s*760px\)[\s\S]*grid-template-columns:\s*1fr/)
})

test('支付未配置时模板和处理函数双重拦截订单请求', () => {
  const rechargeCenter = fs.readFileSync(rechargeCenterPath, 'utf8')
  assert.match(rechargeCenter, /:disabled="!rechargeConfig\.configured"/)
  assert.match(rechargeCenter, /if\s*\(!rechargeConfig\.value\.configured\)\s*return/)
  assert.match(rechargeCenter, /createAlipayRechargeOrder/)
  assert.ok(
    rechargeCenter.indexOf('if (!rechargeConfig.value.configured) return')
      < rechargeCenter.indexOf('createAlipayRechargeOrder({'),
    '支付配置守卫必须先于订单 API 调用',
  )
  assert.match(rechargeCenter, /normalizePaymentRedirectUrl/)
  assert.match(rechargeCenter, /const\s+paymentUrl\s*=\s*normalizePaymentRedirectUrl\(result\?\.payment_url\)/)
  assert.match(rechargeCenter, /if\s*\(!paymentUrl\)\s*return/)
  assert.match(rechargeCenter, /window\.location\.assign\(paymentUrl\)/)
  assert.doesNotMatch(rechargeCenter, /window\.location\.assign\(result\.payment_url\)/)
  assert.doesNotMatch(rechargeCenter, /payment_url:\s*['"]https?:\/\//)
})

test('套餐卡完整展示结构化广告与积分明细，禁用时不发出购买事件', () => {
  assert.equal(fs.existsSync(packageCardPath), true)
  const packageCard = fs.readFileSync(packageCardPath, 'utf8')
  for (const field of ['badge_text', 'ad_title', 'ad_subtitle', 'button_text', 'image_url', 'accent_color']) {
    assert.match(packageCard, new RegExp(`item\\.${field}`))
  }
  assert.match(packageCard, /packageCreditMetrics/)
  assert.match(packageCard, /baseCredits/)
  assert.match(packageCard, /bonusCredits/)
  assert.match(packageCard, /creditsPerYuan/)
  assert.match(packageCard, /if\s*\(props\.disabled\s*\|\|\s*props\.preview\)\s*return/)
  assert.match(packageCard, /height:\s*230px/)
  assert.match(packageCard, /min-height:\s*570px/)
  assert.match(packageCard, /:alt="[^\"]*item\.name/)
})

test('自定义充值复用固定比例工具并在禁用时不发出购买事件', () => {
  assert.equal(fs.existsSync(customPanelPath), true)
  const customPanel = fs.readFileSync(customPanelPath, 'utf8')
  assert.match(customPanel, /QUICK_RECHARGE_AMOUNTS/)
  assert.match(customPanel, /creditsForCustomAmount/)
  assert.match(customPanel, /validCustomAmount/)
  assert.match(customPanel, /1\s*元\s*=\s*100\s*积分/)
  assert.match(customPanel, /if\s*\(props\.disabled\)\s*return/)
  assert.match(customPanel, /emit\(['"]purchase['"],\s*Number\(amount\.value\)\.toFixed\(2\)\)/)
  assert.match(customPanel, /QUICK_RECHARGE_AMOUNTS\.length/)
})

test('充值中心隐藏全局账户悬浮徽标', () => {
  assert.match(appSource, /route\.name\s*!==\s*'recharge-center'/)
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
