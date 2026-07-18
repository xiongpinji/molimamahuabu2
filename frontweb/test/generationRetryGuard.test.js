import test from 'node:test'
import assert from 'node:assert/strict'

import {
  confirmProviderBalanceRetry,
  confirmUnknownResultRetry,
  isProviderBalanceError,
} from '../src/utils/generationRetryGuard.js'

test('iCreat 余额不足错误被识别', () => {
  assert.equal(
    isProviderBalanceError('iCreat 任务失败或不存在: FAILED: insufficient balance: need 310000, have 302000'),
    true
  )
  assert.equal(isProviderBalanceError('余额不足，请充值后重试'), true)
  assert.equal(isProviderBalanceError('模型参数错误'), false)
})

test('余额不足时确认后才允许重新生成', async () => {
  let calls = 0
  const allowed = await confirmProviderBalanceRetry(
    'iCreat 任务失败或不存在: FAILED: insufficient balance: need 310000, have 302000',
    async () => { calls += 1 }
  )
  assert.equal(allowed, true)
  assert.equal(calls, 1)
})

test('余额不足时取消确认则阻止重新生成', async () => {
  const allowed = await confirmProviderBalanceRetry(
    '余额不足，请充值后重试',
    async () => { throw new Error('cancel') }
  )
  assert.equal(allowed, false)
})

test('普通生成失败无需二次确认', async () => {
  let calls = 0
  const allowed = await confirmUnknownResultRetry('模型参数错误', async () => { calls += 1 })
  assert.equal(allowed, true)
  assert.equal(calls, 0)
})

test('结果未知时确认后才允许重新生成', async () => {
  let calls = 0
  const allowed = await confirmUnknownResultRetry(
    '供应商可能已扣费，但本平台未收到结果（结果未知）',
    async () => { calls += 1 }
  )
  assert.equal(allowed, true)
  assert.equal(calls, 1)
})

test('结果未知时取消确认则阻止重新生成', async () => {
  const allowed = await confirmUnknownResultRetry(
    '结果未知，请勿连续重试',
    async () => { throw new Error('cancel') }
  )
  assert.equal(allowed, false)
})

test('供应商仍可能处理中时取消确认则阻止重新生成', async () => {
  const allowed = await confirmUnknownResultRetry(
    '供应商任务仍可能处理中，请勿重新提交',
    async () => { throw new Error('cancel') }
  )
  assert.equal(allowed, false)
})

test('供应商最终状态未知时取消确认则阻止重新生成', async () => {
  const allowed = await confirmUnknownResultRetry(
    '供应商最终状态未知，请先核对账单',
    async () => { throw new Error('cancel') }
  )
  assert.equal(allowed, false)
})
