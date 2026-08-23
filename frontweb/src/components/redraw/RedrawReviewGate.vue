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
      <li v-for="item in missing" :key="item.key">
        <button type="button" class="missing-item" @click="focusAsset(item)">
          <span>{{ item.label }}</span>
          <small>{{ item.detail }}</small>
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

const RESOURCE_LABELS = Object.freeze({
  character_plan: '角色方案',
  reference_bundle: '镜头参考包',
  shot: '镜头准备',
  version: '整集准备',
})

const RESOURCE_REASONS = Object.freeze({
  character_plan: '角色方案尚未就绪',
  reference_bundle: '镜头参考包尚未就绪',
  shot: '镜头准备尚未就绪',
  version: '整集准备尚未就绪',
})

function safeToken(value, pattern, maxLength = 64) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return ''
  const token = String(value).trim()
  return token.length <= maxLength && pattern.test(token) ? token : ''
}

function normalizeMissingItem(input, index) {
  const item = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const kind = safeToken(item.kind, /^(?:character|scene|prop|voice)$/)
  const assetId = safeToken(item.asset_id, /^\d+$/)
  const resourceType = safeToken(item.resource_type, /^(?:character_plan|reference_bundle|shot|version)$/)
  const resourceId = safeToken(item.resource_id, /^\d+$/)
  const shotIds = [...new Set([
    safeToken(item.shot_id, /^[A-Za-z0-9_-]+$/),
    ...(Array.isArray(item.shot_ids)
      ? item.shot_ids.map((value) => safeToken(value, /^[A-Za-z0-9_-]+$/))
      : []),
  ].filter(Boolean))]
  const anchor = safeToken(item.anchor, /^[A-Za-z0-9_-]+$/, 128)
  const label = kind && assetId
    ? `${kind} #${assetId}`
    : resourceType && resourceId ? `${RESOURCE_LABELS[resourceType]} #${resourceId}` : '门禁检查项'
  const detail = shotIds.length ? `镜头 ${shotIds.join('、')}` : (RESOURCE_REASONS[resourceType] || '需要重新确认')
  return { key: `${resourceType || kind || 'gate'}-${resourceId || assetId || index}-${index}`, label, detail, anchor }
}

const missing = computed(() => (Array.isArray(props.gate?.missing)
  ? props.gate.missing.map(normalizeMissingItem)
  : []))

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
