<template>
  <div
    ref="toolbarRef"
    class="video-node-toolbar nodrag nopan"
    @click.stop
    @mousedown.stop
  >
    <button type="button" :disabled="nodeBusy || !operationAvailable('crop')" :title="operationTitle('crop')" @click="openRegionEditor('crop')">▧ 裁剪</button>
    <button type="button" :disabled="nodeBusy || !operationAvailable('upscale')" :title="operationTitle('upscale')" @click="openUpscale">▣ 高清</button>
    <button type="button" :disabled="nodeBusy || !operationAvailable('analyze')" :title="operationTitle('analyze')" @click="runAnalyze">▯ 解析</button>
    <button type="button" :disabled="nodeBusy || !operationAvailable('remove_subtitles')" :title="operationTitle('remove_subtitles')" @click="openRegionEditor('remove_subtitles')">⌁ 框选去字幕</button>

    <div class="toolbar-menu-wrap">
      <button type="button" :disabled="nodeBusy || !operationAvailable('extract_audio')" :title="operationTitle('extract_audio')" @click="toggleMenu('audio')">♫ 音频分离⌄</button>
      <div v-if="openMenu === 'audio'" class="toolbar-menu">
        <button type="button" :disabled="!operationAvailable('extract_audio')" @click="submitDirect('extract_audio')">提取音频为新节点</button>
        <button type="button" :disabled="!operationAvailable('mute')" @click="submitDirect('mute')">生成无声视频</button>
      </div>
    </div>

    <div class="toolbar-menu-wrap">
      <button type="button" :disabled="nodeBusy || !operationAvailable('edit')" :title="operationTitle('edit')" @click="toggleMenu('edit')">✎ 画面编辑⌄</button>
      <div v-if="openMenu === 'edit'" class="toolbar-menu">
        <button type="button" @click="openEdit('mirror-horizontal')">水平镜像</button>
        <button type="button" @click="openEdit('mirror-vertical')">垂直镜像</button>
        <button type="button" @click="openEdit('rotate-clockwise')">顺时针旋转</button>
        <button type="button" @click="openEdit('none')">调色与速度</button>
      </div>
    </div>

    <span class="toolbar-separator" />
    <span
      v-if="capabilitiesError"
      class="toolbar-capability-error"
      role="status"
      :title="capabilitiesError"
    >视频工具不可用</span>
    <button type="button" title="下载视频" aria-label="下载视频" @click="downloadVideo">⇩</button>
    <button type="button" title="全屏预览" aria-label="全屏预览" @click="requestFullscreen">⛶</button>

    <div v-if="data.videoToolStatus === 'failed' && data.videoToolError" class="toolbar-error" role="alert">
      <span>{{ data.videoToolError }}</span>
      <button type="button" :disabled="nodeBusy || !data.videoToolRetryOperation" @click="retryLastOperation">重试</button>
    </div>

    <el-dialog
      v-model="regionVisible"
      class="video-tool-dialog"
      :title="regionOperation === 'crop' ? '裁剪视频' : '框选去字幕（非 OCR）'"
      width="min(920px, calc(100vw - 32px))"
      append-to-body
      destroy-on-close
      :close-on-click-modal="false"
    >
      <div
        ref="regionStage"
        class="region-stage"
        :style="regionStageStyle"
        @pointerdown="startRegionDraw"
        @pointermove="moveRegionDraw"
        @pointerup="finishRegionDraw"
        @pointercancel="finishRegionDraw"
      >
        <video :src="sourceUrl" muted controls playsinline @loadedmetadata="readVideoMetadata" />
        <div class="region-selection" :style="regionStyle" @pointerdown.stop="startRegionMove">
          <span>{{ region.width }} × {{ region.height }}</span>
          <i
            v-for="handle in regionHandles"
            :key="handle"
            class="region-handle"
            :class="`handle-${handle}`"
            aria-hidden="true"
            @pointerdown.stop="startRegionResize($event, handle)"
          />
        </div>
      </div>
      <p class="tool-note">
        {{ regionOperation === 'crop'
          ? '在视频上拖拽选择保留区域，服务端使用 FFmpeg 生成新视频，源视频不变。'
          : '在视频上拖拽框住字幕区域；这是 FFmpeg delogo 选区修复，不做 OCR 识别，源视频不变。' }}
      </p>
      <div class="region-fields">
        <label>X <el-input-number v-model="region.x" :min="0" :max="Math.max(0, videoSize.width - 2)" /></label>
        <label>Y <el-input-number v-model="region.y" :min="0" :max="Math.max(0, videoSize.height - 2)" /></label>
        <label>宽 <el-input-number v-model="region.width" :min="2" :max="Math.max(2, videoSize.width - region.x)" /></label>
        <label>高 <el-input-number v-model="region.height" :min="2" :max="Math.max(2, videoSize.height - region.y)" /></label>
      </div>
      <template #footer>
        <el-button @click="regionVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitRegion">
          {{ regionOperation === 'crop' ? '生成裁剪视频' : '生成去字幕视频' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="upscaleVisible"
      class="video-tool-dialog"
      title="高清视频"
      width="520px"
      append-to-body
      :close-on-click-modal="false"
    >
      <el-form label-width="110px">
        <el-form-item label="输出分辨率">
          <el-radio-group v-model="upscale.resolution">
            <el-radio-button value="1080p">1080P</el-radio-button>
            <el-radio-button value="2k">2K</el-radio-button>
            <el-radio-button value="4k">4K</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="补帧至 60FPS">
          <el-switch v-model="upscale.interpolate" :disabled="!upscaleCapability.interpolateAvailable" />
        </el-form-item>
        <el-form-item label="慢动作">
          <el-select v-model="upscale.slowMotion">
            <el-option label="不变速" :value="1" />
            <el-option label="2 倍慢动作" :value="2" :disabled="!upscaleCapability.slowMotionAvailable" />
            <el-option label="4 倍慢动作" :value="4" :disabled="!upscaleCapability.slowMotionAvailable" />
          </el-select>
        </el-form-item>
      </el-form>
      <p class="tool-note">
        使用 FFmpeg Lanczos 缩放与锐化；可用的补帧和慢动作会实际重编码并生成新视频。
        <span v-if="!upscaleCapability.interpolateAvailable">当前 FFmpeg 未提供补帧滤镜。</span>
        <span v-if="!upscaleCapability.slowMotionAvailable">当前 FFmpeg 未提供慢动作所需滤镜。</span>
      </p>
      <template #footer>
        <el-button @click="upscaleVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitUpscale">生成高清视频</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="editVisible"
      class="video-tool-dialog"
      title="画面编辑"
      width="560px"
      append-to-body
      :close-on-click-modal="false"
    >
      <el-form label-width="90px">
        <el-form-item label="画面变换">
          <el-select v-model="edit.transform">
            <el-option label="不变换" value="none" />
            <el-option label="水平镜像" value="mirror-horizontal" />
            <el-option label="垂直镜像" value="mirror-vertical" />
            <el-option label="顺时针旋转" value="rotate-clockwise" />
            <el-option label="逆时针旋转" value="rotate-counterclockwise" />
            <el-option label="旋转 180°" value="rotate-180" />
          </el-select>
        </el-form-item>
        <el-form-item :label="`亮度 ${edit.brightness.toFixed(2)}`"><el-slider v-model="edit.brightness" :min="-1" :max="1" :step="0.05" /></el-form-item>
        <el-form-item :label="`对比度 ${edit.contrast.toFixed(2)}`"><el-slider v-model="edit.contrast" :min="0" :max="2" :step="0.05" /></el-form-item>
        <el-form-item :label="`饱和度 ${edit.saturation.toFixed(2)}`"><el-slider v-model="edit.saturation" :min="0" :max="3" :step="0.05" /></el-form-item>
        <el-form-item label="播放速度">
          <el-select v-model="edit.speed">
            <el-option label="0.5 倍" :value="0.5" />
            <el-option label="1 倍" :value="1" />
            <el-option label="1.5 倍" :value="1.5" />
            <el-option label="2 倍" :value="2" />
          </el-select>
        </el-form-item>
      </el-form>
      <p class="tool-note">所有变换、调色和变速都由 FFmpeg 应用到新视频，原视频不变。</p>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitEdit">生成编辑视频</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { videoToolsAPI } from '@/api/videoTools'

const props = defineProps({
  nodeId: { type: String, required: true },
  data: { type: Object, required: true },
  sourceUrl: { type: String, required: true },
})

const emit = defineEmits(['suspend-editor'])
const ctx = useCanvasContext()
const toolbarRef = ref(null)
const regionStage = ref(null)
const openMenu = ref('')
const submitting = ref(false)
const regionVisible = ref(false)
const upscaleVisible = ref(false)
const editVisible = ref(false)
const capabilities = ref({})
const capabilitiesError = ref('')
const regionOperation = ref('crop')
const videoSize = reactive({ width: 1920, height: 1080 })
const region = reactive({ x: 0, y: 0, width: 1920, height: 1080 })
const upscale = reactive({ resolution: '1080p', interpolate: false, slowMotion: 1 })
const edit = reactive({ transform: 'none', brightness: 0, contrast: 1, saturation: 1, speed: 1 })
const regionHandles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
let drawStart = null
let regionInteraction = null

const nodeBusy = computed(() => submitting.value
  || props.data.status === 'running'
  || props.data.videoToolStatus === 'running')
const upscaleCapability = computed(() => capabilities.value?.upscale || {})
const regionStyle = computed(() => ({
  left: `${(region.x / videoSize.width) * 100}%`,
  top: `${(region.y / videoSize.height) * 100}%`,
  width: `${(region.width / videoSize.width) * 100}%`,
  height: `${(region.height / videoSize.height) * 100}%`,
}))
const regionStageStyle = computed(() => {
  const ratio = Math.max(0.01, videoSize.width / videoSize.height)
  return {
    aspectRatio: `${videoSize.width} / ${videoSize.height}`,
    maxWidth: `min(100%, calc(58vh * ${ratio}))`,
  }
})

onMounted(async () => {
  try {
    const result = await videoToolsAPI.getCapabilities()
    capabilities.value = result?.operations || {}
    capabilitiesError.value = ''
  } catch {
    capabilities.value = {}
    capabilitiesError.value = '视频处理能力检查失败，请刷新后重试'
  }
})

function operationAvailable(operation) {
  return capabilities.value?.[operation]?.available === true
}

function operationTitle(operation) {
  if (capabilitiesError.value) return capabilitiesError.value
  const capability = capabilities.value?.[operation]
  if (!capability) return '正在检查本地视频处理能力'
  return capability.available ? '' : (capability.reason || '当前处理能力不可用')
}

function toggleMenu(name) {
  openMenu.value = openMenu.value === name ? '' : name
}

function normalizeEven(value, minimum = 0) {
  const rounded = Math.max(minimum, Math.round(Number(value) || 0))
  return rounded - (rounded % 2)
}

function readVideoMetadata(event) {
  videoSize.width = event.target.videoWidth || 1920
  videoSize.height = event.target.videoHeight || 1080
  if (regionOperation.value === 'crop') {
    region.x = 0
    region.y = 0
    region.width = normalizeEven(videoSize.width, 2)
    region.height = normalizeEven(videoSize.height, 2)
  } else {
    region.x = 0
    region.y = normalizeEven(videoSize.height * 0.72)
    region.width = normalizeEven(videoSize.width, 2)
    region.height = normalizeEven(videoSize.height * 0.2, 2)
  }
}

function pointerPosition(event) {
  const bounds = regionStage.value?.getBoundingClientRect()
  if (!bounds) return null
  return {
    x: Math.max(0, Math.min(videoSize.width, ((event.clientX - bounds.left) / bounds.width) * videoSize.width)),
    y: Math.max(0, Math.min(videoSize.height, ((event.clientY - bounds.top) / bounds.height) * videoSize.height)),
  }
}

function applyDraw(point) {
  if (!drawStart || !point) return
  const left = Math.min(drawStart.x, point.x)
  const top = Math.min(drawStart.y, point.y)
  region.x = normalizeEven(left)
  region.y = normalizeEven(top)
  region.width = normalizeEven(Math.max(2, Math.abs(point.x - drawStart.x)), 2)
  region.height = normalizeEven(Math.max(2, Math.abs(point.y - drawStart.y)), 2)
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function captureRegionPointer(event) {
  regionStage.value?.setPointerCapture?.(event.pointerId)
}

function startRegionDraw(event) {
  if (event.button !== 0) return
  event.preventDefault()
  regionInteraction = null
  drawStart = pointerPosition(event)
  captureRegionPointer(event)
  applyDraw(drawStart)
}

function moveRegionDraw(event) {
  const point = pointerPosition(event)
  if (drawStart) {
    applyDraw(point)
    return
  }
  if (!regionInteraction || !point) return
  const dx = point.x - regionInteraction.start.x
  const dy = point.y - regionInteraction.start.y
  const original = regionInteraction.original
  if (regionInteraction.type === 'move') {
    region.x = normalizeEven(clamp(original.x + dx, 0, videoSize.width - original.width))
    region.y = normalizeEven(clamp(original.y + dy, 0, videoSize.height - original.height))
    return
  }

  let left = original.x
  let top = original.y
  let right = original.x + original.width
  let bottom = original.y + original.height
  const handle = regionInteraction.handle
  if (handle.includes('w')) left = clamp(original.x + dx, 0, right - 2)
  if (handle.includes('e')) right = clamp(original.x + original.width + dx, left + 2, videoSize.width)
  if (handle.includes('n')) top = clamp(original.y + dy, 0, bottom - 2)
  if (handle.includes('s')) bottom = clamp(original.y + original.height + dy, top + 2, videoSize.height)
  region.x = normalizeEven(left)
  region.y = normalizeEven(top)
  region.width = normalizeEven(Math.max(2, right - region.x), 2)
  region.height = normalizeEven(Math.max(2, bottom - region.y), 2)
}

function finishRegionDraw(event) {
  moveRegionDraw(event)
  drawStart = null
  regionInteraction = null
  regionStage.value?.releasePointerCapture?.(event.pointerId)
}

function startRegionMove(event) {
  if (event.button !== 0) return
  regionInteraction = {
    type: 'move',
    start: pointerPosition(event),
    original: { ...region },
  }
  drawStart = null
  captureRegionPointer(event)
}

function startRegionResize(event, handle) {
  if (event.button !== 0) return
  regionInteraction = {
    type: 'resize',
    handle,
    start: pointerPosition(event),
    original: { ...region },
  }
  drawStart = null
  captureRegionPointer(event)
}

function openRegionEditor(operation) {
  emit('suspend-editor')
  openMenu.value = ''
  regionOperation.value = operation
  regionVisible.value = true
}

function openUpscale() {
  emit('suspend-editor')
  openMenu.value = ''
  upscaleVisible.value = true
}

function openEdit(transform) {
  emit('suspend-editor')
  openMenu.value = ''
  edit.transform = transform
  editVisible.value = true
}

async function execute(operation, parameters = {}) {
  if (typeof ctx?.runVideoNodeTool !== 'function') throw new Error('视频处理服务未接入当前画布')
  submitting.value = true
  try {
    const result = await ctx.runVideoNodeTool(props.nodeId, operation, parameters)
    ElMessage.success(operation === 'analyze' ? '视频解析完成' : '已生成新素材节点')
    return result
  } catch (error) {
    ElMessage.error(error?.message || '视频处理失败')
    throw error
  } finally {
    submitting.value = false
  }
}

async function submitRegion() {
  await execute(regionOperation.value, {
    x: normalizeEven(region.x),
    y: normalizeEven(region.y),
    width: normalizeEven(region.width, 2),
    height: normalizeEven(region.height, 2),
  })
  regionVisible.value = false
}

async function submitUpscale() {
  await execute('upscale', { ...upscale })
  upscaleVisible.value = false
}

async function submitEdit() {
  await execute('edit', { ...edit })
  editVisible.value = false
}

async function runAnalyze() {
  await execute('analyze', { sceneThreshold: 0.35, maxShots: 24 })
}

async function submitDirect(operation) {
  openMenu.value = ''
  await execute(operation)
}

async function retryLastOperation() {
  await execute(props.data.videoToolRetryOperation, props.data.videoToolRetryParameters || {})
}

function downloadVideo() {
  const link = document.createElement('a')
  link.href = props.sourceUrl
  link.download = `${props.data.title || 'video'}.mp4`
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function requestFullscreen() {
  const video = toolbarRef.value?.closest('.vue-flow__node')?.querySelector('.node-media')
  video?.requestFullscreen?.()
}
</script>

<style scoped>
.video-node-toolbar {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 13;
  display: none;
  align-items: center;
  gap: 3px;
  width: max-content;
  max-width: min(920px, calc(100vw - 32px));
  padding: 8px 10px;
  border: 1px solid #3f3f46;
  border-radius: 22px;
  background: rgba(27, 27, 29, 0.98);
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.48);
  transform: translateX(-50%);
}

:global(.home-canvas-node:hover .video-node-toolbar),
:global(.home-canvas-node.is-selected .video-node-toolbar),
:global(.vue-flow__node.selected .video-node-toolbar),
.video-node-toolbar:focus-within { display: flex; }

.video-node-toolbar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: #f4f4f5;
  font-size: 14px;
  cursor: pointer;
  white-space: nowrap;
}

.video-node-toolbar button:hover { background: #3f3f46; }
.video-node-toolbar button:disabled { cursor: wait; opacity: 0.5; }
.toolbar-separator { width: 1px; height: 24px; background: #3f3f46; }
.toolbar-capability-error { color: #fca5a5; font-size: 12px; white-space: nowrap; }
.toolbar-menu-wrap { position: relative; }
.toolbar-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 20;
  min-width: 190px;
  padding: 6px;
  border: 1px solid #3f3f46;
  border-radius: 12px;
  background: #202023;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.42);
}
.toolbar-menu button { width: 100%; justify-content: flex-start; }
.toolbar-error {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  display: flex;
  gap: 8px;
  min-width: 320px;
  padding: 8px 12px;
  border: 1px solid #7f1d1d;
  border-radius: 10px;
  background: #2c1517;
  color: #fecaca;
  transform: translateX(-50%);
}
.toolbar-error button { height: 26px; color: #fff; }
.region-stage {
  position: relative;
  overflow: hidden;
  width: 100%;
  margin: 0 auto;
  border-radius: 10px;
  background: #09090b;
  cursor: crosshair;
  user-select: none;
}
.region-stage video { display: block; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
.region-selection {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #f97316;
  background: rgba(249, 115, 22, 0.13);
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.42);
  cursor: move;
  pointer-events: auto;
}
.region-handle {
  position: absolute;
  width: 11px;
  height: 11px;
  border: 1px solid #fff;
  border-radius: 2px;
  background: #f97316;
}
.handle-nw { top: -7px; left: -7px; cursor: nwse-resize; }
.handle-n { top: -7px; left: calc(50% - 6px); cursor: ns-resize; }
.handle-ne { top: -7px; right: -7px; cursor: nesw-resize; }
.handle-e { top: calc(50% - 6px); right: -7px; cursor: ew-resize; }
.handle-se { right: -7px; bottom: -7px; cursor: nwse-resize; }
.handle-s { bottom: -7px; left: calc(50% - 6px); cursor: ns-resize; }
.handle-sw { bottom: -7px; left: -7px; cursor: nesw-resize; }
.handle-w { top: calc(50% - 6px); left: -7px; cursor: ew-resize; }
.region-selection span {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 12px;
}
.region-fields { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
.region-fields label { display: grid; gap: 5px; color: #d4d4d8; font-size: 13px; }
.tool-note { margin: 12px 0 0; color: #a1a1aa; line-height: 1.6; }
</style>
