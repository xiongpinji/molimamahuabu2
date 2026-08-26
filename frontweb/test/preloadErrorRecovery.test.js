import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { installPreloadErrorRecovery } from '../src/utils/preloadErrorRecovery.js'

test('应用入口在 Vue 挂载前安装动态分块恢复器', () => {
  const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.match(mainSource, /installPreloadErrorRecovery\(window\)/)
  assert.ok(
    mainSource.indexOf('installPreloadErrorRecovery(window)') < mainSource.indexOf('createApp({'),
  )
})

function createBrowser() {
  const listeners = new Map()
  const storage = new Map()
  let reloads = 0
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null },
      setItem(key, value) { storage.set(key, value) },
    },
    location: {
      reload() { reloads += 1 },
    },
    dispatch(type, event) {
      listeners.get(type)?.(event)
    },
    reloadCount() {
      return reloads
    },
  }
}

test('动态分块失效时自动刷新一次并阻止原异常抛出', () => {
  const browser = createBrowser()
  let prevented = 0
  installPreloadErrorRecovery(browser, { now: () => 1_000 })

  browser.dispatch('vite:preloadError', {
    preventDefault() { prevented += 1 },
  })

  assert.equal(prevented, 1)
  assert.equal(browser.reloadCount(), 1)
})

test('短时间再次加载失败时不循环刷新', () => {
  const browser = createBrowser()
  let now = 1_000
  let prevented = 0
  installPreloadErrorRecovery(browser, { now: () => now })

  const event = { preventDefault() { prevented += 1 } }
  browser.dispatch('vite:preloadError', event)
  now += 1_000
  browser.dispatch('vite:preloadError', event)

  assert.equal(prevented, 1)
  assert.equal(browser.reloadCount(), 1)
})
