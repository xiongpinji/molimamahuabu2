<template>
  <div class="voice-picker">
    <div class="voice-field">
      <label for="redraw-character-select">目标角色</label>
      <el-select id="redraw-character-select" v-model="selectedCharacterId" placeholder="选择要绑定音色的角色">
        <el-option v-for="character in characters" :key="character.id" :label="character.localized_name || `角色 ${character.id}`" :value="character.id" />
      </el-select>
    </div>
    <div class="voice-field">
      <label for="redraw-voice-select">已验证音色</label>
      <div class="voice-row">
        <el-select id="redraw-voice-select" v-model="selectedVoiceId" :disabled="hasBinding" placeholder="选择已验证音色" @change="voiceChanged">
          <el-option v-for="voice in voices" :key="voice.id" :label="voice.localized_name || voice.voice_id || `音色 ${voice.id}`" :value="voice.id" />
        </el-select>
        <el-button
          :disabled="!selectedVoice?.preview_url"
          :icon="isPreviewing ? VideoPause : VideoPlay"
          :aria-pressed="isPreviewing"
          @click="emit('preview', selectedVoice)"
        >{{ isPreviewing ? '暂停' : '试听' }}</el-button>
      </div>
    </div>
    <div class="binding-row">
      <el-tag v-if="hasBinding" type="success">已绑定 {{ boundVoiceLabel }}</el-tag>
      <span v-else class="binding-hint">仅可绑定当前版本中通过真实 TTS 与可读性验证的音色</span>
      <el-button type="primary" :loading="loading" :disabled="!canAssign" @click="assign">
        {{ hasBinding ? '已绑定' : '绑定音色' }}
      </el-button>
    </div>
    <p v-if="!characters.length" class="empty-hint">当前版本暂无可绑定角色</p>
    <p v-else-if="!voices.length" class="empty-hint">当前版本暂无已验证音色</p>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { VideoPause, VideoPlay } from '@element-plus/icons-vue'

const props = defineProps({
  characters: { type: Array, default: () => [] },
  voices: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  previewingVoiceId: { type: [String, Number], default: null },
})
const emit = defineEmits(['assign', 'preview', 'preview-stop'])
const selectedCharacterId = ref(null)
const selectedVoiceId = ref(null)
const selectedCharacter = computed(() => props.characters.find((character) => String(character.id) === String(selectedCharacterId.value)))
const selectedVoice = computed(() => props.voices.find((voice) => String(voice.id) === String(selectedVoiceId.value)))
const voiceSnapshot = computed(() => selectedCharacter.value?.snapshot?.voice_snapshot || null)
const boundVoice = computed(() => {
  const snapshot = voiceSnapshot.value
  if (!snapshot) return null
  return props.voices.find((voice) => (
    String(voice.voice_id || '') === String(snapshot.voice_id || '')
    && Number(voice.audio_asset_id) === Number(snapshot.audio_asset_id)
  )) || null
})
const hasBinding = computed(() => Boolean(voiceSnapshot.value))
const isPreviewing = computed(() => selectedVoice.value != null
  && props.previewingVoiceId != null
  && String(selectedVoice.value.id) === String(props.previewingVoiceId))
const boundVoiceLabel = computed(() => boundVoice.value?.localized_name || voiceSnapshot.value?.voice_id || '现有音色')
const canAssign = computed(() => Boolean(
  selectedCharacter.value
  && selectedVoice.value
  && !hasBinding.value
  && !props.loading,
))

function assign() {
  if (!canAssign.value) return
  const assignment = {
    character_asset_id: selectedCharacter.value.id,
    voice_asset_id: selectedVoice.value.id,
  }
  if (selectedCharacter.value.updated_at) {
    assignment.expected_updated_at = selectedCharacter.value.updated_at
  }
  emit('assign', assignment)
}

function voiceChanged() {
  if (props.previewingVoiceId != null
    && String(props.previewingVoiceId) !== String(selectedVoiceId.value)) {
    emit('preview-stop')
  }
}

watch(() => props.characters, (characters) => {
  if (characters.some((character) => String(character.id) === String(selectedCharacterId.value))) return
  selectedCharacterId.value = characters[0]?.id ?? null
}, { immediate: true })

watch([selectedCharacter, () => props.voices], ([nextCharacter], previousValues = []) => {
  const previousCharacter = previousValues?.[0]
  if (previousCharacter
    && String(nextCharacter?.id) !== String(previousCharacter?.id)
    && props.previewingVoiceId != null) {
    emit('preview-stop')
  }
  selectedVoiceId.value = boundVoice.value?.id ?? null
}, { immediate: true })
</script>

<style scoped>
.voice-picker { display: grid; gap: 12px; padding: 14px; border: 1px solid #333; border-radius: 6px; background: #141414; }
.voice-field { display: grid; gap: 6px; min-width: 0; }
.voice-picker label { color: #d8d8d8; font-size: 13px; }
.voice-row { display: flex; gap: 8px; min-width: 0; }
.voice-row :deep(.el-select) { min-width: 0; flex: 1; }
.binding-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.binding-hint, .empty-hint { margin: 0; color: #888; font-size: 12px; overflow-wrap: anywhere; }
@media (max-width: 640px) { .voice-row, .binding-row { align-items: stretch; flex-direction: column; } }
</style>
