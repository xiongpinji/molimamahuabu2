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
