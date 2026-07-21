<template>
  <div
    class="canvas-node-panel media-panel nodrag nopan nowheel"
    :class="'kind-' + kind"
    @pointerdown.stop
    @mousedown.stop
    @click.stop
    @mouseup.stop
    @wheel.stop
  >
    <div class="panel-head">
      <span>{{ kindTitle }}</span>
      <div class="head-right">
        <span v-if="busyLabel" class="busy-tag">{{ busyLabel }}</span>
        <el-button link size="small" @click.stop="closePanel">收起</el-button>
      </div>
    </div>

    <div class="panel-body">
      <template v-if="kind === 'text'">
        <p class="summary">{{ summary || '暂无脚本内容' }}</p>
        <el-button size="small" type="primary" plain @click.stop="focusStoryboard">编辑脚本</el-button>
      </template>

      <template v-else-if="kind === 'universal'">
        <el-input
          v-model="universalText"
          class="universal-editor"
          type="textarea"
          :rows="5"
          resize="vertical"
          placeholder="编辑全能分镜词，或使用生成/润色"
          @click.stop
        />
        <div class="panel-actions">
          <el-button
            size="small"
            :loading="universalBusy === 'generate'"
            :disabled="Boolean(universalBusy)"
            @click.stop="runUniversalPrompt('generate')"
          >生成全能词</el-button>
          <el-button
            size="small"
            :loading="universalBusy === 'polish'"
            :disabled="Boolean(universalBusy) || !universalText.trim()"
            @click.stop="runUniversalPrompt('polish')"
          >流式润色</el-button>
          <el-button size="small" :loading="universalBusy === 'save'" :disabled="Boolean(universalBusy)" @click.stop="saveUniversalText">保存</el-button>
          <el-button size="small" plain @click.stop="focusStoryboard">编辑字段</el-button>
          <el-button size="small" type="primary" :loading="busy" :disabled="Boolean(universalBusy)" @click.stop="runStep('video')">重新生视频</el-button>
        </div>
      </template>

      <template v-else-if="kind === 'image'">
        <div class="preview-wrap">
          <img v-if="url && !busy" :src="url" alt="" class="preview-img" />
          <div v-else-if="!busy" class="preview-empty">无分镜图</div>
          <div v-if="busy" class="preview-loading"><span class="spinner" />生图中…</div>
        </div>
        <CanvasGenerationOptions mode="image" compact />
        <div class="panel-actions">
          <el-button size="small" type="primary" :loading="busy" @click.stop="runStep('image')">
            {{ frameKind === 'first' ? '生成首帧' : frameKind === 'last' ? '生成尾帧' : '重新生图' }}
          </el-button>
          <CanvasStoryboardImageUpload
            :storyboard="storyboard"
            :node-id="nodeId"
            :frame-kind="frameKind"
          />
        </div>
      </template>

      <template v-else-if="kind === 'video'">
        <div class="preview-wrap">
          <video v-if="url && !busy" :src="url" class="preview-vid" controls playsinline />
          <div v-else-if="!busy" class="preview-empty">无视频</div>
          <div v-if="busy" class="preview-loading"><span class="spinner" />生视频中…</div>
        </div>
        <div v-if="generationError" class="generation-alert generation-alert-error">{{ generationError }}</div>
        <div v-else-if="generationWarning" class="generation-alert generation-alert-warn">{{ generationWarning }}</div>
        <CanvasGenerationOptions mode="video" compact />
        <el-button size="small" type="primary" :loading="busy" @click.stop="runStep('video')">重新生视频</el-button>
        <el-button size="small" :loading="attachBusy" @click.stop="videoLibraryVisible = true">从素材库选用成片</el-button>
        <AssetPickerDialog v-model="videoLibraryVisible" type="video" title="从素材库选用成片" @pick="onLibraryVideoPick" />
      </template>

      <template v-else-if="kind === 'audio'">
        <div class="audio-label">{{ audioType === 'narration' ? '旁白音频' : '对白音频' }}</div>
        <audio v-if="url" :src="url" controls class="preview-aud" />
        <el-button size="small" type="warning" :loading="busy" @click.stop="runStep('audio')">重新配音</el-button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { storyboardsAPI } from '@/api/storyboards'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { CANVAS_NODE_STATUS_LABELS } from '@/composables/useCanvasNodeStatus'
import { runImageStep, runVideoStep, runAudioStep } from '@/composables/useCanvasWorkflowRunner'
import {
  buildUniversalPromptFieldOverrides,
  findStoryboardInDrama,
  getDramaGenerationOptions,
  universalPromptDuration,
} from '@/utils/canvasWorkflow'
import CanvasStoryboardImageUpload from './CanvasStoryboardImageUpload.vue'
import CanvasGenerationOptions from './CanvasGenerationOptions.vue'
import AssetPickerDialog from '@/components/AssetPickerDialog.vue'
import { videosAPI } from '@/api/videos'

const props = defineProps({
  nodeId: { type: String, default: '' },
  kind: { type: String, required: true },
  storyboard: { type: Object, default: null },
  summary: { type: String, default: '' },
  url: { type: String, default: '' },
  audioType: { type: String, default: 'dialogue' },
  frameKind: { type: String, default: '' },
  generationError: { type: String, default: '' },
  generationWarning: { type: String, default: '' },
})

const ctx = useCanvasContext()
const busy = ref(false)
const universalBusy = ref('')
const universalText = ref('')
const videoLibraryVisible = ref(false)
const attachBusy = ref(false)

/** 素材库视频直接复用为该分镜成片（不生成、不计费） */
async function onLibraryVideoPick(asset) {
  const drama = ctx?.drama?.value
  const sbId = props.storyboard?.id
  if (!drama?.id || !sbId) return
  const videoUrl = asset.display_url || asset.url || ''
  const localPath = asset.local_path || ''
  if (!videoUrl && !localPath) return ElMessage.error('该素材缺少可用地址')
  attachBusy.value = true
  try {
    await videosAPI.attach({
      storyboard_id: sbId,
      drama_id: drama.id,
      video_url: videoUrl,
      local_path: localPath || undefined,
      duration: asset.duration ?? undefined,
    })
    ElMessage.success('已将素材库视频设为该分镜成片')
    await ctx?.refresh?.()
  } catch (e) {
    ElMessage.error(e?.message || '复用失败')
  } finally {
    attachBusy.value = false
  }
}

const sbNodeId = computed(() => (props.storyboard?.id ? `sb:${props.storyboard.id}` : ''))

const kindTitle = computed(() => {
  if (props.kind === 'image' && props.frameKind === 'first') return '首帧图'
  if (props.kind === 'image' && props.frameKind === 'last') return '尾帧图'
  const map = { text: '脚本摘要', universal: '全能分镜词', image: '分镜图', video: '视频', audio: '音频' }
  return map[props.kind] || '媒体'
})

const busyLabel = computed(() => {
  const map = ctx?.nodeStatus?.map
  const id = props.nodeId || sbNodeId.value
  return id && map ? map[id]?.message : ''
})

watch(
  () => [props.summary, props.storyboard?.universal_segment_text],
  ([summaryValue, storyboardValue]) => {
    if (!universalBusy.value) universalText.value = storyboardValue || summaryValue || ''
  },
  { immediate: true }
)

function focusStoryboard() {
  if (sbNodeId.value) ctx?.setFocusedNode?.(sbNodeId.value)
}

function closePanel() {
  ctx?.clearFocusedNode?.()
}

async function runUniversalPrompt(mode) {
  const drama = ctx?.drama?.value
  const sbId = props.storyboard?.id
  if (!drama || !sbId || universalBusy.value) return
  const draft = universalText.value.trim()
  if (mode === 'polish' && !draft) {
    ElMessage.warning('请先填写或生成全能分镜词')
    return
  }
  const found = findStoryboardInDrama(drama, sbId)
  const sb = found?.storyboard || props.storyboard
  const statusStep = mode === 'polish' ? 'polish' : 'save'
  universalBusy.value = mode
  const statusMessage = mode === 'polish' ? '全能词润色中…' : '全能词生成中…'
  ctx?.nodeStatus?.set(props.nodeId, { step: statusStep, message: statusMessage })
  ctx?.nodeStatus?.set(sbNodeId.value, { step: statusStep, message: statusMessage })
  universalText.value = ''
  try {
    const body = {
      duration: universalPromptDuration(sb),
      field_overrides: buildUniversalPromptFieldOverrides(sb),
    }
    let response
    const onDelta = (delta) => {
      universalText.value += delta || ''
    }
    if (mode === 'polish') {
      response = await storyboardsAPI.polishUniversalSegmentPromptStream(sbId, {
        ...body,
        draft_universal_segment_text: draft,
      }, onDelta)
    } else {
      response = await storyboardsAPI.generateUniversalSegmentPromptStream(sbId, body, onDelta)
    }
    const nextText = String(response?.universal_segment_text || universalText.value).trim()
    if (!nextText) throw new Error('未生成有效的全能分镜词')
    universalText.value = nextText
    ElMessage.success(mode === 'polish' ? '全能词润色完成' : '全能词生成完成')
    await ctx?.refreshDrama?.(true)
  } catch (e) {
    universalText.value = draft
    ElMessage.error(e?.message || '全能词处理失败')
  } finally {
    universalBusy.value = ''
    ctx?.nodeStatus?.clear(props.nodeId)
    ctx?.nodeStatus?.clear(sbNodeId.value)
  }
}

async function saveUniversalText() {
  const sbId = props.storyboard?.id
  if (!sbId || universalBusy.value) return
  universalBusy.value = 'save'
  const statusMessage = '全能词保存中…'
  ctx?.nodeStatus?.set(props.nodeId, { step: 'save', message: statusMessage })
  ctx?.nodeStatus?.set(sbNodeId.value, { step: 'save', message: statusMessage })
  try {
    await storyboardsAPI.update(sbId, { universal_segment_text: universalText.value.trim() })
    ElMessage.success('全能词已保存')
    await ctx?.refreshDrama?.(true)
  } catch (e) {
    ElMessage.error(e?.message || '全能词保存失败')
  } finally {
    universalBusy.value = ''
    ctx?.nodeStatus?.clear(props.nodeId)
    ctx?.nodeStatus?.clear(sbNodeId.value)
  }
}

async function runStep(step) {
  const drama = ctx?.drama?.value
  const sbId = props.storyboard?.id
  if (!drama || !sbId) return
  busy.value = true
  const statusMsg = step === 'image' && props.frameKind === 'first'
    ? '首帧生成中…'
    : step === 'image' && props.frameKind === 'last'
      ? '尾帧生成中…'
      : CANVAS_NODE_STATUS_LABELS[step] || '处理中…'
  ctx?.nodeStatus?.set(props.nodeId, { step, message: statusMsg })
  ctx?.nodeStatus?.set(sbNodeId.value, { step, message: statusMsg })
  try {
    const found = findStoryboardInDrama(drama, sbId)
    const sb = found?.storyboard || props.storyboard
    const genOpts = ctx?.getGenerationOptions?.() || getDramaGenerationOptions(drama)
    if (step === 'image') await runImageStep(drama, sb, genOpts, props.frameKind)
    else if (step === 'video') await runVideoStep(drama, sb, genOpts)
    else if (step === 'audio') {
      const res = await runAudioStep(sb)
      if (res?.skipped) {
        ElMessage.info(res.reason || '已跳过')
        return
      }
    }
    ElMessage.success('生成完成')
    await ctx?.refresh?.()
  } catch (e) {
    ElMessage.error(e?.message || '生成失败')
    await ctx?.refresh?.()
  } finally {
    busy.value = false
    ctx?.nodeStatus?.clear(props.nodeId)
    ctx?.nodeStatus?.clear(sbNodeId.value)
  }
}
</script>

<style scoped>
.media-panel {
  margin-top: 10px;
  width: min(360px, 90vw);
  padding: 10px 12px 12px;
  border-radius: 10px;
  border: 1px solid rgba(129, 140, 248, 0.4);
  background: rgba(15, 15, 18, 0.96);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 700;
  color: #a5b4fc;
  margin-bottom: 8px;
}
.head-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.busy-tag {
  font-size: 10px;
  color: #93c5fd;
}
.panel-body {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}
.summary {
  flex: 1;
  min-width: 180px;
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: #d4d4d8;
  max-height: 72px;
  overflow-y: auto;
}
.preview-wrap {
  position: relative;
  width: 120px;
  height: 72px;
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  background: #09090b;
}
.preview-img,
.preview-vid {
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
  font-size: 11px;
  color: #71717a;
}
.preview-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: rgba(9, 9, 11, 0.85);
  font-size: 10px;
  color: #d4d4d8;
}
.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.12);
  border-top-color: #818cf8;
  border-radius: 50%;
  animation: spin 0.75s linear infinite;
}
.preview-aud {
  flex: 1;
  min-width: 160px;
}
.audio-label {
  font-size: 11px;
  color: #fbbf24;
  width: 100%;
}
.panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.universal-editor {
  width: 100%;
}
.kind-video { border-color: rgba(244, 114, 182, 0.45); }
.kind-universal { border-color: rgba(167, 139, 250, 0.45); }
.kind-audio { border-color: rgba(251, 191, 36, 0.45); }
.generation-alert {
  flex-basis: 100%;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.35;
}
.generation-alert-error {
  color: #fecaca;
  background: rgba(127, 29, 29, 0.42);
  border: 1px solid rgba(248, 113, 113, 0.22);
}
.generation-alert-warn {
  color: #fde68a;
  background: rgba(113, 63, 18, 0.36);
  border: 1px solid rgba(251, 191, 36, 0.2);
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
