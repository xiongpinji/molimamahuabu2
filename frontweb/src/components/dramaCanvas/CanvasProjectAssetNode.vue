<template>
  <div class="project-asset-node" :class="{ focused: data.focused }">
    <div class="tag">导演截图</div>
    <img v-if="url" :src="url" :alt="data.asset?.name || '导演截图'" />
    <div v-else class="empty">图片不可用</div>
    <strong>{{ data.asset?.name || '未命名截图' }}</strong>
    <span>项目领域资产</span>
    <div class="asset-actions">
      <button type="button" :disabled="!url" @click.stop="openAsset">预览</button>
      <button type="button" :disabled="!referenceText" @click.stop="copyReference">复制引用</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { assetImageUrl } from '@/utils/mediaUrl'

const props = defineProps({ data: { type: Object, required: true } })
const url = computed(() => assetImageUrl(props.data.asset))
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
</script>

<style scoped>
.project-asset-node { width: 190px; overflow: hidden; border: 1px solid #3f3f46; border-radius: 12px; padding: 9px; background: #18181b; color: #e4e4e7; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
.project-asset-node.focused { border-color: #38bdf8; box-shadow: 0 0 0 2px rgba(56,189,248,.25); }
.project-asset-node img, .empty { width: 100%; height: 108px; margin: 6px 0; border-radius: 8px; object-fit: cover; background: #09090b; }
.empty { display: grid; place-items: center; color: #71717a; font-size: 11px; }
.tag { color: #38bdf8; font-size: 10px; font-weight: 700; }
.project-asset-node strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.project-asset-node span { color: #71717a; font-size: 10px; }
.asset-actions { display: flex; gap: 6px; margin-top: 8px; }
.asset-actions button { flex: 1; border: 1px solid rgba(56,189,248,.35); border-radius: 6px; background: rgba(56,189,248,.12); color: #bae6fd; font-size: 10px; line-height: 22px; cursor: pointer; }
.asset-actions button:disabled { opacity: .5; cursor: not-allowed; }
</style>
