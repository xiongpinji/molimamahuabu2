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

    <div v-if="!expectsLocalizationReview && !['analysis_review', 'blueprint_review', 'blueprint_locked', 'localizing', 'localization_needs_attention', 'failed'].includes(workflowPhase)" class="source-card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">01 · 源片输入</p>
          <h2>上传源片并锁定转绘基础设置</h2>
        </div>
        <el-tag v-if="workState?.id" class="source-work-tag">作品 {{ workState.id }}</el-tag>
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
        </label>
        <label class="field field--aspect-ratio">
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

    <p v-if="localeCapabilityMessage" class="locale-capability-empty" role="status">
      {{ localeCapabilityMessage }}
    </p>

    <section v-if="taskState.task_id || workState?.task_id" class="task-card">
      <div>
        <strong>分析任务 {{ taskState.task_id || workState?.task_id }}</strong>
        <span>{{ taskState.status || workState?.status || 'processing' }}</span>
      </div>
      <el-progress :percentage="taskState.progress" :stroke-width="6" color="#ff7139" />
    </section>

    <section v-if="seamReviewLoading || seamReview || seamReviewError" class="task-card source-audio-seam-review">
      <div><strong>长视频对白接缝确认</strong><span>{{ seamReviewLoading ? '正在读取' : '需要人工确认' }}</span></div>
      <p v-if="seamReviewError">{{ seamReviewError }}</p>
      <p v-else-if="seamReview?.reason === 'language_conflict'">相邻分段识别出的语言冲突，请人工校对源语言后重新分析。</p>
      <template v-else-if="seamReview?.status === 'resume_pending'">
        <p>完整对白选择已经保存，可以安全继续原分析任务。</p>
        <div class="billing-row"><el-button type="primary" :loading="seamSubmitting" @click="confirmSourceAudioSeam">继续分析</el-button></div>
      </template>
      <template v-else>
        <p>系统不会自动裁句。请在每个冲突处保留一侧识别出的完整对白段。</p>
        <div v-for="point in seamDecisionPoints" :key="point.seam_ms" class="seam-choice">
          <strong>{{ formatSeamTime(point.seam_ms) }} 接缝</strong>
          <el-radio-group v-model="seamSelections[point.seam_ms]">
            <el-radio :value="point.left_window_id">保留前窗完整对白：{{ point.left_text || '无对白' }}</el-radio>
            <el-radio :value="point.right_window_id">保留后窗完整对白：{{ point.right_text || '无对白' }}</el-radio>
          </el-radio-group>
        </div>
        <div class="billing-row">
          <el-button type="primary" :loading="seamSubmitting" :disabled="!canConfirmSeam" @click="confirmSourceAudioSeam">确认并继续分析</el-button>
        </div>
      </template>
    </section>

    <RedrawBlueprintReviewPanel
      v-if="showsBlueprintReview"
      :record="blueprintRecord"
      :work="workState"
      :loading="blueprintLoading"
      :error="blueprintError"
      @updated="onBlueprintUpdated"
      @refresh-requested="$emit('refresh-blueprint')"
    />

    <section v-if="showsBlueprintReadGate" class="task-card">
      <div>
        <strong>本地化门禁</strong>
        <span>{{ blueprintLoading ? '正在读取母本蓝图' : '母本蓝图不可用' }}</span>
      </div>
      <p>{{ blueprintError || '等待确认当前作品是否存在母本蓝图。' }}</p>
      <div class="billing-row">
        <el-button type="primary" disabled>开始本地化</el-button>
      </div>
    </section>

    <section v-if="workflowPhase === 'blueprint_review'" class="task-card">
      <div>
        <strong>本地化门禁</strong>
        <span>母本蓝图尚未锁定</span>
      </div>
      <p>先解决所有声音聚类并锁定母本事实，系统才会读取本地化报价。</p>
      <div class="billing-row">
        <el-button type="primary" disabled>开始本地化</el-button>
      </div>
    </section>

    <section v-if="workflowPhase === 'analysis_review' && !showsBlueprintReview" class="task-card">
      <div>
        <strong>服务端分析摘要</strong>
        <span>{{ workState?.analysis_task?.status || taskState.status || 'completed' }}</span>
      </div>
      <p>{{ workState?.analysis_summary || workState?.analysis_task?.message || '分析已完成，请确认后创建目标语言本地化版本。' }}</p>
      <div class="billing-row">
        <strong v-if="hasLocalizationQuote" class="canvas-credit-callout-v1">本地化报价 {{ localizationCredits }} 积分</strong>
        <strong v-else class="canvas-credit-callout-v1">本地化报价待管理员配置</strong>
        <el-button
          type="primary"
          :loading="localizationSubmitting"
          :disabled="!canSubmitLocalization"
          @click="confirmLocalization"
        >
          确认本地化
        </el-button>
      </div>
    </section>

    <section v-if="workflowPhase === 'blueprint_locked'" class="task-card">
      <div>
        <strong>母本蓝图已锁定</strong>
        <span>可以开始本地化</span>
      </div>
      <p>本地化版本将绑定当前母本蓝图哈希，不会改写母本原文与证据。</p>
      <div class="billing-row">
        <strong v-if="hasLocalizationQuote" class="canvas-credit-callout-v1">本地化报价 {{ localizationCredits }} 积分</strong>
        <strong v-else class="canvas-credit-callout-v1">本地化报价待管理员配置</strong>
        <el-button
          type="primary"
          :loading="localizationSubmitting"
          :disabled="!canSubmitLocalization"
          @click="confirmLocalization"
        >开始本地化</el-button>
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

    <section v-if="localizationLoading && expectsLocalizationReview" class="task-card">
      <div><strong>全剧本地化审核</strong><span>正在读取</span></div>
    </section>

    <section v-else-if="localizationError && expectsLocalizationReview" class="task-card">
      <div><strong>全剧本地化审核</strong><span>读取失败</span></div>
      <p>{{ localizationError }}</p>
      <div class="billing-row"><el-button @click="loadLocalization(true)">刷新本地化</el-button></div>
    </section>

    <RedrawLocalizationReviewPanel
      v-if="localizationRecord && Number(localizationRecord.version_id) === Number(workState?.version_id)
        && Number(localizationRecord.work_id) === Number(workState?.id)"
      :record="localizationRecord"
      :blueprint="blueprintRecord"
      :project-policy="projectPolicy"
      :blocked="blocked || blueprintLoading || Boolean(blueprintError) || localizationLoading || Boolean(localizationError)"
      @updated="onLocalizationUpdated"
      @locked="onLocalizationLocked"
      @refresh-requested="loadLocalization(true)"
      @unit-delivery-requested="$emit('unit-delivery-requested', $event)"
    />

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
          重试本地化
        </el-button>
      </div>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { redrawAPI } from '@/api/redraw'
import RedrawBlueprintReviewPanel from '@/components/redraw/RedrawBlueprintReviewPanel.vue'
import RedrawLocalizationReviewPanel from '@/components/redraw/RedrawLocalizationReviewPanel.vue'
import StylePresetPicker from '@/components/redraw/StylePresetPicker.vue'
import { canStartLocalization } from '@/utils/redrawBlueprintReviewState'
import { buildSourceAudioSeamDecisionPayload, sourceAudioSeamDecisionPoints } from '@/utils/redrawSourceAudioSeamReview'
import {
  analysisQuoteCredits,
  buildAnalyzePayload,
  buildLocalizationPayload,
  canConfirmLocalization,
  canStartRedrawAnalysis,
  createLocalizationConfirmationSnapshot,
  localizationQuoteCredits,
  localizationTaskState,
  localeReady,
  createLocalizationQuoteRequestGate,
  isCurrentLocalizationConfirmation,
  redrawWorkflowPhase,
  resolveEightStageState,
  shouldResetLocalizationIdempotencyKey,
  taskStateFromWork,
} from '@/utils/redrawWorkspaceState'

const props = defineProps({
  projectPolicy: Object,
  blocked: { type: Boolean, default: false },
  projectId: {
    type: [String, Number],
    required: true,
  },
  defaultLocale: {
    type: String,
    default: '',
  },
  defaultMarket: {
    type: String,
    default: '',
  },
  initialWork: {
    type: Object,
    default: null,
  },
  events: {
    type: Array,
    default: () => [],
  },
  blueprintRecord: {
    type: Object,
    default: undefined,
  },
  blueprintLoading: {
    type: Boolean,
    default: false,
  },
  blueprintError: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['work-updated', 'blueprint-updated', 'refresh-blueprint', 'unit-delivery-requested'])

const fileInput = ref(null)
const selectedFile = ref(null)
const locale = ref(props.defaultLocale || '')
const market = ref(props.defaultMarket || '')
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
const seamReview = ref(null)
const seamReviewLoading = ref(false)
const seamReviewError = ref('')
const seamSelections = ref({})
const seamSubmitting = ref(false)
const localizationState = ref(localizationTaskState(props.initialWork))
const workflowPhase = ref(redrawWorkflowPhase(props.initialWork, props.blueprintRecord))
const localizationIdempotencyKey = ref('')
const localizationQuoteGate = createLocalizationQuoteRequestGate()
const localizationRecord = ref(null)
const localizationLoading = ref(false)
const localizationError = ref('')
let localizationRequestSequence = 0
let workRequestSequence = 0
let visitEpoch = 0
let targetEpoch = 0
let alive = true
let pollTimer = null
let pollAttempts = 0

const aspectRatioOptions = ['1:1', '9:16', '16:9', '3:4', '4:3', '21:9']
const estimateCredits = computed(() => analysisQuoteCredits(workState.value))
const hasValidQuote = computed(() => estimateCredits.value != null)
const localizationCredits = computed(() => localizationQuoteCredits(workState.value))
const hasLocalizationQuote = computed(() => localizationCredits.value != null)
const seamDecisionPoints = computed(() => sourceAudioSeamDecisionPoints(seamReview.value))
const canConfirmSeam = computed(() => seamReview.value?.status === 'resume_pending'
  || (seamDecisionPoints.value.length > 0 && seamDecisionPoints.value.every(point => [point.left_window_id, point.right_window_id]
    .includes(seamSelections.value[point.seam_ms]))))
const selectedLocaleReady = computed(() => localeReady(localeOptions.value, locale.value, market.value))
const localeCapabilityMessage = computed(() => {
  if (!localeOptions.value.length) return '暂无通过验收的语言/地区，请管理员完成语言能力校准后开放。'
  const selected = localeOptions.value.find((item) => item.locale === locale.value && (item.market || '') === market.value)
  if (!selected) return '当前目标语言/地区组合未验证，请保留项目目标等待管理员开放，或手动选择已验证组合。'
  if (!selectedLocaleReady.value) return `当前语言/地区缺少分析或本地化能力：${selected.blocking?.join('、') || '能力状态未验证'}。`
  return selected.blocking.length
    ? `当前语言/地区可分析和本地化；后续生成仍缺少能力：${selected.blocking.join('、')}。`
    : ''
})
const canStartAnalysis = computed(() => canStartRedrawAnalysis({
  work: workState.value,
  selectedFile: selectedFile.value,
  locales: localeOptions.value,
  locale: locale.value,
  market: market.value,
  selectedPreset: selectedPreset.value,
  freeStyle: freeStyle.value,
}))
const canSubmitLocalization = computed(() => (
  selectedLocaleReady.value
  && !props.blueprintLoading
  && !props.blueprintError
  && canConfirmLocalization(workState.value, undefined, props.blueprintRecord)
))
const showsBlueprintReadGate = computed(() => (
  workflowPhase.value === 'analysis_review'
  && (props.blueprintRecord === undefined || props.blueprintLoading || Boolean(props.blueprintError))
))
const showsBlueprintReview = computed(() => (
  ['blueprint_review', 'blueprint_locked'].includes(workflowPhase.value)
  || showsBlueprintReadGate.value
))
const expectsLocalizationReview = computed(() => (
  workflowPhase.value === 'localization_review'
  && Number(workState.value?.version_id || 0) > 0
))
const eightStageState = computed(() => resolveEightStageState({
  ...(workState.value || {}),
  workflow_phase: workflowPhase.value,
  events: props.events,
}))

function onFileChange(event) {
  selectedFile.value = event.target.files?.[0] || null
}

function formatSeamTime(value) {
  const seconds = Math.max(0, Number(value || 0) / 1000)
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

async function loadSourceAudioSeamReview(work = workState.value) {
  const status = String(work?.analysis_task?.status || work?.task_status || '').toLowerCase()
  if (!work?.id || status !== 'needs_attention') {
    seamReview.value = null
    seamReviewError.value = ''
    seamSelections.value = {}
    return
  }
  seamReviewLoading.value = true
  seamReviewError.value = ''
  try {
    seamReview.value = await redrawAPI.getSourceAudioSeamReview(work.id)
    seamSelections.value = {}
  } catch (error) {
    const code = error?.response?.data?.error?.code
    if (['SOURCE_AUDIO_SEAM_REVIEW_NOT_FOUND', 'SOURCE_AUDIO_SEAM_REVIEW_STALE'].includes(code)) seamReview.value = null
    else seamReviewError.value = error?.message || '读取对白接缝失败'
  } finally {
    seamReviewLoading.value = false
  }
}

async function confirmSourceAudioSeam() {
  if (!canConfirmSeam.value || seamSubmitting.value || !workState.value?.id) return
  seamSubmitting.value = true
  try {
    const recorded = seamReview.value.status === 'resume_pending' ? seamReview.value
      : await redrawAPI.recordSourceAudioSeamDecision(workState.value.id,
        buildSourceAudioSeamDecisionPayload(seamReview.value, seamSelections.value))
    await redrawAPI.resumeSourceAudioSeamAnalysis(workState.value.id, {
      analysis_task_id: recorded.analysis_task_id,
      candidate_sha256: recorded.candidate_sha256,
      expected_work_updated_at: recorded.expected_work_updated_at,
      expected_task_updated_at: recorded.expected_task_updated_at,
    })
    seamReview.value = null
    seamSelections.value = {}
    await refreshWork()
    ElMessage.success('接缝选择已保存，母本分析已继续')
  } catch (error) {
    ElMessage.error(error?.response?.data?.error?.message || error?.message || '继续母本分析失败')
    await refreshWork().catch(() => {})
  } finally {
    seamSubmitting.value = false
  }
}

function localizationQuoteBody() {
  return {
    locale: locale.value,
    market: market.value,
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

function blueprintAllowsLocalization(record = props.blueprintRecord) {
  if (props.blueprintLoading || props.blueprintError) return false
  return record === null || canStartLocalization(record)
}

function isTerminalTaskState(work) {
  const phase = redrawWorkflowPhase(work, props.blueprintRecord)
  const analysisStatus = String(work?.analysis_task?.status || work?.task_status || work?.status || '').toLowerCase()
  const localizationStatus = String(work?.localization_task?.status || '').toLowerCase()
  if (phase === 'localizing') return false
  if (['pending', 'processing', 'analyzing'].includes(analysisStatus)) return false
  if (['pending', 'processing', 'localizing'].includes(localizationStatus)) return false
  return ['analysis_review', 'blueprint_review', 'blueprint_locked', 'localization_needs_attention', 'failed', 'assets'].includes(phase)
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
          || redrawWorkflowPhase(work, props.blueprintRecord) === 'localizing'
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
  workflowPhase.value = props.blueprintRecord === undefined
    ? redrawWorkflowPhase(next)
    : redrawWorkflowPhase(next, props.blueprintRecord)
  taskState.value = taskStateFromWork(next)
  localizationState.value = localizationTaskState(next)
  if (shouldResetLocalizationIdempotencyKey(next)) {
    localizationIdempotencyKey.value = ''
  }
  if (shouldPollWork(next)) startTaskPolling()
  if (isTerminalTaskState(next)) stopTaskPolling()
  ensureLocalizationQuote(next)
  if (expectsLocalizationReview.value) loadLocalization()
  else if (Number(next?.current_step || 1) > 1) {
    localizationRequestSequence += 1
    localizationRecord.value = null
    localizationError.value = ''
  }
  loadSourceAudioSeamReview(next)
}

async function loadLocalization(force = false) {
  const versionId = Number(workState.value?.version_id || 0)
  const requestedWorkId = Number(workState.value?.id || 0)
  if (!expectsLocalizationReview.value || !versionId) return
  if (!force && localizationRecord.value?.version_id === versionId
    && Number(localizationRecord.value.work_id) === requestedWorkId) return
  const requestSequence = ++localizationRequestSequence
  const token = sourceContext()
  localizationLoading.value = true
  localizationError.value = ''
  try {
    const next = await redrawAPI.getLocalization(versionId)
    if (!alive || requestSequence !== localizationRequestSequence || token !== sourceContext()) return
    if (Number(next?.version_id) !== versionId || Number(next?.work_id) !== requestedWorkId) throw Error('本地化作品或版本已变化，请刷新')
    localizationRecord.value = next
  } catch (error) {
    if (!alive || requestSequence !== localizationRequestSequence || token !== sourceContext()) return
    localizationError.value = error?.response?.data?.error?.message || error?.message || '读取本地化审核失败'
  } finally {
    if (requestSequence === localizationRequestSequence) localizationLoading.value = false
  }
}

async function loadCapabilities() {
  const [presets, locales] = await Promise.all([
    redrawAPI.listStylePresets(),
    redrawAPI.listLocales(),
  ])
  stylePresets.value = Array.isArray(presets) ? presets : []
  localeOptions.value = Array.isArray(locales) ? locales : []
}

async function refreshWork() {
  if (!workState.value?.id) return
  const requestSequence = ++workRequestSequence, token = sourceContext(), requestedWorkId = workState.value.id
  const fresh = await redrawAPI.getWork(requestedWorkId)
  if (!alive || requestSequence !== workRequestSequence || token !== sourceContext()
    || String(fresh?.id || '') !== String(requestedWorkId)
    || (fresh.project_id != null && String(fresh.project_id) !== String(props.projectId))) return
  syncWork(fresh)
  emit('work-updated', fresh)
  return fresh
}

async function ensureLocalizationQuote(work = workState.value) {
  const phase = redrawWorkflowPhase(work, props.blueprintRecord)
  if (
    !selectedLocaleReady.value
      || !work?.id
      || work?.localization_quote
      || !blueprintAllowsLocalization()
      || !['analysis_review', 'blueprint_locked', 'localization_needs_attention', 'failed'].includes(phase)
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
        || !['analysis_review', 'blueprint_locked', 'localization_needs_attention', 'failed']
          .includes(redrawWorkflowPhase(workState.value, props.blueprintRecord))
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

function mutationScope(targeted = false) {
  return { visit: visitEpoch, target: targeted ? targetEpoch : null }
}

function isCurrentMutation(scope) {
  return alive && scope.visit === visitEpoch
    && (scope.target === null || scope.target === targetEpoch)
}

async function ensureWork(scope) {
  if (workState.value?.id) return workState.value
  if (!selectedFile.value) throw new Error('请先上传源片文件')
  const result = await redrawAPI.createWorks(props.projectId, selectedFile.value)
  if (!isCurrentMutation(scope)) return null
  const created = result?.items?.[0]
  if (!created?.id) throw new Error('后端未返回转绘作品')
  syncWork(created)
  emit('work-updated', created)
  return created
}

async function uploadSource() {
  if (uploading.value || !alive) return
  const scope = mutationScope()
  uploading.value = true
  try {
    await ensureWork(scope)
  } catch (error) {
    if (!isCurrentMutation(scope)) return
    ElMessage.error(error.message || '上传源片失败')
  } finally {
    if (isCurrentMutation(scope)) uploading.value = false
  }
}

async function startAnalysis() {
  if (!canStartAnalysis.value || submitting.value || !alive) return
  const scope = mutationScope(true)
  submitting.value = true
  try {
    const work = await ensureWork(scope)
    if (!isCurrentMutation(scope)) return
    const result = await redrawAPI.analyzeWork(work.id, buildAnalyzePayload({
      locale: locale.value,
      market: market.value,
      aspectRatio: aspectRatio.value,
      selectedPreset: selectedPreset.value,
      freeStyle: freeStyle.value,
    }))
    if (!isCurrentMutation(scope)) return
    taskState.value = {
      task_id: result.task_id,
      status: '',
      progress: 0,
      message: '',
    }
    await refreshWork()
    if (!isCurrentMutation(scope)) return
    startTaskPolling()
    ElMessage.success('源片分析已提交')
  } catch (error) {
    if (!isCurrentMutation(scope)) return
    ElMessage.error(error.message || '提交转绘分析失败')
  } finally {
    if (isCurrentMutation(scope)) submitting.value = false
  }
}

async function confirmLocalization() {
  if (!canSubmitLocalization.value || localizationSubmitting.value || !alive) return
  const scope = mutationScope(true)
  localizationSubmitting.value = true
  try {
    const work = await ensureWork(scope)
    if (!isCurrentMutation(scope)) return
    if (!canSubmitLocalization.value || !blueprintAllowsLocalization()) return
    const quoteBody = localizationQuoteBody()
    const snapshot = createLocalizationConfirmationSnapshot({
      work: workState.value,
      quoteBody,
      blueprint: props.blueprintRecord,
    })
    const quote = await redrawAPI.quoteLocalization(work.id, quoteBody)
    if (!isCurrentMutation(scope)) return
    if (!isCurrentLocalizationConfirmation(snapshot, {
      work: workState.value,
      quoteBody: localizationQuoteBody(),
      blueprint: props.blueprintRecord,
    })) {
      return
    }
    const nextWork = {
      ...workState.value,
      localization_quote: quote?.localization_quote || quote,
    }
    syncWork(nextWork)
    const nextHash = String(nextWork.localization_quote?.quote_hash || '').trim()
    if (!canConfirmLocalization(nextWork, snapshot.previousHash, props.blueprintRecord)) {
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
    if (!isCurrentMutation(scope)) return
    localizationState.value = localizationTaskState({
      localization_task: {
        id: result?.task_id || result?.localization_task?.id,
        status: result?.status || result?.localization_task?.status || 'processing',
        progress: result?.progress || 0,
        message: result?.message || '',
      },
    })
    await refreshWork()
    if (!isCurrentMutation(scope)) return
    startTaskPolling()
    ElMessage.success('本地化已提交')
  } catch (error) {
    if (!isCurrentMutation(scope)) return
    ElMessage.error(error.message || '提交本地化失败')
  } finally {
    if (isCurrentMutation(scope)) localizationSubmitting.value = false
  }
}

onMounted(async () => {
  await loadCapabilities()
  await refreshWork()
})

watch(() => [props.projectId, props.defaultLocale, props.defaultMarket], (next, previous) => {
  if (next[0] !== previous[0]
    || (locale.value === (previous[1] || '') && market.value === (previous[2] || ''))) {
    locale.value = next[1] || ''
    market.value = next[2] || ''
  }
})

watch(() => props.initialWork, (next) => {
  if (Number(next?.id) !== Number(workState.value?.id) || Number(next?.version_id) !== Number(workState.value?.version_id)) {
    localizationRecord.value = null
  }
  workState.value = next
  workflowPhase.value = redrawWorkflowPhase(next, props.blueprintRecord)
  taskState.value = taskStateFromWork(next)
  localizationState.value = localizationTaskState(next)
  if (shouldPollWork(next)) startTaskPolling()
  if (isTerminalTaskState(next)) stopTaskPolling()
  ensureLocalizationQuote(next)
  if (expectsLocalizationReview.value) loadLocalization()
})

function sourceContext() {
  return JSON.stringify([props.projectId, props.initialWork?.id, props.initialWork?.version_id,
    workState.value?.id, workState.value?.version_id, props.projectPolicy])
}
watch(() => [props.projectId, props.initialWork?.id, props.initialWork?.version_id, props.projectPolicy], (next, previous) => {
  visitEpoch += 1
  uploading.value = false; submitting.value = false; localizationSubmitting.value = false
  workRequestSequence += 1; localizationRequestSequence += 1
  if (next.slice(0, 3).some((value, index) => value !== previous[index])) {
    localizationLoading.value = false; localizationError.value = ''
  } else if (localizationLoading.value) {
    localizationLoading.value = false
    localizationError.value = '本地化读取期间项目策略已变化，请显式刷新本地化复核'
  }
}, { deep: true, flush: 'sync' })
watch(() => [locale.value, market.value], () => {
  targetEpoch += 1
  submitting.value = false; localizationSubmitting.value = false
}, { flush: 'sync' })
watch(() => props.blocked, blocked => { if (!blocked && expectsLocalizationReview.value) loadLocalization() })

watch(() => props.blueprintRecord, (next) => {
  workflowPhase.value = redrawWorkflowPhase(workState.value, next)
  ensureLocalizationQuote(workState.value)
  if (expectsLocalizationReview.value) loadLocalization()
})

function onBlueprintUpdated(next) {
  emit('blueprint-updated', next)
}

function onLocalizationUpdated(next) {
  if (props.blocked || Number(next?.work_id) !== Number(workState.value?.id)
    || Number(next?.version_id) !== Number(workState.value?.version_id)) return
  localizationRecord.value = next
}

async function onLocalizationLocked(next) {
  if (props.blocked || Number(next?.work_id) !== Number(workState.value?.id)
    || Number(next?.version_id) !== Number(workState.value?.version_id)) return
  localizationRecord.value = next
  await refreshWork()
}

onUnmounted(() => {
  alive = false; workRequestSequence += 1; localizationRequestSequence += 1
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

.section-heading .source-work-tag {
  color: #f5f5f5;
  background: #252525;
  border-color: #454545;
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
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

.field--aspect-ratio {
  grid-column: 1 / -1;
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
