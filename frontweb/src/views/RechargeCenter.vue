<template>
  <main class="recharge-center">
    <header class="recharge-topbar">
      <div class="recharge-topbar__inner">
        <button type="button" class="back-button" aria-label="返回工作区" @click="backToWorkspace">
          <span aria-hidden="true">←</span>
        </button>
        <div class="brand-title">
          <span class="brand-mark" aria-hidden="true">茉</span>
          <div><strong>茉莉妈妈</strong><span>充值中心</span></div>
        </div>
        <div class="topbar-actions">
          <div class="credit-balance" aria-label="当前可用积分">
            <span>可用积分</span>
            <strong>{{ account.available.toLocaleString('zh-CN') }}</strong>
          </div>
          <button type="button" class="history-button" @click="ordersOpen = true">充值记录</button>
        </div>
      </div>
    </header>

    <div class="recharge-content">
      <section class="recharge-hero">
        <span class="hero-eyebrow">JASMINE CREDITS</span>
        <h1>为下一个好故事，补充创作能量</h1>
        <p>选择管理员配置的精选套餐，或按 1 元 = 100 积分自定义充值。</p>
      </section>

      <nav class="mode-switch" aria-label="充值方式">
        <button
          type="button"
          :class="{ active: mode === 'packages' }"
          :aria-pressed="mode === 'packages'"
          @click="mode = 'packages'"
        >
          精选套餐
        </button>
        <button
          type="button"
          :class="{ active: mode === 'custom' }"
          :aria-pressed="mode === 'custom'"
          @click="mode = 'custom'"
        >
          自定义充值
        </button>
      </nav>

      <el-alert
        v-if="!rechargeConfig.configured && !loading"
        class="channel-alert"
        title="支付通道准备中"
        description="页面可正常浏览，当前不会创建订单或扣款。"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-alert
        v-if="loadError"
        class="channel-alert"
        :title="loadError"
        type="error"
        :closable="false"
        show-icon
      />

      <section v-loading="loading" class="recharge-stage" :aria-busy="loading">
        <template v-if="mode === 'packages'">
          <div v-if="rechargePackages.length" class="recharge-grid">
            <RechargePackageCard
              v-for="item in rechargePackages"
              :key="item.id"
              :item="item"
              :disabled="!rechargeConfig.configured"
              :loading="payingTarget === item.id"
              @purchase="startPackageRecharge"
            />
          </div>
          <div v-else-if="!loading" class="empty-state">
            <span aria-hidden="true">✶</span>
            <h2>暂无可用套餐</h2>
            <p>您仍可切换到自定义充值，按固定比例计算积分。</p>
            <button type="button" @click="mode = 'custom'">前往自定义充值</button>
          </div>
        </template>

        <CustomRechargePanel
          v-else
          :config="rechargeConfig"
          :disabled="!rechargeConfig.configured"
          :loading="payingTarget === 'custom'"
          @purchase="startCustomRecharge"
        />
      </section>
    </div>

    <el-drawer
      v-model="ordersOpen"
      class="recharge-order-drawer"
      title="充值记录"
      direction="rtl"
      size="min(560px, 100vw)"
    >
      <el-table :data="rechargeOrders" empty-text="暂无充值记录">
        <el-table-column label="充值项目" min-width="145">
          <template #default="{ row }">{{ row.package_name || '自定义充值' }}</template>
        </el-table-column>
        <el-table-column label="金额" width="95">
          <template #default="{ row }">¥{{ formatYuan(row.amount_cents) }}</template>
        </el-table-column>
        <el-table-column prop="credits" label="积分" width="95" />
        <el-table-column label="状态" width="86">
          <template #default="{ row }">{{ statusLabel(row.status) }}</template>
        </el-table-column>
        <el-table-column label="时间" min-width="160">
          <template #default="{ row }">{{ formatDate(row.paid_at || row.created_at) }}</template>
        </el-table-column>
      </el-table>
    </el-drawer>
  </main>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getCreditAccount } from '@/api/auth'
import {
  createAlipayRechargeOrder,
  getAlipayRechargeConfig,
  listAlipayRechargeOrders,
  listRechargePackages,
} from '@/api/billing'
import CustomRechargePanel from '@/components/CustomRechargePanel.vue'
import RechargePackageCard from '@/components/RechargePackageCard.vue'
import { normalizeCreditAccount } from '@/utils/billingDisplay'
import { normalizePaymentRedirectUrl } from '@/utils/rechargePresentation'

const router = useRouter()
const mode = ref('packages')
const loading = ref(false)
const loadError = ref('')
const account = ref(normalizeCreditAccount())
const rechargeConfig = ref({
  configured: false,
  fixed_ratio_credits_per_yuan: 100,
  min_amount_yuan: '1.00',
  max_amount_yuan: '50000.00',
})
const rechargePackages = ref([])
const rechargeOrders = ref([])
const ordersOpen = ref(false)
const payingTarget = ref('')

function backToWorkspace() {
  router.push({ name: 'tenant-console' })
}

function createClientOrderKey() {
  return `recharge-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function loadRechargeCenter() {
  loading.value = true
  loadError.value = ''
  try {
    const [credit, config, packages, orders] = await Promise.all([
      getCreditAccount(),
      getAlipayRechargeConfig(),
      listRechargePackages(),
      listAlipayRechargeOrders(),
    ])
    account.value = normalizeCreditAccount(credit)
    rechargeConfig.value = { ...rechargeConfig.value, ...config }
    rechargePackages.value = Array.isArray(packages) ? packages : []
    rechargeOrders.value = Array.isArray(orders) ? orders : []
  } catch (_) {
    loadError.value = '充值信息加载失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

async function beginRecharge(payload, target) {
  if (!rechargeConfig.value.configured) return
  if (payingTarget.value) return
  payingTarget.value = target
  try {
    const result = await createAlipayRechargeOrder({
      ...payload,
      client_order_key: createClientOrderKey(),
    })
    const paymentUrl = normalizePaymentRedirectUrl(result?.payment_url)
    if (!paymentUrl) return ElMessage.warning('订单已创建，但支付地址不安全或不可用')
    window.location.assign(paymentUrl)
  } finally {
    payingTarget.value = ''
  }
}

function startPackageRecharge(item) {
  return beginRecharge({ package_id: item.id }, item.id)
}

function startCustomRecharge(amountYuan) {
  return beginRecharge({ amount_yuan: amountYuan }, 'custom')
}

function formatYuan(amountCents) {
  return (Number(amountCents || 0) / 100).toFixed(2)
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}

function statusLabel(status) {
  return ({ pending: '待支付', paid: '已到账', closed: '已关闭', failed: '失败' })[status] || status || '-'
}

onMounted(loadRechargeCenter)
</script>

<style scoped>
.recharge-center {
  min-height: 100vh;
  color: #f7f7f7;
  font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
  background:
    radial-gradient(circle at 50% -16%, rgba(255, 113, 57, .13), transparent 36%),
    #050505;
}
.recharge-topbar { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid rgba(255, 255, 255, .07); background: rgba(5, 5, 5, .88); backdrop-filter: blur(18px); }
.recharge-topbar__inner { display: flex; min-height: 72px; max-width: 1600px; margin: 0 auto; padding: 0 34px; align-items: center; gap: 14px; }
.back-button,
.history-button { border: 1px solid #303030; color: #ededee; background: #171717; cursor: pointer; }
.back-button { display: grid; width: 40px; height: 40px; border-radius: 13px; place-items: center; font-size: 21px; }
.back-button:hover,
.back-button:focus-visible,
.history-button:hover,
.history-button:focus-visible { border-color: #ff7139; outline: none; }
.back-button:focus-visible,
.history-button:focus-visible { box-shadow: 0 0 0 3px rgba(255, 113, 57, .3); }
.brand-title { display: flex; align-items: center; gap: 11px; }
.brand-mark { display: grid; width: 37px; height: 37px; border-radius: 12px; place-items: center; color: #1c0903; font-weight: 900; background: linear-gradient(135deg, #ffd2bf, #ff7139); }
.brand-title div { display: grid; gap: 2px; }
.brand-title strong { font-size: 14px; }
.brand-title div span { color: #929298; font-size: 12px; }
.topbar-actions { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.credit-balance { display: grid; gap: 2px; padding-right: 12px; text-align: right; }
.credit-balance span { color: #919197; font-size: 11px; }
.credit-balance strong { color: #ff936b; font-size: 17px; }
.history-button { min-height: 40px; padding: 0 15px; border-radius: 12px; font: inherit; font-size: 13px; }
.recharge-content { max-width: 1600px; margin: 0 auto; padding: 56px 34px 80px; }
.recharge-hero { max-width: 800px; margin: 0 auto; text-align: center; }
.hero-eyebrow { color: #ff8e64; font-size: 12px; font-weight: 800; letter-spacing: .22em; }
.recharge-hero h1 { margin: 12px 0 14px; font-size: clamp(34px, 4.8vw, 58px); line-height: 1.08; letter-spacing: -.045em; }
.recharge-hero p { max-width: 670px; margin: 0 auto; color: #a7a7ad; font-size: 15px; line-height: 1.8; }
.mode-switch { display: grid; grid-template-columns: 1fr 1fr; width: min(390px, 100%); margin: 38px auto 28px; padding: 5px; border: 1px solid #2a2a2a; border-radius: 999px; background: #151515; }
.mode-switch button { min-height: 50px; border: 0; border-radius: 999px; color: #97979d; font: inherit; font-weight: 800; background: transparent; cursor: pointer; }
.mode-switch button:hover,
.mode-switch button:focus-visible { color: #fff; outline: none; }
.mode-switch button:focus-visible { box-shadow: inset 0 0 0 2px #ff7139; }
.mode-switch button.active { color: #180903; background: linear-gradient(115deg, #ffd5c3, #ff7139); }
.channel-alert { margin: 0 auto 22px; }
.recharge-stage { min-height: 460px; }
.recharge-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; align-items: stretch; }
.recharge-grid :deep(.recharge-package-card--featured) { transform: translateY(-10px); }
.empty-state { display: grid; max-width: 560px; min-height: 320px; margin: 0 auto; padding: 44px; border: 1px dashed #383838; border-radius: 24px; place-items: center; align-content: center; text-align: center; background: #131313; }
.empty-state > span { color: #ff7139; font-size: 32px; }
.empty-state h2 { margin: 12px 0 6px; }
.empty-state p { margin: 0; color: #99999f; line-height: 1.7; }
.empty-state button { min-height: 42px; margin-top: 22px; padding: 0 18px; border: 1px solid #ff7139; border-radius: 12px; color: #fff; font: inherit; background: rgba(255, 113, 57, .13); cursor: pointer; }

:global(.recharge-order-drawer) { background: #151515 !important; }
:global(.recharge-order-drawer .el-drawer__title) { color: #f4f4f5; font-weight: 800; }

@media (max-width: 1024px) {
  .recharge-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 760px) {
  .recharge-topbar__inner { min-height: 68px; padding: 0 16px; }
  .brand-title strong { display: none; }
  .credit-balance { padding-right: 0; }
  .credit-balance span { display: none; }
  .history-button { padding: 0 10px; }
  .recharge-content { padding: 40px 16px 58px; }
  .recharge-hero h1 { font-size: 36px; }
  .recharge-grid { grid-template-columns: 1fr; }
  .recharge-grid :deep(.recharge-package-card--featured) { transform: none; }
}

@media (max-width: 420px) {
  .brand-mark { display: none; }
  .recharge-hero { text-align: left; }
  .mode-switch { margin-top: 28px; }
}

@media (prefers-reduced-motion: reduce) {
  .recharge-grid :deep(.recharge-package-card--featured) { transform: none; }
}
</style>
