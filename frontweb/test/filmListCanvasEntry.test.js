import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function readView(name) {
  return readFileSync(fileURLToPath(new URL(`../src/views/${name}`, import.meta.url)), 'utf8')
}

const filmListSource = readView('FilmList.vue')
const freeCreateSource = readView('FreeCreate.vue')
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

test('统一导航暴露首页、画布、剧本分析、短剧工厂与右上角登录入口', () => {
  assert.match(platformHeaderSource, /<PlatformPrimaryNav \/>/)
  assert.match(platformHeaderSource, /class="platform-header__account"/)
  assert.match(platformHeaderSource, /name: 'login'/)
  assert.match(platformHeaderSource, /router\.push\(\{ name: 'home-canvas-local' \}\)/)
  assert.match(dramaCanvasSource, /<PlatformPrimaryNav \/>/)
  assert.match(primaryNavSource, /to="\/"/)
  assert.match(primaryNavSource, />\s*首页\s*</)
  assert.match(primaryNavSource, /to="\/canvas"/)
  assert.match(primaryNavSource, /to="\/script-analysis"/)
  assert.match(primaryNavSource, />\s*剧本分析\s*</)
  assert.match(primaryNavSource, /to="\/factory"/)
  assert.match(dramaCanvasSource, /v-if="!isStandaloneCanvas" mode="canvas"/)
  assert.match(dramaCanvasSource, /\.header\.canvas-topbar[\s\S]*background:\s*#080808/)
  assert.match(dramaCanvasSource, /\.canvas-topbar[\s\S]*--el-button-text-color:\s*#f5f5f5/)
  assert.match(dramaCanvasSource, /html\.light \.drama-canvas-page \.header\.canvas-topbar[\s\S]*background:\s*#080808 !important/)
  assert.match(dramaCanvasSource, /html\.light \.drama-canvas-page \.canvas-topbar \.header-actions \.el-button[\s\S]*background:\s*#151515 !important/)
})

test('画布页顶部操作入口保持单行并按视口为浮动账户卡让位', () => {
  assert.match(
    platformHeaderSource,
    /\.platform-header__actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*flex-wrap:\s*nowrap;/,
  )
  assert.match(
    platformHeaderSource,
    /\.platform-header--account-badge \.platform-header__actions\s*\{[^}]*margin-right:\s*clamp\(0px,\s*calc\(1040px - 50vw\),\s*240px\);/,
  )
  assert.match(
    platformHeaderSource,
    /@media \(max-width:\s*1280px\)[\s\S]*?\.platform-header__button-label\s*\{\s*display:\s*none;/,
  )
})

test('首页提供紫黑工作台、快速生成器和真实最近项目入口', () => {
  assert.match(filmListSource, /class="home-workbench"/)
  assert.match(filmListSource, /你好，今天想生成点什么？/)
  assert.match(filmListSource, /class="home-composer"/)
  assert.match(filmListSource, /v-model="homePrompt"/)
  assert.match(filmListSource, /@click="startFromComposer"/)
  assert.match(filmListSource, /dramas\.slice\(0, 4\)/)
  assert.match(filmListSource, /@click="openProject\(d\.id\)"/)
  assert.match(filmListSource, /\.home-workbench[\s\S]*linear-gradient\(112deg/)
})

test('首页单次生成由后端模型目录驱动且一键进入真实生成', () => {
  assert.match(filmListSource, /listGenerationCatalog/)
  assert.match(filmListSource, /getCreditAccount/)
  assert.match(filmListSource, /v-model="homeModel"/)
  assert.match(filmListSource, /v-for="item in homeModelOptions"/)
  assert.match(filmListSource, /homeSelectedPrice/)
  assert.match(filmListSource, /<option value="text">文字<\/option>/)
  assert.match(filmListSource, /ref="homeReferenceInput"/)
  assert.match(filmListSource, /@change="onHomeReferenceChange"/)
  assert.match(filmListSource, /estimateGenerationCredits/)
  assert.match(filmListSource, /autoStart:\s*true/)
  assert.match(filmListSource, /referenceImageUrl:\s*homeMediaType\.value[\s\S]*homeReferenceImageUrl\.value/)
  assert.match(filmListSource, /sessionStorage\.setItem\('moli_quick_create_draft'/)
  assert.match(filmListSource, /name:\s*'free-create'/)
  const startFromComposer = filmListSource.match(/function startFromComposer\(\) \{[\s\S]*?\n\}/)?.[0] || ''
  assert.doesNotMatch(startFromComposer, /dramaAPI\.create/)
})

test('独立创作页承接文字、图片和视频真实生成且统一刷新积分', () => {
  assert.match(freeCreateSource, /name="text"/)
  assert.match(freeCreateSource, /name="image"/)
  assert.match(freeCreateSource, /name="video"/)
  assert.match(freeCreateSource, /buildQuickGenerationRequest/)
  assert.match(freeCreateSource, /request\.post\(requestSpec\.endpoint, requestSpec\.body\)/)
  assert.match(freeCreateSource, /imagesAPI\.create/)
  assert.match(freeCreateSource, /videosAPI\.create/)
  assert.match(freeCreateSource, /taskAPI\.get\(taskId\)/)
  assert.doesNotMatch(freeCreateSource, /imagesAPI\.getTask/)
  assert.match(freeCreateSource, /refreshCreditAccount/)
  assert.match(freeCreateSource, /estimateGenerationCredits/)
  assert.match(freeCreateSource, /draft\?\.autoStart/)
  assert.doesNotMatch(freeCreateSource, /dramaAPI\.create/)
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
