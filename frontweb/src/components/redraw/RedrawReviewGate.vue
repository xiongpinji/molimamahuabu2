<template>
  <section class="review-gate" :class="{ ready: gate?.ok }" aria-live="polite">
    <div class="gate-heading">
      <div>
        <p class="eyebrow">资产审核门禁</p>
        <h3>{{ gate?.ok ? '资产已全部确认，可进入批量转绘' : '还有资产需要确认' }}</h3>
      </div>
      <el-tag :type="gate?.ok ? 'success' : 'warning'">{{ gate?.ok ? '已开放' : `${missing.length} 项待处理` }}</el-tag>
    </div>
    <ul v-if="missing.length" class="missing-list">
      <li v-for="item in missing" :key="`${item.kind}-${item.asset_id}`">
        <button type="button" class="missing-item" @click="focusAsset(item)">
          <span>{{ item.kind }} #{{ item.asset_id }}</span>
          <small>镜头 {{ item.shot_ids.join('、') }}</small>
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  gate: { type: Object, default: () => ({ ok: false, missing: [] }) },
})

const missing = computed(() => (Array.isArray(props.gate?.missing) ? props.gate.missing : []))

function focusAsset(item) {
  const target = document.getElementById(item.anchor)
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target?.focus({ preventScroll: true })
}
</script>

<style scoped>
.review-gate {
  display: grid;
  gap: 12px;
  box-sizing: border-box;
  padding: 16px;
  border: 1px solid #5a3d21;
  border-radius: 8px;
  background: #19130d;
}
.review-gate.ready { border-color: #2f704e; background: #0d1b14; }
.gate-heading { display: flex; justify-content: space-between; gap: 12px; min-width: 0; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
.missing-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.missing-item { display: grid; gap: 3px; width: 100%; padding: 8px 10px; border: 1px solid #3a3125; border-radius: 6px; background: #211a12; color: #f2e4d4; text-align: left; }
.missing-item small { color: #b8a99a; }
</style>
