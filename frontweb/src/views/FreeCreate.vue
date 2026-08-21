<template>
  <div class="free-create-page">
    <PlatformHeader title="自由创作" back-to="/" back-label="返回">
      <template #leading>
        <p class="page-desc">不绑定项目，直接生成文字、图片或视频</p>
      </template>
    </PlatformHeader>

    <div class="create-layout">
      <!-- 左侧：输入面板 -->
      <div class="input-panel">
        <el-tabs v-model="mode" class="mode-tabs">
          <el-tab-pane name="text">
            <template #label><span class="mode-tab-label"><el-icon><Document /></el-icon>生成文字</span></template>
          </el-tab-pane>
          <el-tab-pane name="image">
            <template #label><span class="mode-tab-label"><el-icon><Picture /></el-icon>生成图片</span></template>
          </el-tab-pane>
          <el-tab-pane name="video">
            <template #label><span class="mode-tab-label"><el-icon><VideoCamera /></el-icon>生成视频</span></template>
          </el-tab-pane>
          <el-tab-pane name="script">
            <template #label><span class="mode-tab-label"><el-icon><Document /></el-icon>生成剧本</span></template>
          </el-tab-pane>
        </el-tabs>

        <div class="form-section">
          <div class="form-label">提示词 <span class="required">*</span></div>
          <el-input
            v-model="prompt"
            type="textarea"
            :rows="5"
            :placeholder="mode === 'text'
              ? '输入要生成、扩写或改写的文字要求...'
              : mode === 'script'
                ? '输入故事梗概、人物关系和期望风格...'
                : '描述你想要生成的画面内容...'"
            class="prompt-input"
          />
        </div>

        <div v-if="supportsReferenceImage" class="form-section">
          <div class="form-label">参考图（可选）</div>
          <div class="ref-image-zone" @click="triggerRefImageUpload" @dragover.prevent @drop.prevent="onRefImageDrop">
            <template v-if="refImageDataUrl">
              <img :src="refImageDataUrl" class="ref-preview" />
              <div class="ref-actions">
                <el-button size="small" type="danger" plain @click.stop="clearRefImage">移除</el-button>
              </div>
              <small v-if="refImageUploading">正在上传…</small>
              <small v-else-if="refImageUploadError" class="upload-error">{{ refImageUploadError }}</small>
            </template>
            <template v-else>
              <el-icon class="upload-icon"><Picture /></el-icon>
              <div class="upload-tip">点击或拖拽上传参考图</div>
            </template>
          </div>
          <input ref="refImageInput" type="file" accept="image/*" style="display:none" @change="onRefImageChange" />
        </div>

        <div class="form-section form-row">
          <div v-if="mode === 'image' || selectedResolutions.length" class="form-item">
            <div class="form-label">风格</div>
            <el-input v-model="style" placeholder="例如: cinematic, anime..." />
          </div>
          <div v-if="mode === 'image' || mode === 'video'" class="form-item">
            <div class="form-label">比例</div>
            <el-select v-model="aspectRatio">
              <el-option label="16:9" value="16:9" />
              <el-option label="9:16" value="9:16" />
              <el-option label="1:1" value="1:1" />
              <el-option label="4:3" value="4:3" />
            </el-select>
          </div>
          <div v-if="mode === 'video'" class="form-item">
            <div class="form-label">时长</div>
            <el-select v-model="duration">
              <el-option v-for="value in selectedDurationOptions" :key="value" :label="`${value}秒`" :value="value" />
            </el-select>
          </div>
          <div v-if="mode === 'video' && selectedModel?.capabilities?.supportsAudio === true" class="form-item">
            <div class="form-label">音频</div>
            <el-checkbox v-model="generateAudio">同步生成音频</el-checkbox>
          </div>
          <div v-if="mode === 'image' || mode === 'video'" class="form-item">
            <div class="form-label">清晰度</div>
            <el-select v-model="resolution">
              <el-option
                v-for="value in selectedResolutions"
                :key="value"
                :label="value.toUpperCase()"
                :value="value"
              />
            </el-select>
          </div>
          <div v-if="mode === 'image'" class="form-item">
            <div class="form-label">数量</div>
            <el-select v-model.number="quantity">
              <el-option v-for="value in quantityOptions" :key="value" :label="`${value} 张`" :value="value" />
            </el-select>
          </div>
          <div v-if="mode === 'script'" class="form-item">
            <div class="form-label">剧本集数</div>
            <el-select v-model="episodeCount">
              <el-option label="1集" :value="1" />
              <el-option label="3集" :value="3" />
              <el-option label="5集" :value="5" />
              <el-option label="10集" :value="10" />
            </el-select>
          </div>
          <div class="form-item">
            <div class="form-label">模型</div>
            <el-select v-model="model" placeholder="请选择模型">
              <el-option
                v-for="item in modelOptions"
                :key="item.model"
                :label="item.label || item.model"
                :value="item.model"
              />
            </el-select>
            <small v-if="selectedModel?.publicNote" class="model-public-note">
              {{ selectedModel.publicNote }}
              <span v-if="selectedModel.verificationStatus === 'verified'">· 已验证</span>
            </small>
          </div>
        </div>

        <div class="billing-summary" :class="{ 'is-insufficient': insufficientCredits }">
          <span>预计消耗 <strong>{{ selectedCredits ?? '—' }}</strong> 积分</span>
          <span>可用 <strong>{{ creditAccount.available }}</strong></span>
        </div>

        <el-button
          type="primary"
          size="large"
          :loading="generating"
          :disabled="!prompt.trim() || !model || selectedCredits == null || insufficientCredits || refImageUploading"
          class="generate-btn"
          @click="generate"
        >
          {{ generating ? '生成中...' : ({ text: '生成文字', image: '生成图片', video: '生成视频', script: '生成剧本' }[mode]) }}
        </el-button>
      </div>

      <!-- 右侧：结果展示 -->
      <div class="result-panel">
        <div class="result-header">
          <span class="result-title">生成结果</span>
          <el-button v-if="results.length > 0" size="small" plain @click="clearResults">清空</el-button>
        </div>

        <div v-if="results.length === 0 && !generating" class="empty-result">
          <el-icon class="empty-icon"><MagicStick /></el-icon>
          <p>生成的内容将显示在这里</p>
        </div>

        <div v-if="generating" class="generating-tip">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>正在生成，请稍候...</span>
        </div>

        <div class="result-grid">
          <div
            v-for="(item, idx) in results"
            :key="idx"
            :class="['result-item', { 'result-item--script': item.type === 'script' || item.type === 'text' }]"
          >
            <div class="result-media">
              <video
                v-if="item.type === 'video' && item.url"
                :src="item.url"
                controls
                class="result-video"
                loop
              />
              <img
                v-else-if="item.type === 'image' && item.url"
                :src="item.url"
                class="result-image"
                @click="previewUrl = item.url"
              />
              <article v-else-if="item.type === 'script' && item.status === 'completed'" class="script-result">
                <section v-for="episode in item.episodes" :key="episode.episode" class="script-episode">
                  <h3>第{{ episode.episode }}集 · {{ episode.title }}</h3>
                  <pre>{{ episode.content }}</pre>
                </section>
              </article>
              <article v-else-if="item.type === 'text' && item.status === 'completed'" class="script-result">
                <pre>{{ item.text }}</pre>
              </article>
              <div v-else-if="item.status === 'pending' || item.status === 'processing'" class="media-loading">
                <el-icon class="is-loading"><Loading /></el-icon>
                <span>{{ item.status === 'processing' ? '生成中...' : '排队中...' }}</span>
              </div>
              <div v-else-if="item.status === 'failed'" class="media-error">
                <el-icon><CircleClose /></el-icon>
                <span>{{ item.error || '生成失败' }}</span>
              </div>
            </div>
            <div class="result-meta">
              <span class="result-prompt">{{ item.prompt }}</span>
              <div class="result-actions">
                <el-button v-if="item.url || item.text" size="small" plain @click="downloadItem(item)">下载</el-button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 图片预览 -->
    <div v-if="previewUrl" class="image-preview-overlay" @click="previewUrl = null">
      <img :src="previewUrl" class="preview-img" @click.stop />
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Picture, VideoCamera, MagicStick, Loading, CircleClose, Document } from '@element-plus/icons-vue'
import PlatformHeader from '@/components/PlatformHeader.vue'
import { imagesAPI } from '@/api/images'
import { videosAPI } from '@/api/videos'
import { uploadAPI } from '@/api/upload'
import { generationSettingsAPI } from '@/api/prompts'
import { generationAPI } from '@/api/generation'
import { getCreditAccount } from '@/api/auth'
import request from '@/utils/request'
import { normalizeCreditAccount } from '@/utils/billingDisplay'
import {
  buildQuickGenerationRequest,
  estimateGenerationCredits,
  normalizeQuickGenerationCatalog,
  normalizeQuickGenerationDraft,
  quickGenerationDurations,
  quickGenerationResolutions,
} from '@/utils/homeQuickGeneration'
import { parseTaskResult, resolveTaskMediaUrl } from '@/utils/taskResult'

const route = useRoute()
const mode = ref('image')
const prompt = ref('')
const style = ref('')
const aspectRatio = ref('16:9')
const duration = ref(5)
const generateAudio = ref(false)
const resolution = ref('720p')
const quantity = ref(1)
const episodeCount = ref(1)
const model = ref('')
const generationCatalog = ref([])
const generating = ref(false)
const results = ref([])
const previewUrl = ref(null)
const refImageDataUrl = ref(null)
const refImageLocalPath = ref(null)
const refImageInput = ref(null)
const refImageUploading = ref(false)
const refImageUploadError = ref('')
const restoringDraft = ref(true)
const creditAccount = ref(normalizeCreditAccount())
/** 与后端视频异步超时一致（分钟 → 毫秒） */
const videoPollMaxMs = ref(30 * 60 * 1000)
const modelOptions = computed(() => {
  const category = mode.value === 'script' ? 'text' : mode.value
  return generationCatalog.value.filter((item) => item.category === category)
})
const selectedModel = computed(() => (
  modelOptions.value.find((item) => item.model === model.value) || null
))
const selectedResolutions = computed(() => quickGenerationResolutions(selectedModel.value || {}, mode.value))
const selectedDurationOptions = computed(() => quickGenerationDurations(selectedModel.value || {}))
const supportsReferenceImage = computed(() => {
  if (mode.value === 'image') return selectedModel.value?.capabilities?.supportsImageReference !== false
  if (mode.value !== 'video') return false
  const capability = selectedModel.value?.capabilities || {}
  if (capability.declared === true) {
    return capability.supportsFirstFrame === true || capability.supportsImageReference === true
  }
  return capability.supportsFirstFrame !== false
})
const quantityOptions = computed(() => {
  const declared = selectedModel.value?.capabilities?.quantities
  return Array.isArray(declared) && declared.length ? declared : [1]
})
const selectedCredits = computed(() => estimateGenerationCredits(
  selectedModel.value,
  { duration: duration.value, resolution: resolution.value, quantity: quantity.value },
))
const insufficientCredits = computed(() => (
  selectedCredits.value != null && creditAccount.value.available < selectedCredits.value
))

async function refreshCreditAccount() {
  try {
    creditAccount.value = normalizeCreditAccount(await getCreditAccount())
  } catch (_) {
    creditAccount.value = normalizeCreditAccount()
  }
}

onMounted(async () => {
  const [catalog] = await Promise.allSettled([
    request.get('/canvas/model-catalog'),
    refreshCreditAccount(),
  ])
  generationCatalog.value = normalizeQuickGenerationCatalog(
    catalog.status === 'fulfilled' && Array.isArray(catalog.value) ? catalog.value : [],
  )
  const routeMode = ['text', 'image', 'video', 'script'].includes(String(route.query.mode))
    ? String(route.query.mode)
    : null
  let rawDraft = null
  try {
    rawDraft = JSON.parse(sessionStorage.getItem('moli_quick_create_draft') || 'null')
  } catch (_) {}
  let draft = normalizeQuickGenerationDraft(rawDraft || {})
  mode.value = routeMode || draft.mode
  prompt.value = typeof draft?.prompt === 'string' ? draft.prompt : ''
  aspectRatio.value = draft?.aspectRatio || '16:9'
  duration.value = Number(draft?.duration) || 5
  resolution.value = draft?.resolution || '720p'
  quantity.value = Number(draft?.quantity) || 1
  if (draft?.referenceImageUrl) {
    refImageDataUrl.value = draft.referenceImageUrl
    refImageLocalPath.value = draft.referenceImageUrl.startsWith('/static/')
      ? draft.referenceImageUrl.slice('/static/'.length)
      : draft.referenceImageUrl
  }
  model.value = modelOptions.value.some((item) => item.model === draft?.model)
    ? draft.model
    : (modelOptions.value[0]?.model || '')
  generateAudio.value = draft.generateAudio
  sessionStorage.removeItem('moli_quick_create_draft')
  try {
    const res = await generationSettingsAPI.get()
    const m = Math.max(1, Number(res?.video_generation_timeout_minutes) || 30)
    videoPollMaxMs.value = m * 60 * 1000
  } catch (_) {}
  restoringDraft.value = false
  if (draft?.autoStart && ['text', 'image', 'video'].includes(mode.value) && prompt.value && model.value) {
    await generate()
  }
})

function syncSelectedParameters() {
  const allowed = selectedResolutions.value
  const current = String(resolution.value || '').trim().toLowerCase()
  if (allowed.length && !allowed.includes(current)) resolution.value = allowed[0]
  else if (mode.value === 'video' && Array.isArray(selectedModel.value?.capabilities?.resolutions) && !allowed.length) resolution.value = ''
  else if (current) resolution.value = current
  if (!quantityOptions.value.includes(Number(quantity.value))) quantity.value = quantityOptions.value[0] || 1
  if (!selectedDurationOptions.value.includes(Number(duration.value))) duration.value = selectedDurationOptions.value[0] || 5
  if (selectedModel.value?.capabilities?.supportsAudio !== true) generateAudio.value = false
}

watch([mode, model], () => {
  if (!modelOptions.value.some((item) => item.model === model.value)) {
    model.value = modelOptions.value[0]?.model || ''
  }
  if (restoringDraft.value) return
  syncSelectedParameters()
}, { flush: 'sync' })

function triggerRefImageUpload() {
  refImageInput.value?.click()
}

function clearRefImage() {
  refImageDataUrl.value = null
  refImageLocalPath.value = null
  refImageUploadError.value = ''
}

async function onRefImageChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  processRefImageFile(file)
  e.target.value = ''
}

function onRefImageDrop(e) {
  const file = e.dataTransfer?.files?.[0]
  if (file && file.type.startsWith('image/')) processRefImageFile(file)
}

async function processRefImageFile(file) {
  refImageUploadError.value = ''
  const reader = new FileReader()
  reader.onload = (ev) => {
    refImageDataUrl.value = ev.target.result
  }
  reader.readAsDataURL(file)
  refImageUploading.value = true
  try {
    const res = await uploadAPI.uploadImage(file)
    const localPath = String(res?.local_path || '').replace(/^\/+/, '')
    if (!localPath) throw new Error('上传结果缺少文件路径')
    refImageLocalPath.value = localPath
  } catch (error) {
    refImageLocalPath.value = null
    refImageUploadError.value = error?.message || '参考图上传失败'
    ElMessage.error(refImageUploadError.value)
  } finally {
    refImageUploading.value = false
  }
}

function clearResults() {
  results.value = []
}

function downloadItem(item) {
  if (item.text) {
    const objectUrl = URL.createObjectURL(new Blob([item.text], { type: 'text/plain;charset=utf-8' }))
    const textLink = document.createElement('a')
    textLink.href = objectUrl
    textLink.download = `free_create_${Date.now()}.txt`
    textLink.click()
    URL.revokeObjectURL(objectUrl)
    return
  }
  if (!item.url) return
  const a = document.createElement('a')
  a.href = item.url
  a.download = `free_create_${Date.now()}.${item.type === 'video' ? 'mp4' : 'jpg'}`
  a.click()
}

async function generate() {
  if (!prompt.value.trim()) return
  if (selectedCredits.value == null) {
    ElMessage.warning('当前模型尚未完成计费配置')
    return
  }
  if (insufficientCredits.value) {
    ElMessage.warning(`积分不足：需要 ${selectedCredits.value}，当前可用 ${creditAccount.value.available}`)
    return
  }
  if (refImageUploading.value) {
    ElMessage.warning('参考图仍在上传，请稍候')
    return
  }
  if (refImageUploadError.value) {
    ElMessage.warning('参考图上传失败，请移除或重新上传')
    return
  }
  generating.value = true
  const newItem = {
    type: mode.value,
    prompt: prompt.value,
    style: style.value,
    status: 'processing',
    url: null,
    error: null,
    episodes: [],
    text: '',
  }
  results.value.unshift(newItem)
  try {
    const referenceImageUrl = refImageLocalPath.value ? `/static/${refImageLocalPath.value}` : ''
    const requestSpec = buildQuickGenerationRequest({
      mode: mode.value,
      prompt: prompt.value,
      model: model.value,
      style: style.value,
      aspectRatio: aspectRatio.value,
      duration: duration.value,
      resolution: resolution.value,
      quantity: quantity.value,
      referenceImageUrl: supportsReferenceImage.value ? referenceImageUrl : '',
      capability: selectedModel.value?.capabilities || {},
      generateAudio: generateAudio.value,
      requestId: globalThis.crypto?.randomUUID?.() || `home-${Date.now()}`,
    })
    if (mode.value === 'text') {
      const res = await request.post(requestSpec.endpoint, requestSpec.body)
      newItem.text = String(res?.content || '').trim()
      newItem.status = newItem.text ? 'completed' : 'failed'
      if (!newItem.text) newItem.error = '模型未返回有效文字'
    } else if (mode.value === 'script') {
      const res = await generationAPI.generateStory({
        premise: prompt.value,
        episode_count: episodeCount.value,
        model: model.value,
      })
      newItem.episodes = Array.isArray(res?.episodes) ? res.episodes : []
      newItem.status = newItem.episodes.length ? 'completed' : 'failed'
      if (!newItem.episodes.length) newItem.error = '模型未返回有效剧本'
    } else if (mode.value === 'image') {
      const res = await imagesAPI.create(requestSpec.body)
      if (res?.task_id) {
        await pollImageTask(res.task_id, newItem)
      } else if (res?.image_url || res?.local_path) {
        newItem.url = res.image_url || ('/static/' + res.local_path)
        newItem.status = 'completed'
      }
    } else {
      const res = await videosAPI.create(requestSpec.body)
      if (res?.task_id) {
        await pollVideoTask(res.task_id, newItem)
      } else {
        newItem.status = 'failed'
        newItem.error = '提交失败'
      }
    }
  } catch (e) {
    newItem.status = 'failed'
    newItem.error = e.message || '生成失败'
    ElMessage.error(newItem.error)
  } finally {
    generating.value = false
    await refreshCreditAccount()
    window.dispatchEvent(new CustomEvent('moli:credit-account-refresh'))
  }
}

async function pollImageTask(taskId, item, maxMs = 180000) {
  const start = Date.now()
  const { taskAPI } = await import('@/api/task')
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const res = await taskAPI.get(taskId)
      if (res.status === 'completed' && res.result) {
        const r = parseTaskResult(res.result)
        if (!r) throw new Error('任务结果格式无效')
        item.url = r.image_url ? r.image_url : (r.local_path ? '/static/' + r.local_path : null)
        item.status = 'completed'
        return
      }
      if (res.status === 'failed') {
        item.status = 'failed'
        item.error = res.error || '生成失败'
        return
      }
    } catch (_) {}
  }
  item.status = 'failed'
  item.error = '超时'
}

async function pollVideoTask(taskId, item) {
  const maxMs = videoPollMaxMs.value
  const start = Date.now()
  const { taskAPI } = await import('@/api/task')
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 4000))
    try {
      const res = await taskAPI.get(taskId)
      if (res?.status === 'completed' && res?.result) {
        const r = parseTaskResult(res.result)
        if (!r) throw new Error('任务结果格式无效')
        item.url = resolveTaskMediaUrl(r)
        const vgId = r.video_generation_id
        if (!item.url && vgId) {
          const vRes = await videosAPI.get(vgId)
          item.url = vRes?.local_path ? '/static/' + vRes.local_path : vRes?.video_url
        }
        item.status = 'completed'
        return
      }
      if (res?.status === 'failed') {
        item.status = 'failed'
        item.error = res.error || '生成失败'
        return
      }
    } catch (_) {}
  }
  item.status = 'failed'
  item.error = '超时'
}
</script>

<style scoped>
.free-create-page {
  min-height: 100vh;
  padding: 28px;
  color: #f5f5f5;
  background:
    radial-gradient(circle at 12% 15%, rgba(84, 44, 156, .38), transparent 30%),
    radial-gradient(circle at 90% 75%, rgba(52, 31, 117, .32), transparent 34%),
    #070708;
}

.script-result {
  width: 100%;
  max-height: 560px;
  padding: 8px;
  overflow: auto;
}

.script-episode {
  padding: 18px;
  border: 1px solid #2c2c2c;
  border-radius: 12px;
  background: #151515;
}

.script-episode + .script-episode {
  margin-top: 12px;
}

.script-episode h3 {
  margin: 0 0 12px;
  color: #ff8a5b;
  font-size: 16px;
}

.script-episode pre {
  margin: 0;
  color: #e7e7e7;
  font: inherit;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.page-header {
  margin-bottom: 20px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: #f5f5f5;
  margin: 0;
}

.page-desc {
  color: #8f8f98;
  font-size: 14px;
  margin: 0;
}

.create-layout {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.input-panel {
  width: 380px;
  flex-shrink: 0;
  padding: 22px;
  border: 1px solid #292929;
  border-radius: 16px;
  background: rgba(16, 16, 18, .96);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .32);
}

.mode-tabs {
  margin-bottom: 16px;
}

.mode-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.form-section {
  margin-bottom: 16px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: #b8b8be;
  margin-bottom: 6px;
}

.required {
  color: #ef4444;
}

.prompt-input :deep(.el-textarea__inner) {
  font-size: 14px;
}

.form-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.form-item {
  min-width: 108px;
  flex: 1 1 108px;
}

.form-item .el-select {
  width: 100%;
}
.model-public-note {
  margin: 6px 0 0;
  color: #9ca3af;
  font-size: 12px;
  line-height: 1.5;
}

.model-public-note {
  display: block;
  margin-top: 6px;
  color: #92929a;
  font-size: 11px;
  line-height: 1.45;
}

.ref-image-zone {
  border: 1px dashed #3a3a3d;
  border-radius: 8px;
  padding: 20px;
  text-align: center;
  cursor: pointer;
  transition: border-color .2s;
  min-height: 100px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  position: relative;
}

.ref-image-zone:hover {
  border-color: #ff7139;
}

.ref-preview {
  max-width: 100%;
  max-height: 150px;
  border-radius: 6px;
}

.ref-actions {
  margin-top: 8px;
}

.upload-icon {
  font-size: 28px;
  color: #9ca3af;
}

.upload-tip {
  font-size: 12px;
  color: #9ca3af;
}
.upload-error {
  color: #fca5a5;
}

.billing-summary {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 4px 0 12px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 165, 43, .34);
  border-radius: 9px;
  color: #d4d4d8;
  background: rgba(140, 75, 12, .1);
  font-size: 13px;
}

.billing-summary strong {
  color: #ffb34b;
}

.billing-summary.is-insufficient {
  border-color: rgba(239, 68, 68, .48);
  background: rgba(127, 29, 29, .14);
}

.billing-summary.is-insufficient strong {
  color: #fca5a5;
}

.generate-btn {
  width: 100%;
  margin-top: 4px;
  border: 0;
  background: #ef7443;
}

.result-panel {
  flex: 1;
  padding: 22px;
  border: 1px solid #292929;
  border-radius: 16px;
  background: rgba(16, 16, 18, .96);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .32);
  min-height: 400px;
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.result-title {
  font-size: 16px;
  font-weight: 600;
  color: #f5f5f5;
}

.empty-result {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 300px;
  color: #9ca3af;
  gap: 12px;
}

.empty-icon {
  font-size: 48px;
}

.generating-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #409eff;
  font-size: 14px;
  margin-bottom: 12px;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}

.result-item {
  border: 1px solid #2c2c2f;
  border-radius: 12px;
  overflow: hidden;
  background: #121214;
}

.result-item--script {
  grid-column: 1 / -1;
}

.result-media {
  background: #0b0b0c;
  aspect-ratio: 16/9;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.result-item--script .result-media {
  aspect-ratio: auto;
  justify-content: stretch;
}

.result-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: zoom-in;
}

.result-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.media-loading,
.media-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: #6b7280;
  font-size: 12px;
}

.media-error {
  color: #ef4444;
}

.result-meta {
  padding: 8px 10px;
}

.result-prompt {
  font-size: 12px;
  color: #8f8f98;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.result-actions {
  margin-top: 6px;
  display: flex;
  gap: 6px;
}

.image-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.85);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
}

.preview-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 8px;
}

.free-create-page :deep(.el-tabs__item) {
  color: #8f8f98;
}

.free-create-page :deep(.el-tabs__item.is-active),
.free-create-page :deep(.el-tabs__item:hover) {
  color: #ff8757;
}

.free-create-page :deep(.el-tabs__active-bar) {
  background: #ff7139;
}

.free-create-page :deep(.el-input__wrapper),
.free-create-page :deep(.el-select__wrapper),
.free-create-page :deep(.el-textarea__inner) {
  color: #ededed;
  background: #171719;
  box-shadow: 0 0 0 1px #303034 inset;
}

@media (max-width: 900px) {
  .free-create-page { padding: 18px; }
  .create-layout { flex-direction: column; }
  .input-panel { width: auto; }
  .input-panel,
  .result-panel { box-sizing: border-box; width: 100%; }
}
</style>
