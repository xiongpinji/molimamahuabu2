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
  assert.match(mediaLibrarySource, /if \(\['image', 'video', 'audio'\]\.includes\(type\)\) mediaType\.value = type/)
  assert.match(mediaLibrarySource, /function isTargetAsset\(item\)/)
  assert.match(mediaLibrarySource, /targeted: isTargetAsset\(item\)/)
  assert.match(mediaLibrarySource, /画布结果定位/)
  assert.match(mediaLibrarySource, /watch\(\(\) => \[route\.query\.assetId, route\.query\.type\]/)
  assert.match(mediaLibrarySource, /applyRouteAssetFocus\(\)\s*\n\s*loadMedia\(\)/)
})

test('素材库页面支持音频素材上传、筛选、预览和复用为分镜音频', () => {
  assert.match(mediaLibrarySource, /accept="image\/\*,video\/\*,audio\/\*"/)
  assert.match(mediaLibrarySource, /<el-radio-button value="audio">音频<\/el-radio-button>/)
  assert.match(mediaLibrarySource, /await uploadAPI\.uploadMedia\(file\)/)
  assert.match(mediaLibrarySource, /item\.audio_url \|\| item\.voice_url/)
  assert.match(mediaLibrarySource, /const isAudio = url\.match\(\/\\\.\(mp3\|wav\|m4a\|aac\|ogg\|flac\)\$\/i\) \|\| item\.type === 'audio'/)
  assert.match(mediaLibrarySource, /type: isVideo \? 'video' : isAudio \? 'audio' : 'image'/)
  assert.match(mediaLibrarySource, /item\.audio_local_path \|\| item\.voice_local_path/)
  assert.match(mediaLibrarySource, /<div v-else-if="item\.type === 'audio'" class="thumb-audio">♪<\/div>/)
  assert.match(mediaLibrarySource, /<audio[\s\S]*previewItem\?\.type === 'audio'[\s\S]*class="preview-audio"/)
  assert.match(mediaLibrarySource, /<el-radio-button value="audio">分镜音频<\/el-radio-button>/)
  assert.match(mediaLibrarySource, /usePurpose\.value === 'reference' \|\| usePurpose\.value === 'attach' \|\| usePurpose\.value === 'audio'/)
  assert.match(mediaLibrarySource, /if \(usePurpose\.value === 'audio'\) return '复用为分镜音频'/)
  assert.match(mediaLibrarySource, /item\.type === 'video' \? 'attach' : item\.type === 'audio' \? 'audio' : 'reference'/)
  assert.match(mediaLibrarySource, /request\.put\(`\/storyboards\/\$\{useStoryboardId\.value\}`/)
  assert.match(mediaLibrarySource, /audio_local_path: localPath \|\| undefined/)
  assert.match(mediaLibrarySource, /audio_url: localPath \? undefined : itemUrl\(item\)/)
  assert.match(mediaLibrarySource, /已设为该分镜音频，可到画布查看/)
})

test('素材复用创建派生记录且提交期间拒绝重复点击，不迁移原素材', () => {
  assert.match(mediaLibrarySource, /import \{ buildAssetReusePayload \} from '@\/utils\/assetReuse'/)
  assert.match(mediaLibrarySource, /if \(useSubmitting\.value\) return/)
  assert.match(mediaLibrarySource, /reusedAsset = await assetsAPI\.create\(buildAssetReusePayload\(item, \{/)
  assert.doesNotMatch(mediaLibrarySource, /assetsAPI\.update\(item\.id/)
  assert.match(mediaLibrarySource, /request\.delete\(`\/assets\/\$\{reusedAsset\.id\}`/)
})

test('素材库将 Windows 和 static 本地路径规范化为可访问地址', () => {
  assert.match(mediaLibrarySource, /function staticAssetUrl\(localPath\)/)
  assert.ok(mediaLibrarySource.includes("replace(/\\\\/g, '/')"))
  assert.ok(mediaLibrarySource.includes("replace(/^\\/+/, '')"))
  assert.ok(mediaLibrarySource.includes("replace(/^static\\//, '')"))
  assert.match(mediaLibrarySource, /if \(lp\) return staticAssetUrl\(lp\)/)
})
