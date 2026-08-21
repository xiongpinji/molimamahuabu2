<template>
  <div class="canvas-node-stack">
    <div class="canvas-sb-node" :class="{ selected: selected, highlighted: data.highlighted, dimmed: data.dimmed, processing: isProcessing || isNodeBusy, focused: showPanel }" @click.stop="onSelect">
    <Handle id="chain-in" type="target" :position="Position.Top" />
    <Handle type="target" :position="Position.Left" />
    <Handle type="source" :position="Position.Right" />
    <Handle id="chain-out" type="source" :position="Position.Bottom" />
      <CanvasNodeStatusOverlay :node-id="id" />
      <div class="head">
        <span class="num">#{{ data.storyboard?.storyboard_number ?? data.index }}</span>
        <span v-if="data.workflowGroup?.title" class="wf-badge">{{ data.workflowGroup.title }}</span>
        <span v-if="data.storyboard?.segment_title" class="seg">{{ data.storyboard.segment_title }}</span>
      <span v-if="data.storyboard?.creation_mode === 'universal'" class="mode-badge">全能</span>
      </div>
      <div class="title">{{ data.storyboard?.title || '分镜' }}</div>
      <div class="chips">
        <span v-if="data.storyboard?.shot_type">{{ data.storyboard.shot_type }}</span>
        <span v-if="data.storyboard?.duration">{{ data.storyboard.duration }}s</span>
        <span :class="'st-' + (data.storyboard?.status || 'pending')">{{ statusLabel }}</span>
      </div>
      <div v-if="hasResultState || failureReason" class="result-rail">
        <span v-if="displayImageUrl" class="result-pill ready">图</span>
        <span v-if="displayVideoUrl" class="result-pill ready">视频</span>
        <span v-if="displayAudioUrl" class="result-pill ready">音频</span>
        <span v-if="runtimeResultUrl && !persistedResultUrl" class="result-pill runtime">运行结果</span>
        <span v-if="failureReason" class="result-pill failed" :title="failureReason">失败</span>
      </div>
      <div v-if="failureReason" class="failure-line" :title="failureReason">
        {{ failureReason }}
      </div>
      <div v-if="assignedAssets.length" class="reference-strip" title="已从素材库指派到该分镜">
        <span class="reference-label">素材 {{ assignedAssets.length }}</span>
        <span v-for="asset in assignedAssets.slice(0, 3)" :key="asset.id || asset.name" class="reference-thumb" :title="assetPurposeLabel(asset)">
          <img v-if="assetThumbUrl(asset)" :src="assetThumbUrl(asset)" alt="" />
          <span v-else>{{ assetPurposeShortLabel(asset) }}</span>
        </span>
        <span class="reference-purpose">{{ assignedAssetPurposeSummary }}</span>
      </div>
      <div v-if="hasResultState" class="result-actions">
        <button v-if="displayImageUrl" type="button" @click.stop="openResult(displayImageUrl)">预览图</button>
        <button v-if="displayVideoUrl" type="button" @click.stop="openResult(displayVideoUrl)">预览视频</button>
        <button v-if="displayAudioUrl" type="button" @click.stop="openResult(displayAudioUrl)">播放音频</button>
        <button type="button" @click.stop="copyResultLink">复制结果</button>
      </div>
      <div class="retry-row">
        <button type="button" :disabled="isNodeBusy" @click.stop="retryStep('image')">重试生图</button>
        <button type="button" :disabled="isNodeBusy" @click.stop="retryStep('video')">重试视频</button>
        <button type="button" :disabled="isNodeBusy" @click.stop="retryStep('audio')">重试配音</button>
      </div>
      <div class="hint">{{ showPanel ? '下方可编辑与生成' : '单击展开操作 · 双击进制作' }}</div>
    </div>
    <CanvasStoryboardPanel
      v-if="showPanel"
      :storyboard="data.storyboard"
      :episode-id="data.episodeId"
      :node-id="id"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { isCanvasNodeBusyStatus } from '@/utils/canvasNodeStatus'
import { assetMediaUrl, audioUrl } from '@/utils/mediaUrl'
import {
  imageRecordUrl,
  resolveSbMainImageRecord,
  resolveSbVideoRecord,
  videoRecordUrl,
} from '@/utils/storyboardMedia'
import CanvasStoryboardPanel from './CanvasStoryboardPanel.vue'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
  selected: { type: Boolean, default: false },
})

const ctx = useCanvasContext()
const showPanel = computed(() => ctx?.focusedNodeId?.value === props.id)

const statusLabel = computed(() => {
  const s = props.data.storyboard?.status || 'pending'
  const map = { pending: '待处理', processing: '生成中', completed: '已完成', failed: '失败' }
  return map[s] || s
})

const isProcessing = computed(() => props.data.storyboard?.status === 'processing')

const isNodeBusy = computed(() => {
  const map = ctx?.nodeStatus?.map
  return isCanvasNodeBusyStatus(map?.[props.id])
})

const imagesBySbId = computed(() => ctx?.imagesBySbId?.value || {})
const videosBySbId = computed(() => ctx?.videosBySbId?.value || {})
const runtimeStatus = computed(() => ctx?.nodeStatus?.map?.[props.id] || null)

const imageUrl = computed(() => imageRecordUrl(resolveSbMainImageRecord(props.data.storyboard, imagesBySbId.value)))
const videoUrl = computed(() => videoRecordUrl(resolveSbVideoRecord(props.data.storyboard, videosBySbId.value)))
const audioPath = computed(() => audioUrl(
  props.data.storyboard?.audio_local_path
  || props.data.storyboard?.audio_url
  || props.data.storyboard?.narration_audio_local_path
  || props.data.storyboard?.narration_audio_url
))
const persistedResultUrl = computed(() => videoUrl.value || imageUrl.value || audioPath.value)
const runtimeResultUrl = computed(() => assetMediaUrl({
  local_path: runtimeStatus.value?.savedAssetLocalPath || '',
  url: runtimeStatus.value?.savedAssetUrl || runtimeStatus.value?.resultUrl || '',
}) || runtimeStatus.value?.savedAssetUrl || runtimeStatus.value?.resultUrl || '')
const runtimeResultType = computed(() => {
  const type = String(runtimeStatus.value?.resultType || '').toLowerCase()
  if (['image', 'video', 'audio'].includes(type)) return type
  const url = String(runtimeResultUrl.value).toLowerCase()
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/.test(url)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/.test(url)) return 'audio'
  return runtimeResultUrl.value ? 'image' : ''
})
const displayImageUrl = computed(() => imageUrl.value || (runtimeResultType.value === 'image' ? runtimeResultUrl.value : ''))
const displayVideoUrl = computed(() => videoUrl.value || (runtimeResultType.value === 'video' ? runtimeResultUrl.value : ''))
const displayAudioUrl = computed(() => audioPath.value || (runtimeResultType.value === 'audio' ? runtimeResultUrl.value : ''))
const primaryResultUrl = computed(() => displayVideoUrl.value || displayImageUrl.value || displayAudioUrl.value || runtimeResultUrl.value)
const assignedAssets = computed(() => Array.isArray(props.data.assignedAssets) ? props.data.assignedAssets : [])
const assignedAssetPurposeSummary = computed(() => [...new Set(assignedAssets.value.map(assetPurposeLabel))].join(' / '))
const failureReason = computed(() => {
  const status = runtimeStatus.value
  const runtimeError = status?.errorDetail || status?.detail || (status?.step === 'failed' ? status?.message : '')
  const sb = props.data.storyboard || {}
  return runtimeError || sb.error_msg || sb.error_message || sb.generation_error || ''
})
const hasResultState = computed(() => Boolean(displayImageUrl.value || displayVideoUrl.value || displayAudioUrl.value || runtimeResultUrl.value))

function onSelect(event) {
  ctx?.selectStoryboard?.(props.data.storyboard?.id, event)
  ctx?.setFocusedNode?.(props.id)
}

function assetThumbUrl(asset) {
  if (assetType(asset) !== 'image') return ''
  const url = asset?.display_url || asset?.asset_url || asset?.preview_url || asset?.url || asset?.image_url || asset?.thumbnail_url || asset?.cover_url || asset?.local_path || ''
  if (!url) return ''
  if (/^https?:\/\//.test(url) || url.startsWith('/')) return url
  return `/static/${String(url).replace(/^\/+/, '')}`
}

function assetMediaTarget(asset) {
  return asset?.display_url || asset?.asset_url || asset?.preview_url || asset?.url || asset?.image_url || asset?.video_url || asset?.audio_url || asset?.voice_url || asset?.local_path || ''
}

function assetType(asset) {
  const type = String(asset?.type || '').toLowerCase()
  if (['image', 'video', 'audio'].includes(type)) return type
  if (['voice', 'tone', 'sound', 'music', 'bgm', 'tts'].includes(type)) return 'audio'
  if (asset?.source_kind === 'voice_catalog' || asset?.voice_url || asset?.voice_local_path) return 'audio'
  const url = String(assetMediaTarget(asset) || '').toLowerCase().split('?')[0]
  if (/\.(mp4|webm|mov|m4v)$/.test(url)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(url)) return 'audio'
  return 'image'
}

function assetPurposeLabel(asset) {
  const slot = String(asset?.metadata?.attached_slot || asset?.metadata?.picker_slot || '').toLowerCase()
  if (['storyboard_first', 'first_frame', 'first'].includes(slot)) return '首帧'
  if (['storyboard_last', 'last_frame', 'last'].includes(slot)) return '尾帧'
  const type = assetType(asset)
  if (type === 'video') return '分镜视频'
  if (type === 'audio') return '分镜音频'
  return '参考素材'
}

function assetPurposeShortLabel(asset) {
  return ({ 首帧: '首', 尾帧: '尾', 分镜视频: '视', 分镜音频: '音', 参考素材: '参' }[assetPurposeLabel(asset)] || '素')
}

function retryStep(step) {
  if (isNodeBusy.value) return
  ctx?.runNodeStep?.({ id: props.id, type: 'canvasStoryboard', data: props.data }, step)
}

function openResult(url) {
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function copyResultLink() {
  const url = primaryResultUrl.value
  if (!url) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(url)
    ElMessage.success('结果链接已复制')
  } catch {
    ElMessageBox.alert(url, '结果链接（请手动复制）', { confirmButtonText: '关闭', type: 'info' })
  }
}
</script>

<style scoped>
.canvas-node-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.canvas-sb-node {
  position: relative;
  width: 200px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(129, 140, 248, 0.35);
  background: var(--bg-card, #18181b);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.canvas-sb-node:hover,
.canvas-sb-node.selected,
.canvas-sb-node.focused {
  border-color: #818cf8;
  box-shadow: 0 0 0 1px rgba(129, 140, 248, 0.35), 0 8px 24px rgba(0, 0, 0, 0.35);
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.num {
  font-size: 12px;
  font-weight: 700;
  color: #a5b4fc;
}
.wf-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(251, 191, 36, 0.18);
  color: #fcd34d;
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seg {
  font-size: 10px;
  color: #71717a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mode-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(167, 139, 250, 0.2);
  color: #c4b5fd;
}
.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright, #fafafa);
  margin-bottom: 6px;
  line-height: 1.35;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.chips span {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: #a1a1aa;
}
.st-completed { color: #34d399 !important; background: rgba(52, 211, 153, 0.12) !important; }
.st-processing { color: #60a5fa !important; }
.st-failed { color: #f87171 !important; }
.result-rail {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 5px;
}
.result-pill {
  padding: 2px 5px;
  border-radius: 999px;
  font-size: 9px;
  line-height: 1;
}
.result-pill.ready {
  background: rgba(52, 211, 153, 0.12);
  color: #34d399;
}
.result-pill.runtime {
  background: rgba(129, 140, 248, 0.16);
  color: #c7d2fe;
}
.result-pill.failed {
  background: rgba(248, 113, 113, 0.14);
  color: #fca5a5;
}
.failure-line {
  margin-bottom: 5px;
  color: #fca5a5;
  font-size: 10px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.reference-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
}
.reference-label {
  flex: 0 0 auto;
  font-size: 9px;
  color: #c4b5fd;
}
.reference-purpose {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9px;
  color: #7dd3fc;
}
.reference-thumb {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(167, 139, 250, 0.12);
  border: 1px solid rgba(167, 139, 250, 0.28);
  color: #c4b5fd;
  font-size: 9px;
  line-height: 24px;
  text-align: center;
}
.reference-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.result-actions button {
  border: 0;
  border-radius: 5px;
  padding: 2px 5px;
  background: rgba(52, 211, 153, 0.12);
  color: #86efac;
  font-size: 9px;
  cursor: pointer;
}
.result-actions button:hover {
  background: rgba(52, 211, 153, 0.22);
}
.retry-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.retry-row button {
  border: 0;
  border-radius: 5px;
  padding: 2px 5px;
  background: rgba(129, 140, 248, 0.14);
  color: #c7d2fe;
  font-size: 9px;
  cursor: pointer;
}
.retry-row button:hover:not(:disabled) {
  background: rgba(129, 140, 248, 0.25);
}
.retry-row button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.processing {
  animation: sb-pulse 1.4s ease-in-out infinite;
  border-color: #60a5fa;
}
.highlighted {
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.75), 0 8px 28px rgba(99, 102, 241, 0.25);
}
.dimmed {
  opacity: 0.28;
}
@keyframes sb-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.35); }
  50% { box-shadow: 0 0 0 6px rgba(96, 165, 250, 0.08); }
}
.hint {
  font-size: 10px;
  color: #52525b;
}
</style>
