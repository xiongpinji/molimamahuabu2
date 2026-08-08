<template>
  <div class="generation-options" :class="{ compact }">
    <span class="options-label">{{ label }}</span>
    <div v-if="mode === 'image' || mode === 'both'" class="model-option-group">
      <el-select
        :model-value="options.imageModel || ''"
        size="small"
        class="model-select"
        :disabled="modelCatalogStatus !== 'loaded' || !imageModelOptions.length"
        :placeholder="imageModelOptions.length ? '图像模型' : '平台默认'"
        teleported
        popper-class="canvas-model-select-popper"
        @change="update('imageModel', $event)"
      >
        <el-option label="跟随项目默认" value="" />
        <el-option v-for="model in imageModelOptions" :key="`image-${model.value}`" :label="model.label" :value="model.value" />
      </el-select>
      <p v-if="modelCatalogLoading" class="model-public-note">模型目录加载中…</p>
      <p v-else-if="modelCatalogError" class="model-unavailable-note">
        模型目录加载失败，请重试
        <button type="button" class="model-retry-button" @click.stop="retryModelCatalog">重试</button>
      </p>
      <p v-else-if="selectedImageModelNote" class="model-public-note">{{ selectedImageModelNote }}</p>
      <p v-else-if="imageModelUnavailable" class="model-unavailable-note">当前模型已不可用，请重新选择</p>
    </div>
    <div v-if="mode === 'video' || mode === 'both'" class="model-option-group">
      <el-select
        :model-value="options.videoModel || ''"
        size="small"
        class="model-select"
        :disabled="modelCatalogStatus !== 'loaded' || !videoModelOptions.length"
        :placeholder="videoModelOptions.length ? '视频模型' : '平台默认'"
        teleported
        popper-class="canvas-model-select-popper"
        @change="update('videoModel', $event)"
      >
        <el-option label="跟随项目默认" value="" />
        <el-option v-for="model in videoModelOptions" :key="`video-${model.value}`" :label="model.label" :value="model.value" />
      </el-select>
      <p v-if="modelCatalogLoading" class="model-public-note">模型目录加载中…</p>
      <p v-else-if="modelCatalogError" class="model-unavailable-note">
        模型目录加载失败，请重试
        <button type="button" class="model-retry-button" @click.stop="retryModelCatalog">重试</button>
      </p>
      <p v-else-if="selectedVideoModelNote" class="model-public-note">{{ selectedVideoModelNote }}</p>
      <p v-else-if="videoModelUnavailable" class="model-unavailable-note">当前模型已不可用，请重新选择</p>
    </div>
    <div v-if="mode === 'audio' || mode === 'both'" class="model-option-group">
      <el-select
        :model-value="options.audioModel || ''"
        size="small"
        class="model-select"
        :disabled="modelCatalogStatus !== 'loaded' || !audioModelOptions.length"
        :placeholder="audioModelOptions.length ? '音频模型' : '平台默认'"
        teleported
        popper-class="canvas-model-select-popper"
        @change="update('audioModel', $event)"
      >
        <el-option label="跟随项目默认" value="" />
        <el-option v-for="model in audioModelOptions" :key="`audio-${model.value}`" :label="model.label" :value="model.value" />
      </el-select>
      <p v-if="modelCatalogLoading" class="model-public-note">模型目录加载中…</p>
      <p v-else-if="modelCatalogError" class="model-unavailable-note">
        模型目录加载失败，请重试
        <button type="button" class="model-retry-button" @click.stop="retryModelCatalog">重试</button>
      </p>
      <p v-else-if="selectedAudioModelNote" class="model-public-note">{{ selectedAudioModelNote }}</p>
      <p v-else-if="audioModelUnavailable" class="model-unavailable-note">当前模型已不可用，请重新选择</p>
    </div>
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
      v-if="!modelsOnly && (mode === 'video' || mode === 'both')"
      :model-value="options.videoResolution || '480p'"
      size="small"
      class="resolution-select"
      placeholder="清晰度"
      @change="update('videoResolution', $event)"
    >
      <el-option
        v-for="value in videoResolutionOptions"
        :key="value"
        :label="value === '480p' ? '480p 标清' : value === '720p' ? '720p 高清' : '1080p 超清'"
        :value="value"
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
    <span v-if="!compact" class="options-hint">单镜与批量生成共用</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { VIDEO_DURATION_OPTIONS, videoDurationOptionsForModel } from '@/utils/videoDuration'
import { coerceVideoResolutionForModel, videoResolutionOptionsForModel } from '@/utils/videoResolution'

const props = defineProps({
  mode: { type: String, default: 'both' },
  compact: { type: Boolean, default: false },
  label: { type: String, default: '生成参数' },
  modelValue: { type: Object, default: null },
  modelsOnly: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'change'])

const ctx = useCanvasContext()
const options = computed(() => props.modelValue || ctx?.generationOptions?.value || {})
const modelCatalogStatus = computed(() => ctx?.getFreeNodeModelCatalogStatus?.() || 'loaded')
const modelCatalogLoading = computed(() => ['idle', 'loading'].includes(modelCatalogStatus.value))
const modelCatalogError = computed(() => modelCatalogStatus.value === 'error')

const imageModelOptions = computed(() => modelOptionEntries('image'))
const videoModelOptions = computed(() => modelOptionEntries('video'))
const audioModelOptions = computed(() => modelOptionEntries('audio'))
const selectedImageModel = computed(() => selectedModelEntry(imageModelOptions.value, options.value.imageModel))
const selectedVideoModel = computed(() => selectedModelEntry(videoModelOptions.value, options.value.videoModel))
const selectedAudioModel = computed(() => selectedModelEntry(audioModelOptions.value, options.value.audioModel))
const selectedImageModelNote = computed(() => String(selectedImageModel.value?.note || '').trim())
const selectedVideoModelNote = computed(() => String(selectedVideoModel.value?.note || '').trim())
const selectedAudioModelNote = computed(() => String(selectedAudioModel.value?.note || '').trim())
const imageModelUnavailable = computed(() => modelUnavailable(imageModelOptions.value, options.value.imageModel))
const videoModelUnavailable = computed(() => modelUnavailable(videoModelOptions.value, options.value.videoModel))
const audioModelUnavailable = computed(() => modelUnavailable(audioModelOptions.value, options.value.audioModel))
const videoDurationOptions = computed(() => {
  const declared = ctx?.getFreeNodeModelCapability?.('video', options.value.videoModel)?.durations
  return videoDurationOptionsForModel(options.value.videoModel, declared || VIDEO_DURATION_OPTIONS)
})
const videoResolutionOptions = computed(() => {
  const declared = ctx?.getFreeNodeModelCapability?.('video', options.value.videoModel)?.resolutions
  return videoResolutionOptionsForModel(options.value.videoModel, declared)
})

function modelOptionEntries(kind) {
  return ctx?.getFreeNodeModelOptionEntries?.(kind) || []
}

function selectedModelEntry(models, current) {
  const value = String(current || '').trim()
  return models.find((model) => model.value === value) || null
}

function modelUnavailable(models, current) {
  return modelCatalogStatus.value === 'loaded'
    && Boolean(String(current || '').trim())
    && !selectedModelEntry(models, current)
}

function retryModelCatalog() {
  void ctx?.reloadFreeNodeModelCatalog?.()
}

function update(field, value) {
  const patch = { [field]: value }
  if (field === 'videoModel') {
    const currentDuration = Number(options.value.videoDuration || 5)
    const declared = ctx?.getFreeNodeModelCapability?.('video', value)?.durations
    const nextDurations = videoDurationOptionsForModel(value, declared || VIDEO_DURATION_OPTIONS)
    if (!nextDurations.includes(currentDuration)) patch.videoDuration = nextDurations[0] || 5
    const declaredResolutions = ctx?.getFreeNodeModelCapability?.('video', value)?.resolutions
    patch.videoResolution = coerceVideoResolutionForModel(
      value,
      options.value.videoResolution,
      declaredResolutions,
    )
  }
  if (props.modelValue) {
    const next = { ...options.value, ...patch }
    emit('update:modelValue', next)
    emit('change', patch, next)
    return
  }
  ctx?.updateGenerationOptions?.(patch)
  emit('change', patch, { ...options.value, ...patch })
}
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
.model-option-group { display: grid; gap: 4px; }
.model-public-note, .model-unavailable-note {
  max-width: 180px;
  margin: 0;
  font-size: 10px;
  line-height: 1.4;
}
.model-public-note { color: #9ca3af; }
.model-unavailable-note { color: #f59e0b; }
.model-retry-button {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-decoration: underline;
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
.compact { gap: 5px; }
.compact .options-label { color: #71717a; }
.compact :deep(.el-select) { width: 112px; }
.compact :deep(.model-select) { width: 128px; }
.compact :deep(.duration-select) { width: 96px; }
.compact :deep(.duration-input) { width: 96px; }
</style>

<style>
.canvas-model-select-popper {
  z-index: 4200 !important;
}
</style>
