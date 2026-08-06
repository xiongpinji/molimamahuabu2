<template>
  <div class="voice-picker">
    <label for="redraw-voice-select">目标音色</label>
    <div class="voice-row">
      <el-select id="redraw-voice-select" v-model="selected" placeholder="选择已验证音色" @change="emit('select', selected)">
        <el-option v-for="voice in voices" :key="voice.id" :label="voice.localized_name || voice.voice_id || `音色 ${voice.id}`" :value="voice.id" />
      </el-select>
      <el-button :disabled="!selectedVoice?.preview_url" :icon="VideoPlay" @click="emit('preview', selectedVoice)">试听</el-button>
    </div>
    <audio v-if="selectedVoice?.preview_url" :src="selectedVoice.preview_url" controls preload="none" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { VideoPlay } from '@element-plus/icons-vue'

const props = defineProps({ voices: { type: Array, default: () => [] } })
const emit = defineEmits(['select', 'preview'])
const selected = ref(null)
const selectedVoice = computed(() => props.voices.find((voice) => String(voice.id) === String(selected.value)))
</script>

<style scoped>
.voice-picker { display: grid; gap: 8px; }
.voice-picker label { color: #d8d8d8; font-size: 13px; }
.voice-row { display: flex; gap: 8px; min-width: 0; }
.voice-row :deep(.el-select) { min-width: 0; flex: 1; }
audio { width: 100%; height: 32px; }
</style>
