<template>
  <div class="project-asset-node" :class="{ focused: data.focused }">
    <CanvasNodeStatusOverlay :node-id="id" />
    <div class="tag">{{ typeLabel }}</div>
    <div v-if="assetBadges.length" class="asset-badges">
      <span v-for="badge in assetBadges" :key="badge" class="asset-badge">{{ badge }}</span>
    </div>
    <div class="asset-purpose">{{ purposeLabel }}</div>
    <video v-if="assetType === 'video' && url" :src="url" class="asset-media" muted controls preload="metadata" />
    <audio v-else-if="assetType === 'audio' && url" :src="url" class="asset-audio" controls />
    <img v-else-if="url" :src="url" :alt="data.asset?.name || '项目素材'" />
    <div v-else class="empty">素材不可用</div>
    <strong>{{ data.asset?.name || '未命名截图' }}</strong>
    <span>{{ assignmentLabel }}</span>
    <p v-if="isFailureAsset" class="asset-failure">{{ failureLabel }}</p>
    <div class="asset-actions">
      <button type="button" :disabled="!url" @click.stop="openAsset">预览</button>
      <button type="button" :disabled="!referenceText" @click.stop="copyReference">复制引用</button>
      <button type="button" :disabled="!assetId || assigning" @click.stop="assignToSelectedStoryboard">{{ assignButtonLabel }}</button>
    </div>
    <div
      v-if="data.focused"
      class="project-asset-panel nodrag nopan nowheel"
      @pointerdown.stop
      @mousedown.stop
      @click.stop
      @wheel.stop
    >
      <div class="panel-head">
        <span>素材配置</span>
        <button type="button" @click.stop="closePanel">收起</button>
      </div>
      <CanvasNodeExecutionStrip
        :status="activeNodeStatus"
        :disabled="assigning"
        @retry="retryFailedStep"
      />
      <p class="asset-ref">{{ referenceText || '该素材缺少可复制引用' }}</p>
      <p class="asset-assignment">{{ assignmentLabel }}</p>
      <p v-if="isFailureAsset" class="asset-failure panel-failure">{{ failureLabel }}</p>
      <div class="panel-actions">
        <button type="button" :disabled="!url" @click.stop="openAsset">打开预览</button>
        <button type="button" :disabled="!referenceText" @click.stop="copyReference">复制到提示词</button>
        <button type="button" :disabled="!assetId || assigning" @click.stop="assignToSelectedStoryboard">
          {{ assigning ? '指派中…' : assignButtonLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { assetMediaUrl } from '@/utils/mediaUrl'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'
import CanvasNodeExecutionStrip from './CanvasNodeExecutionStrip.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
})
const ctx = useCanvasContext()
const assigning = ref(false)
const assetType = computed(() => normalizeAssetNodeType(props.data.asset))
const typeLabel = computed(() => ({ image: '图片素材', video: '视频素材', audio: '音频素材' }[assetType.value] || '项目素材'))
const url = computed(() => assetMediaUrl(props.data.asset))
const referenceAssetId = computed(() => props.data.asset?.raw_id || props.data.asset?.id || '')
const assetId = computed(() => referenceAssetId.value)
const activeNodeStatus = computed(() => ctx?.nodeStatus?.map?.[props.id] || null)
const assignedStoryboardId = computed(() => Number(
  props.data.asset?.storyboard_id
  || props.data.asset?.metadata?.storyboard_id
  || props.data.asset?.metadata?.attached_storyboard_id
  || props.data.asset?.picker_storyboard_id
  || 0,
))
const statusStoryboardId = computed(() => Number(activeNodeStatus.value?.attachedToStoryboardId || activeNodeStatus.value?.storyboardId || 0))
const assignmentLabel = computed(() => Number.isFinite(assignedStoryboardId.value) && assignedStoryboardId.value > 0
  ? `已指派到分镜 #${assignedStoryboardId.value}`
  : Number.isFinite(statusStoryboardId.value) && statusStoryboardId.value > 0
    ? `目标分镜 #${statusStoryboardId.value}`
  : '未指派到分镜')
const attachedSlot = computed(() => activeNodeStatus.value?.attachedSlot || props.data.asset?.metadata?.attached_slot || props.data.asset?.metadata?.picker_slot || '')
const purposeLabel = computed(() => assetPurposeLabel(props.data.asset, attachedSlot.value))
const sourceLabel = computed(() => {
  const source = props.data.asset?.picker_source
    || props.data.asset?.source_kind
    || props.data.asset?.metadata?.source_kind
    || ''
  return {
    project: '项目资产',
    character: '角色库',
    scene: '场景库',
    prop: '道具库',
    voice_catalog: '音色库',
  }[source] || ''
})
const pickerStatusLabel = computed(() => props.data.asset?.picker_status || '')
const pickerStoryboardId = computed(() => Number(props.data.asset?.picker_storyboard_id || 0))
const assetBadges = computed(() => [
  sourceLabel.value,
  pickerStatusLabel.value || (Number.isFinite(pickerStoryboardId.value) && pickerStoryboardId.value > 0
    ? `已挂载分镜 #${pickerStoryboardId.value}`
    : ''),
].filter(Boolean))
const isFailureAsset = computed(() => props.data.asset?.category === 'canvas-asset-failure')
const failureReason = computed(() => activeNodeStatus.value?.errorDetail || activeNodeStatus.value?.message || props.data.asset?.metadata?.error || '')
const failureLabel = computed(() => `素材库挂载失败${failureReason.value ? `：${failureReason.value}` : ''}`)
const assignButtonLabel = computed(() => isFailureAsset.value ? '重新选择' : '指派')
const referenceText = computed(() => {
  const asset = props.data.asset || {}
  const id = referenceAssetId.value
  if (!id) return ''
  const name = asset.name || asset.title || asset.filename || '素材'
  return `@素材(${name}#${id}) ${url.value || asset.local_path || ''}`.trim()
})

function normalizeAssetNodeType(asset) {
  const type = String(asset?.type || '').toLowerCase()
  if (['image', 'video', 'audio'].includes(type)) return type
  if (['voice', 'tone', 'sound', 'music', 'bgm', 'tts'].includes(type)) return 'audio'
  if (asset?.source_kind === 'voice_catalog'
    || asset?.voice_catalog
    || asset?.voice_catalog_id
    || asset?.voice_asset_id
    || asset?.voice_url
    || asset?.voice_local_path) return 'audio'
  const target = String(assetMediaUrl(asset) || asset?.url || asset?.local_path || '').toLowerCase().split('?')[0]
  if (/\.(mp4|webm|mov|m4v)$/.test(target)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(target)) return 'audio'
  return 'image'
}

function assetPurposeLabel(asset, slot = '') {
  const normalizedSlot = String(slot || '').toLowerCase()
  if (['storyboard_first', 'first_frame', 'first'].includes(normalizedSlot)) return '用途：首帧'
  if (['storyboard_last', 'last_frame', 'last'].includes(normalizedSlot)) return '用途：尾帧'
  if (normalizedSlot === 'video') return '用途：分镜视频'
  if (normalizedSlot === 'audio') return '用途：分镜音频'
  const type = normalizeAssetNodeType(asset)
  if (type === 'video') return '用途：分镜视频'
  if (type === 'audio') return '用途：分镜音频'
  return '用途：参考素材'
}

function openAsset() {
  if (!url.value) return
  window.open(url.value, '_blank', 'noopener,noreferrer')
}

async function copyReference() {
  if (!referenceText.value) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(referenceText.value)
    ElMessage.success('素材引用已复制')
  } catch {
    ElMessageBox.alert(referenceText.value, '素材引用（请手动复制）', { confirmButtonText: '关闭', type: 'info' })
  }
}

async function assignToSelectedStoryboard() {
  if (!assetId.value || assigning.value) return
  assigning.value = true
  try {
    await ctx?.runNodeStep?.({ id: props.id, type: 'canvasProjectAsset', data: props.data }, 'library')
  } finally {
    assigning.value = false
  }
}

async function retryFailedStep() {
  if (!activeNodeStatus.value?.retryStep || assigning.value) return
  await assignToSelectedStoryboard()
}

function closePanel() {
  ctx?.clearFocusedNode?.()
}
</script>

<style scoped>
.project-asset-node { position: relative; width: 190px; overflow: hidden; border: 1px solid #3f3f46; border-radius: 12px; padding: 9px; background: #18181b; color: #e4e4e7; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
.project-asset-node.focused { border-color: #38bdf8; box-shadow: 0 0 0 2px rgba(56,189,248,.25); }
.project-asset-node img,
.asset-media,
.asset-audio,
.empty { width: 100%; height: 108px; margin: 6px 0; border-radius: 8px; object-fit: cover; background: #09090b; }
.asset-audio { height: 42px; }
.empty { display: grid; place-items: center; color: #71717a; font-size: 11px; }
.tag { color: #38bdf8; font-size: 10px; font-weight: 700; }
.asset-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.asset-badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 999px; padding: 1px 6px; background: rgba(139,92,246,.16); color: #c4b5fd; font-size: 10px; }
.asset-purpose { display: inline-flex; margin-top: 5px; border-radius: 999px; padding: 2px 6px; background: rgba(14,165,233,.12); color: #7dd3fc; font-size: 10px; }
.project-asset-node strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.project-asset-node span { color: #71717a; font-size: 10px; }
.asset-actions { display: flex; gap: 6px; margin-top: 8px; }
.asset-actions button { flex: 1; border: 1px solid rgba(56,189,248,.35); border-radius: 6px; background: rgba(56,189,248,.12); color: #bae6fd; font-size: 10px; line-height: 22px; cursor: pointer; }
.asset-actions button:disabled { opacity: .5; cursor: not-allowed; }
.project-asset-panel { margin-top: 10px; padding-top: 9px; border-top: 1px solid rgba(56,189,248,.22); }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 700; color: #bae6fd; }
.panel-head button { border: 0; background: transparent; color: #7dd3fc; font-size: 10px; cursor: pointer; }
.asset-ref { margin: 8px 0; max-height: 52px; overflow: auto; color: #a1a1aa; font-size: 10px; line-height: 1.4; word-break: break-all; }
.asset-assignment { margin: 0 0 8px; color: #7dd3fc; font-size: 10px; }
.asset-failure { margin: 6px 0 0; color: #fecaca; font-size: 10px; line-height: 1.4; word-break: break-word; }
.panel-failure { margin: 0 0 8px; }
.panel-actions { display: grid; gap: 6px; }
.panel-actions button { border: 1px solid rgba(125,211,252,.32); border-radius: 7px; background: rgba(14,165,233,.13); color: #e0f2fe; font-size: 10px; line-height: 24px; cursor: pointer; }
.panel-actions button:disabled { opacity: .5; cursor: not-allowed; }
</style>
