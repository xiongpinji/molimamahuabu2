<template>
  <section class="redraw-source-step">
    <div v-if="!['analysis_review', 'localizing', 'localization_needs_attention', 'failed'].includes(workflowPhase)" class="source-card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">01 · 源片输入</p>
          <h2>上传源片并锁定转绘基础设置</h2>
        </div>
        <el-tag v-if="workState?.id">作品 {{ workState.id }}</el-tag>
      </div>

      <div class="source-grid">
        <label class="field">
          <span>源片文件</span>
          <input
            ref="fileInput"
            type="file"
            accept=".mp4,.mov,.zip,video/mp4,video/quicktime,application/zip"
            @change="onFileChange"
          />
          <small>支持 MP4、MOV 或 ZIP 批量源片</small>
          <el-button
            v-if="!workState?.id"
            :loading="uploading"
            :disabled="!selectedFile"
            @click="uploadSource"
          >
            上传源片
          </el-button>
        </label>
        <label class="field">
          <span>语言 / 地区</span>
          <div class="inline-fields">
            <el-select v-model="locale" placeholder="语言">
              <el-option
                v-for="item in localeOptions"
                :key="`${item.locale}-${item.market}`"
                :label="item.locale"
                :value="item.locale"
              />
            </el-select>
            <el-select v-model="market" placeholder="地区">
              <el-option
                v-for="item in localeOptions"
                :key="`${item.locale}-${item.market}-market`"
                :label="item.market || '默认地区'"
                :value="item.market || ''"
              />
            </el-select>
          </div>
        </label>
        <label class="field">
          <span>输出比例</span>
          <el-segmented v-model="aspectRatio" :options="aspectRatioOptions" />
        </label>
      </div>

      <StylePresetPicker
        v-model:selected-preset="selectedPreset"
        v-model:free-style="freeStyle"
        :presets="stylePresets"
      />

      <div class="billing-row">
        <strong v-if="hasValidQuote" class="canvas-credit-callout-v1">本次预计扣除 {{ estimateCredits }} 积分</strong>
        <strong v-else class="canvas-credit-callout-v1">积分待管理员配置</strong>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!canStartAnalysis"
          @click="startAnalysis"
        >
          开始分析
        </el-button>
      </div>
    </div>

    <section v-if="taskState.task_id || workState?.task_id" class="task-card">
      <div>
        <strong>分析任务 {{ taskState.task_id || workState?.task_id }}</strong>
        <span>{{ taskState.status || workState?.status || 'processing' }}</span>
      </div>
      <el-progress :percentage="taskState.progress" :stroke-width="6" color="#ff7139" />
    </section>

    <section v-if="workflowPhase === 'analysis_review'" class="task-card">
      <div>
        <strong>服务端分析摘要</strong>
        <span>{{ workState?.analysis_task?.status || taskState.status || 'completed' }}</span>
      </div>
      <p>{{ workState?.analysis_summary || workState?.analysis_task?.message || '分析已完成，请确认后创建英文 1:1 本地化版本。' }}</p>
      <div class="billing-row">
        <strong v-if="hasLocalizationQuote" class="canvas-credit-callout-v1">本地化报价 {{ localizationCredits }} 积分</strong>
        <strong v-else class="canvas-credit-callout-v1">本地化报价待管理员配置</strong>
        <el-button
          type="primary"
          :loading="localizationSubmitting"
          :disabled="!canSubmitLocalization"
          @click="confirmLocalization"
        >
          确认英文 1:1 本地化
        </el-button>
      </div>
    </section>

    <section v-if="workflowPhase === 'localizing'" class="task-card">
      <div>
        <strong>本地化任务 {{ localizationState.task_id }}</strong>
        <span>{{ localizationState.status || 'processing' }}</span>
      </div>
      <el-progress :percentage="localizationState.progress" :stroke-width="6" color="#4c9ffe" />
      <p>请勿重复提交</p>
    </section>

    <section v-if="['localization_needs_attention', 'failed'].includes(workflowPhase)" class="task-card">
      <div>
        <strong>本地化失败</strong>
        <span>{{ localizationState.status || 'failed' }}</span>
      </div>
      <p>{{ localizationState.message || workState?.localization_error || '服务端错误' }}</p>
      <p v-if="!canSubmitLocalization">等待退款确认</p>
      <div class="billing-row">
        <strong v-if="hasLocalizationQuote" class="canvas-credit-callout-v1">本地化报价 {{ localizationCredits }} 积分</strong>
        <strong v-else class="canvas-credit-callout-v1">本地化报价待管理员配置</strong>
        <el-button
          type="primary"
          :loading="localizationSubmitting"
          :disabled="!canSubmitLocalization"
          @click="confirmLocalization"
        >
          重试英文 1:1 本地化
        </el-button>
      </div>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { redrawAPI } from '@/api/redraw'
import StylePresetPicker from '@/components/redraw/StylePresetPicker.vue'
import {
  analysisQuoteCredits,
  buildAnalyzePayload,
  buildLocalizationPayload,
  canConfirmLocalization,
  canStartRedrawAnalysis,
  localizationQuoteCredits,
  localizationTaskState,
  createLocalizationQuoteRequestGate,
  localizationQuoteRequestKey,
  redrawWorkflowPhase,
  shouldResetLocalizationIdempotencyKey,
  taskStateFromWork,
} from '@/utils/redrawWorkspaceState'

const props = defineProps({
  projectId: {
    type: [String, Number],
    required: true,
  },
  initialWork: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['work-updated'])

const fileInput = ref(null)
const selectedFile = ref(null)
const locale = ref('')
const market = ref('')
const aspectRatio = ref('16:9')
const stylePresets = ref([])
const localeOptions = ref([])
const selectedPreset = ref(null)
const freeStyle = ref({})
const workState = ref(props.initialWork)
const uploading = ref(false)
const submitting = ref(false)
const localizationSubmitting = ref(false)
const taskState = ref({ task_id: '', status: '', progress: 0 })
const localizationState = ref(localizationTaskState(props.initialWork))
const workflowPhase = ref(redrawWorkflowPhase(props.initialWork))
const localizationIdempotencyKey = ref('')
const localizationQuoteGate = createLocalizationQuoteRequestGate()
const latestLocalizationQuoteKey = ref('')
let pollTimer = null
let pollAttempts = 0

const aspectRatioOptions = ['1:1', '9:16', '16:9', '3:4', '4:3', '21:9']
const estimateCredits = computed(() => analysisQuoteCredits(workState.value))
const hasValidQuote = computed(() => estimateCredits.value != null)
const localizationCredits = computed(() => localizationQuoteCredits(workState.value))
const hasLocalizationQuote = computed(() => localizationCredits.value != null)
const canStartAnalysis = computed(() => canStartRedrawAnalysis({
  work: workState.value,
  selectedFile: selectedFile.value,
  locales: localeOptions.value,
  selectedPreset: selectedPreset.value,
  freeStyle: freeStyle.value,
}))
const canSubmitLocalization = computed(() => canConfirmLocalization(workState.value))

function onFileChange(event) {
  selectedFile.value = event.target.files?.[0] || null
}

function localizationQuoteBody() {
  return {
    locale: locale.value || 'en-US',
    market: market.value || 'US',
    localization_level: 'faithful',
  }
}

function localizationQuoteRequest(work) {
  const body = localizationQuoteBody()
  return {
    workId: work?.id,
    locale: body.locale,
    market: body.market,
    localizationLevel: body.localization_level,
    body,
  }
}

function isTerminalTaskState(work) {
  const phase = redrawWorkflowPhase(work)
  const analysisStatus = String(work?.analysis_task?.status || work?.task_status || work?.status || '').toLowerCase()
  const localizationStatus = String(work?.localization_task?.status || '').toLowerCase()
  if (phase === 'localizing') return false
  if (['pending', 'processing', 'analyzing'].includes(analysisStatus)) return false
  if (['pending', 'processing', 'localizing'].includes(localizationStatus)) return false
  return ['analysis_review', 'localization_needs_attention', 'failed', 'assets'].includes(phase)
    || ['completed', 'failed', 'needs_attention', 'cancelled', 'canceled'].includes(analysisStatus)
    || ['completed', 'failed', 'needs_attention', 'cancelled', 'canceled'].includes(localizationStatus)
}

function shouldPollWork(work) {
  const analysisStatus = String(work?.analysis_task?.status || work?.task_status || work?.status || '').toLowerCase()
  const localizationStatus = String(work?.localization_task?.status || '').toLowerCase()
  return Boolean(
    work?.id
      && (
        ['pending', 'processing', 'analyzing'].includes(analysisStatus)
          || ['pending', 'processing', 'localizing'].includes(localizationStatus)
          || redrawWorkflowPhase(work) === 'localizing'
      )
      && !isTerminalTaskState(work),
  )
}

function stopTaskPolling() {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

function startTaskPolling() {
  if (pollTimer || !shouldPollWork(workState.value)) return
  pollAttempts = 0
  pollTimer = setInterval(async () => {
    pollAttempts += 1
    if (pollAttempts > 120 || !shouldPollWork(workState.value)) {
      stopTaskPolling()
      return
    }
    try {
      await refreshWork()
    } catch (_) {
      stopTaskPolling()
    }
  }, 2000)
}

function syncWork(next) {
  workState.value = next
  workflowPhase.value = redrawWorkflowPhase(next)
  taskState.value = taskStateFromWork(next)
  localizationState.value = localizationTaskState(next)
  if (shouldResetLocalizationIdempotencyKey(next)) {
    localizationIdempotencyKey.value = ''
  }
  if (shouldPollWork(next)) startTaskPolling()
  if (isTerminalTaskState(next)) stopTaskPolling()
  ensureLocalizationQuote(next)
}

async function loadCapabilities() {
  const [presets, locales] = await Promise.all([
    redrawAPI.listStylePresets(),
    redrawAPI.listLocales(),
  ])
  stylePresets.value = Array.isArray(presets) ? presets : []
  localeOptions.value = Array.isArray(locales) ? locales : []
  if (localeOptions.value.length) {
    locale.value = localeOptions.value[0].locale || ''
    market.value = localeOptions.value[0].market || ''
  }
}

async function refreshWork() {
  if (!workState.value?.id) return
  const fresh = await redrawAPI.getWork(workState.value.id)
  syncWork(fresh)
  emit('work-updated', fresh)
  return fresh
}

async function ensureLocalizationQuote(work = workState.value) {
  if (
    !work?.id
      || work?.localization_quote
      || !['analysis_review', 'localization_needs_attention', 'failed'].includes(redrawWorkflowPhase(work))
  ) {
    return
  }
  const quoteRequest = localizationQuoteRequest(work)
  if (!localizationQuoteGate.begin(quoteRequest)) return
  const requestKey = localizationQuoteRequestKey(quoteRequest)
  latestLocalizationQuoteKey.value = requestKey
  try {
    const quote = await redrawAPI.quoteLocalization(work.id, quoteRequest.body)
    if (workState.value?.id !== work.id || latestLocalizationQuoteKey.value !== requestKey) return
    workState.value = {
      ...workState.value,
      localization_quote: quote?.localization_quote || quote,
    }
  } catch (error) {
    ElMessage.error(error.message || '获取本地化报价失败')
  } finally {
    localizationQuoteGate.finish(quoteRequest)
  }
}

async function ensureWork() {
  if (workState.value?.id) return workState.value
  if (!selectedFile.value) throw new Error('请先上传源片文件')
  const result = await redrawAPI.createWorks(props.projectId, selectedFile.value)
  const created = result?.items?.[0]
  if (!created?.id) throw new Error('后端未返回转绘作品')
  syncWork(created)
  emit('work-updated', created)
  return created
}

async function uploadSource() {
  uploading.value = true
  try {
    await ensureWork()
  } catch (error) {
    ElMessage.error(error.message || '上传源片失败')
  } finally {
    uploading.value = false
  }
}

async function startAnalysis() {
  if (!canStartAnalysis.value) return
  submitting.value = true
  try {
    const work = await ensureWork()
    const result = await redrawAPI.analyzeWork(work.id, buildAnalyzePayload({
      locale: locale.value,
      market: market.value,
      aspectRatio: aspectRatio.value,
      selectedPreset: selectedPreset.value,
      freeStyle: freeStyle.value,
    }))
    taskState.value = {
      task_id: result.task_id,
      status: '',
      progress: 0,
      message: '',
    }
    await refreshWork()
    startTaskPolling()
    ElMessage.success('源片分析已提交')
  } catch (error) {
    ElMessage.error(error.message || '提交转绘分析失败')
  } finally {
    submitting.value = false
  }
}

async function confirmLocalization() {
  if (!canSubmitLocalization.value || localizationSubmitting.value) return
  localizationSubmitting.value = true
  try {
    const work = await ensureWork()
    const previousHash = String(workState.value?.localization_quote?.quote_hash || '').trim()
    const quote = await redrawAPI.quoteLocalization(work.id, localizationQuoteBody())
    const nextWork = {
      ...workState.value,
      localization_quote: quote?.localization_quote || quote,
    }
    syncWork(nextWork)
    const nextHash = String(nextWork.localization_quote?.quote_hash || '').trim()
    if (!canConfirmLocalization(nextWork, previousHash)) {
      ElMessage.warning('本地化报价已变化，请重新确认')
      return
    }
    if (!localizationIdempotencyKey.value) {
      localizationIdempotencyKey.value = crypto.randomUUID()
    }
    const result = await redrawAPI.createVersion(work.id, buildLocalizationPayload({
      locale: locale.value || 'en-US',
      market: market.value || 'US',
      localizationLevel: 'faithful',
      quoteHash: nextHash,
      idempotencyKey: localizationIdempotencyKey.value,
    }))
    localizationState.value = localizationTaskState({
      localization_task: {
        id: result?.task_id || result?.localization_task?.id,
        status: result?.status || result?.localization_task?.status || 'processing',
        progress: result?.progress || 0,
        message: result?.message || '',
      },
    })
    await refreshWork()
    startTaskPolling()
    ElMessage.success('英文 1:1 本地化已提交')
  } catch (error) {
    ElMessage.error(error.message || '提交英文 1:1 本地化失败')
  } finally {
    localizationSubmitting.value = false
  }
}

onMounted(async () => {
  await loadCapabilities()
  await refreshWork()
})

watch(() => props.initialWork, (next) => {
  workState.value = next
  workflowPhase.value = redrawWorkflowPhase(next)
  taskState.value = taskStateFromWork(next)
  localizationState.value = localizationTaskState(next)
  if (shouldPollWork(next)) startTaskPolling()
  if (isTerminalTaskState(next)) stopTaskPolling()
  ensureLocalizationQuote(next)
})

onUnmounted(() => {
  stopTaskPolling()
})
</script>

<style scoped>
.redraw-source-step {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.source-card,
.task-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
  box-sizing: border-box;
  max-width: 100%;
  min-width: 0;
  padding: 20px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  background: #151515;
}

.section-heading,
.billing-row,
.task-card > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.section-heading > div {
  min-width: 0;
}

.eyebrow {
  margin: 0 0 6px;
  color: #ff9a6d;
  font-size: 12px;
  font-weight: 700;
}

h2 {
  margin: 0;
  font-size: 20px;
  overflow-wrap: anywhere;
}

.source-grid {
  display: grid;
  grid-template-columns: minmax(240px, 1.2fr) minmax(240px, 1fr) 220px;
  gap: 14px;
  min-width: 0;
}

.field {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  color: #d8d8d8;
  font-size: 13px;
}

.field input[type="file"] {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 10px;
  border: 1px solid #333;
  border-radius: 6px;
  color: #d8d8d8;
  background: #101010;
}

.field small {
  color: #8d8d8d;
}

.inline-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  min-width: 0;
}

.inline-fields :deep(.el-select),
.field :deep(.el-segmented) {
  max-width: 100%;
  min-width: 0;
}

.canvas-credit-callout-v1 {
  color: #fff;
  font-size: 16px;
  font-weight: 800;
}

.task-card span {
  color: #a5a5a5;
}

@media (max-width: 920px) {
  .source-grid {
    grid-template-columns: 1fr;
  }

  .section-heading,
  .billing-row {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
