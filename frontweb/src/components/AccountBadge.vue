<template>
  <aside v-if="visible" class="account-badge">
    <div>
      <span class="label">可用积分</span>
      <strong>{{ account.available }}</strong>
    </div>
    <div v-if="account.held" class="held">冻结 {{ account.held }}</div>
    <button type="button" @click="logout">退出</button>
  </aside>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getCreditAccount } from '@/api/auth'
import { clearSession, readSession } from '@/utils/authSession'
import { normalizeCreditAccount } from '@/utils/billingDisplay'

const route = useRoute()
const router = useRouter()
const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const account = ref(normalizeCreditAccount())
const visible = computed(() => publicMode && route.name !== 'login' && !!readSession()?.token)

onMounted(async () => {
  if (!visible.value) return
  try { account.value = normalizeCreditAccount(await getCreditAccount()) } catch (_) {}
})

async function logout() {
  clearSession()
  await router.replace({ name: 'login' })
}
</script>

<style scoped>
.account-badge { position: fixed; z-index: 3000; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 15px; border: 1px solid rgba(255,255,255,.1); border-radius: 15px; color: #fff; background: rgba(27, 27, 30, .92); box-shadow: 0 10px 30px rgba(0,0,0,.24); backdrop-filter: blur(12px); }
.account-badge div { display: flex; align-items: baseline; gap: 7px; }
.label, .held { color: #b9b9bd; font-size: 12px; }
.account-badge strong { color: #ffd36a; font-size: 18px; }
.account-badge button { padding: 5px 8px; border: 0; color: #ccc; background: transparent; cursor: pointer; }
</style>
