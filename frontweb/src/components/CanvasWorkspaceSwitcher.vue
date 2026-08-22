<template>
  <div class="canvas-workspace-switcher" aria-label="茉莉妈妈短剧制作平台">
    <img class="canvas-workspace-switcher__logo" src="/moli-mama-logo.png" alt="茉莉妈妈" />
    <span class="canvas-workspace-switcher__copy">
      <span class="canvas-workspace-switcher__name">茉莉妈妈</span>
      <span class="canvas-workspace-switcher__subtitle">短剧制作平台</span>
    </span>
  </div>
</template>

<script setup>
defineProps({
  homeTo: { type: [String, Object], default: '/' }
})
</script>

<style scoped>
.canvas-workspace-switcher {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 146px;
  min-height: 42px;
  padding: 3px 8px 3px 3px;
  border-radius: 12px;
  color: inherit;
  background: transparent;
  text-align: left;
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

:global(html.light) .canvas-workspace-switcher__name {
  color: #f5f5f5;
}

:global(html.light) .canvas-workspace-switcher__subtitle {
  color: #8c8c8c;
}

@media (max-width: 680px) {
  .canvas-workspace-switcher {
    min-width: 44px;
    width: 44px;
    padding: 2px;
  }

  .canvas-workspace-switcher__copy {
    display: none;
  }
}
</style>
