<template>
  <div class="home-canvas-node" :class="[`kind-${data.kind}`, `state-${data.status || 'idle'}`]">
    <Handle type="target" :position="Position.Left" />
    <Handle type="source" :position="Position.Right" />
    <div class="node-heading">
      <span class="node-icon">{{ kindIcon }}</span>
      <span class="node-title">{{ data.title || '未命名节点' }}</span>
      <span class="node-status">{{ statusLabel }}</span>
    </div>
    <p v-if="data.kind === 'text'" class="node-content">{{ data.content || '双击节点编辑内容' }}</p>
    <img v-else-if="data.kind === 'image' && data.url" :src="data.url" :alt="data.title || '图片节点预览'" class="node-media" />
    <div v-else-if="data.kind === 'image'" class="node-empty">{{ data.content || '填写图片描述或媒体地址' }}</div>
    <video v-else-if="data.kind === 'video' && data.url" :src="data.url" class="node-media" controls muted playsinline />
    <audio v-else-if="data.kind === 'audio' && data.url" :src="data.url" class="node-audio" controls />
    <div v-else class="node-empty">{{ data.content || emptyHint }}</div>
    <div v-if="data.error" class="node-error">{{ data.error }}</div>
    <div class="node-actions">
      <button type="button" @click.stop="openConfig" @mousedown.stop>配置</button>
      <button
        v-if="data.kind !== 'text'"
        type="button"
        :disabled="data.status === 'running'"
        @click.stop="runNode"
        @mousedown.stop
      >
        {{ data.status === 'failed' ? '重试' : data.status === 'running' ? '生成中' : '生成' }}
      </button>
    </div>
    <div class="node-hint">双击编辑</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'

const props = defineProps({
  id: { type: String, default: '' },
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()
const kindIcon = computed(() => ({ text: '☷', image: '▧', video: '▶', audio: '♫' }[props.data.kind] || '◈'))
const emptyHint = computed(() => props.data.kind === 'audio' ? '填写音频描述或媒体地址' : '填写视频描述或媒体地址')
const statusLabel = computed(() => ({
  running: '运行中',
  success: '已生成',
  failed: '失败',
}[props.data.status] || '待配置'))

function openConfig() {
  ctx?.openFreeNodeConfig?.(props.id)
}

function runNode() {
  ctx?.runFreeCanvasNode?.(props.id)
}
</script>

<style scoped>
.home-canvas-node {
  position: relative;
  width: 250px;
  min-height: 118px;
  padding: 14px;
  border: 1px solid rgba(129, 140, 248, 0.55);
  border-radius: 14px;
  background: rgba(24, 24, 27, 0.94);
  color: #e4e4e7;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
  cursor: pointer;
}
.home-canvas-node:hover { border-color: #a5b4fc; }
.node-heading { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.node-icon { color: #c4b5fd; font-size: 18px; }
.node-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 700; }
.node-status { margin-left: auto; color: #a1a1aa; font-size: 10px; white-space: nowrap; }
.node-content { margin: 0; color: #c4c4cc; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.node-media { display: block; width: 100%; height: 126px; border-radius: 8px; background: #09090b; object-fit: cover; }
.node-audio { display: block; width: 100%; height: 38px; }
.node-empty { min-height: 60px; display: flex; align-items: center; justify-content: center; color: #71717a; font-size: 11px; text-align: center; }
.node-error { margin-top: 8px; color: #f87171; font-size: 11px; line-height: 1.35; }
.node-actions { display: flex; gap: 8px; margin-top: 10px; }
.node-actions button {
  flex: 1;
  height: 28px;
  border: 1px solid rgba(129, 140, 248, 0.45);
  border-radius: 7px;
  background: rgba(39, 39, 42, 0.9);
  color: #e4e4e7;
  font-size: 12px;
  cursor: pointer;
}
.node-actions button:disabled { cursor: not-allowed; opacity: 0.55; }
.node-actions button:hover:not(:disabled) { border-color: #a5b4fc; color: #c7d2fe; }
.node-hint { margin-top: 10px; color: #52525b; font-size: 10px; }
.state-running { border-color: rgba(96, 165, 250, 0.8); }
.state-success { border-color: rgba(52, 211, 153, 0.8); }
.state-failed { border-color: rgba(248, 113, 113, 0.8); }
.kind-image { border-color: rgba(96, 165, 250, 0.55); }
.kind-image .node-icon { color: #93c5fd; }
.kind-video { border-color: rgba(244, 114, 182, 0.55); }
.kind-video .node-icon { color: #f9a8d4; }
.kind-audio { border-color: rgba(52, 211, 153, 0.55); }
.kind-audio .node-icon { color: #6ee7b7; }
</style>
