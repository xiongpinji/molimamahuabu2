<template>
  <div class="canvas-node-stack">
    <div
      class="canvas-script-node"
      :class="{
        focused: showPanel,
        empty: !hasScript,
        processing: isNodeBusy,
      }"
    >
      <Handle type="source" :position="Position.Right" />
      <CanvasNodeStatusOverlay :node-id="id" />
      <div class="head">
        <span class="badge">📜 剧本</span>
        <span class="ep">第 {{ data.episode?.episode_number ?? '?' }} 集</span>
        <span v-if="statusChip" class="status-chip" :class="'st-' + statusChip.key">{{ statusChip.label }}</span>
      </div>
      <div class="preview">{{ previewText }}</div>
      <div class="meta">
        <span>{{ charCount }} 角色</span>
        <span>{{ sceneCount }} 场景</span>
        <span>{{ propCount }} 道具</span>
      </div>
      <div v-if="failureReason" class="script-error" :title="failureReason">
        {{ failureReason }}
      </div>
      <button
        v-if="canRetry"
        class="retry-btn"
        type="button"
        :disabled="isNodeBusy"
        @click.stop="retryScript"
      >{{ retryLabel }}</button>
      <div class="hint">{{ showPanel ? '下方可编辑与提取' : '单击展开 · 双击进制作' }}</div>
    </div>
    <CanvasScriptPanel
      v-if="showPanel"
      :episode="data.episode"
      :node-id="id"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { isCanvasNodeBusyStatus } from '@/utils/canvasNodeStatus'
import CanvasScriptPanel from './CanvasScriptPanel.vue'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()
const showPanel = computed(() => ctx?.focusedNodeId?.value === props.id)

const hasScript = computed(() => !!(props.data.episode?.script_content || '').trim())
const previewText = computed(() => {
  if (props.data.summary) return props.data.summary
  return hasScript.value ? '（剧本已填写）' : '暂无剧本，点击编辑'
})

const charCount = computed(() => (ctx?.drama?.value?.characters || []).length)
const sceneCount = computed(() => (ctx?.drama?.value?.scenes || []).length)
const propCount = computed(() => (ctx?.drama?.value?.props || []).length)
const runtimeStatus = computed(() => ctx?.nodeStatus?.map?.[props.id] || null)

const isNodeBusy = computed(() => {
  return isCanvasNodeBusyStatus(runtimeStatus.value)
})

const failureReason = computed(() => {
  const status = runtimeStatus.value
  return status?.errorDetail || status?.detail || (status?.step === 'failed' ? status?.message : '') || ''
})
const retryStep = computed(() => runtimeStatus.value?.retryStep || '')
const retryLabel = computed(() => runtimeStatus.value?.retryLabel || '重试脚本任务')
const canRetry = computed(() => Boolean(failureReason.value && retryStep.value && ctx?.scriptActions))

const statusChip = computed(() => {
  const status = runtimeStatus.value
  if (status?.step === 'failed') return { key: 'failed', label: '失败' }
  if (isNodeBusy.value) return { key: 'busy', label: status?.message?.slice(0, 8) || '处理中' }
  if (status?.step === 'success') return { key: 'ready', label: '已完成' }
  return null
})

function retryScript() {
  if (!canRetry.value || isNodeBusy.value) return
  const api = ctx?.scriptActions
  const episode = props.data.episode
  const episodeId = episode?.id
  const scriptContent = episode?.script_content || ''
  const title = episode?.title || ''
  if (!episodeId) return
  if (retryStep.value === 'save_script') {
    api?.saveScript?.(episodeId, { scriptContent, title })
  } else if (retryStep.value === 'extract_chars') {
    api?.extractCharacters?.(episodeId, scriptContent)
  } else if (retryStep.value === 'extract_scenes') {
    api?.extractScenes?.(episodeId)
  } else if (retryStep.value === 'extract_props') {
    api?.extractProps?.(episodeId)
  } else if (retryStep.value === 'extract_all') {
    api?.extractAll?.(episodeId, scriptContent)
  }
}
</script>

<style scoped>
.canvas-node-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.canvas-script-node {
  position: relative;
  width: 220px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(251, 191, 36, 0.45);
  background: rgba(120, 53, 15, 0.35);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.canvas-script-node.focused {
  border-color: #fbbf24;
  box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.4), 0 8px 24px rgba(0, 0, 0, 0.35);
}
.canvas-script-node.empty {
  border-style: dashed;
  opacity: 0.92;
}
.canvas-script-node.processing {
  border-color: #60a5fa;
  animation: script-pulse 1.4s ease-in-out infinite;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.badge {
  font-size: 12px;
  font-weight: 700;
  color: #fcd34d;
}
.ep {
  font-size: 11px;
  color: #d4d4d8;
}
.status-chip {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: #a1a1aa;
}
.status-chip.st-busy { color: #60a5fa; background: rgba(96, 165, 250, 0.15); }
.status-chip.st-ready { color: #34d399; background: rgba(52, 211, 153, 0.12); }
.status-chip.st-failed { color: #f87171; background: rgba(248, 113, 113, 0.12); }
.preview {
  font-size: 11px;
  line-height: 1.45;
  color: #e4e4e7;
  max-height: 56px;
  overflow: hidden;
  margin-bottom: 8px;
}
.meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.meta span {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: #a1a1aa;
}
.script-error {
  margin: 0 0 6px;
  color: #fca5a5;
  font-size: 10px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.retry-btn {
  margin-bottom: 6px;
  width: 100%;
  border: 1px solid rgba(248, 113, 113, 0.35);
  border-radius: 6px;
  background: rgba(248, 113, 113, 0.12);
  color: #fecaca;
  font-size: 10px;
  line-height: 22px;
  cursor: pointer;
}
.retry-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.hint {
  font-size: 10px;
  color: #71717a;
}
@keyframes script-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.25); }
  50% { box-shadow: 0 0 0 5px rgba(96, 165, 250, 0.06); }
}
</style>
