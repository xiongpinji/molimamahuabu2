<template>
  <section class="delivery-panel">
    <header>
      <div>
        <p class="eyebrow">生成与 QA</p>
        <h3>生成队列</h3>
      </div>
      <span class="provider-title">provider 状态</span>
    </header>
    <div class="budget-grid">
      <span>已用预算 <strong>{{ budget.spent }}</strong></span>
      <span>held <strong>{{ budget.held }}</strong></span>
      <span>剩余预算 <strong>{{ budget.remaining == null ? '未设上限' : budget.remaining }}</strong></span>
    </div>
    <p class="warning">submission_unknown：需要核对，不会自动重试。</p>
    <ul v-if="items.length" class="queue-list">
      <li v-for="shot in items" :key="shot.shot_id">
        <div>
          <strong>镜头 {{ shot.shot_index }}</strong>
          <span>attempt {{ shot.attempt }}</span>
          <span>{{ providerDeliveryState(shot).label }}</span>
        </div>
        <p v-if="providerDeliveryState(shot).warning" class="warning">
          {{ providerDeliveryState(shot).warning }}
        </p>
        <el-button
          v-if="providerDeliveryState(shot).canRetry"
          size="small"
          :loading="retryingShotId === shot.shot_id"
          @click="$emit('retry', shot)"
        >
          下一次尝试 {{ shot.next_attempt }}
        </el-button>
      </li>
    </ul>
    <p v-else class="muted">暂无生成任务。</p>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { providerDeliveryState } from '@/utils/redrawShotState'

const props = defineProps({
  summary: { type: Object, default: null },
  retryingShotId: { type: [String, Number], default: null },
})

defineEmits(['retry'])

const budget = computed(() => props.summary?.budget || { spent: 0, held: 0, remaining: null })
const items = computed(() => Array.isArray(props.summary?.shots) ? props.summary.shots : [])
</script>

<style scoped>
.delivery-panel { display: grid; gap: 12px; padding: 14px; border: 1px solid #2d2d2d; border-radius: 10px; background: #121212; }
header, .queue-list li > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3, p { margin: 0; }
.provider-title, .muted { color: #999; }
.budget-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.budget-grid span { padding: 9px; border-radius: 8px; background: #1c1c1c; color: #aaa; }
.budget-grid strong { color: #fff; }
.queue-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.queue-list li { display: grid; gap: 7px; padding: 10px; border: 1px solid #292929; border-radius: 8px; }
.queue-list li > div span { color: #aaa; }
.warning { color: #ffc66d; font-size: 13px; }
@media (max-width: 680px) { .budget-grid { grid-template-columns: 1fr; } }
</style>
