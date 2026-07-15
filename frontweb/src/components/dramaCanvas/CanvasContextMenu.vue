<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="canvas-context-menu"
      :style="menuStyle"
      role="menu"
      aria-label="添加画布节点"
      tabindex="-1"
      @mousedown.stop
      @contextmenu.prevent
      @keydown.esc="close"
    >
      <div class="ctx-title">在此添加节点</div>
      <button v-for="item in addItems" :key="item.type" type="button" class="ctx-item" role="menuitem" @click="pick(item.type)">
        <el-icon><component :is="item.icon" /></el-icon>
        <span>{{ item.label }}</span>
        <small>{{ item.hint }}</small>
      </button>
      <div class="ctx-divider" />
      <button type="button" class="ctx-item" role="menuitem" @click="pick('episode')">
        <el-icon><List /></el-icon>
        <span>新集</span>
        <small>从剧本开始</small>
      </button>
    </div>
    <div v-if="visible" class="canvas-context-backdrop" @mousedown="close" @contextmenu.prevent="close" />
  </Teleport>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import { Document, FolderOpened, FullScreen, List, Operation } from '@element-plus/icons-vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
})

const emit = defineEmits(['select', 'close'])
const menuRef = ref(null)
const menuStyle = ref({ left: '8px', top: '8px' })

const addItems = [
  { type: 'storyboard', label: '分镜', hint: '镜头与首尾帧', icon: Document },
  { type: 'character', label: '角色', hint: '角色设定', icon: FolderOpened },
  { type: 'scene', label: '场景', hint: '空间与氛围', icon: FullScreen },
  { type: 'prop', label: '道具', hint: '关键物件', icon: Operation },
]

async function updateMenuPosition() {
  if (!props.visible || typeof window === 'undefined') return
  await nextTick()
  const menu = menuRef.value
  if (!menu) return
  const gap = 8
  const maxLeft = Math.max(gap, window.innerWidth - menu.offsetWidth - gap)
  const maxTop = Math.max(gap, window.innerHeight - menu.offsetHeight - gap)
  menuStyle.value = {
    left: `${Math.min(Math.max(props.x, gap), maxLeft)}px`,
    top: `${Math.min(Math.max(props.y, gap), maxTop)}px`,
  }
}

watch(() => [props.visible, props.x, props.y], async ([visible]) => {
  if (!visible) return
  await updateMenuPosition()
  menuRef.value?.focus()
})

function pick(type) {
  emit('select', type)
  emit('close')
}

function close() {
  emit('close')
}
</script>

<style scoped>
.canvas-context-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2999;
}
.canvas-context-menu {
  position: fixed;
  z-index: 3000;
  width: 236px;
  padding: 6px 0;
  border-radius: 8px;
  border: 1px solid #3f3f46;
  background: #18181b;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.ctx-title {
  padding: 4px 12px 6px;
  font-size: 10px;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ctx-item {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 42px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: #e4e4e7;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ctx-item .el-icon { font-size: 15px; }
.ctx-item span { min-width: 0; }
.ctx-item small { color: #71717a; font-size: 10px; white-space: nowrap; }
.ctx-item:hover {
  background: rgba(129, 140, 248, 0.15);
  color: #c7d2fe;
}
.ctx-divider {
  height: 1px;
  margin: 4px 0;
  background: #3f3f46;
}
</style>
