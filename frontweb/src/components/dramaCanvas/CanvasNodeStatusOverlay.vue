<template>
  <div v-if="status" class="node-status-overlay" :class="'step-' + status.step" :title="statusTitle">
    <span v-if="isFailed" class="error-mark">!</span>
    <span v-else-if="isSuccess" class="success-mark">✓</span>
    <span v-else class="spinner" />
    <span class="step-label">{{ stepLabel }}</span>
    <span class="msg">{{ status.message }}</span>
    <span v-if="metaText" class="meta">{{ metaText }}</span>
    <span v-if="resultText" class="result-text">{{ resultText }}</span>
    <div v-if="isSuccess && status.resultUrl" class="result-preview" :class="'result-' + resultPreviewType">
      <img v-if="resultPreviewType === 'image'" :src="status.resultUrl" alt="节点生成结果预览" />
      <video v-else-if="resultPreviewType === 'video'" :src="status.resultUrl" muted controls playsinline />
      <audio v-else-if="resultPreviewType === 'audio'" :src="status.resultUrl" controls />
    </div>
    <span v-if="isSuccess" class="success-actions">
      <button v-if="status.resultUrl" type="button" @click.stop="openResult">打开结果</button>
      <button v-if="status.resultUrl" type="button" @click.stop="copyResultLink">复制链接</button>
      <button v-if="status.resultUrl" type="button" @click.stop="downloadResult">下载结果</button>
      <button v-if="status.resultUrl" type="button" :disabled="savingAsset" @click.stop="saveResultAsset">
        {{ savingAsset ? '保存中…' : '存入素材库' }}
      </button>
      <button v-if="savedAsset" type="button" @click.stop="copyAssetReference">复制素材引用</button>
      <button v-if="canAttachImage" type="button" :disabled="attachingResult" @click.stop="attachImageResult('main')">设为本镜图</button>
      <button v-if="canAttachImage" type="button" :disabled="attachingResult" @click.stop="attachImageResult('first')">设为首帧</button>
      <button v-if="canAttachImage" type="button" :disabled="attachingResult" @click.stop="attachImageResult('last')">设为尾帧</button>
      <button v-if="canAttachVideo" type="button" :disabled="attachingResult" @click.stop="attachVideoResult">设为本镜视频</button>
      <button v-if="canAttachAudio" type="button" :disabled="attachingResult" @click.stop="attachAudioResult">设为本镜音频</button>
      <button v-if="status.promptText" type="button" @click.stop="copyPrompt">复制提示词</button>
      <button v-if="status.nextStep" type="button" @click.stop="runNextStep">{{ status.nextLabel || '继续下游' }}</button>
      <button type="button" @click.stop="dismissStatus">收起</button>
    </span>
    <span v-if="isFailed" class="failed-actions">
      <button v-if="status.errorDetail || status.message" type="button" @click.stop="copyError">复制原因</button>
      <button v-if="status.promptText" type="button" @click.stop="copyPrompt">复制提示词</button>
      <button v-if="status.retryStep" type="button" @click.stop="retryFailed">{{ retryLabel }}</button>
      <button type="button" @click.stop="dismissStatus">收起</button>
    </span>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { assetsAPI } from '@/api/assets'
import { imagesAPI } from '@/api/images'
import { storyboardsAPI } from '@/api/storyboards'
import { videosAPI } from '@/api/videos'
import { storyboardIdFromNodeId } from '@/utils/canvasWorkflow'

const props = defineProps({
  nodeId: { type: String, required: true },
})

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
  if (elapsedText.value) parts.push(`耗时 ${elapsedText.value}`)
  if (Number.isFinite(Number(status.value?.progress))) parts.push(`${Number(status.value.progress)}%`)
  if (status.value?.taskId) parts.push(`任务 ${status.value.taskId}`)
  return parts.join(' · ')
})

const resultText = computed(() => {
  if (!isSuccess.value) return ''
  const typeMap = { image: '图片已生成', video: '视频已生成', audio: '音频已生成' }
  const label = status.value?.resultLabel || typeMap[status.value?.resultType] || ''
  const urlHint = status.value?.resultUrl ? '可在节点卡片预览' : ''
  return [label, urlHint].filter(Boolean).join(' · ')
})

const resultPreviewType = computed(() => {
  const type = String(status.value?.resultType || '').toLowerCase()
  if (['image', 'video', 'audio'].includes(type)) return type
  const url = String(status.value?.resultUrl || '').toLowerCase()
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/.test(url)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/.test(url)) return 'audio'
  return 'image'
})

const retryLabel = computed(() => status.value?.retryLabel || '重试')
const canAttachImage = computed(() => isSuccess.value && status.value?.resultUrl && resultPreviewType.value === 'image' && Boolean(resultStoryboardId(runtimeNode())))
const canAttachVideo = computed(() => isSuccess.value && status.value?.resultUrl && resultPreviewType.value === 'video' && Boolean(resultStoryboardId(runtimeNode())))
const canAttachAudio = computed(() => isSuccess.value && resultPreviewType.value === 'audio' && Boolean(resultLocalPath()) && Boolean(resultStoryboardId(runtimeNode())))

const statusTitle = computed(() => {
  const parts = [stepLabel.value, status.value?.message, status.value?.detail, metaText.value, resultText.value, status.value?.resultUrl].filter(Boolean)
  return parts.join('\n')
})

function openResult() {
  if (!status.value?.resultUrl) return
  window.open(status.value.resultUrl, '_blank', 'noopener,noreferrer')
}

function resultFilename() {
  const type = resultPreviewType.value
  const extensionMap = { image: 'png', video: 'mp4', audio: 'mp3' }
  const rawName = String(status.value?.resultUrl || '').split(/[?#]/)[0].split('/').pop()
  return rawName || `canvas-node-result.${extensionMap[type] || 'dat'}`
}

function downloadResult() {
  if (!status.value?.resultUrl) return
  const link = document.createElement('a')
  link.href = status.value.resultUrl
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
  copyText(status.value?.resultUrl || '', '结果链接已复制', '结果链接（请手动复制）')
}

function copyAssetReference() {
  if (!savedAsset.value) return
  const name = savedAsset.value.name || '素材'
  const url = savedAsset.value.url || status.value?.resultUrl || ''
  const reference = `@素材(${name}#${savedAsset.value.id}) ${url}`.trim()
  copyText(reference, '素材引用已复制', '素材引用（请手动复制）')
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
  const url = String(savedAsset.value?.local_path ? `/static/${savedAsset.value.local_path}` : (status.value?.resultUrl || ''))
  const marker = '/static/'
  const index = url.indexOf(marker)
  if (index < 0) return null
  return url.slice(index + marker.length).split(/[?#]/)[0] || null
}

function resultStoryboardId(node) {
  return Number(status.value?.storyboardId || node?.data?.storyboard?.id || storyboardIdFromNodeId(props.nodeId)) || null
}

function resultUrl() {
  return savedAsset.value?.url || status.value?.resultUrl || ''
}

async function refreshCanvasAfterAttach() {
  if (ctx?.refresh) await ctx.refresh()
  else await ctx?.refreshDrama?.(true)
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
      },
    })
    savedAsset.value = asset || null
    ElMessage.success('结果已存入素材库')
    await ctx?.refreshDrama?.(true)
  } catch (error) {
    ElMessage.error(error?.message || '存入素材库失败')
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
    await refreshCanvasAfterAttach()
  } catch (error) {
    ElMessage.error(error?.message || '图片挂载失败')
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
      duration: savedAsset.value?.duration ?? undefined,
    })
    ElMessage.success('已设为本镜视频')
    await refreshCanvasAfterAttach()
  } catch (error) {
    ElMessage.error(error?.message || '视频挂载失败')
  } finally {
    attachingResult.value = false
  }
}

async function attachAudioResult() {
  const storyboardId = resultStoryboardId(runtimeNode())
  const localPath = resultLocalPath()
  if (!storyboardId || !localPath || attachingResult.value) return
  attachingResult.value = true
  try {
    await storyboardsAPI.update(storyboardId, { audio_local_path: localPath })
    ElMessage.success('已设为本镜音频')
    await refreshCanvasAfterAttach()
  } catch (error) {
    ElMessage.error(error?.message || '音频挂载失败')
  } finally {
    attachingResult.value = false
  }
}

async function runNextStep() {
  if (!status.value?.nextStep) return
  ctx?.nodeStatus?.clear?.(props.nodeId)
  await ctx?.runNodeStep?.(runtimeNode(), status.value.nextStep)
}

async function retryFailed() {
  if (!status.value?.retryStep) return
  ctx?.nodeStatus?.clear?.(props.nodeId)
  await ctx?.runNodeStep?.(runtimeNode(), status.value.retryStep)
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
.success-actions {
  display: flex;
  gap: 6px;
  pointer-events: auto;
}
.failed-actions {
  display: flex;
  gap: 6px;
  pointer-events: auto;
}
.success-actions button,
.failed-actions button {
  padding: 3px 7px;
  border: 1px solid rgba(187, 247, 208, 0.45);
  border-radius: 999px;
  background: rgba(6, 95, 70, 0.72);
  color: #dcfce7;
  font-size: 9px;
  cursor: pointer;
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
