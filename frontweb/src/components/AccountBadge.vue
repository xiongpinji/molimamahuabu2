<template>
  <aside v-if="visible" class="account-badge" :class="{ 'account-badge--canvas': isCanvasRoute }">
    <div v-if="accountError" class="load-error" :title="accountError">余额加载失败</div>
    <div v-else>
      <span class="label">可用积分</span>
      <strong>{{ account.available }}</strong>
    </div>
    <div v-if="account.held" class="held">冻结 {{ account.held }}</div>
    <button class="profile-link" type="button" aria-label="个人中心" @click="emit('open')">
      <span class="profile-avatar">{{ accountInitial }}</span>
      <span>个人中心</span>
    </button>
  </aside>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { getCreditAccount } from '@/api/auth'
import { readSession } from '@/utils/authSession'
import { normalizeCreditAccount } from '@/utils/billingDisplay'

const emit = defineEmits(['open'])
const route = useRoute()
const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const account = ref(normalizeCreditAccount())
const accountError = ref('')
const visible = computed(() => publicMode && route.name !== 'login' && !!readSession()?.token)
const isCanvasRoute = computed(() => [
  'film-canvas',
  'home-canvas-local',
  'standalone-canvas',
].includes(String(route.name || '')))
const accountInitial = computed(() => String(readSession()?.user?.email || '茉').slice(0, 1).toUpperCase())

async function loadAccount() {
  accountError.value = ''
  try {
    account.value = normalizeCreditAccount(await getCreditAccount())
  } catch (error) {
    accountError.value = error?.message || '余额加载失败'
  }
}

function handleCreditAccountRefresh() {
  if (visible.value) void loadAccount()
}

onMounted(async () => {
  window.addEventListener('moli:credit-account-refresh', handleCreditAccountRefresh)
  if (!visible.value) return
  await loadAccount()
})

onBeforeUnmount(() => {
  window.removeEventListener('moli:credit-account-refresh', handleCreditAccountRefresh)
})

</script>

<style scoped>
.account-badge { position: fixed; z-index: 3000; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 36px); padding: 10px 12px 10px 15px; border: 1px solid rgba(255,255,255,.1); border-radius: 15px; color: #fff; background: rgba(27, 27, 30, .92); box-shadow: 0 10px 30px rgba(0,0,0,.24); backdrop-filter: blur(12px); }
.account-badge--canvas { top: 12px; right: 230px; bottom: auto; padding: 6px 10px; border-radius: 12px; }
.account-badge div { display: flex; align-items: baseline; gap: 7px; }
.label, .held { color: #b9b9bd; font-size: 12px; }
.load-error { color: #fca5a5; font-size: 12px; }
.account-badge strong { color: #ffd36a; font-size: 18px; }
.profile-link { display: inline-flex; align-items: center; gap: 7px; padding: 0; border: 0; color: #fff; background: transparent; font: inherit; font-size: 13px; cursor: pointer; }
.profile-link:focus-visible { outline: 2px solid #ff9a73; outline-offset: 3px; border-radius: 8px; }
.profile-avatar { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid rgba(255,255,255,.16); border-radius: 50%; color: #161616; background: linear-gradient(135deg, #ffd36a, #ff8f70); font-weight: 800; }
@media (max-width: 680px) {
  .account-badge { left: 10px; right: 10px; bottom: 10px; overflow-x: auto; }
  .account-badge--canvas { top: 68px; bottom: auto; }
}
</style>
