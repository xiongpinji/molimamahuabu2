import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function readView(name) {
  return readFileSync(fileURLToPath(new URL(`../src/views/${name}`, import.meta.url)), 'utf8')
}

const filmListSource = readView('FilmList.vue')
const routerSource = readFileSync(fileURLToPath(new URL('../src/router/index.js', import.meta.url)), 'utf8')
const dramaCanvasSource = readView('DramaCanvas.vue')
const platformHeaderSource = readFileSync(fileURLToPath(new URL('../src/components/PlatformHeader.vue', import.meta.url)), 'utf8')
const primaryNavSource = readFileSync(fileURLToPath(new URL('../src/components/PlatformPrimaryNav.vue', import.meta.url)), 'utf8')

test('项目列表以项目模式决定进入完整画布或流水线', () => {
  assert.doesNotMatch(filmListSource, /show-home-canvas="true"/)
  assert.doesNotMatch(filmListSource, /goHomeCanvas/)
  assert.match(filmListSource, /@click\.stop="openCanvas\(d\.id\)"/)
  assert.match(filmListSource, /projectOpenPath\(id, projectMode\.value\)/)
  assert.match(filmListSource, /projectCanvasPath\(id, projectMode\.value\)/)
  assert.match(filmListSource, /projectMetadata\(newForm\.value\.aspect_ratio, projectMode\.value\)/)
})

test('独立画布入口直接复用完整 DramaCanvas 并保留旧本地画布兼容入口', () => {
  const dramaCanvasImports = routerSource.match(/import\('@\/views\/DramaCanvas\.vue'\)/g) || []
  assert.equal(dramaCanvasImports.length, 2)
  assert.match(routerSource, /path: '\/canvas\/local'[\s\S]*name: 'home-canvas-local'[\s\S]*HomeCanvas\.vue/)
  assert.match(routerSource, /path: '\/canvas\/:id'[\s\S]*name: 'standalone-canvas'[\s\S]*DramaCanvas\.vue/)
  assert.match(routerSource, /path: '\/canvas'[\s\S]*name: 'canvas-projects'[\s\S]*FilmList\.vue/)
})

test('统一导航在项目页和完整画布页都暴露画布与短剧工厂入口', () => {
  assert.match(platformHeaderSource, /<PlatformPrimaryNav \/>/)
  assert.match(dramaCanvasSource, /<PlatformPrimaryNav \/>/)
  assert.match(primaryNavSource, /to="\/canvas"/)
  assert.match(primaryNavSource, /to="\/factory"/)
  assert.match(dramaCanvasSource, /v-if="!isStandaloneCanvas" mode="canvas"/)
})

test('普通页面的全局头部不再把独立自由画布作为主要入口', () => {
  for (const view of ['DramaDetail.vue', 'FilmCreate.vue', 'FreeCreate.vue', 'MediaLibrary.vue', 'AiConfig.vue', 'BillingAdmin.vue']) {
    assert.doesNotMatch(readView(view), /show-home-canvas="true"/, view)
  }
})

test('画布项目中心支持搜索和完整复制入口', () => {
  assert.match(filmListSource, /v-model="searchKeyword"/)
  assert.match(filmListSource, /keyword:\s*searchKeyword\.value\.trim\(\)/)
  assert.match(filmListSource, /dramaAPI\.duplicate\(d\.id\)/)
  assert.match(filmListSource, /aria-label="复制画布项目"/)
  assert.match(filmListSource, /duplicatingId === d\.id/)
})

test('画布项目中心支持文件夹筛选、排序和移动项目', () => {
  assert.match(filmListSource, /v-model="selectedFolderId"/)
  assert.match(filmListSource, /value="unfiled"/)
  assert.match(filmListSource, /v-model="projectSort"/)
  assert.match(filmListSource, /value="updated_desc"/)
  assert.match(filmListSource, /value="created_desc"/)
  assert.match(filmListSource, /value="title_asc"/)
  assert.match(filmListSource, /folder_id:\s*selectedFolderId\.value/)
  assert.match(filmListSource, /sort:\s*projectSort\.value/)
  assert.match(filmListSource, /dramaAPI\.update\(d\.id,\s*\{\s*folder_id:/)
  assert.match(filmListSource, /dramaAPI\.listFolders/)
  assert.match(filmListSource, /dramaAPI\.createFolder/)
  assert.match(filmListSource, /dramaAPI\.renameFolder/)
  assert.match(filmListSource, /dramaAPI\.deleteFolder/)
})
