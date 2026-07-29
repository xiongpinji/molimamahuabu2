<script setup>
import { computed } from 'vue'
import { BaseEdge, getBezierPath } from '@vue-flow/core'

const props = defineProps({
  id: { type: String, required: true },
  sourceX: { type: Number, required: true },
  sourceY: { type: Number, required: true },
  targetX: { type: Number, required: true },
  targetY: { type: Number, required: true },
  sourcePosition: { type: String, required: true },
  targetPosition: { type: String, required: true },
  markerStart: { type: String, default: undefined },
  markerEnd: { type: String, default: undefined },
  interactionWidth: { type: Number, default: 20 },
  selected: { type: Boolean, default: false },
  style: { type: Object, default: () => ({}) },
})

const edgePath = computed(() => getBezierPath({
  sourceX: props.sourceX,
  sourceY: props.sourceY,
  targetX: props.targetX,
  targetY: props.targetY,
  sourcePosition: props.sourcePosition,
  targetPosition: props.targetPosition,
  curvature: 0.42,
})[0])

const baseStyle = computed(() => ({
  stroke: props.selected ? '#e9f3ff' : '#aeb8c5',
  strokeWidth: props.selected ? 1.8 : 1.25,
  opacity: props.style?.opacity ?? 0.82,
}))
</script>

<template>
  <g class="libtv-canvas-edge" :class="{ 'is-selected': selected }">
    <BaseEdge
      :id="id"
      :path="edgePath"
      :marker-start="markerStart"
      :marker-end="markerEnd"
      :interaction-width="interactionWidth"
      :style="baseStyle"
      class="libtv-edge-base"
    />
    <path
      :d="edgePath"
      pathLength="1"
      class="libtv-edge-glow"
    />
  </g>
</template>

<style scoped>
.libtv-edge-glow {
  pointer-events: none;
  fill: none;
  stroke: #62adff;
  stroke-width: 2.2;
  stroke-dasharray: .14 .86;
  stroke-linecap: round;
  opacity: .78;
  filter: drop-shadow(0 0 3px rgb(71 157 255 / 80%));
  animation: libtv-edge-flow 2.4s linear infinite;
}

.libtv-canvas-edge.is-selected .libtv-edge-glow {
  stroke-width: 2.8;
  opacity: 1;
}

@keyframes libtv-edge-flow {
  to {
    stroke-dashoffset: -1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .libtv-edge-glow {
    animation: none;
  }
}
</style>
