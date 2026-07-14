<template>
  <div class="canvas-episode-node" :class="{ processing: isNodeBusy }" title="双击进入本集制作页">
    <Handle type="target" :position="Position.Left" />
    <CanvasNodeStatusOverlay :node-id="id" />
    <span class="badge">第 {{ data.episode?.episode_number ?? '?' }} 集</span>
    <span class="title">{{ data.episode?.title || '未命名集' }}</span>
    <span class="count">{{ (data.episode?.storyboards || []).length }} 镜</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()
const isNodeBusy = computed(() => {
  const map = ctx?.nodeStatus?.map
  return map ? !!map[props.id] : false
})
</script>

<style scoped>
.canvas-episode-node {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid rgba(167, 139, 250, 0.5);
  background: rgba(76, 29, 149, 0.35);
  color: #e9d5ff;
  font-size: 13px;
  white-space: nowrap;
  position: relative;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.canvas-episode-node.processing {
  border-color: #60a5fa;
  animation: episode-pulse 1.4s ease-in-out infinite;
}
.badge {
  font-weight: 700;
}
.title {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.count {
  font-size: 11px;
  opacity: 0.75;
}
@keyframes episode-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.35); }
  50% { box-shadow: 0 0 0 6px rgba(96, 165, 250, 0.08); }
}
</style>
