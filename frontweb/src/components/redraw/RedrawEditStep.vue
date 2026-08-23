<template>
  <section class="redraw-edit-step">
    <header class="section-heading">
      <div>
        <p class="eyebrow">04 · 预览导出</p>
        <h2>英文配音、合成预览与下载</h2>
      </div>
      <el-tag>{{ statusLabel(worstStatus) }}</el-tag>
    </header>

    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />

    <RedrawEpisodeReleasePanel v-if="resolvedVersionId" :version-id="resolvedVersionId" />

    <div class="edit-layout">
      <aside class="edit-sidebar">
        <RedrawTimeline :shots="shots" :selected-shot-id="selectedShotId" @select="selectedShotId = $event" />
        <section class="dialogue-card">
          <h3>英文配音</h3>
          <p v-if="dialogueQuote?.priced" class="credit-callout">本次预计扣除 {{ dialogueQuote.credits || dialogueQuote.total_credits }} 积分</p>
          <p v-else class="muted">积分待管理员配置</p>
          <p v-if="dialogueTask">任务 {{ dialogueTask.id || dialogueTask.task_id }} · {{ statusLabel(dialogueTask.status) }}</p>
          <p v-if="dialogueTask?.status === 'failed' || dialogueTask?.status === 'needs_attention'" class="error-text">
            {{ dialogueTask.message || dialogueTask.error_message || 'failed / needs_attention' }}
          </p>
          <el-button :disabled="!canStartDialogue(dialogueQuote, dialogueTask)" :loading="dialogueStarting" title="使用服务端报价启动英文配音" @click="startDialogue">
            生成英文配音
          </el-button>
        </section>
        <section class="compose-card">
          <h3>合成</h3>
          <p v-if="compositionTask">任务 {{ compositionTask.id || compositionTask.task_id }} · {{ statusLabel(compositionTask.status) }}</p>
          <p v-if="compositionTask?.status === 'failed' || compositionTask?.status === 'needs_attention'" class="error-text">
            {{ compositionTask.message || compositionTask.error_message || 'failed / needs_attention' }}
          </p>
          <el-button :disabled="!canStartComposition(shots, dialogueTask, compositionTask)" :loading="composing" title="按固定源片顺序合成，音频 replace" @click="compose">
            合成成片
          </el-button>
        </section>
      </aside>

      <main class="edit-main">
        <RedrawPlayerCompare :source-url="sourceUrl" :exports="exportArtifacts" />
        <RedrawExportPanel v-if="resolvedVersionId" :exports="exportArtifacts" />
      </main>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { redrawAPI } from '@/api/redraw'
import {
  canStartComposition,
  canStartDialogue,
  expandExportArtifacts,
  normalizeTimelineShots,
  shouldPollTask,
  sourcePreviewUrl,
  statusLabel,
  worstShotStatus,
} from '@/utils/redrawTimelineState'
import RedrawTimeline from './RedrawTimeline.vue'
import RedrawPlayerCompare from './RedrawPlayerCompare.vue'
import RedrawExportPanel from './RedrawExportPanel.vue'
import RedrawEpisodeReleasePanel from './RedrawEpisodeReleasePanel.vue'

const props = defineProps({
  work: { type: Object, default: null },
  versionId: { type: [String, Number], default: null },
})
const emit = defineEmits(['work-updated'])

const localWork = ref(props.work)
const selectedShotId = ref(null)
const dialogueQuote = ref(null)
const dialogueTask = ref(null)
const compositionTask = ref(null)
const exports = ref([])
const exportRow = ref(null)
const loadError = ref('')
const dialogueStarting = ref(false)
const composing = ref(false)
let pollTimer = null

const resolvedVersionId = computed(() => props.versionId || localWork.value?.version_id || localWork.value?.current_version_id)
const shots = computed(() => normalizeTimelineShots(localWork.value?.shots || []))
const worstStatus = computed(() => worstShotStatus(shots.value))
const sourceUrl = computed(() => sourcePreviewUrl(shots.value, selectedShotId.value))
const exportArtifacts = computed(() => expandExportArtifacts(exportRow.value))

function idempotencyKey(prefix) {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${value}`
}

function errorReason(error, fallback) {
  return error?.response?.data?.error?.message || error?.message || fallback
}

async function refreshWork() {
  if (!localWork.value?.id) return
  const nextWork = await redrawAPI.getWork(localWork.value.id)
  localWork.value = nextWork
  emit('work-updated', nextWork)
}

async function loadDialogueQuote() {
  const versionId = resolvedVersionId.value
  if (!versionId) return
  dialogueQuote.value = await redrawAPI.quoteDialogue(versionId, {})
}

async function loadExports() {
  const versionId = resolvedVersionId.value
  if (!versionId) return
  const rows = await redrawAPI.listExports(versionId)
  exports.value = Array.isArray(rows) ? rows : []
  const targetId = compositionTask.value?.export_id || compositionTask.value?.exportId || exports.value[0]?.id
  const row = targetId ? exports.value.find((item) => String(item.id) === String(targetId)) : exports.value[0]
  exportRow.value = row?.id ? await redrawAPI.getExport(row.id) : null
  if (compositionTask.value && exportRow.value?.status) {
    compositionTask.value = {
      ...compositionTask.value,
      export_id: exportRow.value.id,
      status: exportRow.value.status,
      message: exportRow.value.error_message || compositionTask.value.message,
    }
  }
}

async function loadInitialState() {
  if (!resolvedVersionId.value) return
  try {
    await Promise.all([loadDialogueQuote(), loadExports()])
    selectedShotId.value = selectedShotId.value || shots.value[0]?.id || null
    loadError.value = ''
  } catch (error) {
    loadError.value = errorReason(error, '读取第四步状态失败')
  }
}

async function startDialogue() {
  const versionId = resolvedVersionId.value
  if (!versionId || !canStartDialogue(dialogueQuote.value, dialogueTask.value)) return
  dialogueStarting.value = true
  try {
    const result = await redrawAPI.startDialogue(versionId, { quote_hash: dialogueQuote.value.quote_hash, idempotency_key: idempotencyKey('dialogue') })
    dialogueTask.value = result?.task || result
    syncPolling()
  } catch (error) {
    loadError.value = errorReason(error, '启动英文配音失败')
  } finally {
    dialogueStarting.value = false
  }
}

const compositionIdempotencyKey = ref(idempotencyKey('compose'))

async function compose() {
  const versionId = resolvedVersionId.value
  if (!versionId || !canStartComposition(shots.value, dialogueTask.value, compositionTask.value)) return
  composing.value = true
  try {
    const result = await redrawAPI.composeVersion(versionId, { idempotency_key: compositionIdempotencyKey.value, audio_mode: 'replace' })
    const nextTask = result?.task || result
    compositionTask.value = {
      ...nextTask,
      export_id: result?.export_id || nextTask?.export_id || nextTask?.exportId,
    }
    syncPolling()
  } catch (error) {
    loadError.value = errorReason(error, '启动合成失败')
  } finally {
    composing.value = false
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

function syncPolling() {
  if (!shouldPollTask(dialogueTask.value) && !shouldPollTask(compositionTask.value)) {
    stopPolling()
    return
  }
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    const versionId = resolvedVersionId.value
    if (!versionId) return
    try {
      if (shouldPollTask(dialogueTask.value)) {
        const taskId = dialogueTask.value.id || dialogueTask.value.task_id
        dialogueTask.value = await redrawAPI.getDialogueTask(versionId, taskId)
      }
      if (shouldPollTask(compositionTask.value)) {
        await refreshWork()
        await loadExports()
      }
      syncPolling()
    } catch (error) {
      loadError.value = errorReason(error, '刷新第四步任务失败')
      stopPolling()
    }
  }, 2500)
}

watch(() => props.work, (nextWork) => {
  localWork.value = nextWork
  selectedShotId.value = selectedShotId.value || shots.value[0]?.id || null
}, { immediate: true })
watch(resolvedVersionId, loadInitialState)

onMounted(loadInitialState)
onBeforeUnmount(stopPolling)
</script>

<style scoped>
.redraw-edit-step {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.section-heading > div {
  min-width: 0;
}

.eyebrow {
  margin: 0 0 5px;
  color: #ff9a6d;
  font-size: 12px;
  font-weight: 800;
}

h2,
h3 {
  margin: 0;
  overflow-wrap: anywhere;
}

h2 {
  font-size: 20px;
}

h3 {
  font-size: 16px;
}

.edit-layout {
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: 14px;
  min-width: 0;
}

.edit-sidebar,
.edit-main {
  display: grid;
  align-content: start;
  gap: 14px;
  min-width: 0;
}

.dialogue-card,
.compose-card {
  display: grid;
  justify-items: start;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  background: #121212;
}

.credit-callout {
  margin: 0;
  color: #fff;
  font-weight: 800;
}

.muted {
  margin: 0;
  color: #999;
}

.error-text {
  margin: 0;
  color: #ff8585;
  overflow-wrap: anywhere;
}

@media (max-width: 1024px) {
  .edit-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 480px) {
  .section-heading {
    flex-direction: column;
  }
}
</style>
