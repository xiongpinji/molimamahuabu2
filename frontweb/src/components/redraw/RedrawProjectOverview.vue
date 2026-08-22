<template>
  <section class="redraw-project-overview">
    <div class="overview-grid">
      <div>
        <span>原始模式</span>
        <strong>{{ rawMode }}</strong>
      </div>
      <div>
        <span>有效模式</span>
        <strong>{{ effectiveMode }}</strong>
      </div>
      <div>
        <span>预算上限</span>
        <strong>{{ creditsText(policy.budget_limit_credits) }}</strong>
      </div>
      <div>
        <span>已用积分</span>
        <strong>{{ creditsText(project?.spent_credits ?? project?.credit_usage?.spent) }}</strong>
      </div>
      <div>
        <span>预留积分</span>
        <strong>{{ creditsText(project?.reserved_credits ?? project?.credit_usage?.reserved) }}</strong>
      </div>
      <div>
        <span>policy/version</span>
        <strong>{{ policyVersion }}</strong>
      </div>
      <div>
        <span>待审核</span>
        <strong>{{ reviewCount }}</strong>
      </div>
      <div>
        <span>needs_attention</span>
        <strong>{{ needsAttentionCount }}</strong>
      </div>
    </div>

    <div class="stage-strip" aria-label="八阶段状态">
      <span
        v-for="stage in stages"
        :key="stage.key"
        class="stage-pill"
        :class="stage.status"
      >
        {{ stage.label }}
      </span>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import {
  resolveNeedsAttentionCount,
  resolveProjectEffectiveMode,
} from '@/utils/redrawWorkspaceState'

const props = defineProps({
  project: {
    type: Object,
    default: null,
  },
  work: {
    type: Object,
    default: null,
  },
  events: {
    type: Array,
    default: () => [],
  },
  stages: {
    type: Array,
    default: () => [],
  },
})

const project = computed(() => props.project || {})
const policy = computed(() => project.value.effective_policy || project.value.policy || project.value)
const rawMode = computed(() => project.value.execution_mode || project.value.raw_execution_mode || 'safe')
const effectiveMode = computed(() => resolveProjectEffectiveMode({ project: project.value, work: props.work || {} }))
const policyVersion = computed(() => policy.value.policy_version || project.value.policy_version || project.value.updated_at || '-')
const reviewCount = computed(() => Number(project.value.review_pending_count ?? props.work?.review_pending_count ?? props.work?.pending_review_count ?? 0))
const needsAttentionCount = computed(() => resolveNeedsAttentionCount({
  project: project.value,
  work: props.work || {},
  events: props.events,
}))

function creditsText(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${number} 积分` : '未设置'
}
</script>

<style scoped>
.redraw-project-overview {
  display: grid;
  gap: 14px;
  margin-bottom: 18px;
  padding: 16px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  background: #151515;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.overview-grid div {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.overview-grid span {
  color: #8d8d8d;
  font-size: 12px;
}

.overview-grid strong {
  color: #f5f5f5;
  overflow-wrap: anywhere;
}

.stage-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.stage-pill {
  padding: 5px 9px;
  border: 1px solid #333;
  border-radius: 999px;
  color: #a5a5a5;
  font-size: 12px;
}

.stage-pill.completed {
  border-color: #2f6f4e;
  color: #66d49a;
}

.stage-pill.active {
  border-color: #ff7139;
  color: #fff;
}

.stage-pill.needs_attention {
  border-color: #b63b3b;
  color: #ff8585;
}

@media (max-width: 900px) {
  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
