import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACCOUNT_PERMISSIONS,
  BILLING_PERMISSIONS,
  canPlatformAccount,
} from '../src/utils/platformRbac.js'
import { authRedirect } from '../src/utils/authGuard.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('账号管理前端权限提示与服务端矩阵保持一致', () => {
  assert.equal(canPlatformAccount('admin', ACCOUNT_PERMISSIONS.ROLE), true)
  assert.equal(canPlatformAccount('ops', ACCOUNT_PERMISSIONS.STATUS), true)
  assert.equal(canPlatformAccount('ops', ACCOUNT_PERMISSIONS.ROLE), false)
  assert.equal(canPlatformAccount('support', ACCOUNT_PERMISSIONS.FORCE_LOGOUT), true)
  assert.equal(canPlatformAccount('support', ACCOUNT_PERMISSIONS.STATUS), false)
  assert.equal(canPlatformAccount('read_only', ACCOUNT_PERMISSIONS.READ), true)
  assert.equal(canPlatformAccount('read_only', ACCOUNT_PERMISSIONS.FORCE_LOGOUT), false)
  assert.equal(canPlatformAccount('user', ACCOUNT_PERMISSIONS.READ), false)
  assert.equal(canPlatformAccount('redeem_admin', BILLING_PERMISSIONS.REDEEM_CODES_MANAGE), true)
  assert.equal(canPlatformAccount('redeem_admin', BILLING_PERMISSIONS.MANAGE), false)
  assert.equal(canPlatformAccount('redeem_admin', ACCOUNT_PERMISSIONS.READ), false)
})

test('公开模式阻止普通用户直接进入账号管理页', () => {
  const target = { path: '/account-admin', meta: { roles: ['admin', 'ops', 'support', 'read_only'] } }
  assert.deepEqual(authRedirect(true, target, { token: 'token', user: { role: 'user' } }), { name: 'list' })
  assert.equal(authRedirect(true, target, { token: 'token', user: { role: 'support' } }), null)
})

test('统一管理后台在进入页面前要求管理员登录态', () => {
  const router = fs.readFileSync(path.join(root, 'src/router/index.js'), 'utf8')
  assert.match(
    router,
    /path:\s*'\/billing-admin'[\s\S]*?meta:\s*\{\s*title:\s*'平台管理后台',\s*roles:\s*\['admin',\s*'redeem_admin'\],\s*requiresAuth:\s*true\s*\}/,
  )
  const target = { path: '/billing-admin', meta: { roles: ['admin', 'redeem_admin'] } }
  assert.deepEqual(authRedirect(true, target, null), { name: 'login', query: { redirect: '/billing-admin' } })
  assert.deepEqual(authRedirect(true, target, { token: 'token', user: { role: 'ops' } }), { name: 'list' })
  assert.equal(authRedirect(true, target, { token: 'token', user: { role: 'admin' } }), null)
  assert.equal(authRedirect(true, target, { token: 'token', user: { role: 'redeem_admin' } }), null)
})

test('兑换码管理员后台不加载或展示总管理员数据', () => {
  const view = fs.readFileSync(path.join(root, 'src/views/BillingAdmin.vue'), 'utf8')
  assert.match(view, /const isSuperAdmin = !publicMode \|\| readSession\(\)\?\.user\?\.role === 'admin'/)
  assert.match(view, /const activeTab = ref\(isSuperAdmin \? 'models' : 'codes'\)/)
  assert.match(view, /<el-tab-pane v-if="isSuperAdmin" label="模型计费"/)
  assert.match(view, /<el-tab-pane v-if="isSuperAdmin" label="经营台账"/)
  assert.match(view, /<el-tab-pane label="兑换码" name="codes"/)
  assert.match(view, /if \(!isSuperAdmin\) return/)
})

test('首页头部在未登录时始终提供登录入口', () => {
  const header = fs.readFileSync(path.join(root, 'src/components/PlatformHeader.vue'), 'utf8')
  assert.match(header, /v-else\s+class="platform-header__button platform-header__account"/)
  assert.doesNotMatch(header, /v-else-if="publicMode"/)
})

test('账号管理页使用独立 JWT API 并按权限控制敏感操作', () => {
  const view = fs.readFileSync(path.join(root, 'src/views/AccountAdmin.vue'), 'utf8')
  const api = fs.readFileSync(path.join(root, 'src/api/platformAccounts.js'), 'utf8')
  assert.match(api, /request\.get\('\/platform-admin\/users'\)/)
  assert.match(api, /\/role`/)
  assert.match(api, /\/status`/)
  assert.match(api, /\/force-logout`/)
  assert.match(view, /canRole/)
  assert.match(view, /canStatus/)
  assert.match(view, /canForceLogout/)
})
