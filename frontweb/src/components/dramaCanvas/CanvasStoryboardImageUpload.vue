<template>
  <span class="upload-actions">
    <input ref="fileInput" type="file" accept="image/*" hidden @change="onFileChange" />
    <el-button
      v-for="slot in slots"
      :key="slot"
      size="small"
      :loading="uploadingSlot === slot"
      :disabled="disabled || !!uploadingSlot"
      @click.stop="triggerUpload(slot)"
    >
      {{ labelFor(slot) }}
    </el-button>
    <el-button size="small" :disabled="disabled || !!uploadingSlot" @click.stop="openLibrary">
      素材库
    </el-button>
    <AssetPickerDialog
      v-model="libraryVisible"
      type="image"
      title="从素材库选首帧/图片"
      :drama-id="ctx?.drama?.value?.id"
      @pick="onLibraryPick"
    />
  </span>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { imagesAPI } from '@/api/images'
import { uploadAPI } from '@/api/upload'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { dramaUsesFirstLastFrame } from '@/utils/storyboardMedia'
import AssetPickerDialog from '@/components/AssetPickerDialog.vue'

const props = defineProps({
  storyboard: { type: Object, required: true },
  nodeId: { type: String, default: '' },
  frameKind: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['status'])

const ctx = useCanvasContext()
const fileInput = ref(null)
const uploadingSlot = ref('')
const activeSlot = ref('')
const libraryVisible = ref(false)

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
  if (props.disabled) return
  activeSlot.value = slot
  if (fileInput.value) {
    fileInput.value.value = ''
    fileInput.value.click()
  }
}

function openLibrary() {
  if (props.disabled) return
  // 单槽位直接用该槽位；多槽位默认首帧（用户可先点对应上传按钮切换槽位语义，此处取第一个）
  activeSlot.value = slots.value[0] || 'main'
  libraryVisible.value = true
}

/** 素材库选图：与文件上传同一通路（imagesAPI.upload），零重新上传 */
async function onLibraryPick(asset) {
  const drama = ctx?.drama?.value
  const storyboardId = props.storyboard?.id
  const slot = activeSlot.value || 'main'
  if (!drama?.id || !storyboardId) return
  const url = asset.display_url || asset.url || ''
  const localPath = asset.local_path || ''
  if (!url && !localPath) return ElMessage.error('该素材缺少可用地址')
  uploadingSlot.value = slot
  emit('status', { type: 'busy', message: '素材库引用中…' })
  const statusIds = [props.nodeId, `sb:${storyboardId}`].filter(Boolean)
  statusIds.forEach((id) => ctx?.nodeStatus?.set(id, { step: 'upload', message: `素材库引用中…` }))
  try {
    await imagesAPI.upload({
      storyboard_id: storyboardId,
      drama_id: drama.id,
      image_url: url,
      local_path: localPath || undefined,
      frame_type: slot === 'first' ? 'storyboard_first' : slot === 'last' ? 'storyboard_last' : undefined,
    })
    emit('status', { type: 'success', message: '素材库图片引用完成' })
    ElMessage.success('已从素材库引用图片')
    await ctx?.refresh?.()
  } catch (e) {
    emit('status', { type: 'error', message: e?.message || '引用失败' })
    ElMessage.error(e?.message || '引用失败')
  } finally {
    statusIds.forEach((id) => ctx?.nodeStatus?.clear(id))
    uploadingSlot.value = ''
  }
}

async function onFileChange(event) {
  const file = event.target?.files?.[0]
  const drama = ctx?.drama?.value
  const storyboardId = props.storyboard?.id
  const slot = activeSlot.value || 'main'
  if (!file || !drama?.id || !storyboardId) return

  uploadingSlot.value = slot
  emit('status', { type: 'busy', message: `${labelFor(slot)}中…` })
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
    emit('status', { type: 'success', message: `${labelFor(slot)}成功` })
    ElMessage.success(`${labelFor(slot)}成功`)
    await ctx?.refresh?.()
  } catch (e) {
    emit('status', { type: 'error', message: e?.message || '上传失败' })
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
