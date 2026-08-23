import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const view = fs.readFileSync(new URL('../src/views/personal-center.vue', import.meta.url), 'utf8')
const app = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const router = fs.readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')
const badge = fs.readFileSync(new URL('../src/components/AccountBadge.vue', import.meta.url), 'utf8')
const authApi = fs.readFileSync(new URL('../src/api/auth.js', import.meta.url), 'utf8')
const billingApi = fs.readFileSync(new URL('../src/api/billing.js', import.meta.url), 'utf8')

test('个人中心保留兼容路由并由账户入口打开全局弹层', () => {
  assert.match(router, /path:\s*['"]\/personal-center['"]/)
  assert.match(router, /name:\s*['"]personal-center['"]/)
  assert.match(router, /requiresAuth:\s*true/)
  assert.match(app, /<el-dialog/)
  assert.match(app, /<PersonalCenter/)
  assert.match(app, /personalCenterOpen/)
  assert.match(badge, /defineEmits/)
  assert.match(badge, /emit\(['"]open['"]\)/)
  assert.match(badge, /个人中心/)
})

test('个人中心使用左侧导航和去卡片化内容层级', () => {
  assert.match(view, /center-shell/)
  assert.match(view, /center-sidebar/)
  assert.match(view, /panel-close/)
  assert.match(view, /works-list/)
  assert.doesNotMatch(view, /metric-grid/)
  assert.doesNotMatch(view, /works-grid/)
})

test('个人中心接通真实账户、积分、用量、作品和登录审计', () => {
  assert.match(authApi, /\/auth\/me/)
  assert.match(billingApi, /\/billing\/audit-events/)
  assert.match(view, /getCreditAccount/)
  assert.match(view, /listCreditTransactions/)
  assert.match(view, /dramaAPI\.list/)
  assert.match(view, /listAuditEvents/)
  assert.match(view, /积分账单/)
  assert.match(view, /用量统计/)
  assert.match(view, /我的作品/)
  assert.match(view, /登录与安全/)
})

test('普通用户个人中心明确提供兑换码兑换入口', () => {
  assert.match(view, /label:\s*['"]兑换码兑换['"]/)
  assert.match(view, /redeemCredits\(redeemCode\.value\)/)
  assert.match(view, /立即兑换/)
})

test('个人中心按现有角色权限恢复管理后台入口', () => {
  assert.match(view, /管理后台/)
  assert.match(view, /工作区与积分/)
  assert.match(view, /账号与权限/)
  assert.match(view, /运营与计费/)
  assert.match(view, /模型配置/)
  assert.match(view, /ACCOUNT_PERMISSIONS\.READ/)
  assert.match(view, /BILLING_PERMISSIONS\.REDEEM_CODES_MANAGE/)
  assert.match(view, /canPlatformAccount/)
  assert.match(view, /openManagement/)
  assert.match(view, /redeem_admin:\s*['"]兑换码管理员['"]/)
  assert.match(view, /管理后台[\s\S]+v-for="item in navigation"/)
})

test('个人中心没有数据链的参考模块明确标记尚未开放', () => {
  for (const label of ['社群课程', '礼品卡', '优惠券', '宝箱', '我的点赞', '站内消息', '发票管理']) {
    assert.match(view, new RegExp(label))
  }
  assert.match(view, /尚未开放/)
})

test('体验设置真实持久化且安全操作沿用现有会话语义', () => {
  assert.match(view, /moli-personal-reduce-motion/)
  assert.match(view, /changePassword/)
  assert.match(view, /clearSession/)
  assert.match(view, /logoutApi/)
  assert.match(view, /saveCurrentTenantId/)
})

test('单个个人中心接口失败时不阻断其他真实数据加载', () => {
  assert.match(view, /Promise\.allSettled/)
  assert.match(view, /dataErrors/)
  assert.match(view, /暂时无法加载/)
})
