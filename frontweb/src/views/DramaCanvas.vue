<template>
  <div class="drama-canvas-page">
    <header class="header canvas-topbar" :class="{ 'workflow-open': showWorkflowPanel }">
      <div class="header-inner">
        <CanvasWorkspaceSwitcher />
        <span class="breadcrumb-sep">›</span>
        <span class="page-title">{{ drama?.title || '加载中…' }}</span>
        <span class="canvas-name">画布 1</span>
        <span
          v-if="canvasVirtualized"
          class="canvas-virtualization-status"
          :title="`多集画布仅渲染视口附近节点：${nodes.length}/${allGraphNodes.length}`"
        >
          视口渲染 {{ nodes.length }}/{{ allGraphNodes.length }}
        </span>

        <el-select
          v-model="filterEpisodeId"
          class="episode-select"
          placeholder="全部集数"
          clearable
          size="small"
          style="width: 150px"
        >
          <el-option
            v-for="ep in (drama?.episodes || [])"
            :key="ep.id"
            :label="ep.title || '第' + (ep.episode_number || 0) + '集'"
            :value="ep.id"
          />
        </el-select>

        <span v-if="layoutSaveState === 'saving'" class="layout-status saving">保存中…</span>
        <span v-else-if="layoutSaveState === 'saved'" class="layout-status saved">已保存</span>
        <span v-else-if="layoutSaveState === 'error'" class="layout-status error">保存失败</span>

        <div class="header-actions">
          <el-button class="topbar-share" size="small" circle aria-label="分享画布" title="复制画布链接" @click="shareCanvas">
            <el-icon><Share /></el-icon>
          </el-button>
          <el-tooltip content="工作流：框选分镜后创建，可拖拽排序并按步骤整组重跑" placement="bottom">
            <el-button class="topbar-workflow-toggle" size="small" :type="showWorkflowPanel ? 'primary' : 'default'" plain @click="toggleWorkflowPanel">
              <el-icon><Operation /></el-icon>
              工作流
            </el-button>
          </el-tooltip>
          <el-dropdown class="topbar-more" trigger="click" placement="bottom-end" @command="onTopbarMoreCommand">
            <el-button class="topbar-more-trigger" size="small" aria-label="更多画布操作" title="更多画布操作">
              <el-icon><MoreFilled /></el-icon>
              <span class="topbar-more-label">更多</span>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="script">编辑剧本</el-dropdown-item>
                <el-dropdown-item command="storyboard">添加分镜</el-dropdown-item>
                <el-dropdown-item command="character">添加角色</el-dropdown-item>
                <el-dropdown-item command="scene">添加场景</el-dropdown-item>
                <el-dropdown-item command="prop">添加道具</el-dropdown-item>
                <el-dropdown-item command="episode">添加集数</el-dropdown-item>
                <el-dropdown-item command="align" :disabled="aligningNodes">自动对齐节点</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <CanvasModeSwitch mode="canvas" :drama-id="dramaId" :episode-id="filterEpisodeId" />
          <el-button class="btn-theme" @click="toggleTheme">
            <el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon>
            {{ isDark ? '浅色' : '暗色' }}
          </el-button>
        </div>
      </div>

      <div v-if="showWorkflowPanel" class="workflow-bar">
        <el-tooltip content="在画布空白处拖拽框选分镜，或按住 Ctrl 逐个多选" placement="bottom-start">
          <span class="wf-hint">已选 {{ selectedStoryboardIds.length }} 个分镜</span>
        </el-tooltip>
        <CanvasGenerationOptions />
        <el-checkbox-group v-model="pipelineSteps" size="small" class="wf-steps">
          <el-checkbox value="image">生图</el-checkbox>
          <el-checkbox value="video">生视频</el-checkbox>
          <el-checkbox value="audio">配音</el-checkbox>
        </el-checkbox-group>
        <el-button
          size="small"
          :disabled="selectedStoryboardIds.length === 0 || workflowRunning || layoutSaveState === 'saving'"
          @click="onCreateWorkflowGroup"
        >
          创建工作流
        </el-button>
        <el-button
          size="small"
          type="primary"
          plain
          :loading="workflowRunning"
          :disabled="selectedStoryboardIds.length === 0 || workflowRunning || layoutSaveState === 'saving'"
          @click="onRunSelectedStoryboards"
        >
          运行所选
        </el-button>
        <el-select
          v-model="activeGroupId"
          size="small"
          placeholder="选择工作流"
          clearable
          style="width: 160px"
          @change="selectWorkflowGroup"
        >
          <el-option
            v-for="g in workflowGroups"
            :key="g.id"
            :label="`${g.title} (${workflowStoryboardCountLabel(g)})`"
            :value="g.id"
          />
        </el-select>
        <el-button
          size="small"
          type="primary"
          :loading="workflowRunning"
          :disabled="!activeGroupId || layoutSaveState === 'saving'"
          @click="onRunActiveGroup"
        >
          整组重跑
        </el-button>
        <el-button
          size="small"
          type="danger"
          plain
          :disabled="!activeGroupId || workflowRunning || layoutSaveState === 'saving'"
          @click="onDeleteActiveGroup"
        >
          删除工作流
        </el-button>
      </div>

      <div v-if="showWorkflowPanel && workflowProgress" class="workflow-progress">{{ workflowProgress }}</div>

      <CanvasWorkflowOrderPanel
        v-if="showWorkflowPanel && activeWorkflowGroup"
        :group="activeWorkflowGroup"
        :storyboards="allStoryboards"
        :disabled="workflowRunning || layoutSaveState === 'saving'"
        @change="onWorkflowOrderChange"
      />

      <div v-if="showWorkflowPanel" class="generate-bar">
        <span class="gen-label">本集生成</span>
        <el-button
          size="small"
          type="primary"
          :loading="episodeGenerating"
          :disabled="!filterEpisodeId || workflowRunning"
          @click="aiGenerateStoryboards"
        >
          AI 生成分镜
        </el-button>
        <el-button
          size="small"
          :loading="episodeGenerating"
          :disabled="!filterEpisodeId || workflowRunning"
          @click="batchGenerateImages"
        >
          批量生图
        </el-button>
        <el-button
          size="small"
          :loading="episodeGenerating"
          :disabled="!filterEpisodeId || workflowRunning"
          @click="batchGenerateVideos"
        >
          批量生视频
        </el-button>
        <span class="gen-hint" title="完整创作流水线">剧本 → 提取角色/场景/道具 → 分镜 → 生图 → 视频</span>
      </div>
      <div v-if="showWorkflowPanel && episodeGenProgress" class="workflow-progress episode-gen">{{ episodeGenProgress }}</div>
    </header>

    <div v-loading="loading" class="canvas-shell" :class="{ 'sidebar-open': sidebarVisible }">
      <aside v-if="drama && sidebarVisible" class="canvas-sidebar">
        <div class="sidebar-section sidebar-script">
          <div class="sec-label sec-label-row">
            <span>📜 剧本</span>
            <el-button link size="small" type="warning" @click="focusScriptNode">编辑</el-button>
          </div>
          <p class="sidebar-script-tip">从头创作：先写剧本，再提取左侧素材</p>
        </div>
        <div class="sidebar-title">
          素材库
          <el-button v-if="highlightAssetId" link size="small" @click="clearAssetHighlight">清除</el-button>
        </div>
        <div class="sidebar-context">
          {{ episodeContext.isFiltered ? `${selectedEpisodeLabel}引用素材` : '项目全部素材' }}
        </div>
        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>角色 {{ sidebarCharacters.length }}</span>
            <el-button link size="small" type="primary" @click="openCreateDialog('character')">+</el-button>
          </div>
          <div
            v-for="c in sidebarCharacters"
            :key="'c-' + c.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'char:' + c.id }"
            @click="selectSidebarAsset('char:' + c.id)"
          >
            {{ c.name || '未命名' }}
          </div>
          <div v-if="episodeContext.isFiltered && !sidebarCharacters.length" class="sidebar-empty">本集未引用角色</div>
        </div>
        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>场景 {{ sidebarScenes.length }}</span>
            <el-button link size="small" type="primary" @click="openCreateDialog('scene')">+</el-button>
          </div>
          <div
            v-for="s in sidebarScenes"
            :key="'s-' + s.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'scene:' + s.id }"
            @click="selectSidebarAsset('scene:' + s.id)"
          >
            {{ s.location || '未命名' }}
          </div>
          <div v-if="episodeContext.isFiltered && !sidebarScenes.length" class="sidebar-empty">本集未引用场景</div>
        </div>
        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>道具 {{ sidebarProps.length }}</span>
            <el-button link size="small" type="primary" @click="openCreateDialog('prop')">+</el-button>
          </div>
          <div
            v-for="p in sidebarProps"
            :key="'p-' + p.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'prop:' + p.id }"
            @click="selectSidebarAsset('prop:' + p.id)"
          >
            {{ p.name || '未命名' }}
          </div>
          <div v-if="episodeContext.isFiltered && !sidebarProps.length" class="sidebar-empty">本集未引用道具</div>
        </div>

        <div class="sidebar-section workflow-list">
          <div class="sec-label">工作流 {{ workflowGroups.length }}</div>
          <div
            v-for="g in workflowGroups"
            :key="g.id"
            class="sidebar-item workflow-item"
            :class="{ active: activeGroupId === g.id }"
            @click="selectWorkflowGroup(g.id)"
          >
            <div class="wf-item-title">{{ g.title }}</div>
            <div class="wf-item-meta">{{ workflowStoryboardCountLabel(g) }} · {{ (g.pipeline || []).join('→') }}</div>
          </div>
          <div v-if="!workflowGroups.length" class="sidebar-empty">框选分镜后点「创建工作流」</div>
        </div>

        <p class="sidebar-tip">经典模式流水线：分镜 → 脚本摘要 → 分镜图 → 视频。摘要节点是画布可视化，列表里合并在分镜编辑区。顶栏「本集生成」可 AI 批量操作；单击分镜可单镜生图/生视频。</p>
      </aside>

      <div
        ref="canvasMainRef"
        class="canvas-main"
        :class="{ 'space-panning': spacePanning }"
        @wheel.capture="onCanvasWheel"
      >
        <VueFlow
          v-if="allGraphNodes.length"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :node-types="nodeTypes"
          :default-viewport="initialViewport"
          :min-zoom="0.08"
          :max-zoom="2"
          :nodes-connectable="true"
          :elements-selectable="true"
          :select-nodes-on-drag="true"
          selection-mode="partial"
          :selection-key-code="true"
          :pan-on-drag="spacePanning"
          pan-activation-key-code="Space"
          zoom-activation-key-code="Control"
          :pan-on-scroll="true"
          :zoom-on-scroll="false"
          :fit-view-on-init="!hasSavedViewport"
          class="vue-flow-canvas"
          @node-double-click="onNodeDoubleClick"
          @node-click="onNodeClick"
          @node-context-menu="onNodeContextMenu"
          @pane-click="onPaneClick"
          @pane-context-menu="onPaneContextMenu"
          @node-drag-start="onNodeDragStart"
          @node-drag-stop="onNodeDragStop"
          @viewport-change="onViewportChange"
          @move-end="scheduleLayoutSave"
          @nodes-change="onNodesChange"
          @edges-change="onEdgesChange"
          @connect="onConnect"
        >
          <CanvasFlowAligner />
          <Background pattern-color="#3f3f46" :gap="20" />
          <Controls />
          <MiniMap pannable zoomable />
        </VueFlow>
        <el-empty v-else-if="!loading" description="暂无画布数据" />
        <div v-if="runQueueItems.length" class="canvas-run-queue nodrag nopan" aria-label="画布节点运行队列" @mousedown.stop>
          <div class="run-queue-head">
            <span>运行队列</span>
            <small>{{ runningQueueCount }} 进行中 · {{ successQueueCount }} 完成 · {{ failedQueueCount }} 异常</small>
          </div>
          <div
            v-for="item in runQueueItems"
            :key="item.key"
            class="run-queue-item"
            :class="'tone-' + item.tone"
            @click="focusQueueItem(item)"
          >
            <span class="run-dot" />
            <span
              class="run-result-preview"
              :class="[item.resultUrl ? 'preview-' + queueResultPreviewType(item) : 'preview-empty']"
              @click.stop="item.resultUrl && openQueueItemResult(item)"
            >
              <img v-if="item.resultUrl && queueResultPreviewType(item) === 'image'" :src="item.resultUrl" alt="队列结果预览" />
              <video v-else-if="item.resultUrl && queueResultPreviewType(item) === 'video'" :src="item.resultUrl" muted playsinline />
              <span v-else-if="item.resultUrl" class="audio-preview">🎵</span>
            </span>
            <span class="run-info">
              <strong>{{ item.label }}</strong>
              <small>{{ item.message }}</small>
            </span>
            <span v-if="item.tone === 'running'" class="run-action">{{ item.elapsedText }}</span>
            <span v-else-if="item.tone === 'success'" class="run-success-actions">
              <button v-if="item.resultUrl" type="button" @click.stop="openQueueItemResult(item)">打开</button>
              <button v-if="item.resultUrl" type="button" @click.stop="copyQueueItemResult(item)">复制</button>
              <button v-if="item.resultNodeId" type="button" @click.stop="focusQueueItemResult(item)">定位</button>
              <button type="button" @click.stop="dismissQueueItem(item)">收起</button>
            </span>
            <span v-else-if="item.tone === 'failed'" class="run-failed-actions">
              <button v-if="item.resultUrl" type="button" @click.stop="openQueueItemResult(item)">打开</button>
              <button v-if="item.resultUrl" type="button" @click.stop="copyQueueItemResult(item)">复制</button>
              <button v-if="item.resultNodeId" type="button" @click.stop="focusQueueItemResult(item)">定位</button>
              <button v-if="item.errorDetail || item.message" type="button" @click.stop="copyQueueItemError(item)">原因</button>
              <button v-if="item.retryStep" type="button" @click.stop="retryQueueItem(item)">重试</button>
              <button type="button" @click.stop="dismissQueueItem(item)">收起</button>
            </span>
            <span v-else class="run-action">定位</span>
          </div>
        </div>
        <CanvasFloatingToolbar v-if="drama && allGraphNodes.length" />
      </div>
    </div>

    <CanvasDirectorStage
      v-if="directorStageVisible && drama"
      :visible="directorStageVisible"
      :drama="drama"
      :initial-state="directorTimeline"
      @close="closeDirectorStage"
      @state-change="onDirectorStateChange"
      @asset-created="onDirectorAssetCreated"
    />

    <CanvasCreateDialog
      v-model="createDialogVisible"
      :type="createDialogType"
      :on-submit="onCreateSubmit"
    />
    <AssetPickerDialog
      v-model="canvasAssetPickerVisible"
      type="all"
      title="从素材库加入画布"
      :drama-id="dramaId"
      @pick="onCanvasAssetLibraryPick"
    />
    <CanvasContextMenu
      :visible="contextMenuVisible"
      :x="contextMenuX"
      :y="contextMenuY"
      :mode="contextMenuNode ? 'node' : 'create'"
      :node-label="contextMenuNodeLabel"
      :node-actions="contextMenuNodeActions"
      @select="onContextMenuSelect"
      @close="closeContextMenu"
    />
  </div>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { Moon, MoreFilled, Plus, Sunny, Operation, Share } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

import { dramaAPI } from '@/api/drama'
import { assetsAPI } from '@/api/assets'
import { imagesAPI } from '@/api/images'
import { taskAPI } from '@/api/task'
import { storyboardsAPI } from '@/api/storyboards'
import { videosAPI } from '@/api/videos'
import { useTheme } from '@/composables/useTheme'
import { runAudioStep, runImageStep, runVideoStep, runWorkflowGroup } from '@/composables/useCanvasWorkflowRunner'
import { generateAssetReferenceImage } from '@/composables/useCanvasAssetGenerate'
import { CANVAS_CONTEXT_KEY } from '@/composables/useCanvasContext'
import { useCanvasStoryboardMedia } from '@/composables/useCanvasStoryboardMedia'
import { useCanvasCrud } from '@/composables/useCanvasCrud'
import { useCanvasEpisodeGenerate } from '@/composables/useCanvasEpisodeGenerate'
import { useCanvasScript, scriptNodeId } from '@/composables/useCanvasScript'
import {
  CANVAS_NODE_STATUS_LABELS,
  createCanvasNodeStatusStore,
} from '@/composables/useCanvasNodeStatus'
import {
  applyCanvasHighlight,
  buildDramaCanvasGraph,
  computeAutoLayoutPositions,
  getStoryboardRefFromNode,
  stampEdgeBaseStyles,
} from '@/utils/dramaCanvasAdapter'
import { virtualizeCanvasGraph } from '@/utils/canvasVirtualization'
import {
  buildCanvasLayoutPayload,
  parseCanvasLayout,
  parseDramaMetadata,
  resolveViewport,
} from '@/utils/canvasLayout'
import {
  commitCanvasInteractionHistory,
  createCanvasInteractionHistory,
  createCanvasInteractionState,
  redoCanvasInteractionHistory,
  undoCanvasInteractionHistory,
} from '@/utils/canvasInteractionHistory'
import { createCanvasLayoutPersistence } from '@/utils/canvasLayoutPersistence'
import { assetImageUrl, assetMediaUrl, audioUrl } from '@/utils/mediaUrl'
import {
  imageRecordUrl,
  resolveSbFirstImageRecord,
  resolveSbLastImageRecord,
  resolveSbMainImageRecord,
  resolveSbVideoRecord,
  videoRecordUrl,
} from '@/utils/storyboardMedia'
import {
  createWorkflowGroup,
  deleteWorkflowGroup,
  findStoryboardInDrama,
  getAdjacentStoryboards,
  normalizePipeline,
  parseWorkflowGroups,
  reorderWorkflowGroup,
  storyboardIdFromNodeId,
  getDramaGenerationOptions,
} from '@/utils/canvasWorkflow'
import { canChainStoryboardFrames } from '@/utils/videoContinuity'
import {
  filterCanvasAssets,
  getCanvasEpisodeContext,
  isCanvasAssetVisible,
} from '@/utils/canvasEpisodeContext'

import CanvasLabelNode from '@/components/dramaCanvas/CanvasLabelNode.vue'
import CanvasDramaHeaderNode from '@/components/dramaCanvas/CanvasDramaHeaderNode.vue'
import CanvasAssetNode from '@/components/dramaCanvas/CanvasAssetNode.vue'
import CanvasEpisodeNode from '@/components/dramaCanvas/CanvasEpisodeNode.vue'
import CanvasScriptNode from '@/components/dramaCanvas/CanvasScriptNode.vue'
import CanvasStoryboardNode from '@/components/dramaCanvas/CanvasStoryboardNode.vue'
import CanvasMediaNode from '@/components/dramaCanvas/CanvasMediaNode.vue'
import CanvasProjectAssetNode from '@/components/dramaCanvas/CanvasProjectAssetNode.vue'
import CanvasCreateDialog from '@/components/dramaCanvas/CanvasCreateDialog.vue'
import CanvasContextMenu from '@/components/dramaCanvas/CanvasContextMenu.vue'
import CanvasAddButtonNode from '@/components/dramaCanvas/CanvasAddButtonNode.vue'
import CanvasFloatingToolbar from '@/components/dramaCanvas/CanvasFloatingToolbar.vue'
import CanvasFlowAligner from '@/components/dramaCanvas/CanvasFlowAligner.vue'
import CanvasDirectorStage from '@/components/dramaCanvas/CanvasDirectorStage.vue'
import CanvasGenerationOptions from '@/components/dramaCanvas/CanvasGenerationOptions.vue'
import CanvasWorkflowOrderPanel from '@/components/dramaCanvas/CanvasWorkflowOrderPanel.vue'
import CanvasWorkspaceSwitcher from '@/components/CanvasWorkspaceSwitcher.vue'
import CanvasModeSwitch from '@/components/CanvasModeSwitch.vue'
import AssetPickerDialog from '@/components/AssetPickerDialog.vue'

const route = useRoute()
const router = useRouter()
const { isDark, toggle: toggleTheme } = useTheme()
const { imagesBySbId, videosBySbId, loadForDrama } = useCanvasStoryboardMedia()

const loading = ref(false)
const drama = ref(null)
const nodes = ref([])
const edges = ref([])
const allGraphNodes = ref([])
const allGraphEdges = ref([])
const projectImageAssets = ref([])
const storyboardAssignedAssets = ref({})
const canvasVirtualized = ref(false)
const filterEpisodeId = ref(null)
const highlightAssetId = ref(null)
const layoutCache = ref(null)
const workflowGroups = ref([])
const activeGroupId = ref(null)
const selectedStoryboardIds = ref([])
const pipelineSteps = ref(['image', 'video', 'audio'])
const workflowRunning = ref(false)
const workflowProgress = ref('')
const generationOverrides = ref({})
const layoutSaveState = ref('idle')
const layoutDirty = ref(false)
const layoutPersistence = createCanvasLayoutPersistence(({ canvasLayout, workflowGroups }) => (
  dramaAPI.saveCanvasLayout(dramaId.value, canvasLayout, workflowGroups)
))
const currentViewport = ref({ x: 0, y: 0, zoom: 0.75 })
const focusedNodeId = ref(null)
const sidebarVisible = ref(false)
const showWorkflowPanel = ref(false)
const directorStageVisible = ref(false)
let directorReturnFocus = null
const canvasMainRef = ref(null)
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuFlowPos = ref(null)
const contextMenuNode = ref(null)
const canvasAssetPickerVisible = ref(false)
const canvasAssetPickerFlowPos = ref(null)
const paneClickSuppressed = ref(false)
const spacePanning = ref(false)
const nodeStatus = createCanvasNodeStatusStore()
const aligningNodes = ref(false)
const canvasFlowApi = ref(null)
const NODE_STATUS_STORAGE_PREFIX = 'moli_canvas_node_status'
const interactionHistory = ref(createCanvasInteractionHistory(createCanvasInteractionState()))
const dragHistorySnapshot = ref(null)

function openDirectorStage() {
  directorReturnFocus = document.activeElement
  directorStageVisible.value = true
}

async function closeDirectorStage() {
  directorStageVisible.value = false
  await nextTick()
  directorReturnFocus?.focus?.()
  directorReturnFocus = null
}

const PANEL_NODE_TYPES = new Set(['canvasStoryboard', 'canvasMedia', 'canvasAsset', 'canvasScript', 'canvasProjectAsset'])

const contextMenuNodeLabel = computed(() => canvasNodeLabel(contextMenuNode.value))
const contextMenuNodeActions = computed(() => canvasNodeActions(contextMenuNode.value))

let saveTimer = null
let savedHintTimer = null
let pollTimer = null
let paneClickSuppressTimer = null
let virtualizationFrame = null
let runQueueTimer = null

const nodeTypes = {
  canvasLabel: markRaw(CanvasLabelNode),
  canvasDramaHeader: markRaw(CanvasDramaHeaderNode),
  canvasAsset: markRaw(CanvasAssetNode),
  canvasEpisode: markRaw(CanvasEpisodeNode),
  canvasScript: markRaw(CanvasScriptNode),
  canvasStoryboard: markRaw(CanvasStoryboardNode),
  canvasMedia: markRaw(CanvasMediaNode),
  canvasProjectAsset: markRaw(CanvasProjectAssetNode),
  canvasAddButton: markRaw(CanvasAddButtonNode),
}

const dramaId = computed(() => Number(route.params.id))
const savedLayout = computed(() => layoutCache.value || parseCanvasLayout(drama.value?.metadata))
const directorTimeline = computed(() => savedLayout.value?.director_timeline || null)
const visibleStoryboardIds = computed(() => new Set(
  nodes.value
    .filter((node) => node.type === 'canvasStoryboard' && node.data?.storyboard?.id)
    .map((node) => Number(node.data.storyboard.id))
))

const initialViewport = computed(() => {
  const v = resolveViewport(savedLayout.value)
  return { x: v.x, y: v.y, zoom: v.zoom }
})

const hasSavedViewport = computed(() => Boolean(savedLayout.value?.viewport))
const activeWorkflowGroup = computed(() => (
  workflowGroups.value.find((group) => group.id === activeGroupId.value) || null
))
const canUndo = computed(() => interactionHistory.value.past.length > 0)
const canRedo = computed(() => interactionHistory.value.future.length > 0)

function nodeStatusStorageKey() {
  return Number.isFinite(dramaId.value) && dramaId.value > 0
    ? `${NODE_STATUS_STORAGE_PREFIX}:${dramaId.value}`
    : ''
}

function restoreNodeStatusSnapshot() {
  const key = nodeStatusStorageKey()
  nodeStatus.restore({})
  if (!key || typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(key)
    if (raw) {
      nodeStatus.restore(JSON.parse(raw))
      void syncRestoredNodeTasks()
    }
  } catch {
    window.localStorage.removeItem(key)
  }
}

function persistNodeStatusSnapshot() {
  const key = nodeStatusStorageKey()
  if (!key || typeof window === 'undefined') return
  const snapshot = nodeStatus.snapshot()
  try {
    if (Object.keys(snapshot).length) window.localStorage.setItem(key, JSON.stringify(snapshot))
    else window.localStorage.removeItem(key)
  } catch {
    // localStorage may be unavailable or full; node overlays can still work in memory.
  }
}

function isRestoredPendingNodeStatus(status) {
  return Boolean(status?.restored && status?.taskId && !['failed', 'success'].includes(status.step))
}

function taskResultUrl(task) {
  const result = task?.result || {}
  const response = result.response || result.data || {}
  return result.video_url
    || result.image_url
    || result.audio_url
    || result.url
    || response.video_url
    || response.image_url
    || response.audio_url
    || response.url
    || ''
}

function restoredNodeStoryboardId(node, status) {
  return Number(status?.storyboardId || storyboardForNode(node)?.id || storyboardIdFromNodeId(node?.id)) || null
}

function restoredTaskResultInfo(node, status, task, resultUrl) {
  const step = status?.retryStep || status?.step || ''
  const storyboardId = restoredNodeStoryboardId(node, status)
  const storyboard = storyboardForNode(node)
  const base = storyboardId ? nodeStepResultInfo(node, step, storyboardId, storyboard) : {}
  const result = task?.result || {}
  return {
    ...base,
    resultUrl,
    resultType: status?.resultType || base.resultType || (['image', 'video', 'audio'].includes(step) ? step : ''),
    resultNodeId: status?.resultNodeId || base.resultNodeId || node?.id || '',
    resultLabel: status?.resultLabel || base.resultLabel || result.label || '结果已生成',
    promptText: status?.promptText || result.prompt || '',
  }
}

async function syncRestoredNodeTasks() {
  const entries = Object.entries(nodeStatus.map).filter(([, status]) => isRestoredPendingNodeStatus(status))
  for (const [nodeId, status] of entries) {
    try {
      const task = await taskAPI.get(status.taskId)
      if (task?.status === 'completed') {
        const node = findGraphNode(status.sourceNodeId || nodeId) || findGraphNode(nodeId) || { id: nodeId, data: {} }
        const resultUrl = taskResultUrl(task) || status.resultUrl || status.savedAssetUrl || ''
        const storyboardId = restoredNodeStoryboardId(node, status)
        const resultInfo = restoredTaskResultInfo(node, status, task, resultUrl)
        const savedAssetInfo = !status.savedAssetId && resultUrl && storyboardId
          ? await saveNodeResultAsset(node, resultInfo, resultInfo.promptText || '', storyboardId)
          : null
        if (savedAssetInfo && resultInfo.resultType === 'image') await loadProjectImageAssets()
        nodeStatus.success(nodeId, {
          ...status,
          ...resultInfo,
          ...(savedAssetInfo || {}),
          message: '恢复的任务已完成',
          autoClear: false,
        })
      } else if (task?.status === 'failed') {
        const message = task?.error?.message || task?.error || '恢复的任务已失败'
        nodeStatus.fail(nodeId, {
          ...status,
          message,
          errorDetail: message,
          retryStep: status.retryStep || status.step,
          retryLabel: status.retryLabel || `重试${CANVAS_NODE_STATUS_LABELS[status.retryStep || status.step] || '节点'}`,
          recoverable: true,
        })
      }
    } catch {
      // 任务回读失败时保持恢复态，避免误清除用户可重试信息。
    }
  }
  if (entries.length) {
    try {
      await refreshDrama(true)
    } catch {
      // 恢复任务刷新失败时保留当前节点状态，等待用户手动刷新或重试。
    }
  }
}
const allStoryboards = computed(() => {
  const list = []
  for (const episode of drama.value?.episodes || []) {
    for (const storyboard of episode.storyboards || []) {
      list.push({
        ...storyboard,
        episode_title: episode.title || `第${episode.episode_number || 0}集`,
      })
    }
  }
  return list
})
const episodeContext = computed(() => getCanvasEpisodeContext(drama.value, filterEpisodeId.value))
const selectedEpisodeLabel = computed(() => {
  const episode = episodeContext.value.episode
  return episode?.title || `第${episode?.episode_number || 0}集`
})
const sidebarCharacters = computed(() => filterCanvasAssets(drama.value?.characters, 'character', episodeContext.value))
const sidebarScenes = computed(() => filterCanvasAssets(drama.value?.scenes, 'scene', episodeContext.value))
const sidebarProps = computed(() => filterCanvasAssets(drama.value?.props, 'prop', episodeContext.value))
const queueNow = ref(Date.now())
const runQueueItems = computed(() => {
  const grouped = new Map()
  const seen = new Set()
  for (const [nodeId, status] of Object.entries(nodeStatus.map)) {
    if (!nodeId || !status) continue
    const key = `active:${queueStatusRunKey(nodeId, status)}`
    const isFailed = status.step === 'failed'
    const isSuccess = status.step === 'success'
    const sourceNodeId = status.sourceNodeId || nodeId
    seen.add(nodeId)
    mergeRunQueueItem(grouped, {
      key,
      nodeId: sourceNodeId,
      statusIds: [nodeId],
      tone: isFailed ? 'failed' : isSuccess ? 'success' : 'running',
      label: queueNodeLabel(sourceNodeId),
      message: isFailed
        ? (status.message || '节点执行失败')
        : isSuccess
          ? queueSuccessMessage(status)
          : queueRunningMessage(status),
      elapsedText: formatQueueElapsed(status.at),
      retryStep: isFailed ? (status.retryStep || queueNodeRetryStep(findGraphNode(sourceNodeId))) : '',
      resultUrl: status.resultUrl || status.savedAssetUrl || '',
      resultNodeId: status.resultNodeId || '',
      resultType: status.resultType || '',
      errorDetail: isFailed ? (status.errorDetail || status.detail || status.message || '') : '',
    })
  }
  for (const node of allGraphNodes.value) {
    const failure = queueNodeFailure(node)
    if (!failure || seen.has(String(node.id))) continue
    seen.add(String(node.id))
    mergeRunQueueItem(grouped, {
      key: `failed:${node.id}`,
      nodeId: node.id,
      statusIds: [node.id],
      tone: 'failed',
      label: canvasNodeLabel(node),
      message: failure,
      retryStep: queueNodeRetryStep(node),
      errorDetail: failure,
    })
  }
  return Array.from(grouped.values()).slice(0, 8)
})
const runningQueueCount = computed(() => runQueueItems.value.filter((item) => item.tone === 'running').length)
const successQueueCount = computed(() => runQueueItems.value.filter((item) => item.tone === 'success').length)
const failedQueueCount = computed(() => runQueueItems.value.filter((item) => item.tone === 'failed').length)

function queueNodeLabel(nodeId) {
  const node = findGraphNode(nodeId)
  if (node) return canvasNodeLabel(node)
  const sbId = storyboardIdFromNodeId(nodeId)
  return sbId ? `分镜 #${sbId}` : String(nodeId)
}

function queueStatusRunKey(nodeId, status) {
  return status?.runKey || `node:${nodeId}`
}

function queueToneRank(tone) {
  if (tone === 'failed') return 3
  if (tone === 'running') return 2
  if (tone === 'success') return 1
  return 0
}

function mergeRunQueueItem(grouped, item) {
  const current = grouped.get(item.key)
  if (!current) {
    grouped.set(item.key, item)
    return
  }
  current.statusIds = [...new Set([...(current.statusIds || []), ...(item.statusIds || [])])]
  if (!findGraphNode(current.nodeId) && findGraphNode(item.nodeId)) current.nodeId = item.nodeId
  if (!current.resultUrl && item.resultUrl) current.resultUrl = item.resultUrl
  if (!current.resultNodeId && item.resultNodeId) current.resultNodeId = item.resultNodeId
  if (!current.resultType && item.resultType) current.resultType = item.resultType
  if (!current.retryStep && item.retryStep) current.retryStep = item.retryStep
  if (!current.errorDetail && item.errorDetail) current.errorDetail = item.errorDetail
  if (queueToneRank(item.tone) > queueToneRank(current.tone)) current.tone = item.tone
  if (item.tone === current.tone && item.message) current.message = item.message
}

function queueNodeFailure(node) {
  const data = node?.data || {}
  if (data.generationError) return data.generationError
  const sb = data.storyboard || {}
  if (sb.error_msg || sb.error_message || sb.generation_error) {
    return sb.error_msg || sb.error_message || sb.generation_error
  }
  if (sb.status === 'failed') return '节点任务失败，可定位后重试'
  return ''
}

function queueNodeRetryStep(node) {
  if (!node) return ''
  const id = String(node.id || '')
  const kind = node.data?.kind
  if (id.startsWith('sbimg:') || kind === 'image' || node.data?.frameKind) return 'image'
  if (id.startsWith('sbvid:') || kind === 'video') return 'video'
  if (id.startsWith('sbaud:') || kind === 'audio') return 'audio'
  if (node.type === 'canvasStoryboard') return 'video'
  return ''
}

function queueRunningMessage(status) {
  const elapsed = formatQueueElapsed(status?.at)
  return `${status?.message || '处理中…'} · ${elapsed}，刷新后可恢复查看`
}

function queueSuccessMessage(status) {
  const typeMap = { image: '图片结果可复用', video: '视频结果可复用', audio: '音频结果可复用' }
  return status?.resultLabel || typeMap[status?.resultType] || status?.message || '节点执行完成'
}

function queueResultPreviewType(item) {
  const type = String(item?.resultType || '').toLowerCase()
  if (['image', 'video', 'audio'].includes(type)) return type
  const url = String(item?.resultUrl || '').toLowerCase()
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/.test(url)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/.test(url)) return 'audio'
  return 'image'
}

function formatQueueElapsed(startedAt) {
  const start = Number(startedAt)
  if (!Number.isFinite(start)) return '刚刚开始'
  const seconds = Math.max(0, Math.floor((queueNow.value - start) / 1000))
  if (seconds < 60) return `${seconds}秒`
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

async function focusQueueItem(item) {
  if (!item?.nodeId) return
  await focusCanvasNode(item.nodeId)
}

async function retryQueueItem(item) {
  const node = findGraphNode(item?.nodeId)
  if (!node || !item?.retryStep) {
    ElMessage.warning('未找到可重试节点')
    return
  }
  await focusCanvasNode(item.nodeId)
  await runCanvasNodeStep(node, item.retryStep)
}

function openQueueItemResult(item) {
  if (!item?.resultUrl) {
    ElMessage.warning('该队列项暂无可打开的结果')
    return
  }
  window.open(item.resultUrl, '_blank', 'noopener,noreferrer')
}

async function copyQueueItemResult(item) {
  if (!item?.resultUrl) {
    ElMessage.warning('该队列项暂无可复制的结果')
    return
  }
  await copyCanvasText(item.resultUrl, '队列结果链接已复制', '队列结果链接（请手动复制）')
}

async function copyQueueItemError(item) {
  const text = item?.errorDetail || item?.message || ''
  if (!text) {
    ElMessage.warning('该队列项暂无失败原因')
    return
  }
  await copyCanvasText(text, '队列失败原因已复制', '队列失败原因（请手动复制）')
}

async function focusQueueItemResult(item) {
  if (!item?.resultNodeId) {
    ElMessage.warning('该队列项暂无可定位的结果节点')
    return
  }
  await focusNodeOrWarn(item.resultNodeId, '该队列项暂无可定位的结果节点')
}

function dismissQueueItem(item) {
  const ids = item?.statusIds?.length ? item.statusIds : [item?.nodeId]
  ids.filter(Boolean).forEach((id) => nodeStatus.clear(id))
}

function syncWorkflowFromDrama() {
  workflowGroups.value = parseWorkflowGroups(drama.value?.metadata)
  if (activeGroupId.value && !workflowGroups.value.some((g) => g.id === activeGroupId.value)) {
    activeGroupId.value = null
  }
}

function rebuildGraph() {
  if (!drama.value) {
    allGraphNodes.value = []
    allGraphEdges.value = []
    canvasVirtualized.value = false
    nodes.value = []
    edges.value = []
    return
  }
  const graph = buildDramaCanvasGraph(drama.value, {
    episodeId: filterEpisodeId.value,
    savedLayout: savedLayout.value,
    workflowGroups: workflowGroups.value,
    imagesBySbId: imagesBySbId.value,
    videosBySbId: videosBySbId.value,
    projectAssets: projectImageAssets.value,
  })
  let nextNodes = graph.nodes.map((node) => {
    const storyboardId = node.type === 'canvasStoryboard' ? Number(node.data?.storyboard?.id) : null
    if (!Number.isFinite(storyboardId)) return node
    return {
      ...node,
      data: {
        ...node.data,
        assignedAssets: storyboardAssignedAssets.value[storyboardId] || [],
      },
    }
  })
  let nextEdges = stampEdgeBaseStyles(graph.edges)
  if (highlightAssetId.value) {
    const highlighted = applyCanvasHighlight(nextNodes, nextEdges, highlightAssetId.value, drama.value)
    nextNodes = highlighted.nodes
    nextEdges = highlighted.edges
  }
  const selectedIds = new Set(selectedStoryboardIds.value.map(Number))
  if (selectedIds.size) {
    nextNodes = nextNodes.map((node) => {
      if (node.type !== 'canvasStoryboard') return node
      return {
        ...node,
        selected: selectedIds.has(Number(node.data?.storyboard?.id)),
      }
    })
  }
  allGraphNodes.value = nextNodes
  allGraphEdges.value = nextEdges
  applyVirtualizedGraph()
  interactionHistory.value = createCanvasInteractionHistory(currentInteractionState())
}

function currentInteractionState() {
  return createCanvasInteractionState(allGraphNodes.value, currentViewport.value)
}

function commitInteractionHistory(previousState) {
  interactionHistory.value = commitCanvasInteractionHistory(
    interactionHistory.value,
    previousState,
    currentInteractionState(),
  )
}

function applyInteractionState(state) {
  const positions = state?.nodes || {}
  allGraphNodes.value = allGraphNodes.value.map((node) => {
    const position = positions[String(node.id)]
    return position ? { ...node, position: { ...position } } : node
  })
  currentViewport.value = { ...(state?.viewport || currentViewport.value) }
  applyVirtualizedGraph()
  scheduleLayoutSave()
}

function canvasViewportSize() {
  return {
    width: canvasMainRef.value?.clientWidth || 0,
    height: canvasMainRef.value?.clientHeight || 0,
  }
}

function syncRenderedNodesToGraph() {
  if (!allGraphNodes.value.length || !nodes.value.length) return
  const renderedById = new Map(nodes.value.map((node) => [String(node.id), node]))
  allGraphNodes.value = allGraphNodes.value.map((node) => {
    const rendered = renderedById.get(String(node.id))
    if (!rendered) return node
    return {
      ...node,
      position: rendered.position || node.position,
      selected: rendered.selected,
      class: rendered.class,
      data: rendered.data || node.data,
    }
  })
}

function applyVirtualizedGraph() {
  if (!allGraphNodes.value.length) {
    nodes.value = []
    edges.value = []
    canvasVirtualized.value = false
    return
  }
  const result = virtualizeCanvasGraph(
    allGraphNodes.value,
    allGraphEdges.value,
    currentViewport.value,
    canvasViewportSize(),
    {
      minNodes: 80,
      overscan: 360,
      pinnedIds: focusedNodeId.value ? [focusedNodeId.value] : [],
    },
  )
  nodes.value = result.nodes
  edges.value = result.edges
  canvasVirtualized.value = result.virtualized
}

function scheduleVirtualization() {
  if (virtualizationFrame != null) {
    if (typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(virtualizationFrame)
    else clearTimeout(virtualizationFrame)
  }
  const run = () => {
    virtualizationFrame = null
    applyVirtualizedGraph()
  }
  if (typeof window !== 'undefined' && window.requestAnimationFrame) {
    virtualizationFrame = window.requestAnimationFrame(run)
  } else {
    virtualizationFrame = setTimeout(run, 0)
  }
}

function workflowStoryboardCountLabel(group) {
  const total = (group?.storyboard_ids || []).length
  if (filterEpisodeId.value == null) return `${total}镜`
  const visible = (group?.storyboard_ids || []).filter((id) => visibleStoryboardIds.value.has(Number(id))).length
  return `${visible}/${total}镜`
}

function applyHighlight() {
  if (!allGraphNodes.value.length) return
  const highlighted = applyCanvasHighlight(
    allGraphNodes.value.map((n) => ({ ...n, class: undefined, data: { ...n.data, highlighted: false, dimmed: false } })),
    allGraphEdges.value,
    highlightAssetId.value,
    drama.value
  )
  allGraphNodes.value = highlighted.nodes
  allGraphEdges.value = highlighted.edges
  applyVirtualizedGraph()
}

function selectSidebarAsset(assetNodeId) {
  highlightAssetId.value = highlightAssetId.value === assetNodeId ? null : assetNodeId
  applyHighlight()
}

function setHighlightAsset(assetNodeId) {
  highlightAssetId.value = assetNodeId
  applyHighlight()
}

async function refreshDrama(preserveFocus = true) {
  const keepId = preserveFocus ? focusedNodeId.value : null
  await loadDrama(true)
  await loadForDrama(drama.value, filterEpisodeId.value)
  rebuildGraph()
  if (keepId) focusedNodeId.value = keepId
}

async function refreshCanvas(preserveFocus = true) {
  await refreshDrama(preserveFocus)
}

function suppressPaneClick(ms = 350) {
  paneClickSuppressed.value = true
  if (paneClickSuppressTimer) clearTimeout(paneClickSuppressTimer)
  paneClickSuppressTimer = setTimeout(() => {
    paneClickSuppressed.value = false
    paneClickSuppressTimer = null
  }, ms)
}

function screenToFlowPosition(clientX, clientY) {
  const el = canvasMainRef.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const vp = currentViewport.value
  return {
    x: (clientX - rect.left - vp.x) / vp.zoom,
    y: (clientY - rect.top - vp.y) / vp.zoom,
  }
}

function canvasNodeLabel(node) {
  if (!node) return ''
  if (node.data?.label) return node.data.label
  if (node.data?.entity) return node.data.entity.name || node.data.entity.location || node.id
  if (node.data?.storyboard) return node.data.storyboard.shot_title || `分镜 ${node.data.storyboard.shot_number || node.data.storyboard.id}`
  if (node.data?.episode) return node.data.episode.title || `第 ${node.data.episode.episode_number || node.data.episode.id} 集`
  return String(node.id || '未命名节点')
}


function canvasNodeActions(node) {
  if (!node) return []
  const actions = ['copy-node-ref']
  const sb = storyboardForNode(node)
  const runtimeStatus = nodeRuntimeStatus(node)
  if (nodeResultUrl(node, runtimeStatus)) {
    actions.unshift('open-node-result', 'copy-node-result')
    if (resultNodeIdFromStatus(node, runtimeStatus)) actions.unshift('focus-node-result')
  }
  if (nodeAssignedAssets(node).length) actions.unshift(
    'set-assigned-asset-first-frame',
    'set-assigned-asset-last-frame',
    'copy-node-assigned-asset-ref',
    'unbind-node-assigned-asset',
  )
  if (runtimeStatus?.savedAssetId) actions.unshift('copy-node-asset-ref')
  if (runtimeStatus?.nextStep) actions.unshift('continue-node-next-step')
  if ((runtimeStatus?.step === 'failed' && (runtimeStatus.retryStep || queueNodeRetryStep(node))) || (queueNodeFailure(node) && queueNodeRetryStep(node))) {
    actions.unshift('retry-node-failed')
  }
  if (PANEL_NODE_TYPES.has(node.type)) actions.unshift('open-node-config')
  if (node.type === 'canvasProjectAsset') {
    actions.unshift('assign-project-asset-selected')
    return [...new Set(actions)]
  }
  if (node.type === 'canvasAsset') {
    return [...new Set([...actions, 'append-downstream-storyboard', 'focus-downstream-video'])]
  }
  if (sb) {
    actions.push('focus-upstream', 'focus-downstream-video')
    actions.push('append-downstream-storyboard')
    if (node.type === 'canvasStoryboard') {
      actions.push('run-node-image', 'run-node-video', 'run-node-audio', 'preview-node-video')
      actions.push('create-workflow-from-node', 'run-node-workflow')
    } else if (node.type === 'canvasMedia') {
      if (node.data?.kind === 'image') actions.push('run-node-image', 'run-node-video')
      else if (node.data?.kind === 'video') actions.push('preview-node-video', 'run-node-video')
      else if (node.data?.kind === 'audio') actions.push('run-node-audio')
      else if (node.data?.kind === 'text' || node.data?.kind === 'universal') actions.push('run-node-image', 'run-node-video', 'run-node-audio')
    }
  }
  return [...new Set(actions)]
}

function findGraphNode(nodeId) {
  return allGraphNodes.value.find((node) => String(node.id) === String(nodeId))
}

function storyboardUsesAsset(storyboard, kind, assetId) {
  const id = Number(assetId)
  if (!storyboard || !Number.isFinite(id)) return false
  if (kind === 'character') return (storyboard.characters || []).some((item) => Number(item?.id ?? item) === id)
  if (kind === 'scene') return Number(storyboard.scene_id) === id || Number(storyboard.scene?.id) === id
  if (kind === 'prop') return (storyboard.prop_ids || storyboard.props || []).some((item) => Number(item?.id ?? item) === id)
  return false
}

function storyboardForNode(node) {
  if (node?.data?.storyboard) return node.data.storyboard
  const sbId = storyboardIdFromNodeId(node?.id)
  if (!sbId) return null
  for (const ep of drama.value?.episodes || []) {
    const sb = (ep.storyboards || []).find((item) => Number(item.id) === Number(sbId))
    if (sb) return sb
  }
  return null
}

function firstAssetNodeForStoryboard(storyboard) {
  const characterId = storyboard?.characters?.[0]?.id ?? storyboard?.characters?.[0]
  const sceneId = storyboard?.scene_id || storyboard?.scene?.id
  const propId = storyboard?.prop_ids?.[0] ?? storyboard?.props?.[0]?.id ?? storyboard?.props?.[0]
  const candidates = [
    characterId ? `char:${characterId}` : null,
    sceneId ? `scene:${sceneId}` : null,
    propId ? `prop:${propId}` : null,
  ].filter(Boolean)
  return candidates.find((id) => findGraphNode(id))
}

function firstStoryboardForAssetNode(node) {
  const match = String(node?.id || '').match(/^(char|scene|prop):(\d+)$/)
  if (!match) return null
  const kind = { char: 'character', scene: 'scene', prop: 'prop' }[match[1]]
  for (const ep of drama.value?.episodes || []) {
    const sb = (ep.storyboards || []).find((item) => storyboardUsesAsset(item, kind, match[2]))
    if (sb) return sb
  }
  return null
}

async function focusNodeOrWarn(nodeId, warning) {
  if (!findGraphNode(nodeId)) {
    ElMessage.warning(warning)
    return false
  }
  await focusCanvasNode(nodeId)
  return true
}

async function focusUpstreamAsset(node) {
  if (node?.type === 'canvasAsset') {
    await focusCanvasNode(node.id)
    setHighlightAsset(node.id)
    return
  }
  const assetNodeId = firstAssetNodeForStoryboard(storyboardForNode(node))
  if (!assetNodeId) {
    ElMessage.warning('该节点暂无可定位的上游素材')
    return
  }
  setHighlightAsset(assetNodeId)
  await focusCanvasNode(assetNodeId)
}

async function focusDownstreamVideo(node) {
  const storyboard = node?.type === 'canvasAsset' ? firstStoryboardForAssetNode(node) : storyboardForNode(node)
  const targetId = storyboard ? `sbvid:${storyboard.id}` : null
  await focusNodeOrWarn(targetId, '该节点下游暂无视频节点')
}

async function appendDownstreamStoryboard(node) {
  if (!node) return
  const sourceStoryboard = storyboardForNode(node) || (node.type === 'canvasAsset' ? firstStoryboardForAssetNode(node) : null)
  let episodeId = sourceStoryboard?.episode_id || node.data?.episodeId || filterEpisodeId.value
  if (!episodeId) {
    const eps = drama.value?.episodes || []
    if (eps.length === 1) episodeId = eps[0].id
  }
  if (!episodeId) {
    ElMessage.warning('请先选择集数，再追加下游分镜')
    return
  }

  const episode = (drama.value?.episodes || []).find((ep) => Number(ep.id) === Number(episodeId))
  const boards = episode?.storyboards || []
  const maxNum = boards.reduce((max, sb) => Math.max(max, Number(sb.storyboard_number || sb.shot_number || 0)), 0)
  const created = await storyboardsAPI.create({
    episode_id: episodeId,
    storyboard_number: maxNum + 1,
    title: `下游分镜 ${maxNum + 1}`,
    description: sourceStoryboard?.description
      ? `承接：${sourceStoryboard.description}`
      : node.type === 'canvasAsset'
        ? `围绕${canvasNodeLabel(node)}设计新分镜`
        : '',
  })
  const storyboard = created?.data ?? created
  const storyboardId = storyboard?.id ?? storyboard?.storyboard?.id
  if (!storyboardId) throw new Error('追加下游分镜失败：未返回分镜 ID')

  const targetNodeId = `sb:${storyboardId}`
  const sourcePosition = node.position || { x: 0, y: 0 }
  const targetPosition = { x: sourcePosition.x + 420, y: sourcePosition.y }
  const edge = {
    id: manualEdgeId({ source: node.id, target: targetNodeId }),
    source: node.id,
    target: targetNodeId,
    sourceHandle: null,
    targetHandle: null,
    type: 'smoothstep',
    style: { stroke: '#22d3ee', strokeWidth: 1.8, strokeDasharray: '5 5' },
    data: { manual: true },
  }

  layoutCache.value = {
    ...(layoutCache.value || { version: 1 }),
    nodes: {
      ...(layoutCache.value?.nodes || {}),
      [targetNodeId]: targetPosition,
    },
  }
  if (!hasSameEdgeConnection(edge)) {
    allGraphEdges.value = stampEdgeBaseStyles([...allGraphEdges.value, edge])
  }
  await persistCanvasState({ layoutOnly: true })
  if (filterEpisodeId.value !== episodeId) filterEpisodeId.value = episodeId
  await refreshCanvas(false)
  await focusCanvasNode(targetNodeId)
  ElMessage.success('已追加下游分镜并连线')
}

async function copyNodeReference(node) {
  const text = `${canvasNodeLabel(node)} · ${node?.id || ''}`
  await copyCanvasText(text, '节点引用已复制', '节点引用（请手动复制）')
}

async function copyCanvasText(text, successMessage, fallbackTitle) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(successMessage)
  } catch {
    ElMessageBox.alert(text, fallbackTitle, { confirmButtonText: '关闭', type: 'info' })
  }
}

function nodeRuntimeStatus(node) {
  if (!node) return null
  const direct = nodeStatus.get(String(node.id || ''))
  if (direct) return direct
  const sb = storyboardForNode(node)
  return sb?.id ? nodeStatus.get(`sb:${sb.id}`) : null
}

function nodeResultUrl(node, status = nodeRuntimeStatus(node)) {
  if (status?.savedAssetUrl) return status.savedAssetUrl
  if (status?.resultUrl) return status.resultUrl
  if (node?.data?.url) return node.data.url
  if (node?.type === 'canvasProjectAsset') return assetMediaUrl(node.data?.asset)
  return videoUrlFromNode(node)
}

function nodeInputReferenceUrls(node) {
  const targetId = String(node?.id || '')
  if (!targetId) return []
  const urls = []
  for (const edge of allGraphEdges.value) {
    if (String(edge?.target || '') !== targetId) continue
    const sourceNode = findGraphNode(edge.source)
    const url = nodeResultUrl(sourceNode)
      || (sourceNode?.type === 'canvasProjectAsset' ? assetDisplayUrl(sourceNode.data?.asset) : '')
    if (url) urls.push(url)
  }
  for (const asset of nodeAssignedAssets(node)) {
    const url = assetDisplayUrl(asset)
    if (url) urls.push(url)
  }
  return [...new Set(urls)]
}

function nodeAssignedAssets(node) {
  const fromNode = Array.isArray(node?.data?.assignedAssets) ? node.data.assignedAssets : []
  if (fromNode.length) return fromNode
  const sb = storyboardForNode(node)
  return sb?.id ? (storyboardAssignedAssets.value[Number(sb.id)] || []) : []
}

function assetReferenceText(asset) {
  if (!asset?.id) return ''
  const name = asset.name || asset.title || asset.filename || '素材'
  const url = assetDisplayUrl(asset) || asset.local_path || ''
  return `@素材(${name}#${asset.id}) ${url}`.trim()
}

function assignedAssetImagePayload(asset) {
  const localPath = asset?.local_path || asset?.image_local_path || ''
  const imageUrl = assetImageUrl(asset)
    || asset?.display_url
    || asset?.asset_url
    || asset?.preview_url
    || asset?.url
    || asset?.image_url
    || ''
  if (!localPath && !imageUrl) return null
  return {
    image_url: imageUrl,
    local_path: localPath || undefined,
  }
}

function projectAssetId(asset) {
  if (asset?.raw_id) return asset.raw_id
  const id = String(asset?.id || '')
  return id.startsWith('project:') ? id.slice('project:'.length) : id
}

function assetDisplayUrl(asset) {
  return assetMediaUrl(asset)
    || asset?.display_url
    || asset?.asset_url
    || asset?.preview_url
    || asset?.url
    || asset?.image_url
    || asset?.video_url
    || asset?.audio_url
    || ''
}

function assetLocalPath(asset) {
  return asset?.local_path
    || asset?.image_local_path
    || asset?.video_local_path
    || asset?.audio_local_path
    || asset?.voice_local_path
    || ''
}

function selectedStoryboardMediaAssetPayload(asset) {
  const type = String(asset?.type || '').toLowerCase()
  if (!['video', 'audio'].includes(type)) return null
  const url = assetDisplayUrl(asset)
  const localPath = assetLocalPath(asset)
  if (!url && !localPath) return null
  return { type, url, localPath }
}

async function ensureProjectImageAsset(asset) {
  const assetId = projectAssetId(asset)
  if (asset?.source_kind === 'project' && assetId) return { ...asset, id: assetId }
  if (!drama.value?.id) throw new Error('项目信息不完整，无法加入素材')
  const localPath = assetLocalPath(asset)
  const url = assetDisplayUrl(asset)
  if (!url && !localPath) throw new Error('该素材缺少可用媒体地址')
  return assetsAPI.create({
    drama_id: drama.value.id,
    name: asset?.name || asset?.title || asset?.filename || '素材库素材',
    type: asset?.type || 'image',
    category: 'canvas-library-pick',
    url,
    local_path: localPath || undefined,
    metadata: {
      source: 'canvas_asset_picker',
      picker_source: asset?.picker_source || asset?.source_kind || 'library',
      source_asset_id: asset?.raw_id || asset?.id || null,
      reference_text: asset?.reference_text || '',
    },
  })
}

async function placeProjectAssetNode(asset, flowPosition = null) {
  const assetId = projectAssetId(asset)
  if (!assetId) return ''
  await loadProjectImageAssets()
  const nodeId = `project-asset:${assetId}`
  if (flowPosition) {
    layoutCache.value = {
      ...(layoutCache.value || { version: 1 }),
      nodes: {
        ...(layoutCache.value?.nodes || {}),
        [nodeId]: { x: flowPosition.x, y: flowPosition.y },
      },
    }
  }
  rebuildGraph()
  focusedNodeId.value = nodeId
  await nextTick()
  if (flowPosition) await persistCanvasState({ layoutOnly: true })
  await focusCanvasNode(nodeId)
  return nodeId
}

function resultNodeIdFromStatus(node, status = nodeRuntimeStatus(node)) {
  if (status?.resultNodeId) return status.resultNodeId
  const sb = storyboardForNode(node)
  if (!sb?.id || !status?.resultType) return ''
  if (status.resultType === 'image') return `sbimg:${sb.id}`
  if (status.resultType === 'video') return `sbvid:${sb.id}`
  if (status.resultType === 'audio') return `sbaud:${sb.id}:dialogue`
  return ''
}

function openNodeResult(node) {
  const url = nodeResultUrl(node)
  if (!url) {
    ElMessage.warning('该节点暂无可打开的结果')
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function copyNodeResult(node) {
  const url = nodeResultUrl(node)
  if (!url) {
    ElMessage.warning('该节点暂无可复制的结果链接')
    return
  }
  await copyCanvasText(url, '结果链接已复制', '结果链接（请手动复制）')
}

async function copyNodeAssetReference(node) {
  const status = nodeRuntimeStatus(node)
  if (!status?.savedAssetId) {
    ElMessage.warning('该节点结果尚未存入素材库')
    return
  }
  const name = status.savedAssetName || '素材'
  const url = status.savedAssetUrl || status.resultUrl || ''
  await copyCanvasText(`@素材(${name}#${status.savedAssetId}) ${url}`.trim(), '素材引用已复制', '素材引用（请手动复制）')
}

async function copyNodeAssignedAssetReference(node) {
  const firstAsset = nodeAssignedAssets(node)[0]
  const text = assetReferenceText(firstAsset)
  if (!text) {
    ElMessage.warning('该分镜暂无指派素材')
    return
  }
  await copyCanvasText(text, '指派素材引用已复制', '指派素材引用（请手动复制）')
}

async function unbindNodeAssignedAsset(node) {
  const firstAsset = nodeAssignedAssets(node)[0]
  const assetId = projectAssetId(firstAsset)
  if (!assetId) {
    ElMessage.warning('该分镜暂无可解绑的指派素材')
    return false
  }
  await assetsAPI.update(assetId, { storyboard_id: null })
  await loadProjectImageAssets()
  rebuildGraph()
  ElMessage.success('已解绑当前分镜素材')
  return true
}

async function setNodeAssignedAssetFrame(node, frameType) {
  const sb = storyboardForNode(node)
  const firstAsset = nodeAssignedAssets(node)[0]
  const payload = assignedAssetImagePayload(firstAsset)
  if (!sb?.id || !drama.value?.id || !payload) {
    ElMessage.warning('该分镜暂无可回填的指派素材')
    return false
  }
  const label = frameType === 'storyboard_last' ? '尾帧' : '首帧'
  await imagesAPI.upload({
    storyboard_id: sb.id,
    drama_id: drama.value.id,
    frame_type: frameType,
    ...payload,
  })
  await refreshDrama(true)
  ElMessage.success(`已将指派素材设为${label}`)
  return true
}

async function assignProjectAssetToSelectedStoryboard(asset, options = {}) {
  const silent = options.silent === true
  const returnDetail = options.returnDetail === true
  const fail = (message) => {
    if (!silent) ElMessage.warning(message)
    return returnDetail ? { ok: false, message } : false
  }
  const success = (message = '已指派素材到选中分镜') => returnDetail ? { ok: true, message } : true
  const selectedIds = selectedStoryboardIds.value.map(Number).filter(Number.isFinite)
  if (selectedIds.length !== 1) {
    return fail(selectedIds.length ? '请只选中一个分镜后再指派素材' : '请先选中一个分镜')
  }
  const assetId = projectAssetId(asset)
  if (!drama.value?.id || !assetId) {
    return fail(!assetId ? '素材信息不完整，无法指派' : '缺少项目 ID，无法指派素材')
  }
  const storyboardId = selectedIds[0]
  const mediaPayload = selectedStoryboardMediaAssetPayload(asset)
  let resultMessage = '已指派素材到选中分镜'
  await assetsAPI.update(assetId, { drama_id: drama.value.id, storyboard_id: storyboardId })
  if (mediaPayload?.type === 'video') {
    await videosAPI.attach({
      storyboard_id: storyboardId,
      drama_id: drama.value.id,
      video_url: mediaPayload.url,
      local_path: mediaPayload.localPath || undefined,
      duration: asset?.duration ?? undefined,
    })
    resultMessage = '已指派素材并设为分镜成片'
    await refreshDrama(true)
  } else if (mediaPayload?.type === 'audio') {
    await storyboardsAPI.update(storyboardId, {
      audio_local_path: mediaPayload.localPath || undefined,
      audio_url: mediaPayload.localPath ? undefined : mediaPayload.url,
    })
    resultMessage = '已指派素材并设为分镜音频'
    await refreshDrama(true)
  } else {
    await loadProjectImageAssets()
    rebuildGraph()
  }
  await focusCanvasNode(`sb:${storyboardId}`)
  ElMessage.success(resultMessage)
  return success(resultMessage)
}

async function runCanvasProjectAssetNodeStep(node, step) {
  if (step !== 'library') {
    ElMessage.warning('该项目素材节点暂不支持该操作')
    return
  }
  const nodeId = String(node?.id || '')
  const asset = node?.data?.asset
  const assetId = projectAssetId(asset)
  const resultUrl = assetDisplayUrl(asset)
  const retryPayload = {
    retryStep: 'library',
    retryLabel: '重试指派素材',
    resultUrl,
    resultType: asset?.type || 'image',
    savedAssetId: assetId,
    savedAssetName: asset?.name || '项目素材',
    autoClear: false,
  }
  if (!nodeId) return
  nodeStatus.set(nodeId, {
    step: 'library',
    message: '指派素材到分镜中…',
    ...retryPayload,
  })
  try {
    const result = await assignProjectAssetToSelectedStoryboard(asset, { silent: true, returnDetail: true })
    if (!result?.ok) throw new Error(result?.message || '素材未指派，请选中一个分镜后重试')
    nodeStatus.success(nodeId, {
      message: '已指派素材到选中分镜',
      ...retryPayload,
    })
  } catch (error) {
    const message = error?.message || '素材指派失败'
    nodeStatus.fail(nodeId, {
      message,
      errorDetail: message,
      ...retryPayload,
    })
    ElMessage.error(message)
  }
}

function openCanvasAssetLibrary(flowPosition = null) {
  canvasAssetPickerFlowPos.value = flowPosition
  canvasAssetPickerVisible.value = true
}

async function onCanvasAssetLibraryPick(asset) {
  let nodeId = ''
  let projectAsset = null
  try {
    projectAsset = await ensureProjectImageAsset(asset)
    nodeId = await placeProjectAssetNode(projectAsset, canvasAssetPickerFlowPos.value)
    if (selectedStoryboardIds.value.length === 1) {
      await assignProjectAssetToSelectedStoryboard(projectAsset)
    } else {
      ElMessage.success(nodeId ? '已从素材库加入画布' : '素材已加入项目素材库')
    }
    if (nodeId) {
      nodeStatus.success(nodeId, {
        message: selectedStoryboardIds.value.length === 1 ? '已加入画布并指派到分镜' : '已从素材库加入画布',
        resultUrl: assetDisplayUrl(projectAsset),
        resultType: projectAsset?.type || asset?.type || 'image',
        savedAssetId: projectAssetId(projectAsset),
        savedAssetName: projectAsset?.name || asset?.name || '项目素材',
        savedAssetUrl: assetDisplayUrl(projectAsset),
        retryStep: 'library',
        retryLabel: '重新指派素材',
        autoClear: false,
      })
    }
  } catch (e) {
    if (nodeId) {
      const message = e?.message || '素材库素材加入画布失败'
      nodeStatus.fail(nodeId, {
        message,
        errorDetail: message,
        resultUrl: projectAsset ? assetDisplayUrl(projectAsset) : '',
        resultType: projectAsset?.type || asset?.type || 'image',
        savedAssetId: projectAsset ? projectAssetId(projectAsset) : '',
        savedAssetName: projectAsset?.name || asset?.name || '项目素材',
        retryStep: 'library',
        retryLabel: '重试指派素材',
        autoClear: false,
      })
    }
    ElMessage.error(e?.message || '素材库素材加入画布失败')
  } finally {
    canvasAssetPickerFlowPos.value = null
  }
}

async function focusNodeResult(node) {
  const resultNodeId = resultNodeIdFromStatus(node)
  if (!resultNodeId) {
    ElMessage.warning('该节点暂无可定位的结果节点')
    return
  }
  await focusNodeOrWarn(resultNodeId, '该节点暂无可定位的结果节点')
}

async function retryFailedNode(node) {
  const status = nodeRuntimeStatus(node)
  const retryStep = status?.retryStep || queueNodeRetryStep(node)
  if (!retryStep) {
    ElMessage.warning('该节点暂无可重试步骤')
    return
  }
  await focusCanvasNode(node.id)
  await runCanvasNodeStep(node, retryStep)
}

async function continueNodeNextStep(node) {
  const status = nodeRuntimeStatus(node)
  if (!status?.nextStep) {
    ElMessage.warning('该节点暂无可继续的下游步骤')
    return
  }
  await focusCanvasNode(node.id)
  await runCanvasNodeStep(node, status.nextStep)
}


function nodeStepStatusLabel(step, node) {
  if (step === 'image' && node?.data?.frameKind === 'first') return '首帧生成中…'
  if (step === 'image' && node?.data?.frameKind === 'last') return '尾帧生成中…'
  if (step === 'link_tail_frame') return '尾帧衔接中…'
  return CANVAS_NODE_STATUS_LABELS[step] || '处理中…'
}

function nodeStepResultUrl(node, step, storyboard) {
  const nodeUrl = node?.data?.url || ''
  if (nodeUrl) return nodeUrl
  if (!storyboard) return ''
  if (step === 'image') {
    const frameKind = node?.data?.frameKind
    if (frameKind === 'first') return imageRecordUrl(resolveSbFirstImageRecord(storyboard, imagesBySbId.value))
    if (frameKind === 'last') return imageRecordUrl(resolveSbLastImageRecord(storyboard, imagesBySbId.value))
    return imageRecordUrl(resolveSbMainImageRecord(storyboard, imagesBySbId.value))
  }
  if (step === 'video') return videoRecordUrl(resolveSbVideoRecord(storyboard, videosBySbId.value))
  if (step === 'audio') return audioUrl(storyboard.audio_local_path || storyboard.audio_url || '')
  return ''
}

function videoNodeNextAction(storyboard) {
  const fallback = { nextStep: 'audio', nextLabel: '继续配音' }
  if (!drama.value || !storyboard?.id) return fallback
  const found = findStoryboardInDrama(drama.value, storyboard.id)
  const current = found?.storyboard || storyboard
  const { next } = found?.episode ? getAdjacentStoryboards(found.episode, current.id) : {}
  if (next && canChainStoryboardFrames(next, current)) {
    return { nextStep: 'link_tail_frame', nextLabel: '尾帧衔接' }
  }
  return fallback
}

function nodeStepResultInfo(node, step, storyboardId, storyboard = null) {
  const id = String(node?.id || '')
  const frameKind = node?.data?.frameKind
  const resultNodeId = step === 'image'
    ? (frameKind ? `sbimg-${frameKind}:${storyboardId}` : (id.startsWith('sbimg') ? id : `sbimg:${storyboardId}`))
    : step === 'video'
      ? (id.startsWith('sbvid:') ? id : `sbvid:${storyboardId}`)
      : step === 'audio'
        ? (id.startsWith('sbaud:') ? id : `sbaud:${storyboardId}:dialogue`)
        : id
  const resultNode = findGraphNode(resultNodeId) || findGraphNode(id) || node
  const resultType = step === 'audio' ? 'audio' : step === 'link_tail_frame' ? 'text' : step
  const labelMap = { image: '图片已生成', video: '视频已生成', audio: '音频已生成', text: '尾帧衔接完成' }
  const nextMap = {
    image: { nextStep: 'video', nextLabel: '继续生成视频' },
    video: videoNodeNextAction(storyboard),
  }
  return {
    resultUrl: nodeStepResultUrl(resultNode, step, storyboard),
    resultNodeId,
    resultType,
    resultLabel: labelMap[resultType] || '结果已生成',
    ...(nextMap[resultType] || {}),
  }
}

function resultLocalPathFromUrl(url) {
  const value = String(url || '')
  const marker = '/static/'
  const index = value.indexOf(marker)
  if (index < 0) return ''
  return value.slice(index + marker.length).split(/[?#]/)[0] || ''
}

function nodeResultAssetName(node, resultInfo) {
  const label = node?.data?.label || node?.data?.title || resultInfo?.resultLabel || '节点结果'
  const filename = String(resultInfo?.resultUrl || '').split(/[?#]/)[0].split('/').pop()
  return filename ? `${label}-${filename}` : label
}

async function saveNodeResultAsset(node, resultInfo, promptText, storyboardId) {
  if (!resultInfo?.resultUrl || !drama.value?.id) return null
  try {
    const asset = await assetsAPI.create({
      drama_id: drama.value.id,
      storyboard_id: storyboardId,
      name: nodeResultAssetName(node, resultInfo),
      type: resultInfo.resultType || 'image',
      category: 'canvas-result',
      url: resultInfo.resultUrl,
      local_path: resultLocalPathFromUrl(resultInfo.resultUrl) || undefined,
      metadata: {
        source: 'canvas_node_result',
        canvas_node_id: node?.id || '',
        result_label: resultInfo.resultLabel || '',
        prompt_text: promptText || '',
        auto_saved: true,
      },
    })
    if (!asset?.id) return null
    return {
      savedAssetId: asset.id,
      savedAssetName: asset.name || nodeResultAssetName(node, resultInfo),
      savedAssetUrl: asset.url || resultInfo.resultUrl,
      savedAssetLocalPath: asset.local_path || '',
      savedAssetDuration: asset.duration ?? null,
    }
  } catch (error) {
    console.warn('auto save canvas node result asset failed', error)
    return null
  }
}

function nodeStepPromptText(step, sb, node) {
  if (!sb) return ''
  if (step === 'image') {
    const frameKind = node?.data?.frameKind
    if (frameKind === 'last') return sb.video_prompt || sb.result || sb.action || sb.description || ''
    return sb.polished_prompt || sb.image_prompt || sb.description || sb.action || ''
  }
  if (step === 'video') return sb.video_prompt || sb.polished_prompt || sb.image_prompt || sb.description || ''
  if (step === 'audio') return sb.dialogue || ''
  return ''
}

async function linkStoryboardTailFrameFromNode(storyboard) {
  if (!drama.value?.id || !storyboard?.id) throw new Error('项目信息不完整，无法尾帧衔接')
  const found = findStoryboardInDrama(drama.value, storyboard.id)
  const current = found?.storyboard || storyboard
  const { next } = getAdjacentStoryboards(found?.episode, current.id)
  if (!next) throw new Error('当前分镜没有下一镜，无法尾帧衔接')
  if (!canChainStoryboardFrames(next, current)) throw new Error('跨场景不自动锁定尾帧')
  const result = await storyboardsAPI.linkTailFrame(current.id, { drama_id: drama.value.id })
  return { nextStoryboardId: result?.next_storyboard_id || next.id }
}

function shouldKeepNodeStatus(nodeId) {
  return ['failed', 'success'].includes(nodeStatus.get(nodeId)?.step)
}

function nodeStepStatusIds(node, step, storyboardId) {
  return [...new Set([
    node?.id,
    `sb:${storyboardId}`,
    nodeStepResultInfo(node, step, storyboardId).resultNodeId,
  ].filter(Boolean))]
}

function setNodeStepStatus(statusIds, payload) {
  statusIds.forEach((id) => nodeStatus.set(id, payload))
}

function successNodeStepStatus(statusIds, payload) {
  statusIds.forEach((id) => nodeStatus.success(id, payload))
}

function failNodeStepStatus(statusIds, payload) {
  statusIds.forEach((id) => nodeStatus.fail(id, payload))
}

function clearTransientNodeStepStatus(statusIds) {
  statusIds.forEach((id) => {
    if (!shouldKeepNodeStatus(id)) nodeStatus.clear(id)
  })
}

function nodeStepTaskStatusOptions(statusIds, basePayload) {
  return {
    onTask(task) {
      setNodeStepStatus(statusIds, {
        ...basePayload,
        taskId: task?.taskId || '',
        message: `${basePayload.message || '处理中…'} · 任务已创建`,
      })
    },
    onPoll(task) {
      setNodeStepStatus(statusIds, {
        ...basePayload,
        taskId: task?.id || task?.task_id || basePayload.taskId || '',
        progress: task?.progress ?? null,
        message: task?.message || task?.status_message || basePayload.message,
      })
    },
  }
}

async function runCanvasNodeStep(node, step) {
  if (node?.type === 'canvasProjectAsset') {
    await runCanvasProjectAssetNodeStep(node, step)
    return
  }
  if (node?.type === 'canvasAsset') {
    await runCanvasAssetNodeStep(node, step)
    return
  }

  const sb = storyboardForNode(node)
  if (!drama.value || !sb?.id) {
    ElMessage.warning('该节点没有绑定分镜，无法执行生成')
    return
  }
  const nodeId = node?.id
  const statusIds = nodeStepStatusIds(node, step, sb.id)
  const runKey = `storyboard:${sb.id}:${step}:${Date.now()}`
  const statusMessage = nodeStepStatusLabel(step, node)
  const initialPromptText = nodeStepPromptText(step, sb, node)
  const upstreamReferenceUrlsForNode = nodeInputReferenceUrls(node)
  const baseStatusPayload = {
    step,
    message: statusMessage,
    promptText: initialPromptText,
    runKey,
    sourceNodeId: nodeId,
    upstreamReferenceUrls: upstreamReferenceUrlsForNode,
  }
  setNodeStepStatus(statusIds, baseStatusPayload)
  try {
    const found = findStoryboardInDrama(drama.value, sb.id)
    const latestSb = found?.storyboard || sb
    const promptText = nodeStepPromptText(step, latestSb, node)
    const taskStatusOptions = nodeStepTaskStatusOptions(statusIds, { ...baseStatusPayload, promptText })
    setNodeStepStatus(statusIds, { ...baseStatusPayload, promptText })
    const genOpts = {
      ...getCanvasGenerationOptions(),
      upstreamReferenceUrls: upstreamReferenceUrlsForNode,
    }
    let operationResult = null
    if (step === 'image') await runImageStep(drama.value, latestSb, genOpts, node?.data?.frameKind || '', taskStatusOptions)
    else if (step === 'video') await runVideoStep(drama.value, latestSb, genOpts, taskStatusOptions)
    else if (step === 'audio') {
      const res = await runAudioStep(latestSb)
      if (res?.skipped) {
        ElMessage.info(res.reason || '已跳过')
        return
      }
      operationResult = res
    }
    else if (step === 'link_tail_frame') operationResult = await linkStoryboardTailFrameFromNode(latestSb)
    else throw new Error(`暂不支持该节点步骤：${step}`)
    ElMessage.success(step === 'link_tail_frame' ? '尾帧衔接完成' : '节点生成完成')
    await refreshDrama(true)
    const refreshed = findStoryboardInDrama(drama.value, sb.id)
    const refreshedSb = refreshed?.storyboard || latestSb
    const resultInfo = { ...nodeStepResultInfo(node, step, sb.id, refreshedSb), ...(operationResult || {}), promptText }
    const savedAssetInfo = await saveNodeResultAsset(node, resultInfo, promptText, sb.id)
    if (savedAssetInfo && resultInfo.resultType === 'image') await loadProjectImageAssets()
    const successPayload = { ...resultInfo, ...(savedAssetInfo || {}), runKey, sourceNodeId: nodeId, autoClear: false }
    successNodeStepStatus(statusIds, successPayload)
    if (nodeId) await focusCanvasNode(nodeId)
  } catch (e) {
    const errorMessage = e?.message || '节点生成失败'
    const retryPayload = {
      message: errorMessage,
      errorDetail: errorMessage,
      promptText: nodeStepPromptText(step, sb, node),
      retryStep: step,
      retryLabel: `重试${nodeStepStatusLabel(step, node).replace(/中…$/, '')}`,
      runKey,
      sourceNodeId: nodeId,
      upstreamReferenceUrls: upstreamReferenceUrlsForNode,
    }
    failNodeStepStatus(statusIds, retryPayload)
    ElMessage.error(errorMessage)
    await refreshDrama(true)
  } finally {
    clearTransientNodeStepStatus(statusIds)
  }
}

async function runCanvasAssetNodeStep(node, step) {
  if (step !== 'ref_image') {
    ElMessage.warning('该素材节点暂不支持该操作')
    return
  }
  const entity = node?.data?.entity
  const kind = node?.data?.kind
  if (!entity?.id || !kind) {
    ElMessage.warning('该素材节点缺少素材信息，无法执行生成')
    return
  }
  try {
    await generateAssetReferenceImage(
      { nodeStatus, drama, refreshDrama, refresh: refreshCanvas },
      { kind, entity, nodeId: node.id }
    )
    ElMessage.success('素材参考图已生成')
    await refreshDrama(true)
    await focusCanvasNode(node.id)
  } catch (e) {
    ElMessage.error(e?.message || '素材参考图生成失败')
    await refreshDrama(true)
  }
}

function videoUrlFromNode(node) {
  if (node?.data?.url) return node.data.url
  const localPath = node?.data?.videoRecord?.local_path
  if (localPath) return `/static/${String(localPath).replace(/^\/+/, '')}`
  if (node?.data?.videoRecord?.video_url) return node.data.videoRecord.video_url
  const sb = storyboardForNode(node)
  const videoNode = sb?.id ? findGraphNode(`sbvid:${sb.id}`) : null
  if (!videoNode || videoNode === node) return ''
  return videoUrlFromNode(videoNode)
}

function previewNodeVideo(node) {
  const url = videoUrlFromNode(node)
  if (!url) {
    ElMessage.warning('该视频节点暂无可预览地址')
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function createWorkflowFromNode(node) {
  const storyboard = storyboardForNode(node)
  const storyboardId = Number(storyboard?.id)
  if (!Number.isFinite(storyboardId)) {
    ElMessage.warning('只有分镜节点可以创建工作流')
    return
  }
  const selectedIds = selectedStoryboardIds.value.map(Number)
  if (!selectedIds.includes(storyboardId)) applySelectedStoryboardIds([storyboardId])
  await onCreateWorkflowGroup()
}

async function runWorkflowFromNode(node) {
  const storyboard = storyboardForNode(node)
  const storyboardId = Number(storyboard?.id)
  if (!Number.isFinite(storyboardId)) {
    ElMessage.warning('只有分镜节点可以运行工作流')
    return
  }
  const containingGroups = workflowGroups.value.filter((group) => (
    (group.storyboard_ids || []).map(Number).includes(storyboardId)
  ))
  if (!containingGroups.length) {
    ElMessage.warning('该分镜尚未加入工作流，请先创建工作流')
    return
  }
  if (!activeGroupId.value || !containingGroups.some((group) => group.id === activeGroupId.value)) {
    activeGroupId.value = containingGroups[0].id
  }
  await onRunActiveGroup()
}

async function runNodeMenuAction(type, node) {
  if (type === 'open-node-config') {
    openNodeConfig(node)
  } else if (type === 'open-node-result') {
    openNodeResult(node)
  } else if (type === 'copy-node-result') {
    await copyNodeResult(node)
  } else if (type === 'copy-node-asset-ref') {
    await copyNodeAssetReference(node)
  } else if (type === 'copy-node-assigned-asset-ref') {
    await copyNodeAssignedAssetReference(node)
  } else if (type === 'unbind-node-assigned-asset') {
    await unbindNodeAssignedAsset(node)
  } else if (type === 'set-assigned-asset-first-frame') {
    await setNodeAssignedAssetFrame(node, 'storyboard_first')
  } else if (type === 'set-assigned-asset-last-frame') {
    await setNodeAssignedAssetFrame(node, 'storyboard_last')
  } else if (type === 'assign-project-asset-selected') {
    await runCanvasNodeStep(node, 'library')
  } else if (type === 'focus-node-result') {
    await focusNodeResult(node)
  } else if (type === 'retry-node-failed') {
    await retryFailedNode(node)
  } else if (type === 'continue-node-next-step') {
    await continueNodeNextStep(node)
  } else if (type === 'run-node-image') {
    await runCanvasNodeStep(node, 'image')
  } else if (type === 'run-node-video') {
    await runCanvasNodeStep(node, 'video')
  } else if (type === 'run-node-audio') {
    await runCanvasNodeStep(node, 'audio')
  } else if (type === 'preview-node-video') {
    previewNodeVideo(node)
  } else if (type === 'focus-upstream') {
    await focusUpstreamAsset(node)
  } else if (type === 'focus-downstream-video') {
    await focusDownstreamVideo(node)
  } else if (type === 'append-downstream-storyboard') {
    await appendDownstreamStoryboard(node)
  } else if (type === 'copy-node-ref') {
    await copyNodeReference(node)
  } else if (type === 'create-workflow-from-node') {
    await createWorkflowFromNode(node)
  } else if (type === 'run-node-workflow') {
    await runWorkflowFromNode(node)
  }
}

function openNodeConfig(node) {
  if (!node) return
  if (PANEL_NODE_TYPES.has(node.type)) {
    focusedNodeId.value = node.id
    scheduleVirtualization()
    return
  }
  onNodeDoubleClick({ node })
}

function onPaneContextMenu(payload) {
  const event = payload?.event || payload
  if (event?.preventDefault) event.preventDefault()
  const flowPos = payload?.flowPosition || screenToFlowPosition(event.clientX, event.clientY)
  contextMenuFlowPos.value = flowPos
  contextMenuNode.value = null
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuVisible.value = true
}

function onNodeContextMenu(payload) {
  const event = payload?.event || payload
  if (event?.preventDefault) event.preventDefault()
  event?.stopPropagation?.()
  contextMenuNode.value = payload?.node || null
  contextMenuFlowPos.value = contextMenuNode.value?.position || screenToFlowPosition(event.clientX, event.clientY)
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuVisible.value = true
}

function closeContextMenu() {
  contextMenuVisible.value = false
  contextMenuFlowPos.value = null
  contextMenuNode.value = null
}

function clearCanvasInteractionState() {
  closeContextMenu()
  focusedNodeId.value = null
  activeGroupId.value = null
  applySelectedStoryboardIds([])
}

async function onContextMenuSelect(type) {
  const node = contextMenuNode.value
  if (node) {
    closeContextMenu()
    await runNodeMenuAction(type, node)
    return
  }
  const flowPosition = contextMenuFlowPos.value
  if (type === 'focus-script') {
    closeContextMenu()
    await focusScriptNode(flowPosition)
    return
  }
  if (type === 'open-media-library') {
    closeContextMenu()
    openCanvasAssetLibrary(flowPosition)
    return
  }
  pendingFlowPosition.value = flowPosition
  openCreateDialog(type, flowPosition)
  closeContextMenu()
}

async function onCreateSubmit(form) {
  try {
    await submitCreate(form)
  } catch (e) {
    ElMessage.error(e?.message || '创建失败')
  }
}

function getCanvasGenerationOptions() {
  return {
    ...getDramaGenerationOptions(drama.value),
    ...generationOverrides.value,
    imagesBySbId: imagesBySbId.value,
  }
}

let generationSaveTimer = null
function updateGenerationOptions(patch = {}) {
  generationOverrides.value = { ...generationOverrides.value, ...patch }
  const current = getCanvasGenerationOptions()
  if (drama.value) {
    const metadata = parseDramaMetadata(drama.value.metadata) || {}
    const nextMetadata = {
      ...metadata,
      aspect_ratio: current.aspectRatio || '16:9',
      video_resolution: current.videoResolution || '480p',
    }
    if (Object.hasOwn(patch, 'imageModel')) nextMetadata.image_model = current.imageModel || null
    if (Object.hasOwn(patch, 'videoModel')) nextMetadata.video_model = current.videoModel || null
    drama.value = { ...drama.value, metadata: nextMetadata }
  }
  if (generationSaveTimer) clearTimeout(generationSaveTimer)
  generationSaveTimer = setTimeout(async () => {
    generationSaveTimer = null
    if (!dramaId.value) return
    const metadata = parseDramaMetadata(drama.value?.metadata) || {}
    try {
      await dramaAPI.saveOutline(dramaId.value, { metadata })
    } catch (e) {
      ElMessage.error(e?.message || '生成参数保存失败')
    }
  }, 450)
}

const scriptActionsHolder = {}

provide(CANVAS_CONTEXT_KEY, {
  focusedNodeId,
  currentViewport,
  drama,
  imagesBySbId,
  videosBySbId,
  generationOptions: computed(() => getCanvasGenerationOptions()),
  updateGenerationOptions,
  getGenerationOptions: getCanvasGenerationOptions,
  setFocusedNode: (nodeId) => {
    focusedNodeId.value = nodeId
  },
  clearFocusedNode: () => {
    focusedNodeId.value = null
  },
  setHighlightAsset,
  refresh: refreshCanvas,
  refreshDrama,
  refreshProjectAssets: async () => {
    await loadProjectImageAssets()
    rebuildGraph()
  },
  suppressPaneClick,
  nodeStatus,
  openCreateDialog: (...args) => openCreateDialog(...args),
  scriptActions: scriptActionsHolder,
  registerCanvasFlowApi: (api) => {
    canvasFlowApi.value = api
  },
  sidebarVisible,
  showWorkflowPanel,
  directorStageVisible,
  canUndo,
  canRedo,
  openDirectorStage,
  toggleSidebar,
  toggleWorkflowPanel,
  focusScript: focusScriptNode,
  goListMode,
  toggleTheme,
  alignNodes: onAlignNodes,
  fitCanvasView,
  focusCanvasNode,
  findCanvasNode: findGraphNode,
  undoCanvas,
  redoCanvas,
  zoomIn: () => canvasFlowApi.value?.zoomIn?.({ duration: 180 }),
  zoomOut: () => canvasFlowApi.value?.zoomOut?.({ duration: 180 }),
  showCanvasHelp,
  selectStoryboard: (storyboardId, event) => selectStoryboard(storyboardId, event),
  assignProjectAssetToSelectedStoryboard,
  runNodeStep: runCanvasNodeStep,
})

function clearAssetHighlight() {
  highlightAssetId.value = null
  applyHighlight()
}

function applySelectedStoryboardIds(ids = []) {
  const normalizedIds = [...new Set(ids.map(Number).filter(Number.isFinite))]
  selectedStoryboardIds.value = normalizedIds
  const selectedIds = new Set(normalizedIds)
  allGraphNodes.value = allGraphNodes.value.map((node) => {
    if (node.type !== 'canvasStoryboard') return node
    return { ...node, selected: selectedIds.has(Number(node.data?.storyboard?.id)) }
  })
  nodes.value = nodes.value.map((node) => {
    if (node.type !== 'canvasStoryboard') return node
    return { ...node, selected: selectedIds.has(Number(node.data?.storyboard?.id)) }
  })

  if (!normalizedIds.length) {
    activeGroupId.value = null
    return
  }

  const containingGroups = workflowGroups.value.filter((group) => {
    const groupIds = new Set((group.storyboard_ids || []).map(Number))
    return normalizedIds.every((id) => groupIds.has(Number(id)))
  })
  if (containingGroups.length === 1 && (normalizedIds.length > 1 || !activeGroupId.value)) {
    activeGroupId.value = containingGroups[0].id
  } else if (normalizedIds.length > 1 && containingGroups.length !== 1) {
    activeGroupId.value = null
  }
}

function onNodesChange(changes = []) {
  const selectionChanges = changes.filter((change) => change?.type === 'select')
  if (!selectionChanges.length) return

  const selectedIds = new Set(selectedStoryboardIds.value.map(Number))
  for (const change of selectionChanges) {
    const storyboardId = storyboardIdFromNodeId(change.id)
    if (!storyboardId) continue
    if (change.selected) selectedIds.add(Number(storyboardId))
    else selectedIds.delete(Number(storyboardId))
  }
  applySelectedStoryboardIds([...selectedIds])
}

function manualEdgeId(connection) {
  return [
    'manual',
    connection.source,
    connection.sourceHandle || 'out',
    connection.target,
    connection.targetHandle || 'in',
  ].join(':')
}

function hasSameEdgeConnection(candidate, edgeList = allGraphEdges.value) {
  return edgeList.some((edge) => (
    String(edge.source) === String(candidate.source)
    && String(edge.target) === String(candidate.target)
    && String(edge.sourceHandle || '') === String(candidate.sourceHandle || '')
    && String(edge.targetHandle || '') === String(candidate.targetHandle || '')
  ))
}

function onConnect(connection) {
  if (!connection?.source || !connection?.target) return
  if (String(connection.source) === String(connection.target)) {
    ElMessage.warning('不能连接到同一个节点')
    return
  }
  if (hasSameEdgeConnection(connection)) {
    ElMessage.info('该连线已存在')
    return
  }

  const edge = {
    id: manualEdgeId(connection),
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle || null,
    targetHandle: connection.targetHandle || null,
    type: 'smoothstep',
    style: { stroke: '#22d3ee', strokeWidth: 1.8, strokeDasharray: '5 5' },
    data: { manual: true },
  }
  allGraphEdges.value = stampEdgeBaseStyles([...allGraphEdges.value, edge])
  applyVirtualizedGraph()
  scheduleLayoutSave()
  ElMessage.success('已添加画布连线')
}

function onEdgesChange(changes = []) {
  const removedManualIds = changes
    .filter((change) => change?.type === 'remove' && String(change.id || '').startsWith('manual:'))
    .map((change) => String(change.id))
  if (!removedManualIds.length) return

  const removed = new Set(removedManualIds)
  allGraphEdges.value = allGraphEdges.value.filter((edge) => !removed.has(String(edge.id)))
  applyVirtualizedGraph()
  scheduleLayoutSave()
}

function selectStoryboard(storyboardId, event) {
  const normalizedId = Number(storyboardId)
  if (!Number.isFinite(normalizedId)) return
  const selectedIds = new Set(selectedStoryboardIds.value.map(Number))
  if (event?.ctrlKey || event?.metaKey) {
    if (selectedIds.has(normalizedId)) selectedIds.delete(normalizedId)
    else selectedIds.add(normalizedId)
  } else {
    selectedIds.clear()
    selectedIds.add(normalizedId)
  }
  applySelectedStoryboardIds([...selectedIds])
}

function selectWorkflowGroup(groupId) {
  activeGroupId.value = groupId || null
  const group = workflowGroups.value.find((item) => item.id === groupId)
  const storyboardIds = group
    ? (group.storyboard_ids || []).map(Number).filter((id) => allGraphNodes.value.some(
      (node) => node.type === 'canvasStoryboard' && Number(node.data?.storyboard?.id) === id,
    ))
    : []
  const selectedIds = new Set(storyboardIds)
  selectedStoryboardIds.value = storyboardIds
  allGraphNodes.value = allGraphNodes.value.map((node) => {
    if (node.type !== 'canvasStoryboard') return node
    return {
      ...node,
      selected: selectedIds.has(Number(node.data?.storyboard?.id)),
    }
  })
  applyVirtualizedGraph()
}

function onViewportChange(viewport) {
  currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
  scheduleVirtualization()
}

function onCanvasWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  event.stopPropagation()
  if (event.deltaY < 0) canvasFlowApi.value?.zoomIn?.({ duration: 0 })
  if (event.deltaY > 0) canvasFlowApi.value?.zoomOut?.({ duration: 0 })
}

function toggleSidebar() {
  sidebarVisible.value = !sidebarVisible.value
}

function toggleWorkflowPanel() {
  showWorkflowPanel.value = !showWorkflowPanel.value
}

async function shareCanvas() {
  const url = window.location.href
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: `${drama.value?.title || '短剧'} · 画布`,
        url,
      })
      ElMessage.success('分享面板已打开')
      return
    } catch (error) {
      // 用户主动关闭系统分享面板时不再弹出复制失败提示。
      if (error?.name === 'AbortError') return
    }
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(url)
    ElMessage.success('画布链接已复制')
  } catch {
    ElMessageBox.alert(url, '画布链接（请手动复制）', {
      confirmButtonText: '关闭',
      type: 'info',
    })
  }
}

async function fitCanvasView() {
  const api = canvasFlowApi.value
  if (!api?.fitView) return
  await api.fitView({ padding: 0.14, duration: 250, includeHiddenNodes: false })
  const viewport = api.getViewport?.()
  if (viewport) {
    currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    scheduleVirtualization()
  }
}

async function focusCanvasNode(nodeId) {
  if (!nodeId) return
  focusedNodeId.value = nodeId
  scheduleVirtualization()
  await nextTick()
  const api = canvasFlowApi.value
  if (!api?.fitView) return
  await api.fitView({ nodes: [{ id: nodeId }], padding: 0.55, duration: 320, includeHiddenNodes: false })
  const viewport = api.getViewport?.()
  if (viewport) {
    currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    scheduleVirtualization()
  }
}

function showCanvasHelp() {
  ElMessageBox.alert(
    [
      '空格 + 鼠标左键拖动：平移画布',
      '普通滚轮：上下滚动画布',
      'Ctrl/⌘ + 滚轮：放大或缩小画布',
      '拖动画布空白区域：框选节点',
      'Ctrl/⌘ + 点击：多选节点',
      'Ctrl/⌘ + G：将已选分镜创建为工作流',
      'Esc：清空选择、焦点和右键菜单',
      '右键画布：添加节点',
      '双击节点：打开对应制作入口',
    ].join('\n'),
    '画布操作指南',
    { confirmButtonText: '知道了', type: 'info' },
  )
}

function scheduleLayoutSave() {
  layoutDirty.value = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistCanvasState({ layoutOnly: true })
  }, 700)
}

function onNodeDragStart() {
  syncRenderedNodesToGraph()
  dragHistorySnapshot.value = currentInteractionState()
}

function onNodeDragStop() {
  syncRenderedNodesToGraph()
  if (dragHistorySnapshot.value) commitInteractionHistory(dragHistorySnapshot.value)
  dragHistorySnapshot.value = null
  scheduleLayoutSave()
}

function isEditableTarget(target) {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable))
}

function setSpacePanning(active) {
  spacePanning.value = active
}

function undoCanvas() {
  const next = undoCanvasInteractionHistory(interactionHistory.value)
  if (next === interactionHistory.value) return
  interactionHistory.value = next
  applyInteractionState(next.present)
  ElMessage.info('已撤销画布布局操作')
}

function redoCanvas() {
  const next = redoCanvasInteractionHistory(interactionHistory.value)
  if (next === interactionHistory.value) return
  interactionHistory.value = next
  applyInteractionState(next.present)
  ElMessage.info('已重做画布布局操作')
}

function onCanvasKeydown(event) {
  if (isEditableTarget(event.target)) return
  const key = String(event.key || '').toLowerCase()
  if (key === 'escape' || key === 'esc') {
    event.preventDefault()
    clearCanvasInteractionState()
    return
  }
  if (key === ' ' || key === 'spacebar') {
    event.preventDefault()
    setSpacePanning(true)
    return
  }
  const modifier = event.ctrlKey || event.metaKey
  if (!modifier || event.altKey) return
  if (key === 'g') {
    event.preventDefault()
    void onCreateWorkflowGroup()
    return
  }
  if (key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redoCanvas()
    else undoCanvas()
  } else if (key === 'y') {
    event.preventDefault()
    redoCanvas()
  }
}

function onCanvasKeyup(event) {
  const key = String(event.key || '').toLowerCase()
  if (key === ' ' || key === 'spacebar') {
    event.preventDefault()
    setSpacePanning(false)
  }
}

function onCanvasBlur() {
  setSpacePanning(false)
}

async function persistCanvasState({ layoutOnly = false, groupsOnly = false } = {}) {
  if (!dramaId.value) return

  let layoutPayload = null
  if (!groupsOnly) {
    syncRenderedNodesToGraph()
    layoutPayload = buildCanvasLayoutPayload(
      allGraphNodes.value,
      currentViewport.value,
      layoutCache.value,
      allGraphEdges.value
    )
    if (layoutOnly && layoutPayload) layoutCache.value = layoutPayload
  }
  const groupsPayload = groupsOnly || !layoutOnly ? workflowGroups.value : undefined

  layoutSaveState.value = 'saving'
  try {
    const updated = await layoutPersistence.update({
      ...(layoutPayload !== null ? { canvasLayout: layoutPayload } : {}),
      ...(groupsPayload !== undefined ? { workflowGroups: groupsPayload } : {}),
    })
    const meta = parseDramaMetadata(updated.metadata)
    if (meta.canvas_layout) layoutCache.value = meta.canvas_layout
    if (meta.workflow_groups) workflowGroups.value = meta.workflow_groups
    // 仅合并 metadata / 时间戳，勿用精简对象覆盖 episodes、characters 等完整数据
    if (drama.value && updated) {
      drama.value = {
        ...drama.value,
        metadata: updated.metadata,
        updated_at: updated.updated_at,
        title: updated.title ?? drama.value.title,
        style: updated.style ?? drama.value.style,
        genre: updated.genre ?? drama.value.genre,
        description: updated.description ?? drama.value.description,
      }
      if (Array.isArray(updated.episodes) && updated.episodes.length) {
        drama.value.episodes = updated.episodes
      }
      if (Array.isArray(updated.characters)) {
        drama.value.characters = updated.characters
      }
      if (Array.isArray(updated.scenes)) {
        drama.value.scenes = updated.scenes
      }
      if (Array.isArray(updated.props)) {
        drama.value.props = updated.props
      }
    } else if (updated) {
      drama.value = updated
    }
    layoutSaveState.value = 'saved'
    layoutDirty.value = false
    if (savedHintTimer) clearTimeout(savedHintTimer)
    savedHintTimer = setTimeout(() => {
      if (layoutSaveState.value === 'saved') layoutSaveState.value = 'idle'
    }, 2000)
    return true
  } catch (e) {
    layoutSaveState.value = 'error'
    ElMessage.error(e?.message || '保存失败')
    return false
  }
}

async function onDirectorStateChange(nextState, acknowledge) {
  const currentLayout = layoutCache.value || parseCanvasLayout(drama.value?.metadata) || {}
  layoutCache.value = {
    ...currentLayout,
    director_timeline: nextState,
  }
  const saved = await persistCanvasState({ layoutOnly: true })
  acknowledge?.(saved)
}

async function loadProjectImageAssets() {
  if (!dramaId.value) {
    projectImageAssets.value = []
    storyboardAssignedAssets.value = {}
    return
  }
  const result = await assetsAPI.list({ drama_id: dramaId.value, page_size: 100 })
  const assets = Array.isArray(result) ? result : (result?.items || [])
  projectImageAssets.value = assets
  storyboardAssignedAssets.value = assets.reduce((map, asset) => {
    if (asset?.category === 'canvas-result') return map
    const storyboardId = Number(asset?.storyboard_id)
    if (!Number.isFinite(storyboardId)) return map
    if (!map[storyboardId]) map[storyboardId] = []
    map[storyboardId].push(asset)
    return map
  }, {})
}

async function onDirectorAssetCreated(asset) {
  await loadProjectImageAssets()
  rebuildGraph()
  const nodeId = `project-asset:${asset.id}`
  focusedNodeId.value = nodeId
  await nextTick()
  canvasFlowApi.value?.fitView?.({ nodes: [{ id: nodeId }], padding: 0.5, duration: 350 })
  ElMessage.success('导演截图已写入项目资产并定位到画布')
}

const {
  createDialogVisible,
  createDialogType,
  pendingFlowPosition,
  openCreateDialog,
  submitCreate,
} = useCanvasCrud({
  drama,
  filterEpisodeId,
  layoutCache,
  focusedNodeId,
  refreshCanvas,
  persistCanvasState,
})

const {
  episodeGenerating,
  episodeGenProgress,
  aiGenerateStoryboards,
  batchGenerateImages,
  batchGenerateVideos,
} = useCanvasEpisodeGenerate({
  drama,
  filterEpisodeId,
  imagesBySbId,
  videosBySbId,
  refreshCanvas,
  nodeStatus,
})

Object.assign(
  scriptActionsHolder,
  useCanvasScript({
    drama,
    dramaId,
    refreshCanvas: refreshDrama,
    nodeStatus,
  })
)

async function focusScriptNode(flowPosition = null) {
  let epId = filterEpisodeId.value
  if (!epId) {
    const eps = drama.value?.episodes || []
    if (eps.length === 1) epId = eps[0].id
  }
  if (!epId) {
    ElMessage.warning('请先选择或新建集数')
    return
  }
  if (!filterEpisodeId.value) filterEpisodeId.value = epId
  const nodeId = scriptNodeId(epId)
  if (flowPosition) {
    allGraphNodes.value = allGraphNodes.value.map((node) => (
      node.id === nodeId ? { ...node, position: { x: flowPosition.x, y: flowPosition.y } } : node
    ))
    layoutCache.value = {
      ...(layoutCache.value || { version: 1 }),
      nodes: {
        ...(layoutCache.value?.nodes || {}),
        [nodeId]: { x: flowPosition.x, y: flowPosition.y },
      },
    }
    applyVirtualizedGraph()
    await persistCanvasState({ layoutOnly: true })
  }
  await focusCanvasNode(nodeId)
}

function onTopbarMoreCommand(command) {
  if (command === 'script') focusScriptNode()
  else if (command === 'align') onAlignNodes()
  else openCreateDialog(command)
}

async function onAlignNodes() {
  if (!drama.value || !allGraphNodes.value.length || aligningNodes.value) return
  aligningNodes.value = true
  focusedNodeId.value = null
  try {
    const { positions } = computeAutoLayoutPositions(drama.value, {
      episodeId: filterEpisodeId.value,
      workflowGroups: workflowGroups.value,
      imagesBySbId: imagesBySbId.value,
      videosBySbId: videosBySbId.value,
    })
    allGraphNodes.value = allGraphNodes.value.map((n) => {
      const pos = positions[n.id]
      return pos ? { ...n, position: { x: pos.x, y: pos.y } } : n
    })
    applyVirtualizedGraph()
    layoutCache.value = {
      version: 1,
      nodes: { ...positions },
      viewport: layoutCache.value?.viewport,
    }
    await nextTick()
    const flowApi = canvasFlowApi.value
    if (flowApi?.fitView) {
      await flowApi.fitView({
        padding: 0.14,
        duration: 380,
        includeHiddenNodes: false,
      })
      await new Promise((r) => setTimeout(r, 400))
      const vp = flowApi.getViewport?.()
      if (vp) {
        currentViewport.value = { x: vp.x, y: vp.y, zoom: vp.zoom }
        scheduleVirtualization()
      }
    }
    await persistCanvasState({ layoutOnly: true })
    ElMessage.success('节点已按规则对齐并适配当前视图')
  } catch (e) {
    ElMessage.error(e?.message || '对齐失败')
  } finally {
    aligningNodes.value = false
  }
}

async function loadDrama(silent = false) {
  if (!dramaId.value) return
  if (!silent) loading.value = true
  try {
    drama.value = await dramaAPI.get(dramaId.value)
    await loadProjectImageAssets()
    layoutCache.value = parseCanvasLayout(drama.value.metadata)
    syncWorkflowFromDrama()
    const vp = resolveViewport(layoutCache.value)
    currentViewport.value = vp
    if (route.query.episode) filterEpisodeId.value = Number(route.query.episode)
    await loadForDrama(drama.value, filterEpisodeId.value)
    rebuildGraph()
  } catch (e) {
    if (!silent) ElMessage.error(e?.message || '加载项目失败')
  } finally {
    if (!silent) loading.value = false
  }
}

async function onCreateWorkflowGroup() {
  if (workflowRunning.value || layoutSaveState.value === 'saving') {
    ElMessage.warning('请等待当前画布任务完成后再创建工作流')
    return
  }
  if (!selectedStoryboardIds.value.length) {
    ElMessage.warning('请先框选或 Ctrl 点击选择分镜节点')
    return
  }
  const previousGroups = workflowGroups.value
  const previousActiveGroupId = activeGroupId.value
  try {
    const { value } = await ElMessageBox.prompt('工作流名称', '创建工作流', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputValue: `工作流 ${workflowGroups.value.length + 1}`,
    })
    workflowGroups.value = createWorkflowGroup(workflowGroups.value, {
      title: value?.trim() || undefined,
      storyboardIds: selectedStoryboardIds.value,
      pipeline: normalizePipeline(pipelineSteps.value),
    })
    activeGroupId.value = workflowGroups.value[workflowGroups.value.length - 1]?.id || null
    const saved = await persistCanvasState({ groupsOnly: true })
    if (!saved) {
      workflowGroups.value = previousGroups
      activeGroupId.value = previousActiveGroupId
      rebuildGraph()
      return
    }
    rebuildGraph()
    ElMessage.success('工作流已创建')
  } catch (_) {}
}

async function onDeleteActiveGroup() {
  if (!activeGroupId.value) return
  const previousGroups = workflowGroups.value
  const previousActiveGroupId = activeGroupId.value
  try {
    await ElMessageBox.confirm('确定删除该工作流？', '删除工作流', { type: 'warning' })
    workflowGroups.value = deleteWorkflowGroup(workflowGroups.value, activeGroupId.value)
    activeGroupId.value = workflowGroups.value[0]?.id || null
    const saved = await persistCanvasState({ groupsOnly: true })
    if (!saved) {
      workflowGroups.value = previousGroups
      activeGroupId.value = previousActiveGroupId
      rebuildGraph()
      return
    }
    rebuildGraph()
    selectedStoryboardIds.value = []
    ElMessage.success('已删除')
  } catch (_) {}
}

async function onWorkflowOrderChange(storyboardIds) {
  if (!activeGroupId.value || workflowRunning.value || layoutSaveState.value === 'saving') return
  const previousGroups = workflowGroups.value
  const nextGroups = reorderWorkflowGroup(workflowGroups.value, activeGroupId.value, storyboardIds)
  const previousIds = previousGroups.find((group) => group.id === activeGroupId.value)?.storyboard_ids || []
  const nextIds = nextGroups.find((group) => group.id === activeGroupId.value)?.storyboard_ids || []
  if (JSON.stringify(previousIds) === JSON.stringify(nextIds)) return

  workflowGroups.value = nextGroups
  rebuildGraph()
  const saved = await persistCanvasState({ groupsOnly: true })
  if (!saved) {
    workflowGroups.value = previousGroups
    rebuildGraph()
    return
  }
  ElMessage.success('工作流执行顺序已保存')
}

async function onRunActiveGroup() {
  const group = workflowGroups.value.find((g) => g.id === activeGroupId.value)
  if (!group) {
    ElMessage.warning('请先选择工作流')
    return
  }

  await runWorkflowWithConfirm({
    ...group,
    pipeline: normalizePipeline(group.pipeline?.length ? group.pipeline : pipelineSteps.value),
  }, '整组重跑')
}

async function onRunSelectedStoryboards() {
  const storyboardIds = selectedStoryboardIds.value
    .map(Number)
    .filter((id) => visibleStoryboardIds.value.has(id))

  if (!storyboardIds.length) {
    ElMessage.warning('请先框选或 Ctrl 点击选择分镜节点')
    return
  }

  await runWorkflowWithConfirm({
    id: 'selected-storyboards',
    title: '所选分镜',
    storyboard_ids: storyboardIds,
    pipeline: normalizePipeline(pipelineSteps.value),
  }, '运行所选分镜')
}

async function runWorkflowWithConfirm(runGroup, confirmTitle) {
  try {
    await ElMessageBox.confirm(
      `将对 ${(runGroup.storyboard_ids || []).length} 个分镜依次执行：${(runGroup.pipeline || pipelineSteps.value).join(' → ')}\n耗时可能较长，是否继续？`,
      confirmTitle,
      { type: 'warning', confirmButtonText: '开始执行' }
    )
  } catch {
    return
  }

  const storyboardIds = runGroup.storyboard_ids || []
  const total = storyboardIds.length
  let currentIndex = 0

  storyboardIds.forEach((storyboardId) => nodeStatus.clear(`sb:${storyboardId}`))
  workflowRunning.value = true
  workflowProgress.value = '准备执行…'
  try {
    const summary = await runWorkflowGroup(drama.value, runGroup, {
      stopOnError: true,
      generationOptions: getCanvasGenerationOptions(),
      reloadStoryboard: async (storyboardId) => {
        await loadDrama(true)
        return findStoryboardInDrama(drama.value, storyboardId)?.storyboard
      },
      onStoryboardStart: ({ storyboardId }) => {
        currentIndex = Math.max(storyboardIds.indexOf(storyboardId) + 1, currentIndex + 1)
        nodeStatus.set(`sb:${storyboardId}`, {
          step: 'workflow',
          message: `工作流 ${currentIndex}/${total}`,
        })
        workflowProgress.value = `${runGroup.title} · ${currentIndex}/${total} · 准备执行…`
      },
      onStepStart: ({ storyboardId, step }) => {
        const label = CANVAS_NODE_STATUS_LABELS[step] || step
        nodeStatus.set(`sb:${storyboardId}`, { step, message: label, storyboardId, retryStep: step })
        workflowProgress.value = `${runGroup.title} · ${currentIndex}/${total} · 分镜 #${storyboardId}：${label}`
      },
      onStoryboardComplete: ({ storyboardId }) => {
        nodeStatus.clear(`sb:${storyboardId}`)
      },
      onStepError: ({ storyboardId, step, error }) => {
        nodeStatus.fail(`sb:${storyboardId}`, {
          message: `${CANVAS_NODE_STATUS_LABELS[step] || step}失败：${error?.message || error}`,
          errorDetail: error?.message || String(error || ''),
          storyboardId,
          retryStep: step,
          retryLabel: `重试${CANVAS_NODE_STATUS_LABELS[step] || step}`,
        })
      },
      onStoryboardError: ({ storyboardId, error }) => {
        nodeStatus.fail(`sb:${storyboardId}`, {
          message: `工作流失败：${error?.message || error}`,
          errorDetail: error?.message || String(error || ''),
          storyboardId,
          retryStep: queueNodeRetryStep(findGraphNode(`sb:${storyboardId}`)) || 'video',
          retryLabel: '重试当前分镜',
        })
        ElMessage.error(`分镜 #${storyboardId} 失败：${error?.message || error}`)
      },
    })
    await loadDrama(true)
    await loadForDrama(drama.value, filterEpisodeId.value)
    rebuildGraph()
    if (summary.failed.length) {
      ElMessage.warning(`完成 ${summary.ok.length} 镜，失败 ${summary.failed.length} 镜`)
    } else {
      ElMessage.success(`工作流执行完成，共 ${summary.ok.length} 镜`)
    }
  } catch (e) {
    ElMessage.error(e?.message || '工作流执行失败')
  } finally {
    workflowRunning.value = false
    workflowProgress.value = ''
  }
}

function hasProcessingStoryboards() {
  for (const ep of drama.value?.episodes || []) {
    for (const sb of ep.storyboards || []) {
      if (sb.status === 'processing') return true
    }
  }
  return false
}

function startStatusPoll() {
  stopStatusPoll()
  if (!hasProcessingStoryboards()) return
  pollTimer = setInterval(() => {
    if (hasProcessingStoryboards()) loadDrama(true)
    else stopStatusPoll()
  }, 8000)
}

function stopStatusPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function goListMode() {
  const query = filterEpisodeId.value ? { episode: String(filterEpisodeId.value) } : {}
  router.push({ path: `/film/${dramaId.value}`, query })
}

function navigateToProduction(episodeId, hash) {
  router.push({
    path: `/film/${dramaId.value}`,
    query: episodeId ? { episode: String(episodeId) } : {},
    hash: hash ? `#${hash}` : undefined,
  })
}

function navigateToStoryboard(episodeId, storyboardId) {
  navigateToProduction(episodeId, storyboardId ? `sb-${storyboardId}` : undefined)
}

function onNodeDoubleClick({ node }) {
  if (node.type === 'canvasStoryboard') {
    navigateToStoryboard(node.data.episodeId || node.data.storyboard?.episode_id, node.data.storyboard?.id)
    return
  }

  if (node.type === 'canvasScript') {
    navigateToProduction(node.data.episode?.id, 'anchor-script')
    return
  }

  if (node.type === 'canvasEpisode') {
    navigateToProduction(node.data.episode?.id, 'anchor-storyboard')
    return
  }

  if (node.type === 'canvasAsset') {
    const anchor = {
      character: 'anchor-characters',
      scene: 'anchor-scenes',
      prop: 'anchor-props',
    }[node.data?.kind]
    navigateToProduction(filterEpisodeId.value, anchor)
    return
  }

  const ref = getStoryboardRefFromNode(node)
  if (ref?.storyboardId) navigateToStoryboard(ref.episodeId, ref.storyboardId)
}

function onPaneClick(event) {
  if (paneClickSuppressed.value) return
  const target = event?.event?.target || event?.target
  if (target?.closest?.('.canvas-node-panel') || target?.closest?.('.el-popper') || target?.closest?.('.canvas-context-menu')) {
    return
  }
  focusedNodeId.value = null
  activeGroupId.value = null
  closeContextMenu()
}

function onNodeClick({ node, event }) {
  if (node.type === 'canvasAddButton') {
    event?.stopPropagation?.()
    openCreateDialog(node.data?.assetType || 'storyboard')
    return
  }

  if (PANEL_NODE_TYPES.has(node.type)) {
    focusedNodeId.value = node.id
    scheduleVirtualization()
  }

  if (node.type === 'canvasAsset') {
    const prefix = node.data.kind === 'character' ? 'char' : node.data.kind === 'scene' ? 'scene' : 'prop'
    selectSidebarAsset(`${prefix}:${node.data.entity.id}`)
    return
  }
  const sbId = storyboardIdFromNodeId(node.id)
  if (sbId) {
    selectStoryboard(sbId, event)
  }
}

watch(filterEpisodeId, async (val) => {
  if (drama.value) await loadForDrama(drama.value, val)
  if (highlightAssetId.value && !isCanvasAssetVisible(highlightAssetId.value, episodeContext.value)) {
    highlightAssetId.value = null
  }
  rebuildGraph()
  selectedStoryboardIds.value = selectedStoryboardIds.value.filter((id) => visibleStoryboardIds.value.has(Number(id)))
  if (activeGroupId.value) {
    const activeGroup = workflowGroups.value.find((group) => group.id === activeGroupId.value)
    const hasVisibleStoryboards = activeGroup
      && activeGroup.storyboard_ids.some((id) => visibleStoryboardIds.value.has(Number(id)))
    if (!hasVisibleStoryboards) activeGroupId.value = null
  }
  const query = { ...route.query }
  if (val != null) query.episode = String(val)
  else delete query.episode
  router.replace({ query }).catch(() => {})
})

watch(focusedNodeId, () => scheduleVirtualization())

watch(() => dramaId.value, () => {
  restoreNodeStatusSnapshot()
}, { immediate: true })

watch(nodeStatus.map, () => {
  persistNodeStatusSnapshot()
}, { deep: true })

watch(() => route.params.id, () => {
  highlightAssetId.value = null
  layoutCache.value = null
  activeGroupId.value = null
  selectedStoryboardIds.value = []
  focusedNodeId.value = null
  generationOverrides.value = {}
  loadDrama()
}, { immediate: true })

watch(drama, () => startStatusPoll())

onMounted(() => {
  scheduleVirtualization()
  runQueueTimer = setInterval(() => {
    queueNow.value = Date.now()
  }, 1000)
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', scheduleVirtualization)
    window.addEventListener('keydown', onCanvasKeydown)
    window.addEventListener('keyup', onCanvasKeyup)
    window.addEventListener('blur', onCanvasBlur)
  }
})

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
  if (savedHintTimer) clearTimeout(savedHintTimer)
  if (paneClickSuppressTimer) clearTimeout(paneClickSuppressTimer)
  if (generationSaveTimer) clearTimeout(generationSaveTimer)
  if (runQueueTimer) clearInterval(runQueueTimer)
  if (virtualizationFrame != null) {
    if (typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(virtualizationFrame)
    else clearTimeout(virtualizationFrame)
    virtualizationFrame = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', scheduleVirtualization)
    window.removeEventListener('keydown', onCanvasKeydown)
    window.removeEventListener('keyup', onCanvasKeyup)
    window.removeEventListener('blur', onCanvasBlur)
  }
  stopStatusPoll()
  if (layoutDirty.value) persistCanvasState({ layoutOnly: true })
})
</script>

<style scoped>
.drama-canvas-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page, #0f0f12);
  color: var(--text-primary, #e4e4e7);
  overflow: hidden;
}

.header {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color, #27272a);
  background: var(--bg-card, #18181b);
}

.header-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px 6px;
  flex-wrap: wrap;
}

.workflow-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px 10px;
  flex-wrap: wrap;
}

.wf-hint {
  font-size: 12px;
  color: var(--text-subtle, #71717a);
}

.wf-steps {
  display: flex;
  gap: 4px;
}

.workflow-progress {
  padding: 0 20px 8px;
  font-size: 12px;
  color: #60a5fa;
}

.workflow-progress.episode-gen {
  color: #34d399;
}

.generate-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 20px 10px;
  flex-wrap: wrap;
  border-top: 1px solid rgba(63, 63, 70, 0.35);
  margin-top: 2px;
  padding-top: 8px;
}

.gen-label {
  font-size: 12px;
  font-weight: 600;
  color: #a1a1aa;
  margin-right: 4px;
}

.gen-hint {
  font-size: 11px;
  color: #52525b;
  flex: 1;
  min-width: 200px;
}

.logo {
  margin: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  line-height: 1.2;
}
.brand-logo { width: 40px; height: 40px; object-fit: cover; border-radius: 11px; flex: 0 0 auto; }
.brand-copy { display: flex; flex-direction: column; }

.logo-main {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright, #fafafa);
}

.logo-sub {
  font-size: 11px;
  color: #818cf8;
}

.breadcrumb-sep { color: var(--text-faint, #52525b); }

.page-title {
  font-size: 14px;
  color: var(--text-muted, #a1a1aa);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layout-status { font-size: 12px; }
.layout-status.saving { color: #60a5fa; }
.layout-status.saved { color: #34d399; }
.layout-status.error { color: #f87171; }
.canvas-virtualization-status {
  flex: 0 0 auto;
  padding: 3px 7px;
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-radius: 999px;
  color: #93c5fd;
  font-size: 11px;
  white-space: nowrap;
}

.header-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.canvas-shell {
  flex: 1;
  display: flex;
  min-height: 0;
}

.canvas-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color, #27272a);
  background: var(--bg-card, #18181b);
  padding: 14px 12px;
  overflow-y: auto;
}

.sidebar-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 12px;
  color: var(--text-bright, #fafafa);
}

.sidebar-context {
  margin: -6px 0 12px;
  font-size: 10px;
  color: var(--text-faint, #52525b);
}

.sidebar-section { margin-bottom: 14px; }
.sidebar-script {
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border-color, #27272a);
}
.sidebar-script-tip {
  margin: 0;
  font-size: 10px;
  line-height: 1.45;
  color: var(--text-subtle, #71717a);
}

.sec-label {
  font-size: 11px;
  color: var(--text-subtle, #71717a);
  margin-bottom: 6px;
}

.sec-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-item {
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  color: var(--text-primary, #e4e4e7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s;
}
.sidebar-item:hover { background: rgba(129, 140, 248, 0.12); }
.sidebar-item.active { background: rgba(52, 211, 153, 0.16); color: #6ee7b7; }

.workflow-item { white-space: normal; }
.wf-item-title { font-weight: 600; }
.wf-item-meta { font-size: 10px; color: var(--text-faint, #52525b); margin-top: 2px; }
.sidebar-empty { font-size: 11px; color: var(--text-faint, #52525b); padding: 4px 0; }

.sidebar-tip {
  font-size: 10px;
  line-height: 1.45;
  color: var(--text-faint, #52525b);
  margin-top: 16px;
}

.canvas-main {
  flex: 1;
  min-width: 0;
  position: relative;
}

.canvas-main.space-panning :deep(.vue-flow__pane) {
  cursor: grab;
}

.canvas-main.space-panning :deep(.vue-flow__pane:active) {
  cursor: grabbing;
}

.vue-flow-canvas {
  width: 100%;
  height: 100%;
  background: #0c0c0f;
}

:deep(.vue-flow__minimap) {
  background: rgba(24, 24, 27, 0.92);
  border: 1px solid #3f3f46;
}

:deep(.vue-flow__controls) {
  box-shadow: none;
  border: 1px solid #3f3f46;
}

:deep(.vue-flow__controls button) {
  background: #18181b;
  border-color: #3f3f46;
  color: #e4e4e7;
}

:deep(.vue-flow__node.selected) {
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.8);
}
/* LibTV 风格画布工作区覆盖层 */
.header.canvas-topbar {
  position: absolute;
  inset: 0 0 auto;
  z-index: 30;
  border-bottom: 0;
  background: transparent;
  pointer-events: none;
}
.canvas-topbar .header-inner {
  margin: 12px 16px 0;
  padding: 8px 10px;
  min-width: 0;
  flex-wrap: nowrap;
  border: 1px solid rgba(82, 82, 91, 0.7);
  border-radius: 16px;
  background: rgba(24, 24, 27, 0.82);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(18px);
  pointer-events: auto;
}
.workspace-switcher { min-width: 156px; }
.canvas-name {
  padding-left: 12px;
  border-left: 1px solid #3f3f46;
  color: #a1a1aa;
  font-size: 12px;
  white-space: nowrap;
}
.canvas-topbar .header-actions { gap: 6px; min-width: 0; flex: 0 0 auto; }
.canvas-topbar .page-title { min-width: 0; flex: 0 1 auto; }
.canvas-topbar .topbar-workflow-toggle { min-width: 92px; }
.canvas-topbar .topbar-share { width: 38px; padding: 0; }
.canvas-topbar .topbar-more { flex: 0 0 auto; }
.canvas-topbar .topbar-more-trigger { min-width: 42px; padding: 0 10px; }
.canvas-topbar .topbar-more-label { margin-left: 4px; }
.canvas-topbar .el-button { min-height: 38px; }
.canvas-topbar .workflow-bar,
.canvas-topbar .generate-bar,
.canvas-topbar .workflow-progress { pointer-events: auto; }
.canvas-topbar .workflow-bar,
.canvas-topbar .generate-bar {
  margin: 8px 16px 0;
  padding: 10px 14px;
  border: 1px solid rgba(82, 82, 91, 0.65);
  border-radius: 14px;
  background: rgba(24, 24, 27, 0.92);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(18px);
}
.canvas-topbar .workflow-progress {
  margin: 8px 16px 0;
  padding: 7px 12px;
  border-radius: 10px;
  background: rgba(24, 24, 27, 0.86);
}
.canvas-shell { position: relative; width: 100%; }
.canvas-sidebar {
  position: absolute;
  top: 82px;
  left: 16px;
  bottom: 16px;
  z-index: 20;
  width: 248px;
  border: 1px solid rgba(82, 82, 91, 0.72);
  border-radius: 16px;
  background: rgba(24, 24, 27, 0.9);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(18px);
}
.canvas-main { width: 100%; height: 100%; }
.vue-flow-canvas { background: #101014; }
.canvas-topbar .layout-status { font-size: 11px; white-space: nowrap; }
.canvas-run-queue {
  position: absolute;
  left: 18px;
  bottom: 22px;
  z-index: 24;
  width: min(360px, calc(100% - 36px));
  padding: 9px;
  border: 1px solid rgba(82, 82, 91, 0.72);
  border-radius: 14px;
  background: rgba(24, 24, 27, 0.92);
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(18px);
  pointer-events: auto;
}
.run-queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 3px 7px;
  color: #e4e4e7;
  font-size: 12px;
  font-weight: 700;
}
.run-queue-head small {
  color: #71717a;
  font-size: 10px;
  font-weight: 400;
}
.run-queue-item {
  width: 100%;
  display: grid;
  grid-template-columns: 10px 42px 1fr auto;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  padding: 7px 8px;
  border: 1px solid rgba(63, 63, 70, 0.8);
  border-radius: 10px;
  background: rgba(9, 9, 11, 0.44);
  color: #d4d4d8;
  text-align: left;
  cursor: pointer;
}
.run-queue-item:hover {
  border-color: rgba(129, 140, 248, 0.62);
  background: rgba(129, 140, 248, 0.12);
}
.run-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #60a5fa;
}
.tone-running .run-dot {
  animation: queue-pulse 1.2s ease-in-out infinite;
}
.tone-failed .run-dot {
  background: #f87171;
}
.tone-success .run-dot {
  background: #34d399;
}
.run-result-preview {
  width: 42px;
  height: 32px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(63, 63, 70, 0.8);
  background: rgba(39, 39, 42, 0.72);
}
.run-result-preview:not(.preview-empty) {
  cursor: zoom-in;
}
.run-result-preview img,
.run-result-preview video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.run-result-preview.preview-audio {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.12);
}
.run-result-preview.preview-empty {
  opacity: 0.28;
}
.run-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.run-info strong,
.run-info small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-info strong {
  font-size: 11px;
  font-weight: 700;
}
.run-info small {
  color: #a1a1aa;
  font-size: 10px;
}
.tone-failed .run-info small {
  color: #fca5a5;
}
.tone-success .run-info small {
  color: #bbf7d0;
}
.run-action {
  color: #a5b4fc;
  font-size: 10px;
}
.run-success-actions,
.run-failed-actions {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.run-success-actions button {
  padding: 3px 7px;
  border: 1px solid rgba(52, 211, 153, 0.55);
  border-radius: 999px;
  background: rgba(6, 78, 59, 0.32);
  color: #bbf7d0;
  font-size: 10px;
  cursor: pointer;
}
.run-success-actions button:hover {
  border-color: rgba(52, 211, 153, 0.9);
  background: rgba(6, 95, 70, 0.48);
}
.run-failed-actions button {
  padding: 3px 7px;
  border: 1px solid rgba(248, 113, 113, 0.55);
  border-radius: 999px;
  background: rgba(127, 29, 29, 0.32);
  color: #fecaca;
  font-size: 10px;
  cursor: pointer;
}
.run-failed-actions button:hover {
  border-color: rgba(248, 113, 113, 0.9);
  background: rgba(185, 28, 28, 0.45);
}
@keyframes queue-pulse {
  0%, 100% { opacity: 0.45; transform: scale(0.92); }
  50% { opacity: 1; transform: scale(1.12); }
}
@media (max-width: 980px) {
  .canvas-topbar .header-inner { margin: 8px 10px 0; }
  .canvas-topbar .btn-theme { display: none; }
  .page-title { max-width: 160px; }
  .canvas-topbar .episode-select { width: 130px !important; }
}
@media (max-width: 680px) {
  .canvas-topbar .header-inner { padding: 7px 8px; }
  .workspace-switcher { min-width: 0; }
  .brand-copy, .breadcrumb-sep, .canvas-name, .layout-status, .canvas-virtualization-status { display: none; }
  .brand-logo { width: 34px; height: 34px; }
  .page-title { max-width: 120px; }
  .episode-select { width: 112px !important; }
  .canvas-topbar .topbar-workflow-toggle { min-width: 42px; padding: 0 10px; }
  .canvas-topbar .topbar-workflow-toggle .el-icon + span { display: none; }
  .canvas-topbar .topbar-more-label { display: none; }
  .canvas-topbar .topbar-more-trigger { width: 42px; padding: 0; }
  .canvas-topbar .header-actions { gap: 4px; }
  .canvas-sidebar { top: 70px; left: 8px; right: 8px; width: auto; }
}
@media (max-width: 480px) {
  .canvas-topbar .page-title { display: none; }
  .canvas-topbar .header-inner { gap: 6px; margin-left: 8px; margin-right: 8px; }
  .canvas-topbar .episode-select { width: 96px !important; }
}
@media (prefers-reduced-motion: reduce) {
  .canvas-topbar .header-inner { transition: none; }
}
</style>

<style>
html.light .drama-canvas-page { background: var(--bg-page); }
html.light .vue-flow-canvas { background: #eef2ff; }
</style>
