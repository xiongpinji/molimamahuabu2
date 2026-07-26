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
  align-self: stretch;
  gap: 22px;
}

.platform-primary-nav__link {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 0 2px;
  color: #8f8f8f;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.platform-primary-nav__link:hover,
.platform-primary-nav__link:focus-visible {
  outline: none;
  color: #f4f4f5;
}

.platform-primary-nav__link:focus-visible {
  box-shadow: 0 0 0 2px rgba(255, 113, 57, .72);
}

.platform-primary-nav__link.is-active {
  color: #fff;
}

.platform-primary-nav__link.is-active::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  border-radius: 999px 999px 0 0;
  background: #ff7139;
}

:global(html.light) .platform-primary-nav {
  border-color: #272727;
  background: rgba(8, 8, 8, .75);
}

:global(html.light) .platform-primary-nav__link {
  color: #a3a3a3;
}

:global(html.light) .platform-primary-nav__link:hover,
:global(html.light) .platform-primary-nav__link:focus-visible {
  color: #ffffff;
  background: #1a1a1a;
}

:global(html.light) .platform-primary-nav__link.is-active {
  color: #ffffff;
}

@media (max-width: 720px) {
  .platform-primary-nav__link {
    padding-inline: 9px;
    font-size: 12px;
  }
}
</style>
