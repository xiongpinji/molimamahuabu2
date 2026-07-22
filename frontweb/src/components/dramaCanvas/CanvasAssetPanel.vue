<template>
  <div
    class="canvas-node-panel asset-panel nodrag nopan nowheel"
    :class="'kind-' + kind"
    @pointerdown.stop
    @mousedown.stop
    @click.stop
    @mouseup.stop
    @wheel.stop
  >
    <div class="panel-head">
      <span>{{ kindLabel }}</span>
      <el-button link size="small" @click.stop="closePanel">收起</el-button>
    </div>

    <div class="panel-body">
      <div class="preview-col">
        <div class="preview-box">
          <img v-if="previewUrl && !generating" :src="previewUrl" alt="" />
          <div v-else-if="!generating" class="preview-empty">{{ kindIcon }}</div>
          <div v-if="generating || nodeBusy" class="preview-loading">
            <span class="spinner" />
            <span>{{ nodeBusy?.message || '生成参考图…' }}</span>
          </div>
        </div>
        <div v-if="entityStatus" class="entity-status" :class="'st-' + entityStatus">{{ entityStatusLabel }}</div>
        <div v-if="kind === 'scene' && panoramaUrl" class="panorama-preview">
          <img :src="panoramaUrl" alt="场景全景图" />
          <span>全景图</span>
        </div>
        <div v-if="kind === 'character' && multiViewUrl" class="panorama-preview multi-view-preview">
          <img :src="multiViewUrl" alt="角色三视图" />
          <span>三视图参考</span>
        </div>
      </div>

      <div class="form-col">
        <el-form label-position="left" label-width="44px" size="small" class="panel-form compact-form">
          <template v-if="kind === 'character'">
            <div class="form-row-2">
              <el-form-item label="名称" class="flex-1">
                <el-input v-model="form.name" placeholder="角色名" />
              </el-form-item>
              <el-form-item label="类型" class="type-field">
                <el-select
                  v-model="form.role"
                  clearable
                  placeholder="类型"
                  teleported
                  popper-class="canvas-panel-popper"
                  @visible-change="onSelectVisibleChange"
                >
                  <el-option label="主角" value="main" />
                  <el-option label="配角" value="supporting" />
                </el-select>
              </el-form-item>
            </div>
            <el-form-item label="外貌">
              <el-input
                v-model="form.appearance"
                type="textarea"
                :rows="2"
                resize="vertical"
                placeholder="外貌描述"
              />
            </el-form-item>
            <el-form-item label="简介">
              <el-input
                v-model="form.description"
                type="textarea"
                :rows="2"
                resize="vertical"
                placeholder="角色简介"
              />
            </el-form-item>
          </template>

          <template v-else-if="kind === 'scene'">
            <div class="form-row-2">
              <el-form-item label="地点" class="flex-1">
                <el-input v-model="form.location" placeholder="场景地点" />
              </el-form-item>
              <el-form-item label="时间" class="time-field">
                <el-input v-model="form.time" placeholder="白天/夜" />
              </el-form-item>
            </div>
            <el-form-item label="描述">
              <el-input
                v-model="form.prompt"
                type="textarea"
                :rows="2"
                resize="vertical"
                placeholder="场景描述"
              />
            </el-form-item>
          </template>

          <template v-else>
            <el-form-item label="名称">
              <el-input v-model="form.name" placeholder="道具名称" />
            </el-form-item>
            <el-form-item label="描述">
              <el-input
                v-model="form.description"
                type="textarea"
                :rows="2"
                resize="vertical"
                placeholder="道具描述"
              />
            </el-form-item>
            <el-form-item label="提示">
              <el-input
                v-model="form.prompt"
                type="textarea"
                :rows="2"
                resize="vertical"
                placeholder="生图提示词"
              />
            </el-form-item>
          </template>
        </el-form>
      </div>
    </div>

    <CanvasNodeExecutionStrip
      :status="nodeBusy"
      :disabled="saving || generating || panoramaGenerating || multiViewGenerating || libraryApplying"
      @retry="retryAssetFailedStep"
    />

    <div class="panel-actions">
      <el-button size="small" :loading="saving" @click.stop="saveAsset">保存</el-button>
      <el-button
        size="small"
        plain
        :loading="libraryApplying"
        :disabled="generating || panoramaGenerating"
        @click.stop="libraryVisible = true"
      >
        素材库选图
      </el-button>
      <el-button
        v-if="canGenerate || generating"
        size="small"
        type="primary"
        :loading="generating"
        @click.stop="generateImage"
      >
        生成参考图
      </el-button>
      <el-button
        v-if="kind === 'scene'"
        size="small"
        type="success"
        :loading="panoramaGenerating"
        :disabled="generating"
        @click.stop="generatePanorama"
      >
        生成全景图
      </el-button>
      <el-button
        v-if="kind === 'character' || kind === 'scene'"
        size="small"
        type="warning"
        plain
        :loading="multiViewGenerating"
        :disabled="generating || panoramaGenerating"
        @click.stop="generateMultiView"
      >
        {{ kind === 'character' ? '角色三视图' : '场景多视图' }}
      </el-button>
      <el-button size="small" plain @click.stop="highlightRelated">关联分镜</el-button>
      <el-button size="small" type="danger" plain @click.stop="deleteAsset">删除</el-button>
    </div>

    <AssetPickerDialog
      v-model="libraryVisible"
      type="image"
      :title="`从素材库选择${kindLabel}参考图`"
      :drama-id="ctx?.drama?.value?.id"
      @pick="applyLibraryImage"
    />
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import AssetPickerDialog from '@/components/AssetPickerDialog.vue'
import CanvasNodeExecutionStrip from './CanvasNodeExecutionStrip.vue'
import { characterAPI } from '@/api/characters'
import { sceneAPI } from '@/api/scenes'
import { propAPI } from '@/api/props'
import { assetsAPI } from '@/api/assets'
import { useCanvasContext } from '@/composables/useCanvasContext'
import {
  generateAssetReferenceImage,
  generateAssetMultiViewImage,
  generateScenePanoramaImage,
} from '@/composables/useCanvasAssetGenerate'
import { assetImageUrl } from '@/utils/mediaUrl'

const props = defineProps({
  kind: { type: String, required: true },
  entity: { type: Object, required: true },
  nodeId: { type: String, required: true },
})

const ctx = useCanvasContext()
const saving = ref(false)
const generating = ref(false)
const multiViewGenerating = ref(false)
const panoramaGenerating = ref(false)
const libraryVisible = ref(false)
const libraryApplying = ref(false)
const form = reactive({
  name: '',
  role: '',
  appearance: '',
  description: '',
  location: '',
  time: '',
  prompt: '',
})

const kindLabel = computed(() => {
  const map = { character: '角色', scene: '场景', prop: '道具' }
  return map[props.kind] || '素材'
})

const kindIcon = computed(() => {
  const map = { character: '👤', scene: '🏞', prop: '🎭' }
  return map[props.kind] || '📦'
})

const previewUrl = computed(() => assetImageUrl(props.entity))
const panoramaUrl = computed(() => assetImageUrl({
  image_url: props.entity?.panorama_image_url,
  local_path: props.entity?.panorama_local_path,
}))
const multiViewUrl = computed(() => props.kind === 'character'
  ? assetImageUrl({ image_url: props.entity?.four_view_image_url })
  : '')
const canGenerate = computed(() => !previewUrl.value)
const entityStatus = computed(() => props.entity?.status || '')
const entityStatusLabel = computed(() => {
  const s = entityStatus.value
  const map = { pending: '待生成', processing: '生成中', completed: '已完成', failed: '失败' }
  return map[s] || (previewUrl.value ? '已有参考图' : '无参考图')
})

const nodeBusy = computed(() => {
  const map = ctx?.nodeStatus?.map
  return map ? map[props.nodeId] : null
})

function syncForm(entity) {
  form.name = entity?.name || ''
  form.role = entity?.role || ''
  form.appearance = entity?.appearance || ''
  form.description = entity?.description || ''
  form.location = entity?.location || ''
  form.time = entity?.time || ''
  form.prompt = entity?.prompt || entity?.polished_prompt || ''
}

watch(() => props.entity, (e) => syncForm(e), { immediate: true, deep: true })

function onSelectVisibleChange(open) {
  if (open) ctx?.suppressPaneClick?.()
  else ctx?.suppressPaneClick?.(400)
}

function closePanel() {
  ctx?.clearFocusedNode?.()
}

async function saveAsset() {
  saving.value = true
  ctx?.nodeStatus?.set(props.nodeId, { step: 'save', message: '保存中…' })
  try {
    if (props.kind === 'character') {
      if (!form.name.trim()) {
        ElMessage.warning('请填写角色名称')
        return
      }
      await characterAPI.update(props.entity.id, {
        name: form.name.trim(),
        role: form.role || undefined,
        appearance: form.appearance.trim() || undefined,
        description: form.description.trim() || undefined,
      })
    } else if (props.kind === 'scene') {
      if (!form.location.trim()) {
        ElMessage.warning('请填写场景地点')
        return
      }
      await sceneAPI.update(props.entity.id, {
        location: form.location.trim(),
        time: form.time.trim() || undefined,
        prompt: form.prompt.trim() || undefined,
      })
    } else {
      if (!form.name.trim()) {
        ElMessage.warning('请填写道具名称')
        return
      }
      await propAPI.update(props.entity.id, {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        prompt: form.prompt.trim() || undefined,
      })
    }
    ElMessage.success('已保存')
    await ctx?.refreshDrama?.(true)
    ctx?.nodeStatus?.success(props.nodeId, {
      message: '素材已保存',
      resultType: 'text',
      resultLabel: `${kindLabel.value}已保存`,
      promptText: form.prompt || form.description || form.appearance || form.name || form.location,
      autoClear: false,
    })
  } catch (e) {
    const message = e?.message || '保存失败'
    ctx?.nodeStatus?.fail(props.nodeId, {
      message,
      errorDetail: message,
      retryStep: 'save',
      retryLabel: `重试保存${kindLabel.value}`,
      recoverable: true,
    })
    ElMessage.error(message)
  } finally {
    saving.value = false
    clearTransientAssetStatus()
  }
}

function buildLibraryImagePayload(asset) {
  const localPath = asset?.local_path || asset?.image_local_path || ''
  const displayUrl = asset?.display_url || asset?.url || ''
  const ref = localPath || displayUrl
  if (!ref) throw new Error('该素材缺少可用图片地址')
  const payload = { ref_image: ref }
  if (localPath) {
    payload.local_path = localPath
  } else {
    payload.image_url = displayUrl
  }
  return payload
}

async function bindPickedProjectAsset(asset) {
  if (asset?.source_kind !== 'project' || !asset?.raw_id) return
  await assetsAPI.update(asset.raw_id, {
    metadata: {
      ...(asset.metadata || {}),
      canvas_asset_binding: {
        kind: props.kind,
        entity_id: props.entity.id,
        node_id: props.nodeId,
        drama_id: ctx?.drama?.value?.id || null,
      },
    },
  })
}

async function applyLibraryImage(asset) {
  libraryApplying.value = true
  ctx?.nodeStatus?.set(props.nodeId, { step: 'library', message: '引用素材库图片…' })
  let failed = false
  try {
    const payload = buildLibraryImagePayload(asset)
    if (props.kind === 'character') {
      await characterAPI.putImage(props.entity.id, payload)
    } else if (props.kind === 'scene') {
      await sceneAPI.update(props.entity.id, payload)
    } else {
      await propAPI.update(props.entity.id, payload)
    }
    try {
      await bindPickedProjectAsset(asset)
    } catch (e) {
      ElMessage.warning(e?.message || '素材关联写回失败，图片已引用')
    }
    ElMessage.success('已引用素材库图片')
    await ctx?.refreshDrama?.(true)
  } catch (e) {
    failed = true
    const message = e?.message || '引用素材库图片失败'
    ctx?.nodeStatus?.fail(props.nodeId, {
      message,
      errorDetail: message,
      retryStep: 'library',
      retryLabel: '重试引用素材库图片',
      recoverable: true,
      libraryAsset: asset,
    })
    ElMessage.error(message)
  } finally {
    libraryApplying.value = false
    if (!failed && !generating.value && !saving.value && !panoramaGenerating.value) ctx?.nodeStatus?.clear(props.nodeId)
  }
}
async function deleteAsset() {
  const label = props.kind === 'scene'
    ? (props.entity.location || '未命名')
    : (props.entity.name || '未命名')
  try {
    await ElMessageBox.confirm(`确定删除「${label.slice(0, 20)}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    if (props.kind === 'character') {
      await characterAPI.delete(props.entity.id)
    } else if (props.kind === 'scene') {
      await sceneAPI.delete(props.entity.id)
    } else {
      await propAPI.delete(props.entity.id)
    }
    ctx?.clearFocusedNode?.()
    ElMessage.success('已删除')
    await ctx?.refresh?.()
  } catch (e) {
    if (e === 'cancel') return
    ElMessage.error(e?.message || '删除失败')
  }
}

async function generateImage() {
  generating.value = true
  try {
    await generateAssetReferenceImage(ctx, {
      kind: props.kind,
      entity: props.entity,
      nodeId: props.nodeId,
    })
    ElMessage.success('参考图已生成')
  } catch (e) {
    const message = e?.message || '生成失败'
    ctx?.nodeStatus?.fail(props.nodeId, {
      message,
      errorDetail: message,
      retryStep: 'image',
      retryLabel: '重试生成参考图',
      recoverable: true,
    })
    ElMessage.error(message)
  } finally {
    generating.value = false
  }
}

async function generatePanorama() {
  panoramaGenerating.value = true
  try {
    await generateScenePanoramaImage(ctx, {
      entity: props.entity,
      nodeId: props.nodeId,
    })
    ElMessage.success('场景全景图已生成')
  } catch (e) {
    const message = e?.message || '全景图生成失败'
    ctx?.nodeStatus?.fail(props.nodeId, {
      message,
      errorDetail: message,
      retryStep: 'panorama',
      retryLabel: '重试生成全景图',
      recoverable: true,
    })
    ElMessage.error(message)
  } finally {
    panoramaGenerating.value = false
  }
}

async function generateMultiView() {
  multiViewGenerating.value = true
  try {
    await generateAssetMultiViewImage(ctx, {
      kind: props.kind,
      entity: props.entity,
      nodeId: props.nodeId,
    })
    ElMessage.success(props.kind === 'character' ? '角色三视图已生成' : '场景多视图已生成')
  } catch (e) {
    const message = e?.message || '多视图生成失败'
    ctx?.nodeStatus?.fail(props.nodeId, {
      message,
      errorDetail: message,
      retryStep: 'multi_view',
      retryLabel: props.kind === 'character' ? '重试生成角色三视图' : '重试生成场景多视图',
      recoverable: true,
    })
    ElMessage.error(message)
  } finally {
    multiViewGenerating.value = false
  }
}

async function retryAssetFailedStep() {
  const status = nodeBusy.value
  if (status?.retryStep === 'save') return saveAsset()
  if (status?.retryStep === 'library' && status.libraryAsset) return applyLibraryImage(status.libraryAsset)
  if (status?.retryStep === 'image') return generateImage()
  if (status?.retryStep === 'panorama') return generatePanorama()
  if (status?.retryStep === 'multi_view') return generateMultiView()
}

function highlightRelated() {
  ctx?.setHighlightAsset?.(props.nodeId)
}

function clearTransientAssetStatus() {
  const status = ctx?.nodeStatus?.get?.(props.nodeId)
  if (status && !['failed', 'success'].includes(status.step)) ctx?.nodeStatus?.clear(props.nodeId)
}
</script>

<style scoped>
.asset-panel {
  margin-top: 10px;
  width: min(520px, 92vw);
  padding: 10px 14px 12px;
  border-radius: 12px;
  border: 1px solid rgba(52, 211, 153, 0.4);
  background: rgba(15, 15, 18, 0.97);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 700;
  color: #6ee7b7;
  margin-bottom: 10px;
}
.panel-body {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.preview-col {
  flex-shrink: 0;
  width: 108px;
}
.preview-box {
  position: relative;
  width: 108px;
  height: 108px;
  border-radius: 10px;
  overflow: hidden;
  background: #09090b;
  border: 1px solid #3f3f46;
}
.preview-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.preview-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  opacity: 0.65;
}
.preview-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(9, 9, 11, 0.82);
  font-size: 10px;
  color: #d4d4d8;
  text-align: center;
  padding: 6px;
}
.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.12);
  border-top-color: #34d399;
  border-radius: 50%;
  animation: spin 0.75s linear infinite;
}
.entity-status {
  margin-top: 6px;
  font-size: 10px;
  text-align: center;
  color: #71717a;
}
.entity-status.st-processing { color: #60a5fa; }
.entity-status.st-completed { color: #34d399; }
.entity-status.st-failed { color: #f87171; }
.panorama-preview {
  margin-top: 6px;
  width: 108px;
  border-radius: 6px;
  overflow: hidden;
  background: #09090b;
  border: 1px solid rgba(52, 211, 153, 0.35);
}
.panorama-preview img {
  display: block;
  width: 100%;
  height: 42px;
  object-fit: cover;
}
.panorama-preview span {
  display: block;
  padding: 2px 5px;
  font-size: 9px;
  color: #6ee7b7;
}
.form-col {
  flex: 1;
  min-width: 0;
}
.compact-form :deep(.el-form-item) {
  margin-bottom: 6px;
}
.compact-form :deep(.el-form-item__label) {
  color: #71717a;
  font-size: 11px;
  padding-right: 6px;
}
.compact-form :deep(.el-input__wrapper),
.compact-form :deep(.el-select__wrapper) {
  min-height: 28px;
}
.compact-form :deep(.el-textarea__inner) {
  resize: vertical;
  min-height: 52px;
  line-height: 1.45;
}
.form-row-2 {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.flex-1 { flex: 1; min-width: 0; }
.type-field { width: 108px; flex-shrink: 0; }
.time-field { width: 96px; flex-shrink: 0; }
.panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(63, 63, 70, 0.6);
}
.panel-actions :deep(.el-button) {
  margin: 0;
}
.kind-scene { border-color: rgba(96, 165, 250, 0.45); }
.kind-scene .panel-head { color: #93c5fd; }
.kind-scene .spinner { border-top-color: #93c5fd; }
.kind-prop { border-color: rgba(251, 191, 36, 0.45); }
.kind-prop .panel-head { color: #fcd34d; }
.kind-prop .spinner { border-top-color: #fcd34d; }
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>

<style>
.canvas-panel-popper {
  z-index: 4000 !important;
}
.canvas-panel-popper.el-select__popper .el-select-dropdown__wrap {
  max-height: 168px !important;
}
</style>
