<template>
  <el-button-group class="canvas-mode-switch" role="group" aria-label="制作模式">
    <el-button
      size="small"
      :type="mode === 'production' ? 'primary' : 'default'"
      :plain="mode !== 'production'"
      :aria-pressed="mode === 'production'"
      title="进入制作页"
      @click="go('production')"
    >
      <el-icon><Document /></el-icon>
      <span class="canvas-mode-switch__label">制作页</span>
    </el-button>
    <el-button
      size="small"
      :type="mode === 'canvas' ? 'primary' : 'default'"
      :plain="mode !== 'canvas'"
      :aria-pressed="mode === 'canvas'"
      title="进入画布页"
      @click="go('canvas')"
    >
      <el-icon><Grid /></el-icon>
      <span class="canvas-mode-switch__label">画布页</span>
    </el-button>
  </el-button-group>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { Document, Grid } from '@element-plus/icons-vue'

const props = defineProps({
  mode: { type: String, required: true },
  dramaId: { type: [String, Number], required: true },
  episodeId: { type: [String, Number], default: null },
})

const router = useRouter()

function go(target) {
  const path = target === 'canvas' ? `/film/${props.dramaId}/canvas` : `/film/${props.dramaId}`
  const hasEpisode = props.episodeId !== null && props.episodeId !== undefined && props.episodeId !== ''
  router.push(hasEpisode ? { path, query: { episode: String(props.episodeId) } } : { path })
}
</script>

<style scoped>
.canvas-mode-switch {
  display: inline-flex;
  flex: 0 0 auto;
}

.canvas-mode-switch :deep(.el-button) {
  min-height: 38px;
}

.canvas-mode-switch__label {
  margin-left: 4px;
}

@media (max-width: 680px) {
  .canvas-mode-switch :deep(.el-button) {
    width: 40px;
    padding: 0 10px;
  }

  .canvas-mode-switch__label {
    display: none;
  }
}
</style>
