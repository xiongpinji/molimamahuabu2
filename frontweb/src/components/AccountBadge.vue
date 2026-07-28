<template>
  <aside v-if="visible" class="account-badge">
    <el-select
      v-model="tenantId"
      class="tenant-select"
      size="small"
      :loading="loadingTenants"
      aria-label="当前工作区"
      @change="switchTenant"
    >
      <el-option
        v-for="tenant in tenants"
        :key="tenant.id"
        :label="tenant.name"
        :value="tenant.id"
      />
    </el-select>
    <div v-if="accountError" class="load-error" :title="accountError">余额加载失败</div>
    <div v-else>
      <span class="label">可用积分</span>
      <strong>{{ account.available }}</strong>
    </div>
    <div v-if="account.held" class="held">冻结 {{ account.held }}</div>
    <router-link class="manage-link" :to="{ name: 'tenant-console', query: { section: 'redeem' } }">兑换积分</router-link>
    <router-link v-if="canManageAccounts" class="manage-link" to="/account-admin">账号</router-link>
    <router-link v-if="canManageBilling" class="manage-link" to="/billing-admin">计费</router-link>
    <button type="button" @click="passwordDialog = true">改密</button>
    <button type="button" @click="logout">退出</button>
  </aside>

  <el-dialog v-model="passwordDialog" title="修改密码" width="420px" append-to-body>
    <el-form label-position="top" @submit.prevent="submitPasswordChange">
      <el-form-item label="当前密码">
        <el-input v-model="passwordForm.current" type="password" autocomplete="current-password" show-password />
      </el-form-item>
      <el-form-item label="新密码">
        <el-input v-model="passwordForm.next" type="password" autocomplete="new-password" show-password placeholder="至少 12 个字符" />
      </el-form-item>
      <el-form-item label="确认新密码">
        <el-input v-model="passwordForm.confirm" type="password" autocomplete="new-password" show-password />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="passwordDialog = false">取消</el-button>
      <el-button type="primary" :loading="passwordLoading" @click="submitPasswordChange">保存并重新登录</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { changePassword, getCreditAccount, logout as logoutApi } from '@/api/auth'
import { listTenants } from '@/api/tenants'
import {
  clearSession,
  readCurrentTenantId,
  readSession,
  saveCurrentTenantId,
} from '@/utils/authSession'
import { normalizeCreditAccount } from '@/utils/billingDisplay'
import { ACCOUNT_PERMISSIONS, BILLING_PERMISSIONS, canPlatformAccount } from '@/utils/platformRbac'

const route = useRoute()
const router = useRouter()
const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const account = ref(normalizeCreditAccount())
const accountError = ref('')
const tenants = ref([])
const tenantId = ref('')
const loadingTenants = ref(false)
const passwordDialog = ref(false)
const passwordLoading = ref(false)
const passwordForm = ref({ current: '', next: '', confirm: '' })
const visible = computed(() => publicMode && route.name !== 'login' && !!readSession()?.token)
const canManageAccounts = computed(() => {
  const role = readSession()?.user?.role
  return canPlatformAccount(role, ACCOUNT_PERMISSIONS.READ)
})
const canManageBilling = computed(() => canPlatformAccount(
  readSession()?.user?.role,
  BILLING_PERMISSIONS.REDEEM_CODES_MANAGE,
))

async function loadAccount() {
  accountError.value = ''
  try {
    account.value = normalizeCreditAccount(await getCreditAccount())
  } catch (error) {
    accountError.value = error?.message || '余额加载失败'
  }
}

onMounted(async () => {
  if (!visible.value) return
  loadingTenants.value = true
  try {
    tenants.value = await listTenants()
    const savedId = readCurrentTenantId()
    tenantId.value = tenants.value.some((tenant) => tenant.id === savedId)
      ? savedId
      : tenants.value[0]?.id || ''
    if (tenantId.value) saveCurrentTenantId(tenantId.value)
    await loadAccount()
  } finally {
    loadingTenants.value = false
  }
})

function switchTenant(value) {
  saveCurrentTenantId(value)
  window.location.reload()
}

async function submitPasswordChange() {
  if (!passwordForm.value.current || passwordForm.value.next.length < 12) {
    return ElMessage.warning('请输入当前密码，新密码至少需要 12 个字符')
  }
  if (passwordForm.value.next !== passwordForm.value.confirm) {
    return ElMessage.warning('两次输入的新密码不一致')
  }
  passwordLoading.value = true
  try {
    await changePassword({
      current_password: passwordForm.value.current,
      new_password: passwordForm.value.next,
    })
    clearSession()
    passwordDialog.value = false
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
</script>

<style scoped>
.account-badge { position: fixed; z-index: 3000; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 36px); padding: 10px 12px 10px 15px; border: 1px solid rgba(255,255,255,.1); border-radius: 15px; color: #fff; background: rgba(27, 27, 30, .92); box-shadow: 0 10px 30px rgba(0,0,0,.24); backdrop-filter: blur(12px); }
.account-badge div { display: flex; align-items: baseline; gap: 7px; }
.label, .held { color: #b9b9bd; font-size: 12px; }
.load-error { color: #fca5a5; font-size: 12px; }
.account-badge strong { color: #ffd36a; font-size: 18px; }
.account-badge button { padding: 5px 8px; border: 0; color: #ccc; background: transparent; cursor: pointer; }
.tenant-select { width: 156px; }
.manage-link { color: #ff9a73; font-size: 13px; text-decoration: none; }
.manage-link:hover { color: #ffc0a6; }
@media (max-width: 680px) {
  .account-badge { left: 10px; right: 10px; bottom: 10px; overflow-x: auto; }
  .tenant-select { min-width: 132px; }
}
</style>
