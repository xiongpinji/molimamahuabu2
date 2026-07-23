<template>
  <el-dialog
    v-model="visible"
    :title="title || `从素材库选择${typeDisplayName}`"
    width="760px"
    destroy-on-close
    append-to-body
  >
    <div class="picker-toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索素材名称..."
        clearable
        class="picker-search"
        @input="debouncedLoad"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select
        v-if="type === 'all'"
        v-model="typeFilter"
        size="small"
        class="type-filter"
        placeholder="素材类型"
      >
        <el-option
          v-for="option in typeOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <el-select
        v-model="sourceFilter"
        size="small"
        class="source-filter"
        placeholder="素材来源"
      >
        <el-option
          v-for="option in sourceOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <div class="picker-summary">
        <el-tag size="small" effect="plain">{{ typeLabel }}</el-tag>
        <span>{{ loading ? '加载中…' : `显示 ${visibleItems.length}/${items.length} 个可用素材` }}</span>
      </div>
      <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      class="picker-alert"
    >
      <el-button size="small" text class="picker-alert-action" :loading="loading" @click="load">重试加载</el-button>
    </el-alert>
    <el-alert
      v-if="loadWarning"
      :title="loadWarning"
      type="warning"
      show-icon
      :closable="false"
      class="picker-alert"
    />
    <div v-loading="loading" class="picker-grid">
      <div
        v-for="item in visibleItems"
        :key="item.id"
        class="picker-card"
      >
        <button class="thumb-button" type="button" :disabled="!itemUrl(item)" @click="openPreview(item)">
          <video v-if="item.type === 'video'" :src="itemUrl(item)" class="picker-thumb" muted preload="metadata" />
          <div v-else-if="item.type === 'audio'" class="picker-thumb audio-thumb">♪</div>
          <img v-else :src="itemUrl(item)" class="picker-thumb" />
          <span class="thumb-badge">{{ itemTypeName(item) }}</span>
        </button>
        <div class="picker-info">
          <div class="picker-name" :title="item.name">{{ item.name || '未命名' }}</div>
          <div class="picker-meta">
            <span v-if="item.source_label" class="source-badge">{{ item.source_label }}</span>
            <span v-if="itemStatusText(item)" class="status-badge" :class="`status-${itemStatusKind(item)}`">{{ itemStatusText(item) }}</span>
            <span>{{ formatSize(item.file_size || item.size) }}</span>
            <template v-if="item.duration"> · {{ formatDuration(item.duration) }}</template>
            <template v-if="item.setup_hint"> · {{ item.setup_hint }}</template>
          </div>
          <div v-if="item.quality_notice" class="picker-quality-notice" :title="item.quality_notice">
            {{ item.quality_notice }}
          </div>
        </div>
        <div class="picker-actions">
          <el-button size="small" text :disabled="!itemUrl(item)" @click="openPreview(item)">预览</el-button>
          <el-button size="small" type="primary" :disabled="!itemUrl(item) || item.selectable === false" @click="onPick(item)">选用</el-button>
        </div>
      </div>
      <div v-if="!loading && !visibleItems.length" class="picker-empty">
        <div>素材库暂无可用{{ typeDisplayName }}</div>
        <el-button size="small" text @click="load">重新加载</el-button>
      </div>
    </div>

    <el-dialog
      v-model="previewVisible"
      :title="previewItem?.name || '素材预览'"
      width="720px"
      append-to-body
      destroy-on-close
    >
      <div class="preview-body">
        <video
          v-if="previewItem?.type === 'video'"
          :src="itemUrl(previewItem)"
          class="preview-media"
          controls
          autoplay
        />
        <audio
          v-else-if="previewItem?.type === 'audio'"
          :src="itemUrl(previewItem)"
          class="preview-audio"
          controls
        />
        <img v-else-if="previewItem" :src="itemUrl(previewItem)" class="preview-media" />
      </div>
      <el-alert
        v-if="previewItem?.quality_notice"
        :title="previewItem.quality_notice"
        type="warning"
        show-icon
        :closable="false"
        class="preview-quality-notice"
      />
      <template #footer>
        <el-button @click="previewVisible = false">关闭</el-button>
        <el-button type="primary" :disabled="!itemUrl(previewItem)" @click="onPick(previewItem)">选用此素材</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { Refresh, Search } from '@element-plus/icons-vue'
import { assetsAPI } from '@/api/assets'
import { characterAPI } from '@/api/characters'
import { characterLibraryAPI } from '@/api/characterLibrary'
import { sceneLibraryAPI } from '@/api/sceneLibrary'
import { propLibraryAPI } from '@/api/propLibrary'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  type: { type: String, default: 'image' }, // image | video | audio | all
  title: { type: String, default: '' },
  dramaId: { type: [Number, String], default: '' },
})
const emit = defineEmits(['update:modelValue', 'pick'])

const visible = ref(props.modelValue)
watch(() => props.modelValue, (v) => {
  visible.value = v
  if (v) load()
})
watch(visible, (v) => emit('update:modelValue', v))

const loading = ref(false)
const items = ref([])
const keyword = ref('')
const typeFilter = ref('all')
const sourceFilter = ref('all')
const loadError = ref('')
const loadWarning = ref('')
const previewVisible = ref(false)
const previewItem = ref(null)
let timer = null

const typeDisplayName = computed(() => itemTypeName({ type: props.type }))
const typeLabel = computed(() => `${typeDisplayName.value}素材`)
const sourceOptions = computed(() => {
  const options = [{ label: '全部来源', value: 'all' }]
  const seen = new Set()
  for (const item of items.value) {
    const value = item.source_kind || 'library'
    if (seen.has(value)) continue
    seen.add(value)
    options.push({ label: item.source_label || sourceLabel(value), value })
  }
  return options
})
const typeOptions = computed(() => [
  { label: '全部类型', value: 'all' },
  { label: '图片', value: 'image' },
  { label: '视频', value: 'video' },
  { label: '音频/音色', value: 'audio' },
])
const visibleItems = computed(() => (
  items.value.filter((item) => {
    const matchesSource = sourceFilter.value === 'all' || item.source_kind === sourceFilter.value
    const matchesType = props.type !== 'all' || typeFilter.value === 'all' || item.type === typeFilter.value
    return matchesSource && matchesType
  })
))

watch(() => props.type, () => {
  sourceFilter.value = 'all'
  typeFilter.value = 'all'
})

function debouncedLoad() {
  clearTimeout(timer)
  timer = setTimeout(load, 350)
}

async function load() {
  loading.value = true
  loadError.value = ''
    loadWarning.value = ''
  try {
    const wantsAll = props.type === 'all'
    const params = { page: 1, page_size: 100 }
    if (!wantsAll) params.type = props.type
    if (props.dramaId) {
      params.drama_id = props.dramaId
      params.include_global = 1
    }
    if (keyword.value) params.keyword = keyword.value
    const sources = [
      {
        label: '项目资产',
        run: () => assetsAPI.list(params, { silentError: true }).then((res) => normalizeAssetItems(res, 'project')),
      },
    ]
    if (props.type === 'image' || wantsAll) {
      const libraryParams = { page: 1, page_size: 100 }
      if (keyword.value) libraryParams.keyword = keyword.value
      sources.push({
        label: '角色库',
        run: () => characterLibraryAPI.list(libraryParams, { silentError: true }).then((res) => normalizeAssetItems(res, 'character')),
      })
      sources.push({
        label: '场景库',
        run: () => sceneLibraryAPI.list(libraryParams, { silentError: true }).then((res) => normalizeAssetItems(res, 'scene')),
      })
      sources.push({
        label: '道具库',
        run: () => propLibraryAPI.list(libraryParams, { silentError: true }).then((res) => normalizeAssetItems(res, 'prop')),
      })
    }
    if (props.type === 'audio' || wantsAll) {
      const voiceParams = {}
      if (props.dramaId) voiceParams.drama_id = props.dramaId
      if (keyword.value) voiceParams.keyword = keyword.value
      sources.push({
        label: '音色库',
        run: () => characterAPI.listVoiceCatalog(voiceParams, { silentError: true }).then(normalizeVoiceCatalogItems),
      })
    }
    const results = await Promise.allSettled(sources.map((source) => source.run()))
    const loadedItems = results
      .filter((res) => res.status === 'fulfilled')
      .flatMap((res) => res.value)
    items.value = dedupeItems(loadedItems)
    if (!sourceOptions.value.some((option) => option.value === sourceFilter.value)) {
      sourceFilter.value = 'all'
    }
    const failedSources = results
      .map((res, index) => res.status === 'rejected' ? sources[index].label : '')
      .filter(Boolean)
    if (failedSources.length && items.value.length) {
      loadWarning.value = `${failedSources.join('、')}加载失败，已显示其他可用素材`
    }
    if (!items.value.length && failedSources.length) {
      const firstError = results.find((res) => res.status === 'rejected')?.reason
      loadError.value = `${failedSources.join('、')}加载失败：${firstError?.message || '素材库加载失败'}`
    }
  } catch (e) {
    items.value = []
    loadError.value = e?.message || '素材库加载失败'
    loadWarning.value = ''
  } finally {
    loading.value = false
  }
}

function resultItems(res) {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.items)) return res.items
  if (Array.isArray(res?.data)) return res.data
  if (Array.isArray(res?.data?.items)) return res.data.items
  return []
}

function normalizeAssetItems(res, source) {
  return resultItems(res).map((it) => normalizeAssetItem(it, source)).filter((it) => itemUrl(it))
}

function normalizeVoiceCatalogItems(res) {
  return resultItems(res)
    .filter((it) => it.available !== false || it.setup_hint)
    .map((it) => normalizeAssetItem({
      ...it,
      id: it.asset_id || it.id || it.voice_id,
      name: it.label || it.name || it.voice_id,
      type: 'audio',
      url: firstString(it.preview_url, it.url, it.audio_url, it.voice_url),
      audio_url: firstString(it.preview_url, it.url, it.audio_url, it.voice_url),
      local_path: firstString(it.local_path, it.audio_local_path, it.voice_local_path),
      selectable: Boolean(firstString(it.preview_url, it.url, it.audio_url, it.voice_url, it.local_path, it.audio_local_path, it.voice_local_path)),
      metadata: {
        ...(it.metadata || {}),
        voice_catalog: it,
      },
    }, 'voice_catalog'))
}

function normalizeAssetItem(it, source) {
  const url = firstString(
    it.url,
    it.asset_url,
    it.display_url,
    it.preview_url,
    it.image_url,
    it.video_url,
    it.ref_image,
    it.audio_url,
    it.voice_url,
    it.thumbnail_url,
    it.file_url,
    it.cover_url,
    it.poster_url,
  )
  const localPath = firstString(
    it.local_path,
    it.path,
    it.file_path,
    it.image_local_path,
    it.video_local_path,
    it.audio_local_path,
    it.voice_local_path,
    it.thumbnail_local_path,
  )
  const itemType = it.type || inferAssetType(url || localPath)
  return {
    ...it,
    id: `${source}:${it.id || url || localPath || it.name}`,
    raw_id: it.id,
    type: itemType,
    name: it.name || it.title || it.location || String(url || localPath).split('/').pop(),
    url,
    local_path: localPath,
    setup_hint: it.setup_hint || '',
    quality_notice: it.quality_notice || it.metadata?.voice_asset?.quality_notice || '',
    selectable: it.selectable ?? true,
    drama_id: it.drama_id || it.metadata?.drama_id || '',
    storyboard_id: it.storyboard_id || it.metadata?.storyboard_id || it.metadata?.attached_storyboard_id || '',
    source_kind: source,
    source_label: sourceLabel(source),
  }
}

function inferAssetType(value) {
  const target = String(value || '')
  if (target.match(/\.(mp4|webm|mov)$/i)) return 'video'
  if (target.match(/\.(mp3|wav|m4a|aac|ogg|flac)$/i)) return 'audio'
  return 'image'
}

function itemTypeName(item) {
  return {
    all: '素材',
    video: '视频',
    audio: '音频',
    image: '图片',
  }[item?.type] || '图片'
}

function sourceLabel(source) {
  return {
    project: '项目资产',
    character: '角色库',
    scene: '场景库',
    prop: '道具库',
    voice_catalog: '音色库',
  }[source] || '素材库'
}

function itemStoryboardId(item) {
  return Number(item?.storyboard_id || item?.metadata?.storyboard_id || item?.metadata?.attached_storyboard_id || 0) || 0
}

function itemStatusKind(item) {
  if (item?.selectable === false) return 'disabled'
  if (itemStoryboardId(item)) return 'attached'
  if (item?.source_kind === 'project' && item?.drama_id) return 'project'
  if (item?.source_kind === 'project') return 'global'
  return 'library'
}

function itemStatusText(item) {
  if (!item) return ''
  if (item.selectable === false) return item.setup_hint || '不可选'
  const storyboardId = itemStoryboardId(item)
  if (storyboardId) return `已挂载分镜 #${storyboardId}`
  if (item.source_kind === 'project' && item.drama_id) return '当前项目'
  if (item.source_kind === 'project') return '全局素材'
  return ''
}

function dedupeItems(list) {
  const seen = new Set()
  return list.filter((item) => {
    const key = itemUrl(item) || item.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

function staticAssetUrl(localPath) {
  const path = String(localPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^static\//, '')
  return path ? `/static/${path}` : ''
}

/** 展示/使用地址：优先本地持久路径，规避过期远程 URL */
function itemUrl(item) {
  if (!item) return ''
  const lp = firstString(
    item.local_path,
    item.path,
    item.file_path,
    item.image_local_path,
    item.video_local_path,
    item.audio_local_path,
    item.voice_local_path,
    item.thumbnail_local_path,
  )
  if (lp) return staticAssetUrl(lp)
  return firstString(
    item.url,
    item.asset_url,
    item.display_url,
    item.preview_url,
    item.image_url,
    item.video_url,
    item.audio_url,
    item.voice_url,
    item.thumbnail_url,
    item.file_url,
    item.cover_url,
    item.poster_url,
  )
}

function normalizePickedAsset(item) {
  const displayUrl = itemUrl(item)
  const localPath = firstString(
    item.local_path,
    item.path,
    item.file_path,
    item.image_local_path,
    item.video_local_path,
    item.audio_local_path,
    item.voice_local_path,
    item.thumbnail_local_path,
  )
  const name = item.name || item.title || item.filename || '素材'
  const voiceCatalog = item.metadata?.voice_catalog || null
  return {
    ...item,
    name,
    display_url: displayUrl,
    asset_url: displayUrl,
    preview_url: displayUrl,
    local_path: localPath,
    voice_url: item.type === 'audio' && (item.source_kind === 'voice_catalog' || voiceCatalog) ? displayUrl : item.voice_url,
    voice_local_path: item.type === 'audio' && (item.source_kind === 'voice_catalog' || voiceCatalog) ? localPath : item.voice_local_path,
    category: item.category || (item.source_kind === 'voice_catalog' || voiceCatalog ? 'voice' : ''),
    reference_text: `@素材(${name}#${item.raw_id || item.id}) ${displayUrl}`.trim(),
    picker_source: item.source_kind || 'library',
    picker_status: itemStatusText(item),
    picker_storyboard_id: itemStoryboardId(item) || null,
    voice_catalog: voiceCatalog,
    voice_catalog_id: voiceCatalog?.id || voiceCatalog?.voice_id || null,
    voice_asset_id: voiceCatalog?.asset_id || null,
  }
}

function formatSize(size) {
  const n = Number(size) || 0
  if (!n) return '未知大小'
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function formatDuration(duration) {
  const seconds = Math.max(0, Math.round(Number(duration) || 0))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function openPreview(item) {
  previewItem.value = item
  previewVisible.value = true
}

function onPick(item) {
  if (!item) return
  emit('pick', normalizePickedAsset(item))
  previewVisible.value = false
  visible.value = false
}
</script>

<style scoped>
.picker-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.picker-search { width: 240px; }
.source-filter,
.type-filter { width: 116px; flex-shrink: 0; }
.picker-summary { display: flex; align-items: center; gap: 8px; color: #a1a1aa; font-size: 12px; flex: 1; }
.picker-alert { margin-bottom: 12px; }
.picker-alert-action { margin-left: 8px; }
.picker-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
  max-height: 420px; overflow-y: auto; min-height: 120px;
}
.picker-card { border: 1px solid #3f3f46; border-radius: 8px; overflow: hidden; background: #18181b; transition: border-color .15s; }
.picker-card:hover { border-color: #8b5cf6; }
.thumb-button { position: relative; display: block; width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.picker-thumb { width: 100%; height: 96px; object-fit: cover; display: block; background: #09090b; }
.audio-thumb { display: flex; align-items: center; justify-content: center; color: #c4b5fd; font-size: 34px; }
.thumb-badge { position: absolute; left: 6px; top: 6px; padding: 2px 6px; border-radius: 999px; background: rgba(0,0,0,.58); color: #fff; font-size: 11px; }
.picker-info { padding: 6px; }
.picker-name { font-size: 12px; color: #e4e4e7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.picker-meta { margin-top: 3px; font-size: 11px; color: #71717a; }
.picker-quality-notice { margin-top: 4px; overflow: hidden; color: #fbbf24; font-size: 11px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.source-badge { display: inline-block; margin-right: 5px; padding: 1px 5px; border-radius: 999px; background: rgba(139,92,246,.16); color: #c4b5fd; }
.status-badge { display: inline-block; margin-right: 5px; padding: 1px 5px; border-radius: 999px; background: rgba(39,39,42,.82); color: #d4d4d8; }
.status-attached { background: rgba(34,197,94,.16); color: #86efac; }
.status-project { background: rgba(59,130,246,.16); color: #93c5fd; }
.status-global { background: rgba(245,158,11,.16); color: #fcd34d; }
.status-disabled { background: rgba(239,68,68,.16); color: #fca5a5; }
.picker-actions { display: flex; justify-content: flex-end; gap: 4px; padding: 0 6px 6px; }
.picker-empty { grid-column: 1 / -1; text-align: center; color: #71717a; padding: 40px 0; }
.preview-body { display: flex; justify-content: center; background: #09090b; border-radius: 8px; overflow: hidden; }
.preview-media { max-width: 100%; max-height: 520px; object-fit: contain; }
.preview-audio { width: 100%; margin: 40px 24px; }
.preview-quality-notice { margin-top: 10px; }
</style>
