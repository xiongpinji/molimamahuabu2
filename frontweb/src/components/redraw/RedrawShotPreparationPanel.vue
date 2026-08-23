<template>
  <section class="preparation-panel" aria-label="逐镜参考准备">
    <header class="panel-heading">
      <div>
        <p class="eyebrow">逐镜准备</p>
        <h3>人物、文字、净景与参考包</h3>
      </div>
      <el-tag>{{ safeMode ? 'A 模式 · 逐项确认' : 'B 模式 · 自动推进' }}</el-tag>
    </header>

    <el-alert
      v-if="autoDowngraded"
      type="warning"
      :closable="false"
      :title="`B 模式已降级为 A 模式；降级原因：${reasonText}`"
      show-icon
    />

    <div class="shot-preparation-grid">
      <article v-for="shot in projectedShots" :key="shot.id" class="shot-preparation-card">
        <header><strong>镜头 {{ shot.id }}</strong><el-tag size="small">{{ shot.state }}</el-tag></header>
        <dl>
          <div><dt>人物覆盖</dt><dd>{{ evidenceText(shot.personCoverage) }}</dd></div>
          <div><dt>文字覆盖</dt><dd>{{ evidenceText(shot.textCoverage) }}</dd></div>
          <div><dt>净景</dt><dd>{{ evidenceText(shot.cleanPlate) }}</dd></div>
          <div><dt>参考包</dt><dd>{{ shot.referenceBundle.ready ? '已就绪' : '待准备' }}</dd></div>
          <div v-if="shot.staleReason"><dt>失效原因</dt><dd>{{ shot.staleReason }}</dd></div>
          <div v-if="shot.reworkScope"><dt>返工范围</dt><dd>只返工此镜头</dd></div>
        </dl>
        <el-checkbox
          v-if="safeMode && selectableShotIds.includes(Number(shot.id))"
          v-model="confirmedShotIds"
          :value="Number(shot.id)"
        >逐项确认此镜头</el-checkbox>
        <el-button
          v-if="shot.state === 'needs_attention'"
          size="small"
          @click="$emit('manual-review', shot.id)"
        >人工核对</el-button>
      </article>
    </div>

    <footer class="preparation-actions">
      <div class="canvas-credit-callout-v1 preparation-credits">
        <span>参考准备总价</span>
        <strong v-if="serverCredits !== null">本次预计扣除 {{ serverCredits }} 积分</strong>
        <strong v-else>积分待管理员配置</strong>
      </div>
      <el-button type="primary" :loading="preparing" :disabled="!canPrepare" @click="submitPreparation">
        {{ safeMode ? '确认并准备所选镜头' : '按服务端策略自动准备' }}
      </el-button>
    </footer>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { projectShotPreparation } from '@/utils/redrawShotState'

const props = defineProps({
  shots: { type: Array, default: () => [] },
  gate: { type: Object, default: null },
  quote: { type: Object, default: null },
  executionMode: { type: String, default: 'safe' },
  preparing: { type: Boolean, default: false },
  submissionLocked: { type: Boolean, default: false },
})
const emit = defineEmits(['prepare', 'manual-review'])
const confirmedShotIds = ref([])

const projectedShots = computed(() => props.shots.map((shot) => projectShotPreparation(
  shot,
  props.gate || {},
  props.quote || {},
)))
const selectableShotIds = computed(() => {
  const quoted = Array.isArray(props.quote?.missing_shot_ids)
    ? props.quote.missing_shot_ids.map(Number)
    : Array.isArray(props.quote?.selected_shot_ids) ? props.quote.selected_shot_ids.map(Number) : []
  const attention = new Set((props.quote?.needs_attention_shot_ids || []).map(Number))
  return quoted.filter((id) => !attention.has(id))
})
const safeMode = computed(() => String(props.quote?.effective_mode || props.executionMode) !== 'auto')
const autoDowngraded = computed(() => props.executionMode === 'auto' && safeMode.value)
const reasonText = computed(() => (props.quote?.reason_codes || []).join('、') || '证据或置信度不足')
const serverCredits = computed(() => (
  props.quote?.priced === true && Number.isSafeInteger(Number(props.quote?.credits))
    ? Number(props.quote.credits)
    : null
))
const allSafeConfirmed = computed(() => (
  !safeMode.value || selectableShotIds.value.every((id) => confirmedShotIds.value.includes(id))
))
const canPrepare = computed(() => (
  !props.preparing
    && !props.submissionLocked
    && props.quote?.action !== 'blocked'
    && props.quote?.priced === true
    && selectableShotIds.value.length > 0
    && allSafeConfirmed.value
))

function evidenceText(item) {
  if (!item.required) return '无需处理'
  return item.ready ? `${item.completed}/${item.required} 已完成` : `${item.completed}/${item.required} 待完成`
}

function submitPreparation() {
  if (!canPrepare.value) return
  emit('prepare', {
    shot_ids: [...selectableShotIds.value],
    quote_hash: props.quote?.quote_hash,
  })
}

watch(selectableShotIds, (ids) => {
  confirmedShotIds.value = confirmedShotIds.value.filter((id) => ids.includes(id))
})
</script>

<style scoped>
.preparation-panel { display: grid; gap: 12px; padding: 16px; border: 1px solid #303030; border-radius: 10px; background: #121212; }
.panel-heading, .shot-preparation-card header, .preparation-actions { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3 { margin: 0; font-size: 17px; }
.shot-preparation-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.shot-preparation-card { display: grid; gap: 10px; padding: 13px; border: 1px solid #292929; border-radius: 8px; background: #191919; }
dl { display: grid; gap: 7px; margin: 0; }
dl div { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 8px; }
dt { color: #8f8f8f; }
dd { margin: 0; overflow-wrap: anywhere; }
.preparation-actions { align-items: center; }
.preparation-credits { display: grid; gap: 3px; }
@media (max-width: 640px) { .panel-heading, .preparation-actions { flex-direction: column; } }
</style>
