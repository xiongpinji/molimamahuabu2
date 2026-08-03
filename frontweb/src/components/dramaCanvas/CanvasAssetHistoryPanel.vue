<template>
  <section
    class="asset-history-panel"
    :class="[`mode-${mode}`, { 'has-detail': detailItem }]"
  >
    <header v-if="mode === 'assets'" class="panel-header assets-header">
      <div class="asset-primary-row">
        <div class="asset-title-tabs">
          <h2>资产库</h2>
          <nav class="panel-tabs" aria-label="资产来源">
            <button
              v-for="option in assetTabs"
              :key="option.value"
              type="button"
              :class="{ active: activeTab === option.value }"
              @click="activeTab = option.value"
            >
              {{ option.label }}
              <span v-if="option.external" class="external-badge">外部</span>
            </button>
          </nav>
        </div>

        <div class="toolbar-actions">
          <div class="segmented-control">
            <button
              v-for="option in groupOptions"
              :key="option.value"
              :class="{ active: groupMode === option.value }"
              type="button"
              @click="groupMode = option.value"
            >
              {{ option.label }}
            </button>
          </div>
          <button class="round-control active" type="button" title="网格视图" @click="viewMode = 'grid'">
            <el-icon><Grid /></el-icon>
          </button>
          <div class="asset-size-control" title="缩略图大小">
            <el-slider v-model="cardWidth" :min="104" :max="224" :step="8" :show-tooltip="false" />
          </div>
          <span class="toolbar-divider" />
          <el-switch v-model="realtimePreview" size="small" active-text="实时预览" />
          <span class="toolbar-divider" />
          <button
            class="batch-control"
            :class="{ active: batchMode }"
            type="button"
            @click="toggleBatchMode"
          >
            <el-icon><Select /></el-icon>
            批量选择
          </button>
          <button class="close-control" type="button" title="关闭" @click="emit('close')">
            <el-icon><Close /></el-icon>
          </button>
        </div>
      </div>

      <div class="asset-filter-row">
        <button class="canvas-scope-control" type="button">
          全部画布
          <span aria-hidden="true">⌄</span>
        </button>
        <div v-if="activeTab === 'library'" class="filter-group category-filter">
          <button
            v-for="option in categoryOptions"
            :key="option.value"
            class="filter-chip"
            :class="{ active: categoryFilter === option.value }"
            type="button"
            @click="categoryFilter = option.value"
          >
            {{ option.label }}
          </button>
        </div>
        <div class="filter-group type-filter">
          <button
            v-for="option in visibleTypeOptions"
            :key="option.value"
            class="filter-chip"
            :class="{ active: typeFilter === option.value }"
            type="button"
            @click="typeFilter = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </header>

    <header v-else class="panel-header history-header">
      <div class="history-primary-row">
        <div class="filter-group history-type-filter">
          <button
            v-for="option in visibleTypeOptions"
            :key="option.value"
            class="filter-chip"
            :class="{ active: typeFilter === option.value }"
            type="button"
            @click="typeFilter = option.value"
          >
            {{ option.label }}
          </button>
        </div>

        <div class="toolbar-actions">
          <div class="segmented-control">
            <button
              v-for="option in groupOptions"
              :key="option.value"
              :class="{ active: groupMode === option.value }"
              type="button"
              @click="groupMode = option.value"
            >
              {{ option.label }}
            </button>
          </div>

          <el-popover
            placement="bottom"
            :width="280"
            trigger="click"
            popper-class="canvas-history-popper"
          >
            <template #reference>
              <button class="round-control" :class="{ active: tagFilter !== 'all' }" type="button" title="标签">
                <el-icon><PriceTag /></el-icon>
              </button>
            </template>
            <div class="tag-popover">
              <strong>按标签筛选</strong>
              <small>点击标签筛选素材</small>
              <button
                class="tag-choice"
                :class="{ active: tagFilter === 'all' }"
                type="button"
                @click="tagFilter = 'all'"
              >
                全部标签
              </button>
              <button
                v-for="tag in tags"
                :key="tag"
                class="tag-choice"
                :class="{ active: tagFilter === tag }"
                type="button"
                @click="tagFilter = tag"
              >
                {{ tag }}
              </button>
              <span v-if="!tags.length" class="tag-empty">暂无标签，在下方新建</span>
              <div class="new-tag-row">
                <el-input v-model="newTag" size="small" maxlength="20" placeholder="新建标签" @keyup.enter="createTag" />
                <el-button size="small" :disabled="!newTag.trim()" @click="createTag">添加</el-button>
              </div>
            </div>
          </el-popover>

          <el-select v-model="cardRatio" class="ratio-select" title="卡片比例">
            <el-option v-for="ratio in ratioOptions" :key="ratio" :label="ratio" :value="ratio" />
          </el-select>
          <el-select v-model="cardSize" class="card-size-select" title="卡片大小">
            <el-option label="小" value="small" />
            <el-option label="中" value="medium" />
            <el-option label="大" value="large" />
          </el-select>
          <button
            class="round-control"
            :class="{ active: viewMode === 'grid' }"
            type="button"
            title="网格"
            @click="viewMode = 'grid'"
          >
            <el-icon><Grid /></el-icon>
          </button>
          <button
            class="round-control"
            :class="{ active: viewMode === 'list' }"
            type="button"
            title="列表"
            @click="viewMode = 'list'"
          >
            <el-icon><List /></el-icon>
          </button>
          <button
            class="round-control"
            :class="{ active: batchMode }"
            type="button"
            title="批量选择"
            @click="toggleBatchMode"
          >
            <el-icon><Select /></el-icon>
          </button>
          <el-select v-model="scope" class="scope-select" title="资产范围">
            <el-option label="当前画布" value="canvas" />
            <el-option label="个人画布" value="project" />
          </el-select>
          <button class="close-control" type="button" title="关闭" @click="emit('close')">
            <el-icon><Close /></el-icon>
          </button>
        </div>
      </div>
    </header>

    <main v-loading="loading" class="panel-content">
      <el-alert
        v-if="loadError"
        class="load-alert"
        type="warning"
        :title="loadError"
        :closable="false"
        show-icon
      />

      <template v-if="groups.length">
        <section v-for="group in groups" :key="group.key" class="media-group">
          <header v-if="group.label" class="group-heading">
            <strong>{{ group.label }}</strong>
            <span>{{ group.items.length }} 项</span>
          </header>

          <div
            class="media-collection"
            :class="viewMode"
            :style="viewMode === 'grid' ? { '--card-width': `${cardWidth}px` } : null"
          >
            <article
              v-for="item in group.items"
              :key="item.key"
              class="media-card"
              :class="{ selected: selectedKeys.includes(item.key) }"
              @click="onItemClick(item)"
            >
              <div class="media-preview" :style="{ aspectRatio: cssRatio }">
                <video
                  v-if="item.type === 'video' && displayUrl(item)"
                  :src="displayUrl(item)"
                  :autoplay="realtimePreview"
                  :controls="viewMode === 'list'"
                  :loop="realtimePreview"
                  muted
                  playsinline
                  preload="metadata"
                />
                <audio
                  v-else-if="item.type === 'audio' && displayUrl(item) && viewMode === 'list'"
                  :src="displayUrl(item)"
                  controls
                  @click.stop
                />
                <div v-else-if="item.type === 'audio'" class="media-placeholder">
                  <el-icon><Headset /></el-icon>
                  <span>音频</span>
                </div>
                <div v-else-if="item.type === 'text'" class="text-preview">{{ item.prompt || item.name }}</div>
                <div v-else-if="item.type === 'model'" class="media-placeholder">
                  <el-icon><Box /></el-icon>
                  <span>3D World</span>
                </div>
                <img v-else-if="displayUrl(item)" :src="displayUrl(item)" :alt="item.name" loading="lazy" />
                <div v-else class="media-placeholder">
                  <el-icon><Picture /></el-icon>
                  <span>暂无预览</span>
                </div>

                <span v-if="mode === 'history'" class="history-type-badge" :title="typeName(item.type)">
                  <el-icon>
                    <VideoCamera v-if="item.type === 'video'" />
                    <Headset v-else-if="item.type === 'audio'" />
                    <Box v-else-if="item.type === 'model'" />
                    <Picture v-else />
                  </el-icon>
                </span>
                <span v-else class="type-badge">{{ typeName(item.type) }}</span>
                <time v-if="mode === 'history'" class="card-time">{{ formatTime(item.createdAt) }}</time>
                <label v-if="batchMode" class="select-check" @click.stop>
                  <input
                    type="checkbox"
                    :checked="selectedKeys.includes(item.key)"
                    @change="toggleSelected(item.key)"
                  >
                </label>
                <div v-if="!batchMode" class="preview-actions">
                  <button type="button" title="查看详情" @click.stop="detailItem = item">
                    <el-icon><View /></el-icon>
                  </button>
                  <button
                    v-if="item.nodeId"
                    type="button"
                    title="定位到画布"
                    @click.stop="emit('locate', item.nodeId)"
                  >
                    <el-icon><Location /></el-icon>
                  </button>
                </div>
              </div>
              <div v-if="mode === 'assets' || viewMode === 'list'" class="media-meta">
                <strong :title="item.name">{{ item.name }}</strong>
                <time v-if="mode === 'assets'">{{ formatTime(item.createdAt) }}</time>
                <div v-if="itemTags(item).length" class="item-tags">
                  <span v-for="tag in itemTags(item)" :key="tag">{{ tag }}</span>
                </div>
              </div>
            </article>
          </div>
        </section>
      </template>

      <div
        v-else-if="!loading && mode === 'assets' && activeTab === 'library'"
        class="empty-state asset-empty-state"
      >
        <span class="empty-document-icon"><el-icon><Document /></el-icon></span>
        <h3>素材库为空</h3>
        <p>在工作流画布中右键点击节点，即可保存到素材库</p>
        <ol class="empty-guide">
          <li><span>1</span><p>在画布中找到图片、视频、音频或文本节点</p></li>
          <li><span>2</span><p>右键点击节点 → 选择 <strong>保存到素材库</strong></p></li>
          <li><span>3</span><p>设置名称和分类后即可在此查看和使用</p></li>
        </ol>
      </div>
      <div v-else-if="!loading" class="empty-state">
        <span class="empty-document-icon"><el-icon><Document /></el-icon></span>
        <h3>{{ emptyTitle }}</h3>
        <p>{{ emptyDescription }}</p>
      </div>
    </main>

    <footer v-if="batchMode" class="batch-bar">
      <el-checkbox
        :model-value="allVisibleSelected"
        :indeterminate="selectedKeys.length > 0 && !allVisibleSelected"
        @change="toggleSelectAll"
      >
        全选
      </el-checkbox>
      <strong>已选 {{ selectedKeys.length }} 项</strong>
      <el-select
        v-if="mode === 'history'"
        v-model="batchTag"
        class="batch-tag-select"
        size="small"
        placeholder="选择标签"
        :disabled="!selectedKeys.length || !tags.length"
      >
        <el-option v-for="tag in tags" :key="tag" :label="tag" :value="tag" />
      </el-select>
      <el-button
        v-if="mode === 'history'"
        size="small"
        :disabled="!selectedKeys.length || !batchTag"
        @click="assignBatchTag"
      >
        添加标签
      </el-button>
      <el-button size="small" :disabled="!downloadableSelection.length" @click="downloadSelected">
        打包下载
      </el-button>
    </footer>

    <footer v-if="mode === 'history' && !batchMode" class="history-footer">
      <span>共 {{ filteredItems.length }} 项</span>
      <div class="history-pagination">
        <button
          v-if="pageCount > 1"
          type="button"
          :disabled="currentPage <= 1"
          title="上一页"
          @click="currentPage -= 1"
        >
          ‹
        </button>
        <button
          v-if="pageCount > 1"
          type="button"
          :disabled="currentPage >= pageCount"
          title="下一页"
          @click="currentPage += 1"
        >
          ›
        </button>
        <span>每页</span>
        <el-select v-model="pageSize" class="page-size-select">
          <el-option :label="42" :value="42" />
          <el-option :label="84" :value="84" />
          <el-option :label="126" :value="126" />
        </el-select>
        <span>项</span>
      </div>
    </footer>

    <aside v-if="detailItem" class="detail-drawer">
      <header>
        <strong>资产详情</strong>
        <button class="icon-button" type="button" @click="detailItem = null">
          <el-icon><Close /></el-icon>
        </button>
      </header>
      <div class="detail-preview" :style="{ aspectRatio: cssRatio }">
        <video
          v-if="detailItem.type === 'video' && displayUrl(detailItem)"
          :src="displayUrl(detailItem)"
          controls
          preload="metadata"
        />
        <audio
          v-else-if="detailItem.type === 'audio' && displayUrl(detailItem)"
          :src="displayUrl(detailItem)"
          controls
        />
        <img
          v-else-if="detailItem.type === 'image' && displayUrl(detailItem)"
          :src="displayUrl(detailItem)"
          :alt="detailItem.name"
        >
        <div v-else class="media-placeholder">
          <el-icon><Box v-if="detailItem.type === 'model'" /><Document v-else /></el-icon>
          <span>{{ detailItem.prompt || detailItem.name }}</span>
        </div>
      </div>
      <div class="detail-actions">
        <el-button :disabled="!displayUrl(detailItem)" @click="downloadItem(detailItem)">下载</el-button>
        <el-button :disabled="!displayUrl(detailItem)" @click="openOriginal(detailItem)">
          {{ detailItem.type === 'image' ? '查看原图' : '查看原文件' }}
        </el-button>
      </div>
      <dl>
        <div><dt>任务ID</dt><dd>{{ detailItem.taskId || '—' }}</dd></div>
        <div><dt>类型</dt><dd>{{ typeName(detailItem.type) }}生成</dd></div>
        <div><dt>生成时间</dt><dd>{{ formatDateTime(detailItem.createdAt) }}</dd></div>
        <div><dt>模型</dt><dd>{{ detailItem.model || '—' }}</dd></div>
        <div><dt>生成方式</dt><dd>{{ detailItem.prompt ? '文生' + typeName(detailItem.type) : '—' }}</dd></div>
        <div><dt>比例</dt><dd>{{ detailItem.ratio || cardRatio }}</dd></div>
        <div><dt>节点</dt><dd>{{ detailItem.nodeId || '未关联画布节点' }}</dd></div>
      </dl>
      <section class="prompt-section">
        <header>
          <strong>提示词</strong>
          <button type="button" :disabled="!detailItem.prompt" @click="copyPrompt(detailItem.prompt)">复制</button>
        </header>
        <p>{{ detailItem.prompt || '暂无提示词' }}</p>
      </section>
      <div class="drawer-footer">
        <el-button
          v-if="detailItem.nodeId"
          @click="emit('locate', detailItem.nodeId)"
        >
          定位到画布
        </el-button>
        <el-button type="primary" @click="emit('apply', detailItem)">应用到画布</el-button>
      </div>
    </aside>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Box,
  Close,
  Document,
  Grid,
  Headset,
  List,
  Location,
  Picture,
  PriceTag,
  Select,
  VideoCamera,
  View,
} from '@element-plus/icons-vue'

import { assetsAPI } from '@/api/assets'
import { imagesAPI } from '@/api/images'
import { videosAPI } from '@/api/videos'
import { assetMediaUrl } from '@/utils/mediaUrl'
import {
  groupMediaItems,
  normalizeCanvasAssets,
  normalizeGenerationHistory,
  normalizeLibraryAssets,
} from '@/utils/canvasAssetHistory'

const props = defineProps({
  mode: {
    type: String,
    required: true,
    validator: (value) => ['assets', 'history'].includes(value),
  },
  dramaId: {
    type: [String, Number],
    required: true,
  },
  nodes: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['close', 'locate', 'apply'])

const assetTabs = [
  { value: 'library', label: '素材库' },
  { value: 'canvas', label: '画布资产' },
  { value: 'image', label: '图片工具', external: true },
  { value: 'video', label: '视频工具', external: true },
]
const categoryOptions = [
  { value: 'all', label: '全部分类' },
  { value: 'person', label: '人物' },
  { value: 'scene', label: '场景' },
  { value: 'item', label: '物品' },
  { value: 'style', label: '风格' },
  { value: 'sound', label: '音效' },
  { value: 'other', label: '其它' },
  { value: 'prompt', label: '提示词' },
]
const assetTypeOptions = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'text', label: '文本' },
  { value: 'model', label: '3D World' },
]
const historyTypeOptions = assetTypeOptions.filter((option) => option.value !== 'text')
const groupOptions = [
  { value: 'flat', label: '平铺' },
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]
const ratioOptions = ['1:1', '4:3', '3:4', '16:9', '21:9']

const activeTab = ref('library')
const categoryFilter = ref('all')
const typeFilter = ref('all')
const groupMode = ref('day')
const cardRatio = ref('1:1')
const cardSize = ref('small')
const cardWidth = ref(180)
const realtimePreview = ref(false)
const viewMode = ref('grid')
const batchMode = ref(false)
const selectedKeys = ref([])
const detailItem = ref(null)
const scope = ref('canvas')
const loading = ref(false)
const loadError = ref('')
const libraryItems = ref([])
const imageRecords = ref([])
const videoRecords = ref([])
const tags = ref([])
const tagAssignments = ref({})
const tagFilter = ref('all')
const newTag = ref('')
const batchTag = ref('')
const pageSize = ref(42)
const currentPage = ref(1)

const storageKey = computed(() => `moli-canvas-history-tags:${props.dramaId}`)
const canvasItems = computed(() => normalizeCanvasAssets(props.nodes))
const generationItems = computed(() => normalizeGenerationHistory({
  images: imageRecords.value,
  videos: videoRecords.value,
  nodes: props.nodes,
}))
const historyItems = computed(() => {
  const supplements = canvasItems.value.filter((item) => ['audio', 'model'].includes(item.type))
  const seen = new Set(generationItems.value.map((item) => item.nodeId).filter(Boolean))
  return [
    ...generationItems.value,
    ...supplements.filter((item) => !seen.has(item.nodeId)),
  ]
})
const visibleTypeOptions = computed(() => (
  props.mode === 'history'
    ? historyTypeOptions
    : assetTypeOptions.filter((option) => activeTab.value !== 'library' || option.value !== 'model')
))
const baseItems = computed(() => {
  if (props.mode === 'history') return historyItems.value
  if (activeTab.value === 'library') return libraryItems.value
  if (activeTab.value === 'canvas') return canvasItems.value
  return generationItems.value.filter((item) => item.type === activeTab.value)
})
const filteredItems = computed(() => baseItems.value.filter((item) => {
  if (
    props.mode === 'assets'
    && activeTab.value === 'library'
    && categoryFilter.value !== 'all'
    && item.category !== categoryFilter.value
  ) return false
  if (typeFilter.value !== 'all' && item.type !== typeFilter.value) return false
  if (props.mode === 'history' && scope.value === 'canvas' && !item.nodeId) return false
  if (props.mode === 'history' && tagFilter.value !== 'all' && !itemTags(item).includes(tagFilter.value)) {
    return false
  }
  return true
}))
const pageCount = computed(() => Math.max(1, Math.ceil(filteredItems.value.length / pageSize.value)))
const pagedItems = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredItems.value.slice(start, start + pageSize.value)
})
const groups = computed(() => groupMediaItems(pagedItems.value, groupMode.value))
const visibleKeys = computed(() => pagedItems.value.map((item) => item.key))
const allVisibleSelected = computed(() => (
  visibleKeys.value.length > 0
  && visibleKeys.value.every((key) => selectedKeys.value.includes(key))
))
const downloadableSelection = computed(() => {
  const selected = new Set(selectedKeys.value)
  return filteredItems.value.filter((item) => selected.has(item.key) && displayUrl(item))
})
const cssRatio = computed(() => cardRatio.value.replace(':', ' / '))
const emptyTitle = computed(() => {
  if (props.mode === 'history') return '此画布暂无历史生成资产'
  if (activeTab.value === 'library') return '素材库为空'
  if (activeTab.value === 'image') return '暂无图片生成记录'
  if (activeTab.value === 'video') return '暂无视频生成记录'
  return '当前画布暂无资产'
})
const emptyDescription = computed(() => {
  if (props.mode === 'history') return '生成图片、视频、音频或 3D World 后会显示在这里。'
  if (activeTab.value === 'library') return '在画布节点菜单中保存素材并设置名称与分类后，可在这里统一管理。'
  return '完成生成或把素材添加到画布后，会显示在这里。'
})

function responseItems(response) {
  if (Array.isArray(response)) return response
  if (Array.isArray(response?.items)) return response.items
  if (Array.isArray(response?.data?.items)) return response.data.items
  if (Array.isArray(response?.data)) return response.data
  return []
}

function responseTotalPages(response) {
  return Number(
    response?.pagination?.total_pages
      || response?.data?.pagination?.total_pages
      || 1,
  )
}

async function loadAllPages(api, params) {
  const first = await api.list({ ...params, page: 1, page_size: 100 })
  const totalPages = Math.min(responseTotalPages(first), 20)
  if (totalPages <= 1) return responseItems(first)
  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) => (
      api.list({ ...params, page: index + 2, page_size: 100 })
    )),
  )
  return [first, ...rest].flatMap(responseItems)
}

async function load() {
  loading.value = true
  loadError.value = ''
  const params = { drama_id: props.dramaId }
  const results = await Promise.allSettled([
    loadAllPages(assetsAPI, { ...params, include_global: 1 }),
    loadAllPages(imagesAPI, params),
    loadAllPages(videosAPI, params),
  ])

  if (results[0].status === 'fulfilled') {
    libraryItems.value = normalizeLibraryAssets(results[0].value)
  }
  if (results[1].status === 'fulfilled') imageRecords.value = results[1].value
  if (results[2].status === 'fulfilled') videoRecords.value = results[2].value

  const failed = [
    results[0].status === 'rejected' ? '素材库' : '',
    results[1].status === 'rejected' ? '图片历史' : '',
    results[2].status === 'rejected' ? '视频历史' : '',
  ].filter(Boolean)
  if (failed.length) loadError.value = `${failed.join('、')}加载失败，其余真实数据仍可使用。`
  loading.value = false
}

function displayUrl(item) {
  return assetMediaUrl(item?.raw) || assetMediaUrl({ url: item?.url })
}

function typeName(type) {
  return {
    image: '图片',
    video: '视频',
    audio: '音频',
    text: '文本',
    model: '3D World',
  }[type] || '资产'
}

function formatTime(value) {
  if (!value) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatDateTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function onItemClick(item) {
  if (batchMode.value) {
    toggleSelected(item.key)
    return
  }
  detailItem.value = item
}

function toggleBatchMode() {
  batchMode.value = !batchMode.value
  selectedKeys.value = []
  if (batchMode.value) detailItem.value = null
}

function toggleSelected(key) {
  selectedKeys.value = selectedKeys.value.includes(key)
    ? selectedKeys.value.filter((itemKey) => itemKey !== key)
    : [...selectedKeys.value, key]
}

function toggleSelectAll(checked) {
  selectedKeys.value = checked ? [...visibleKeys.value] : []
}

function restoreTags() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey.value) || '{}')
    tags.value = Array.isArray(saved.tags) ? saved.tags : []
    tagAssignments.value = saved.assignments && typeof saved.assignments === 'object'
      ? saved.assignments
      : {}
  } catch {
    tags.value = []
    tagAssignments.value = {}
  }
}

function saveTags() {
  localStorage.setItem(storageKey.value, JSON.stringify({
    tags: tags.value,
    assignments: tagAssignments.value,
  }))
}

function createTag() {
  const value = newTag.value.trim()
  if (!value) return
  if (!tags.value.includes(value)) tags.value = [...tags.value, value]
  newTag.value = ''
  saveTags()
}

function itemTags(item) {
  const value = tagAssignments.value[item.key]
  return Array.isArray(value) ? value : []
}

function assignBatchTag() {
  if (!batchTag.value || !selectedKeys.value.length) return
  const next = { ...tagAssignments.value }
  for (const key of selectedKeys.value) {
    next[key] = [...new Set([...(next[key] || []), batchTag.value])]
  }
  tagAssignments.value = next
  saveTags()
  ElMessage.success(`已为 ${selectedKeys.value.length} 项添加标签`)
}

function downloadItem(item) {
  const url = displayUrl(item)
  if (!url) return
  const link = document.createElement('a')
  link.href = url
  link.download = item.name || 'asset'
  link.rel = 'noopener'
  link.click()
}

function downloadSelected() {
  for (const item of downloadableSelection.value) downloadItem(item)
}

function openOriginal(item) {
  const url = displayUrl(item)
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

async function copyPrompt(value) {
  if (!value) return
  await navigator.clipboard.writeText(value)
  ElMessage.success('提示词已复制')
}

watch(() => props.mode, (value) => {
  activeTab.value = value === 'assets' ? 'library' : 'canvas'
  typeFilter.value = 'all'
  selectedKeys.value = []
  detailItem.value = null
})

watch(activeTab, () => {
  typeFilter.value = 'all'
  categoryFilter.value = 'all'
  selectedKeys.value = []
  detailItem.value = null
})

watch(cardSize, (value) => {
  cardWidth.value = {
    small: 180,
    medium: 224,
    large: 288,
  }[value] || 180
})

watch([() => filteredItems.value.length, pageSize], () => {
  currentPage.value = Math.min(currentPage.value, pageCount.value)
})

watch(storageKey, restoreTags)

onMounted(() => {
  restoreTags()
  load()
})
</script>

<style scoped src="./CanvasAssetHistoryPanel.css"></style>
