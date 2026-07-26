<template>
  <el-dropdown trigger="click" placement="bottom-start" @command="navigate">
    <button
      type="button"
      class="canvas-workspace-switcher"
      aria-label="打开工作区菜单"
      aria-haspopup="menu"
    >
      <img class="canvas-workspace-switcher__logo" src="/moli-mama-logo.png" alt="茉莉妈妈" />
      <span class="canvas-workspace-switcher__copy">
        <span class="canvas-workspace-switcher__name">茉莉妈妈</span>
        <span class="canvas-workspace-switcher__subtitle">短剧制作平台</span>
      </span>
      <el-icon class="canvas-workspace-switcher__chevron"><ArrowDown /></el-icon>
    </button>

    <template #dropdown>
      <el-dropdown-menu class="canvas-workspace-menu">
        <el-dropdown-item command="/factory">
          <el-icon><List /></el-icon>
          短剧工厂
          <span v-if="isActive('list')" class="canvas-workspace-menu__current" aria-label="当前页面">当前</span>
        </el-dropdown-item>
        <el-dropdown-item command="/canvas">
          <el-icon><Grid /></el-icon>
          画布项目
          <span v-if="isActive('canvas')" class="canvas-workspace-menu__current" aria-label="当前页面">当前</span>
        </el-dropdown-item>
        <el-dropdown-item command="/canvas/local">
          <el-icon><Grid /></el-icon>
          本地临时画布
          <span v-if="isActive('local-canvas')" class="canvas-workspace-menu__current" aria-label="当前页面">当前</span>
        </el-dropdown-item>
        <el-dropdown-item command="/free-create">
          <el-icon><MagicStick /></el-icon>
          自由创作
          <span v-if="isActive('free-create')" class="canvas-workspace-menu__current" aria-label="当前页面">当前</span>
        </el-dropdown-item>
        <el-dropdown-item command="/media-library">
          <el-icon><Files /></el-icon>
          媒体素材库
          <span v-if="isActive('media-library')" class="canvas-workspace-menu__current" aria-label="当前页面">当前</span>
        </el-dropdown-item>
        <el-dropdown-item command="/ai-config">
          <el-icon><Setting /></el-icon>
          AI 配置
          <span v-if="isActive('ai-config')" class="canvas-workspace-menu__current" aria-label="当前页面">当前</span>
        </el-dropdown-item>
        <el-dropdown-item command="/film/new" divided>
          <el-icon><Plus /></el-icon>
          开始创作
          <span v-if="isActive('create')" class="canvas-workspace-menu__current" aria-label="当前页面">当前</span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowDown, Files, Grid, List, MagicStick, Plus, Setting } from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()

defineProps({
  homeTo: { type: [String, Object], default: '/' }
})

const routeName = computed(() => route.name)

function isActive(target) {
  const name = routeName.value
  if (target === 'list') {
    return ['list', 'factory', 'drama-detail', 'film-canvas'].includes(name)
      || (name === 'film' && String(route.params.id) !== 'new')
  }
  if (target === 'canvas') return ['canvas-projects', 'standalone-canvas'].includes(name)
  if (target === 'local-canvas') return name === 'home-canvas-local'
  if (target === 'create') return name === 'film' && String(route.params.id) === 'new'
  return name === target
}

function navigate(path) {
  router.push(path)
}
</script>

<style scoped>
.canvas-workspace-switcher {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 146px;
  min-height: 42px;
  padding: 3px 8px 3px 3px;
  border: 0;
  border-radius: 12px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background-color .18s ease, transform .18s ease;
}

.canvas-workspace-switcher:hover,
.canvas-workspace-switcher:focus-visible {
  outline: none;
  background: rgba(255, 255, 255, .055);
}

.canvas-workspace-switcher:focus-visible {
  box-shadow: 0 0 0 2px rgba(255, 113, 57, .72);
}

.canvas-workspace-switcher:active {
  transform: translateY(1px);
}

:global(.canvas-workspace-menu__current) {
  margin-left: auto;
  color: #ff8757;
  font-size: 11px;
}

.canvas-workspace-switcher__logo {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border-radius: 10px;
  object-fit: cover;
}

.canvas-workspace-switcher__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.canvas-workspace-switcher__name {
  color: #f4f4f5;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.1;
  white-space: nowrap;
}

.canvas-workspace-switcher__subtitle {
  color: #737373;
  font-size: 9px;
  line-height: 1.1;
  white-space: nowrap;
}

.canvas-workspace-switcher__chevron {
  margin-left: auto;
  color: #a1a1aa;
  font-size: 14px;
}

:global(html.light) .canvas-workspace-switcher:hover,
:global(html.light) .canvas-workspace-switcher:focus-visible {
  background: #1a1a1a;
}

:global(html.light) .canvas-workspace-switcher__name {
  color: #f5f5f5;
}

:global(html.light) .canvas-workspace-switcher__subtitle,
:global(html.light) .canvas-workspace-switcher__chevron {
  color: #8c8c8c;
}

@media (max-width: 680px) {
  .canvas-workspace-switcher {
    min-width: 44px;
    width: 44px;
    padding: 2px;
  }

  .canvas-workspace-switcher__copy,
  .canvas-workspace-switcher__chevron {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .canvas-workspace-switcher { transition: none; }
}
</style>
