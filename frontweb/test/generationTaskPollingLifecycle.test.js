import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'

test('停止过的任务可显式恢复轮询，正常完成后也能再次轮询', async (t) => {
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  t.after(() => vite.close())

  const { useGenerationTaskStore, GEN_RESOURCE } = await vite.ssrLoadModule(
    '/src/stores/generationTaskStore.js'
  )
  const { taskAPI } = await vite.ssrLoadModule('/src/api/task.js')
  const responses = [
    { status: 'completed', result: { round: 1 } },
    { status: 'completed', result: { round: 2 } },
  ]
  let calls = 0
  taskAPI.get = async () => {
    calls += 1
    return responses.shift()
  }

  setActivePinia(createPinia())
  const store = useGenerationTaskStore()
  const meta = {
    dramaId: 1,
    episodeId: 2,
    resourceType: GEN_RESOURCE.SB_IMAGE,
    resourceId: 3,
    label: '分镜图片',
  }

  store.stopPollingTask('task-image', '页面切换时停止轮询')
  const resumed = await store.pollTask('task-image', meta, null, {
    interval: 0,
    maxAttempts: 1,
    showErrorToast: false,
    showTimeoutToast: false,
  })
  assert.deepEqual(resumed, { status: 'completed', result: { round: 1 } })

  const repeated = await store.pollTask('task-image', meta, null, {
    interval: 0,
    maxAttempts: 1,
    showErrorToast: false,
    showTimeoutToast: false,
  })
  assert.deepEqual(repeated, { status: 'completed', result: { round: 2 } })
  assert.equal(calls, 2)
})

test('任务查询 404 是终态失败，只请求一次且返回可重试提示', async (t) => {
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  t.after(() => vite.close())

  const { useGenerationTaskStore, GEN_RESOURCE } = await vite.ssrLoadModule(
    '/src/stores/generationTaskStore.js'
  )
  const { taskAPI } = await vite.ssrLoadModule('/src/api/task.js')
  let calls = 0
  taskAPI.get = async () => {
    calls += 1
    const error = new Error('资源不存在')
    error.response = { status: 404 }
    throw error
  }

  setActivePinia(createPinia())
  const store = useGenerationTaskStore()
  const result = await store.pollTask('missing-task', {
    dramaId: 1,
    episodeId: 2,
    resourceType: GEN_RESOURCE.PROP_IMAGE,
    resourceId: 8,
    label: '道具图片',
  }, null, {
    interval: 0,
    maxAttempts: 5,
    showErrorToast: false,
    showTimeoutToast: false,
  })

  assert.equal(result.status, 'failed')
  assert.match(result.error, /任务不存在或无权访问/)
  assert.equal(calls, 1)
})

test('任务轮询请求使用 silentError，避免全局拦截器重复弹出 404', async (t) => {
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  t.after(() => vite.close())

  const requestModule = await vite.ssrLoadModule('/src/utils/request.js')
  const { taskAPI } = await vite.ssrLoadModule('/src/api/task.js')
  let captured
  requestModule.default.get = async (...args) => {
    captured = args
    return { status: 'completed' }
  }

  await taskAPI.get('task-1')

  assert.equal(captured[0], '/tasks/task-1')
  assert.equal(captured[1].silentError, true)
})
