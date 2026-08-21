import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createFilmCreateModelCatalogLoader,
  filmCreateVideoModelDecision,
  intersectFilmCreateVideoModels,
} from '../src/utils/filmCreateModelCatalog.js'

function viewSource(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

const filmCreateSource = viewSource('../src/views/FilmCreate.vue')

test('FilmCreate 仅用公开画布目录呈现视频模型元数据且仍提交原始 model', () => {
  assert.match(filmCreateSource, /request\.get\('\/canvas\/model-catalog'\)/)
  assert.match(filmCreateSource, /intersectFilmCreateVideoModels/)
  assert.equal((filmCreateSource.match(/:label="model\.label" :value="model\.value"/g) || []).length, 3)
  assert.equal((filmCreateSource.match(/class="sb-video-model-note"/g) || []).length, 3)
  assert.match(filmCreateSource, /const selectedVideoModelNote = computed/)
  assert.match(filmCreateSource, /function getStoryboardVideoModelNote\(sb\)/)
  assert.match(filmCreateSource, /model:\s*sbModel/)
})

test('FilmCreate 目录失败、空目录与旧失效选择不回退且阻止视频生成', () => {
  assert.match(filmCreateSource, /createFilmCreateModelCatalogLoader/)
  assert.match(filmCreateSource, /videoModelCatalogLoader\.forceRefresh\(\)/)
  assert.match(filmCreateSource, /function ensureVideoModelAvailable\(model/)
  assert.match(filmCreateSource, /模型目录加载失败/)
  assert.match(filmCreateSource, /当前没有公开可用的视频模型/)
  assert.match(filmCreateSource, /所选视频模型.*已失效/)
  assert.match(filmCreateSource, /if \(!selectedVideoModel\.value && videoModelOptions\.value\.length\)/)
  assert.doesNotMatch(filmCreateSource, /if \(!models\.includes\(selectedVideoModel\.value\)\)/)
  assert.match(filmCreateSource, /async function onGenerateSbVideo\(sb\)[\s\S]{0,400}await refreshVideoModelCatalogBeforeGeneration\(\)/)
  assert.match(filmCreateSource, /async function startBatchVideoGeneration\(\)[\s\S]{0,400}await refreshVideoModelCatalogBeforeGeneration\(\)/)
  assert.match(filmCreateSource, /async function startOneClickPipeline\(\)[\s\S]{0,400}await refreshVideoModelCatalogBeforeGeneration\(\)/)
  assert.match(filmCreateSource, /async function startRepairPipeline\(\)[\s\S]{0,400}await refreshVideoModelCatalogBeforeGeneration\(\)/)
  assert.match(filmCreateSource, /onMounted\(async \(\) => \{[\s\S]{0,300}await loadVideoModelOptions\(\)/)
})

test('视频模型交集仅保留 AI 配置和公开目录共有项及原始值元数据', () => {
  assert.equal(typeof intersectFilmCreateVideoModels, 'function')
  const options = intersectFilmCreateVideoModels(['A', 'B'], [
    { kind: 'image', model: 'A', label: '图片 A', note: '不应进入视频选项' },
    { kind: 'video', model: 'B', label: '公开视频 B', note: '管理员备注' },
  ])
  assert.deepEqual(options, [{ value: 'B', label: '公开视频 B', note: '管理员备注' }])
})

test('目录 loader 暴露 idle loading loaded 并合并并发请求', async () => {
  assert.equal(typeof createFilmCreateModelCatalogLoader, 'function')
  let calls = 0
  let resolveRequest
  const loader = createFilmCreateModelCatalogLoader(() => {
    calls += 1
    return new Promise((resolve) => { resolveRequest = resolve })
  })
  assert.equal(loader.snapshot().status, 'idle')
  const first = loader.load()
  const second = loader.load()
  assert.equal(loader.snapshot().status, 'loading')
  assert.strictEqual(first, second)
  assert.equal(calls, 1)
  resolveRequest([{ kind: 'video', model: 'B' }])
  await first
  assert.equal(loader.snapshot().status, 'loaded')
})

test('目录成功空响应保持 loaded 并明确阻断生成', async () => {
  assert.equal(typeof filmCreateVideoModelDecision, 'function')
  const loader = createFilmCreateModelCatalogLoader(async () => [])
  await loader.load()
  const state = loader.snapshot()
  assert.equal(state.status, 'loaded')
  assert.deepEqual(state.catalog, [])
  assert.deepEqual(
    filmCreateVideoModelDecision(state, [], 'B'),
    { ok: false, code: 'CATALOG_EMPTY', model: 'B' },
  )
})

test('目录失败进入 error 且下一次 load 会真实重试', async () => {
  let calls = 0
  const loader = createFilmCreateModelCatalogLoader(async () => {
    calls += 1
    if (calls === 1) throw new Error('catalog down')
    return [{ kind: 'video', model: 'B' }]
  })
  await assert.rejects(loader.load(), /catalog down/)
  const failedState = loader.snapshot()
  assert.equal(failedState.status, 'error')
  assert.deepEqual(
    filmCreateVideoModelDecision(failedState, [], 'B'),
    { ok: false, code: 'CATALOG_ERROR', model: 'B' },
  )
  await loader.load()
  assert.equal(calls, 2)
  assert.equal(loader.snapshot().status, 'loaded')
})

test('loaded 后 force refresh 删除旧模型会阻断旧页选择', async () => {
  let calls = 0
  const loader = createFilmCreateModelCatalogLoader(async () => {
    calls += 1
    return calls === 1
      ? [{ kind: 'video', model: 'B', label: '公开视频 B', note: '旧备注' }]
      : [{ kind: 'video', model: 'A', label: '公开视频 A', note: '新备注' }]
  })
  let catalog = await loader.load()
  let options = intersectFilmCreateVideoModels(['A', 'B'], catalog)
  assert.equal(filmCreateVideoModelDecision(loader.snapshot(), options, 'B').ok, true)

  catalog = await loader.forceRefresh()
  options = intersectFilmCreateVideoModels(['A', 'B'], catalog)
  assert.equal(calls, 2)
  assert.deepEqual(options, [{ value: 'A', label: '公开视频 A', note: '新备注' }])
  assert.deepEqual(
    filmCreateVideoModelDecision(loader.snapshot(), options, 'B'),
    { ok: false, code: 'MODEL_UNAVAILABLE', model: 'B' },
  )
})

test('其他普通用户模型选择器仍保留公开备注绑定', () => {
  const filmListSource = viewSource('../src/views/FilmList.vue')
  const freeCreateSource = viewSource('../src/views/FreeCreate.vue')
  const homeCanvasNodeSource = viewSource('../src/components/dramaCanvas/HomeCanvasNode.vue')

  assert.match(filmListSource, /homeSelectedModelNote/)
  assert.match(filmListSource, /home-model-note/)
  assert.match(freeCreateSource, /selectedModelNote/)
  assert.match(freeCreateSource, /model-public-note/)
  assert.match(homeCanvasNodeSource, /selectedModelNote/)
  assert.match(homeCanvasNodeSource, /model-public-note/)
})
