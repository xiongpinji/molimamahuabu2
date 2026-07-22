<template>
  <div v-if="status" class="node-execution-strip">
    <span class="node-execution-label">节点执行</span>
    <span class="node-execution-message">{{ status.errorDetail || status.message || status.step }}</span>
    <el-button
      v-if="status.step === 'failed' && status.retryStep"
      link
      size="small"
      type="danger"
      :disabled="disabled"
      @click.stop="$emit('retry')"
    >{{ status.retryLabel || '重试失败步骤' }}</el-button>
    <el-button
      v-if="status.nextStep"
      link
      size="small"
      type="primary"
      :disabled="disabled"
      @click.stop="$emit('continue')"
    >{{ status.nextLabel || '继续下游' }}</el-button>
  </div>
</template>

<script setup>
defineProps({
  status: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
})

defineEmits(['retry', 'continue'])
</script>

<style scoped>
.node-execution-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  padding: 4px 7px;
  border: 1px solid rgba(99, 102, 241, 0.28);
  border-radius: 8px;
  background: rgba(30, 27, 75, 0.3);
  color: #c7d2fe;
  font-size: 11px;
}
.node-execution-label {
  color: #93c5fd;
  font-weight: 700;
}
.node-execution-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
