<template>
  <div class="script-analysis-page">
    <PlatformHeader title="剧本分析" :show-ai-config="false" />

    <main class="script-analysis-shell">
      <aside class="project-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">导演工作区</p>
            <h2>分析项目</h2>
          </div>
          <el-button class="new-button" @click="newDraft">新建</el-button>
        </div>

        <div v-loading="loadingProjects" class="project-list">
          <button
            v-for="item in projects"
            :key="item.id"
            type="button"
            class="project-item"
            :class="{ active: project.id === item.id }"
            @click="loadProject(item.id)"
          >
            <span class="project-item__title">{{ item.title || '未命名剧本' }}</span>
            <span class="project-item__meta">
              {{ statusText(item.status) }}
              <i />
              {{ formatDate(item.updated_at) }}
            </span>
          </button>

          <div v-if="!loadingProjects && projects.length === 0" class="empty-projects">
            还没有剧本分析项目
          </div>
        </div>
      </aside>

      <section class="workspace">
        <header class="workspace-hero">
          <div>
            <p class="eyebrow">专业短剧导演智能体</p>
            <h1>从原剧本到可执行分镜</h1>
            <p class="hero-copy">
              在锁定人物关系、时间线与关键事实的前提下，统一产出角色、场景、道具、镜头和生成提示词。
            </p>
          </div>
          <div class="hero-actions">
            <label class="skill-select">
              <span>导演 Skill</span>
              <select
                v-model="selectedSkillId"
                :disabled="running || loadingSkills || !skills.length"
              >
                <option
                  v-for="skill in skills"
                  :key="skill.id"
                  :value="skill.id"
                >
                  {{ skill.name }} · v{{ skill.version }}
                </option>
              </select>
            </label>
            <el-button :loading="saving" @click="saveProject">保存</el-button>
            <el-button
              type="primary"
              class="run-button"
              :loading="running"
              :disabled="!project.source_script.trim() || !selectedSkillId"
              @click="runAnalysis"
            >
              开始导演分析
            </el-button>
          </div>
        </header>

        <section class="source-card">
          <div class="section-title">
            <div>
              <span class="section-index">01</span>
              <h2>原剧本与约束</h2>
            </div>
            <div class="source-actions">
              <input
                ref="scriptFileInput"
                class="visually-hidden"
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                @change="importScriptFile"
              />
              <el-button class="import-button" @click="openScriptFilePicker">
                导入 TXT / Markdown
              </el-button>
              <span class="source-notice">原文只读保护：AI 输出不会覆盖源剧本</span>
            </div>
          </div>

          <div class="source-grid">
            <label class="field field--title">
              <span>项目名称</span>
              <input v-model="project.title" maxlength="120" placeholder="例如：雨夜来信" />
            </label>

            <label class="field field--script">
              <span>原剧本（{{ project.source_script.length }}/{{ SCRIPT_CHAR_LIMIT }}）</span>
              <textarea
                v-model="project.source_script"
                rows="15"
                :maxlength="SCRIPT_CHAR_LIMIT"
                placeholder="粘贴完整剧本、小说章节或故事大纲。建议保留人物名、场次和对白。"
              />
            </label>

            <label class="field field--facts">
              <span>锁定事实（每行一条）</span>
              <textarea
                v-model="lockedFactsText"
                rows="15"
                placeholder="例如：&#10;女主角叫林晚&#10;故事发生在现代上海&#10;父亲已经失踪三年"
              />
            </label>
          </div>
        </section>

        <section v-if="task.id || project.status" class="task-card">
          <div class="task-summary">
            <span class="status-dot" :class="taskStatusClass" />
            <div>
              <strong>{{ taskTitle }}</strong>
              <p>{{ taskMessage }}</p>
            </div>
          </div>
          <el-progress
            v-if="running"
            :percentage="task.progress"
            :show-text="false"
            :stroke-width="5"
            color="#ef7444"
          />
        </section>

        <template v-if="analysisPackage">
          <section class="overview-card">
            <div class="section-title">
              <div>
                <span class="section-index">02</span>
                <h2>导演总览</h2>
              </div>
              <div class="version-tools">
                <span class="version-chip">分析版本 {{ activeVersion }}</span>
                <span v-if="skillSnapshot" class="version-chip">
                  {{ skillSnapshot.name }} · v{{ skillSnapshot.version }}
                </span>
                <select
                  v-if="historyVersions.length"
                  v-model="selectedVersion"
                  class="version-select"
                  @change="resetRevisionEditor"
                >
                  <option value="">当前版本</option>
                  <option
                    v-for="item in historyVersions"
                    :key="item.version"
                    :value="String(item.version)"
                  >
                    版本 {{ item.version }} · {{ statusText(item.approval_status) }}
                  </option>
                </select>
              </div>
            </div>

            <div class="metrics">
              <article>
                <strong>{{ characters.length }}</strong>
                <span>角色</span>
              </article>
              <article>
                <strong>{{ scenes.length }}</strong>
                <span>场景</span>
              </article>
              <article>
                <strong>{{ props.length }}</strong>
                <span>关键道具</span>
              </article>
              <article>
                <strong>{{ shots.length }}</strong>
                <span>镜头</span>
              </article>
            </div>

            <div class="story-overview">
              <h3>{{ storyOverview.title || project.title }}</h3>
              <p>{{ storyOverview.logline || storyOverview.summary || '暂无故事总览' }}</p>
              <div class="story-tags">
                <span v-if="storyOverview.genre">
                  {{ storyOverview.genre }}
                </span>
                <span v-if="storyOverview.tone">
                  {{ storyOverview.tone }}
                </span>
                <span v-if="storyOverview.target_duration">
                  {{ storyOverview.target_duration }}
                </span>
              </div>
            </div>
          </section>

          <section v-if="visualDirection" class="visual-direction-section">
            <div class="section-title">
              <div>
                <span class="section-index">02A</span>
                <h2>电影化视觉方案</h2>
              </div>
              <span class="source-notice">增强建议不会替换原剧本与现有生产包</span>
            </div>

            <div class="visual-signal-grid">
              <article class="visual-signal-card">
                <span class="card-kicker">情绪基调</span>
                <h3>{{ visualDirection.emotional_tone.primary || '待分析' }}</h3>
                <p v-if="visualDirection.emotional_tone.secondary">
                  辅基调：{{ visualDirection.emotional_tone.secondary }}
                </p>
                <div class="evidence-list">
                  <span
                    v-for="item in visualDirection.emotional_tone.evidence"
                    :key="item"
                  >
                    {{ item }}
                  </span>
                </div>
              </article>

              <article class="visual-signal-card">
                <span class="card-kicker">节奏特征</span>
                <div class="visual-tag-list">
                  <span v-for="item in visualDirection.rhythm.labels" :key="item">
                    {{ item }}
                  </span>
                  <span v-if="visualDirection.rhythm.labels.length === 0">待分析</span>
                </div>
                <div class="evidence-list">
                  <span v-for="item in visualDirection.rhythm.evidence" :key="item">
                    {{ item }}
                  </span>
                </div>
              </article>
            </div>

            <div v-if="visualDirection.scene_profile.length" class="visual-profile-row">
              <strong>场景分布</strong>
              <span v-for="item in visualDirection.scene_profile" :key="item.type">
                {{ item.type }}<template v-if="item.ratio_percent !== undefined"> · {{ item.ratio_percent }}%</template>
              </span>
            </div>

            <div v-if="visualDirection.visual_motifs.length" class="visual-motif-grid">
              <article
                v-for="item in visualDirection.visual_motifs"
                :key="item.motif"
                class="visual-motif-card"
              >
                <span class="card-kicker">视觉母题</span>
                <h3>{{ item.motif }}</h3>
                <p>{{ item.application || '待确认画面应用方式' }}</p>
              </article>
            </div>

            <div class="visual-recommendations">
              <article
                v-for="item in visualDirection.recommendations"
                :key="`${item.rank}-${item.name}`"
                class="visual-recommendation-card"
              >
                <div class="recommendation-heading">
                  <span>方案 {{ item.rank || 1 }}</span>
                  <h3>{{ item.name || '未命名视觉方案' }}</h3>
                </div>
                <p>{{ item.objective_style || '暂无核心视觉语言' }}</p>
                <dl>
                  <template v-if="item.composition">
                    <dt>构图</dt><dd>{{ item.composition }}</dd>
                  </template>
                  <template v-if="item.camera_movement">
                    <dt>运镜</dt><dd>{{ item.camera_movement }}</dd>
                  </template>
                  <template v-if="item.lighting">
                    <dt>灯光</dt><dd>{{ item.lighting }}</dd>
                  </template>
                  <template v-if="item.color">
                    <dt>色彩</dt><dd>{{ item.color }}</dd>
                  </template>
                </dl>
                <div class="visual-tag-list">
                  <span v-for="reason in item.match_reasons" :key="reason">{{ reason }}</span>
                </div>
                <p v-if="item.risks.length" class="recommendation-risk">
                  注意：{{ item.risks.join('；') }}
                </p>
              </article>
            </div>
          </section>

          <section class="library-section">
            <div class="section-title">
              <div>
                <span class="section-index">03</span>
                <h2>制作圣经</h2>
              </div>
            </div>

            <el-tabs v-model="activeLibraryTab" class="analysis-tabs">
              <el-tab-pane label="角色" name="characters">
                <div class="card-grid">
                  <article v-for="item in characters" :key="item.id || item.name" class="bible-card">
                    <span class="card-kicker">{{ item.role || '角色' }}</span>
                    <h3>{{ item.name || '未命名角色' }}</h3>
                    <p>{{ descriptionTextFor('character', item) || '暂无角色描述' }}</p>
                    <dl>
                      <template v-if="item.visual">
                        <dt>视觉</dt>
                        <dd>{{ readableText(item.visual) }}</dd>
                      </template>
                      <template v-if="item.voice">
                        <dt>声音</dt>
                        <dd>{{ item.voice }}</dd>
                      </template>
                    </dl>
                  </article>
                </div>
              </el-tab-pane>

              <el-tab-pane label="场景" name="scenes">
                <div class="card-grid">
                  <article v-for="item in scenes" :key="item.id || item.name" class="bible-card">
                    <span class="card-kicker">{{ item.time || item.time_of_day || '场景' }}</span>
                    <h3>{{ item.name || item.location || '未命名场景' }}</h3>
                    <p>{{ descriptionTextFor('scene', item) || '暂无场景描述' }}</p>
                    <dl v-if="item.visual">
                      <dt>视觉基准</dt>
                      <dd>{{ readableText(item.visual) }}</dd>
                    </dl>
                  </article>
                </div>
              </el-tab-pane>

              <el-tab-pane label="道具" name="props">
                <div class="card-grid">
                  <article v-for="item in props" :key="item.id || item.name" class="bible-card">
                    <span class="card-kicker">{{ item.owner || '关键道具' }}</span>
                    <h3>{{ item.name || '未命名道具' }}</h3>
                    <p>{{ descriptionTextFor('prop', item) || '暂无道具描述' }}</p>
                    <dl v-if="item.continuity">
                      <dt>连续性</dt>
                      <dd>{{ item.continuity }}</dd>
                    </dl>
                  </article>
                </div>
              </el-tab-pane>
            </el-tabs>
          </section>

          <section class="shots-section">
            <div class="section-title">
              <div>
                <span class="section-index">04</span>
                <h2>分镜执行表</h2>
              </div>
              <span class="source-notice">每个镜头包含画面、运动、连续性与生成提示词</span>
            </div>

            <div class="shot-list">
              <article v-for="(shot, index) in shots" :key="shot.key" class="shot-card">
                <div class="shot-number">{{ String(index + 1).padStart(2, '0') }}</div>
                <div class="shot-content">
                  <div class="shot-heading">
                    <div>
                      <span>{{ shot.episodeTitle }} · {{ shot.sceneTitle }}</span>
                      <h3>{{ shot.title || shot.description || `镜头 ${index + 1}` }}</h3>
                    </div>
                    <span class="shot-duration">{{ shot.duration || shot.duration_seconds || '—' }}秒</span>
                  </div>

                  <p class="shot-description">{{ descriptionTextFor('shot', shot) || '暂无镜头描述' }}</p>

                  <div class="shot-meta">
                    <span v-if="shot.shot_size">{{ shot.shot_size }}</span>
                    <span v-if="shot.camera_movement">{{ shot.camera_movement }}</span>
                    <span v-if="shot.angle">{{ shot.angle }}</span>
                  </div>

                  <div class="prompt-grid">
                    <div>
                      <strong>图片提示词</strong>
                      <p>{{ shot.image_prompt || '暂无' }}</p>
                    </div>
                    <div>
                      <strong>视频提示词</strong>
                      <p>{{ shot.video_prompt || '暂无' }}</p>
                    </div>
                  </div>

                  <div v-if="shot.continuity || shot.first_frame || shot.last_frame" class="continuity-row">
                    <strong>连续性</strong>
                    <span>{{ continuityText(shot) }}</span>
                  </div>
                </div>
              </article>

              <div v-if="shots.length === 0" class="empty-results">分析结果中暂无镜头</div>
            </div>
          </section>

          <section class="review-section">
            <div class="section-title">
              <div>
                <span class="section-index">05</span>
                <h2>审查与变更</h2>
              </div>
              <span class="review-score">{{ reviewScore }}</span>
            </div>

            <div class="review-grid">
              <article>
                <h3>一致性问题</h3>
                <ul>
                  <li v-for="(issue, index) in reviewIssues" :key="index">
                    {{ issueText(issue) }}
                  </li>
                  <li v-if="reviewIssues.length === 0">未发现明确的一致性问题</li>
                </ul>
              </article>
              <article>
                <h3>AI 建议变更</h3>
                <ul>
                  <li v-for="(change, index) in aiChanges" :key="index">
                    {{ issueText(change) }}
                  </li>
                  <li v-if="aiChanges.length === 0">没有改写原剧本事实</li>
                </ul>
              </article>
            </div>

            <div class="review-actions">
              <label class="field">
                <span>人工审核备注</span>
                <textarea
                  v-model="reviewNote"
                  rows="3"
                  maxlength="2000"
                  placeholder="记录通过理由或退回修改要求"
                />
              </label>
              <div class="review-action-buttons">
                <span v-if="selectedVersion" class="history-note">
                  历史版本仅供查看，请切回当前版本后审核。
                </span>
                <el-button
                  type="success"
                  :disabled="!canImportToCanvas"
                  @click="importApprovedPackageToCanvas"
                >
                  导入独立画布
                </el-button>
                <el-button
                  :disabled="!canImportToCanvas"
                  @click="openFactoryImportPreview"
                >
                  预览导入短剧工厂
                </el-button>
                <el-button
                  :disabled="Boolean(selectedVersion) || running"
                  @click="startRevision"
                >
                  人工校订
                </el-button>
                <el-button
                  :disabled="Boolean(selectedVersion) || running"
                  :loading="reviewing"
                  @click="submitReview('rejected')"
                >
                  退回修改
                </el-button>
                <el-button
                  type="primary"
                  :disabled="Boolean(selectedVersion) || running"
                  :loading="reviewing"
                  @click="submitReview('approved')"
                >
                  确认通过
                </el-button>
              </div>
            </div>
            <div v-if="revising" class="revision-editor">
              <div class="revision-editor__heading">
                <div>
                  <strong>人工校订生产包</strong>
                  <p>保存后生成不可变新版本，原版本继续保留。</p>
                </div>
              </div>
              <label class="field">
                <span>校订后的生产包 JSON</span>
                <textarea
                  v-model="revisionPackageText"
                  rows="18"
                  spellcheck="false"
                />
              </label>
              <label class="field">
                <span>校订说明</span>
                <textarea
                  v-model="revisionNote"
                  rows="3"
                  maxlength="2000"
                  placeholder="说明本次人工修改内容"
                />
              </label>
              <div class="review-action-buttons">
                <el-button @click="cancelRevision">取消</el-button>
                <el-button
                  type="primary"
                  :loading="revisionSaving"
                  @click="submitRevision"
                >
                  保存为新版本
                </el-button>
              </div>
            </div>
          </section>
        </template>

        <section v-else class="empty-workbench">
          <span>DIRECTOR</span>
          <h2>分析完成后，这里会形成完整制作包</h2>
          <p>包括角色、场景、道具、分镜、提示词、连续性检查和 AI 变更清单。</p>
        </section>
      </section>
    </main>

    <el-dialog
      v-model="factoryPreviewVisible"
      title="短剧工厂导入预览"
      width="min(720px, calc(100vw - 32px))"
      class="factory-preview-dialog"
    >
      <div v-if="factoryPreview" class="factory-preview">
        <div class="factory-preview__source">
          <span>剧本分析项目 {{ factoryPreview.source.project_id }}</span>
          <span>版本 {{ factoryPreview.source.version }}</span>
          <span v-if="factoryPreview.skill_snapshot">
            {{ factoryPreview.skill_snapshot.name }} · v{{ factoryPreview.skill_snapshot.version }}
          </span>
        </div>

        <h3>{{ factoryPreview.story.title || factoryPreview.source.project_title }}</h3>
        <p>{{ factoryPreview.story.logline || '暂无故事简介' }}</p>
        <span v-if="factoryPreview.story.genre" class="factory-preview__genre">
          {{ factoryPreview.story.genre }}
        </span>

        <div class="factory-preview__counts">
          <article><strong>{{ factoryPreview.counts.characters }}</strong><span>角色</span></article>
          <article><strong>{{ factoryPreview.counts.scenes }}</strong><span>场景</span></article>
          <article><strong>{{ factoryPreview.counts.props }}</strong><span>道具</span></article>
          <article><strong>{{ factoryPreview.counts.episodes }}</strong><span>集数</span></article>
          <article><strong>{{ factoryPreview.counts.shots }}</strong><span>镜头</span></article>
        </div>

        <div v-if="factoryPreview.locked_facts.length" class="factory-preview__section">
          <strong>锁定事实</strong>
          <ul>
            <li v-for="item in factoryPreview.locked_facts" :key="item">{{ item }}</li>
          </ul>
        </div>

        <div v-if="factoryPreview.visual_direction" class="factory-preview__section">
          <strong>视觉指导</strong>
          <p>
            {{ factoryPreview.visual_direction.emotional_tone?.primary || '已包含电影化视觉方案' }}
          </p>
        </div>

        <p class="factory-preview__boundary">
          确认后只新增一个短剧项目，不调用模型、不扣积分。相同版本重复确认不会重复创建。
        </p>
      </div>

      <template #footer>
        <el-button :disabled="factoryImporting" @click="factoryPreviewVisible = false">关闭</el-button>
        <el-button type="primary" :loading="factoryImporting" @click="confirmFactoryImport">
          确认导入并打开项目
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import PlatformHeader from '@/components/PlatformHeader.vue'
import { scriptAnalysisAPI } from '@/api/scriptAnalysis'
import { taskAPI } from '@/api/task'
import {
  HOME_CANVAS_STORAGE_KEY,
  normalizeHomeCanvasState,
  serializeHomeCanvasState,
} from '@/utils/homeCanvasState'
import { buildScriptAnalysisCanvasState } from '@/utils/scriptAnalysisCanvasImport'
import { descriptionTextFor, readableText } from '@/utils/scriptAnalysisDescription'
import { isTransientHttpError, userHttpErrorMessage } from '@/utils/httpError'
import { buildFactorySkillImportPreview } from '@/utils/skillModuleAdapters'

const router = useRouter()
const projects = ref([])
const loadingProjects = ref(false)
const skills = ref([])
const selectedSkillId = ref('')
const loadingSkills = ref(false)
const saving = ref(false)
const running = ref(false)
const reviewing = ref(false)
const SCRIPT_CHAR_LIMIT = 60000
const scriptFileInput = ref(null)
const versions = ref([])
const selectedVersion = ref('')
const reviewNote = ref('')
const lockedFactsText = ref('')
const revising = ref(false)
const revisionSaving = ref(false)
const revisionPackageText = ref('')
const revisionNote = ref('')
const activeLibraryTab = ref('characters')
const pollingTimer = ref(null)
const taskPollFailures = ref(0)
const MAX_TRANSIENT_TASK_POLL_FAILURES = 4
const factoryPreviewVisible = ref(false)
const factoryPreview = ref(null)
const factoryImporting = ref(false)

const emptyProject = () => ({
  id: null,
  title: '',
  source_script: '',
  locked_facts: [],
  status: 'draft',
  analysis_package: null,
  active_version: 0,
})

const emptyTask = () => ({
  id: '',
  type: '',
  status: '',
  progress: 0,
  message: '',
  error: '',
})

const project = ref(emptyProject())
const task = ref(emptyTask())

function unwrap(response) {
  return response?.data ?? response
}

function parseJSON(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function asArray(value) {
  const parsed = parseJSON(value)
  return Array.isArray(parsed) ? parsed : []
}

function asObject(value) {
  const parsed = parseJSON(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : null
}

function normalizeProject(value) {
  const next = value?.project ?? value ?? {}
  return {
    ...emptyProject(),
    ...next,
    active_version: Number(next.current_version || next.active_version || 0),
    locked_facts: asArray(next.locked_facts),
    analysis_package: asObject(next.analysis_package),
  }
}

function normalizeVersion(value) {
  const next = value ?? {}
  return {
    ...next,
    version: Number(next.version || 0),
    package: asObject(next.package),
    ai_changes: asArray(next.ai_changes),
  }
}

const selectedVersionData = computed(() => {
  if (!selectedVersion.value) return null
  return versions.value.find((item) => String(item.version) === selectedVersion.value) || null
})

const historyVersions = computed(() => (
  versions.value.filter((item) => Number(item.version) !== Number(project.value.active_version))
))

const analysisEnvelope = computed(() => (
  asObject(
    selectedVersionData.value?.package ?? project.value.analysis_package,
  )
))

const analysisPackage = computed(() => {
  const value = analysisEnvelope.value
  if (!value) return null
  return asObject(value.package) || asObject(asObject(value.result)?.package) || value
})

const skillSnapshot = computed(() => (
  asObject(analysisEnvelope.value?.skill_snapshot)
  || asObject(analysisPackage.value?.skill_snapshot)
))

const storyOverview = computed(() => {
  const pkg = analysisPackage.value || {}
  const overview = pkg.normalized_script || pkg.story_overview || {}
  const duration = overview.target_duration ?? overview.target_duration_seconds
  return {
    ...overview,
    title: overview.title || project.value.title,
    target_duration: duration == null
      ? ''
      : typeof duration === 'number'
        ? `${duration} 秒`
        : duration,
  }
})

const visualDirection = computed(() => {
  const value = asObject(analysisPackage.value?.visual_direction)
  if (!value) return null
  const emotionalTone = asObject(value.emotional_tone) || {}
  const rhythm = asObject(value.rhythm) || {}
  return {
    emotional_tone: {
      ...emotionalTone,
      evidence: asArray(emotionalTone.evidence),
    },
    scene_profile: asArray(value.scene_profile),
    rhythm: {
      ...rhythm,
      labels: asArray(rhythm.labels),
      evidence: asArray(rhythm.evidence),
    },
    visual_motifs: asArray(value.visual_motifs),
    recommendations: asArray(value.recommendations).map((item) => ({
      ...item,
      match_reasons: asArray(item?.match_reasons),
      risks: asArray(item?.risks),
    })),
  }
})

const characters = computed(() => (
  analysisPackage.value?.characters
  || analysisPackage.value?.character_bible
  || []
))

const scenes = computed(() => (
  analysisPackage.value?.scenes
  || analysisPackage.value?.scene_bible
  || []
))

const props = computed(() => (
  analysisPackage.value?.props
  || analysisPackage.value?.prop_bible
  || []
))

const shots = computed(() => {
  const pkg = analysisPackage.value
  if (!pkg) return []
  if (Array.isArray(pkg.shots)) {
    return pkg.shots.map((shot, index) => ({
      ...shot,
      key: shot.id || `shot-${index}`,
      episodeTitle: '全剧',
      sceneTitle: shot.scene || '分镜',
    }))
  }

  const result = []
  const episodes = Array.isArray(pkg.episodes) ? pkg.episodes : []
  episodes.forEach((episode, episodeIndex) => {
    const episodeScenes = Array.isArray(episode.scenes) ? episode.scenes : []
    episodeScenes.forEach((scene, sceneIndex) => {
      const sceneShots = Array.isArray(scene.shots) ? scene.shots : []
      sceneShots.forEach((shot, shotIndex) => {
        result.push({
          ...shot,
          key: shot.id || `${episodeIndex}-${sceneIndex}-${shotIndex}`,
          episodeTitle: episode.title || `第 ${episodeIndex + 1} 集`,
          sceneTitle: scene.title || scene.name || `场景 ${sceneIndex + 1}`,
        })
      })
    })
  })
  return result
})

const reviewIssues = computed(() => (
  analysisPackage.value?.review?.issues
  || analysisPackage.value?.review?.continuity_issues
  || analysisPackage.value?.continuity_issues
  || []
))

const aiChanges = computed(() => (
  selectedVersionData.value?.ai_changes
  || analysisPackage.value?.ai_changes
  || analysisPackage.value?.review?.ai_changes
  || []
))

const selectedStatus = computed(() => (
  selectedVersionData.value?.approval_status || project.value.status
))

const activeVersion = computed(() => (
  selectedVersionData.value?.version
  || project.value.active_version
  || analysisPackage.value?.version
  || 1
))

const canImportToCanvas = computed(() => (
  !selectedVersion.value && selectedStatus.value === 'approved'
))

const reviewScore = computed(() => {
  const score = analysisPackage.value?.review?.score
  const label = statusText(selectedStatus.value)
  return score == null ? label : `${label} · 审查分 ${score}`
})

const taskStatusClass = computed(() => ({
  running: running.value,
  success: ['completed', 'succeeded', 'success'].includes(task.value.status),
  failed: ['failed', 'error', 'cancelled'].includes(task.value.status),
}))

const taskTitle = computed(() => {
  if (task.value.type === 'script_analysis_revision') {
    if (running.value) return '模型正在根据审核意见修改'
    if (['completed', 'succeeded', 'success'].includes(task.value.status)) return '自动修订已完成'
    if (['failed', 'error', 'cancelled'].includes(task.value.status)) return '自动修订未完成'
  }
  if (running.value) return '导演智能体正在分析'
  if (['completed', 'succeeded', 'success'].includes(task.value.status)) return '分析已完成'
  if (['failed', 'error', 'cancelled'].includes(task.value.status)) return '分析未完成'
  return statusText(project.value.status)
})

const taskMessage = computed(() => (
  task.value.error
  || task.value.message
  || (task.value.type === 'script_analysis_revision'
    ? '正在理解人工审核备注并修改完整生产包，请稍候。'
    : running.value
      ? '正在梳理事实、人物、场景和镜头，请稍候。'
      : '可继续修改原剧本后重新分析。')
))

function statusText(status) {
  const labels = {
    draft: '草稿',
    queued: '排队中',
    pending: '等待中',
    running: '分析中',
    analyzing: '分析中',
    completed: '待审核',
    succeeded: '待审核',
    success: '待审核',
    needs_review: '待审核',
    approved: '已通过',
    rejected: '已退回',
    cancelled: '已取消',
    failed: '失败',
    error: '失败',
  }
  return labels[status] || '草稿'
}

function formatDate(value) {
  if (!value) return '刚刚'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function issueText(value) {
  if (typeof value === 'string') return value
  return value?.description || value?.message || value?.change || JSON.stringify(value)
}

function continuityText(shot) {
  if (typeof shot.continuity === 'string') return shot.continuity
  if (shot.continuity) return issueText(shot.continuity)
  return [shot.first_frame, shot.last_frame].filter(Boolean).join(' → ') || '无'
}

async function listProjects() {
  loadingProjects.value = true
  try {
    const body = unwrap(await scriptAnalysisAPI.list())
    projects.value = body?.projects || body?.items || (Array.isArray(body) ? body : [])
  } catch (error) {
    ElMessage.error(error?.message || '读取剧本分析项目失败')
  } finally {
    loadingProjects.value = false
  }
}

async function loadSkills() {
  loadingSkills.value = true
  try {
    const body = unwrap(await scriptAnalysisAPI.skills())
    skills.value = Array.isArray(body?.skills) ? body.skills : []
    const current = skills.value.find((skill) => skill.id === selectedSkillId.value)
    selectedSkillId.value = current?.id
      || skills.value.find((skill) => skill.is_default)?.id
      || skills.value[0]?.id
      || ''
  } catch (error) {
    skills.value = []
    selectedSkillId.value = ''
    ElMessage.error(error?.message || '加载导演 Skill 失败')
  } finally {
    loadingSkills.value = false
  }
}

function newDraft() {
  stopPolling()
  project.value = emptyProject()
  task.value = emptyTask()
  lockedFactsText.value = ''
  versions.value = []
  selectedVersion.value = ''
  reviewNote.value = ''
  resetRevisionEditor()
}

async function loadVersions(id) {
  if (!id) {
    versions.value = []
    return
  }
  const body = unwrap(await scriptAnalysisAPI.versions(id))
  const items = body?.versions || body?.items || (Array.isArray(body) ? body : [])
  versions.value = items.map(normalizeVersion)
}

async function loadProject(id) {
  stopPolling()
  try {
    const body = unwrap(await scriptAnalysisAPI.get(id))
    project.value = normalizeProject(body)
    selectedVersion.value = ''
    resetRevisionEditor()
    lockedFactsText.value = project.value.locked_facts.join('\n')
    task.value = emptyTask()
    await loadVersions(id)
    reviewNote.value = project.value.review?.review_note
      || analysisPackage.value?.review?.review_note
      || ''
  } catch (error) {
    ElMessage.error(error?.message || '读取剧本分析项目失败')
  }
}

function projectPayload() {
  return {
    title: project.value.title.trim() || '未命名剧本',
    source_script: project.value.source_script,
    locked_facts: lockedFactsText.value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
  }
}

async function saveProject(options = {}) {
  if (!project.value.source_script.trim()) {
    ElMessage.warning('请先输入原剧本')
    return null
  }

  saving.value = true
  try {
    const body = project.value.id
      ? unwrap(await scriptAnalysisAPI.update(project.value.id, projectPayload()))
      : unwrap(await scriptAnalysisAPI.create(projectPayload()))
    project.value = normalizeProject(body)
    selectedVersion.value = ''
    resetRevisionEditor()
    lockedFactsText.value = project.value.locked_facts.join('\n')
    await loadVersions(project.value.id)
    await listProjects()
    if (!options.silent) ElMessage.success('剧本项目已保存')
    return project.value
  } catch (error) {
    ElMessage.error(error?.message || '保存失败')
    return null
  } finally {
    saving.value = false
  }
}

async function runAnalysis() {
  if (!selectedSkillId.value) {
    ElMessage.warning('请选择导演 Skill')
    return
  }
  const saved = await saveProject({ silent: true })
  if (!saved?.id) return

  running.value = true
  task.value = {
    ...emptyTask(),
    status: 'queued',
    progress: 5,
    message: '分析任务已提交',
  }

  try {
    selectedVersion.value = ''
    resetRevisionEditor()
    const body = unwrap(await scriptAnalysisAPI.run(saved.id, {
      skill_id: selectedSkillId.value,
    }))
    task.value.id = body?.task_id || body?.task?.id
    if (!task.value.id) throw new Error('服务端未返回任务编号')
    startPolling()
  } catch (error) {
    running.value = false
    task.value.status = 'failed'
    task.value.error = error?.message || '提交分析任务失败'
    ElMessage.error(task.value.error)
  }
}

function startPolling() {
  stopPolling()
  taskPollFailures.value = 0
  pollTask()
  pollingTimer.value = window.setInterval(pollTask, 1500)
}

function stopPolling() {
  if (pollingTimer.value) {
    window.clearInterval(pollingTimer.value)
    pollingTimer.value = null
  }
}

async function pollTask() {
  if (!task.value.id) return
  try {
    const body = unwrap(await taskAPI.get(task.value.id))
    taskPollFailures.value = 0
    const next = body?.task || body || {}
    task.value.type = next.type || task.value.type
    task.value.status = next.status || task.value.status
    task.value.progress = Number(next.progress ?? task.value.progress ?? 0)
    task.value.message = next.message || next.status_message || task.value.message
    task.value.error = next.error || next.error_message || ''

    if (['completed', 'succeeded', 'success'].includes(task.value.status)) {
      const isRevisionTask = task.value.type === 'script_analysis_revision'
      stopPolling()
      running.value = false
      task.value.progress = 100
      await loadProject(project.value.id)
      task.value.type = isRevisionTask ? 'script_analysis_revision' : 'script_analysis'
      task.value.status = 'completed'
      task.value.progress = 100
      task.value.message = isRevisionTask
        ? '已按审核意见生成新版本，请继续审核。'
        : '制作包已生成，请核对后再用于生产。'
      ElMessage.success(isRevisionTask ? '模型已完成自动修订' : '导演分析已完成')
    } else if (['failed', 'error', 'cancelled'].includes(task.value.status)) {
      const isRevisionTask = task.value.type === 'script_analysis_revision'
      const taskError = task.value.error || (isRevisionTask ? '自动修订失败' : '导演分析失败')
      stopPolling()
      running.value = false
      if (isRevisionTask) await loadProject(project.value.id)
      else if (project.value.status === 'analyzing') project.value.status = 'failed'
      task.value.type = isRevisionTask ? 'script_analysis_revision' : task.value.type
      task.value.status = 'failed'
      task.value.error = taskError
      ElMessage.error(taskError)
    } else {
      task.value.progress = Math.min(92, Math.max(task.value.progress, 12))
    }
  } catch (error) {
    if (isTransientHttpError(error) && taskPollFailures.value < MAX_TRANSIENT_TASK_POLL_FAILURES) {
      taskPollFailures.value += 1
      task.value.message = `服务短暂不可用，正在重新连接（${taskPollFailures.value}/${MAX_TRANSIENT_TASK_POLL_FAILURES}）`
      return
    }
    stopPolling()
    running.value = false
    task.value.status = 'failed'
    task.value.error = userHttpErrorMessage(error, '查询分析任务失败')
    ElMessage.error(task.value.error)
  }
}

function openScriptFilePicker() {
  scriptFileInput.value?.click()
}

async function importScriptFile(event) {
  const file = event?.target?.files?.[0]
  if (!file) return

  try {
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!['txt', 'md', 'markdown'].includes(extension || '')) {
      throw new Error('仅支持 TXT 或 Markdown 文件')
    }

    const text = await file.text()
    if (!text.trim()) throw new Error('文件内容为空')
    if (text.length > SCRIPT_CHAR_LIMIT) {
      throw new Error(`剧本内容超过 ${SCRIPT_CHAR_LIMIT.toLocaleString()} 字符限制`)
    }

    project.value.source_script = text
    if (!project.value.title.trim()) {
      project.value.title = file.name.replace(/\.(txt|md|markdown)$/i, '')
    }
    ElMessage.success('剧本文件已导入')
  } catch (error) {
    ElMessage.error(error?.message || '导入剧本失败')
  } finally {
    if (event?.target) event.target.value = ''
  }
}

function resetRevisionEditor() {
  revising.value = false
  revisionPackageText.value = ''
  revisionNote.value = ''
}

function startRevision() {
  if (!project.value?.analysis_package || selectedVersion.value) {
    ElMessage.warning('请切回当前版本后校订')
    return
  }
  revisionPackageText.value = JSON.stringify(project.value.analysis_package, null, 2)
  revisionNote.value = ''
  revising.value = true
}

function cancelRevision() {
  resetRevisionEditor()
}

async function submitRevision() {
  if (!project.value?.id) return
  const note = revisionNote.value.trim()
  if (!note) {
    ElMessage.warning('请填写人工校订说明')
    return
  }

  let parsedPackage
  try {
    parsedPackage = JSON.parse(revisionPackageText.value)
  } catch {
    ElMessage.warning('生产包 JSON 格式无效')
    return
  }

  revisionSaving.value = true
  try {
    const body = unwrap(await scriptAnalysisAPI.revise(project.value.id, {
      version: project.value.active_version,
      package: parsedPackage,
      note,
    }))
    project.value = normalizeProject(body)
    selectedVersion.value = ''
    resetRevisionEditor()
    await Promise.all([loadVersions(project.value.id), listProjects()])
    ElMessage.success('人工校订已保存为新版本')
  } catch (error) {
    ElMessage.error(error?.message || '人工校订失败')
  } finally {
    revisionSaving.value = false
  }
}

async function submitReview(status) {
  if (!project.value.id || !project.value.active_version) {
    ElMessage.warning('请先完成一次导演分析')
    return
  }
  if (status === 'rejected' && !reviewNote.value.trim()) {
    ElMessage.warning('退回修改时请填写审核意见')
    return
  }

  reviewing.value = true
  try {
    const note = reviewNote.value.trim()
    const body = unwrap(await scriptAnalysisAPI.review(project.value.id, {
      version: project.value.active_version,
      status,
      note,
    }))
    if (status === 'rejected') {
      const taskId = body?.task_id || body?.task?.id
      if (!taskId) throw new Error('服务端未返回自动修订任务编号')
      task.value = {
        ...emptyTask(),
        id: taskId,
        type: 'script_analysis_revision',
        status: body?.status || 'pending',
        progress: 5,
        message: '模型正在根据审核意见修改',
      }
      project.value.status = 'analyzing'
      selectedVersion.value = ''
      resetRevisionEditor()
      running.value = true
      await listProjects()
      startPolling()
      ElMessage.success('已退回，模型正在根据审核意见修改')
      return
    }
    project.value = normalizeProject(body)
    selectedVersion.value = ''
    resetRevisionEditor()
    await loadVersions(project.value.id)
    await listProjects()
    ElMessage.success('当前版本已通过审核')
  } catch (error) {
    ElMessage.error(error?.message || '提交审核结果失败')
  } finally {
    reviewing.value = false
  }
}

async function importApprovedPackageToCanvas() {
  if (!canImportToCanvas.value) {
    ElMessage.warning('仅当前审核通过的版本可以导入独立画布')
    return
  }

  try {
    const existingState = normalizeHomeCanvasState(
      localStorage.getItem(HOME_CANVAS_STORAGE_KEY),
    )
    const nextState = buildScriptAnalysisCanvasState({
      existingState,
      project: {
        ...project.value,
        active_version: activeVersion.value,
      },
      productionPackage: analysisPackage.value,
      skillSnapshot: skillSnapshot.value,
      approvalStatus: selectedStatus.value,
      importId: `project-${project.value.id}-version-${activeVersion.value}`,
    })

    localStorage.setItem(
      HOME_CANVAS_STORAGE_KEY,
      serializeHomeCanvasState(nextState),
    )
  } catch (error) {
    ElMessage.error(error?.message || '导入独立画布失败')
    return
  }

  try {
    await router.push('/canvas/local')
    ElMessage.success('已导入独立画布，原画布内容已保留')
  } catch {
    ElMessage.warning('已导入独立画布，但自动跳转失败，请手动打开画布')
  }
}

function openFactoryImportPreview() {
  try {
    factoryPreview.value = buildFactorySkillImportPreview({
      project: project.value,
      productionPackage: analysisPackage.value,
      skillSnapshot: skillSnapshot.value,
      approvalStatus: selectedStatus.value,
      activeVersion: activeVersion.value,
    })
    factoryPreviewVisible.value = true
  } catch (error) {
    ElMessage.error(error?.message || '生成短剧工厂导入预览失败')
  }
}

async function confirmFactoryImport() {
  if (!factoryPreview.value || factoryImporting.value) return

  try {
    await ElMessageBox.confirm(
      '将根据当前审核通过版本新增一个短剧项目。导入只写入现有生产包，不调用模型、不扣积分；相同版本不会重复创建。是否继续？',
      '确认导入短剧工厂',
      {
        type: 'warning',
        confirmButtonText: '确认导入',
        cancelButtonText: '取消',
      },
    )
  } catch {
    return
  }

  let result
  factoryImporting.value = true
  try {
    result = unwrap(await scriptAnalysisAPI.importToFactory(project.value.id, {
      version: activeVersion.value,
    }))
  } catch (error) {
    ElMessage.error(error?.message || '导入短剧工厂失败')
    return
  } finally {
    factoryImporting.value = false
  }

  if (!result?.drama_id) {
    ElMessage.error('导入结果缺少短剧项目 ID')
    return
  }

  factoryPreviewVisible.value = false
  ElMessage.success(result.created ? '已导入短剧工厂并打开项目' : '该版本已导入，已打开原项目')
  try {
    await router.push(`/film/${result.drama_id}`)
  } catch {
    ElMessage.warning('项目已导入，但自动跳转失败，请从短剧工厂打开')
  }
}

onMounted(async () => {
  await loadSkills()
  await listProjects()
  if (projects.value[0]?.id) await loadProject(projects.value[0].id)
})

onBeforeUnmount(stopPolling)
</script>

<style scoped>
.script-analysis-page {
  min-height: 100vh;
  color: #f6f2ee;
  background:
    radial-gradient(circle at 85% 10%, rgba(109, 58, 137, 0.25), transparent 33rem),
    radial-gradient(circle at 15% 35%, rgba(239, 116, 68, 0.1), transparent 28rem),
    #080808;
}

.script-analysis-shell {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 24px;
  width: min(1680px, calc(100% - 48px));
  margin: 0 auto;
  padding: 28px 0 80px;
}

.project-panel,
.source-card,
.task-card,
.overview-card,
.visual-direction-section,
.library-section,
.shots-section,
.review-section,
.empty-workbench {
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 24px;
  background: rgba(17, 17, 18, 0.92);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.18);
}

.project-panel {
  position: sticky;
  top: 96px;
  align-self: start;
  min-height: calc(100vh - 128px);
  padding: 20px;
}

.panel-heading,
.workspace-hero,
.section-title,
.shot-heading,
.task-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.panel-heading h2,
.section-title h2 {
  margin: 3px 0 0;
  font-size: 20px;
}

.eyebrow {
  margin: 0;
  color: #ef7444;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.new-button {
  color: #f6f2ee;
  border-color: rgba(255, 255, 255, 0.15);
  background: #202022;
}

.project-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}

.project-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 14px;
  color: #f6f2ee;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 14px;
  background: transparent;
  cursor: pointer;
}

.project-item:hover,
.project-item.active {
  border-color: rgba(239, 116, 68, 0.45);
  background: rgba(239, 116, 68, 0.1);
}

.project-item__title {
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-item__meta {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #8f8a88;
  font-size: 12px;
}

.project-item__meta i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #5f5b59;
}

.empty-projects,
.empty-results {
  padding: 32px 12px;
  color: #77716e;
  text-align: center;
}

.workspace {
  min-width: 0;
}

.workspace-hero {
  padding: 30px 8px 30px 4px;
}

.workspace-hero h1 {
  margin: 8px 0 10px;
  font-size: clamp(34px, 4vw, 64px);
  letter-spacing: -0.045em;
}

.hero-copy {
  max-width: 760px;
  margin: 0;
  color: #aaa39f;
  line-height: 1.8;
}

.hero-actions {
  display: flex;
  align-items: flex-end;
  flex-shrink: 0;
  gap: 10px;
}

.skill-select {
  display: flex;
  min-width: 220px;
  flex-direction: column;
  gap: 5px;
  color: #948d89;
  font-size: 11px;
}

.skill-select select {
  height: 44px;
  padding: 0 36px 0 14px;
  color: #f6f2ee;
  border: 1px solid rgba(239, 116, 68, 0.36);
  border-radius: 10px;
  outline: none;
  background: #171718;
}

.skill-select select:disabled {
  opacity: 0.55;
}

.hero-actions :deep(.el-button) {
  height: 44px;
  padding: 0 20px;
  color: #f6f2ee;
  border-color: rgba(255, 255, 255, 0.14);
  background: #171718;
}

.hero-actions .run-button {
  color: #140a06;
  border-color: #ef7444;
  background: #ef7444;
}

.source-card,
.overview-card,
.visual-direction-section,
.library-section,
.shots-section,
.review-section {
  margin-bottom: 18px;
  padding: 28px;
}

.section-title {
  margin-bottom: 24px;
}

.section-title > div {
  display: flex;
  align-items: center;
  gap: 12px;
}

.section-index {
  color: #ef7444;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.source-notice,
.version-chip {
  color: #948d89;
  font-size: 12px;
}

.source-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.8fr) minmax(260px, 0.8fr);
  gap: 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  color: #aaa39f;
  font-size: 13px;
}

.field input,
.field textarea {
  box-sizing: border-box;
  width: 100%;
  color: #f6f2ee;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  outline: none;
  background: #0c0c0d;
}

.field input {
  height: 44px;
  padding: 0 14px;
}

.field textarea {
  padding: 14px;
  line-height: 1.75;
  resize: vertical;
}

.field input:focus,
.field textarea:focus {
  border-color: rgba(239, 116, 68, 0.7);
}

.field--script,
.field--facts {
  grid-row: 2;
}

.task-card {
  margin-bottom: 18px;
  padding: 18px 22px;
}

.task-summary {
  justify-content: flex-start;
  margin-bottom: 12px;
}

.task-summary strong {
  font-size: 14px;
}

.task-summary p {
  margin: 4px 0 0;
  color: #8f8985;
  font-size: 12px;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #777;
}

.status-dot.running {
  background: #ef7444;
  box-shadow: 0 0 0 6px rgba(239, 116, 68, 0.12);
}

.status-dot.success {
  background: #4cc38a;
}

.status-dot.failed {
  background: #e25959;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.metrics article {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 15px;
  background: #0d0d0e;
}

.metrics strong {
  font-size: 28px;
}

.metrics span {
  color: #8f8985;
  font-size: 12px;
}

.story-overview {
  margin-top: 14px;
  padding: 22px;
  border-radius: 16px;
  background: linear-gradient(120deg, rgba(239, 116, 68, 0.12), rgba(91, 48, 118, 0.16));
}

.story-overview h3 {
  margin: 0 0 9px;
  font-size: 22px;
}

.story-overview p {
  margin: 0;
  color: #bbb4b0;
  line-height: 1.75;
}

.story-tags,
.shot-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.story-tags span,
.shot-meta span,
.shot-duration,
.card-kicker {
  padding: 5px 9px;
  color: #cfc7c2;
  font-size: 11px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
}

.visual-signal-grid,
.visual-motif-grid,
.visual-recommendations {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.visual-signal-card,
.visual-motif-card,
.visual-recommendation-card {
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  background: #0c0c0d;
}

.visual-signal-card h3,
.visual-motif-card h3,
.visual-recommendation-card h3 {
  margin: 12px 0 8px;
}

.visual-signal-card p,
.visual-motif-card p,
.visual-recommendation-card p,
.visual-recommendation-card dd {
  color: #9e9793;
  line-height: 1.65;
}

.evidence-list,
.visual-tag-list,
.visual-profile-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.evidence-list span,
.visual-tag-list span,
.visual-profile-row span {
  padding: 5px 9px;
  color: #cfc7c2;
  font-size: 11px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
}

.evidence-list span::before {
  content: '依据 · ';
  color: #ef7444;
}

.visual-profile-row {
  align-items: center;
  margin: 14px 0;
  padding: 14px 16px;
  border-radius: 14px;
  background: rgba(239, 116, 68, 0.07);
}

.visual-profile-row strong,
.recommendation-heading span {
  color: #ef7444;
  font-size: 11px;
}

.visual-motif-grid {
  margin-bottom: 12px;
}

.recommendation-heading h3 {
  margin-top: 5px;
}

.visual-recommendation-card dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 7px 12px;
  margin: 16px 0 0;
}

.visual-recommendation-card dt {
  color: #ef7444;
  font-size: 12px;
}

.visual-recommendation-card dd {
  margin: 0;
  font-size: 12px;
}

.visual-recommendation-card .recommendation-risk {
  margin-bottom: 0;
  color: #efb36f;
  font-size: 12px;
}

.analysis-tabs :deep(.el-tabs__item) {
  color: #8f8985;
}

.analysis-tabs :deep(.el-tabs__item.is-active) {
  color: #ef7444;
}

.analysis-tabs :deep(.el-tabs__active-bar) {
  background-color: #ef7444;
}

.analysis-tabs :deep(.el-tabs__nav-wrap::after) {
  background: rgba(255, 255, 255, 0.08);
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.bible-card {
  min-height: 160px;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  background: #0c0c0d;
}

.bible-card h3 {
  margin: 14px 0 8px;
}

.bible-card p,
.bible-card dd {
  color: #9e9793;
  line-height: 1.65;
}

.bible-card dl {
  margin: 14px 0 0;
}

.bible-card dt {
  margin-top: 8px;
  color: #d7cfca;
  font-size: 12px;
}

.bible-card dd {
  margin: 3px 0 0;
  font-size: 12px;
}

.shot-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.shot-card {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr);
  gap: 18px;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  background: #0c0c0d;
}

.shot-number {
  color: #ef7444;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 24px;
}

.shot-heading {
  align-items: flex-start;
}

.shot-heading span:not(.shot-duration) {
  color: #817b77;
  font-size: 11px;
}

.shot-heading h3 {
  margin: 5px 0 0;
  font-size: 17px;
}

.shot-description {
  margin: 13px 0 0;
  color: #aaa39f;
  line-height: 1.7;
}

.prompt-grid,
.review-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.prompt-grid > div,
.review-grid article {
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  background: #151516;
}

.prompt-grid strong,
.continuity-row strong {
  color: #ef7444;
  font-size: 11px;
}

.prompt-grid p {
  margin: 7px 0 0;
  color: #aaa39f;
  font-size: 12px;
  line-height: 1.65;
}

.continuity-row {
  display: flex;
  gap: 12px;
  margin-top: 13px;
  color: #8f8985;
  font-size: 12px;
}

.review-score {
  color: #efb36f;
  font-size: 12px;
}

.review-grid {
  margin-top: 0;
}

.review-grid h3 {
  margin: 0 0 12px;
  font-size: 15px;
}

.review-grid ul {
  margin: 0;
  padding-left: 18px;
  color: #a7a09c;
  line-height: 1.8;
}

.empty-workbench {
  padding: 70px 28px;
  text-align: center;
}

.empty-workbench span {
  color: rgba(239, 116, 68, 0.6);
  font-size: 12px;
  letter-spacing: 0.3em;
}

.empty-workbench h2 {
  margin: 18px 0 10px;
}

.empty-workbench p {
  margin: 0;
  color: #817b77;
}

.source-actions,
.version-tools,
.review-action-buttons {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.import-button {
  color: #f6f2ee;
  border-color: rgba(255, 255, 255, 0.14);
  background: #171718;
}

.version-select {
  height: 32px;
  padding: 0 34px 0 12px;
  color: #f6f2ee;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: #171718;
}

.review-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 20px;
  align-items: end;
  margin-top: 20px;
}

.revision-editor {
  margin-top: 18px;
  padding: 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  background: #0c0c0d;
}

.revision-editor__heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.revision-editor__heading p {
  margin: 6px 0 0;
  color: #85858d;
  font-size: 13px;
}

.review-action-buttons {
  justify-content: flex-end;
}

.history-note {
  margin: 8px 0 0;
  color: #8f8a88;
  font-size: 12px;
}

:global(.factory-preview-dialog) {
  color: #f6f2ee;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #171718;
}

:global(.factory-preview-dialog .el-dialog__title) {
  color: #f6f2ee;
}

.factory-preview > h3 {
  margin: 18px 0 8px;
  font-size: 22px;
}

.factory-preview > p,
.factory-preview__section p {
  color: #aaa39f;
  line-height: 1.7;
}

.factory-preview__source,
.factory-preview__counts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.factory-preview__source span,
.factory-preview__genre {
  padding: 5px 9px;
  color: #cfc7c2;
  font-size: 11px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
}

.factory-preview__counts {
  margin: 20px 0;
}

.factory-preview__counts article {
  display: flex;
  min-width: 82px;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  border-radius: 12px;
  background: #0d0d0e;
}

.factory-preview__counts article strong {
  font-size: 22px;
}

.factory-preview__counts article span {
  color: #8f8985;
  font-size: 12px;
}

.factory-preview__section {
  margin-top: 14px;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: #0d0d0e;
}

.factory-preview__section ul {
  margin: 9px 0 0;
  padding-left: 18px;
  color: #aaa39f;
  line-height: 1.7;
}

.factory-preview .factory-preview__boundary {
  margin: 18px 0 0;
  padding: 12px 14px;
  color: #efb36f;
  border-radius: 10px;
  background: rgba(239, 116, 68, 0.1);
}

@media (max-width: 1100px) {
  .script-analysis-shell {
    grid-template-columns: 1fr;
  }

  .project-panel {
    position: static;
    min-height: auto;
  }

  .project-list {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .card-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .script-analysis-shell {
    width: min(100% - 24px, 1680px);
    padding-top: 12px;
  }

  .workspace-hero {
    align-items: flex-start;
    flex-direction: column;
  }

  .source-grid,
  .metrics,
  .card-grid,
  .visual-signal-grid,
  .visual-motif-grid,
  .visual-recommendations,
  .prompt-grid,
  .review-grid,
  .project-list {
    grid-template-columns: 1fr;
  }

  .review-actions {
    grid-template-columns: 1fr;
  }

  .review-action-buttons {
    justify-content: flex-start;
  }

  .field--script,
  .field--facts {
    grid-row: auto;
  }

  .shot-card {
    grid-template-columns: 1fr;
  }

  .source-card,
  .overview-card,
  .visual-direction-section,
  .library-section,
  .shots-section,
  .review-section {
    padding: 20px;
  }
}
</style>
