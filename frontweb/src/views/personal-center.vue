<template>
  <main class="personal-center" :class="{ 'reduce-motion': reduceMotion }">
    <aside class="center-rail">
      <router-link class="back-link" to="/" aria-label="返回项目">‹</router-link>
      <div class="rail-avatar">{{ userInitial }}</div>
      <nav aria-label="个人中心导航">
        <button
          v-for="item in navigation"
          :key="item.key"
          type="button"
          :class="{ active: activeSection === item.key }"
          :title="item.label"
          @click="activeSection = item.key"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
          <i v-if="item.pending">待开放</i>
        </button>
      </nav>
      <button class="rail-logout" type="button" title="退出登录" @click="logout">
        <el-icon><SwitchButton /></el-icon><span>退出登录</span>
      </button>
    </aside>

    <section class="center-stage">
      <header class="center-header">
        <div>
          <p>ACCOUNT CENTER</p>
          <h1>{{ activeItem.label }}</h1>
          <span>{{ activeItem.description }}</span>
        </div>
        <div class="balance-pill"><small>可用积分</small><strong>{{ account.available }}</strong></div>
      </header>

      <div v-loading="loading" class="center-content">
        <template v-if="activeSection === 'profile'">
          <section class="profile-hero">
            <div class="hero-avatar">{{ userInitial }}</div>
            <div>
              <h2>{{ user.email || '当前用户' }}</h2>
              <p>{{ roleLabel(user.role) }} · {{ currentTenant?.name || '个人工作区' }}</p>
            </div>
            <el-button @click="passwordDialog = true">修改密码</el-button>
          </section>
          <div class="metric-grid">
            <article><span>可用积分</span><strong>{{ account.available }}</strong></article>
            <article><span>冻结积分</span><strong>{{ account.held }}</strong></article>
            <article><span>累计使用</span><strong>{{ account.spent }}</strong></article>
            <article><span>作品数量</span><strong>{{ works.length }}</strong></article>
          </div>
          <section class="content-card">
            <h3>当前工作区</h3>
            <el-select v-model="tenantId" aria-label="当前工作区" @change="switchTenant">
              <el-option v-for="tenant in tenants" :key="tenant.id" :label="tenant.name" :value="tenant.id" />
            </el-select>
          </section>
        </template>

        <template v-else-if="activeSection === 'credits'">
          <div class="metric-grid">
            <article><span>可用</span><strong>{{ account.available }}</strong></article>
            <article><span>冻结</span><strong>{{ account.held }}</strong></article>
            <article><span>累计消耗</span><strong>{{ account.spent }}</strong></article>
          </div>
          <section class="content-card">
            <h3>积分流水</h3>
            <el-table :data="transactions" empty-text="暂无积分流水">
              <el-table-column prop="event_type" label="类型" width="120" />
              <el-table-column prop="amount" label="积分变动" width="120" />
              <el-table-column prop="model" label="模型" min-width="170" />
              <el-table-column prop="reason" label="说明" min-width="220" />
              <el-table-column label="时间" min-width="180">
                <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
              </el-table-column>
            </el-table>
          </section>
        </template>

        <template v-else-if="activeSection === 'usage'">
          <div class="metric-grid">
            <article><span>完成调用</span><strong>{{ usageSummary.calls }}</strong></article>
            <article><span>消耗积分</span><strong>{{ usageSummary.credits }}</strong></article>
            <article><span>使用模型</span><strong>{{ usageSummary.models.length }}</strong></article>
          </div>
          <section class="content-card">
            <h3>模型用量</h3>
            <div v-if="usageSummary.models.length" class="model-usage">
              <div v-for="model in usageSummary.models" :key="model.name">
                <span>{{ model.name }}</span><strong>{{ model.count }} 次 · {{ model.credits }} 积分</strong>
              </div>
            </div>
            <el-empty v-else description="暂无已完成的模型调用" />
          </section>
        </template>

        <template v-else-if="activeSection === 'earn'">
          <section class="redeem-card">
            <span>兑换积分</span>
            <h2>输入平台发放的兑换码</h2>
            <p>积分将进入当前工作区，兑换成功后余额立即刷新。</p>
            <div><el-input v-model.trim="redeemCode" placeholder="MOLI-XXXX-XXXX-XXXX" /><el-button type="primary" :loading="redeeming" @click="redeem">立即兑换</el-button></div>
          </section>
        </template>

        <template v-else-if="activeSection === 'works'">
          <section class="content-card">
            <h3>我的作品</h3>
            <div v-if="works.length" class="works-grid">
              <router-link v-for="work in works" :key="work.id" :to="workLink(work)">
                <span>{{ projectType(work) === 'canvas' ? '画布' : '短剧' }}</span>
                <strong>{{ work.title || `未命名作品 ${work.id}` }}</strong>
                <small>{{ formatDate(work.updated_at || work.created_at) }}</small>
              </router-link>
            </div>
            <el-empty v-else description="暂无作品" />
          </section>
        </template>

        <template v-else-if="activeSection === 'security'">
          <section class="content-card">
            <div class="card-heading"><h3>登录与安全</h3><el-button @click="passwordDialog = true">修改密码</el-button></div>
            <div class="current-device"><span class="status-dot"></span><div><strong>本次浏览器登录</strong><small>由当前登录令牌确认</small></div></div>
            <h3>近期账户活动</h3>
            <el-timeline>
              <el-timeline-item v-for="event in auditEvents" :key="event.id" :timestamp="formatDate(event.created_at)">
                {{ auditLabel(event.event_type) }} · {{ event.outcome === 'failed' ? '失败' : '成功' }}
              </el-timeline-item>
            </el-timeline>
          </section>
        </template>

        <template v-else-if="activeSection === 'settings'">
          <section class="content-card settings-list">
            <div><div><strong>深色界面</strong><small>切换个人中心及平台主题</small></div><el-switch :model-value="isDark" @change="toggleTheme" /></div>
            <div><div><strong>减少动效</strong><small>降低过渡动画与视觉移动</small></div><el-switch v-model="reduceMotion" @change="saveMotionPreference" /></div>
          </section>
        </template>

        <template v-else>
          <section class="pending-card">
            <span>COMING SOON</span><h2>{{ activeItem.label }}</h2>
            <p>该模块尚未开放。当前源码没有对应的真实业务数据链，因此不会展示模拟数据。</p>
          </section>
        </template>
      </div>
    </section>

    <el-dialog v-model="passwordDialog" title="修改密码" width="430px">
      <el-form label-position="top">
        <el-form-item label="当前密码"><el-input v-model="passwordForm.current" type="password" show-password /></el-form-item>
        <el-form-item label="新密码"><el-input v-model="passwordForm.next" type="password" show-password placeholder="至少 12 个字符" /></el-form-item>
        <el-form-item label="确认新密码"><el-input v-model="passwordForm.confirm" type="password" show-password /></el-form-item>
      </el-form>
      <template #footer><el-button @click="passwordDialog = false">取消</el-button><el-button type="primary" :loading="passwordLoading" @click="submitPasswordChange">保存并重新登录</el-button></template>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Avatar, Coin, DataAnalysis, Present, Collection, Star, Bell, Tickets,
  Monitor, Setting, SwitchButton,
} from '@element-plus/icons-vue'
import { changePassword, getCreditAccount, getCurrentUser, logout as logoutApi } from '@/api/auth'
import { listAuditEvents, listCreditTransactions, redeemCredits } from '@/api/billing'
import { dramaAPI } from '@/api/drama'
import { listTenants } from '@/api/tenants'
import { clearSession, readCurrentTenantId, readSession, saveCurrentTenantId } from '@/utils/authSession'
import { normalizeCreditAccount } from '@/utils/billingDisplay'
import { useTheme } from '@/composables/useTheme'

const router = useRouter()
const { isDark, toggle: toggleTheme } = useTheme()
const activeSection = ref('profile')
const loading = ref(true)
const user = ref(readSession()?.user || {})
const account = ref(normalizeCreditAccount())
const tenants = ref([])
const tenantId = ref('')
const transactions = ref([])
const works = ref([])
const auditEvents = ref([])
const redeemCode = ref('')
const redeeming = ref(false)
const passwordDialog = ref(false)
const passwordLoading = ref(false)
const passwordForm = ref({ current: '', next: '', confirm: '' })
const reduceMotion = ref(localStorage.getItem('moli-personal-reduce-motion') === '1')

const navigation = [
  { key: 'profile', label: '个人信息', description: '管理账户资料、工作区和安全信息', icon: Avatar },
  { key: 'credits', label: '积分账单', description: '查看余额与每一笔真实积分变动', icon: Coin },
  { key: 'usage', label: '用量统计', description: '按真实模型调用汇总资源消耗', icon: DataAnalysis },
  { key: 'earn', label: '赚取积分', description: '使用平台兑换码补充当前工作区积分', icon: Present },
  { key: 'courses', label: '社群课程', description: '课程与社群权益', icon: Collection, pending: true },
  { key: 'gifts', label: '礼品卡', description: '礼品卡管理', icon: Present, pending: true },
  { key: 'coupons', label: '优惠券', description: '优惠券与活动权益', icon: Tickets, pending: true },
  { key: 'treasure', label: '宝箱', description: '活动奖励', icon: Present, pending: true },
  { key: 'works', label: '我的作品', description: '查看当前账户有权访问的创作项目', icon: Collection },
  { key: 'likes', label: '我的点赞', description: '收藏与点赞内容', icon: Star, pending: true },
  { key: 'messages', label: '站内消息', description: '系统与创作通知', icon: Bell, pending: true },
  { key: 'invoice', label: '发票管理', description: '发票与抬头信息', icon: Tickets, pending: true },
  { key: 'security', label: '登录与安全', description: '查看登录活动并更新密码', icon: Monitor },
  { key: 'settings', label: '体验设置', description: '调整主题和界面动效偏好', icon: Setting },
]
const activeItem = computed(() => navigation.find((item) => item.key === activeSection.value) || navigation[0])
const userInitial = computed(() => String(user.value.email || '茉').slice(0, 1).toUpperCase())
const currentTenant = computed(() => tenants.value.find((item) => item.id === tenantId.value))
const usageSummary = computed(() => {
  const confirmed = transactions.value.filter((item) => item.event_type === 'confirm')
  const grouped = new Map()
  confirmed.forEach((item) => {
    const name = item.model || item.resource_type || '未标注模型'
    const current = grouped.get(name) || { name, count: 0, credits: 0 }
    current.count += 1
    current.credits += Math.abs(Number(item.amount) || 0)
    grouped.set(name, current)
  })
  return {
    calls: confirmed.length,
    credits: confirmed.reduce((sum, item) => sum + Math.abs(Number(item.amount) || 0), 0),
    models: [...grouped.values()].sort((a, b) => b.credits - a.credits),
  }
})

function roleLabel(role) {
  return ({ admin: '平台管理员', ops: '运营人员', support: '客服人员', read_only: '只读人员', user: '普通用户' })[role] || '普通用户'
}
function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}
function auditLabel(type) {
  return ({ 'auth.login.success': '账户登录', 'auth.password_change.success': '修改密码', 'auth.password_reset.success': '重置密码' })[type] || String(type || '账户活动').replaceAll('.', ' / ')
}
function projectType(work) {
  return work?.metadata?.project_type || work?.project_type || 'factory'
}
function workLink(work) {
  return projectType(work) === 'canvas' ? `/canvas/${work.id}` : `/drama/${work.id}`
}
function switchTenant(value) {
  saveCurrentTenantId(value)
  window.location.reload()
}
function saveMotionPreference(value) {
  localStorage.setItem('moli-personal-reduce-motion', value ? '1' : '0')
}
async function redeem() {
  if (!redeemCode.value) return ElMessage.warning('请输入兑换码')
  redeeming.value = true
  try {
    const result = await redeemCredits(redeemCode.value)
    account.value = normalizeCreditAccount(result.account)
    redeemCode.value = ''
    transactions.value = await listCreditTransactions()
    window.dispatchEvent(new Event('moli:credit-account-refresh'))
    ElMessage.success(`兑换成功，已增加 ${result.credits} 积分`)
  } finally {
    redeeming.value = false
  }
}
async function submitPasswordChange() {
  if (!passwordForm.value.current || passwordForm.value.next.length < 12) return ElMessage.warning('请输入当前密码，新密码至少 12 个字符')
  if (passwordForm.value.next !== passwordForm.value.confirm) return ElMessage.warning('两次输入的新密码不一致')
  passwordLoading.value = true
  try {
    await changePassword({ current_password: passwordForm.value.current, new_password: passwordForm.value.next })
    clearSession()
    await router.replace({ name: 'login' })
    ElMessage.success('密码已修改，请重新登录')
  } finally {
    passwordLoading.value = false
  }
}
async function logout() {
  await logoutApi().catch(() => undefined)
  clearSession()
  await router.replace({ name: 'login' })
}
onMounted(async () => {
  try {
    const [currentUser, credit, tenantList, ledger, projects, events] = await Promise.all([
      getCurrentUser(), getCreditAccount(), listTenants(), listCreditTransactions(),
      dramaAPI.list(), listAuditEvents(30),
    ])
    user.value = currentUser || user.value
    account.value = normalizeCreditAccount(credit)
    tenants.value = Array.isArray(tenantList) ? tenantList : []
    const saved = readCurrentTenantId()
    tenantId.value = tenants.value.some((item) => item.id === saved) ? saved : tenants.value[0]?.id || ''
    if (tenantId.value) saveCurrentTenantId(tenantId.value)
    transactions.value = Array.isArray(ledger) ? ledger : []
    works.value = Array.isArray(projects) ? projects : projects?.items || []
    auditEvents.value = Array.isArray(events) ? events : []
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.personal-center { min-height: 100vh; color: #f5f5f5; background: radial-gradient(circle at 76% 0%, rgba(255,121,86,.12), transparent 32%), #0b0b0c; }
.center-rail { position: fixed; inset: 0 0 0 auto; z-index: 10; display: flex; width: 86px; flex-direction: column; align-items: center; gap: 14px; padding: 18px 10px; border-left: 1px solid #252527; background: rgba(17,17,19,.96); }
.back-link { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid #303034; border-radius: 13px; color: #ddd; font-size: 28px; text-decoration: none; }
.rail-avatar { display: grid; width: 46px; height: 46px; place-items: center; border-radius: 50%; color: #141414; background: linear-gradient(135deg,#ffd36a,#ff8064); font-weight: 900; }
.center-rail nav { display: flex; width: 100%; flex: 1; flex-direction: column; gap: 4px; overflow-y: auto; scrollbar-width: none; }
.center-rail button { position: relative; display: flex; width: 100%; min-height: 50px; flex-direction: column; align-items: center; justify-content: center; gap: 3px; border: 0; border-radius: 12px; color: #85858c; background: transparent; cursor: pointer; }
.center-rail button span { font-size: 10px; white-space: nowrap; }
.center-rail button i { position: absolute; top: 2px; right: 1px; padding: 1px 3px; border-radius: 5px; color: #999; background: #29292c; font-size: 7px; font-style: normal; }
.center-rail button.active { color: #fff; background: #2a2a2e; }
.center-stage { min-height: 100vh; margin-right: 86px; }
.center-header { display: flex; min-height: 128px; align-items: center; justify-content: space-between; padding: 28px 48px; border-bottom: 1px solid #232326; }
.center-header p { margin: 0 0 6px; color: #ff9a73; font-size: 11px; letter-spacing: .2em; }
.center-header h1 { margin: 0; font-size: 30px; }
.center-header span { display: block; margin-top: 7px; color: #898990; }
.balance-pill { display: flex; min-width: 126px; flex-direction: column; align-items: flex-end; padding: 14px 18px; border: 1px solid #353538; border-radius: 16px; background: #19191b; }
.balance-pill small { color: #93939a; }.balance-pill strong { color: #ffd36a; font-size: 25px; }
.center-content { max-width: 1180px; min-height: 560px; margin: 0 auto; padding: 38px 42px 80px; }
.profile-hero,.content-card,.redeem-card,.pending-card { border: 1px solid #29292d; border-radius: 22px; background: #151517; }
.profile-hero { display: flex; align-items: center; gap: 18px; padding: 26px; }.profile-hero > div:nth-child(2) { flex: 1; }.profile-hero h2 { margin: 0 0 7px; }.profile-hero p { margin: 0; color: #929298; }
.hero-avatar { display: grid; width: 68px; height: 68px; place-items: center; border-radius: 20px; color: #161616; background: linear-gradient(135deg,#ffd36a,#ff8064); font-size: 26px; font-weight: 900; }
.metric-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 14px; margin: 18px 0; }.metric-grid article { padding: 22px; border: 1px solid #29292d; border-radius: 18px; background: #151517; }.metric-grid span { color: #8d8d94; }.metric-grid strong { display: block; margin-top: 12px; font-size: 28px; }
.content-card { margin-top: 18px; padding: 26px; }.content-card h3 { margin: 0 0 20px; }.card-heading { display:flex; align-items:center; justify-content:space-between; }
.model-usage > div,.settings-list > div { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid #29292d; }.model-usage span,.settings-list small { color: #929298; }.settings-list small { display:block; margin-top:5px; }
.redeem-card,.pending-card { padding: 48px; text-align: center; }.redeem-card > span,.pending-card > span { color: #ff9a73; font-size: 12px; letter-spacing: .18em; }.redeem-card p,.pending-card p { color: #929298; }.redeem-card > div { display: flex; max-width: 560px; gap: 12px; margin: 28px auto 0; }
.works-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 14px; }.works-grid a { display:flex; min-height:130px; flex-direction:column; justify-content:flex-end; gap:7px; padding:18px; border:1px solid #303034; border-radius:16px; color:#fff; background:linear-gradient(145deg,#222227,#141416); text-decoration:none; }.works-grid a span,.works-grid a small { color:#929298; }
.current-device { display:flex; align-items:center; gap:12px; margin-bottom:30px; padding:16px; border:1px solid #303034; border-radius:14px; }.current-device div { display:flex; flex-direction:column; gap:4px; }.current-device small { color:#8d8d94; }.status-dot { width:10px; height:10px; border-radius:50%; background:#54d68b; box-shadow:0 0 12px rgba(84,214,139,.55); }
.reduce-motion * { scroll-behavior:auto!important; transition:none!important; animation:none!important; }
@media (max-width: 760px) {
  .center-rail { inset: auto 0 0; width: 100%; height: 74px; flex-direction: row; padding: 8px 10px; border-top: 1px solid #29292d; border-right: 0; }.center-rail nav { flex-direction:row; overflow-x:auto; }.center-rail nav button { min-width:58px; }.back-link,.rail-avatar,.rail-logout { display:none!important; }
  .center-stage { margin-right:0; padding-bottom:74px; }.center-header { padding:22px; }.balance-pill { display:none; }.center-content { padding:22px 14px 40px; }.metric-grid { grid-template-columns:repeat(2,1fr); }.works-grid { grid-template-columns:1fr; }.profile-hero { align-items:flex-start; flex-wrap:wrap; }.redeem-card,.pending-card { padding:30px 20px; }
}
</style>
