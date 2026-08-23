<template>
  <div
    class="canvas-node-panel script-panel nodrag nopan nowheel"
    @pointerdown.stop
    @mousedown.stop
    @click.stop
    @mouseup.stop
    @wheel.stop
  >
    <div class="panel-head">
      <span>剧本 · 第 {{ episode?.episode_number ?? '?' }} 集</span>
      <div class="head-right">
        <span v-if="busyLabel" class="busy-tag">{{ busyLabel }}</span>
        <el-button link size="small" @click.stop="closePanel">收起</el-button>
      </div>
    </div>

    <p class="flow-hint">创作起点：编写剧本 → 提取角色/场景/道具 → AI 生成分镜 → 生图/生视频</p>
    <CanvasNodeExecutionStrip
      :status="activeNodeStatus"
      :node-id="nodeId"
      :disabled="saving || extracting"
      @retry="retryScriptFailedStep"
    />

    <el-form label-position="left" label-width="44px" size="small" class="compact-form">
      <el-form-item label="集标题">
        <el-input v-model="form.title" placeholder="第 N 集" />
      </el-form-item>
      <el-form-item label="剧本">
        <el-input
          v-model="form.scriptContent"
          type="textarea"
          :rows="6"
          resize="vertical"
          placeholder="在此粘贴或编写本集剧本…"
          class="script-textarea"
        />
      </el-form-item>
    </el-form>

    <div class="stats-row">
      <span>素材：{{ charCount }} 角色 · {{ sceneCount }} 场景 · {{ propCount }} 道具</span>
      <span class="len">{{ scriptLen }} 字</span>
    </div>

    <div class="panel-actions">
      <el-button size="small" type="primary" :loading="saving" @click.stop="onSave">保存剧本</el-button>
      <el-button size="small" :loading="extracting" @click.stop="onExtractChars">提取角色</el-button>
      <el-button size="small" :loading="extracting" @click.stop="onExtractScenes">提取场景</el-button>
      <el-button size="small" :loading="extracting" @click.stop="onExtractProps">提取道具</el-button>
      <el-button size="small" type="warning" :loading="extracting" @click.stop="onExtractAll">一键提取</el-button>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import CanvasNodeExecutionStrip from './CanvasNodeExecutionStrip.vue'

const props = defineProps({
  episode: { type: Object, required: true },
  nodeId: { type: String, required: true },
})

const ctx = useCanvasContext()
const saving = ref(false)
const extracting = ref(false)
const form = reactive({
  title: '',
  scriptContent: '',
})

const charCount = computed(() => (ctx?.drama?.value?.characters || []).length)
const sceneCount = computed(() => (ctx?.drama?.value?.scenes || []).length)
const propCount = computed(() => (ctx?.drama?.value?.props || []).length)
const scriptLen = computed(() => (form.scriptContent || '').length)

const activeNodeStatus = computed(() => {
  const map = ctx?.nodeStatus?.map
  return map ? map[props.nodeId] : null
})
const busyLabel = computed(() => {
  return activeNodeStatus.value?.message || ''
})

function syncForm(ep) {
  form.title = ep?.title || `第${ep?.episode_number ?? ''}集`
  form.scriptContent = ep?.script_content || ''
}

watch(() => props.episode, (ep) => syncForm(ep), { immediate: true, deep: true })

function closePanel() {
  ctx?.clearFocusedNode?.()
}

function getScriptApi() {
  return ctx?.scriptActions
}

async function onSave() {
  if (!form.scriptContent.trim()) {
    ElMessage.warning('请先填写剧本内容')
    return
  }
  saving.value = true
  ctx?.nodeStatus?.set(props.nodeId, { step: 'save', message: '剧本保存中…' })
  try {
    await getScriptApi()?.saveScript?.(props.episode.id, {
      scriptContent: form.scriptContent,
      title: form.title,
    })
    await ctx?.refreshDrama?.(true)
    ctx?.nodeStatus?.success(props.nodeId, {
      message: '剧本已保存',
      resultType: 'text',
      resultLabel: '剧本已保存',
      promptText: form.scriptContent,
      autoClear: false,
    })
  } catch (e) {
    const message = e?.message || '保存失败'
    ctx?.nodeStatus?.fail(props.nodeId, {
      message,
      errorDetail: message,
      retryStep: 'save',
      retryLabel: '重试保存剧本',
      recoverable: true,
    })
    ElMessage.error(message)
  } finally {
    saving.value = false
  }
}

async function runExtract(fn, step = 'extract_all', retryLabel = '重试提取') {
  extracting.value = true
  ctx?.nodeStatus?.set(props.nodeId, { step, message: `${retryLabel.replace(/^重试/, '')}中…` })
  try {
    await fn()
    ctx?.nodeStatus?.success(props.nodeId, {
      message: '提取完成',
      resultType: 'text',
      resultLabel: retryLabel.replace(/^重试/, ''),
      promptText: form.scriptContent,
      autoClear: false,
    })
  } catch (e) {
    const message = e?.message || '提取失败'
    ctx?.nodeStatus?.fail(props.nodeId, {
      message,
      errorDetail: message,
      retryStep: step,
      retryLabel,
      recoverable: true,
    })
    ElMessage.error(message)
  } finally {
    extracting.value = false
  }
}

async function onExtractChars() {
  await runExtract(() =>
    getScriptApi()?.extractCharacters?.(props.episode.id, form.scriptContent)
  , 'extract_characters', '重试提取角色')
}

async function onExtractScenes() {
  await runExtract(() =>
    getScriptApi()?.extractScenes?.(props.episode.id)
  , 'extract_scenes', '重试提取场景')
}

async function onExtractProps() {
  await runExtract(() =>
    getScriptApi()?.extractProps?.(props.episode.id)
  , 'extract_props', '重试提取道具')
}

async function onExtractAll() {
  if (!form.scriptContent.trim()) {
    ElMessage.warning('请先填写剧本')
    return
  }
  await runExtract(() =>
    getScriptApi()?.extractAll?.(props.episode.id, form.scriptContent)
  , 'extract_all', '重试一键提取')
}

async function retryScriptFailedStep() {
  const step = activeNodeStatus.value?.retryStep
  if (step === 'save') return onSave()
  if (step === 'extract_characters') return onExtractChars()
  if (step === 'extract_scenes') return onExtractScenes()
  if (step === 'extract_props') return onExtractProps()
  if (step === 'extract_all') return onExtractAll()
}
</script>

<style scoped>
.script-panel {
  margin-top: 10px;
  width: min(520px, 92vw);
  padding: 10px 14px 12px;
  border-radius: 12px;
  border: 1px solid rgba(251, 191, 36, 0.45);
  background: rgba(15, 15, 18, 0.97);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 700;
  color: #fcd34d;
  margin-bottom: 6px;
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
.flow-hint {
  margin: 0 0 10px;
  font-size: 10px;
  line-height: 1.45;
  color: #71717a;
}
.compact-form :deep(.el-form-item) {
  margin-bottom: 8px;
}
.compact-form :deep(.el-form-item__label) {
  color: #71717a;
  font-size: 11px;
}
.compact-form :deep(.el-textarea__inner) {
  resize: vertical;
  min-height: 120px;
  line-height: 1.5;
}
.stats-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: #a1a1aa;
  margin-bottom: 8px;
}
.len {
  color: #71717a;
}
.panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(63, 63, 70, 0.6);
}
.panel-actions :deep(.el-button) {
  margin: 0;
}
</style>
