<template>
  <div
    class="canvas-node-panel sb-panel nodrag nopan nowheel"
    @pointerdown.stop
    @mousedown.stop
    @click.stop
    @mouseup.stop
    @wheel.stop
  >
    <div class="panel-head">
      <span>分镜 #{{ storyboard?.storyboard_number ?? storyboard?.id }}</span>
      <div class="head-actions">
        <span v-if="busyLabel" class="busy-tag">{{ busyLabel }}</span>
        <el-button link size="small" type="primary" @click.stop="openListMode">列表详情</el-button>
        <el-button link size="small" @click.stop="closePanel">收起</el-button>
      </div>
    </div>

    <el-form label-position="left" label-width="36px" size="small" class="panel-form compact-form">
      <section class="panel-section">
        <div class="section-head">
          <span>基础信息</span>
          <small>分镜标题</small>
        </div>
      <el-form-item label="标题">
        <el-input v-model="form.title" placeholder="分镜标题" @blur="saveMeta" />
      </el-form-item>
      </section>

      <section class="panel-section">
        <div class="section-head">
          <span>引用素材</span>
          <small>角色 / 场景 / 道具</small>
        </div>

      <div class="relation-row">
        <el-form-item label="角色" class="rel-item">
          <el-select
            v-model="characterIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            filterable
            placeholder="角色"
            teleported
            popper-class="canvas-panel-popper"
            @visible-change="onSelectVisibleChange"
            @change="onRelationChange"
          >
            <el-option
              v-for="c in characters"
              :key="c.id"
              :label="c.name || '未命名'"
              :value="normalizeEntityId(c.id)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="场景" class="rel-item">
          <el-select
            v-model="sceneId"
            clearable
            filterable
            placeholder="场景"
            teleported
            popper-class="canvas-panel-popper"
            @visible-change="onSelectVisibleChange"
            @change="onRelationChange"
          >
            <el-option
              v-for="s in scenes"
              :key="s.id"
              :label="s.location || '未命名'"
              :value="normalizeEntityId(s.id)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="道具" class="rel-item">
          <el-select
            v-model="propIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            filterable
            placeholder="道具"
            teleported
            popper-class="canvas-panel-popper"
            @visible-change="onSelectVisibleChange"
            @change="onRelationChange"
          >
            <el-option
              v-for="p in propsList"
              :key="p.id"
              :label="p.name || '未命名'"
              :value="normalizeEntityId(p.id)"
            />
          </el-select>
        </el-form-item>
      </div>
      <div class="inline-add-row">
        <el-button link type="primary" size="small" @click.stop="createAsset('character')">+角色</el-button>
        <el-button link type="primary" size="small" @click.stop="createAsset('scene')">+场景</el-button>
        <el-button link type="primary" size="small" @click.stop="createAsset('prop')">+道具</el-button>
      </div>

      <div class="reference-strip">
        <div class="reference-head">
          <span>参考图</span>
          <span class="reference-count">{{ referenceAssets.length }}/10</span>
        </div>
        <div v-if="referenceAssets.length" class="reference-list">
          <span
            v-for="reference in referenceAssets"
            :key="reference.key"
            class="reference-chip"
            :title="`${reference.kind === 'scene' ? '场景' : reference.kind === 'character' ? '角色' : '道具'}：${reference.name}`"
          >
            <img :src="reference.url" alt="" />
            <span>{{ reference.name }}</span>
          </span>
        </div>
        <span v-else class="reference-empty">选择角色、场景或道具后自动带入生成</span>
      </div>

      </section>

      <section class="panel-section">
        <div class="section-head">
          <span>镜头参数</span>
          <small>景别 / 时长</small>
        </div>
      <div class="meta-row">
        <el-form-item label="景别" class="meta-item">
          <el-input v-model="form.shot_type" placeholder="特写" @blur="saveMeta" />
        </el-form-item>
        <el-form-item label="时长" class="meta-item narrow">
          <el-input-number v-model="form.duration" :min="1" :max="120" controls-position="right" @change="saveMeta" />
        </el-form-item>
      </div>

      </section>

      <section class="panel-section">
        <div class="section-head">
          <span>摄影控制</span>
          <small>角度 / 灯光 / 宫格</small>
        </div>
      <div class="camera-control-strip">
        <div class="control-head">
          <span>摄影控制</span>
          <el-tag size="small" type="info" effect="plain">角度 · 灯光 · 宫格</el-tag>
        </div>
        <div class="camera-control-grid">
          <el-select v-model="angleH" size="small" clearable placeholder="水平角度" @change="savePhotography">
            <el-option v-for="item in HORIZONTAL_ANGLES" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="angleV" size="small" clearable placeholder="俯仰角度" @change="savePhotography">
            <el-option v-for="item in VERTICAL_ANGLES" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="angleS" size="small" clearable placeholder="景别" @change="savePhotography">
            <el-option v-for="item in SHOT_SIZES" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="lightingStyle" size="small" clearable placeholder="灯光风格" @change="savePhotography">
            <el-option v-for="item in LIGHTING_STYLES" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="gridFrameType" size="small" placeholder="分镜图版式" @change="savePhotography">
            <el-option label="单张" value="single" />
            <el-option v-for="layout in GRID_LAYOUTS" :key="layout.value" :label="layout.label" :value="layout.value" />
          </el-select>
        </div>
        <div class="camera-control-hint">保存后会写入分镜提示词；生成分镜图时按所选版式提交。</div>
      </div>

      </section>

      <section class="panel-section">
        <div class="section-head">
          <span>脚本提示词</span>
          <small>动作 / 对白 / 生图词 / 视频词</small>
        </div>
      <template v-if="isUniversal">
        <el-form-item label="全能词">
          <el-input
            v-model="form.universal_segment_text"
            type="textarea"
            :rows="2"
            resize="vertical"
            placeholder="全能模式片段描述"
          />
        </el-form-item>
        <el-form-item label="视频词">
          <el-input
            v-model="form.video_prompt"
            type="textarea"
            :rows="2"
            resize="vertical"
            placeholder="生视频提示词"
          />
        </el-form-item>
      </template>
      <template v-else>
        <div class="text-row-2">
          <el-form-item label="动作" class="flex-1">
            <el-input
              v-model="form.action"
              type="textarea"
              :rows="2"
              resize="vertical"
              placeholder="画面动作"
            />
          </el-form-item>
          <el-form-item label="对白" class="flex-1">
            <el-input
              v-model="form.dialogue"
              type="textarea"
              :rows="2"
              resize="vertical"
              placeholder="角色对白"
            />
          </el-form-item>
        </div>
        <el-form-item label="生图词">
          <el-input
            v-model="form.image_prompt"
            type="textarea"
            :rows="2"
            resize="vertical"
            placeholder="图片提示词"
          />
        </el-form-item>
        <el-form-item label="视频词">
          <el-input
            v-model="form.video_prompt"
            type="textarea"
            :rows="2"
            resize="vertical"
            placeholder="视频提示词"
          />
        </el-form-item>
      </template>
      </section>
    </el-form>

    <section class="panel-section generation-section">
      <div class="section-head">
        <span>生成参数</span>
        <small>模型 / 画幅 / 清晰度</small>
      </div>
    <CanvasGenerationOptions
      compact
      :storyboard="storyboardGenerationOptions"
      image-service-type="storyboard_image"
      @storyboard-image-model-change="onStoryboardImageModelChange"
      @storyboard-video-model-change="onStoryboardVideoModelChange"
    />
    </section>

    <section class="panel-section">
      <div class="section-head">
        <span>视频模型与声音</span>
        <small>角色音色 / 模型策略</small>
      </div>
    <div class="storyboard-control-strip">
      <div class="control-head">
        <span>视频模型与声音</span>
        <el-tag v-if="voicePolicy" :type="voicePolicy.type" size="small" effect="plain">
          {{ voicePolicy.label }}
        </el-tag>
        <el-tag v-else size="small" type="info" effect="plain">策略待加载</el-tag>
      </div>
      <div class="control-meta">
        当前模型：{{ effectiveVideoModel || '跟随项目默认' }}
        <span v-if="voicePolicy?.key === 'silent'"> · 需后期对白配音</span>
        <span v-else-if="voicePolicy?.key === 'reference_audio'"> · 优先使用角色参考音频</span>
        <span v-else> · 使用角色级文字声线提示</span>
      </div>
      <el-popover placement="top-start" :width="420" trigger="click">
        <template #reference>
          <el-button link type="primary" size="small">声音提示预览</el-button>
        </template>
        <pre class="prompt-preview">{{ voicePromptPreview }}</pre>
      </el-popover>
    </div>
    </section>

    <section class="panel-section">
      <div class="section-head">
        <span>镜头连续性</span>
        <small>首尾帧 / 相邻镜头</small>
      </div>
    <div class="continuity-strip">
      <div class="control-head">
        <span>镜头连续性</span>
        <el-tag size="small" :type="usesFirstLastFrame ? 'success' : 'info'" effect="plain">
          {{ usesFirstLastFrame ? '首尾帧模式' : '剧情提示模式' }}
        </el-tag>
      </div>
      <div class="continuity-meta">
        <span>上一镜：{{ storyboardNeighbors.previous?.title || '无' }}</span>
        <span>下一镜：{{ storyboardNeighbors.next?.title || '无' }}</span>
      </div>
      <div class="continuity-actions">
        <el-button
          v-if="canLinkTail"
          size="small"
          type="primary"
          plain
          :loading="tailLinking"
          @click.stop="linkTailFrame"
        >尾帧衔接</el-button>
        <span v-else-if="storyboardNeighbors.next" class="continuity-muted">跨场景不自动锁定尾帧</span>
        <el-popover placement="top-start" :width="520" trigger="click">
          <template #reference>
            <el-button link type="primary" size="small">连续性提示预览</el-button>
          </template>
          <pre class="prompt-preview">{{ continuityPrompt || '暂无相邻镜头' }}</pre>
        </el-popover>
      </div>
    </div>
    </section>

    <div class="panel-actions fixed-action-bar" :class="{ busy: isActionBusy }">
      <div class="action-status" :class="actionStatus.type">
        <span class="status-dot" />
        <span>{{ actionStatusLabel }}</span>
      </div>
      <div class="action-groups">
        <div class="action-group">
          <el-button size="small" :loading="saving" :disabled="isActionBusy && !saving" @click.stop="saveFields">保存</el-button>
          <el-button v-if="!isUniversal" size="small" :loading="busyStep === 'polish'" :disabled="isActionBusy && busyStep !== 'polish'" @click.stop="polishPrompt">润色</el-button>
        </div>
        <div v-if="!isUniversal" class="action-group">
          <el-button size="small" type="primary" :loading="busyStep === 'image'" :disabled="isActionBusy && busyStep !== 'image'" @click.stop="runStep('image')">生图</el-button>
          <CanvasStoryboardImageUpload
            :storyboard="storyboard"
            :node-id="sbNodeId"
            :disabled="isActionBusy"
            @status="setActionStatus"
          />
        </div>
        <div class="action-group">
          <el-button size="small" type="primary" :loading="busyStep === 'video'" :disabled="isActionBusy && busyStep !== 'video'" @click.stop="runStep('video')">生视频</el-button>
          <el-button size="small" type="warning" :loading="busyStep === 'audio'" :disabled="isActionBusy && busyStep !== 'audio'" @click.stop="runStep('audio')">配音</el-button>
        </div>
        <div class="action-group danger-group">
          <el-button size="small" type="danger" plain :disabled="isActionBusy" @click.stop="deleteStoryboard">删除</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { aiAPI } from '@/api/ai'
import { storyboardsAPI } from '@/api/storyboards'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { CANVAS_NODE_STATUS_LABELS } from '@/composables/useCanvasNodeStatus'
import {
  normalizeEntityId,
  parseStoryboardCharacterIds,
  parseStoryboardPropIds,
  parseStoryboardSceneId,
} from '@/utils/canvasEntityIds'
import { runImageStep, runVideoStep, runAudioStep } from '@/composables/useCanvasWorkflowRunner'
import {
  collectStoryboardReferenceAssets,
  findStoryboardInDrama,
  getAdjacentStoryboards,
  getDramaGenerationOptions,
} from '@/utils/canvasWorkflow'
import { buildStoryboardContinuityPrompt, canChainStoryboardFrames } from '@/utils/videoContinuity'
import { buildVoicePromptPreview, videoVoicePolicyForConfig } from '@/utils/videoVoicePolicy'
import { dramaUsesFirstLastFrame } from '@/utils/storyboardMedia'
import { GRID_LAYOUTS } from '@/utils/gridLayout'
import CanvasStoryboardImageUpload from './CanvasStoryboardImageUpload.vue'
import CanvasGenerationOptions from './CanvasGenerationOptions.vue'

const props = defineProps({
  storyboard: { type: Object, required: true },
  episodeId: { type: Number, default: null },
  nodeId: { type: String, default: '' },
})

const router = useRouter()
const ctx = useCanvasContext()
const saving = ref(false)
const busyStep = ref('')
const actionStatus = ref({ type: 'idle', message: '准备就绪' })
const characterIds = ref([])
const sceneId = ref(null)
const propIds = ref([])
const angleH = ref('')
const angleV = ref('')
const angleS = ref('')
const lightingStyle = ref('')
const gridFrameType = ref('single')
const imageModel = ref('')
const videoConfigs = ref([])
const tailLinking = ref(false)
const form = reactive({
  title: '',
  action: '',
  dialogue: '',
  image_prompt: '',
  video_prompt: '',
  universal_segment_text: '',
  shot_type: '',
  duration: 5,
})

const sbNodeId = computed(() => props.nodeId || (props.storyboard?.id ? `sb:${props.storyboard.id}` : ''))

const isUniversal = computed(() => props.storyboard?.creation_mode === 'universal')
const characters = computed(() => ctx?.drama?.value?.characters || [])
const scenes = computed(() => ctx?.drama?.value?.scenes || [])
const propsList = computed(() => ctx?.drama?.value?.props || [])
const referenceAssets = computed(() => collectStoryboardReferenceAssets(ctx?.drama?.value, {
  ...props.storyboard,
  characters: characterIds.value,
  scene_id: sceneId.value,
  prop_ids: propIds.value,
}))

const effectiveVideoModel = computed(() => String(
  props.storyboard?.video_model || ctx?.getGenerationOptions?.()?.videoModel || '',
).trim())
const storyboardGenerationOptions = computed(() => ({
  ...props.storyboard,
  image_model: imageModel.value,
}))
const storyboardCharacters = computed(() => {
  const ids = new Set(characterIds.value.map((id) => Number(id)))
  return characters.value.filter((character) => ids.has(Number(character?.id)))
})

const HORIZONTAL_ANGLES = [
  { value: 'front', label: '正面' },
  { value: 'front_left', label: '前左 45°' },
  { value: 'left', label: '左侧' },
  { value: 'back_left', label: '后左 135°' },
  { value: 'back', label: '背面' },
  { value: 'back_right', label: '后右 135°' },
  { value: 'right', label: '右侧' },
  { value: 'front_right', label: '前右 45°' },
]
const VERTICAL_ANGLES = [
  { value: 'worm', label: '虫眼仰拍' },
  { value: 'low', label: '低角度仰拍' },
  { value: 'eye_level', label: '平视' },
  { value: 'high', label: '高角度俯拍' },
]
const SHOT_SIZES = [
  { value: 'close_up', label: '近景/特写' },
  { value: 'medium', label: '中景' },
  { value: 'wide', label: '远景/全景' },
]
const LIGHTING_STYLES = [
  { value: 'natural', label: '自然光' },
  { value: 'front', label: '顺光' },
  { value: 'side', label: '侧光' },
  { value: 'backlit', label: '逆光' },
  { value: 'soft', label: '柔光' },
  { value: 'dramatic', label: '戏剧光' },
  { value: 'golden_hour', label: '黄金时段' },
  { value: 'blue_hour', label: '蓝调时刻' },
  { value: 'night', label: '夜景低调光' },
  { value: 'neon', label: '霓虹' },
]
const voicePolicy = computed(() => {
  const model = effectiveVideoModel.value
  if (!model) return null
  for (const config of videoConfigs.value) {
    const policies = Array.isArray(config?.voice_policies) ? config.voice_policies : []
    const exact = policies.find((policy) => String(policy?.model || '').trim() === model)
    if (exact) return { ...exact, type: exact.type || exact.tone || 'info', label: exact.label || exact.name || '声音策略' }
    const fallback = videoVoicePolicyForConfig(config)
    if (fallback?.model === model) return fallback
  }
  return null
})
const voicePromptPreview = computed(() => buildVoicePromptPreview({
  policy: voicePolicy.value,
  characters: storyboardCharacters.value,
}))
const currentEpisode = computed(() => {
  const drama = ctx?.drama?.value
  const byProp = (drama?.episodes || []).find((episode) => Number(episode?.id) === Number(props.episodeId))
  if (byProp) return byProp
  return findStoryboardInDrama(drama, Number(props.storyboard?.id))?.episode || null
})
const storyboardNeighbors = computed(() => getAdjacentStoryboards(currentEpisode.value, props.storyboard?.id))
const usesFirstLastFrame = computed(() => dramaUsesFirstLastFrame(ctx?.drama?.value))
const canLinkTail = computed(() => canChainStoryboardFrames(
  storyboardNeighbors.value.next,
  props.storyboard,
))
const continuityPrompt = computed(() => {
  const base = props.storyboard?.video_prompt
    || props.storyboard?.universal_segment_text
    || props.storyboard?.description
    || props.storyboard?.action
    || ''
  return buildStoryboardContinuityPrompt({
    prompt: base,
    current: props.storyboard,
    previous: storyboardNeighbors.value.previous,
    next: storyboardNeighbors.value.next,
  })
})

const busyLabel = computed(() => {
  const map = ctx?.nodeStatus?.map
  const st = map && sbNodeId.value ? map[sbNodeId.value] : null
  return st?.message || (busyStep.value ? CANVAS_NODE_STATUS_LABELS[busyStep.value] : '')
})
const isActionBusy = computed(() => saving.value || !!busyLabel.value)
const actionStatusLabel = computed(() => busyLabel.value || actionStatus.value.message || '准备就绪')

function setActionStatus(status) {
  actionStatus.value = status || { type: 'idle', message: '准备就绪' }
}

function syncForm(sb) {
  form.title = sb?.title || ''
  form.action = sb?.action || ''
  form.dialogue = sb?.dialogue || ''
  form.image_prompt = sb?.image_prompt || sb?.polished_prompt || ''
  form.video_prompt = sb?.video_prompt || ''
  form.universal_segment_text = sb?.universal_segment_text || ''
  form.shot_type = sb?.shot_type || ''
  form.duration = sb?.duration != null ? Number(sb.duration) : 5
  characterIds.value = parseStoryboardCharacterIds(sb)
  sceneId.value = parseStoryboardSceneId(sb)
  propIds.value = parseStoryboardPropIds(sb)
  angleH.value = sb?.angle_h || ''
  angleV.value = sb?.angle_v || ''
  angleS.value = sb?.angle_s || ''
  lightingStyle.value = sb?.lighting_style || ''
  if (Object.prototype.hasOwnProperty.call(sb || {}, 'image_model')) imageModel.value = sb?.image_model || ''
  if (Object.prototype.hasOwnProperty.call(sb || {}, 'grid_frame_type')) gridFrameType.value = sb?.grid_frame_type || 'single'
}

watch(() => props.storyboard, (sb) => syncForm(sb), { immediate: true, deep: true })
watch(() => props.storyboard?.id, (id, previousId) => {
  if (id && id !== previousId) {
    imageModel.value = Object.prototype.hasOwnProperty.call(props.storyboard || {}, 'image_model')
      ? props.storyboard.image_model || ''
      : ''
    gridFrameType.value = Object.prototype.hasOwnProperty.call(props.storyboard || {}, 'grid_frame_type')
      ? props.storyboard.grid_frame_type || 'single'
      : 'single'
    loadStoredImageSettings()
  }
})

onMounted(async () => {
  await Promise.all([loadVideoModels(), loadStoredImageSettings()])
})

async function loadVideoModels() {
  try {
    const rows = await aiAPI.listVideoModels()
    videoConfigs.value = Array.isArray(rows) ? rows.filter((row) => row?.is_active !== false) : []
  } catch (_) {
    videoConfigs.value = []
  }
}

async function loadStoredImageSettings() {
  if (!props.storyboard?.id) return
  try {
    const detail = await storyboardsAPI.get(props.storyboard.id)
    if (Number(detail?.id) !== Number(props.storyboard.id)) return
    imageModel.value = detail.image_model || ''
    gridFrameType.value = detail.grid_frame_type || 'single'
  } catch (_) {
    // 旧服务未部署新列时保留当前面板默认值，生成仍可继续使用项目默认模型。
  }
}

function onSelectVisibleChange(open) {
  if (open) ctx?.suppressPaneClick?.()
  else ctx?.suppressPaneClick?.(400)
}

function closePanel() {
  ctx?.clearFocusedNode?.()
}

function createAsset(type) {
  ctx?.openCreateDialog?.(type)
}

function openListMode() {
  const dramaId = ctx?.drama?.value?.id
  if (!dramaId) return
  router.push({
    path: `/film/${dramaId}`,
    query: props.episodeId ? { episode: String(props.episodeId) } : {},
    hash: props.storyboard?.id ? `#sb-${props.storyboard.id}` : undefined,
  })
}

async function onRelationChange() {
  if (!props.storyboard?.id) return
  try {
    await storyboardsAPI.update(props.storyboard.id, {
      character_ids: characterIds.value,
      scene_id: sceneId.value,
      prop_ids: propIds.value,
    })
    await ctx?.refreshDrama?.(true)
  } catch (e) {
    ElMessage.error(e?.message || '关联保存失败')
  }
}

async function saveMeta() {
  if (!props.storyboard?.id) return
  try {
    await storyboardsAPI.update(props.storyboard.id, {
      title: form.title.trim() || null,
      shot_type: form.shot_type.trim() || null,
      duration: form.duration ?? 5,
    })
    await ctx?.refreshDrama?.(true)
  } catch (e) {
    ElMessage.error(e?.message || '保存失败')
  }
}

async function persistForm(silent = false) {
  if (!props.storyboard?.id) return
  const payload = isUniversal.value
    ? {
        title: form.title.trim() || null,
        universal_segment_text: form.universal_segment_text.trim() || null,
        video_prompt: form.video_prompt.trim() || null,
        shot_type: form.shot_type.trim() || null,
        duration: form.duration ?? 5,
      }
    : {
        title: form.title.trim() || null,
        action: form.action.trim() || null,
        dialogue: form.dialogue.trim() || null,
        image_prompt: form.image_prompt.trim() || null,
        video_prompt: form.video_prompt.trim() || null,
        shot_type: form.shot_type.trim() || null,
        duration: form.duration ?? 5,
      }
  await storyboardsAPI.update(props.storyboard.id, payload)
  if (!silent) ElMessage.success('已保存')
}

async function savePhotography() {
  if (!props.storyboard?.id) return
  try {
    await storyboardsAPI.update(props.storyboard.id, {
      angle_h: angleH.value || null,
      angle_v: angleV.value || null,
      angle_s: angleS.value || null,
      lighting_style: lightingStyle.value || null,
      image_model: imageModel.value || null,
      grid_frame_type: gridFrameType.value || 'single',
    })
    await ctx?.refreshDrama?.(true)
  } catch (e) {
    ElMessage.error(e?.message || '摄影参数保存失败')
  }
}

async function onStoryboardImageModelChange(value) {
  imageModel.value = String(value || '').trim()
  await savePhotography()
  ElMessage.success(imageModel.value ? `已为本分镜设置图像模型：${imageModel.value}` : '已恢复跟随项目默认图像模型')
}

async function onStoryboardVideoModelChange(value) {
  if (!props.storyboard?.id) return
  const model = String(value || '').trim()
  try {
    await storyboardsAPI.update(props.storyboard.id, { video_model: model || null })
    await ctx?.refreshDrama?.(true)
    ElMessage.success(model ? `已为本分镜设置模型：${model}` : '已恢复跟随项目默认模型')
  } catch (e) {
    ElMessage.error(e?.message || '保存分镜模型失败')
  }
}

async function linkTailFrame() {
  const dramaId = ctx?.drama?.value?.id
  if (!props.storyboard?.id || !dramaId || !canLinkTail.value) return
  tailLinking.value = true
  try {
    const result = await storyboardsAPI.linkTailFrame(props.storyboard.id, { drama_id: dramaId })
    await ctx?.refreshDrama?.(true)
    ElMessage.success(`已衔接到分镜 #${result?.next_storyboard_id || storyboardNeighbors.value.next?.storyboard_number || ''}`)
  } catch (e) {
    ElMessage.error(e?.message || '尾帧衔接失败')
  } finally {
    tailLinking.value = false
  }
}

async function saveFields() {
  if (!props.storyboard?.id) return
  saving.value = true
  actionStatus.value = { type: 'busy', message: '保存中…' }
  ctx?.nodeStatus?.set(sbNodeId.value, { step: 'save', message: CANVAS_NODE_STATUS_LABELS.save })
  try {
    await persistForm(false)
    await ctx?.refreshDrama?.(true)
    actionStatus.value = { type: 'success', message: '保存完成' }
  } catch (e) {
    actionStatus.value = { type: 'error', message: e?.message || '保存失败' }
    ElMessage.error(e?.message || '保存失败')
  } finally {
    saving.value = false
    if (!busyStep.value) ctx?.nodeStatus?.clear(sbNodeId.value)
  }
}

async function deleteStoryboard() {
  if (!props.storyboard?.id) return
  try {
    await ElMessageBox.confirm('确定删除该分镜？此操作不可恢复。', '删除分镜', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    await storyboardsAPI.delete(props.storyboard.id)
    ctx?.clearFocusedNode?.()
    actionStatus.value = { type: 'success', message: '分镜已删除' }
    ElMessage.success('分镜已删除')
    await ctx?.refresh?.()
  } catch (e) {
    if (e === 'cancel') return
    actionStatus.value = { type: 'error', message: e?.message || '删除失败' }
    ElMessage.error(e?.message || '删除失败')
  }
}

async function polishPrompt() {
  if (!props.storyboard?.id) return
  busyStep.value = 'polish'
  actionStatus.value = { type: 'busy', message: CANVAS_NODE_STATUS_LABELS.polish }
  ctx?.nodeStatus?.set(sbNodeId.value, { step: 'polish', message: CANVAS_NODE_STATUS_LABELS.polish })
  try {
    const res = await storyboardsAPI.polishPrompt(props.storyboard.id)
    if (res?.polished_prompt) form.image_prompt = res.polished_prompt
    actionStatus.value = { type: 'success', message: '提示词润色完成' }
    ElMessage.success('提示词已润色')
    await ctx?.refreshDrama?.(true)
  } catch (e) {
    actionStatus.value = { type: 'error', message: e?.message || '润色失败' }
    ElMessage.error(e?.message || '润色失败')
  } finally {
    busyStep.value = ''
    ctx?.nodeStatus?.clear(sbNodeId.value)
  }
}

async function runStep(step) {
  const drama = ctx?.drama?.value
  const sbId = props.storyboard?.id
  if (!drama || !sbId) return

  if (step !== 'audio') {
    try {
      await persistForm(true)
    } catch (e) {
      ElMessage.error(e?.message || '保存失败')
      return
    }
  }

  busyStep.value = step
  const statusMsg = CANVAS_NODE_STATUS_LABELS[step] || '处理中…'
  actionStatus.value = { type: 'busy', message: statusMsg }
  ctx?.nodeStatus?.set(sbNodeId.value, { step, message: statusMsg })
  if (step === 'image') ctx?.nodeStatus?.set(`sbimg:${sbId}`, { step, message: statusMsg })
  if (step === 'video') ctx?.nodeStatus?.set(`sbvid:${sbId}`, { step, message: statusMsg })
  try {
    const found = findStoryboardInDrama(drama, sbId)
    const sb = found?.storyboard || props.storyboard
    const genOpts = ctx?.getGenerationOptions?.() || getDramaGenerationOptions(drama)
    if (step === 'image') {
      await runImageStep(drama, sb, {
        ...genOpts,
        imageModel: imageModel.value || genOpts.imageModel,
      }, '', {
        frameType: gridFrameType.value === 'single' ? undefined : gridFrameType.value,
      })
    }
    else if (step === 'video') await runVideoStep(drama, sb, genOpts)
    else if (step === 'audio') {
      const res = await runAudioStep(sb)
      if (res?.skipped) {
        actionStatus.value = { type: 'idle', message: res.reason || '已跳过' }
        ElMessage.info(res.reason || '已跳过')
        return
      }
    }
    const successMsg = step === 'image' ? '生图完成' : step === 'video' ? '视频生成完成' : '配音完成'
    actionStatus.value = { type: 'success', message: successMsg }
    ElMessage.success(successMsg)
    await ctx?.refresh?.()
  } catch (e) {
    actionStatus.value = { type: 'error', message: e?.message || '生成失败' }
    ElMessage.error(e?.message || '生成失败')
  } finally {
    busyStep.value = ''
    ctx?.nodeStatus?.clear(sbNodeId.value)
    if (step === 'image') ctx?.nodeStatus?.clear(`sbimg:${sbId}`)
    if (step === 'video') ctx?.nodeStatus?.clear(`sbvid:${sbId}`)
  }
}
</script>

<style scoped>
.sb-panel {
  margin-top: 10px;
  width: min(560px, 94vw);
  padding: 10px 14px 12px;
  border-radius: 12px;
  border: 1px solid rgba(129, 140, 248, 0.45);
  background: rgba(15, 15, 18, 0.97);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 700;
  color: #c7d2fe;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.busy-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(96, 165, 250, 0.18);
  color: #93c5fd;
  animation: pulse-tag 1.2s ease-in-out infinite;
}
.compact-form :deep(.el-form-item) {
  margin-bottom: 6px;
}
.compact-form :deep(.el-form-item__label) {
  color: #71717a;
  font-size: 11px;
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
.panel-section {
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid rgba(63, 63, 70, 0.72);
  border-radius: 10px;
  background: rgba(24, 24, 27, 0.54);
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
  color: #e4e4e7;
  font-size: 12px;
  font-weight: 700;
}
.section-head small {
  color: #71717a;
  font-size: 10px;
  font-weight: 400;
  white-space: nowrap;
}
.generation-section {
  margin-top: 8px;
}
.relation-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.rel-item {
  flex: 1;
  min-width: 0;
  margin-bottom: 4px !important;
}
.inline-add-row {
  display: flex;
  gap: 10px;
  margin: 0 0 8px 36px;
}

.reference-strip {
  margin: 0 0 8px 36px;
  padding: 6px 8px;
  border: 1px solid rgba(63, 63, 70, 0.8);
  border-radius: 7px;
  background: rgba(24, 24, 27, 0.7);
}
.reference-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 5px;
  font-size: 10px;
  color: #a1a1aa;
}
.reference-count { color: #818cf8; }
.reference-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.reference-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 132px;
  padding: 2px 5px 2px 2px;
  border-radius: 999px;
  background: rgba(129, 140, 248, 0.12);
  color: #d4d4d8;
  font-size: 10px;
}
.reference-chip img {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 50%;
  object-fit: cover;
  background: #09090b;
}
.reference-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reference-empty {
  font-size: 10px;
  color: #71717a;
}
.storyboard-control-strip,
.continuity-strip {
  margin: 8px 0 0 36px;
  padding: 7px 9px;
  border: 1px solid rgba(63, 63, 70, 0.8);
  border-radius: 7px;
  background: rgba(24, 24, 27, 0.72);
}
.continuity-strip { border-color: rgba(99, 102, 241, 0.38); }
.camera-control-strip {
  margin: 8px 0 0 36px;
  padding: 7px 9px;
  border: 1px solid rgba(245, 158, 11, 0.32);
  border-radius: 7px;
  background: rgba(24, 24, 27, 0.72);
}
.camera-control-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
  margin-top: 6px;
}
.camera-control-hint {
  margin-top: 5px;
  color: #71717a;
  font-size: 10px;
}
.control-head,
.continuity-meta,
.continuity-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.control-head {
  color: #d4d4d8;
  font-size: 11px;
  font-weight: 600;
}
.control-meta,
.continuity-meta,
.continuity-muted {
  margin-top: 4px;
  color: #a1a1aa;
  font-size: 10px;
  line-height: 1.5;
}
.continuity-meta {
  justify-content: space-between;
  gap: 12px;
}
.continuity-meta span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.continuity-actions { margin-top: 4px; }
.continuity-muted { margin-top: 0; color: #71717a; }
.prompt-preview {
  max-width: 500px;
  max-height: 260px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  color: #27272a;
  font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.meta-row {
  display: flex;
  gap: 10px;
}
.meta-item { flex: 1; min-width: 0; }
.meta-item.narrow { max-width: 140px; flex: 0 0 140px; }
.text-row-2 {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.flex-1 { flex: 1; min-width: 0; }
.panel-actions {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(63, 63, 70, 0.8);
}
.fixed-action-bar {
  position: sticky;
  bottom: 0;
  z-index: 6;
  margin: 10px -4px 0;
  padding: 8px;
  border: 1px solid rgba(63, 63, 70, 0.88);
  border-radius: 11px;
  background: rgba(15, 15, 18, 0.98);
  box-shadow: 0 -8px 22px rgba(0, 0, 0, 0.32);
}
.action-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 18px;
  color: #a1a1aa;
  font-size: 11px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #71717a;
}
.action-status.busy .status-dot {
  background: #60a5fa;
  animation: pulse-tag 1.2s ease-in-out infinite;
}
.action-status.success .status-dot { background: #22c55e; }
.action-status.error {
  color: #fca5a5;
}
.action-status.error .status-dot { background: #ef4444; }
.action-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.action-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  border-right: 1px solid rgba(63, 63, 70, 0.72);
}
.action-group:last-child {
  padding-right: 0;
  border-right: 0;
}
.danger-group {
  margin-left: auto;
}
.panel-actions :deep(.el-button) {
  margin: 0;
}
@keyframes pulse-tag {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.65; }
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
