import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

test('首页和自由创作从统一画布目录读取管理员展示信息与图片档位', () => {
  const home = read('src/views/FilmList.vue')
  const freeCreate = read('src/views/FreeCreate.vue')
  for (const source of [home, freeCreate]) {
    assert.match(source, /\/canvas\/model-catalog/)
    assert.match(source, /publicNote/)
    assert.match(source, /quickGenerationResolutions/)
    assert.match(source, /quantity/)
  }
})

test('独立画布和项目画布共享目录元数据、能力和分档积分合同', () => {
  const homeCanvas = read('src/views/HomeCanvas.vue')
  const dramaCanvas = read('src/views/DramaCanvas.vue')
  const node = read('src/components/dramaCanvas/HomeCanvasNode.vue')
  assert.match(homeCanvas, /\/canvas\/model-catalog/)
  assert.match(homeCanvas, /getFreeNodeModelMetadata/)
  assert.match(dramaCanvas, /getFreeNodeModelMetadata/)
  assert.match(dramaCanvas, /const catalogOptions = canvasModelOptions\(freeCanvasModelCatalog\.value, kind, \{ referenceCount \}\)/)
  assert.match(dramaCanvas, /return catalogOptions/)
  assert.doesNotMatch(dramaCanvas, /filterCanvasCatalogFallbackModels/)
  assert.match(node, /currentModelMetadata/)
  assert.match(node, /publicNote/)
  assert.match(node, /canvas-credit-callout-v1/)
})
