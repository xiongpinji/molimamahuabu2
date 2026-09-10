<template>
  <section class="release-panel">
    <template v-if="unitMode">
      <header><h3>所选执行记录导出准备</h3><el-tag>{{ unitVerified ? '绑定已核验' : '未核验' }}</el-tag></header>
      <p v-if="unitReading" role="status">正在重新核验项目、计划与所选执行记录…</p>
      <p v-else-if="unitError" role="alert">{{ unitError }}</p>
      <p v-else-if="!unitVerified" role="status">缺少有效选择或当前项目上下文，导出准备未核验。</p>
      <template v-if="unitVerified">
        <p>执行 #{{ unitVerified.run.id }} · 修订 {{ unitVerified.run.revision }} · 状态 {{ unitVerified.run.status }}</p>
        <p>计划 {{ unitVerified.preview.plan_hash }} · {{ unitVerified.run.units.length }} 个单元</p>
        <p>音轨规划：{{ unitAudioLabel }}</p>
        <p v-if="unitVerified.preview.capability.audio_mode === 'replace'">缺口：独立配音尚未完成，替换音轨仍须合成后听审。</p>
        <p v-else-if="unitVerified.preview.capability.audio_mode === 'native'">缺口：原生音轨仍需目标地区、完整对白与内容听审。</p>
        <p v-else>缺口：无对白要求仍需核对环境声音与完整画面。</p>
        <p>绑定核验不等于最终交付；单元质量、字幕、下载与最终听看仍需独立核验。</p>
        <el-button :disabled="!unitCanCompose" @click="composeUnit">合成此执行记录（一次提交）</el-button>
        <p v-if="unitOriginal" role="status">原合成状态：{{ unitCompositionResult?.status || '未知，等待只读核对。' }}</p>
        <p v-if="unitCompositionResult?.status === 'completed' && !unitOutput">技术任务完成；MP4、SRT、VTT、报告四文件尚未核验，最终人审尚未完成。</p>
        <p v-if="unitCompositionError" role="alert">{{ unitCompositionError }}</p>
        <el-button v-if="unitOriginal" :disabled="unitCompositionBusy || !unitContextValid()" @click="recoverUnitComposition">只读核对原合成</el-button>
        <el-button v-if="unitCompositionResult?.status === 'completed'" :disabled="unitOutputBusy || unitCompositionBusy || !unitContextValid()" @click="loadUnitOutput">核验并加载四文件</el-button>
        <p v-if="unitOutputBusy" role="status">正在只读核验原合成的四个文件…</p>
        <p v-if="unitOutputError" role="alert">{{ unitOutputError }}</p>
        <div v-if="unitOutput" :key="unitOutput.generation" class="unit-output">
          <p>导出 #{{ unitOutput.exportId }} 技术文件已核验；最终人审仍待完成。</p>
          <p role="status">{{ unitOutput.playback }} · {{ unitOutput.subtitles }}</p>
          <video :src="unitOutput.urls.mp4" controls preload="metadata"
            v-on="{ loadedmetadata: unitOutput.onMetadata, canplay: unitOutput.onCanplay, error: unitOutput.onVideoError }">
            <track :src="unitOutput.urls.vtt" kind="subtitles" :srclang="unitOutput.locale" :label="unitOutput.locale" default
              v-on="{ load: unitOutput.onTrackLoad, error: unitOutput.onTrackError }" />
          </video>
          <div class="downloads">
            <el-button v-on="{ click: unitOutput.downloads.mp4 }">下载 MP4</el-button>
            <el-button v-on="{ click: unitOutput.downloads.srt }">下载 SRT</el-button>
            <el-button v-on="{ click: unitOutput.downloads.vtt }">下载 VTT</el-button>
            <el-button v-on="{ click: unitOutput.downloads.report }">下载报告</el-button>
          </div>
        </div>
      </template>
      <el-button :disabled="unitReading || unitCompositionBusy || !unitContextValid()" @click="loadUnitProof">重新核验导出准备</el-button>
    </template>
    <template v-else>
    <header>
      <div>
        <p class="eyebrow">合并与导出</p>
        <h3>整集 readiness</h3>
      </div>
      <el-tag :type="readiness.ready ? 'success' : 'warning'">
        {{ readiness.ready ? '可发布' : '存在缺口' }}
      </el-tag>
    </header>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <ul v-if="readiness.blockers.length" class="blockers">
      <li v-for="(blocker, index) in readiness.blockers" :key="`${blocker.shot_id}-${index}`">
        <strong>镜头 {{ blocker.shot_id ?? '整集' }}</strong>
        <span>原因：{{ blocker.reason_code }}</span>
      </li>
    </ul>
    <p v-else>全部 {{ readiness.shot_count }} 个镜头已满足当前 release 证据。</p>
    <el-button :disabled="!readiness.ready" :loading="creating" type="primary" @click="create">
      创建整集 release
    </el-button>
    <div v-if="Object.keys(downloads).length" class="downloads">
      <el-button :disabled="!safeUrl('mp4')" @click="download('mp4')">MP4 下载</el-button>
      <el-button :disabled="!safeUrl('srt')" @click="download('srt')">SRT 下载</el-button>
      <el-button :disabled="!safeUrl('vtt')" @click="download('vtt')">VTT 下载</el-button>
      <el-button :disabled="!safeUrl('report')" @click="download('report')">报告下载</el-button>
    </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { redrawAPI } from '@/api/redraw'
import { readCurrentTenantId, readSession } from '@/utils/authSession'
import { controlledReleaseDownloadUrl, normalizeReleaseReadiness } from '@/utils/redrawTimelineState'

const props = defineProps({
  versionId: { type: [String, Number], default: null },
  refreshToken: { type: Number, default: 0 },
  unitMode: { type: Boolean, default: false },
  unitIntent: { type: Object, default: null },
  unitContext: { type: Object, default: null },
})
const readiness = ref(normalizeReleaseReadiness())
const exports = ref([])
const createdRelease = ref(null)
const creating = ref(false)
const loadError = ref('')
const idempotencyKey = ref('')

let pollTimer = null
const unitVerified = ref(null), unitReading = ref(false), unitError = ref('')
const unitOriginal = ref(null), unitCompositionResult = ref(null), unitCompositionError = ref('')
const unitCompositionBusy = ref(false), unitCompositionBlocked = ref(false)
const unitOutput = ref(null), unitOutputBusy = ref(false), unitOutputError = ref('')
const unitOutputKinds = ['mp4', 'srt', 'vtt', 'report']
let unitOutputSequence = 0, unitOutputUrls = []
const unitFrozenScopes = new Set()
const unitKnownReceiptIds = new Map()
const unitCompositionSchema = 'redraw-execution-unit-composition-v1'
let unitSequence = 0, unitAlive = true, unitController = null
const positive = value => Number.isSafeInteger(value) && value > 0
const sha = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stable = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const unitAudioLabel = computed(() => ({ native: 'native · 模型原生音轨', replace: 'replace · 独立配音替换',
  not_required: 'not_required · 无对白要求' })[unitVerified.value?.preview.capability.audio_mode] || '未核验')
const unitCanCompose = computed(() => unitContextValid() && unitVerified.value?.run.status === 'completed'
  && unitVerified.value.run.units.every(unit => unit.status === 'approved')
  && ['native', 'not_required'].includes(unitVerified.value.preview.capability.audio_mode)
  && !unitCompositionBusy.value && !unitCompositionBlocked.value && !unitOriginal.value)

function unitContextValid() {
  const context = props.unitContext, intent = props.unitIntent, policy = context?.policy
  if (!unitAlive || !props.unitMode || !object(context) || !object(intent)
    || !positive(intent.run_id) || !positive(intent.version_id) || !sha(intent.plan_hash)
    || !Number.isSafeInteger(intent.run_revision) || intent.run_revision < 0
    || !positive(context.project_id) || !positive(context.work_id) || context.version_id !== intent.version_id
    || Number(props.versionId) !== intent.version_id
    || !Array.isArray(context.owner) || context.owner.length !== 2
    || context.owner.some(value => typeof value !== 'string' || !value.trim())
    || policy?.project_id !== context.project_id || !['safe', 'auto'].includes(policy.execution_mode)
    || !positive(policy.policy_version) || !Number.isSafeInteger(policy.epoch) || policy.epoch < 0) return false
  try {
    const session = readSession(), tenant = readCurrentTenantId()
    return Boolean(session?.token && session.user?.id != null && String(session.user.id) === context.owner[1]
      && (tenant === null || tenant === context.owner[0]))
  } catch { return false }
}
function unitToken() { return stable([props.versionId, props.unitMode, props.unitIntent, props.unitContext]) }
function unitSessionUser(raw) {
  try { const session = JSON.parse(raw); return session?.token && session.user?.id != null ? String(session.user.id) : null } catch { return null }
}
function unitOwnerSelection() {
  try {
    const session = readSession()
    return stable([session?.token && session.user?.id != null ? String(session.user.id) : null, readCurrentTenantId()])
  } catch { return '' }
}
let unitObservedOwner = unitOwnerSelection()
function checkUnitOwner(event) {
  if (!props.unitMode) return
  let changed = false
  if (event?.type !== 'focus' && event && (!event.storageArea || event.storageArea === window.localStorage)) {
    if (event.key === null) changed = true
    if (event.key === 'moli_mama_session') changed = unitSessionUser(event.oldValue) !== unitSessionUser(event.newValue)
    if (event.key === 'moli_mama_tenant_id') changed = event.oldValue !== event.newValue
  }
  const owner = unitOwnerSelection()
  if (changed || owner !== unitObservedOwner) { unitObservedOwner = owner; invalidateUnitProof() }
}
function invalidateUnitProof() {
  unitSequence += 1; unitController?.abort(); unitController = null
  clearUnitOutput()
  unitVerified.value = null; unitReading.value = false; unitError.value = ''
  unitOriginal.value = null; unitCompositionResult.value = null; unitCompositionError.value = ''
  unitCompositionBusy.value = false; unitCompositionBlocked.value = false
}
function unitRequestCurrent(ticket) {
  return unitContextValid() && ticket.sequence === unitSequence && ticket.token === unitToken()
}
function validUnitPlan(record, preview, review, intent, context) {
  const bindings = preview?.bindings
  return object(record) && record.work_id === context.work_id && Number(record.version_id) === intent.version_id
    && ['review', 'locked'].includes(record.status) && sha(record.blueprint_hash) && sha(record.localization_hash)
    && typeof record.updated_at === 'string' && Boolean(record.updated_at)
    && record.localization?.review?.status === record.status
    && record.localization.blueprint_hash === record.blueprint_hash && record.localization.localization_hash === record.localization_hash
    && preview?.schema_version === 'redraw-execution-plan-preview-v1' && preview.status === 'ready' && preview.executable === false
    && preview.plan_hash === intent.plan_hash && object(bindings) && bindings.work_id === context.work_id
    && bindings.version_id === intent.version_id && bindings.tenant_id === context.owner[0] && String(bindings.user_id) === context.owner[1]
    && bindings.blueprint_hash === record.blueprint_hash && bindings.localization_hash === record.localization_hash
    && bindings.localization_updated_at === record.updated_at && positive(bindings.source_asset_id)
    && sha(bindings.source_sha256) && sha(bindings.capability_hash)
    && bindings.locale === record.localization.locale && bindings.market === record.localization.market
    && ['native', 'replace', 'not_required'].includes(preview.capability?.audio_mode)
    && Array.isArray(preview.units) && preview.units.length > 0
    && positive(review?.id) && review.status === 'current' && review.plan_hash === preview.plan_hash
    && stable(review.plan) === stable(preview)
}
function validUnitQueue(value, preview, review, context) {
  const queue = value?.queue
  return stable(value?.preview) === stable(preview) && stable(value?.saved_review) === stable(review)
    && positive(queue?.id) && queue.work_id === context.work_id && queue.version_id === context.version_id
    && queue.status === 'waiting_readiness' && queue.executable === false && queue.plan_hash === preview.plan_hash
    && Array.isArray(queue.units) && queue.units.length === preview.units.length
    && new Set(queue.units.map(unit => unit.id)).size === queue.units.length
    && queue.units.every((unit, index) => typeof unit.id === 'string' && unit.id.length > 0 && unit.ordinal === index
      && unit.status === 'pending' && sha(unit.unit_hash) && unit.id === preview.units[index]?.id
      && stable(unit.plan_unit) === stable(preview.units[index]))
}
function validUnitRun(value, queue, review, intent, context) {
  return value?.id === intent.run_id && value.work_id === context.work_id && value.version_id === context.version_id
    && value.queue_id === queue.id && value.review_id === review.id && value.plan_hash === intent.plan_hash
    && value.binding_status === 'current' && value.executable === false && value.revision === intent.run_revision
    && ['ready', 'running', 'waiting_review', 'paused', 'failed', 'needs_attention', 'completed'].includes(value.status)
    && Array.isArray(value.units) && value.units.length === queue.units.length
    && value.units.every((unit, index) => unit.id === queue.units[index].id && unit.ordinal === index
      && unit.unit_hash === queue.units[index].unit_hash)
}
async function loadUnitProof() {
  invalidateUnitProof()
  if (!unitContextValid()) return
  const intent = { ...props.unitIntent }, context = props.unitContext
  unitController = new AbortController()
  const ticket = { sequence: unitSequence, token: unitToken(), controller: unitController }
  unitReading.value = true
  try {
    const record = await redrawAPI.getLocalization(intent.version_id)
    if (!unitRequestCurrent(ticket)) return
    if (!object(record) || record.work_id !== context.work_id || Number(record.version_id) !== intent.version_id) throw Error('localization binding')
    const result = await redrawAPI.getExecutionPlanReview(intent.version_id)
    if (!unitRequestCurrent(ticket)) return
    const preview = result?.preview, review = result?.saved_review
    if (!validUnitPlan(record, preview, review, intent, context)) throw Error('plan binding')
    const queueResult = await redrawAPI.getExecutionQueue(intent.version_id)
    if (!unitRequestCurrent(ticket)) return
    if (!validUnitQueue(queueResult, preview, review, context)) throw Error('queue binding')
    const queue = queueResult.queue
    const list = await redrawAPI.listExecutionRuns(intent.version_id, { signal: ticket.controller.signal })
    if (!unitRequestCurrent(ticket)) return
    if (list?.version_id !== intent.version_id || list.current_run_id !== intent.run_id || !Array.isArray(list.runs)
      || list.runs.filter(item => item?.id === intent.run_id).length !== 1
      || list.runs.filter(item => item?.binding_status === 'current').length !== 1) throw Error('run selection')
    const selected = list.runs.find(item => item.id === intent.run_id)
    if (!validUnitRun(selected, queue, review, intent, context)) throw Error('listed run binding')
    const run = await redrawAPI.getExecutionRun(intent.version_id, intent.run_id, { signal: ticket.controller.signal })
    if (!unitRequestCurrent(ticket)) return
    if (!validUnitRun(run, queue, review, intent, context)) throw Error('run binding')
    unitVerified.value = { run, preview }
    restoreUnitOriginal()
  } catch {
    if (unitRequestCurrent(ticket)) unitError.value = '导出准备核验失败或绑定已变化，请重新核验；不会自动合成、配音或下载。'
  } finally {
    if (ticket.sequence === unitSequence) { unitReading.value = false; unitController = null }
  }
}

function unitScope() {
  const context = props.unitContext
  return { owner: [...context.owner], project_id: context.project_id, work_id: context.work_id, version_id: context.version_id }
}
function unitStorageKey() { return `redraw-unit-composition:${stable(unitScope())}` }
function unitStorage() {
  if (typeof sessionStorage === 'undefined' || !sessionStorage
    || typeof sessionStorage.getItem !== 'function' || typeof sessionStorage.setItem !== 'function') throw Error('composition storage unavailable')
  return sessionStorage
}
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function validUnitKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 200 && key.trim() === key
    && !/[\x00-\x1f\x7f]/.test(key) && new TextDecoder().decode(new TextEncoder().encode(key)) === key
}
function parseUnitOriginal(raw) {
  const value = JSON.parse(raw), body = value?.body
  if (!exactKeys(value, ['schema_version', 'scope', 'body', 'request_hash', 'idempotency_key_sha256', 'export_id'])
    || value.schema_version !== 'redraw-unit-composition-intent-v1' || stable(value.scope) !== stable(unitScope())
    || !exactKeys(body, ['schema_version', 'run_id', 'expected_plan_hash', 'expected_run_revision', 'idempotency_key'])
    || body.schema_version !== unitCompositionSchema || !positive(body.run_id) || !sha(body.expected_plan_hash)
    || !Number.isSafeInteger(body.expected_run_revision) || body.expected_run_revision < 0 || !validUnitKey(body.idempotency_key)
    || !sha(value.request_hash) || !sha(value.idempotency_key_sha256)
    || (value.export_id !== null && !positive(value.export_id))) throw Error('invalid original composition')
  const knownId = unitKnownReceiptIds.get(stable([value.scope, value.request_hash, value.idempotency_key_sha256]))
  if (knownId !== undefined) {
    if (value.export_id !== null && value.export_id !== knownId) throw Error('original receipt conflict')
    value.export_id = knownId
  }
  return value
}
function restoreUnitOriginal() {
  const key = unitStorageKey()
  try {
    const raw = unitStorage().getItem(key)
    if (raw !== null) { unitFrozenScopes.add(key); unitOriginal.value = parseUnitOriginal(raw) }
  } catch {
    unitFrozenScopes.add(key)
    unitCompositionError.value = '原合成存储不可可靠核对，已冻结新提交；不会自动覆盖或更换幂等键。'
  }
  unitCompositionBlocked.value = unitFrozenScopes.has(key)
}
function unitReleaseRequest(original) {
  const body = original.body
  return JSON.stringify({ expected_plan_hash: body.expected_plan_hash, expected_run_revision: body.expected_run_revision,
    run_id: body.run_id, schema_version: 'redraw-execution-unit-release-v1', version_id: original.scope.version_id })
}
async function unitSha256(value) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
function writeUnitOriginal(key, original) {
  const storage = unitStorage(), raw = JSON.stringify(original)
  storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw Error('composition storage readback failed')
}
async function composeUnit() {
  if (!unitCanCompose.value || !unitContextValid()) return
  // Freeze synchronously: neither a second click nor proof refresh may mint another key.
  const key = unitStorageKey(), ticket = { sequence: unitSequence, token: unitToken() }
  if (unitFrozenScopes.has(key)) return
  unitFrozenScopes.add(key); unitCompositionBusy.value = true; unitCompositionBlocked.value = true
  try {
    const raw = unitStorage().getItem(key)
    if (raw !== null) { unitOriginal.value = parseUnitOriginal(raw); return }
    const original = { schema_version: 'redraw-unit-composition-intent-v1', scope: unitScope(),
      body: { schema_version: unitCompositionSchema, run_id: unitVerified.value.run.id,
        expected_plan_hash: unitVerified.value.preview.plan_hash, expected_run_revision: unitVerified.value.run.revision,
        idempotency_key: `unit-composition-${globalThis.crypto.randomUUID()}` },
      request_hash: '', idempotency_key_sha256: '', export_id: null }
    if (!validUnitKey(original.body.idempotency_key)) throw Error('invalid composition key')
    original.request_hash = await unitSha256(unitReleaseRequest(original))
    if (!unitRequestCurrent(ticket)) return
    original.idempotency_key_sha256 = await unitSha256(original.body.idempotency_key)
    if (!unitRequestCurrent(ticket)) return
    // Another mounted panel may have saved an intent while the hashes were pending.
    const existing = unitStorage().getItem(key)
    if (existing !== null) { unitOriginal.value = parseUnitOriginal(existing); return }
    writeUnitOriginal(key, original)
    unitOriginal.value = original
    const receipt = await redrawAPI.composeVersion(original.scope.version_id, { ...original.body })
    if (!unitRequestCurrent(ticket)) return
    if (positive(receipt?.export_id)) {
      unitKnownReceiptIds.set(stable([original.scope, original.request_hash, original.idempotency_key_sha256]), receipt.export_id)
      unitOriginal.value = { ...original, export_id: receipt.export_id }
      writeUnitOriginal(key, unitOriginal.value)
    }
  } catch {
    if (unitRequestCurrent(ticket)) unitCompositionError.value = '原合成结果未知或原意图未可靠保存；已冻结新提交，不会自动重试。'
  } finally {
    if (unitRequestCurrent(ticket)) unitCompositionBusy.value = false
  }
}
function matchesUnitExport(row, original) {
  return positive(row?.id) && row.version_id === original.scope.version_id && row.export_type === 'video'
    && row.schema_version === unitCompositionSchema && row.run_id === original.body.run_id
    && row.plan_hash === original.body.expected_plan_hash && row.request_hash === original.request_hash
    && row.idempotency_key_sha256 === original.idempotency_key_sha256
}
async function recoverUnitComposition() {
  if (!unitContextValid() || !unitVerified.value || !unitOriginal.value || unitCompositionBusy.value) return
  clearUnitOutput()
  const ticket = { sequence: unitSequence, token: unitToken() }, key = unitStorageKey()
  unitCompositionBusy.value = true; unitCompositionResult.value = null; unitCompositionError.value = ''
  try {
    const original = parseUnitOriginal(unitStorage().getItem(key))
    const requestHash = await unitSha256(unitReleaseRequest(original))
    if (!unitRequestCurrent(ticket)) return
    if (requestHash !== original.request_hash) throw Error('original request hash mismatch')
    const keyHash = await unitSha256(original.body.idempotency_key)
    if (!unitRequestCurrent(ticket)) return
    if (keyHash !== original.idempotency_key_sha256) throw Error('original key hash mismatch')
    const rows = await redrawAPI.listExports(original.scope.version_id)
    if (!unitRequestCurrent(ticket)) return
    if (!Array.isArray(rows)) throw Error('invalid export list')
    const matches = rows.filter(row => matchesUnitExport(row, original))
    if (matches.length !== 1 || (original.export_id !== null && matches[0].id !== original.export_id)) throw Error('original export not unique')
    const detail = await redrawAPI.getExport(matches[0].id)
    if (!unitRequestCurrent(ticket)) return
    if (!matchesUnitExport(detail, original) || detail.id !== matches[0].id
      || !['pending', 'processing', 'completed', 'failed', 'needs_attention'].includes(detail.status)) throw Error('export detail mismatch')
    unitOriginal.value = original
    unitCompositionResult.value = { id: detail.id, status: detail.status }
  } catch {
    if (unitRequestCurrent(ticket)) unitCompositionError.value = '原合成状态未知，原请求未能唯一核对；请仅在需要时再次只读核对，不会补发提交。'
  } finally {
    if (unitRequestCurrent(ticket)) unitCompositionBusy.value = false
  }
}

function clearUnitOutput() {
  unitOutputSequence += 1
  unitOutput.value = null; unitOutputBusy.value = false; unitOutputError.value = ''
  unitOutputUrls.forEach(url => URL.revokeObjectURL(url)); unitOutputUrls = []
}
function unitOutputCurrent(ticket) {
  return unitRequestCurrent(ticket) && ticket.generation === unitOutputSequence && Boolean(unitVerified.value)
    && unitCompositionResult.value?.status === 'completed' && unitCompositionResult.value.id === ticket.exportId
    && stable(unitOriginal.value) === ticket.original
}
function validUnitOutputDetail(detail, original, exportId) {
  const release = detail?.episode_release, proof = unitVerified.value, context = props.unitContext
  const run = proof.run, preview = proof.preview, bindings = preview.bindings, body = original.body
  if (!matchesUnitExport(detail, original) || detail.id !== exportId || detail.status !== 'completed'
    || (original.export_id !== null && detail.id !== original.export_id)
    || stable(original.scope) !== stable(unitScope()) || body.run_id !== run.id
    || body.expected_plan_hash !== run.plan_hash || body.expected_run_revision !== run.revision
    || run.status !== 'completed' || !run.units.every(unit => unit.status === 'approved')
    || !['native', 'not_required'].includes(preview.capability.audio_mode)
    || !sha(detail.release_hash) || !sha(detail.input_hash)
    || !unitOutputKinds.every(kind => positive(detail.output_asset_ids?.[kind]) && sha(detail.hashes?.[kind]))
    || new Set(unitOutputKinds.map(kind => detail.output_asset_ids[kind])).size !== 4
    || detail.asset_id !== detail.output_asset_ids.mp4 || detail.subtitle_asset_id !== detail.output_asset_ids.srt
    || release?.schema_version !== 'redraw-execution-unit-release-v1' || release.project_id !== context.project_id
    || release.work_id !== context.work_id || release.version_id !== context.version_id
    || release.run_id !== run.id || release.run_revision !== run.revision || release.plan_hash !== preview.plan_hash
    || typeof release.locale !== 'string' || !release.locale || release.locale !== bindings.locale
    || typeof release.market !== 'string' || !release.market || release.market !== bindings.market
    || release.source_sha256 !== bindings.source_sha256 || release.blueprint_hash !== bindings.blueprint_hash
    || release.localization_hash !== bindings.localization_hash || !positive(release.duration_ms)
    || release.audio_mode !== preview.capability.audio_mode || detail.audio_mode !== release.audio_mode
    || release.quality_summary?.final_media_review !== 'pending' || release.quality_summary.dialogue_alignment !== 'not_verified'
    || stable(detail.quality_summary) !== stable(release.quality_summary)
    || !Array.isArray(release.units) || release.units.length !== run.units.length) return false
  let outputEnd = 0
  return release.units.every((unit, index) => {
    const planned = preview.units[index], timeline = unit?.timeline
    if (unit?.unit_id !== run.units[index].id || unit.ordinal !== index || unit.unit_hash !== run.units[index].unit_hash
      || !sha(unit.candidate_sha256) || !sha(unit.review_hash) || !object(timeline)
      || !['source_start_ms', 'source_end_ms', 'retained_duration_ms', 'generated_duration_ms', 'padding_ms']
        .every(key => timeline[key] === planned[key])
      || !positive(timeline.retained_duration_ms) || unit.output_start_ms !== outputEnd
      || unit.output_end_ms !== outputEnd + timeline.retained_duration_ms) return false
    outputEnd = unit.output_end_ms
    return true
  }) && outputEnd === release.duration_ms
}
function unitAspect(value) {
  if (typeof value !== 'string' || !/^\d+:\d+$/.test(value)) return null
  const [numerator, denominator] = value.split(':').map(Number)
  return positive(numerator) && positive(denominator) ? numerator / denominator : null
}
function validUnitVtt(value) {
  // Validate the subtitle service's cue grammar on a copy; keep the downloaded Blob unchanged.
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  if (lines.shift() !== 'WEBVTT' || lines.shift() !== '') return false
  let previousEnd = 0
  return lines.join('\n').replace(/\n+$/, '').split(/\n{2,}/).every(block => {
    if (!block) return true
    const cue = block.split('\n'), timingIndex = /^\d+$/.test(cue[0]) ? 1 : 0
    const timing = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(cue[timingIndex])
    if (!timing) return false
    const time = offset => Number(timing[offset]) * 3600000 + Number(timing[offset + 1]) * 60000
      + Number(timing[offset + 2]) * 1000 + Number(timing[offset + 3])
    const start = time(1), end = time(5), text = cue.slice(timingIndex + 1)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previousEnd || end <= start
      || !text.length || !text.every(line => line.trim().length > 0 && !line.includes('-->'))) return false
    previousEnd = end
    return true
  })
}
function validUnitOutputReport(report, detail, files) {
  const release = detail.episode_release, media = report?.media, audio = report?.audio
  if (report?.schema_version !== 'redraw-execution-unit-composition-report-v1' || report.export_id !== detail.id
    || report.version_id !== detail.version_id || report.run_id !== release.run_id
    || report.release_hash !== detail.release_hash || report.input_hash !== detail.input_hash
    || report.final_media_review !== 'pending' || report.dialogue_alignment !== 'not_verified'
    || !['mp4', 'srt', 'vtt'].every(kind => report.outputs?.[kind]?.sha256 === files[kind].hash
      && report.outputs[kind].bytes === files[kind].size)
    || media?.sha256 !== files.mp4.hash || media.bytes !== files.mp4.size || media.mime_type !== 'video/mp4'
    || !positive(media.duration_ms) || Math.abs(media.duration_ms - release.duration_ms) > Math.max(250, Math.round(release.duration_ms * 0.03))
    || !positive(media.width) || !positive(media.height) || typeof media.has_audio !== 'boolean'
    || audio?.mode !== release.audio_mode || audio.approved_dub_required !== false
    || audio.no_dialogue_required !== (release.audio_mode === 'not_required')
    || audio.post_assembly_ambient_and_extra_dialogue_review_required !== true
    || !Array.isArray(audio.units) || audio.units.length !== release.units.length
    || !Array.isArray(report.units) || report.units.length !== release.units.length) return false
  const sar = unitAspect(media.sample_aspect_ratio), dar = unitAspect(media.display_aspect_ratio)
  const plannedAspect = unitAspect(unitVerified.value.run.output_parameters?.aspect_ratio)
  // Assembly preserves the first approved input geometry, not a resolution-name raster.
  if (!sar || !dar || !plannedAspect || Math.abs(media.width / media.height * sar - dar) > 0.000001
    || Math.abs(dar - plannedAspect) > 0.000001) return false
  const hasInputAudio = audio.units.some(unit => unit.input_has_audio === true)
  const native = release.audio_mode === 'native'
  const disposition = native ? 'approved_unit_tracks_preserved' : hasInputAudio
    ? 'available_unit_tracks_preserved_with_missing_intervals_silenced' : 'video_only_no_unit_tracks'
  return media.has_audio === hasInputAudio && (!native || media.has_audio) && audio.disposition === disposition
    && audio.units.every((unit, index) => unit.unit_id === release.units[index].unit_id
      && typeof unit.input_has_audio === 'boolean' && (!native || unit.input_has_audio)
      && unit.silence_placeholder === (!native && hasInputAudio && !unit.input_has_audio))
    && report.units.every((unit, index) => {
      const expected = release.units[index]
      return unit.unit_id === expected.unit_id && unit.ordinal === expected.ordinal
        && stable(unit.timeline) === stable(expected.timeline)
        && unit.output_start_ms === expected.output_start_ms && unit.output_end_ms === expected.output_end_ms
    })
}
async function loadUnitOutput() {
  if (!unitContextValid() || !unitVerified.value || !unitOriginal.value || unitCompositionBusy.value
    || unitOutputBusy.value || unitCompositionResult.value?.status !== 'completed') return
  clearUnitOutput()
  const ticket = { sequence: unitSequence, token: unitToken(), generation: unitOutputSequence,
    exportId: unitCompositionResult.value.id, original: stable(unitOriginal.value) }
  const urls = {}, files = {}
  let published = false
  unitOutputBusy.value = true
  try {
    const original = parseUnitOriginal(unitStorage().getItem(unitStorageKey()))
    if (stable(original) !== ticket.original) throw Error('original intent changed')
    const requestHash = await unitSha256(unitReleaseRequest(original))
    if (!unitOutputCurrent(ticket)) return
    if (requestHash !== original.request_hash) throw Error('original request hash mismatch')
    const keyHash = await unitSha256(original.body.idempotency_key)
    if (!unitOutputCurrent(ticket)) return
    if (keyHash !== original.idempotency_key_sha256) throw Error('original key hash mismatch')
    const detail = await redrawAPI.getExport(ticket.exportId)
    if (!unitOutputCurrent(ticket)) return
    if (!validUnitOutputDetail(detail, original, ticket.exportId)) throw Error('output detail binding')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (const kind of unitOutputKinds) {
      const blob = await redrawAPI.downloadExport(ticket.exportId, kind)
      if (!unitOutputCurrent(ticket)) return
      if (!(blob instanceof Blob)) throw Error('output is not Blob')
      const bytes = await blob.arrayBuffer()
      if (!unitOutputCurrent(ticket)) return
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
      if (!unitOutputCurrent(ticket)) return
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if (hash !== detail.hashes[kind] || bytes.byteLength !== blob.size) throw Error('output bytes mismatch')
      files[kind] = { blob, size: bytes.byteLength, hash }
      if (kind !== 'mp4') files[kind].text = decoder.decode(bytes)
    }
    const report = JSON.parse(files.report.text)
    if (!files.mp4.size || !validUnitVtt(files.vtt.text)
      || !validUnitOutputReport(report, detail, files)) throw Error('output report or media invalid')
    for (const kind of unitOutputKinds) {
      if (!unitOutputCurrent(ticket)) return
      urls[kind] = URL.createObjectURL(files[kind].blob)
    }
    if (!unitOutputCurrent(ticket)) return
    const updateMedia = (field, message) => {
      if (unitOutputCurrent(ticket) && unitOutput.value?.generation === ticket.generation) unitOutput.value[field] = message
    }
    // Bound closures keep retained DOM handlers from acting on a newer export generation.
    const downloadHandlers = Object.fromEntries(unitOutputKinds.map(kind => [kind, () => {
      if (!unitOutputCurrent(ticket) || unitOutput.value?.generation !== ticket.generation) return
      try {
        const anchor = document.createElement('a')
        if (!unitOutputCurrent(ticket)) return
        anchor.href = urls[kind]
        anchor.download = `redraw-unit-export-${ticket.exportId}.${kind === 'report' ? 'json' : kind}`
        anchor.click()
      } catch {
        if (unitOutputCurrent(ticket)) { clearUnitOutput(); unitOutputError.value = '文件下载失败，请重新核验四文件；不会自动重试。' }
      }
    }]))
    unitOutputUrls = Object.values(urls)
    unitOutput.value = { generation: ticket.generation, exportId: ticket.exportId, locale: detail.episode_release.locale, urls,
      playback: '视频尚未加载', subtitles: '字幕尚未加载', downloads: downloadHandlers,
      onMetadata: () => updateMedia('playback', '视频元数据已加载，等待可播放'),
      onCanplay: () => updateMedia('playback', '视频可播放'),
      onVideoError: () => updateMedia('playback', '视频播放错误，请重新核验或检查浏览器解码能力'),
      onTrackLoad: () => updateMedia('subtitles', '字幕已加载'),
      onTrackError: () => updateMedia('subtitles', '字幕加载错误，请重新核验') }
    published = true
  } catch {
    if (unitOutputCurrent(ticket)) unitOutputError.value = '四文件核验失败或绑定已变化，未开放播放或下载；不会自动重试。'
  } finally {
    if (!published) Object.values(urls).forEach(url => URL.revokeObjectURL(url))
    if (ticket.generation === unitOutputSequence) unitOutputBusy.value = false
  }
}

const downloads = computed(() => {
  if (createdRelease.value?.status === 'completed') return createdRelease.value.downloads || {}
  return exports.value.find((item) => item?.status === 'completed')?.downloads || {}
})

function newIdempotencyKey() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `episode-release-${random}`
}

function safeUrl(kind) {
  return controlledReleaseDownloadUrl(downloads.value?.[kind], kind === 'report')
}

async function load() {
  if (props.unitMode || !props.versionId) return
  try {
    const [nextReadiness, nextExports] = await Promise.all([
      redrawAPI.getReleaseReadiness(props.versionId),
      redrawAPI.listExports(props.versionId),
    ])
    if (props.unitMode) return
    readiness.value = normalizeReleaseReadiness(nextReadiness)
    exports.value = Array.isArray(nextExports) ? nextExports : []
    if (createdRelease.value?.export_id) {
      const current = exports.value.find((item) => Number(item.id) === Number(createdRelease.value.export_id))
      if (current) createdRelease.value = { ...createdRelease.value, ...current }
      if (current && !['pending', 'processing'].includes(current.status)) stopPolling()
    }
    loadError.value = ''
  } catch (error) {
    loadError.value = error?.response?.data?.error?.message || error?.message || '读取整集 readiness 失败'
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

function startPolling() {
  if (props.unitMode || pollTimer || !createdRelease.value || !['pending', 'processing'].includes(createdRelease.value.status)) return
  pollTimer = setInterval(load, 2500)
}

async function create() {
  if (props.unitMode || !props.versionId || !readiness.value.ready || !readiness.value.readiness_hash) return
  if (!idempotencyKey.value) idempotencyKey.value = newIdempotencyKey()
  creating.value = true
  try {
    createdRelease.value = await redrawAPI.createRelease(props.versionId, {
      idempotency_key: idempotencyKey.value,
      readiness_hash: readiness.value.readiness_hash,
    })
    await load()
    startPolling()
  } catch (error) {
    loadError.value = error?.response?.data?.error?.message || error?.message || '创建整集 release 失败'
    await load()
  } finally {
    creating.value = false
  }
}

async function download(kind) {
  if (props.unitMode) return
  const relativeUrl = safeUrl(kind)
  if (!relativeUrl) return
  const report = kind === 'report'
  const result = await redrawAPI.downloadReleaseArtifact(relativeUrl, report)
  const blob = report
    ? new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    : result
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = report ? 'redraw-release-report.json' : `redraw-release.${kind}`
  anchor.click()
  URL.revokeObjectURL(objectUrl)
}

watch(() => [props.versionId, props.refreshToken], ([versionId], [previousVersionId] = []) => {
  if (String(versionId || '') !== String(previousVersionId || '')) {
    stopPolling()
    idempotencyKey.value = ''
    createdRelease.value = null
  }
  load()
})
watch(() => [props.versionId, props.unitMode, props.unitIntent, props.unitContext], () => {
  invalidateUnitProof()
  if (props.unitMode) stopPolling()
}, { deep: true, flush: 'sync' })
watch(() => [props.versionId, props.unitMode, props.unitIntent, props.unitContext], () => {
  if (props.unitMode) loadUnitProof()
}, { immediate: true, deep: true })
if (typeof window !== 'undefined') { window.addEventListener('storage', checkUnitOwner); window.addEventListener('focus', checkUnitOwner) }
onMounted(load)
onBeforeUnmount(() => {
  unitAlive = false; invalidateUnitProof(); stopPolling()
  if (typeof window !== 'undefined') { window.removeEventListener('storage', checkUnitOwner); window.removeEventListener('focus', checkUnitOwner) }
})
</script>

<style scoped>
.release-panel { display: grid; justify-items: start; gap: 12px; padding: 14px; border: 1px solid #2d2d2d; border-radius: 10px; background: #121212; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3, p { margin: 0; }
.blockers { display: grid; gap: 7px; width: 100%; margin: 0; padding: 0; list-style: none; }
.blockers li { display: flex; justify-content: space-between; gap: 10px; padding: 9px; border-radius: 8px; background: #1c1c1c; }
.blockers span { color: #ffc66d; overflow-wrap: anywhere; }
.downloads { display: flex; flex-wrap: wrap; gap: 8px; }
.unit-output { display: grid; gap: 10px; width: 100%; }
.unit-output video { max-width: 100%; max-height: 60vh; }
</style>
