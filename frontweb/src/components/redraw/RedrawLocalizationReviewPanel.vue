<template>
  <section class="localization-review-panel">
    <header class="panel-heading">
      <div>
        <p class="eyebrow">02 · 全剧姓名与对白</p>
        <h2>全剧本地化审核</h2>
      </div>
      <el-tag :type="locked ? 'success' : 'warning'">{{ locked ? '已锁定' : '待审核' }}</el-tag>
    </header>

    <el-alert
      v-if="conflictMessage"
      :title="conflictMessage"
      type="error"
      :closable="false"
      show-icon
    >
      <el-button size="small" @click="$emit('refresh-requested')">刷新本地化</el-button>
    </el-alert>
    <el-alert
      v-if="validationMessage"
      :title="validationMessage"
      type="error"
      :closable="false"
      show-icon
    />

    <template v-if="draft">
      <section class="review-section">
        <div class="section-title">
          <h3>人物姓名</h3>
          <span>角色 ID 与母本源名不可修改</span>
        </div>
        <div class="name-grid">
          <article v-for="character in characters" :key="character.id" class="review-card name-card">
            <code>{{ character.id }}</code>
            <p><span>源名</span><strong>{{ character.sourceName || '—' }}</strong></p>
            <label>
              <span>目标名</span>
              <input
                v-model="draft.character_name_map[character.id]"
                type="text"
                :aria-label="`${character.id} 目标姓名`"
                :readonly="locked"
              />
            </label>
            <label class="approval-check">
              <input
                v-model="draft.review.character_name_map[character.id]"
                type="checkbox"
                :aria-label="`${character.id} 姓名已审核`"
                :disabled="locked"
              />
              姓名已审核
            </label>
          </article>
        </div>
      </section>

      <section class="review-section">
        <div class="section-title"><h3>对白</h3><span>源文、speaker 与 timecode 只读</span></div>
        <article v-for="turn in draft.dialogue_map" :key="turn.source_dialogue_id" class="review-card dialogue-card">
          <header>
            <code>{{ turn.source_dialogue_id }}</code>
            <span>说话人 {{ turn.speaker_id }}</span>
            <span>{{ timecode(turn.start_ms) }}–{{ timecode(turn.end_ms) }}</span>
          </header>
          <div class="source-target-grid">
            <div><small>源文</small><p>{{ turn.source_text }}</p></div>
            <label>
              <small>目标文</small>
              <textarea
                v-model="turn.target_text"
                rows="3"
                :aria-label="`${turn.source_dialogue_id} 目标对白`"
                :readonly="locked"
              />
            </label>
          </div>
          <footer>
            <span>预计语速 {{ turn.estimated_speech_rate }} 字符/秒</span>
            <span>预计时长 {{ turn.estimated_duration_ms }} ms</span>
            <span>情绪 {{ turn.emotion || '—' }}</span>
          </footer>
          <label class="approval-check">
            <input
              v-model="draft.review.dialogue_map[turn.source_dialogue_id]"
              type="checkbox"
              :aria-label="`${turn.source_dialogue_id} 对白已审核`"
              :disabled="locked"
            />
            对白已审核
          </label>
        </article>
      </section>

      <section class="review-section">
        <div class="section-title"><h3>OCR / 画面文字</h3><span>需替换区域精确覆盖</span></div>
        <article v-for="region in draft.text_region_map" :key="region.text_region_id" class="review-card compact-card">
          <code>{{ region.text_region_id }}</code>
          <div class="source-target-grid">
            <div><small>源文</small><p>{{ region.source_text }}</p></div>
            <label><small>目标文</small><input v-model="region.target_text" type="text" :readonly="locked" /></label>
          </div>
          <label class="approval-check">
            <input
              v-model="draft.review.text_region_map[region.text_region_id]"
              type="checkbox"
              :aria-label="`${region.text_region_id} OCR 已审核`"
              :disabled="locked"
            />
            OCR 已审核
          </label>
        </article>
        <p v-if="!draft.text_region_map.length" class="empty-state">母本没有需替换的文字区域</p>
      </section>

      <section class="review-section secondary-grid">
        <div>
          <div class="section-title"><h3>文化适配</h3></div>
          <article v-for="item in draft.cultural_adaptations" :key="item.id" class="review-card compact-card">
            <code>{{ item.id }}</code>
            <p>{{ item.source }} → {{ item.target }}</p>
            <small>{{ item.note }}</small>
            <label class="approval-check">
              <input v-model="draft.review.cultural_adaptations[item.id]" type="checkbox" :aria-label="`${item.id} 文化适配已审核`" :disabled="locked" />
              文化适配已审核
            </label>
          </article>
        </div>
        <div>
          <div class="section-title"><h3>Glossary</h3></div>
          <article v-for="item in draft.glossary" :key="item.source_term" class="review-card compact-card">
            <p>{{ item.source_term }} → {{ item.target_term }}</p>
            <small>{{ item.note }}</small>
            <label class="approval-check">
              <input v-model="draft.review.glossary[item.source_term]" type="checkbox" :aria-label="`${item.source_term} glossary 已审核`" :disabled="locked" />
              Glossary 已审核
            </label>
          </article>
        </div>
        <div>
          <div class="section-title"><h3>Locked terms</h3></div>
          <article v-for="term in draft.locked_terms" :key="term" class="review-card compact-card">
            <strong>{{ term }}</strong>
            <label class="approval-check">
              <input v-model="draft.review.locked_terms[term]" type="checkbox" :aria-label="`${term} locked term 已审核`" :disabled="locked" />
              Locked term 已审核
            </label>
          </article>
        </div>
      </section>

      <footer class="panel-actions">
        <span v-if="locked">本地化已锁定，只读展示</span>
        <span v-else-if="!reviewComplete">所有条目需逐项确认后才能锁定</span>
        <span v-else-if="dirty">请先保存最新审核修改</span>
        <span v-else>全部条目已审核，可以锁定</span>
        <div>
          <el-button v-if="!locked" :loading="saving" :disabled="!canSave" @click="save">保存本地化审核</el-button>
          <el-button v-if="!locked" type="primary" :loading="locking" :disabled="!canLock" @click="lock">锁定本地化</el-button>
        </div>
      </footer>
    </template>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { redrawAPI } from '@/api/redraw'

const props = defineProps({
  record: { type: Object, required: true },
  blueprint: { type: Object, default: null },
})

const emit = defineEmits(['updated', 'locked', 'refresh-requested'])
const draft = ref(null)
const baseline = ref('')
const saving = ref(false)
const locking = ref(false)
const conflictMessage = ref('')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function syncRecord(record) {
  draft.value = clone(record?.localization || null)
  baseline.value = JSON.stringify(draft.value)
  conflictMessage.value = ''
}

watch(() => props.record, syncRecord, { immediate: true, deep: true })

const blueprintValue = computed(() => props.blueprint?.blueprint || props.blueprint || {})
const sourceNames = computed(() => (blueprintValue.value.characters || [])
  .map((item) => String(item?.source_name || item?.display_name || '').trim())
  .filter(Boolean))
const characters = computed(() => Object.keys(draft.value?.character_name_map || {}).map((id) => {
  const source = (blueprintValue.value.characters || []).find((item) => String(item?.id) === id)
  return { id, sourceName: String(source?.source_name || source?.display_name || '').trim() }
}))
const locked = computed(() => props.record?.status === 'locked' || draft.value?.review?.status === 'locked')
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)

function comparable(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase(draft.value?.locale || undefined)
    .replace(/[\p{White_Space}\p{P}\p{S}]+/gu, '')
}

const hasEmptyTarget = computed(() => {
  if (!draft.value) return true
  return [
    ...Object.values(draft.value.character_name_map || {}),
    ...(draft.value.dialogue_map || []).map((item) => item.target_text),
    ...(draft.value.text_region_map || []).map((item) => item.target_text),
    ...(draft.value.cultural_adaptations || []).map((item) => item.target),
    ...(draft.value.glossary || []).map((item) => item.target_term),
    ...(draft.value.locked_terms || []),
  ].some((value) => !String(value || '').trim())
})

const hasDuplicateName = computed(() => {
  const names = Object.values(draft.value?.character_name_map || {}).map(comparable).filter(Boolean)
  return new Set(names).size !== names.length
})

const hasSourceNameRemainder = computed(() => {
  const targetValues = [
    ...Object.values(draft.value?.character_name_map || {}),
    ...(draft.value?.dialogue_map || []).map((item) => item.target_text),
    ...(draft.value?.text_region_map || []).map((item) => item.target_text),
  ].map(comparable)
  return sourceNames.value.some((sourceName) => {
    const source = comparable(sourceName)
    return source && targetValues.some((target) => target.includes(source))
  })
})

const validationMessage = computed(() => {
  if (hasEmptyTarget.value) return '目标姓名与目标文本不能为空'
  if (hasDuplicateName.value) return '目标姓名不能重复'
  if (hasSourceNameRemainder.value) return '目标内容不能残留源角色名'
  return ''
})

const reviewComplete = computed(() => {
  const review = draft.value?.review || {}
  return ['character_name_map', 'dialogue_map', 'text_region_map', 'cultural_adaptations', 'glossary', 'locked_terms']
    .every((key) => Object.values(review[key] || {}).every((value) => value === true))
})
const canSave = computed(() => !locked.value && !saving.value && !locking.value && dirty.value && !validationMessage.value)
const canLock = computed(() => !locked.value && !saving.value && !locking.value
  && !dirty.value && !validationMessage.value && reviewComplete.value)

function timecode(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0)
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.floor((value % 60_000) / 1000)
  const millis = Math.floor(value % 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

function handleConflict(error, fallback) {
  if (Number(error?.response?.status) === 409) {
    conflictMessage.value = error?.response?.data?.error?.message || '本地化已变化，请刷新后重试'
    ElMessage.error(conflictMessage.value)
    return
  }
  ElMessage.error(error?.response?.data?.error?.message || error?.message || fallback)
}

async function save() {
  if (!canSave.value) return
  saving.value = true
  conflictMessage.value = ''
  try {
    const next = await redrawAPI.saveLocalization(props.record.version_id, {
      expected_updated_at: props.record.updated_at,
      localization: clone(draft.value),
    })
    syncRecord(next)
    emit('updated', next)
    ElMessage.success('本地化审核已保存')
  } catch (error) {
    handleConflict(error, '保存本地化审核失败')
  } finally {
    saving.value = false
  }
}

async function lock() {
  if (!canLock.value) return
  locking.value = true
  conflictMessage.value = ''
  try {
    const next = await redrawAPI.lockLocalization(props.record.version_id, {
      blueprint_hash: props.record.blueprint_hash,
      expected_localization_hash: props.record.localization_hash,
      expected_updated_at: props.record.updated_at,
    })
    syncRecord(next)
    emit('locked', next)
    ElMessage.success('全剧本地化已锁定')
  } catch (error) {
    handleConflict(error, '锁定本地化失败')
  } finally {
    locking.value = false
  }
}
</script>

<style scoped>
.localization-review-panel,
.review-section {
  display: grid;
  gap: 14px;
}

.localization-review-panel {
  min-width: 0;
  padding: 20px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  background: #151515;
}

.panel-heading,
.section-title,
.dialogue-card header,
.dialogue-card footer,
.panel-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #ff9a6d;
  font-size: 12px;
  font-weight: 700;
}

h2,
h3,
p {
  margin: 0;
}

.section-title span,
.review-card small,
.dialogue-card header span,
.dialogue-card footer,
.panel-actions > span {
  color: #999;
  font-size: 12px;
}

.name-grid,
.source-target-grid,
.secondary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.secondary-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.secondary-grid > div,
.review-card,
.dialogue-card label,
.compact-card label {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.review-card {
  padding: 14px;
  border: 1px solid #303030;
  border-radius: 8px;
  background: #101010;
}

.name-card p,
.name-card label:not(.approval-check) {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

input[type="text"],
textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  color: #f5f5f5;
  background: #090909;
  font: inherit;
}

input[readonly],
textarea[readonly] {
  color: #aaa;
  background: #181818;
}

.approval-check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #d8d8d8;
  font-size: 13px;
}

.dialogue-card,
.compact-card {
  margin-bottom: 10px;
}

.dialogue-card footer {
  justify-content: flex-start;
  flex-wrap: wrap;
}

.empty-state {
  color: #888;
}

@media (max-width: 920px) {
  .name-grid,
  .source-target-grid,
  .secondary-grid {
    grid-template-columns: 1fr;
  }

  .panel-heading,
  .section-title,
  .dialogue-card header,
  .panel-actions {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
