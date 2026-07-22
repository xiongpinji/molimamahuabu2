import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const mediaLibrarySource = readFileSync(fileURLToPath(new URL('../src/views/MediaLibrary.vue', import.meta.url)), 'utf8')

test('素材库消费画布结果跳转参数并高亮目标素材', () => {
  assert.match(mediaLibrarySource, /import \{ useRoute \} from 'vue-router'/)
  assert.match(mediaLibrarySource, /const route = useRoute\(\)/)
  assert.match(mediaLibrarySource, /const highlightedAssetId = ref\(null\)/)
  assert.match(mediaLibrarySource, /function applyRouteAssetFocus\(\)/)
  assert.match(mediaLibrarySource, /Number\(route\.query\.assetId\)/)
  assert.match(mediaLibrarySource, /if \(\['image', 'video'(, 'audio')?\]\.includes\(type\)\) mediaType\.value = type/)
  assert.match(mediaLibrarySource, /function isTargetAsset\(item\)/)
  assert.match(mediaLibrarySource, /targeted: isTargetAsset\(item\)/)
  assert.match(mediaLibrarySource, /画布结果定位/)
  assert.match(mediaLibrarySource, /watch\(\(\) => \[route\.query\.assetId, route\.query\.type\]/)
  assert.match(mediaLibrarySource, /applyRouteAssetFocus\(\)\s*\n\s*loadMedia\(\)/)
})
