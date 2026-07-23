<template>
  <div v-if="status" class="node-execution-strip">
    <span class="node-execution-label">节点执行</span>
    <span class="node-execution-message">{{ status.actionError || status.errorDetail || status.message || status.step }}</span>
    <span v-if="resultMetaText" class="node-execution-meta">{{ resultMetaText }}</span>
    <el-button
      v-if="resultUrl"
      link
      size="small"
      type="primary"
      @click.stop="openResult"
    >打开结果</el-button>
    <el-button
      v-if="resultUrl"
      link
      size="small"
      type="primary"
      @click.stop="copyResult"
    >复制结果</el-button>
    <el-button
      v-if="resultUrl"
      link
      size="small"
      type="primary"
      @click.stop="downloadResult"
    >下载</el-button>
    <el-button
      v-if="status.actionError || status.errorDetail || status.message"
      link
      size="small"
      :type="status.step === 'failed' || status.actionError ? 'danger' : 'info'"
      @click.stop="copyStatusDetail"
    >复制详情</el-button>
    <el-button
      v-if="status.promptText"
      link
      size="small"
      type="info"
      @click.stop="copyPrompt"
    >复制提示词</el-button>
    <el-button
      v-if="requestPayloadText"
      link
      size="small"
      type="info"
      @click.stop="copyRequestPayload"
    >复制请求</el-button>
    <el-button
      v-if="resultSummary"
      link
      size="small"
      type="info"
      @click.stop="copyResultSummary"
    >复制摘要</el-button>
    <el-button
      v-if="resultReferencesText"
      link
      size="small"
      type="info"
      @click.stop="copyResultReferences"
    >复制引用</el-button>
    <el-button
      v-if="upstreamReferenceText"
      link
      size="small"
      type="info"
      @click.stop="copyUpstreamReferences"
    >复制上游</el-button>
    <el-button
      v-if="savedAssetReference"
      link
      size="small"
      type="info"
      @click.stop="copySavedAssetReference"
    >素材引用</el-button>
    <el-button
      v-if="canUseResultAsDownstreamReference"
      link
      size="small"
      type="primary"
      :disabled="disabled || attachingReference"
      @click.stop="useResultAsDownstreamReference"
    >{{ attachingReference ? '处理中…' : '作为下游参考' }}</el-button>
    <el-button
      v-if="status.step === 'failed' && status.retryStep"
      link
      size="small"
      type="danger"
      :disabled="disabled"
      @click.stop="$emit('retry')"
    >{{ status.retryLabel || '重试失败步骤' }}</el-button>
    <el-button
      v-if="status.retryAction"
      link
      size="small"
      :type="status.step === 'failed' || status.actionError ? 'danger' : 'warning'"
      :disabled="disabled"
      @click.stop="$emit('retry-action')"
    >{{ status.retryActionLabel || '重试操作' }}</el-button>
    <el-button
      v-if="status.nextStep"
      link
      size="small"
      type="primary"
      :disabled="disabled"
      @click.stop="$emit('continue')"
    >{{ status.nextLabel || '继续下游' }}</el-button>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { assetMediaUrl } from '@/utils/mediaUrl'

const props = defineProps({
  status: { type: Object, default: null },
  nodeId: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
})

defineEmits(['retry', 'retry-action', 'continue'])

const ctx = useCanvasContext()
const attachingReference = ref(false)
const statusSavedAsset = computed(() => {
  if (!props.status?.savedAssetId) return null
  return {
    id: props.status.savedAssetId,
    url: props.status.savedAssetUrl || props.status.resultUrl || '',
    local_path: props.status.savedAssetLocalPath || '',
  }
})
const resultUrl = computed(() => assetMediaUrl(statusSavedAsset.value) || props.status?.savedAssetUrl || props.status?.resultUrl || '')
const downstreamNodeId = computed(() => props.status?.resultNodeId || props.status?.sourceNodeId || props.nodeId || '')
const downstreamNode = computed(() => downstreamNodeId.value ? ctx?.findCanvasNode?.(downstreamNodeId.value) : null)
const resultSummary = computed(() => String(props.status?.resultSummary || '').trim())
const resultReferences = computed(() => normalizeTextList(props.status?.resultReferences))
const resultReferencesText = computed(() => resultReferences.value.join('\n'))
const upstreamReferenceUrls = computed(() => normalizeTextList(props.status?.upstreamReferenceUrls))
const upstreamReferenceText = computed(() => upstreamReferenceUrls.value.join('\n'))
const savedAssetReference = computed(() => {
  if (!props.status?.savedAssetId) return ''
  const name = props.status?.savedAssetName || '素材'
  const url = props.status?.savedAssetUrl || props.status?.resultUrl || ''
  return `@素材(${name}#${props.status.savedAssetId}) ${url}`.trim()
})
const hasReusableResultReference = computed(() => Boolean(resultUrl.value || resultSummary.value || resultReferences.value.length || savedAssetReference.value))
const canUseResultAsDownstreamReference = computed(() => hasReusableResultReference.value && Boolean(downstreamNode.value?.id) && Boolean(ctx?.useNodeResultAsDownstreamReference))
const resultMetaText = computed(() => {
  const parts = []
  if (resultSummary.value) parts.push(resultSummary.value)
  if (resultReferences.value.length) parts.push(`引用 ${resultReferences.value.length}`)
  if (props.status?.savedAssetId) parts.push(`素材 #${props.status.savedAssetId}`)
  return parts.join(' · ')
})
const requestPayloadText = computed(() => {
  const payload = props.status?.requestAudit || props.status?.requestPayload
  if (!payload || typeof payload !== 'object') return ''
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload || '')
  }
})

function normalizeTextList(items) {
  if (!Array.isArray(items)) return []
  return [...new Set(items.map((value) => String(value || '').trim()).filter(Boolean))]
}

function openResult() {
  if (!resultUrl.value) return
  window.open(resultUrl.value, '_blank', 'noopener,noreferrer')
}

function downloadResult() {
  if (!resultUrl.value) return
  const link = document.createElement('a')
  link.href = resultUrl.value
  link.download = resultFilename()
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function resultFilename() {
  const rawName = String(resultUrl.value).split(/[?#]/)[0].split('/').pop()
  return rawName || 'canvas-node-result'
}

async function copyText(text, successMessage, fallbackTitle) {
  if (!text) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(text)
    ElMessage.success(successMessage)
  } catch {
    ElMessageBox.alert(text, fallbackTitle, { confirmButtonText: '关闭', type: 'info' })
  }
}

function copyResult() {
  copyText(resultUrl.value, '结果链接已复制', '结果链接（请手动复制）')
}

function copyStatusDetail() {
  copyText(props.status?.actionError || props.status?.errorDetail || props.status?.message || '', '节点详情已复制', '节点详情（请手动复制）')
}

function copyPrompt() {
  copyText(props.status?.promptText || '', '提示词已复制', '提示词（请手动复制）')
}

function copyRequestPayload() {
  copyText(requestPayloadText.value, '真实请求已复制', '真实请求（请手动复制）')
}

function copyResultSummary() {
  copyText(resultSummary.value, '结果摘要已复制', '结果摘要（请手动复制）')
}

function copyResultReferences() {
  copyText(resultReferencesText.value, '结果引用已复制', '结果引用（请手动复制）')
}

function copyUpstreamReferences() {
  copyText(upstreamReferenceText.value, '上游引用已复制', '上游引用（请手动复制）')
}

function copySavedAssetReference() {
  copyText(savedAssetReference.value, '素材引用已复制', '素材引用（请手动复制）')
}

async function useResultAsDownstreamReference() {
  if (!canUseResultAsDownstreamReference.value || attachingReference.value) return
  attachingReference.value = true
  try {
    await ctx.useNodeResultAsDownstreamReference(downstreamNode.value, {
      resultUrl: resultUrl.value,
      resultType: props.status?.resultType || '',
      savedAssetId: props.status?.savedAssetId || '',
      resultSummary: resultSummary.value,
      resultReferences: resultReferences.value,
    })
    ElMessage.success('已作为下游参考')
  } catch (error) {
    ElMessage.error(error?.message || '作为下游参考失败')
  } finally {
    attachingReference.value = false
  }
}
</script>

<style scoped>
.node-execution-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  padding: 4px 7px;
  border: 1px solid rgba(99, 102, 241, 0.28);
  border-radius: 8px;
  background: rgba(30, 27, 75, 0.3);
  color: #c7d2fe;
  font-size: 11px;
}
.node-execution-label {
  color: #93c5fd;
  font-weight: 700;
}
.node-execution-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-execution-meta {
  max-width: 240px;
  overflow: hidden;
  color: #a5b4fc;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
