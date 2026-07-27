import test from 'node:test'
import assert from 'node:assert/strict'

import { authRedirect } from '../src/utils/authGuard.js'

test('本地模式不强制登录', () => {
  assert.equal(authRedirect(false, { path: '/film/1' }, null), null)
});

test('公开模式匿名访问业务页跳转登录并保留原地址', () => {
  assert.deepEqual(authRedirect(true, { path: '/film/1', fullPath: '/film/1?tab=video' }, null), {
    name: 'login', query: { redirect: '/film/1?tab=video' },
  })
});

test('公开首页允许匿名访问', () => {
  assert.equal(authRedirect(true, { name: 'list', path: '/', meta: { public: true } }, null), null)
})

test('需登录页面不依赖构建模式也会跳转登录', () => {
  assert.deepEqual(
    authRedirect(false, {
      name: 'canvas-projects',
      path: '/canvas',
      fullPath: '/canvas',
      meta: { requiresAuth: true },
    }, null),
    { name: 'login', query: { redirect: '/canvas' } },
  )
})

test('登录页和已登录访问不重复跳转', () => {
  assert.equal(authRedirect(true, { name: 'login', path: '/login' }, null), null)
  assert.equal(authRedirect(true, { path: '/film/1' }, { token: 'token-1' }), null)
});
