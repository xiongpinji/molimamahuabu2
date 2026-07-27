<template>
  <nav class="admin-workspace-nav" aria-label="管理中心">
    <RouterLink
      v-for="item in visibleItems"
      :key="item.name"
      :to="{ name: item.name }"
      class="admin-workspace-nav__link"
      :class="{ 'is-active': route.name === item.name }"
      :aria-current="route.name === item.name ? 'page' : undefined"
    >
      <span>{{ item.label }}</span>
      <small>{{ item.description }}</small>
    </RouterLink>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { readSession } from '@/utils/authSession'
import { ACCOUNT_PERMISSIONS, BILLING_PERMISSIONS, canPlatformAccount } from '@/utils/platformRbac'

const route = useRoute()
const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const role = readSession()?.user?.role
const legacyAdminMode = !role && !publicMode

const items = [
  {
    name: 'tenant-console',
    label: '工作区与积分',
    description: '成员、兑换与流水',
    visible: role !== 'redeem_admin',
  },
  {
    name: 'account-admin',
    label: '账号与权限',
    description: '角色、状态与会话',
    visible: legacyAdminMode || canPlatformAccount(role, ACCOUNT_PERMISSIONS.READ),
  },
  {
    name: 'billing-admin',
    label: '运营与计费',
    description: '模型、兑换码与对账',
    visible: legacyAdminMode || canPlatformAccount(role, BILLING_PERMISSIONS.REDEEM_CODES_MANAGE),
  },
  {
    name: 'ai-config',
    label: '模型配置',
    description: '供应商、密钥与模型',
    visible: legacyAdminMode || role === 'admin',
  },
]

const visibleItems = computed(() => items.filter((item) => item.visible))
</script>

<style scoped>
.admin-workspace-nav {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
  margin-bottom: 34px;
  padding: 8px;
  border: 1px solid #252525;
  border-radius: 18px;
  background: rgba(15, 15, 15, .92);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .24);
}

.admin-workspace-nav__link {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid transparent;
  border-radius: 12px;
  color: #b6b6b6;
  text-decoration: none;
  transition: border-color .18s ease, color .18s ease, background-color .18s ease;
}

.admin-workspace-nav__link span {
  overflow: hidden;
  font-size: 14px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-workspace-nav__link small {
  overflow: hidden;
  color: #707070;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-workspace-nav__link:hover,
.admin-workspace-nav__link:focus-visible {
  outline: none;
  border-color: #3c302c;
  color: #fff;
  background: #191919;
}

.admin-workspace-nav__link:focus-visible {
  box-shadow: 0 0 0 2px rgba(255, 113, 57, .58);
}

.admin-workspace-nav__link.is-active {
  border-color: rgba(255, 113, 57, .46);
  color: #fff;
  background: linear-gradient(135deg, rgba(255, 113, 57, .18), rgba(255, 113, 57, .06));
}

.admin-workspace-nav__link.is-active small {
  color: #c88f77;
}

@media (max-width: 700px) {
  .admin-workspace-nav {
    grid-template-columns: 1fr;
    margin-bottom: 26px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .admin-workspace-nav__link { transition: none; }
}
</style>
