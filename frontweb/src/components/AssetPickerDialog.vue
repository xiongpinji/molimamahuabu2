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
    </div>
    <div v-loading="loading" class="picker-grid">
      <div
        v-for="item in items"
        :key="item.id"
        class="picker-card"
        @click="onPick(item)"
      >
        <video v-if="item.type === 'video'" :src="itemUrl(item)" class="picker-thumb" muted />
        <img v-else :src="itemUrl(item)" class="picker-thumb" />
        <div class="picker-name" :title="item.name">{{ item.name || '未命名' }}</div>
      </div>
      <div v-if="!loading && !items.length" class="picker-empty">素材库暂无可用{{ type === 'video' ? '视频' : '图片' }}</div>
    </div>
  </el-dialog>
</template>

<script setup>
import { ref, watch } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { assetsAPI } from '@/api/assets'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  type: { type: String, default: 'image' }, // image | video
  title: { type: String, default: '' },
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
let timer = null

function debouncedLoad() {
  clearTimeout(timer)
  timer = setTimeout(load, 350)
}

async function load() {
  loading.value = true
  try {
    const params = { page: 1, page_size: 100, type: props.type }
    if (keyword.value) params.keyword = keyword.value
    const res = await assetsAPI.list(params)
    items.value = (res?.items || []).map((it) => ({
      ...it,
      type: it.type || (String(it.url || '').match(/\.(mp4|webm|mov)$/i) ? 'video' : 'image'),
      name: it.name || String(it.url || '').split('/').pop(),
    }))
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

/** 展示/使用地址：优先本地持久路径，规避过期远程 URL */
function itemUrl(item) {
  if (!item) return ''
  const lp = item.local_path || item.image_local_path || item.video_local_path
  if (lp) return '/static/' + String(lp).replace(/^\/+/, '').replace(/^static\//, '')
  return item.url || ''
}

function onPick(item) {
  emit('pick', { ...item, display_url: itemUrl(item) })
  visible.value = false
}
</script>

<style scoped>
.picker-toolbar { margin-bottom: 12px; }
.picker-search { width: 260px; }
.picker-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
  max-height: 420px; overflow-y: auto; min-height: 120px;
}
.picker-card { cursor: pointer; border: 1px solid #3f3f46; border-radius: 8px; overflow: hidden; background: #18181b; transition: border-color .15s; }
.picker-card:hover { border-color: #8b5cf6; }
.picker-thumb { width: 100%; height: 96px; object-fit: cover; display: block; background: #09090b; }
.picker-name { font-size: 11px; color: #a1a1aa; padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.picker-empty { grid-column: 1 / -1; text-align: center; color: #71717a; padding: 40px 0; }
</style>
