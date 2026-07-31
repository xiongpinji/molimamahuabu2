import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const filmCreateSource = readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')
const dramaApiSource = readFileSync(new URL('../src/api/drama.js', import.meta.url), 'utf8')

test('分镜生成区提供当前集强制匹配场景角色物品按钮', () => {
  assert.match(filmCreateSource, /强制匹配场景\/角色\/物品/)
  assert.match(filmCreateSource, /:loading="storyboardAssetRematching"/)
  assert.match(filmCreateSource, /@click="onForceMatchStoryboardAssets"/)
})

test('强制匹配按钮调用当前集接口并刷新后端权威数据', () => {
  assert.match(
    dramaApiSource,
    /rematchStoryboardAssets\(episodeId\)[\s\S]*request\.post\(`\/episodes\/\$\{episodeId\}\/storyboards\/rematch-assets`/,
  )
  assert.match(
    filmCreateSource,
    /async function onForceMatchStoryboardAssets\(\)[\s\S]*dramaAPI\.rematchStoryboardAssets\(epId\)[\s\S]*await loadDrama\(\)/,
  )
})
