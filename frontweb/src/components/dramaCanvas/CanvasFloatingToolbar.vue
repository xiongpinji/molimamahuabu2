<template>
  <div
    ref="toolbarRef"
    class="canvas-floating-toolbar nodrag nopan"
    :class="{ 'panel-open': panelOpen && selectedFreeCount < 2 && selectedGroupCount === 0 }"
    :style="{ '--canvas-bottom-toolbar-scale': bottomToolbarScale }"
    @mousedown.stop
  >
    <div v-if="addMenuVisible" class="canvas-tool-panel canvas-add-menu" role="menu" aria-label="添加节点菜单">
      <div class="add-menu-title">添加节点</div>
      <button v-for="item in addItems" :key="item.type" type="button" class="add-menu-item" role="menuitem" @click="create(item.type)">
        <el-icon><component :is="item.icon" /></el-icon>
        <span>{{ item.label }}</span>
        <small>{{ item.hint }}</small>
      </button>
    </div>

    <div v-if="props.standalone && activePanel === 'history'" class="canvas-tool-panel">
      <div class="tool-panel-title">生成历史</div>
      <div v-if="!historyItems.length" class="tool-panel-empty">暂无生成记录</div>
      <button v-for="item in historyItems" v-else :key="item.key" type="button" class="tool-panel-item" @click="focusHistoryItem(item)">
        <span>{{ item.label }}</span>
        <small>{{ item.message || item.step || '查看节点' }}</small>
      </button>
    </div>

    <div v-if="props.standalone && activePanel === 'locator'" class="canvas-tool-panel">
      <div class="tool-panel-title">节点定位</div>
      <div v-if="!locatorItems.length" class="tool-panel-empty">画布中暂无节点</div>
      <button v-for="item in locatorItems" v-else :key="item.id" type="button" class="tool-panel-item" @click="focusLocatorItem(item)">
        <span>{{ item.label }}</span>
        <small>{{ item.type }}</small>
      </button>
    </div>

    <CanvasSettingsPanel v-if="props.standalone && activePanel === 'settings'" @close="activePanel = ''" />

    <div class="toolbar-main">
      <button type="button" class="toolbar-primary" :aria-expanded="addMenuVisible" aria-label="添加元素" title="添加元素" @click="toggleAddMenu">
        <el-icon><Plus /></el-icon>
      </button>
      <span class="toolbar-divider" aria-hidden="true" />
      <button v-if="!props.standalone" type="button" class="toolbar-button" :class="{ active: workflowOpen }" aria-label="打开工作流面板" title="工作流" @click="toggleWorkflow">
        <el-icon><Operation /></el-icon><span>工作流</span>
      </button>
      <button type="button" class="toolbar-button" :class="{ active: sidebarOpen }" aria-label="打开素材库" :title="props.standalone ? '我的资产' : '素材库'" @click="toggleSidebar">
        <el-icon><FolderOpened /></el-icon><span>{{ props.standalone ? '我的资产' : '素材库' }}</span>
      </button>
      <button v-if="props.standalone" type="button" class="toolbar-button" :class="{ active: activePanel === 'history' }" title="生成历史" @click="togglePanel('history')">
        <el-icon><Document /></el-icon><span>生成历史</span>
      </button>
      <button v-if="props.standalone" type="button" class="toolbar-button" :class="{ active: activePanel === 'locator' }" title="节点定位" @click="togglePanel('locator')">
        <el-icon><Operation /></el-icon><span>节点定位</span>
      </button>
      <button v-if="props.standalone" type="button" class="toolbar-button" :class="{ active: activePanel === 'settings' }" title="画布设置" @click="togglePanel('settings')">
        <el-icon><Setting /></el-icon><span>画布设置</span>
      </button>
      <button v-if="props.standalone" type="button" class="toolbar-button" :class="{ active: snapEnabled }" title="自动吸附" @click="toggleSnap">
        <el-icon><Connection /></el-icon><span>自动吸附</span>
      </button>
      <button v-if="!props.standalone" type="button" class="toolbar-button" aria-label="打开剧本节点" title="剧本" @click="focusScript">
        <el-icon><Document /></el-icon><span>剧本</span>
      </button>
      <button type="button" class="toolbar-button" aria-label="整理画布节点" title="整理节点" @click="alignNodes">
        <el-icon><Grid /></el-icon><span>整理</span>
      </button>
      <button v-if="props.standalone && selectedFreeCount >= 2" type="button" class="toolbar-button group-action" title="将所选节点打组（Ctrl/Cmd+G）" @click="createGroup">
        <el-icon><Connection /></el-icon><span>打组 {{ selectedFreeCount }}</span>
      </button>
      <button v-if="props.standalone && selectedGroupCount" type="button" class="toolbar-button" title="执行组内节点" @click="runGroup">
        <el-icon><VideoPlay /></el-icon><span>整组执行</span>
      </button>
      <button v-if="props.standalone && selectedGroupCount" type="button" class="toolbar-button" title="解散所选组" @click="ungroup">
        <span>解组</span>
      </button>
      <button type="button" class="toolbar-button" :class="{ active: directorOpen }" aria-label="打开 3D 导演台" title="3D 导演台" @click="openDirectorStage">
        <el-icon><VideoCamera /></el-icon><span>导演台</span>
      </button>
      <span class="toolbar-divider" aria-hidden="true" />
      <button type="button" class="toolbar-icon" aria-label="画布帮助" title="帮助" @click="showHelp">
        <el-icon><QuestionFilled /></el-icon>
      </button>
      <button type="button" class="toolbar-icon" aria-label="撤销" title="撤销（Ctrl/Cmd+Z）" :disabled="!canUndo" @click="undo">
        <el-icon><RefreshLeft /></el-icon>
      </button>
      <button type="button" class="toolbar-icon" aria-label="重做" title="重做（Ctrl/Cmd+Shift+Z）" :disabled="!canRedo" @click="redo">
        <el-icon><RefreshRight /></el-icon>
      </button>
      <button type="button" class="toolbar-icon" aria-label="返回列表模式" title="列表模式" @click="goList">
        <el-icon><List /></el-icon>
      </button>
      <span class="toolbar-divider toolbar-divider-spacer" aria-hidden="true" />
      <button type="button" class="toolbar-icon" aria-label="缩小画布" title="缩小" @click="zoomOut">
        <el-icon><ZoomOut /></el-icon>
      </button>
      <span class="zoom-label" aria-live="polite">{{ zoomLabel }}</span>
      <button type="button" class="toolbar-icon" aria-label="放大画布" title="放大" @click="zoomIn">
        <el-icon><ZoomIn /></el-icon>
      </button>
      <button type="button" class="toolbar-icon" aria-label="适配画布" title="适配视图" @click="fitView">
        <el-icon><FullScreen /></el-icon>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Connection, Document, FolderOpened, FullScreen, Grid, List, Microphone, Operation, Picture, Plus, QuestionFilled, RefreshLeft, RefreshRight, Setting, VideoCamera, VideoPlay, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import { useCanvasContext } from '@/composables/useCanvasContext'
import CanvasSettingsPanel from '@/components/dramaCanvas/CanvasSettingsPanel.vue'

const props = defineProps({
  standalone: { type: Boolean, default: false },
})
const ctx = useCanvasContext()
const activePanel = ref('')
const addMenuVisible = computed(() => activePanel.value === 'add')
const toolbarRef = ref(null)

const productionAddItems = [
  { type: 'storyboard', label: '分镜', hint: '镜头与首尾帧', icon: Document },
  { type: 'character', label: '角色', hint: '角色设定', icon: FolderOpened },
  { type: 'scene', label: '场景', hint: '空间与氛围', icon: FullScreen },
  { type: 'prop', label: '道具', hint: '关键物件', icon: Operation },
  { type: 'episode', label: '新集', hint: '从剧本开始', icon: List },
]
const standaloneAddItems = [
  { type: 'text', label: '文本', hint: '内容与提示词', icon: Document },
  { type: 'image', label: '图片', hint: '图片生成节点', icon: Picture },
  { type: 'video', label: '视频', hint: '视频生成节点', icon: VideoPlay },
  { type: 'audio', label: '音频', hint: '音频生成节点', icon: Microphone },
]
const addItems = computed(() => props.standalone ? standaloneAddItems : productionAddItems)

const workflowOpen = computed(() => Boolean(ctx?.showWorkflowPanel?.value))
const sidebarOpen = computed(() => Boolean(ctx?.sidebarVisible?.value))
const directorOpen = computed(() => Boolean(ctx?.directorStageVisible?.value))
const canUndo = computed(() => Boolean(ctx?.canUndo?.value))
const canRedo = computed(() => Boolean(ctx?.canRedo?.value))
const panelOpen = computed(() => Boolean(ctx?.focusedNodeId?.value))
const selectedFreeCount = computed(() => ctx?.selectedFreeNodeIds?.value?.length || 0)
const selectedGroupCount = computed(() => ctx?.allGraphNodes?.value?.filter?.((node) => node.type === 'canvasGroup' && node.selected).length || 0)
const historyItems = computed(() => ctx?.runQueueItems?.value || [])
const locatorItems = computed(() => ctx?.canvasNodeLocatorItems?.value || [])
const snapEnabled = computed(() => Boolean(ctx?.canvasSnapEnabled?.value))
const bottomToolbarScale = computed(() => Number(ctx?.canvasPreferences?.value?.bottom_toolbar_scale || 1))
const zoomLabel = computed(() => {
  const zoom = Number(ctx?.currentViewport?.value?.zoom || 0.75)
  return String(Math.round(zoom * 100)) + '%'
})

function toggleAddMenu() {
  togglePanel('add')
}

function togglePanel(panel) {
  activePanel.value = activePanel.value === panel ? '' : panel
}

function closeAddMenuOnOutside(event) {
  if (!activePanel.value || toolbarRef.value?.contains(event.target)) return
  activePanel.value = ''
}

function closeAddMenuOnEscape(event) {
  if (event.key !== 'Escape' || !activePanel.value) return
  activePanel.value = ''
}

function create(type) {
  activePanel.value = ''
  ctx?.openCreateDialog?.(type)
}

function focusHistoryItem(item) {
  activePanel.value = ''
  ctx?.focusQueueItem?.(item)
}

function focusLocatorItem(item) {
  activePanel.value = ''
  ctx?.focusCanvasNode?.(item.id)
}

function toggleSnap() { ctx?.toggleCanvasSnap?.() }
function toggleWorkflow() { ctx?.toggleWorkflowPanel?.() }
function toggleSidebar() { ctx?.toggleSidebar?.() }
function focusScript() { ctx?.focusScript?.() }
function alignNodes() { ctx?.alignNodes?.() }
function openDirectorStage() { ctx?.openDirectorStage?.() }
function showHelp() { ctx?.showCanvasHelp?.() }
function undo() { ctx?.undoCanvas?.() }
function redo() { ctx?.redoCanvas?.() }
function goList() { ctx?.goListMode?.() }
function zoomIn() { ctx?.zoomIn?.() }
function zoomOut() { ctx?.zoomOut?.() }
function fitView() { ctx?.fitCanvasView?.() }
function createGroup() { ctx?.createStandaloneGroup?.() }
function runGroup() { ctx?.runSelectedStandaloneGroup?.() }
function ungroup() { ctx?.ungroupStandaloneSelection?.() }

onMounted(() => {
  document.addEventListener('pointerdown', closeAddMenuOnOutside)
  document.addEventListener('keydown', closeAddMenuOnEscape)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeAddMenuOnOutside)
  document.removeEventListener('keydown', closeAddMenuOnEscape)
})
</script>

<style scoped>
.canvas-floating-toolbar {
  position: absolute;
  left: 50%;
  bottom: 18px;
  z-index: 25;
  transform: translateX(-50%);
  max-width: calc(100% - 28px);
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.canvas-floating-toolbar.panel-open {
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 12px);
}
.toolbar-main {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 54px;
  padding: 6px 10px;
  border: 1px solid #2d2d2d;
  border-radius: 17px;
  background: color-mix(in srgb, var(--canvas-panel-background, #0f0f0f) 94%, transparent);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(18px);
  transform: scale(var(--canvas-bottom-toolbar-scale, 1));
  transform-origin: bottom center;
}
button {
  font: inherit;
  color: #d4d4d8;
}
.toolbar-primary,
.toolbar-button,
.toolbar-icon {
  min-width: 44px;
  min-height: 44px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  transition: background 180ms ease, color 180ms ease, transform 180ms ease;
}
.toolbar-primary {
  width: 48px;
  background: #ff7139;
  color: #111;
  font-size: 22px;
}
.toolbar-button { padding: 0 11px; font-size: 12px; }
.toolbar-button > span { white-space: nowrap; }
.toolbar-icon { width: 44px; font-size: 18px; }
.toolbar-button:hover,
.toolbar-icon:hover { background: rgba(255, 113, 57, 0.14); color: #ff9a72; }
.toolbar-button.active { background: rgba(255, 113, 57, 0.18); color: #ff956d; }
.toolbar-primary:hover { transform: scale(1.03); background: #ff8757; }
.toolbar-divider { width: 1px; height: 24px; margin: 0 4px; background: #3f3f46; }
.toolbar-divider-spacer { margin-left: 8px; }
.zoom-label { width: 42px; color: #a1a1aa; font-size: 11px; text-align: center; font-variant-numeric: tabular-nums; }
.canvas-tool-panel {
  position: absolute;
  left: 0;
  bottom: 66px;
  width: 250px;
  max-height: min(360px, calc(100vh - 150px));
  overflow: auto;
  padding: 8px;
  border: 1px solid #303030;
  border-radius: 14px;
  background: rgba(17, 17, 17, 0.98);
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.45);
}
.tool-panel-title,
.add-menu-title { padding: 4px 8px 7px; color: #a1a1aa; font-size: 12px; font-weight: 600; }
.tool-panel-empty { padding: 18px 8px; color: #71717a; font-size: 12px; text-align: center; }
.tool-panel-item {
  width: 100%;
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 9px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.tool-panel-item:hover { background: rgba(255, 113, 57, 0.13); }
.tool-panel-item span { color: #e4e4e7; font-size: 12px; }
.tool-panel-item small { max-width: 118px; overflow: hidden; color: #71717a; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.add-menu-item {
  width: 100%;
  min-height: 44px;
  display: grid;
  grid-template-columns: 26px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.add-menu-item:hover { background: rgba(255, 113, 57, 0.13); }
.add-menu-item span { font-size: 13px; color: #e4e4e7; }
.add-menu-item small { color: #71717a; font-size: 10px; }
@media (max-width: 760px) {
  .toolbar-button span { display: none; }
  .toolbar-button { width: 44px; padding: 0; }
  .toolbar-divider-spacer, .zoom-label { display: none; }
  .toolbar-main { gap: 2px; }
}
@media (min-width: 761px) and (max-width: 1500px) {
  .toolbar-button { width: 44px; padding: 0; }
  .toolbar-button > span {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .toolbar-primary, .toolbar-button, .toolbar-icon { transition: none; }
}
</style>
