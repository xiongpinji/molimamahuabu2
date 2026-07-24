<template>
  <main class="account-admin">
    <PlatformHeader title="账号与权限" back-to="/" back-label="返回" />
    <section class="content">
      <header>
        <div>
          <h1>账号与权限</h1>
          <p>管理平台角色、账号状态和登录会话。所有变更均由服务端鉴权并记录审计。</p>
        </div>
        <el-button :loading="loading" @click="loadUsers">刷新</el-button>
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
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PlatformHeader from '@/components/PlatformHeader.vue'
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
  { label: '管理员', value: 'admin' },
  { label: '运营', value: 'ops' },
  { label: '客服', value: 'support' },
  { label: '只读', value: 'read_only' },
]
const canRole = computed(() => canPlatformAccount(currentRole, ACCOUNT_PERMISSIONS.ROLE))
const canStatus = computed(() => canPlatformAccount(currentRole, ACCOUNT_PERMISSIONS.STATUS))
const canForceLogout = computed(() => canPlatformAccount(currentRole, ACCOUNT_PERMISSIONS.FORCE_LOGOUT))

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
.account-admin { min-height: 100vh; padding: 0 20px 56px; color: #f5f5f7; background: #111214; }
.content { width: min(1100px, 100%); margin: 24px auto 0; padding: 22px; border: 1px solid #303136; border-radius: 16px; background: #1b1c20; }
header { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
h1 { margin: 0 0 8px; }
p { margin: 0; color: #a8a9af; }
.el-alert { margin-bottom: 18px; }
@media (max-width: 680px) {
  .account-admin { padding-inline: 10px; }
  .content { padding: 14px; overflow-x: auto; }
}
</style>
