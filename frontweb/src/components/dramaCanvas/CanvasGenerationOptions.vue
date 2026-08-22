<template>
  <div class="generation-options" :class="{ compact }">
    <span class="options-label">{{ label }}</span>
    <el-select
      v-if="mode === 'image' || mode === 'both'"
      :model-value="options.imageModel || ''"
      size="small"
      class="model-select"
      :disabled="!imageModelOptions.length"
      :placeholder="imageModelOptions.length ? '图像模型' : '平台默认'"
      @change="update('imageModel', $event)"
    >
      <el-option label="跟随项目默认" value="" />
      <el-option v-for="option in imageModelOptions" :key="`image-${option.value}`" :label="option.label" :value="option.value" />
    </el-select>
    <el-select
      v-if="mode === 'video' || mode === 'both'"
      :model-value="options.videoModel || ''"
      size="small"
      class="model-select"
      :disabled="!videoModelOptions.length"
      :placeholder="videoModelOptions.length ? '视频模型' : '平台默认'"
      @change="onVideoModelChange"
    >
      <el-option label="跟随项目默认" value="" />
      <el-option v-for="option in videoModelOptions" :key="`video-${option.value}`" :label="option.label" :value="option.value" />
    </el-select>
    <el-select
      v-if="mode === 'audio' || mode === 'both'"
      :model-value="options.audioModel || ''"
      size="small"
      class="model-select"
      :disabled="!audioModelOptions.length"
      :placeholder="audioModelOptions.length ? '音频模型' : '平台默认'"
      @change="update('audioModel', $event)"
    >
      <el-option label="跟随项目默认" value="" />
      <el-option v-for="option in audioModelOptions" :key="`audio-${option.value}`" :label="option.label" :value="option.value" />
    </el-select>
    <el-select
      v-if="!modelsOnly && mode !== 'audio'"
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
      v-if="!modelsOnly && (mode === 'video' || mode === 'both') && videoResolutionOptions.length"
      :model-value="options.videoResolution || '480p'"
      size="small"
      class="resolution-select"
      placeholder="清晰度"
      @change="update('videoResolution', $event)"
    >
      <el-option
        v-for="resolution in videoResolutionOptions"
        :key="resolution"
        :label="resolution.toUpperCase()"
        :value="resolution"
      />
    </el-select>
    <el-select
      v-if="!modelsOnly && (mode === 'video' || mode === 'both')"
      :model-value="Number(options.videoDuration || 5)"
      size="small"
      class="duration-select"
      placeholder="时长"
      @change="update('videoDuration', $event)"
    >
      <el-option
        v-for="duration in videoDurationOptions"
        :key="duration"
        :label="`${duration} 秒`"
        :value="duration"
      />
    </el-select>
    <el-input-number
      v-else-if="!modelsOnly && mode === 'audio'"
      :model-value="Number(options.videoDuration || 5)"
      size="small"
      class="duration-input"
      :min="1"
      :max="120"
      controls-position="right"
      @change="update('videoDuration', $event)"
    />
    <span v-if="selectedVideoModel?.publicNote && !compact" class="model-note">{{ selectedVideoModel.publicNote }}</span>
    <span v-if="!compact" class="options-hint">单镜与批量生成共用</span>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { aiAPI } from '@/api/ai'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { canvasModelEntry, canvasModelOptions } from '@/utils/canvasModelCapabilities'
import { videoDurationOptionsForCapability } from '@/utils/videoDuration'

const props = defineProps({
  mode: { type: String, default: 'both' },
  compact: { type: Boolean, default: false },
  label: { type: String, default: '生成参数' },
  modelValue: { type: Object, default: null },
  modelsOnly: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'change'])

const ctx = useCanvasContext()
const modelCatalog = ref([])
const options = computed(() => props.modelValue || ctx?.generationOptions?.value || {})

const imageModelOptions = computed(() => canvasModelOptions(modelCatalog.value, 'image'))
const videoModelOptions = computed(() => canvasModelOptions(modelCatalog.value, 'video'))
const audioModelOptions = computed(() => canvasModelOptions(modelCatalog.value, 'audio'))
const selectedVideoModel = computed(() => (
  canvasModelEntry(modelCatalog.value, 'video', options.value.videoModel) || null
))
const videoResolutionOptions = computed(() => {
  const declared = selectedVideoModel.value?.capabilities?.resolutions
  return Array.isArray(declared) ? declared : ['480p', '720p']
})
const videoDurationOptions = computed(() => videoDurationOptionsForCapability(
  selectedVideoModel.value?.capabilities,
))

function updatePatch(patch) {
  if (props.modelValue) {
    const next = { ...options.value, ...patch }
    emit('update:modelValue', next)
    emit('change', patch, next)
    return
  }
  ctx?.updateGenerationOptions?.(patch)
  emit('change', patch, { ...options.value, ...patch })
}

function update(field, value) {
  updatePatch({ [field]: value })
}

function onVideoModelChange(value) {
  const selected = canvasModelEntry(modelCatalog.value, 'video', value)
  const declaredResolutions = selected?.capabilities?.resolutions
  const resolutions = Array.isArray(declaredResolutions) ? declaredResolutions : ['480p', '720p']
  const durations = videoDurationOptionsForCapability(selected?.capabilities)
  const currentResolution = String(options.value.videoResolution || '').trim().toLowerCase()
  const currentDuration = Number(options.value.videoDuration || 5)
  updatePatch({
    videoModel: value,
    videoResolution: resolutions.includes(currentResolution) ? currentResolution : (resolutions[0] || ''),
    videoDuration: durations.includes(currentDuration) ? currentDuration : durations[0],
  })
}

onMounted(async () => {
  const catalog = await aiAPI.listCanvasModels().catch(() => [])
  modelCatalog.value = Array.isArray(catalog) ? catalog : []
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
.generation-options :deep(.duration-select) { width: 104px; }
.generation-options :deep(.duration-input) { width: 104px; }
.options-hint {
  color: #52525b;
  font-size: 10px;
  white-space: nowrap;
}
.model-note {
  max-width: 220px;
  overflow: hidden;
  color: #a1a1aa;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compact { gap: 5px; }
.compact .options-label { color: #71717a; }
.compact :deep(.el-select) { width: 112px; }
.compact :deep(.model-select) { width: 128px; }
.compact :deep(.duration-select) { width: 96px; }
.compact :deep(.duration-input) { width: 96px; }
</style>
