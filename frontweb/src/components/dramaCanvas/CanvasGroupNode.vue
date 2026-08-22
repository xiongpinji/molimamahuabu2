<template>
  <div
    class="canvas-group-node"
    :class="{ selected }"
    :style="{ width: `${data.width}px`, height: `${data.height}px` }"
  >
    <div class="canvas-group-title">
      <span>{{ data.title || '节点组' }}</span>
      <small>{{ data.childNodeIds?.length || 0 }} 个节点</small>
    </div>
  </div>
</template>

<script setup>
defineProps({
  data: { type: Object, required: true },
  selected: { type: Boolean, default: false },
})
</script>

<style scoped>
.canvas-group-node {
  box-sizing: border-box;
  min-width: 260px;
  min-height: 180px;
  border: 1px solid rgba(113, 113, 122, 0.64);
  border-radius: 18px;
  background: rgba(39, 39, 42, 0.16);
  cursor: grab;
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}
.canvas-group-node.selected {
  border-color: rgba(92, 155, 106, 0.95);
  background: rgba(48, 92, 59, 0.12);
  box-shadow: 0 0 0 2px rgba(92, 155, 106, 0.32);
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
