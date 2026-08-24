<template>
  <section class="redraw-asset-step">
    <div class="section-heading">
      <div><p class="eyebrow">02 · 资产审核</p><h2>确认本地化资产后再进入批量转绘</h2></div>
      <el-tag>{{ assets.length }} 项资产</el-tag>
    </div>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <RedrawCharacterLibraryPanel :plan="characterPlan" :loading="loading" />
    <nav class="asset-tabs" aria-label="资产类型">
      <button v-for="item in ASSET_KINDS" :key="item.key" type="button" :class="{ active: activeKind === item.key }" @click="activeKind = item.key">{{ item.label }}</button>
    </nav>
    <RedrawReviewGate :gate="gate" />
    <div class="asset-batch-panel">
      <div class="canvas-credit-callout-v1 asset-batch-credits">
        <span>资产批量总价</span>
        <strong v-if="batchQuoteApplicable === false">当前无需批量生成</strong>
        <strong v-else-if="batchCredits">本次预计扣除 {{ batchCredits }} 积分</strong>
        <strong v-else>积分待管理员配置</strong>
      </div>
      <el-alert v-if="batchQuoteError" :title="batchQuoteError" type="warning" :closable="false" show-icon />
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
    <RedrawVoicePicker
      v-if="activeKind === 'voice'"
      :characters="characterAssets"
      :voices="productionVoices"
      :loading="voiceBinding"
      :previewing-voice-id="previewingVoiceId"
      @assign="selectVoice"
      @preview="previewVoice"
      @preview-stop="stopVoicePreview"
    />
    <div class="asset-grid">
      <RedrawAssetCard
        v-for="asset in visibleAssets"
        :key="asset.id"
        :asset="asset"
        :quote="asset.quote_credits || quote"
        :wardrobe-reference-assets="wardrobeReferenceAssets"
        @generate="generate"
        @review="review"
        @identity-saved="handleIdentitySaved"
      />
      <p v-if="!visibleAssets.length" class="empty-state">当前类型暂无资产</p>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { redrawAPI } from '@/api/redraw'
import { isRedrawCharacterIdentityPackReady } from '@/utils/redrawCharacterIdentity'
import {
  ASSET_KINDS,
  assetBatchCredits,
  assetBatchProgress,
  assetBatchQuoteApplicable,
  canStartAssetBatch,
  failedAssetIds,
  confirmSingleAssetQuote,
  generationGateOpen,
  groupAssets,
  isAssetVersionContextCurrent,
  resolveAssetBatchQuoteForRefresh,
  singleAssetGenerationNotice,
} from '@/utils/redrawAssetState'
import RedrawAssetCard from './RedrawAssetCard.vue'
import RedrawCharacterLibraryPanel from './RedrawCharacterLibraryPanel.vue'
import RedrawReviewGate from './RedrawReviewGate.vue'
import RedrawVoicePicker from './RedrawVoicePicker.vue'

function createVoicePreviewController(options = {}) {
  const createAudio = options.createAudio || (() => new Audio())
  const fetchPreview = options.fetchPreview || (() => Promise.reject(new Error('音色预览请求不可用')))
  const createObjectURL = options.createObjectURL || ((blob) => URL.createObjectURL(blob))
  const revokeObjectURL = options.revokeObjectURL || ((url) => URL.revokeObjectURL(url))
  const onPlayingChange = options.onPlayingChange || (() => {})
  const onError = options.onError || (() => {})
  let player = null
  let loadedVoiceId = null
  let loadedPreviewUrl = ''
  let loadedObjectUrl = ''
  let playingVoiceId = null
  let operationId = 0
  let disposed = false

  const setPlaying = (voiceId) => {
    playingVoiceId = voiceId
    onPlayingChange(voiceId)
  }
  const releaseLoadedPreview = () => {
    if (loadedObjectUrl) revokeObjectURL(loadedObjectUrl)
    loadedObjectUrl = ''
    loadedVoiceId = null
    loadedPreviewUrl = ''
    if (player) {
      player.removeAttribute('src')
      player.load()
    }
  }
  const handleEnded = () => {
    operationId += 1
    setPlaying(null)
    releaseLoadedPreview()
  }
  const ensurePlayer = () => {
    if (player) return player
    player = createAudio()
    player.addEventListener('ended', handleEnded)
    return player
  }
  const stop = () => {
    operationId += 1
    if (player && !player.paused) player.pause()
    setPlaying(null)
    releaseLoadedPreview()
    return false
  }

  const toggle = async (voice = {}) => {
    const voiceId = voice.id
    const previewUrl = String(voice.preview_url || '').trim()
    if (disposed || voiceId == null || !previewUrl) return false
    const audio = ensurePlayer()
    if (playingVoiceId != null
      && String(playingVoiceId) === String(voiceId)
      && !audio.paused) {
      operationId += 1
      audio.pause()
      setPlaying(null)
      return false
    }

    const nextOperationId = ++operationId
    if (playingVoiceId != null || !audio.paused) {
      audio.pause()
      setPlaying(null)
    }
    if (loadedVoiceId == null
      || String(loadedVoiceId) !== String(voiceId)
      || loadedPreviewUrl !== previewUrl) {
      releaseLoadedPreview()
      let objectUrl = ''
      try {
        const blob = await fetchPreview(voice)
        if (disposed || nextOperationId !== operationId) return false
        objectUrl = createObjectURL(blob)
        if (disposed || nextOperationId !== operationId) {
          revokeObjectURL(objectUrl)
          return false
        }
        audio.src = objectUrl
        loadedVoiceId = voiceId
        loadedPreviewUrl = previewUrl
        loadedObjectUrl = objectUrl
      } catch (error) {
        if (objectUrl) revokeObjectURL(objectUrl)
        if (disposed || nextOperationId !== operationId) return false
        setPlaying(null)
        onError(error)
        return false
      }
    }
    try {
      await audio.play()
      if (disposed || nextOperationId !== operationId) return false
      setPlaying(voiceId)
      return true
    } catch (error) {
      if (disposed || nextOperationId !== operationId) return false
      setPlaying(null)
      releaseLoadedPreview()
      onError(error)
      return false
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    operationId += 1
    if (player) {
      player.pause()
      player.removeEventListener('ended', handleEnded)
    }
    releaseLoadedPreview()
    player = null
    setPlaying(null)
  }

  return { toggle, stop, dispose }
}

const props = defineProps({
  work: { type: Object, default: null },
  versionId: { type: [String, Number], default: null },
})
const emit = defineEmits(['work-updated', 'gate-updated'])
const assets = ref([])
const characterPlan = ref(null)
const productionVoices = ref([])
const gate = ref({ ok: false, missing: [] })
const activeKind = ref('character')
const loading = ref(false)
const voiceBinding = ref(false)
const previewingVoiceId = ref(null)
const quote = ref(0)
const batchQuote = ref(null)
const batchWork = ref(null)
const batchSubmitting = ref(false)
const batchIdempotencyKey = ref(null)
const pendingQuoteContext = ref('')
const batchQuoteApplicable = ref(null)
const batchQuoteError = ref('')
const loadError = ref('')
let pollTimer = null
const resolvedVersionId = computed(() => props.versionId || props.work?.version_id || props.work?.current_version_id)
const visibleAssets = computed(() => groupAssets(assets.value, activeKind.value))
const characterAssets = computed(() => groupAssets(assets.value, 'character'))
const wardrobeReferenceAssets = computed(() => assets.value.filter((asset) => {
  const assetId = Number(asset?.asset_id)
  return asset.kind !== 'voice' && Number.isSafeInteger(assetId) && assetId > 0
}))
const activeBatch = computed(() => batchWork.value || props.work?.asset_batch || null)
const batchCredits = computed(() => assetBatchCredits(batchQuote.value))
const batchProgress = computed(() => assetBatchProgress(activeBatch.value))
const batchReady = computed(() => canStartAssetBatch(batchQuote.value, activeBatch.value) && !batchSubmitting.value)
const failedIds = computed(() => failedAssetIds({ items: assets.value }))
const canRetryFailedAssets = computed(() => activeBatch.value?.status === 'partial_failed')
const previewController = createVoicePreviewController({
  fetchPreview: (voice) => redrawAPI.getVoicePreview(resolvedVersionId.value, voice.id),
  onPlayingChange: (voiceId) => { previewingVoiceId.value = voiceId },
  onError: (error) => ElMessage.error(error?.message || '音色试听失败'),
})

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
  return ['completed', 'partial_failed', 'failed', 'needs_attention'].includes(String(batch?.status || ''))
}

function nextIdempotencyKey() {
  if (!batchIdempotencyKey.value) batchIdempotencyKey.value = crypto.randomUUID()
  return batchIdempotencyKey.value
}

function isCurrentVersion(versionId) {
  return isAssetVersionContextCurrent(versionId, resolvedVersionId.value)
}

async function loadProductionVoices(versionId = resolvedVersionId.value) {
  if (!versionId) {
    productionVoices.value = []
    return
  }
  const items = await redrawAPI.listProductionVoices(versionId)
  if (!isCurrentVersion(versionId)) return
  productionVoices.value = Array.isArray(items) ? items : []
}

async function loadAssetBatchQuote(assetIds = null) {
  if (!resolvedVersionId.value) return null
  const versionId = resolvedVersionId.value
  const ids = Array.isArray(assetIds) ? assetIds : []
  const context = quoteContext(versionId, ids)
  pendingQuoteContext.value = context
  const result = ids.length
    ? await redrawAPI.quoteAssetBatch(versionId, { asset_ids: ids })
    : await redrawAPI.quoteAssetBatch(versionId, {})
  if (!isCurrentVersion(versionId) || pendingQuoteContext.value !== context) return null
  batchQuote.value = result || null
  return batchQuote.value
}

async function refresh(options = {}) {
  if (!resolvedVersionId.value) return
  const versionId = resolvedVersionId.value
  const quoteBatch = options.quoteBatch !== false
  loading.value = true
  try {
    const [items, nextGate, nextCharacterPlan] = await Promise.all([
      redrawAPI.listAssets(versionId),
      redrawAPI.getGenerationGate(versionId),
      redrawAPI.getCharacterPlan(versionId),
    ])
    if (!isCurrentVersion(versionId)) return
    const nextAssets = Array.isArray(items) ? items : []
    const quoted = await Promise.all(nextAssets.map(async (asset) => {
      const nextQuote = await redrawAPI.getAssetQuote(asset.id)
      if (!isCurrentVersion(versionId)) return null
      return {
        ...asset,
        quote_credits: nextQuote?.credits || null,
        quote_hash: quoteHash(nextQuote),
      }
    }))
    if (quoted.some((asset) => !asset)) return
    if (!isCurrentVersion(versionId)) return
    assets.value = quoted
    characterPlan.value = nextCharacterPlan || null
    gate.value = nextGate || { ok: false, missing: [] }
    emit('gate-updated', gate.value)
    if (!isCurrentVersion(versionId)) return
    if (quoteBatch) {
      const quoteState = await resolveAssetBatchQuoteForRefresh(quoted, () => loadAssetBatchQuote())
      if (!isCurrentVersion(versionId)) return
      batchQuoteApplicable.value = quoteState.applicable
      batchQuote.value = quoteState.quote
      batchQuoteError.value = quoteState.error
        ? quoteState.error?.response?.data?.error?.message || quoteState.error.message || '批量资产报价失败'
        : ''
      if (!quoteState.applicable) pendingQuoteContext.value = ''
    } else if (!assetBatchQuoteApplicable(quoted)) {
      batchQuoteApplicable.value = false
      batchQuote.value = null
      batchQuoteError.value = ''
      pendingQuoteContext.value = ''
    }
    if (activeKind.value === 'voice') await loadProductionVoices(versionId)
    loadError.value = ''
  } finally {
    loading.value = false
  }
}

async function refreshSafely(options = {}) {
  try {
    await refresh(options)
  } catch (error) {
    loadError.value = error?.response?.data?.error?.message || error?.message || '读取资产状态失败'
  }
}

async function generate(asset) {
  try {
    const quoteResult = await redrawAPI.getAssetQuote(asset.id)
    if (!quoteResult?.priced) {
      ElMessage.warning('积分待管理员配置')
      return
    }
    const confirmation = confirmSingleAssetQuote(asset, quoteResult)
    if (asset.kind === 'voice' && !confirmation.confirmed) {
      assets.value = assets.value.map((item) => (
        String(item.id) === String(asset.id) ? confirmation.asset : item
      ))
      ElMessage.warning('单项报价已更新，请再次确认')
      return
    }
    const result = await redrawAPI.generateAsset(asset.id, {
      prompt: asset.prompt,
      quote_hash: confirmation.quoteHash,
    })
    await refresh()
    const notice = singleAssetGenerationNotice(result)
    if (notice.type === 'warning') ElMessage.warning(notice.message)
    else ElMessage.success(notice.message)
  }
  catch (error) { ElMessage.error(error.message || '资产生成失败') }
}

async function review(asset, action) {
  try {
    if (action === 'approved' && asset?.kind === 'character' && !isRedrawCharacterIdentityPackReady(asset)) {
      ElMessage.warning('角色身份包未就绪，不能批准')
      return
    }
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

async function handleIdentitySaved() {
  try {
    await refresh()
    if (props.work?.id) {
      const nextWork = await redrawAPI.getWork(props.work.id)
      emit('work-updated', nextWork)
    }
  } catch (error) {
    ElMessage.error(error.message || '身份包保存后刷新失败')
  }
}

async function pollBatchWork() {
  if (!props.work?.id) return
  const versionId = resolvedVersionId.value
  try {
    const work = await redrawAPI.getWork(props.work.id)
    if (!isCurrentVersion(versionId)) return
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
    const gateBatch = ids.length ? null : activeBatch.value
    if (!previousHash || !nextHash || nextHash !== previousHash || !canStartAssetBatch(nextQuote, gateBatch)) {
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
    if (!isCurrentVersion(versionId)) return
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

async function selectVoice(selection = {}) {
  const characterAssetId = Number(selection.character_asset_id)
  const voiceAssetId = Number(selection.voice_asset_id)
  const expectedUpdatedAt = selection.expected_updated_at
  if (voiceBinding.value
    || !Number.isInteger(characterAssetId) || characterAssetId <= 0
    || !Number.isInteger(voiceAssetId) || voiceAssetId <= 0) return
  voiceBinding.value = true
  try {
    await redrawAPI.assignVoice(characterAssetId, {
      voice_asset_id: voiceAssetId,
      expected_updated_at: expectedUpdatedAt,
    })
    await refresh()
    ElMessage.success('角色音色已绑定')
  } catch (error) {
    ElMessage.error(error.message || '角色音色绑定失败')
  } finally {
    voiceBinding.value = false
  }
}

function previewVoice(voice) {
  return previewController.toggle(voice)
}

function stopVoicePreview() {
  previewController.stop()
}

onMounted(async () => {
  await refreshSafely()
  if (['pending', 'processing'].includes(String(activeBatch.value?.status || ''))) startBatchPolling()
})
onUnmounted(() => {
  stopBatchPolling()
  previewController.dispose()
})
watch(resolvedVersionId, async () => {
  stopBatchPolling()
  stopVoicePreview()
  productionVoices.value = []
  batchQuote.value = null
  batchWork.value = null
  batchIdempotencyKey.value = null
  batchQuoteApplicable.value = null
  batchQuoteError.value = ''
  loadError.value = ''
  await refreshSafely()
})
watch(activeKind, async (kind) => {
  if (kind !== 'voice') {
    stopVoicePreview()
    return
  }
  if (productionVoices.value.length) return
  try {
    await loadProductionVoices()
  } catch (error) {
    ElMessage.error(error.message || '已验证音色列表加载失败')
  }
})

defineExpose({ refresh: refreshSafely, generationGateOpen })
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
