<template>
  <header
    class="platform-header"
    :class="{ 'platform-header--account-badge': publicMode && loggedIn }"
  >
    <div class="platform-header__inner">
      <CanvasWorkspaceSwitcher :home-to="homeTo" />

      <span v-if="title" class="platform-header__separator" aria-hidden="true">›</span>
      <div v-if="title" class="platform-header__title" :title="title">{{ title }}</div>

      <PlatformPrimaryNav />

      <div class="platform-header__leading">
        <slot name="leading" />
      </div>

      <div class="platform-header__actions">
        <slot name="actions" />
        <el-button
          v-if="loggedIn"
          class="platform-header__button"
          title="支付宝充值积分"
          @click="goRecharge"
        >
          <el-icon><Coin /></el-icon>
          <span class="platform-header__button-label">充值积分</span>
        </el-button>
        <el-button
          v-if="loggedIn"
          class="platform-header__button"
          title="兑换积分"
          @click="goRedeem"
        >
          <el-icon><Ticket /></el-icon>
          <span class="platform-header__button-label">兑换积分</span>
        </el-button>
        <el-button
          v-if="showHomeCanvas"
          class="platform-header__button"
          title="打开首页自由画布"
          @click="goHomeCanvas"
        >
          <el-icon><Grid /></el-icon>
          <span class="platform-header__button-label">首页画布</span>
        </el-button>
        <el-button
          v-if="showTheme"
          class="platform-header__button platform-header__theme"
          :title="isDark ? '切换到浅色模式' : '切换到暗色模式'"
          @click="toggleTheme"
        >
          <el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon>
          <span class="platform-header__button-label">{{ isDark ? '浅色' : '暗色' }}</span>
        </el-button>
        <el-button
          v-if="backTo"
          class="platform-header__button platform-header__back"
          title="返回上一级"
          @click="goBack"
        >
          <el-icon><ArrowLeft /></el-icon>
          <span class="platform-header__button-label">{{ backLabel }}</span>
        </el-button>
        <el-dropdown
          v-if="loggedIn && !publicMode"
          class="platform-header__account"
          trigger="click"
          placement="bottom-end"
          @command="handleAccountCommand"
        >
          <el-button class="platform-header__button platform-header__account-button">
            <el-icon><UserFilled /></el-icon>
            <span class="platform-header__account-label">{{ accountLabel }}</span>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="workspace">工作区与积分</el-dropdown-item>
              <el-dropdown-item v-if="canManageBilling" command="billing">运营与计费</el-dropdown-item>
              <el-dropdown-item v-if="isAdmin" command="models">模型配置</el-dropdown-item>
              <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button
          v-else-if="!loggedIn"
          class="platform-header__button platform-header__account"
          @click="goLogin"
        >
          <el-icon><UserFilled /></el-icon>
          <span class="platform-header__button-label">登录</span>
        </el-button>
      </div>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Coin, Grid, Moon, Sunny, Ticket, UserFilled } from '@element-plus/icons-vue'
import { useTheme } from '@/composables/useTheme'
import CanvasWorkspaceSwitcher from '@/components/CanvasWorkspaceSwitcher.vue'
import PlatformPrimaryNav from '@/components/PlatformPrimaryNav.vue'
import { logout as logoutApi } from '@/api/auth'
import { clearSession, readSession } from '@/utils/authSession'
import { BILLING_PERMISSIONS, canPlatformAccount } from '@/utils/platformRbac'

const props = defineProps({
  title: { type: String, default: '' },
  backTo: { type: [String, Object], default: '' },
  backLabel: { type: String, default: '返回' },
  showTheme: { type: Boolean, default: true },
  showHomeCanvas: { type: Boolean, default: false },
  homeTo: { type: [String, Object], default: '/' }
})

const router = useRouter()
const route = useRoute()
const { isDark, toggle: toggleTheme } = useTheme()
const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const session = computed(() => {
  void route.fullPath
  return readSession()
})
const loggedIn = computed(() => Boolean(session.value?.token))
const accountLabel = computed(() => session.value?.user?.email || '账号')
const isAdmin = computed(() => session.value?.user?.role === 'admin')
const canManageBilling = computed(() => canPlatformAccount(
  session.value?.user?.role,
  BILLING_PERMISSIONS.REDEEM_CODES_MANAGE,
))

function goBack() {
  router.push(props.backTo)
}

function goHomeCanvas() {
  router.push({ name: 'home-canvas-local' })
}

function goRedeem() {
  router.push({ name: 'tenant-console', query: { section: 'redeem' } })
}

function goRecharge() {
  router.push({ name: 'recharge-center' })
}

function goLogin() {
  router.push({
    name: 'login',
    query: route.fullPath === '/' ? undefined : { redirect: route.fullPath },
  })
}

async function handleAccountCommand(command) {
  if (command === 'workspace') return router.push({ name: 'tenant-console' })
  if (command === 'billing') return router.push({ name: 'billing-admin' })
  if (command === 'models') return router.push({ name: 'ai-config' })
  if (command === 'logout') {
    await logoutApi().catch(() => undefined)
    clearSession()
    await router.replace({ name: 'login' })
  }
}
</script>

<style scoped>
.platform-header {
  position: sticky;
  top: 0;
  z-index: 220;
  border-bottom: 1px solid rgba(255, 255, 255, .07);
  background: rgba(8, 8, 8, .88);
  backdrop-filter: blur(18px);
}

.platform-header__inner {
  display: flex;
  align-items: center;
  gap: 18px;
  min-height: 64px;
  box-sizing: border-box;
  min-width: 0;
  max-width: 1600px;
  margin: 0 auto;
  padding: 0 28px;
}

.platform-header__separator {
  color: #71717a;
  font-size: 22px;
  line-height: 1;
}

.platform-header__title {
  min-width: 0;
  max-width: min(30vw, 420px);
  overflow: hidden;
  color: #f5f5f5;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.platform-header__leading {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1 1 auto;
  gap: 8px;
}

.platform-header__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  margin-left: auto;
  flex: 0 0 auto;
  flex-wrap: nowrap;
}

.platform-header--account-badge .platform-header__actions {
  margin-right: clamp(0px, calc(1040px - 50vw), 240px);
}

.platform-header__button {
  min-height: 38px;
  border-color: rgba(255, 255, 255, .09) !important;
  border-radius: 10px !important;
  color: #e4e4e7 !important;
  background: #151515 !important;
  transition: background-color .18s ease, border-color .18s ease, transform .18s ease;
}

.platform-header__button:hover,
.platform-header__button:focus-visible {
  border-color: rgba(255, 113, 57, .72) !important;
  color: #fff !important;
  background: #1c1c1c !important;
}

.platform-header__button:active {
  transform: translateY(1px);
}

.platform-header__back {
  border-color: rgba(255, 113, 57, .36) !important;
}

.platform-header__account-button {
  max-width: 230px;
}

.platform-header__account-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(html.light) .platform-header__inner {
  border-color: #272727;
  background: rgba(8, 8, 8, .92);
  box-shadow: 0 12px 28px rgba(0, 0, 0, .34);
}

:global(html.light) .platform-header__title {
  color: #f5f5f5;
}

:global(html.light) .platform-header__separator {
  color: #707070;
}

:global(html.light) .platform-header__button {
  border-color: #2b2b2b !important;
  color: #d4d4d4 !important;
  background: #121212 !important;
}

:global(html.light) .platform-header__button:hover,
:global(html.light) .platform-header__button:focus-visible {
  border-color: #ff7139 !important;
  color: #ffffff !important;
  background: #1d1d1d !important;
}

@media (max-width: 1280px) {
  .platform-header__button-label { display: none; }
  .platform-header__button { width: 40px; padding: 0 !important; }
}

@media (max-width: 860px) {
  .platform-header--account-badge { min-height: 124px; }
  .platform-header--account-badge .platform-header__actions { margin-right: 0; }
  .platform-header__inner {
    max-width: 100%;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
  }
  .platform-header__separator,
  .platform-header__button-label { display: none; }
  .platform-header__account-label { display: none; }
  .platform-header__title {
    flex: 1 1 120px;
    max-width: none;
  }
  .platform-header__actions {
    flex: 0 0 auto;
    margin-left: 0;
  }
  :deep(.platform-primary-nav) {
    order: 10;
    max-width: 100%;
    min-width: 0;
    flex: 1 1 100%;
    overflow-x: auto;
  }
  .platform-header__button { width: 40px; padding: 0 !important; }
}

@media (prefers-reduced-motion: reduce) {
  .platform-header__button { transition: none; }
}
</style>
