import test from 'node:test'
import assert from 'node:assert/strict'

import {
  saveSession,
  readSession,
  clearSession,
  applyAuthHeader,
  saveAdminToken,
  applyAdminHeader,
  saveCurrentTenantId,
  readCurrentTenantId,
  applyTenantHeader,
  clearSessionOnUnauthorized,
} from '../src/utils/authSession.js'

function storage() {
  const values = new Map()
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

test('登录会话只保存令牌和公开用户信息', () => {
  const store = storage()
  saveSession({ token: 'token-1', user: { id: 'u1', email: 'a@example.com', role: 'user', password: 'secret' } }, store)
  assert.deepEqual(readSession(store), {
    token: 'token-1',
    user: { id: 'u1', email: 'a@example.com', role: 'user' },
  })
});

test('请求存在会话时自动添加 Bearer 令牌', () => {
  const store = storage()
  saveSession({ token: 'token-1', user: { id: 'u1', email: 'a@example.com', role: 'user' } }, store)
  assert.deepEqual(applyAuthHeader({ headers: {} }, store).headers, { Authorization: 'Bearer token-1' })
});

test('退出后清除会话且匿名请求不添加认证头', () => {
  const store = storage()
  saveSession({ token: 'token-1', user: { id: 'u1', email: 'a@example.com', role: 'user' } }, store)
  clearSession(store)
  assert.equal(readSession(store), null)
  assert.deepEqual(applyAuthHeader({ headers: {} }, store).headers, {})
});

test('管理员令牌仅添加到管理接口且不覆盖用户令牌', () => {
  const store = storage()
  saveAdminToken('admin-token', store)
  const managed = applyAdminHeader({ url: '/billing/prices', headers: { Authorization: 'Bearer user-token' } }, store)
  assert.equal(managed.headers.Authorization, 'Bearer user-token')
  assert.equal(managed.headers['X-Platform-Admin-Token'], 'admin-token')
  assert.equal(applyAdminHeader({ url: '/videos', headers: {} }, store).headers['X-Platform-Admin-Token'], undefined)
  assert.equal(applyAdminHeader({ url: '/billing/plans', method: 'get', headers: {} }, store).headers['X-Platform-Admin-Token'], undefined)
  assert.equal(applyAdminHeader({ url: '/billing/plans/creator', method: 'put', headers: {} }, store).headers['X-Platform-Admin-Token'], 'admin-token')
});

test('当前租户会持久化并自动添加到登录请求', () => {
  const store = storage()
  saveCurrentTenantId('tenant-1', store)
  assert.equal(readCurrentTenantId(store), 'tenant-1')
  assert.deepEqual(applyTenantHeader({ headers: {} }, store).headers, { 'X-Tenant-Id': 'tenant-1' })
});

test('退出登录同时清除当前租户', () => {
  const store = storage()
  saveSession({ token: 'token-1', user: { id: 'u1', email: 'a@example.com', role: 'user' } }, store)
  saveCurrentTenantId('tenant-1', store)
  clearSession(store)
  assert.equal(readCurrentTenantId(store), null)
});

test('切换登录用户时清除上一用户的租户选择', () => {
  const store = storage()
  saveSession({ token: 'token-1', user: { id: 'u1', email: 'a@example.com', role: 'user' } }, store)
  saveCurrentTenantId('tenant-1', store)
  saveSession({ token: 'token-2', user: { id: 'u2', email: 'b@example.com', role: 'user' } }, store)
  assert.equal(readCurrentTenantId(store), null)
});

test('公开模式收到 401 时清除已失效登录，本地模式和非 401 不处理', () => {
  const store = storage()
  saveSession({ token: 'token-1', user: { id: 'u1', email: 'a@example.com', role: 'user' } }, store)
  assert.equal(clearSessionOnUnauthorized(403, true, store), false)
  assert.ok(readSession(store))
  assert.equal(clearSessionOnUnauthorized(401, false, store), false)
  assert.ok(readSession(store))
  assert.equal(clearSessionOnUnauthorized(401, true, store), true)
  assert.equal(readSession(store), null)
});
