<template>
  <div class="home-canvas-page">
    <header class="header canvas-topbar">
      <div class="header-inner">
        <CanvasWorkspaceSwitcher />
        <span class="breadcrumb-sep">›</span>
        <span class="page-title">首页自由画布</span>
        <span class="canvas-name">画布 1</span>
        <span class="layout-status" :class="layoutSaveState">{{ layoutStatusLabel }}</span>

        <div class="header-actions">
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
          <el-button class="btn-theme" @click="toggleTheme">
            <el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon>
            {{ isDark ? '浅色' : '暗色' }}
          </el-button>
        </div>
      </div>
    </header>

    <div class="canvas-shell">
      <div ref="canvasMainRef" class="canvas-main">
        <VueFlow
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
          pan-on-scroll-mode="vertical"
          :zoom-on-scroll="false"
          :fit-view-on-init="!hasSavedViewport"
          class="vue-flow-canvas"
          @node-double-click="onNodeDoubleClick"
          @pane-click="onPaneClick"
          @pane-context-menu="onPaneContextMenu"
          @node-drag-stop="scheduleSave"
          @viewport-change="onViewportChange"
          @move-end="scheduleSave"
        >
          <HomeCanvasFlowAligner @ready="registerCanvasFlowApi" />
          <Background pattern-color="#3f3f46" :gap="20" />
          <Controls />
          <MiniMap pannable zoomable />
        </VueFlow>

        <div v-if="!nodes.length" class="home-empty">
          <strong>这是一个独立画布</strong>
          <span>不绑定项目，右键空白处或点击底部“+”开始创作。</span>
        </div>

        <div class="home-floating-toolbar nodrag nopan" @mousedown.stop>
          <button type="button" class="toolbar-primary" aria-label="添加节点" title="添加节点" @click="openNodeEditor('text')">
            <el-icon><Plus /></el-icon>
          </button>
          <span class="toolbar-divider" />
          <button type="button" class="toolbar-button" @click="openNodeEditor('text')">文本</button>
          <button type="button" class="toolbar-button" @click="openNodeEditor('image')">图片</button>
          <button type="button" class="toolbar-button" @click="openNodeEditor('video')">视频</button>
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
        <div class="ctx-title">在此添加</div>
        <button type="button" class="ctx-item" @click="openNodeEditor('text', pendingFlowPosition)">文本节点</button>
        <button type="button" class="ctx-item" @click="openNodeEditor('image', pendingFlowPosition)">图片节点</button>
        <button type="button" class="ctx-item" @click="openNodeEditor('video', pendingFlowPosition)">视频节点</button>
      </div>
    </Teleport>

    <el-dialog v-model="editorVisible" :title="editingNodeId ? '编辑节点' : '添加节点'" width="460px" destroy-on-close>
      <el-form label-position="top" @submit.prevent="submitNode">
        <el-form-item label="标题" required>
          <el-input v-model="editorForm.title" maxlength="80" placeholder="例如：开场氛围" />
        </el-form-item>
        <el-form-item :label="editorKind === 'text' ? '内容' : '说明'">
          <el-input v-model="editorForm.content" type="textarea" :rows="4" placeholder="填写节点内容" />
        </el-form-item>
        <el-form-item v-if="editorKind !== 'text'" :label="editorKind === 'image' ? '图片地址' : '视频地址'">
          <el-input v-model="editorForm.url" placeholder="支持 http(s) 或本地静态资源地址" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!editorForm.title.trim()" @click="submitNode">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, markRaw, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { Delete, FullScreen, List, Moon, Plus, QuestionFilled, Share, Sunny, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

import { useTheme } from '@/composables/useTheme'
import CanvasWorkspaceSwitcher from '@/components/CanvasWorkspaceSwitcher.vue'
import HomeCanvasNode from '@/components/dramaCanvas/HomeCanvasNode.vue'
import HomeCanvasFlowAligner from '@/components/dramaCanvas/HomeCanvasFlowAligner.vue'
import {
  HOME_CANVAS_STORAGE_KEY,
  createHomeCanvasState,
  normalizeHomeCanvasState,
  serializeHomeCanvasState,
} from '@/utils/homeCanvasState'

const router = useRouter()
const { isDark, toggle: toggleTheme } = useTheme()

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
const editorVisible = ref(false)
const editingNodeId = ref(null)
const editorKind = ref('text')
const editorForm = ref({ title: '', content: '', url: '' })
let saveTimer = null

const nodeTypes = { homeCanvasNode: markRaw(HomeCanvasNode) }
const initialViewport = computed(() => currentViewport.value)
const zoomLabel = computed(() => `${Math.round(Number(currentViewport.value.zoom || 0.75) * 100)}%`)
const layoutStatusLabel = computed(() => ({ saving: '保存中…', saved: '已保存', error: '保存失败' }[layoutSaveState.value] || '本地画布'))

function loadState() {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(HOME_CANVAS_STORAGE_KEY)
  const state = normalizeHomeCanvasState(raw || createHomeCanvasState())
  nodes.value = state.nodes
  edges.value = state.edges
  currentViewport.value = state.viewport
  hasSavedViewport.value = Boolean(raw)
}

function persistState() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(HOME_CANVAS_STORAGE_KEY, serializeHomeCanvasState({
      nodes: nodes.value,
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

function onPaneContextMenu(payload) {
  const event = payload?.event || payload
  event?.preventDefault?.()
  pendingFlowPosition.value = payload?.flowPosition || screenToFlowPosition(event?.clientX || 0, event?.clientY || 0)
  contextMenuX.value = event?.clientX || 0
  contextMenuY.value = event?.clientY || 0
  contextMenuVisible.value = true
}

function closeContextMenu() {
  contextMenuVisible.value = false
  pendingFlowPosition.value = null
}

function openNodeEditor(kind, position = null) {
  closeContextMenu()
  editorKind.value = kind
  editingNodeId.value = null
  pendingFlowPosition.value = position || centerFlowPosition()
  editorForm.value = { title: '', content: '', url: '' }
  editorVisible.value = true
}

function onNodeDoubleClick({ node }) {
  if (!node?.data) return
  editingNodeId.value = node.id
  editorKind.value = node.data.kind || 'text'
  editorForm.value = {
    title: node.data.title || '',
    content: node.data.content || '',
    url: node.data.url || '',
  }
  editorVisible.value = true
}

function submitNode() {
  const title = editorForm.value.title.trim()
  if (!title) return
  if (editingNodeId.value) {
    nodes.value = nodes.value.map((node) => node.id === editingNodeId.value
      ? { ...node, data: { ...node.data, kind: editorKind.value, title, content: editorForm.value.content, url: editorForm.value.url } }
      : node)
  } else {
    nodes.value.push({
      id: `home:${editorKind.value}:${Date.now()}`,
      type: 'homeCanvasNode',
      position: pendingFlowPosition.value || centerFlowPosition(),
      data: {
        kind: editorKind.value,
        title,
        content: editorForm.value.content,
        url: editorForm.value.url,
      },
    })
  }
  editorVisible.value = false
  pendingFlowPosition.value = null
  scheduleSave()
  ElMessage.success(editingNodeId.value ? '节点已更新' : '节点已添加')
}

function onPaneClick() {
  closeContextMenu()
}

async function clearCanvas() {
  try {
    await ElMessageBox.confirm('清空后将删除首页自由画布中的全部节点，是否继续？', '清空画布', { type: 'warning' })
  } catch {
    return
  }
  nodes.value = []
  edges.value = []
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

function showHelp() {
  ElMessage.info('空格 + 鼠标左键拖动画布；Ctrl + 滚轮缩放；普通滚轮上下滚动画布；右键添加节点。')
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

loadState()

watch([nodes, edges], scheduleSave, { deep: true })

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
  persistState()
})
</script>

<style scoped>
.home-canvas-page { height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: var(--bg-page, #0f0f12); color: var(--text-primary, #e4e4e7); }
.header { flex-shrink: 0; border-bottom: 1px solid var(--border-color, #27272a); background: var(--bg-card, #18181b); }
.canvas-topbar { position: absolute; inset: 0 0 auto; z-index: 30; border-bottom: 0; background: transparent; pointer-events: none; }
.header-inner { display: flex; align-items: center; gap: 12px; min-width: 0; margin: 12px 16px 0; padding: 8px 10px; flex-wrap: nowrap; border: 1px solid rgba(82, 82, 91, 0.7); border-radius: 16px; background: rgba(24, 24, 27, 0.82); box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28); backdrop-filter: blur(18px); pointer-events: auto; }
.logo { cursor: pointer; display: flex; align-items: center; gap: 10px; line-height: 1.2; }
.brand-logo { width: 40px; height: 40px; object-fit: cover; border-radius: 11px; flex: 0 0 auto; }
.brand-copy { display: flex; flex-direction: column; }
.logo-main { font-size: 15px; font-weight: 700; color: var(--text-bright, #fafafa); }
.logo-sub { font-size: 11px; color: #818cf8; }
.breadcrumb-sep { color: var(--text-faint, #52525b); }
.page-title { max-width: 220px; min-width: 0; overflow: hidden; flex: 0 1 auto; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; color: var(--text-muted, #a1a1aa); }
.canvas-name { padding-left: 12px; border-left: 1px solid #3f3f46; color: #a1a1aa; font-size: 12px; white-space: nowrap; }
.header-actions { min-width: 0; margin-left: auto; display: flex; flex: 0 0 auto; gap: 6px; }
.topbar-share { width: 38px; padding: 0; }
.layout-status { font-size: 11px; white-space: nowrap; }
.layout-status.saving { color: #60a5fa; }
.layout-status.saved { color: #34d399; }
.layout-status.error { color: #f87171; }
.canvas-shell { flex: 1; display: flex; min-height: 0; width: 100%; }
.canvas-main { position: relative; flex: 1; min-width: 0; width: 100%; height: 100%; }
.vue-flow-canvas { width: 100%; height: 100%; background: #101014; }
:deep(.vue-flow__minimap) { background: rgba(24, 24, 27, 0.92); border: 1px solid #3f3f46; }
:deep(.vue-flow__controls) { box-shadow: none; border: 1px solid #3f3f46; }
:deep(.vue-flow__controls button) { background: #18181b; border-color: #3f3f46; color: #e4e4e7; }
.home-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; pointer-events: none; color: #a1a1aa; }
.home-empty strong { color: #e4e4e7; font-size: 16px; }
.home-empty span { font-size: 12px; color: #71717a; }
.home-floating-toolbar { position: absolute; left: 50%; bottom: 18px; z-index: 25; display: flex; align-items: center; gap: 4px; max-width: calc(100% - 28px); padding: 6px 10px; border: 1px solid rgba(82, 82, 91, 0.72); border-radius: 17px; background: rgba(24, 24, 27, 0.92); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4); backdrop-filter: blur(18px); transform: translateX(-50%); }
.toolbar-primary, .toolbar-button, .toolbar-icon { min-width: 42px; min-height: 42px; border: 0; border-radius: 10px; background: transparent; color: #d4d4d8; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.toolbar-primary { width: 46px; background: #f4f4f5; color: #18181b; font-size: 21px; }
.toolbar-button { padding: 0 10px; font-size: 12px; }
.toolbar-icon { width: 42px; font-size: 17px; }
.toolbar-button:hover, .toolbar-icon:hover { background: rgba(129, 140, 248, 0.16); color: #c7d2fe; }
.toolbar-icon.danger:hover { color: #fca5a5; background: rgba(248, 113, 113, 0.15); }
.toolbar-divider { width: 1px; height: 24px; margin: 0 4px; background: #3f3f46; }
.zoom-label { width: 40px; color: #a1a1aa; font-size: 11px; text-align: center; font-variant-numeric: tabular-nums; }
.home-context-backdrop { position: fixed; inset: 0; z-index: 2999; }
.home-context-menu { position: fixed; z-index: 3000; min-width: 150px; padding: 6px 0; border: 1px solid #3f3f46; border-radius: 8px; background: #18181b; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45); }
.ctx-title { padding: 4px 12px 6px; color: #71717a; font-size: 10px; }
.ctx-item { display: block; width: 100%; padding: 8px 12px; border: 0; background: transparent; color: #e4e4e7; font-size: 13px; text-align: left; cursor: pointer; }
.ctx-item:hover { background: rgba(129, 140, 248, 0.15); color: #c7d2fe; }
@media (max-width: 820px) {
  .header-inner { margin: 8px 10px 0; padding: 7px 8px; }
  .brand-copy, .breadcrumb-sep, .canvas-name, .layout-status, .btn-theme { display: none; }
  .brand-logo { width: 34px; height: 34px; }
  .header-actions .el-button { min-height: 34px; }
  .toolbar-button { padding: 0 7px; }
}
@media (max-width: 620px) {
  .page-title { max-width: 120px; }
  .toolbar-button { width: 42px; padding: 0; font-size: 0; }
  .home-floating-toolbar { gap: 2px; }
  .zoom-label { display: none; }
}
@media (max-width: 480px) {
  .page-title { display: none; }
  .header-inner { gap: 6px; margin-left: 8px; margin-right: 8px; }
  .header-actions { gap: 4px; }
  .topbar-add-node,
  .topbar-home { width: 42px; padding: 0; font-size: 0; }
  .topbar-add-node .el-icon,
  .topbar-home .el-icon { margin: 0; font-size: 16px; }
}
</style>

<style>
html.light .home-canvas-page { background: var(--bg-page); }
html.light .vue-flow-canvas { background: #eef2ff; }
</style>
