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

      <div ref="canvasMainRef" class="canvas-main" @wheel.capture="onCanvasWheel">
        <VueFlow
          v-if="allGraphNodes.length"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :node-types="nodeTypes"
          :default-viewport="initialViewport"
          :min-zoom="0.08"
          :max-zoom="2"
          :nodes-connectable="false"
          :elements-selectable="true"
          :select-nodes-on-drag="true"
          selection-mode="partial"
          :selection-key-code="true"
          :pan-on-drag="false"
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
            <small>{{ runningQueueCount }} 进行中 · {{ failedQueueCount }} 异常</small>
          </div>
          <div
            v-for="item in runQueueItems"
            :key="item.key"
            class="run-queue-item"
            :class="'tone-' + item.tone"
            @click="focusQueueItem(item)"
          >
            <span class="run-dot" />
            <span class="run-info">
              <strong>{{ item.label }}</strong>
              <small>{{ item.message }}</small>
            </span>
            <span v-if="item.tone === 'running'" class="run-action">{{ item.elapsedText }}</span>
            <button
              v-else-if="item.retryStep"
              type="button"
              class="run-retry"
              @click.stop="retryQueueItem(item)"
            >
              重试
            </button>
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
import { useTheme } from '@/composables/useTheme'
import { runAudioStep, runImageStep, runVideoStep, runWorkflowGroup } from '@/composables/useCanvasWorkflowRunner'
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
import {
  createWorkflowGroup,
  deleteWorkflowGroup,
  findStoryboardInDrama,
  normalizePipeline,
  parseWorkflowGroups,
  reorderWorkflowGroup,
  storyboardIdFromNodeId,
  getDramaGenerationOptions,
} from '@/utils/canvasWorkflow'
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
const paneClickSuppressed = ref(false)
const nodeStatus = createCanvasNodeStatusStore()
const aligningNodes = ref(false)
const canvasFlowApi = ref(null)
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

const PANEL_NODE_TYPES = new Set(['canvasStoryboard', 'canvasMedia', 'canvasAsset', 'canvasScript'])

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
  const items = []
  const seen = new Set()
  for (const [nodeId, status] of Object.entries(nodeStatus.map)) {
    if (!nodeId || !status) continue
    const key = `active:${nodeId}`
    seen.add(nodeId)
    items.push({
      key,
      nodeId,
      tone: status.step === 'failed' ? 'failed' : 'running',
      label: queueNodeLabel(nodeId),
      message: status.step === 'failed' ? (status.message || '节点执行失败') : queueRunningMessage(status),
      elapsedText: formatQueueElapsed(status.at),
      retryStep: status.step === 'failed' ? queueNodeRetryStep(findGraphNode(nodeId)) : '',
    })
  }
  for (const node of allGraphNodes.value) {
    const failure = queueNodeFailure(node)
    if (!failure || seen.has(String(node.id))) continue
    seen.add(String(node.id))
    items.push({
      key: `failed:${node.id}`,
      nodeId: node.id,
      tone: 'failed',
      label: canvasNodeLabel(node),
      message: failure,
      retryStep: queueNodeRetryStep(node),
    })
  }
  return items.slice(0, 8)
})
const runningQueueCount = computed(() => runQueueItems.value.filter((item) => item.tone === 'running').length)
const failedQueueCount = computed(() => runQueueItems.value.filter((item) => item.tone === 'failed').length)

function queueNodeLabel(nodeId) {
  const node = findGraphNode(nodeId)
  if (node) return canvasNodeLabel(node)
  const sbId = storyboardIdFromNodeId(nodeId)
  return sbId ? `分镜 #${sbId}` : String(nodeId)
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
  let nextNodes = graph.nodes
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
  if (PANEL_NODE_TYPES.has(node.type)) actions.unshift('open-node-config')
  if (node.type === 'canvasAsset') {
    return [...actions, 'focus-downstream-video']
  }
  if (sb) {
    actions.push('focus-upstream', 'focus-downstream-video')
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

async function copyNodeReference(node) {
  const text = `${canvasNodeLabel(node)} · ${node?.id || ''}`
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('节点引用已复制')
  } catch {
    ElMessageBox.alert(text, '节点引用（请手动复制）', { confirmButtonText: '关闭', type: 'info' })
  }
}


function nodeStepStatusLabel(step, node) {
  if (step === 'image' && node?.data?.frameKind === 'first') return '首帧生成中…'
  if (step === 'image' && node?.data?.frameKind === 'last') return '尾帧生成中…'
  return CANVAS_NODE_STATUS_LABELS[step] || '处理中…'
}

function nodeStepResultInfo(node, step, storyboardId) {
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
  const resultType = step === 'audio' ? 'audio' : step
  const labelMap = { image: '图片已生成', video: '视频已生成', audio: '音频已生成' }
  return {
    resultUrl: resultNode?.data?.url || '',
    resultType,
    resultLabel: labelMap[resultType] || '结果已生成',
  }
}

function shouldKeepNodeStatus(nodeId) {
  return ['failed', 'success'].includes(nodeStatus.get(nodeId)?.step)
}

async function runCanvasNodeStep(node, step) {
  const sb = storyboardForNode(node)
  if (!drama.value || !sb?.id) {
    ElMessage.warning('该节点没有绑定分镜，无法执行生成')
    return
  }
  const nodeId = node?.id
  const sbNodeId = `sb:${sb.id}`
  const statusMessage = nodeStepStatusLabel(step, node)
  if (nodeId) nodeStatus.set(nodeId, { step, message: statusMessage })
  nodeStatus.set(sbNodeId, { step, message: statusMessage })
  try {
    const found = findStoryboardInDrama(drama.value, sb.id)
    const latestSb = found?.storyboard || sb
    const genOpts = getCanvasGenerationOptions()
    if (step === 'image') await runImageStep(drama.value, latestSb, genOpts, node?.data?.frameKind || '')
    else if (step === 'video') await runVideoStep(drama.value, latestSb, genOpts)
    else if (step === 'audio') {
      const res = await runAudioStep(latestSb)
      if (res?.skipped) {
        ElMessage.info(res.reason || '已跳过')
        return
      }
    }
    ElMessage.success('节点生成完成')
    await refreshDrama(true)
    const resultInfo = nodeStepResultInfo(node, step, sb.id)
    if (nodeId) nodeStatus.success(nodeId, { ...resultInfo, autoClear: false })
    nodeStatus.success(sbNodeId, { ...resultInfo, autoClear: false })
    if (nodeId) await focusCanvasNode(nodeId)
  } catch (e) {
    const errorMessage = e?.message || '节点生成失败'
    if (nodeId) nodeStatus.fail(nodeId, { message: errorMessage })
    nodeStatus.fail(sbNodeId, { message: errorMessage })
    ElMessage.error(errorMessage)
    await refreshDrama(true)
  } finally {
    if (!shouldKeepNodeStatus(nodeId)) nodeStatus.clear(nodeId)
    if (!shouldKeepNodeStatus(sbNodeId)) nodeStatus.clear(sbNodeId)
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
    onNodeDoubleClick({ node })
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
  } else if (type === 'copy-node-ref') {
    await copyNodeReference(node)
  } else if (type === 'create-workflow-from-node') {
    await createWorkflowFromNode(node)
  } else if (type === 'run-node-workflow') {
    await runWorkflowFromNode(node)
  }
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

async function onContextMenuSelect(type) {
  const node = contextMenuNode.value
  if (node) {
    closeContextMenu()
    await runNodeMenuAction(type, node)
    return
  }
  pendingFlowPosition.value = contextMenuFlowPos.value
  openCreateDialog(type, contextMenuFlowPos.value)
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
  undoCanvas,
  redoCanvas,
  zoomIn: () => canvasFlowApi.value?.zoomIn?.({ duration: 180 }),
  zoomOut: () => canvasFlowApi.value?.zoomOut?.({ duration: 180 }),
  showCanvasHelp,
  selectStoryboard: (storyboardId, event) => selectStoryboard(storyboardId, event),
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
  const modifier = event.ctrlKey || event.metaKey
  if (!modifier || event.altKey) return
  if (key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redoCanvas()
    else undoCanvas()
  } else if (key === 'y') {
    event.preventDefault()
    redoCanvas()
  }
}

async function persistCanvasState({ layoutOnly = false, groupsOnly = false } = {}) {
  if (!dramaId.value) return

  let layoutPayload = null
  if (!groupsOnly) {
    syncRenderedNodesToGraph()
    layoutPayload = buildCanvasLayoutPayload(nodes.value, currentViewport.value, layoutCache.value)
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
    return
  }
  const result = await assetsAPI.list({ drama_id: dramaId.value, type: 'image', page_size: 100 })
  projectImageAssets.value = Array.isArray(result) ? result : (result?.items || [])
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

function focusScriptNode() {
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
  focusedNodeId.value = scriptNodeId(epId)
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
  try {
    await ElMessageBox.confirm(
      `将对 ${(group.storyboard_ids || []).length} 个分镜依次执行：${(group.pipeline || pipelineSteps.value).join(' → ')}\n耗时可能较长，是否继续？`,
      '整组重跑',
      { type: 'warning', confirmButtonText: '开始执行' }
    )
  } catch {
    return
  }

  const runGroup = {
    ...group,
    pipeline: normalizePipeline(group.pipeline?.length ? group.pipeline : pipelineSteps.value),
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
        nodeStatus.set(`sb:${storyboardId}`, { step, message: label })
        workflowProgress.value = `${runGroup.title} · ${currentIndex}/${total} · 分镜 #${storyboardId}：${label}`
      },
      onStoryboardComplete: ({ storyboardId }) => {
        nodeStatus.clear(`sb:${storyboardId}`)
      },
      onStepError: ({ storyboardId, step, error }) => {
        nodeStatus.set(`sb:${storyboardId}`, {
          step: 'failed',
          message: `${CANVAS_NODE_STATUS_LABELS[step] || step}失败：${error?.message || error}`,
        })
      },
      onStoryboardError: ({ storyboardId, error }) => {
        nodeStatus.set(`sb:${storyboardId}`, {
          step: 'failed',
          message: `工作流失败：${error?.message || error}`,
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
  grid-template-columns: 10px 1fr auto;
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
.run-action {
  color: #a5b4fc;
  font-size: 10px;
}
.run-retry {
  padding: 3px 7px;
  border: 1px solid rgba(248, 113, 113, 0.55);
  border-radius: 999px;
  background: rgba(127, 29, 29, 0.32);
  color: #fecaca;
  font-size: 10px;
  cursor: pointer;
}
.run-retry:hover {
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
