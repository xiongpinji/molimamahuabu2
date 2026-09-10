<template>
  <section class="reference-bundle-panel" aria-label="逐镜参考包门禁">
    <header>
      <div>
        <p class="eyebrow">逐镜参考包</p>
        <h4>{{ state.ready ? '服务端证据已复核' : '生成前必须完成服务端复核' }}</h4>
      </div>
      <el-tag :type="state.ready ? 'success' : 'warning'">
        {{ state.loading ? '读取中' : state.ready ? 'ready' : 'blocked' }}
      </el-tag>
    </header>

    <div class="evidence-grid">
      <div v-for="item in evidenceItems" :key="item.key" class="evidence-item">
        <span>{{ item.label }}</span>
        <strong :class="item.ok ? 'ok' : 'pending'">{{ item.ok ? '已验证' : '未完成' }}</strong>
      </div>
    </div>

    <el-alert
      v-if="state.error || editError"
      :title="editError || state.error"
      type="error"
      :closable="false"
      show-icon
    />

    <section class="motion-material" aria-label="动作素材">
      <h4>动作素材</h4>
      <p>可预览静音草稿并手工处理 MP4，或制作待审动作参考。自动处理仅对已审核局部人物和文字做保守降细节，不是精细修补或自动合格；仍须逐帧人工审核，不会自动上传、准备或生成。</p>
      <el-alert title="仅裁片静音、人物和文字未遮除" type="warning" :closable="false" />
      <div class="motion-actions">
        <el-button data-testid="motion-draft-preview" :disabled="motionState.processingLoading" :loading="motionState.draftLoading" @click="$emit('motion-draft')">预览裁片静音草稿</el-button>
        <el-button data-testid="motion-process" :disabled="motionState.locked || motionState.processingLoading" :loading="motionState.processingLoading" @click="requestMotionProcessing">制作待审动作参考</el-button>
        <el-button data-testid="motion-refresh" :disabled="motionState.processingLoading" :loading="motionState.loading" @click="$emit('motion-refresh')">刷新动作素材</el-button>
      </div>
      <video v-if="motionState.draftUrl" :src="motionState.draftUrl" data-testid="motion-draft-video" controls playsinline />
      <a v-if="motionState.draftUrl" :href="motionState.draftUrl" download="motion-draft.mp4">下载草稿供本地处理</a>
      <p data-testid="motion-status">{{ motionState.error || motionStatus }}</p>
      <video v-if="motionState.candidateUrl" :src="motionState.candidateUrl" data-testid="motion-candidate-video" controls playsinline />
      <label>选择已处理 MP4（不超过 200 MiB）
        <input ref="motionInput" data-testid="motion-processed-file" type="file" accept=".mp4,video/mp4" :disabled="motionState.locked" @change="selectMotionFile" />
      </label>
      <p v-if="motionFile">{{ motionFile.name }} · {{ motionFile.size }} 字节</p>
      <p v-if="motionProcessingReport" data-testid="motion-processing-review">处理报告仅为待审技术附件，不是来源证明或人工质量批准。请检查身份、文字、动作和背景；不满足要求请拒绝结果。</p>
      <video v-if="motionLocalUrl" :key="motionLocalUrl" :src="motionLocalUrl" data-testid="motion-local-video" controls playsinline
        @loadeddata="motionPreviewLoaded" @error="motionPreviewFailed" />
      <p v-if="motionFileError" role="alert">{{ motionFileError }}</p>
      <label v-for="item in motionChecks" :key="item.key" class="motion-confirmation">
        <input v-model="motionConfirmations[item.key]" type="checkbox" :data-testid="`motion-confirm-${item.key.replaceAll('_', '-')}`"
          :disabled="!motionFile || motionState.locked" />{{ item.label }}
      </label>
      <div class="motion-actions">
        <el-button data-testid="motion-cancel" :disabled="motionState.locked" @click="cancelMotionSelection">取消处理 / 选择</el-button>
        <el-button v-if="motionProcessingReport" data-testid="motion-reject" :disabled="motionState.locked" @click="cancelMotionSelection">拒绝待审结果</el-button>
        <el-button data-testid="motion-upload" type="primary" :disabled="!canUploadMotion" :loading="motionState.uploading" @click="submitMotion">上传已处理动作素材</el-button>
      </div>
      <small>上传本身不扣积分。素材可读取不等于参考包 ready；未知上传需人工核对，本页不会自动重发。</small>
    </section>

    <details>
      <summary>高级参考包绑定</summary>
    <el-form-item label="无原音运动参考资产 ID">
      <el-input-number v-model="form.motion_reference_asset_id" :min="1" controls-position="right" />
    </el-form-item>
    <div class="json-grid">
      <el-form-item label="人物轨迹绑定（JSON）">
        <el-input v-model="form.face_tracks_json" type="textarea" :rows="7" />
      </el-form-item>
      <el-form-item label="文字净景绑定（JSON）">
        <el-input v-model="form.text_regions_json" type="textarea" :rows="7" />
      </el-form-item>
    </div>
    <div class="coverage-grid">
      <el-form-item v-for="field in countFields" :key="field.key" :label="field.label">
        <el-input-number v-model="form.coverage_review[field.key]" :min="0" controls-position="right" />
      </el-form-item>
      <el-form-item label="审核状态">
        <el-select v-model="form.coverage_review.status">
          <el-option label="待审核" value="pending" />
          <el-option label="已批准" value="approved" />
        </el-select>
      </el-form-item>
    </div>
    <div class="panel-actions">
      <small>保存后仍须重新 GET 并验证完整证据，PUT 响应不会直接标记 ready。</small>
      <el-button type="primary" :loading="saving" @click="save">保存参考包绑定</el-button>
    </div>
    </details>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

const props = defineProps({
  state: { type: Object, default: () => ({ ready: false, evidence: {}, response: null, error: '' }) },
  saving: Boolean,
  motionScope: { type: String, default: '' },
  motionState: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['save', 'motion-selection', 'motion-upload', 'motion-draft', 'motion-refresh', 'motion-process', 'motion-cancel'])
const motionInput = ref(null)
const motionFile = ref(null)
const motionLocalUrl = ref('')
const motionFileError = ref('')
const motionReadable = ref(false)
const motionProcessingReport = ref(null)
const motionChecks = [
  { key: 'full_frame_reviewed', label: '我已逐帧检查整个片段' },
  { key: 'source_identity_obscured', label: '原人物身份已遮除' },
  { key: 'source_text_obscured', label: '原字幕和画面文字已遮除' },
  { key: 'motion_preserved', label: '动作与镜头运动已保留' },
]
const motionConfirmations = reactive(Object.fromEntries(motionChecks.map(item => [item.key, false])))
let motionFileEpoch = 0
const motionStatus = computed(() => props.motionState.locked ? '动作素材尚未完成核对，生成已冻结'
  : props.motionState.status === 'available' ? '动作素材可读取；仍须完整参考包复核'
    : props.motionState.status === 'unavailable' ? '最新动作素材不可读取，请核对；不会回退旧素材' : '尚未上传已处理动作素材')
const canUploadMotion = computed(() => Boolean(motionFile.value && motionReadable.value && !motionFileError.value
  && !props.motionState.locked && motionChecks.every(item => motionConfirmations[item.key] === true)))

function clearMotionSelection() {
  motionFileEpoch += 1
  if (motionLocalUrl.value) URL.revokeObjectURL(motionLocalUrl.value)
  motionLocalUrl.value = ''
  motionFile.value = null
  motionProcessingReport.value = null
  motionReadable.value = false
  motionFileError.value = ''
  if (motionInput.value) motionInput.value.value = ''
  for (const item of motionChecks) motionConfirmations[item.key] = false
}
function cancelMotionSelection() {
  clearMotionSelection()
  emit('motion-cancel')
  emit('motion-selection', { scope: props.motionScope, file: null, readable: false })
}
function requestMotionProcessing() {
  if (props.motionState.locked || props.motionState.processingLoading) return
  clearMotionSelection()
  emit('motion-process')
}

async function selectMotionFile(event) {
  if (props.motionState.locked) return
  const file = event?.target?.files?.[0]
  clearMotionSelection()
  emit('motion-selection', { scope: props.motionScope, file: null, readable: false })
  if (!file) return
  motionFile.value = file
  emit('motion-selection', { scope: props.motionScope, file, readable: false })
  if (!/\.mp4$/i.test(file.name || '') || file.type !== 'video/mp4' || file.size <= 0 || file.size > 200 * 1024 * 1024) {
    motionFileError.value = '请选择非空 MP4，文件不得超过 200 MiB'
    return
  }
  const epoch = motionFileEpoch
  try {
    await file.slice(0, 32).arrayBuffer()
    if (epoch !== motionFileEpoch) return
    motionLocalUrl.value = URL.createObjectURL(file)
  } catch (_) {
    if (epoch === motionFileEpoch) motionFileError.value = '本地文件不可读取，请重新选择'
  }
}
function motionPreviewLoaded(event) {
  if (!motionLocalUrl.value || (event?.target && event.target.getAttribute('src') !== motionLocalUrl.value)) return
  if (event?.target && (event.target.readyState < 2 || event.target.videoWidth <= 0 || event.target.videoHeight <= 0)) return
  motionReadable.value = true
  emit('motion-selection', { scope: props.motionScope, file: motionFile.value, readable: true,
    ...(motionProcessingReport.value === null ? {} : { processing_report: motionProcessingReport.value }) })
}
function motionPreviewFailed(event) {
  if (event?.target && event.target.getAttribute('src') !== motionLocalUrl.value) return
  motionReadable.value = false
  motionFileError.value = '浏览器无法读取所选视频；未发送上传'
  emit('motion-selection', { scope: props.motionScope, file: motionFile.value, readable: false,
    ...(motionProcessingReport.value === null ? {} : { processing_report: motionProcessingReport.value }) })
}
function submitMotion() {
  if (!canUploadMotion.value) return
  emit('motion-upload', { scope: props.motionScope, file: motionFile.value, confirmations: { ...motionConfirmations },
    ...(motionProcessingReport.value === null ? {} : { processing_report: motionProcessingReport.value }) })
}
watch(() => props.motionState.processingResult, result => {
  if (!result) { if (motionProcessingReport.value !== null) clearMotionSelection(); return }
  if (result.scope !== props.motionScope || props.motionState.locked) return
  clearMotionSelection()
  motionFile.value = result.file
  motionProcessingReport.value = result.processingReport
  motionLocalUrl.value = URL.createObjectURL(result.file)
  emit('motion-selection', { scope: props.motionScope, file: result.file, readable: false, processing_report: result.processingReport })
}, { flush: 'sync' })
watch(() => props.motionScope, clearMotionSelection, { flush: 'sync' })
watch(() => props.motionState.resetSelection, clearMotionSelection)
onBeforeUnmount(clearMotionSelection)

const countFields = [
  { key: 'recognizable_face_count', label: '可识别人脸数' },
  { key: 'mapped_face_count', label: '已映射人脸数' },
  { key: 'unresolved_face_count', label: '未解决人脸数' },
  { key: 'recognizable_text_region_count', label: '可识别文字区数' },
  { key: 'mapped_text_region_count', label: '已映射文字区数' },
  { key: 'unresolved_text_region_count', label: '未解决文字区数' },
]
const form = reactive({
  motion_reference_asset_id: null,
  face_tracks_json: '[]',
  text_regions_json: '[]',
  coverage_review: {
    recognizable_face_count: 0,
    mapped_face_count: 0,
    unresolved_face_count: 0,
    recognizable_text_region_count: 0,
    mapped_text_region_count: 0,
    unresolved_text_region_count: 0,
    status: 'pending',
  },
})
const editError = ref('')

const evidenceItems = computed(() => [
  { key: 'faceTracks', label: '人物轨迹', ok: props.state.evidence?.faceTracks === true },
  { key: 'identityPacks', label: '身份包', ok: props.state.evidence?.identityPacks === true },
  { key: 'textClean', label: '文字净景', ok: props.state.evidence?.textClean === true },
  { key: 'motion', label: '无原音运动参考', ok: props.state.evidence?.motion === true },
  { key: 'dialogue', label: '英文对白', ok: props.state.evidence?.dialogue === true },
])

function editableBundle(response) {
  const bundle = response?.bundle || {}
  return {
    motion_reference_asset_id: bundle.motion_reference?.asset_id ?? null,
    face_tracks: (Array.isArray(bundle.face_tracks) ? bundle.face_tracks : []).map((track) => ({
      track_key: track.track_key,
      source_character_key: track.source_character_key,
      time_ranges: track.time_ranges,
      identity_redraw_asset_id: track.identity_redraw_asset_id,
    })),
    text_regions: (Array.isArray(bundle.text_regions) ? bundle.text_regions : []).map((region) => ({
      region_key: region.region_key,
      kind: region.kind,
      time_ranges: region.time_ranges,
      text_clean_redraw_asset_id: region.text_clean_redraw_asset_id,
    })),
    coverage_review: bundle.coverage_review || {},
  }
}

function hydrate(response) {
  const editable = editableBundle(response)
  form.motion_reference_asset_id = editable.motion_reference_asset_id
  form.face_tracks_json = JSON.stringify(editable.face_tracks, null, 2)
  form.text_regions_json = JSON.stringify(editable.text_regions, null, 2)
  for (const field of countFields) {
    form.coverage_review[field.key] = Number(editable.coverage_review[field.key]) || 0
  }
  form.coverage_review.status = response ? 'approved' : 'pending'
  editError.value = ''
}

function save() {
  try {
    const faceTracks = JSON.parse(form.face_tracks_json)
    const textRegions = JSON.parse(form.text_regions_json)
    if (!Array.isArray(faceTracks) || !Array.isArray(textRegions)) throw new Error('invalid arrays')
    editError.value = ''
    emit('save', {
      motion_reference_asset_id: Number(form.motion_reference_asset_id),
      face_tracks: faceTracks,
      text_regions: textRegions,
      coverage_review: {
        recognizable_face_count: Number(form.coverage_review.recognizable_face_count),
        mapped_face_count: Number(form.coverage_review.mapped_face_count),
        unresolved_face_count: Number(form.coverage_review.unresolved_face_count),
        recognizable_text_region_count: Number(form.coverage_review.recognizable_text_region_count),
        mapped_text_region_count: Number(form.coverage_review.mapped_text_region_count),
        unresolved_text_region_count: Number(form.coverage_review.unresolved_text_region_count),
        status: form.coverage_review.status,
      },
    })
  } catch (_) {
    editError.value = '参考包编辑内容格式错误，未发送保存请求'
  }
}

watch(() => props.state.response, hydrate, { immediate: true })
</script>

<style scoped>
.reference-bundle-panel { display: grid; gap: 12px; padding: 14px; border: 1px solid #66412f; border-radius: 8px; background: #1b1411; }
header, .panel-actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h4 { margin: 0; }
.evidence-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.evidence-item { display: grid; gap: 4px; padding: 8px; border: 1px solid #3d3029; border-radius: 6px; }
.evidence-item span { color: #d8c2b7; font-size: 12px; }
.evidence-item strong.ok { color: #73d49b; }
.evidence-item strong.pending { color: #ff9a6d; }
.json-grid, .coverage-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.coverage-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
:deep(.el-input-number), :deep(.el-select) { width: 100%; }
.panel-actions { align-items: center; }
.panel-actions small { color: #bca79d; }
.motion-material { display: grid; gap: 10px; min-width: 0; }
.motion-material p { margin: 0; overflow-wrap: anywhere; }
.motion-material video { width: 100%; max-height: 280px; background: #000; }
.motion-material input[type="file"] { display: block; width: 100%; margin-top: 8px; }
.motion-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.motion-confirmation { display: flex; gap: 8px; align-items: center; }
summary { cursor: pointer; padding: 10px 0; color: #d8c2b7; }
@media (max-width: 900px) { .evidence-grid, .coverage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { header, .panel-actions { flex-direction: column; } .evidence-grid, .json-grid, .coverage-grid { grid-template-columns: 1fr; } }
</style>
