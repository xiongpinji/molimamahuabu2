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

test('平台后台保留可编辑充值套餐入口', () => {
  assert.match(billingAdmin, /label="充值套餐" name="recharge"/)
  assert.match(billingAdmin, /RechargePackageAdminPanel/)
})

const adminPanel = fs.readFileSync(
  new URL('../src/components/RechargePackageAdminPanel.vue', import.meta.url),
  'utf8',
)

function createAdminPanelHarness(overrides = {}) {
  const script = adminPanel.match(/<script setup>([\s\S]*?)<\/script>/)?.[1] || ''
  let skippingImport = false
  const executable = script.split('\n').filter((line) => {
    if (skippingImport) {
      if (/\sfrom\s+['"]/.test(line)) skippingImport = false
      return false
    }
    if (!/^\s*import\s/.test(line)) return true
    skippingImport = !/\sfrom\s+['"]/.test(line)
    return false
  }).join('\n')
  const messages = { success: [], warning: [], error: [] }
  const deps = {
    createRechargePackage: async () => ({}),
    listAdminRechargePackages: async () => [],
    reorderRechargePackages: async (ids) => ids.map((id, index) => ({ id, name: id, sort_order: index })),
    updateRechargePackage: async () => ({}),
    uploadRechargePackageImage: async () => ({ url: '/static/uploads/recharge-packages/new.png' }),
    ElMessage: {
      success: (message) => messages.success.push(message),
      warning: (message) => messages.warning.push(message),
      error: (message) => messages.error.push(message),
    },
    ...overrides,
  }
  const api = Function('deps', `
    const {
      createRechargePackage, listAdminRechargePackages, reorderRechargePackages,
      updateRechargePackage, uploadRechargePackageImage, ElMessage,
    } = deps
    const ref = (value) => ({ value })
    const reactive = (value) => value
    const watch = () => {}
    const onMounted = () => {}
    ${executable}
    return {
      draft, packages, stableOrder, uploading, normalizePackage, toPayload,
      validate, selectItem, saveItem, uploadImage, persistOrder,
    }
  `)(deps)
  return { ...api, messages }
}

test('套餐管理器提供全字段草稿、创建更新与用户端实时预览', () => {
  for (const text of [
    '套餐名称', '角标文案', '广告主标题', '广告副标题', '按钮文案',
    '售价（元）', '到账积分', '开始时间', '结束时间', '强调色', '推荐套餐', '状态',
  ]) {
    assert.match(adminPanel, new RegExp(text))
  }
  for (const field of [
    'name', 'badge_text', 'ad_title', 'ad_subtitle', 'button_text', 'amount_yuan',
    'credits', 'starts_at', 'ends_at', 'image_url', 'accent_color', 'sort_order',
    'is_featured', 'status',
  ]) {
    if (field === 'sort_order') assert.match(adminPanel, /sort_order:\s*packages\.value\.length/)
    else assert.match(adminPanel, new RegExp(`draft\\.${field}`), `草稿应包含 ${field}`)
    assert.match(adminPanel, new RegExp(`${field}:\\s*item\\.${field}|${field}:\\s*Number\\(item\\.${field}|${field}:\\s*item\\.${field}\\s*\\?`), `保存 payload 应包含 ${field}`)
  }
  assert.match(adminPanel, /createRechargePackage/)
  assert.match(adminPanel, /updateRechargePackage/)
  assert.match(adminPanel, /<RechargePackageCard\s+:item="draft"\s+preview\s+disabled/s)
  assert.doesNotMatch(adminPanel, /@purchase=/)
})

test('套餐广告图上传校验格式且仅在成功后替换草稿图片', () => {
  assert.match(adminPanel, /uploadRechargePackageImage/)
  assert.match(adminPanel, /accept="image\/jpeg,image\/png,image\/webp"/)
  assert.match(adminPanel, /\['image\/jpeg',\s*'image\/png',\s*'image\/webp'\]\.includes\(file\.type\)/)
  assert.match(adminPanel, /const\s+result\s*=\s*await\s+uploadRechargePackageImage\(file\)[\s\S]*draft\.image_url\s*=\s*result\.url/)
  assert.ok(
    adminPanel.indexOf('await uploadRechargePackageImage(file)') < adminPanel.indexOf('draft.image_url = result.url'),
    '上传成功前不得替换草稿图片',
  )
  assert.doesNotMatch(adminPanel, /catch\s*\([^)]*\)\s*\{[^}]*draft\.image_url\s*=\s*['"]/s)
})

test('套餐排序提交完整 ID 列表并在失败时回滚稳定顺序', () => {
  assert.match(adminPanel, /reorderRechargePackages/)
  assert.match(adminPanel, /draggable="true"/)
  assert.match(adminPanel, /:aria-label="`上移/)
  assert.match(adminPanel, /:aria-label="`下移/)
  assert.match(adminPanel, /await\s+reorderRechargePackages\(next\.map\(\(item\)\s*=>\s*item\.id\)\)/)
  assert.match(adminPanel, /const\s+previous\s*=\s*packages\.value[\s\S]*const\s+previousStableOrder\s*=\s*stableOrder\.value\.slice\(\)/s)
  assert.match(adminPanel, /packages\.value\s*=\s*next[\s\S]*catch\s*\([^)]*\)\s*\{[\s\S]*previousStableOrder[\s\S]*previous\.find/s)
  assert.match(adminPanel, /stableOrder\.value\s*=\s*previousStableOrder/)
})

test('套餐管理器按三栏、两栏和单栏响应并保留失败草稿', () => {
  assert.match(adminPanel, /grid-template-columns:\s*300px\s+minmax\(420px,\s*1fr\)\s+minmax\(320px,\s*420px\)/)
  assert.match(adminPanel, /@media\s*\(max-width:\s*1200px\)[\s\S]*grid-template-columns:\s*300px\s+minmax\(0,\s*1fr\)/)
  assert.match(adminPanel, /@media\s*\(max-width:\s*760px\)[\s\S]*grid-template-columns:\s*1fr/)
  assert.match(adminPanel, /catch\s*\(error\)\s*\{[\s\S]*套餐保存失败/s)
  assert.doesNotMatch(adminPanel, /catch\s*\(error\)\s*\{[^}]*Object\.assign\(draft,\s*emptyDraft\(\)\)/s)
  assert.match(adminPanel, /v-if="packages\.length === 0"/)
  assert.match(adminPanel, /新增套餐/)
  assert.match(adminPanel, /推荐套餐由后端事务保证全局唯一/)
})

test('套餐表单保留关键业务校验', () => {
  for (const text of ['请填写套餐名称', '请填写广告主标题', '请填写按钮文案', '请填写广告图片']) {
    assert.match(adminPanel, new RegExp(text))
  }
  assert.match(adminPanel, /:min="0\.01"/)
  assert.match(adminPanel, /\/static\\\/uploads\\\/recharge-packages\\\//)
  assert.match(adminPanel, /\^#\[0-9a-fA-F\]\{6\}\$/)
})

test('套餐草稿归一化分转元并生成完整保存 payload', () => {
  const { normalizePackage, toPayload } = createAdminPanelHarness()
  const item = normalizePackage({
    id: 'pkg-1',
    name: '夏日套餐',
    badge_text: '限时',
    ad_title: '',
    ad_subtitle: '本周有效',
    button_text: '',
    amount_cents: 1234,
    credits: 1500,
    starts_at: '2026-08-01T00:00:00.000Z',
    ends_at: '2026-08-31T00:00:00.000Z',
    image_url: '/static/uploads/recharge-packages/summer.png',
    accent_color: '#FF7139',
    sort_order: 2,
    is_featured: 1,
    status: 'active',
  })
  assert.equal(item.amount_yuan, 12.34)
  assert.equal(item.ad_title, '夏日套餐')
  assert.equal(item.button_text, '立即购买')
  assert.equal(item.is_featured, true)
  assert.deepEqual(toPayload(item), {
    name: '夏日套餐',
    badge_text: '限时',
    ad_title: '夏日套餐',
    ad_subtitle: '本周有效',
    button_text: '立即购买',
    amount_yuan: '12.34',
    credits: 1500,
    starts_at: '2026-08-01T00:00:00.000Z',
    ends_at: '2026-08-31T00:00:00.000Z',
    image_url: '/static/uploads/recharge-packages/summer.png',
    accent_color: '#ff7139',
    sort_order: 2,
    is_featured: true,
    status: 'active',
  })
})

test('广告图上传失败保留原图，成功后才替换', async () => {
  const failed = createAdminPanelHarness({
    uploadRechargePackageImage: async () => { throw new Error('upload failed') },
  })
  failed.draft.image_url = '/static/uploads/recharge-packages/original.png'
  const failedEvent = { target: { files: [{ type: 'image/png' }], value: 'selected' } }
  await failed.uploadImage(failedEvent)
  assert.equal(failed.draft.image_url, '/static/uploads/recharge-packages/original.png')
  assert.equal(failedEvent.target.value, '')
  assert.deepEqual(failed.messages.error, ['upload failed'])

  const succeeded = createAdminPanelHarness()
  succeeded.draft.image_url = '/static/uploads/recharge-packages/original.png'
  await succeeded.uploadImage({ target: { files: [{ type: 'image/webp' }], value: 'selected' } })
  assert.equal(succeeded.draft.image_url, '/static/uploads/recharge-packages/new.png')
})

test('排序提交完整 ID，失败时恢复最近稳定顺序', async () => {
  const payloads = []
  const succeeded = createAdminPanelHarness({
    reorderRechargePackages: async (ids) => {
      payloads.push(ids)
      return ids.map((id, index) => ({ id, name: id, amount_cents: 1000, credits: 1000, sort_order: index }))
    },
  })
  const a = { id: 'a', name: 'A' }
  const b = { id: 'b', name: 'B' }
  succeeded.packages.value = [a, b]
  succeeded.stableOrder.value = ['a', 'b']
  await succeeded.persistOrder([b, a])
  assert.deepEqual(payloads, [['b', 'a']])
  assert.deepEqual(succeeded.stableOrder.value, ['b', 'a'])

  const failed = createAdminPanelHarness({
    reorderRechargePackages: async () => { throw new Error('order failed') },
  })
  failed.packages.value = [a, b]
  failed.stableOrder.value = ['a', 'b']
  await failed.persistOrder([b, a])
  assert.deepEqual(failed.packages.value.map((item) => item.id), ['a', 'b'])
  assert.deepEqual(failed.stableOrder.value, ['a', 'b'])
  assert.deepEqual(failed.messages.error, ['order failed'])
})

test('切换套餐使用独立草稿且保存失败保留当前图片', async () => {
  const harness = createAdminPanelHarness({
    updateRechargePackage: async () => { throw new Error('save failed') },
  })
  const listed = {
    id: 'pkg-1',
    name: '原套餐',
    ad_title: '广告标题',
    button_text: '立即购买',
    amount_cents: 1000,
    credits: 1000,
    image_url: '/static/uploads/recharge-packages/original.png',
    accent_color: '#ff7139',
    sort_order: 0,
    is_featured: 0,
    status: 'active',
  }
  harness.selectItem(listed)
  harness.draft.name = '仅修改草稿'
  assert.equal(listed.name, '原套餐')
  await harness.saveItem()
  assert.equal(harness.draft.image_url, '/static/uploads/recharge-packages/original.png')
  assert.deepEqual(harness.messages.error, ['save failed'])
})
