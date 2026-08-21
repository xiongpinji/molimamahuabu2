<template>
  <main class="recharge-center">
    <header class="recharge-topbar">
      <div class="recharge-topbar__inner">
        <div class="recharge-brand">
          <img class="brand-logo" src="/moli-mama-logo.png" alt="茉莉妈妈">
          <div class="brand-copy"><strong>充值中心</strong><span>茉莉妈妈</span></div>
        </div>
        <div class="topbar-actions">
          <div class="credit-balance" aria-label="当前可用积分">
            <span>可用积分</span>
            <strong>{{ loadState === 'ready' ? account.available.toLocaleString('zh-CN') : '--' }}</strong>
          </div>
          <button
            type="button"
            class="history-button"
            aria-label="充值记录"
            :disabled="loadState !== 'ready'"
            @click="ordersOpen = true"
          >
            <span aria-hidden="true">◷</span><span class="history-button__label">充值记录</span>
          </button>
          <button type="button" class="back-button" aria-label="返回工作区" @click="backToWorkspace">
            <span aria-hidden="true">←</span><span class="back-button__label">返回工作区</span>
          </button>
        </div>
      </div>
    </header>

    <div class="recharge-content">
      <section v-if="loadState === 'loading'" class="recharge-loading-state" role="status" aria-live="polite">
        <span class="state-spinner" aria-hidden="true" />
        <h1>正在加载充值信息</h1>
        <p>正在同步积分、支付状态、套餐与充值记录。</p>
      </section>
      <section v-else-if="loadState === 'error'" class="recharge-load-error" role="alert">
        <span class="error-mark" aria-hidden="true">!</span>
        <h1>充值信息加载失败</h1>
        <p>{{ loadError }}</p>
        <div class="state-actions">
          <button type="button" class="retry-button" @click="loadRechargeCenter">重新加载</button>
          <button type="button" class="safe-back-button" @click="backToWorkspace">返回工作区</button>
        </div>
      </section>

      <template v-else-if="loadState === 'ready'">
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
          v-if="!rechargeConfig.configured"
          class="channel-alert"
          title="支付通道准备中"
          description="页面可正常浏览，当前不会创建订单或扣款。"
          type="warning"
          :closable="false"
          show-icon
        />

        <section class="recharge-stage">
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
            <div v-else class="empty-state">
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
      </template>
    </div>

    <el-drawer
      v-if="loadState === 'ready'"
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
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  createAlipayRechargeOrder,
  getCreditAccount,
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
const loadState = ref('loading')
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
let loadRequest = null
let loadController = null
let loadGeneration = 0
let isMounted = false

function backToWorkspace() {
  router.push({ name: 'tenant-console' })
}

function createClientOrderKey() {
  return `recharge-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function loadRechargeCenter() {
  if (loadRequest) return loadRequest
  const generation = ++loadGeneration
  const controller = new AbortController()
  const requestConfig = { silentError: true, signal: controller.signal }
  loadController = controller
  loadState.value = 'loading'
  loadError.value = ''
  ordersOpen.value = false
  const request = Promise.all([
      getCreditAccount(requestConfig),
      getAlipayRechargeConfig(requestConfig),
      listRechargePackages(requestConfig),
      listAlipayRechargeOrders(requestConfig),
    ])
    .then(([credit, config, packages, orders]) => {
      if (!isMounted || generation !== loadGeneration || controller.signal.aborted) return
      const nextAccount = normalizeCreditAccount(credit)
      const nextConfig = { ...rechargeConfig.value, ...config }
      const nextPackages = Array.isArray(packages) ? packages : []
      const nextOrders = Array.isArray(orders) ? orders : []
      account.value = nextAccount
      rechargeConfig.value = nextConfig
      rechargePackages.value = nextPackages
      rechargeOrders.value = nextOrders
      loadState.value = 'ready'
    })
    .catch((error) => {
      controller.abort()
      if (!isMounted || generation !== loadGeneration) return
      if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || error?.name === 'AbortError') return
      loadError.value = error?.message || '请稍后重试'
      loadState.value = 'error'
    })
    .finally(() => {
      if (generation !== loadGeneration) return
      if (loadController === controller) loadController = null
      if (loadRequest === request) loadRequest = null
    })
  loadRequest = request
  return loadRequest
}

async function beginRecharge(payload, target) {
  if (loadState.value !== 'ready') return
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

onMounted(() => {
  isMounted = true
  loadRechargeCenter()
})

onBeforeUnmount(() => {
  isMounted = false
  loadGeneration += 1
  loadController?.abort()
  loadController = null
  loadRequest = null
})
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
.back-button,
.history-button { display: flex; min-height: 40px; padding: 0 14px; border-radius: 12px; align-items: center; justify-content: center; gap: 7px; font: inherit; font-size: 13px; }
.back-button:hover,
.back-button:focus-visible,
.history-button:hover,
.history-button:focus-visible { border-color: #ff7139; outline: none; }
.back-button:focus-visible,
.history-button:focus-visible { box-shadow: 0 0 0 3px rgba(255, 113, 57, .3); }
.history-button:disabled { border-color: #292929; color: #77777d; background: #121212; cursor: not-allowed; }
.recharge-brand { display: flex; min-width: 0; align-items: center; gap: 11px; }
.brand-logo { display: block; width: 42px; height: 42px; flex: 0 0 auto; object-fit: contain; }
.brand-copy { display: grid; min-width: 0; gap: 2px; }
.brand-copy strong { color: #f7f7f7; font-size: 16px; white-space: nowrap; }
.brand-copy span { color: #929298; font-size: 11px; }
.topbar-actions { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.credit-balance { display: grid; gap: 2px; padding-right: 12px; text-align: right; }
.credit-balance span { color: #919197; font-size: 11px; }
.credit-balance strong { color: #ff936b; font-size: 17px; }
.recharge-content { max-width: 1600px; margin: 0 auto; padding: 56px 34px 80px; }
.recharge-loading-state,
.recharge-load-error { display: grid; max-width: 620px; min-height: 360px; margin: 42px auto 0; padding: 42px; border: 1px solid #303030; border-radius: 24px; place-items: center; align-content: center; text-align: center; background: #151515; box-shadow: 0 26px 60px rgba(0, 0, 0, .28); }
.recharge-loading-state h1,
.recharge-load-error h1 { margin: 18px 0 8px; font-size: clamp(26px, 4vw, 38px); }
.recharge-loading-state p,
.recharge-load-error p { max-width: 480px; margin: 0; color: #a7a7ad; line-height: 1.7; }
.state-spinner { width: 38px; height: 38px; border: 3px solid #343434; border-top-color: #ff7139; border-radius: 50%; animation: state-spin .8s linear infinite; }
.error-mark { display: grid; width: 48px; height: 48px; border: 1px solid rgba(255, 113, 57, .48); border-radius: 50%; place-items: center; color: #ff9a74; font-size: 25px; font-weight: 900; background: rgba(255, 113, 57, .1); }
.state-actions { display: flex; justify-content: center; gap: 10px; margin-top: 26px; flex-wrap: wrap; }
.retry-button,
.safe-back-button { min-height: 44px; padding: 0 18px; border: 1px solid #3a3a3a; border-radius: 12px; color: #f4f4f5; font: inherit; font-weight: 700; background: #202020; cursor: pointer; }
.retry-button { border-color: #ff7139; color: #1a0904; background: linear-gradient(110deg, #ffd0bd, #ff7139); }
.retry-button:focus-visible,
.safe-back-button:focus-visible { outline: 3px solid rgba(255, 113, 57, .36); outline-offset: 3px; }
@keyframes state-spin { to { transform: rotate(360deg); } }
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
  .brand-copy span { display: none; }
  .credit-balance { padding-right: 0; }
  .credit-balance span { display: none; }
  .history-button,
  .back-button { padding: 0 10px; }
  .recharge-content { padding: 40px 16px 58px; }
  .recharge-hero h1 { font-size: 36px; }
  .recharge-grid { grid-template-columns: 1fr; }
  .recharge-grid :deep(.recharge-package-card--featured) { transform: none; }
}

@media (max-width: 420px) {
  .brand-logo { width: 36px; height: 36px; }
  .brand-copy strong { font-size: 14px; }
  .history-button__label,
  .back-button__label { display: none; }
  .recharge-hero { text-align: left; }
  .mode-switch { margin-top: 28px; }
}

@media (prefers-reduced-motion: reduce) {
  .state-spinner { animation: none; }
  .recharge-grid :deep(.recharge-package-card--featured) { transform: none; }
}
</style>
