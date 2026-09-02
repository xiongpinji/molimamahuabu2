<template>
  <div class="home-canvas-page">
    <header class="header canvas-topbar">
      <div class="header-inner">
        <CanvasWorkspaceSwitcher />
        <span class="page-title">自由画布</span>
        <span class="layout-status" :class="layoutSaveState">{{ layoutStatusLabel }}</span>

        <div class="header-actions">
          <el-select v-model="bindingProjectId" class="project-bind-select" size="small" placeholder="选择项目接入运行" filterable>
            <el-option v-for="project in bindingProjects" :key="project.id" :label="project.title || project.name" :value="String(project.id)" />
          </el-select>
          <el-button size="small" :loading="bindingProject" :disabled="!bindingProjectId" @click="bindToProject">接入项目</el-button>
          <div class="topbar-history" aria-label="画布历史操作">
            <button type="button" aria-label="撤销" title="撤销（Ctrl/Cmd+Z）" :disabled="!canUndo" @click="undoCanvas">
              <el-icon><RefreshLeft /></el-icon>
            </button>
            <button type="button" aria-label="重做" title="重做（Ctrl/Cmd+Shift+Z）" :disabled="!canRedo" @click="redoCanvas">
              <el-icon><RefreshRight /></el-icon>
            </button>
          </div>
          <el-button class="canvas-recharge" size="small" type="warning" plain title="充值积分" @click="router.push({ name: 'recharge-center' })">
            <el-icon><Coin /></el-icon>
            <span>充值积分</span>
          </el-button>
          <el-button class="topbar-share" size="small" circle aria-label="分享画布" title="复制画布链接" @click="shareCanvas">
            <el-icon><Share /></el-icon>
          </el-button>
          <el-button class="topbar-add-node" type="primary" plain @click="openNodeEditor('text')">
            <el-icon><Plus /></el-icon>
            <span>添加节点</span>
          </el-button>
          <el-button class="topbar-home" plain @click="router.push('/')">
            <el-icon><List /></el-icon>
            <span>返回首页</span>
          </el-button>
        </div>
      </div>
    </header>

    <div class="canvas-shell">
      <div
        ref="canvasMainRef"
        class="canvas-main"
        :class="{ 'quick-start-visible': showStarterPanel }"
        @wheel.capture="onCanvasWheel"
        @dragover="onCanvasImageDragOver"
        @drop="onCanvasImageDrop"
      >
        <VueFlow
          v-model:nodes="nodes"
          v-model:edges="edges"
          :node-types="nodeTypes"
          :edge-types="edgeTypes"
          :default-edge-options="{ type: 'libtv' }"
          :default-viewport="initialViewport"
          :min-zoom="0.08"
          :max-zoom="8"
          :nodes-connectable="true"
          :nodes-draggable="true"
          :edges-updatable="true"
          :elements-selectable="true"
          :select-nodes-on-drag="true"
          selection-mode="partial"
          :selection-key-code="true"
          :delete-key-code="null"
          :pan-on-drag="false"
          pan-activation-key-code="Space"
          zoom-activation-key-code="Control"
          :pan-on-scroll="true"
          pan-on-scroll-mode="vertical"
          :zoom-on-scroll="false"
          :fit-view-on-init="!hasSavedViewport"
          class="vue-flow-canvas"
          @node-click="onNodeClick"
          @node-double-click="onNodeDoubleClick"
          @node-context-menu="onNodeContextMenu"
          @pane-click="onPaneClick"
          @pane-context-menu="onPaneContextMenu"
          @connect="onConnect"
          @nodes-change="onNodesChange"
          @edges-change="onEdgesChange"
          @node-drag-start="onNodeDragStart"
          @node-drag-stop="onNodeDragStop"
          @edge-update-start="onEdgeUpdateStart"
          @edge-update="onEdgeUpdate"
          @edge-update-end="onEdgeUpdateEnd"
          @viewport-change="onViewportChange"
          @move-end="scheduleSave"
        >
          <HomeCanvasFlowAligner @ready="registerCanvasFlowApi" />
          <Background pattern-color="#3f3f46" :gap="20" />
          <Controls />
          <MiniMap pannable zoomable />
        </VueFlow>

        <div v-if="!showStarterPanel && !nodes.length" class="home-empty">
          <strong>这是一个独立画布</strong>
          <span>不绑定项目，右键空白处或点击底部“+”开始创作。</span>
        </div>

        <section v-if="showStarterPanel" class="home-starter-panel" aria-label="快速开始">
          <div class="starter-heading">
            <strong>快速开始</strong>
            <span>选择一个入口，先把创作素材放进独立画布</span>
          </div>
          <div class="starter-grid">
            <button
              v-for="preset in starterPresets"
              :key="preset.id"
              type="button"
              class="starter-card"
              :aria-label="`快速开始：${preset.title}`"
              @click="openStarter(preset)"
            >
              <span class="starter-icon" aria-hidden="true">{{ preset.icon }}</span>
              <span class="starter-copy">
                <strong>{{ preset.title }}</strong>
                <small>{{ preset.description }}</small>
              </span>
            </button>
          </div>
          <span class="starter-note">快速入口只创建画布节点，不绑定项目；后续可继续编辑或接入生成流程。</span>
        </section>

        <div class="home-floating-toolbar nodrag nopan" @mousedown.stop>
          <button type="button" class="toolbar-primary" aria-label="添加节点" title="添加节点" @click="openNodeEditor('text')">
            <el-icon><Plus /></el-icon>
          </button>
          <span class="toolbar-divider" />
          <button type="button" class="toolbar-button" @click="openNodeEditor('text')">文本</button>
          <button type="button" class="toolbar-button" @click="openNodeEditor('image')">图片</button>
          <button type="button" class="toolbar-button" @click="openNodeEditor('video')">视频</button>
          <button type="button" class="toolbar-button" @click="openNodeEditor('audio')">音频</button>
          <span class="toolbar-divider" />
          <button type="button" class="toolbar-icon" aria-label="撤销" title="撤销（Ctrl/Cmd+Z）" :disabled="!canUndo" @click="undoCanvas">
            <el-icon><RefreshLeft /></el-icon>
          </button>
          <button type="button" class="toolbar-icon" aria-label="重做" title="重做（Ctrl/Cmd+Shift+Z）" :disabled="!canRedo" @click="redoCanvas">
            <el-icon><RefreshRight /></el-icon>
          </button>
          <span class="toolbar-divider" />
          <button type="button" class="toolbar-icon" aria-label="画布帮助" title="帮助" @click="showHelp">
            <el-icon><QuestionFilled /></el-icon>
          </button>
          <button type="button" class="toolbar-icon" aria-label="缩小画布" title="缩小" @click="zoomOut">
            <el-icon><ZoomOut /></el-icon>
          </button>
          <span class="zoom-label">{{ zoomLabel }}</span>
          <button type="button" class="toolbar-icon" aria-label="放大画布" title="放大" @click="zoomIn">
            <el-icon><ZoomIn /></el-icon>
          </button>
          <button type="button" class="toolbar-icon" aria-label="适配画布" title="适配视图" @click="fitCanvasView">
            <el-icon><FullScreen /></el-icon>
          </button>
          <button type="button" class="toolbar-icon danger" aria-label="清空画布" title="清空画布" @click="clearCanvas">
            <el-icon><Delete /></el-icon>
          </button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="contextMenuVisible"
        class="home-context-backdrop"
        @mousedown="closeContextMenu"
        @contextmenu.prevent="closeContextMenu"
      />
      <div
        v-if="contextMenuVisible"
        class="home-context-menu"
        :style="{ left: contextMenuX + 'px', top: contextMenuY + 'px' }"
        @mousedown.stop
        @contextmenu.prevent
      >
        <template v-if="contextMenuNode">
          <div class="ctx-title">节点操作 · {{ contextMenuNode.data?.title || '未命名节点' }}</div>
          <button type="button" class="ctx-item" @click="duplicateContextNode">复制节点</button>
          <button type="button" class="ctx-item danger" @click="deleteContextNode">删除节点</button>
        </template>
        <template v-else>
          <div class="ctx-title">在此添加</div>
          <button type="button" class="ctx-item" @click="openNodeEditor('text', pendingFlowPosition)">文本节点</button>
          <button type="button" class="ctx-item" @click="openNodeEditor('image', pendingFlowPosition)">图片节点</button>
          <button type="button" class="ctx-item" @click="openNodeEditor('video', pendingFlowPosition)">视频节点</button>
          <button type="button" class="ctx-item" @click="openNodeEditor('audio', pendingFlowPosition)">音频节点</button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, markRaw, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { Coin, Delete, FullScreen, List, Plus, QuestionFilled, RefreshLeft, RefreshRight, Share, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

import { CANVAS_CONTEXT_KEY } from '@/composables/useCanvasContext'
import { dramaAPI } from '@/api/drama'
import { uploadAPI } from '@/api/upload'
import request from '@/utils/request'
import CanvasWorkspaceSwitcher from '@/components/CanvasWorkspaceSwitcher.vue'
import HomeCanvasNode from '@/components/dramaCanvas/HomeCanvasNode.vue'
import HomeCanvasFlowAligner from '@/components/dramaCanvas/HomeCanvasFlowAligner.vue'
import LibTvCanvasEdge from '@/components/dramaCanvas/LibTvCanvasEdge.vue'
import {
  canvasNodeKind,
  resolveCanvasNodeConnection,
  toLibTvCanvasEdge,
} from '@/utils/canvasNodeContracts'
import {
  HOME_CANVAS_STORAGE_KEY,
  createHomeCanvasState,
  createHomeCanvasHistory,
  commitHomeCanvasHistory,
  hasDuplicateHomeCanvasEdge,
  normalizeHomeCanvasState,
  removeSelectedHomeCanvasElements,
  redoHomeCanvasHistory,
  serializeHomeCanvasState,
  undoHomeCanvasHistory,
} from '@/utils/homeCanvasState'
import { parseCanvasLayout, parseDramaMetadata } from '@/utils/canvasLayout'
import { mergeLocalCanvasIntoProjectLayout } from '@/utils/localCanvasBinding'
import {
  collectDroppedImageFiles,
  createDroppedImageNodeSpecs,
  hasDraggedFilePayload,
  stripLocalImagePreviewsForPersistence,
} from '@/utils/canvasImageDrop'
import {
  buildFreeCanvasReferenceMentionCandidates,
  collectDirectUpstreamImageReferences,
  collectDirectUpstreamMediaReferences,
  getFreeCanvasNodeResultUrl,
  normalizeFreeCanvasSubmissionReferences,
} from '@/utils/freeCanvasGeneration'
import {
  canvasModelCapability,
  canvasModelEntry,
  canvasModelOptions,
  estimateCanvasCredits,
  normalizeCanvasModelCatalog,
} from '@/utils/canvasModelCapabilities'
import { cloneSingleCanvasNodeWithIncidentEdges } from '@/utils/canvasDuplicate'

const router = useRouter()

const canvasMainRef = ref(null)
const nodes = ref([])
const edges = ref([])
const currentViewport = ref({ x: 0, y: 0, zoom: 0.75 })
const hasSavedViewport = ref(false)
const canvasFlowApi = ref(null)
const layoutSaveState = ref('idle')
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const pendingFlowPosition = ref(null)
const contextMenuNode = ref(null)
const activeNodeId = ref('')
const historyState = ref(createHomeCanvasHistory(createHomeCanvasState()))
const dragHistorySnapshot = ref(null)
const edgeHistorySnapshot = ref(null)
const canvasClipboard = ref(null)
let canvasPasteSequence = 0
let canvasNodeSequence = 0
let saveTimer = null
let canvasAlive = true
const localPreviewUrls = new Set()
const bindingProjects = ref([])
const bindingProjectId = ref('')
const bindingProject = ref(false)
const homeCanvasModelCatalog = ref([])

const nodeTypes = { homeCanvasNode: markRaw(HomeCanvasNode) }
const edgeTypes = { libtv: markRaw(LibTvCanvasEdge) }
const initialViewport = computed(() => currentViewport.value)
const zoomLabel = computed(() => `${Math.round(Number(currentViewport.value.zoom || 0.75) * 100)}%`)
const layoutStatusLabel = computed(() => ({ saving: '保存中…', saved: '已保存', error: '保存失败' }[layoutSaveState.value] || '本地画布'))
const canUndo = computed(() => historyState.value.past.length > 0)
const canRedo = computed(() => historyState.value.future.length > 0)
const starterPresets = Object.freeze([
  { id: 'script', icon: '☷', title: '故事脚本生成', description: '先写下故事梗概与角色设定', kind: 'text', nodeTitle: '故事脚本', nodeContent: '输入故事梗概、人物关系和场景目标。' },
  { id: 'character', icon: '♙', title: '角色三视图', description: '整理角色参考图和视觉设定', kind: 'image', nodeTitle: '角色三视图', nodeContent: '填写角色参考图地址，补充服装、动作和镜头备注。' },
  { id: 'first-frame', icon: '▧', title: '首帧图生视频', description: '从首帧画面继续整理视频素材', kind: 'video', nodeTitle: '首帧图生视频', nodeContent: '先记录首帧画面要求，再补充视频地址或生成结果。' },
  { id: 'audio-video', icon: '▶', title: '音频生视频', description: '把音频、画面和节奏放在一起', kind: 'video', nodeTitle: '音频生视频', nodeContent: '记录音频内容、画面节奏和视频地址。' },
])
const showStarterPanel = computed(() => {
  if (!nodes.value.length) return true
  return nodes.value.length === 1 && nodes.value[0]?.id === 'home:welcome'
})

function nodeById(id, nodeList = nodes.value) {
  return nodeList.find((node) => String(node.id) === String(id))
}

function decorateEdge(edge, nodeList = nodes.value) {
  return toLibTvCanvasEdge(
    edge,
    canvasNodeKind(nodeById(edge.source, nodeList)),
    canvasNodeKind(nodeById(edge.target, nodeList))
  )
}

function decorateEdges(edgeList, nodeList = nodes.value) {
  return (edgeList || []).filter((edge) => {
    const sourceKind = canvasNodeKind(nodeById(edge.source, nodeList))
    const targetKind = canvasNodeKind(nodeById(edge.target, nodeList))
    return !sourceKind || !targetKind || resolveCanvasNodeConnection(sourceKind, targetKind).allowed
  }).map((edge) => decorateEdge(edge, nodeList))
}

function connectionContract(source, target) {
  return resolveCanvasNodeConnection(
    canvasNodeKind(nodeById(source)),
    canvasNodeKind(nodeById(target))
  )
}

function loadState() {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(HOME_CANVAS_STORAGE_KEY)
  const state = normalizeHomeCanvasState(raw || createHomeCanvasState())
  nodes.value = state.nodes
  edges.value = decorateEdges(state.edges, state.nodes)
  currentViewport.value = state.viewport
  hasSavedViewport.value = Boolean(raw)
  historyState.value = createHomeCanvasHistory(state)
}

function currentCanvasState() {
  return normalizeHomeCanvasState(serializeHomeCanvasState({
    nodes: nodes.value,
    edges: edges.value,
    viewport: currentViewport.value,
  }))
}

function commitHistory(previousState) {
  historyState.value = commitHomeCanvasHistory(historyState.value, previousState, currentCanvasState())
}

function applyCanvasState(state) {
  const next = normalizeHomeCanvasState(state)
  nodes.value = next.nodes
  edges.value = decorateEdges(next.edges, next.nodes)
  currentViewport.value = next.viewport
}

function persistState() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(HOME_CANVAS_STORAGE_KEY, serializeHomeCanvasState({
      nodes: stripLocalImagePreviewsForPersistence(nodes.value),
      edges: edges.value,
      viewport: currentViewport.value,
    }))
    layoutSaveState.value = 'saved'
  } catch {
    layoutSaveState.value = 'error'
  }
}

function scheduleSave() {
  layoutSaveState.value = 'saving'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistState()
  }, 300)
}

function onViewportChange(viewport) {
  currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
}

function onCanvasWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  event.stopPropagation()
  const action = event.deltaY < 0
    ? canvasFlowApi.value?.zoomIn?.({ duration: 0 })
    : event.deltaY > 0
      ? canvasFlowApi.value?.zoomOut?.({ duration: 0 })
      : null
  const syncViewport = () => {
    const viewport = canvasFlowApi.value?.getViewport?.()
    if (!viewport) return
    currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    scheduleSave()
  }
  if (action && typeof action.finally === 'function') action.finally(syncViewport)
  else syncViewport()
}

function onConnect(connection) {
  const source = String(connection?.source || '')
  const target = String(connection?.target || '')
  if (!source || !target || source === target) return
  const sourceHandle = connection?.sourceHandle ? String(connection.sourceHandle) : undefined
  const targetHandle = connection?.targetHandle ? String(connection.targetHandle) : undefined
  const exists = hasDuplicateHomeCanvasEdge(edges.value, { source, target, sourceHandle, targetHandle })
  if (exists) return
  if (!connectionContract(source, target).allowed) {
    ElMessage.warning('节点契约不匹配：当前输出不能作为目标节点输入')
    return
  }
  const previousState = currentCanvasState()
  const order = edges.value.filter((edge) => String(edge.target) === target).length
  edges.value = [
    ...edges.value,
    decorateEdge({
      id: String(connection.id || `home:edge:${source}:${target}:${Date.now()}`),
      source,
      target,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
      data: { manual: true, contract: { order } },
    }),
  ]
  commitHistory(previousState)
  scheduleSave()
}

function freeCanvasReferenceCandidates(nodeOrId) {
  const targetId = String(nodeOrId || '')
  return buildFreeCanvasReferenceMentionCandidates(
    normalizeFreeCanvasSubmissionReferences(
      collectDirectUpstreamImageReferences(nodes.value, edges.value, targetId),
    ),
  )
}

function attachFreeCanvasReference(targetNodeId, sourceNodeId) {
  onConnect({
    source: String(sourceNodeId || ''),
    target: String(targetNodeId || ''),
  })
}

function freeCanvasNodeInputReferences(nodeId) {
  const node = nodeById(nodeId)
  return node?.data?.kind === 'video'
    ? collectDirectUpstreamMediaReferences(nodes.value, edges.value, String(nodeId || ''))
    : collectDirectUpstreamImageReferences(nodes.value, edges.value, String(nodeId || ''))
}

function getFreeNodeModelOptions(kind) {
  return canvasModelOptions(homeCanvasModelCatalog.value, kind)
}

function getFreeNodeModelCapability(kind, model) {
  return canvasModelCapability(homeCanvasModelCatalog.value, kind, model)
}

function getFreeNodeModelMetadata(kind, model) {
  return canvasModelEntry(homeCanvasModelCatalog.value, kind, model)
}

function getFreeNodeEstimatedCredits(kind, model, quantity, duration, resolution) {
  return estimateCanvasCredits(homeCanvasModelCatalog.value, kind, model, quantity, duration, resolution)
}

async function loadHomeCanvasModelCatalog() {
  try {
    const catalog = await request.get('/canvas/model-catalog')
    homeCanvasModelCatalog.value = normalizeCanvasModelCatalog(Array.isArray(catalog) ? catalog : [])
  } catch (error) {
    homeCanvasModelCatalog.value = []
    console.warn('load home canvas model catalog failed', error)
  }
}

function updateFreeCanvasReference(edgeId, patch = {}) {
  const previousState = currentCanvasState()
  let changed = false
  edges.value = edges.value.map((edge) => {
    if (String(edge.id) !== String(edgeId)) return edge
    changed = true
    return decorateEdge({
      ...edge,
      data: {
        ...(edge.data || {}),
        contract: { ...(edge.data?.contract || {}), ...patch },
      },
    })
  })
  if (!changed) return
  commitHistory(previousState)
  scheduleSave()
}

function detachFreeCanvasReference(edgeId) {
  const previousState = currentCanvasState()
  const nextEdges = edges.value.filter((edge) => String(edge.id) !== String(edgeId))
  if (nextEdges.length === edges.value.length) return
  edges.value = nextEdges
  commitHistory(previousState)
  scheduleSave()
}

function onNodesChange(changes = []) {
  if (changes.some((change) => !['select', 'position', 'dimensions'].includes(change.type))) scheduleSave()
}

function onEdgesChange(changes = []) {
  if (changes.some((change) => change.type !== 'select')) scheduleSave()
}

function onNodeDragStart() {
  dragHistorySnapshot.value = currentCanvasState()
}

function onNodeDragStop() {
  if (dragHistorySnapshot.value) commitHistory(dragHistorySnapshot.value)
  dragHistorySnapshot.value = null
  scheduleSave()
}

function onEdgeUpdateStart() {
  edgeHistorySnapshot.value = currentCanvasState()
}

function onEdgeUpdate({ edge, connection } = {}) {
  const source = String(connection?.source || '')
  const target = String(connection?.target || '')
  if (!edge?.id || !source || !target || source === target) return
  const duplicate = hasDuplicateHomeCanvasEdge(edges.value, {
    id: edge.id,
    source,
    target,
    sourceHandle: connection.sourceHandle,
    targetHandle: connection.targetHandle,
  })
  if (duplicate) {
    ElMessage.warning('该连接已存在')
    return
  }
  if (!connectionContract(source, target).allowed) {
    ElMessage.warning('节点契约不匹配：当前输出不能作为目标节点输入')
    return
  }
  const previousState = edgeHistorySnapshot.value || currentCanvasState()
  edges.value = edges.value.map((item) => {
    if (item.id !== edge.id) return item
    const updated = { ...item, source, target }
    if (connection.sourceHandle) updated.sourceHandle = String(connection.sourceHandle)
    else delete updated.sourceHandle
    if (connection.targetHandle) updated.targetHandle = String(connection.targetHandle)
    else delete updated.targetHandle
    return decorateEdge(updated)
  })
  edgeHistorySnapshot.value = null
  commitHistory(previousState)
  scheduleSave()
}

function onEdgeUpdateEnd() {
  edgeHistorySnapshot.value = null
}

function registerCanvasFlowApi(api) {
  canvasFlowApi.value = api
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

function centerFlowPosition() {
  const el = canvasMainRef.value
  if (!el) return { x: 0, y: 0 }
  const rect = el.getBoundingClientRect()
  return screenToFlowPosition(rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function onCanvasImageDragOver(event) {
  if (!hasDraggedFilePayload(event.dataTransfer)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

async function onCanvasImageDrop(event) {
  if (!hasDraggedFilePayload(event.dataTransfer)) return
  event.preventDefault()
  event.stopPropagation()
  const files = collectDroppedImageFiles(event.dataTransfer)
  if (!files.length) return
  const origin = screenToFlowPosition(event.clientX, event.clientY) || centerFlowPosition()
  const specs = createDroppedImageNodeSpecs(files, origin, (file) => {
    const previewUrl = URL.createObjectURL(file)
    localPreviewUrls.add(previewUrl)
    return previewUrl
  })
  const droppedNodes = specs.map((spec) => ({
    spec,
    nodeId: openNodeEditor('image', spec.position, spec.data),
  }))
  for (const { spec, nodeId } of droppedNodes) {
    try {
      const uploaded = await uploadAPI.uploadImage(spec.file)
      if (!canvasAlive) {
        URL.revokeObjectURL(spec.previewUrl)
        localPreviewUrls.delete(spec.previewUrl)
        continue
      }
      const stableUrl = String(uploaded?.url || '')
      if (!stableUrl) throw new Error('图片上传成功但未返回可用地址')
      await updateFreeCanvasNode(nodeId, {
        url: String(uploaded?.url || ''),
        status: 'success',
        error: '',
        localPreview: false,
      })
      URL.revokeObjectURL(spec.previewUrl)
      localPreviewUrls.delete(spec.previewUrl)
    } catch (error) {
      if (!canvasAlive) {
        URL.revokeObjectURL(spec.previewUrl)
        localPreviewUrls.delete(spec.previewUrl)
        continue
      }
      await updateFreeCanvasNode(nodeId, {
        url: spec.previewUrl,
        status: 'failed',
        error: error?.message || '本地图片上传失败',
        localPreview: true,
      })
    }
  }
}

function onPaneContextMenu(payload) {
  const event = payload?.event || payload
  event?.preventDefault?.()
  contextMenuNode.value = null
  pendingFlowPosition.value = payload?.flowPosition || screenToFlowPosition(event?.clientX || 0, event?.clientY || 0)
  contextMenuX.value = event?.clientX || 0
  contextMenuY.value = event?.clientY || 0
  contextMenuVisible.value = true
}

function onNodeContextMenu(payload) {
  const event = payload?.event || payload
  event?.preventDefault?.()
  contextMenuNode.value = payload?.node || null
  pendingFlowPosition.value = null
  contextMenuX.value = event?.clientX || 0
  contextMenuY.value = event?.clientY || 0
  contextMenuVisible.value = Boolean(contextMenuNode.value)
}

function closeContextMenu() {
  contextMenuVisible.value = false
  pendingFlowPosition.value = null
  contextMenuNode.value = null
}

function openNodeEditor(kind, position = null, initial = null) {
  closeContextMenu()
  const previousState = currentCanvasState()
  const titles = { text: '文本', image: '图片', video: '视频', audio: '音频' }
  const nodeId = `home:${kind}:${Date.now()}:${canvasNodeSequence++}`
  nodes.value = nodes.value
    .filter((node) => node.id !== 'home:welcome')
    .map((node) => ({ ...node, selected: false }))
  nodes.value.push({
    id: nodeId,
    type: 'homeCanvasNode',
    position: position || centerFlowPosition(),
    selected: true,
    data: {
      kind,
      title: initial?.title || titles[kind] || '节点',
      content: initial?.content || '',
      url: initial?.url || '',
      ...(initial || {}),
    },
  })
  activeNodeId.value = nodeId
  pendingFlowPosition.value = null
  commitHistory(previousState)
  scheduleSave()
  return nodeId
}

function openStarter(preset) {
  openNodeEditor(preset.kind, centerFlowPosition(), {
    title: preset.nodeTitle,
    content: preset.nodeContent,
    url: '',
  })
}

function onNodeClick({ node }) {
  if (!node?.id) return
  selectNodeById(node.id)
}

async function loadBindingProjects() {
  try {
    const result = await dramaAPI.list({ page: 1, page_size: 100 })
    bindingProjects.value = Array.isArray(result) ? result : (result?.items || result?.data || [])
  } catch (error) {
    console.warn('load projects for local canvas binding failed', error)
  }
}

function readCanvasStateRevision(metadata) {
  const revision = Number(parseDramaMetadata(metadata)?.canvas_state_revision)
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
}

async function bindToProject() {
  if (!bindingProjectId.value || bindingProject.value) return
  bindingProject.value = true
  try {
    persistState()
    const project = await dramaAPI.get(bindingProjectId.value)
    const merged = mergeLocalCanvasIntoProjectLayout(
      parseCanvasLayout(project?.metadata),
      currentCanvasState(),
      `local:${Date.now()}`,
    )
    await dramaAPI.saveCanvasLayout(bindingProjectId.value, merged, project?.workflow_groups, readCanvasStateRevision(project?.metadata))
    ElMessage.success('本地节点已合并到项目画布，生成与素材闭环已启用')
    await router.push(`/canvas/${bindingProjectId.value}`)
  } catch (error) {
    ElMessage.error(error?.message || '接入项目失败')
  } finally {
    bindingProject.value = false
  }
}

function selectNodeById(nodeId) {
  activeNodeId.value = String(nodeId)
  nodes.value = nodes.value.map((item) => ({ ...item, selected: String(item.id) === String(nodeId) }))
}

function onNodeDoubleClick(payload) {
  onNodeClick(payload)
}

async function updateFreeCanvasNode(nodeId, patch) {
  const previousState = currentCanvasState()
  let changed = false
  nodes.value = nodes.value.map((node) => {
    if (String(node.id) !== String(nodeId)) return node
    changed = true
    return { ...node, data: { ...node.data, ...patch } }
  })
  if (!changed) return
  commitHistory(previousState)
  scheduleSave()
}

async function deleteFreeCanvasNode(nodeId) {
  const previousState = currentCanvasState()
  const id = String(nodeId)
  nodes.value = nodes.value.filter((node) => String(node.id) !== id)
  edges.value = edges.value.filter((edge) => String(edge.source) !== id && String(edge.target) !== id)
  commitHistory(previousState)
  scheduleSave()
}

function duplicateContextNode() {
  const source = contextMenuNode.value
  if (!source) return
  const previousState = currentCanvasState()
  const nextId = nextDuplicateNodeId(source.id)
  const { node: clone, edges: clonedEdges } = cloneSingleCanvasNodeWithIncidentEdges({
    sourceNode: source,
    edges: edges.value,
    nextNodeId: nextId,
    nextEdgeId: (edge, index) => `${edge.id || 'edge'}:copy:${nextId}:${index}`,
    createNode: (node) => ({
      ...node,
      id: nextId,
      position: {
        x: Number(source.position?.x || 0) + 40,
        y: Number(source.position?.y || 0) + 40,
      },
      selected: true,
      dragging: false,
      data: {
        ...node.data,
        title: `${node.data?.title || '未命名节点'} 副本`,
      },
    }),
  })
  nodes.value = [
    ...nodes.value.map((node) => ({ ...node, selected: false })),
    clone,
  ]
  const nextNodes = nodes.value
  edges.value = [
    ...edges.value.map((edge) => ({ ...edge, selected: false })),
    ...decorateEdges(clonedEdges, nextNodes),
  ]
  closeContextMenu()
  commitHistory(previousState)
  scheduleSave()
  ElMessage.success('已复制节点')
}

function nextDuplicateNodeId(sourceId) {
  let candidate = ''
  do {
    candidate = `${sourceId}:copy:${canvasNodeSequence++}`
  } while (nodes.value.some((node) => String(node.id) === String(candidate)))
  return candidate
}

async function deleteContextNode() {
  const nodeId = contextMenuNode.value?.id
  closeContextMenu()
  if (nodeId) await deleteFreeCanvasNode(nodeId)
}

function onPaneClick() {
  closeContextMenu()
  activeNodeId.value = null
  nodes.value = nodes.value.map((node) => ({ ...node, selected: false }))
  edges.value = edges.value.map((edge) => ({ ...edge, selected: false }))
}

async function clearCanvas() {
  try {
    await ElMessageBox.confirm('清空后将删除首页自由画布中的全部节点，是否继续？', '清空画布', { type: 'warning' })
  } catch {
    return
  }
  const previousState = currentCanvasState()
  nodes.value = []
  edges.value = []
  commitHistory(previousState)
  scheduleSave()
}

async function fitCanvasView() {
  const api = canvasFlowApi.value
  if (!api?.fitView) return
  await api.fitView({ padding: 0.18, duration: 240, includeHiddenNodes: false })
  const viewport = api.getViewport?.()
  if (viewport) currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
  scheduleSave()
}

function zoomIn() { canvasFlowApi.value?.zoomIn?.({ duration: 180 }) }
function zoomOut() { canvasFlowApi.value?.zoomOut?.({ duration: 180 }) }

function undoCanvas() {
  const nextHistory = undoHomeCanvasHistory(historyState.value)
  if (nextHistory === historyState.value) return
  historyState.value = nextHistory
  applyCanvasState(nextHistory.present)
  scheduleSave()
}

function redoCanvas() {
  const nextHistory = redoHomeCanvasHistory(historyState.value)
  if (nextHistory === historyState.value) return
  historyState.value = nextHistory
  applyCanvasState(nextHistory.present)
  scheduleSave()
}

function cloneCanvasValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function copySelectedCanvasElements() {
  const state = currentCanvasState()
  const selectedNodes = state.nodes.filter((node) => node.selected)
  if (!selectedNodes.length) return
  const selectedIds = new Set(selectedNodes.map((node) => node.id))
  canvasClipboard.value = {
    nodes: cloneCanvasValue(selectedNodes).map((node) => {
      delete node.selected
      delete node.dragging
      return node
    }),
    edges: cloneCanvasValue(state.edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))).map((edge) => {
      delete edge.selected
      return edge
    }),
  }
  ElMessage.success(`已复制 ${selectedNodes.length} 个节点`)
}

function pasteCanvasElements() {
  const clipboard = canvasClipboard.value
  if (!clipboard?.nodes?.length) return
  const previousState = currentCanvasState()
  const pasteStamp = `${Date.now()}:${canvasPasteSequence++}`
  const idMap = new Map()
  const pastedNodes = clipboard.nodes.map((node, index) => {
    const nextId = `${node.id}:copy:${pasteStamp}:${index}`
    idMap.set(node.id, nextId)
    return {
      ...cloneCanvasValue(node),
      id: nextId,
      position: {
        x: Number(node.position?.x || 0) + 40,
        y: Number(node.position?.y || 0) + 40,
      },
      selected: true,
    }
  })
  const pastedEdges = clipboard.edges
    .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
    .map((edge, index) => ({
      ...cloneCanvasValue(edge),
      id: `${edge.id}:copy:${pasteStamp}:${index}`,
      source: idMap.get(edge.source),
      target: idMap.get(edge.target),
      selected: false,
    }))
  nodes.value = [
    ...nodes.value.map((node) => ({ ...node, selected: false })),
    ...pastedNodes,
  ]
  const nextNodes = nodes.value
  edges.value = [
    ...edges.value.map((edge) => ({ ...edge, selected: false })),
    ...decorateEdges(pastedEdges, nextNodes),
  ]
  commitHistory(previousState)
  scheduleSave()
  ElMessage.success(`已粘贴 ${pastedNodes.length} 个节点`)
}

function isEditableTarget(target) {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable))
}

function onCanvasKeydown(event) {
  if (isEditableTarget(event.target)) return
  const key = String(event.key || '').toLowerCase()
  const modifier = event.ctrlKey || event.metaKey
  if (modifier && !event.altKey && !event.shiftKey && key === 'c') {
    event.preventDefault()
    copySelectedCanvasElements()
    return
  }
  if (modifier && !event.altKey && !event.shiftKey && key === 'v') {
    event.preventDefault()
    pasteCanvasElements()
    return
  }
  if (modifier && !event.altKey && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redoCanvas()
    else undoCanvas()
    return
  }
  if (modifier && !event.altKey && key === 'y') {
    event.preventDefault()
    redoCanvas()
    return
  }
  if ((event.key !== 'Delete' && event.key !== 'Backspace') || modifier || event.altKey) return
  const previousState = currentCanvasState()
  const nextState = removeSelectedHomeCanvasElements(previousState)
  if (serializeHomeCanvasState(previousState) === serializeHomeCanvasState(nextState)) return
  event.preventDefault()
  applyCanvasState(nextState)
  commitHistory(previousState)
  scheduleSave()
}

function showHelp() {
  ElMessage.info('空格 + 鼠标左键拖动画布；Ctrl + 滚轮缩放；普通滚轮上下滚动画布；Ctrl/Cmd+C/V 复制粘贴；空白处右键添加，节点右键复制或删除。')
}

async function shareCanvas() {
  const url = window.location.href
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: '茉莉妈妈 · 首页自由画布',
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

loadState()

provide(CANVAS_CONTEXT_KEY, {
  isFreeCanvasNodeSelected: (nodeId) => activeNodeId.value === String(nodeId),
  setFocusedNode: selectNodeById,
  updateFreeCanvasNode,
  deleteFreeCanvasNode,
  getFreeNodeInputReferences: freeCanvasNodeInputReferences,
  getFreeNodeModelOptions,
  getFreeNodeModelCapability,
  getFreeNodeModelMetadata,
  getFreeNodeEstimatedCredits,
  getFreeNodeReferenceCandidates: freeCanvasReferenceCandidates,
  attachFreeCanvasReference,
  updateFreeCanvasReference,
  detachFreeCanvasReference,
})

onMounted(() => {
  canvasAlive = true
  window.addEventListener('keydown', onCanvasKeydown)
  void loadBindingProjects()
  void loadHomeCanvasModelCatalog()
})

onBeforeUnmount(() => {
  canvasAlive = false
  window.removeEventListener('keydown', onCanvasKeydown)
  if (saveTimer) clearTimeout(saveTimer)
  for (const previewUrl of localPreviewUrls) URL.revokeObjectURL(previewUrl)
  localPreviewUrls.clear()
  persistState()
})
</script>

<style scoped>
.home-canvas-page { height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: #080808; color: var(--text-primary, #e4e4e7); }
.header { flex-shrink: 0; border-bottom: 1px solid var(--border-color, #27272a); background: var(--bg-card, #18181b); }
.canvas-topbar { position: absolute; inset: 0 0 auto; z-index: 30; border-bottom: 0; background: transparent; pointer-events: none; }
.header-inner { display: flex; align-items: center; gap: 12px; min-width: 0; margin: 20px 24px 0; padding: 7px 8px; flex-wrap: nowrap; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; background: rgba(12, 12, 12, 0.9); box-shadow: 0 14px 38px rgba(0, 0, 0, 0.34); backdrop-filter: blur(18px); pointer-events: auto; }
.logo { cursor: pointer; display: flex; align-items: center; gap: 10px; line-height: 1.2; }
.brand-logo { width: 40px; height: 40px; object-fit: cover; border-radius: 11px; flex: 0 0 auto; }
.brand-copy { display: flex; flex-direction: column; }
.logo-main { font-size: 15px; font-weight: 700; color: var(--text-bright, #fafafa); }
.logo-sub { font-size: 11px; color: #818cf8; }
.page-title { max-width: 220px; min-width: 0; overflow: hidden; flex: 0 1 auto; padding-left: 13px; border-left: 1px solid #303030; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; color: #efefef; }
.canvas-name { padding-left: 12px; border-left: 1px solid #3f3f46; color: #a1a1aa; font-size: 12px; white-space: nowrap; }
.header-actions { min-width: 0; margin-left: auto; display: flex; flex: 0 0 auto; gap: 6px; }
.topbar-history { display: inline-flex; align-items: center; padding: 3px; border: 1px solid #292929; border-radius: 10px; background: #111; }
.topbar-history button { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 7px; color: #9a9a9a; background: transparent; cursor: pointer; }
.topbar-history button:hover:not(:disabled) { color: #fff; background: #202020; }
.topbar-history button:disabled { opacity: .34; cursor: not-allowed; }
.topbar-share { width: 38px; padding: 0; }
.layout-status { font-size: 11px; white-space: nowrap; }
.layout-status.saving { color: #60a5fa; }
.layout-status.saved { color: #34d399; }
.layout-status.error { color: #f87171; }
.canvas-shell { flex: 1; display: flex; min-height: 0; width: 100%; }
.canvas-main { position: relative; flex: 1; min-width: 0; width: 100%; height: 100%; }
.vue-flow-canvas { width: 100%; height: 100%; background: #0b0b0b; }
:deep(.vue-flow__minimap),
:deep(.vue-flow__controls) { display: none; }
:deep(.vue-flow__controls button) { background: #18181b; border-color: #3f3f46; color: #e4e4e7; }
.home-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; pointer-events: none; color: #a1a1aa; }
.home-empty strong { color: #e4e4e7; font-size: 16px; }
.home-empty span { font-size: 12px; color: #71717a; }
.quick-start-visible :deep(.vue-flow__node) { opacity: 0; pointer-events: none; }
.home-starter-panel { position: absolute; top: 50%; left: 50%; z-index: 20; width: min(900px, calc(100% - 36px)); padding: 22px; border: 1px solid #292929; border-radius: 18px; background: rgba(14, 14, 14, 0.92); box-shadow: 0 24px 68px rgba(0, 0, 0, 0.48); backdrop-filter: blur(20px); transform: translate(-50%, -42%); }
.starter-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.starter-heading strong { color: #f4f4f5; font-size: 18px; }
.starter-heading span { color: #a1a1aa; font-size: 12px; }
.starter-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.starter-card { min-height: 112px; display: flex; flex-direction: column; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px; border: 1px solid #2c2c2c; border-radius: 14px; background: #151515; color: #e4e4e7; text-align: left; cursor: pointer; transition: border-color 160ms ease, transform 160ms ease, background 160ms ease; }
.starter-card:hover { border-color: rgba(255, 113, 57, .68); background: rgba(255, 113, 57, .08); transform: translateY(-2px); }
.starter-card:focus-visible { outline: 2px solid #ff7139; outline-offset: 2px; }
.starter-icon { color: #ff8b5d; font-size: 24px; line-height: 1; }
.starter-copy { display: flex; flex-direction: column; gap: 5px; }
.starter-copy strong { font-size: 13px; }
.starter-copy small { color: #a1a1aa; font-size: 11px; line-height: 1.45; }
.starter-note { display: block; margin-top: 14px; color: #71717a; font-size: 11px; }
.home-floating-toolbar { position: absolute; left: 50%; bottom: 18px; z-index: 25; display: flex; align-items: center; gap: 4px; max-width: calc(100% - 28px); padding: 6px 10px; border: 1px solid #2d2d2d; border-radius: 17px; background: rgba(15, 15, 15, 0.94); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.44); backdrop-filter: blur(18px); transform: translateX(-50%); }
.toolbar-primary, .toolbar-button, .toolbar-icon { min-width: 42px; min-height: 42px; border: 0; border-radius: 10px; background: transparent; color: #d4d4d8; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.toolbar-primary { width: 46px; background: #ff7139; color: #111; font-size: 21px; }
.toolbar-button { padding: 0 10px; font-size: 12px; }
.toolbar-icon { width: 42px; font-size: 17px; }
.toolbar-icon:disabled { opacity: 0.38; cursor: not-allowed; }
.toolbar-icon:disabled:hover { background: transparent; color: #d4d4d8; }
.toolbar-button:hover, .toolbar-icon:hover { background: rgba(255, 113, 57, 0.14); color: #ff9a72; }
.toolbar-icon.danger:hover { color: #fca5a5; background: rgba(248, 113, 113, 0.15); }
.toolbar-divider { width: 1px; height: 24px; margin: 0 4px; background: #3f3f46; }
.zoom-label { width: 40px; color: #a1a1aa; font-size: 11px; text-align: center; font-variant-numeric: tabular-nums; }
.home-context-backdrop { position: fixed; inset: 0; z-index: 2999; }
.home-context-menu { position: fixed; z-index: 3000; min-width: 170px; padding: 7px; border: 1px solid #303030; border-radius: 12px; background: #121212; box-shadow: 0 16px 38px rgba(0, 0, 0, 0.48); }
.ctx-title { padding: 4px 12px 6px; color: #71717a; font-size: 10px; }
.ctx-item { display: block; width: 100%; padding: 9px 10px; border: 0; border-radius: 8px; background: transparent; color: #e4e4e7; font-size: 13px; text-align: left; cursor: pointer; }
.ctx-item:hover { background: rgba(255, 113, 57, 0.13); color: #ff9b75; }
@media (max-width: 920px) {
  .page-title { display: none; }
}
@media (max-width: 820px) {
  .header-inner { margin: 8px 10px 0; padding: 7px 8px; }
  .brand-copy, .breadcrumb-sep, .canvas-name, .layout-status, .btn-theme { display: none; }
  .brand-logo { width: 34px; height: 34px; }
  .header-actions .el-button { min-height: 34px; }
  .toolbar-button { padding: 0 7px; }
  .starter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 620px) {
  .page-title { max-width: 120px; }
  .toolbar-button { width: 42px; padding: 0; font-size: 0; }
  .home-floating-toolbar { gap: 2px; }
  .zoom-label { display: none; }
  .home-starter-panel { width: min(420px, calc(100% - 20px)); padding: 16px; }
  .starter-heading { display: block; }
  .starter-heading span { display: block; margin-top: 5px; }
}
@media (max-width: 480px) {
  .page-title { display: none; }
  .header-inner { gap: 6px; margin-left: 8px; margin-right: 8px; }
  .header-actions { gap: 4px; }
  .topbar-add-node,
  .topbar-home { width: 42px; padding: 0; font-size: 0; }
  .topbar-add-node .el-icon,
  .topbar-home .el-icon { margin: 0; font-size: 16px; }
  .starter-grid { grid-template-columns: 1fr; }
}
</style>

<style>
html.light .home-canvas-page { background: #080808; }
html.light .home-canvas-page .vue-flow-canvas { background: #080808; }
</style>
