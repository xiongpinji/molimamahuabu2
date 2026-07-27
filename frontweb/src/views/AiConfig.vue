<template>
  <AdminWorkspaceShell
    title="模型配置"
    eyebrow="平台管理"
    description="统一管理供应商、接口密钥和管理员启用的文本、图片、视频与声音模型。普通用户端不会显示这些配置。"
  >
    <section class="ai-config-workspace" aria-label="AI 模型配置">
      <AIConfigContent />
    </section>
  </AdminWorkspaceShell>
</template>

<script setup>
import AdminWorkspaceShell from '@/components/AdminWorkspaceShell.vue'
import AIConfigContent from '@/components/AIConfigContent.vue'
</script>

<style scoped>
.ai-config-workspace {
  padding: 28px;
  overflow: hidden;
  border: 1px solid #292929;
  border-radius: 22px;
  background: rgba(17, 17, 17, .96);
  box-shadow: 0 24px 80px rgba(0, 0, 0, .35);
}

@media (max-width: 760px) {
  .ai-config-workspace {
    padding: 18px 14px;
    border-radius: 16px;
  }
}
</style>
