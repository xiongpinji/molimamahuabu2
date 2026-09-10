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
      :submission-locked="preparationSubmissionLocked || motionPreparationBlocked"
      @prepare="startReferencePreparation"
      @manual-review="openPreparationReview"
    />
    <el-button
      v-if="referenceBundleRequired"
      data-testid="redraw-reference-preparation-refresh"
      :loading="preparationRefreshing"
      :disabled="preparationSubmitting || preparationRefreshing || (motionPreparationBlocked && !selectedMotionPreparation)"
      @click="refreshReferencePreparation"
    >刷新准备报价 / 状态</el-button>
    <RedrawGenerationQueuePanel
      :summary="motionQueueSummary"
      :retrying-shot-id="retryingDeliveryShotId"
      :generation-disabled="motionGenerationBlocked"
      @retry="retryDeliveryShot"
    />
    <el-alert v-if="motionGenerationBlocked" title="动作素材尚未完成核对，单镜、批量与队列重试已冻结" type="warning" :closable="false" />
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
        :gate="motionGenerationBlocked ? { ok: false, missing: [] } : gate"
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
          :motion-scope="motionScope"
          :motion-state="motionState"
          :motion-generation-blocked="motionGenerationBlocked"
          @save="saveShot"
          @generate="generateShot"
          @save-reference-bundle="saveReferenceBundleDraft"
          @motion-selection="handleMotionSelection"
          @motion-upload="uploadMotionReference"
          @motion-draft="loadMotionDraft"
          @motion-process="processMotionReference"
          @motion-cancel="cancelMotionProcessing"
          @motion-refresh="refreshMotionReference"
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
import { taskAPI } from '@/api/task'
import { readCurrentTenantId, readSession } from '@/utils/authSession'
import { parseMotionProcessingEnvelope, motionProcessingErrorMessage } from '@/utils/redrawMotionProcessing'
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
const preparationRefreshing = ref(false)
const preparationSubmissionLocked = ref(false)
const preparationIdempotencyKey = ref('')
const pollAttempts = ref(0)
const generationSummaryState = ref(null)
const retryingDeliveryShotId = ref(null)
const MAX_POLL_ATTEMPTS = 120
let pollingTimer = null
let pollRequestActive = false
let workReadEpoch = 0

const state = computed(() => normalizeShotWorkspace(localWork.value || {}))
const shots = computed(() => state.value.shots)
const batches = computed(() => state.value.batches)
const resolvedVersionId = computed(() => props.versionId || localWork.value?.version_id || localWork.value?.current_version_id)
const selectedShot = computed(() => shots.value.find((shot) => String(shot.id) === String(selectedShotId.value)) || null)
const referenceBundleRequired = computed(() => localWork.value?.reference_bundle_required === true)
const selectedReferenceBundleState = computed(() => ({ ...(referenceBundles.value[String(selectedShotId.value)] || {
  loaded: false,
  loading: false,
  ready: false,
  evidence: {},
  response: null,
  error: '',
}), ready: motionReferenceReady(selectedShotId.value) }))

const HEX_SHA256 = /^[a-f0-9]{64}$/i
const motionOperations = ref({})
const motionSelection = ref(null)
const motionStorageError = ref('')
const motionAuthError = ref('')
const motionView = ref({ status: 'missing', draftUrl: '', candidateUrl: '', error: '', loading: false, draftLoading: false,
  processingLoading: false, processingResult: null, resetSelection: 0 })
const motionCandidates = ref({})
const motionCandidateScopes = ref({})
const motionPreparationProof = ref(null)
let applyingMotionPreparation = false
let motionEpoch = 0
let motionActionEpoch = 0
let motionDisposed = false
const motionControllers = new Set()
const referenceBundleControllers = new Map()
// Keep this work anchored to its entry identity; a token refresh is not an owner change.
let motionWorkAuth = readMotionAuth()
const motionStoragePrefix = computed(() => {
  const work = localWork.value
  const { user_id: userId, tenant_id: tenantId } = motionWorkAuth
  return userId && work?.id && resolvedVersionId.value
    ? `redraw-motion-pending:v1:${[userId, tenantId, work.id, resolvedVersionId.value].map(encodeURIComponent).join(':')}:` : ''
})
const motionOperationScope = computed(() => `${motionStoragePrefix.value}${selectedShotId.value || ''}`)
const motionOwnerScope = computed(() => `${localWork.value?.tenant_id || ''}:${localWork.value?.user_id || ''}`)
const motionScope = computed(() => `${motionOperationScope.value}:${selectedShot.value?.updated_at || ''}:${localWork.value?.source_fingerprint || ''}:${motionOwnerScope.value}`)
const hasPendingMotionOperation = computed(() => Object.keys(motionOperations.value).some(key => key.startsWith(motionStoragePrefix.value)))
const motionSubmissionBlocked = computed(() => referenceBundleRequired.value && Boolean(motionAuthError.value || motionStorageError.value
  || motionSelection.value?.file || motionView.value.processingLoading || motionView.value.processingResult || hasPendingMotionOperation.value))
const selectedMotionPreparation = computed(() => motionOperations.value[motionOperationScope.value]?.preparation || null)
const canPrepareUploadedMotion = computed(() => {
  const operation = motionOperations.value[motionOperationScope.value], proof = motionPreparationProof.value
  return Boolean(operation?.phase === 'awaiting-refresh' && !operation.preparation && proof
    && proof.scope === motionScope.value && proof.epoch === motionActionEpoch && !motionView.value.loading
    && !motionStorageError.value && Object.keys(motionOperations.value).filter(key => key.startsWith(motionStoragePrefix.value)).length === 1)
})
const motionPreparationBlocked = computed(() => motionSubmissionBlocked.value && !canPrepareUploadedMotion.value)
const motionGenerationBlocked = computed(() => motionSubmissionBlocked.value || motionView.value.loading)
const motionQueueSummary = computed(() => generationSummaryState.value ? { ...generationSummaryState.value,
  shots: (generationSummaryState.value.shots || []).map(shot => ({ ...shot, motion_reference_ready: motionReferenceReady(shot.shot_id) })),
} : null)
const motionState = computed(() => ({ ...motionView.value,
  error: motionAuthError.value || motionStorageError.value || motionView.value.error,
  locked: Boolean(motionAuthError.value || motionStorageError.value || hasPendingMotionOperation.value),
  uploading: motionOperations.value[motionOperationScope.value]?.phase === 'uploading',
}))

function restoreMotionOperations() {
  if (!referenceBundleRequired.value) return true
  if (!currentMotionAuth()) return false
  try {
    if (!motionStoragePrefix.value || typeof sessionStorage === 'undefined') throw new Error('missing session storage')
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index)
      if (!key?.startsWith(motionStoragePrefix.value)) continue
      const marker = JSON.parse(sessionStorage.getItem(key))
      if (!marker || marker.scope !== key || !/^[\w-]{20,}$/.test(marker.idempotencyKey || '')
        || !marker.expected_updated_at || !HEX_SHA256.test(marker.expected_source_sha256 || '')
        || Object.keys(marker).some(field => !['scope', 'idempotencyKey', 'expected_updated_at', 'expected_source_sha256'].includes(field))) {
        throw new Error('invalid pending marker')
      }
      if (!motionOperations.value[key]) motionOperations.value[key] = { ...marker, phase: 'unknown' }
    }
    return !motionStorageError.value
  } catch (_) {
    motionStorageError.value = '无法安全读取上传待核对记录，生成与上传已冻结；请人工核对会话存储'
    return false
  }
}

function invalidateMotionReads() {
  motionEpoch += 1
  motionPreparationProof.value = null
  preparationRefreshing.value = false
  for (const controller of motionControllers) controller.abort()
  motionControllers.clear()
  motionView.value.loading = false
  motionView.value.draftLoading = false
  motionView.value.processingLoading = false
}
function clearMotionMedia() {
  for (const key of ['draftUrl', 'candidateUrl']) {
    if (motionView.value[key]) URL.revokeObjectURL(motionView.value[key])
    motionView.value[key] = ''
  }
}
function readMotionAuth(work = localWork.value) {
  try {
    return { user_id: String(readSession()?.user?.id || ''),
      tenant_id: String(readCurrentTenantId() || work?.tenant_id || 'default') }
  } catch (_) { return { user_id: '', tenant_id: '' } }
}
function currentMotionAuth(expected = motionWorkAuth) {
  if (motionDisposed) return false
  const live = readMotionAuth(), work = localWork.value
  if (live.user_id && live.user_id === expected.user_id && live.tenant_id === expected.tenant_id
    && live.user_id === motionWorkAuth.user_id && live.tenant_id === motionWorkAuth.tenant_id
    && (work?.user_id == null || String(work.user_id) === live.user_id)
    && (work?.tenant_id == null || String(work.tenant_id) === live.tenant_id)) {
    motionAuthError.value = ''
    return true
  }
  invalidateMotionAuth()
  return false
}
function invalidateMotionAuth() {
  if (!motionDisposed && !motionAuthError.value) {
    motionAuthError.value = '当前用户或租户已变化，动作素材已清除；请重新载入所属工作区'
    motionActionEpoch += 1
    workReadEpoch += 1
    invalidateMotionReads()
    clearMotionMedia()
    motionSelection.value = null
    motionView.value.processingResult = null
    motionView.value.resetSelection += 1
    motionCandidates.value = {}
    motionCandidateScopes.value = {}
    for (const [shotId, request] of referenceBundleControllers) {
      request.controller.abort()
      setReferenceBundleState(shotId, { loading: false, ready: false })
    }
    referenceBundleControllers.clear()
    // Submitted operations and their persisted bytes remain available for explicit reconciliation.
  }
}
function checkMotionAuthStorage(event) {
  if (event.key != null && !['moli_mama_session', 'moli_mama_tenant_id'].includes(event.key)) return
  // Storage events can be queued after A→B→A; live storage alone would miss the intervening owner.
  if (event.key === 'moli_mama_session' && event.newValue !== undefined) {
    let session
    try { session = JSON.parse(event.newValue) } catch (_) { /* Invalid sessions also revoke local media. */ }
    if (!session?.token || String(session?.user?.id || '') !== motionWorkAuth.user_id) { invalidateMotionAuth(); return }
  }
  if (event.key === 'moli_mama_tenant_id' && event.newValue !== undefined
    && String(event.newValue || localWork.value?.tenant_id || 'default') !== motionWorkAuth.tenant_id) {
    invalidateMotionAuth(); return
  }
  if (event.key === null) { invalidateMotionAuth(); return }
  currentMotionAuth()
}
function checkMotionAuthFocus() { currentMotionAuth() }
function beginMotionRead() {
  const controller = new AbortController()
  motionControllers.add(controller)
  const epoch = motionEpoch, scope = motionScope.value, owner = { ...motionWorkAuth }
  return { controller, owner, current: () => !motionDisposed && epoch === motionEpoch && scope === motionScope.value
    && currentMotionAuth(owner) && !controller.signal.aborted }
}
function motionIdentity(shot = selectedShot.value, work = localWork.value) {
  return { expected_updated_at: shot?.updated_at, expected_source_sha256: work?.source_fingerprint }
}
function validMotionIdentity(identity) {
  return Boolean(identity.expected_updated_at && HEX_SHA256.test(identity.expected_source_sha256 || ''))
}
function motionScopeForShot(shotId) {
  const shot = shots.value.find(item => Number(item.id) === Number(shotId))
  return shot ? `${motionStoragePrefix.value}${shot.id}:${shot.updated_at || ''}:${localWork.value?.source_fingerprint || ''}:${motionOwnerScope.value}` : ''
}
function motionReferenceReady(shotId) {
  if (!referenceBundleRequired.value) return true
  if (String(shotId) === String(selectedShotId.value) && motionView.value.loading) return false
  const scope = motionScopeForShot(shotId), bundleState = referenceBundles.value[String(shotId)]
  const candidate = motionCandidates.value[String(shotId)]
  return Boolean(scope && motionCandidateScopes.value[String(shotId)] === scope && bundleState?.ready
    && (candidateMatchesBundle(bundleState.response, candidate, shotId)
      || serverBundleStandsAlone(bundleState.response, candidate, shotId)))
}
function invalidateMotionProof(shotId) {
  referenceBundleControllers.get(String(shotId))?.controller.abort()
  referenceBundleControllers.delete(String(shotId))
  delete motionCandidateScopes.value[String(shotId)]
  delete motionCandidates.value[String(shotId)]
  setReferenceBundleState(shotId, { ready: false })
}
function candidateMatchesBundle(response, candidate, shotId = response?.shot_id) {
  const shot = shots.value.find(item => Number(item.id) === Number(shotId))
  if (!shot) return false
  try { validateMotionCandidate(candidate, shotId, motionIdentity(shot)) } catch (_) { return false }
  return Boolean(candidate?.status === 'available' && candidate.candidate?.asset
    && Number(response?.bundle?.motion_reference?.asset_id) === Number(candidate.candidate.asset.id)
    && response.bundle.motion_reference.sha256 === candidate.candidate.asset.sha256)
}
function bundleMatchesCurrentScope(response, shotId = response?.shot_id) {
  const shot = shots.value.find(item => Number(item.id) === Number(shotId))
  return Boolean(shot && Number(response?.shot_id) === Number(shotId)
    && Number(response?.version_id) === Number(resolvedVersionId.value)
    && response?.shot_updated_at === shot.updated_at
    && response?.source_sha256 === localWork.value?.source_fingerprint)
}
function serverBundleStandsAlone(response, candidate, shotId = response?.shot_id) {
  return Boolean(candidate?.status === 'missing' && !hasPendingMotionOperation.value
    && bundleMatchesCurrentScope(response, shotId))
}
function missingMotionCandidate(error) {
  return responseStatus(error) === 404
    && error?.response?.data?.error?.code === 'REDRAW_MOTION_CANDIDATE_NOT_FOUND'
}
function missingMotionCandidateEnvelope(shotId, identity) {
  return { shot_id: Number(shotId), version_id: Number(resolvedVersionId.value),
    shot_updated_at: identity.expected_updated_at, source_sha256: identity.expected_source_sha256,
    status: 'missing', candidate: null }
}
function validateMotionCandidate(response, shotId, identity) {
  if (Number(response?.shot_id) !== Number(shotId) || Number(response?.version_id) !== Number(resolvedVersionId.value)
    || response.shot_updated_at !== identity.expected_updated_at || response.source_sha256 !== identity.expected_source_sha256
    || !['missing', 'available', 'unavailable'].includes(response.status)) throw new Error('动作素材来源或镜头版本不匹配，请重新核对')
  if (response.status === 'available' && (!Number.isSafeInteger(response.candidate?.import_id)
    || response.candidate.import_id <= 0 || !validMotionAsset(response.candidate?.asset))) throw new Error('动作素材证据不完整')
  if (response.status !== 'available' && response.candidate !== null) throw new Error('动作素材状态不一致')
}
function validMotionAsset(asset) {
  return Number.isSafeInteger(asset?.id) && asset.id > 0 && asset.type === 'video' && asset.mime_type === 'video/mp4'
    && HEX_SHA256.test(asset.sha256 || '') && ['duration_ms', 'width', 'height', 'file_size'].every(key => Number.isSafeInteger(asset[key]) && asset[key] > 0)
}
function validMotionBlob(blob) {
  if (!(blob instanceof Blob) || !blob.size || blob.type !== 'video/mp4') throw new Error('动作视频不可读取')
  return blob
}

function handleMotionSelection(input = {}) {
  if (!currentMotionAuth() || input.scope !== motionScope.value || hasPendingMotionOperation.value) return
  const result = motionView.value.processingResult
  if (input.processing_report !== undefined && (!result || input.file !== result.file || input.processing_report !== result.processingReport)) return
  if (input.file !== result?.file) motionView.value.processingResult = null
  if (!input.file && !motionSelection.value && !motionView.value.processingLoading) return
  motionSelection.value = input.file ? { ...input, owner: { ...motionWorkAuth } } : null
  motionActionEpoch += 1
  invalidateMotionReads()
}

function cancelMotionProcessing() {
  if (hasPendingMotionOperation.value) return
  motionActionEpoch += 1
  invalidateMotionReads()
  motionSelection.value = null
  motionView.value.processingResult = null
  motionView.value.resetSelection += 1
}

async function processMotionReference() {
  if (!currentMotionAuth() || !selectedShot.value?.id || !validMotionIdentity(motionIdentity()) || motionView.value.processingLoading
    || hasPendingMotionOperation.value || motionStorageError.value || preparationSubmissionLocked.value) return
  cancelMotionProcessing()
  const request = beginMotionRead(), scope = motionScope.value, identity = motionIdentity(), shotId = selectedShot.value.id
  const binding = { ...identity, owner: request.owner, work_id: localWork.value.id, version_id: resolvedVersionId.value, shot_id: shotId }
  motionView.value.processingLoading = true
  motionView.value.error = ''
  try {
    const blob = await redrawAPI.getMotionProcessing(shotId, identity, { signal: request.controller.signal })
    if (!request.current()) return
    const result = await parseMotionProcessingEnvelope(blob, binding, { signal: request.controller.signal })
    if (!request.current()) return
    motionView.value.processingResult = { ...result, scope }
  } catch (error) {
    if (!request.current()) return
    try {
      const message = await motionProcessingErrorMessage(error, { signal: request.controller.signal })
      if (request.current()) motionView.value.error = message
    } catch (_) {
      if (request.current()) motionView.value.error = '动作处理失败，请手工重新核对'
    }
  } finally {
    motionControllers.delete(request.controller)
    if (request.current()) motionView.value.processingLoading = false
  }
}

async function loadMotionDraft() {
  if (!currentMotionAuth() || !selectedShot.value?.id || !validMotionIdentity(motionIdentity()) || motionView.value.draftLoading || motionView.value.processingLoading) return
  const request = beginMotionRead(), shotId = selectedShot.value.id
  motionView.value.draftLoading = true
  try {
    const blob = await redrawAPI.getMotionDraft(shotId, motionIdentity(), { signal: request.controller.signal })
    if (!request.current()) return
    validMotionBlob(blob)
    if (motionView.value.draftUrl) URL.revokeObjectURL(motionView.value.draftUrl)
    motionView.value.draftUrl = URL.createObjectURL(blob)
  } catch (error) {
    if (request.current()) motionView.value.error = errorReason(error, '读取裁片静音草稿失败')
  } finally {
    motionControllers.delete(request.controller)
    if (request.current()) motionView.value.draftLoading = false
  }
}

async function readMotionCandidate({ freshWork = false } = {}) {
  if (!referenceBundleRequired.value || !currentMotionAuth() || !selectedShot.value?.id || !validMotionIdentity(motionIdentity())) return
  invalidateMotionReads()
  const request = beginMotionRead(), shotId = selectedShot.value.id, workId = localWork.value.id
  const versionId = resolvedVersionId.value, operationScope = motionOperationScope.value
  const candidateScope = motionScopeForShot(shotId)
  invalidateMotionProof(shotId)
  motionView.value.loading = true
  const readEpoch = ++workReadEpoch
  try {
    // This GET is intentionally independent of the polling busy flag: only a new request is a post-upload barrier.
    const options = { signal: request.controller.signal, silentError: true }
    const nextWork = freshWork ? await redrawAPI.getWork(workId, options) : localWork.value
    if (!request.current()) return
    const currentShot = nextWork?.shots?.find(item => Number(item.id) === Number(shotId))
    const identity = motionIdentity(currentShot, nextWork)
    if (Number(nextWork?.id) !== Number(workId) || Number(nextWork.version_id || nextWork.current_version_id) !== Number(versionId)
      || !currentShot || !validMotionIdentity(identity)) throw new Error('新工作区与当前镜头不匹配，保持冻结')
    if (freshWork && (localWork.value.user_id != null || localWork.value.tenant_id != null) && !motionWorkOwned(nextWork)) {
      throw new Error('新工作区归属与当前用户不匹配，保持冻结')
    }
    if (identity.expected_updated_at !== selectedShot.value.updated_at || identity.expected_source_sha256 !== localWork.value.source_fingerprint) {
      throw new Error('镜头或源片已变更，请重新载入工作区并人工核对动作素材')
    }
    const candidate = await redrawAPI.getMotionReference(shotId, identity, { signal: request.controller.signal })
      .catch(error => {
        if (missingMotionCandidate(error) && !hasPendingMotionOperation.value) {
          return missingMotionCandidateEnvelope(shotId, identity)
        }
        throw error
      })
    if (!request.current()) return
    validateMotionCandidate(candidate, shotId, identity)
    const [response, nextGate] = await Promise.all([
      redrawAPI.getReferenceBundle(shotId, options).catch(error => {
        const operation = motionOperations.value[operationScope]
        // A first upload may precede bundle creation; this is not ready evidence or a general 404 fallback.
        if (freshWork && operation?.phase === 'awaiting-refresh' && !operation.preparation && motionWorkOwned(nextWork)
          && operation.asset?.id === candidate.candidate?.asset.id && operation.asset?.sha256 === candidate.candidate?.asset.sha256
          && operation.expected_updated_at === identity.expected_updated_at && operation.expected_source_sha256 === identity.expected_source_sha256
          && (!operation.importId || operation.importId === candidate.candidate?.import_id)
          && currentShot.reference_bundle_hash === null && currentShot.reference_bundle_updated_at === null
          && error?.response?.status === 404 && error.response.data?.error?.code === 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND') return null
        throw error
      }),
      redrawAPI.getGenerationGate(versionId, options),
    ])
    if (!request.current()) return
    const evidence = referenceBundleEvidence(response, shotId)
    const matches = candidateMatchesBundle(response, candidate)
      || serverBundleStandsAlone(response, candidate, shotId)
    let blob = null
    if (candidate.status === 'available') {
      blob = await redrawAPI.getMotionReferenceMedia(shotId, { ...identity, expected_import_id: candidate.candidate.import_id,
        expected_file_sha256: candidate.candidate.asset.sha256 }, { signal: request.controller.signal })
      if (!request.current()) return
      validMotionBlob(blob)
    }
    if (readEpoch !== workReadEpoch) return
    if (freshWork) applyWork(nextWork)
    motionCandidates.value[String(shotId)] = candidate
    motionCandidateScopes.value[String(shotId)] = candidateScope
    setReferenceBundleState(shotId, { loaded: true, loading: false, response, evidence,
      ready: evidence.ready && matches, error: evidence.ready && matches ? '' : '动作素材与完整参考包尚未一致，禁止生成' })
    gate.value = nextGate || { ok: false, missing: [] }
    if (motionView.value.candidateUrl) URL.revokeObjectURL(motionView.value.candidateUrl)
    motionView.value.candidateUrl = blob ? URL.createObjectURL(blob) : ''
    motionView.value.status = candidate.status
    const operation = motionOperations.value[operationScope]
    if (operation) {
      const uploadedCandidate = freshWork && operation.phase === 'awaiting-refresh' && !operation.preparation
        && operation.asset?.id === candidate.candidate?.asset.id && operation.asset?.sha256 === candidate.candidate?.asset.sha256
        && operation.expected_updated_at === identity.expected_updated_at && operation.expected_source_sha256 === identity.expected_source_sha256
        && (!operation.importId || operation.importId === candidate.candidate?.import_id)
      if (uploadedCandidate && motionWorkOwned(nextWork) && Number(nextGate?.version_id) === Number(versionId)
        && typeof nextGate?.ok === 'boolean' && Array.isArray(nextGate?.missing)) {
        operation.importId = candidate.candidate.import_id
        motionPreparationProof.value = { scope: motionScope.value, epoch: motionActionEpoch,
          work: JSON.parse(JSON.stringify(nextWork)), candidate: JSON.parse(JSON.stringify(candidate)) }
      }
      if (uploadedCandidate && matches) {
        sessionStorage.removeItem(operationScope)
        if (sessionStorage.getItem(operationScope) !== null) throw new Error('上传待核对记录未能安全清除')
        delete motionOperations.value[operationScope]
        motionSelection.value = null
        motionView.value.processingResult = null
        motionView.value.resetSelection += 1
        motionView.value.error = ''
      } else {
        motionView.value.error = operation.phase === 'awaiting-refresh' ? '上传已接收，但新素材与参考包未完成一致性复核，保持冻结'
          : '上传结果尚未确认；读取当前候选不能证明该次上传终态，请人工核对，不会自动重发'
      }
    } else motionView.value.error = ''
    return evidence.ready && matches
  } catch (error) {
    if (request.current()) {
      motionView.value.error = errorReason(error, '读取动作素材失败，请人工核对')
      setReferenceBundleState(shotId, { ready: false, loading: false, error: motionView.value.error })
      if (motionView.value.candidateUrl) URL.revokeObjectURL(motionView.value.candidateUrl)
      motionView.value.candidateUrl = ''
    }
  } finally {
    motionControllers.delete(request.controller)
    if (request.current()) motionView.value.loading = false
  }
}
async function refreshMotionReference() {
  if (!currentMotionAuth() || motionView.value.processingLoading) return
  restoreMotionOperations()
  if (selectedMotionPreparation.value) return refreshMotionPreparation()
  await readMotionCandidate({ freshWork: true })
}

function motionWorkOwned(work, baseline = localWork.value) {
  return Boolean(work && baseline && String(work.user_id || '') === String(readSession()?.user?.id || '')
    && work.user_id != null && work.tenant_id != null
    && String(work.user_id) === String(baseline.user_id) && String(work.tenant_id) === String(baseline.tenant_id)
    && String(work.tenant_id) === String(readCurrentTenantId() || baseline.tenant_id)
    && Number(work.id) === Number(baseline.id)
    && Number(work.version_id || work.current_version_id) === Number(resolvedVersionId.value)
    && work.source_fingerprint === baseline.source_fingerprint)
}

function preparationShotContent(shot) {
  // Only preparation writes and computed pricing/availability are excluded; preparation_version is immutable here.
  const dynamic = new Set(['updated_at', 'preparation_state', 'preparation', 'stale_reason_code',
    'reference_bundle_hash', 'reference_bundle_updated_at', 'billing', 'quote', 'generation_snapshot', 'generation_availability'])
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  return JSON.stringify(canonical(Object.fromEntries(Object.entries(shot || {}).filter(([key]) => !dynamic.has(key)))))
}

function motionPreparationCurrent(attempt) {
  return !motionDisposed && attempt === selectedMotionPreparation.value && attempt.scope === motionScope.value
    && attempt.epoch === motionActionEpoch && motionWorkOwned(localWork.value, attempt.work)
}

function completedMotionPreparation(task, attempt) {
  const metadata = typeof task?.metadata === 'string' ? JSON.parse(task.metadata) : task?.metadata
  const result = typeof task?.result === 'string' ? JSON.parse(task.result) : task?.result
  const completed = [...(result?.prepared_shot_ids || []), ...(result?.reused_shot_ids || [])].map(Number).sort((a, b) => a - b)
  return Boolean(task?.id === attempt.taskId && task.type === 'redraw_reference_preparation'
    && String(task.user_id) === String(attempt.work.user_id) && String(task.tenant_id) === String(attempt.work.tenant_id)
    && new RegExp(`^redraw_reference_preparation:${attempt.versionId}:[a-f0-9]{64}$`, 'i').test(task.resource_id || '')
    && task.status === 'completed' && task.completed_at
    && metadata?.quote_hash === attempt.quote.quote_hash && metadata?.version_snapshot_hash === attempt.quote.version_snapshot_hash
    && Number(result?.version_id) === Number(attempt.versionId) && result?.quote_hash === attempt.quote.quote_hash
    && Array.isArray(result?.prepared_shot_ids) && Array.isArray(result?.reused_shot_ids)
    && Array.isArray(result?.failed_shot_ids) && result.failed_shot_ids.length === 0
    && Array.isArray(result?.needs_attention_shot_ids) && result.needs_attention_shot_ids.length === 0
    && JSON.stringify(completed) === JSON.stringify(attempt.shotIds))
}

async function refreshMotionPreparation() {
  const attempt = selectedMotionPreparation.value
  if (!attempt || preparationRefreshing.value || !motionPreparationCurrent(attempt)) return
  if (!attempt.taskId) { preparationError.value = '准备提交结果未知，保持原幂等键与上传记录，请人工核对'; return }
  preparationRefreshing.value = true
  const request = beginMotionRead(), current = () => request.current() && motionPreparationCurrent(attempt)
  const options = { signal: request.controller.signal, silentError: true }
  try {
    const task = await taskAPI.get(attempt.taskId)
    if (!current()) return
    if (!completedMotionPreparation(task, attempt)) {
      preparationError.value = '本次准备任务尚未完成有效终态核对，保持冻结；刷新不会再次提交'
      return
    }
    const nextWork = await redrawAPI.getWork(attempt.work.id, options)
    if (!current()) return
    const shotId = attempt.shotIds[0], nextShot = nextWork?.shots?.find(item => Number(item.id) === shotId)
    const previousShot = attempt.work.shots.find(item => Number(item.id) === shotId)
    if (!motionWorkOwned(nextWork, attempt.work) || !nextShot || !validMotionIdentity(motionIdentity(nextShot, nextWork))
      || preparationShotContent(nextShot) !== preparationShotContent(previousShot)
      || nextShot.preparation_state !== 'reference_ready' || nextShot.preparation?.status !== 'completed') {
      throw new Error('准备后的镜头业务内容或来源发生变化，保持冻结')
    }
    const identity = motionIdentity(nextShot, nextWork)
    const candidate = await redrawAPI.getMotionReference(shotId, identity, options).catch(error => {
      if (missingMotionCandidate(error) && !hasPendingMotionOperation.value) {
        return missingMotionCandidateEnvelope(shotId, identity)
      }
      throw error
    })
    if (!current()) return
    validateMotionCandidate(candidate, shotId, identity)
    if (candidate.status !== 'available' || candidate.candidate.import_id !== attempt.candidate.candidate.import_id
      || candidate.candidate.asset.id !== attempt.candidate.candidate.asset.id
      || candidate.candidate.asset.sha256 !== attempt.candidate.candidate.asset.sha256) throw new Error('准备后的动作素材已漂移，保持冻结')
    const [response, nextGate] = await Promise.all([redrawAPI.getReferenceBundle(shotId, options), redrawAPI.getGenerationGate(attempt.versionId, options)])
    if (!current()) return
    const evidence = referenceBundleEvidence(response, shotId)
    if (!evidence.ready || response.reference_bundle_hash !== nextShot.reference_bundle_hash
      || response.reference_bundle_updated_at !== nextShot.reference_bundle_updated_at
      || Number(response.bundle.motion_reference.asset_id) !== candidate.candidate.asset.id
      || response.bundle.motion_reference.sha256 !== candidate.candidate.asset.sha256
      || Number(nextGate?.version_id) !== Number(attempt.versionId) || typeof nextGate?.ok !== 'boolean'
      || !Array.isArray(nextGate?.missing)) throw new Error('准备后的参考包或门禁与当前候选不一致，保持冻结')
    const blob = await redrawAPI.getMotionReferenceMedia(shotId, { ...identity, expected_import_id: candidate.candidate.import_id,
      expected_file_sha256: candidate.candidate.asset.sha256 }, options)
    if (!current()) return
    validMotionBlob(blob)
    const operationScope = motionOperationScope.value
    sessionStorage.removeItem(operationScope)
    if (sessionStorage.getItem(operationScope) !== null) throw new Error('上传待核对记录未能安全清除')
    // The task proves this preparation completed; fresh content above authorizes adopting the current CAS.
    applyingMotionPreparation = true
    try { applyWork(nextWork) } finally { applyingMotionPreparation = false }
    delete motionOperations.value[operationScope]
    motionSelection.value = null
    motionCandidates.value[String(shotId)] = candidate
    motionCandidateScopes.value[String(shotId)] = motionScopeForShot(shotId)
    setReferenceBundleState(shotId, { loaded: true, loading: false, response, evidence, ready: true, error: '' })
    gate.value = nextGate
    motionView.value.candidateUrl = URL.createObjectURL(blob)
    motionView.value.status = 'available'
    motionView.value.error = ''
    preparationSubmissionLocked.value = false
    preparationIdempotencyKey.value = ''
    preparationError.value = ''
  } catch (error) {
    if (current()) preparationError.value = errorReason(error, '准备完成证据核对失败，保持冻结')
  } finally {
    motionControllers.delete(request.controller)
    if (request.current()) preparationRefreshing.value = false
  }
}

async function refreshReferencePreparation() {
  if (preparationSubmitting.value || preparationRefreshing.value) return
  if (selectedMotionPreparation.value) return refreshMotionPreparation()
  if (hasPendingMotionOperation.value) await refreshMotionReference()
  await loadPreparationWorkspace({ explicit: true })
}

async function uploadMotionReference(input = {}) {
  if (!currentMotionAuth(motionSelection.value?.owner) || input.scope !== motionScope.value || !restoreMotionOperations() || hasPendingMotionOperation.value
    || !motionSelection.value?.readable || motionSelection.value.file !== input.file || !validMotionIdentity(motionIdentity())
    || motionSelection.value.processing_report !== input.processing_report) return
  const file = input.file, checks = ['full_frame_reviewed', 'source_identity_obscured', 'source_text_obscured', 'motion_preserved']
  if (!file || file.type !== 'video/mp4' || !/\.mp4$/i.test(file.name) || file.size <= 0 || file.size > 200 * 1024 * 1024
    || !checks.every(key => input.confirmations?.[key] === true)) return
  const operationScope = motionOperationScope.value, shotId = selectedShot.value.id
  let marker
  try {
    marker = { scope: operationScope,
      idempotencyKey: `motion-${createReferencePreparationIdempotencyKey(typeof crypto === 'undefined' ? null : crypto)}`, ...motionIdentity() }
    sessionStorage.setItem(operationScope, JSON.stringify(marker))
    if (sessionStorage.getItem(operationScope) !== JSON.stringify(marker)) throw new Error('pending write not persisted')
  } catch (_) {
    motionStorageError.value = '无法安全保存上传待核对记录，未发送上传；生成已冻结'
    return
  }
  invalidateMotionReads()
  motionActionEpoch += 1
  workReadEpoch += 1
  const request = beginMotionRead()
  motionOperations.value[operationScope] = { ...marker, phase: 'uploading' }
  setReferenceBundleState(shotId, { ready: false, error: '动作素材上传后等待新证据复核' })
  try {
    const result = await redrawAPI.uploadMotionReference(shotId, file, { ...marker, ...input.confirmations,
      ...(input.processing_report === undefined ? {} : { processing_report: input.processing_report }) })
    if (!request.current()) {
      motionOperations.value[operationScope] = { ...marker, phase: 'unknown' }
      return
    }
    if (result?.purpose !== 'motion' || !validMotionAsset(result.asset)
      || !['credits', 'held', 'charged'].every(key => result.billing?.[key] === 0)) throw new Error('上传响应不完整，结果待人工核对')
    motionOperations.value[operationScope] = { ...marker, phase: 'awaiting-refresh', asset: result.asset }
    if (request.current()) await readMotionCandidate({ freshWork: true })
  } catch (error) {
    motionOperations.value[operationScope] = { ...marker, phase: responseStatus(error) === 409 ? 'conflict' : 'unknown' }
    if (request.current()) motionView.value.error = `${errorReason(error, '上传结果未知')}；保持冻结，请人工核对，不会自动重发`
  } finally {
    motionControllers.delete(request.controller)
  }
}

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
  if (selectedMotionPreparation.value) return refreshMotionPreparation()
  if (!localWork.value?.id || pollRequestActive) return
  const epoch = ++workReadEpoch
  pollRequestActive = true
  if (!quiet) refreshing.value = true
  try {
    const nextWork = await redrawAPI.getWork(localWork.value.id)
    if (epoch !== workReadEpoch || motionDisposed) return
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
  if (motionGenerationBlocked.value || !shot?.shot_id || shot.can_start_next_attempt !== true || !motionReferenceReady(shot.shot_id)) return
  const epoch = motionActionEpoch
  retryingDeliveryShotId.value = shot.shot_id
  try {
    if (referenceBundleRequired.value && !(await loadReferenceBundle(shot.shot_id))) return
    if (motionGenerationBlocked.value || epoch !== motionActionEpoch || !motionReferenceReady(shot.shot_id)) return
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
  const epoch = motionEpoch
  try {
    const [nextAssets, nextGate] = await Promise.all([
      redrawAPI.listAssets(resolvedVersionId.value),
      redrawAPI.getGenerationGate(resolvedVersionId.value),
    ])
    if (epoch !== motionEpoch || motionDisposed) return
    assets.value = Array.isArray(nextAssets) ? nextAssets : []
    gate.value = nextGate || { ok: false, missing: [] }
  } catch (error) {
    loadError.value = errorReason(error, '读取资产门禁失败')
  }
}

async function loadPreparationWorkspace({ explicit = false } = {}) {
  if (!currentMotionAuth() || motionPreparationBlocked.value || (hasPendingMotionOperation.value && !explicit)) return
  if (!resolvedVersionId.value || !referenceBundleRequired.value) {
    preparationGate.value = { ok: false, missing: [] }
    preparationQuote.value = null
    return
  }
  const versionId = resolvedVersionId.value
  const scope = motionScope.value, epoch = motionActionEpoch
  try {
    const [nextGate, nextQuote] = await Promise.all([
      redrawAPI.getPreparationGate(versionId),
      redrawAPI.quoteReferencePreparation(versionId, hasPendingMotionOperation.value ? { shot_ids: [Number(selectedShotId.value)] } : {}),
    ])
    if (scope !== motionScope.value || epoch !== motionActionEpoch || !currentMotionAuth()) return
    preparationGate.value = nextGate || { ok: false, missing: [] }
    preparationQuote.value = nextQuote || null
    preparationError.value = ''
  } catch (error) {
    if (scope !== motionScope.value || epoch !== motionActionEpoch || !currentMotionAuth()) return
    preparationError.value = errorReason(error, '读取逐镜参考准备状态失败')
  }
}

async function startReferencePreparation(input = {}) {
  if (!currentMotionAuth() || motionPreparationBlocked.value || preparationSubmitting.value || preparationSubmissionLocked.value || !resolvedVersionId.value) return
  const scope = motionScope.value, epoch = motionActionEpoch, workspaceScope = motionStoragePrefix.value
  const proof = canPrepareUploadedMotion.value ? motionPreparationProof.value : null
  const requested = Array.isArray(input.shot_ids) ? input.shot_ids.map(Number) : []
  if (proof && (requested.length !== 1 || requested[0] !== Number(selectedShotId.value))) return
  preparationSubmitting.value = true
  preparationSubmissionLocked.value = true
  let requestStarted = false
  try {
    const versionId = resolvedVersionId.value
    const requestedShotIds = Array.isArray(input.shot_ids) ? [...input.shot_ids] : []
    const scopedQuote = await redrawAPI.quoteReferencePreparation(versionId, { shot_ids: requestedShotIds })
    if (scope !== motionScope.value || epoch !== motionActionEpoch || !currentMotionAuth() || motionPreparationBlocked.value) return
    const scopedStart = buildReferencePreparationScopedStart(
      scopedQuote,
      requestedShotIds,
      resolvedVersionId.value,
      preparationQuote.value,
    )
    if (!preparationIdempotencyKey.value) {
      preparationIdempotencyKey.value = createReferencePreparationIdempotencyKey()
    }
    let attempt = null
    if (proof) {
      if (!HEX_SHA256.test(scopedQuote?.version_snapshot_hash || '')) throw new Error('准备报价作用域证据不完整')
      motionOperations.value[motionOperationScope.value].preparation = { ...proof, versionId, shotIds: requested,
        quote: scopedQuote, taskId: null, idempotencyKey: preparationIdempotencyKey.value }
      attempt = selectedMotionPreparation.value
    }
    const submission = redrawAPI.startReferencePreparation(versionId, {
      ...scopedStart,
      idempotency_key: preparationIdempotencyKey.value,
    })
    requestStarted = true
    const result = await submission
    if (scope !== motionScope.value || epoch !== motionActionEpoch || !currentMotionAuth()) return
    const settled = settleReferencePreparationSubmission({
      idempotencyKey: preparationIdempotencyKey.value,
      requestStarted,
      result,
    })
    preparationSubmissionLocked.value = settled.locked
    preparationIdempotencyKey.value = settled.idempotencyKey
    if (attempt) {
      if (['pending', 'processing', 'completed'].includes(result?.status) && /^[\w-]+$/.test(result?.task_id || '')
        && result.quote?.quote_hash === scopedQuote.quote_hash && result.quote?.version_snapshot_hash === scopedQuote.version_snapshot_hash
        && Number(result.quote?.version_id) === Number(versionId)) attempt.taskId = result.task_id
      await refreshMotionPreparation()
    } else {
      await refreshWork({ quiet: true })
      await loadPreparationWorkspace()
    }
    if (settled.outcome === 'needs_attention') ElMessage.warning('准备状态需要人工核对')
    else if (settled.outcome === 'unknown') ElMessage.warning('准备任务状态未知，请人工核对')
    else ElMessage.success('逐镜参考准备任务已创建')
  } catch (error) {
    if (scope !== motionScope.value || epoch !== motionActionEpoch || !currentMotionAuth()) return
    const settled = settleReferencePreparationSubmission({
      idempotencyKey: preparationIdempotencyKey.value,
      requestStarted,
      error,
    })
    preparationSubmissionLocked.value = settled.locked
    preparationIdempotencyKey.value = settled.idempotencyKey
    if (!settled.locked && selectedMotionPreparation.value) delete motionOperations.value[motionOperationScope.value].preparation
    if (settled.refreshWorkspace) await loadPreparationWorkspace()
    const fallback = settled.outcome === 'unknown'
      ? '逐镜参考准备提交状态未知，请人工核对'
      : '逐镜参考准备提交被拒绝，请重新确认服务端报价'
    preparationError.value = errorReason(error, fallback)
    ElMessage.error(preparationError.value)
  } finally {
    if (workspaceScope === motionStoragePrefix.value) {
      preparationSubmitting.value = false
      if (!requestStarted) preparationSubmissionLocked.value = false
    }
  }
}

async function openPreparationReview(shotId) {
  if (shotId != null) selectedShotId.value = shotId
  if (selectedMotionPreparation.value || hasPendingMotionOperation.value) return refreshMotionReference()
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
  if (!currentMotionAuth()) return false
  if (String(shotId) === String(selectedShotId.value) && motionView.value.loading) {
    await readMotionCandidate()
    return motionReferenceReady(shotId)
  }
  const shot = shots.value.find(item => Number(item.id) === Number(shotId))
  const identity = motionIdentity(shot), scope = motionScopeForShot(shotId)
  if (!shot || !validMotionIdentity(identity)) return false
  invalidateMotionProof(shotId)
  const request = { controller: new AbortController(), scope }
  referenceBundleControllers.set(String(shotId), request)
  const current = () => !motionDisposed && referenceBundleControllers.get(String(shotId)) === request
    && scope === motionScopeForShot(shotId) && currentMotionAuth()
  setReferenceBundleState(shotId, { loading: true, ready: false, error: '' })
  try {
    const options = { signal: request.controller.signal, silentError: true }
    const candidate = await redrawAPI.getMotionReference(shotId, identity, options).catch(error => {
      if (missingMotionCandidate(error) && !hasPendingMotionOperation.value) {
        return missingMotionCandidateEnvelope(shotId, identity)
      }
      throw error
    })
    if (!current()) return false
    validateMotionCandidate(candidate, shotId, identity)
    const response = await redrawAPI.getReferenceBundle(shotId, options)
    if (!current()) return false
    const evidence = referenceBundleEvidence(response, shotId)
    if (!candidateMatchesBundle(response, candidate, shotId)
      && !serverBundleStandsAlone(response, candidate, shotId)) evidence.ready = false
    motionCandidates.value[String(shotId)] = candidate
    motionCandidateScopes.value[String(shotId)] = scope
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
    if (!current()) return false
    setReferenceBundleState(shotId, {
      loaded: true,
      loading: false,
      ready: false,
      evidence: {},
      response: null,
      error: errorReason(error, '读取逐镜参考包失败'),
    })
    return false
  } finally {
    if (referenceBundleControllers.get(String(shotId)) === request) referenceBundleControllers.delete(String(shotId))
  }
}

async function loadAllReferenceBundles() {
  if (!referenceBundleRequired.value) {
    referenceBundles.value = {}
    return
  }
  for (const [shotId, request] of referenceBundleControllers) {
    if (request.scope !== motionScopeForShot(shotId)) { request.controller.abort(); referenceBundleControllers.delete(shotId) }
  }
  await Promise.all(shots.value.filter(shot => !motionReferenceReady(shot.id)
    && !(String(shot.id) === String(selectedShotId.value) && motionView.value.loading)).map(shot => loadReferenceBundle(shot.id)))
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
  if (motionGenerationBlocked.value || !selectedShot.value?.id || !motionReferenceReady(selectedShotId.value)) return
  const epoch = motionActionEpoch
  shotGenerating.value = true
  try {
    const saved = await saveShot(update, { silent: true })
    if (!saved || motionSubmissionBlocked.value || epoch !== motionActionEpoch) return
    // Saving may advance this shot's CAS; generation must wait for a new candidate proof.
    if (referenceBundleRequired.value) await readMotionCandidate()
    if (motionGenerationBlocked.value || epoch !== motionActionEpoch) return
    if (referenceBundleRequired.value && !(await loadReferenceBundle(saved.id))) {
      ElMessage.error('镜头保存后参考包复核未通过，未提交生成任务')
      return
    }
    if (motionGenerationBlocked.value || epoch !== motionActionEpoch) return
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
  if (motionGenerationBlocked.value || !localWork.value?.id || !shotIds.length) return
  const epoch = motionActionEpoch
  batchGenerating.value = true
  try {
    let verifiedShotIds = shotIds
    if (referenceBundleRequired.value) {
      const candidates = shotIds.filter((shotId) => motionReferenceReady(shotId))
      const rechecked = await Promise.all(candidates.map((shotId) => loadReferenceBundle(shotId)))
      verifiedShotIds = candidates.filter((_shotId, index) => rechecked[index] === true)
    }
    if (!verifiedShotIds.length || motionGenerationBlocked.value || epoch !== motionActionEpoch) return
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
  if (String(nextWork.id) !== String(localWork.value?.id)) motionWorkAuth = readMotionAuth(nextWork)
  const nextShot = nextWork.shots?.find(shot => String(shot.id) === String(selectedShotId.value))
  if (nextShot?.updated_at !== selectedShot.value?.updated_at) motionActionEpoch += 1
  localWork.value = nextWork
  selectedShotId.value = restoreSelectedShotId(state.value.shots, selectedShotId.value)
}, { immediate: true, flush: 'sync' })
watch(motionScope, () => {
  invalidateMotionReads()
  invalidateMotionProof(selectedShotId.value)
  workReadEpoch += 1
  motionSelection.value = null
  clearMotionMedia()
  motionView.value = { status: 'missing', draftUrl: '', candidateUrl: '', error: '', loading: false, draftLoading: false,
    processingLoading: false, processingResult: null,
    resetSelection: motionView.value.resetSelection + 1 }
  restoreMotionOperations()
  if (!applyingMotionPreparation) readMotionCandidate()
}, { immediate: true, flush: 'sync' })
watch(() => `${motionOperationScope.value}:${localWork.value?.source_fingerprint || ''}`, () => {
  motionActionEpoch += 1
}, { flush: 'sync' })
watch(resolvedVersionId, loadAssetsAndGate)
watch(() => preparationShotContent(selectedShot.value), () => {
  if (hasPendingMotionOperation.value && !applyingMotionPreparation) {
    motionActionEpoch += 1
    invalidateMotionReads()
  }
}, { flush: 'sync' })
watch(resolvedVersionId, loadGenerationSummary)
watch(motionStoragePrefix, () => {
  preparationSubmitting.value = false
  preparationSubmissionLocked.value = Boolean(selectedMotionPreparation.value)
  preparationIdempotencyKey.value = selectedMotionPreparation.value?.idempotencyKey || ''
  loadPreparationWorkspace()
}, { flush: 'sync' })
watch(
  () => `${referenceBundleRequired.value}:${motionStoragePrefix.value}:${localWork.value?.source_fingerprint || ''}:${shots.value.map(shot => `${shot.id}:${shot.updated_at}`).join(',')}`,
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
onMounted(() => {
  if (typeof window === 'undefined') return
  window.addEventListener('storage', checkMotionAuthStorage)
  window.addEventListener('focus', checkMotionAuthFocus)
  currentMotionAuth()
})
onBeforeUnmount(stopPolling)
onBeforeUnmount(() => {
  motionDisposed = true
  invalidateMotionReads()
  workReadEpoch += 1
  clearMotionMedia()
  motionSelection.value = null
  motionView.value.processingResult = null
  for (const request of referenceBundleControllers.values()) request.controller.abort()
  referenceBundleControllers.clear()
  if (typeof window !== 'undefined') {
    window.removeEventListener('storage', checkMotionAuthStorage)
    window.removeEventListener('focus', checkMotionAuthFocus)
  }
})
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
