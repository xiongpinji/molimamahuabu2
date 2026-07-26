<template>
  <div class="ai-config">
    <PlatformHeader
      title="AI 配置"
      back-to="/factory"
      back-label="返回项目"
      :show-theme="false"
    />

    <main class="ai-config-main">
      <section class="ai-config-hero" aria-labelledby="ai-config-title">
        <p class="hero-eyebrow">模型与生成中枢</p>
        <h1 id="ai-config-title">管理所有 AI 生成能力</h1>
        <p>统一配置文本、图片、视频和声音模型，保存后将直接用于流水线与自由画布。</p>
      </section>

      <section class="ai-config-workspace" aria-label="AI 模型配置">
        <AIConfigContent />
      </section>
    </main>
  </div>
</template>

<script setup>
import PlatformHeader from '@/components/PlatformHeader.vue'
import AIConfigContent from '@/components/AIConfigContent.vue'
</script>

<style scoped>
.ai-config {
  --el-color-primary: #ff7139;
  --el-color-primary-light-3: #ff8f64;
  --el-color-primary-light-5: #ffab8c;
  --el-color-primary-light-8: #4c281d;
  --el-color-primary-light-9: #291813;
  --el-bg-color: #121212;
  --el-bg-color-overlay: #171717;
  --el-fill-color-blank: #121212;
  --el-fill-color-light: #1d1d1d;
  --el-fill-color-lighter: #232323;
  --el-border-color: #333;
  --el-border-color-light: #292929;
  --el-text-color-primary: #f5f5f5;
  --el-text-color-regular: #c5c5c5;
  --el-text-color-secondary: #8d8d8d;
  min-height: 100vh;
  color: #f5f5f5;
  background: #080808;
  background-image:
    radial-gradient(circle at 14% -8%, rgba(255, 113, 57, 0.14), transparent 28rem),
    radial-gradient(circle at 92% 42%, rgba(255, 113, 57, 0.07), transparent 32rem);
}

:global(html.light) .ai-config {
  color: #f5f5f5;
  background: #080808;
  background-image:
    radial-gradient(circle at 14% -8%, rgba(255, 113, 57, 0.14), transparent 28rem),
    radial-gradient(circle at 92% 42%, rgba(255, 113, 57, 0.07), transparent 32rem);
}

.ai-config-main {
  width: min(1480px, calc(100% - 48px));
  margin: 0 auto;
  padding: 48px 0 72px;
}

.ai-config-hero {
  max-width: 760px;
  margin-bottom: 28px;
}

.hero-eyebrow {
  margin: 0 0 12px;
  color: #ff7139;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.ai-config-hero h1 {
  margin: 0;
  font-size: clamp(32px, 4vw, 52px);
  line-height: 1.08;
  letter-spacing: -0.04em;
}

.ai-config-hero p:last-child {
  max-width: 680px;
  margin: 18px 0 0;
  color: #919191;
  font-size: 15px;
  line-height: 1.8;
}

.ai-config-workspace {
  padding: 28px;
  overflow: hidden;
  background: rgba(17, 17, 17, 0.96);
  border: 1px solid #292929;
  border-radius: 22px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
}

.ai-config-workspace :deep(.el-tabs__item) {
  color: #898989;
}

.ai-config-workspace :deep(.el-tabs__item.is-active),
.ai-config-workspace :deep(.el-tabs__item:hover) {
  color: #ff7139;
}

.ai-config-workspace :deep(.el-tabs__active-bar) {
  background-color: #ff7139;
}

.ai-config-workspace :deep(.el-tabs__nav-wrap::after) {
  background-color: #292929;
}

.ai-config-workspace :deep(.el-input__wrapper),
.ai-config-workspace :deep(.el-select__wrapper),
.ai-config-workspace :deep(.el-textarea__inner),
.ai-config-workspace :deep(.el-input-number),
.ai-config-workspace :deep(.el-table),
.ai-config-workspace :deep(.el-table tr),
.ai-config-workspace :deep(.el-table th.el-table__cell),
.ai-config-workspace :deep(.el-table td.el-table__cell) {
  color: #dedede;
  background: #151515;
  box-shadow: none;
}

.ai-config-workspace :deep(.el-input__wrapper),
.ai-config-workspace :deep(.el-select__wrapper),
.ai-config-workspace :deep(.el-textarea__inner) {
  border: 1px solid #303030;
}

.ai-config-workspace :deep(.el-input__wrapper.is-focus),
.ai-config-workspace :deep(.el-select__wrapper.is-focused),
.ai-config-workspace :deep(.el-textarea__inner:focus) {
  border-color: #ff7139;
}

.ai-config-workspace :deep(.el-table) {
  --el-table-border-color: #2a2a2a;
  --el-table-header-bg-color: #191919;
  --el-table-row-hover-bg-color: #202020;
  --el-table-tr-bg-color: #151515;
}

.ai-config-workspace :deep(.el-button--primary) {
  --el-button-bg-color: #ff7139;
  --el-button-border-color: #ff7139;
  --el-button-hover-bg-color: #ff875a;
  --el-button-hover-border-color: #ff875a;
  color: #111;
  font-weight: 700;
}

.ai-config-workspace :deep(.default-tip),
.ai-config-workspace :deep(.one-key-tip),
.ai-config-workspace :deep(.ph-tip),
.ai-config-workspace :deep(.one-key-section) {
  color: #a7a7a7;
  background: #151515;
  border-color: #303030;
}

.ai-config-workspace :deep(.ph-section-title) {
  color: #f0f0f0;
}

@media (max-width: 760px) {
  .ai-config-main {
    width: min(100% - 28px, 1480px);
    padding-top: 28px;
  }

  .ai-config-workspace {
    padding: 18px 14px;
    border-radius: 16px;
  }
}
</style>
