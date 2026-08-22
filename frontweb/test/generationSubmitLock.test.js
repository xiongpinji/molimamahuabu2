import test from 'node:test'
import assert from 'node:assert/strict'

test('提交锁首次获取成功且重复获取被拒绝', async () => {
  const lockModule = await import('../src/utils/generationSubmitLock.js').catch(() => ({}))
  assert.equal(typeof lockModule.tryAcquireGenerationLock, 'function')

  const running = new Set()
  assert.equal(lockModule.tryAcquireGenerationLock(running, '19:first'), true)
  assert.equal(lockModule.tryAcquireGenerationLock(running, '19:first'), false)
  assert.equal(running.has('19:first'), true)
})

test('释放后允许再次提交且不同帧类型互不阻塞', async () => {
  const lockModule = await import('../src/utils/generationSubmitLock.js').catch(() => ({}))
  assert.equal(typeof lockModule.tryAcquireGenerationLock, 'function')

  const running = new Set(['19:first'])
  assert.equal(lockModule.tryAcquireGenerationLock(running, '19:last'), true)
  lockModule.releaseGenerationLock(running, '19:first')
  assert.equal(lockModule.tryAcquireGenerationLock(running, '19:first'), true)
})
