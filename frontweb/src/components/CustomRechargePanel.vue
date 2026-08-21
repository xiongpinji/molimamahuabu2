<template>
  <section class="custom-recharge-panel" aria-labelledby="custom-recharge-title">
    <div class="custom-amount-panel">
      <div class="panel-heading">
        <div>
          <span class="eyebrow">固定比例充值</span>
          <h2 id="custom-recharge-title">自定义充值</h2>
        </div>
        <strong class="ratio">1 元 = 100 积分</strong>
      </div>

      <label class="amount-label" for="custom-recharge-amount">充值金额</label>
      <el-input-number
        id="custom-recharge-amount"
        v-model="amount"
        class="amount-input"
        :min="Number(config.min_amount_yuan)"
        :max="Number(config.max_amount_yuan)"
        :precision="2"
        :step="1"
        controls-position="right"
      />

      <div class="quick-amounts" :aria-label="`快捷充值金额，共 ${QUICK_RECHARGE_AMOUNTS.length} 项`">
        <button
          v-for="quickAmount in QUICK_RECHARGE_AMOUNTS"
          :key="quickAmount"
          type="button"
          :class="{ active: Number(amount) === quickAmount }"
          @click="amount = quickAmount"
        >
          ¥{{ quickAmount }}
        </button>
      </div>

      <div class="credit-preview">
        <span>预计到账积分</span>
        <strong>{{ credits.toLocaleString('zh-CN') }}</strong>
      </div>

      <ul class="recharge-rules">
        <li>金额范围：¥{{ config.min_amount_yuan }} 至 ¥{{ config.max_amount_yuan }}</li>
        <li>最多保留两位小数，积分在支付成功后入账</li>
      </ul>
    </div>

    <aside class="order-summary" aria-label="充值订单摘要">
      <div>
        <span class="eyebrow">订单摘要</span>
        <h3>自定义积分</h3>
      </div>
      <dl>
        <div><dt>支付金额</dt><dd>¥{{ displayAmount }}</dd></div>
        <div><dt>兑换比例</dt><dd>1 : 100</dd></div>
        <div><dt>到账积分</dt><dd>{{ credits.toLocaleString('zh-CN') }}</dd></div>
      </dl>
      <p v-if="disabled" class="channel-state">支付通道准备中，当前不会创建订单或扣款。</p>
      <p v-else class="channel-state channel-state--ready">支付通道已就绪，请确认金额后继续。</p>
      <button
        type="button"
        class="custom-purchase"
        :disabled="disabled || loading"
        :aria-busy="loading"
        @click="submit"
      >
        {{ disabled ? '支付通道准备中' : (loading ? '正在创建订单…' : '立即充值') }}
      </button>
    </aside>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  QUICK_RECHARGE_AMOUNTS,
  creditsForCustomAmount,
  validCustomAmount,
} from '@/utils/rechargePresentation'

const props = defineProps({
  config: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['purchase'])
const amount = ref(10)
const credits = computed(() => creditsForCustomAmount(amount.value))
const displayAmount = computed(() => Number(amount.value || 0).toFixed(2))

function submit() {
  if (props.disabled) return
  if (!validCustomAmount(amount.value, props.config.min_amount_yuan, props.config.max_amount_yuan)) {
    return ElMessage.warning(`充值金额需在 ${props.config.min_amount_yuan} 至 ${props.config.max_amount_yuan} 元之间`)
  }
  emit('purchase', Number(amount.value).toFixed(2))
}
</script>

<style scoped>
.custom-recharge-panel {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(290px, .65fr);
  gap: 18px;
  color: #f7f7f7;
}
.custom-amount-panel,
.order-summary { padding: clamp(22px, 3vw, 36px); border: 1px solid #303030; border-radius: 24px; background: #181818; box-shadow: 0 26px 60px rgba(0, 0, 0, .28); }
.panel-heading { display: flex; align-items: start; justify-content: space-between; gap: 18px; }
.eyebrow { color: #ff946c; font-size: 12px; font-weight: 800; letter-spacing: .12em; }
.panel-heading h2,
.order-summary h3 { margin: 6px 0 0; }
.ratio { padding: 9px 12px; border: 1px solid rgba(255, 113, 57, .38); border-radius: 999px; color: #ff9b75; font-size: 13px; background: rgba(255, 113, 57, .09); }
.amount-label { display: block; margin: 30px 0 10px; color: #a7a7ad; font-size: 13px; }
.amount-input { width: 100%; }
.amount-input :deep(.el-input__wrapper) { min-height: 86px; padding: 0 24px; border-radius: 18px; background: #101010; box-shadow: inset 0 0 0 1px #3a3a3a; }
.amount-input :deep(.el-input__inner) { color: #fff; font-size: clamp(34px, 5vw, 52px); font-weight: 900; text-align: left; }
.quick-amounts { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.quick-amounts button { min-height: 42px; border: 1px solid #373737; border-radius: 12px; color: #d4d4d7; font: inherit; background: #202020; cursor: pointer; }
.quick-amounts button:hover,
.quick-amounts button:focus-visible,
.quick-amounts button.active { border-color: #ff7139; color: #fff; background: rgba(255, 113, 57, .16); outline: none; }
.quick-amounts button:focus-visible { box-shadow: 0 0 0 3px rgba(255, 113, 57, .3); }
.credit-preview { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-top: 26px; padding: 18px 20px; border: 1px solid rgba(255, 113, 57, .28); border-radius: 16px; background: linear-gradient(120deg, rgba(255, 113, 57, .13), rgba(255, 113, 57, .025)); }
.credit-preview span { color: #b6b6bb; }
.credit-preview strong { color: #ff9a73; font-size: clamp(26px, 4vw, 40px); }
.recharge-rules { margin: 20px 0 0; padding-left: 20px; color: #929298; font-size: 13px; line-height: 1.8; }
.order-summary { display: flex; min-height: 390px; flex-direction: column; }
.order-summary dl { display: grid; gap: 0; margin: 28px 0 0; }
.order-summary dl div { display: flex; justify-content: space-between; gap: 16px; padding: 15px 0; border-bottom: 1px solid #303030; }
.order-summary dt { color: #96969c; }
.order-summary dd { margin: 0; color: #f4f4f5; font-weight: 800; }
.channel-state { margin: 22px 0; color: #c6a08f; font-size: 13px; line-height: 1.6; }
.channel-state--ready { color: #8fc7a0; }
.custom-purchase { min-height: 50px; margin-top: auto; border: 0; border-radius: 14px; color: #1a0904; font: inherit; font-weight: 800; background: linear-gradient(110deg, #ffd0bd, #ff7139); cursor: pointer; }
.custom-purchase:hover:not(:disabled),
.custom-purchase:focus-visible:not(:disabled) { filter: brightness(1.08); }
.custom-purchase:focus-visible { outline: 3px solid rgba(255, 148, 108, .7); outline-offset: 3px; }
.custom-purchase:disabled { color: #89898f; background: #303033; cursor: not-allowed; }

@media (max-width: 850px) {
  .custom-recharge-panel { grid-template-columns: 1fr; }
  .quick-amounts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .order-summary { min-height: 320px; }
}

@media (max-width: 520px) {
  .panel-heading { align-items: start; flex-direction: column; }
  .custom-amount-panel,
  .order-summary { padding: 20px 16px; }
  .credit-preview { align-items: start; flex-direction: column; }
}
</style>
