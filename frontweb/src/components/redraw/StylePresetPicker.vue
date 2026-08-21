<template>
  <section class="style-preset-picker">
    <el-segmented v-model="activeCategory" :options="categoryOptions" />

    <div
      ref="trackRef"
      class="preset-track"
      tabindex="0"
      @wheel.prevent="onWheel"
      @keydown.left.prevent="scrollActiveTrack(-1)"
      @keydown.right.prevent="scrollActiveTrack(1)"
    >
      <button
        v-for="preset in visiblePresets"
        :key="preset.id || preset.stable_key"
        type="button"
        class="preset-card"
        :class="{ active: selectedPresetId === preset.id }"
        @click="selectPreset(preset)"
      >
        <div class="preset-card__image">
          <img v-if="preset.preview_url || preset.url" :src="preset.preview_url || preset.url" :alt="preset.name" />
          <span v-else>{{ categoryLabel(activeCategory) }}</span>
        </div>
        <strong>{{ preset.name }}</strong>
      </button>
    </div>

    <div v-if="activeCategory === 'free'" class="free-style-panel">
      <label>
        <span>正向提示词</span>
        <el-input v-model="freeStyle.positivePrompt" type="textarea" :rows="3" placeholder="描述目标画面风格" />
      </label>
      <label>
        <span>负向提示词</span>
        <el-input v-model="freeStyle.negativePrompt" type="textarea" :rows="2" placeholder="不希望出现的内容" />
      </label>
      <label>
        <span>参考图</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" @change="onReferenceImageChange" />
      </label>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'

const PRESET_CARD_WIDTH = 156
const PRESET_IMAGE_HEIGHT = 104

const props = defineProps({
  presets: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['update:selectedPreset', 'update:freeStyle'])
const selectedPreset = defineModel('selectedPreset', { default: null })
const freeStyleModel = defineModel('freeStyle', { default: () => ({}) })

const activeCategory = ref('two_dimensional')
const trackRef = ref(null)
const selectedPresetId = ref(null)
const scrollLeftByCategory = reactive({})
const freeStyle = reactive({
  positivePrompt: '',
  negativePrompt: '',
  referenceImage: null,
})

const categoryOptions = [
  { label: '二维动漫风', value: 'two_dimensional' },
  { label: '三维动漫风', value: 'three_dimensional' },
  { label: '真人写实风格', value: 'live_action' },
  { label: '自由风格', value: 'free' },
]

const categoryAliases = {
  two_dimensional: new Set(['two_dimensional', '2d_anime', 'anime_2d', '二维动漫风']),
  three_dimensional: new Set(['three_dimensional', '3d_anime', 'anime_3d', '三维动漫风']),
  live_action: new Set(['live_action', 'realistic', '真人写实风格']),
}

const visiblePresets = computed(() => {
  if (activeCategory.value === 'free') return []
  const aliases = categoryAliases[activeCategory.value] || new Set([activeCategory.value])
  return props.presets.filter((preset) => aliases.has(String(preset.category || '')))
})

function categoryLabel(value) {
  return categoryOptions.find((item) => item.value === value)?.label || '风格'
}

function selectPreset(preset) {
  selectedPreset.value = preset
  selectedPresetId.value = preset?.id || null
  freeStyle.positivePrompt = ''
  freeStyle.negativePrompt = ''
  freeStyle.referenceImage = null
  emit('update:selectedPreset', preset)
}

function onWheel(event) {
  if (!trackRef.value) return
  trackRef.value.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  scrollLeftByCategory[activeCategory.value] = trackRef.value.scrollLeft
}

function scrollActiveTrack(direction) {
  if (!trackRef.value) return
  trackRef.value.scrollBy({ left: direction * (PRESET_CARD_WIDTH + 12), behavior: 'smooth' })
  scrollLeftByCategory[activeCategory.value] = trackRef.value.scrollLeft + direction * (PRESET_CARD_WIDTH + 12)
}

function onReferenceImageChange(event) {
  freeStyle.referenceImage = event.target.files?.[0] || null
}

watch(activeCategory, async (next, previous) => {
  if (trackRef.value && previous) scrollLeftByCategory[previous] = trackRef.value.scrollLeft
  if (next === 'free') {
    selectedPreset.value = null
    selectedPresetId.value = null
    emit('update:selectedPreset', null)
  }
  await nextTick()
  if (trackRef.value) trackRef.value.scrollLeft = scrollLeftByCategory[next] || 0
})

watch(freeStyle, () => {
  freeStyleModel.value = { ...freeStyle }
  emit('update:freeStyle', { ...freeStyle })
}, { deep: true })
</script>

<style scoped>
.style-preset-picker {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  min-width: 0;
}

.preset-track {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 156px;
  grid-template-columns: repeat(auto-fill, 156px);
  gap: 12px;
  max-width: 100%;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  padding-bottom: 8px;
}

.style-preset-picker :deep(.el-segmented) {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow-x: auto;
}

.preset-card {
  display: grid;
  grid-template-rows: 104px 38px;
  gap: 8px;
  width: 156px;
  min-width: 156px;
  border: 1px solid #2e2e2e;
  border-radius: 8px;
  background: #171717;
  color: #f4f4f4;
  padding: 0;
  overflow: hidden;
  cursor: pointer;
}

.preset-card.active {
  border-color: #ff7139;
  box-shadow: 0 0 0 1px #ff7139 inset;
}

.preset-card__image {
  display: grid;
  place-items: center;
  width: 156px;
  height: 104px;
  background: #222;
  color: #8f8f8f;
  font-size: 12px;
}

.preset-card__image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preset-card strong {
  display: -webkit-box;
  padding: 0 10px;
  overflow: hidden;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  line-clamp: 2;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.free-style-panel {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.free-style-panel label {
  display: grid;
  gap: 8px;
  color: #d8d8d8;
  font-size: 13px;
}

.free-style-panel label:first-child {
  grid-column: 1 / -1;
}

.free-style-panel input {
  color: #d8d8d8;
}

@media (max-width: 720px) {
  .free-style-panel {
    grid-template-columns: 1fr;
  }
}
</style>
