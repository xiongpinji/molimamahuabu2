<template>
  <header class="platform-header">
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
          v-if="showHomeCanvas"
          class="platform-header__button"
          title="打开首页自由画布"
          @click="goHomeCanvas"
        >
          <el-icon><Grid /></el-icon>
          <span class="platform-header__button-label">首页画布</span>
        </el-button>
        <el-button
          v-if="showAiConfig"
          class="platform-header__button"
          title="打开 AI 配置"
          @click="goAiConfig"
        >
          <el-icon><Setting /></el-icon>
          <span class="platform-header__button-label">AI 配置</span>
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
      </div>
    </div>
  </header>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { ArrowLeft, Grid, Moon, Setting, Sunny } from '@element-plus/icons-vue'
import { useTheme } from '@/composables/useTheme'
import CanvasWorkspaceSwitcher from '@/components/CanvasWorkspaceSwitcher.vue'
import PlatformPrimaryNav from '@/components/PlatformPrimaryNav.vue'

const props = defineProps({
  title: { type: String, default: '' },
  backTo: { type: [String, Object], default: '' },
  backLabel: { type: String, default: '返回' },
  showTheme: { type: Boolean, default: true },
  showAiConfig: { type: Boolean, default: false },
  showHomeCanvas: { type: Boolean, default: false },
  homeTo: { type: [String, Object], default: '/' }
})

const router = useRouter()
const { isDark, toggle: toggleTheme } = useTheme()

function goBack() {
  router.push(props.backTo)
}

function goAiConfig() {
  router.push({ name: 'ai-config' })
}

function goHomeCanvas() {
  router.push({ name: 'home-canvas-local' })
}
</script>

<style scoped>
.platform-header {
  position: sticky;
  top: 0;
  z-index: 220;
  padding: 10px 16px 0;
  pointer-events: none;
}

.platform-header__inner {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 58px;
  max-width: 1440px;
  margin: 0 auto;
  padding: 8px 10px;
  border: 1px solid rgba(82, 82, 91, .72);
  border-radius: 16px;
  background: rgba(24, 24, 27, .88);
  box-shadow: 0 12px 28px rgba(0, 0, 0, .28);
  backdrop-filter: blur(18px);
  pointer-events: auto;
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
  color: #e4e4e7;
  font-size: 15px;
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
  margin-left: auto;
  flex-wrap: wrap;
}

.platform-header__button {
  min-height: 40px;
  border-color: rgba(255, 255, 255, .1) !important;
  border-radius: 12px !important;
  color: #e4e4e7 !important;
  background: rgba(39, 39, 42, .84) !important;
  transition: background-color .18s ease, border-color .18s ease, transform .18s ease;
}

.platform-header__button:hover,
.platform-header__button:focus-visible {
  border-color: rgba(167, 139, 250, .62) !important;
  color: #fff !important;
  background: rgba(63, 63, 70, .96) !important;
}

.platform-header__button:active {
  transform: translateY(1px);
}

.platform-header__back {
  border-color: rgba(167, 139, 250, .34) !important;
}

:global(html.light) .platform-header__inner {
  border-color: #e4e4e7;
  background: rgba(255, 255, 255, .92);
  box-shadow: 0 12px 28px rgba(24, 24, 27, .12);
}

:global(html.light) .platform-header__title {
  color: #18181b;
}

:global(html.light) .platform-header__separator {
  color: #71717a;
}

:global(html.light) .platform-header__button {
  border-color: #e4e4e7 !important;
  color: #27272a !important;
  background: rgba(255, 255, 255, .96) !important;
}

:global(html.light) .platform-header__button:hover,
:global(html.light) .platform-header__button:focus-visible {
  border-color: #a78bfa !important;
  color: #18181b !important;
  background: #f4f4f5 !important;
}

@media (max-width: 860px) {
  .platform-header { padding: 8px 10px 0; }
  .platform-header__inner { gap: 8px; }
  .platform-header__separator,
  .platform-header__button-label { display: none; }
  .platform-header__title { max-width: 34vw; }
  .platform-header__button { width: 40px; padding: 0 !important; }
}

@media (prefers-reduced-motion: reduce) {
  .platform-header__button { transition: none; }
}
</style>
