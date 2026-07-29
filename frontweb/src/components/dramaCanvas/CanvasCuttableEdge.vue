<script setup>
import { computed, inject, ref } from 'vue'
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
const canRunCanvasEdgeTarget = inject('can-run-canvas-edge-target', null)
const runCanvasEdgeTarget = inject('run-canvas-edge-target', null)
const hovering = ref(false)
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
const canRunTarget = computed(() => Boolean(canRunCanvasEdgeTarget?.(props.id)))

function cutEdge(event) {
  event.stopPropagation()
  cutCanvasEdges?.([props.id], 'scissor')
}

function runEdgeTarget(event) {
  event.stopPropagation()
  runCanvasEdgeTarget?.(props.id)
}
</script>

<template>
  <g class="canvas-cuttable-edge" :class="{ 'is-selected': selected, 'is-hovering': hovering }">
    <BaseEdge
      :id="id"
      :path="edgePath"
      :marker-end="markerEnd"
      :style="style"
      :interaction-width="40"
    />
    <path
      :d="edgePath"
      class="canvas-edge-hover-path"
      @mouseenter="hovering = true"
      @mouseleave="hovering = false"
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
    <g
      v-if="canRunTarget"
      class="canvas-edge-run nodrag nopan"
      :transform="`translate(${labelX + 48}, ${labelY})`"
      role="button"
      tabindex="0"
      aria-label="运行下游图片节点"
      @mousedown.stop
      @click="runEdgeTarget"
      @keydown.enter.prevent="runEdgeTarget"
    >
      <circle r="20" />
      <text text-anchor="middle" dominant-baseline="central">↑</text>
    </g>
  </g>
</template>

<style scoped>
.canvas-edge-hover-path {
  fill: none;
  stroke: transparent;
  stroke-width: 40;
  cursor: pointer;
  pointer-events: stroke;
}

.canvas-edge-cut,
.canvas-edge-run {
  cursor: pointer;
  visibility: hidden;
  opacity: 0;
  transition: opacity 120ms ease, visibility 120ms ease, border-color 120ms ease;
  pointer-events: all;
}

.canvas-edge-cut circle,
.canvas-edge-run circle {
  fill: rgba(20, 20, 23, 0.96);
  stroke: rgba(228, 228, 231, 0.7);
  stroke-width: 2;
}

.canvas-edge-cut text,
.canvas-edge-run text {
  fill: #f4f4f5;
  font-size: 21px;
  user-select: none;
}

.canvas-edge-cut:hover circle,
.canvas-edge-run:hover circle,
.canvas-cuttable-edge.is-selected .canvas-edge-cut circle,
.canvas-cuttable-edge.is-selected .canvas-edge-run circle {
  stroke: #f97316;
}

.canvas-cuttable-edge:hover .canvas-edge-cut,
.canvas-cuttable-edge:hover .canvas-edge-run,
.canvas-cuttable-edge.is-hovering .canvas-edge-cut,
.canvas-cuttable-edge.is-hovering .canvas-edge-run,
.canvas-cuttable-edge.is-selected .canvas-edge-cut,
.canvas-cuttable-edge.is-selected .canvas-edge-run,
.canvas-edge-cut:focus-visible,
.canvas-edge-run:focus-visible {
  visibility: visible;
  opacity: 1;
}
</style>
