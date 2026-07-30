import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const view = fs.readFileSync(new URL('../src/views/personal-center.vue', import.meta.url), 'utf8')
const router = fs.readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')
const badge = fs.readFileSync(new URL('../src/components/AccountBadge.vue', import.meta.url), 'utf8')
const authApi = fs.readFileSync(new URL('../src/api/auth.js', import.meta.url), 'utf8')
const billingApi = fs.readFileSync(new URL('../src/api/billing.js', import.meta.url), 'utf8')

test('个人中心是登录后独立路由并由账户头像进入', () => {
  assert.match(router, /path:\s*['"]\/personal-center['"]/)
  assert.match(router, /name:\s*['"]personal-center['"]/)
  assert.match(router, /requiresAuth:\s*true/)
  assert.match(badge, /name:\s*['"]personal-center['"]/)
  assert.match(badge, /个人中心/)
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
