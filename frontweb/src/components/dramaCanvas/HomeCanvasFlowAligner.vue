<template>
  <span aria-hidden="true" />
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useVueFlow } from '@vue-flow/core'

const emit = defineEmits(['ready'])
const { fitView, getViewport, setViewport, zoomIn, zoomOut } = useVueFlow()

onMounted(() => emit('ready', { fitView, getViewport, setViewport, zoomIn, zoomOut }))
onUnmounted(() => emit('ready', null))
</script>
