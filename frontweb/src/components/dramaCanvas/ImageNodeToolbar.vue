<template>
  <div
    ref="toolbarRef"
    class="image-node-toolbar nodrag nopan"
    @click.stop
    @mousedown.stop
  >
    <button
      v-for="item in quickActions"
      :key="item.operation"
      type="button"
      :class="{ unavailable: !operationCapability(item.operation).available }"
      :disabled="nodeBusy || !operationCapability(item.operation).available"
      :title="operationTitle(item)"
      @click="selectOperation(item)"
    >
      {{ item.label }}
    </button>

    <div class="toolbar-menu-wrap">
      <button
        type="button"
        :disabled="nodeBusy"
        :title="busyTitle('工具')"
        @click="toggleMenu('tools')"
      >
        工具⌄
      </button>
      <div v-if="openMenu === 'tools'" class="toolbar-menu">
        <button
          v-for="item in toolActions"
          :key="item.label"
          type="button"
          :class="{ unavailable: !itemAvailable(item) }"
          :disabled="nodeBusy || !itemAvailable(item)"
          :title="itemTitle(item)"
          @click="selectOperation(item)"
        >
          {{ item.label }}
          <small v-if="!itemAvailable(item)">未接通</small>
        </button>
      </div>
    </div>

    <div class="toolbar-menu-wrap">
      <button
        type="button"
        :disabled="nodeBusy"
        :title="busyTitle('设定')"
        @click="toggleMenu('settings')"
      >
        设定⌄
      </button>
      <div v-if="openMenu === 'settings'" class="toolbar-menu settings-menu">
        <button
          v-for="item in settingActions"
          :key="item.operation"
          type="button"
          :class="{ unavailable: !operationCapability(item.operation).available }"
          :disabled="nodeBusy || !operationCapability(item.operation).available"
          :title="operationTitle(item)"
          @click="selectOperation(item)"
        >
          {{ item.label }}
          <small v-if="!operationCapability(item.operation).available">未接通</small>
        </button>
      </div>
    </div>

    <span class="toolbar-separator" />
    <button type="button" :title="busyTitle('标记色')" :disabled="nodeBusy" @click="cycleMarkerColor">
      <span class="marker-dot" :style="{ background: data.imageMarkerColor || markerColors[0] }" />
    </button>
    <button type="button" title="处理历史" @click="toggleHistory">◷</button>
    <button
      type="button"
      :title="busyTitle('替换图片')"
      :disabled="nodeBusy"
      @click="replaceInput?.click()"
    >
      ▧
    </button>
    <button type="button" title="下载图片" @click="downloadImage">⇩</button>
    <button type="button" title="全屏预览" @click="requestFullscreen">⛶</button>
    <input
      ref="replaceInput"
      class="replace-input"
      type="file"
      accept=".png,.jpg,.jpeg,.webp"
      @change="replaceImage"
    />

    <div
      v-if="data.imageToolStatus === 'failed' && data.imageToolError"
      class="toolbar-error"
      role="alert"
    >
      <span>{{ data.imageToolError }}</span>
      <button
        type="button"
        :disabled="nodeBusy || !data.imageToolRetryOperation"
        @click="retryLastOperation"
      >
        重试
      </button>
    </div>

    <div v-if="historyVisible" class="toolbar-history">
      <strong>处理历史</strong>
      <span v-if="!resolvedHistory.length">暂无记录</span>
      <div v-for="item in resolvedHistory" :key="item.taskId" class="history-item">
        <span>{{ operationLabel(item.operation) }}</span>
        <small>{{ item.status === 'completed' || item.status === 'success' ? '已完成' : item.status }}</small>
      </div>
    </div>

    <el-dialog
      v-model="editorVisible"
      class="image-tool-dialog"
      :title="operationLabel(editorOperation)"
      width="680px"
      destroy-on-close
      :close-on-click-modal="false"
      @closed="destroyCropper"
    >
      <div v-if="['crop', 'compress', 'mirror', 'rotate'].includes(editorOperation)" class="operation-tabs">
        <button
          v-for="item in primaryEditorOperations"
          :key="item.operation"
          type="button"
          :class="{ active: editorOperation === item.operation }"
          :disabled="nodeBusy"
          @click="switchEditorOperation(item.operation)"
        >
          {{ item.label }}
        </button>
      </div>

      <div v-if="['crop', 'selection_cutout'].includes(editorOperation)" class="crop-stage">
        <p v-if="editorOperation === 'selection_cutout'" class="crop-hint">
          框选需要保留的主体区域；本地抠图模型只处理该区域并生成透明 PNG。
        </p>
        <img ref="cropImage" :src="data.url" alt="框选预览" @load="initCropper" />
      </div>

      <el-form v-else label-position="top">
        <template v-if="editorOperation === 'upscale'">
          <el-form-item label="增强倍率">
            <el-select v-model="upscaleScale">
              <el-option label="2x" :value="2" />
              <el-option label="3x" :value="3" />
              <el-option label="4x" :value="4" />
            </el-select>
          </el-form-item>
          <p class="crop-hint">
            使用已审计的本地 Real-ESRGAN 生成 PNG 新素材；原图保持不变。
          </p>
        </template>

        <template v-else-if="editorOperation === 'compress'">
          <el-form-item label="输出格式">
            <el-select v-model="compressForm.format">
              <el-option label="WebP" value="webp" />
              <el-option label="JPEG" value="jpeg" />
              <el-option label="PNG" value="png" />
            </el-select>
          </el-form-item>
          <el-form-item :label="`质量 ${compressForm.quality}`">
            <el-slider v-model="compressForm.quality" :min="1" :max="100" />
          </el-form-item>
        </template>

        <el-form-item v-else-if="editorOperation === 'mirror'" label="镜像方向">
          <el-radio-group v-model="mirrorDirection">
            <el-radio-button value="horizontal">水平</el-radio-button>
            <el-radio-button value="vertical">垂直</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-else-if="editorOperation === 'rotate'" label="旋转角度">
          <el-radio-group v-model="rotateAngle">
            <el-radio-button :value="90">顺时针 90°</el-radio-button>
            <el-radio-button :value="180">180°</el-radio-button>
            <el-radio-button :value="270">逆时针 90°</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <template v-else-if="editorOperation === 'grid_crop'">
          <el-form-item label="行数">
            <el-input-number v-model="gridForm.rows" :min="1" :max="5" />
          </el-form-item>
          <el-form-item label="列数">
            <el-input-number v-model="gridForm.columns" :min="1" :max="5" />
          </el-form-item>
        </template>

        <template v-else-if="editorOperation === 'adjust'">
          <el-form-item :label="`亮度 ${adjustForm.brightness.toFixed(1)}`">
            <el-slider v-model="adjustForm.brightness" :min="0.1" :max="3" :step="0.1" />
          </el-form-item>
          <el-form-item :label="`饱和度 ${adjustForm.saturation.toFixed(1)}`">
            <el-slider v-model="adjustForm.saturation" :min="0" :max="3" :step="0.1" />
          </el-form-item>
          <el-form-item :label="`对比度 ${adjustForm.contrast.toFixed(1)}`">
            <el-slider v-model="adjustForm.contrast" :min="0.1" :max="3" :step="0.1" />
          </el-form-item>
          <el-form-item :label="`色温 ${Math.round(adjustForm.temperature * 100)}`">
            <el-slider v-model="adjustForm.temperature" :min="-1" :max="1" :step="0.1" />
          </el-form-item>
        </template>

        <el-form-item v-else-if="editorOperation === 'lut'" label="内置调色预设">
          <el-select v-model="lutPreset">
            <el-option label="电影感" value="cinematic" />
            <el-option label="暖色" value="warm" />
            <el-option label="冷色" value="cool" />
            <el-option label="黑白" value="mono" />
          </el-select>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="nodeBusy" @click="submitOperation">
          {{ submitting ? '处理中…' : '应用并生成新素材' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { imageToolsAPI } from '@/api/imageTools'
import { useCanvasContext } from '@/composables/useCanvasContext'

const props = defineProps({
  nodeId: { type: String, required: true },
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()
const toolbarRef = ref(null)
const replaceInput = ref(null)
const cropImage = ref(null)
const capabilities = ref({})
const openMenu = ref('')
const editorVisible = ref(false)
const editorOperation = ref('crop')
const submitting = ref(false)
const historyVisible = ref(false)
const resolvedHistory = ref([])
const markerColors = ['#a1a1aa', '#60a5fa', '#34d399', '#fbbf24', '#f87171']
const compressForm = ref({ format: 'webp', quality: 80 })
const mirrorDirection = ref('horizontal')
const rotateAngle = ref(90)
const gridForm = ref({ rows: 3, columns: 3 })
const adjustForm = ref({ brightness: 1, saturation: 1, contrast: 1, temperature: 0 })
const lutPreset = ref('cinematic')
const upscaleScale = ref(2)
let cropper = null
let CropperClass = null

const DIRECTOR_STAGE_OPERATIONS = new Set(['director_stage'])

const quickActions = [
  { label: '720全景', operation: 'panorama' },
  { label: '灯光', operation: 'lighting' },
  { label: '高清', operation: 'upscale' },
]

const primaryEditorOperations = [
  { label: '裁剪', operation: 'crop' },
  { label: '压缩', operation: 'compress' },
  { label: '镜像', operation: 'mirror' },
  { label: '旋转', operation: 'rotate' },
]

const toolActions = [
  { label: '裁剪/压缩/镜像', operation: 'crop' },
  { label: '标记修图', operation: 'markup_retouch' },
  { label: '宫格裁剪', operation: 'grid_crop' },
  { label: '智能抠图', operation: 'smart_cutout' },
  { label: '框选抠图', operation: 'selection_cutout' },
  { label: '图片调整', operation: 'adjust' },
  { label: 'LUT 调色', operation: 'lut' },
  { label: '生成导演台', operation: 'director_stage' },
  { label: '姿势', operation: 'pose' },
  { label: '角度', operation: 'angle' },
  { label: '扩图', operation: 'outpaint' },
  { label: '画面联想', operation: 'image_ideation' },
  { label: '角度联想', operation: 'angle_ideation' },
  { label: '对口型', operation: 'lip_sync' },
]

const settingActions = [
  { label: '生成全景场景', operation: 'panorama_scene' },
  { label: '角色三视图', operation: 'character_views' },
  { label: '多机位叙事九宫格', operation: 'narrative_grid' },
  { label: '画面推演-3秒后', operation: 'frame_forward' },
  { label: '画面推演-5秒前', operation: 'frame_backward' },
  { label: '电影级光影校正', operation: 'cinematic_relight' },
  { label: '细节纹理增强', operation: 'detail_enhance' },
]

const history = computed(() => Array.isArray(props.data.imageToolHistory)
  ? props.data.imageToolHistory
  : [])
const busyReason = '图片节点正在生成或处理，请稍后'
const nodeBusy = computed(() => submitting.value
  || props.data.status === 'running'
  || props.data.imageToolStatus === 'running')

onMounted(async () => {
  try {
    const result = await imageToolsAPI.getCapabilities()
    capabilities.value = result?.operations || {}
  } catch {
    capabilities.value = {}
  }
})

onBeforeUnmount(destroyCropper)

function operationCapability(operation) {
  return capabilities.value?.[operation] || {
    available: false,
    reason: '处理能力尚未从本地服务加载',
  }
}

function itemAvailable(item) {
  return operationCapability(item.operation).available
}

function operationTitle(item) {
  if (nodeBusy.value) return `${item.label}：${busyReason}`
  const capability = operationCapability(item.operation)
  return capability.available ? item.label : `${item.label}：${capability.reason}`
}

function itemTitle(item) {
  return operationTitle(item)
}

function busyTitle(label) {
  return nodeBusy.value ? `${label}：${busyReason}` : label
}

function toggleMenu(menu) {
  if (nodeBusy.value) return
  openMenu.value = openMenu.value === menu ? '' : menu
  historyVisible.value = false
}

function selectOperation(item) {
  openMenu.value = ''
  if (nodeBusy.value) return
  const capability = operationCapability(item.operation)
  if (!capability.available) {
    ElMessage.warning(capability.reason || '该能力尚未接通')
    return
  }
  if (DIRECTOR_STAGE_OPERATIONS.has(item.operation)) {
    ctx?.openDirectorStage?.({
      mode: item.operation,
      imageUrl: props.data.url,
      sourceNodeId: props.nodeId,
      sourceTitle: props.data.title || '图片节点',
    })
    return
  }
  editorOperation.value = item.operation
  editorVisible.value = true
  if (['crop', 'selection_cutout'].includes(item.operation)) nextTick(initCropper)
}

function switchEditorOperation(operation) {
  if (nodeBusy.value) return
  const capability = operationCapability(operation)
  if (!capability.available) {
    ElMessage.warning(capability.reason || '该能力尚未接通')
    return
  }
  destroyCropper()
  editorOperation.value = operation
  if (['crop', 'selection_cutout'].includes(operation)) nextTick(initCropper)
}

async function initCropper() {
  if (
    !editorVisible.value
    || !['crop', 'selection_cutout'].includes(editorOperation.value)
    || !cropImage.value
  ) return
  if (!CropperClass) {
    const [cropperModule] = await Promise.all([
      import('cropperjs'),
      import('cropperjs/dist/cropper.css'),
    ])
    CropperClass = cropperModule.default
  }
  if (
    !editorVisible.value
    || !['crop', 'selection_cutout'].includes(editorOperation.value)
    || !cropImage.value
  ) return
  destroyCropper()
  cropper = new CropperClass(cropImage.value, {
    viewMode: 1,
    autoCropArea: 0.85,
    background: false,
    responsive: true,
  })
}

function destroyCropper() {
  cropper?.destroy()
  cropper = null
}

function operationParameters() {
  if (['crop', 'selection_cutout'].includes(editorOperation.value)) {
    if (!cropper) throw new Error('裁剪器尚未就绪')
    const data = cropper.getData(true)
    return {
      left: data.x,
      top: data.y,
      width: data.width,
      height: data.height,
    }
  }
  if (editorOperation.value === 'compress') return { ...compressForm.value }
  if (editorOperation.value === 'mirror') return { direction: mirrorDirection.value }
  if (editorOperation.value === 'rotate') return { angle: rotateAngle.value }
  if (editorOperation.value === 'grid_crop') return { ...gridForm.value }
  if (editorOperation.value === 'adjust') return { ...adjustForm.value }
  if (editorOperation.value === 'lut') return { preset: lutPreset.value }
  if (editorOperation.value === 'upscale') return { scale: upscaleScale.value }
  return {}
}

async function submitOperation() {
  if (nodeBusy.value) return
  submitting.value = true
  try {
    await ctx?.runImageNodeTool?.(
      props.nodeId,
      editorOperation.value,
      operationParameters(),
    )
    editorVisible.value = false
    ElMessage.success('图片处理完成，已生成新素材')
  } catch (error) {
    ElMessage.error(error?.message || '图片处理失败')
  } finally {
    submitting.value = false
  }
}

async function retryLastOperation() {
  const operation = String(props.data.imageToolRetryOperation || '').trim()
  const parameters = props.data.imageToolRetryParameters
  if (!operation || !parameters || nodeBusy.value) return
  submitting.value = true
  try {
    await ctx?.runImageNodeTool?.(props.nodeId, operation, parameters)
    ElMessage.success('图片处理重试成功，已生成新素材')
  } catch (error) {
    ElMessage.error(error?.message || '图片处理重试失败')
  } finally {
    submitting.value = false
  }
}

function operationLabel(operation) {
  const labels = {
    crop: '裁剪',
    compress: '压缩',
    mirror: '镜像',
    rotate: '旋转',
    grid_crop: '宫格裁剪',
    smart_cutout: '智能抠图',
    selection_cutout: '框选抠图',
    upscale: '高清增强',
    adjust: '图片调整',
    lut: 'LUT 调色',
  }
  return labels[operation] || operation || '图片处理'
}

async function toggleHistory() {
  historyVisible.value = !historyVisible.value
  openMenu.value = ''
  if (!historyVisible.value) return
  resolvedHistory.value = await Promise.all(history.value.map(async (item) => {
    try {
      const task = await imageToolsAPI.getOperation(item.taskId)
      return { ...item, status: task?.status || item.status }
    } catch {
      return item
    }
  }))
}

function cycleMarkerColor() {
  const current = markerColors.indexOf(props.data.imageMarkerColor)
  const next = markerColors[(current + 1) % markerColors.length]
  ctx?.setFreeCanvasNodeMarker?.(props.nodeId, next)
}

async function replaceImage(event) {
  const file = event?.target?.files?.[0]
  if (!file) return
  try {
    await ctx?.replaceFreeCanvasNodeImage?.(props.nodeId, file)
    ElMessage.success('图片已替换并存入素材库')
  } catch (error) {
    ElMessage.error(error?.message || '替换图片失败')
  } finally {
    if (event?.target) event.target.value = ''
  }
}

function downloadImage() {
  const link = document.createElement('a')
  link.href = props.data.url
  const title = String(props.data.title || 'image').replace(/\.(png|jpe?g|webp)$/i, '')
  link.download = `${title}.${downloadExtension(props.data.url)}`
  link.rel = 'noopener'
  link.click()
}

function downloadExtension(url) {
  try {
    const pathname = new URL(url, window.location.origin).pathname
    const extension = pathname.match(/\.(png|jpe?g|webp)$/i)?.[1]?.toLowerCase()
    return extension === 'jpeg' ? 'jpg' : (extension || 'png')
  } catch {
    return 'png'
  }
}

function requestFullscreen() {
  const image = toolbarRef.value
    ?.closest('.vue-flow__node')
    ?.querySelector('.node-media')
  image?.requestFullscreen?.()
}
</script>

<style scoped>
.image-node-toolbar {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 12;
  display: none;
  align-items: center;
  gap: 2px;
  width: max-content;
  max-width: 760px;
  padding: 6px;
  border: 1px solid #3f3f46;
  border-radius: 999px;
  background: rgba(24, 24, 27, 0.98);
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.45);
  transform: translateX(-50%);
}

.home-canvas-node:hover .image-node-toolbar,
.vue-flow__node.selected .image-node-toolbar,
.image-node-toolbar:focus-within {
  display: flex;
}

.image-node-toolbar button {
  min-width: 32px;
  height: 30px;
  padding: 0 9px;
  border: 0;
  border-radius: 15px;
  background: transparent;
  color: #d4d4d8;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.image-node-toolbar button:hover {
  background: #3f3f46;
  color: #fff;
}

.image-node-toolbar button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.image-node-toolbar button:disabled:hover {
  background: transparent;
  color: inherit;
}

.image-node-toolbar button.unavailable {
  color: #71717a;
}

.toolbar-menu-wrap {
  position: relative;
}

.toolbar-menu {
  position: absolute;
  top: 38px;
  left: 0;
  z-index: 20;
  display: grid;
  width: 210px;
  max-height: 420px;
  padding: 8px;
  overflow: auto;
  border: 1px solid #3f3f46;
  border-radius: 14px;
  background: rgba(24, 24, 27, 0.99);
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.5);
}

.toolbar-menu button {
  display: flex;
  justify-content: space-between;
  width: 100%;
  border-radius: 8px;
  text-align: left;
}

.toolbar-menu small {
  color: #71717a;
}

.settings-menu {
  width: 230px;
}

.toolbar-separator {
  width: 1px;
  height: 22px;
  margin: 0 3px;
  background: #3f3f46;
}

.marker-dot {
  display: inline-block;
  width: 15px;
  height: 15px;
  border: 2px solid #d4d4d8;
  border-radius: 50%;
}

.replace-input {
  display: none;
}

.toolbar-error {
  position: absolute;
  top: 44px;
  left: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 360px;
  padding: 9px 10px;
  border: 1px solid #7f1d1d;
  border-radius: 10px;
  background: #2a1215;
  color: #fecaca;
  font-size: 12px;
}

.toolbar-error span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbar-error button {
  flex: 0 0 auto;
  border: 1px solid #b91c1c;
  color: #fecaca;
}

.toolbar-history {
  position: absolute;
  top: 44px;
  right: 0;
  display: grid;
  gap: 6px;
  width: 230px;
  padding: 12px;
  border: 1px solid #3f3f46;
  border-radius: 12px;
  background: #18181b;
  color: #d4d4d8;
  font-size: 12px;
}

.history-item {
  display: flex;
  justify-content: space-between;
  color: #a1a1aa;
}

.operation-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.operation-tabs button {
  height: 32px;
  padding: 0 16px;
  border: 1px solid #d4d4d8;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.operation-tabs button.active {
  border-color: #6366f1;
  background: #6366f1;
  color: white;
}

.crop-stage {
  height: 430px;
  overflow: hidden;
  background: #09090b;
}

.crop-hint {
  margin: 0;
  padding: 10px 14px;
  color: #d4d4d8;
  background: #18181b;
}

.crop-stage img {
  display: block;
  max-width: 100%;
}
</style>
