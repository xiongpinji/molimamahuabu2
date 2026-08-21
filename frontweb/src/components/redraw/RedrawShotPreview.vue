<template>
  <section v-if="shot" class="shot-preview">
    <header>
      <div>
        <p class="eyebrow">同时间码对照</p>
        <h3>{{ formatTimecode(shot.start_ms) }} — {{ formatTimecode(shot.end_ms) }}</h3>
      </div>
      <div class="preview-toggle" role="group" aria-label="原片新片切换">
        <button type="button" :class="{ active: mode === 'source' }" @click="mode = 'source'">原片</button>
        <button type="button" :class="{ active: mode === 'generated' }" :disabled="!generatedReady" @click="mode = 'generated'">新片</button>
      </div>
    </header>
    <div class="video-frame">
      <video
        v-if="activeUrl"
        :key="`${mode}-${shot.id}-${activeUrl}`"
        :src="videoUrlAtTime(activeUrl, shot.start_ms)"
        :poster="activePoster"
        controls
        preload="metadata"
      />
      <div v-else class="preview-empty">
        <el-icon><VideoCamera /></el-icon>
        <strong>{{ mode === 'generated' ? '后端尚未返回可读新片' : '源片预览暂不可用' }}</strong>
        <span>预览仅使用后端返回的 source_video_ref / new_video_ref</span>
      </div>
    </div>
    <div v-if="shot.generation?.status" class="task-progress">
      <span>{{ shot.generation.message || shot.generation.status }}</span>
      <el-progress :percentage="Number(shot.generation.progress) || 0" :stroke-width="6" color="#ff7139" />
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { VideoCamera } from '@element-plus/icons-vue'
import { formatTimecode } from '@/utils/redrawShotState'

const props = defineProps({ shot: { type: Object, default: null } })
const mode = ref('source')

function refUrl(reference) {
  if (typeof reference === 'string') return reference
  return reference?.url || reference?.video_url || reference?.playback_url || reference?.download_url || ''
}

function refPoster(reference) {
  return typeof reference === 'object' ? reference?.thumbnail_url || reference?.poster_url || '' : ''
}

function videoUrlAtTime(url, startMs) {
  const separator = String(url).includes('#') ? '&' : '#'
  return `${url}${separator}t=${Math.max(0, Number(startMs) || 0) / 1000}`
}

const sourceUrl = computed(() => refUrl(props.shot?.source_video_ref))
const generatedReady = computed(() => props.shot?.status === 'completed' && Boolean(refUrl(props.shot?.new_video_ref)))
const generatedUrl = computed(() => generatedReady.value ? refUrl(props.shot?.new_video_ref) : '')
const activeUrl = computed(() => mode.value === 'generated' ? generatedUrl.value : sourceUrl.value)
const activePoster = computed(() => mode.value === 'generated'
  ? refPoster(props.shot?.new_video_ref)
  : refPoster(props.shot?.source_video_ref))

watch(() => [props.shot?.id, generatedReady.value], () => {
  if (!generatedReady.value || mode.value === 'generated') mode.value = 'source'
})
</script>

<style scoped>
.shot-preview { display: grid; gap: 12px; min-width: 0; padding: 16px; border: 1px solid #2c2c2c; border-radius: 8px; background: #121212; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
.preview-toggle { display: grid; grid-template-columns: repeat(2, minmax(54px, 1fr)); gap: 5px; }
.preview-toggle button { padding: 7px 10px; border: 1px solid #333; border-radius: 6px; background: #1b1b1b; color: #aaa; }
.preview-toggle button.active { border-color: #ff7139; color: #fff; }
.preview-toggle button:disabled { opacity: .4; }
.video-frame { position: relative; min-width: 0; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 7px; background: #050505; }
.video-frame video { display: block; width: 100%; height: 100%; object-fit: contain; }
.preview-empty { display: grid; place-content: center; justify-items: center; gap: 8px; box-sizing: border-box; height: 100%; padding: 18px; color: #7f7f7f; text-align: center; }
.preview-empty :deep(.el-icon) { font-size: 28px; }
.preview-empty span { max-width: 100%; font-size: 12px; overflow-wrap: anywhere; }
.task-progress { display: grid; gap: 6px; color: #aaa; font-size: 12px; }
@media (max-width: 520px) { header { flex-direction: column; } .preview-toggle { width: 100%; } }
</style>
