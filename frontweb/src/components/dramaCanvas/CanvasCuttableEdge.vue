<script setup>
import { computed, inject } from 'vue'
import { BaseEdge, getBezierPath, getSmoothStepPath, getStraightPath } from '@vue-flow/core'

const props = defineProps({
  id: { type: String, required: true },
  sourceX: { type: Number, required: true },
  sourceY: { type: Number, required: true },
  targetX: { type: Number, required: true },
  targetY: { type: Number, required: true },
  sourcePosition: { type: String, required: true },
  targetPosition: { type: String, required: true },
  markerEnd: { type: String, default: undefined },
  style: { type: Object, default: () => ({}) },
  data: { type: Object, default: () => ({}) },
  selected: { type: Boolean, default: false },
})

const cutCanvasEdges = inject('cut-canvas-edges', null)
const pathResult = computed(() => {
  const options = {
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  }
  if (props.data?.lineType === 'straight') return getStraightPath(options)
  if (props.data?.lineType === 'smoothstep') return getSmoothStepPath(options)
  return getBezierPath(options)
})
const edgePath = computed(() => pathResult.value[0])
const labelX = computed(() => pathResult.value[1])
const labelY = computed(() => pathResult.value[2])

function cutEdge(event) {
  event.stopPropagation()
  cutCanvasEdges?.([props.id], 'scissor')
}
</script>

<template>
  <g class="canvas-cuttable-edge" :class="{ 'is-selected': selected }">
    <BaseEdge
      :id="id"
      :path="edgePath"
      :marker-end="markerEnd"
      :style="style"
      :interaction-width="28"
    />
    <g
      class="canvas-edge-cut nodrag nopan"
      :transform="`translate(${labelX}, ${labelY})`"
      role="button"
      tabindex="0"
      aria-label="剪断连线"
      @mousedown.stop
      @click="cutEdge"
      @keydown.enter.prevent="cutEdge"
    >
      <circle r="20" />
      <text text-anchor="middle" dominant-baseline="central">✂</text>
    </g>
  </g>
</template>

<style scoped>
.canvas-edge-cut {
  cursor: pointer;
  visibility: hidden;
  opacity: 0;
  transition: opacity 120ms ease, visibility 120ms ease, border-color 120ms ease;
  pointer-events: all;
}

.canvas-edge-cut circle {
  fill: rgba(20, 20, 23, 0.96);
  stroke: rgba(228, 228, 231, 0.7);
  stroke-width: 2;
}

.canvas-edge-cut text {
  fill: #f4f4f5;
  font-size: 21px;
  user-select: none;
}

.canvas-edge-cut:hover circle,
.canvas-cuttable-edge.is-selected .canvas-edge-cut circle {
  stroke: #f97316;
}

.canvas-cuttable-edge:hover .canvas-edge-cut,
.canvas-cuttable-edge.is-selected .canvas-edge-cut,
.canvas-edge-cut:focus-visible {
  visibility: visible;
  opacity: 1;
}
</style>
