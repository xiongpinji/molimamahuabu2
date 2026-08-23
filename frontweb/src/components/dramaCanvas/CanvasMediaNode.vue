<template>
  <div class="canvas-node-stack">
    <div
      class="canvas-media-node"
      :class="['kind-' + data.kind, { highlighted: data.highlighted, dimmed: data.dimmed, focused: showPanel, processing: isProcessing }]"
      :title="nodeTitle"
      @click.stop="onSelect"
    >
      <Handle type="target" :position="Position.Left" />
      <Handle v-if="data.kind !== 'video' && data.kind !== 'audio'" type="source" :position="Position.Right" />
      <CanvasNodeStatusOverlay :node-id="id" />
      <div class="tag">{{ kindLabel }}</div>
      <template v-if="data.kind === 'text'">
        <p class="text-body">{{ displayText || '暂无脚本' }}</p>
      </template>
      <template v-else-if="data.kind === 'universal'">
        <p class="text-body universal-body">{{ displayText || '暂无全能分镜词' }}</p>
      </template>
      <template v-else-if="data.kind === 'image'">
        <img v-if="resultUrl" :src="resultUrl" alt="" class="media-img" />
        <div v-else class="empty">无分镜图</div>
      </template>
      <template v-else-if="data.kind === 'video'">
        <video v-if="resultUrl" :src="resultUrl" class="media-vid" muted playsinline />
        <div v-else class="empty">无视频</div>
      </template>
      <template v-else-if="data.kind === 'audio'">
        <div class="audio-wrap">
          <span>🎵</span>
          <span>{{ data.audioType === 'narration' ? '旁白' : '对白' }}</span>
          <span v-if="resultUrl" class="audio-ready">已生成</span>
        </div>
      </template>
      <div v-if="failureReason" class="node-error" :title="failureReason">
        {{ failureReason }}
      </div>
      <div v-if="resultReferences.length" class="reference-strip">
        <span v-for="reference in resultReferences.slice(0, 3)" :key="reference">{{ reference }}</span>
      </div>
      <div v-if="auditBadges.length" class="audit-strip">
        <span v-for="badge in auditBadges" :key="badge">{{ badge }}</span>
      </div>
      <div v-if="hasResultActions" class="result-actions">
        <button v-if="resultUrl" type="button" @click.stop="openResult">{{ previewLabel }}</button>
        <button v-if="resultUrl" type="button" @click.stop="copyResultLink">复制</button>
        <button v-if="resultUrl" type="button" @click.stop="downloadResult">下载</button>
        <button v-if="textResult" type="button" @click.stop="copyTextResult">复制文本</button>
        <button v-if="resultReferences.length" type="button" @click.stop="copyResultReferences">复制引用</button>
        <button v-if="requestPayloadText" type="button" @click.stop="copyRequestPayload">复制请求</button>
        <button v-if="canUseResultAsDownstreamReference" type="button" :disabled="assigningDownstreamReference" @click.stop="useResultAsDownstreamReference">
          {{ assigningDownstreamReference ? '引用中…' : '下游参考' }}
        </button>
        <button v-if="resultNodeId" type="button" @click.stop="focusResultNode">定位</button>
        <button v-if="savedAssetReferenceText" type="button" @click.stop="copyAssetReference">素材引用</button>
        <button v-if="savedAsset" type="button" :disabled="assigningAsset" @click.stop="assignSavedAssetToSelectedStoryboard">
          {{ assigningAsset ? '回填中…' : '回填' }}
        </button>
      </div>
      <div class="node-footer">
        <span class="result-state" :class="'state-' + resultState.key">{{ resultState.label }}</span>
        <button
          v-if="canRetry"
          class="retry-btn"
          type="button"
          :disabled="isNodeBusy"
          @click.stop="retryNode"
        >{{ retryLabel }}</button>
        <span v-else class="hint">单击查看</span>
      </div>
    </div>
    <CanvasMediaPanel
      v-if="showPanel"
      :node-id="id"
      :kind="data.kind"
      :storyboard="data.storyboard"
      :summary="data.summary"
      :url="resultUrl"
      :video-record="data.videoRecord"
      :audio-type="data.audioType"
      :frame-kind="data.frameKind"
      :generation-error="failureReason"
      :generation-warning="data.generationWarning"
    />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { isCanvasNodeBusyStatus } from '@/utils/canvasNodeStatus'
import { assetMediaUrl, audioUrl } from '@/utils/mediaUrl'
import {
  imageRecordUrl,
  resolveSbFirstImageRecord,
  resolveSbLastImageRecord,
  resolveSbMainImageRecord,
  resolveSbVideoRecord,
  videoRecordUrl,
} from '@/utils/storyboardMedia'
import CanvasMediaPanel from './CanvasMediaPanel.vue'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()
const showPanel = computed(() => ctx?.focusedNodeId?.value === props.id)
const assigningAsset = ref(false)
const assigningDownstreamReference = ref(false)

const isNodeBusy = computed(() => {
  const map = ctx?.nodeStatus?.map
  return isCanvasNodeBusyStatus(map?.[props.id])
})

const runtimeStatus = computed(() => ctx?.nodeStatus?.map?.[props.id] || null)
const imagesBySbId = computed(() => ctx?.imagesBySbId?.value || {})
const videosBySbId = computed(() => ctx?.videosBySbId?.value || {})
const nodeFailed = computed(() => runtimeStatus.value?.step === 'failed')
const failureReason = computed(() => {
  const status = runtimeStatus.value
  return status?.errorDetail || status?.detail || (nodeFailed.value ? status?.message : '') || props.data.generationError || ''
})

const fallbackResultUrl = computed(() => {
  const sb = props.data.storyboard || {}
  if (props.data.kind === 'image') {
    if (props.data.frameKind === 'first') return imageRecordUrl(resolveSbFirstImageRecord(sb, imagesBySbId.value))
    if (props.data.frameKind === 'last') return imageRecordUrl(resolveSbLastImageRecord(sb, imagesBySbId.value))
    return imageRecordUrl(resolveSbMainImageRecord(sb, imagesBySbId.value))
  }
  if (props.data.kind === 'video') {
    return videoRecordUrl(props.data.videoRecord || resolveSbVideoRecord(sb, videosBySbId.value))
  }
  if (props.data.kind === 'audio') {
    return audioUrl(
      sb.audio_local_path
      || sb.audio_url
      || sb.narration_audio_local_path
      || sb.narration_audio_url
    )
  }
  return ''
})
const isRecoveredResult = computed(() => Boolean(fallbackResultUrl.value) && !runtimeStatus.value?.resultUrl && !props.data.url)

const isProcessing = computed(() => isNodeBusy.value || props.data.storyboard?.status === 'processing')

const resultState = computed(() => {
  if (failureReason.value) return { key: 'failed', label: '生成失败' }
  if (isNodeBusy.value || props.data.storyboard?.status === 'processing') return { key: 'busy', label: '生成中' }
  if (props.data.kind === 'text') return { key: 'editable', label: '可编辑' }
  if (props.data.kind === 'video' && props.data.videoRecord?.provider === 'library') return { key: 'library', label: '素材库' }
  if (isRecoveredResult.value) return { key: 'recovered', label: '已恢复' }
  if (resultUrl.value) return { key: 'ready', label: '已生成' }
  if (props.data.generationWarning) return { key: 'warn', label: '需检查' }
  return { key: 'empty', label: '待生成' }
})

const nodeTitle = computed(() => {
  if (props.data.kind === 'text') return '单击查看脚本摘要并编辑'
  if (failureReason.value) return failureReason.value
  if (props.data.generationWarning) return props.data.generationWarning
  return resultUrl.value ? '单击预览结果或重新生成' : '单击查看生成选项'
})

const kindLabel = computed(() => {
  if (props.data.frameLabel) return props.data.frameLabel
  const map = { text: '脚本摘要', universal: '全能分镜词', image: '分镜图', video: '视频', audio: '音频' }
  return map[props.data.kind] || props.data.kind
})

const canRetry = computed(() => Boolean(runtimeStatus.value?.retryStep) || ['image', 'video', 'audio'].includes(props.data.kind))
const resultUrl = computed(() => runtimeStatus.value?.resultUrl || props.data.url || fallbackResultUrl.value)
const textResult = computed(() => runtimeStatus.value?.resultSummary || '')
const displayText = computed(() => textResult.value || props.data.summary || '')
const resultReferences = computed(() => Array.isArray(runtimeStatus.value?.resultReferences) ? runtimeStatus.value.resultReferences : [])
const requestPayloadText = computed(() => {
  const payload = runtimeStatus.value?.requestAudit || runtimeStatus.value?.requestPayload
  if (!payload || typeof payload !== 'object') return ''
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload || '')
  }
})
const auditBadges = computed(() => [
  runtimeStatus.value?.model ? `模型 ${runtimeStatus.value.model}` : '',
  runtimeStatus.value?.taskId ? `任务 ${runtimeStatus.value.taskId}` : '',
  runtimeStatus.value?.videoGenerationId ? `记录 ${runtimeStatus.value.videoGenerationId}` : '',
  runtimeStatus.value?.requestAudit?.voice_policy?.label ? `声音 ${runtimeStatus.value.requestAudit.voice_policy.label}` : '',
  requestPayloadText.value ? '真实请求已记录' : '',
].filter(Boolean))
const hasResultActions = computed(() => Boolean(resultUrl.value || textResult.value || resultReferences.value.length || requestPayloadText.value || resultNodeId.value || savedAssetReferenceText.value))
const resultNodeId = computed(() => runtimeStatus.value?.resultNodeId || '')
const savedAsset = computed(() => {
  const status = runtimeStatus.value
  if (!status?.savedAssetId) return null
  return {
    id: status.savedAssetId,
    name: status.savedAssetName || `${kindLabel.value}结果`,
    type: status.resultType || props.data.kind,
    url: status.savedAssetUrl || status.resultUrl || resultUrl.value || '',
    local_path: status.savedAssetLocalPath || '',
    duration: status.savedAssetDuration ?? undefined,
  }
})
const savedAssetReferenceText = computed(() => {
  const asset = savedAsset.value
  if (!asset?.id) return ''
  const url = assetMediaUrl(asset) || asset.url || ''
  return `@素材(${asset.name || '素材'}#${asset.id}) ${url}`.trim()
})
const canUseResultAsDownstreamReference = computed(() => Boolean(ctx?.useNodeResultAsDownstreamReference) && Boolean(resultUrl.value || resultReferences.value.length || savedAssetReferenceText.value || textResult.value))
const previewLabel = computed(() => {
  if (props.data.kind === 'image') return '预览图'
  if (props.data.kind === 'video') return '预览视频'
  if (props.data.kind === 'audio') return '播放音频'
  return '预览'
})

const retryLabel = computed(() => {
  if (props.data.kind === 'image' && props.data.frameKind === 'first') return '重试首帧'
  if (props.data.kind === 'image' && props.data.frameKind === 'last') return '重试尾帧'
  const map = { image: '重试生图', video: '重试视频', audio: '重试配音' }
  return map[props.data.kind] || '重试'
})

function retryNode() {
  if (!canRetry.value || isNodeBusy.value) return
  ctx?.runNodeStep?.({ id: props.id, data: props.data }, runtimeStatus.value?.retryStep || props.data.kind)
}

function onSelect() {
  ctx?.setFocusedNode?.(props.id)
}

function openResult() {
  if (!resultUrl.value) return
  window.open(resultUrl.value, '_blank', 'noopener,noreferrer')
}

async function copyResultLink() {
  if (!resultUrl.value) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(resultUrl.value)
    ElMessage.success('结果链接已复制')
  } catch {
    ElMessageBox.alert(resultUrl.value, '结果链接（请手动复制）', { confirmButtonText: '关闭', type: 'info' })
  }
}

async function copyAssetReference() {
  if (!savedAssetReferenceText.value) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(savedAssetReferenceText.value)
    ElMessage.success('素材引用已复制')
  } catch {
    ElMessageBox.alert(savedAssetReferenceText.value, '素材引用（请手动复制）', { confirmButtonText: '关闭', type: 'info' })
  }
}

async function copyTextResult() {
  if (!textResult.value) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(textResult.value)
    ElMessage.success('文本结果已复制')
  } catch {
    ElMessageBox.alert(textResult.value, '文本结果（请手动复制）', { confirmButtonText: '关闭', type: 'info' })
  }
}

async function copyResultReferences() {
  if (!resultReferences.value.length) return
  const text = resultReferences.value.join('\n')
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(text)
    ElMessage.success('结果引用已复制')
  } catch {
    ElMessageBox.alert(text, '结果引用（请手动复制）', { confirmButtonText: '关闭', type: 'info' })
  }
}

async function copyRequestPayload() {
  if (!requestPayloadText.value) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(requestPayloadText.value)
    ElMessage.success('真实请求已复制')
  } catch {
    ElMessageBox.alert(requestPayloadText.value, '真实请求（请手动复制）', { confirmButtonText: '关闭', type: 'info' })
  }
}

async function focusResultNode() {
  if (!resultNodeId.value) return
  if (!ctx?.focusCanvasNode) {
    ElMessage.warning('当前画布暂不支持定位结果节点')
    return
  }
  if (ctx?.findCanvasNode && !ctx.findCanvasNode(resultNodeId.value)) {
    ElMessage.warning('结果节点不在当前画布，可刷新后重试')
    return
  }
  await ctx.focusCanvasNode(resultNodeId.value)
}

async function assignSavedAssetToSelectedStoryboard() {
  if (!savedAsset.value || assigningAsset.value) return
  assigningAsset.value = true
  try {
    await ctx?.assignProjectAssetToSelectedStoryboard?.(savedAsset.value)
  } finally {
    assigningAsset.value = false
  }
}

async function useResultAsDownstreamReference() {
  if (!canUseResultAsDownstreamReference.value || assigningDownstreamReference.value) return
  assigningDownstreamReference.value = true
  try {
    await ctx.useNodeResultAsDownstreamReference({ id: props.id, data: props.data }, {
      resultUrl: resultUrl.value,
      resultType: runtimeStatus.value?.resultType || props.data.kind,
      savedAssetId: savedAsset.value?.id || '',
      resultSummary: textResult.value,
      resultReferences: resultReferences.value,
    })
    ElMessage.success('已作为下游参考')
  } catch (error) {
    ElMessage.error(error?.message || '作为下游参考失败')
  } finally {
    assigningDownstreamReference.value = false
  }
}

function downloadResult() {
  if (!resultUrl.value) return
  const link = document.createElement('a')
  const rawName = String(resultUrl.value).split(/[?#]/)[0].split('/').pop()
  link.href = resultUrl.value
  link.download = rawName || `${props.data.kind || 'media'}-result`
  link.rel = 'noopener noreferrer'
  document.body.appendChild(link)
  link.click()
  link.remove()
}
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
  flex-wrap: wrap;
  gap: 8px;
  padding: 24px 8px;
  font-size: 12px;
  color: #fbbf24;
}
.audio-ready {
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(52, 211, 153, 0.12);
  color: #34d399;
  font-size: 9px;
}
.node-error {
  margin-top: 6px;
  padding: 5px 6px;
  border-radius: 6px;
  background: rgba(127, 29, 29, 0.42);
  color: #fecaca;
  font-size: 10px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.reference-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.reference-strip span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 999px;
  padding: 1px 6px;
  background: rgba(129, 140, 248, 0.14);
  color: #c7d2fe;
  font-size: 9px;
}
.audit-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.audit-strip span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 999px;
  padding: 1px 6px;
  background: rgba(251, 191, 36, 0.12);
  color: #fde68a;
  font-size: 9px;
}
.result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.result-actions button {
  border: 0;
  border-radius: 5px;
  padding: 2px 6px;
  background: rgba(52, 211, 153, 0.12);
  color: #86efac;
  font-size: 9px;
  cursor: pointer;
}
.result-actions button:hover {
  background: rgba(52, 211, 153, 0.22);
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
.state-recovered { color: #2dd4bf; background: rgba(45, 212, 191, 0.14); }
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
.retry-btn {
  flex-shrink: 0;
  border: 0;
  border-radius: 5px;
  padding: 2px 6px;
  background: rgba(129, 140, 248, 0.16);
  color: #c7d2fe;
  font-size: 9px;
  cursor: pointer;
}
.retry-btn:hover:not(:disabled) {
  background: rgba(129, 140, 248, 0.28);
}
.retry-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
