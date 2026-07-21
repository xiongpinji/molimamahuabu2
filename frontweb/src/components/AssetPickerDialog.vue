<template>
  <el-dialog
    v-model="visible"
    :title="title || `从素材库选择${type === 'video' ? '视频' : '图片'}`"
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
    />
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
        <button class="thumb-button" type="button" @click="openPreview(item)">
          <video v-if="item.type === 'video'" :src="itemUrl(item)" class="picker-thumb" muted preload="metadata" />
          <img v-else :src="itemUrl(item)" class="picker-thumb" />
          <span class="thumb-badge">{{ item.type === 'video' ? '视频' : '图片' }}</span>
        </button>
        <div class="picker-info">
          <div class="picker-name" :title="item.name">{{ item.name || '未命名' }}</div>
          <div class="picker-meta">
            <span v-if="item.source_label" class="source-badge">{{ item.source_label }}</span>
            <span>{{ formatSize(item.file_size || item.size) }}</span>
            <template v-if="item.duration"> · {{ formatDuration(item.duration) }}</template>
          </div>
        </div>
        <div class="picker-actions">
          <el-button size="small" text @click="openPreview(item)">预览</el-button>
          <el-button size="small" type="primary" :disabled="!itemUrl(item)" @click="onPick(item)">选用</el-button>
        </div>
      </div>
      <div v-if="!loading && !visibleItems.length" class="picker-empty">
        <div>素材库暂无可用{{ type === 'video' ? '视频' : '图片' }}</div>
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
        <img v-else-if="previewItem" :src="itemUrl(previewItem)" class="preview-media" />
      </div>
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
import { characterLibraryAPI } from '@/api/characterLibrary'
import { sceneLibraryAPI } from '@/api/sceneLibrary'
import { propLibraryAPI } from '@/api/propLibrary'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  type: { type: String, default: 'image' }, // image | video
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
const sourceFilter = ref('all')
const loadError = ref('')
const loadWarning = ref('')
const previewVisible = ref(false)
const previewItem = ref(null)
let timer = null

const typeLabel = computed(() => props.type === 'video' ? '视频素材' : '图片素材')
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
const visibleItems = computed(() => (
  sourceFilter.value === 'all'
    ? items.value
    : items.value.filter((item) => item.source_kind === sourceFilter.value)
))

watch(() => props.type, () => {
  sourceFilter.value = 'all'
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
    const params = { page: 1, page_size: 100, type: props.type }
    if (props.dramaId) params.drama_id = props.dramaId
    if (keyword.value) params.keyword = keyword.value
    const sources = [
      {
        label: '项目资产',
        run: () => assetsAPI.list(params).then((res) => normalizeAssetItems(res, 'project')),
      },
    ]
    if (props.type === 'image') {
      const libraryParams = { page: 1, page_size: 100 }
      if (keyword.value) libraryParams.keyword = keyword.value
      sources.push({
        label: '角色库',
        run: () => characterLibraryAPI.list(libraryParams).then((res) => normalizeAssetItems(res, 'character')),
      })
      sources.push({
        label: '场景库',
        run: () => sceneLibraryAPI.list(libraryParams).then((res) => normalizeAssetItems(res, 'scene')),
      })
      sources.push({
        label: '道具库',
        run: () => propLibraryAPI.list(libraryParams).then((res) => normalizeAssetItems(res, 'prop')),
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

function normalizeAssetItem(it, source) {
  const url = it.url || it.image_url || it.ref_image || ''
  const localPath = it.local_path || it.image_local_path || it.video_local_path || ''
  const itemType = it.type || (String(url || localPath).match(/\.(mp4|webm|mov)$/i) ? 'video' : 'image')
  return {
    ...it,
    id: `${source}:${it.id || url || localPath || it.name}`,
    raw_id: it.id,
    type: itemType,
    name: it.name || it.title || String(url || localPath).split('/').pop(),
    url,
    local_path: localPath,
    source_kind: source,
    source_label: sourceLabel(source),
  }
}

function sourceLabel(source) {
  return {
    project: '项目资产',
    character: '角色库',
    scene: '场景库',
    prop: '道具库',
  }[source] || '素材库'
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

/** 展示/使用地址：优先本地持久路径，规避过期远程 URL */
function itemUrl(item) {
  if (!item) return ''
  const lp = item.local_path || item.image_local_path || item.video_local_path
  if (lp) return '/static/' + String(lp).replace(/^\/+/, '').replace(/^static\//, '')
  return item.url || ''
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
  emit('pick', { ...item, display_url: itemUrl(item) })
  previewVisible.value = false
  visible.value = false
}
</script>

<style scoped>
.picker-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.picker-search { width: 240px; }
.source-filter { width: 116px; flex-shrink: 0; }
.picker-summary { display: flex; align-items: center; gap: 8px; color: #a1a1aa; font-size: 12px; flex: 1; }
.picker-alert { margin-bottom: 12px; }
.picker-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
  max-height: 420px; overflow-y: auto; min-height: 120px;
}
.picker-card { border: 1px solid #3f3f46; border-radius: 8px; overflow: hidden; background: #18181b; transition: border-color .15s; }
.picker-card:hover { border-color: #8b5cf6; }
.thumb-button { position: relative; display: block; width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.picker-thumb { width: 100%; height: 96px; object-fit: cover; display: block; background: #09090b; }
.thumb-badge { position: absolute; left: 6px; top: 6px; padding: 2px 6px; border-radius: 999px; background: rgba(0,0,0,.58); color: #fff; font-size: 11px; }
.picker-info { padding: 6px; }
.picker-name { font-size: 12px; color: #e4e4e7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.picker-meta { margin-top: 3px; font-size: 11px; color: #71717a; }
.source-badge { display: inline-block; margin-right: 5px; padding: 1px 5px; border-radius: 999px; background: rgba(139,92,246,.16); color: #c4b5fd; }
.picker-actions { display: flex; justify-content: flex-end; gap: 4px; padding: 0 6px 6px; }
.picker-empty { grid-column: 1 / -1; text-align: center; color: #71717a; padding: 40px 0; }
.preview-body { display: flex; justify-content: center; background: #09090b; border-radius: 8px; overflow: hidden; }
.preview-media { max-width: 100%; max-height: 520px; object-fit: contain; }
</style>
