<template>
  <div class="drama-canvas-page">
    <header class="header canvas-topbar" :class="{ 'workflow-open': showWorkflowPanel }">
      <div class="header-inner">
        <CanvasWorkspaceSwitcher />
        <span class="breadcrumb-sep">›</span>
        <span class="page-title">{{ drama?.title || '加载中…' }}</span>
        <span class="canvas-name">画布 1</span>

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
          <el-button class="topbar-workflow-toggle" size="small" :type="showWorkflowPanel ? 'primary' : 'default'" plain @click="toggleWorkflowPanel">
            <el-icon><Operation /></el-icon>
            工作流
          </el-button>
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
        <span class="wf-hint">已选 {{ selectedStoryboardIds.length }} 个分镜</span>
        <el-checkbox-group v-model="pipelineSteps" size="small" class="wf-steps">
          <el-checkbox value="image">生图</el-checkbox>
          <el-checkbox value="video">生视频</el-checkbox>
          <el-checkbox value="audio">配音</el-checkbox>
        </el-checkbox-group>
        <el-button size="small" :disabled="selectedStoryboardIds.length === 0" @click="onCreateWorkflowGroup">
          创建工作流
        </el-button>
        <el-select
          v-model="activeGroupId"
          size="small"
          placeholder="选择工作流"
          clearable
          style="width: 160px"
        >
          <el-option
            v-for="g in workflowGroups"
            :key="g.id"
            :label="`${g.title} (${(g.storyboard_ids || []).length}镜)`"
            :value="g.id"
          />
        </el-select>
        <el-button
          size="small"
          type="primary"
          :loading="workflowRunning"
          :disabled="!activeGroupId"
          @click="onRunActiveGroup"
        >
          整组重跑
        </el-button>
        <el-button size="small" type="danger" plain :disabled="!activeGroupId" @click="onDeleteActiveGroup">
          删除工作流
        </el-button>
      </div>

      <div v-if="showWorkflowPanel && workflowProgress" class="workflow-progress">{{ workflowProgress }}</div>

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
        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>角色 {{ (drama.characters || []).length }}</span>
            <el-button link size="small" type="primary" @click="openCreateDialog('character')">+</el-button>
          </div>
          <div
            v-for="c in (drama.characters || [])"
            :key="'c-' + c.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'char:' + c.id }"
            @click="selectSidebarAsset('char:' + c.id)"
          >
            {{ c.name || '未命名' }}
          </div>
        </div>
        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>场景 {{ (drama.scenes || []).length }}</span>
            <el-button link size="small" type="primary" @click="openCreateDialog('scene')">+</el-button>
          </div>
          <div
            v-for="s in (drama.scenes || [])"
            :key="'s-' + s.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'scene:' + s.id }"
            @click="selectSidebarAsset('scene:' + s.id)"
          >
            {{ s.location || '未命名' }}
          </div>
        </div>
        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>道具 {{ (drama.props || []).length }}</span>
            <el-button link size="small" type="primary" @click="openCreateDialog('prop')">+</el-button>
          </div>
          <div
            v-for="p in (drama.props || [])"
            :key="'p-' + p.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'prop:' + p.id }"
            @click="selectSidebarAsset('prop:' + p.id)"
          >
            {{ p.name || '未命名' }}
          </div>
        </div>

        <div class="sidebar-section workflow-list">
          <div class="sec-label">工作流 {{ workflowGroups.length }}</div>
          <div
            v-for="g in workflowGroups"
            :key="g.id"
            class="sidebar-item workflow-item"
            :class="{ active: activeGroupId === g.id }"
            @click="activeGroupId = g.id"
          >
            <div class="wf-item-title">{{ g.title }}</div>
            <div class="wf-item-meta">{{ (g.storyboard_ids || []).length }} 镜 · {{ (g.pipeline || []).join('→') }}</div>
          </div>
          <div v-if="!workflowGroups.length" class="sidebar-empty">框选分镜后点「创建工作流」</div>
        </div>

        <p class="sidebar-tip">经典模式流水线：分镜 → 脚本摘要 → 分镜图 → 视频。摘要节点是画布可视化，列表里合并在分镜编辑区。顶栏「本集生成」可 AI 批量操作；单击分镜可单镜生图/生视频。</p>
      </aside>

      <div ref="canvasMainRef" class="canvas-main">
        <VueFlow
          v-if="nodes.length"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :node-types="nodeTypes"
          :default-viewport="initialViewport"
          :min-zoom="0.08"
          :max-zoom="2"
          :nodes-connectable="false"
          :elements-selectable="true"
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
          @pane-click="onPaneClick"
          @pane-context-menu="onPaneContextMenu"
          @node-drag-stop="scheduleLayoutSave"
          @viewport-change="onViewportChange"
          @move-end="scheduleLayoutSave"
          @selection-change="onSelectionChange"
        >
          <CanvasFlowAligner />
          <Background pattern-color="#3f3f46" :gap="20" />
          <Controls />
          <MiniMap pannable zoomable />
        </VueFlow>
        <el-empty v-else-if="!loading" description="暂无画布数据" />
        <CanvasFloatingToolbar v-if="drama && nodes.length" />
      </div>
    </div>

    <CanvasDirectorStage
      v-if="directorStageVisible && drama"
      :visible="directorStageVisible"
      :drama="drama"
      :initial-state="directorTimeline"
      @close="directorStageVisible = false"
      @state-change="onDirectorStateChange"
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
      @select="onContextMenuSelect"
      @close="closeContextMenu"
    />
  </div>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, provide, ref, watch } from 'vue'
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
import { useTheme } from '@/composables/useTheme'
import { runWorkflowGroup } from '@/composables/useCanvasWorkflowRunner'
import { CANVAS_CONTEXT_KEY } from '@/composables/useCanvasContext'
import { useCanvasStoryboardMedia } from '@/composables/useCanvasStoryboardMedia'
import { useCanvasCrud } from '@/composables/useCanvasCrud'
import { useCanvasEpisodeGenerate } from '@/composables/useCanvasEpisodeGenerate'
import { useCanvasScript, scriptNodeId } from '@/composables/useCanvasScript'
import { createCanvasNodeStatusStore } from '@/composables/useCanvasNodeStatus'
import {
  applyCanvasHighlight,
  buildDramaCanvasGraph,
  computeAutoLayoutPositions,
  getStoryboardRefFromNode,
  stampEdgeBaseStyles,
} from '@/utils/dramaCanvasAdapter'
import {
  buildCanvasLayoutPayload,
  parseCanvasLayout,
  parseDramaMetadata,
  resolveViewport,
} from '@/utils/canvasLayout'
import {
  createWorkflowGroup,
  deleteWorkflowGroup,
  findStoryboardInDrama,
  normalizePipeline,
  parseWorkflowGroups,
  storyboardIdFromNodeId,
  getDramaGenerationOptions,
} from '@/utils/canvasWorkflow'

import CanvasLabelNode from '@/components/dramaCanvas/CanvasLabelNode.vue'
import CanvasDramaHeaderNode from '@/components/dramaCanvas/CanvasDramaHeaderNode.vue'
import CanvasAssetNode from '@/components/dramaCanvas/CanvasAssetNode.vue'
import CanvasEpisodeNode from '@/components/dramaCanvas/CanvasEpisodeNode.vue'
import CanvasScriptNode from '@/components/dramaCanvas/CanvasScriptNode.vue'
import CanvasStoryboardNode from '@/components/dramaCanvas/CanvasStoryboardNode.vue'
import CanvasMediaNode from '@/components/dramaCanvas/CanvasMediaNode.vue'
import CanvasCreateDialog from '@/components/dramaCanvas/CanvasCreateDialog.vue'
import CanvasContextMenu from '@/components/dramaCanvas/CanvasContextMenu.vue'
import CanvasAddButtonNode from '@/components/dramaCanvas/CanvasAddButtonNode.vue'
import CanvasFloatingToolbar from '@/components/dramaCanvas/CanvasFloatingToolbar.vue'
import CanvasFlowAligner from '@/components/dramaCanvas/CanvasFlowAligner.vue'
import CanvasDirectorStage from '@/components/dramaCanvas/CanvasDirectorStage.vue'
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
const filterEpisodeId = ref(null)
const highlightAssetId = ref(null)
const layoutCache = ref(null)
const workflowGroups = ref([])
const activeGroupId = ref(null)
const selectedStoryboardIds = ref([])
const pipelineSteps = ref(['image', 'video', 'audio'])
const workflowRunning = ref(false)
const workflowProgress = ref('')
const layoutSaveState = ref('idle')
const layoutDirty = ref(false)
const currentViewport = ref({ x: 0, y: 0, zoom: 0.75 })
const focusedNodeId = ref(null)
const sidebarVisible = ref(false)
const showWorkflowPanel = ref(false)
const directorStageVisible = ref(false)
const canvasMainRef = ref(null)
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuFlowPos = ref(null)
const paneClickSuppressed = ref(false)
const nodeStatus = createCanvasNodeStatusStore()
const aligningNodes = ref(false)
const canvasFlowApi = ref(null)

const PANEL_NODE_TYPES = new Set(['canvasStoryboard', 'canvasMedia', 'canvasAsset', 'canvasScript'])

let saveTimer = null
let savedHintTimer = null
let pollTimer = null
let paneClickSuppressTimer = null

const nodeTypes = {
  canvasLabel: markRaw(CanvasLabelNode),
  canvasDramaHeader: markRaw(CanvasDramaHeaderNode),
  canvasAsset: markRaw(CanvasAssetNode),
  canvasEpisode: markRaw(CanvasEpisodeNode),
  canvasScript: markRaw(CanvasScriptNode),
  canvasStoryboard: markRaw(CanvasStoryboardNode),
  canvasMedia: markRaw(CanvasMediaNode),
  canvasAddButton: markRaw(CanvasAddButtonNode),
}

const dramaId = computed(() => Number(route.params.id))
const savedLayout = computed(() => layoutCache.value || parseCanvasLayout(drama.value?.metadata))
const directorTimeline = computed(() => savedLayout.value?.director_timeline || null)

const initialViewport = computed(() => {
  const v = resolveViewport(savedLayout.value)
  return { x: v.x, y: v.y, zoom: v.zoom }
})

const hasSavedViewport = computed(() => Boolean(savedLayout.value?.viewport))

function syncWorkflowFromDrama() {
  workflowGroups.value = parseWorkflowGroups(drama.value?.metadata)
  if (activeGroupId.value && !workflowGroups.value.some((g) => g.id === activeGroupId.value)) {
    activeGroupId.value = null
  }
}

function rebuildGraph() {
  if (!drama.value) {
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
  })
  let nextNodes = graph.nodes
  let nextEdges = stampEdgeBaseStyles(graph.edges)
  if (highlightAssetId.value) {
    const highlighted = applyCanvasHighlight(nextNodes, nextEdges, highlightAssetId.value, drama.value)
    nextNodes = highlighted.nodes
    nextEdges = highlighted.edges
  }
  nodes.value = nextNodes
  edges.value = nextEdges
}

function applyHighlight() {
  if (!nodes.value.length) return
  const highlighted = applyCanvasHighlight(
    nodes.value.map((n) => ({ ...n, class: undefined, data: { ...n.data, highlighted: false, dimmed: false } })),
    edges.value,
    highlightAssetId.value,
    drama.value
  )
  nodes.value = highlighted.nodes
  edges.value = highlighted.edges
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

function onPaneContextMenu(payload) {
  const event = payload?.event || payload
  if (event?.preventDefault) event.preventDefault()
  const flowPos = payload?.flowPosition || screenToFlowPosition(event.clientX, event.clientY)
  contextMenuFlowPos.value = flowPos
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuVisible.value = true
}

function closeContextMenu() {
  contextMenuVisible.value = false
  contextMenuFlowPos.value = null
}

function onContextMenuSelect(type) {
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
    imagesBySbId: imagesBySbId.value,
  }
}

const scriptActionsHolder = {}

provide(CANVAS_CONTEXT_KEY, {
  focusedNodeId,
  currentViewport,
  drama,
  imagesBySbId,
  videosBySbId,
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
  openDirectorStage: () => {
    directorStageVisible.value = true
  },
  toggleSidebar,
  toggleWorkflowPanel,
  focusScript: focusScriptNode,
  goListMode,
  toggleTheme,
  alignNodes: onAlignNodes,
  fitCanvasView,
  zoomIn: () => canvasFlowApi.value?.zoomIn?.({ duration: 180 }),
  zoomOut: () => canvasFlowApi.value?.zoomOut?.({ duration: 180 }),
  showCanvasHelp,
})

function clearAssetHighlight() {
  highlightAssetId.value = null
  applyHighlight()
}

function onSelectionChange({ nodes: selectedNodes }) {
  selectedStoryboardIds.value = (selectedNodes || [])
    .filter((n) => n.type === 'canvasStoryboard' && n.data?.storyboard?.id)
    .map((n) => n.data.storyboard.id)
}

function onViewportChange(viewport) {
  currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
}

function toggleSidebar() {
  sidebarVisible.value = !sidebarVisible.value
}

function toggleWorkflowPanel() {
  showWorkflowPanel.value = !showWorkflowPanel.value
}

async function shareCanvas() {
  const url = window.location.href
  try {
    await navigator.clipboard.writeText(url)
    ElMessage.success('画布链接已复制')
  } catch {
    ElMessage.info(url)
  }
}

async function fitCanvasView() {
  const api = canvasFlowApi.value
  if (!api?.fitView) return
  await api.fitView({ padding: 0.14, duration: 250, includeHiddenNodes: false })
  const viewport = api.getViewport?.()
  if (viewport) currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
}

function showCanvasHelp() {
  ElMessage.info('快捷键：空格拖动画布，Ctrl/⌘ + 滚轮缩放，双击节点打开编辑')
}

function scheduleLayoutSave() {
  layoutDirty.value = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistCanvasState({ layoutOnly: true })
  }, 700)
}

async function persistCanvasState({ layoutOnly = false, groupsOnly = false } = {}) {
  if (!dramaId.value) return

  let layoutPayload = null
  if (!groupsOnly) {
    layoutPayload = buildCanvasLayoutPayload(nodes.value, currentViewport.value, layoutCache.value)
    if (layoutOnly && layoutPayload) layoutCache.value = layoutPayload
  }
  const groupsPayload = groupsOnly || !layoutOnly ? workflowGroups.value : undefined

  layoutSaveState.value = 'saving'
  try {
    const updated = await dramaAPI.saveCanvasLayout(dramaId.value, layoutPayload, groupsPayload)
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
  } catch (e) {
    layoutSaveState.value = 'error'
    ElMessage.error(e?.message || '保存失败')
  }
}

async function onDirectorStateChange(nextState) {
  const currentLayout = layoutCache.value || parseCanvasLayout(drama.value?.metadata) || {}
  layoutCache.value = {
    ...currentLayout,
    director_timeline: nextState,
  }
  await persistCanvasState({ layoutOnly: true })
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
  if (!drama.value || !nodes.value.length || aligningNodes.value) return
  aligningNodes.value = true
  focusedNodeId.value = null
  try {
    const { positions } = computeAutoLayoutPositions(drama.value, {
      episodeId: filterEpisodeId.value,
      workflowGroups: workflowGroups.value,
      imagesBySbId: imagesBySbId.value,
      videosBySbId: videosBySbId.value,
    })
    nodes.value = nodes.value.map((n) => {
      const pos = positions[n.id]
      return pos ? { ...n, position: { x: pos.x, y: pos.y } } : n
    })
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
    await persistCanvasState({ groupsOnly: true })
    rebuildGraph()
    ElMessage.success('工作流已创建')
  } catch (_) {}
}

async function onDeleteActiveGroup() {
  if (!activeGroupId.value) return
  try {
    await ElMessageBox.confirm('确定删除该工作流？', '删除工作流', { type: 'warning' })
    workflowGroups.value = deleteWorkflowGroup(workflowGroups.value, activeGroupId.value)
    activeGroupId.value = workflowGroups.value[0]?.id || null
    await persistCanvasState({ groupsOnly: true })
    rebuildGraph()
    ElMessage.success('已删除')
  } catch (_) {}
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

  workflowRunning.value = true
  workflowProgress.value = '准备执行…'
  try {
    const summary = await runWorkflowGroup(drama.value, {
      ...group,
      pipeline: normalizePipeline(group.pipeline?.length ? group.pipeline : pipelineSteps.value),
    }, {
      stopOnError: true,
      generationOptions: getCanvasGenerationOptions(),
      reloadStoryboard: async (storyboardId) => {
        await loadDrama(true)
        return findStoryboardInDrama(drama.value, storyboardId)?.storyboard
      },
      onStepStart: ({ storyboardId, step }) => {
        workflowProgress.value = `分镜 #${storyboardId}：${step === 'image' ? '生图' : step === 'video' ? '生视频' : '配音'}…`
      },
      onStoryboardError: ({ storyboardId, error }) => {
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

function navigateToStoryboard(episodeId, storyboardId) {
  router.push({
    path: `/film/${dramaId.value}`,
    query: episodeId ? { episode: String(episodeId) } : {},
    hash: storyboardId ? `#sb-${storyboardId}` : undefined,
  })
}

function onNodeDoubleClick({ node }) {
  if (node.type === 'canvasStoryboard') {
    navigateToStoryboard(node.data.episodeId || node.data.storyboard?.episode_id, node.data.storyboard?.id)
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
  }

  if (node.type === 'canvasAsset') {
    const prefix = node.data.kind === 'character' ? 'char' : node.data.kind === 'scene' ? 'scene' : 'prop'
    selectSidebarAsset(`${prefix}:${node.data.entity.id}`)
    return
  }
  const sbId = storyboardIdFromNodeId(node.id)
  if (sbId) activeGroupId.value = workflowGroups.value.find((g) => (g.storyboard_ids || []).includes(sbId))?.id || activeGroupId.value
}

watch(filterEpisodeId, async (val) => {
  if (drama.value) await loadForDrama(drama.value, val)
  rebuildGraph()
  const query = { ...route.query }
  if (val != null) query.episode = String(val)
  else delete query.episode
  router.replace({ query }).catch(() => {})
})

watch(() => route.params.id, () => {
  highlightAssetId.value = null
  layoutCache.value = null
  activeGroupId.value = null
  selectedStoryboardIds.value = []
  focusedNodeId.value = null
  loadDrama()
}, { immediate: true })

watch(drama, () => startStatusPoll())

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
  if (savedHintTimer) clearTimeout(savedHintTimer)
  if (paneClickSuppressTimer) clearTimeout(paneClickSuppressTimer)
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
@media (max-width: 980px) {
  .canvas-topbar .header-inner { margin: 8px 10px 0; }
  .canvas-topbar .btn-theme { display: none; }
  .page-title { max-width: 160px; }
  .canvas-topbar .episode-select { width: 130px !important; }
}
@media (max-width: 680px) {
  .canvas-topbar .header-inner { padding: 7px 8px; }
  .workspace-switcher { min-width: 0; }
  .brand-copy, .breadcrumb-sep, .canvas-name, .layout-status { display: none; }
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
