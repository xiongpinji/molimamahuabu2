<template>
  <div v-if="status" class="node-status-overlay" :class="'step-' + status.step" :title="statusTitle">
    <span v-if="isFailed" class="error-mark">!</span>
    <span v-else-if="isSuccess" class="success-mark">✓</span>
    <span v-else class="spinner" />
    <span class="step-label">{{ stepLabel }}</span>
    <span class="msg">{{ status.message }}</span>
    <span v-if="metaText" class="meta">{{ metaText }}</span>
    <span v-if="resultText" class="result-text">{{ resultText }}</span>
    <span v-if="isFailed" class="failed-hint">右键节点可重试</span>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useCanvasContext } from '@/composables/useCanvasContext'

const props = defineProps({
  nodeId: { type: String, required: true },
})

const ctx = useCanvasContext()
const now = ref(Date.now())
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

const statusTitle = computed(() => {
  const parts = [stepLabel.value, status.value?.message, status.value?.detail, metaText.value, resultText.value, status.value?.resultUrl].filter(Boolean)
  return parts.join('\n')
})

watch(status, (value) => {
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
.failed-hint {
  color: #fecaca;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
