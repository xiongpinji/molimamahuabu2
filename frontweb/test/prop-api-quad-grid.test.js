import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

test('道具生图接口把四视图开关传给后端', async (t) => {
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  t.after(() => vite.close())

  const { propAPI } = await vite.ssrLoadModule('/src/api/props.js')
  const request = (await vite.ssrLoadModule('/src/utils/request.js')).default
  const calls = []
  request.post = async (url, body) => {
    calls.push({ url, body })
    return { task_id: 'task-1' }
  }

  await propAPI.generateImage(8, 'gpt-image-2', 'realistic', true)

  assert.deepEqual(calls, [{
    url: '/props/8/generate',
    body: {
      model: 'gpt-image-2',
      style: 'realistic',
      use_quad_grid: true,
    },
  }])
})

test('短剧工厂批量生成道具图也传递四视图开关', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/views/FilmCreate.vue', import.meta.url)),
    'utf8'
  )
  const calls = source.match(/propAPI\.generateImage\(\s*prop\.id,[\s\S]*?\)/g) || []

  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.includes('propUseQuadGrid.value')))
})
