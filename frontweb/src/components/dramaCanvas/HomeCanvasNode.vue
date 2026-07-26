<template>
  <article
    class="home-canvas-node"
    :class="[`kind-${data.kind}`, `state-${data.status || 'idle'}`, { 'is-selected': selected }]"
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

    <section v-if="data.kind === 'text'" class="text-editor nodrag nopan" @mousedown.stop>
      <div class="text-toolbar" aria-label="文本格式工具栏">
        <button type="button" aria-label="一级标题" @click="prefixSelection('# ')">H1</button>
        <button type="button" aria-label="二级标题" @click="prefixSelection('## ')">H2</button>
        <button type="button" aria-label="加粗" @click="wrapSelection('**')"><b>B</b></button>
        <button type="button" aria-label="斜体" @click="wrapSelection('_')"><i>I</i></button>
        <button type="button" aria-label="项目列表" @click="prefixSelection('- ')">☷</button>
      </div>
      <textarea
        ref="contentInput"
        v-model="draft.content"
        class="node-textarea"
        aria-label="文本内容"
        placeholder="开启你的创作…"
        @blur="saveDraft"
      />
    </section>

    <template v-else>
      <section class="media-stage nodrag nopan" @mousedown.stop>
        <img v-if="data.kind === 'image' && data.url" :src="data.url" :alt="data.title || '图片节点预览'" class="node-media" />
        <video v-else-if="data.kind === 'video' && data.url" :src="data.url" class="node-media" controls muted playsinline />
        <audio v-else-if="data.kind === 'audio' && data.url" :src="data.url" class="node-audio" controls />
        <div v-else class="media-empty">
          <span class="media-empty-icon" aria-hidden="true">{{ kindIcon }}</span>
          <span>{{ mediaEmptyLabel }}</span>
          <button type="button" class="upload-button" @click="chooseFile">上传</button>
        </div>
        <input ref="fileInput" class="file-input" type="file" :accept="accept" @change="uploadFile" />
      </section>

      <section class="generation-panel nodrag nopan" @mousedown.stop>
        <textarea
          v-model="draft.content"
          class="prompt-input"
          aria-label="生成提示词"
          placeholder="描述任何你想要生成的内容"
          @blur="saveDraft"
        />
        <div class="generation-controls">
          <input
            v-model="draft.model"
            class="model-input"
            aria-label="生成模型"
            :placeholder="defaultModelLabel"
            @blur="saveDraft"
          />
          <select v-if="['image', 'video'].includes(data.kind)" v-model="draft.aspectRatio" aria-label="画面比例" @change="saveDraft">
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
          </select>
          <select v-if="data.kind === 'video'" v-model.number="draft.duration" aria-label="视频时长" @change="saveDraft">
            <option :value="5">5 秒</option>
            <option :value="10">10 秒</option>
            <option :value="15">15 秒</option>
          </select>
          <button type="button" class="advanced-button" aria-label="配置" title="更多配置" @click.stop="openConfig">⋯</button>
          <button
            type="button"
            class="run-button"
            :disabled="data.status === 'running'"
            :aria-label="data.status === 'failed' ? '重试' : '生成'"
            @click.stop="runNode"
          >
            {{ data.status === 'running' ? '生成中…' : '↑' }}
          </button>
        </div>
      </section>
    </template>

    <div v-if="data.error" class="node-error">{{ data.error }}</div>
    <div v-if="assetSaveFailed" class="node-asset-error">
      入库失败：{{ data.assetSaveError || '请重试' }}
      <button type="button" @click.stop="retryAssetSave">重试入库</button>
    </div>
  </article>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
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
const draft = reactive({
  title: '',
  content: '',
  model: '',
  aspectRatio: '16:9',
  duration: 5,
})
const kindIcon = computed(() => ({ text: 'T', image: '▧', video: '▣', audio: '♫' }[props.data.kind] || '◈'))
const mediaEmptyLabel = computed(() => ({ image: '添加图片', video: '添加视频或参考帧', audio: '添加音频' }[props.data.kind] || '添加素材'))
const accept = computed(() => ({ image: 'image/*', video: 'video/*,image/*', audio: 'audio/*' }[props.data.kind] || '*/*'))
const defaultModelLabel = computed(() => props.data.kind === 'image' ? '默认图片模型' : props.data.kind === 'video' ? '默认视频模型' : '默认音频模型')
const assetSaveFailed = computed(() => props.data.status === 'success' && props.data.assetSaveStatus === 'failed' && Boolean(props.data.url))
const statusLabel = computed(() => ({ running: '运行中', success: '已生成', failed: '失败' }[props.data.status] || '待配置'))

function syncDraft() {
  draft.title = props.data.title || ''
  draft.content = props.data.content || ''
  draft.model = props.data.model || ''
  draft.aspectRatio = props.data.aspectRatio || '16:9'
  draft.duration = Number(props.data.duration) || 5
}

async function saveDraft() {
  await ctx?.updateFreeCanvasNode?.(props.id, {
    title: draft.title.trim() || '未命名节点',
    content: draft.content,
    model: draft.model.trim(),
    aspectRatio: draft.aspectRatio,
    duration: Number(draft.duration) || 5,
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

function chooseFile() {
  fileInput.value?.click()
}

function openConfig() {
  ctx?.openFreeNodeConfig?.(props.id)
}

async function uploadFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) await ctx?.uploadFreeCanvasNodeFile?.(props.id, file)
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

watch(() => props.data, syncDraft, { deep: true, immediate: true })
</script>

<style scoped>
.home-canvas-node {
  position: relative;
  width: 430px;
  padding: 0;
  color: #e4e4e7;
  cursor: default;
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
  width: 28px;
  height: 28px;
  top: calc(50% + 19px);
  z-index: 4;
  border: 1px solid #52525b;
  background: #18181b;
}
.node-handle::after { content: '+'; display: grid; height: 100%; place-items: center; color: #d4d4d8; font-size: 19px; line-height: 1; }
.node-handle-input { left: -24px; }
.node-handle-output { right: -24px; }
.text-editor, .media-stage, .generation-panel { margin: 10px; border: 1px solid #35353a; border-radius: 16px; background: #18181b; }
.text-toolbar { display: flex; gap: 3px; padding: 8px 10px; border-bottom: 1px solid #2f2f33; }
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
.node-textarea { min-height: 170px; padding: 18px; font-size: 14px; line-height: 1.7; }
.media-stage { min-height: 230px; overflow: hidden; }
.node-media { display: block; width: 100%; height: 230px; background: #09090b; object-fit: contain; }
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
.file-input { display: none; }
.generation-panel { padding: 14px; }
.prompt-input { min-height: 86px; padding: 0; font-size: 13px; line-height: 1.6; }
.generation-controls { display: flex; align-items: center; gap: 8px; }
.model-input, .generation-controls select {
  min-width: 0;
  height: 34px;
  border: 1px solid #3f3f46;
  border-radius: 17px;
  outline: 0;
  background: #202024;
  color: #d4d4d8;
  padding: 0 12px;
  font-size: 11px;
}
.model-input { flex: 1; }
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
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border: 1px solid #3f3f46;
  border-radius: 50%;
  background: #202024;
  color: #a1a1aa;
  cursor: pointer;
}
.run-button:disabled { cursor: wait; opacity: 0.6; }
.node-error, .node-asset-error { margin: 10px 14px; color: #f87171; font-size: 11px; }
.node-asset-error { color: #fbbf24; }
.node-asset-error button { margin-left: 8px; }
.state-running::before { border-color: #60a5fa; }
.state-success::before { border-color: #34d399; }
.state-failed::before { border-color: #f87171; }
</style>
