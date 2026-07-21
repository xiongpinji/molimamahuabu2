<template>
  <div class="canvas-node-stack">
    <div
      class="canvas-media-node"
      :class="['kind-' + data.kind, { highlighted: data.highlighted, dimmed: data.dimmed, focused: showPanel, processing: isProcessing }]"
      :title="nodeTitle"
    >
      <Handle type="target" :position="Position.Left" />
      <Handle v-if="data.kind !== 'video' && data.kind !== 'audio'" type="source" :position="Position.Right" />
      <CanvasNodeStatusOverlay :node-id="id" />
      <div class="tag">{{ kindLabel }}</div>
      <template v-if="data.kind === 'text'">
        <p class="text-body">{{ data.summary || '暂无脚本' }}</p>
      </template>
      <template v-else-if="data.kind === 'universal'">
        <p class="text-body universal-body">{{ data.summary || '暂无全能分镜词' }}</p>
      </template>
      <template v-else-if="data.kind === 'image'">
        <img v-if="data.url" :src="data.url" alt="" class="media-img" />
        <div v-else class="empty">无分镜图</div>
      </template>
      <template v-else-if="data.kind === 'video'">
        <video v-if="data.url" :src="data.url" class="media-vid" muted playsinline />
        <div v-else class="empty">无视频</div>
      </template>
      <template v-else-if="data.kind === 'audio'">
        <div class="audio-wrap">
          <span>🎵</span>
          <span>{{ data.audioType === 'narration' ? '旁白' : '对白' }}</span>
        </div>
      </template>
      <div class="node-footer">
        <span class="result-state" :class="'state-' + resultState.key">{{ resultState.label }}</span>
        <span class="hint">单击查看与重试</span>
      </div>
    </div>
    <CanvasMediaPanel
      v-if="showPanel"
      :node-id="id"
      :kind="data.kind"
      :storyboard="data.storyboard"
      :summary="data.summary"
      :url="data.url"
      :video-record="data.videoRecord"
      :audio-type="data.audioType"
      :frame-kind="data.frameKind"
      :generation-error="data.generationError"
      :generation-warning="data.generationWarning"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'
import CanvasMediaPanel from './CanvasMediaPanel.vue'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()
const showPanel = computed(() => ctx?.focusedNodeId?.value === props.id)

const isNodeBusy = computed(() => {
  const map = ctx?.nodeStatus?.map
  return map ? !!map[props.id] : false
})

const isProcessing = computed(() => isNodeBusy.value || props.data.storyboard?.status === 'processing')

const resultState = computed(() => {
  if (isNodeBusy.value || props.data.storyboard?.status === 'processing') return { key: 'busy', label: '生成中' }
  if (props.data.kind === 'text') return { key: 'editable', label: '可编辑' }
  if (props.data.generationError) return { key: 'failed', label: '生成失败' }
  if (props.data.kind === 'video' && props.data.videoRecord?.provider === 'library') return { key: 'library', label: '素材库' }
  if (props.data.url) return { key: 'ready', label: '已生成' }
  if (props.data.generationWarning) return { key: 'warn', label: '需检查' }
  return { key: 'empty', label: '待生成' }
})

const nodeTitle = computed(() => {
  if (props.data.kind === 'text') return '单击查看脚本摘要并编辑'
  if (props.data.generationError) return props.data.generationError
  if (props.data.generationWarning) return props.data.generationWarning
  return props.data.url ? '单击预览结果或重新生成' : '单击查看生成选项'
})

const kindLabel = computed(() => {
  if (props.data.frameLabel) return props.data.frameLabel
  const map = { text: '脚本摘要', universal: '全能分镜词', image: '分镜图', video: '视频', audio: '音频' }
  return map[props.data.kind] || props.data.kind
})
</script>

<style scoped>
.canvas-node-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.canvas-media-node {
  position: relative;
  width: 168px;
  min-height: 100px;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid var(--border-muted, #3f3f46);
  background: rgba(24, 24, 27, 0.95);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.canvas-media-node.focused {
  border-color: #818cf8;
  box-shadow: 0 0 0 1px rgba(129, 140, 248, 0.35);
}
.tag {
  font-size: 10px;
  font-weight: 600;
  color: #818cf8;
  margin-bottom: 6px;
}
.text-body {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: #d4d4d8;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.media-img {
  width: 100%;
  height: 92px;
  object-fit: cover;
  border-radius: 6px;
  background: #09090b;
}
.media-vid {
  width: 100%;
  height: 92px;
  object-fit: cover;
  border-radius: 6px;
  background: #000;
}
.audio-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 8px;
  font-size: 12px;
  color: #fbbf24;
}
.empty {
  font-size: 11px;
  color: #71717a;
  padding: 20px 0;
  text-align: center;
}
.universal-body {
  -webkit-line-clamp: 8;
}
.kind-universal { border-color: rgba(167, 139, 250, 0.5); }
.kind-universal .tag { color: #c4b5fd; }
.kind-image { border-color: rgba(129, 140, 248, 0.4); }
.kind-video { border-color: rgba(244, 114, 182, 0.4); }
.kind-audio { border-color: rgba(251, 191, 36, 0.4); }
.canvas-media-node.processing { border-color: #60a5fa; }
.highlighted { box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.55); }
.dimmed { opacity: 0.28; }
.node-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 6px;
}
.result-state {
  flex-shrink: 0;
  padding: 2px 5px;
  border-radius: 4px;
  font-size: 9px;
  background: rgba(255, 255, 255, 0.08);
  color: #a1a1aa;
}
.state-busy { color: #60a5fa; background: rgba(96, 165, 250, 0.15); }
.state-ready { color: #34d399; background: rgba(52, 211, 153, 0.12); }
.state-library { color: #2dd4bf; background: rgba(45, 212, 191, 0.14); }
.state-editable { color: #fbbf24; background: rgba(251, 191, 36, 0.12); }
.state-failed { color: #f87171; background: rgba(248, 113, 113, 0.14); }
.state-warn { color: #fbbf24; background: rgba(251, 191, 36, 0.12); }
.hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9px;
  color: #52525b;
}
</style>
