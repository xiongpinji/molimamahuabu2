import test from 'node:test'
import assert from 'node:assert/strict'

import { saveSession, readSession, clearSession, applyAuthHeader, saveAdminToken, applyAdminHeader } from '../src/utils/authSession.js'

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
});
