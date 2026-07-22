<template>
  <div class="project-asset-node" :class="{ focused: data.focused }">
    <CanvasNodeStatusOverlay :node-id="id" />
    <div class="tag">{{ typeLabel }}</div>
    <video v-if="assetType === 'video' && url" :src="url" class="asset-media" muted controls preload="metadata" />
    <audio v-else-if="assetType === 'audio' && url" :src="url" class="asset-audio" controls />
    <img v-else-if="url" :src="url" :alt="data.asset?.name || '项目素材'" />
    <div v-else class="empty">素材不可用</div>
    <strong>{{ data.asset?.name || '未命名截图' }}</strong>
    <span>项目领域资产</span>
    <div class="asset-actions">
      <button type="button" :disabled="!url" @click.stop="openAsset">预览</button>
      <button type="button" :disabled="!referenceText" @click.stop="copyReference">复制引用</button>
      <button type="button" :disabled="!assetId || assigning" @click.stop="assignToSelectedStoryboard">指派</button>
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
      <p class="asset-ref">{{ referenceText || '该素材缺少可复制引用' }}</p>
      <div class="panel-actions">
        <button type="button" :disabled="!url" @click.stop="openAsset">打开预览</button>
        <button type="button" :disabled="!referenceText" @click.stop="copyReference">复制到提示词</button>
        <button type="button" :disabled="!assetId || assigning" @click.stop="assignToSelectedStoryboard">
          {{ assigning ? '指派中…' : '指派到选中分镜' }}
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

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
})
const ctx = useCanvasContext()
const assigning = ref(false)
const assetType = computed(() => props.data.asset?.type || 'image')
const typeLabel = computed(() => ({ image: '图片素材', video: '视频素材', audio: '音频素材' }[assetType.value] || '项目素材'))
const url = computed(() => assetMediaUrl(props.data.asset))
const assetId = computed(() => props.data.asset?.raw_id || props.data.asset?.id || '')
const referenceText = computed(() => {
  const asset = props.data.asset || {}
  if (!asset.id) return ''
  const name = asset.name || asset.title || asset.filename || '素材'
  return `@素材(${name}#${asset.id}) ${url.value || asset.local_path || ''}`.trim()
})

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
.project-asset-node strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.project-asset-node span { color: #71717a; font-size: 10px; }
.asset-actions { display: flex; gap: 6px; margin-top: 8px; }
.asset-actions button { flex: 1; border: 1px solid rgba(56,189,248,.35); border-radius: 6px; background: rgba(56,189,248,.12); color: #bae6fd; font-size: 10px; line-height: 22px; cursor: pointer; }
.asset-actions button:disabled { opacity: .5; cursor: not-allowed; }
.project-asset-panel { margin-top: 10px; padding-top: 9px; border-top: 1px solid rgba(56,189,248,.22); }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 700; color: #bae6fd; }
.panel-head button { border: 0; background: transparent; color: #7dd3fc; font-size: 10px; cursor: pointer; }
.asset-ref { margin: 8px 0; max-height: 52px; overflow: auto; color: #a1a1aa; font-size: 10px; line-height: 1.4; word-break: break-all; }
.panel-actions { display: grid; gap: 6px; }
.panel-actions button { border: 1px solid rgba(125,211,252,.32); border-radius: 7px; background: rgba(14,165,233,.13); color: #e0f2fe; font-size: 10px; line-height: 24px; cursor: pointer; }
.panel-actions button:disabled { opacity: .5; cursor: not-allowed; }
</style>
