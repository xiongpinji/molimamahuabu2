<template>
  <section class="redraw-shot-step">
    <header class="section-heading">
      <div>
        <p class="eyebrow">03 · 批量转绘</p>
        <h2>按分镜生成并从后端恢复真实进度</h2>
      </div>
      <el-tag>{{ shots.length }} 个镜头</el-tag>
    </header>

    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="preparationError"
      :title="preparationError"
      type="warning"
      :closable="false"
      show-icon
    />
    <el-button
      v-if="preparationSubmissionLocked && !preparationSubmitting"
      type="warning"
      plain
      @click="openPreparationReview(selectedShotId)"
    >人工核对准备状态</el-button>
    <RedrawShotPreparationPanel
      v-if="referenceBundleRequired"
      :shots="shots"
      :gate="preparationGate"
      :quote="preparationQuote"
      :execution-mode="executionMode"
      :preparing="preparationSubmitting"
      :submission-locked="preparationSubmissionLocked"
      @prepare="startReferencePreparation"
      @manual-review="openPreparationReview"
    />
    <RedrawGenerationQueuePanel
      :summary="generationSummaryState"
      :retrying-shot-id="retryingDeliveryShotId"
      @retry="retryDeliveryShot"
    />
    <RedrawQualityReviewPanel
      :shots="shots"
      :execution-mode="executionMode"
      @reviewed="refreshDeliveryWorkspace"
    />
    <div v-if="shots.length" class="shot-layout">
      <RedrawBatchPanel
        :batches="batches"
        :shots="shots"
        :selected-shot-id="selectedShotId"
        :filter="filter"
        :gate="gate"
        :refreshing="refreshing"
        :generating="batchGenerating"
        @select="selectedShotId = $event"
        @update:filter="filter = $event"
        @generate="generateBatch"
        @refresh="refreshWork"
      />
      <div class="shot-main">
        <RedrawShotPreview :shot="selectedShot" />
        <RedrawShotEditor
          :shot="selectedShot"
          :assets="assets"
          :gate="gate"
          :saving="saving"
          :generating="shotGenerating"
          :reference-bundle-required="referenceBundleRequired"
          :reference-bundle-state="selectedReferenceBundleState"
          :reference-bundle-saving="referenceBundleSaving"
          @save="saveShot"
          @generate="generateShot"
          @save-reference-bundle="saveReferenceBundleDraft"
        />
      </div>
    </div>
    <div v-else class="empty-state">
      <strong>当前版本暂无可生成分镜</strong>
      <span>请等待后端分析完成后刷新，不会在前端伪造镜头或任务。</span>
      <el-button :icon="Refresh" :loading="refreshing" @click="refreshWork">刷新后端状态</el-button>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { redrawAPI } from '@/api/redraw'
import {
  buildReferencePreparationScopedStart,
  createReferencePreparationIdempotencyKey,
  normalizeShotWorkspace,
  referencePreparationManualReviewState,
  restoreSelectedShotId,
  settleReferencePreparationSubmission,
  shouldPollWork,
} from '@/utils/redrawShotState'
import RedrawBatchPanel from './RedrawBatchPanel.vue'
import RedrawShotEditor from './RedrawShotEditor.vue'
import RedrawShotPreview from './RedrawShotPreview.vue'
import RedrawShotPreparationPanel from './RedrawShotPreparationPanel.vue'
import RedrawGenerationQueuePanel from './RedrawGenerationQueuePanel.vue'
import RedrawQualityReviewPanel from './RedrawQualityReviewPanel.vue'

const props = defineProps({
  work: { type: Object, default: null },
  versionId: { type: [String, Number], default: null },
  executionMode: { type: String, default: 'safe' },
})
const emit = defineEmits(['work-updated'])
const localWork = ref(props.work)
const assets = ref([])
const gate = ref({ ok: false, missing: [] })
const selectedShotId = ref(null)
const filter = ref('incomplete')
const refreshing = ref(false)
const saving = ref(false)
const shotGenerating = ref(false)
const batchGenerating = ref(false)
const referenceBundleSaving = ref(false)
const referenceBundles = ref({})
const loadError = ref('')
const preparationError = ref('')
const preparationGate = ref({ ok: false, missing: [] })
const preparationQuote = ref(null)
const preparationSubmitting = ref(false)
const preparationSubmissionLocked = ref(false)
const preparationIdempotencyKey = ref('')
const pollAttempts = ref(0)
const generationSummaryState = ref(null)
const retryingDeliveryShotId = ref(null)
const MAX_POLL_ATTEMPTS = 120
let pollingTimer = null
let pollRequestActive = false

const state = computed(() => normalizeShotWorkspace(localWork.value || {}))
const shots = computed(() => state.value.shots)
const batches = computed(() => state.value.batches)
const resolvedVersionId = computed(() => props.versionId || localWork.value?.version_id || localWork.value?.current_version_id)
const selectedShot = computed(() => shots.value.find((shot) => String(shot.id) === String(selectedShotId.value)) || null)
const referenceBundleRequired = computed(() => localWork.value?.reference_bundle_required === true)
const selectedReferenceBundleState = computed(() => referenceBundles.value[String(selectedShotId.value)] || {
  loaded: false,
  loading: false,
  ready: false,
  evidence: {},
  response: null,
  error: '',
})

const HEX_SHA256 = /^[a-f0-9]{64}$/i

function referenceBundleEvidence(response, shotId) {
  const bundle = response?.bundle
  const coverage = bundle?.coverage_review
  const faceTracks = Array.isArray(bundle?.face_tracks) ? bundle.face_tracks : null
  const textRegions = Array.isArray(bundle?.text_regions) ? bundle.text_regions : null
  const faceCountsMatch = coverage && faceTracks
    && Number(coverage.recognizable_face_count) === Number(coverage.mapped_face_count)
    && Number(coverage.mapped_face_count) === faceTracks.length
    && Number(coverage.unresolved_face_count) === 0
  const textCountsMatch = coverage && textRegions
    && Number(coverage.recognizable_text_region_count) === Number(coverage.mapped_text_region_count)
    && Number(coverage.mapped_text_region_count) === textRegions.length
    && Number(coverage.unresolved_text_region_count) === 0
  const evidence = {
    faceTracks: Boolean(faceCountsMatch && faceTracks.every((track) => (
      String(track?.track_key || '').trim()
        && String(track?.source_character_key || '').trim()
        && Array.isArray(track?.time_ranges)
        && Number.isSafeInteger(Number(track?.identity_redraw_asset_id))
        && Number(track.identity_redraw_asset_id) > 0
    ))),
    identityPacks: Boolean(faceTracks && faceTracks.every((track) => (
      HEX_SHA256.test(String(track?.identity_pack_sha256 || ''))
        && HEX_SHA256.test(String(track?.identity?.artifact?.sha256 || ''))
        && Number.isSafeInteger(Number(track?.identity?.artifact?.asset_id))
        && Number(track.identity.artifact.asset_id) > 0
    ))),
    textClean: Boolean(textCountsMatch && textRegions.every((region) => (
      ['text_subtitle', 'text_screen'].includes(String(region?.kind || ''))
        && HEX_SHA256.test(String(region?.clean_plate?.pack_sha256 || ''))
        && HEX_SHA256.test(String(region?.clean_plate?.artifact?.sha256 || ''))
        && Number.isSafeInteger(Number(region?.clean_plate?.artifact?.asset_id))
        && Number(region.clean_plate.artifact.asset_id) > 0
    ))),
    motion: Boolean(
      Number.isSafeInteger(Number(bundle?.motion_reference?.asset_id))
        && Number(bundle.motion_reference.asset_id) > 0
        && HEX_SHA256.test(String(bundle?.motion_reference?.sha256 || ''))
        && Number(bundle?.motion_reference?.audio_stream_count) === 0
    ),
    dialogue: Boolean(
      String(bundle?.dialogue?.target_locale || '').trim()
        && bundle.dialogue.target_locale === bundle?.locale
        && String(bundle?.dialogue?.target_market || '').trim()
        && bundle.dialogue.target_market === bundle?.market
        && Array.isArray(bundle?.dialogue?.turns)
        && !/[\u3400-\u9fff]/.test(JSON.stringify(bundle.dialogue.turns))
    ),
  }
  const envelope = Number(response?.shot_id) === Number(shotId)
    && bundle?.schema_version === 'redraw-reference-bundle-v2'
    && HEX_SHA256.test(String(response?.reference_bundle_hash || ''))
    && Boolean(response?.reference_bundle_updated_at)
  return { ...evidence, ready: Boolean(envelope && Object.values(evidence).every(Boolean)) }
}

function setReferenceBundleState(shotId, next) {
  referenceBundles.value = {
    ...referenceBundles.value,
    [String(shotId)]: { ...(referenceBundles.value[String(shotId)] || {}), ...next },
  }
}

function errorReason(error, fallback) {
  return error?.response?.data?.error?.message || error?.message || fallback
}

function applyWork(nextWork) {
  localWork.value = nextWork
  selectedShotId.value = restoreSelectedShotId(state.value.shots, selectedShotId.value)
  emit('work-updated', nextWork)
}

async function refreshWork({ quiet = false } = {}) {
  if (!localWork.value?.id || pollRequestActive) return
  pollRequestActive = true
  if (!quiet) refreshing.value = true
  try {
    const nextWork = await redrawAPI.getWork(localWork.value.id)
    applyWork(nextWork)
    await loadGenerationSummary()
    loadError.value = ''
  } catch (error) {
    loadError.value = errorReason(error, '读取分镜状态失败')
  } finally {
    pollRequestActive = false
    if (!quiet) refreshing.value = false
  }
}

async function loadGenerationSummary() {
  if (!resolvedVersionId.value) return
  try {
    generationSummaryState.value = await redrawAPI.getGenerationSummary(resolvedVersionId.value)
  } catch (error) {
    loadError.value = errorReason(error, '读取生成队列摘要失败')
  }
}

async function retryDeliveryShot(shot) {
  if (!shot?.shot_id || shot.can_start_next_attempt !== true) return
  retryingDeliveryShotId.value = shot.shot_id
  try {
    await redrawAPI.generateShot(shot.shot_id, { retry: true })
    await refreshDeliveryWorkspace()
    ElMessage.success(`镜头 ${shot.shot_index} 的下一次尝试已提交`)
  } catch (error) {
    loadError.value = errorReason(error, '提交下一次尝试失败')
    await loadGenerationSummary()
  } finally {
    retryingDeliveryShotId.value = null
  }
}

async function refreshDeliveryWorkspace() {
  await refreshWork({ quiet: true })
  await loadGenerationSummary()
}

async function loadAssetsAndGate() {
  if (!resolvedVersionId.value) return
  try {
    const [nextAssets, nextGate] = await Promise.all([
      redrawAPI.listAssets(resolvedVersionId.value),
      redrawAPI.getGenerationGate(resolvedVersionId.value),
    ])
    assets.value = Array.isArray(nextAssets) ? nextAssets : []
    gate.value = nextGate || { ok: false, missing: [] }
  } catch (error) {
    loadError.value = errorReason(error, '读取资产门禁失败')
  }
}

async function loadPreparationWorkspace() {
  if (!resolvedVersionId.value || !referenceBundleRequired.value) {
    preparationGate.value = { ok: false, missing: [] }
    preparationQuote.value = null
    return
  }
  const versionId = resolvedVersionId.value
  try {
    const [nextGate, nextQuote] = await Promise.all([
      redrawAPI.getPreparationGate(versionId),
      redrawAPI.quoteReferencePreparation(versionId, {}),
    ])
    if (String(versionId) !== String(resolvedVersionId.value)) return
    preparationGate.value = nextGate || { ok: false, missing: [] }
    preparationQuote.value = nextQuote || null
    preparationError.value = ''
  } catch (error) {
    if (String(versionId) !== String(resolvedVersionId.value)) return
    preparationError.value = errorReason(error, '读取逐镜参考准备状态失败')
  }
}

async function startReferencePreparation(input = {}) {
  if (preparationSubmitting.value || preparationSubmissionLocked.value || !resolvedVersionId.value) return
  preparationSubmitting.value = true
  preparationSubmissionLocked.value = true
  let requestStarted = false
  try {
    const versionId = resolvedVersionId.value
    const requestedShotIds = Array.isArray(input.shot_ids) ? [...input.shot_ids] : []
    const scopedQuote = await redrawAPI.quoteReferencePreparation(versionId, { shot_ids: requestedShotIds })
    const scopedStart = buildReferencePreparationScopedStart(
      scopedQuote,
      requestedShotIds,
      resolvedVersionId.value,
      preparationQuote.value,
    )
    if (!preparationIdempotencyKey.value) {
      preparationIdempotencyKey.value = createReferencePreparationIdempotencyKey()
    }
    const submission = redrawAPI.startReferencePreparation(versionId, {
      ...scopedStart,
      idempotency_key: preparationIdempotencyKey.value,
    })
    requestStarted = true
    const result = await submission
    const settled = settleReferencePreparationSubmission({
      idempotencyKey: preparationIdempotencyKey.value,
      requestStarted,
      result,
    })
    preparationSubmissionLocked.value = settled.locked
    preparationIdempotencyKey.value = settled.idempotencyKey
    await refreshWork({ quiet: true })
    await loadPreparationWorkspace()
    if (settled.outcome === 'needs_attention') ElMessage.warning('准备状态需要人工核对')
    else if (settled.outcome === 'unknown') ElMessage.warning('准备任务状态未知，请人工核对')
    else ElMessage.success('逐镜参考准备任务已创建')
  } catch (error) {
    const settled = settleReferencePreparationSubmission({
      idempotencyKey: preparationIdempotencyKey.value,
      requestStarted,
      error,
    })
    preparationSubmissionLocked.value = settled.locked
    preparationIdempotencyKey.value = settled.idempotencyKey
    if (settled.refreshWorkspace) await loadPreparationWorkspace()
    const fallback = settled.outcome === 'unknown'
      ? '逐镜参考准备提交状态未知，请人工核对'
      : '逐镜参考准备提交被拒绝，请重新确认服务端报价'
    preparationError.value = errorReason(error, fallback)
    ElMessage.error(preparationError.value)
  } finally {
    preparationSubmitting.value = false
  }
}

async function openPreparationReview(shotId) {
  if (shotId != null) selectedShotId.value = shotId
  await refreshWork({ quiet: true })
  await loadPreparationWorkspace()
  const reviewed = referencePreparationManualReviewState(preparationIdempotencyKey.value)
  preparationSubmitting.value = reviewed.submitting
  preparationSubmissionLocked.value = reviewed.locked
  preparationIdempotencyKey.value = reviewed.idempotencyKey
  ElMessage.warning('此镜头只允许人工核对当前证据，不会自动再次提交')
}

async function loadReferenceBundle(shotId) {
  if (!referenceBundleRequired.value) return true
  setReferenceBundleState(shotId, { loading: true, ready: false, error: '' })
  try {
    const response = await redrawAPI.getReferenceBundle(shotId)
    const evidence = referenceBundleEvidence(response, shotId)
    setReferenceBundleState(shotId, {
      loaded: true,
      loading: false,
      ready: evidence.ready,
      evidence,
      response,
      error: evidence.ready ? '' : '服务端参考包证据不完整，当前镜头禁止生成',
    })
    return evidence.ready
  } catch (error) {
    setReferenceBundleState(shotId, {
      loaded: true,
      loading: false,
      ready: false,
      evidence: {},
      response: null,
      error: errorReason(error, '读取逐镜参考包失败'),
    })
    return false
  }
}

async function loadAllReferenceBundles() {
  if (!referenceBundleRequired.value) {
    referenceBundles.value = {}
    return
  }
  await Promise.all(shots.value.map((shot) => loadReferenceBundle(shot.id)))
}

function responseStatus(error) {
  return Number(error?.response?.status || error?.response?.data?.status || 0)
}

async function saveReferenceBundleDraft(draft) {
  const currentShot = selectedShot.value
  if (!referenceBundleRequired.value || !currentShot?.id) return
  referenceBundleSaving.value = true
  setReferenceBundleState(currentShot.id, {
    loading: true,
    ready: false,
    error: '参考包保存后等待服务端重新验证',
  })
  try {
    await redrawAPI.saveReferenceBundle(currentShot.id, {
      expected_updated_at: currentShot.updated_at,
      motion_reference_asset_id: draft.motion_reference_asset_id,
      face_tracks: draft.face_tracks,
      text_regions: draft.text_regions,
      coverage_review: draft.coverage_review,
    })
    await refreshWork({ quiet: true })
    const ready = await loadReferenceBundle(currentShot.id)
    if (ready) ElMessage.success('参考包已保存并由服务端重新验证')
    else ElMessage.error('参考包已保存，但服务端证据复核未通过')
  } catch (error) {
    const message = errorReason(error, '保存逐镜参考包失败')
    loadError.value = message
    if (responseStatus(error) === 409) {
      await refreshWork({ quiet: true })
      await loadReferenceBundle(currentShot.id)
    } else {
      setReferenceBundleState(currentShot.id, { loading: false, ready: false, error: message })
    }
    ElMessage.error(message)
  } finally {
    referenceBundleSaving.value = false
  }
}

async function saveShot(payload, { silent = false } = {}) {
  if (!selectedShot.value?.id) return null
  saving.value = true
  try {
    const updated = await redrawAPI.updateShot(selectedShot.value.id, payload)
    const nextShots = shots.value.map((shot) => Number(shot.id) === Number(updated.id) ? updated : shot)
    applyWork({ ...localWork.value, shots: nextShots })
    if (!silent) ElMessage.success('镜头已保存')
    return updated
  } catch (error) {
    const message = errorReason(error, '保存镜头失败')
    loadError.value = message
    await refreshWork({ quiet: true })
    if (!silent) ElMessage.error(message)
    return null
  } finally {
    saving.value = false
  }
}

async function generateShot({ update, retry }) {
  if (!selectedShot.value?.id) return
  shotGenerating.value = true
  try {
    const saved = await saveShot(update, { silent: true })
    if (!saved) return
    if (referenceBundleRequired.value && !(await loadReferenceBundle(saved.id))) {
      ElMessage.error('镜头保存后参考包复核未通过，未提交生成任务')
      return
    }
    const body = {
      model: saved.model,
      duration: Number(saved.duration),
      resolution: saved.resolution,
      ...(retry ? { retry: true } : {}),
    }
    await redrawAPI.generateShot(saved.id, body)
    pollAttempts.value = 0
    await refreshWork({ quiet: true })
    ElMessage.success(retry ? '重试任务已提交' : '镜头生成任务已提交')
  } catch (error) {
    const message = errorReason(error, retry ? '镜头重试失败' : '镜头生成失败')
    loadError.value = message
    ElMessage.error(message)
    await refreshWork({ quiet: true })
  } finally {
    shotGenerating.value = false
  }
}

async function generateBatch(shotIds) {
  if (!localWork.value?.id || !shotIds.length) return
  batchGenerating.value = true
  try {
    let verifiedShotIds = shotIds
    if (referenceBundleRequired.value) {
      const candidates = shotIds.filter((shotId) => referenceBundles.value[String(shotId)]?.ready === true)
      const rechecked = await Promise.all(candidates.map((shotId) => loadReferenceBundle(shotId)))
      verifiedShotIds = candidates.filter((_shotId, index) => rechecked[index] === true)
    }
    if (!verifiedShotIds.length) return
    await redrawAPI.generateBatch(localWork.value.id, {
      version_id: resolvedVersionId.value,
      shot_ids: verifiedShotIds,
    })
    pollAttempts.value = 0
    await refreshWork({ quiet: true })
    ElMessage.success(`已提交 ${verifiedShotIds.length} 个镜头`)
  } catch (error) {
    const message = errorReason(error, '批量生成失败')
    loadError.value = message
    ElMessage.error(message)
    await refreshWork({ quiet: true })
  } finally {
    batchGenerating.value = false
  }
}

function stopPolling() {
  if (pollingTimer) clearInterval(pollingTimer)
  pollingTimer = null
}

function syncPolling() {
  const needsPolling = shouldPollWork(shots.value) && pollAttempts.value < MAX_POLL_ATTEMPTS
  if (!needsPolling) {
    stopPolling()
    return
  }
  if (pollingTimer) return
  pollingTimer = setInterval(async () => {
    if (pollAttempts.value >= MAX_POLL_ATTEMPTS) {
      stopPolling()
      loadError.value = '任务仍在处理，已暂停自动刷新，请手动刷新后端状态'
      return
    }
    pollAttempts.value += 1
    await refreshWork({ quiet: true })
  }, 2500)
}

watch(() => props.work, (nextWork) => {
  if (!nextWork) return
  localWork.value = nextWork
  selectedShotId.value = restoreSelectedShotId(state.value.shots, selectedShotId.value)
}, { immediate: true })
watch(resolvedVersionId, loadAssetsAndGate)
watch(resolvedVersionId, loadGenerationSummary)
watch(resolvedVersionId, () => {
  preparationSubmissionLocked.value = false
  preparationIdempotencyKey.value = ''
  loadPreparationWorkspace()
})
watch(
  () => `${referenceBundleRequired.value}:${resolvedVersionId.value || ''}:${shots.value.map((shot) => shot.id).join(',')}`,
  loadAllReferenceBundles,
  { immediate: true },
)
watch(shots, syncPolling, { deep: true })

onMounted(async () => {
  selectedShotId.value = restoreSelectedShotId(shots.value, selectedShotId.value)
  await loadAssetsAndGate()
  await loadPreparationWorkspace()
  await loadGenerationSummary()
  syncPolling()
})
onBeforeUnmount(stopPolling)
</script>

<style scoped>
.redraw-shot-step { display: grid; gap: 16px; min-width: 0; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
.section-heading > div { min-width: 0; }
.eyebrow { margin: 0 0 5px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h2 { margin: 0; font-size: 20px; overflow-wrap: anywhere; }
.shot-layout { display: grid; grid-template-columns: minmax(230px, 280px) minmax(0, 1fr); align-items: start; gap: 14px; min-width: 0; }
.shot-main { display: grid; gap: 14px; min-width: 0; }
.empty-state { display: grid; justify-items: start; gap: 10px; min-width: 0; padding: 28px; border: 1px dashed #343434; border-radius: 8px; background: #121212; color: #999; }
.empty-state strong, .empty-state span { max-width: 100%; overflow-wrap: anywhere; }
@media (max-width: 900px) { .shot-layout { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .section-heading { flex-direction: column; } }
</style>
