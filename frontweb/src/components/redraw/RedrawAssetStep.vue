<template>
  <section class="redraw-asset-step">
    <div class="section-heading">
      <div><p class="eyebrow">02 · 资产审核</p><h2>确认本地化资产后再进入批量转绘</h2></div>
      <el-tag>{{ assets.length }} 项资产</el-tag>
    </div>
    <nav class="asset-tabs" aria-label="资产类型">
      <button v-for="item in ASSET_KINDS" :key="item.key" type="button" :class="{ active: activeKind === item.key }" @click="activeKind = item.key">{{ item.label }}</button>
    </nav>
    <RedrawReviewGate :gate="gate" />
    <div class="asset-batch-panel">
      <div class="canvas-credit-callout-v1 asset-batch-credits">
        <span>资产批量总价</span>
        <strong v-if="batchCredits">本次预计扣除 {{ batchCredits }} 积分</strong>
        <strong v-else>积分待管理员配置</strong>
      </div>
      <div v-if="activeBatch" class="asset-batch-progress">
        <el-progress :percentage="batchProgress.percent" />
        <span>{{ batchProgress.successCount }} 成功 / {{ batchProgress.failedCount }} 失败 / {{ batchProgress.totalCount }} 总数</span>
      </div>
      <div class="asset-batch-actions">
        <el-button type="primary" :loading="batchSubmitting" :disabled="!batchReady" @click="startAssetBatch()">
          一键批量生成全部资产
        </el-button>
        <el-button v-if="canRetryFailedAssets" :loading="batchSubmitting" :disabled="!failedIds.length" @click="retryFailedAssets">
          一键重试失败项
        </el-button>
      </div>
    </div>
    <RedrawVoicePicker v-if="activeKind === 'voice'" :voices="visibleAssets" @select="selectVoice" />
    <div class="asset-grid">
      <RedrawAssetCard v-for="asset in visibleAssets" :key="asset.id" :asset="asset" :quote="asset.quote_credits || quote" @generate="generate" @review="review" />
      <p v-if="!visibleAssets.length" class="empty-state">当前类型暂无资产</p>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { redrawAPI } from '@/api/redraw'
import {
  ASSET_KINDS,
  assetBatchCredits,
  assetBatchProgress,
  canStartAssetBatch,
  failedAssetIds,
  generationGateOpen,
  groupAssets,
} from '@/utils/redrawAssetState'
import RedrawAssetCard from './RedrawAssetCard.vue'
import RedrawReviewGate from './RedrawReviewGate.vue'
import RedrawVoicePicker from './RedrawVoicePicker.vue'

const props = defineProps({
  work: { type: Object, default: null },
  versionId: { type: [String, Number], default: null },
})
const emit = defineEmits(['work-updated', 'gate-updated'])
const assets = ref([])
const gate = ref({ ok: false, missing: [] })
const activeKind = ref('character')
const loading = ref(false)
const quote = ref(0)
const batchQuote = ref(null)
const batchWork = ref(null)
const batchSubmitting = ref(false)
const batchIdempotencyKey = ref(null)
const pendingQuoteContext = ref('')
let pollTimer = null
const resolvedVersionId = computed(() => props.versionId || props.work?.version_id || props.work?.current_version_id)
const visibleAssets = computed(() => groupAssets(assets.value, activeKind.value))
const activeBatch = computed(() => batchWork.value || props.work?.asset_batch || null)
const batchCredits = computed(() => assetBatchCredits(batchQuote.value))
const batchProgress = computed(() => assetBatchProgress(activeBatch.value))
const batchReady = computed(() => canStartAssetBatch(batchQuote.value, activeBatch.value) && !batchSubmitting.value)
const failedIds = computed(() => failedAssetIds({ items: assets.value }))
const canRetryFailedAssets = computed(() => activeBatch.value?.status === 'partial_failed')

function quoteHash(result) {
  return result?.quote_hash || result?.hash || ''
}

function quoteContext(versionId, assetIds) {
  return JSON.stringify({ versionId: String(versionId || ''), assetIds: assetIds || [] })
}

function normalizeBatch(result) {
  return result?.asset_batch || result?.batch || result || null
}

function batchTerminal(batch) {
  return ['completed', 'partial_failed', 'failed'].includes(String(batch?.status || ''))
}

function nextIdempotencyKey() {
  if (!batchIdempotencyKey.value) batchIdempotencyKey.value = crypto.randomUUID()
  return batchIdempotencyKey.value
}

async function loadAssetBatchQuote(assetIds = null) {
  if (!resolvedVersionId.value) return null
  const versionId = resolvedVersionId.value
  const ids = Array.isArray(assetIds) ? assetIds : []
  const context = quoteContext(versionId, ids)
  pendingQuoteContext.value = context
  const result = ids.length
    ? await redrawAPI.quoteAssetBatch(resolvedVersionId.value, { asset_ids: ids })
    : await redrawAPI.quoteAssetBatch(resolvedVersionId.value, {})
  if (resolvedVersionId.value !== versionId || pendingQuoteContext.value !== context) return null
  batchQuote.value = result || null
  return batchQuote.value
}

async function refresh(options = {}) {
  if (!resolvedVersionId.value) return
  const quoteBatch = options.quoteBatch !== false
  loading.value = true
  try {
    const [items, nextGate] = await Promise.all([
      redrawAPI.listAssets(resolvedVersionId.value),
      redrawAPI.getGenerationGate(resolvedVersionId.value),
    ])
    assets.value = Array.isArray(items) ? items : []
    const quoted = await Promise.all(assets.value.map(async (asset) => {
      const nextQuote = await redrawAPI.getAssetQuote(asset.id)
      return { ...asset, quote_credits: nextQuote?.credits || null }
    }))
    assets.value = quoted
    gate.value = nextGate || { ok: false, missing: [] }
    emit('gate-updated', gate.value)
    if (quoteBatch) await loadAssetBatchQuote()
  } finally {
    loading.value = false
  }
}

async function generate(asset) {
  try {
    const quoteResult = await redrawAPI.getAssetQuote(asset.id)
    if (!quoteResult?.priced) {
      ElMessage.warning('积分待管理员配置')
      return
    }
    await redrawAPI.generateAsset(asset.id, { prompt: asset.prompt })
    await refresh()
    ElMessage.success('资产生成任务已完成')
  }
  catch (error) { ElMessage.error(error.message || '资产生成失败') }
}

async function review(asset, action) {
  try {
    const result = await redrawAPI.reviewAsset(asset.id, { action, expected_updated_at: asset.updated_at })
    if (result?.current_step || result?.status) {
      emit('work-updated', {
        ...props.work,
        current_step: result.current_step || props.work?.current_step,
        status: result.status || props.work?.status,
      })
    }
    await refresh()
    ElMessage.success(action === 'approved' ? '资产已批准' : '资产已退回')
  } catch (error) { ElMessage.error(error.message || '审核失败') }
}

async function pollBatchWork() {
  if (!props.work?.id) return
  const versionId = resolvedVersionId.value
  try {
    const work = await redrawAPI.getWork(props.work.id)
    if (resolvedVersionId.value !== versionId) return
    emit('work-updated', work)
    batchWork.value = normalizeBatch(work?.asset_batch)
    await refresh({ quoteBatch: false })
    if (batchTerminal(batchWork.value)) {
      stopBatchPolling()
      batchIdempotencyKey.value = null
    }
  } catch (error) {
    ElMessage.error(error.message || '批量资产状态刷新失败')
  }
}

function startBatchPolling() {
  stopBatchPolling()
  pollTimer = window.setInterval(pollBatchWork, 3000)
  pollBatchWork()
}

function stopBatchPolling() {
  if (!pollTimer) return
  window.clearInterval(pollTimer)
  pollTimer = null
}

async function startAssetBatch(assetIds = null) {
  if (batchSubmitting.value || !resolvedVersionId.value) return
  const ids = Array.isArray(assetIds) ? assetIds : []
  const previousHash = quoteHash(batchQuote.value)
  batchSubmitting.value = true
  try {
    const nextQuote = await loadAssetBatchQuote(ids)
    const nextHash = quoteHash(nextQuote)
    if (!previousHash || !nextHash || nextHash !== previousHash || !canStartAssetBatch(nextQuote, activeBatch.value)) {
      ElMessage.warning('批量报价已更新，请再次确认')
      return
    }
    const versionId = resolvedVersionId.value
    const body = {
      quote_hash: nextHash,
      idempotency_key: nextIdempotencyKey(),
    }
    if (ids.length) body.asset_ids = ids
    const result = await redrawAPI.createAssetBatch(versionId, body)
    if (resolvedVersionId.value !== versionId) return
    batchWork.value = normalizeBatch(result)
    startBatchPolling()
    ElMessage.success('资产批量生成任务已创建')
  } catch (error) {
    ElMessage.error(error.message || '资产批量生成失败')
  } finally {
    batchSubmitting.value = false
  }
}

function retryFailedAssets() {
  if (!failedIds.value.length) {
    ElMessage.warning('暂无可确定的失败资产')
    return
  }
  startAssetBatch(failedIds.value)
}

function selectVoice() {}

onMounted(async () => {
  await refresh()
  if (['pending', 'processing'].includes(String(activeBatch.value?.status || ''))) startBatchPolling()
})
onUnmounted(stopBatchPolling)
watch(resolvedVersionId, async () => {
  stopBatchPolling()
  batchQuote.value = null
  batchWork.value = null
  batchIdempotencyKey.value = null
  await refresh()
})

defineExpose({ refresh, generationGateOpen })
</script>

<style scoped>
.redraw-asset-step { display: grid; gap: 14px; min-width: 0; }
.section-heading { display: flex; justify-content: space-between; gap: 12px; min-width: 0; }
.section-heading > div { min-width: 0; }
.eyebrow { margin: 0 0 5px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h2 { margin: 0; font-size: 20px; overflow-wrap: anywhere; }
.asset-tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.asset-tabs button { min-width: 0; padding: 10px; border: 1px solid #2f2f2f; border-radius: 6px; background: #121212; color: #aaa; }
.asset-tabs button.active { border-color: #ff7139; color: #fff; }
.asset-batch-panel { display: grid; gap: 10px; padding: 12px; border: 1px solid #333; border-radius: 6px; background: #141414; }
.asset-batch-credits { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; color: #eee; }
.asset-batch-credits span { color: #aaa; font-size: 13px; }
.asset-batch-credits strong { color: #ffd166; overflow-wrap: anywhere; }
.asset-batch-progress { display: grid; gap: 6px; color: #aaa; font-size: 13px; }
.asset-batch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.asset-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; min-width: 0; }
.empty-state { grid-column: 1 / -1; padding: 30px; border: 1px dashed #363636; color: #888; text-align: center; }
@media (max-width: 720px) { .section-heading { align-items: stretch; flex-direction: column; } .asset-grid { grid-template-columns: 1fr; } }
</style>
