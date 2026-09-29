<template>
  <section class="redraw-source-step">
    <div class="source-stage-strip" aria-label="八阶段状态">
      <span
        v-for="stage in eightStageState"
        :key="stage.key"
        :class="stage.status"
      >
        {{ stage.label }}
      </span>
    </div>

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
            <el-select
              v-model="locale"
              :placeholder="localeOptions.length ? '语言' : '暂无已验证语言'"
              :disabled="!localeOptions.length"
            >
              <el-option
                v-for="item in localeOptions"
                :key="`${item.locale}-${item.market}`"
                :label="item.locale"
                :value="item.locale"
              />
            </el-select>
            <el-select
              v-model="market"
              :placeholder="localeOptions.length ? '地区' : '暂无已验证地区'"
              :disabled="!localeOptions.length"
            >
              <el-option
                v-for="item in localeOptions"
                :key="`${item.locale}-${item.market}-market`"
                :label="item.market || '默认地区'"
                :value="item.market || ''"
              />
            </el-select>
          </div>
          <small v-if="!localeOptions.length" class="locale-capability-empty">
            暂无通过验收的语言/地区，请管理员完成语言能力校准后开放。
          </small>
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
      <small v-if="analysisLocked" class="analysis-locked-hint">
        该作品已完成样片分析，结果已锁定；如需重新分析，请新建作品重新上传样片。
      </small>
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
        <strong>用反推出的剧本、角色、场景、道具与分镜新建短剧工厂项目，后续资产与视频在短剧工厂里生成</strong>
        <el-button
          type="success"
          :loading="factoryImporting"
          @click="importToFactory"
        >
          导入短剧工厂
        </el-button>
      </div>
      <div v-if="fullLocalizationTargets.length" class="billing-row factory-localization-row">
        <strong>完全转绘：{{ localizationStatusText(fullLocalizationState, selectedFullLocalizationLabel) }}</strong>
        <span v-if="seriesLockText(fullLocalizationState)" class="factory-series-lock">{{ seriesLockText(fullLocalizationState) }}</span>
        <div class="factory-localization-actions">
          <el-select v-model="fullLocalizationKey" placeholder="选择目标语言与国家" :disabled="fullLocalizationBusy">
            <el-option v-for="item in fullLocalizationTargets" :key="item.key" :label="item.label" :value="item.key" />
          </el-select>
          <el-select
            v-if="seriesTargets.length"
            v-model="seriesTargetId"
            class="factory-series-select"
            placeholder="导入到"
            :disabled="fullLocalizationBusy"
            @change="seriesTargetTouched = true"
          >
            <el-option :value="0" label="新建短剧工厂项目" />
            <el-option v-for="item in seriesTargets" :key="item.drama_id" :label="seriesTargetLabel(item)" :value="item.drama_id" />
          </el-select>
          <strong
            v-if="fullLocalizationState.credits != null && fullLocalizationState.status !== 'ready'"
            class="canvas-credit-callout-v1"
          >本次预计扣除 {{ fullLocalizationState.credits }} 积分</strong>
          <el-button
            type="primary"
            :loading="fullLocalizationBusy"
            :disabled="!fullLocalizationKey || fullLocalizationState.status === 'localizing'"
            @click="runFullLocalization"
          >
            {{ localizationActionLabel(fullLocalizationState) }}
          </el-button>
        </div>
      </div>
      <div v-if="needsAnalysisReview" class="billing-row">
        <strong>安全模式：请人工确认分析结果后再进入本地化</strong>
        <el-button
          type="primary"
          :loading="analysisReviewSubmitting"
          @click="confirmAnalysisReview"
        >
          确认分析结果
        </el-button>
      </div>
      <div v-else-if="needsLocalizationReview" class="billing-row">
        <strong>本地化已完成（安全模式）：请核对译文后确认进入资产阶段</strong>
        <el-button
          type="primary"
          :loading="localizationReviewSubmitting"
          @click="confirmLocalizationReview"
        >
          确认本地化结果
        </el-button>
      </div>
      <div v-else class="billing-row">
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
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { redrawAPI } from '@/api/redraw'
import StylePresetPicker from '@/components/redraw/StylePresetPicker.vue'
import {
  defaultLocalizationTarget,
  defaultSeriesTarget,
  importSuccessMessage,
  localizationActionLabel,
  localizationBody,
  localizationStatusText,
  seriesLockText,
  seriesTargetLabel,
} from '@/utils/redrawFactoryLocalization'
import {
  analysisQuoteCredits,
  analysisReviewPending,
  localizationReviewPending,
  buildAnalyzePayload,
  buildLocalizationPayload,
  canConfirmLocalization,
  canStartRedrawAnalysis,
  createLocalizationConfirmationSnapshot,
  localizationQuoteCredits,
  localizationTaskState,
  createLocalizationQuoteRequestGate,
  isCurrentLocalizationConfirmation,
  redrawAnalysisLocked,
  redrawWorkflowPhase,
  resolveEightStageState,
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
  events: {
    type: Array,
    default: () => [],
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
const analysisReviewSubmitting = ref(false)
const factoryImporting = ref(false)
const router = useRouter()
const localizationReviewSubmitting = ref(false)
const taskState = ref({ task_id: '', status: '', progress: 0 })
const localizationState = ref(localizationTaskState(props.initialWork))
const workflowPhase = ref(redrawWorkflowPhase(props.initialWork))
const localizationIdempotencyKey = ref('')
const localizationQuoteGate = createLocalizationQuoteRequestGate()
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
const analysisLocked = computed(() => redrawAnalysisLocked(workState.value))
const canSubmitLocalization = computed(() => canConfirmLocalization(workState.value))
const needsAnalysisReview = computed(() => analysisReviewPending(workState.value))
const needsLocalizationReview = computed(() => localizationReviewPending(workState.value))
const eightStageState = computed(() => resolveEightStageState({
  ...(workState.value || {}),
  events: props.events,
}))

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
    // 分段分析最长约一小时（5 分钟样片约 15 段），轮询覆盖到这个时长。
    if (pollAttempts > 1800 || !shouldPollWork(workState.value)) {
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

async function importToFactory() {
  const work = workState.value
  if (!work?.id || factoryImporting.value) return
  factoryImporting.value = true
  try {
    const result = await redrawAPI.importToFactory(work.id)
    ElMessage.success(result?.created === false ? '已导入过，打开现有短剧工厂项目' : '已导入短剧工厂')
    if (result?.drama_id) await router.push(`/film/${result.drama_id}`)
  } catch (error) {
    ElMessage.error(error.message || '导入短剧工厂失败')
  } finally {
    factoryImporting.value = false
  }
}

// 完全转绘：选目标语言 + 国家 → 付费生成该国的名字、形象、台词与场景 → 轮询完成 → 导入短剧工厂。
const FULL_LOCALIZATION_POLL_MS = 5000
const FULL_LOCALIZATION_POLL_LIMIT = 240
const fullLocalizationTargets = ref([])
const fullLocalizationKey = ref('')
const fullLocalizationState = ref({ status: '', credits: null })
const fullLocalizationBusy = ref(false)
let fullLocalizationTimer = null
let fullLocalizationPolls = 0
const selectedFullLocalizationLabel = computed(() => fullLocalizationTargets.value
  .find((item) => item.key === fullLocalizationKey.value)?.label || '')
// 整部剧：同一部剧按同一目标国家导入过的短剧工厂项目，本集可追加为下一集（来自 status 的 series_targets）。
const seriesTargets = ref([])
const seriesTargetId = ref(0)
const seriesTargetTouched = ref(false)

function applySeriesTargets(state) {
  if (!Array.isArray(state?.series_targets)) return
  seriesTargets.value = state.series_targets
  const keep = seriesTargetTouched.value
    && (seriesTargetId.value === 0 || state.series_targets.some((item) => item.drama_id === seriesTargetId.value))
  if (!keep) seriesTargetId.value = defaultSeriesTarget(state.series_targets)
}

function stopFullLocalizationPolling() {
  if (fullLocalizationTimer) clearTimeout(fullLocalizationTimer)
  fullLocalizationTimer = null
}

async function loadFullLocalizationTargets() {
  const work = workState.value
  if (!work?.id || fullLocalizationTargets.value.length) return
  try {
    const result = await redrawAPI.factoryLocalization(work.id, { action: 'targets' })
    fullLocalizationTargets.value = Array.isArray(result?.targets) ? result.targets : []
    fullLocalizationKey.value = defaultLocalizationTarget(fullLocalizationTargets.value, result?.default_locale, result?.default_market)
  } catch (_) {
    fullLocalizationTargets.value = []
  }
}

async function refreshFullLocalizationStatus() {
  const body = localizationBody(fullLocalizationTargets.value, fullLocalizationKey.value, 'status')
  if (!workState.value?.id || !body) return null
  fullLocalizationState.value = await redrawAPI.factoryLocalization(workState.value.id, body)
  applySeriesTargets(fullLocalizationState.value)
  return fullLocalizationState.value
}

async function importFullLocalization() {
  const extra = seriesTargetId.value ? { target_drama_id: seriesTargetId.value } : {}
  const body = localizationBody(fullLocalizationTargets.value, fullLocalizationKey.value, 'import', extra)
  const result = await redrawAPI.factoryLocalization(workState.value.id, body)
  ElMessage.success(importSuccessMessage(result, selectedFullLocalizationLabel.value))
  if (result?.drama_id) await router.push(`/film/${result.drama_id}`)
}

function pollFullLocalization() {
  stopFullLocalizationPolling()
  fullLocalizationTimer = setTimeout(async () => {
    fullLocalizationPolls += 1
    try {
      const state = await refreshFullLocalizationStatus()
      if (state?.status === 'ready') {
        fullLocalizationBusy.value = true
        await importFullLocalization()
        fullLocalizationBusy.value = false
        return
      }
      if (state?.status === 'failed') {
        ElMessage.error(localizationStatusText(state))
        return
      }
    } catch (error) {
      ElMessage.error(error.message || '查询转绘进度失败')
    }
    if (fullLocalizationPolls < FULL_LOCALIZATION_POLL_LIMIT) pollFullLocalization()
  }, FULL_LOCALIZATION_POLL_MS)
}

async function runFullLocalization() {
  if (!workState.value?.id || fullLocalizationBusy.value) return
  fullLocalizationBusy.value = true
  try {
    const current = await refreshFullLocalizationStatus()
    if (current?.status === 'ready') {
      await importFullLocalization()
      return
    }
    const started = await redrawAPI.factoryLocalization(
      workState.value.id,
      localizationBody(fullLocalizationTargets.value, fullLocalizationKey.value, 'start', { expected_credits: current?.credits }),
    )
    fullLocalizationState.value = started
    if (started?.status === 'ready') {
      await importFullLocalization()
      return
    }
    ElMessage.success(`已开始生成${selectedFullLocalizationLabel.value}版本`)
    fullLocalizationPolls = 0
    pollFullLocalization()
  } catch (error) {
    ElMessage.error(error.message || '完全转绘失败')
  } finally {
    fullLocalizationBusy.value = false
  }
}

watch(fullLocalizationKey, async () => {
  stopFullLocalizationPolling()
  seriesTargets.value = []
  seriesTargetId.value = 0
  seriesTargetTouched.value = false
  try {
    const state = await refreshFullLocalizationStatus()
    if (state?.status === 'localizing') {
      fullLocalizationPolls = 0
      pollFullLocalization()
    }
  } catch (_) {
    fullLocalizationState.value = { status: '', credits: null }
  }
})

watch(workflowPhase, (phase) => {
  if (phase === 'analysis_review') void loadFullLocalizationTargets()
}, { immediate: true })

async function confirmAnalysisReview() {
  const work = workState.value
  if (!analysisReviewPending(work) || analysisReviewSubmitting.value) return
  analysisReviewSubmitting.value = true
  try {
    await redrawAPI.approveAnalysisReview(work.id, work.analysis_decision.evidence_hash)
    await refreshWork()
  } catch (error) {
    ElMessage.error(error.message || '确认分析结果失败')
  } finally {
    analysisReviewSubmitting.value = false
  }
}

async function confirmLocalizationReview() {
  const work = workState.value
  if (!localizationReviewPending(work) || localizationReviewSubmitting.value) return
  localizationReviewSubmitting.value = true
  try {
    await redrawAPI.approveLocalizationReview(work.id, {
      versionId: work.localization_decision.version_id,
      expectedFactsHash: work.localization_decision.evidence_hash,
    })
    await refreshWork()
  } catch (error) {
    ElMessage.error(error.message || '确认本地化结果失败')
  } finally {
    localizationReviewSubmitting.value = false
  }
}

async function ensureLocalizationQuote(work = workState.value) {
  if (
    !work?.id
      || work?.localization_quote
      || analysisReviewPending(work)
      || localizationReviewPending(work)
      || !['analysis_review', 'localization_needs_attention', 'failed'].includes(redrawWorkflowPhase(work))
  ) {
    return
  }
  const quoteRequest = localizationQuoteRequest(work)
  if (!localizationQuoteGate.begin(quoteRequest)) return
  try {
    const quote = await redrawAPI.quoteLocalization(work.id, quoteRequest.body)
    if (
      workState.value?.id !== work.id
        || !localizationQuoteGate.accepts(quoteRequest)
        || !['analysis_review', 'localization_needs_attention', 'failed'].includes(redrawWorkflowPhase(workState.value))
    ) {
      return
    }
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
    const quoteBody = localizationQuoteBody()
    const snapshot = createLocalizationConfirmationSnapshot({ work: workState.value, quoteBody })
    const quote = await redrawAPI.quoteLocalization(work.id, quoteBody)
    if (!isCurrentLocalizationConfirmation(snapshot, { work: workState.value, quoteBody: localizationQuoteBody() })) {
      return
    }
    const nextWork = {
      ...workState.value,
      localization_quote: quote?.localization_quote || quote,
    }
    syncWork(nextWork)
    const nextHash = String(nextWork.localization_quote?.quote_hash || '').trim()
    if (!canConfirmLocalization(nextWork, snapshot.previousHash)) {
      ElMessage.warning('本地化报价已变化，请重新确认')
      return
    }
    if (!localizationIdempotencyKey.value) {
      localizationIdempotencyKey.value = crypto.randomUUID()
    }
    const result = await redrawAPI.createVersion(work.id, buildLocalizationPayload({
      locale: snapshot.quoteBody.locale,
      market: snapshot.quoteBody.market,
      localizationLevel: snapshot.quoteBody.localization_level,
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
  stopFullLocalizationPolling()
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

.source-stage-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.source-stage-strip span {
  padding: 5px 9px;
  border: 1px solid #333;
  border-radius: 999px;
  color: #a5a5a5;
  font-size: 12px;
}

.source-stage-strip .completed {
  border-color: #2f6f4e;
  color: #66d49a;
}

.source-stage-strip .active {
  border-color: #ff7139;
  color: #fff;
}

.source-stage-strip .needs_attention {
  border-color: #b63b3b;
  color: #ff8585;
}

.analysis-locked-hint {
  display: block;
  margin-top: 8px;
  color: #f0b86e;
  text-align: right;
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

.factory-localization-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.factory-localization-actions .el-select {
  width: 200px;
}

.factory-localization-actions .factory-series-select {
  width: 280px;
  max-width: 100%;
}

.factory-series-lock {
  color: #f4d58d;
  font-size: 13px;
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
