import test from 'node:test'
import assert from 'node:assert/strict'
import {
  installBrowserWheelZoomGuard,
  preventModifiedWheelPageZoom,
} from '../src/utils/browser-zoom-guard.js'

test('仅阻止 Ctrl 或 Command 修饰的滚轮默认行为', () => {
  let prevented = 0
  const preventDefault = () => { prevented += 1 }

  preventModifiedWheelPageZoom({ ctrlKey: false, metaKey: false, preventDefault })
  assert.equal(prevented, 0)

  preventModifiedWheelPageZoom({ ctrlKey: true, metaKey: false, preventDefault })
  preventModifiedWheelPageZoom({ ctrlKey: false, metaKey: true, preventDefault })
  assert.equal(prevented, 2)
})

test('在捕获阶段安装非被动监听，且卸载使用同一处理器', () => {
  const calls = []
  const target = {
    addEventListener(...args) { calls.push(['add', ...args]) },
    removeEventListener(...args) { calls.push(['remove', ...args]) },
  }

  const uninstall = installBrowserWheelZoomGuard(target)
  uninstall()

  assert.equal(calls[0][0], 'add')
  assert.equal(calls[0][1], 'wheel')
  assert.equal(calls[0][2], preventModifiedWheelPageZoom)
  assert.deepEqual(calls[0][3], { capture: true, passive: false })
  assert.deepEqual(calls[1], ['remove', 'wheel', preventModifiedWheelPageZoom, true])
})
