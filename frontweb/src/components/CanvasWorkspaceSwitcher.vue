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
        <el-dropdown-item :command="homeTo">
          <el-icon><List /></el-icon>
          项目列表
        </el-dropdown-item>
        <el-dropdown-item command="/canvas">
          <el-icon><Grid /></el-icon>
          首页自由画布
        </el-dropdown-item>
        <el-dropdown-item command="/free-create">
          <el-icon><MagicStick /></el-icon>
          自由创作
        </el-dropdown-item>
        <el-dropdown-item command="/media-library">
          <el-icon><Files /></el-icon>
          媒体素材库
        </el-dropdown-item>
        <el-dropdown-item command="/ai-config">
          <el-icon><Setting /></el-icon>
          AI 配置
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { ArrowDown, Files, Grid, List, MagicStick, Setting } from '@element-plus/icons-vue'

const router = useRouter()

const props = defineProps({
  homeTo: { type: [String, Object], default: '/' }
})

const homeTo = props.homeTo

function navigate(path) {
  router.push(path)
}
</script>

<style scoped>
.canvas-workspace-switcher {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 156px;
  min-height: 44px;
  padding: 2px 8px 2px 2px;
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
  background: rgba(63, 63, 70, .62);
}

.canvas-workspace-switcher:focus-visible {
  box-shadow: 0 0 0 2px rgba(167, 139, 250, .72);
}

.canvas-workspace-switcher:active {
  transform: translateY(1px);
}

.canvas-workspace-switcher__logo {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border-radius: 11px;
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
  font-size: 15px;
  font-weight: 700;
  line-height: 1.1;
  white-space: nowrap;
}

.canvas-workspace-switcher__subtitle {
  color: #a1a1aa;
  font-size: 10px;
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
  background: #f4f4f5;
}

:global(html.light) .canvas-workspace-switcher__name {
  color: #18181b;
}

:global(html.light) .canvas-workspace-switcher__subtitle,
:global(html.light) .canvas-workspace-switcher__chevron {
  color: #71717a;
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
