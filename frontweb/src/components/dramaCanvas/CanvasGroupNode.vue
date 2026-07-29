<template>
  <div class="canvas-group-node" :style="{ width: `${data.width}px`, height: `${data.height}px` }">
    <div class="canvas-group-title">
      <span>{{ data.title || '节点组' }}</span>
      <small>{{ data.childNodeIds?.length || 0 }} 个节点</small>
    </div>
  </div>
</template>

<script setup>
defineProps({ data: { type: Object, required: true } })
</script>

<style scoped>
.canvas-group-node {
  box-sizing: border-box;
  min-width: 260px;
  min-height: 180px;
  border: 1px dashed rgba(255, 113, 57, 0.78);
  border-radius: 20px;
  background: rgba(255, 113, 57, 0.035);
  cursor: grab;
}
.canvas-group-node:active { cursor: grabbing; }
.canvas-group-title {
  position: absolute;
  top: -38px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #f4f4f5;
  font-size: 14px;
  font-weight: 600;
}
.canvas-group-title small { color: #a1a1aa; font-size: 11px; font-weight: 400; }
</style>
