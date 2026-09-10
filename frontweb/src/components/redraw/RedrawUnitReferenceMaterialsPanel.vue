<template>
  <section class="unit-materials" aria-label="执行单元素材">
    <h4>单元素材</h4>
    <p>仅检查或本地准备已审核素材，不生成、不扣费；已准备不代表可以开始生成。</p>
    <p v-if="!contextReady" role="status">计划、审核或队列未就绪或已失效，请先刷新当前计划。</p>
    <template v-else>
      <label>选择执行单元
        <select v-model="selectedUnitId" aria-label="选择执行单元">
          <option v-for="unit in queue.units" :key="unit.id" :value="unit.id">单元 {{ unit.ordinal + 1 }}</option>
        </select>
      </label>
      <p v-if="selectedUnit">单元 {{ selectedUnit.ordinal + 1 }} · 源片 {{ seconds(selectedUnit.plan_unit.source_start_ms) }}—{{ seconds(selectedUnit.plan_unit.source_end_ms) }} 秒</p>
      <p role="status">{{ statusText }}</p>
      <div class="material-actions">
        <el-button :disabled="!canCheck" :loading="busy === 'checking'" @click="checkMaterials">检查素材</el-button>
        <el-button :disabled="!canPrepare" :loading="busy === 'preparing'" @click="prepareMaterials">本地准备</el-button>
      </div>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { redrawAPI } from '@/api/redraw'

const props = defineProps({ record: { type: Object, required: true }, preview: Object, savedReview: Object,
  queue: Object, blocked: { type: Boolean, default: false }, projectPolicy: Object })
const emit = defineEmits(['prepared'])
const selectedUnitId = ref('')
const materials = ref(null)
const busy = ref('')
const error = ref('')
let sequence = 0
let alive = true
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const contextReady = computed(() => {
  const p = props.preview, r = props.savedReview, q = props.queue, record = props.record
  return !props.blocked && p?.status === 'ready' && p.executable === false && sha(p.plan_hash)
    && r?.status === 'current' && positive(r.id) && r.plan_hash === p.plan_hash && stable(r.plan) === stable(p)
    && q?.status === 'waiting_readiness' && q.executable === false && positive(q.id) && q.plan_hash === p.plan_hash
    && positive(q.work_id) && q.work_id === p.bindings?.work_id && q.version_id === Number(record.version_id)
    && p.bindings?.version_id === Number(record.version_id) && p.bindings.blueprint_hash === record.blueprint_hash
    && p.bindings.localization_hash === record.localization_hash && p.bindings.localization_updated_at === record.updated_at
    && Array.isArray(p.units) && p.units.length > 0 && Array.isArray(q.units) && q.units.length === p.units.length
    && q.units.every((unit, ordinal) => unit.ordinal === ordinal && unit.status === 'pending' && sha(unit.unit_hash)
      && unit.id === unit.plan_unit?.id && unit.id === p.units[ordinal]?.id && stable(unit.plan_unit) === stable(p.units[ordinal]))
})
const selectedUnit = computed(() => props.queue?.units?.find(unit => unit.id === selectedUnitId.value) || null)
const canCheck = computed(() => alive && contextReady.value && Boolean(selectedUnit.value) && !busy.value)
const canPrepare = computed(() => canCheck.value && materials.value?.status === 'needs_preparation' && !error.value)
const statusText = computed(() => busy.value === 'preparing' ? '正在本地准备，结果仍待复核…'
  : busy.value === 'checking' ? '正在只读检查素材…' : materials.value?.status === 'prepared' ? '已准备（仅本地素材）'
    : materials.value?.status === 'needs_preparation' ? '待准备：请显式点击本地准备' : error.value ? '状态失效或结果未确认' : '待检查素材')
function context() { return stable([props.record, props.preview, props.savedReview, props.queue, props.blocked, props.projectPolicy, selectedUnitId.value]) }
function current(id, token) { return alive && sequence === id && context() === token && contextReady.value }
function invalidate() { sequence++; materials.value = null; error.value = '' }
function input() { return { review_id: props.savedReview.id, plan_hash: props.preview.plan_hash, unit_hash: selectedUnit.value.unit_hash } }
function target() { return [Number(props.record.version_id), props.queue.id, selectedUnitId.value, input()] }
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value)))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
function assertBindings(bindings) {
  const plan = props.preview.bindings
  const expected = { tenant_id: plan.tenant_id, user_id: plan.user_id, work_id: plan.work_id, version_id: plan.version_id,
    review_id: props.savedReview.id, queue_id: props.queue.id, plan_hash: props.preview.plan_hash, unit_id: selectedUnitId.value,
    unit_hash: selectedUnit.value.unit_hash, source_asset_id: plan.source_asset_id, source_sha256: plan.source_sha256,
    blueprint_hash: plan.blueprint_hash, localization_hash: plan.localization_hash, capability_hash: plan.capability_hash }
  if (!bindings || Object.keys(bindings).length !== Object.keys(expected).length + 1 || !sha(bindings.production_pack_hash)
    || Object.entries(expected).some(([key, value]) => value == null || bindings[key] !== value)) throw Error('binding invalid')
}
async function assertPrepared(value, expectedHash, bindings) {
  if (!value || value.schema_version !== 'redraw-unit-prepared-reference-materials-v1' || value.materials_hash !== expectedHash
    || !sha(value.prepared_materials_hash) || !Array.isArray(value.references)
    || (bindings && stable(value.bindings) !== stable(bindings))) throw Error('prepared invalid')
  assertBindings(value.bindings)
  const { prepared_materials_hash: expectedDigest, ...unsigned } = value
  if (await digest(unsigned) !== expectedDigest) throw Error('prepared hash invalid')
}
async function checked(value) {
  if (!value || value.schema_version !== 'redraw-unit-prepared-reference-inspection-v1' || !sha(value.materials_hash)
    || !['prepared', 'needs_preparation'].includes(value.status)) throw Error('inspection invalid')
  assertBindings(value.bindings)
  if (value.status === 'prepared') await assertPrepared(value.prepared_materials, value.materials_hash, value.bindings)
  else if (value.prepared_materials != null || !Array.isArray(value.missing_requirement_ids) || !value.missing_requirement_ids.length
    || value.missing_requirement_ids.some(id => !selectedUnit.value.plan_unit.reference_requirements.some(item => item.id === id))) throw Error('missing invalid')
  return value
}
async function checkMaterials() {
  if (!canCheck.value) return
  const id = ++sequence, token = context(), args = target(), unit = selectedUnit.value.plan_unit
  const policy = props.projectPolicy ? { ...props.projectPolicy } : null
  materials.value = null; error.value = ''; busy.value = 'checking'
  try {
    if (await digest(unit) !== args[3].unit_hash) throw Error('unit hash invalid')
    if (!current(id, token)) return
    const next = await redrawAPI.getUnitReferenceMaterials(...args)
    if (!current(id, token)) return
    const value = await checked(next)
    if (current(id, token)) {
      materials.value = value
      if (value.status === 'prepared') emit('prepared', { ...value, projectPolicy: policy })
    }
  } catch {
    if (current(id, token)) error.value = '素材状态失效或校验失败，请刷新当前计划后检查素材'
  } finally { busy.value = '' }
}
async function prepareMaterials() {
  if (!canPrepare.value) return
  const id = ++sequence, token = context(), args = target(), expectedHash = materials.value.materials_hash
  const policy = props.projectPolicy ? { ...props.projectPolicy } : null
  args[3] = { ...args[3], expected_materials_hash: expectedHash }
  materials.value = null; error.value = ''; busy.value = 'preparing'
  try {
    const prepared = await redrawAPI.prepareUnitReferenceMaterials(...args)
    if (!current(id, token)) return
    await assertPrepared(prepared, expectedHash)
    if (!current(id, token)) return
    const next = await redrawAPI.getUnitReferenceMaterials(args[0], args[1], args[2], input())
    if (!current(id, token)) return
    const value = await checked(next)
    if (value.status !== 'prepared' || value.materials_hash !== expectedHash
      || value.prepared_materials.prepared_materials_hash !== prepared.prepared_materials_hash) throw Error('prepare not confirmed')
    if (current(id, token)) {
      materials.value = value
      emit('prepared', { ...value, projectPolicy: policy })
    }
  } catch (failure) {
    if (current(id, token)) error.value = Number(failure?.response?.status) === 409
      ? '计划或素材已失效，请刷新当前计划后检查素材；未自动重试准备'
      : '本地准备结果未确认，请点击检查素材只读核对；不会自动重试准备'
  } finally { busy.value = '' }
}
watch(() => [props.record, props.preview, props.savedReview, props.queue, props.blocked, props.projectPolicy], () => {
  invalidate(); selectedUnitId.value = contextReady.value ? props.queue.units[0].id : ''
}, { immediate: true, deep: true, flush: 'sync' })
watch(selectedUnitId, invalidate, { flush: 'sync' })
onUnmounted(() => { alive = false; invalidate() })
function seconds(value) { return (Number(value) / 1000).toFixed(3).replace(/\.?0+$/, '') }
</script>

<style scoped>
.unit-materials { border-top: 1px solid #334155; padding-top: 16px; margin-top: 16px; }
h4 { margin: 0 0 10px; } p { line-height: 1.6; overflow-wrap: anywhere; }
label, .material-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
select { color: #e2e8f0; background: #151b27; border: 1px solid #64748b; border-radius: 4px; padding: 8px; }
select:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
[role="alert"] { color: #fca5a5; }
</style>
