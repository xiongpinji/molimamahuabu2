<template>
  <span class="upload-actions">
    <input ref="fileInput" type="file" accept="image/*" hidden @change="onFileChange" />
    <el-button
      v-for="slot in slots"
      :key="slot"
      size="small"
      :loading="uploadingSlot === slot"
      :disabled="!!uploadingSlot"
      @click.stop="triggerUpload(slot)"
    >
      {{ labelFor(slot) }}
    </el-button>
  </span>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { imagesAPI } from '@/api/images'
import { uploadAPI } from '@/api/upload'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { dramaUsesFirstLastFrame } from '@/utils/storyboardMedia'

const props = defineProps({
  storyboard: { type: Object, required: true },
  nodeId: { type: String, default: '' },
  frameKind: { type: String, default: '' },
})

const ctx = useCanvasContext()
const fileInput = ref(null)
const uploadingSlot = ref('')
const activeSlot = ref('')

const useFirstLast = computed(() => (
  props.storyboard?.creation_mode !== 'universal'
) && dramaUsesFirstLastFrame(ctx?.drama?.value))

const slots = computed(() => {
  if (props.frameKind === 'first' || props.frameKind === 'last') return [props.frameKind]
  return useFirstLast.value ? ['first', 'last'] : ['main']
})

function labelFor(slot) {
  if (slot === 'first') return '上传首帧'
  if (slot === 'last') return '上传尾帧'
  return '上传图片'
}

function triggerUpload(slot) {
  activeSlot.value = slot
  if (fileInput.value) {
    fileInput.value.value = ''
    fileInput.value.click()
  }
}

async function onFileChange(event) {
  const file = event.target?.files?.[0]
  const drama = ctx?.drama?.value
  const storyboardId = props.storyboard?.id
  const slot = activeSlot.value || 'main'
  if (!file || !drama?.id || !storyboardId) return

  uploadingSlot.value = slot
  const statusIds = [props.nodeId, `sb:${storyboardId}`].filter(Boolean)
  statusIds.forEach((id) => ctx?.nodeStatus?.set(id, { step: 'upload', message: `${labelFor(slot)}中…` }))
  try {
    const uploadedFile = await uploadAPI.uploadImage(file, { dramaId: drama.id })
    const url = uploadedFile?.url || uploadedFile?.path || ''
    const localPath = uploadedFile?.local_path || ''
    if (!url && !localPath) throw new Error('上传未返回地址')

    await imagesAPI.upload({
      storyboard_id: storyboardId,
      drama_id: drama.id,
      image_url: url,
      local_path: localPath || undefined,
      frame_type: slot === 'first' ? 'storyboard_first' : slot === 'last' ? 'storyboard_last' : undefined,
    })
    ElMessage.success(`${labelFor(slot)}成功`)
    await ctx?.refresh?.()
  } catch (e) {
    ElMessage.error(e?.message || '上传失败')
  } finally {
    statusIds.forEach((id) => ctx?.nodeStatus?.clear(id))
    uploadingSlot.value = ''
    activeSlot.value = ''
    if (event.target) event.target.value = ''
  }
}
</script>

<style scoped>
.upload-actions {
  display: inline-flex;
  gap: 6px;
}
</style>
