<template>
  <article
    class="recharge-package-card"
    :class="{ 'recharge-package-card--featured': Boolean(item.is_featured) }"
    :style="{ '--package-accent': accentColor }"
  >
    <div class="package-image-wrap">
      <img
        v-if="item.image_url && !imageFailed"
        class="package-image"
        :src="item.image_url"
        :alt="`${item.name} 广告图片`"
        @error="imageFailed = true"
      >
      <div v-else class="package-image-placeholder" role="img" :aria-label="`${item.name} 广告图占位`">
        <span>{{ item.name }}</span>
      </div>
    </div>

    <div class="package-body">
      <div v-if="item.is_featured || item.badge_text" class="package-labels">
        <span v-if="item.is_featured" class="featured-label">推荐套餐</span>
        <span v-if="item.badge_text" class="badge-label">{{ item.badge_text }}</span>
      </div>

      <div class="package-ad-copy">
        <p v-if="item.ad_subtitle" class="package-subtitle">{{ item.ad_subtitle }}</p>
        <h2>{{ item.ad_title || item.name }}</h2>
      </div>

      <div class="package-identity">
        <strong>{{ item.name }}</strong>
        <span>{{ validityText }}</span>
      </div>

      <div class="package-price-row">
        <div class="package-price"><small>¥</small>{{ amountYuan }}</div>
        <div class="package-credit-total">
          <strong>{{ formatNumber(item.credits) }}</strong>
          <span>到账积分 · {{ creditsPerYuan }} 积分/元</span>
        </div>
      </div>

      <div class="package-metrics">
        <div>
          <span>基础积分</span>
          <strong>{{ formatNumber(baseCredits) }}</strong>
        </div>
        <div v-if="bonusCredits > 0" class="bonus-metric">
          <span>额外赠送</span>
          <strong>+{{ formatNumber(bonusCredits) }}</strong>
        </div>
      </div>

      <button
        type="button"
        class="package-purchase"
        :disabled="disabled || preview || loading"
        :aria-busy="loading"
        @click="purchase"
      >
        {{ buttonLabel }}
      </button>
    </div>
  </article>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { normalizeAccentColor, packageCreditMetrics } from '@/utils/rechargePresentation'

const props = defineProps({
  item: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  preview: { type: Boolean, default: false },
})
const emit = defineEmits(['purchase'])

const imageFailed = ref(false)
const accentColor = computed(() => normalizeAccentColor(props.item.accent_color))
const metrics = computed(() => packageCreditMetrics(props.item))
const amountYuan = computed(() => metrics.value.amountYuan.toFixed(2))
const baseCredits = computed(() => metrics.value.baseCredits)
const bonusCredits = computed(() => metrics.value.bonusCredits)
const creditsPerYuan = computed(() => metrics.value.creditsPerYuan)
const buttonLabel = computed(() => props.disabled
  ? '支付通道准备中'
  : (props.item.button_text || '立即购买'))
const validityText = computed(() => {
  if (!props.item.ends_at) return '长期有效'
  const date = new Date(props.item.ends_at)
  return Number.isNaN(date.getTime()) ? '限时有效' : `有效至 ${date.toLocaleDateString('zh-CN')}`
})

watch(() => props.item.image_url, () => { imageFailed.value = false })

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN')
}

function purchase() {
  if (props.disabled || props.preview) return
  if (props.loading) return
  emit('purchase', props.item)
}
</script>

<style scoped>
.recharge-package-card {
  display: flex;
  min-width: 0;
  min-height: 570px;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--package-accent) 34%, #303030);
  border-radius: 24px;
  color: #f7f7f7;
  background: linear-gradient(160deg, color-mix(in srgb, var(--package-accent) 11%, #181818) 0%, #181818 46%);
  box-shadow: 0 26px 60px rgba(0, 0, 0, .34);
}

.recharge-package-card--featured {
  border-color: color-mix(in srgb, var(--package-accent) 76%, #fff);
  box-shadow: 0 26px 70px color-mix(in srgb, var(--package-accent) 24%, transparent);
}

.package-image-wrap {
  position: relative;
  height: 230px;
  min-height: 230px;
  overflow: hidden;
  background: #202020;
}

.package-image {
  display: block;
  width: 100%;
  height: 230px;
  object-fit: cover;
}

.package-image-placeholder {
  display: grid;
  width: 100%;
  height: 230px;
  padding: 24px;
  place-items: center;
  color: rgba(255, 255, 255, .9);
  font-size: 20px;
  font-weight: 800;
  text-align: center;
  background:
    radial-gradient(circle at 72% 22%, color-mix(in srgb, var(--package-accent) 58%, transparent), transparent 46%),
    linear-gradient(145deg, color-mix(in srgb, var(--package-accent) 26%, #151515), #151515);
}

.package-body {
  display: flex;
  min-height: 340px;
  padding: 22px 24px 24px;
  flex: 1;
  flex-direction: column;
}

.package-labels { display: flex; min-height: 25px; gap: 8px; flex-wrap: wrap; }
.package-labels span { padding: 5px 9px; border-radius: 999px; font-size: 12px; font-weight: 800; }
.featured-label { color: #140703; background: var(--package-accent); }
.badge-label { color: #fff; background: #a13f22; }
.package-ad-copy { min-height: 78px; margin-top: 13px; }
.package-ad-copy h2 { margin: 4px 0 0; font-size: clamp(21px, 1.7vw, 27px); line-height: 1.2; }
.package-subtitle { margin: 0; color: #aaaab0; font-size: 13px; }
.package-identity { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 13px; color: #a7a7ad; }
.package-identity strong { overflow: hidden; color: #f7f7f7; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.package-identity span { flex: 0 0 auto; font-size: 12px; }
.package-price-row { display: flex; align-items: end; justify-content: space-between; gap: 14px; margin-top: 18px; }
.package-price { color: #fff; font-size: clamp(38px, 3.2vw, 50px); font-weight: 900; letter-spacing: -2px; line-height: 1; }
.package-price small { margin-right: 3px; font-size: 22px; }
.package-credit-total { display: grid; gap: 4px; text-align: right; }
.package-credit-total strong { color: var(--package-accent); font-size: 20px; }
.package-credit-total span { color: #929298; font-size: 11px; }
.package-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 18px; }
.package-metrics > div { display: grid; min-width: 0; gap: 5px; padding: 12px; border: 1px solid #303030; border-radius: 13px; background: rgba(255, 255, 255, .025); }
.package-metrics span { color: #96969d; font-size: 12px; }
.package-metrics strong { overflow: hidden; font-size: 18px; text-overflow: ellipsis; }
.package-metrics .bonus-metric strong { color: var(--package-accent); }
.package-purchase { width: 100%; min-height: 48px; margin-top: auto; padding: 0 18px; border: 0; border-radius: 14px; color: #160804; font: inherit; font-weight: 800; background: linear-gradient(110deg, #f4f4f5, color-mix(in srgb, var(--package-accent) 74%, #fff)); cursor: pointer; }
.package-purchase:hover:not(:disabled),
.package-purchase:focus-visible:not(:disabled) { filter: brightness(1.08); }
.package-purchase:focus-visible { outline: 3px solid color-mix(in srgb, var(--package-accent) 68%, #fff); outline-offset: 3px; }
.package-purchase:disabled { color: #8c8c91; background: #2b2b2d; cursor: not-allowed; }

@media (prefers-reduced-motion: no-preference) {
  .package-purchase { transition: filter .18s ease, transform .18s ease; }
  .package-purchase:active:not(:disabled) { transform: translateY(1px); }
}
</style>
