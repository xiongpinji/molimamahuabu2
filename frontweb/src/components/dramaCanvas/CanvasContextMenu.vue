<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="canvas-context-menu"
      :style="menuStyle"
      role="menu"
      :aria-label="mode === 'node' ? '节点操作' : '添加画布节点'"
      tabindex="-1"
      @mousedown.stop
      @contextmenu.prevent
      @keydown.esc="close"
    >
      <template v-if="mode === 'node'">
        <div class="ctx-title">节点操作 · {{ nodeLabel }}</div>
        <template v-for="(group, groupIndex) in visibleNodeGroups" :key="group.title">
          <div class="ctx-group">{{ group.title }}</div>
          <button v-for="item in group.items" :key="item.type" type="button" class="ctx-item" role="menuitem" @click="pick(item.type)">
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
            <small>{{ item.hint }}</small>
          </button>
          <div v-if="groupIndex < visibleNodeGroups.length - 1" class="ctx-divider" />
        </template>
      </template>
      <template v-else>
        <div class="ctx-title">添加节点</div>
        <template v-for="(group, groupIndex) in addGroups" :key="group.title">
          <div class="ctx-group">{{ group.title }}</div>
          <button
            v-for="item in group.items"
            :key="item.key"
            type="button"
            class="ctx-item"
            role="menuitem"
            @click="pick(item.type)"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
            <small>{{ item.hint }}</small>
          </button>
          <div v-if="groupIndex < addGroups.length - 1" class="ctx-divider" />
        </template>
      </template>
    </div>
    <div v-if="visible" class="canvas-context-backdrop" @mousedown="close" @contextmenu.prevent="close" />
  </Teleport>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { Connection, Document, EditPen, FolderOpened, FullScreen, List, Microphone, Operation, Picture, VideoPlay, View } from '@element-plus/icons-vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  mode: { type: String, default: 'create' },
  nodeLabel: { type: String, default: '' },
  nodeActions: { type: Array, default: () => [] },
})

const emit = defineEmits(['select', 'close'])
const menuRef = ref(null)
const menuStyle = ref({ left: '8px', top: '8px' })

const addGroups = [
  {
    title: '创作',
    items: [
      { key: 'script', type: 'focus-script', label: '故事脚本', hint: '定位脚本节点', icon: List },
      { key: 'storyboard', type: 'storyboard', label: '分镜', hint: '镜头与首尾帧', icon: Document },
    ],
  },
  {
    title: '资产',
    items: [
      { key: 'character', type: 'character', label: '角色', hint: '角色设定', icon: FolderOpened },
      { key: 'scene', type: 'scene', label: '场景', hint: '空间与氛围', icon: FullScreen },
      { key: 'prop', type: 'prop', label: '道具', hint: '关键物件', icon: Operation },
      { key: 'episode', type: 'episode', label: '新集', hint: '从剧本开始', icon: List },
    ],
  },
  {
    title: '素材',
    items: [
      { key: 'media-library', type: 'open-media-library', label: '素材库', hint: '上传 / 管理素材', icon: FolderOpened },
    ],
  },
]

const nodeGroups = [
  {
    title: '编辑',
    items: [
      { type: 'open-node-config', label: '打开节点配置', hint: '编辑当前节点', icon: EditPen },
      { type: 'preview-node-video', label: '预览视频', hint: '打开成片', icon: View },
    ],
  },
  {
    title: '结果',
    items: [
      { type: 'open-node-result', label: '打开结果', hint: '查看生成结果', icon: View },
      { type: 'copy-node-result', label: '复制结果链接', hint: '复用到提示词', icon: Document },
      { type: 'copy-node-asset-ref', label: '复制素材引用', hint: '@素材(...)', icon: Document },
      { type: 'copy-node-assigned-asset-ref', label: '复制指派素材', hint: '本镜参考素材', icon: Document },
      { type: 'focus-node-result', label: '定位结果节点', hint: '跳到图片/视频/音频节点', icon: FullScreen },
      { type: 'retry-node-failed', label: '重试失败节点', hint: '按失败步骤重跑', icon: VideoPlay },
    ],
  },
  {
    title: '生成',
    items: [
      { type: 'run-node-image', label: '生成 / 重跑图片', hint: '当前分镜图', icon: Picture },
      { type: 'run-node-video', label: '生成 / 重跑视频', hint: '当前分镜视频', icon: VideoPlay },
      { type: 'run-node-audio', label: '生成 / 重跑音频', hint: '对白配音', icon: Microphone },
    ],
  },
  {
    title: '定位',
    items: [
      { type: 'focus-upstream', label: '定位到上游素材', hint: '角色 / 场景 / 道具', icon: FolderOpened },
      { type: 'focus-downstream-video', label: '定位到下游视频', hint: '当前分镜视频', icon: FullScreen },
      { type: 'copy-node-ref', label: '复制节点引用', hint: '名称与 ID', icon: Document },
    ],
  },
  {
    title: '工作流',
    items: [
      { type: 'create-workflow-from-node', label: '创建工作流', hint: '用选中分镜成组', icon: Connection },
      { type: 'run-node-workflow', label: '运行所在工作流', hint: '整组重跑', icon: VideoPlay },
    ],
  },
]

const visibleNodeGroups = computed(() => {
  const allowed = new Set(props.nodeActions || [])
  return nodeGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => allowed.has(item.type)) }))
    .filter((group) => group.items.length)
})

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
.ctx-group {
  padding: 6px 12px 3px;
  font-size: 10px;
  color: #a1a1aa;
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
