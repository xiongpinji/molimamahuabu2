<template>
  <main class="personal-center" :class="{ 'is-embedded': embedded, 'reduce-motion': reduceMotion }">
    <div class="center-shell">
      <aside class="center-sidebar">
        <div class="sidebar-brand">
          <span>茉</span>
          <div><strong>个人中心</strong><small>ACCOUNT</small></div>
        </div>
        <div class="sidebar-user">
          <span>{{ userInitial }}</span>
          <div><strong>{{ user.email || '当前用户' }}</strong><small>{{ roleLabel(user.role) }}</small></div>
        </div>
        <nav aria-label="个人中心导航">
          <template v-if="managementNavigation.length">
            <p class="nav-section-label nav-section-label--first">管理后台</p>
            <button
              v-for="item in managementNavigation"
              :key="item.name"
              type="button"
              class="management-link"
              :title="item.description"
              @click="openManagement(item)"
            >
              <el-icon><component :is="item.icon" /></el-icon>
              <span>{{ item.label }}</span>
              <i>进入</i>
            </button>
            <p class="nav-section-label">个人功能</p>
          </template>
          <button
            v-for="item in navigation"
            :key="item.key"
            type="button"
            :class="{ active: activeSection === item.key }"
            :aria-current="activeSection === item.key ? 'page' : undefined"
            @click="activeSection = item.key"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
            <i v-if="item.pending">待开放</i>
          </button>
        </nav>
        <button class="sidebar-logout" type="button" @click="logout">
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
          <div class="header-actions">
            <div class="balance-inline">
              <small>可用积分</small>
              <strong>{{ dataErrors.account ? '加载失败' : account.available }}</strong>
            </div>
            <button class="panel-close" type="button" aria-label="关闭个人中心" @click="closePanel">
              <el-icon><Close /></el-icon>
            </button>
          </div>
        </header>

        <div v-loading="loading" class="center-content">
          <template v-if="activeSection === 'profile'">
            <section class="profile-summary">
              <div class="hero-avatar">{{ userInitial }}</div>
              <div>
                <h2>{{ user.email || '当前用户' }}</h2>
                <p>{{ roleLabel(user.role) }} · {{ currentTenant?.name || '个人工作区' }}</p>
                <p v-if="dataErrors.user" class="data-error">账户资料暂时无法刷新</p>
              </div>
              <el-button plain @click="passwordDialog = true">修改密码</el-button>
            </section>
            <dl class="metric-strip">
              <div><dt>可用积分</dt><dd>{{ dataErrors.account ? '—' : account.available }}</dd></div>
              <div><dt>冻结积分</dt><dd>{{ dataErrors.account ? '—' : account.held }}</dd></div>
              <div><dt>累计使用</dt><dd>{{ dataErrors.account ? '—' : account.spent }}</dd></div>
              <div><dt>作品数量</dt><dd>{{ dataErrors.works ? '—' : works.length }}</dd></div>
            </dl>
            <section class="section-block">
              <div class="section-heading"><div><h3>当前工作区</h3><p>管理本次创作和积分归属</p></div></div>
              <p v-if="dataErrors.tenants" class="data-error">工作区暂时无法加载</p>
              <el-select v-else v-model="tenantId" aria-label="当前工作区" @change="switchTenant">
                <el-option v-for="tenant in tenants" :key="tenant.id" :label="tenant.name" :value="tenant.id" />
              </el-select>
            </section>
          </template>

          <template v-else-if="activeSection === 'credits'">
            <dl class="metric-strip metric-strip--three">
              <div><dt>可用</dt><dd>{{ dataErrors.account ? '—' : account.available }}</dd></div>
              <div><dt>冻结</dt><dd>{{ dataErrors.account ? '—' : account.held }}</dd></div>
              <div><dt>累计消耗</dt><dd>{{ dataErrors.account ? '—' : account.spent }}</dd></div>
            </dl>
            <section class="section-block">
              <div class="section-heading"><div><h3>积分流水</h3><p>账户的真实积分变动记录</p></div></div>
              <el-empty v-if="dataErrors.transactions" description="积分流水暂时无法加载" />
              <el-table v-else :data="transactions" empty-text="暂无积分流水">
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
            <el-empty v-if="dataErrors.transactions" description="用量数据暂时无法加载" />
            <template v-else>
              <dl class="metric-strip metric-strip--three">
                <div><dt>完成调用</dt><dd>{{ usageSummary.calls }}</dd></div>
                <div><dt>消耗积分</dt><dd>{{ usageSummary.credits }}</dd></div>
                <div><dt>使用模型</dt><dd>{{ usageSummary.models.length }}</dd></div>
              </dl>
              <section class="section-block">
                <div class="section-heading"><div><h3>模型用量</h3><p>按模型汇总已完成的调用</p></div></div>
                <div v-if="usageSummary.models.length" class="model-usage">
                  <div v-for="model in usageSummary.models" :key="model.name">
                    <span>{{ model.name }}</span><strong>{{ model.count }} 次 · {{ model.credits }} 积分</strong>
                  </div>
                </div>
                <el-empty v-else description="暂无已完成的模型调用" />
              </section>
            </template>
          </template>

          <template v-else-if="activeSection === 'earn'">
            <section class="redeem-panel">
              <span>兑换积分</span>
              <h2>输入平台发放的兑换码</h2>
              <p>积分将进入当前工作区，兑换成功后余额立即刷新。</p>
              <div><el-input v-model.trim="redeemCode" placeholder="MOLI-XXXX-XXXX-XXXX" /><el-button type="primary" :loading="redeeming" @click="redeem">立即兑换</el-button></div>
            </section>
          </template>

          <template v-else-if="activeSection === 'works'">
            <section class="section-block section-block--first">
              <div class="section-heading"><div><h3>我的作品</h3><p>当前账户有权访问的创作项目</p></div><span>{{ dataErrors.works ? '—' : works.length }} 个</span></div>
              <el-empty v-if="dataErrors.works" description="作品暂时无法加载" />
              <div v-else-if="works.length" class="works-list">
                <router-link v-for="work in works" :key="work.id" :to="workLink(work)" @click="closeForNavigation">
                  <span class="work-kind">{{ projectType(work) === 'canvas' ? '画布' : '短剧' }}</span>
                  <span class="work-main"><strong>{{ work.title || `未命名作品 ${work.id}` }}</strong><small>{{ formatDate(work.updated_at || work.created_at) }}</small></span>
                  <span aria-hidden="true">→</span>
                </router-link>
              </div>
              <el-empty v-else description="暂无作品" />
            </section>
          </template>

          <template v-else-if="activeSection === 'security'">
            <section class="section-block section-block--first">
              <div class="section-heading"><div><h3>登录与安全</h3><p>管理密码并查看账户活动</p></div><el-button plain @click="passwordDialog = true">修改密码</el-button></div>
              <div class="current-device"><span class="status-dot"></span><div><strong>本次浏览器登录</strong><small>由当前登录令牌确认</small></div></div>
              <h3 class="subheading">近期账户活动</h3>
              <el-empty v-if="dataErrors.audit" description="近期账户活动暂时无法加载" />
              <el-timeline v-else>
                <el-timeline-item v-for="event in auditEvents" :key="event.id" :timestamp="formatDate(event.created_at)">
                  {{ auditLabel(event.event_type) }} · {{ event.outcome === 'failed' ? '失败' : '成功' }}
                </el-timeline-item>
              </el-timeline>
            </section>
          </template>

          <template v-else-if="activeSection === 'settings'">
            <section class="section-block section-block--first settings-list">
              <div><div><strong>深色界面</strong><small>切换个人中心及平台主题</small></div><el-switch :model-value="isDark" @change="toggleTheme" /></div>
              <div><div><strong>减少动效</strong><small>降低过渡动画与视觉移动</small></div><el-switch v-model="reduceMotion" @change="saveMotionPreference" /></div>
            </section>
          </template>

          <template v-else>
            <section class="pending-panel">
              <span>COMING SOON</span><h2>{{ activeItem.label }}</h2>
              <p>该模块尚未开放。当前源码没有对应的真实业务数据链，因此不会展示模拟数据。</p>
            </section>
          </template>
        </div>
      </section>
    </div>

    <el-dialog v-model="passwordDialog" title="修改密码" width="430px" append-to-body>
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
  Monitor, Setting, SwitchButton, Close,
} from '@element-plus/icons-vue'
import { changePassword, getCreditAccount, getCurrentUser, logout as logoutApi } from '@/api/auth'
import { listAuditEvents, listCreditTransactions, redeemCredits } from '@/api/billing'
import { dramaAPI } from '@/api/drama'
import { listTenants } from '@/api/tenants'
import { clearSession, readCurrentTenantId, readSession, saveCurrentTenantId } from '@/utils/authSession'
import { normalizeCreditAccount } from '@/utils/billingDisplay'
import { ACCOUNT_PERMISSIONS, BILLING_PERMISSIONS, canPlatformAccount } from '@/utils/platformRbac'
import { useTheme } from '@/composables/useTheme'

const props = defineProps({
  embedded: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])
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
const dataErrors = ref({})
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
  { key: 'earn', label: '兑换码兑换', description: '使用平台兑换码补充当前工作区积分', icon: Present },
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
const managementNavigation = computed(() => {
  const role = user.value.role
  return [
    {
      name: 'tenant-console',
      label: '工作区与积分',
      description: '管理成员、兑换与积分流水',
      icon: Collection,
      visible: ['admin', 'ops', 'support', 'read_only'].includes(role),
    },
    {
      name: 'account-admin',
      label: '账号与权限',
      description: '管理账号角色、状态与会话',
      icon: Avatar,
      visible: canPlatformAccount(role, ACCOUNT_PERMISSIONS.READ),
    },
    {
      name: 'billing-admin',
      label: '运营与计费',
      description: '管理模型定价、兑换码与对账',
      icon: Coin,
      visible: canPlatformAccount(role, BILLING_PERMISSIONS.REDEEM_CODES_MANAGE),
    },
    {
      name: 'ai-config',
      label: '模型配置',
      description: '管理供应商、密钥与模型',
      icon: Setting,
      visible: role === 'admin',
    },
  ].filter((item) => item.visible)
})
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
  return ({
    admin: '平台管理员',
    ops: '运营人员',
    support: '客服人员',
    read_only: '只读人员',
    redeem_admin: '兑换码管理员',
    user: '普通用户',
  })[role] || '普通用户'
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
function closePanel() {
  if (props.embedded) {
    emit('close')
    return
  }
  if (window.history.state?.back) {
    router.back()
    return
  }
  void router.replace({ name: 'list' })
}
function closeForNavigation() {
  if (props.embedded) emit('close')
}
function openManagement(item) {
  closeForNavigation()
  void router.push({ name: item.name })
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
    closeForNavigation()
    await router.replace({ name: 'login' })
    ElMessage.success('密码已修改，请重新登录')
  } finally {
    passwordLoading.value = false
  }
}
async function logout() {
  await logoutApi().catch(() => undefined)
  clearSession()
  closeForNavigation()
  await router.replace({ name: 'login' })
}
onMounted(async () => {
  try {
    const [currentUser, credit, tenantList, ledger, projects, events] = await Promise.allSettled([
      getCurrentUser(), getCreditAccount(), listTenants(), listCreditTransactions(),
      dramaAPI.list(), listAuditEvents(30),
    ])
    dataErrors.value = {
      user: currentUser.status === 'rejected',
      account: credit.status === 'rejected',
      tenants: tenantList.status === 'rejected',
      transactions: ledger.status === 'rejected',
      works: projects.status === 'rejected',
      audit: events.status === 'rejected',
    }
    if (currentUser.status === 'fulfilled') user.value = currentUser.value || user.value
    if (credit.status === 'fulfilled') account.value = normalizeCreditAccount(credit.value)
    if (tenantList.status === 'fulfilled') {
      tenants.value = Array.isArray(tenantList.value) ? tenantList.value : []
      const saved = readCurrentTenantId()
      tenantId.value = tenants.value.some((item) => item.id === saved) ? saved : tenants.value[0]?.id || ''
      if (tenantId.value) saveCurrentTenantId(tenantId.value)
    }
    if (ledger.status === 'fulfilled') transactions.value = Array.isArray(ledger.value) ? ledger.value : []
    if (projects.status === 'fulfilled') {
      works.value = Array.isArray(projects.value) ? projects.value : projects.value?.items || []
    }
    if (events.status === 'fulfilled') auditEvents.value = Array.isArray(events.value) ? events.value : []
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.personal-center {
  height: 100%;
  min-height: 100vh;
  overflow: hidden;
  color: #f5f5f5;
  background: #111113;
}
.personal-center.is-embedded { min-height: 0; }
.center-shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); height: 100%; min-height: 680px; }
.is-embedded .center-shell { min-height: 0; }
.center-sidebar {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  padding: 26px 18px 20px;
  border-right: 1px solid rgba(255,255,255,.08);
  background: linear-gradient(180deg, #18181b 0%, #131315 100%);
}
.sidebar-brand,.sidebar-user { display: flex; align-items: center; gap: 12px; }
.sidebar-brand { padding: 0 8px 22px; }
.sidebar-brand > span,.sidebar-user > span {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  color: #171719;
  background: linear-gradient(135deg, #ffd36a, #ff8064);
  font-weight: 900;
}
.sidebar-brand > span { width: 36px; height: 36px; border-radius: 11px; }
.sidebar-brand div,.sidebar-user div { display: flex; min-width: 0; flex-direction: column; }
.sidebar-brand strong { font-size: 15px; }.sidebar-brand small { margin-top: 2px; color: #73737b; font-size: 9px; letter-spacing: .18em; }
.sidebar-user { margin-bottom: 18px; padding: 16px 8px; border-block: 1px solid rgba(255,255,255,.07); }
.sidebar-user > span { width: 40px; height: 40px; border-radius: 50%; }
.sidebar-user strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-user small { margin-top: 4px; color: #85858d; font-size: 11px; }
.center-sidebar nav { display: flex; flex: 1; flex-direction: column; gap: 2px; overflow-y: auto; }
.center-sidebar nav::-webkit-scrollbar { width: 4px; }
.center-sidebar nav::-webkit-scrollbar-track { background: transparent; }
.center-sidebar nav::-webkit-scrollbar-thumb { border-radius: 4px; background: rgba(255,255,255,.16); }
.nav-section-label {
  margin: 14px 12px 5px;
  padding-top: 14px;
  border-top: 1px solid rgba(255,255,255,.07);
  color: #66666e;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .16em;
}
.nav-section-label--first { margin-top: 0; padding-top: 0; border-top: 0; }
.center-sidebar nav button,.sidebar-logout {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 42px;
  align-items: center;
  gap: 11px;
  padding: 0 12px;
  border: 0;
  border-radius: 10px;
  color: #92929a;
  background: transparent;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.center-sidebar nav button:hover,.sidebar-logout:hover { color: #fff; background: rgba(255,255,255,.045); }
.center-sidebar nav button.active { color: #fff; background: rgba(255,143,112,.12); }
.center-sidebar nav button.management-link { color: #b9b9c0; }
.center-sidebar nav button.management-link:hover { color: #ffd7c7; background: rgba(255,143,112,.08); }
.center-sidebar nav button.active::before { position: absolute; inset: 9px auto 9px 0; width: 2px; border-radius: 2px; background: #ff8f70; content: ''; }
.center-sidebar nav button i { margin-left: auto; color: #707077; font-size: 9px; font-style: normal; }
.center-sidebar nav button:focus-visible,.sidebar-logout:focus-visible,.panel-close:focus-visible { outline: 2px solid #ff9a73; outline-offset: 2px; }
.sidebar-logout { margin-top: 12px; border-top: 1px solid rgba(255,255,255,.07); border-radius: 0; }
.center-stage { display: flex; min-width: 0; min-height: 0; flex-direction: column; }
.center-header {
  display: flex;
  min-height: 126px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  padding: 28px 38px;
  border-bottom: 1px solid rgba(255,255,255,.075);
  background: radial-gradient(circle at 82% 0%, rgba(255,121,86,.09), transparent 42%);
}
.center-header p { margin: 0 0 6px; color: #ff9a73; font-size: 10px; letter-spacing: .22em; }
.center-header h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -.02em; }
.center-header > div > span { display: block; margin-top: 6px; color: #85858d; font-size: 13px; }
.header-actions { display: flex; align-items: center; gap: 20px; }
.balance-inline { display: flex; flex-direction: column; align-items: flex-end; }
.balance-inline small { color: #85858d; }.balance-inline strong { margin-top: 4px; color: #ffd36a; font-size: 24px; }
.panel-close { display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid rgba(255,255,255,.1); border-radius: 50%; color: #b7b7bd; background: transparent; cursor: pointer; }
.panel-close:hover { color: #fff; background: rgba(255,255,255,.06); }
.center-content { min-height: 0; flex: 1; overflow-y: auto; padding: 34px 40px 56px; }
.profile-summary { display: flex; align-items: center; gap: 18px; padding-bottom: 30px; }
.profile-summary > div:nth-child(2) { flex: 1; min-width: 0; }.profile-summary h2 { margin: 0 0 6px; font-size: 21px; }.profile-summary p { margin: 0; color: #8f8f97; }
.hero-avatar { display: grid; width: 64px; height: 64px; flex: 0 0 auto; place-items: center; border-radius: 18px; color: #161616; background: linear-gradient(135deg,#ffd36a,#ff8064); font-size: 24px; font-weight: 900; }
.metric-strip { display: grid; grid-template-columns: repeat(4, 1fr); margin: 0; padding: 22px 0; border-block: 1px solid rgba(255,255,255,.085); }
.metric-strip--three { grid-template-columns: repeat(3, 1fr); }
.metric-strip > div { padding: 0 22px; }.metric-strip > div:first-child { padding-left: 0; }.metric-strip > div + div { border-left: 1px solid rgba(255,255,255,.08); }
.metric-strip dt { color: #85858d; font-size: 12px; }.metric-strip dd { margin: 8px 0 0; font-size: 27px; font-weight: 650; }
.section-block { margin-top: 34px; padding-top: 28px; border-top: 1px solid rgba(255,255,255,.075); }
.section-block--first { margin-top: 0; padding-top: 0; border-top: 0; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
.section-heading h3,.subheading { margin: 0; font-size: 16px; }.section-heading p { margin: 5px 0 0; color: #85858d; font-size: 12px; }.section-heading > span { color: #85858d; font-size: 12px; }
.model-usage > div,.settings-list > div { display: flex; align-items: center; justify-content: space-between; padding: 17px 0; border-bottom: 1px solid rgba(255,255,255,.075); }
.model-usage span,.settings-list small { color: #8f8f97; }.settings-list small { display: block; margin-top: 5px; }
.redeem-panel,.pending-panel { max-width: 660px; margin: 8vh auto 0; text-align: center; }
.redeem-panel > span,.pending-panel > span { color: #ff9a73; font-size: 11px; letter-spacing: .2em; }
.redeem-panel h2,.pending-panel h2 { margin: 16px 0 10px; font-size: 27px; }.redeem-panel p,.pending-panel p { color: #8f8f97; }
.redeem-panel > div { display: flex; gap: 12px; margin-top: 28px; padding-top: 28px; border-top: 1px solid rgba(255,255,255,.08); }
.works-list { border-top: 1px solid rgba(255,255,255,.09); }
.works-list a { display: grid; grid-template-columns: 72px minmax(0,1fr) auto; align-items: center; gap: 18px; min-height: 76px; padding: 12px 6px; border-bottom: 1px solid rgba(255,255,255,.075); color: #f4f4f5; text-decoration: none; transition: padding .18s, background .18s; }
.works-list a:hover { padding-inline: 14px; background: rgba(255,255,255,.035); }
.work-kind { color: #ffad8e; font-size: 11px; letter-spacing: .08em; }.work-main { display: flex; min-width: 0; flex-direction: column; gap: 6px; }.work-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.work-main small { color: #818188; }
.current-device { display:flex; align-items:center; gap:12px; margin-bottom:30px; padding:18px 0; border-block:1px solid rgba(255,255,255,.075); }.current-device div { display:flex; flex-direction:column; gap:4px; }.current-device small { color:#85858d; }.status-dot { width:9px; height:9px; border-radius:50%; background:#54d68b; box-shadow:0 0 12px rgba(84,214,139,.55); }
.subheading { margin-bottom: 22px; }.data-error { color: #ff9a73 !important; }
:deep(.el-table) { --el-table-bg-color: transparent; --el-table-tr-bg-color: transparent; --el-table-header-bg-color: rgba(255,255,255,.035); --el-table-border-color: rgba(255,255,255,.075); }
.reduce-motion * { scroll-behavior:auto!important; transition:none!important; animation:none!important; }
@media (max-width: 760px) {
  .center-shell { grid-template-columns: 82px minmax(0,1fr); min-height: 100vh; }
  .center-sidebar { padding: 14px 8px; }.sidebar-brand { justify-content: center; padding: 0 0 14px; }.sidebar-brand div,.sidebar-user,.sidebar-logout span { display: none; }
  .nav-section-label { margin: 10px 4px 4px; padding-top: 10px; text-align: center; letter-spacing: .08em; }
  .center-sidebar nav button,.sidebar-logout { min-height: 52px; flex-direction: column; justify-content: center; gap: 4px; padding: 4px; text-align: center; }.center-sidebar nav button span { max-width: 64px; overflow: hidden; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.center-sidebar nav button i { display: none; }
  .center-header { min-height: 108px; padding: 20px; }.center-header h1 { font-size: 23px; }.center-header > div > span,.balance-inline { display: none; }.header-actions { gap: 0; }
  .center-content { padding: 24px 18px 40px; }.profile-summary { align-items: flex-start; flex-wrap: wrap; }.profile-summary > div:nth-child(2) { min-width: calc(100% - 82px); }.profile-summary .el-button { margin-left: 82px; }
  .metric-strip,.metric-strip--three { grid-template-columns: repeat(2, 1fr); }.metric-strip > div { padding: 14px 16px; }.metric-strip > div:first-child { padding-left: 16px; }.metric-strip > div:nth-child(odd) { border-left: 0; }.metric-strip dd { font-size: 22px; }
  .section-heading { align-items: flex-start; }.redeem-panel,.pending-panel { margin-top: 4vh; }.redeem-panel > div { flex-direction: column; }
  .works-list a { grid-template-columns: 52px minmax(0,1fr) auto; gap: 10px; }.work-main small { font-size: 10px; }
}
</style>
