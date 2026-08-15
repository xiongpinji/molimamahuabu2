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
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  state: { type: Object, default: () => ({ ready: false, evidence: {}, response: null, error: '' }) },
  saving: Boolean,
})
const emit = defineEmits(['save'])

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
@media (max-width: 900px) { .evidence-grid, .coverage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { header, .panel-actions { flex-direction: column; } .evidence-grid, .json-grid, .coverage-grid { grid-template-columns: 1fr; } }
</style>
