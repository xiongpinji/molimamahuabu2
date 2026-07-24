import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../src/components/AssetPickerDialog.vue', import.meta.url)), 'utf8')

test('素材选择弹窗按项目范围加载项目素材，并合并角色/场景/道具库图片', () => {
  assert.match(source, /assetsAPI\.list\(params, \{ silentError: true \}\)/)
  assert.match(source, /if \(props\.dramaId\) \{[\s\S]*params\.drama_id = props\.dramaId[\s\S]*params\.include_global = 1[\s\S]*\}/)
  assert.match(source, /params\.include_global = 1/)
  assert.match(source, /characterLibraryAPI\.list\(libraryParams, \{ silentError: true \}\)/)
  assert.match(source, /sceneLibraryAPI\.list\(libraryParams, \{ silentError: true \}\)/)
  assert.match(source, /propLibraryAPI\.list\(libraryParams, \{ silentError: true \}\)/)
})

test('素材选择弹窗使用场景库 location 作为真实场景素材名称', () => {
  assert.match(source, /name: it\.name \|\| it\.title \|\| it\.location \|\|/)
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

test('素材选择弹窗在全类型入口支持按图片视频音频筛选', () => {
  assert.match(source, /const typeFilter = ref\('all'\)/)
  assert.match(source, /v-if="type === 'all'"/)
  assert.match(source, /v-model="typeFilter"/)
  assert.match(source, /const typeOptions = computed\(\(\) => \[/)
  assert.match(source, /音频\/音色/)
  assert.match(source, /const matchesType = props\.type !== 'all' \|\| typeFilter\.value === 'all' \|\| item\.type === typeFilter\.value/)
  assert.match(source, /return matchesSource && matchesType/)
  assert.match(source, /typeFilter\.value = 'all'/)
  assert.match(source, /\.type-filter/)
})

test('素材选择弹窗显示素材挂载状态，避免复用时看不出目标用途', () => {
  assert.match(source, /class="status-badge"/)
  assert.match(source, /itemStatusText\(item\)/)
  assert.match(source, /itemStatusKind\(item\)/)
  assert.match(source, /function itemStoryboardId\(item\)/)
  assert.match(source, /metadata\?\.attached_storyboard_id/)
  assert.match(source, /return `已挂载分镜 #\$\{storyboardId\}`/)
  assert.match(source, /return '当前项目'/)
  assert.match(source, /return '全局素材'/)
  assert.match(source, /return item\.setup_hint \|\| '不可选'/)
  assert.match(source, /\.status-attached/)
  assert.match(source, /\.status-project/)
  assert.match(source, /\.status-global/)
  assert.match(source, /\.status-disabled/)
})

test('素材选择弹窗支持音频/音色素材选择与预览', () => {
  assert.match(source, /image \| video \| audio \| all/)
  assert.match(source, /import \{ characterAPI \} from '@\/api\/characters'/)
  assert.match(source, /const typeDisplayName = computed/)
  assert.match(source, /item\.type === 'audio'/)
  assert.match(source, /if \(props\.type === 'audio' \|\| wantsAll\)/)
  assert.match(source, /characterAPI\.listVoiceCatalog\(voiceParams, \{ silentError: true \}\)/)
  assert.match(source, /if \(keyword\.value\) voiceParams\.keyword = keyword\.value/)
  assert.match(source, /normalizeVoiceCatalogItems/)
  assert.match(source, /it\.available !== false \|\| it\.setup_hint/)
  assert.doesNotMatch(source, /can_bind !== false/)
  assert.match(source, /voice_catalog: '音色库'/)
  assert.match(source, /class="picker-thumb audio-thumb"/)
  assert.match(source, /<audio[\s\S]*previewItem\?\.type === 'audio'[\s\S]*controls/)
  assert.match(source, /audio_local_path/)
  assert.match(source, /voice_local_path/)
  assert.match(source, /mp3\|wav\|m4a\|aac\|ogg\|flac/)
  assert.match(source, /class="picker-quality-notice"/)
  assert.match(source, /\{\{ item\.quality_notice \}\}/)
  assert.match(source, /previewItem\?\.quality_notice/)
  assert.match(source, /quality_notice: it\.quality_notice \|\| it\.metadata\?\.voice_asset\?\.quality_notice \|\| ''/)
})

test('素材选择弹窗显示未就绪音色目录但禁用不可用音频操作', () => {
  assert.match(source, /<template v-if="item\.setup_hint"> · \{\{ item\.setup_hint \}\}<\/template>/)
  assert.match(source, /url: firstString\(it\.preview_url, it\.url, it\.audio_url, it\.voice_url\)/)
  assert.match(source, /local_path: firstString\(it\.local_path, it\.audio_local_path, it\.voice_local_path\)/)
  assert.match(source, /selectable: Boolean\(firstString\(it\.preview_url, it\.url, it\.audio_url, it\.voice_url, it\.local_path, it\.audio_local_path, it\.voice_local_path\)\)/)
  assert.match(source, /setup_hint: it\.setup_hint \|\| ''/)
  assert.match(source, /selectable: it\.selectable \?\? true/)
  assert.match(source, /:disabled="!itemUrl\(item\)"/)
  assert.match(source, /:disabled="!itemUrl\(item\) \|\| item\.selectable === false"/)
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
  assert.match(source, /it\.file_url/)
  assert.match(source, /it\.cover_url/)
  assert.match(source, /it\.poster_url/)
  assert.match(source, /item\.path/)
  assert.match(source, /item\.file_path/)
  assert.match(source, /item\.thumbnail_local_path/)
  assert.match(source, /display_url: displayUrl/)
  assert.match(source, /asset_url: displayUrl/)
  assert.match(source, /preview_url: displayUrl/)
  assert.match(source, /local_path: localPath/)
  assert.match(source, /voice_url: item\.type === 'audio' && \(item\.source_kind === 'voice_catalog' \|\| voiceCatalog\) \? displayUrl : item\.voice_url/)
  assert.match(source, /voice_local_path: item\.type === 'audio' && \(item\.source_kind === 'voice_catalog' \|\| voiceCatalog\) \? localPath : item\.voice_local_path/)
  assert.match(source, /category: item\.category \|\| \(item\.source_kind === 'voice_catalog' \|\| voiceCatalog \? 'voice' : ''\)/)
  assert.match(source, /reference_text: `@素材\(\$\{name\}#\$\{item\.raw_id \|\| item\.id\}\) \$\{displayUrl\}`\.trim\(\)/)
  assert.match(source, /picker_source: item\.source_kind \|\| 'library'/)
  assert.match(source, /picker_status: itemStatusText\(item\)/)
  assert.match(source, /picker_storyboard_id: itemStoryboardId\(item\) \|\| null/)
  assert.match(source, /const voiceCatalog = item\.metadata\?\.voice_catalog \|\| null/)
  assert.match(source, /voice_catalog: voiceCatalog/)
  assert.match(source, /voice_catalog_id: voiceCatalog\?\.id \|\| voiceCatalog\?\.voice_id \|\| null/)
  assert.match(source, /voice_asset_id: voiceCatalog\?\.asset_id \|\| null/)
  assert.match(source, /emit\('pick', normalizePickedAsset\(item\)\)/)
})

test('素材选择弹窗将本地 Windows 路径标准化为可访问静态地址', () => {
  assert.match(source, /function staticAssetUrl\(localPath\)/)
  assert.ok(source.includes("replace(/\\\\/g, '/')"))
  assert.ok(source.includes("replace(/^\\/+/, '')"))
  assert.ok(source.includes("replace(/^static\\//, '')"))
  assert.match(source, /return path \? `\/static\/\$\{path\}` : ''/)
  assert.match(source, /if \(lp\) return staticAssetUrl\(lp\)/)
})
