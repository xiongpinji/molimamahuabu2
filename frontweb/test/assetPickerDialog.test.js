import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../src/components/AssetPickerDialog.vue', import.meta.url)), 'utf8')

test('素材选择弹窗按项目范围加载项目素材，并合并角色/场景/道具库图片', () => {
  assert.match(source, /assetsAPI\.list\(params\)/)
  assert.match(source, /if \(props\.dramaId\) params\.drama_id = props\.dramaId/)
  assert.match(source, /characterLibraryAPI\.list\(libraryParams\)/)
  assert.match(source, /sceneLibraryAPI\.list\(libraryParams\)/)
  assert.match(source, /propLibraryAPI\.list\(libraryParams\)/)
})

test('素材选择弹窗暴露部分素材源加载失败，而不是静默吞掉 404', () => {
  assert.match(source, /const loadWarning = ref\(''\)/)
  assert.match(source, /Promise\.allSettled\(sources\.map\(\(source\) => source\.run\(\)\)\)/)
  assert.match(source, /failedSources\.join\('、'\).*加载失败，已显示其他可用素材/)
})

test('素材选择弹窗支持按素材来源筛选并显示可见数量', () => {
  assert.match(source, /const sourceFilter = ref\('all'\)/)
  assert.match(source, /const sourceOptions = computed\(\(\) => \{/)
  assert.match(source, /const visibleItems = computed\(\(\) =>/)
  assert.match(source, /v-for="item in visibleItems"/)
  assert.match(source, /显示 \$\{visibleItems\.length\}\/\$\{items\.length\} 个可用素材/)
})

test('素材选择弹窗支持音频/音色素材选择与预览', () => {
  assert.match(source, /image \| video \| audio/)
  assert.match(source, /const typeDisplayName = computed/)
  assert.match(source, /item\.type === 'audio'/)
  assert.match(source, /class="picker-thumb audio-thumb"/)
  assert.match(source, /<audio[\s\S]*previewItem\?\.type === 'audio'[\s\S]*controls/)
  assert.match(source, /audio_local_path/)
  assert.match(source, /voice_local_path/)
  assert.match(source, /mp3\|wav\|m4a\|aac\|ogg\|flac/)
})
