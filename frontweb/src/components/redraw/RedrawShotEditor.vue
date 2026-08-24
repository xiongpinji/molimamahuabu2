<template>
  <section v-if="shot" class="shot-editor">
    <header class="shot-editor__heading">
      <div>
        <p class="eyebrow">镜头 {{ shot.shot_index }}</p>
        <h3>{{ formatTimecode(form.start_ms) }} — {{ formatTimecode(form.end_ms) }}</h3>
      </div>
      <el-tag :type="statusType">{{ statusLabel }}</el-tag>
    </header>

    <div class="time-grid">
      <el-form-item label="开始时间（毫秒）">
        <el-input-number v-model="form.start_ms" :min="0" :step="1000" controls-position="right" />
      </el-form-item>
      <el-form-item label="结束时间（毫秒）">
        <el-input-number v-model="form.end_ms" :min="form.start_ms + 1000" :step="1000" controls-position="right" />
      </el-form-item>
      <div class="duration-note" :class="{ warning: !durationInRange }">
        {{ durationSeconds }} 秒分镜 · 建议保持 5–15 秒
      </div>
    </div>

    <div class="state-grid">
      <el-form-item label="开场状态">
        <el-input v-model="form.opening_state" type="textarea" :rows="2" />
      </el-form-item>
      <el-form-item label="连续动作">
        <el-input v-model="form.continuous_action" type="textarea" :rows="2" />
      </el-form-item>
      <el-form-item label="镜尾状态">
        <el-input v-model="form.ending_state" type="textarea" :rows="2" />
      </el-form-item>
    </div>

    <div class="dialogue-grid">
      <el-form-item label="源片台词">
        <el-input :model-value="sourceDialogueText" type="textarea" :rows="3" readonly />
      </el-form-item>
      <el-form-item label="英文台词">
        <el-input v-model="form.localized_dialogue_text" type="textarea" :rows="3" />
      </el-form-item>
    </div>

    <el-form-item label="提示词">
      <el-input v-model="form.prompt" type="textarea" :rows="4" placeholder="描述镜头画面、角色和动作连续性" />
    </el-form-item>
    <el-form-item label="负面提示词">
      <el-input v-model="form.negative_prompt" type="textarea" :rows="2" />
    </el-form-item>

    <el-form-item label="@角色/@场景/@物品">
      <el-select
        v-model="referenceIds"
        multiple
        filterable
        :filter-method="filterReferences"
        placeholder="输入 @ 搜索当前版本已批准资产"
        class="reference-select"
      >
        <el-option
          v-for="asset in filteredReferences"
          :key="asset.id"
          :label="referenceLabel(asset)"
          :value="Number(asset.id)"
        />
      </el-select>
    </el-form-item>
    <div v-if="selectedReferenceAssets.length" class="reference-versions" aria-label="已选资产版本">
      <span v-for="asset in selectedReferenceAssets" :key="asset.id">
        {{ referenceLabel(asset) }} · v{{ asset.version_number ?? '—' }}
      </span>
    </div>
    <div v-if="characterIdentityPacks.length" class="identity-map" aria-label="角色身份包映射">
      <div v-for="item in characterIdentityPacks" :key="item.sourceLabel" class="identity-map__row">
        <strong>源角色 {{ item.sourceLabel }} → 目标演员 {{ item.targetActorLabel || '待确认' }}</strong>
        <span>{{ item.shortHash ? `#${item.shortHash}` : 'hash待配置' }}</span>
        <small>{{ item.ready ? 'ready' : `缺项：${item.missingLabels.join('、')}` }}</small>
      </div>
    </div>

    <RedrawReferenceBundlePanel
      v-if="referenceBundleRequired"
      :state="referenceBundleState"
      :saving="referenceBundleSaving"
      @save="$emit('save-reference-bundle', $event)"
    />

    <div class="generation-grid">
      <el-form-item label="视频模型（后端快照）">
        <el-input v-model="form.model" readonly />
      </el-form-item>
      <el-form-item label="生成时长">
        <el-input-number v-model="form.duration" :min="5" :max="15" :step="1" controls-position="right" />
      </el-form-item>
      <el-form-item label="清晰度">
        <el-select v-model="form.resolution">
          <el-option label="720p" value="720p" />
          <el-option label="1080p" value="1080p" />
        </el-select>
      </el-form-item>
      <el-form-item label="数量 count">
        <el-input-number v-model="form.count" :min="1" :max="1" disabled />
      </el-form-item>
    </div>

    <div class="editor-actions">
      <div class="credit-callout" data-contract="canvas-credit-callout-v1">
        <strong v-if="credits !== null">本次预计扣除 {{ credits }} 积分</strong>
        <strong v-else>积分待管理员配置</strong>
        <small v-if="!availability.ok">{{ availability.reason }}</small>
      </div>
      <div class="button-row">
        <el-button :icon="DocumentChecked" :loading="saving" :disabled="!editable" @click="save">保存镜头</el-button>
        <el-button
          v-if="shot.status === 'failed'"
          type="danger"
          :icon="RefreshRight"
          :loading="generating"
          :disabled="generationDisabled"
          @click="generate(true)"
        >独立重试</el-button>
        <el-button
          v-else
          type="primary"
          :icon="VideoPlay"
          :loading="generating"
          :disabled="generationDisabled"
          @click="generate(false)"
        >生成本镜头</el-button>
      </div>
    </div>
    <el-alert
      v-if="shot.error_message"
      :title="shot.error_message"
      :description="shot.error_code || '镜头生成失败，可单独修正后重试'"
      type="error"
      :closable="false"
      show-icon
    />
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { DocumentChecked, RefreshRight, VideoPlay } from '@element-plus/icons-vue'
import {
  approvedReferenceOptions,
  formatTimecode,
  generationAvailability,
  quoteCredits,
  structuredReferences,
} from '@/utils/redrawShotState'
import { projectRedrawCharacterIdentityPack } from '@/utils/redrawCharacterIdentity'
import RedrawReferenceBundlePanel from './RedrawReferenceBundlePanel.vue'

const props = defineProps({
  shot: { type: Object, default: null },
  assets: { type: Array, default: () => [] },
  gate: { type: Object, default: () => ({ ok: false, missing: [] }) },
  saving: Boolean,
  generating: Boolean,
  referenceBundleRequired: Boolean,
  referenceBundleState: { type: Object, default: () => ({ ready: false }) },
  referenceBundleSaving: Boolean,
})
const emit = defineEmits(['save', 'generate', 'save-reference-bundle'])
const referenceQuery = ref('')
const referenceIds = ref([])
const form = reactive({
  start_ms: 0,
  end_ms: 10000,
  opening_state: '',
  continuous_action: '',
  ending_state: '',
  localized_dialogue_text: '',
  prompt: '',
  negative_prompt: '',
  model: '',
  duration: 10,
  resolution: '720p',
  count: 1,
})

const referenceAssets = computed(() => approvedReferenceOptions(props.assets))
const filteredReferences = computed(() => approvedReferenceOptions(props.assets, referenceQuery.value))
const selectedReferenceAssets = computed(() => referenceIds.value
  .map((id) => referenceAssets.value.find((asset) => Number(asset.id) === Number(id)))
  .filter(Boolean))
const characterIdentityPacks = computed(() => selectedReferenceAssets.value
  .filter((asset) => asset.kind === 'character')
  .map((asset) => projectRedrawCharacterIdentityPack(asset)))
const credits = computed(() => quoteCredits(props.shot))
const availability = computed(() => generationAvailability(props.shot, props.gate))
const editable = computed(() => ['draft', 'failed'].includes(String(props.shot?.status || '')))
const durationSeconds = computed(() => Math.max(0, Number(form.end_ms) - Number(form.start_ms)) / 1000)
const durationInRange = computed(() => durationSeconds.value >= 5 && durationSeconds.value <= 15)
const generationDisabled = computed(() => !availability.value.ok
  || !durationInRange.value
  || (props.referenceBundleRequired
    && (props.referenceBundleSaving || !props.referenceBundleState.ready)))
const sourceDialogueText = computed(() => dialogueText(props.shot?.source_dialogue))
const statusLabel = computed(() => ({
  draft: '待生成', processing: '生成中', completed: '已完成', failed: '失败', needs_attention: '需人工确认',
})[props.shot?.status] || props.shot?.status || '未知')
const statusType = computed(() => ({
  completed: 'success', failed: 'danger', needs_attention: 'warning', processing: 'primary',
})[props.shot?.status] || 'info')

function dialogueText(dialogue) {
  return (Array.isArray(dialogue) ? dialogue : []).map((line) => (
    typeof line === 'string' ? line : line?.text || line?.content || line?.dialogue || ''
  )).filter(Boolean).join('\n')
}

function referenceLabel(asset) {
  const kind = { character: '角色', scene: '场景', prop: '物品' }[asset?.kind] || '资产'
  return `@${kind} ${asset?.localized_name || asset?.display_name || asset?.name || asset?.id}`
}

function filterReferences(query) {
  referenceQuery.value = query
}

function hydrate(shot) {
  if (!shot) return
  form.start_ms = Number(shot.start_ms) || 0
  form.end_ms = Number(shot.end_ms) || form.start_ms + 10000
  form.opening_state = shot.opening_state || ''
  form.continuous_action = shot.continuous_action || ''
  form.ending_state = shot.ending_state || ''
  form.localized_dialogue_text = dialogueText(shot.localized_dialogue)
  form.prompt = shot.prompt || ''
  form.negative_prompt = shot.negative_prompt || ''
  form.model = shot.model || ''
  form.duration = Math.max(5, Math.min(15, Number(shot.duration) || Math.ceil((form.end_ms - form.start_ms) / 1000)))
  form.resolution = shot.resolution || '720p'
  form.count = 1
  referenceIds.value = (Array.isArray(shot.references) ? shot.references : [])
    .map((reference) => Number(reference.redraw_asset_id ?? reference.asset_id))
    .filter(Number.isSafeInteger)
  referenceQuery.value = ''
}

function payload() {
  return {
    updated_at: props.shot.updated_at,
    start_ms: Number(form.start_ms),
    end_ms: Number(form.end_ms),
    opening_state: form.opening_state,
    continuous_action: form.continuous_action,
    ending_state: form.ending_state,
    source_dialogue: Array.isArray(props.shot.source_dialogue) ? props.shot.source_dialogue : [],
    localized_dialogue: form.localized_dialogue_text.split('\n').map((line) => line.trim()).filter(Boolean),
    prompt: form.prompt,
    negative_prompt: form.negative_prompt,
    references: structuredReferences(selectedReferenceAssets.value),
    model: form.model,
    duration: Number(form.duration),
    resolution: form.resolution,
    count: 1,
  }
}

function save() {
  emit('save', payload())
}

function generate(retry) {
  emit('generate', { update: payload(), retry })
}

watch(() => props.shot, hydrate, { immediate: true })
</script>

<style scoped>
.shot-editor { display: grid; gap: 14px; min-width: 0; padding: 18px; border: 1px solid #2c2c2c; border-radius: 8px; background: #151515; }
.shot-editor__heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.eyebrow { margin: 0 0 5px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3 { margin: 0; font-size: 18px; overflow-wrap: anywhere; }
.time-grid, .generation-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; min-width: 0; }
.time-grid :deep(.el-form-item) { grid-column: span 2; }
.duration-note { grid-column: 1 / -1; color: #9bd7ad; font-size: 12px; }
.duration-note.warning { color: #ff9a6d; }
.state-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; min-width: 0; }
.dialogue-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; min-width: 0; }
.reference-select, :deep(.el-input-number), :deep(.el-select) { width: 100%; min-width: 0; }
.reference-versions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: -8px; }
.reference-versions span { max-width: 100%; padding: 5px 8px; border: 1px solid #3c332f; border-radius: 5px; color: #d8c2b7; font-size: 12px; overflow-wrap: anywhere; }
.identity-map { display: grid; gap: 8px; }
.identity-map__row { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid #3a302a; border-radius: 6px; background: #1a1310; color: #f2ded4; }
.identity-map__row strong, .identity-map__row small { overflow-wrap: anywhere; }
.identity-map__row span { color: #d8c2b7; font-size: 12px; overflow-wrap: anywhere; }
.editor-actions { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; min-width: 0; }
.credit-callout { display: grid; gap: 4px; min-width: 0; padding: 12px 14px; border: 1px solid #ff7139; border-radius: 8px; background: #25150f; color: #fff; }
.credit-callout strong { color: #ff9a6d; font-size: 16px; overflow-wrap: anywhere; }
.credit-callout small { color: #c9b0a6; overflow-wrap: anywhere; }
.button-row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (max-width: 900px) { .generation-grid, .state-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) {
  .shot-editor { padding: 14px; }
  .time-grid, .generation-grid, .state-grid, .dialogue-grid { grid-template-columns: 1fr; }
  .time-grid :deep(.el-form-item) { grid-column: auto; }
  .duration-note { grid-column: auto; }
  .editor-actions { align-items: stretch; flex-direction: column; }
  .button-row { display: grid; grid-template-columns: 1fr; }
  .button-row :deep(.el-button) { width: 100%; margin-left: 0; }
}
</style>
