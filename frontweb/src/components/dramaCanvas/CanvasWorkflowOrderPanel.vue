<template>
  <section v-if="group" class="workflow-order-panel" aria-label="工作流执行顺序">
    <div class="order-panel-head">
      <div>
        <strong>执行顺序</strong>
        <span class="order-count">{{ items.length }} 镜 · {{ group.title }}</span>
      </div>
      <span class="order-hint">拖拽卡片调整，保存后按此顺序重跑</span>
    </div>

    <div class="order-list" @dragend="clearDragging">
      <div
        v-for="(item, index) in items"
        :key="item.id"
        class="order-item"
        :class="{ dragging: draggingIndex === index, missing: !item.storyboard }"
        draggable="true"
        @dragstart="startDragging(index, $event)"
        @dragover.prevent
        @drop.prevent="dropOn(index)"
      >
        <span class="drag-handle" aria-hidden="true">⋮⋮</span>
        <span class="order-index">{{ index + 1 }}</span>
        <div class="order-copy">
          <strong>{{ item.label }}</strong>
          <span v-if="item.storyboard?.segment_title" class="order-subtitle">{{ item.storyboard.segment_title }}</span>
          <span v-else-if="!item.storyboard" class="order-subtitle">该分镜已不存在</span>
        </div>
        <div class="order-actions">
          <el-button
            text
            size="small"
            :disabled="disabled || index === 0"
            aria-label="上移分镜"
            title="上移"
            @click.stop="move(index, index - 1)"
          >↑</el-button>
          <el-button
            text
            size="small"
            :disabled="disabled || index === items.length - 1"
            aria-label="下移分镜"
            title="下移"
            @click.stop="move(index, index + 1)"
          >↓</el-button>
        </div>
      </div>
      <div v-if="!items.length" class="order-empty">该工作流暂无分镜</div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  group: { type: Object, default: null },
  storyboards: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['change'])
const orderedIds = ref([])
const draggingIndex = ref(null)

watch(
  () => props.group?.storyboard_ids,
  (ids) => {
    orderedIds.value = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : []
  },
  { immediate: true },
)

const storyboardMap = computed(() => new Map(
  props.storyboards.map((storyboard) => [Number(storyboard.id), storyboard]),
))

const items = computed(() => orderedIds.value.map((id) => {
  const storyboard = storyboardMap.value.get(Number(id))
  const number = storyboard?.storyboard_number ?? id
  return {
    id,
    storyboard,
    label: `#${number} ${storyboard?.title || '分镜'}`,
  }
}))

function startDragging(index, event) {
  if (props.disabled) {
    event.preventDefault()
    return
  }
  draggingIndex.value = index
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function clearDragging() {
  draggingIndex.value = null
}

function dropOn(targetIndex) {
  const sourceIndex = draggingIndex.value
  clearDragging()
  if (props.disabled || sourceIndex == null || sourceIndex === targetIndex) return
  move(sourceIndex, targetIndex)
}

function move(sourceIndex, targetIndex) {
  if (props.disabled || sourceIndex === targetIndex) return
  const next = [...orderedIds.value]
  const [moved] = next.splice(sourceIndex, 1)
  if (moved == null) return
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, moved)
  orderedIds.value = next
  emit('change', next)
}
</script>

<style scoped>
.workflow-order-panel {
  pointer-events: auto;
  margin: 8px 16px 0;
  padding: 10px 14px 12px;
  border: 1px solid rgba(82, 82, 91, 0.65);
  border-radius: 14px;
  background: rgba(24, 24, 27, 0.92);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(18px);
}
.order-panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.order-panel-head strong { font-size: 12px; color: #e4e4e7; }
.order-count, .order-hint { color: #71717a; font-size: 11px; margin-left: 8px; }
.order-hint { margin-left: auto; }
.order-list {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.order-item {
  display: flex;
  align-items: center;
  flex: 0 0 220px;
  min-width: 0;
  gap: 7px;
  padding: 7px 8px;
  border: 1px solid rgba(129, 140, 248, 0.32);
  border-radius: 9px;
  background: rgba(39, 39, 42, 0.86);
  cursor: grab;
  transition: border-color 0.15s, opacity 0.15s;
}
.order-item:hover { border-color: rgba(129, 140, 248, 0.78); }
.order-item.dragging { opacity: 0.45; }
.order-item.missing { border-color: rgba(248, 113, 113, 0.55); }
.drag-handle { color: #71717a; letter-spacing: -3px; cursor: grab; }
.order-index {
  display: grid;
  place-items: center;
  flex: 0 0 22px;
  height: 22px;
  border-radius: 6px;
  color: #c4b5fd;
  background: rgba(129, 140, 248, 0.16);
  font-size: 11px;
  font-weight: 700;
}
.order-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.order-copy strong, .order-subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.order-copy strong { color: #e4e4e7; font-size: 11px; }
.order-subtitle { color: #71717a; font-size: 10px; }
.missing .order-copy strong, .missing .order-subtitle { color: #fca5a5; }
.order-actions { display: flex; flex: 0 0 auto; }
.order-actions :deep(.el-button) { color: #a1a1aa; padding: 2px 4px; }
.order-actions :deep(.el-button:not(.is-disabled):hover) { color: #c4b5fd; }
.order-empty { color: #71717a; font-size: 11px; padding: 6px 0; }
@media (max-width: 680px) {
  .workflow-order-panel { margin-left: 8px; margin-right: 8px; }
  .order-panel-head { align-items: flex-start; flex-direction: column; gap: 3px; }
  .order-hint { margin-left: 0; }
}
</style>
