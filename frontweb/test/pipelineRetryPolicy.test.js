import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decidePipelineRetry,
  runConcurrentItems,
  shouldStopBatchOnGenerationResult,
  submitPreparedGenerationUnlessStopped,
} from '../src/utils/pipelineRetryPolicy.js'

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

test('并发任务有一个暂停后不再领取新的任务', async () => {
  let releaseFirst
  let releaseSecond
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const secondGate = new Promise((resolve) => { releaseSecond = resolve })
  const started = []

  const running = runConcurrentItems([1, 2, 3, 4], 2, async (item) => {
    started.push(item)
    if (item === 1) {
      await firstGate
      return { paused: true }
    }
    if (item === 2) await secondGate
    return { paused: false }
  })

  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
  releaseFirst()
  await new Promise((resolve) => setTimeout(resolve, 0))
  releaseSecond()

  assert.deepEqual(await running, { paused: true })
  assert.deepEqual(started, [1, 2])
})

test('任务准备期间收到停止信号时不得提交生成请求', async () => {
  let releasePreparation
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve })
  let stopped = false
  let submitCalls = 0

  const running = submitPreparedGenerationUnlessStopped({
    isStopped: () => stopped,
    prepare: async () => {
      await preparationGate
      return { prompt: 'ready' }
    },
    submit: async () => {
      submitCalls += 1
      return { task_id: 'must-not-submit' }
    },
  })

  stopped = true
  releasePreparation()

  assert.deepEqual(await running, { stopped: true })
  assert.equal(submitCalls, 0)
})

test('一个 worker 结果未知时已领取但仍在准备的 worker 不得继续 POST', async () => {
  let releaseUnknown
  let releaseSecondPreparation
  const unknownGate = new Promise((resolve) => { releaseUnknown = resolve })
  const secondPreparationGate = new Promise((resolve) => { releaseSecondPreparation = resolve })
  const started = []
  const submitted = []
  let stopped = false

  const running = runConcurrentItems([1, 2, 3, 4], 2, async (item) => {
    started.push(item)
    if (item === 1) {
      submitted.push(item)
      await unknownGate
      stopped = true
      return { paused: true }
    }

    const submission = await submitPreparedGenerationUnlessStopped({
      isStopped: () => stopped,
      prepare: async () => {
        if (item === 2) await secondPreparationGate
        return item
      },
      submit: async (preparedItem) => {
        submitted.push(preparedItem)
        return { task_id: `task-${preparedItem}` }
      },
    })
    return { paused: submission.stopped }
  })

  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
  releaseUnknown()
  await new Promise((resolve) => setTimeout(resolve, 0))
  releaseSecondPreparation()

  assert.deepEqual(await running, { paused: true })
  assert.deepEqual(started, [1, 2])
  assert.deepEqual(submitted, [1])
})
