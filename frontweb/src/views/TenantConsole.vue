<template>
  <main class="tenant-page">
    <PlatformHeader title="工作区与计费" back-to="/" back-label="返回项目" />

    <section v-if="!publicMode" class="tenant-shell">
      <el-alert
        title="租户控制台仅在公开平台模式启用"
        description="本地单用户模式继续使用原有数据和配置。"
        type="info"
        :closable="false"
      />
    </section>

    <section v-else v-loading="loading" class="tenant-shell">
      <header class="page-heading">
        <div>
          <h1>工作区与计费</h1>
          <p>切换团队空间、管理成员，并查看当前租户的积分和订阅。</p>
        </div>
        <el-button type="primary" @click="showCreate = true">新建工作区</el-button>
      </header>

      <div class="workspace-strip">
        <button
          v-for="tenant in tenants"
          :key="tenant.id"
          type="button"
          class="workspace-card"
          :class="{ active: tenant.id === tenantId }"
          @click="switchWorkspace(tenant.id)"
        >
          <strong>{{ tenant.name }}</strong>
          <span>{{ roleLabel(tenant.role) }} · {{ tenant.slug }}</span>
        </button>
      </div>

      <div v-if="currentTenant" class="overview-grid">
        <article class="info-card">
          <span>可用积分</span>
          <strong>{{ account.available }}</strong>
          <small>冻结 {{ account.held }} · 已使用 {{ account.spent }}</small>
        </article>
        <article class="info-card">
          <span>当前套餐</span>
          <strong>{{ subscription?.plan_name || '尚未订阅' }}</strong>
          <small>{{ subscription ? subscriptionStatus(subscription.status) : '可从下方创建待支付订单' }}</small>
        </article>
        <article class="info-card">
          <span>当前工作区</span>
          <strong>{{ currentTenant.name }}</strong>
          <small>{{ roleLabel(currentTenant.role) }}</small>
        </article>
      </div>

      <section v-if="isManager" class="panel">
        <div class="panel-heading">
          <div>
            <h2>成员管理</h2>
            <p>新成员必须先注册平台账号，再通过邮箱加入。</p>
          </div>
          <div class="member-form">
            <el-input v-model.trim="memberForm.email" placeholder="成员邮箱" />
            <el-select v-model="memberForm.role">
              <el-option label="成员" value="member" />
              <el-option label="管理员" value="admin" />
              <el-option v-if="currentTenant.role === 'owner'" label="所有者" value="owner" />
            </el-select>
            <el-button type="primary" :loading="addingMember" @click="addMember">添加</el-button>
          </div>
        </div>

        <el-table :data="members" empty-text="暂无成员">
          <el-table-column prop="email" label="邮箱" min-width="220" />
          <el-table-column label="角色" width="120">
            <template #default="{ row }">{{ roleLabel(row.role) }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="100" />
          <el-table-column label="操作" width="100" align="right">
            <template #default="{ row }">
              <el-button
                v-if="row.user_id !== sessionUserId"
                link
                type="danger"
                @click="removeMember(row)"
              >
                移除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>套餐</h2>
            <p>本阶段仅创建待支付订单，不会自动扣款、激活订阅或发放积分。</p>
          </div>
        </div>
        <div v-if="plans.length" class="plan-grid">
          <article v-for="plan in plans" :key="plan.id" class="plan-card">
            <h3>{{ plan.name }}</h3>
            <p>{{ plan.description || '暂无说明' }}</p>
            <strong>{{ formatMoney(plan.price_cents, plan.currency) }}</strong>
            <span>每月 {{ plan.monthly_credits }} 积分</span>
            <el-button
              v-if="isManager"
              :loading="orderingPlanId === plan.id"
              @click="createOrder(plan)"
            >
              创建待支付订单
            </el-button>
          </article>
        </div>
        <el-empty v-else description="平台管理员尚未配置套餐" />
      </section>

      <section v-if="isManager" class="panel">
        <div class="panel-heading">
          <div>
            <h2>订单</h2>
            <p>真实支付回调接入前，订单只保留待支付或已取消状态。</p>
          </div>
        </div>
        <el-table :data="orders" empty-text="暂无订单">
          <el-table-column prop="plan_name" label="套餐" min-width="150" />
          <el-table-column label="金额" width="130">
            <template #default="{ row }">{{ formatMoney(row.amount_cents, row.currency) }}</template>
          </el-table-column>
          <el-table-column label="积分" width="110">
            <template #default="{ row }">{{ row.monthly_credits }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">{{ orderStatus(row.status) }}</template>
          </el-table-column>
          <el-table-column label="创建时间" min-width="180">
            <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100" align="right">
            <template #default="{ row }">
              <el-button v-if="row.status === 'pending'" link type="danger" @click="cancelOrder(row)">
                取消
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </section>

    <el-dialog v-model="showCreate" title="新建工作区" width="460px">
      <el-form label-position="top">
        <el-form-item label="工作区名称">
          <el-input v-model.trim="workspaceForm.name" maxlength="60" />
        </el-form-item>
        <el-form-item label="英文标识">
          <el-input v-model.trim="workspaceForm.slug" placeholder="例如 jasmine-studio" maxlength="63" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="creatingWorkspace" @click="createWorkspace">创建</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PlatformHeader from '@/components/PlatformHeader.vue'
import { getCreditAccount } from '@/api/auth'
import {
  addTenantMember,
  createTenant,
  listTenantMembers,
  listTenants,
  removeTenantMember,
} from '@/api/tenants'
import {
  cancelBillingOrder,
  createBillingOrder,
  getCurrentSubscription,
  listBillingOrders,
  listBillingPlans,
} from '@/api/billing'
import {
  readCurrentTenantId,
  readSession,
  saveCurrentTenantId,
} from '@/utils/authSession'
import { normalizeCreditAccount } from '@/utils/billingDisplay'

const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const loading = ref(false)
const tenants = ref([])
const tenantId = ref('')
const account = ref(normalizeCreditAccount())
const subscription = ref(null)
const plans = ref([])
const members = ref([])
const orders = ref([])
const showCreate = ref(false)
const creatingWorkspace = ref(false)
const addingMember = ref(false)
const orderingPlanId = ref('')
const workspaceForm = reactive({ name: '', slug: '' })
const memberForm = reactive({ email: '', role: 'member' })
const sessionUserId = readSession()?.user?.id || ''

const currentTenant = computed(() => tenants.value.find((tenant) => tenant.id === tenantId.value) || null)
const isManager = computed(() => ['owner', 'admin'].includes(currentTenant.value?.role))

function roleLabel(role) {
  return ({ owner: '所有者', admin: '管理员', member: '成员' })[role] || role || '成员'
}

function subscriptionStatus(status) {
  return ({ trialing: '试用中', active: '生效中', past_due: '待续费', canceled: '已取消' })[status] || status
}

function orderStatus(status) {
  return ({ pending: '待支付', paid: '已支付', canceled: '已取消', refunded: '已退款' })[status] || status
}

function formatMoney(cents, currency = 'CNY') {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
  }).format(Number(cents || 0) / 100)
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}

async function loadTenantData() {
  if (!tenantId.value) return
  const [credit, currentSubscription, availablePlans] = await Promise.all([
    getCreditAccount(),
    getCurrentSubscription(),
    listBillingPlans(),
  ])
  account.value = normalizeCreditAccount(credit)
  subscription.value = currentSubscription
  plans.value = availablePlans
  if (isManager.value) {
    const [tenantMembers, tenantOrders] = await Promise.all([
      listTenantMembers(tenantId.value),
      listBillingOrders(),
    ])
    members.value = tenantMembers
    orders.value = tenantOrders
  } else {
    members.value = []
    orders.value = []
  }
}

async function load() {
  if (!publicMode) return
  loading.value = true
  try {
    tenants.value = await listTenants()
    const savedId = readCurrentTenantId()
    tenantId.value = tenants.value.some((tenant) => tenant.id === savedId)
      ? savedId
      : tenants.value[0]?.id || ''
    if (tenantId.value) saveCurrentTenantId(tenantId.value)
    await loadTenantData()
  } finally {
    loading.value = false
  }
}

async function switchWorkspace(id) {
  if (id === tenantId.value) return
  tenantId.value = id
  saveCurrentTenantId(id)
  loading.value = true
  try {
    await loadTenantData()
  } finally {
    loading.value = false
  }
}

async function createWorkspace() {
  if (!workspaceForm.name || !workspaceForm.slug) return ElMessage.warning('请填写名称和英文标识')
  creatingWorkspace.value = true
  try {
    const created = await createTenant(workspaceForm)
    saveCurrentTenantId(created.id)
    tenantId.value = created.id
    showCreate.value = false
    workspaceForm.name = ''
    workspaceForm.slug = ''
    await load()
    ElMessage.success('工作区已创建')
  } finally {
    creatingWorkspace.value = false
  }
}

async function addMember() {
  if (!memberForm.email) return ElMessage.warning('请输入成员邮箱')
  addingMember.value = true
  try {
    await addTenantMember(tenantId.value, memberForm)
    memberForm.email = ''
    memberForm.role = 'member'
    members.value = await listTenantMembers(tenantId.value)
    ElMessage.success('成员已添加')
  } finally {
    addingMember.value = false
  }
}

async function removeMember(row) {
  try {
    await ElMessageBox.confirm(`确定移除 ${row.email}？`, '移除成员', { type: 'warning' })
  } catch (_) {
    return
  }
  await removeTenantMember(tenantId.value, row.user_id)
  members.value = await listTenantMembers(tenantId.value)
  ElMessage.success('成员已移除')
}

async function createOrder(plan) {
  orderingPlanId.value = plan.id
  try {
    const orderKey = globalThis.crypto?.randomUUID?.()
      || `checkout-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await createBillingOrder({ plan_id: plan.id, client_order_key: orderKey })
    orders.value = await listBillingOrders()
    ElMessage.success('待支付订单已创建；尚未发生扣款或积分入账')
  } finally {
    orderingPlanId.value = ''
  }
}

async function cancelOrder(row) {
  try {
    await ElMessageBox.confirm('确定取消该待支付订单？', '取消订单', { type: 'warning' })
  } catch (_) {
    return
  }
  await cancelBillingOrder(row.id)
  orders.value = await listBillingOrders()
  ElMessage.success('订单已取消')
}

onMounted(load)
</script>

<style scoped>
.tenant-page { min-height: 100vh; padding: 0 20px 56px; color: #f5f5f7; background: #111214; }
.tenant-shell { width: min(1120px, 100%); margin: 24px auto 0; }
.page-heading, .panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.page-heading h1, .panel h2 { margin: 0 0 8px; }
.page-heading p, .panel-heading p { margin: 0; color: #a8a9af; }
.workspace-strip { display: flex; gap: 12px; margin: 24px 0; overflow-x: auto; padding-bottom: 4px; }
.workspace-card { min-width: 210px; padding: 15px; border: 1px solid #303136; border-radius: 14px; color: #e4e4e7; background: #1b1c20; text-align: left; cursor: pointer; }
.workspace-card strong, .workspace-card span { display: block; }
.workspace-card span { margin-top: 6px; color: #92939a; font-size: 12px; }
.workspace-card.active { border-color: #8b5cf6; box-shadow: 0 0 0 2px rgba(139, 92, 246, .16); }
.overview-grid, .plan-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.info-card, .plan-card, .panel { border: 1px solid #303136; border-radius: 16px; background: #1b1c20; }
.info-card { display: grid; gap: 7px; padding: 20px; }
.info-card span, .info-card small, .plan-card span { color: #a8a9af; }
.info-card strong { font-size: 22px; }
.panel { margin-top: 18px; padding: 22px; }
.member-form { display: grid; grid-template-columns: minmax(190px, 1fr) 120px auto; gap: 8px; width: min(520px, 100%); }
.panel :deep(.el-table) { margin-top: 18px; }
.plan-grid { margin-top: 18px; }
.plan-card { display: grid; gap: 10px; padding: 20px; }
.plan-card h3, .plan-card p { margin: 0; }
.plan-card p { min-height: 40px; color: #a8a9af; }
.plan-card strong { font-size: 22px; color: #fbbf24; }
@media (max-width: 820px) {
  .overview-grid, .plan-grid { grid-template-columns: 1fr; }
  .page-heading, .panel-heading { flex-direction: column; }
  .member-form { grid-template-columns: 1fr; }
}
</style>
