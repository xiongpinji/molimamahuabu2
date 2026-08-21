<template>
  <div
    v-if="visible"
    class="canvas-selection-toolbar nodrag nopan"
    :style="selectionToolbarStyle"
    role="toolbar"
    :aria-label="selectedGroupCount ? '节点组操作' : '多选节点操作'"
    @pointerdown.stop
    @mousedown.stop
  >
    <template v-if="selectedGroupCount">
      <span class="selection-summary">
        <strong>{{ selectedGroupTitle }}</strong>
        <small>{{ selectedGroupMemberCount }} 个节点</small>
      </span>
      <span class="toolbar-divider" aria-hidden="true" />
      <button type="button" title="按组内连线顺序执行" @click="runGroup">
        <el-icon><VideoPlay /></el-icon>
        <span>整组执行</span>
      </button>
      <span class="toolbar-divider" aria-hidden="true" />
      <button type="button" class="danger" title="解组并保留节点当前位置" @click="ungroup">
        <el-icon><CloseBold /></el-icon>
        <span>解组</span>
      </button>
    </template>

    <template v-else>
      <span class="selection-summary">
        <strong>{{ selectedFreeCount }} 个节点</strong>
      </span>
      <span class="toolbar-divider" aria-hidden="true" />
      <button type="button" title="将所选节点打组（Ctrl/Cmd+G）" @click="createGroup">
        <el-icon><Connection /></el-icon>
        <span>打组</span>
      </button>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { CloseBold, Connection, VideoPlay } from '@element-plus/icons-vue'
import { useCanvasContext } from '@/composables/useCanvasContext'

const ctx = useCanvasContext()

const selectedFreeCount = computed(() => ctx?.selectedFreeNodeIds?.value?.length || 0)
const selectedGroups = computed(() => (
  ctx?.allGraphNodes?.value?.filter?.((node) => node.type === 'canvasGroup' && node.selected) || []
))
const selectedGroupCount = computed(() => selectedGroups.value.length)
const selectedGroupTitle = computed(() => selectedGroups.value[0]?.data?.title || '节点组')
const selectedGroupMemberCount = computed(() => selectedGroups.value[0]?.data?.childNodeIds?.length || 0)
const selectedNodes = computed(() => {
  if (selectedGroupCount.value) return selectedGroups.value
  if (selectedFreeCount.value < 2) return []
  const selectedIds = new Set(ctx?.selectedFreeNodeIds?.value?.map?.(String) || [])
  return ctx?.allGraphNodes?.value?.filter?.((node) => (
    node.type === 'homeCanvasNode' && selectedIds.has(String(node.id))
  )) || []
})
const visible = computed(() => selectedGroupCount.value > 0 || selectedFreeCount.value >= 2)

const selectionToolbarStyle = computed(() => {
  const members = selectedNodes.value
  if (!members.length) return {}
  const viewport = ctx?.currentViewport?.value || { x: 0, y: 0, zoom: 1 }
  const zoom = Number(viewport.zoom) || 1
  const minX = Math.min(...members.map((node) => Number(node.position?.x) || 0))
  const minY = Math.min(...members.map((node) => Number(node.position?.y) || 0))
  const maxX = Math.max(...members.map((node) => (
    (Number(node.position?.x) || 0)
    + Number(node.data?.width || node.dimensions?.width || 460)
  )))
  const centerX = Number(viewport.x || 0) + ((minX + maxX) / 2) * zoom
  const top = Math.max(58, Number(viewport.y || 0) + minY * zoom - 12)
  return {
    left: `${centerX}px`,
    top: `${top}px`,
  }
})

function createGroup() { ctx?.createStandaloneGroup?.() }
function runGroup() { ctx?.runSelectedStandaloneGroup?.() }
function ungroup() { ctx?.ungroupStandaloneSelection?.() }
</script>

<style scoped>
.canvas-selection-toolbar {
  position: absolute;
  z-index: 40;
  transform: translate(-50%, -100%);
  display: flex;
  align-items: center;
  min-height: 54px;
  max-width: calc(100% - 24px);
  padding: 6px 10px;
  border: 1px solid #343434;
  border-radius: 18px;
  background: rgba(20, 20, 22, 0.96);
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.46);
  backdrop-filter: blur(18px);
}
.selection-summary {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 12px;
  white-space: nowrap;
}
.selection-summary strong {
  color: #e4e4e7;
  font-size: 14px;
  font-weight: 650;
}
.selection-summary small {
  color: #8f8f98;
  font-size: 11px;
}
button {
  min-height: 40px;
  padding: 0 13px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: #d4d4d8;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  transition: background 160ms ease, color 160ms ease;
}
button:hover {
  background: rgba(255, 113, 57, 0.15);
  color: #ff9a72;
}
button.danger:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #fca5a5;
}
.toolbar-divider {
  width: 1px;
  height: 26px;
  margin: 0 3px;
  background: #3f3f46;
}
@media (max-width: 680px) {
  .canvas-selection-toolbar {
    min-height: 48px;
    padding: 4px 7px;
  }
  .selection-summary { padding: 0 8px; }
  button { min-height: 38px; padding: 0 9px; }
  .selection-summary small { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
}
</style>
