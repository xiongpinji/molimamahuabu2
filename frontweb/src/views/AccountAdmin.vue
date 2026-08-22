<template>
  <AdminWorkspaceShell
    title="账号与权限"
    eyebrow="平台治理"
    description="管理平台角色、账号状态和登录会话。所有变更均由服务端鉴权并记录审计。"
  >
    <template #actions>
      <el-button :loading="loading" @click="loadUsers">刷新账号</el-button>
    </template>

    <section class="account-summary" aria-label="账号概览">
      <article>
        <span>账号总数</span>
        <strong>{{ users.length }}</strong>
      </article>
      <article>
        <span>正常使用</span>
        <strong>{{ activeUserCount }}</strong>
      </article>
      <article>
        <span>已暂停</span>
        <strong>{{ disabledUserCount }}</strong>
      </article>
    </section>

    <section class="account-panel" aria-labelledby="account-list-title">
      <header class="panel-heading">
        <div>
          <h2 id="account-list-title">平台账号</h2>
          <p>角色与状态变更会立即影响后续登录和现有会话。</p>
        </div>
      </header>

      <el-alert
        v-if="!canRole && !canStatus && !canForceLogout"
        title="当前角色只有查看权限"
        type="info"
        :closable="false"
      />

      <el-table v-loading="loading" :data="users" empty-text="暂无账号">
        <el-table-column prop="email" label="邮箱" min-width="220" />
        <el-table-column label="角色" min-width="160">
          <template #default="{ row }">
            <el-select
              :model-value="row.role"
              :disabled="!canRole || saving === row.id"
              @change="changeRole(row, $event)"
            >
              <el-option v-for="role in roles" :key="role.value" :label="role.label" :value="role.value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'danger'">
              {{ row.status === 'active' ? '启用' : '已暂停' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="tenant_count" label="工作区" width="90" />
        <el-table-column label="操作" min-width="210" align="right">
          <template #default="{ row }">
            <el-button
              v-if="canStatus"
              :disabled="row.id === currentUserId"
              :loading="saving === row.id"
              @click="toggleStatus(row)"
            >
              {{ row.status === 'active' ? '暂停账号' : '恢复账号' }}
            </el-button>
            <el-button
              v-if="canForceLogout"
              :loading="saving === row.id"
              @click="forceLogout(row)"
            >
              强制退出
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </AdminWorkspaceShell>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import AdminWorkspaceShell from '@/components/AdminWorkspaceShell.vue'
import {
  changePlatformAccountRole,
  changePlatformAccountStatus,
  forcePlatformAccountLogout,
  listPlatformAccounts,
} from '@/api/platformAccounts'
import { readSession } from '@/utils/authSession'
import { ACCOUNT_PERMISSIONS, canPlatformAccount } from '@/utils/platformRbac'

const session = readSession()
const currentUserId = session?.user?.id
const currentRole = session?.user?.role
const users = ref([])
const loading = ref(false)
const saving = ref('')
const roles = [
  { label: '普通用户', value: 'user' },
  { label: '总管理员', value: 'admin' },
  { label: '兑换码管理员', value: 'redeem_admin' },
  { label: '运营', value: 'ops' },
  { label: '客服', value: 'support' },
  { label: '只读', value: 'read_only' },
]
const canRole = computed(() => canPlatformAccount(currentRole, ACCOUNT_PERMISSIONS.ROLE))
const canStatus = computed(() => canPlatformAccount(currentRole, ACCOUNT_PERMISSIONS.STATUS))
const canForceLogout = computed(() => canPlatformAccount(currentRole, ACCOUNT_PERMISSIONS.FORCE_LOGOUT))
const activeUserCount = computed(() => users.value.filter((user) => user.status === 'active').length)
const disabledUserCount = computed(() => users.value.filter((user) => user.status !== 'active').length)

async function loadUsers() {
  loading.value = true
  try {
    users.value = await listPlatformAccounts()
  } finally {
    loading.value = false
  }
}

async function changeRole(row, role) {
  saving.value = row.id
  try {
    Object.assign(row, await changePlatformAccountRole(row.id, role))
    ElMessage.success('角色已更新，原登录会话已失效')
  } finally {
    saving.value = ''
  }
}

async function toggleStatus(row) {
  const status = row.status === 'active' ? 'disabled' : 'active'
  await ElMessageBox.confirm(
    status === 'disabled' ? `确认暂停 ${row.email}？` : `确认恢复 ${row.email}？`,
    '账号状态变更',
    { type: 'warning' },
  )
  saving.value = row.id
  try {
    Object.assign(row, await changePlatformAccountStatus(row.id, status))
    ElMessage.success(status === 'disabled' ? '账号已暂停' : '账号已恢复，请重新登录')
  } finally {
    saving.value = ''
  }
}

async function forceLogout(row) {
  await ElMessageBox.confirm(`确认强制退出 ${row.email} 的全部现有登录？`, '强制退出', { type: 'warning' })
  saving.value = row.id
  try {
    Object.assign(row, await forcePlatformAccountLogout(row.id))
    ElMessage.success('现有登录已全部失效')
  } finally {
    saving.value = ''
  }
}

onMounted(loadUsers)
</script>

<style scoped>
.account-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.account-summary article,
.account-panel {
  border: 1px solid #292929;
  border-radius: 18px;
  background: rgba(18, 18, 18, .96);
  box-shadow: 0 20px 58px rgba(0, 0, 0, .22);
}
.account-summary article { display: grid; gap: 7px; padding: 18px 20px; }
.account-summary span { color: #858585; font-size: 12px; }
.account-summary strong { font-size: 24px; }
.account-panel { padding: 22px; overflow: hidden; }
.panel-heading { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.panel-heading h2 { margin: 0 0 7px; font-size: 18px; }
.panel-heading p { margin: 0; color: #8f8f8f; font-size: 13px; }
.el-alert { margin-bottom: 18px; }
@media (max-width: 680px) {
  .account-summary { grid-template-columns: 1fr; }
  .account-panel { padding: 14px; overflow-x: auto; }
}
</style>
