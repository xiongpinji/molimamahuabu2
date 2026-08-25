import test from 'node:test'
import assert from 'node:assert/strict'

import { decidePipelineRetry, shouldStopBatchOnGenerationResult } from '../src/utils/pipelineRetryPolicy.js'

test('供应商任务仍可能处理中时暂停而非自动重试', () => {
  assert.deepEqual(
    decidePipelineRetry('供应商任务仍可能处理中，请勿重新提交', 0, 3),
    { retry: false, pause: true }
  )
})

test('结果未知时暂停而非自动重试', () => {
  assert.deepEqual(
    decidePipelineRetry('供应商可能已扣费，结果未知', 1, 3),
    { retry: false, pause: true }
  )
})

test('普通失败在剩余次数内仍可重试', () => {
  assert.deepEqual(decidePipelineRetry('网络繁忙', 0, 3), { retry: true, pause: false })
})

test('普通失败到达上限后不再重试', () => {
  assert.deepEqual(decidePipelineRetry('网络繁忙', 2, 3), { retry: false, pause: false })
})

test('批量任务遇到 needs_attention 结构化结果时停止领取后续任务', () => {
  assert.equal(shouldStopBatchOnGenerationResult({
    status: 'needs_attention',
    error: {
      response: {
        status: 409,
        data: {
          error: {
            code: 'RESULT_UNKNOWN_NEEDS_REVIEW',
            details: { status: 'needs_attention' },
          },
        },
      },
    },
  }), true)
})

test('批量任务普通失败不触发全队列停止', () => {
  assert.equal(shouldStopBatchOnGenerationResult({
    status: 'failed',
    error: new Error('参数错误'),
  }), false)
})
