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
          <el-button :disabled="!mediaIdentity || conflict || mediaStatus === 'loading'" :loading="mediaStatus === 'loading'" @click="loadSourceVideo">加载母本</el-button>
          <video v-if="sourceUrl" :key="sourceUrl" ref="sourcePlayer" :src="sourceUrl" controls playsinline preload="metadata" referrerpolicy="no-referrer" @timeupdate="onSourceTimeUpdate" @error="onSourceMediaError" />
          <p v-if="playbackError" role="status">{{ playbackError }}</p>
          <div v-if="!sourceUrl" class="media-empty">{{ mediaStatus === 'loading' ? '正在加载母本视频…' : mediaStatus === 'undecodable' ? '浏览器无法解码母本视频，可明确重新加载后复核。' : mediaStatus === 'error' ? '母本加载失败，请复核后重新加载。' : '母本未加载；点击加载母本后可回放完整对白。蓝图文本仍可审核。' }}</div>
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
                <el-button size="small" :disabled="!canEdit || !sourceIdentityMatches" @click="beginFactEdit('scene', scene.id)">编辑场景事实</el-button>
                <div v-if="factEdit?.kind === 'scene' && factEdit.id === scene.id" class="dialogue-edit-form">
                  <label v-for="[field, label, max] in FACT_EDIT_FIELDS.scene" :key="field">{{ label }}<el-input v-model="factEdit.values[field]" :aria-label="`${scene.id} ${label}`" :maxlength="max" :disabled="!canEdit" /></label>
                  <p>仅修订地点和时间描述，不改变原始场景范围。应用后需重新审核和保存。</p>
                  <div class="action-buttons"><el-button @click="cancelFactEdit">取消事实编辑</el-button><el-button :disabled="!canEdit || !sourceIdentityMatches" @click="applyFactEdit">应用事实修订</el-button></div>
                </div>
              </article>
              <article v-for="prop in draftBlueprint.props || []" :key="prop.id" class="fact-card">
                <strong>道具 · {{ prop.name }}</strong>
                <EvidenceMeta :item="prop" />
                <el-button size="small" :disabled="!canEdit || !sourceIdentityMatches" @click="beginFactEdit('prop', prop.id)">编辑道具事实</el-button>
                <div v-if="factEdit?.kind === 'prop' && factEdit.id === prop.id" class="dialogue-edit-form">
                  <label>名称<el-input v-model="factEdit.values.name" :aria-label="`${prop.id} 名称`" :maxlength="200" :disabled="!canEdit" /></label>
                  <p>应用只修改名称草稿，不改变原始证据范围；仍须重新审核和保存。</p>
                  <div class="action-buttons"><el-button @click="cancelFactEdit">取消事实编辑</el-button><el-button :disabled="!canEdit || !sourceIdentityMatches" @click="applyFactEdit">应用事实修订</el-button></div>
                </div>
              </article>
            </div>
          </details>

          <details open>
            <summary>按时间排列的镜头与原对白</summary>
            <section class="speaker-correction" aria-label="选中对白说话人纠错">
              <div class="item-heading">
                <strong aria-live="polite">已选择 {{ selectedDialogueIds.length }} 条对白</strong>
                <el-button :disabled="!canEdit || !selectedDialogueIds.length" size="small" @click="clearDialogueSelection">清空对白选择</el-button>
              </div>
              <p>可选择一句或跨镜多句，包括已映射对白。应用只修改草稿，修改后须重新审核；原文和原声时间保持不变。</p>
              <div class="speaker-correction-fields">
                <label>
                  <span>已有角色</span>
                  <el-select v-model="selectedCharacterId" aria-label="选中对白目标角色" placeholder="选择已有角色" :disabled="!canEdit">
                    <el-option v-for="character in characters" :key="character.id" :value="character.id" :label="character.display_name || character.source_name || character.id" />
                  </el-select>
                </label>
                <label>
                  <span>画面状态</span>
                  <select v-model="selectedSpeakerKind" aria-label="选中对白画面状态" :disabled="!canEdit">
                    <option value="onscreen">画内（全部所选镜头可见）</option>
                    <option value="offscreen">画外</option>
                  </select>
                </label>
                <el-button :disabled="!canEdit || !selectedDialogueIds.length || !selectedCharacterId" @click="applySelectedCharacter">应用已有角色到选中对白</el-button>
                <label>
                  <span>新画外角色姓名</span>
                  <el-input v-model="selectedOffScreenName" aria-label="选中对白新画外角色名称" placeholder="只需填写姓名" :disabled="!canEdit" />
                </label>
                <el-button :disabled="!canEdit || !selectedDialogueIds.length || !selectedOffScreenName.trim()" @click="createSelectedOffScreen">为选中对白创建画外角色</el-button>
              </div>
            </section>
            <ol class="shot-list">
              <li v-for="shot in shots" :key="shot.id" class="shot-card">
                <header class="item-heading">
                  <strong>镜头 {{ shot.index }} · {{ formatTime(shot.start_ms) }} – {{ formatTime(shot.end_ms) }}</strong>
                  <span>{{ shot.id }}</span>
                </header>
                <p>构图：{{ shot.composition }}</p>
                <p>运镜：{{ shot.camera_movement }}</p>
                <p>动作：{{ shot.opening_state }} → {{ shot.continuous_action }} → {{ shot.ending_state }}</p>
                <p>画面可见：{{ shot.visible_character_ids.map(characterName).join('、') || '无已确认可见人物' }}</p>
                <EvidenceMeta :item="shot" />
                <el-button size="small" :disabled="!canEdit || !sourceIdentityMatches" @click="beginFactEdit('shot', shot.id)">编辑镜头事实</el-button>
                <el-button v-if="nextBoundaryShot(shot.id)" size="small" :disabled="!canEdit || !sourceIdentityMatches" @click="beginBoundaryEdit(shot.id)">调整与下一镜切点</el-button>
                <form v-if="boundaryEdit?.left_shot_id === shot.id" aria-label="相邻镜头切点纠错" class="dialogue-edit-form" @submit.prevent="applyBoundaryEdit">
                  <label>公共切点（秒）<el-input v-model="boundaryEdit.boundary_seconds" aria-label="公共切点（秒）" :disabled="!canEdit || !sourceIdentityMatches" /></label>
                  <p v-for="range in boundaryPreview.ranges || []" :key="range.id">镜头 {{ range.index }}：{{ formatTime(range.start_ms) }} – {{ formatTime(range.end_ms) }}</p>
                  <p v-if="boundaryPreview.status === 'unresolved'" role="status">{{ boundaryPreview.reason }}</p>
                  <p v-if="boundaryPreview.status === 'pending_server_verification'">两镜当前没有归属对白；这不代表物理静默，保存时仍须由服务器核验原始音频证据。</p>
                  <label v-for="turn in boundaryPreview.turns" :key="turn.dialogue_id">
                    <span>完整原句：{{ turn.source_text }}（{{ formatTime(turn.source_start_ms) }} – {{ formatTime(turn.source_end_ms) }}）</span>
                    <select v-model="boundaryEdit.assignments.find(item => item.dialogue_id === turn.dialogue_id).target_shot_id" :aria-label="`整句归属 ${turn.dialogue_id}`" :disabled="!canEdit || !sourceIdentityMatches">
                      <option v-for="target in allShots" :key="target.id" :value="target.id" :disabled="!turn.target_shots.includes(target.id)">{{ boundaryTargetLabel(target) }}{{ turn.target_shots.includes(target.id) ? '' : '（不可选：无正相交或画内人物不可见）' }}</option>
                    </select>
                    <span v-if="!turn.target_shots.includes(boundaryEdit.assignments.find(item => item.dialogue_id === turn.dialogue_id)?.target_shot_id)">当前归属已失效，请明确选择有效镜头。</span>
                  </label>
                  <p>画面文字区域不会自动迁移，请复核切点两侧画面；保存后需重新审核。原始 ASR、人物和画外属性保持不变；本预览不代表服务器已核验新投影。</p>
                  <div class="action-buttons">
                    <el-button :disabled="!canEdit || !sourceIdentityMatches || !sourcePlaybackReady || boundaryPreview.status === 'unresolved'" @click="seekBoundary">定位到切点</el-button>
                    <el-button @click="cancelBoundaryEdit">取消切点调整</el-button>
                    <el-button :disabled="!canEdit || !sourceIdentityMatches || boundaryPreview.status === 'unresolved'" @click="applyBoundaryEdit">应用切点与整句归属</el-button>
                  </div>
                </form>
                <div v-if="factEdit?.kind === 'shot' && factEdit.id === shot.id" class="dialogue-edit-form">
                  <label v-for="[field, label, max] in FACT_EDIT_FIELDS.shot" :key="field">{{ label }}<el-input v-model="factEdit.values[field]" type="textarea" :aria-label="`${shot.id} ${label}`" :maxlength="max" :disabled="!canEdit" /></label>
                  <fieldset class="visible-character-options">
                    <legend>画面可见人物</legend>
                    <label v-for="character in characters" :key="character.id"><input v-model="factEdit.values.visible_character_ids" type="checkbox" :value="character.id" :aria-label="`画面可见 · ${characterName(character.id)}`" :disabled="!canEdit" />{{ characterName(character.id) }}</label>
                  </fieldset>
                  <p>不能删除画内对白仍引用的人物；可见人物增减后该镜全部对白需重新审核。仅改事实草稿，不改变切镜时间或原始证据。</p>
                  <div class="action-buttons"><el-button @click="cancelFactEdit">取消事实编辑</el-button><el-button :disabled="!canEdit || !sourceIdentityMatches" @click="applyFactEdit">应用事实修订</el-button></div>
                </div>
                <div v-for="dialogue in shot.dialogue || []" :key="dialogue.id" class="dialogue-card">
                  <label class="dialogue-selection">
                    <input type="checkbox" :aria-label="`${dialogue.id} 选择对白`" :checked="selectedDialogueIds.includes(dialogue.id)" :disabled="!canEdit" @change="toggleDialogueSelection(dialogue.id, $event.target.checked)" />
                    选择此句纠正说话人
                  </label>
                  <div class="item-heading">
                    <strong>原对白 · {{ dialogue.source_text }}</strong>
                    <el-tag :type="dialogue.review_status === 'approved' ? 'success' : 'danger'">
                      {{ dialogue.review_status }}
                    </el-tag>
                  </div>
                  <p>
                    镜头内显示范围：{{ formatTime(dialogue.start_ms) }} – {{ formatTime(dialogue.end_ms) }} ·
                    {{ dialogue.speaker_id }} · {{ speakerKindLabel(dialogue) }} · {{ dialogue.emotion }}
                  </p>
                  <template v-if="sourceDialogue(shot.id, dialogue.id).status === 'resolved'">
                    <p>
                      整句源范围：{{ formatTime(sourceDialogue(shot.id, dialogue.id).source_start_ms) }} –
                      {{ formatTime(sourceDialogue(shot.id, dialogue.id).source_end_ms) }}
                      <span v-if="sourceDialogue(shot.id, dialogue.id).cross_shot"> · 跨镜对白，不能按镜头内范围截句生成</span>
                    </p>
                    <el-button size="small" :disabled="!sourcePlaybackReady" @click="playSourceDialogue(shot.id, dialogue.id)">播放整句原声</el-button>
                  </template>
                  <p v-else-if="sourceDialogue(shot.id, dialogue.id).status === 'unresolved'">完整对白证据未核验或已变化，请保存并刷新后复核。</p>
                  <p v-else>未提供可追溯的完整音频证据；镜头内显示范围不代表整句已核验。</p>
                  <template v-if="originalDialogue(shot.id, dialogue.id).status === 'resolved'">
                    <p>原始识别：{{ originalDialogue(shot.id, dialogue.id).original_source_text }} · {{ formatTime(originalDialogue(shot.id, dialogue.id).original_start_ms) }} – {{ formatTime(originalDialogue(shot.id, dialogue.id).original_end_ms) }}</p>
                    <p v-if="dialogue.source_correction">当前人工修订：{{ dialogue.source_text }} · 整句源范围 {{ formatTime(dialogue.source_correction.source_start_ms) }} – {{ formatTime(dialogue.source_correction.source_end_ms) }}（保存并刷新后取得核验结果）</p>
                    <el-button size="small" :disabled="!canEdit || !sourceIdentityMatches" @click="beginDialogueEdit(shot.id, dialogue.id)">编辑对白文字与时间</el-button>
                    <el-button v-if="dialogue.source_correction" size="small" :disabled="!canEdit || !sourceIdentityMatches" @click="restoreDialogue(shot.id, dialogue.id)">恢复原始识别</el-button>
                  </template>
                  <div v-if="dialogueEdit?.shot_id === shot.id && dialogueEdit?.dialogue_id === dialogue.id" class="dialogue-edit-form">
                    <label>修订文字<el-input v-model="dialogueEdit.source_text" type="textarea" :aria-label="`${dialogue.id} 修订文字`" :disabled="!canEdit" /></label>
                    <label>完整开始秒<input v-model="dialogueEdit.start_seconds" type="text" inputmode="decimal" :aria-label="`${dialogue.id} 完整开始秒`" :disabled="!canEdit" /></label>
                    <label>完整结束秒<input v-model="dialogueEdit.end_seconds" type="text" inputmode="decimal" :aria-label="`${dialogue.id} 完整结束秒`" :disabled="!canEdit" /></label>
                    <p>填写完整对白范围，保留已核验来源的原始时间精度；应用只修改草稿，仍须重新审核和保存。</p>
                    <div class="action-buttons"><el-button @click="cancelDialogueEdit">取消单句编辑</el-button><el-button :disabled="!canEdit || !sourceIdentityMatches" @click="applyDialogueEdit">应用单句修订</el-button></div>
                  </div>
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
            <div class="shot-pagination">
              <span>已显示 {{ shots.length }} / {{ allShots.length }} 个镜头</span>
              <el-button v-if="shots.length < allShots.length" size="small" @click="loadMoreShots">
                加载更多镜头
              </el-button>
            </div>
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
import { computed, defineComponent, h, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElButton, ElInput } from 'element-plus'
import { redrawAPI } from '@/api/redraw'
import {
  approveBlueprintReview,
  approveCharacterReview,
  approveDialogueReview,
  assignDialogueSpeakers,
  applyDialogueSourceCorrection,
  applyAdjacentBoundaryCorrection,
  boundaryCorrectionForReview,
  applyShotVisualFactCorrection,
  applySceneFactCorrection,
  applyPropFactCorrection,
  blueprintLockBlockers,
  buildBlueprintLockPayload,
  buildBlueprintSavePayload,
  dialogueOriginalForReview,
  dialogueMillisecondsToSeconds,
  dialogueSecondsToMilliseconds,
  dialogueSourceForReview,
  createOffScreenCharacterForCluster,
  createOffScreenCharacterForDialogues,
  mapVoiceClusterToCharacter,
  restoreDialogueSourceCorrection,
  unresolvedVoiceClusters,
} from '@/utils/redrawBlueprintReviewState'

const props = defineProps({
  record: { type: Object, default: undefined },
  work: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
const emit = defineEmits(['updated', 'locked', 'refresh-requested'])

const SHOT_CONFIDENCE_FIELDS = [
  ['character_mapping', '人物映射'],
  ['speaker_mapping', '说话人映射'],
  ['text_regions', '文字区域'],
  ['shot_boundary', '镜头边界'],
]
const SHOT_PAGE_SIZE = 20
const FACT_EDIT_FIELDS = {
  shot: [['composition', '构图', 500], ['camera_movement', '运镜', 300], ['opening_state', '起始状态', 500], ['continuous_action', '连续动作', 500], ['ending_state', '结束状态', 500]],
  scene: [['location', '地点', 200], ['time', '时间', 120]],
  prop: [['name', '名称', 200]],
}

const EvidenceMeta = defineComponent({
  name: 'EvidenceMeta',
  props: { item: { type: Object, default: null } },
  setup(componentProps) {
    return () => {
      const refs = Array.isArray(componentProps.item?.evidence_refs) ? componentProps.item.evidence_refs : []
      const confidence = componentProps.item?.confidence
      const confidenceNode = confidence && typeof confidence === 'object' && !Array.isArray(confidence)
        ? h('span', { class: 'confidence-breakdown', role: 'group', 'aria-label': '镜头置信度明细' },
          SHOT_CONFIDENCE_FIELDS.map(([key, label]) => {
            const value = confidence[key]
            return h('span', { key }, typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
              ? `${label} ${Math.round(value * 100)}%`
              : `${label} 未提供`)
          }))
        : h('span', typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
          ? `置信度 ${Math.round(confidence * 100)}%`
          : '置信度未提供')
      return h('span', { class: 'evidence-meta' }, [
        confidenceNode,
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
const selectedDialogueIds = ref([])
const selectedCharacterId = ref('')
const selectedSpeakerKind = ref('onscreen')
const selectedOffScreenName = ref('')
const dialogueEdit = ref(null)
const factEdit = ref(null)
const boundaryEdit = ref(null)
const visibleShotLimit = ref(SHOT_PAGE_SIZE)
const sourcePlayer = ref(null)
const playbackError = ref('')
const sourceUrl = ref('')
const mediaStatus = ref('not_loaded')
const mediaBoundIdentity = ref('')
let mediaEpoch = 0
let mediaRequest = null
let playback = null
let requestEpoch = 0
let activeRequest = null
const disposed = ref(false)

function sourceDialogue(shotId, dialogueId) {
  const source = dialogueSourceForReview(recordState.value, draftBlueprint.value, shotId, dialogueId)
  return source.status === 'resolved' && !sourceIdentityMatches.value ? { status: 'unresolved' } : source
}

function stopSourcePlayback() {
  if (playback) playback.player.pause()
  playback = null
}

async function playSourceDialogue(shotId, dialogueId) {
  stopSourcePlayback()
  playbackError.value = ''
  const source = sourceDialogue(shotId, dialogueId)
  const player = sourcePlayer.value
  if (source.status !== 'resolved' || !player || !sourcePlaybackReady.value) return
  if (player.readyState < 1 || !Number.isFinite(player.duration)
    || player.duration * 1000 < source.source_end_ms) {
    playbackError.value = '源片尚未就绪或时长不匹配，不能回放完整对白。'
    return
  }
  const request = { player, shotId, dialogueId, endMs: source.source_end_ms }
  playback = request
  try {
    player.currentTime = source.source_start_ms / 1000
    await player.play()
  } catch {
    if (playback === request) {
      stopSourcePlayback()
      playbackError.value = '整句原声播放失败，请检查源片是否可播放。'
    }
  }
}

function onSourceTimeUpdate() {
  if (!playback) return
  const source = sourceDialogue(playback.shotId, playback.dialogueId)
  if (source.status !== 'resolved' || playback.player.currentTime * 1000 >= playback.endMs) stopSourcePlayback()
}

const isLocked = computed(() => recordState.value?.status === 'locked')
const canEdit = computed(() => !disposed.value && !!recordState.value
  && String(recordState.value.work_id) === String(props.work?.id)
  && !isLocked.value && !saving.value && !locking.value && !conflict.value)
const characters = computed(() => Array.isArray(draftBlueprint.value?.characters) ? draftBlueprint.value.characters : [])
const allShots = computed(() => [...(draftBlueprint.value?.shots || [])]
  .sort((left, right) => Number(left.start_ms) - Number(right.start_ms) || Number(left.index) - Number(right.index)))
const shots = computed(() => allShots.value.slice(0, visibleShotLimit.value))
const unresolved = computed(() => draftBlueprint.value ? unresolvedVoiceClusters(draftBlueprint.value, recordState.value) : [])
const lockBlockers = computed(() => draftBlueprint.value ? blueprintLockBlockers(draftBlueprint.value, recordState.value) : ['母本蓝图不存在'])
const nonReviewBlockers = computed(() => lockBlockers.value.filter((item) => item !== '母本事实尚未审核通过'))
const visibleError = computed(() => localError.value || props.error)
function positiveSourceId(value) {
  return (typeof value === 'number' || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0
}
const sourceIdentityMatches = computed(() => {
  const source = draftBlueprint.value?.source
  return /^[a-f0-9]{64}$/.test(props.work?.source_fingerprint || '')
    && props.work.source_fingerprint === source?.sha256
    && positiveSourceId(props.work.source_asset_id) && positiveSourceId(source?.asset_id)
    && String(props.work.source_asset_id) === String(source.asset_id)
})
const mediaIdentity = computed(() => {
  const workId = Number(recordState.value?.work_id)
  const assetId = Number(props.work?.source_asset_id)
  if (!positiveSourceId(recordState.value?.work_id) || !positiveSourceId(props.work?.id) || Number(props.work.id) !== workId
    || !Number.isSafeInteger(assetId) || assetId <= 0 || !sourceIdentityMatches.value) return ''
  const record = recordState.value
  return JSON.stringify([workId, assetId, props.work.source_fingerprint, record.id, record.revision,
    record.updated_at, record.blueprint_hash, record.status])
})
const sourcePlaybackReady = computed(() => !disposed.value && !conflict.value && !!sourceUrl.value
  && !!mediaIdentity.value && mediaBoundIdentity.value === mediaIdentity.value)

function invalidateSourceMedia() {
  mediaEpoch += 1
  mediaRequest?.controller.abort()
  mediaRequest = null
  const player = sourcePlayer.value
  const playingPlayer = playback?.player
  stopSourcePlayback()
  if (player) {
    if (player !== playingPlayer) player.pause()
    player.removeAttribute?.('src')
    player.load?.()
  }
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
  sourceUrl.value = ''
  mediaBoundIdentity.value = ''
  mediaStatus.value = 'not_loaded'
}

function currentMediaRequest(request) {
  return !disposed.value && !conflict.value && mediaRequest === request && request.epoch === mediaEpoch
    && request.identity === mediaIdentity.value && !request.controller.signal.aborted
}

async function loadSourceVideo() {
  if (disposed.value || conflict.value || !mediaIdentity.value || sourcePlaybackReady.value || mediaRequest) return
  invalidateSourceMedia()
  playbackError.value = ''
  const request = { epoch: mediaEpoch, identity: mediaIdentity.value, controller: new AbortController() }
  mediaRequest = request
  mediaStatus.value = 'loading'
  try {
    const blob = await redrawAPI.getSourceVideo(Number(recordState.value.work_id), {
      asset_id: Number(props.work.source_asset_id), sha256: props.work.source_fingerprint,
    }, { signal: request.controller.signal })
    if (!currentMediaRequest(request)) return
    if (!(blob instanceof Blob) || !blob.size || !['video/mp4', 'video/quicktime'].includes(blob.type)) throw new Error('母本响应不是可读视频')
    const url = URL.createObjectURL(blob)
    if (!currentMediaRequest(request)) { URL.revokeObjectURL(url); return }
    mediaBoundIdentity.value = request.identity
    sourceUrl.value = url
    mediaStatus.value = 'loaded'
  } catch (error) {
    if (!currentMediaRequest(request)) return
    invalidateSourceMedia()
    mediaStatus.value = 'error'
    playbackError.value = readableError(error, '母本视频加载失败，请明确重新加载后复核。')
    if (conflict.value) localError.value = playbackError.value
  } finally {
    if (mediaRequest === request) mediaRequest = null
  }
}

function onSourceMediaError(event) {
  if (event && event.target !== sourcePlayer.value) return
  if (!sourceUrl.value) return
  invalidateSourceMedia()
  mediaStatus.value = 'undecodable'
  playbackError.value = '浏览器无法解码母本视频，完整对白回放不可用。'
}

watch(mediaIdentity, invalidateSourceMedia, { flush: 'sync' })

function readableError(error, fallback) {
  if (Number(error?.response?.status) === 409 || error?.response?.data?.error?.code === 'REDRAW_BLUEPRINT_CAS_CONFLICT') {
    conflict.value = true
    return '母本蓝图已变化，请刷新后重试'
  }
  return error?.response?.data?.error?.message || error?.message || fallback
}

function syncRecord(record) {
  invalidateSourceMedia()
  clearDialogueSelection()
  cancelDialogueEdit()
  cancelFactEdit()
  cancelBoundaryEdit()
  playbackError.value = ''
  visibleShotLimit.value = SHOT_PAGE_SIZE
  recordState.value = null
  draftBlueprint.value = null
  dirty.value = false
  reviewer.value = ''
  if (!record) {
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

function loadMoreShots() {
  visibleShotLimit.value = Math.min(visibleShotLimit.value + SHOT_PAGE_SIZE, allShots.value.length)
}

function replaceDraft(next) {
  if (!canEdit.value) return
  stopSourcePlayback()
  draftBlueprint.value = next
  dirty.value = true
  localError.value = ''
}

function originalDialogue(shotId, dialogueId) {
  if (!sourceIdentityMatches.value) return { status: 'unresolved' }
  return dialogueOriginalForReview(recordState.value, draftBlueprint.value, shotId, dialogueId)
}

function cancelDialogueEdit() {
  dialogueEdit.value = null
}

function characterName(id) {
  const character = characters.value.find((item) => item.id === id)
  return character?.display_name || character?.source_name || id
}

function cancelFactEdit() {
  factEdit.value = null
}

function cancelBoundaryEdit() {
  boundaryEdit.value = null
}

function nextBoundaryShot(shotId) {
  const index = allShots.value.findIndex((shot) => shot.id === shotId)
  return index < 0 ? null : allShots.value[index + 1]
}

const boundaryPreview = computed(() => {
  const edit = boundaryEdit.value
  if (!edit) return { status: 'unresolved', turns: [] }
  try {
    const boundary = dialogueSecondsToMilliseconds(edit.boundary_seconds)
    const preview = boundaryCorrectionForReview(recordState.value, draftBlueprint.value, edit.left_shot_id, edit.right_shot_id, boundary)
    return { ...preview, ranges: allShots.value.filter((shot) => [edit.left_shot_id, edit.right_shot_id].includes(shot.id))
      .map((shot) => ({ ...shot, ...(shot.id === edit.left_shot_id ? { end_ms: boundary } : { start_ms: boundary }) })) }
  } catch (error) { return { status: 'unresolved', turns: [], reason: error.message } }
})

function beginBoundaryEdit(shotId) {
  if (!canEdit.value || !sourceIdentityMatches.value) return
  const right = nextBoundaryShot(shotId)
  if (!right) return
  const left = allShots.value.find((shot) => shot.id === shotId)
  stopSourcePlayback()
  cancelDialogueEdit(); cancelFactEdit()
  const preview = boundaryCorrectionForReview(recordState.value, draftBlueprint.value, left.id, right.id, left.end_ms)
  boundaryEdit.value = { left_shot_id: left.id, right_shot_id: right.id, boundary_seconds: (left.end_ms / 1000).toFixed(3),
    assignments: preview.turns.map((turn) => ({ dialogue_id: turn.dialogue_id, target_shot_id: turn.current_shot_id })) }
  localError.value = ''
}

function boundaryTargetLabel(shot) {
  const range = boundaryPreview.value.ranges?.find((item) => item.id === shot.id) || shot
  return `镜头 ${shot.index} · ${formatTime(range.start_ms)} – ${formatTime(range.end_ms)} · 可见：${shot.visible_character_ids.map(characterName).join('、') || '无已确认人物'}`
}

function applyBoundaryEdit() {
  if (!canEdit.value || !sourceIdentityMatches.value || !boundaryEdit.value) return
  const edit = boundaryEdit.value
  try {
    const next = applyAdjacentBoundaryCorrection(recordState.value, draftBlueprint.value, edit.left_shot_id, edit.right_shot_id,
      { boundary_ms: dialogueSecondsToMilliseconds(edit.boundary_seconds), assignments: edit.assignments })
    stopSourcePlayback()
    if (JSON.stringify(next) !== JSON.stringify(draftBlueprint.value)) replaceDraft(next)
    reviewer.value = String(next.review?.reviewer || '')
    cancelBoundaryEdit()
  } catch (error) { localError.value = error.message }
}

function seekBoundary() {
  if (!canEdit.value || !sourceIdentityMatches.value || !boundaryEdit.value || !sourcePlaybackReady.value
    || !sourceUrl.value.startsWith('blob:') || boundaryPreview.value.status === 'unresolved') return
  const player = sourcePlayer.value
  const boundary = dialogueSecondsToMilliseconds(boundaryEdit.value.boundary_seconds)
  if (!player || player.readyState < 1 || !Number.isFinite(player.duration) || player.duration * 1000 < boundary) {
    playbackError.value = '源片尚未就绪或时长不匹配，不能定位切点。'
    return
  }
  stopSourcePlayback()
  player.pause()
  player.currentTime = boundary / 1000
  playbackError.value = ''
}

function beginFactEdit(kind, id) {
  if (!canEdit.value || !sourceIdentityMatches.value || !['shot', 'scene', 'prop'].includes(kind)) return
  const collection = kind === 'shot' ? 'shots' : kind === 'scene' ? 'scenes' : 'props'
  const item = draftBlueprint.value[collection]?.find((entry) => entry.id === id)
  if (!item) return
  cancelDialogueEdit()
  cancelBoundaryEdit()
  const values = Object.fromEntries(FACT_EDIT_FIELDS[kind].map(([field]) => [field, item[field]]))
  if (kind === 'shot') values.visible_character_ids = [...item.visible_character_ids]
  factEdit.value = { kind, id, values }
  localError.value = ''
}

function applyFactEdit() {
  if (!canEdit.value || !sourceIdentityMatches.value || !factEdit.value) return
  const { kind, id, values } = factEdit.value
  try {
    const apply = kind === 'shot' ? applyShotVisualFactCorrection : kind === 'scene' ? applySceneFactCorrection : applyPropFactCorrection
    replaceDraft(apply(draftBlueprint.value, id, values))
    reviewer.value = ''
    cancelFactEdit()
  } catch (error) { localError.value = error.message }
}

function beginDialogueEdit(shotId, dialogueId) {
  if (!canEdit.value || !sourceIdentityMatches.value) return
  const original = originalDialogue(shotId, dialogueId)
  if (original.status !== 'resolved') return
  cancelFactEdit()
  cancelBoundaryEdit()
  const dialogue = draftBlueprint.value.shots.find((shot) => shot.id === shotId).dialogue.find((line) => line.id === dialogueId)
  dialogueEdit.value = { shot_id: shotId, dialogue_id: dialogueId, source_text: dialogue.source_text,
    start_seconds: dialogueMillisecondsToSeconds(dialogue.source_correction?.source_start_ms ?? original.original_start_ms),
    end_seconds: dialogueMillisecondsToSeconds(dialogue.source_correction?.source_end_ms ?? original.original_end_ms) }
  localError.value = ''
}

function applyDialogueEdit() {
  if (!canEdit.value || !sourceIdentityMatches.value || !dialogueEdit.value) return
  const edit = dialogueEdit.value
  try {
    replaceDraft(applyDialogueSourceCorrection(recordState.value, draftBlueprint.value, edit.shot_id, edit.dialogue_id, {
      source_text: edit.source_text,
      source_start_ms: dialogueSecondsToMilliseconds(edit.start_seconds, recordState.value, draftBlueprint.value, edit.shot_id, edit.dialogue_id),
      source_end_ms: dialogueSecondsToMilliseconds(edit.end_seconds, recordState.value, draftBlueprint.value, edit.shot_id, edit.dialogue_id),
    }))
    cancelDialogueEdit()
  } catch (error) { localError.value = error.message }
}

function restoreDialogue(shotId, dialogueId) {
  if (!canEdit.value || !sourceIdentityMatches.value) return
  try {
    replaceDraft(restoreDialogueSourceCorrection(recordState.value, draftBlueprint.value, shotId, dialogueId))
    cancelDialogueEdit()
  } catch (error) { localError.value = error.message }
}

function clearDialogueSelection() {
  selectedDialogueIds.value = []
  selectedCharacterId.value = ''
  selectedSpeakerKind.value = 'onscreen'
  selectedOffScreenName.value = ''
}

function toggleDialogueSelection(dialogueId, selected) {
  if (!canEdit.value) return
  const ids = new Set(selectedDialogueIds.value)
  if (selected) ids.add(dialogueId)
  else ids.delete(dialogueId)
  selectedDialogueIds.value = [...ids]
}

function applySelectedCharacter() {
  if (!canEdit.value) return
  try {
    replaceDraft(assignDialogueSpeakers(draftBlueprint.value, selectedDialogueIds.value, {
      character_id: selectedCharacterId.value, off_screen: selectedSpeakerKind.value === 'offscreen',
    }))
  } catch (error) {
    localError.value = error.message
  }
}

function createSelectedOffScreen() {
  if (!canEdit.value) return
  try {
    replaceDraft(createOffScreenCharacterForDialogues(draftBlueprint.value, selectedDialogueIds.value, { name: selectedOffScreenName.value }))
  } catch (error) {
    localError.value = error.message
  }
}

function mapCluster(clusterId, characterId) {
  if (!canEdit.value || !sourceIdentityMatches.value) return
  try {
    replaceDraft(mapVoiceClusterToCharacter(draftBlueprint.value, clusterId, characterId, recordState.value))
  } catch (error) {
    localError.value = error.message
  }
}

function toggleOffScreen(clusterId) {
  if (!canEdit.value || !sourceIdentityMatches.value) return
  offScreenOpen[clusterId] = !offScreenOpen[clusterId]
  if (!offScreenDrafts[clusterId]) offScreenDrafts[clusterId] = { id: '', name: '' }
}

function createOffScreen(clusterId) {
  if (!canEdit.value || !sourceIdentityMatches.value) return
  try {
    replaceDraft(createOffScreenCharacterForCluster(draftBlueprint.value, clusterId, offScreenDrafts[clusterId], recordState.value))
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
    replaceDraft(approveBlueprintReview(draftBlueprint.value, reviewer.value, recordState.value))
  } catch (error) {
    localError.value = error.message
  }
}

function invalidateRequests() {
  requestEpoch += 1
  activeRequest = null
  saving.value = false
  locking.value = false
  clearDialogueSelection()
  cancelDialogueEdit()
  cancelFactEdit()
  cancelBoundaryEdit()
  for (const key of Object.keys(offScreenOpen)) delete offScreenOpen[key]
  for (const key of Object.keys(offScreenDrafts)) delete offScreenDrafts[key]
}

function beginRequest() {
  const request = { epoch: requestEpoch, record: props.record, workId: recordState.value.work_id,
    sourceAssetId: props.work?.source_asset_id, sourceFingerprint: props.work?.source_fingerprint }
  activeRequest = request
  return request
}

function isCurrentRequest(request) {
  return !disposed.value && activeRequest === request && request.epoch === requestEpoch
    && props.record === request.record
    && String(props.work?.id) === String(request.workId)
    && props.work?.source_asset_id === request.sourceAssetId
    && props.work?.source_fingerprint === request.sourceFingerprint
}

async function persistDraft(request) {
  saving.value = true
  try {
    const pending = { ...recordState.value, blueprint: draftBlueprint.value }
    const saved = await redrawAPI.saveBlueprint(request.workId, buildBlueprintSavePayload(pending))
    if (!isCurrentRequest(request)) return null
    if (String(saved?.work_id) !== String(request.workId)) throw new Error('保存回执不属于当前作品，请刷新后复核')
    syncRecord(saved)
    return saved
  } catch (error) {
    if (isCurrentRequest(request)) localError.value = readableError(error, '保存母本蓝图失败')
    return null
  } finally {
    if (isCurrentRequest(request)) saving.value = false
  }
}

async function saveDraft() {
  if (!canEdit.value || activeRequest) return null
  if (!dirty.value) return recordState.value
  const request = beginRequest()
  localError.value = ''
  try {
    const saved = await persistDraft(request)
    if (!saved || !isCurrentRequest(request)) return null
    emit('updated', saved)
    return saved
  } finally {
    if (isCurrentRequest(request)) activeRequest = null
  }
}

async function lockDraft() {
  if (!canEdit.value || lockBlockers.value.length > 0 || activeRequest) return
  const request = beginRequest()
  locking.value = true
  localError.value = ''
  try {
    // Do not emit an intermediate save: a parent prop sync would invalidate this same lock operation.
    const saved = dirty.value ? await persistDraft(request) : recordState.value
    if (!saved || !isCurrentRequest(request) || conflict.value) return
    if (blueprintLockBlockers(saved.blueprint, saved).length) {
      locking.value = false
      activeRequest = null
      emit('updated', saved)
      localError.value = '修改已保存，服务器要求重新审核；请复审对白与母本事实后再明确锁定。'
      return
    }
    const locked = await redrawAPI.lockBlueprint(saved.work_id, buildBlueprintLockPayload(saved))
    if (!isCurrentRequest(request)) return
    if (String(locked?.work_id) !== String(request.workId)) throw new Error('锁定回执不属于当前作品，请刷新后复核')
    syncRecord(locked)
    emit('updated', locked)
    emit('locked', locked)
  } catch (error) {
    if (isCurrentRequest(request)) localError.value = readableError(error, '锁定母本蓝图失败')
  } finally {
    if (isCurrentRequest(request)) {
      locking.value = false
      activeRequest = null
    }
  }
}

function formatTime(value) {
  const milliseconds = Number(value)
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > Number.MAX_SAFE_INTEGER) return '-'
  const [whole, fraction = ''] = dialogueMillisecondsToSeconds(milliseconds).split('.')
  const minutes = Math.floor(Number(whole) / 60)
  const seconds = String(Number(whole) % 60).padStart(2, '0')
  const decimals = Number.isSafeInteger(milliseconds) ? fraction.padEnd(fraction ? 3 : 0, '0') : fraction
  return `${String(minutes).padStart(2, '0')}:${seconds}${decimals ? `.${decimals}` : ''}`
}

function speakerKindLabel(dialogue) {
  if (dialogue.speaker_kind === 'voice_cluster') return '声音聚类（待映射）'
  return dialogue.off_screen ? '画外' : '画内'
}

watch([() => props.record, () => props.record?.id, () => props.record?.revision,
  () => props.record?.updated_at, () => props.record?.blueprint_hash, () => props.record?.status,
  () => props.work?.id, () => props.work?.source_asset_id, () => props.work?.source_fingerprint], () => {
  invalidateRequests()
  localError.value = ''
  conflict.value = false
  syncRecord(String(props.record?.work_id) === String(props.work?.id) ? props.record : null)
}, { immediate: true, flush: 'sync' })
watch([conflict, isLocked], ([hasConflict, locked]) => {
  if (hasConflict || locked) { clearDialogueSelection(); cancelDialogueEdit(); cancelFactEdit(); cancelBoundaryEdit() }
  if (hasConflict) invalidateSourceMedia()
}, { flush: 'sync' })
onBeforeUnmount(() => { disposed.value = true; invalidateRequests(); invalidateSourceMedia() })
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
.speaker-correction { display: grid; gap: 10px; margin: 0 14px 14px; padding: 12px; border: 1px solid #76513d; border-radius: 7px; }
.speaker-correction p, .dialogue-selection { color: #bbb; font-size: 12px; }
.speaker-correction-fields { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; }
.speaker-correction-fields label { display: grid; gap: 6px; color: #bbb; font-size: 12px; }
.speaker-correction-fields select { min-height: 32px; padding: 4px 8px; border: 1px solid #444; border-radius: 4px; background: #1b1b1b; color: #ddd; }
.dialogue-selection { display: flex; align-items: center; gap: 6px; }
.dialogue-edit-form { display: grid; gap: 8px; padding: 10px; border: 1px solid #76513d; border-radius: 5px; }
.dialogue-edit-form label { display: grid; gap: 6px; color: #bbb; font-size: 12px; }
.dialogue-edit-form input { min-height: 32px; padding: 4px 8px; border: 1px solid #444; border-radius: 4px; background: #1b1b1b; color: #ddd; }
.visible-character-options { display: flex; flex-wrap: wrap; gap: 10px; min-width: 0; border: 1px solid #444; }
.visible-character-options label { display: flex; align-items: center; gap: 6px; }
.visible-character-options input { min-height: auto; }
.shot-pagination { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 14px 14px; color: #999; font-size: 12px; }
.shot-card { background: #131313; }
.dialogue-card, .ocr-card { display: grid; gap: 6px; padding: 10px; border-left: 3px solid #ff7139; border-radius: 5px; background: #1b1b1b; }
.ocr-card { border-left-color: #4c9ffe; }
.evidence-meta { display: flex; flex-wrap: wrap; gap: 6px; color: #888; font-size: 11px; }
.confidence-breakdown { display: flex; flex-wrap: wrap; gap: 6px; }
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
