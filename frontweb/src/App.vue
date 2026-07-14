<template>
  <div class="app">
    <router-view />
    <AccountBadge />
  </div>
</template>

<script setup lang="ts">
import AccountBadge from '@/components/AccountBadge.vue'
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
</style>
