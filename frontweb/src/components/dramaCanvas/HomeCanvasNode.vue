<template>
  <article
    ref="nodeRoot"
    class="home-canvas-node"
    :class="[`kind-${data.kind}`, `state-${data.status || 'idle'}`, { 'is-selected': isSelected }]"
    :style="data.imageMarkerColor ? { '--image-node-marker': data.imageMarkerColor } : undefined"
  >
    <header class="node-heading">
      <span class="node-icon" aria-hidden="true">{{ kindIcon }}</span>
      <input
        v-model="draft.title"
        class="node-title-input"
        aria-label="节点标题"
        maxlength="80"
        @mousedown.stop
        @input="scheduleDraftSave"
        @blur="saveDraft"
        @keydown.enter.prevent="$event.target.blur()"
      />
      <span class="sr-only">{{ draft.title }}</span>
      <button
        v-if="canExtractLastFrame"
        type="button"
        class="last-frame-button nodrag nopan"
        :disabled="extractingLastFrame"
        @mousedown.stop
        @click.stop="extractLastFrame"
      >
        {{ extractingLastFrame ? '提取中…' : '一键提取尾帧' }}
      </button>
      <div v-if="data.kind !== 'text' && (canUpload || canMountAsset)" class="node-media-actions nodrag nopan" @mousedown.stop>
        <button v-if="canMountAsset" type="button" class="upload-button" @click.stop="openAssetLibrary">素材库</button>
        <button v-if="canUpload" type="button" class="upload-button" @click.stop="chooseFile">上传</button>
      </div>
      <span class="node-status">{{ statusLabel }}</span>
      <button class="node-delete nodrag nopan" type="button" aria-label="删除节点" title="删除节点" @mousedown.stop @click.stop="deleteNode">×</button>
    </header>

    <Handle class="node-handle node-handle-input" type="target" :position="Position.Left" />
    <Handle class="node-handle node-handle-output" type="source" :position="Position.Right" />
    <section v-if="data.kind === 'text'" class="text-preview">
      <span class="text-preview-icon" aria-hidden="true">☰</span>
      <p>{{ draft.content || '点击节点展开文本编辑器' }}</p>
    </section>

    <section v-else class="media-stage">
      <img
        v-if="data.kind === 'image' && primaryResultUrl"
        :src="primaryResultUrl"
        :alt="data.title || '图片节点预览'"
        class="node-media"
        draggable="false"
        title="双击全屏查看"
        @dragstart.prevent
        @click.stop="scheduleMediaOpen"
        @dblclick.stop="openMediaPreview(primaryResultUrl, 'image')"
      />
      <video
        v-else-if="data.kind === 'video' && primaryResultUrl"
        :src="primaryResultUrl"
        class="node-media"
        controls
        muted
        playsinline
        title="双击全屏查看"
        @click.stop="scheduleMediaOpen"
        @dblclick.stop="openMediaPreview(primaryResultUrl, 'video')"
      />
      <audio v-else-if="data.kind === 'audio' && primaryResultUrl" :src="primaryResultUrl" class="node-audio" controls />
      <div v-else class="media-empty">
        <span class="media-empty-icon" aria-hidden="true">{{ kindIcon }}</span>
        <span>{{ mediaEmptyLabel }}</span>
      </div>
      <div v-if="primaryResultUrl" class="result-actions">
        <button type="button" aria-label="下载结果" title="下载结果" @click="downloadResult">↓</button>
        <button type="button" aria-label="复制结果引用" title="复制结果引用" @click="copyResultReference">⧉</button>
      </div>
      <input ref="fileInput" class="file-input" type="file" :accept="accept" @change="uploadFile" />
    </section>

    <ImageNodeToolbar
      v-if="data.kind === 'image' && data.url"
      :node-id="id"
      :data="data"
    />

    <Teleport to="body">
      <section
        v-if="isSelected && !hasMultiSelection && !editorHidden"
        class="node-expanded-editor canvas-node-panel nodrag nopan"
        :class="[`editor-${data.kind}`, { 'is-fullscreen': editorFullscreen }]"
        :style="editorFullscreen ? undefined : editorPanelStyle"
        :data-editor-dock="editorDock"
        role="region"
        :aria-label="editorLabel"
        @mousedown.stop
      >
        <div class="editor-heading">
          <div>
            <span class="editor-kind">{{ editorKindLabel }}</span>
            <span class="editor-hint">连线、素材与参数会随当前节点保存</span>
          </div>
          <div class="editor-window-actions">
            <button type="button" aria-label="全屏编辑" :title="editorFullscreen ? '退出全屏' : '全屏编辑'" @click="editorFullscreen = !editorFullscreen">⛶</button>
            <button type="button" aria-label="关闭编辑器" title="关闭编辑器" @click="closeEditor">×</button>
          </div>
        </div>

        <div v-if="data.kind === 'video'" class="video-mode-toolbar">
          <div class="video-mode-tabs" role="tablist" aria-label="视频参考模式">
            <button
              type="button"
              :class="{ active: videoReferenceMode === 'first-last' }"
              role="tab"
              :aria-selected="videoReferenceMode === 'first-last'"
              @click="setVideoReferenceMode('first-last')"
            >
              首尾帧
            </button>
            <button
              type="button"
              :class="{ active: videoReferenceMode === 'multi' }"
              role="tab"
              :aria-selected="videoReferenceMode === 'multi'"
              @click="setVideoReferenceMode('multi')"
            >
              多图参考
            </button>
            <button type="button" role="tab" aria-selected="false" disabled title="当前生成链路尚未开放动作模仿">动作模仿</button>
            <button type="button" role="tab" aria-selected="false" disabled title="当前生成链路尚未开放全能参考">全能参考</button>
            <button type="button" role="tab" aria-selected="false" disabled title="当前生成链路尚未开放视频编辑">视频编辑</button>
          </div>
          <label class="camera-pill">
            <span>运镜</span>
            <select v-model="draft.cameraMovement" aria-label="视频运镜" @change="saveDraft">
              <option value="">自动</option>
              <option value="push-in">推进</option>
              <option value="pull-out">拉远</option>
              <option value="pan-left">左摇</option>
              <option value="pan-right">右摇</option>
              <option value="orbit">环绕</option>
              <option value="handheld">手持</option>
            </select>
          </label>
        </div>

        <section v-if="['image', 'video'].includes(data.kind)" class="reference-panel" aria-label="自动参考图">
          <div class="reference-heading">
            <strong>参考图 · 连线自动采用</strong>
            <span v-if="inputReferences.length">{{ readyReferenceCount }}/{{ inputReferences.length }} 已就绪</span>
          </div>
          <div class="reference-actions">
            <button v-if="canUpload" type="button" aria-label="上传参考图" @click="chooseReferenceFile">+ 上传参考图</button>
            <input
              v-if="canUpload"
              ref="referenceFileInput"
              class="file-input"
              type="file"
              accept="image/*"
              @change="uploadReferenceFile"
            />
          </div>
          <div v-if="inputReferences.length" class="reference-list">
            <figure
              v-for="(reference, index) in inputReferences"
              :key="reference.nodeId"
              class="reference-card"
              :data-reference-state="reference.ready ? 'ready' : 'pending'"
              :title="`右键引用为 @图片${index + 1}`"
              @mousedown.right.prevent
              @contextmenu.prevent.stop="insertReferenceToken(index)"
            >
              <span class="reference-index">{{ index + 1 }}</span>
              <button
                class="reference-remove"
                type="button"
                aria-label="取消参考图"
                title="取消参考图"
                @click.stop="removeReference(reference)"
              >×</button>
              <img v-if="reference.url" :src="reference.url" :alt="reference.title" />
              <span v-else class="reference-placeholder">等待图片</span>
              <figcaption :title="reference.title">图片{{ index + 1 }}</figcaption>
            </figure>
          </div>
          <p v-else-if="data.kind === 'video'" class="reference-empty">把图片节点连接到视频节点，生成时会自动采用为首帧和参考图。</p>
          <p v-else class="reference-empty">把图片节点连接到图片节点，生成时会自动采用为参考图。</p>
        </section>

        <div v-if="data.kind === 'text'" class="text-toolbar" aria-label="文本格式工具栏">
          <button type="button" aria-label="一级标题" @click="prefixSelection('# ')">H1</button>
          <button type="button" aria-label="二级标题" @click="prefixSelection('## ')">H2</button>
          <button type="button" aria-label="加粗" @click="wrapSelection('**')"><b>B</b></button>
          <button type="button" aria-label="斜体" @click="wrapSelection('_')"><i>I</i></button>
          <button type="button" aria-label="项目列表" @click="prefixSelection('- ')">☷</button>
        </div>

        <div class="prompt-editor">
          <textarea
            ref="contentInput"
            v-model="draft.content"
            :class="data.kind === 'text' ? 'node-textarea' : 'prompt-input'"
            :aria-label="data.kind === 'text' ? '文本内容' : '生成提示词'"
            :placeholder="data.kind === 'text' ? '写下内容，或输入要求后让 AI 继续创作…' : promptPlaceholder"
            @input="handleEditorInput"
            @select="rememberContentSelection"
            @blur="handleContentBlur"
          />
          <div
            v-if="showReferenceMention"
            class="reference-mention-menu"
            aria-label="@选择参考图"
          >
            <button
              v-for="candidate in filteredReferenceCandidates"
              :key="candidate.nodeId"
              type="button"
              @mousedown.prevent="selectReferenceMention(candidate)"
            >
              <img :src="candidate.url" alt="" />
              <span>{{ candidate.title }}</span>
            </button>
            <p v-if="!filteredReferenceCandidates.length">没有可引用的图片节点</p>
          </div>
        </div>

        <div v-if="data.kind === 'audio'" class="audio-toolbar" aria-label="语音文本工具栏">
          <button type="button" aria-label="插入停顿" @mousedown.prevent @click="insertAudioText('……')">停顿</button>
          <button type="button" aria-label="插入语气词" @mousedown.prevent @click="insertAudioText('嗯，')">语气词</button>
        </div>

        <div class="editor-options">
          <label v-if="canGenerate" class="editor-field field-model">
            <span>模型</span>
            <input
              v-model="draft.model"
              aria-label="生成模型"
              :placeholder="defaultModelLabel"
              :list="modelOptions.length ? modelListId : undefined"
              @blur="saveDraft"
            />
          </label>
          <datalist v-if="modelOptions.length" :id="modelListId">
            <option v-for="model in modelOptions" :key="model" :value="model" />
          </datalist>

          <label v-if="['image', 'video'].includes(data.kind)" class="editor-field">
            <span>风格</span>
            <input v-model="draft.style" aria-label="风格" placeholder="电影感、写实…" @blur="saveDraft" />
          </label>
          <label v-if="['image', 'video'].includes(data.kind)" class="editor-field">
            <span>比例</span>
            <select v-model="draft.aspectRatio" aria-label="画面比例" @change="saveDraft">
              <option v-for="value in capability.aspectRatios || []" :key="value" :value="value">{{ value }}</option>
            </select>
          </label>
          <label v-if="['image', 'video'].includes(data.kind)" class="editor-field">
            <span>清晰度</span>
            <select v-model="draft.resolution" aria-label="清晰度" @change="saveDraft">
              <option v-for="value in capability.resolutions || []" :key="value" :value="value">{{ value }}</option>
            </select>
          </label>
          <label v-if="['image', 'video'].includes(data.kind)" class="editor-field">
            <span>数量</span>
            <select v-model.number="draft.quantity" aria-label="生成数量" @change="saveDraft">
              <option v-for="value in capability.quantities || [1]" :key="value" :value="value">{{ value }} 个</option>
            </select>
          </label>
          <label v-if="data.kind === 'image'" class="editor-field field-wide">
            <span>排除</span>
            <input v-model="draft.negativePrompt" aria-label="负面提示词" placeholder="模糊、畸形、文字水印…" @blur="saveDraft" />
          </label>
          <label v-if="data.kind === 'video'" class="editor-field">
            <span>时长</span>
            <select v-model.number="draft.duration" aria-label="视频时长" @change="saveDraft">
              <option v-for="value in capability.durations || []" :key="value" :value="value">{{ value }} 秒</option>
            </select>
          </label>
          <label v-if="data.kind === 'video'" class="editor-field">
            <span>特效</span>
            <select v-model="draft.effect" aria-label="视觉特效" @change="saveDraft">
              <option value="">无</option>
              <option value="film-grain">电影颗粒</option>
              <option value="slow-motion">慢动作</option>
              <option value="time-lapse">延时</option>
              <option value="light-leak">漏光</option>
            </select>
          </label>
          <label v-if="data.kind === 'video' && capability.supportsAudio !== false" class="editor-check">
            <input v-model="draft.includeAudio" type="checkbox" aria-label="生成音频" @change="saveDraft" />
            <span>同步音频</span>
          </label>
          <label v-if="data.kind === 'audio'" class="editor-field field-model">
            <span>音色</span>
            <input
              v-model="draft.voiceId"
              aria-label="音色"
              placeholder="默认音色或音色 ID"
              :list="voiceOptions.length ? voiceListId : undefined"
              @blur="saveDraft"
            />
            <datalist v-if="voiceOptions.length" :id="voiceListId">
              <option v-for="voice in voiceOptions" :key="voice.value" :value="voice.value">{{ voice.label }}</option>
            </datalist>
          </label>
          <label v-if="data.kind === 'audio'" class="editor-field">
            <span>语速</span>
            <select v-model.number="draft.speechRate" aria-label="语速" @change="saveDraft">
              <option :value="0.75">0.75×</option>
              <option :value="1">1.0×</option>
              <option :value="1.15">1.15×</option>
              <option :value="1.35">1.35×</option>
            </select>
          </label>
          <label v-if="data.kind === 'audio'" class="editor-field">
            <span>情绪</span>
            <select v-model="draft.speechEmotion" aria-label="情绪" @change="saveDraft">
              <option value="">自动</option>
              <option value="neutral">中性</option>
              <option value="happy">开心</option>
              <option value="sad">悲伤</option>
              <option value="angry">愤怒</option>
              <option value="fearful">害怕</option>
              <option value="disgusted">厌恶</option>
              <option value="surprised">惊讶</option>
            </select>
          </label>
          <label v-if="data.kind === 'audio'" class="editor-field">
            <span>音量</span>
            <input v-model.number="draft.speechVolume" aria-label="音量" type="number" min="0.1" max="10" step="0.1" @change="saveDraft" />
          </label>
          <label v-if="data.kind === 'audio'" class="editor-field">
            <span>音高</span>
            <input v-model.number="draft.speechPitch" aria-label="音高" type="number" min="-12" max="12" step="1" @change="saveDraft" />
          </label>
          <label v-if="data.kind === 'audio'" class="editor-field audio-pronunciation-field">
            <span>多音字（每行一条，如“燕少飞/(yan4)(shao3)(fei1)”）</span>
            <textarea v-model="draft.pronunciationTonesText" aria-label="多音字" rows="2" @blur="saveDraft" />
          </label>
        </div>

        <div
          v-if="data.status === 'running'"
          class="generation-progress"
          role="progressbar"
          aria-label="生成进度"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="generationProgress"
        >
          <div><span>生成进度</span><strong>{{ generationProgress }}%</strong></div>
          <span class="generation-progress-track"><i :style="{ width: `${generationProgress}%` }" /></span>
        </div>
        <p v-if="data.status === 'failed' && data.error" class="editor-error" role="alert">{{ data.error }}</p>

        <div class="editor-footer">
          <span v-if="canGenerate" class="billing-note">{{ estimatedCredits ? `本次预计扣除 ${estimatedCredits} 积分` : '本次消耗以实际结算为准' }} · {{ draft.quantity || 1 }} 次</span>
          <span v-if="canGenerate && capability.declared === false" class="billing-note">保守参数 · 最终由供应商校验</span>
          <span v-if="!canGenerate" class="local-draft-note">本地草稿仅保存内容；绑定项目后的独立画布才能运行模型与挂载素材。</span>
          <button v-if="canTranslate" type="button" class="advanced-button" aria-label="中英互译" title="中文与英文互译（按文本模型计费）" @click.stop="translateNode">中/英</button>
          <button v-if="canGenerate" type="button" class="advanced-button" aria-label="配置" title="节点完整配置" @click.stop="openConfig">参数</button>
          <button v-if="canGenerate" type="button" class="advanced-button" aria-label="运行下游" title="按依赖顺序运行当前节点及其下游" @click.stop="runSubgraph">运行下游</button>
          <button
            v-if="canGenerate"
            type="button"
            class="run-button"
            :disabled="data.status === 'running' || !draft.content.trim()"
            :aria-label="data.kind === 'text' ? 'AI 生成文本' : (data.status === 'failed' ? '重试' : '生成')"
            @click.stop="runNode"
          >
            {{ data.status === 'running' ? '生成中…' : '↑' }}
          </button>
        </div>
      </section>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="mediaPreviewUrl"
        class="image-lightbox nodrag nopan"
        role="dialog"
        aria-modal="true"
        :aria-label="mediaPreviewKind === 'image' ? '图片全屏预览' : '视频全屏预览'"
        @click.self="closeMediaPreview"
      >
        <button
          type="button"
          :aria-label="mediaPreviewKind === 'image' ? '关闭图片预览' : '关闭视频预览'"
          title="关闭"
          @click="closeMediaPreview"
        >×</button>
        <img v-if="mediaPreviewKind === 'image'" :src="mediaPreviewUrl" :alt="data.title || '图片预览'" />
        <video v-else :src="mediaPreviewUrl" controls autoplay playsinline />
      </div>
    </Teleport>

    <div v-if="data.error" class="node-error">{{ data.error }}</div>
    <div v-if="assetSaveFailed" class="node-asset-error">
      入库失败：{{ data.assetSaveError || '请重试' }}
      <button type="button" @click.stop="retryAssetSave">重试入库</button>
    </div>
  </article>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'
import ImageNodeToolbar from './ImageNodeToolbar.vue'

const props = defineProps({
  id: { type: String, default: '' },
  data: { type: Object, required: true },
  selected: { type: Boolean, default: false },
})

const ctx = useCanvasContext()
const nodeRoot = ref(null)
const contentInput = ref(null)
const fileInput = ref(null)
const referenceFileInput = ref(null)
const editorHidden = ref(false)
const editorFullscreen = ref(false)
const editorDock = ref('bottom')
const editorPanelStyle = ref({})
const mediaPreviewUrl = ref('')
const mediaPreviewKind = ref('image')
let draftSaveTimer = null
let draftDirty = false
let editorPositionFrame = null
let contentSelection = null
let mediaOpenTimer = null
const mentionStart = ref(-1)
const mentionEnd = ref(-1)
const mentionQuery = ref('')
const draft = reactive({
  title: '',
  content: '',
  model: '',
  aspectRatio: '16:9',
  duration: 5,
  style: '',
  resolution: '',
  quantity: 1,
  negativePrompt: '',
  voiceId: '',
  speechRate: 1,
  speechVolume: 1,
  speechPitch: 0,
  speechEmotion: '',
  pronunciationTonesText: '',
  cameraMovement: '',
  effect: '',
  includeAudio: false,
})
const kindIcon = computed(() => ({ text: 'T', image: '▧', video: '▣', audio: '♫' }[props.data.kind] || '◈'))
const mediaEmptyLabel = computed(() => {
  if (props.data.status === 'running') {
    return props.data.kind === 'video' ? '视频生成中…' : '图片生成中…'
  }
  return ({ image: '添加图片', video: '添加视频或参考帧', audio: '添加音频' }[props.data.kind] || '添加素材')
})
const accept = computed(() => ({ image: 'image/*', video: 'video/*,image/*', audio: 'audio/*' }[props.data.kind] || '*/*'))
const defaultModelLabel = computed(() => ({
  text: '默认文本模型',
  image: '默认图片模型',
  video: '默认视频模型',
  audio: '默认音频模型',
}[props.data.kind] || '默认模型'))
const editorKindLabel = computed(() => ({ text: '文本编辑', image: '图片生成', video: '视频生成', audio: '语音合成' }[props.data.kind] || '节点编辑'))
const editorLabel = computed(() => `${({ text: '文本', image: '图片', video: '视频', audio: '音频' }[props.data.kind] || '自由')}节点编辑器`)
const promptPlaceholder = computed(() => props.data.kind === 'audio' ? '输入要合成的文本' : '描述任何你想要生成的内容')
const canGenerate = computed(() => typeof ctx?.runFreeCanvasNode === 'function')
const canTranslate = computed(() => typeof ctx?.translateFreeCanvasNode === 'function' && Boolean(draft.content.trim()))
const canUpload = computed(() => typeof ctx?.uploadFreeCanvasNodeFile === 'function')
const canMountAsset = computed(() => typeof ctx?.openFreeNodeAssetLibrary === 'function')
const modelOptions = computed(() => ctx?.getFreeNodeModelOptions?.(props.data.kind) || [])
const capability = computed(() => ctx?.getFreeNodeModelCapability?.(props.data.kind, draft.model) || {})
const estimatedCredits = computed(() => ctx?.getFreeNodeEstimatedCredits?.(props.data.kind, draft.model, draft.quantity) || null)
const generationProgress = computed(() => Math.min(100, Math.max(0, Math.round(Number(props.data.progress) || 0))))
const voiceOptions = computed(() => ctx?.getFreeNodeVoiceOptions?.() || [])
const inputReferences = computed(() => (
  ['image', 'video'].includes(props.data.kind)
    ? (ctx?.getFreeNodeInputReferences?.(props.id) || [])
    : []
))
const videoReferenceMode = computed(() => (
  inputReferences.value.some((reference) => ['first-frame', 'last-frame'].includes(reference.slot))
    ? 'first-last'
    : 'multi'
))
const referenceCandidates = computed(() => (
  props.data.kind === 'video'
    ? (ctx?.getFreeNodeReferenceCandidates?.(props.id) || [])
    : []
))
const filteredReferenceCandidates = computed(() => {
  const query = mentionQuery.value.trim().toLowerCase()
  if (!query) return referenceCandidates.value
  return referenceCandidates.value.filter((candidate) => String(candidate.title || '').toLowerCase().includes(query))
})
const showReferenceMention = computed(() => props.data.kind === 'video' && mentionStart.value >= 0)
const readyReferenceCount = computed(() => inputReferences.value.filter((reference) => reference.ready).length)
const modelListId = computed(() => `free-node-models-${String(props.id || 'node').replace(/[^a-zA-Z0-9_-]/g, '-')}`)
const voiceListId = computed(() => `free-node-voices-${String(props.id || 'node').replace(/[^a-zA-Z0-9_-]/g, '-')}`)
const resultUrls = computed(() => [...new Set([
  ...(Array.isArray(props.data.resultUrls) ? props.data.resultUrls : []),
  props.data.url,
].filter(Boolean))])
const primaryResultUrl = computed(() => String(props.data.url || resultUrls.value[0] || ''))
const extractingLastFrame = ref(false)
const canExtractLastFrame = computed(() => (
  props.data.kind === 'video'
  && Boolean(primaryResultUrl.value)
  && typeof ctx?.createImageNodeFromVideoLastFrame === 'function'
))
const isSelected = computed(() => (
  props.selected
  || ctx?.focusedNodeId?.value === props.id
  || Boolean(ctx?.isFreeCanvasNodeSelected?.(props.id))
))
const hasMultiSelection = computed(() => (ctx?.selectedFreeNodeIds?.value?.length || 0) > 1)
const assetSaveFailed = computed(() => props.data.status === 'success' && props.data.assetSaveStatus === 'failed' && Boolean(primaryResultUrl.value))
const statusLabel = computed(() => ({ running: '运行中', success: '已生成', failed: '失败' }[props.data.status] || (canGenerate.value ? '待配置' : '本地草稿')))

function syncDraft() {
  draft.title = props.data.title || ''
  draft.content = props.data.content || ''
  draft.model = props.data.model || ''
  draft.aspectRatio = props.data.aspectRatio || '16:9'
  draft.duration = Number(props.data.duration) || 5
  draft.style = props.data.style || ''
  draft.resolution = props.data.resolution || (props.data.kind === 'image' ? '2K' : '720p')
  draft.quantity = Math.min(4, Math.max(1, Number(props.data.quantity) || 1))
  draft.negativePrompt = props.data.negativePrompt || ''
  draft.voiceId = props.data.voiceId || ''
  draft.speechRate = Number(props.data.speechRate) || 1
  draft.speechVolume = Number(props.data.speechVolume) || 1
  draft.speechPitch = Number(props.data.speechPitch) || 0
  draft.speechEmotion = props.data.speechEmotion || ''
  draft.pronunciationTonesText = Array.isArray(props.data.pronunciationTones)
    ? props.data.pronunciationTones.join('\n')
    : ''
  draft.cameraMovement = props.data.cameraMovement || ''
  draft.effect = props.data.effect || ''
  draft.includeAudio = props.data.includeAudio === true
}

async function saveDraft() {
  if (draftSaveTimer) {
    window.clearTimeout(draftSaveTimer)
    draftSaveTimer = null
  }
  await ctx?.updateFreeCanvasNode?.(props.id, {
    title: draft.title.trim() || '未命名节点',
    content: draft.content,
    model: draft.model.trim(),
    aspectRatio: draft.aspectRatio,
    duration: Number(draft.duration) || 5,
    style: draft.style.trim(),
    resolution: draft.resolution,
    quantity: Math.min(4, Math.max(1, Number(draft.quantity) || 1)),
    negativePrompt: draft.negativePrompt.trim(),
    voiceId: draft.voiceId.trim(),
    speechRate: Number(draft.speechRate) || 1,
    speechVolume: Math.min(10, Math.max(0.1, Number(draft.speechVolume) || 1)),
    speechPitch: Math.min(12, Math.max(-12, Number(draft.speechPitch) || 0)),
    speechEmotion: draft.speechEmotion,
    pronunciationTones: draft.pronunciationTonesText
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
    cameraMovement: draft.cameraMovement,
    effect: draft.effect,
    includeAudio: draft.includeAudio === true,
  })
  draftDirty = false
}

function scheduleDraftSave() {
  draftDirty = true
  if (draftSaveTimer) window.clearTimeout(draftSaveTimer)
  draftSaveTimer = window.setTimeout(() => {
    draftSaveTimer = null
    void saveDraft()
  }, 250)
}

function selectionRange() {
  const input = contentInput.value
  return input ? { input, start: input.selectionStart, end: input.selectionEnd } : null
}

function wrapSelection(marker) {
  const range = selectionRange()
  if (!range) return
  const selectedText = draft.content.slice(range.start, range.end)
  draft.content = `${draft.content.slice(0, range.start)}${marker}${selectedText}${marker}${draft.content.slice(range.end)}`
  void saveDraft()
}

function prefixSelection(prefix) {
  const range = selectionRange()
  if (!range) return
  const lineStart = draft.content.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1
  draft.content = `${draft.content.slice(0, lineStart)}${prefix}${draft.content.slice(lineStart)}`
  void saveDraft()
}

function insertAudioText(text) {
  const range = selectionRange()
  if (!range) {
    draft.content += text
    void saveDraft()
    return
  }
  draft.content = `${draft.content.slice(0, range.start)}${text}${draft.content.slice(range.end)}`
  void saveDraft()
}

function chooseFile() {
  fileInput.value?.click()
}

function handlePromptInput(event) {
  if (props.data.kind !== 'video') return
  const value = String(event.target.value || '')
  const cursor = Number(event.target.selectionStart ?? value.length)
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) {
    mentionStart.value = -1
    mentionEnd.value = -1
    mentionQuery.value = ''
    return
  }
  mentionStart.value = cursor - match[1].length - 1
  mentionEnd.value = cursor
  mentionQuery.value = match[1]
}

function handleEditorInput(event) {
  rememberContentSelection(event)
  handlePromptInput(event)
  scheduleDraftSave()
}

function rememberContentSelection(event) {
  const input = event?.target
  if (!input) return
  contentSelection = {
    start: Number(input.selectionStart ?? String(draft.content || '').length),
    end: Number(input.selectionEnd ?? input.selectionStart ?? String(draft.content || '').length),
  }
}

function handleContentBlur(event) {
  rememberContentSelection(event)
  void saveDraft()
}

async function selectReferenceMention(candidate) {
  const sourceNodeId = String(candidate?.nodeId || '')
  if (!sourceNodeId || mentionStart.value < 0) return
  const cursor = mentionStart.value + String(candidate.title || '').length + 2
  draft.content = `${draft.content.slice(0, mentionStart.value)}@${candidate.title} ${draft.content.slice(mentionEnd.value)}`
  mentionStart.value = -1
  mentionEnd.value = -1
  mentionQuery.value = ''
  ctx?.attachFreeCanvasReference?.(props.id, sourceNodeId)
  await saveDraft()
  await nextTick()
  contentInput.value?.focus()
  contentInput.value?.setSelectionRange(cursor, cursor)
}

async function insertReferenceToken(index) {
  if (props.data.kind !== 'video') return
  const input = contentInput.value
  const value = String(draft.content || '')
  const liveSelection = input && document.activeElement === input
    ? {
        start: Number(input.selectionStart ?? value.length),
        end: Number(input.selectionEnd ?? input.selectionStart ?? value.length),
      }
    : contentSelection
  const start = liveSelection ? liveSelection.start : value.length
  const end = liveSelection ? liveSelection.end : start
  const before = value.slice(0, start)
  const after = value.slice(end)
  const token = `@图片${index + 1}`
  const leadingSpace = before && !/\s$/.test(before) ? ' ' : ''
  const trailingSpace = after && !/^\s/.test(after) ? ' ' : ''
  const insertion = `${leadingSpace}${token}${trailingSpace || (after ? '' : ' ')}`
  draft.content = `${before}${insertion}${after}`
  const cursor = before.length + insertion.length
  await saveDraft()
  await nextTick()
  input?.focus()
  input?.setSelectionRange(cursor, cursor)
  contentSelection = { start: cursor, end: cursor }
}

function chooseReferenceFile() {
  referenceFileInput.value?.click()
}

function openConfig() {
  editorFullscreen.value = false
  ctx?.openFreeNodeConfig?.(props.id)
}

function openEditor() {
  editorHidden.value = false
  ctx?.setFocusedNode?.(props.id)
  nextTick(startEditorPositionTracking)
}

function closeEditor() {
  editorHidden.value = true
  editorFullscreen.value = false
  stopEditorPositionTracking()
}

function updateEditorPosition() {
  if (!isSelected.value || editorHidden.value || editorFullscreen.value || !nodeRoot.value) return
  const bounds = nodeRoot.value.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const viewportPadding = 16
  const nodeGap = 12
  const panelWidth = Math.max(1, Math.min(860, viewportWidth - viewportPadding * 2))
  const desiredLeft = bounds.left + bounds.width / 2 - panelWidth / 2
  const panelLeft = Math.min(
    Math.max(viewportPadding, desiredLeft),
    Math.max(viewportPadding, viewportWidth - panelWidth - viewportPadding),
  )
  const spaceAbove = Math.max(0, bounds.top - nodeGap - viewportPadding)
  const spaceBelow = Math.max(0, viewportHeight - bounds.bottom - nodeGap - viewportPadding)
  const dock = spaceBelow >= spaceAbove ? 'bottom' : 'top'
  const availableHeight = dock === 'bottom' ? spaceBelow : spaceAbove

  editorDock.value = dock
  const nextStyle = {
    top: dock === 'bottom' ? `${Math.round(bounds.bottom + nodeGap)}px` : 'auto',
    right: 'auto',
    bottom: dock === 'top' ? `${Math.round(viewportHeight - bounds.top + nodeGap)}px` : 'auto',
    left: `${Math.round(panelLeft)}px`,
    width: `${Math.round(panelWidth)}px`,
    maxHeight: `${Math.max(1, Math.floor(availableHeight))}px`,
  }
  if (Object.entries(nextStyle).some(([key, value]) => editorPanelStyle.value[key] !== value)) {
    editorPanelStyle.value = nextStyle
  }
}

function startEditorPositionTracking() {
  if (editorPositionFrame != null || !isSelected.value || editorHidden.value) return
  const track = () => {
    editorPositionFrame = null
    if (!isSelected.value || editorHidden.value) return
    updateEditorPosition()
    editorPositionFrame = window.requestAnimationFrame(track)
  }
  editorPositionFrame = window.requestAnimationFrame(track)
}

function stopEditorPositionTracking() {
  if (editorPositionFrame == null) return
  window.cancelAnimationFrame(editorPositionFrame)
  editorPositionFrame = null
}

function openMediaPreview(url, kind = 'image') {
  if (mediaOpenTimer) {
    window.clearTimeout(mediaOpenTimer)
    mediaOpenTimer = null
  }
  if (!url) return
  openEditor()
  mediaPreviewUrl.value = String(url)
  mediaPreviewKind.value = kind
}

function scheduleMediaOpen() {
  if (mediaOpenTimer) window.clearTimeout(mediaOpenTimer)
  mediaOpenTimer = window.setTimeout(() => {
    mediaOpenTimer = null
    openEditor()
  }, 250)
}

function closeMediaPreview() {
  mediaPreviewUrl.value = ''
  mediaPreviewKind.value = 'image'
}

function openAssetLibrary() {
  ctx?.openFreeNodeAssetLibrary?.(props.id)
}

async function uploadFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) await ctx?.uploadFreeCanvasNodeFile?.(props.id, file)
}

async function uploadReferenceFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) await ctx?.uploadFreeCanvasReferenceImage?.(props.id, file)
}

async function deleteNode() {
  await ctx?.deleteFreeCanvasNode?.(props.id)
}

async function runNode() {
  await saveDraft()
  await ctx?.runFreeCanvasNode?.(props.id)
}

function retryAssetSave() {
  ctx?.retryFreeCanvasAssetSave?.(props.id)
}

async function runSubgraph() {
  await saveDraft()
  await ctx?.runFreeCanvasSubgraph?.(props.id)
}

function updateReference(reference, patch) {
  ctx?.updateFreeCanvasReference?.(reference.edgeId, patch)
}

function setVideoReferenceMode(mode) {
  if (props.data.kind !== 'video') return
  inputReferences.value.forEach((reference, index) => {
    const input = mode === 'first-last'
      ? (index === 0 ? 'first-frame' : index === 1 ? 'last-frame' : 'reference-image')
      : 'reference-image'
    updateReference(reference, { input })
  })
}

function removeReference(reference) {
  if (!reference?.edgeId) return
  ctx?.detachFreeCanvasReference?.(reference.edgeId)
}

async function translateNode() {
  await saveDraft()
  await ctx?.translateFreeCanvasNode?.(props.id)
}

async function extractLastFrame() {
  if (!canExtractLastFrame.value || extractingLastFrame.value) return
  extractingLastFrame.value = true
  try {
    await ctx.createImageNodeFromVideoLastFrame?.(props.id)
  } finally {
    extractingLastFrame.value = false
  }
}

function downloadResult() {
  const url = primaryResultUrl.value
  if (!url) return
  const link = document.createElement('a')
  link.href = url
  link.download = ''
  link.rel = 'noopener'
  link.click()
}

async function copyResultReference() {
  const url = primaryResultUrl.value
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
  } catch {
    window.prompt('复制结果引用', url)
  }
}

function onEditorKeydown(event) {
  if (event.key !== 'Escape') return
  if (mediaPreviewUrl.value) {
    event.preventDefault()
    closeMediaPreview()
    return
  }
  if (!isSelected.value || editorHidden.value) return
  event.preventDefault()
  if (editorFullscreen.value) editorFullscreen.value = false
  else closeEditor()
}

onMounted(() => {
  window.addEventListener('keydown', onEditorKeydown)
  window.addEventListener('resize', updateEditorPosition)
  if (isSelected.value) nextTick(startEditorPositionTracking)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEditorKeydown)
  window.removeEventListener('resize', updateEditorPosition)
  stopEditorPositionTracking()
  if (draftSaveTimer) window.clearTimeout(draftSaveTimer)
  if (mediaOpenTimer) window.clearTimeout(mediaOpenTimer)
})

watch(() => props.data, () => {
  if (!draftDirty) syncDraft()
}, { deep: true, immediate: true })
watch(isSelected, (selected) => {
  if (selected) {
    editorHidden.value = false
    nextTick(startEditorPositionTracking)
  }
  else {
    stopEditorPositionTracking()
    editorFullscreen.value = false
    closeMediaPreview()
  }
})
</script>

<style scoped>
.home-canvas-node {
  position: relative;
  width: 340px;
  padding: 0;
  color: #e4e4e7;
  cursor: default;
}
.home-canvas-node.kind-image,
.home-canvas-node.kind-video {
  width: 640px;
}
.home-canvas-node::before {
  content: '';
  position: absolute;
  inset: 38px -10px -10px;
  z-index: -1;
  border: 2px solid #3f3f46;
  border-radius: 24px;
  background: #161618;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.35);
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.home-canvas-node.is-selected::before {
  border-color: #fb7b3b;
  box-shadow: 0 16px 38px rgba(251, 123, 59, 0.16);
}
:global(.vue-flow__node:has(.home-canvas-node:hover)),
:global(.vue-flow__node:has(.home-canvas-node:focus-within)) {
  z-index: 2000 !important;
}
:global(.vue-flow__node.selected:has(.home-canvas-node)) {
  z-index: 2001 !important;
}
.node-heading { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 4px; cursor: grab; user-select: none; }
.node-heading:active { cursor: grabbing; }
.node-icon { color: #a1a1aa; font-size: 15px; }
.node-title-input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: #d4d4d8;
  font-size: 13px;
  cursor: text;
}
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.node-status { color: #71717a; font-size: 10px; }
.last-frame-button {
  flex: 0 0 auto;
  padding: 5px 10px;
  border: 1px solid #7c2d12;
  border-radius: 999px;
  background: #2b1710;
  color: #fb923c;
  font-size: 11px;
  cursor: pointer;
}
.last-frame-button:hover { border-color: #ea580c; background: #3a1d12; }
.last-frame-button:disabled { cursor: wait; opacity: .65; }
.node-media-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.node-media-actions .upload-button { padding: 4px 10px; border-radius: 8px; font-size: 11px; }
.node-delete {
  width: 28px;
  height: 28px;
  border: 0;
  background: transparent;
  color: #71717a;
  font-size: 20px;
  cursor: pointer;
}
.node-delete:hover { color: #fb7185; }
.node-handle {
  width: 18px;
  height: 18px;
  top: calc(50% + 19px);
  z-index: 4;
  border: 1px solid #52525b;
  background: #18181b;
}
.node-handle::after { content: '+'; display: grid; height: 100%; place-items: center; color: #d4d4d8; font-size: 13px; line-height: 1; }
.node-handle-input { left: -15px; }
.node-handle-output { right: -15px; }
.text-preview, .media-stage { margin: 10px; border: 1px solid #35353a; border-radius: 16px; background: #18181b; }
.home-canvas-node.is-selected .text-preview,
.home-canvas-node.is-selected .media-stage { cursor: grab; }
.home-canvas-node.is-selected .text-preview:active,
.home-canvas-node.is-selected .media-stage:active { cursor: grabbing; }
.text-preview {
  display: grid;
  min-height: 220px;
  padding: 26px;
  place-content: center;
  gap: 14px;
  color: #71717a;
  text-align: center;
  box-sizing: border-box;
}
.text-preview-icon { color: #52525b; font-size: 42px; }
.text-preview p {
  display: -webkit-box;
  max-width: 230px;
  margin: 0;
  overflow: hidden;
  color: #a1a1aa;
  font-size: 12px;
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}
.node-expanded-editor {
  position: fixed;
  top: 16px;
  right: auto;
  bottom: auto;
  left: 16px;
  z-index: 3100;
  width: min(860px, calc(100vw - 48px));
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 18px;
  border: 1px solid #3f3f46;
  border-radius: 24px;
  background: #1c1c1f;
  box-shadow: 0 22px 56px rgba(0, 0, 0, 0.5);
  box-sizing: border-box;
}
.node-expanded-editor.is-fullscreen {
  position: fixed;
  inset: 16px;
  z-index: 3200;
  width: auto;
  max-height: none;
  transform: none;
}
.node-expanded-editor.is-fullscreen .prompt-input,
.node-expanded-editor.is-fullscreen .node-textarea {
  min-height: min(54vh, 640px);
  resize: vertical;
}
.editor-heading, .reference-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.editor-heading { margin-bottom: 18px; }
.editor-heading > div { display: flex; align-items: center; gap: 12px; }
.editor-kind { color: #f4f4f5; font-size: 14px; font-weight: 650; }
.editor-hint, .reference-heading span { color: #71717a; font-size: 11px; }
.editor-window-actions { display: flex; gap: 6px; }
.editor-window-actions button {
  width: 34px;
  height: 34px;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  background: #202024;
  color: #d4d4d8;
  cursor: pointer;
}
.video-mode-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -6px 0 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid #2f2f33;
}
.video-mode-tabs {
  display: flex;
  min-width: 0;
  gap: 4px;
  padding: 4px;
  overflow-x: auto;
  border-radius: 14px;
  background: #27272a;
}
.video-mode-tabs button {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: #a1a1aa;
  cursor: pointer;
}
.video-mode-tabs button.active {
  background: #52525b;
  color: #fafafa;
}
.video-mode-tabs button:disabled {
  opacity: .38;
  cursor: not-allowed;
}
.camera-pill {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid #3f3f46;
  border-radius: 999px;
  color: #d4d4d8;
  background: #202024;
}
.camera-pill select {
  max-width: 100px;
  border: 0;
  outline: 0;
  color: inherit;
  background: transparent;
}
.reference-panel {
  margin-bottom: 16px;
  padding: 14px;
  border: 1px solid #35353a;
  border-radius: 16px;
  background: #161618;
}
.reference-heading strong { color: #d4d4d8; font-size: 12px; }
.reference-actions { display: flex; gap: 10px; margin-top: 12px; }
.reference-actions button,
.reference-actions select {
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  background: #202024;
  color: #d4d4d8;
}
.reference-actions select { min-width: 190px; }
.reference-list { display: flex; gap: 10px; margin-top: 12px; overflow-x: auto; }
.reference-card {
  position: relative;
  width: 94px;
  flex: 0 0 94px;
  margin: 0;
}
.reference-card img, .reference-placeholder {
  display: grid;
  width: 94px;
  height: 72px;
  place-items: center;
  border: 1px solid #52525b;
  border-radius: 12px;
  background: #27272a;
  color: #71717a;
  object-fit: cover;
  font-size: 11px;
}
.reference-card[data-reference-state='ready'] img { border-color: #60a5fa; }
.reference-index {
  position: absolute;
  top: 5px;
  left: 5px;
  z-index: 1;
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border-radius: 50%;
  background: rgba(9, 9, 11, 0.84);
  color: #f4f4f5;
  font-size: 10px;
}
.reference-remove {
  position: absolute;
  top: 5px;
  right: 5px;
  z-index: 2;
  display: grid;
  width: 20px;
  height: 20px;
  padding: 0;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 50%;
  background: rgba(9, 9, 11, 0.84);
  color: #f4f4f5;
  cursor: pointer;
}
.reference-remove:hover { border-color: #fb7185; color: #fb7185; }
.reference-card figcaption {
  margin-top: 6px;
  overflow: hidden;
  color: #a1a1aa;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reference-empty { margin: 10px 0 0; color: #71717a; font-size: 11px; }
.text-toolbar { display: flex; gap: 3px; padding: 8px 10px; border-bottom: 1px solid #2f2f33; }
.audio-toolbar { display: flex; gap: 8px; margin-top: 10px; }
.audio-toolbar button {
  padding: 7px 12px;
  border: 1px solid #3f3f46;
  border-radius: 9px;
  background: #29292d;
  color: #d4d4d8;
  cursor: pointer;
}
.text-toolbar button {
  min-width: 32px;
  height: 30px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #a1a1aa;
  cursor: pointer;
}
.text-toolbar button:hover { background: #27272a; color: #fb7b3b; }
.node-textarea, .prompt-input {
  width: 100%;
  resize: none;
  border: 0;
  outline: 0;
  background: transparent;
  color: #e4e4e7;
  font: inherit;
  box-sizing: border-box;
}
.node-textarea { min-height: 160px; padding: 16px; font-size: 14px; line-height: 1.7; }
.media-stage { position: relative; min-height: 230px; overflow: hidden; }
.node-media { display: block; width: 100%; height: 230px; background: #09090b; object-fit: contain; }
.kind-image .media-stage,
.kind-video .media-stage,
.kind-image .media-empty,
.kind-video .media-empty { min-height: 360px; }
.kind-image .node-media,
.kind-video .node-media { height: 360px; }
.node-audio { width: calc(100% - 32px); margin: 96px 16px; }
.media-empty { min-height: 230px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #71717a; }
.media-empty-icon { color: #d4d4d8; font-size: 42px; }
.upload-button {
  padding: 7px 16px;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  background: #202024;
  color: #d4d4d8;
  cursor: pointer;
}
.result-actions button {
  display: grid;
  width: 34px;
  height: 34px;
  padding: 0;
  place-items: center;
  overflow: hidden;
  border: 1px solid #52525b;
  border-radius: 9px;
  background: rgba(24, 24, 27, 0.9);
  color: #e4e4e7;
  cursor: pointer;
}
.result-actions { position: absolute; top: 12px; right: 12px; display: flex; gap: 6px; }
.file-input { display: none; }
.prompt-editor { position: relative; }
.prompt-input { min-height: 112px; padding: 0 0 14px; font-size: 14px; line-height: 1.7; }
.reference-mention-menu {
  position: absolute;
  z-index: 8;
  top: 42px;
  left: 12px;
  display: grid;
  width: min(360px, calc(100% - 24px));
  max-height: 240px;
  gap: 4px;
  padding: 8px;
  overflow-y: auto;
  border: 1px solid #3f3f46;
  border-radius: 12px;
  background: #202024;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.38);
}
.reference-mention-menu button {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 7px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #e4e4e7;
  cursor: pointer;
  text-align: left;
}
.reference-mention-menu button:hover { background: #303036; }
.reference-mention-menu img {
  width: 44px;
  height: 34px;
  flex: 0 0 auto;
  border-radius: 7px;
  object-fit: cover;
}
.reference-mention-menu span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reference-mention-menu p { margin: 8px; color: #71717a; font-size: 12px; }
.editor-options {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid #2f2f33;
}
.editor-field { display: grid; min-width: 0; gap: 6px; }
.editor-field span { color: #71717a; font-size: 10px; }
.editor-field input, .editor-field select {
  width: 100%;
  min-width: 0;
  height: 36px;
  box-sizing: border-box;
  min-width: 0;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  outline: 0;
  background: #202024;
  color: #d4d4d8;
  padding: 0 12px;
  font-size: 11px;
}
.audio-pronunciation-field { grid-column: span 2; }
.audio-pronunciation-field textarea {
  width: 100%;
  min-height: 58px;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  outline: 0;
  background: #202024;
  color: #d4d4d8;
  padding: 9px 12px;
  font: inherit;
}
.field-model { grid-column: span 2; }
.field-wide { grid-column: span 2; }
.editor-check { display: flex; align-items: flex-end; gap: 8px; padding: 0 4px 9px; color: #d4d4d8; font-size: 11px; }
.editor-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.billing-note, .editor-footer .local-draft-note { margin-right: auto; color: #71717a; font-size: 11px; }
.generation-progress { display: grid; gap: 7px; margin-top: 16px; }
.generation-progress > div { display: flex; justify-content: space-between; color: #a1a1aa; font-size: 11px; }
.generation-progress strong { color: #d4d4d8; font-weight: 600; }
.generation-progress-track { height: 6px; overflow: hidden; border-radius: 999px; background: #303036; }
.generation-progress-track i { display: block; height: 100%; border-radius: inherit; background: #fb7b3b; transition: width 180ms ease; }
.editor-error { margin: 14px 0 0; padding: 10px 12px; border: 1px solid rgba(248, 113, 113, 0.32); border-radius: 10px; background: rgba(127, 29, 29, 0.22); color: #fca5a5; font-size: 12px; line-height: 1.5; }
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 3300;
  display: grid;
  padding: 28px;
  place-items: center;
  background: rgba(0, 0, 0, 0.9);
  box-sizing: border-box;
}
.image-lightbox > button {
  position: absolute;
  top: 22px;
  right: 22px;
  display: grid;
  width: 42px;
  height: 42px;
  padding: 0;
  place-items: center;
  border: 1px solid #52525b;
  border-radius: 50%;
  background: #18181b;
  color: #f4f4f5;
  font-size: 24px;
  cursor: pointer;
}
.image-lightbox > img,
.image-lightbox > video { max-width: 100%; max-height: 100%; border-radius: 12px; object-fit: contain; }
.run-button {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 50%;
  background: #7c3f26;
  color: #fff;
  font-size: 22px;
  cursor: pointer;
}
.advanced-button {
  min-width: 54px;
  height: 34px;
  flex: 0 0 auto;
  border: 1px solid #3f3f46;
  border-radius: 17px;
  background: #202024;
  color: #a1a1aa;
  cursor: pointer;
}
.run-button:disabled { cursor: wait; opacity: 0.6; }
.local-draft-note { color: #71717a; font-size: 11px; line-height: 1.5; }
.node-error, .node-asset-error { margin: 10px 14px; color: #f87171; font-size: 11px; }
.node-asset-error { color: #fbbf24; }
.node-asset-error button { margin-left: 8px; }
.kind-image::before { border-color: var(--image-node-marker, #3f3f46); }
.state-running::before { border-color: #60a5fa; }
.state-success::before { border-color: #34d399; }
.state-failed::before { border-color: #f87171; }
@media (max-width: 760px) {
  .node-expanded-editor { right: 12px; bottom: 12px; left: 12px; width: auto; padding: 16px; }
  .editor-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .editor-heading .editor-hint { display: none; }
  .video-mode-toolbar { align-items: flex-start; flex-direction: column; }
}
</style>
