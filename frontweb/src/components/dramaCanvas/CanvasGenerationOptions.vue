<template>
  <div class="generation-options" :class="{ compact }">
    <span class="options-label">生成参数</span>
    <el-select
      v-if="mode !== 'video'"
      :model-value="selectedImageModel"
      size="small"
      class="model-select"
      :disabled="!imageModelOptions.length"
      :placeholder="imageModelOptions.length ? '图像模型' : 'AI 配置默认'"
      @change="update('imageModel', $event)"
    >
      <el-option v-if="storyboard" label="跟随项目默认" value="" />
      <el-option v-for="model in imageModelOptions" :key="`image-${model}`" :label="model" :value="model" />
    </el-select>
    <el-select
      v-if="mode !== 'image'"
      :model-value="selectedVideoModel"
      size="small"
      class="model-select"
      :disabled="!videoModelOptions.length"
      :placeholder="videoModelOptions.length ? '视频模型' : 'AI 配置默认'"
      @change="update('videoModel', $event)"
    >
      <el-option v-if="storyboard" label="跟随项目默认" value="" />
      <el-option v-for="model in videoModelOptions" :key="`video-${model}`" :label="model" :value="model" />
    </el-select>
    <el-select
      :model-value="options.aspectRatio || '16:9'"
      size="small"
      class="ratio-select"
      placeholder="画幅"
      @change="update('aspectRatio', $event)"
    >
      <el-option label="16:9 横屏" value="16:9" />
      <el-option label="9:16 竖屏" value="9:16" />
      <el-option label="3:4 竖版" value="3:4" />
      <el-option label="1:1 方形" value="1:1" />
      <el-option label="4:3 横屏" value="4:3" />
      <el-option label="21:9 宽银幕" value="21:9" />
    </el-select>
    <el-select
      v-if="mode !== 'image'"
      :model-value="options.videoResolution || '480p'"
      size="small"
      class="resolution-select"
      placeholder="清晰度"
      @change="update('videoResolution', $event)"
    >
      <el-option label="480p 标清" value="480p" />
      <el-option label="720p 高清" value="720p" />
      <el-option label="1080p 超清" value="1080p" />
    </el-select>
    <span v-if="!compact" class="options-hint">单镜与批量生成共用</span>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { aiAPI } from '@/api/ai'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { getSelectableModels } from '@/utils/modelSelection'

const props = defineProps({
  mode: { type: String, default: 'both' },
  compact: { type: Boolean, default: false },
  storyboard: { type: Object, default: null },
  imageServiceType: { type: String, default: 'image' },
})

const emit = defineEmits(['storyboard-video-model-change', 'storyboard-image-model-change'])

const ctx = useCanvasContext()
const imageConfigs = ref([])
const videoConfigs = ref([])
const options = computed(() => ctx?.generationOptions?.value || {})
const selectedImageModel = computed(() => props.storyboard
  ? String(props.storyboard.image_model || '')
  : String(options.value.imageModel || ''))

const imageModelOptions = computed(() => withCurrent(
  getSelectableModels(imageConfigs.value, props.imageServiceType),
  selectedImageModel.value,
))
const videoModelOptions = computed(() => withCurrent(
  getSelectableModels(videoConfigs.value, 'video'),
  props.storyboard?.video_model || options.value.videoModel,
))
const selectedVideoModel = computed(() => props.storyboard
  ? String(props.storyboard.video_model || '')
  : String(options.value.videoModel || ''))

function withCurrent(models, current) {
  const value = String(current || '').trim()
  if (!value || models.includes(value)) return models
  return [value, ...models]
}

function update(field, value) {
  if (props.storyboard && field === 'imageModel') {
    emit('storyboard-image-model-change', value)
    return
  }
  if (props.storyboard && field === 'videoModel') {
    emit('storyboard-video-model-change', value)
    return
  }
  ctx?.updateGenerationOptions?.({ [field]: value })
}

onMounted(async () => {
  const [images, videos] = await Promise.allSettled([
    aiAPI.listImageModels(),
    aiAPI.listVideoModels(),
  ])
  if (images.status === 'fulfilled') imageConfigs.value = Array.isArray(images.value) ? images.value : []
  if (videos.status === 'fulfilled') videoConfigs.value = Array.isArray(videos.value) ? videos.value : []
})
</script>

<style scoped>
.generation-options {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.options-label {
  color: #a1a1aa;
  font-size: 11px;
  white-space: nowrap;
}
.generation-options :deep(.el-select) { width: 124px; }
.generation-options :deep(.ratio-select) { width: 116px; }
.generation-options :deep(.resolution-select) { width: 124px; }
.generation-options :deep(.model-select) { width: 140px; }
.options-hint {
  color: #52525b;
  font-size: 10px;
  white-space: nowrap;
}
.compact { gap: 5px; }
.compact .options-label { color: #71717a; }
.compact :deep(.el-select) { width: 112px; }
.compact :deep(.model-select) { width: 128px; }
</style>
