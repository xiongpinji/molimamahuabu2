<template>
  <section class="player-compare">
    <header>
      <strong>预览对照</strong>
      <div role="group" aria-label="预览切换">
        <button type="button" :class="{ active: mode === 'source' }" aria-label="预览原片" @click="mode = 'source'">原片</button>
        <button type="button" :class="{ active: mode === 'export' }" :disabled="!mp4Export" aria-label="预览新成片" @click="mode = 'export'">新成片</button>
      </div>
    </header>
    <video v-if="previewUrl" :src="previewUrl" controls playsinline />
    <div v-else class="empty">合成完成后通过鉴权下载接口生成预览。</div>
    <footer>
      <el-switch v-model="showSubtitles" aria-label="字幕预览开关" active-text="字幕" />
      <el-switch v-model="showDubbing" aria-label="外语配音预览开关" active-text="外语配音" />
      <span>开关只影响预览 UI，不改源片。</span>
    </footer>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { redrawAPI } from '@/api/redraw'
import { exportByKind } from '@/utils/redrawTimelineState'

const props = defineProps({
  versionId: { type: [String, Number], default: null },
  sourceUrl: { type: String, default: '' },
  exports: { type: Array, default: () => [] },
})

const mode = ref('source')
const showSubtitles = ref(true)
const showDubbing = ref(true)
const objectUrl = ref('')
const loadingKey = ref('')
const mp4Export = computed(() => exportByKind(props.exports, 'mp4'))
const previewUrl = computed(() => mode.value === 'source' ? props.sourceUrl : objectUrl.value)

function clearObjectUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

async function loadExportPreview() {
  if (mode.value !== 'export' || !props.versionId || !mp4Export.value?.id) {
    if (mode.value !== 'export') clearObjectUrl()
    return
  }
  const key = `${props.versionId}:${mp4Export.value.id}`
  if (loadingKey.value === key && objectUrl.value) return
  loadingKey.value = key
  clearObjectUrl()
  const blob = await redrawAPI.downloadExport(props.versionId, mp4Export.value.id)
  objectUrl.value = URL.createObjectURL(blob)
}

watch(() => [mode.value, props.versionId, mp4Export.value?.id], loadExportPreview)
onBeforeUnmount(clearObjectUrl)
</script>

<style scoped>
.player-compare {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  background: #121212;
}

header,
footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

button {
  margin-left: 6px;
  padding: 7px 10px;
  border: 1px solid #333;
  border-radius: 7px;
  background: #1c1c1c;
  color: #eee;
}

button.active {
  border-color: #ff7139;
}

button:disabled {
  opacity: .45;
}

video {
  width: 100%;
  max-height: 56vh;
  border-radius: 8px;
  background: #000;
  object-fit: contain;
}

.empty {
  min-height: 220px;
  display: grid;
  place-items: center;
  border: 1px dashed #333;
  border-radius: 8px;
  color: #999;
  text-align: center;
  overflow-wrap: anywhere;
}

footer span {
  color: #999;
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
