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
    <router-link class="manage-link" to="/tenant-console">管理</router-link>
    <router-link v-if="canManageAccounts" class="manage-link" to="/account-admin">账号</router-link>
    <button type="button" @click="logout">退出</button>
  </aside>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getCreditAccount } from '@/api/auth'
import { listTenants } from '@/api/tenants'
import {
  clearSession,
  readCurrentTenantId,
  readSession,
  saveCurrentTenantId,
} from '@/utils/authSession'
import { normalizeCreditAccount } from '@/utils/billingDisplay'
import { ACCOUNT_PERMISSIONS, canPlatformAccount } from '@/utils/platformRbac'

const route = useRoute()
const router = useRouter()
const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const account = ref(normalizeCreditAccount())
const accountError = ref('')
const tenants = ref([])
const tenantId = ref('')
const loadingTenants = ref(false)
const visible = computed(() => publicMode && route.name !== 'login' && !!readSession()?.token)
const canManageAccounts = computed(() => {
  const role = readSession()?.user?.role
  return canPlatformAccount(role, ACCOUNT_PERMISSIONS.READ)
})

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

async function logout() {
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
.manage-link { color: #c4b5fd; font-size: 13px; text-decoration: none; }
.manage-link:hover { color: #ddd6fe; }
@media (max-width: 680px) {
  .account-badge { left: 10px; right: 10px; bottom: 10px; overflow-x: auto; }
  .tenant-select { min-width: 132px; }
}
</style>
