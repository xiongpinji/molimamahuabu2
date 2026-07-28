<template>
  <article
    class="home-canvas-node"
    :class="[`kind-${data.kind}`, `state-${data.status || 'idle'}`, { 'is-selected': isSelected }]"
  >
    <header class="node-heading">
      <span class="node-icon" aria-hidden="true">{{ kindIcon }}</span>
      <input
        v-model="draft.title"
        class="node-title-input"
        aria-label="节点标题"
        maxlength="80"
        @mousedown.stop
        @blur="saveDraft"
        @keydown.enter.prevent="$event.target.blur()"
      />
      <span class="sr-only">{{ draft.title }}</span>
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
      <img v-if="data.kind === 'image' && data.url" :src="data.url" :alt="data.title || '图片节点预览'" class="node-media" />
      <video v-else-if="data.kind === 'video' && data.url" :src="data.url" class="node-media" controls muted playsinline />
      <audio v-else-if="data.kind === 'audio' && data.url" :src="data.url" class="node-audio" controls />
      <div v-else class="media-empty">
        <span class="media-empty-icon" aria-hidden="true">{{ kindIcon }}</span>
        <span>{{ mediaEmptyLabel }}</span>
      </div>
      <div v-if="resultUrls.length > 1" class="result-strip" aria-label="生成结果列表">
        <button
          v-for="(url, index) in resultUrls"
          :key="url"
          type="button"
          :class="{ active: url === data.url }"
          aria-label="设为当前结果"
          :title="`结果 ${index + 1}`"
          @click="selectResult(url)"
        >
          <img v-if="data.kind === 'image'" :src="url" alt="" />
          <span v-else>{{ index + 1 }}</span>
        </button>
      </div>
      <div v-if="data.url" class="result-actions">
        <button type="button" aria-label="下载结果" title="下载结果" @click="downloadResult">↓</button>
        <button type="button" aria-label="复制结果引用" title="复制结果引用" @click="copyResultReference">⧉</button>
      </div>
      <div v-if="canUpload || canMountAsset" class="media-actions">
        <button v-if="canMountAsset" type="button" class="upload-button" @click="openAssetLibrary">素材库</button>
        <button v-if="canUpload" type="button" class="upload-button" @click="chooseFile">上传</button>
      </div>
      <input ref="fileInput" class="file-input" type="file" :accept="accept" @change="uploadFile" />
    </section>

    <Teleport to="body">
      <section
        v-if="isSelected && !hasMultiSelection && !editorHidden"
        class="node-expanded-editor canvas-node-panel nodrag nopan"
        :class="{ 'is-fullscreen': editorFullscreen }"
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

        <section v-if="['image', 'video'].includes(data.kind)" class="reference-panel" aria-label="自动参考图">
          <div class="reference-heading">
            <strong>参考图 · 连线自动采用</strong>
            <span v-if="inputReferences.length">{{ readyReferenceCount }}/{{ inputReferences.length }} 已就绪</span>
          </div>
          <div class="reference-actions">
            <button type="button" aria-label="上传参考图" @click="chooseReferenceFile">+ 上传参考图</button>
            <select
              v-if="data.kind === 'video'"
              aria-label="@选择参考图"
              @change="attachReference"
            >
              <option value="">@ 选择画布图片</option>
              <option
                v-for="candidate in referenceCandidates"
                :key="candidate.nodeId"
                :value="candidate.nodeId"
              >
                {{ candidate.title }}
              </option>
            </select>
            <input
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
            >
              <span class="reference-index">{{ index + 1 }}</span>
              <img v-if="reference.url" :src="reference.url" :alt="reference.title" />
              <span v-else class="reference-placeholder">等待图片</span>
              <figcaption>{{ reference.title }}</figcaption>
              <select
                :value="reference.slot"
                aria-label="参考图用途"
                @change="updateReference(reference, { input: $event.target.value })"
              >
                <option value="reference-image">普通参考</option>
                <option v-if="data.kind === 'video'" value="first-frame">首帧</option>
                <option v-if="data.kind === 'video'" value="last-frame">尾帧</option>
                <option value="character-reference">角色</option>
                <option value="style-reference">风格</option>
              </select>
              <div class="reference-controls">
                <button type="button" title="前移" @click="moveReference(reference, -1)">←</button>
                <button type="button" title="后移" @click="moveReference(reference, 1)">→</button>
                <label>权重 <input type="number" min="0.1" max="2" step="0.1" :value="reference.weight" @change="updateReference(reference, { weight: Number($event.target.value) })" /></label>
                <label><input type="checkbox" :checked="reference.enabled" @change="updateReference(reference, { enabled: $event.target.checked })" />启用</label>
              </div>
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

        <textarea
          ref="contentInput"
          v-model="draft.content"
          :class="data.kind === 'text' ? 'node-textarea' : 'prompt-input'"
          :aria-label="data.kind === 'text' ? '文本内容' : '生成提示词'"
          :placeholder="data.kind === 'text' ? '写下内容，或输入要求后让 AI 继续创作…' : promptPlaceholder"
          @blur="saveDraft"
        />

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
            <span>运镜</span>
            <select v-model="draft.cameraMovement" aria-label="镜头运动" @change="saveDraft">
              <option value="">自动</option>
              <option value="push-in">推进</option>
              <option value="pull-out">拉远</option>
              <option value="pan-left">左摇</option>
              <option value="pan-right">右摇</option>
              <option value="orbit">环绕</option>
              <option value="handheld">手持</option>
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
        </div>

        <div class="editor-footer">
          <span v-if="canGenerate" class="billing-note">{{ estimatedCredits ? `预计 ${estimatedCredits} 积分` : '以实际结算为准' }} · {{ draft.quantity || 1 }} 次</span>
          <span v-if="canGenerate && capability.declared === false" class="billing-note">保守参数 · 最终由供应商校验</span>
          <span v-else class="local-draft-note">本地草稿仅保存内容；绑定项目后的独立画布才能运行模型与挂载素材。</span>
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

    <div v-if="data.error" class="node-error">{{ data.error }}</div>
    <div v-if="assetSaveFailed" class="node-asset-error">
      入库失败：{{ data.assetSaveError || '请重试' }}
      <button type="button" @click.stop="retryAssetSave">重试入库</button>
    </div>
  </article>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'

const props = defineProps({
  id: { type: String, default: '' },
  data: { type: Object, required: true },
  selected: { type: Boolean, default: false },
})

const ctx = useCanvasContext()
const contentInput = ref(null)
const fileInput = ref(null)
const referenceFileInput = ref(null)
const editorHidden = ref(false)
const editorFullscreen = ref(false)
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
const voiceOptions = computed(() => ctx?.getFreeNodeVoiceOptions?.() || [])
const inputReferences = computed(() => (
  ['image', 'video'].includes(props.data.kind)
    ? (ctx?.getFreeNodeInputReferences?.(props.id) || [])
    : []
))
const referenceCandidates = computed(() => (
  props.data.kind === 'video'
    ? (ctx?.getFreeNodeReferenceCandidates?.(props.id) || [])
    : []
))
const readyReferenceCount = computed(() => inputReferences.value.filter((reference) => reference.ready).length)
const modelListId = computed(() => `free-node-models-${String(props.id || 'node').replace(/[^a-zA-Z0-9_-]/g, '-')}`)
const voiceListId = computed(() => `free-node-voices-${String(props.id || 'node').replace(/[^a-zA-Z0-9_-]/g, '-')}`)
const resultUrls = computed(() => [...new Set([
  ...(Array.isArray(props.data.resultUrls) ? props.data.resultUrls : []),
  props.data.url,
].filter(Boolean))])
const isSelected = computed(() => (
  props.selected
  || ctx?.focusedNodeId?.value === props.id
  || Boolean(ctx?.isFreeCanvasNodeSelected?.(props.id))
))
const hasMultiSelection = computed(() => (ctx?.selectedFreeNodeIds?.value?.length || 0) > 1)
const assetSaveFailed = computed(() => props.data.status === 'success' && props.data.assetSaveStatus === 'failed' && Boolean(props.data.url))
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
  draft.cameraMovement = props.data.cameraMovement || ''
  draft.effect = props.data.effect || ''
  draft.includeAudio = props.data.includeAudio === true
}

async function saveDraft() {
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
    cameraMovement: draft.cameraMovement,
    effect: draft.effect,
    includeAudio: draft.includeAudio === true,
  })
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

function chooseReferenceFile() {
  referenceFileInput.value?.click()
}

function openConfig() {
  ctx?.openFreeNodeConfig?.(props.id)
}

function closeEditor() {
  editorHidden.value = true
  editorFullscreen.value = false
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

function attachReference(event) {
  const sourceNodeId = String(event.target.value || '')
  event.target.value = ''
  if (sourceNodeId) ctx?.attachFreeCanvasReference?.(props.id, sourceNodeId)
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

function moveReference(reference, delta) {
  const index = inputReferences.value.findIndex((item) => item.edgeId === reference.edgeId)
  const targetIndex = index + delta
  if (index < 0 || targetIndex < 0 || targetIndex >= inputReferences.value.length) return
  const reordered = [...inputReferences.value]
  const [moved] = reordered.splice(index, 1)
  reordered.splice(targetIndex, 0, moved)
  reordered.forEach((item, order) => updateReference(item, { order }))
}

async function translateNode() {
  await saveDraft()
  await ctx?.translateFreeCanvasNode?.(props.id)
}

async function selectResult(url) {
  await ctx?.updateFreeCanvasNode?.(props.id, { url })
}

function downloadResult() {
  const url = String(props.data.url || '')
  if (!url) return
  const link = document.createElement('a')
  link.href = url
  link.download = ''
  link.rel = 'noopener'
  link.click()
}

async function copyResultReference() {
  const url = String(props.data.url || '')
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
  } catch {
    window.prompt('复制结果引用', url)
  }
}

function onEditorKeydown(event) {
  if (!isSelected.value || editorHidden.value || event.key !== 'Escape') return
  event.preventDefault()
  if (editorFullscreen.value) editorFullscreen.value = false
  else closeEditor()
}

onMounted(() => window.addEventListener('keydown', onEditorKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onEditorKeydown))

watch(() => props.data, syncDraft, { deep: true, immediate: true })
watch(isSelected, (selected) => {
  if (selected) editorHidden.value = false
  else editorFullscreen.value = false
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
  right: 24px;
  bottom: 24px;
  left: 50%;
  z-index: 1900;
  width: min(860px, calc(100vw - 48px));
  max-height: min(58vh, 560px);
  overflow-y: auto;
  padding: 18px;
  border: 1px solid #3f3f46;
  border-radius: 24px;
  background: #1c1c1f;
  box-shadow: 0 22px 56px rgba(0, 0, 0, 0.5);
  box-sizing: border-box;
  transform: translateX(-50%);
}
.node-expanded-editor.is-fullscreen {
  inset: 16px;
  width: auto;
  max-height: none;
  transform: none;
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
.media-actions { position: absolute; right: 12px; bottom: 12px; display: flex; gap: 8px; }
.result-strip {
  position: absolute;
  bottom: 12px;
  left: 12px;
  display: flex;
  gap: 6px;
}
.result-strip button, .result-actions button {
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
.result-strip button.active { border-color: #fb7b3b; }
.result-strip img { width: 100%; height: 100%; object-fit: cover; }
.result-actions { position: absolute; top: 12px; right: 12px; display: flex; gap: 6px; }
.file-input { display: none; }
.prompt-input { min-height: 112px; padding: 0 0 14px; font-size: 14px; line-height: 1.7; }
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
.state-running::before { border-color: #60a5fa; }
.state-success::before { border-color: #34d399; }
.state-failed::before { border-color: #f87171; }
@media (max-width: 760px) {
  .node-expanded-editor { right: 12px; bottom: 12px; width: calc(100vw - 24px); padding: 16px; }
  .editor-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .editor-heading .editor-hint { display: none; }
}
</style>
