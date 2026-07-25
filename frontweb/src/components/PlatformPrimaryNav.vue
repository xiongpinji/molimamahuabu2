<template>
  <nav class="platform-primary-nav" aria-label="主要功能">
    <RouterLink
      to="/canvas"
      class="platform-primary-nav__link"
      :class="{ 'is-active': canvasActive }"
      :aria-current="canvasActive ? 'page' : undefined"
    >
      画布
    </RouterLink>
    <RouterLink
      to="/factory"
      class="platform-primary-nav__link"
      :class="{ 'is-active': factoryActive }"
      :aria-current="factoryActive ? 'page' : undefined"
    >
      短剧工厂
    </RouterLink>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

const route = useRoute()

const canvasActive = computed(() => ['canvas-projects', 'standalone-canvas', 'home-canvas-local'].includes(route.name))
const factoryActive = computed(() => ['list', 'factory', 'drama-detail', 'film', 'film-canvas'].includes(route.name))
</script>

<style scoped>
.platform-primary-nav {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid rgba(82, 82, 91, .65);
  border-radius: 12px;
  background: rgba(9, 9, 11, .42);
}

.platform-primary-nav__link {
  min-height: 34px;
  padding: 7px 12px;
  border-radius: 9px;
  color: #a1a1aa;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  text-decoration: none;
  white-space: nowrap;
}

.platform-primary-nav__link:hover,
.platform-primary-nav__link:focus-visible {
  outline: none;
  color: #f4f4f5;
  background: rgba(63, 63, 70, .72);
}

.platform-primary-nav__link:focus-visible {
  box-shadow: 0 0 0 2px rgba(167, 139, 250, .72);
}

.platform-primary-nav__link.is-active {
  color: #fff;
  background: rgba(124, 58, 237, .88);
}

:global(html.light) .platform-primary-nav {
  border-color: #e4e4e7;
  background: rgba(244, 244, 245, .75);
}

:global(html.light) .platform-primary-nav__link {
  color: #52525b;
}

:global(html.light) .platform-primary-nav__link:hover,
:global(html.light) .platform-primary-nav__link:focus-visible {
  color: #18181b;
  background: #e4e4e7;
}

:global(html.light) .platform-primary-nav__link.is-active {
  color: #fff;
  background: #7c3aed;
}

@media (max-width: 720px) {
  .platform-primary-nav__link {
    padding-inline: 9px;
    font-size: 12px;
  }
}
</style>
