<template>
  <main class="admin-workspace">
    <PlatformHeader
      :title="headerTitle || title"
      :back-to="backTo"
      :back-label="backLabel"
      :show-theme="false"
    />

    <div class="admin-workspace__main">
      <AdminWorkspaceNav />

      <section class="admin-workspace__hero" aria-labelledby="admin-workspace-title">
        <div>
          <p class="admin-workspace__eyebrow">{{ eyebrow }}</p>
          <h1 id="admin-workspace-title">{{ title }}</h1>
          <p class="admin-workspace__description">{{ description }}</p>
        </div>
        <div v-if="$slots.actions" class="admin-workspace__actions">
          <slot name="actions" />
        </div>
      </section>

      <div class="admin-workspace__body">
        <slot />
      </div>
    </div>
  </main>
</template>

<script setup>
import AdminWorkspaceNav from '@/components/AdminWorkspaceNav.vue'
import PlatformHeader from '@/components/PlatformHeader.vue'

defineProps({
  title: { type: String, required: true },
  eyebrow: { type: String, default: '管理中心' },
  description: { type: String, default: '' },
  headerTitle: { type: String, default: '' },
  backTo: { type: [String, Object], default: '/factory' },
  backLabel: { type: String, default: '返回项目' },
})
</script>

<style scoped>
.admin-workspace {
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
    radial-gradient(circle at 10% -5%, rgba(255, 113, 57, .14), transparent 30rem),
    radial-gradient(circle at 92% 52%, rgba(255, 113, 57, .06), transparent 34rem);
}

:global(html.light) .admin-workspace {
  color: #f5f5f5;
  background: #080808;
  background-image:
    radial-gradient(circle at 10% -5%, rgba(255, 113, 57, .14), transparent 30rem),
    radial-gradient(circle at 92% 52%, rgba(255, 113, 57, .06), transparent 34rem);
}

.admin-workspace__main {
  width: min(1320px, calc(100% - 48px));
  margin: 0 auto;
  padding: 28px 0 72px;
}

.admin-workspace__hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin-bottom: 26px;
}

.admin-workspace__eyebrow {
  margin: 0 0 10px;
  color: #ff7139;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .14em;
}

.admin-workspace__hero h1 {
  margin: 0;
  font-size: clamp(30px, 3.8vw, 48px);
  line-height: 1.08;
  letter-spacing: -.04em;
}

.admin-workspace__description {
  max-width: 720px;
  margin: 16px 0 0;
  color: #929292;
  font-size: 14px;
  line-height: 1.8;
}

.admin-workspace__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
}

.admin-workspace__body :deep(.el-button--primary) {
  --el-button-bg-color: #ff7139;
  --el-button-border-color: #ff7139;
  --el-button-hover-bg-color: #ff875a;
  --el-button-hover-border-color: #ff875a;
  border-color: #ff7139 !important;
  color: #111;
  background: #ff7139 !important;
  font-weight: 700;
}

.admin-workspace__body :deep(.el-input__wrapper),
.admin-workspace__body :deep(.el-select__wrapper),
.admin-workspace__body :deep(.el-textarea__inner),
.admin-workspace__body :deep(.el-input-number),
.admin-workspace__body :deep(.el-table),
.admin-workspace__body :deep(.el-table tr),
.admin-workspace__body :deep(.el-table th.el-table__cell),
.admin-workspace__body :deep(.el-table td.el-table__cell) {
  color: #dedede;
  background: #151515;
  box-shadow: none;
}

.admin-workspace__body :deep(.el-input__wrapper),
.admin-workspace__body :deep(.el-select__wrapper),
.admin-workspace__body :deep(.el-textarea__inner) {
  border: 0;
  background: #151515 !important;
  box-shadow: 0 0 0 1px #303030 inset !important;
}

.admin-workspace__body :deep(.el-input__wrapper.is-focus),
.admin-workspace__body :deep(.el-select__wrapper.is-focused),
.admin-workspace__body :deep(.el-textarea__inner:focus) {
  box-shadow: 0 0 0 1px #ff7139 inset !important;
}

.admin-workspace__body :deep(.el-input__inner),
.admin-workspace__body :deep(.el-textarea__inner),
.admin-workspace__body :deep(.el-select__selected-item) {
  color: #dedede !important;
}

.admin-workspace__body :deep(.el-alert) {
  border: 1px solid #3a302c;
  color: #bdbdbd;
  background: #191614 !important;
}

.admin-workspace__body :deep(.el-alert__title),
.admin-workspace__body :deep(.el-alert__description) {
  color: #bdbdbd !important;
}

.admin-workspace__body :deep(.el-table) {
  --el-table-bg-color: #151515;
  --el-table-border-color: #292929;
  --el-table-header-bg-color: #191919;
  --el-table-header-text-color: #bdbdbd;
  --el-table-row-hover-bg-color: #202020;
  --el-table-tr-bg-color: #151515;
  --el-table-text-color: #dedede;
  background: #151515 !important;
}

.admin-workspace__body :deep(.el-table tr),
.admin-workspace__body :deep(.el-table th.el-table__cell),
.admin-workspace__body :deep(.el-table td.el-table__cell) {
  background-color: var(--el-table-tr-bg-color) !important;
}

.admin-workspace__body :deep(.el-table th.el-table__cell) {
  background-color: var(--el-table-header-bg-color) !important;
  color: #bdbdbd !important;
}

.admin-workspace__body :deep(.el-table__inner-wrapper::before) {
  background-color: #292929;
}

.admin-workspace__body :deep(.el-table__empty-block) {
  background: #151515;
}

.admin-workspace__body :deep(.el-tabs__item) {
  color: #898989;
}

.admin-workspace__body :deep(.el-tabs__item.is-active),
.admin-workspace__body :deep(.el-tabs__item:hover) {
  color: #ff7139;
}

.admin-workspace__body :deep(.el-tabs__active-bar) {
  background-color: #ff7139;
}

.admin-workspace__body :deep(.el-tabs__nav-wrap::after) {
  background-color: #292929;
}

@media (max-width: 760px) {
  .admin-workspace__main {
    width: min(100% - 28px, 1320px);
    padding-top: 18px;
  }

  .admin-workspace__hero {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
