<template>
  <section class="blueprint-review-panel" aria-labelledby="blueprint-review-title">
    <header class="panel-heading">
      <div>
        <p class="eyebrow">母本事实层</p>
        <h2 id="blueprint-review-title">母本反推审核</h2>
      </div>
      <el-tag v-if="recordState" :type="isLocked ? 'success' : 'warning'">
        {{ isLocked ? '已锁定' : '待审核' }}
      </el-tag>
    </header>

    <el-alert v-if="loading" title="正在读取母本蓝图" type="info" :closable="false" show-icon />
    <el-alert v-if="visibleError" :title="visibleError" type="error" :closable="false" show-icon>
      <template v-if="conflict" #default>
        <el-button size="small" @click="$emit('refresh-requested')">刷新母本蓝图</el-button>
      </template>
    </el-alert>
    <el-empty v-if="!loading && !visibleError && !draftBlueprint" description="尚未生成可审核的母本蓝图" />

    <template v-if="draftBlueprint">
      <el-alert
        v-if="isLocked"
        title="蓝图已锁定，只读展示"
        type="success"
        :closable="false"
        show-icon
      />

      <div class="review-layout">
        <section class="source-player" aria-label="母本源片播放器">
          <h3>源片</h3>
          <video v-if="sourceUrl" :src="sourceUrl" controls playsinline preload="metadata" />
          <div v-else class="media-empty">后端尚未返回可读源片预览，蓝图文本仍可审核。</div>
          <dl class="compact-facts">
            <div><dt>时长</dt><dd>{{ formatTime(draftBlueprint.source?.duration_ms) }}</dd></div>
            <div><dt>画面</dt><dd>{{ draftBlueprint.source?.width || '-' }} × {{ draftBlueprint.source?.height || '-' }}</dd></div>
            <div><dt>帧率</dt><dd>{{ draftBlueprint.source?.fps ?? '-' }}</dd></div>
          </dl>
        </section>

        <div class="review-content">
          <section v-if="unresolved.length" class="blocking-section" aria-live="polite">
            <header>
              <div>
                <strong>未解决声音聚类</strong>
                <p>必须由审核者明确映射；系统不会根据画面或剧情猜人物。</p>
              </div>
              <el-tag type="danger">阻断 {{ unresolved.length }} 项</el-tag>
            </header>
            <article v-for="cluster in unresolved" :key="cluster.id" class="cluster-card">
              <div>
                <strong>{{ cluster.id }}</strong>
                <span>{{ cluster.dialogue_count }} 条原对白</span>
              </div>
              <el-select
                :model-value="''"
                :aria-label="`${cluster.id} 映射角色`"
                placeholder="选择已有角色"
                :disabled="!canEdit"
                @change="mapCluster(cluster.id, $event)"
              >
                <el-option
                  v-for="character in characters"
                  :key="character.id"
                  :label="character.display_name || character.source_name || character.id"
                  :value="character.id"
                />
              </el-select>
              <el-button :disabled="!canEdit" @click="toggleOffScreen(cluster.id)">创建画外角色</el-button>
              <div v-if="offScreenOpen[cluster.id]" class="off-screen-form">
                <label>
                  <span>角色名称</span>
                  <el-input
                    v-model="offScreenDrafts[cluster.id].name"
                    :aria-label="`${cluster.id} 画外角色名称`"
                    placeholder="由审核者填写，不自动猜测"
                  />
                </label>
                <label>
                  <span>角色标识</span>
                  <el-input
                    v-model="offScreenDrafts[cluster.id].id"
                    :aria-label="`${cluster.id} 画外角色标识`"
                    placeholder="例如 character-narrator"
                  />
                </label>
                <el-button type="primary" @click="createOffScreen(cluster.id)">确认创建画外角色</el-button>
              </div>
            </article>
          </section>

          <details open>
            <summary>剧情、因果链、反转与 Hook</summary>
            <div class="detail-body">
              <section class="fact-card">
                <strong>剧情摘要</strong>
                <p>{{ draftBlueprint.story?.summary || '无' }}</p>
                <ul><li v-for="beat in draftBlueprint.story?.beats || []" :key="beat">{{ beat }}</li></ul>
                <EvidenceMeta :item="draftBlueprint.story" />
              </section>
              <section class="fact-card">
                <strong>因果链</strong>
                <p v-for="item in draftBlueprint.causal_chain || []" :key="item.id">
                  {{ item.cause }} → {{ item.effect }}
                  <EvidenceMeta :item="item" />
                </p>
              </section>
              <section class="fact-card">
                <strong>反转</strong>
                <p v-for="item in draftBlueprint.reversals || []" :key="item.id">
                  {{ item.text }}
                  <EvidenceMeta :item="item" />
                </p>
              </section>
              <section class="fact-card">
                <strong>剧集 Hook</strong>
                <p>{{ draftBlueprint.episode_hook?.text || '无' }}</p>
                <EvidenceMeta :item="draftBlueprint.episode_hook" />
              </section>
              <section class="fact-card full-row">
                <strong>锁定事实</strong>
                <p v-for="item in draftBlueprint.locked_facts || []" :key="item.id">
                  {{ item.text }}
                  <EvidenceMeta :item="item" />
                </p>
              </section>
            </div>
          </details>

          <details open>
            <summary>角色与关系</summary>
            <div class="card-grid">
              <article v-for="character in characters" :key="character.id" class="fact-card">
                <div class="item-heading">
                  <strong>{{ character.display_name || character.source_name }}</strong>
                  <el-tag :type="character.review_status === 'approved' ? 'success' : 'warning'">
                    {{ character.review_status }}
                  </el-tag>
                </div>
                <p>{{ character.id }}</p>
                <p>{{ character.relationship }}</p>
                <p v-if="character.relationships?.length">关系：{{ character.relationships.join('、') }}</p>
                <EvidenceMeta :item="character" />
                <el-button
                  v-if="canEdit && character.review_status !== 'approved'"
                  size="small"
                  @click="approveCharacter(character.id)"
                >确认角色审核</el-button>
              </article>
            </div>
          </details>

          <details open>
            <summary>动作、场景、道具与 OCR</summary>
            <div class="card-grid">
              <article v-for="scene in draftBlueprint.scenes || []" :key="scene.id" class="fact-card">
                <strong>场景 · {{ scene.location }}</strong>
                <p>{{ scene.time }}</p>
                <EvidenceMeta :item="scene" />
              </article>
              <article v-for="prop in draftBlueprint.props || []" :key="prop.id" class="fact-card">
                <strong>道具 · {{ prop.name }}</strong>
                <EvidenceMeta :item="prop" />
              </article>
            </div>
          </details>

          <details open>
            <summary>按时间排列的镜头与原对白</summary>
            <ol class="shot-list">
              <li v-for="shot in shots" :key="shot.id" class="shot-card">
                <header class="item-heading">
                  <strong>镜头 {{ shot.index }} · {{ formatTime(shot.start_ms) }} – {{ formatTime(shot.end_ms) }}</strong>
                  <span>{{ shot.id }}</span>
                </header>
                <p>构图：{{ shot.composition }}</p>
                <p>运镜：{{ shot.camera_movement }}</p>
                <p>动作：{{ shot.opening_state }} → {{ shot.continuous_action }} → {{ shot.ending_state }}</p>
                <EvidenceMeta :item="shot" />
                <div v-for="dialogue in shot.dialogue || []" :key="dialogue.id" class="dialogue-card">
                  <div class="item-heading">
                    <strong>原对白 · {{ dialogue.source_text }}</strong>
                    <el-tag :type="dialogue.review_status === 'approved' ? 'success' : 'danger'">
                      {{ dialogue.review_status }}
                    </el-tag>
                  </div>
                  <p>
                    {{ formatTime(dialogue.start_ms) }} – {{ formatTime(dialogue.end_ms) }} ·
                    {{ dialogue.speaker_id }} · {{ speakerKindLabel(dialogue) }} · {{ dialogue.emotion }}
                  </p>
                  <EvidenceMeta :item="dialogue" />
                  <el-button
                    v-if="canEdit && dialogue.speaker_kind !== 'voice_cluster' && dialogue.review_status !== 'approved'"
                    size="small"
                    @click="approveDialogue(dialogue.id)"
                  >确认对白审核</el-button>
                </div>
                <div v-for="region in shot.text_regions || []" :key="region.id" class="ocr-card">
                  <strong>OCR · {{ region.source_text || '未识别文本' }}</strong>
                  <p>{{ region.kind }} · {{ region.id }}</p>
                  <EvidenceMeta :item="region" />
                </div>
              </li>
            </ol>
          </details>

          <details>
            <summary>证据清单</summary>
            <ul class="evidence-list">
              <li v-for="item in draftBlueprint.evidence_manifest?.items || []" :key="item.id">
                <strong>{{ item.id }}</strong>
                <span>{{ item.kind }} · {{ item.tool }} {{ item.tool_version }}</span>
              </li>
            </ul>
          </details>
        </div>
      </div>

      <footer v-if="!isLocked" class="review-actions">
        <div class="approval-box">
          <label>
            <span>审核人标识</span>
            <el-input v-model="reviewer" aria-label="审核人标识" :disabled="!canEdit" />
          </label>
          <el-button
            :disabled="!canEdit || unresolved.length > 0 || nonReviewBlockers.length > 0 || !reviewer.trim()"
            @click="approveReview"
          >确认母本事实审核</el-button>
        </div>
        <ul v-if="lockBlockers.length" class="blocker-list" aria-label="蓝图锁定阻断项">
          <li v-for="item in lockBlockers" :key="item">{{ item }}</li>
        </ul>
        <div class="action-buttons">
          <el-button :loading="saving" :disabled="!canEdit || !dirty" @click="saveDraft()">保存审核修改</el-button>
          <el-button
            type="primary"
            :loading="locking"
            :disabled="!canEdit || lockBlockers.length > 0"
            @click="lockDraft"
          >锁定母本蓝图</el-button>
        </div>
      </footer>
    </template>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, reactive, ref, watch } from 'vue'
import { ElButton, ElInput } from 'element-plus'
import { redrawAPI } from '@/api/redraw'
import {
  approveBlueprintReview,
  approveCharacterReview,
  approveDialogueReview,
  blueprintLockBlockers,
  buildBlueprintLockPayload,
  buildBlueprintSavePayload,
  createOffScreenCharacterForCluster,
  mapVoiceClusterToCharacter,
  unresolvedVoiceClusters,
} from '@/utils/redrawBlueprintReviewState'

const props = defineProps({
  record: { type: Object, default: null },
  work: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
const emit = defineEmits(['updated', 'locked', 'refresh-requested'])

const EvidenceMeta = defineComponent({
  name: 'EvidenceMeta',
  props: { item: { type: Object, default: null } },
  setup(componentProps) {
    return () => {
      const refs = Array.isArray(componentProps.item?.evidence_refs) ? componentProps.item.evidence_refs : []
      const confidence = Number(componentProps.item?.confidence)
      const confidenceText = Number.isFinite(confidence) ? `置信度 ${Math.round(confidence * 100)}%` : '置信度未提供'
      return h('span', { class: 'evidence-meta' }, [
        h('span', confidenceText),
        ...refs.map((refId) => h('code', { key: refId }, String(refId))),
      ])
    }
  },
})

const recordState = ref(null)
const draftBlueprint = ref(null)
const dirty = ref(false)
const saving = ref(false)
const locking = ref(false)
const localError = ref('')
const conflict = ref(false)
const reviewer = ref('')
const offScreenOpen = reactive({})
const offScreenDrafts = reactive({})

const isLocked = computed(() => recordState.value?.status === 'locked')
const canEdit = computed(() => !isLocked.value && !saving.value && !locking.value && !conflict.value)
const characters = computed(() => Array.isArray(draftBlueprint.value?.characters) ? draftBlueprint.value.characters : [])
const shots = computed(() => [...(draftBlueprint.value?.shots || [])]
  .sort((left, right) => Number(left.start_ms) - Number(right.start_ms) || Number(left.index) - Number(right.index)))
const unresolved = computed(() => draftBlueprint.value ? unresolvedVoiceClusters(draftBlueprint.value) : [])
const lockBlockers = computed(() => draftBlueprint.value ? blueprintLockBlockers(draftBlueprint.value) : ['母本蓝图不存在'])
const nonReviewBlockers = computed(() => lockBlockers.value.filter((item) => item !== '母本事实尚未审核通过'))
const visibleError = computed(() => localError.value || props.error)
const sourceUrl = computed(() => {
  const value = String(props.work?.url || props.work?.source_video_ref?.url || '').trim()
  return /^(?:https?:\/\/|\/api\/)/.test(value) ? value : ''
})

function readableError(error, fallback) {
  if (Number(error?.response?.status) === 409 || error?.response?.data?.error?.code === 'REDRAW_BLUEPRINT_CAS_CONFLICT') {
    conflict.value = true
    return '母本蓝图已变化，请刷新后重试'
  }
  return error?.response?.data?.error?.message || error?.message || fallback
}

function syncRecord(record) {
  if (!record) {
    recordState.value = null
    draftBlueprint.value = null
    dirty.value = false
    return
  }
  try {
    const blueprint = buildBlueprintSavePayload(record).blueprint
    recordState.value = { ...record, blueprint }
    draftBlueprint.value = blueprint
    reviewer.value = String(blueprint.review?.reviewer || '')
    dirty.value = false
    localError.value = ''
    conflict.value = false
  } catch (error) {
    localError.value = error.message || '母本蓝图数据无效'
  }
}

function replaceDraft(next) {
  draftBlueprint.value = next
  dirty.value = true
  localError.value = ''
}

function mapCluster(clusterId, characterId) {
  try {
    replaceDraft(mapVoiceClusterToCharacter(draftBlueprint.value, clusterId, characterId))
  } catch (error) {
    localError.value = error.message
  }
}

function toggleOffScreen(clusterId) {
  offScreenOpen[clusterId] = !offScreenOpen[clusterId]
  if (!offScreenDrafts[clusterId]) offScreenDrafts[clusterId] = { id: '', name: '' }
}

function createOffScreen(clusterId) {
  try {
    replaceDraft(createOffScreenCharacterForCluster(draftBlueprint.value, clusterId, offScreenDrafts[clusterId]))
    offScreenOpen[clusterId] = false
  } catch (error) {
    localError.value = error.message
  }
}

function approveCharacter(characterId) {
  try {
    replaceDraft(approveCharacterReview(draftBlueprint.value, characterId))
  } catch (error) {
    localError.value = error.message
  }
}

function approveDialogue(dialogueId) {
  try {
    replaceDraft(approveDialogueReview(draftBlueprint.value, dialogueId))
  } catch (error) {
    localError.value = error.message
  }
}

function approveReview() {
  try {
    replaceDraft(approveBlueprintReview(draftBlueprint.value, reviewer.value))
  } catch (error) {
    localError.value = error.message
  }
}

async function saveDraft() {
  if (!dirty.value) return recordState.value
  saving.value = true
  localError.value = ''
  try {
    const pending = { ...recordState.value, blueprint: draftBlueprint.value }
    const saved = await redrawAPI.saveBlueprint(recordState.value.work_id, buildBlueprintSavePayload(pending))
    syncRecord(saved)
    emit('updated', saved)
    return saved
  } catch (error) {
    localError.value = readableError(error, '保存母本蓝图失败')
    return null
  } finally {
    saving.value = false
  }
}

async function lockDraft() {
  if (lockBlockers.value.length > 0 || locking.value) return
  locking.value = true
  localError.value = ''
  try {
    const saved = dirty.value ? await saveDraft() : recordState.value
    if (!saved || conflict.value) return
    const locked = await redrawAPI.lockBlueprint(saved.work_id, buildBlueprintLockPayload(saved))
    syncRecord(locked)
    emit('updated', locked)
    emit('locked', locked)
  } catch (error) {
    localError.value = readableError(error, '锁定母本蓝图失败')
  } finally {
    locking.value = false
  }
}

function formatTime(value) {
  const milliseconds = Number(value)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '-'
  const totalSeconds = milliseconds / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = (totalSeconds - minutes * 60).toFixed(milliseconds % 1000 === 0 ? 0 : 1).padStart(2, '0')
  return `${String(minutes).padStart(2, '0')}:${seconds}`
}

function speakerKindLabel(dialogue) {
  if (dialogue.speaker_kind === 'voice_cluster') return '声音聚类（待映射）'
  return dialogue.off_screen ? '画外' : '画内'
}

watch(() => props.record, syncRecord, { immediate: true })
</script>

<style scoped>
.blueprint-review-panel { display: grid; gap: 14px; min-width: 0; padding: 20px; border: 1px solid #2a2a2a; border-radius: 8px; background: #151515; }
.panel-heading, .blocking-section header, .item-heading, .cluster-card > div, .review-actions, .action-buttons { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.eyebrow { margin: 0 0 6px; color: #ff9a6d; font-size: 12px; font-weight: 700; }
h2, h3, p { margin: 0; }
h2 { font-size: 20px; }
h3 { font-size: 16px; }
.review-layout { display: grid; grid-template-columns: minmax(240px, .72fr) minmax(0, 1.5fr); gap: 14px; align-items: start; min-width: 0; }
.source-player { position: sticky; top: 12px; display: grid; gap: 12px; min-width: 0; padding: 14px; border: 1px solid #292929; border-radius: 8px; background: #101010; }
.source-player video { width: 100%; max-height: 64vh; border-radius: 6px; background: #000; object-fit: contain; }
.media-empty { display: grid; min-height: 180px; place-items: center; padding: 12px; border: 1px dashed #363636; border-radius: 6px; color: #999; text-align: center; }
.compact-facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0; }
.compact-facts div { display: grid; gap: 3px; }
.compact-facts dt { color: #888; font-size: 11px; }
.compact-facts dd { margin: 0; color: #ddd; font-size: 12px; }
.review-content { display: grid; gap: 12px; min-width: 0; }
details { min-width: 0; border: 1px solid #292929; border-radius: 8px; background: #101010; }
summary { padding: 13px 14px; color: #f0f0f0; font-weight: 700; cursor: pointer; }
.detail-body, .card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 0 14px 14px; }
.fact-card, .shot-card, .cluster-card { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid #292929; border-radius: 7px; background: #171717; }
.full-row { grid-column: 1 / -1; }
.fact-card p, .shot-card p, .blocking-section p, .cluster-card span { color: #aaa; font-size: 13px; overflow-wrap: anywhere; }
.fact-card ul { margin: 0; padding-left: 20px; color: #bbb; font-size: 13px; }
.blocking-section { display: grid; gap: 10px; padding: 14px; border: 1px solid #c84747; border-radius: 8px; background: #251313; }
.cluster-card { grid-template-columns: minmax(140px, .7fr) minmax(180px, 1fr) auto; align-items: center; border-color: #713434; background: #191111; }
.cluster-card > div:first-child { display: grid; justify-content: start; }
.off-screen-form { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: end; }
.off-screen-form label, .approval-box label { display: grid; gap: 6px; color: #bbb; font-size: 12px; }
.shot-list { display: grid; gap: 10px; margin: 0; padding: 0 14px 14px; list-style: none; }
.shot-card { background: #131313; }
.dialogue-card, .ocr-card { display: grid; gap: 6px; padding: 10px; border-left: 3px solid #ff7139; border-radius: 5px; background: #1b1b1b; }
.ocr-card { border-left-color: #4c9ffe; }
.evidence-meta { display: flex; flex-wrap: wrap; gap: 6px; color: #888; font-size: 11px; }
.evidence-meta code { padding: 2px 5px; border-radius: 4px; background: #242424; color: #a9cfff; overflow-wrap: anywhere; }
.evidence-list { display: grid; gap: 8px; margin: 0; padding: 0 14px 14px; list-style: none; }
.evidence-list li { display: grid; gap: 4px; padding: 10px; border: 1px solid #292929; border-radius: 6px; }
.evidence-list span { color: #999; font-size: 12px; }
.review-actions { align-items: end; flex-wrap: wrap; padding-top: 4px; }
.approval-box { display: flex; align-items: end; gap: 8px; }
.approval-box label { min-width: 210px; }
.blocker-list { flex: 1 1 220px; margin: 0; color: #ff8585; font-size: 12px; }
@media (max-width: 920px) {
  .review-layout { grid-template-columns: 1fr; }
  .source-player { position: static; }
  .cluster-card, .off-screen-form, .detail-body, .card-grid { grid-template-columns: 1fr; }
  .full-row, .off-screen-form { grid-column: auto; }
  .panel-heading, .blocking-section header, .review-actions, .approval-box { align-items: stretch; flex-direction: column; }
}
</style>
