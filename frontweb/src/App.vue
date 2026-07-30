<template>
  <div class="app">
    <router-view />
    <AccountBadge v-if="!personalCenterOpen && route.name !== 'personal-center'" @open="personalCenterOpen = true" />
    <el-dialog
      v-model="personalCenterOpen"
      class="personal-center-dialog"
      modal-class="personal-center-backdrop"
      title="个人中心"
      width="min(1180px, calc(100vw - 40px))"
      top="4vh"
      append-to-body
      destroy-on-close
      :show-close="false"
    >
      <PersonalCenter embedded @close="personalCenterOpen = false" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import { useRoute } from 'vue-router'
import AccountBadge from '@/components/AccountBadge.vue'

const PersonalCenter = defineAsyncComponent(() => import('@/views/personal-center.vue'))
const route = useRoute()
const personalCenterOpen = ref(false)
</script>

<style>
* {
  box-sizing: border-box;
}
html, body, #app, .app {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background: var(--bg-page);
  color: var(--text-primary);
  transition: background 0.25s, color 0.25s;
}
.personal-center-backdrop {
  background: rgba(4, 4, 6, .76);
  backdrop-filter: blur(10px);
}
.personal-center-dialog.el-dialog {
  height: 92vh;
  max-height: 860px;
  margin-bottom: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.11) !important;
  border-radius: 24px !important;
  background: #111113 !important;
  box-shadow: 0 30px 90px rgba(0,0,0,.56) !important;
}
.personal-center-dialog .el-dialog__header {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
.personal-center-dialog .el-dialog__body {
  height: 100%;
  padding: 0;
}
@media (max-width: 760px) {
  .personal-center-dialog.el-dialog {
    width: 100vw !important;
    height: 100vh;
    max-height: none;
    margin: 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
  }
}
</style>
