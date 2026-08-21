<template>
  <nav class="platform-primary-nav" aria-label="主要功能">
    <RouterLink
      to="/"
      class="platform-primary-nav__link"
      :class="{ 'is-active': homeActive }"
      :aria-current="homeActive ? 'page' : undefined"
    >
      首页
    </RouterLink>
    <RouterLink
      to="/canvas"
      class="platform-primary-nav__link"
      :class="{ 'is-active': canvasActive }"
      :aria-current="canvasActive ? 'page' : undefined"
    >
      画布
    </RouterLink>
    <RouterLink
      to="/script-analysis"
      class="platform-primary-nav__link"
      :class="{ 'is-active': scriptAnalysisActive }"
      :aria-current="scriptAnalysisActive ? 'page' : undefined"
    >
      剧本分析
    </RouterLink>
    <RouterLink
      to="/redraw"
      class="platform-primary-nav__link"
      :class="{ 'is-active': redrawActive }"
      :aria-current="redrawActive ? 'page' : undefined"
    >
      一键转绘
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

const homeActive = computed(() => route.name === 'list')
const canvasActive = computed(() => ['canvas-projects', 'standalone-canvas', 'home-canvas-local'].includes(route.name))
const scriptAnalysisActive = computed(() => route.name === 'script-analysis')
const redrawActive = computed(() => ['redraw-projects', 'redraw-workspace'].includes(route.name))
const factoryActive = computed(() => [
  'factory',
  'drama-detail',
  'film',
  'film-canvas',
  'material-characters',
  'material-scenes',
  'material-props',
  'media-library',
  'ai-config',
  'tenant-console',
  'account-admin',
  'billing-admin',
].includes(route.name))
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
