<script setup>
import { computed, inject, ref } from 'vue'
import { BaseEdge, getBezierPath } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'

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

const ctx = useCanvasContext()
const cutCanvasEdges = inject('cut-canvas-edges', null)
const hovering = ref(false)
const pathResult = computed(() => getBezierPath({
  sourceX: props.sourceX,
  sourceY: props.sourceY,
  targetX: props.targetX,
  targetY: props.targetY,
  sourcePosition: props.sourcePosition,
  targetPosition: props.targetPosition,
  curvature: 0.42,
}))
const edgePath = computed(() => pathResult.value[0])
const labelX = computed(() => pathResult.value[1])
const labelY = computed(() => pathResult.value[2])

const baseStyle = computed(() => ({
  stroke: props.selected ? '#e9f3ff' : '#aeb8c5',
  strokeWidth: props.selected ? 1.8 : 1.25,
  opacity: props.style?.opacity ?? 0.82,
}))

function cutEdge(event) {
  event.stopPropagation()
  if (!cutCanvasEdges?.([props.id], 'scissor')) {
    ctx?.detachFreeCanvasReference?.(props.id)
  }
}
</script>

<template>
  <g class="libtv-canvas-edge" :class="{ 'is-selected': selected, 'is-hovering': hovering }">
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
      class="libtv-edge-hover-path"
      @mouseenter="hovering = true"
      @mouseleave="hovering = false"
    />
    <path
      :d="edgePath"
      pathLength="1"
      class="libtv-edge-glow"
    />
    <g
      class="libtv-edge-cut nodrag nopan"
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
.libtv-edge-hover-path {
  fill: none;
  stroke: transparent;
  stroke-width: 40;
  cursor: pointer;
  pointer-events: stroke;
}

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

.libtv-edge-cut {
  cursor: pointer;
  visibility: hidden;
  opacity: 0;
  transition: opacity 120ms ease, visibility 120ms ease;
  pointer-events: all;
}

.libtv-edge-cut circle {
  fill: rgba(20, 20, 23, 0.96);
  stroke: rgba(228, 228, 231, 0.7);
  stroke-width: 2;
}

.libtv-edge-cut text {
  fill: #f4f4f5;
  font-size: 21px;
  user-select: none;
}

.libtv-edge-cut:hover circle,
.libtv-canvas-edge.is-selected .libtv-edge-cut circle {
  stroke: #f97316;
}

.libtv-canvas-edge:hover .libtv-edge-cut,
.libtv-canvas-edge.is-hovering .libtv-edge-cut,
.libtv-canvas-edge.is-selected .libtv-edge-cut,
.libtv-edge-cut:focus-visible {
  visibility: visible;
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
