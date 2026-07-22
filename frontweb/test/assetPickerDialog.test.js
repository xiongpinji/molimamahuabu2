import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../src/components/AssetPickerDialog.vue', import.meta.url)), 'utf8')

test('素材选择弹窗按项目范围加载项目素材，并合并角色/场景/道具库图片', () => {
  assert.match(source, /assetsAPI\.list\(params, \{ silentError: true \}\)/)
  assert.match(source, /if \(props\.dramaId\) params\.drama_id = props\.dramaId/)
  assert.match(source, /characterLibraryAPI\.list\(libraryParams, \{ silentError: true \}\)/)
  assert.match(source, /sceneLibraryAPI\.list\(libraryParams, \{ silentError: true \}\)/)
  assert.match(source, /propLibraryAPI\.list\(libraryParams, \{ silentError: true \}\)/)
})

test('素材选择弹窗暴露部分素材源加载失败，而不是静默吞掉 404', () => {
  assert.match(source, /const loadWarning = ref\(''\)/)
  assert.match(source, /Promise\.allSettled\(sources\.map\(\(source\) => source\.run\(\)\)\)/)
  assert.match(source, /failedSources\.join\('、'\).*加载失败，已显示其他可用素材/)
})

test('素材选择弹窗加载多来源素材时静默接口错误，避免全局 404 连续弹窗', () => {
  assert.match(source, /assetsAPI\.list\(params, \{ silentError: true \}\)/)
  assert.match(source, /characterLibraryAPI\.list\(libraryParams, \{ silentError: true \}\)/)
  assert.match(source, /sceneLibraryAPI\.list\(libraryParams, \{ silentError: true \}\)/)
  assert.match(source, /propLibraryAPI\.list\(libraryParams, \{ silentError: true \}\)/)
  assert.match(source, /characterAPI\.listVoiceCatalog\(voiceParams, \{ silentError: true \}\)/)
})

test('素材选择弹窗全量加载失败时提供重试入口', () => {
  assert.match(source, /v-if="loadError"/)
  assert.match(source, />重试加载</)
  assert.match(source, /class="picker-alert-action"/)
  assert.match(source, /@click="load"/)
})

test('素材选择弹窗支持按素材来源筛选并显示可见数量', () => {
  assert.match(source, /const sourceFilter = ref\('all'\)/)
  assert.match(source, /const sourceOptions = computed\(\(\) => \{/)
  assert.match(source, /const visibleItems = computed\(\(\) =>/)
  assert.match(source, /v-for="item in visibleItems"/)
  assert.match(source, /显示 \$\{visibleItems\.length\}\/\$\{items\.length\} 个可用素材/)
})

test('素材选择弹窗支持音频/音色素材选择与预览', () => {
  assert.match(source, /image \| video \| audio \| all/)
  assert.match(source, /import \{ characterAPI \} from '@\/api\/characters'/)
  assert.match(source, /const typeDisplayName = computed/)
  assert.match(source, /item\.type === 'audio'/)
  assert.match(source, /if \(props\.type === 'audio' \|\| wantsAll\)/)
  assert.match(source, /characterAPI\.listVoiceCatalog\(voiceParams, \{ silentError: true \}\)/)
  assert.match(source, /normalizeVoiceCatalogItems/)
  assert.match(source, /it\.available !== false && it\.can_bind !== false/)
  assert.match(source, /voice_catalog: '音色库'/)
  assert.match(source, /class="picker-thumb audio-thumb"/)
  assert.match(source, /<audio[\s\S]*previewItem\?\.type === 'audio'[\s\S]*controls/)
  assert.match(source, /audio_local_path/)
  assert.match(source, /voice_local_path/)
  assert.match(source, /mp3\|wav\|m4a\|aac\|ogg\|flac/)
})

test('素材选择弹窗支持全类型素材入口', () => {
  assert.match(source, /const wantsAll = props\.type === 'all'/)
  assert.match(source, /if \(!wantsAll\) params\.type = props\.type/)
  assert.match(source, /if \(props\.type === 'image' \|\| wantsAll\)/)
  assert.match(source, /if \(props\.type === 'audio' \|\| wantsAll\)/)
  assert.match(source, /all: '素材'/)
})

test('素材选择弹窗选中素材时输出统一复用字段', () => {
  assert.match(source, /function normalizePickedAsset\(item\)/)
  assert.match(source, /function firstString\(\.\.\.values\)/)
  assert.match(source, /it\.asset_url/)
  assert.match(source, /it\.display_url/)
  assert.match(source, /it\.preview_url/)
  assert.match(source, /it\.video_url/)
  assert.match(source, /it\.thumbnail_url/)
  assert.match(source, /item\.path/)
  assert.match(source, /display_url: displayUrl/)
  assert.match(source, /asset_url: displayUrl/)
  assert.match(source, /preview_url: displayUrl/)
  assert.match(source, /local_path: localPath/)
  assert.match(source, /reference_text: `@素材\(\$\{name\}#\$\{item\.raw_id \|\| item\.id\}\) \$\{displayUrl\}`\.trim\(\)/)
  assert.match(source, /picker_source: item\.source_kind \|\| 'library'/)
  assert.match(source, /emit\('pick', normalizePickedAsset\(item\)\)/)
})
