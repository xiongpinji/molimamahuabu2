import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCanvasLayoutPersistence } from '../src/utils/canvasLayoutPersistence.js'

function httpError(status) {
  const error = new Error(`HTTP ${status}`)
  error.response = { status }
  return error
}

function networkError() {
  const error = new Error('offline')
  error.code = 'ERR_NETWORK'
  error.request = {}
  return error
}

function createScheduler() {
  const pending = []
  return {
    delays: [],
    setTimer(callback, delay) {
      const token = { callback, delay, cancelled: false }
      this.delays.push(delay)
      pending.push(token)
      return token
    },
    clearTimer(token) { token.cancelled = true },
    async runNext() {
      const token = pending.shift()
      assert.ok(token, 'expected a scheduled retry')
      if (!token.cancelled) await token.callback()
    },
    get activeCount() { return pending.filter((item) => !item.cancelled).length },
  }
}

const dramaApiSource = readFileSync(fileURLToPath(new URL('../src/api/drama.js', import.meta.url)), 'utf8')
const dramaCanvasSource = readFileSync(fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)), 'utf8')

test('唯一保存协调器将交错布局和导演状态合并到后续快照', async () => {
  const scheduler = createScheduler()
  const calls = []
  let releaseFirst
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    calls.push(structuredClone(payload))
    if (calls.length === 1) await gate
    return payload
  }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })

  const first = persistence.update({ canvasLayout: { nodes: { a: { x: 1, y: 2 } } } })
  persistence.update({
    canvasLayout: { nodes: { a: { x: 1, y: 2 } }, director_timeline: { version: 2 } },
    workflowGroups: [{ id: 'g1' }],
  })
  releaseFirst()
  await first
  await persistence.flush()

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].canvasLayout.director_timeline, { version: 2 })
  assert.deepEqual(calls[1].workflowGroups, [{ id: 'g1' }])
  assert.equal(persistence.dirty, false)
})

test('保存失败保持 dirty 并允许 flush 重试', async () => {
  const scheduler = createScheduler()
  let attempts = 0
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    attempts += 1
    if (attempts === 1) throw new Error('offline')
    return payload
  }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })
  await assert.rejects(persistence.update({ canvasLayout: { version: 1 } }), /offline/)
  assert.equal(persistence.dirty, true)
  await persistence.flush()
  assert.equal(attempts, 2)
  assert.equal(persistence.dirty, false)
})

test('画布保存携带当前项目更新时间作为并发基线', () => {
  assert.match(dramaApiSource, /saveCanvasLayout\(id, canvasLayout, workflowGroups, baseUpdatedAt, config = \{\}\)/)
  assert.match(dramaApiSource, /if \(baseUpdatedAt\) body\.base_updated_at = baseUpdatedAt/)
  assert.match(dramaCanvasSource, /dramaAPI\.saveCanvasLayout\(\s*dramaId\.value,\s*canvasLayout,\s*workflowGroups,\s*drama\.value\?\.updated_at,\s*\{ silentError: true \},?\s*\)/)
})

test('布局瞬时失败按 2/4/8/15/15 秒退避并在成功后复位', async () => {
  const scheduler = createScheduler()
  const states = []
  let attempts = 0
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    attempts += 1
    if (attempts <= 5) throw httpError(503)
    return { metadata: { canvas_layout: payload.canvasLayout } }
  }, {
    savedStateDuration: 1234,
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
    onStateChange: (event) => states.push(event),
  })

  const firstFailure = await persistence.update({ canvasLayout: { x: 1 } }, { allowRetry: true })
  assert.equal(firstFailure.status, 'queued')
  assert.equal(firstFailure.revision, 1)
  assert.equal(firstFailure.delay, 2000)
  assert.equal(scheduler.activeCount, 1)

  for (let index = 0; index < 5; index += 1) await scheduler.runNext()

  assert.deepEqual(scheduler.delays.slice(0, 5), [2000, 4000, 8000, 15000, 15000])
  assert.equal(persistence.dirty, false)
  assert.equal(persistence.state, 'saved')
  assert.equal(states.filter(({ state }) => state === 'retry_wait').length, 5)
  assert.equal(scheduler.delays.at(-1), 1234)
  await scheduler.runNext()
  assert.equal(persistence.state, 'idle')

  attempts = 0
  const nextFailure = await persistence.update({ canvasLayout: { x: 2 } }, { allowRetry: true })
  assert.equal(nextFailure.status, 'queued')
  assert.equal(nextFailure.revision, 2)
  assert.equal(nextFailure.delay, 2000)
  assert.equal(scheduler.delays.at(-1), 2000)
  persistence.dispose()
})

test('自定义重试判定和 7/11 毫秒退避覆盖默认策略', async () => {
  const scheduler = createScheduler()
  let attempts = 0
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    attempts += 1
    if (attempts <= 2) throw httpError(418)
    return { metadata: { canvas_layout: payload.canvasLayout } }
  }, {
    isRetryable: (error) => error?.response?.status === 418,
    retryDelays: [7, 11],
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })

  const firstFailure = await persistence.update({ canvasLayout: { x: 1 } }, { allowRetry: true })
  assert.equal(firstFailure.status, 'queued')
  assert.equal(firstFailure.revision, 1)
  assert.equal(firstFailure.delay, 7)
  assert.deepEqual(scheduler.delays, [7])

  await scheduler.runNext()
  assert.deepEqual(scheduler.delays, [7, 11])
  assert.equal(persistence.dirty, true)

  await scheduler.runNext()
  assert.equal(attempts, 3)
  assert.equal(persistence.dirty, false)
  assert.equal(persistence.state, 'saved')
  persistence.dispose()
  assert.equal(scheduler.activeCount, 0)
})

test('退避期间只发送最新布局且任意时刻仅有一个请求和定时器', async () => {
  const scheduler = createScheduler()
  const calls = []
  let attempts = 0
  let activeSaves = 0
  let maxActiveSaves = 0
  let releaseRetry
  const retryGate = new Promise((resolve) => { releaseRetry = resolve })
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    calls.push(structuredClone(payload))
    attempts += 1
    activeSaves += 1
    maxActiveSaves = Math.max(maxActiveSaves, activeSaves)
    try {
      if (attempts === 1) throw networkError()
      if (attempts === 2) await retryGate
      return { metadata: { canvas_layout: payload.canvasLayout } }
    } finally {
      activeSaves -= 1
    }
  }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })

  await persistence.update({ canvasLayout: { x: 1 } }, { allowRetry: true })
  await persistence.update({ canvasLayout: { x: 2 } }, { allowRetry: true })
  await persistence.update({ canvasLayout: { x: 3 } }, { allowRetry: true })
  assert.equal(scheduler.activeCount, 1)
  assert.deepEqual(scheduler.delays, [2000])
  assert.equal(calls.length, 1)

  const retryRun = scheduler.runNext()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].canvasLayout, { x: 3 })
  const updateDuringRetry = persistence.update({ canvasLayout: { x: 4 } }, { allowRetry: true })
  assert.equal(calls.length, 2)
  assert.equal(maxActiveSaves, 1)

  releaseRetry()
  await Promise.all([retryRun, updateDuringRetry])
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2].canvasLayout, { x: 4 })
  assert.equal(maxActiveSaves, 1)
  assert.equal(persistence.savedRevision, persistence.revision)
  persistence.dispose()
  assert.equal(scheduler.activeCount, 0)
})

test('仅无响应和 502/503/504 的纯布局写入在 allowRetry 时自动排队', async () => {
  const retryableErrors = [
    networkError(),
    httpError(502),
    httpError(503),
    httpError(504),
  ]

  for (const error of retryableErrors) {
    const scheduler = createScheduler()
    const persistence = createCanvasLayoutPersistence(async () => { throw error }, {
      setTimer: scheduler.setTimer.bind(scheduler),
      clearTimer: scheduler.clearTimer.bind(scheduler),
    })
    const queued = await persistence.update({ canvasLayout: { error: error.message } }, { allowRetry: true })
    assert.equal(queued.status, 'queued')
    assert.equal(queued.revision, 1)
    assert.equal(queued.delay, 2000)
    assert.equal(scheduler.activeCount, 1)
    persistence.dispose()
  }

  for (const status of [400, 401, 403, 409, 500]) {
    const scheduler = createScheduler()
    const persistence = createCanvasLayoutPersistence(async () => { throw httpError(status) }, {
      setTimer: scheduler.setTimer.bind(scheduler),
      clearTimer: scheduler.clearTimer.bind(scheduler),
    })
    await assert.rejects(
      persistence.update({ canvasLayout: { status } }, { allowRetry: true }),
      new RegExp(String(status)),
    )
    assert.equal(scheduler.activeCount, 0)
    persistence.dispose()
  }

  const scheduler = createScheduler()
  const persistence = createCanvasLayoutPersistence(async () => { throw httpError(503) }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })
  await assert.rejects(persistence.update({ canvasLayout: { x: 1 } }), /503/)
  assert.equal(scheduler.activeCount, 0)
  persistence.dispose()
})

test('分组显式保存失败不重试且不会混入后续布局重试', async () => {
  const scheduler = createScheduler()
  const calls = []
  let attempt = 0
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    calls.push(structuredClone(payload))
    attempt += 1
    if (attempt <= 2) throw httpError(503)
    return { metadata: { canvas_layout: payload.canvasLayout } }
  }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })

  await assert.rejects(
    persistence.update({ workflowGroups: [{ id: 'rolled-back' }] }, { allowRetry: true }),
    /503/,
  )
  assert.equal(scheduler.activeCount, 0)

  const queued = await persistence.update({ canvasLayout: { x: 9 } }, { allowRetry: true })
  assert.equal(queued.status, 'queued')
  await scheduler.runNext()
  assert.equal(calls.length, 3)
  assert.equal(calls.slice(1).some((payload) => Object.hasOwn(payload, 'workflowGroups')), false)
  assert.deepEqual(calls.at(-1).canvasLayout, { x: 9 })
  persistence.dispose()
})

test('dispose 清除重试定时器并拒绝后续写入', async () => {
  const scheduler = createScheduler()
  let calls = 0
  const persistence = createCanvasLayoutPersistence(async () => {
    calls += 1
    throw networkError()
  }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })

  await persistence.update({ canvasLayout: { x: 1 } }, { allowRetry: true })
  assert.equal(scheduler.activeCount, 1)
  persistence.dispose()
  assert.equal(persistence.state, 'disposed')
  assert.equal(scheduler.activeCount, 0)
  await scheduler.runNext()
  await assert.rejects(persistence.update({ canvasLayout: { x: 2 } }, { allowRetry: true }), /disposed/)
  assert.equal(calls, 1)
})
