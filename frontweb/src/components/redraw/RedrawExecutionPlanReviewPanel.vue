<template>
  <section class="execution-plan-review" aria-label="动态执行计划审核">
    <header>
      <div><h3>动态执行计划</h3><p>仅审核已保存的本地化。保存不启动生成，不扣费，也不代表素材或声音已就绪。</p></div>
      <el-button :disabled="blocked || loading || saving || queueSaving" @click="load">刷新计划</el-button>
    </header>
    <p v-if="blocked" role="status">本地化有未保存修改或正在保存，请完成后重新检查计划。</p>
    <p v-else-if="loading" role="status">正在核对当前版本与规划能力…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="preview">
      <p class="review-status" role="status">{{ reviewStatus }}</p>
      <p v-if="preview.status === 'blocked'">当前无法形成完整计划：</p>
      <ul v-if="preview.blocking_reasons?.length">
        <li v-for="reason in preview.blocking_reasons" :key="reason.code">{{ reasonText(reason.code) }}</li>
      </ul>
      <template v-if="preview.status === 'ready'">
        <p>{{ preview.bindings.locale }} / {{ preview.bindings.market }} · {{ preview.units.length }} 个单元 · {{ preview.capability.model }}</p>
        <p>能力范围：{{ preview.capability.resolutions.join('、') }} · {{ preview.capability.aspect_ratios.join('、') }}；音轨规划：{{ audioMode }}</p>
        <p>能力范围不等于每种参数组合都已实测；以下参考仅是需求，不是已验证素材。</p>
        <div class="execution-units">
          <article v-for="unit in preview.units" :key="unit.id" class="execution-unit">
            <h4>{{ unit.id }} · 源片 {{ timecode(unit.source_start_ms) }}—{{ timecode(unit.source_end_ms) }}</h4>
            <p>保留 {{ seconds(unit.retained_duration_ms) }} 秒 · 生成 {{ seconds(unit.generated_duration_ms) }} 秒 · 尾部余量 {{ seconds(unit.padding_ms) }} 秒</p>
            <p>父镜头：{{ unit.parent_shots.map(item => item.id).join('、') }}</p>
            <div v-for="turn in unit.dialogues" :key="turn.id" class="plan-dialogue">
              <small>整句源范围 {{ timecode(turn.start_ms) }}—{{ timecode(turn.end_ms) }}</small>
              <p>原句：{{ turn.source_text }}</p><p>目标对白：{{ turn.target_text }}</p>
            </div>
            <p v-if="!unit.dialogues.length">无对白单元</p>
            <p>参考需求：{{ referenceSummary(unit.reference_requirements) }}</p>
          </article>
        </div>
      </template>
      <details>
        <summary>执行前仍需满足的条件（保存不会解除）</summary>
        <ul><li v-for="code in preview.execution_blockers" :key="code">{{ reasonText(code) }}</li></ul>
      </details>
      <details v-if="savedReview">
        <summary>已保存快照记录</summary>
        <p>保存时间：{{ savedReview.saved_at }}；状态：{{ savedReview.status }}</p>
        <code>{{ savedReview.plan_hash }}</code>
        <p v-if="savedReview.status === 'stale'">历史快照已保留，不适用于当前计划。请核对当前内容后重新保存。</p>
        <p v-if="savedReview.status === 'invalid'">历史快照校验失败，不可用作审核或执行依据。</p>
      </details>
      <footer v-if="preview.status === 'ready'">
        <label><input type="checkbox" :checked="confirmedHash === preview.plan_hash" :disabled="!canConfirm" @change="confirm($event.target.checked)" />我已检查完整对白、时间范围和参考需求</label>
        <el-button type="primary" :loading="saving" :disabled="!canSave" @click="save">保存计划审核</el-button>
      </footer>
      <div class="execution-queue" aria-label="待就绪执行队列">
        <h4>执行队列登记</h4>
        <p>登记只保存待就绪单元，不生成、不扣费。素材、声音和执行器仍须独立验证。</p>
        <p v-if="queueLoading" role="status">正在读取队列记录…</p>
        <p v-if="queueError" role="alert">{{ queueError }}</p>
        <template v-if="queue">
          <p role="status">{{ queueStatus }}</p>
          <p>队列 #{{ queue.id }} · 登记时间 {{ queue.created_at }}</p>
          <ul v-if="queue.status !== 'invalid'">
            <li v-for="item in queue.units" :key="item.id">
              {{ item.id }} · 待执行 · {{ timecode(item.plan_unit.source_start_ms) }}—{{ timecode(item.plan_unit.source_end_ms) }}
              · 父镜头 {{ item.plan_unit.parent_shots.map(parent => parent.id).join('、') }}
            </li>
          </ul>
        </template>
        <el-button :disabled="!canPrepareQueue" :loading="queueSaving" @click="prepareQueue">登记执行队列（不生成）</el-button>
      </div>
    </template>
    <RedrawUnitReferenceMaterialsPanel :record="record" :preview="preview" :saved-review="savedReview"
      :queue="queue" :blocked="materialsBlocked" :project-policy="projectPolicy" @prepared="onMaterialsPrepared" />
    <RedrawExecutionRunPanel ref="executionRun" :record="record" :preview="preview" :saved-review="savedReview"
      :queue="queue" :blocked="materialsBlocked" :project-policy="projectPolicy" @unit-delivery-requested="$emit('unit-delivery-requested', $event)" />
  </section>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { redrawAPI } from '@/api/redraw'
import RedrawUnitReferenceMaterialsPanel from './RedrawUnitReferenceMaterialsPanel.vue'
import RedrawExecutionRunPanel from './RedrawExecutionRunPanel.vue'

const props = defineProps({ record: { type: Object, required: true }, blocked: { type: Boolean, default: false }, projectPolicy: Object })
defineEmits(['unit-delivery-requested'])
const executionRun = ref(null)
const result = ref(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const confirmedHash = ref('')
const queue = ref(null)
const queueLoading = ref(false)
const queueSaving = ref(false)
const queueError = ref('')
const queueLoaded = ref(false)
let sequence = 0
let alive = true
const preview = computed(() => result.value?.preview || null)
const savedReview = computed(() => result.value?.saved_review || null)
const materialsBlocked = computed(() => props.blocked || loading.value || saving.value || queueLoading.value
  || queueSaving.value || Boolean(error.value) || Boolean(queueError.value) || !queueLoaded.value
  || (props.projectPolicy != null && (!Number.isSafeInteger(props.projectPolicy.project_id) || props.projectPolicy.project_id <= 0
    || !['safe', 'auto'].includes(props.projectPolicy.execution_mode) || !Number.isSafeInteger(props.projectPolicy.policy_version)
    || props.projectPolicy.policy_version <= 0 || !Number.isSafeInteger(props.projectPolicy.epoch) || props.projectPolicy.epoch < 0)))
const canConfirm = computed(() => !props.blocked && !loading.value && !saving.value && !queueSaving.value && !error.value
  && preview.value?.status === 'ready' && preview.value.executable === false && preview.value.units.length > 0
  && savedReview.value?.status !== 'current' && savedReview.value?.status !== 'invalid')
const canSave = computed(() => canConfirm.value && confirmedHash.value === preview.value?.plan_hash)
const canPrepareQueue = computed(() => !props.blocked && !loading.value && !saving.value && !queueLoading.value
  && !queueSaving.value && !error.value && !queueError.value && queueLoaded.value
  && preview.value?.status === 'ready' && savedReview.value?.status === 'current'
  && savedReview.value.plan_hash === preview.value.plan_hash && (!queue.value || queue.value.status === 'stale'))
const queueStatus = computed(() => ({waiting_readiness:'等待素材与执行条件就绪；尚未生成',
  stale:'历史队列已过期，不能执行；当前计划需重新登记',invalid:'队列记录校验失败，不能登记或执行'})[queue.value?.status] || '')
const reviewStatus = computed(() => ({ current: '计划审核已保存；仍不可执行', stale: '旧审核已过期，请检查当前计划',
  invalid: '保存记录校验失败，请联系维护人员' })[savedReview.value?.status]
  || (preview.value?.status === 'ready' ? '预览可审核，尚未保存' : '计划被阻断，不能保存审核'))
const audioMode = computed(() => ({native:'模型原生音轨（仍需地区和内容验收）',replace:'独立配音替换（尚未执行）',not_required:'无对白要求'})[preview.value?.capability?.audio_mode] || '未核验')

function onMaterialsPrepared(value) {
  if (materialsBlocked.value || value?.status !== 'prepared' || !props.projectPolicy
    || JSON.stringify(value.projectPolicy) !== JSON.stringify(props.projectPolicy)) return
  const bindings = value.bindings, plan = preview.value?.bindings
  const unit = queue.value?.units.find(item => item.id === bindings?.unit_id)
  if (!bindings || !unit || bindings.unit_hash !== unit.unit_hash || bindings.queue_id !== queue.value.id
    || bindings.review_id !== savedReview.value?.id || bindings.plan_hash !== preview.value?.plan_hash
    || bindings.version_id !== Number(props.record.version_id)
    || ['tenant_id', 'user_id', 'work_id', 'version_id', 'source_asset_id', 'source_sha256', 'blueprint_hash', 'localization_hash', 'capability_hash']
      .some(key => bindings[key] !== plan?.[key])) return
  return executionRun.value?.refreshReadiness()
}

function context() { return JSON.stringify(props.record) }
function current(id, token) { return alive && id === sequence && token === context() && !props.blocked }
function resetQueue() { queue.value = null; queueError.value = ''; queueLoaded.value = false; queueLoading.value = false; queueSaving.value = false }
function reset() { result.value = null; confirmedHash.value = ''; error.value = ''; loading.value = false; saving.value = false; resetQueue() }
function accept(value) {
  const plan = value?.preview
  if (!plan || plan.schema_version !== 'redraw-execution-plan-preview-v1' || plan.executable !== false
    || !/^[a-f0-9]{64}$/.test(plan.plan_hash || '') || !Array.isArray(plan.units)
    || Number(plan.bindings?.version_id) !== Number(props.record.version_id)) throw Error('计划返回内容无效，请刷新')
  if (plan.status === 'ready' && (plan.bindings.localization_hash !== props.record.localization_hash
    || plan.bindings.blueprint_hash !== props.record.blueprint_hash
    || plan.bindings.localization_updated_at !== props.record.updated_at)) throw Error('本地化已变化，请先刷新本地化审核')
  result.value = value
}
async function load() {
  const id = ++sequence; const token = context(); reset()
  if (props.blocked || !Number.isSafeInteger(Number(props.record.version_id)) || Number(props.record.version_id) <= 0) return
  loading.value = true
  try {
    const next = await redrawAPI.getExecutionPlanReview(Number(props.record.version_id))
    if (current(id, token)) { accept(next); await loadQueue(id, token) }
  }
  catch { if (current(id, token)) error.value = '读取计划失败或本地化已变化，请刷新本地化后重新读取' }
  finally { if (current(id, token)) loading.value = false }
}
function confirm(checked) { confirmedHash.value = checked && canConfirm.value ? preview.value.plan_hash : '' }
async function save() {
  if (!canSave.value) return
  const id = ++sequence; const token = context(); const versionId = Number(props.record.version_id)
  const expectedHash = preview.value.plan_hash
  resetQueue()
  saving.value = true
  try {
    const next = await redrawAPI.saveExecutionPlanReview(versionId, { expected_plan_hash: expectedHash })
    if (current(id, token)) { confirmedHash.value = ''; accept(next); await loadQueue(id, token) }
  } catch (failure) {
    if (current(id, token)) {
      result.value = null; confirmedHash.value = ''
      error.value = Number(failure?.response?.status) === 409
        ? '计划或保存记录已变化，请刷新并重新检查；未自动重试保存'
        : '保存未确认，请刷新检查已保存记录；不会自动重试'
    }
  } finally { if (current(id, token)) saving.value = false }
}
function acceptQueue(value) {
  if (value?.preview?.plan_hash !== preview.value?.plan_hash
    || Number(value.preview.bindings?.version_id) !== Number(props.record.version_id)
    || value.saved_review?.status !== savedReview.value?.status
    || value.saved_review?.plan_hash !== savedReview.value?.plan_hash) throw Error('queue binding changed')
  const next = value.queue
  if (next !== null) {
    if (!next || !Number.isSafeInteger(next.id) || next.id <= 0 || next.executable !== false
      || Number(next.version_id) !== Number(props.record.version_id)
      || !['waiting_readiness', 'stale', 'invalid'].includes(next.status) || !Array.isArray(next.units)
      || !Array.isArray(next.execution_blockers)
      || (next.status === 'invalid' && next.units.length !== 0)
      || (next.status !== 'invalid' && (!next.units.length || next.units.some(item => item.status !== 'pending'
        || item.id !== item.plan_unit?.id || !Array.isArray(item.plan_unit?.parent_shots))))
      || (next.status === 'waiting_readiness' && (next.plan_hash !== preview.value.plan_hash
        || next.units.length !== preview.value.units.length))) throw Error('queue response invalid')
  }
  queue.value = next; queueLoaded.value = true
}
async function loadQueue(id, token) {
  if (!preview.value) return
  queueLoading.value = true
  try {
    const next = await redrawAPI.getExecutionQueue(Number(props.record.version_id))
    if (current(id, token)) acceptQueue(next)
  } catch {
    if (current(id, token)) { queue.value = null; queueLoaded.value = false; queueError.value = '读取队列失败或计划已变化，请刷新计划核对' }
  } finally { if (current(id, token)) queueLoading.value = false }
}
async function prepareQueue() {
  if (!canPrepareQueue.value) return
  const id = sequence; const token = context()
  queueSaving.value = true
  try {
    const next = await redrawAPI.prepareExecutionQueue(Number(props.record.version_id), {expected_plan_hash:preview.value.plan_hash})
    if (current(id, token)) acceptQueue(next)
  } catch (failure) {
    if (current(id, token)) {
      queue.value = null; queueLoaded.value = false
      queueError.value = Number(failure?.response?.status) === 409
        ? '计划或队列记录已变化，请刷新核对；未自动重试登记'
        : '登记结果未确认，请刷新读取原队列；不会自动重试'
    }
  } finally { if (current(id, token)) queueSaving.value = false }
}
watch(() => [props.record, props.blocked], load, { immediate: true, deep: true, flush: 'sync' })
onUnmounted(() => { alive = false; sequence += 1 })

function seconds(value) { return (Number(value) / 1000).toFixed(3).replace(/\.?0+$/, '') }
function timecode(value) { const ms = Number(value); return `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}` }
function referenceSummary(items) {
  return ['image', 'video', 'audio'].map(kind => `${({image:'身份图',video:'动作视频',audio:'音频'})[kind]} ${items.filter(item => item.kind === kind).length}`).join(' · ')
}
function reasonText(code) {
  return ({ PREVIEW_ONLY:'当前仅为预览', SOURCE_MEDIA_NOT_RECHECKED:'原始视频文件尚未重新验收',
    REFERENCE_ASSETS_NOT_VERIFIED:'身份图、动作与音频素材尚未验证', CREDENTIAL_READINESS_NOT_CHECKED:'执行凭据尚未检查',
    DYNAMIC_EXECUTOR_NOT_CONNECTED:'动态执行队列尚未接通', TARGET_REGION_AUDIO_NOT_VERIFIED:'目标地区声音尚未验收',
    AUDIO_CAPABILITY_UNAVAILABLE:'缺少匹配目标语言和地区的声音能力证据', VIDEO_CAPABILITY_UNAVAILABLE:'缺少已验证的视频规划能力',
    CAPABILITY_PARAMETERS_UNVERIFIED:'缺少时长、尺寸或参考上限证据', SOURCE_DIALOGUE_UNRESOLVED:'完整源对白证据尚未解决',
    CREDENTIAL_BINDING_NOT_CHECKED:'该线路还需独立凭据绑定检查', LOCALIZATION_NOT_FOUND:'请先完成并保存本地化',
    BLUEPRINT_NOT_LOCKED:'请先锁定母本蓝图' })[code] || code
}
</script>

<style scoped>
.execution-plan-review { border-top: 1px solid #334155; padding-top: 24px; margin-top: 24px; color: #e2e8f0; }
header, footer { display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap; }
h3, h4 { margin: 0 0 10px; } p { line-height: 1.6; margin: 8px 0; overflow-wrap: anywhere; }
.execution-units { max-height: 560px; overflow-y: auto; margin: 16px 0; }
.execution-unit { background: #151b27; border: 1px solid #334155; border-radius: 10px; padding: 16px; margin-bottom: 12px; }
.plan-dialogue { border-left: 2px solid #64748b; padding-left: 12px; white-space: pre-wrap; }
.review-status { color: #fbbf24; } [role="alert"] { color: #fca5a5; }
details { margin: 12px 0; } summary { cursor: pointer; } code { overflow-wrap: anywhere; }
footer label { display: flex; gap: 8px; align-items: center; min-width: 0; white-space: normal; flex: 1 1 240px; }
.execution-queue { border-top: 1px solid #334155; margin-top: 20px; padding-top: 16px; }
.execution-queue ul { max-height: 320px; overflow-y: auto; overflow-wrap: anywhere; padding-left: 20px; }
</style>
