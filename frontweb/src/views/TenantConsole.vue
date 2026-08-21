<template>
  <AdminWorkspaceShell
    title="工作区与积分"
    eyebrow="团队与用量"
    description="切换团队空间、管理成员、支付宝充值或兑换积分，并核对当前工作区的积分流水。"
  >
    <template v-if="publicMode" #actions>
      <el-button type="primary" @click="showCreate = true">新建工作区</el-button>
    </template>

    <section v-if="!publicMode" class="mode-panel">
      <el-alert
        title="租户控制台仅在公开平台模式启用"
        description="本地单用户模式继续使用原有数据和配置。"
        type="info"
        :closable="false"
      />
    </section>

    <section v-else v-loading="loading" class="tenant-content">
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
          <span>积分获取</span>
          <strong>支付宝 / 兑换码</strong>
          <small>充值成功或兑换后，积分立即进入当前工作区</small>
          <el-button type="primary" @click="router.push({ name: 'recharge-center' })">
            前往充值中心
          </el-button>
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
              <el-option v-if="currentTenant.role === 'owner'" label="管理员" value="admin" />
              <el-option v-if="currentTenant.role === 'owner'" label="所有者" value="owner" />
            </el-select>
            <el-button type="primary" :loading="addingMember" @click="addMember">添加</el-button>
          </div>
        </div>

        <el-table :data="members" empty-text="暂无成员">
          <el-table-column prop="email" label="邮箱" min-width="220" />
          <el-table-column label="角色" width="120">
            <template #default="{ row }">
              <el-select
                v-if="canChangeMemberRole(row)"
                :model-value="row.role"
                :loading="memberRoleSaving === row.user_id"
                @change="changeMemberRole(row, $event)"
              >
                <el-option label="成员" value="member" />
                <el-option v-if="currentTenant.role === 'owner'" label="管理员" value="admin" />
                <el-option v-if="currentTenant.role === 'owner'" label="所有者" value="owner" />
              </el-select>
              <span v-else>{{ roleLabel(row.role) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="100" />
          <el-table-column label="操作" width="100" align="right">
            <template #default="{ row }">
              <el-button
                v-if="canRemoveMember(row)"
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

      <section id="redeem-credits" ref="redeemSection" class="panel redeem-panel">
        <div class="panel-heading">
          <div>
            <h2>兑换码</h2>
            <p>兑换积分只进入当前工作区；同一工作区不能重复使用同一兑换码。</p>
          </div>
          <div class="redeem-form">
            <el-input v-model.trim="redeemCode" placeholder="MOLI-XXXX-XXXX-XXXX" />
            <el-button type="primary" :loading="redeeming" @click="redeem">立即兑换</el-button>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>积分消耗明细</h2>
            <p>展示已经完成的模型调用、消耗积分和对应生成资源。</p>
          </div>
        </div>
        <el-table :data="consumptionTransactions" empty-text="暂无积分消耗记录">
          <el-table-column prop="amount" label="积分变动" width="120" />
          <el-table-column prop="balanceAfter" label="剩余积分" width="120" />
          <el-table-column prop="model" label="模型" min-width="180" />
          <el-table-column prop="resource_type" label="资源类型" width="120" />
          <el-table-column prop="reason" label="原因" min-width="220" />
          <el-table-column label="时间" min-width="180">
            <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
          </el-table-column>
        </el-table>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>积分兑换记录</h2>
            <p>展示当前工作区通过兑换码获得积分的历史记录。</p>
          </div>
        </div>
        <el-table :data="redemptionTransactions" empty-text="暂无积分兑换记录">
          <el-table-column prop="amount" label="兑换积分" width="120" />
          <el-table-column prop="balanceAfter" label="剩余积分" width="120" />
          <el-table-column prop="reason" label="兑换说明" min-width="260" />
          <el-table-column label="时间" min-width="180">
            <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
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
  </AdminWorkspaceShell>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import AdminWorkspaceShell from '@/components/AdminWorkspaceShell.vue'
import { getCreditAccount } from '@/api/auth'
import {
  addTenantMember,
  changeTenantMemberRole,
  createTenant,
  listTenantMembers,
  listTenants,
  removeTenantMember,
} from '@/api/tenants'
import {
  listCreditTransactions,
  redeemCredits,
} from '@/api/billing'
import {
  readCurrentTenantId,
  readSession,
  saveCurrentTenantId,
} from '@/utils/authSession'
import { normalizeCreditAccount } from '@/utils/billingDisplay'

const route = useRoute()
const router = useRouter()
const redeemSection = ref(null)
const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const loading = ref(false)
const tenants = ref([])
const tenantId = ref('')
const account = ref(normalizeCreditAccount())
const members = ref([])
const transactions = ref([])
const redeemCode = ref('')
const redeeming = ref(false)
const showCreate = ref(false)
const creatingWorkspace = ref(false)
const addingMember = ref(false)
const memberRoleSaving = ref('')
const workspaceForm = reactive({ name: '', slug: '' })
const memberForm = reactive({ email: '', role: 'member' })
const sessionUserId = readSession()?.user?.id || ''

const currentTenant = computed(() => tenants.value.find((tenant) => tenant.id === tenantId.value) || null)
const isManager = computed(() => ['owner', 'admin'].includes(currentTenant.value?.role))
const transactionsWithBalance = computed(() => {
  let runningBalance = Number(account.value.available || 0)
  return transactions.value.map((item) => {
    const explicitBalance = Number(
      item.balance_after ?? item.remaining_balance ?? item.available_after
    )
    const balanceAfter = Number.isFinite(explicitBalance) ? explicitBalance : runningBalance
    runningBalance = balanceAfter - Number(item.amount || 0)
    return { ...item, balanceAfter }
  })
})
const consumptionTransactions = computed(() => transactionsWithBalance.value.filter(
  (item) => item.event_type === 'confirm',
))
const redemptionTransactions = computed(() => transactionsWithBalance.value.filter(
  (item) => item.event_type === 'redeem',
))
function canChangeMemberRole(row) {
  return Boolean(row && row.user_id !== sessionUserId && currentTenant.value?.role === 'owner')
}

function canRemoveMember(row) {
  if (!row || row.user_id === sessionUserId) return false
  return currentTenant.value?.role === 'owner'
    || (currentTenant.value?.role === 'admin' && row.role === 'member')
}

function roleLabel(role) {
  return ({ owner: '所有者', admin: '管理员', member: '成员' })[role] || role || '成员'
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}

async function loadTenantData() {
  if (!tenantId.value) return
  const [credit, creditTransactions] = await Promise.all([
    getCreditAccount(),
    listCreditTransactions(),
  ])
  account.value = normalizeCreditAccount(credit)
  transactions.value = creditTransactions
  if (isManager.value) {
    members.value = await listTenantMembers(tenantId.value)
  } else {
    members.value = []
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
  if (currentTenant.value?.role !== 'owner') memberForm.role = 'member'
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

async function changeMemberRole(row, role) {
  memberRoleSaving.value = row.user_id
  try {
    Object.assign(row, await changeTenantMemberRole(tenantId.value, row.user_id, role))
    ElMessage.success('成员角色已更新')
  } finally {
    memberRoleSaving.value = ''
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

async function redeem() {
  if (!redeemCode.value) return ElMessage.warning('请输入兑换码')
  redeeming.value = true
  try {
    const result = await redeemCredits(redeemCode.value)
    account.value = normalizeCreditAccount(result.account)
    transactions.value = await listCreditTransactions()
    redeemCode.value = ''
    ElMessage.success(`兑换成功，已增加 ${result.credits} 积分`)
  } finally {
    redeeming.value = false
  }
}

onMounted(async () => {
  await load()
  if (route.query.section === 'redeem') {
    await nextTick()
    redeemSection.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})
</script>

<style scoped>
.mode-panel,
.info-card,
.panel {
  border: 1px solid #292929;
  border-radius: 18px;
  background: rgba(18, 18, 18, .96);
  box-shadow: 0 20px 58px rgba(0, 0, 0, .22);
}
.mode-panel { padding: 22px; }
.panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.panel h2 { margin: 0 0 8px; }
.panel-heading p { margin: 0; color: #929292; }
.workspace-strip { display: flex; gap: 12px; margin: 0 0 18px; overflow-x: auto; padding-bottom: 4px; }
.workspace-card { min-width: 210px; padding: 15px; border: 1px solid #292929; border-radius: 14px; color: #e4e4e7; background: #141414; text-align: left; cursor: pointer; }
.workspace-card strong, .workspace-card span { display: block; }
.workspace-card span { margin-top: 6px; color: #92939a; font-size: 12px; }
.workspace-card:hover,
.workspace-card:focus-visible { outline: none; border-color: #65402f; }
.workspace-card:focus-visible { box-shadow: 0 0 0 2px rgba(255, 113, 57, .48); }
.workspace-card.active { border-color: #ff7139; box-shadow: 0 0 0 2px rgba(255, 113, 57, .14); }
.overview-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.info-card { display: grid; gap: 7px; padding: 20px; }
.info-card span, .info-card small, .plan-card span { color: #a8a9af; }
.info-card strong { font-size: 22px; }
.panel { margin-top: 18px; padding: 22px; }
.member-form { display: grid; grid-template-columns: minmax(190px, 1fr) 120px auto; gap: 8px; width: min(520px, 100%); }
.panel :deep(.el-table) { margin-top: 18px; }
.redeem-form { display: grid; grid-template-columns: minmax(240px, 1fr) auto; gap: 8px; width: min(480px, 100%); }
@media (max-width: 820px) {
  .overview-grid { grid-template-columns: 1fr; }
  .panel-heading { flex-direction: column; }
  .member-form, .redeem-form { grid-template-columns: 1fr; }
}
</style>
