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
    <RedrawVoicePicker v-if="activeKind === 'voice'" :voices="visibleAssets" @select="selectVoice" />
    <div class="asset-grid">
      <RedrawAssetCard v-for="asset in visibleAssets" :key="asset.id" :asset="asset" :quote="asset.quote_credits || quote" @generate="generate" @review="review" />
      <p v-if="!visibleAssets.length" class="empty-state">当前类型暂无资产</p>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { redrawAPI } from '@/api/redraw'
import { ASSET_KINDS, generationGateOpen, groupAssets } from '@/utils/redrawAssetState'
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
const resolvedVersionId = computed(() => props.versionId || props.work?.version_id || props.work?.current_version_id)
const visibleAssets = computed(() => groupAssets(assets.value, activeKind.value))

async function refresh() {
  if (!resolvedVersionId.value) return
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
    await redrawAPI.generateAsset(asset.id, { prompt: asset.prompt, credit_amount: quoteResult.credits })
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

function selectVoice() {}

onMounted(refresh)
watch(resolvedVersionId, refresh)

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
.asset-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; min-width: 0; }
.empty-state { grid-column: 1 / -1; padding: 30px; border: 1px dashed #363636; color: #888; text-align: center; }
@media (max-width: 720px) { .section-heading { align-items: stretch; flex-direction: column; } .asset-grid { grid-template-columns: 1fr; } }
</style>
