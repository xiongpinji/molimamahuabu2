<template>
  <div v-if="status" class="node-status-overlay" :class="'step-' + status.step" :title="statusTitle">
    <span v-if="isFailed" class="error-mark">!</span>
    <span v-else-if="isSuccess" class="success-mark">✓</span>
    <span v-else class="spinner" />
    <span class="step-label">{{ stepLabel }}</span>
    <span class="msg">{{ status.message }}</span>
    <span v-if="metaText" class="meta">{{ metaText }}</span>
    <span v-if="failedHint" class="failed-hint">{{ failedHint }}</span>
    <span v-if="resultText" class="result-text">{{ resultText }}</span>
    <span v-if="failedResultText" class="failed-result-text">{{ failedResultText }}</span>
    <span v-if="assetResultText" class="asset-result-text">{{ assetResultText }}</span>
    <span v-if="generationAuditText" class="generation-audit">{{ generationAuditText }}</span>
    <span v-if="upstreamReferenceText" class="reference-text">{{ upstreamReferenceText }}</span>
    <span v-if="actionErrorText" class="action-error">{{ actionErrorText }}</span>
    <div v-if="hasResultPreview" class="result-preview" :class="'result-' + resultPreviewType">
      <img v-if="resultPreviewType === 'image'" :src="effectiveResultUrl" alt="节点生成结果预览" />
      <video v-else-if="resultPreviewType === 'video'" :src="effectiveResultUrl" muted controls playsinline />
      <audio v-else-if="resultPreviewType === 'audio'" :src="effectiveResultUrl" controls />
    </div>
    <div v-if="hasTextResultPreview" class="result-preview result-text-preview">
      <p>{{ textResultPreview }}</p>
    </div>
    <span v-if="isSuccess" class="success-actions">
      <span v-if="effectiveResultUrl" class="action-group action-group-primary" aria-label="结果操作">
        <button type="button" @click.stop="openResult">打开结果</button>
        <button type="button" @click.stop="copyResultLink">复制链接</button>
        <button type="button" @click.stop="downloadResult">下载结果</button>
        <button v-if="resultNodeId" type="button" @click.stop="focusResultNode">定位结果</button>
      </span>
      <span v-if="status.resultUrl || effectiveSavedAsset" class="action-group action-group-asset" aria-label="素材操作">
        <button v-if="status.resultUrl" type="button" :disabled="savingAsset" @click.stop="saveResultAsset">
          {{ savingAsset ? '保存中…' : '存入素材库' }}
        </button>
        <button v-if="effectiveSavedAsset" type="button" @click.stop="copyAssetReference">复制素材引用</button>
        <button v-if="effectiveSavedAsset" type="button" @click.stop="viewSavedAsset">查看素材</button>
      </span>
      <span v-if="canAttachImage || canAttachVideo || canAttachAudio" class="action-group action-group-attach" aria-label="挂载操作">
        <button v-if="canAttachImage" type="button" :disabled="attachingResult" @click.stop="attachImageResult('main')">设为本镜图</button>
        <button v-if="canAttachImage" type="button" :disabled="attachingResult" @click.stop="attachImageResult('first')">设为首帧</button>
        <button v-if="canAttachImage" type="button" :disabled="attachingResult" @click.stop="attachImageResult('last')">设为尾帧</button>
        <button v-if="canAttachVideo" type="button" :disabled="attachingResult" @click.stop="attachVideoResult">设为本镜视频</button>
        <button v-if="canAttachAudio" type="button" :disabled="attachingResult" @click.stop="attachAudioResult">设为本镜音频</button>
      </span>
      <span class="action-group action-group-flow" aria-label="流程操作">
        <button v-if="status.promptText" type="button" @click.stop="copyPrompt">复制提示词</button>
        <button v-if="resultReferencesText" type="button" @click.stop="copyResultReferences">复制结果引用</button>
        <button v-if="upstreamReferenceUrls.length" type="button" @click.stop="copyUpstreamReferences">复制上游引用</button>
        <button v-if="requestPayloadText" type="button" @click.stop="copyRequestPayload">复制请求</button>
        <button v-if="canUseResultAsDownstreamReference" type="button" :disabled="attachingResult" @click.stop="useResultAsDownstreamReference">作为下游参考</button>
        <button v-if="status.retryAction" type="button" :disabled="savingAsset || attachingResult" @click.stop="retryAction">{{ status.retryActionLabel || '重试操作' }}</button>
        <button v-if="status.nextStep" type="button" @click.stop="runNextStep">{{ status.nextLabel || '继续下游' }}</button>
        <button type="button" @click.stop="dismissStatus">收起</button>
      </span>
    </span>
    <span v-if="isFailed" class="failed-actions">
      <span class="action-group action-group-primary" aria-label="失败结果操作">
        <button v-if="effectiveResultUrl" type="button" @click.stop="openResult">打开结果</button>
        <button v-if="effectiveResultUrl" type="button" @click.stop="copyResultLink">复制链接</button>
        <button v-if="effectiveResultUrl" type="button" @click.stop="downloadResult">下载结果</button>
        <button v-if="resultNodeId" type="button" @click.stop="focusResultNode">定位结果</button>
        <button v-if="status.errorDetail || status.message" type="button" @click.stop="copyError">复制原因</button>
      </span>
      <span v-if="status.resultUrl || effectiveSavedAsset" class="action-group action-group-asset" aria-label="失败素材操作">
        <button v-if="status.resultUrl" type="button" :disabled="savingAsset" @click.stop="saveResultAsset">
          {{ savingAsset ? '保存中…' : '存入素材库' }}
        </button>
        <button v-if="effectiveSavedAsset" type="button" @click.stop="copyAssetReference">复制素材引用</button>
        <button v-if="effectiveSavedAsset" type="button" @click.stop="viewSavedAsset">查看素材</button>
      </span>
      <span class="action-group action-group-flow" aria-label="失败流程操作">
        <button v-if="status.promptText" type="button" @click.stop="copyPrompt">复制提示词</button>
        <button v-if="upstreamReferenceUrls.length" type="button" @click.stop="copyUpstreamReferences">复制上游引用</button>
        <button v-if="requestPayloadText" type="button" @click.stop="copyRequestPayload">复制请求</button>
        <button v-if="status.retryAction" type="button" :disabled="savingAsset || attachingResult" @click.stop="retryAction">{{ status.retryActionLabel || '重试操作' }}</button>
        <button v-if="canUseResultAsDownstreamReference" type="button" :disabled="attachingResult" @click.stop="useResultAsDownstreamReference">作为下游参考</button>
        <button v-if="status.retryStep" type="button" @click.stop="retryFailed">{{ retryLabel }}</button>
        <button type="button" @click.stop="dismissStatus">收起</button>
      </span>
    </span>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { assetsAPI } from '@/api/assets'
import { imagesAPI } from '@/api/images'
import { storyboardsAPI } from '@/api/storyboards'
import { videosAPI } from '@/api/videos'
import { storyboardIdFromNodeId } from '@/utils/canvasWorkflow'
import { assetMediaUrl } from '@/utils/mediaUrl'

const props = defineProps({
  nodeId: { type: String, required: true },
})

const router = useRouter()
const ctx = useCanvasContext()
const now = ref(Date.now())
const savingAsset = ref(false)
const savedAsset = ref(null)
const attachingResult = ref(false)
let timer = null

const status = computed(() => {
  const map = ctx?.nodeStatus?.map
  if (!map || !props.nodeId) return null
  return map[props.nodeId] || null
})

const isFailed = computed(() => status.value?.step === 'failed')
const isSuccess = computed(() => status.value?.step === 'success')

const stepLabel = computed(() => {
  const map = {
    image: '图片任务',
    video: '视频任务',
    audio: '音频任务',
    polish: '润色任务',
    ref_image: '参考图任务',
    panorama: '全景任务',
    multi_view: '多视图任务',
    upload: '上传任务',
    save: '保存任务',
    library: '素材库',
    workflow: '工作流',
    generate_sb: '分镜任务',
    extract_chars: '角色提取',
    extract_scenes: '场景提取',
    extract_props: '道具提取',
    extract_all: '一键提取',
    failed: '执行失败',
    success: '执行完成',
  }
  return map[status.value?.step] || '节点任务'
})

const elapsedText = computed(() => {
  const startedAt = Number(status.value?.at)
  if (!Number.isFinite(startedAt)) return ''
  const seconds = Math.max(0, Math.floor((now.value - startedAt) / 1000))
  if (seconds < 60) return `${seconds}秒`
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
})

const metaText = computed(() => {
  const parts = []
  if (status.value?.queueLabel) parts.push(status.value.queueLabel)
  if (status.value?.stepIndex && status.value?.stepTotal) parts.push(`步骤 ${status.value.stepIndex}/${status.value.stepTotal}`)
  if (status.value?.restored) parts.push(status.value?.stale ? '已恢复中断状态' : '已恢复运行状态')
  if (elapsedText.value) parts.push(`耗时 ${elapsedText.value}`)
  if (Number.isFinite(Number(status.value?.progress))) parts.push(`${Number(status.value.progress)}%`)
  if (status.value?.taskId) parts.push(`任务 ${status.value.taskId}`)
  if (status.value?.videoGenerationId) parts.push(`记录 ${status.value.videoGenerationId}`)
  if (status.value?.model) parts.push(`模型 ${status.value.model}`)
  return parts.join(' · ')
})

const requestPayloadText = computed(() => {
  const payload = status.value?.requestAudit || status.value?.requestPayload
  if (!payload || typeof payload !== 'object') return ''
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload || '')
  }
})

const generationAuditText = computed(() => {
  const parts = []
  if (status.value?.videoGenerationId) parts.push(`生成记录 ${status.value.videoGenerationId}`)
  if (status.value?.model) parts.push(`模型 ${status.value.model}`)
  if (status.value?.requestAudit?.voice_policy?.label) parts.push(`声音 ${status.value.requestAudit.voice_policy.label}`)
  if (requestPayloadText.value) parts.push('真实请求已记录')
  return parts.join(' · ')
})

const failedHint = computed(() => {
  if (!isFailed.value) return ''
  if (status.value?.recoverable || status.value?.retryStep) return '可点击重试继续执行'
  return ''
})

const resultText = computed(() => {
  if (!isSuccess.value) return ''
  const typeMap = { image: '图片已生成', video: '视频已生成', audio: '音频已生成' }
  const label = status.value?.resultLabel || typeMap[status.value?.resultType] || ''
  const summary = status.value?.resultSummary || ''
  const urlHint = effectiveResultUrl.value ? '可在节点卡片预览' : ''
  return [label, summary, urlHint].filter(Boolean).join(' · ')
})

const failedResultText = computed(() => {
  if (!isFailed.value) return ''
  const parts = []
  if (effectiveResultUrl.value) parts.push('已保留失败前结果，可预览/下载')
  const asset = effectiveSavedAsset.value
  if (asset?.id) parts.push(`已保留素材：${asset.name || '素材'}#${asset.id}`)
  return parts.join(' · ')
})

const assetResultText = computed(() => {
  if (!isSuccess.value) return ''
  const parts = []
  const asset = effectiveSavedAsset.value
  if (asset?.id) parts.push(`已入库：${asset.name || '素材'}#${asset.id}`)
  if (status.value?.attachedToStoryboardId) {
    const slotMap = { first: '首帧', last: '尾帧', main: '本镜图', video: '本镜视频', audio: '本镜音频' }
    const slot = slotMap[status.value?.attachedSlot] || '分镜素材'
    parts.push(`已挂载：${slot} -> 分镜 ${status.value.attachedToStoryboardId}`)
  }
  if (status.value?.attachedResultUrl || status.value?.attachedResultLocalPath) parts.push('挂载结果已回写')
  return parts.join(' · ')
})

const upstreamReferenceUrls = computed(() => {
  const urls = Array.isArray(status.value?.upstreamReferenceUrls) ? status.value.upstreamReferenceUrls : []
  return [...new Set(urls.map((url) => String(url || '').trim()).filter(Boolean))]
})
const upstreamReferenceText = computed(() => upstreamReferenceUrls.value.length ? `已引用 ${upstreamReferenceUrls.value.length} 个上游结果` : '')
const resultReferences = computed(() => {
  const references = Array.isArray(status.value?.resultReferences) ? status.value.resultReferences : []
  return [...new Set(references.map((reference) => String(reference || '').trim()).filter(Boolean))]
})
const resultReferencesText = computed(() => resultReferences.value.join('\n'))
const textResultPreview = computed(() => {
  if (!['text', 'script'].includes(String(status.value?.resultType || '').toLowerCase())) return ''
  return status.value?.resultSummary || resultReferencesText.value || status.value?.promptText || ''
})
const hasTextResultPreview = computed(() => (isSuccess.value || isFailed.value) && Boolean(textResultPreview.value))
const actionErrorText = computed(() => {
  if (!isSuccess.value) return ''
  return status.value?.actionError || ''
})

const resultPreviewType = computed(() => {
  const type = String(status.value?.resultType || '').toLowerCase()
  if (['image', 'video', 'audio'].includes(type)) return type
  const url = String(effectiveResultUrl.value).toLowerCase()
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/.test(url)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/.test(url)) return 'audio'
  return 'image'
})

const retryLabel = computed(() => status.value?.retryLabel || '重试')
const canAttachImage = computed(() => isSuccess.value && effectiveResultUrl.value && resultPreviewType.value === 'image' && Boolean(resultStoryboardId(runtimeNode())))
const canAttachVideo = computed(() => isSuccess.value && effectiveResultUrl.value && resultPreviewType.value === 'video' && Boolean(resultStoryboardId(runtimeNode())))
const canAttachAudio = computed(() => isSuccess.value && resultPreviewType.value === 'audio' && Boolean(resultUrl()) && Boolean(resultStoryboardId(runtimeNode())))
const hasReusableResultReference = computed(() => Boolean(effectiveResultUrl.value || textResultPreview.value || resultReferences.value.length))
const canUseResultAsDownstreamReference = computed(() => (isSuccess.value || isFailed.value) && hasReusableResultReference.value && Boolean(ctx?.useNodeResultAsDownstreamReference))
const statusSavedAsset = computed(() => {
  if (!status.value?.savedAssetId) return null
  return {
    id: status.value.savedAssetId,
    name: status.value.savedAssetName || '素材',
    url: status.value.savedAssetUrl || status.value.resultUrl || '',
    local_path: status.value.savedAssetLocalPath || '',
    duration: status.value.savedAssetDuration ?? undefined,
  }
})
const effectiveSavedAsset = computed(() => savedAsset.value || statusSavedAsset.value)
const effectiveResultUrl = computed(() => assetMediaUrl(effectiveSavedAsset.value) || status.value?.resultUrl || '')
const resultNodeId = computed(() => status.value?.resultNodeId || '')
const hasResultPreview = computed(() => Boolean(effectiveResultUrl.value) && (isSuccess.value || isFailed.value))

const statusTitle = computed(() => {
  const parts = [stepLabel.value, status.value?.message, status.value?.detail, metaText.value, resultText.value, failedResultText.value, assetResultText.value, generationAuditText.value, upstreamReferenceText.value, effectiveResultUrl.value].filter(Boolean)
  return parts.join('\n')
})

function openResult() {
  if (!effectiveResultUrl.value) return
  window.open(effectiveResultUrl.value, '_blank', 'noopener,noreferrer')
}

function resultFilename() {
  const type = resultPreviewType.value
  const extensionMap = { image: 'png', video: 'mp4', audio: 'mp3' }
  const rawName = String(effectiveResultUrl.value).split(/[?#]/)[0].split('/').pop()
  return rawName || `canvas-node-result.${extensionMap[type] || 'dat'}`
}

function downloadResult() {
  if (!effectiveResultUrl.value) return
  const link = document.createElement('a')
  link.href = effectiveResultUrl.value
  link.download = resultFilename()
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
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

function copyPrompt() {
  copyText(status.value?.promptText || '', '提示词已复制', '提示词（请手动复制）')
}

function copyResultLink() {
  copyText(effectiveResultUrl.value, '结果链接已复制', '结果链接（请手动复制）')
}

function copyResultReferences() {
  copyText(resultReferencesText.value, '结果引用已复制', '结果引用（请手动复制）')
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
  await ctx?.focusCanvasNode?.(resultNodeId.value)
}

function copyUpstreamReferences() {
  copyText(upstreamReferenceUrls.value.join('\n'), '上游引用已复制', '上游引用（请手动复制）')
}

function copyRequestPayload() {
  copyText(requestPayloadText.value, '真实请求已复制', '真实请求（请手动复制）')
}

function copyAssetReference() {
  const asset = effectiveSavedAsset.value
  if (!asset) return
  const name = asset.name || '素材'
  const url = asset.url || status.value?.resultUrl || ''
  const reference = `@素材(${name}#${asset.id}) ${url}`.trim()
  copyText(reference, '素材引用已复制', '素材引用（请手动复制）')
}

function viewSavedAsset() {
  const asset = effectiveSavedAsset.value
  if (!asset?.id) return
  router.push({
    name: 'media-library',
    query: {
      assetId: String(asset.id),
      type: resultPreviewType.value,
    },
  })
}

function copyError() {
  copyText(status.value?.errorDetail || status.value?.message || '', '失败原因已复制', '失败原因（请手动复制）')
}

function dismissStatus() {
  ctx?.nodeStatus?.clear?.(props.nodeId)
}

function runtimeNode() {
  return ctx?.findCanvasNode?.(props.nodeId) || { id: props.nodeId, data: {} }
}

function resultAssetName(node) {
  const label = node?.data?.label || node?.data?.title || status.value?.resultLabel || '节点结果'
  return `${label}-${resultFilename()}`
}

function resultLocalPath() {
  if (status.value?.savedAssetLocalPath) return status.value.savedAssetLocalPath
  const asset = effectiveSavedAsset.value
  const url = String(asset?.local_path ? `/static/${asset.local_path}` : (status.value?.resultUrl || ''))
  const marker = '/static/'
  const index = url.indexOf(marker)
  if (index < 0) return null
  return url.slice(index + marker.length).split(/[?#]/)[0] || null
}

function resultStoryboardId(node) {
  return Number(status.value?.storyboardId || node?.data?.storyboard?.id || storyboardIdFromNodeId(props.nodeId)) || null
}

function resultUrl() {
  return effectiveResultUrl.value
}

async function refreshCanvasAfterAttach() {
  if (ctx?.refresh) await ctx.refresh()
  else await ctx?.refreshDrama?.(true)
}

function markAttachSuccess(message, extra = {}) {
  const storyboardId = resultStoryboardId(runtimeNode())
  ctx?.nodeStatus?.success?.(props.nodeId, {
    ...status.value,
    message,
    attachedToStoryboardId: storyboardId,
    attachedResultUrl: resultUrl(),
    attachedResultLocalPath: resultLocalPath(),
    attachedResultType: resultPreviewType.value,
    actionError: '',
    retryAction: '',
    retryActionLabel: '',
    autoClear: false,
    ...extra,
  })
}

function markActionFailure(message, retryActionName, retryActionLabel) {
  const text = message || '结果操作失败'
  const update = isFailed.value ? ctx?.nodeStatus?.fail : ctx?.nodeStatus?.success
  update?.(props.nodeId, {
    ...status.value,
    message: status.value?.message || (isFailed.value ? '节点执行失败' : '节点执行完成'),
    actionError: text,
    retryAction: retryActionName,
    retryActionLabel,
    autoClear: false,
  })
}

async function saveResultAsset() {
  if (!status.value?.resultUrl || savingAsset.value) return
  const node = runtimeNode()
  const dramaId = Number(status.value?.dramaId || ctx?.drama?.value?.id || node?.data?.dramaId)
  if (!Number.isFinite(dramaId) || dramaId <= 0) {
    ElMessage.warning('缺少项目 ID，无法存入素材库')
    return
  }
  savingAsset.value = true
  try {
    const asset = await assetsAPI.create({
      drama_id: dramaId,
      storyboard_id: resultStoryboardId(node),
      name: resultAssetName(node),
      type: resultPreviewType.value,
      category: 'canvas-result',
      url: status.value.resultUrl,
      local_path: resultLocalPath(),
      metadata: {
        source: 'canvas_node_result',
        canvas_node_id: props.nodeId,
        result_label: status.value?.resultLabel || '',
        prompt_text: status.value?.promptText || '',
        model: status.value?.model || '',
        task_id: status.value?.taskId || '',
        video_generation_id: status.value?.videoGenerationId || '',
        request_payload: status.value?.requestPayload || null,
        request_audit: status.value?.requestAudit || null,
      },
    })
    const normalizedAsset = asset ? {
      id: asset.id,
      name: asset.name || resultAssetName(node),
      url: asset.url || status.value.resultUrl || '',
      local_path: asset.local_path || '',
      duration: asset.duration ?? null,
    } : null
    savedAsset.value = normalizedAsset
    if (normalizedAsset) {
      ctx?.nodeStatus?.success?.(props.nodeId, {
        ...status.value,
        savedAssetId: normalizedAsset.id,
        savedAssetName: normalizedAsset.name,
        savedAssetUrl: normalizedAsset.url,
        savedAssetLocalPath: normalizedAsset.local_path,
        savedAssetDuration: normalizedAsset.duration,
        actionError: '',
        retryAction: '',
        retryActionLabel: '',
        autoClear: false,
      })
    }
    ElMessage.success('结果已存入素材库')
    if (ctx?.refreshProjectAssets) await ctx.refreshProjectAssets()
    else await ctx?.refreshDrama?.(true)
  } catch (error) {
    const message = error?.message || '存入素材库失败'
    ElMessage.error(message)
    markActionFailure(message, 'save_result_asset', '重试存入素材库')
  } finally {
    savingAsset.value = false
  }
}

async function attachImageResult(slot = 'main') {
  const node = runtimeNode()
  const storyboardId = resultStoryboardId(node)
  const dramaId = Number(status.value?.dramaId || ctx?.drama?.value?.id || node?.data?.dramaId)
  if (!storyboardId || !Number.isFinite(dramaId) || dramaId <= 0 || attachingResult.value) return
  attachingResult.value = true
  try {
    await imagesAPI.upload({
      storyboard_id: storyboardId,
      drama_id: dramaId,
      image_url: resultUrl(),
      local_path: resultLocalPath() || undefined,
      frame_type: slot === 'first' ? 'storyboard_first' : slot === 'last' ? 'storyboard_last' : undefined,
    })
    ElMessage.success(slot === 'first' ? '已设为首帧' : slot === 'last' ? '已设为尾帧' : '已设为本镜图')
    markAttachSuccess(slot === 'first' ? '已设为首帧' : slot === 'last' ? '已设为尾帧' : '已设为本镜图', {
      attachedSlot: slot,
      resultType: 'image',
    })
    await refreshCanvasAfterAttach()
  } catch (error) {
    const message = error?.message || '图片挂载失败'
    ElMessage.error(message)
    markActionFailure(message, `attach_image_${slot}`, slot === 'first' ? '重试设为首帧' : slot === 'last' ? '重试设为尾帧' : '重试设为本镜图')
  } finally {
    attachingResult.value = false
  }
}

async function attachVideoResult() {
  const node = runtimeNode()
  const storyboardId = resultStoryboardId(node)
  const dramaId = Number(status.value?.dramaId || ctx?.drama?.value?.id || node?.data?.dramaId)
  if (!storyboardId || !Number.isFinite(dramaId) || dramaId <= 0 || attachingResult.value) return
  attachingResult.value = true
  try {
    await videosAPI.attach({
      storyboard_id: storyboardId,
      drama_id: dramaId,
      video_url: resultUrl(),
      local_path: resultLocalPath() || undefined,
      duration: effectiveSavedAsset.value?.duration ?? undefined,
    })
    ElMessage.success('已设为本镜视频')
    markAttachSuccess('已设为本镜视频', {
      attachedSlot: 'video',
      resultType: 'video',
    })
    await refreshCanvasAfterAttach()
  } catch (error) {
    const message = error?.message || '视频挂载失败'
    ElMessage.error(message)
    markActionFailure(message, 'attach_video', '重试设为本镜视频')
  } finally {
    attachingResult.value = false
  }
}

async function attachAudioResult() {
  const storyboardId = resultStoryboardId(runtimeNode())
  const localPath = resultLocalPath()
  const audioUrl = resultUrl()
  if (!storyboardId || !audioUrl || attachingResult.value) return
  attachingResult.value = true
  try {
    await storyboardsAPI.update(storyboardId, {
      audio_local_path: localPath || undefined,
      audio_url: localPath ? undefined : audioUrl,
    })
    ElMessage.success('已设为本镜音频')
    markAttachSuccess('已设为本镜音频', {
      attachedSlot: 'audio',
      resultType: 'audio',
    })
    await refreshCanvasAfterAttach()
  } catch (error) {
    const message = error?.message || '音频挂载失败'
    ElMessage.error(message)
    markActionFailure(message, 'attach_audio', '重试设为本镜音频')
  } finally {
    attachingResult.value = false
  }
}

async function useResultAsDownstreamReference() {
  if (!canUseResultAsDownstreamReference.value || attachingResult.value) return
  attachingResult.value = true
  try {
    await ctx.useNodeResultAsDownstreamReference(runtimeNode(), {
      resultUrl: resultUrl(),
      resultType: resultPreviewType.value,
      savedAssetId: effectiveSavedAsset.value?.id || status.value?.savedAssetId || '',
      resultSummary: status.value?.resultSummary || '',
      resultReferences: resultReferences.value,
    })
    ctx?.nodeStatus?.success?.(props.nodeId, {
      ...status.value,
      actionError: '',
      retryAction: '',
      retryActionLabel: '',
      autoClear: false,
    })
  } catch (error) {
    const message = error?.message || '作为下游参考失败'
    ElMessage.error(message)
    markActionFailure(message, 'use_downstream_reference', '重试作为下游参考')
  } finally {
    attachingResult.value = false
  }
}

async function retryAction() {
  const action = status.value?.retryAction
  if (action === 'save_result_asset') return saveResultAsset()
  if (action === 'attach_image_main') return attachImageResult('main')
  if (action === 'attach_image_first') return attachImageResult('first')
  if (action === 'attach_image_last') return attachImageResult('last')
  if (action === 'attach_library_image') return attachImageResult(libraryImageRetrySlot())
  if (action === 'attach_video') return attachVideoResult()
  if (action === 'attach_library_video') return attachVideoResult()
  if (action === 'attach_audio') return attachAudioResult()
  if (action === 'attach_library_audio') return attachAudioResult()
  if (action === 'use_downstream_reference') return useResultAsDownstreamReference()
}

function libraryImageRetrySlot() {
  const slot = String(status.value?.attachedSlot || '').trim()
  return ['first', 'last', 'main'].includes(slot) ? slot : 'main'
}

async function runNextStep() {
  const step = status.value?.nextStep
  if (!step) return
  ctx?.nodeStatus?.clear?.(props.nodeId)
  await ctx?.runNodeStep?.(runtimeNode(), step)
}

async function retryFailed() {
  const step = status.value?.retryStep
  if (!step) return
  ctx?.nodeStatus?.clear?.(props.nodeId)
  await ctx?.runNodeStep?.(runtimeNode(), step)
}

watch(status, (value) => {
  savedAsset.value = null
  attachingResult.value = false
  if (value && !timer) {
    now.value = Date.now()
    timer = setInterval(() => {
      now.value = Date.now()
    }, 1000)
  } else if (!value && timer) {
    clearInterval(timer)
    timer = null
  }
}, { immediate: true })

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.node-status-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(9, 9, 11, 0.72);
  border-radius: inherit;
  box-sizing: border-box;
  overflow: hidden;
  padding: 8px;
  pointer-events: none;
}
.spinner {
  width: 22px;
  height: 22px;
  border: 2px solid rgba(255, 255, 255, 0.15);
  border-top-color: #818cf8;
  border-radius: 50%;
  animation: spin 0.75s linear infinite;
}
.step-ref_image .spinner { border-top-color: #34d399; }
.step-extract_chars .spinner,
.step-extract_scenes .spinner,
.step-extract_props .spinner,
.step-extract_all .spinner,
.step-save_script .spinner { border-top-color: #fbbf24; }
.step-video .spinner { border-top-color: #f472b6; }
.step-audio .spinner { border-top-color: #fbbf24; }
.step-failed { background: rgba(127, 29, 29, 0.82); }
.step-success { background: rgba(6, 78, 59, 0.82); }
.error-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 2px solid #fca5a5;
  border-radius: 50%;
  color: #fee2e2;
  font-weight: 700;
}
.success-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 2px solid #86efac;
  border-radius: 50%;
  color: #dcfce7;
  font-weight: 700;
}
.step-label {
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(129, 140, 248, 0.2);
  color: #c7d2fe;
  font-size: 9px;
  line-height: 1;
}
.step-failed .step-label {
  background: rgba(254, 202, 202, 0.16);
  color: #fee2e2;
}
.step-success .step-label {
  background: rgba(187, 247, 208, 0.16);
  color: #dcfce7;
}
.msg {
  font-size: 10px;
  color: #e4e4e7;
  text-align: center;
  padding: 0 8px;
  line-height: 1.3;
}
.meta,
.result-text,
.failed-result-text,
.asset-result-text,
.generation-audit,
.reference-text,
.action-error,
.failed-hint {
  max-width: calc(100% - 18px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9px;
  color: #a1a1aa;
}
.result-text {
  color: #bbf7d0;
}
.failed-result-text {
  color: #fed7aa;
}
.asset-result-text {
  color: #a7f3d0;
}
.reference-text {
  color: #c7d2fe;
}
.generation-audit {
  color: #fde68a;
}
.action-error {
  color: #fecaca;
}
.result-preview {
  width: min(84%, 220px);
  max-height: 120px;
  pointer-events: auto;
}
.result-preview img,
.result-preview video {
  display: block;
  width: 100%;
  max-height: 120px;
  object-fit: contain;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
}
.result-preview audio {
  width: 100%;
  height: 28px;
}
.result-text-preview {
  max-height: 96px;
  overflow: auto;
  padding: 8px;
  border: 1px solid rgba(187, 247, 208, 0.18);
  border-radius: 8px;
  background: rgba(3, 7, 18, 0.55);
}
.result-text-preview p {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: #dcfce7;
  font-size: 10px;
  line-height: 1.45;
}
.success-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
  max-width: calc(100% - 14px);
  pointer-events: auto;
}
.failed-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
  max-width: calc(100% - 14px);
  pointer-events: auto;
}
.action-group {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 3px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  background: rgba(24, 24, 27, 0.38);
}
.action-group-asset {
  background: rgba(6, 78, 59, 0.26);
  border-color: rgba(134, 239, 172, 0.26);
}
.action-group-attach {
  background: rgba(37, 99, 235, 0.18);
  border-color: rgba(96, 165, 250, 0.32);
}
.action-group-flow {
  background: rgba(76, 29, 149, 0.18);
  border-color: rgba(167, 139, 250, 0.32);
}
.success-actions button,
.failed-actions button {
  padding: 3px 7px;
  border: 1px solid rgba(187, 247, 208, 0.45);
  border-radius: 999px;
  background: rgba(6, 95, 70, 0.72);
  color: #dcfce7;
  font-size: 9px;
  white-space: nowrap;
  cursor: pointer;
}
.success-actions button:disabled,
.failed-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.failed-actions button {
  border-color: rgba(254, 202, 202, 0.45);
  background: rgba(127, 29, 29, 0.72);
  color: #fee2e2;
}
.success-actions button:hover,
.failed-actions button:hover {
  border-color: rgba(187, 247, 208, 0.85);
  background: rgba(5, 150, 105, 0.78);
}
.failed-actions button:hover {
  border-color: rgba(254, 202, 202, 0.85);
  background: rgba(185, 28, 28, 0.78);
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
