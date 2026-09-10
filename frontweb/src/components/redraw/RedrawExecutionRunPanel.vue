<template>
  <section class="execution-run" aria-label="执行记录">
    <h4>执行记录</h4>
    <p>读取记录和检查条件不会生成。只有确认本次积分后，显式推进才可能提交一次生成。</p>
    <p v-if="!contextReady" role="status">当前账号、项目策略、计划审核或队列已失效，请先刷新。</p>
    <div class="run-actions">
      <el-button :disabled="!canRefreshRuns" @click="refreshRuns">刷新执行记录</el-button>
      <el-button :disabled="!canCreate" @click="createRun">创建执行记录（不生成）</el-button>
    </div>
    <p v-if="listLoaded">当前执行记录：{{ currentRunId == null ? '尚未创建' : `#${currentRunId}` }}</p>
    <label v-if="runs.length">当前与历史记录
      <select :value="selectedRunId || ''" aria-label="选择执行记录" @change="selectRun(Number($event.target.value))">
        <option value="" disabled>请选择记录</option>
        <option v-for="item in runs" :key="item.id" :value="item.id">#{{ item.id }} · {{ item.status }}{{ item.id === currentRunId ? '（当前）' : '（历史）' }}</option>
      </select>
    </label>
    <template v-if="run">
      <p>执行 #{{ run.id }} · 状态 {{ run.status }} · 修订 {{ run.revision }}</p>
      <el-button :disabled="!currentRun || Boolean(reading)" @click="viewUnitDelivery">查看此执行记录的导出准备</el-button>
      <el-button :disabled="!canPause" @click="pauseRun">请求暂停（不生成）</el-button>
      <p v-if="!currentRun">此记录仅供查看，不适用于当前审核队列。</p>
      <label>分辨率
        <select v-model="selectedResolution" aria-label="生成分辨率" :disabled="!currentRun">
          <option value="" disabled>请选择支持的分辨率</option>
          <option v-for="value in resolutions" :key="value" :value="value">{{ value }}</option>
        </select>
      </label>
      <label>画面比例
        <select v-model="selectedAspectRatio" aria-label="生成画面比例" :disabled="!currentRun">
          <option value="" disabled>请选择支持的比例</option>
          <option v-for="value in aspectRatios" :key="value" :value="value">{{ value }}</option>
        </select>
      </label>
      <el-button :disabled="!canReadiness" @click="loadReadiness">检查本次执行条件（只读）</el-button>
      <p class="credit-callout"><strong>{{ validReadiness ? `本次预计扣除 ${readiness.amount} 积分` : '积分待管理员配置' }}</strong></p>
      <p v-if="readiness?.status === 'blocked'" role="status">本次执行条件未就绪：{{ readiness.reason_codes?.join('、') }}</p>
      <label><input type="checkbox" :checked="Boolean(confirmation)" :disabled="!canConfirm" @change="$event.target.checked ? confirmAction() : clearConfirmation()" />我确认当前参数及本次预计积分，仅执行本次{{ readiness?.action === 'resume' ? '解暂停' : '推进' }}</label>
      <el-button v-if="run.pause_requested" type="primary" :disabled="!canResume" @click="resumeRun">确认并解暂停（不生成）</el-button>
      <el-button v-else type="primary" :disabled="!canAdvance" @click="advanceRun">确认并推进一次</el-button>
      <p v-if="run.pause_requested">解暂停不会生成；解暂停后须重新检查并单独确认，才能推进。</p>
      <div v-for="attempt in recoverableAttempts" :key="attempt.id">
        <el-button :disabled="!canRecover(attempt.id)" @click="recoverAttempt(attempt.id)">显式核对原尝试 #{{ attempt.id }}（不重新生成）</el-button>
      </div>
      <div v-for="unit in candidateUnits" :key="unit.id">
        <el-button :disabled="Boolean(reading)" @click="loadCandidate(unit.id)">读取候选 {{ unit.ordinal + 1 }}（只读）</el-button>
      </div>
    </template>
    <section v-if="candidate" class="candidate-review" aria-label="候选播放与逐项人审">
      <h4>候选 {{ candidate.ordinal + 1 }} · {{ candidate.status }}</h4>
      <p>执行 #{{ candidate.run_id }} / 单元 {{ candidate.unit_id }} / 尝试 #{{ candidate.attempt_id }} / 修订 {{ candidate.run_revision }}</p>
      <p>候选指纹 {{ candidate.candidate_hash }} · 媒体指纹 {{ candidate.asset.sha256 }}</p>
      <video v-if="candidateUrl" :ref="bindCandidateVideo" :src="candidateUrl" controls playsinline preload="auto"
        aria-label="受控候选视频" @loadeddata="candidateLoaded" @error="candidateMediaError" />
      <p v-if="!mediaReady">媒体尚未确认可播放；不能提交人工审核。</p>
      <p>技术检查：{{ candidate.technical_qa?.method }} / {{ candidate.technical_qa?.status }}。机器内容证据：{{ candidate.content_qa?.machine_evidence }}。技术通过不代表内容通过，auto 策略仍须人审。</p>
      <p>最终音轨审核：{{ candidate.content_qa?.final_audio_review }}。replace 分支的音轨须在合成后另行听审。</p>
      <details open>
        <summary>目标名字、对白与镜头要求（人工对照）</summary>
        <p v-for="(name, id) in candidate.target_contract.character_name_map" :key="id">{{ id }} → {{ name }}</p>
        <p v-for="(dialogue, index) in candidate.target_contract.dialogues" :key="index">{{ dialogue.unit_start_ms }}–{{ dialogue.unit_end_ms }} ms · {{ dialogue.target_speaker_name }}：{{ dialogue.target_text }} · 情绪 {{ dialogue.emotion }} · 发音 {{ dialogue.pronunciation_hint }}</p>
        <p v-for="(shot, index) in candidate.target_contract.shots" :key="index">{{ shot.unit_start_ms }}–{{ shot.unit_end_ms }} ms · 构图 {{ shot.composition }} · 运镜 {{ shot.camera_movement }} · 开始 {{ shot.opening_state }} · 连续动作 {{ shot.continuous_action }} · 结束 {{ shot.ending_state }}</p>
      </details>
      <label v-for="key in candidate.required_checks" :key="key">{{ checkLabels[key] || key }}
        <select :value="reviewChecks[key]" :data-review-check="key" :aria-label="checkLabels[key] || key" :disabled="!canEditCandidate"
          @change="setReviewCheck(key, $event.target.value)">
          <option value="not_checked">尚未人工检查</option><option value="passed">人工听看：通过</option><option value="failed">人工听看：不通过</option>
        </select>
      </label>
      <label><input type="checkbox" aria-label="我已实际播放并逐项听看本候选" :checked="reviewAcknowledged" :disabled="!canEditCandidate"
        @change="acknowledgeReview($event.target.checked)" />我已实际播放并逐项听看本候选；以上结果由我明确确认。</label>
      <div class="run-actions">
        <el-button :disabled="!canApproveCandidate" @click="reviewCandidate('approved')">批准本候选（不推进）</el-button>
        <el-button :disabled="!canRejectCandidate" @click="reviewCandidate('rejected')">拒绝本候选（不退款、不重试）</el-button>
      </div>
      <p v-if="candidate.review">已保存决定：{{ candidate.review.decision }}。此候选不能改判；候选通过不等于整次执行或成片完成。</p>
    </section>
    <p v-if="reviewNotice" role="status">{{ reviewNotice }}</p>
    <p v-if="reading" role="status">正在只读核对执行记录…</p>
    <p v-if="operationNotice" role="status">{{ operationNotice }}</p>
    <p v-if="submissionReceipt && contextReady && submissionReceipt.run_id === selectedRunId" role="status">执行 #{{ submissionReceipt.run_id }} 已保留本次提交回执，不会自动重提。任务 #{{ submissionReceipt.task_id }} · 供应商任务 {{ submissionReceipt.provider_task_id || '尚未确认' }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<script>
import { reactive } from 'vue'

// A component unmount must not release an in-flight or unknown POST.
const runOperations = reactive(new Map())
const activeOperations = reactive(new Set())
</script>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { redrawAPI } from '@/api/redraw'
import { readCurrentTenantId, readSession } from '@/utils/authSession'

const props = defineProps({ record: { type: Object, required: true }, preview: Object, savedReview: Object, queue: Object,
  blocked: { type: Boolean, default: false }, projectPolicy: Object })
const emit = defineEmits(['unit-delivery-requested'])
const runs = ref([]), currentRunId = ref(null), selectedRunId = ref(null), run = ref(null), listLoaded = ref(false)
const selectedResolution = ref(''), selectedAspectRatio = ref(''), readiness = ref(null), confirmation = ref(null)
const reading = ref(''), error = ref(''), submissionReceipt = ref(null)
const candidate = ref(null), candidateUrl = ref(''), mediaReady = ref(false)
const reviewChecks = ref({}), reviewAcknowledged = ref(false)
let candidateTicket = null, candidateVideo = null
const storageBlocked = ref(false)
const ownerEpoch = ref(0)
const defaultOwnerProof = ref(null)
const operationPrefix = 'redraw-execution-run-operation-v1:'
let sequence = 0, alive = true, controller = null
const positive = value => Number.isSafeInteger(value) && value > 0
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
function ownerSelection() {
  ownerEpoch.value
  try {
    const session = readSession(), tenant = readCurrentTenantId()
    return session?.token && session.user?.id != null ? [tenant ? String(tenant) : null, String(session.user.id)] : null
  } catch { return null }
}
function owner() {
  const selection = ownerSelection(), proof = defaultOwnerProof.value
  if (!selection) return null
  if (selection[0]) return selection
  return proof?.selection === stable(selection) && proof.epoch === ownerEpoch.value
    && proof.project_id === props.projectPolicy?.project_id ? proof.identity : null
}
function policyValid(value) { return value && ['safe', 'auto'].includes(value.execution_mode) && positive(value.policy_version) }
function contextValid(identity = owner()) {
  const p = props.preview, r = props.savedReview, q = props.queue, record = props.record, policy = props.projectPolicy
  return alive && !props.blocked && identity && p?.status === 'ready' && p.executable === false && sha(p.plan_hash)
    && r?.status === 'current' && positive(r.id) && r.plan_hash === p.plan_hash && stable(r.plan) === stable(p)
    && q?.status === 'waiting_readiness' && q.executable === false && positive(q.id) && q.plan_hash === p.plan_hash
    && positive(q.work_id) && q.work_id === p.bindings?.work_id && q.version_id === Number(record.version_id)
    && p.bindings?.version_id === Number(record.version_id) && p.bindings.blueprint_hash === record.blueprint_hash
    && p.bindings.localization_hash === record.localization_hash && p.bindings.localization_updated_at === record.updated_at
    && identity[0] === String(p.bindings.tenant_id) && identity[1] === String(p.bindings.user_id)
    && policyValid(policy) && positive(policy.project_id) && Number.isSafeInteger(policy.epoch) && policy.epoch >= 0
    && Array.isArray(p.units) && p.units.length > 0 && Array.isArray(q.units) && q.units.length === p.units.length
    && q.units.every((unit, ordinal) => unit.ordinal === ordinal && unit.status === 'pending' && sha(unit.unit_hash)
      && unit.id === p.units[ordinal]?.id && stable(unit.plan_unit) === stable(p.units[ordinal]))
}
const contextReady = computed(() => Boolean(contextValid()))
function canResolveDefaultOwner() {
  const selection = ownerSelection(), policy = props.projectPolicy
  return alive && !props.blocked && selection?.[0] === null && Boolean(selection[1].trim())
    && policyValid(policy) && positive(policy.project_id) && Number.isSafeInteger(policy.epoch) && policy.epoch >= 0
}
const canRefreshRuns = computed(() => !reading.value && (contextReady.value || canResolveDefaultOwner()))
const resolutions = computed(() => props.preview?.capability?.resolutions || [])
const aspectRatios = computed(() => props.preview?.capability?.aspect_ratios || [])
const parametersValid = computed(() => resolutions.value.includes(selectedResolution.value) && aspectRatios.value.includes(selectedAspectRatio.value))
function scopeKey() {
  return stable([owner(), props.projectPolicy?.project_id, props.queue?.work_id, Number(props.record.version_id),
    props.savedReview?.id, props.queue?.id, props.preview?.plan_hash])
}
function context() {
  return stable([owner(), ownerEpoch.value, props.record, props.preview, props.savedReview, props.queue, props.blocked, props.projectPolicy,
    selectedRunId.value, run.value, selectedResolution.value, selectedAspectRatio.value])
}
function operationStorage() {
  if (typeof sessionStorage === 'undefined' || !sessionStorage
    || typeof sessionStorage.getItem !== 'function' || typeof sessionStorage.setItem !== 'function'
    || typeof sessionStorage.key !== 'function' || !Number.isSafeInteger(sessionStorage.length) || sessionStorage.length < 0) throw Error('操作存储不可用')
  return sessionStorage
}
function operationKey(value) { return stable([value.scope, value.action, value.hash]) }
function canReconcile(operation) {
  return ['pending', 'unknown'].includes(operation.status) && !activeOperations.has(operationKey(operation))
}
function scopedOperations(scope = scopeKey()) {
  const storage = operationStorage(), entries = new Map()
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (typeof key !== 'string' || !key.startsWith(operationPrefix)) continue
    const value = JSON.parse(storage.getItem(key))
    if (!value || typeof value.scope !== 'string') throw Error('操作存储无效')
    if (value.scope !== scope) continue
    if (!['create', 'advance', 'pause', 'resume', 'recover', 'review'].includes(value.action)
      || !['pending', 'unknown', 'received'].includes(value.status) || typeof value.hash !== 'string'
      || key !== operationPrefix + operationKey(value)) throw Error('操作存储绑定无效')
    entries.set(operationKey(value), value)
  }
  for (const [key, value] of runOperations) if (value.scope === scope) entries.set(key, value)
  return [...entries.values()]
}
function locked(action, hash) {
  try {
    if (storageBlocked.value) return true
    return scopedOperations().some(item => {
      if (action === 'recover') return item.action === action && item.hash === hash && activeOperations.has(operationKey(item))
      if (action === 'pause') return item.action === action && item.hash === hash
      return item.status === 'pending' || (['create', 'advance', 'resume', 'review'].includes(item.action) && item.status === 'unknown')
        || (item.action === action && item.hash === hash)
        || (item.action === 'pause' && item.status === 'unknown' && item.run_revision === run.value?.revision)
    })
  } catch { return true }
}
const operationNotice = computed(() => {
  if (!contextReady.value) return ''
  try {
    if (storageBlocked.value) return '本地操作存储无法可靠核对，已阻止新的提交。'
    const unresolved = scopedOperations().find(item => item.status !== 'received')
    return unresolved ? '有尚未确认的本地操作，防重状态仍保留；不会自动重提。原尝试只能由你显式核对。' : ''
  } catch { return '本地操作存储不可用，已阻止提交；读取记录不会生成。' }
})
function checkedRun(value, current = false) {
  const q = props.queue
  if (!value || !positive(value.id) || value.work_id !== q.work_id || value.version_id !== q.version_id
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.executable !== false || !Array.isArray(value.units)) throw Error('执行记录返回无效')
  if (current && (value.binding_status !== 'current' || value.queue_id !== q.id || value.review_id !== props.savedReview.id
    || value.plan_hash !== props.preview.plan_hash || value.units.length !== q.units.length
    || value.units.some((unit, index) => unit.id !== q.units[index].id || unit.ordinal !== index || unit.unit_hash !== q.units[index].unit_hash))) {
    throw Error('执行记录与当前审核队列不一致')
  }
  return value
}
const currentRun = computed(() => {
  if (!contextReady.value || run.value?.id !== currentRunId.value) return false
  try { checkedRun(run.value, true); return true } catch { return false }
})
function readyValid(value) {
  const policy = props.projectPolicy, unit = run.value?.units.find(item => item.status !== 'approved')
  const attempt = unit?.attempts?.at(-1)
  const phaseValid = value?.phase === 'idle' ? value.attempt_id === null && unit?.status === 'pending' && !unit.attempts?.length
    : ['claimed_unbound', 'claimed_bound'].includes(value?.phase) && positive(value.attempt_id)
      && unit?.status === 'claimed' && attempt?.status === 'claimed' && attempt.id === value.attempt_id
      && stable(run.value.output_parameters) === stable(parameters())
  return currentRun.value && parametersValid.value && value?.schema_version === 'redraw-execution-run-advance-readiness-v1'
    && ['ready', 'running', 'paused'].includes(run.value.status)
    && value.status === 'ready' && value.executable === false && value.action === (run.value.pause_requested ? 'resume' : 'advance') && phaseValid
    && value.run_id === run.value.id && value.run_revision === run.value.revision && value.plan_hash === props.preview.plan_hash
    && unit?.id === value.unit_id
    && stable(value.output_parameters) === stable(parameters()) && sha(value.quote_hash) && sha(value.confirmation_hash)
    && typeof value.amount === 'number' && Number.isFinite(value.amount)
    && ((value.billing_mode === 'paid' && value.amount > 0) || (value.billing_mode === 'no_charge' && value.amount === 0))
    && policyValid(value.policy) && value.policy.execution_mode === policy.execution_mode && value.policy.policy_version === policy.policy_version
}
const validReadiness = computed(() => Boolean(readyValid(readiness.value)))
const canCreate = computed(() => contextReady.value && listLoaded.value && currentRunId.value === null && !reading.value && !locked('create', ''))
const canReadiness = computed(() => currentRun.value && parametersValid.value && !reading.value)
const canConfirm = computed(() => validReadiness.value && !reading.value && !locked(readiness.value.action, readiness.value.confirmation_hash))
function confirmed(action) {
  return canConfirm.value && readiness.value.action === action && confirmation.value?.action === action
    && confirmation.value?.sequence === sequence && confirmation.value?.context === context()
    && confirmation.value?.hash === readiness.value.confirmation_hash
}
const canAdvance = computed(() => confirmed('advance'))
const canResume = computed(() => confirmed('resume'))
const canPause = computed(() => currentRun.value && !reading.value && !run.value.pause_requested
  && ['ready', 'running', 'paused', 'waiting_review', 'needs_attention'].includes(run.value.status)
  && !locked('pause', stable([run.value.id, run.value.revision])))
const recoverableAttempts = computed(() => {
  if (!currentRun.value) return []
  let unresolved = []
  try { unresolved = scopedOperations().filter(item => item.action === 'advance' && canReconcile(item)) } catch { /* No terminal action without local proof. */ }
  return run.value.units.flatMap(unit => (unit.attempts || []).filter(attempt => positive(attempt.id)
    && (['submitting', 'running', 'needs_attention'].includes(attempt.status)
      || ['waiting_review', 'approved', 'rejected', 'failed'].includes(attempt.status)
        && unresolved.some(item => advanceProofMatches(item, run.value, unit.id, attempt.id)))))
})
function canRecover(id) {
  return contextValid() && currentRun.value && !reading.value && positive(id)
    && recoverableAttempts.value.some(attempt => attempt.id === id) && !locked('recover', stable([run.value.id, id]))
}
function parameters() { return { resolution: selectedResolution.value, aspect_ratio: selectedAspectRatio.value } }
function clearConfirmation() { confirmation.value = null }
function invalidate() {
  clearCandidate()
  sequence++; controller?.abort(); controller = null; reading.value = ''; readiness.value = null; clearConfirmation(); error.value = ''
}
function current(ticket) { return alive && ticket.sequence === sequence && ticket.context === context() && contextValid() }
function beginRead(kind) {
  invalidate(); controller = new AbortController(); reading.value = kind
  return { sequence, context: context(), controller }
}
function finishRead(ticket) { if (ticket.sequence === sequence) { controller = null; reading.value = '' } }
function ownerProofContext() {
  return stable([ownerSelection(), ownerEpoch.value, props.record, props.preview, props.savedReview, props.queue,
    props.blocked, props.projectPolicy])
}
function ownerProofCurrent(ticket) { return alive && ticket.sequence === sequence && ticket.proofContext === ownerProofContext() }
async function resolveDefaultOwner() {
  if (!canResolveDefaultOwner() || reading.value) return false
  const projectId = props.projectPolicy.project_id, selection = ownerSelection(), ticket = beginRead('owner')
  ticket.proofContext = ownerProofContext()
  try {
    const value = await redrawAPI.getProject(projectId)
    if (!ownerProofCurrent(ticket)) return false
    const userId = value?.user_id, tenantId = value?.tenant_id
    if (!value || Array.isArray(value) || value.id !== projectId || typeof tenantId !== 'string' || !tenantId.trim()
      || !((typeof userId === 'string' && userId.trim()) || positive(userId)) || String(userId) !== selection[1]
      || !contextValid([tenantId, String(userId)])) throw Error('项目归属与当前审核队列不一致')
    defaultOwnerProof.value = { selection: stable(selection), epoch: ownerEpoch.value, project_id: projectId, identity: [tenantId, String(userId)] }
    return true
  } catch {
    if (ownerProofCurrent(ticket)) {
      defaultOwnerProof.value = null
      error.value = '当前项目归属未通过核对，请显式刷新；不会选择租户、创建或推进'
    }
    return false
  } finally { finishRead(ticket) }
}
async function refreshRuns() {
  if (!contextValid() && !await resolveDefaultOwner()) return
  if (!contextValid()) return
  selectedRunId.value = null; run.value = null; listLoaded.value = false
  const ticket = beginRead('list')
  try {
    const value = await redrawAPI.listExecutionRuns(Number(props.record.version_id), { signal: ticket.controller.signal })
    if (!current(ticket)) return
    if (value?.version_id !== props.queue.version_id || !Array.isArray(value.runs)
      || !(value.current_run_id === null || positive(value.current_run_id))) throw Error('执行记录列表返回无效')
    value.runs.forEach(item => checkedRun(item))
    if (value.current_run_id !== null && !value.runs.some(item => item.id === value.current_run_id)) throw Error('当前执行记录缺失')
    runs.value = value.runs; currentRunId.value = value.current_run_id; listLoaded.value = true
  } catch {
    if (current(ticket)) error.value = '读取执行记录失败，请显式刷新；不会自动创建或推进'
  } finally { finishRead(ticket) }
}
async function selectRun(id) {
  if (!contextValid() || !positive(id) || !runs.value.some(item => item.id === id)) return
  selectedRunId.value = id; run.value = null
  const ticket = beginRead('detail')
  try {
    const value = await redrawAPI.getExecutionRun(Number(props.record.version_id), id, { signal: ticket.controller.signal })
    if (!current(ticket)) return
    if (value?.id !== id) throw Error('执行记录身份不一致')
    run.value = checkedRun(value, id === currentRunId.value)
    reconcileControl('create')
    reconcileControl('pause')
  } catch {
    if (current(ticket)) error.value = '执行记录失效或读取失败，请显式刷新'
  } finally { finishRead(ticket) }
}
async function viewUnitDelivery() {
  if (!contextValid() || !currentRun.value || reading.value) return
  const id = selectedRunId.value, ticket = beginRead('delivery')
  try {
    const value = await redrawAPI.getExecutionRun(Number(props.record.version_id), id, { signal: ticket.controller.signal })
    if (!current(ticket)) return
    if (value?.id !== id) throw Error('执行记录身份不一致')
    checkedRun(value, true)
    emit('unit-delivery-requested', { project_id: props.projectPolicy.project_id, work_id: value.work_id,
      version_id: value.version_id, run_id: value.id, plan_hash: value.plan_hash, run_revision: value.revision,
      owner: [...owner()], project_policy: { ...props.projectPolicy } })
  } catch {
    if (current(ticket)) error.value = '导出准备的执行记录未通过核验，请显式刷新；不会进入合成或生成'
  } finally { finishRead(ticket) }
}
async function loadReadiness() {
  if (!contextValid() || !canReadiness.value) return
  const ticket = beginRead('readiness')
  try {
    const value = await redrawAPI.getExecutionRunReadiness(Number(props.record.version_id), run.value.id, parameters(), { signal: ticket.controller.signal })
    if (!current(ticket)) return
    if (value?.status === 'blocked' && value.run_id === run.value.id && value.run_revision === run.value.revision) {
      readiness.value = value; return
    }
    if (!readyValid(value)) throw Error('本次费用、策略或执行绑定尚未核验')
    readiness.value = value
    reconcileControl('resume', value)
  } catch {
    if (current(ticket)) error.value = '本次参数、积分或项目策略未通过核对，不能确认；请重新检查'
  } finally { finishRead(ticket) }
}
function confirmAction() {
  if (!contextValid() || !canConfirm.value) return
  confirmation.value = { sequence, context: context(), hash: readiness.value.confirmation_hash, action: readiness.value.action }
}
function writeOperation(operation) {
  const storage = operationStorage(), key = operationPrefix + operationKey(operation), value = JSON.stringify(operation)
  storage.setItem(key, value)
  if (storage.getItem(key) !== value) throw Error('操作存储核对失败')
}
function reserve(action, hash, attemptId = readiness.value?.attempt_id ?? null, unitId = readiness.value?.unit_id ?? null, review = null) {
  if (locked(action, hash)) return null
  const boundContext = context(), scope = scopeKey()
  let operation
  try {
    const records = scopedOperations(scope), previous = records.find(item => item.action === action && item.hash === hash)
    const knownReceipt = action === 'recover' ? records.filter(item => item.receipt?.run_id === run.value.id
      && item.receipt.attempt_id === attemptId && receiptValid(item.receipt, item)).at(-1)?.receipt : null
    operation = { scope, action, hash, status: 'pending', receipt: previous?.receipt ?? knownReceipt ?? null,
      run_id: run.value?.id ?? null, run_revision: run.value?.revision ?? null, unit_id: unitId, attempt_id: attemptId,
      phase: readiness.value?.phase ?? null, output_parameters: readiness.value ? { ...readiness.value.output_parameters } : null,
      policy: { execution_mode: props.projectPolicy.execution_mode, policy_version: props.projectPolicy.policy_version, epoch: props.projectPolicy.epoch },
      ...(action === 'review' ? { review, review_asset: { ...candidate.value.asset } } : {}) }
    writeOperation(operation)
    if (!contextValid() || context() !== boundContext) return null
  } catch {
    storageBlocked.value = true
    error.value = '无法可靠保存本次操作的防重状态，已阻止提交；不会自动重试'
    return null
  }
  const key = operationKey(operation)
  activeOperations.add(key)
  runOperations.set(key, operation)
  return runOperations.get(key)
}
function receiptSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.schema_version === 'redraw-execution-unit-candidate-review-v1') return {
    schema_version: value.schema_version, run_id: value.run_id, run_revision: value.run_revision, unit_id: value.unit_id,
    attempt_id: value.attempt_id, candidate_hash: value.candidate_hash, status: value.status,
    review: value.review ? { decision: value.review.decision, checks: JSON.parse(JSON.stringify(value.review.checks)),
      reviewed_at: value.review.reviewed_at, review_hash: value.review.review_hash } : null,
  }
  const pick = (object, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(object, key)
    && (object[key] === null || ['string', 'number', 'boolean'].includes(typeof object[key]))).map(key => [key, object[key]]))
  const result = pick(value, ['id', 'revision', 'work_id', 'version_id', 'queue_id', 'review_id', 'plan_hash', 'binding_status',
    'run_id', 'run_revision', 'run_status', 'pause_requested', 'attempt_id', 'attempt_status', 'task_id', 'status', 'provider_task_id',
    'newly_submitted', 'receipt_persisted', 'fallback_receipt_persisted', 'changed', 'executable', 'amount', 'billing_mode'])
  if (value.recovery_receipt && typeof value.recovery_receipt === 'object') result.recovery_receipt = pick(value.recovery_receipt,
    ['schema_version', 'tenant_id', 'user_id', 'work_id', 'version_id', 'run_id', 'attempt_id', 'task_id', 'request_hash',
      'submit_started_at', 'provider_task_id', 'status', 'reason_code'])
  return result
}
function receiptValid(value, operation) {
  if (value?.run_id !== operation.run_id || !positive(value.attempt_id)
    || (operation.attempt_id !== null && operation.attempt_id !== value.attempt_id)
    || typeof value.task_id !== 'string' || !value.task_id.trim()
    || typeof value.provider_task_id !== 'string' || !value.provider_task_id.trim() || value.executable !== false) return false
  if (value.run_revision !== undefined && (!Number.isSafeInteger(value.run_revision) || value.run_revision < operation.run_revision)) return false
  if (value.recovery_receipt !== undefined) {
    const inner = value.recovery_receipt, scope = JSON.parse(operation.scope)
    if (inner?.schema_version !== 'redraw-execution-unit-safe-receipt-v1' || String(inner.tenant_id) !== scope[0][0]
      || String(inner.user_id) !== scope[0][1] || inner.work_id !== scope[2] || inner.version_id !== scope[3]
      || inner.run_id !== operation.run_id || inner.attempt_id !== value.attempt_id || inner.task_id !== value.task_id
      || inner.provider_task_id !== value.provider_task_id || !sha(inner.request_hash) || typeof inner.submit_started_at !== 'string'
      || !inner.submit_started_at || inner.status !== 'needs_attention' || inner.reason_code !== 'PROVIDER_RECEIPT_PERSISTENCE_FAILED') return false
  }
  return true
}
function receiptCompatible(value, operation) {
  if (!receiptValid(value, operation)) return false
  const previous = operation.receipt
  if (!previous) return true
  if (['run_id', 'attempt_id', 'task_id', 'provider_task_id'].some(key => previous[key] != null && previous[key] !== value[key])) return false
  const before = previous.recovery_receipt, after = value.recovery_receipt
  return !before || !after || ['schema_version', 'tenant_id', 'user_id', 'work_id', 'version_id', 'run_id', 'attempt_id',
    'task_id', 'request_hash', 'submit_started_at', 'provider_task_id'].every(key => before[key] === after[key])
}
function settle(operation, status, value) {
  const receipt = receiptSnapshot(value), previous = operation.receipt, submission = ['advance', 'recover'].includes(operation.action)
  const valid = !submission || receiptCompatible(receipt, operation)
  // A later sparse result may update status, but must not erase the original immutable safe proof.
  const retained = valid && receipt ? { ...receipt, ...(previous?.recovery_receipt && !receipt.recovery_receipt
    ? { recovery_receipt: previous.recovery_receipt } : {}) } : previous
  const updated = { ...operation, status: valid ? status : 'unknown', receipt: retained }
  let persisted = false
  // Preserve the original owner's result before any current-component/UI check.
  try { writeOperation(updated); persisted = true } catch {
    updated.status = 'unknown'
    // A successful write followed by a failed readback is not permission to leave a durable unlock.
    try { writeOperation(updated) } catch { /* Keep the in-memory lock if storage is unavailable. */ }
    if (alive && operation.scope === scopeKey()) storageBlocked.value = true
  }
  Object.assign(operation, updated)
  runOperations.set(operationKey(operation), operation)
  activeOperations.delete(operationKey(operation))
  return persisted && operation.status === 'received'
}
function reconcileControl(action, ready) {
  if (!currentRun.value || runs.value.filter(item => item.id === currentRunId.value).length !== 1) return
  for (const operation of scopedOperations()) {
    if (operation.action !== action || !canReconcile(operation)) continue
    if (action === 'create') {
      if (operation.run_id !== null) continue
    } else if (action === 'pause') {
      if (operation.run_id !== run.value.id || run.value.revision !== operation.run_revision + 1 || run.value.pause_requested !== true) continue
    } else if (!ready || ready.action !== 'advance' || run.value.pause_requested !== false
      || operation.run_id !== run.value.id || run.value.revision !== operation.run_revision + 1
      || operation.unit_id !== ready.unit_id || operation.attempt_id !== ready.attempt_id || operation.phase !== ready.phase
      || stable(operation.output_parameters) !== stable(ready.output_parameters)
      || stable(operation.policy) !== stable({ execution_mode: props.projectPolicy.execution_mode,
        policy_version: props.projectPolicy.policy_version, epoch: props.projectPolicy.epoch })) continue
    // Only this explicit read's matching control intent is resolved; generation intents remain untouched.
    settle(operation, 'received')
  }
}
function advanceProofMatches(operation, proof, unitId, attemptId) {
  const unit = proof.units.find(item => item.id === unitId), scope = JSON.parse(operation.scope)
  return operation.run_id === proof.id && operation.unit_id === unitId && operation.run_revision <= proof.revision
    && proof.work_id === scope[2] && proof.version_id === scope[3] && proof.review_id === scope[4]
    && proof.queue_id === scope[5] && proof.plan_hash === scope[6]
    && (operation.attempt_id === null || operation.attempt_id === attemptId)
    && unit?.attempts?.length === 1 && unit.attempts[0].id === attemptId
    && proof.units.flatMap(item => item.attempts || []).filter(attempt => attempt.id === attemptId).length === 1
    && operation.output_parameters && stable(operation.output_parameters) === stable(proof.output_parameters)
}
function reconcileAdvance(recovery, value, proof) {
  if (recovery.status !== 'received' || value.newly_submitted !== false || value.receipt_persisted !== true
    || !['running', 'waiting_review', 'approved', 'rejected', 'failed'].includes(value.status)) return
  if (proof.id !== recovery.run_id) return
  for (const operation of scopedOperations(recovery.scope)) {
    if (operation.action !== 'advance' || !canReconcile(operation)
      || !advanceProofMatches(operation, proof, recovery.unit_id, recovery.attempt_id) || !receiptCompatible(value, operation)) continue
    settle(operation, 'received', value)
  }
}
function restoreReceipt() {
  if (!contextValid() || !positive(selectedRunId.value)) { submissionReceipt.value = null; return }
  try {
    const records = scopedOperations().filter(item => ['advance', 'recover'].includes(item.action)
      && item.run_id === selectedRunId.value && receiptValid(item.receipt, item))
    submissionReceipt.value = records.at(-1)?.receipt ?? null
  } catch { /* Keep an already known receipt if storage becomes unreadable. */ }
}
async function createRun() {
  if (!contextValid() || !canCreate.value) return
  const operation = reserve('create', '')
  if (!operation) return
  invalidate()
  const ticket = { sequence, context: context() }
  try {
    const value = await redrawAPI.createExecutionRun(Number(props.record.version_id), { expected_plan_hash: props.preview.plan_hash, expected_queue_id: props.queue.id })
    settle(operation, 'unknown', value)
    if (!current(ticket)) return
    checkedRun(value, true); settle(operation, 'received', value)
    runs.value = [value, ...runs.value.filter(item => item.id !== value.id)]; currentRunId.value = value.id
    selectedRunId.value = value.id; run.value = value; listLoaded.value = true
  } catch {
    settle(operation, 'unknown')
    if (current(ticket)) error.value = '创建结果未确认，已保留防重状态；请只读刷新，不会自动重提'
  }
}
async function advanceRun() {
  if (!contextValid() || !canAdvance.value) return
  const ready = readiness.value, id = run.value.id, version = Number(props.record.version_id)
  const operation = reserve('advance', ready.confirmation_hash)
  if (!operation) return
  const body = actionBody(ready)
  invalidate()
  const ticket = { sequence, context: context() }
  try {
    const value = await redrawAPI.advanceExecutionRun(version, id, body)
    const valid = receiptValid(value, operation)
    settle(operation, valid && value.receipt_persisted === true && value.status !== 'needs_attention' ? 'received' : 'unknown', value)
    if (!current(ticket)) return
    restoreReceipt()
    if (operation.status === 'unknown') error.value = '提交结果或落库未确认，回执已保留；不会再次提交，请等待显式核对'
  } catch {
    settle(operation, 'unknown')
    if (current(ticket)) error.value = '提交结果未知，已保留防重状态；不会自动重提或恢复'
  }
}
function actionBody(ready) {
  return { expected_revision: ready.run_revision, expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash,
    expected_confirmation_hash: ready.confirmation_hash, output_parameters: { ...ready.output_parameters } }
}
async function pauseRun() {
  if (!contextValid() || !canPause.value) return
  const id = run.value.id, revision = run.value.revision, version = Number(props.record.version_id)
  const operation = reserve('pause', stable([id, revision]), null, null)
  if (!operation) return
  invalidate()
  const ticket = { sequence, context: context() }
  try {
    const value = await redrawAPI.pauseExecutionRun(version, id, { expected_revision: revision })
    settle(operation, 'unknown', value)
    if (!current(ticket)) return
    checkedRun(value, true)
    if (value.id !== id || value.revision !== revision + 1 || value.pause_requested !== true) throw Error('暂停回执无效')
    settle(operation, 'received', value); run.value = value
  } catch {
    settle(operation, 'unknown')
    if (current(ticket)) error.value = '暂停结果未确认，请显式读取原记录；不会自动重试或生成'
  }
}
async function resumeRun() {
  if (!contextValid() || !canResume.value) return
  const ready = readiness.value, id = run.value.id, version = Number(props.record.version_id)
  const operation = reserve('resume', ready.confirmation_hash)
  if (!operation) return
  invalidate()
  const ticket = { sequence, context: context() }
  try {
    const value = await redrawAPI.resumeExecutionRun(version, id, actionBody(ready)), idle = ready.attempt_id === null
    const valid = value?.run_id === id && value.run_revision === ready.run_revision + 1 && value.pause_requested === false
      && value.run_status === (idle ? 'ready' : 'running') && value.attempt_id === ready.attempt_id
      && value.attempt_status === (idle ? null : 'claimed') && value.amount === (idle ? null : ready.amount)
      && value.billing_mode === (idle ? null : ready.billing_mode) && value.changed === true && value.executable === false
    settle(operation, valid ? 'received' : 'unknown', value)
    if (!current(ticket)) return
    if (!valid) { error.value = '解暂停结果未确认，请只读核对；不会推进或重试'; return }
    run.value = { ...run.value, revision: value.run_revision, status: value.run_status, pause_requested: false }
  } catch {
    settle(operation, 'unknown')
    if (current(ticket)) error.value = '解暂停结果未知，已保留防重状态；不会自动推进'
  }
}
async function recoverAttempt(attemptId) {
  if (!canRecover(attemptId)) return
  const id = run.value.id, version = Number(props.record.version_id)
  const proof = JSON.parse(JSON.stringify(run.value))
  const unit = run.value.units.find(item => item.attempts?.some(attempt => attempt.id === attemptId))
  const operation = reserve('recover', stable([id, attemptId]), attemptId, unit.id)
  if (!operation) return
  invalidate()
  const ticket = { sequence, context: context() }
  try {
    const value = await redrawAPI.recoverExecutionUnitTask(version, id, { attempt_id: attemptId })
    const valid = receiptValid(value, operation)
    const received = settle(operation, valid && value.receipt_persisted === true && value.status !== 'needs_attention' ? 'received' : 'unknown', value)
    if (received) reconcileAdvance(operation, value, proof)
    if (!current(ticket)) return
    restoreReceipt()
    if (operation.status === 'unknown') error.value = '原尝试仍未确认，已有回执继续保留；可再次显式核对，不会重新生成'
  } catch {
    settle(operation, 'unknown')
    if (current(ticket)) error.value = '原尝试核对失败，可再次显式核对；不会自动重试或重新生成'
  }
}
const checkLabels = {
  scene_action_continuity: '场景、动作与连续性', source_text_and_caption_residue: '源语言文字及字幕残留',
  character_identity: '人物身份一致', target_dialogue_complete: '目标对白完整', speaker_order: '说话人顺序',
  target_names: '目标人物名字', language_and_locale: '目标语言与地区', voice_and_emotion: '声音与情绪',
  no_extra_dialogue: '没有多余对白', lip_sync: '可见对白口型', no_dialogue: '应无对白', ambient_audio: '环境声音',
}
const candidateUnits = computed(() => currentRun.value ? run.value.units.filter(unit =>
  ['waiting_review', 'approved', 'rejected'].includes(unit.status) && unit.attempts?.length === 1
  && positive(unit.attempts[0].id) && unit.attempts[0].status === unit.status) : [])
function clearCandidate() {
  candidateTicket?.controller.abort()
  const player = candidateVideo, url = candidateUrl.value
  if (url && player) { player.pause(); player.removeAttribute('src'); player.load() }
  if (url) URL.revokeObjectURL(url)
  candidateUrl.value = ''; mediaReady.value = false; reviewChecks.value = {}; reviewAcknowledged.value = false
  candidate.value = null; candidateTicket = null
}
function bindCandidateVideo(player) {
  // Function refs receive null during real unmount, while the previous player is still available here.
  if (!player && candidateVideo) clearCandidate()
  candidateVideo = player
}
function candidateCurrent() {
  return candidate.value && candidateTicket && current(candidateTicket) && candidateTicket.identity === stable(candidate.value)
    && !candidateTicket.controller.signal.aborted
}
function checkedCandidate(value, unit) {
  const asset = value?.asset, policy = value?.review_policy
  if (value?.schema_version !== 'redraw-execution-unit-candidate-review-v1' || value.run_id !== run.value.id
    || value.run_revision !== run.value.revision || value.unit_id !== unit.id || value.ordinal !== unit.ordinal
    || value.attempt_id !== unit.attempts[0].id || value.status !== unit.status || !sha(value.candidate_hash)
    || !positive(asset?.id) || !sha(asset.sha256) || !positive(asset.bytes) || asset.mime_type !== 'video/mp4'
    || !policyValid(policy) || policy.execution_mode !== props.projectPolicy.execution_mode
    || policy.policy_version !== props.projectPolicy.policy_version || policy.human_required !== true
    || !Array.isArray(value.required_checks) || !value.required_checks.length
    || value.required_checks.some(key => typeof key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(key))
    || new Set(value.required_checks).size !== value.required_checks.length
    || !value.target_contract?.character_name_map || !Array.isArray(value.target_contract.dialogues)
    || !Array.isArray(value.target_contract.shots)) throw Error('候选返回与当前执行绑定不一致')
  return value
}
function reviewHash(value) { return stable([value.run_id, value.unit_id, value.attempt_id, value.candidate_hash]) }
const canEditCandidate = computed(() => Boolean(candidateCurrent() && mediaReady.value && !reading.value
  && candidate.value.status === 'waiting_review' && ['waiting_review', 'paused'].includes(run.value.status)))
const canRejectCandidate = computed(() => canEditCandidate.value && reviewAcknowledged.value
  && !locked('review', reviewHash(candidate.value)))
const canApproveCandidate = computed(() => canRejectCandidate.value
  && candidate.value.required_checks.every(key => reviewChecks.value[key] === 'passed'))
const reviewNotice = computed(() => {
  if (!contextReady.value || !positive(selectedRunId.value)) return ''
  try {
    const operation = scopedOperations().filter(item => item.action === 'review' && item.run_id === selectedRunId.value).at(-1)
    if (!operation) return ''
    return operation.status === 'received'
      ? `单元 ${operation.unit_id} 候选 ${operation.review.expected_candidate_hash} 已保存 ${operation.review.decision}；请显式刷新执行记录，再检查下一次条件。不会自动推进。`
      : `单元 ${operation.unit_id} 候选 ${operation.review.expected_candidate_hash} 的 ${operation.review.decision} 审核尚未确认，原决定与逐项结果已保留。请显式刷新执行记录并读取原候选核对；不会重提或推进。`
  } catch { return '' }
})
function setReviewCheck(key, result) {
  if (!canEditCandidate.value || !candidate.value.required_checks.includes(key) || !['passed', 'failed', 'not_checked'].includes(result)) return
  reviewChecks.value[key] = result
}
function acknowledgeReview(value) { reviewAcknowledged.value = canEditCandidate.value && value === true }
function candidateLoaded(event) {
  if (candidateCurrent() && candidateUrl.value && event?.currentTarget === candidateVideo
    && event.currentTarget.src === candidateUrl.value) mediaReady.value = true
}
function candidateMediaError(event) {
  if (!candidateCurrent() || event?.currentTarget !== candidateVideo) return
  invalidate(); error.value = '候选视频无法解码或播放，已撤销媒体与人工审核草稿；请显式重新读取核对'
}
function reviewProofMatches(value, operation) {
  const input = operation.review, policy = operation.policy
  return value?.schema_version === 'redraw-execution-unit-candidate-review-v1' && input
    && value.run_id === operation.run_id && value.unit_id === operation.unit_id && value.attempt_id === operation.attempt_id
    && value.candidate_hash === input.expected_candidate_hash && value.run_revision === input.expected_revision + 1
    && value.status === input.decision && value.review?.decision === input.decision
    && stable(value.required_checks) === stable(Object.keys(input.checks)) && stable(value.review.checks) === stable(input.checks)
    && stable(value.asset) === stable(operation.review_asset) && sha(value.review.review_hash)
    && String(value.review.reviewed_by) === JSON.parse(operation.scope)[0][1]
    && value.review_policy?.execution_mode === policy.execution_mode && value.review_policy.policy_version === policy.policy_version
    && value.review_policy.human_required === true
}
async function loadCandidate(unitId) {
  if (!contextValid() || !currentRun.value || reading.value) return
  const unit = candidateUnits.value.find(item => item.id === unitId)
  if (!unit) return
  const version = Number(props.record.version_id), id = run.value.id, ticket = beginRead('candidate')
  try {
    const value = await redrawAPI.getExecutionUnitCandidate(version, id, unitId, { signal: ticket.controller.signal })
    if (!current(ticket)) return
    checkedCandidate(value, unit)
    for (const operation of scopedOperations()) {
      if (operation.action === 'review' && canReconcile(operation) && reviewProofMatches(value, operation)) settle(operation, 'received', value)
    }
    if (!current(ticket)) return
    candidate.value = value; candidateTicket = { ...ticket, identity: stable(value) }
    reviewChecks.value = Object.fromEntries(value.required_checks.map(key => [key, 'not_checked']))
    const blob = await redrawAPI.getExecutionUnitCandidateMedia(version, id, unitId,
      { expected_candidate_hash: value.candidate_hash }, { signal: ticket.controller.signal })
    if (!candidateCurrent()) return
    if (!(blob instanceof Blob) || !blob.size || blob.type !== 'video/mp4' || blob.size !== value.asset.bytes) throw Error('候选响应不是匹配的 MP4')
    const bytes = await blob.arrayBuffer()
    if (!candidateCurrent()) return
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    if (!candidateCurrent()) return
    const actual = Array.from(new Uint8Array(digest), item => item.toString(16).padStart(2, '0')).join('')
    if (actual !== value.asset.sha256) throw Error('候选媒体摘要不一致')
    const url = URL.createObjectURL(blob)
    if (!candidateCurrent()) { URL.revokeObjectURL(url); return }
    candidateUrl.value = url
  } catch (cause) {
    if (!current(ticket)) return
    invalidate()
    error.value = cause?.response?.status === 409 ? '候选已过期或冲突，已撤销媒体与审核草稿；请显式刷新执行记录'
      : '候选或媒体读取失败，已撤销审核草稿；请显式刷新核对，不会自动重试'
  } finally { finishRead(ticket) }
}
async function reviewCandidate(decision) {
  if (!contextValid() || !['approved', 'rejected'].includes(decision)
    || !(decision === 'approved' ? canApproveCandidate.value : canRejectCandidate.value)) return
  const value = candidate.value, version = Number(props.record.version_id)
  const body = { expected_revision: value.run_revision, expected_candidate_hash: value.candidate_hash, decision,
    checks: Object.fromEntries(value.required_checks.map(key => [key, { basis: reviewChecks.value[key] === 'not_checked'
      ? 'not_checked' : 'human_watch_listen', result: reviewChecks.value[key] }])) }
  const operation = reserve('review', reviewHash(value), value.attempt_id, value.unit_id, body)
  if (!operation) return
  invalidate()
  const ticket = { sequence, context: context() }
  try {
    const result = await redrawAPI.reviewExecutionUnitCandidate(version, value.run_id, value.unit_id, body)
    const valid = reviewProofMatches(result, operation) && typeof result.newly_reviewed === 'boolean'
    const received = settle(operation, valid ? 'received' : 'unknown', valid ? result : undefined)
    if (current(ticket) && !received) error.value = '审核回执未确认，原候选与决定已保留；请显式读取核对，不会重提'
  } catch (cause) {
    settle(operation, 'unknown')
    if (current(ticket)) error.value = cause?.response?.status === 409 ? '审核版本冲突，原候选与决定已保留；请显式刷新并读取核对'
      : '审核结果未确认，原候选与决定已保留；请显式读取核对，不会自动重试'
  }
}
function resetContext() {
  defaultOwnerProof.value = null
  invalidate(); runs.value = []; currentRunId.value = null; selectedRunId.value = null; run.value = null; listLoaded.value = false
  submissionReceipt.value = null; storageBlocked.value = false
}
let observedOwner = stable(ownerSelection())
function sessionUser(raw) {
  try { const value = JSON.parse(raw); return value?.token && value.user?.id != null ? String(value.user.id) : null } catch { return null }
}
function checkOwner(event) {
  let changed = false
  if (event?.type !== 'focus' && event && (!event.storageArea || event.storageArea === window.localStorage)) {
    if (event.key === null) changed = true
    if (event.key === 'moli_mama_session') changed = sessionUser(event.oldValue) !== sessionUser(event.newValue)
    if (event.key === 'moli_mama_tenant_id') changed = event.oldValue !== event.newValue
  }
  const identity = stable(ownerSelection())
  if (changed || identity !== observedOwner) { observedOwner = identity; ownerEpoch.value++; resetContext() }
}
watch(() => [props.record, props.preview, props.savedReview, props.queue, props.blocked, props.projectPolicy], resetContext,
  { immediate: true, deep: true, flush: 'sync' })
watch([selectedResolution, selectedAspectRatio, selectedRunId], invalidate, { flush: 'sync' })
watch(() => [scopeKey(), selectedRunId.value, ...runOperations.values()], restoreReceipt, { deep: true, flush: 'sync' })
if (typeof window !== 'undefined') { window.addEventListener('storage', checkOwner); window.addEventListener('focus', checkOwner) }
onUnmounted(() => {
  alive = false; defaultOwnerProof.value = null; invalidate()
  if (typeof window !== 'undefined') { window.removeEventListener('storage', checkOwner); window.removeEventListener('focus', checkOwner) }
})
defineExpose({ refreshReadiness: loadReadiness })
</script>

<style scoped>
.execution-run { border-top: 1px solid #334155; margin-top: 16px; padding-top: 16px; }
h4 { margin: 0 0 10px; } p { line-height: 1.6; overflow-wrap: anywhere; }
label, .run-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
select { color: #e2e8f0; background: #151b27; border: 1px solid #64748b; border-radius: 4px; padding: 8px; }
select:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
.credit-callout { color: #fbbf24; font-size: 1.05rem; } .credit-callout strong { font-weight: 800; }
.candidate-review { margin-top: 16px; padding-top: 16px; border-top: 1px solid #334155; }
.candidate-review video { display: block; width: 100%; max-height: 65vh; background: #000; object-fit: contain; }
[role="alert"] { color: #fca5a5; }
</style>
