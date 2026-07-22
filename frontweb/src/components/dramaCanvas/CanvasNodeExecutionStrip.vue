<template>
  <div v-if="status" class="node-execution-strip">
    <span class="node-execution-label">节点执行</span>
    <span class="node-execution-message">{{ status.errorDetail || status.message || status.step }}</span>
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
      v-if="status.errorDetail || status.message"
      link
      size="small"
      :type="status.step === 'failed' ? 'danger' : 'info'"
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
      v-if="status.step === 'failed' && status.retryStep"
      link
      size="small"
      type="danger"
      :disabled="disabled"
      @click.stop="$emit('retry')"
    >{{ status.retryLabel || '重试失败步骤' }}</el-button>
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
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { assetMediaUrl } from '@/utils/mediaUrl'

const props = defineProps({
  status: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
})

defineEmits(['retry', 'continue'])

const statusSavedAsset = computed(() => {
  if (!props.status?.savedAssetId) return null
  return {
    id: props.status.savedAssetId,
    url: props.status.savedAssetUrl || props.status.resultUrl || '',
    local_path: props.status.savedAssetLocalPath || '',
  }
})
const resultUrl = computed(() => assetMediaUrl(statusSavedAsset.value) || props.status?.savedAssetUrl || props.status?.resultUrl || '')
const requestPayloadText = computed(() => {
  const payload = props.status?.requestAudit || props.status?.requestPayload
  if (!payload || typeof payload !== 'object') return ''
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload || '')
  }
})

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
  copyText(props.status?.errorDetail || props.status?.message || '', '节点详情已复制', '节点详情（请手动复制）')
}

function copyPrompt() {
  copyText(props.status?.promptText || '', '提示词已复制', '提示词（请手动复制）')
}

function copyRequestPayload() {
  copyText(requestPayloadText.value, '真实请求已复制', '真实请求（请手动复制）')
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
</style>
