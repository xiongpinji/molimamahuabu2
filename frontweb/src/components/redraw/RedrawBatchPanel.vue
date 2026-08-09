<template>
  <aside class="batch-panel">
    <header>
      <div><p class="eyebrow">批次</p><h3>{{ batches.length }} 组分镜</h3></div>
      <el-button :icon="Refresh" circle aria-label="刷新分镜" :loading="refreshing" @click="emit('refresh')" />
    </header>
    <div class="shot-filters" role="group" aria-label="镜头状态筛选">
      <button v-for="item in filters" :key="item.key" type="button" :class="{ active: filter === item.key }" @click="emit('update:filter', item.key)">
        {{ item.label }}
      </button>
    </div>
    <div class="batch-list">
      <section v-for="batch in visibleBatches" :key="batch.batch_index" class="batch-card">
        <div class="batch-card__title">
          <strong>批次 {{ batch.batch_index }}</strong>
          <span>{{ Math.round((Number(batch.duration_ms) || 0) / 1000) }} 秒</span>
        </div>
        <button
          v-for="shot in batch.shots"
          :key="shot.id"
          type="button"
          class="shot-row"
          :class="{ active: String(shot.id) === String(selectedShotId) }"
          @click="emit('select', shot.id)"
        >
          <span>镜头 {{ shot.shot_index }}</span>
          <small>{{ statusLabel(shot.status) }}</small>
        </button>
      </section>
      <p v-if="!visibleShots.length" class="empty">当前筛选下没有镜头</p>
    </div>
    <footer>
      <div class="batch-credit" data-contract="canvas-credit-callout-v1">
        <strong v-if="batchQuote.priced">本次预计扣除 {{ batchQuote.total }} 积分</strong>
        <strong v-else>积分待管理员配置</strong>
        <small v-if="batchQuote.priced">批量总价 {{ batchQuote.total }} 积分</small>
        <small v-if="batchReason">{{ batchReason }}</small>
        <div v-if="visibleShots.length" class="batch-price-details" aria-label="分镜价格明细">
          <small>分镜价格明细</small>
          <span v-for="shot in visibleShots" :key="shot.id">
            镜头 {{ shot.shot_index }}：{{ shotCreditText(shot) }} · 冻结 {{ billingValue(shot, 'held') }} / 已扣 {{ billingValue(shot, 'charged') }} / 已退 {{ billingValue(shot, 'released') }}
          </span>
        </div>
      </div>
      <el-button
        type="primary"
        :icon="VideoPlay"
        :loading="generating"
        :disabled="!canGenerateBatch"
        @click="emit('generate', targetShots.map((shot) => shot.id))"
      >批量生成 {{ targetShots.length }} 镜</el-button>
    </footer>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import { Refresh, VideoPlay } from '@element-plus/icons-vue'
import { filterShots, quoteCredits, sumShotQuotes } from '@/utils/redrawShotState'

const props = defineProps({
  batches: { type: Array, default: () => [] },
  shots: { type: Array, default: () => [] },
  selectedShotId: { type: [String, Number], default: null },
  filter: { type: String, default: 'incomplete' },
  gate: { type: Object, default: () => ({ ok: false, missing: [] }) },
  refreshing: Boolean,
  generating: Boolean,
})
const emit = defineEmits(['select', 'update:filter', 'generate', 'refresh'])
const filters = [
  { key: 'incomplete', label: '未完成' },
  { key: 'failed', label: '失败' },
  { key: 'completed', label: '已完成' },
]
const visibleShots = computed(() => filterShots(props.shots, props.filter))
const visibleIds = computed(() => new Set(visibleShots.value.map((shot) => String(shot.id))))
const visibleBatches = computed(() => props.batches.map((batch) => ({
  ...batch,
  shots: (Array.isArray(batch.shots) ? batch.shots : []).filter((shot) => visibleIds.value.has(String(shot.id))),
})).filter((batch) => batch.shots.length))
const targetShots = computed(() => visibleShots.value.filter((shot) => ['draft', 'failed'].includes(String(shot.status))))
const batchQuote = computed(() => sumShotQuotes(targetShots.value))
const gateOpen = computed(() => props.gate?.ok === true && (!Array.isArray(props.gate?.missing) || !props.gate.missing.length))
const unavailableShot = computed(() => targetShots.value.find((shot) => shot?.generation_availability?.ok === false))
const canGenerateBatch = computed(() => gateOpen.value && !unavailableShot.value && batchQuote.value.priced && targetShots.value.length > 0 && !props.generating)
const batchReason = computed(() => {
  if (!gateOpen.value) return '资产门禁未开放，请先完成资产审核'
  if (!targetShots.value.length) return '当前筛选下没有可提交镜头'
  if (unavailableShot.value) return unavailableShot.value.generation_availability?.reason || '生成能力不可用'
  if (!batchQuote.value.priced) return '有镜头尚未配置价格'
  return ''
})

function statusLabel(status) {
  return ({ draft: '待生成', processing: '生成中', completed: '已完成', failed: '失败', needs_attention: '需确认' })[status] || status || '未知'
}

function shotCreditText(shot) {
  const credits = quoteCredits(shot)
  return credits === null ? '积分待管理员配置' : `预计扣除 ${credits} 积分`
}

function billingValue(shot, key) {
  const value = Number(shot?.billing?.[key])
  return Number.isFinite(value) ? value : 0
}
</script>

<style scoped>
.batch-panel { display: grid; grid-template-rows: auto auto minmax(180px, 1fr) auto; gap: 12px; min-width: 0; padding: 16px; border: 1px solid #2c2c2c; border-radius: 8px; background: #121212; }
header, .batch-card__title { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3 { margin: 0; font-size: 17px; }
.shot-filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.shot-filters button { min-width: 0; padding: 8px 4px; border: 1px solid #303030; border-radius: 6px; background: #191919; color: #aaa; overflow-wrap: anywhere; }
.shot-filters button.active { border-color: #ff7139; color: #fff; }
.batch-list { display: grid; align-content: start; gap: 10px; min-width: 0; max-height: 620px; overflow-y: auto; }
.batch-card { display: grid; gap: 6px; min-width: 0; }
.batch-card__title { color: #ddd; font-size: 13px; }
.batch-card__title span { color: #818181; }
.shot-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 9px 10px; border: 1px solid #292929; border-radius: 6px; background: #181818; color: #d5d5d5; text-align: left; }
.shot-row.active { border-color: #ff7139; background: #25150f; }
.shot-row span, .shot-row small { min-width: 0; overflow-wrap: anywhere; }
.shot-row small { color: #929292; }
.empty { color: #777; font-size: 13px; }
footer { display: grid; gap: 10px; }
.batch-credit { display: grid; gap: 4px; min-width: 0; padding: 11px; border: 1px solid #ff7139; border-radius: 8px; background: #25150f; }
.batch-credit strong { color: #ff9a6d; overflow-wrap: anywhere; }
.batch-credit small { color: #c9b0a6; overflow-wrap: anywhere; }
.batch-price-details { display: grid; gap: 3px; color: #d8c2b7; font-size: 12px; }
.batch-price-details span { overflow-wrap: anywhere; }
footer :deep(.el-button) { width: 100%; margin-left: 0; }
@media (max-width: 720px) { .batch-list { max-height: none; } }
</style>
