<template>
  <div class="film-list">
    <PlatformHeader :show-theme="false">
      <template v-if="isCanvasMode" #leading>
        <div class="header-library">
          <el-button class="btn-library" @click="goMaterialLibrary('characters')">
            <el-icon><User /></el-icon>素材角色
          </el-button>
          <el-button class="btn-library" @click="goMaterialLibrary('scenes')">
            <el-icon><PictureFilled /></el-icon>素材场景
          </el-button>
          <el-button class="btn-library" @click="goMaterialLibrary('props')">
            <el-icon><Box /></el-icon>素材道具
          </el-button>
        </div>
      </template>
      <template v-if="isCanvasMode" #actions>
        <el-button class="btn-import" :loading="importing" @click="triggerImport">
          <el-icon><Upload /></el-icon>导入项目
        </el-button>
        <input ref="importFileInput" type="file" accept=".zip" style="display:none" @change="onImportFile" />
        <el-button type="primary" class="btn-new" @click="goNewProject">
          <el-icon><Plus /></el-icon>{{ isCanvasMode ? '新建画布' : '新建项目' }}
        </el-button>
      </template>
    </PlatformHeader>

    <main :class="['main', { 'main--home': !isCanvasMode }]">
      <section v-if="!isCanvasMode" class="home-workbench" aria-labelledby="home-workbench-title">
        <div class="home-workbench__glow home-workbench__glow--left" aria-hidden="true"></div>
        <div class="home-workbench__glow home-workbench__glow--right" aria-hidden="true"></div>
        <div class="home-workbench__inner">
          <p class="home-workbench__eyebrow">茉莉妈妈 AI 创作工作台</p>
          <h1 id="home-workbench-title">你好，今天想生成点什么？</h1>

          <section class="home-composer" aria-label="快速生成">
            <button
              class="home-composer__reference"
              type="button"
              :disabled="homeMediaType === 'text' || homeReferenceUploading"
              @click="triggerHomeReferenceUpload"
            >
              <img v-if="homeReferencePreview" :src="homeReferencePreview" alt="已上传的参考图" />
              <span v-else class="home-composer__plus">＋</span>
              <span v-if="homeReferenceUploading">上传中…</span>
              <span v-else-if="homeReferencePreview">点击更换参考图</span>
              <span v-else-if="homeMediaType === 'text'">文字无需参考图</span>
              <span v-else>上传参考图</span>
            </button>
            <input
              ref="homeReferenceInput"
              type="file"
              accept="image/*"
              hidden
              @change="onHomeReferenceChange"
            />
            <div class="home-composer__body">
              <textarea
                v-model="homePrompt"
                rows="3"
                aria-label="描述想生成的内容"
                :placeholder="homeMediaType === 'text'
                  ? '描述需要生成或改写的文字内容。'
                  : '输入生成要求，可上传一张参考图保持画面一致性。'"
              />
              <div class="home-composer__toolbar">
                <div class="home-composer__controls">
                  <label class="home-control">
                    <span class="home-control__icon">▣</span>
                    <select v-model="homeMediaType" aria-label="生成类型">
                      <option value="video">视频</option>
                      <option value="image">图片</option>
                      <option value="text">文字</option>
                    </select>
                  </label>
                  <label class="home-control">
                    <select v-model="homeModel" aria-label="生成模型">
                      <option v-if="!homeModelOptions.length" value="">暂无可用模型</option>
                      <option
                        v-for="item in homeModelOptions"
                        :key="item.model"
                        :value="item.model"
                      >
                        {{ item.display_name || item.model }}
                      </option>
                    </select>
                  </label>
                  <label v-if="homeMediaType !== 'text'" class="home-control">
                    <select v-model="homeAspectRatio" aria-label="画面比例">
                      <option value="16:9">16:9</option>
                      <option value="9:16">9:16</option>
                      <option value="1:1">1:1</option>
                      <option value="4:3">4:3</option>
                      <option value="3:4">3:4</option>
                      <option value="21:9">21:9</option>
                    </select>
                  </label>
                  <label v-if="homeMediaType === 'video'" class="home-control">
                    <select v-model.number="homeDuration" aria-label="视频时长">
                      <option :value="5">5s</option>
                      <option :value="10">10s</option>
                      <option :value="15">15s</option>
                    </select>
                  </label>
                  <label v-if="homeMediaType === 'video'" class="home-control">
                    <select v-model="homeResolution" aria-label="视频清晰度">
                      <option value="480p">480P</option>
                      <option value="720p">720P</option>
                      <option value="1080p">1080P</option>
                    </select>
                  </label>
                </div>
                <div class="home-composer__submit">
                  <span
                    class="home-composer__credits"
                    aria-label="预计消耗积分"
                    :class="{ 'is-insufficient': homeInsufficientCredits }"
                    :title="`预计消耗 ${homeSelectedPrice ?? '—'} 积分，可用积分 ${homeBalance}`"
                  >✦ {{ homeSelectedPrice ?? '—' }}</span>
                  <button
                    type="button"
                    class="home-generate"
                    :disabled="!homePrompt.trim() || !homeModel || homeSelectedPrice == null || homeInsufficientCredits || homeReferenceUploading"
                    @click="startFromComposer"
                  >
                    <span>✦</span>生成
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section class="home-recent" aria-labelledby="home-recent-title">
            <div class="home-recent__heading">
              <h2 id="home-recent-title">最近项目</h2>
              <button type="button" @click="scrollToProjects">所有项目 <span>→</span></button>
            </div>
            <div ref="homeProjectsRef" v-loading="loading" class="home-project-grid">
              <button class="home-project-card home-project-card--create" type="button" @click="goNewProject">
                <span class="home-project-card__create-icon">＋</span>
                <strong>创建新项目</strong>
                <small>从灵感开始新的短剧</small>
              </button>
              <article
                v-for="d in dramas.slice(0, 4)"
                :key="d.id"
                class="home-project-card"
                role="button"
                tabindex="0"
                @click="openProject(d.id)"
                @keydown.enter="openProject(d.id)"
                @keydown.space.prevent="openProject(d.id)"
              >
                <div class="home-project-card__cover">
                  <span>{{ (d.title || '未命名项目').slice(0, 1) }}</span>
                </div>
                <div class="home-project-card__copy">
                  <strong>{{ d.title || '未命名项目' }}</strong>
                  <small>{{ formatDate(d.updated_at) }} · {{ d.episodes?.length || 0 }} 集</small>
                </div>
              </article>
            </div>
          </section>
        </div>
      </section>

      <section v-else class="workspace-heading" aria-labelledby="workspace-heading-title">
        <span class="workspace-heading__eyebrow">AI 原生创作工作区</span>
        <div class="workspace-heading__row">
          <div>
            <h1 id="workspace-heading-title">
              {{ isCanvasMode ? '一块自由画布，承载完整创作过程' : '从剧本到成片，全程不换工具' }}
            </h1>
            <p>
              {{ isCanvasMode
                ? '自由组织文本、图片、视频与音频节点，连接灵感并直接调用真实模型。'
                : '统一管理剧本、角色、场景、分镜、音色与视频生成。' }}
            </p>
          </div>
          <el-button type="primary" size="large" class="workspace-heading__action" @click="goNewProject">
            <el-icon><Plus /></el-icon>{{ isCanvasMode ? '新建画布' : '新建短剧' }}
          </el-button>
        </div>
      </section>

      <section v-if="isCanvasMode" class="canvas-project-toolbar" aria-label="画布项目搜索与筛选">
        <el-input
          v-model="searchKeyword"
          class="canvas-project-search"
          clearable
          :prefix-icon="Search"
          placeholder="搜索画布名称或描述"
          aria-label="搜索画布项目"
          @keyup.enter="loadList"
          @clear="loadList"
        />
        <el-button type="primary" plain @click="loadList">搜索</el-button>
        <el-select
          v-model="selectedFolderId"
          class="canvas-project-filter"
          aria-label="按文件夹筛选画布项目"
          @change="loadList"
        >
          <el-option label="全部文件夹" value="" />
          <el-option label="未分类" value="unfiled" />
          <el-option
            v-for="folder in projectFolders"
            :key="folder.id"
            :label="`${folder.name}（${folder.project_count || 0}）`"
            :value="String(folder.id)"
          />
        </el-select>
        <el-select
          v-model="projectSort"
          class="canvas-project-sort"
          aria-label="画布项目排序"
          @change="loadList"
        >
          <el-option label="最近更新" value="updated_desc" />
          <el-option label="最近创建" value="created_desc" />
          <el-option label="名称排序" value="title_asc" />
        </el-select>
        <el-button :icon="FolderOpened" @click="openFolderDialog">管理文件夹</el-button>
        <span class="canvas-project-count" aria-live="polite">共 {{ total }} 个画布</span>
      </section>
      <div v-if="isCanvasMode" v-loading="loading" class="projects-wrap">
        <div class="project-grid">
          <!-- 操作卡片：始终作为第一个格子 -->
          <div class="project-card action-card">
            <div class="action-card-inner">
              <h3 class="action-card-title">快速开始</h3>
              <div class="action-card-buttons">
                <el-button type="primary" size="large" class="action-btn action-btn-new" @click="goNewProject">
                  <el-icon><Plus /></el-icon>{{ isCanvasMode ? '新建画布项目' : '新建短剧项目' }}
                </el-button>
                <el-button v-if="!isCanvasMode" size="large" class="action-btn action-btn-import" :loading="importing" @click="triggerImport">
                  <el-icon><Upload /></el-icon>导入短剧项目
                </el-button>
              </div>
              <div v-if="!isCanvasMode && exampleList.length > 0" class="action-card-example">
                <div class="example-hint">
                  <el-icon class="example-hint-icon"><QuestionFilled /></el-icon>
                  <span class="example-hint-text">新手？试试导入示例项目快速体验</span>
                </div>
                <div class="example-list">
                  <el-button
                    v-for="ex in exampleList"
                    :key="ex.filename"
                    size="small"
                    class="example-btn"
                    :loading="importingExample === ex.filename"
                    @click="onImportExample(ex)"
                  >
                    <el-icon><FolderOpened /></el-icon>{{ ex.name }}
                  </el-button>
                </div>
              </div>
            </div>
          </div>
          <div
            v-for="d in dramas"
            :key="d.id"
            class="project-card"
            role="button"
            tabindex="0"
            :aria-label="`${isCanvasMode ? '打开画布' : '打开项目详情'}：${d.title || '未命名项目'}`"
            @click="openProject(d.id)"
            @keydown.enter="openProject(d.id)"
            @keydown.space.prevent="openProject(d.id)"
          >
            <div class="project-card-actions" @click.stop>
              <el-button
                v-if="isCanvasMode"
                size="small"
                circle
                :icon="CopyDocument"
                title="复制画布项目"
                aria-label="复制画布项目"
                :loading="duplicatingId === d.id"
                @click="onDuplicate(d)"
              />
              <el-dropdown
                v-if="isCanvasMode"
                trigger="click"
                @command="(folderId) => moveProjectToFolder(d, folderId)"
              >
                <el-button
                  size="small"
                  circle
                  :icon="FolderOpened"
                  title="移动画布项目"
                  aria-label="移动画布项目"
                  :loading="movingProjectId === d.id"
                />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="unfiled">未分类</el-dropdown-item>
                    <el-dropdown-item
                      v-for="folder in projectFolders"
                      :key="folder.id"
                      :command="String(folder.id)"
                    >
                      {{ folder.name }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button size="small" circle :icon="Download" title="导出项目" :loading="exportingId === d.id" @click="onExport(d)" />
              <el-button size="small" circle :icon="Edit" title="编辑" @click="openEditDialog(d)" />
              <el-button size="small" type="danger" plain circle :icon="Delete" title="删除" @click="onDelete(d)" />
            </div>
            <div class="project-card-body">
              <h3 class="project-title">{{ d.title || '未命名项目' }}</h3>
              <p class="project-desc">{{ d.description || '暂无描述' }}</p>
              <div class="project-badges">
                <span class="badge badge-status" :class="'badge-status--' + (d.status || 'draft')">{{ formatStatus(d.status) }}</span>
                <span v-if="d.episodes?.length" class="badge badge-episodes">{{ d.episodes.length }} 集</span>
                <span v-if="totalStoryboards(d) > 0" class="badge badge-storyboards">{{ totalStoryboards(d) }} 分镜</span>
                <span v-if="d.metadata?.aspect_ratio" class="badge badge-ratio">{{ d.metadata.aspect_ratio }}</span>
                <span v-if="isCanvasMode && folderName(d.folder_id)" class="badge badge-folder">{{ folderName(d.folder_id) }}</span>
                <span v-if="d.style" class="badge badge-style">{{ formatStyle(d.style) }}</span>
                <span v-if="d.genre" class="badge badge-genre">{{ formatGenre(d.genre) }}</span>
              </div>
              <div class="project-card-footer">
                <p class="project-meta">{{ formatDate(d.updated_at) }}</p>
                <el-button size="small" type="primary" plain class="project-open-canvas" @click.stop="openCanvas(d.id)">
                  <el-icon><Grid /></el-icon>
                  {{ isCanvasMode ? '进入画布' : '打开画布' }}
                </el-button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- 新建项目：先填标题和描述 -->
    <el-dialog
      v-model="showNewDialog"
      class="project-dialog"
      :title="isCanvasMode ? '新建画布项目' : '新建项目'"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetNewForm"
    >
      <el-form :model="newForm" label-width="80px" label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="newForm.title" placeholder="输入项目标题" maxlength="100" show-word-limit />
        </el-form-item>
        <el-form-item v-if="!isCanvasMode" label="描述">
          <el-input v-model="newForm.description" type="textarea" :rows="3" placeholder="输入项目描述（选填）" />
        </el-form-item>
        <el-form-item v-if="!isCanvasMode" label="画面比例">
          <el-select v-model="newForm.aspect_ratio" style="width: 100%">
            <el-option label="16:9 横屏（默认）" value="16:9" />
            <el-option label="9:16 竖屏（短视频）" value="9:16" />
            <el-option label="3:4 竖版" value="3:4" />
            <el-option label="1:1 方形" value="1:1" />
            <el-option label="4:3 传统横屏" value="4:3" />
            <el-option label="21:9 宽银幕" value="21:9" />
          </el-select>
          <p style="margin: 4px 0 0; font-size: 12px; color: #71717a;">影响分镜图和视频的生成比例，短视频选 9:16</p>
        </el-form-item>
        <el-form-item v-if="isCanvasMode" label="文件夹">
          <el-select v-model="newForm.folder_id" style="width: 100%">
            <el-option label="未分类" value="" />
            <el-option v-for="folder in projectFolders" :key="folder.id" :label="folder.name" :value="folder.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showNewDialog = false">取消</el-button>
        <el-button type="primary" :loading="newSaving" :disabled="!newForm.title?.trim()" @click="submitNew">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="showFolderDialog"
      title="管理画布文件夹"
      width="480px"
      :close-on-click-modal="false"
    >
      <div class="folder-create-row">
        <el-input
          v-model="newFolderName"
          maxlength="50"
          placeholder="输入文件夹名称"
          aria-label="新文件夹名称"
          @keyup.enter="createProjectFolder"
        />
        <el-button type="primary" :loading="folderSaving" :disabled="!newFolderName.trim()" @click="createProjectFolder">
          新建
        </el-button>
      </div>
      <div class="folder-list">
        <div v-for="folder in projectFolders" :key="folder.id" class="folder-list-item">
          <div class="folder-list-label">
            <el-icon><FolderOpened /></el-icon>
            <span>{{ folder.name }}</span>
            <small>{{ folder.project_count || 0 }} 个画布</small>
          </div>
          <div>
            <el-button text @click="renameProjectFolder(folder)">重命名</el-button>
            <el-button text type="danger" @click="deleteProjectFolder(folder)">删除</el-button>
          </div>
        </div>
        <el-empty v-if="projectFolders.length === 0" :image-size="64" description="暂无文件夹" />
      </div>
    </el-dialog>

    <!-- 编辑项目：修改标题和故事 -->
    <el-dialog
      v-model="showEditDialog"
      class="project-dialog"
      title="编辑项目"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetEditForm"
    >
      <el-form :model="editForm" label-width="80px" label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="editForm.title" placeholder="输入项目标题" maxlength="100" show-word-limit />
        </el-form-item>
        <el-form-item label="故事">
          <el-input v-model="editForm.description" type="textarea" :rows="3" placeholder="输入故事梗概（选填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" :disabled="!editForm.title?.trim()" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Edit, Delete, Plus, User, PictureFilled, Box, Download, Upload, QuestionFilled, FolderOpened, Grid, CopyDocument, Search } from '@element-plus/icons-vue'
import PlatformHeader from '@/components/PlatformHeader.vue'
import { dramaAPI } from '@/api/drama'
import { listGenerationCatalog } from '@/api/billing'
import { getCreditAccount } from '@/api/auth'
import { uploadAPI } from '@/api/upload'
import {
  estimateGenerationCredits,
  normalizeQuickGenerationDraft,
} from '@/utils/homeQuickGeneration'
import {
  normalizeProjectMode,
  projectCanvasPath,
  projectMetadata,
  projectOpenPath,
} from '@/utils/projectMode'

const router = useRouter()
const props = defineProps({
  projectMode: { type: String, default: 'factory' },
})
const projectMode = computed(() => normalizeProjectMode(props.projectMode))
const isCanvasMode = computed(() => projectMode.value === 'canvas')

const loading = ref(false)
const dramas = ref([])
const total = ref(0)
const homePrompt = ref('')
const homeMediaType = ref('video')
const homeModel = ref('')
const homeAspectRatio = ref('16:9')
const homeDuration = ref(5)
const homeResolution = ref('720p')
const homeGenerationCatalog = ref([])
const homeBalance = ref(0)
const homeReferenceInput = ref(null)
const homeReferencePreview = ref('')
const homeReferenceImageUrl = ref('')
const homeReferenceUploading = ref(false)
const homeProjectsRef = ref(null)
const searchKeyword = ref('')
const projectFolders = ref([])
const selectedFolderId = ref('')
const projectSort = ref('updated_desc')
const showFolderDialog = ref(false)
const newFolderName = ref('')
const folderSaving = ref(false)
const movingProjectId = ref(null)

function goMaterialLibrary(type) {
  router.push({ name: `material-${type}` })
}

const homeModelOptions = computed(() => {
  return homeGenerationCatalog.value.filter((item) => item.category === homeMediaType.value)
})

const homeSelectedModel = computed(() => (
  homeModelOptions.value.find((item) => item.model === homeModel.value) || null
))
const homeSelectedPrice = computed(() => estimateGenerationCredits(
  homeSelectedModel.value,
  { duration: homeDuration.value, resolution: homeResolution.value },
))
const homeInsufficientCredits = computed(() => (
  homeSelectedPrice.value != null && homeBalance.value < homeSelectedPrice.value
))

function triggerHomeReferenceUpload() {
  if (homeMediaType.value === 'text' || homeReferenceUploading.value) return
  homeReferenceInput.value?.click()
}

async function onHomeReferenceChange(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('参考内容目前只支持图片文件')
    return
  }
  homeReferenceUploading.value = true
  try {
    const uploaded = await uploadAPI.uploadImage(file)
    const localPath = String(uploaded?.local_path || '').replace(/^\/+/, '')
    if (!localPath) throw new Error('上传结果缺少文件路径')
    homeReferenceImageUrl.value = `/static/${localPath}`
    homeReferencePreview.value = uploaded?.url || homeReferenceImageUrl.value
  } catch (error) {
    homeReferenceImageUrl.value = ''
    homeReferencePreview.value = ''
    ElMessage.error(error?.message || '参考图上传失败')
  } finally {
    homeReferenceUploading.value = false
  }
}

async function loadHomeGenerationConfig() {
  const [catalog, account] = await Promise.allSettled([
    listGenerationCatalog(),
    getCreditAccount(),
  ])
  homeGenerationCatalog.value = catalog.status === 'fulfilled' && Array.isArray(catalog.value)
    ? catalog.value
    : []
  homeBalance.value = account.status === 'fulfilled' ? Number(account.value?.available || 0) : 0
  homeModel.value = homeModelOptions.value[0]?.model || ''
}

function startFromComposer() {
  if (!homePrompt.value.trim()) {
    ElMessage.warning('请先输入生成要求')
    return
  }
  if (!homeModel.value) {
    ElMessage.warning('当前没有管理员已启用并配置计费的模型')
    return
  }
  if (homeSelectedPrice.value == null) {
    ElMessage.warning('当前模型尚未完成计费配置')
    return
  }
  if (homeInsufficientCredits.value) {
    ElMessage.warning(`积分不足：需要 ${homeSelectedPrice.value}，当前可用 ${homeBalance.value}`)
    return
  }
  const draft = normalizeQuickGenerationDraft({
    mode: homeMediaType.value,
    prompt: homePrompt.value.trim(),
    model: homeModel.value,
    aspectRatio: homeAspectRatio.value,
    duration: homeDuration.value,
    resolution: homeResolution.value,
    referenceImageUrl: homeMediaType.value === 'text' ? '' : homeReferenceImageUrl.value,
    autoStart: true,
  })
  sessionStorage.setItem('moli_quick_create_draft', JSON.stringify(draft))
  router.push({ name: 'free-create', query: { mode: homeMediaType.value, source: 'home' } })
}

function scrollToProjects() {
  homeProjectsRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const showNewDialog = ref(false)
const newForm = ref({ title: '', description: '', aspect_ratio: '16:9', folder_id: '' })
const newSaving = ref(false)
const exportingId = ref(null)
const duplicatingId = ref(null)
const importing = ref(false)
const importFileInput = ref(null)

const exampleList = ref([])
const importingExample = ref(null)

function loadExamples() {
  dramaAPI.listExamples()
    .then(res => { exampleList.value = Array.isArray(res) ? res : (res?.data ?? []) })
    .catch(() => { exampleList.value = [] })
}

async function onImportExample(ex) {
  importingExample.value = ex.filename
  try {
    const data = await dramaAPI.importExample(ex.filename)
    ElMessage.success(`示例导入成功：${data?.title || ex.name}`)
    loadList()
  } catch (e) {
    const msg = e.response?.data?.message || e.message || '导入失败'
    ElMessage.error(msg)
  } finally {
    importingExample.value = null
  }
}

const showEditDialog = ref(false)
const editForm = ref({ id: null, title: '', description: '' })
const editSaving = ref(false)

function loadList() {
  loading.value = true
  return dramaAPI
    .list({
      page: 1,
      page_size: 50,
      project_type: projectMode.value,
      keyword: searchKeyword.value.trim(),
      folder_id: selectedFolderId.value,
      sort: projectSort.value,
    })
    .then((res) => {
      dramas.value = res?.items ?? []
      total.value = res?.pagination?.total ?? 0
    })
    .catch(() => {
      dramas.value = []
    })
    .finally(() => {
      loading.value = false
    })
}

async function loadProjectFolders() {
  if (!isCanvasMode.value) {
    projectFolders.value = []
    return
  }
  try {
    const res = await dramaAPI.listFolders({ project_type: projectMode.value })
    projectFolders.value = res?.items ?? res ?? []
  } catch (e) {
    projectFolders.value = []
    ElMessage.error(e.message || '文件夹加载失败')
  }
}

function openFolderDialog() {
  showFolderDialog.value = true
  loadProjectFolders()
}

async function createProjectFolder() {
  const name = newFolderName.value.trim()
  if (!name) return
  folderSaving.value = true
  try {
    await dramaAPI.createFolder(name)
    newFolderName.value = ''
    await loadProjectFolders()
    ElMessage.success('文件夹已创建')
  } catch (e) {
    ElMessage.error(e.message || '文件夹创建失败')
  } finally {
    folderSaving.value = false
  }
}

async function renameProjectFolder(folder) {
  let value
  try {
    ({ value } = await ElMessageBox.prompt('输入新的文件夹名称', '重命名文件夹', {
      inputValue: folder.name,
      inputPattern: /\S+/,
      inputErrorMessage: '文件夹名称不能为空',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    }))
  } catch {
    return
  }
  try {
    await dramaAPI.renameFolder(folder.id, value.trim())
    await loadProjectFolders()
    ElMessage.success('文件夹已重命名')
  } catch (e) {
    ElMessage.error(e.message || '重命名失败')
  }
}

async function deleteProjectFolder(folder) {
  try {
    await ElMessageBox.confirm(
      `删除文件夹「${folder.name}」？其中的画布会保留并移到“未分类”。`,
      '删除文件夹',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await dramaAPI.deleteFolder(folder.id)
    if (selectedFolderId.value === String(folder.id)) selectedFolderId.value = ''
    await Promise.all([loadProjectFolders(), loadList()])
    ElMessage.success('文件夹已删除，画布已移到未分类')
  } catch (e) {
    ElMessage.error(e.message || '文件夹删除失败')
  }
}

async function moveProjectToFolder(d, folderId) {
  movingProjectId.value = d.id
  try {
    await dramaAPI.update(d.id, { folder_id: folderId === 'unfiled' ? null : Number(folderId) })
    await Promise.all([loadProjectFolders(), loadList()])
    ElMessage.success(folderId === 'unfiled' ? '已移到未分类' : '画布已移动')
  } catch (e) {
    ElMessage.error(e.message || '移动失败')
  } finally {
    movingProjectId.value = null
  }
}

function folderName(folderId) {
  if (folderId == null) return ''
  return projectFolders.value.find(folder => Number(folder.id) === Number(folderId))?.name || ''
}

function formatDate(val) {
  if (!val) return ''
  const d = new Date(val)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatStatus(status) {
  const map = { draft: '草稿', published: '已发布', archived: '已归档', generating: '生成中' }
  return map[status] || status || '草稿'
}

function formatStyle(style) {
  const map = {
    // 写实 / 影视
    realistic: '写实',
    cinematic: '电影感',
    documentary: '纪录片',
    noir: '黑色电影',
    'retro film': '复古胶片',
    horror: '恐怖',
    // 动漫 / 卡通
    'anime style': '日本动漫',
    anime: '日本动漫',
    'comic style': '欧美漫画',
    cartoon: '卡通',
    // 中国风格
    'ink wash': '国画水墨',
    'chinese style': '中国风',
    historical: '古装',
    wuxia: '武侠',
    // 绘画艺术
    watercolor: '水彩',
    'oil painting': '油画',
    sketch: '素描',
    'woodblock print': '版画',
    impressionist: '印象派',
    // 幻想 / 科幻
    fantasy: '奇幻',
    'dark fantasy': '暗黑奇幻',
    'sci-fi': '科幻',
    sci_fi: '科幻',
    cyberpunk: '赛博朋克',
    steampunk: '蒸汽朋克',
    'post-apocalyptic': '末世废土',
    // 数字 / 现代
    '3d render': '3D渲染',
    'pixel art': '像素风',
    'low poly': '低多边形',
    minimalist: '极简',
    dreamy: '唯美梦幻',
  }
  return map[style] || style
}

function formatGenre(genre) {
  const map = { drama: '剧情', comedy: '喜剧', adventure: '冒险', romance: '爱情', thriller: '悬疑', action: '动作', horror: '恐怖' }
  return map[genre] || genre
}

function totalStoryboards(d) {
  return (d.episodes || []).reduce((sum, ep) => sum + (ep.storyboards?.length || 0), 0)
}

function goNewProject() {
  newForm.value.folder_id = /^\d+$/.test(selectedFolderId.value) ? Number(selectedFolderId.value) : ''
  showNewDialog.value = true
}

function openCanvas(id) {
  router.push(projectCanvasPath(id, projectMode.value))
}

function resetNewForm() {
  newForm.value = { title: '', description: '', aspect_ratio: '16:9', folder_id: '' }
}

async function submitNew() {
  const title = newForm.value.title?.trim()
  if (!title) return
  newSaving.value = true
  try {
    const drama = await dramaAPI.create({
      title,
      description: isCanvasMode.value ? undefined : newForm.value.description?.trim() || undefined,
      folder_id: newForm.value.folder_id === '' ? null : newForm.value.folder_id,
      metadata: {
        ...projectMetadata(newForm.value.aspect_ratio, projectMode.value),
      },
    })
    showNewDialog.value = false
    ElMessage.success('项目已创建')
    loadList()
    router.push(isCanvasMode.value ? projectCanvasPath(drama.id, projectMode.value) : `/film/${drama.id}`)
  } catch (e) {
    ElMessage.error(e.message || '创建失败')
  } finally {
    newSaving.value = false
  }
}

function openEditDialog(d) {
  editForm.value = { id: d.id, title: d.title || '', description: d.description || '' }
  showEditDialog.value = true
}

function resetEditForm() {
  editForm.value = { id: null, title: '', description: '' }
}

async function submitEdit() {
  const title = editForm.value.title?.trim()
  if (!title || editForm.value.id == null) return
  editSaving.value = true
  try {
    await dramaAPI.update(editForm.value.id, { title, description: editForm.value.description?.trim() || undefined })
    showEditDialog.value = false
    ElMessage.success('已保存')
    loadList()
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    editSaving.value = false
  }
}

function openProject(id) {
  router.push(projectOpenPath(id, projectMode.value))
}

function onExport(d) {
  if (exportingId.value) return
  exportingId.value = d.id
  try {
    // 大 ZIP 用浏览器原生下载，避免 axios blob 经 dev proxy 整包缓冲导致 ERR_FAILED
    const a = document.createElement('a')
    a.href = `/api/v1/dramas/${d.id}/export`
    a.download = `${d.title || 'drama'}.zip`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    ElMessage.success('开始下载')
  } catch (e) {
    ElMessage.error(e.message || '导出失败')
  } finally {
    exportingId.value = null
  }
}

async function onDuplicate(d) {
  if (duplicatingId.value != null) return
  duplicatingId.value = d.id
  try {
    const copy = await dramaAPI.duplicate(d.id)
    ElMessage.success(`已复制：${copy?.title || `${d.title || '画布'} 副本`}`)
    await loadList()
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message || '复制失败')
  } finally {
    duplicatingId.value = null
  }
}

function triggerImport() {
  importFileInput.value?.click()
}

async function onImportFile(e) {
  const file = e.target.files?.[0]
  if (!file) return
  e.target.value = ''
  if (!file.name.endsWith('.zip')) {
    ElMessage.error('请选择 .zip 格式的文件')
    return
  }
  importing.value = true
  try {
    const data = await dramaAPI.importDrama(file)
    ElMessage.success(`导入成功：${data?.title || '项目'}`) 
    loadList()
  } catch (e) {
    const msg = e.response?.data?.message || e.message || '导入失败'
    ElMessage.error(msg)
  } finally {
    importing.value = false
  }
}

async function onDelete(d) {
  try {
    await ElMessageBox.confirm(
      `确定要删除项目「${(d.title || '未命名').slice(0, 20)}${(d.title && d.title.length > 20) ? '…' : ''}」吗？此操作不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await dramaAPI.delete(d.id)
    ElMessage.success('已删除')
    loadList()
  } catch (e) {
    ElMessage.error(e.message || '删除失败')
  }
}

onMounted(() => {
  loadList()
  if (isCanvasMode.value) loadProjectFolders()
  else {
    loadExamples()
    loadHomeGenerationConfig()
  }
})

watch(projectMode, () => {
  searchKeyword.value = ''
  selectedFolderId.value = ''
  projectSort.value = 'updated_desc'
  loadList()
  if (!isCanvasMode.value) loadExamples()
  else {
    exampleList.value = []
    loadProjectFolders()
  }
})

watch(homeMediaType, () => {
  homeModel.value = homeModelOptions.value[0]?.model || ''
})
</script>

<style scoped>
.film-list {
  min-height: 100vh;
  background: #080808;
  color: #e4e4e7;
  background-image:
    radial-gradient(ellipse 60% 36% at 50% -10%, rgba(255, 113, 57, 0.12) 0%, transparent 72%),
    linear-gradient(rgba(255, 255, 255, .018) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, .018) 1px, transparent 1px);
  background-size: auto, 40px 40px, 40px 40px;
}
.header {
  background: rgba(12, 12, 18, 0.82);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(99, 102, 241, 0.18);
  padding: 12px 24px;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: 0 1px 0 rgba(99, 102, 241, 0.08), 0 4px 24px rgba(0, 0, 0, 0.3);
}
.header-inner {
  max-width: min(1400px, 96vw);
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.logo {
  margin: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  line-height: 1;
}
.brand-logo { width: 42px; height: 42px; object-fit: cover; border-radius: 12px; flex: 0 0 auto; }
.brand-copy { display: flex; flex-direction: column; gap: 3px; }
.logo-main {
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, #a5b4fc 0%, #c084fc 50%, #f0abfc 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 10px rgba(168, 85, 247, 0.35));
}
.logo-sub {
  font-size: 0.68rem;
  font-weight: 400;
  letter-spacing: 0.02em;
  color: #6d6d7a;
  -webkit-text-fill-color: #6d6d7a;
  filter: none;
}
.page-title {
  color: #a1a1aa;
  font-size: 0.95rem;
}
.header-library {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 20px;
}
.header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 资源库按钮 */
.btn-library {
  --el-button-bg-color: #141414;
  --el-button-border-color: #2b2b2b;
  --el-button-text-color: #b8b8b8;
  --el-button-hover-bg-color: rgba(255, 113, 57, 0.12);
  --el-button-hover-border-color: rgba(255, 113, 57, 0.55);
  --el-button-hover-text-color: #ff9a72;
  --el-button-active-bg-color: rgba(255, 113, 57, 0.2);
  --el-button-active-border-color: rgba(255, 113, 57, 0.75);
}
html.light .btn-library {
  --el-button-bg-color: #141414;
  --el-button-border-color: #2b2b2b;
  --el-button-text-color: #b8b8b8;
  --el-button-hover-bg-color: rgba(255, 113, 57, 0.12);
  --el-button-hover-border-color: rgba(255, 113, 57, 0.55);
  --el-button-hover-text-color: #ff9a72;
  --el-button-active-bg-color: rgba(255, 113, 57, 0.2);
  --el-button-active-border-color: rgba(255, 113, 57, 0.75);
}

/* 主题切换按钮 */
.btn-theme {
  --el-button-bg-color: rgba(148, 163, 184, 0.1);
  --el-button-border-color: rgba(148, 163, 184, 0.3);
  --el-button-text-color: #94a3b8;
  --el-button-hover-bg-color: rgba(148, 163, 184, 0.2);
  --el-button-hover-border-color: rgba(148, 163, 184, 0.5);
  --el-button-hover-text-color: #cbd5e1;
  transition: all 0.2s;
}
html.light .btn-theme {
  --el-button-bg-color: #141414;
  --el-button-border-color: #2b2b2b;
  --el-button-text-color: #a3a3a3;
  --el-button-hover-bg-color: rgba(255, 113, 57, 0.12);
  --el-button-hover-border-color: rgba(255, 113, 57, 0.5);
  --el-button-hover-text-color: #ff9a72;
}

/* 导入按钮 */
.btn-import,
html.light .btn-import {
  --el-button-bg-color: #141414;
  --el-button-border-color: #2b2b2b;
  --el-button-text-color: #b8b8b8;
  --el-button-hover-bg-color: rgba(255, 113, 57, 0.12);
  --el-button-hover-border-color: rgba(255, 113, 57, 0.55);
  --el-button-hover-text-color: #ff9a72;
}

.main {
  max-width: min(1500px, calc(100vw - 56px));
  margin: 0 auto;
  padding: 58px 0 72px;
}
.main--home {
  max-width: none;
  padding: 0;
}
.home-workbench {
  position: relative;
  min-height: calc(100vh - 72px);
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 38%, rgba(12, 9, 20, .08) 0 17%, rgba(5, 5, 8, .72) 52%, rgba(5, 5, 8, .96) 76%),
    linear-gradient(112deg, #2d0d4c 0%, #0a0811 26%, #07070a 58%, #27125b 100%);
}
.home-workbench::before,
.home-workbench::after {
  content: "";
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}
.home-workbench::before {
  width: 620px;
  height: 620px;
  right: -185px;
  top: 150px;
  border: 1px solid rgba(199, 171, 255, .12);
  background: radial-gradient(circle at 40% 35%, rgba(133, 93, 231, .24), rgba(71, 38, 143, .22) 42%, rgba(20, 10, 42, .08) 67%, transparent 70%);
  box-shadow: inset 42px 0 90px rgba(150, 106, 255, .15), 0 0 110px rgba(106, 63, 211, .12);
}
.home-workbench::after {
  width: 340px;
  height: 340px;
  left: -120px;
  bottom: -135px;
  background: radial-gradient(circle at 60% 40%, rgba(129, 84, 232, .38), rgba(59, 30, 123, .12) 58%, transparent 70%);
}
.home-workbench__glow {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #ffe09c;
  box-shadow: 0 0 18px 6px rgba(255, 208, 112, .48);
  pointer-events: none;
}
.home-workbench__glow--left {
  left: 10%;
  bottom: 16%;
}
.home-workbench__glow--right {
  right: 10%;
  top: 39%;
}
.home-workbench__inner {
  position: relative;
  z-index: 1;
  width: min(1460px, calc(100vw - 64px));
  margin: 0 auto;
  padding: 104px 0 90px;
}
.home-workbench__eyebrow {
  margin: 0 0 14px;
  text-align: center;
  color: rgba(232, 220, 255, .62);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .18em;
}
.home-workbench h1 {
  margin: 0;
  color: #fff;
  font-size: clamp(48px, 5.4vw, 78px);
  font-weight: 750;
  letter-spacing: -.055em;
  line-height: 1.08;
  text-align: center;
  text-shadow: 0 18px 55px rgba(0, 0, 0, .48);
}
.home-composer {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr);
  gap: 22px;
  width: min(1220px, 100%);
  min-height: 188px;
  margin: 72px auto 0;
  padding: 24px;
  border: 1px solid rgba(255, 255, 255, .09);
  border-radius: 24px;
  background: rgba(12, 12, 15, .96);
  box-shadow: 0 34px 72px rgba(0, 0, 0, .48), 0 0 0 1px rgba(0, 0, 0, .34);
}
.home-composer__reference {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 136px;
  border: 1px dashed #47474c;
  border-radius: 17px;
  color: #8d8d94;
  background: #111114;
  cursor: pointer;
  transition: border-color .2s, color .2s, background .2s;
}
.home-composer__reference:hover,
.home-composer__reference:focus-visible {
  outline: none;
  border-color: #ff7139;
  color: #ff9a72;
  background: rgba(255, 113, 57, .07);
}
.home-composer__reference:disabled {
  cursor: default;
  border-color: #303034;
  color: #66666d;
  background: #101012;
}
.home-composer__reference img {
  width: 72px;
  height: 72px;
  border-radius: 12px;
  object-fit: cover;
}
.home-composer__plus {
  color: #b4b4ba;
  font-size: 32px;
  font-weight: 300;
  line-height: 1;
}
.home-composer__body {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.home-composer textarea {
  width: 100%;
  min-height: 90px;
  padding: 2px 0 12px;
  resize: none;
  border: 0;
  outline: 0;
  color: #f2f2f3;
  background: transparent;
  font: inherit;
  font-size: 18px;
  line-height: 1.6;
}
.home-composer textarea::placeholder {
  color: #68686f;
}
.home-composer__toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-top: auto;
}
.home-composer__controls,
.home-composer__submit {
  display: flex;
  align-items: center;
  gap: 10px;
}
.home-control,
.home-composer__credits {
  display: inline-flex;
  min-height: 46px;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border: 1px solid #333338;
  border-radius: 13px;
  color: #dedee1;
  background: #19191d;
  font-size: 14px;
  white-space: nowrap;
}
.home-control select {
  max-width: 190px;
  border: 0;
  outline: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.home-control select option {
  color: #e8e8e8;
  background: #18181b;
}
.home-control__icon {
  color: #ff7139;
}
.home-control--static {
  color: #bbb;
}
.home-composer__credits {
  min-height: 44px;
  border-color: rgba(255, 165, 43, .48);
  color: #ffb34b;
  background: rgba(140, 75, 12, .13);
}
.home-composer__credits.is-insufficient {
  border-color: rgba(239, 68, 68, .55);
  color: #fca5a5;
  background: rgba(127, 29, 29, .18);
}
.home-generate {
  display: inline-flex;
  min-width: 126px;
  min-height: 52px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 14px;
  color: #fff;
  background: #ef6c3b;
  box-shadow: 0 12px 28px rgba(239, 108, 59, .18);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  transition: transform .2s, background .2s, box-shadow .2s;
}
.home-generate:hover,
.home-generate:focus-visible {
  outline: none;
  background: #ff7b46;
  transform: translateY(-1px);
  box-shadow: 0 16px 34px rgba(239, 108, 59, .28);
}
.home-recent {
  width: min(1220px, 100%);
  margin: 64px auto 0;
}
.home-recent__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 22px;
}
.home-recent__heading h2 {
  margin: 0;
  color: #efedf4;
  font-size: 23px;
  letter-spacing: -.02em;
}
.home-recent__heading button {
  border: 0;
  color: #9f9aa9;
  background: transparent;
  font-size: 14px;
  cursor: pointer;
}
.home-recent__heading button:hover,
.home-recent__heading button:focus-visible {
  outline: none;
  color: #fff;
}
.home-project-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 18px;
  scroll-margin-top: 90px;
}
.home-project-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .09);
  border-radius: 18px;
  color: inherit;
  background: rgba(12, 12, 15, .92);
  text-align: left;
  cursor: pointer;
  transition: transform .2s, border-color .2s, box-shadow .2s;
}
.home-project-card:hover,
.home-project-card:focus-visible {
  outline: none;
  border-color: rgba(255, 113, 57, .64);
  transform: translateY(-4px);
  box-shadow: 0 20px 38px rgba(0, 0, 0, .32);
}
.home-project-card__cover {
  display: grid;
  min-height: 148px;
  place-items: center;
  color: rgba(255, 255, 255, .78);
  background:
    radial-gradient(circle at 28% 25%, rgba(255, 128, 77, .62), transparent 33%),
    radial-gradient(circle at 72% 72%, rgba(122, 81, 226, .76), transparent 38%),
    linear-gradient(135deg, #231427, #101014);
  font-size: 48px;
  font-weight: 800;
}
.home-project-card__copy {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 15px 16px 17px;
}
.home-project-card__copy strong {
  overflow: hidden;
  color: #f2f2f3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-project-card__copy small {
  color: #777780;
}
.home-project-card--create {
  display: flex;
  min-height: 214px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 9px;
  border-style: dashed;
  border-color: rgba(255, 113, 57, .42);
  background: rgba(17, 12, 20, .75);
  text-align: center;
}
.home-project-card--create strong {
  color: #f5f1f7;
}
.home-project-card--create small {
  color: #7d7883;
}
.home-project-card__create-icon {
  display: grid;
  width: 48px;
  height: 48px;
  margin-bottom: 4px;
  place-items: center;
  border: 1px solid rgba(255, 113, 57, .54);
  border-radius: 50%;
  color: #ff9168;
  background: rgba(255, 113, 57, .1);
  font-size: 27px;
}
.workspace-heading {
  margin-bottom: 42px;
}
.workspace-heading__eyebrow {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid rgba(255, 113, 57, .32);
  border-radius: 999px;
  color: #ff9167;
  background: rgba(255, 113, 57, .08);
  font-size: 12px;
  font-weight: 600;
}
.workspace-heading__row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin-top: 18px;
}
.workspace-heading h1 {
  max-width: 760px;
  margin: 0;
  color: #f6f6f6;
  font-size: clamp(32px, 4vw, 54px);
  font-weight: 650;
  letter-spacing: -.045em;
  line-height: 1.08;
}
.workspace-heading p {
  max-width: 680px;
  margin: 16px 0 0;
  color: #878787;
  font-size: 15px;
  line-height: 1.7;
}
.workspace-heading__action {
  min-width: 132px;
  min-height: 46px;
  border-radius: 12px;
  box-shadow: 0 10px 28px rgba(255, 113, 57, .18);
}
.canvas-project-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 22px;
  padding: 12px;
  border: 1px solid #272727;
  border-radius: 14px;
  background: rgba(15, 15, 15, .86);
}
.canvas-project-search {
  width: min(420px, 100%);
}
.canvas-project-filter {
  width: 190px;
}
.canvas-project-sort {
  width: 140px;
}
.canvas-project-count {
  color: #a1a1aa;
  font-size: 0.84rem;
}
.projects-wrap {
  min-height: 200px;
}
.empty {
  text-align: center;
  padding: 48px 24px;
}
.empty-title {
  font-size: 1.1rem;
  color: #e4e4e7;
  margin: 0 0 8px;
}
.empty-desc {
  color: #71717a;
  font-size: 0.9rem;
  margin: 0 0 20px;
}
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 18px;
}
.project-card {
  position: relative;
  background: rgba(17, 17, 17, 0.9);
  border: 1px solid #272727;
  border-radius: 16px;
  padding: 20px;
  cursor: pointer;
  transition: border-color 0.25s, background 0.25s, transform 0.25s, box-shadow 0.25s;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  overflow: hidden;
}
.project-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(255, 113, 57, 0.04) 0%, transparent 60%);
  pointer-events: none;
}
.project-card:hover {
  border-color: rgba(255, 113, 57, 0.58);
  background: #151515;
  transform: translateY(-3px);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .42), 0 0 0 1px rgba(255, 113, 57, .08);
}
.project-card:focus-visible {
  outline: 2px solid #ff7139;
  outline-offset: 3px;
  border-color: rgba(255, 113, 57, 0.72);
}

/* 操作卡片 */
.action-card {
  cursor: default;
  border-style: dashed;
  border-color: rgba(255, 113, 57, 0.42);
  background: linear-gradient(145deg, rgba(255, 113, 57, 0.07), rgba(17, 17, 17, .92));
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 0 40px rgba(99, 102, 241, 0.04);
}
.action-card:hover {
  border-color: rgba(255, 113, 57, 0.72);
  background: linear-gradient(145deg, rgba(255, 113, 57, 0.11), rgba(20, 20, 20, .96));
  transform: translateY(-2px);
  box-shadow: 0 8px 30px rgba(99, 102, 241, 0.12), inset 0 0 40px rgba(99, 102, 241, 0.06);
}
.action-card::before {
  display: none;
}
.action-card-inner {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.action-card-title {
  font-size: 1rem;
  font-weight: 600;
  color: #ff956d;
  margin: 0;
}
.action-card-buttons {
  display: flex;
  gap: 12px;
  width: 100%;
  justify-content: center;
}
.action-btn {
  min-width: 150px;
}
.action-btn-new {
  --el-button-bg-color: var(--el-color-primary);
}
.action-btn-import {
  --el-button-bg-color: rgba(99, 102, 241, 0.12);
  --el-button-border-color: rgba(99, 102, 241, 0.35);
  --el-button-text-color: #a5b4fc;
  --el-button-hover-bg-color: rgba(99, 102, 241, 0.22);
  --el-button-hover-border-color: rgba(99, 102, 241, 0.55);
  --el-button-hover-text-color: #c7d2fe;
}
.action-card-example {
  width: 100%;
  padding-top: 8px;
  border-top: 1px solid rgba(99, 102, 241, 0.15);
}
.example-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  margin-bottom: 8px;
}
.example-hint-icon {
  color: #a5b4fc;
  font-size: 15px;
}
.example-hint-text {
  font-size: 0.8rem;
  color: #71717a;
}
.example-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.example-btn {
  --el-button-bg-color: rgba(34, 197, 94, 0.1);
  --el-button-border-color: rgba(34, 197, 94, 0.3);
  --el-button-text-color: #4ade80;
  --el-button-hover-bg-color: rgba(34, 197, 94, 0.2);
  --el-button-hover-border-color: rgba(34, 197, 94, 0.5);
  --el-button-hover-text-color: #22c55e;
}
.project-card-body {
  padding-right: 56px;
}
.project-title {
  font-size: 1.05rem;
  margin: 0 0 8px;
  color: #fafafa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-desc {
  font-size: 0.875rem;
  color: #a1a1aa;
  margin: 0 0 12px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.project-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 10px;
}
.badge {
  display: inline-flex;
  align-items: center;
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 99px;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
}
.badge-status--draft {
  background: rgba(113, 113, 122, 0.15);
  color: #a1a1aa;
  border: 1px solid rgba(113, 113, 122, 0.3);
}
.badge-status--published {
  background: rgba(34, 197, 94, 0.12);
  color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.badge-status--generating {
  background: rgba(234, 179, 8, 0.12);
  color: #fcd34d;
  border: 1px solid rgba(234, 179, 8, 0.3);
}
.badge-status--archived {
  background: rgba(99, 102, 241, 0.1);
  color: #a5b4fc;
  border: 1px solid rgba(99, 102, 241, 0.25);
}
.badge-episodes {
  background: rgba(14, 165, 233, 0.12);
  color: #38bdf8;
  border: 1px solid rgba(14, 165, 233, 0.28);
}
.badge-storyboards {
  background: rgba(20, 184, 166, 0.12);
  color: #2dd4bf;
  border: 1px solid rgba(20, 184, 166, 0.28);
}
.badge-ratio {
  background: rgba(251, 146, 60, 0.1);
  color: #fb923c;
  border: 1px solid rgba(251, 146, 60, 0.25);
  font-family: monospace;
}
.badge-folder {
  background: rgba(99, 102, 241, 0.12);
  color: #a5b4fc;
  border: 1px solid rgba(99, 102, 241, 0.3);
}
.badge-style {
  background: rgba(168, 85, 247, 0.1);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.25);
}
.badge-genre {
  background: rgba(249, 115, 22, 0.1);
  color: #fb923c;
  border: 1px solid rgba(249, 115, 22, 0.25);
}
.project-meta {
  font-size: 0.75rem;
  color: #71717a;
  margin: 0;
}
.project-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
}
.project-open-canvas {
  flex: 0 0 auto;
}
.project-card-actions {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  gap: 6px;
}
.project-card-actions .el-button {
  --el-button-size: 28px;
  padding: 0;
}
.project-card-actions .el-button .el-icon {
  font-size: 14px;
}

.folder-create-row {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.folder-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow-y: auto;
}
.folder-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 8px 12px;
  border: 1px solid #27272a;
  border-radius: 8px;
  background: #18181e;
}
.folder-list-label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.folder-list-label span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-list-label small {
  flex: 0 0 auto;
  color: #71717a;
}

@media (max-width: 760px) {
  .main {
    max-width: calc(100vw - 24px);
    padding-top: 34px;
  }
  .main--home {
    max-width: none;
    padding-top: 0;
  }
  .home-workbench__inner {
    width: calc(100vw - 28px);
    padding: 62px 0 72px;
  }
  .home-workbench h1 {
    font-size: 40px;
    line-height: 1.14;
  }
  .home-composer {
    grid-template-columns: 1fr;
    margin-top: 42px;
    padding: 16px;
  }
  .home-composer__reference {
    min-height: 82px;
  }
  .home-composer__toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .home-composer__controls {
    overflow-x: auto;
    padding-bottom: 5px;
  }
  .home-composer__submit {
    justify-content: flex-end;
  }
  .home-project-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .home-project-card--create {
    min-height: 196px;
  }
  .workspace-heading {
    margin-bottom: 28px;
  }
  .workspace-heading__row {
    display: block;
  }
  .workspace-heading h1 {
    font-size: 34px;
  }
  .workspace-heading__action {
    width: 100%;
    margin-top: 22px;
  }
  .canvas-project-search,
  .canvas-project-filter,
  .canvas-project-sort {
    width: 100%;
  }
}

:global(.project-dialog.el-dialog) {
  --el-bg-color: #111111;
  --el-bg-color-overlay: #111111;
  --el-fill-color-blank: #161616;
  --el-border-color: #303030;
  --el-border-color-light: #292929;
  --el-text-color-primary: #f5f5f5;
  --el-text-color-regular: #c5c5c5;
  --el-text-color-secondary: #888888;
  border: 1px solid #2b2b2b;
  border-radius: 16px;
  background: #111111 !important;
  box-shadow: 0 28px 90px rgba(0, 0, 0, .66);
}

@media (min-width: 761px) and (max-width: 1180px) {
  .home-composer__toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .home-project-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
:global(.project-dialog .el-dialog__title) {
  color: #f5f5f5 !important;
}
:global(.project-dialog .el-dialog__headerbtn:hover .el-dialog__close) {
  color: #ff8f64;
}
:global(.project-dialog .el-form-item__label) {
  color: #a8a8a8 !important;
}
:global(.project-dialog .el-input__wrapper),
:global(.project-dialog .el-select__wrapper),
:global(.project-dialog .el-textarea__inner) {
  color: #e8e8e8 !important;
  background: #161616 !important;
  box-shadow: 0 0 0 1px #303030 inset !important;
}
:global(.project-dialog .el-input__wrapper:hover),
:global(.project-dialog .el-select__wrapper:hover),
:global(.project-dialog .el-textarea__inner:hover) {
  box-shadow: 0 0 0 1px #484848 inset !important;
}
:global(.project-dialog .el-input__wrapper.is-focus),
:global(.project-dialog .el-select__wrapper.is-focused),
:global(.project-dialog .el-textarea__inner:focus) {
  box-shadow: 0 0 0 1px #ff7139 inset !important;
}
:global(.project-dialog .el-input__inner),
:global(.project-dialog .el-select__selected-item),
:global(.project-dialog .el-textarea__inner) {
  color: #e8e8e8 !important;
}
:global(.project-dialog .el-input__inner::placeholder),
:global(.project-dialog .el-textarea__inner::placeholder) {
  color: #676767 !important;
}
:global(.project-dialog .el-input__count) {
  color: #707070 !important;
  background: transparent !important;
}
:global(.project-dialog .el-dialog__footer .el-button:not(.el-button--primary)) {
  --el-button-bg-color: #161616;
  --el-button-border-color: #343434;
  --el-button-text-color: #bdbdbd;
  --el-button-hover-bg-color: rgba(255, 113, 57, .1);
  --el-button-hover-border-color: rgba(255, 113, 57, .55);
  --el-button-hover-text-color: #ff9a72;
}
:global(html.light .project-dialog.el-dialog) {
  --el-bg-color: #111111;
  --el-bg-color-overlay: #111111;
  --el-fill-color-blank: #161616;
  --el-border-color: #303030;
  --el-border-color-light: #292929;
  --el-text-color-primary: #f5f5f5;
  --el-text-color-regular: #c5c5c5;
  --el-text-color-secondary: #888888;
  background: #111111 !important;
}
:global(html.light .project-dialog .el-dialog__title) {
  color: #f5f5f5 !important;
}
:global(html.light .project-dialog .el-form-item__label) {
  color: #a8a8a8 !important;
}
:global(html.light .project-dialog .el-input__wrapper),
:global(html.light .project-dialog .el-select__wrapper),
:global(html.light .project-dialog .el-textarea__inner) {
  color: #e8e8e8 !important;
  background: #161616 !important;
  box-shadow: 0 0 0 1px #303030 inset !important;
}
:global(html.light .project-dialog .el-input__inner),
:global(html.light .project-dialog .el-select__selected-item),
:global(html.light .project-dialog .el-textarea__inner) {
  color: #e8e8e8 !important;
}

/* 项目入口固定为 OpenVideo 风格的暗色工作区，避免历史主题设置覆盖 */
html.light .film-list {
  background: #080808;
  color: #f5f5f5;
  background-image:
    radial-gradient(ellipse 70% 45% at 50% -10%, rgba(255, 113, 57, 0.12) 0%, transparent 70%),
    radial-gradient(ellipse 50% 35% at 85% 55%, rgba(255, 113, 57, 0.05) 0%, transparent 60%);
}
html.light .header {
  background: rgba(8, 8, 8, 0.92) !important;
  border-bottom-color: #272727 !important;
  box-shadow: 0 1px 0 rgba(255, 113, 57, 0.06), 0 4px 16px rgba(0, 0, 0, 0.28) !important;
}
html.light .logo-main {
  background: linear-gradient(135deg, #ff7139 0%, #ff9a72 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 8px rgba(255, 113, 57, 0.2));
}
html.light .logo-sub {
  color: #8c8c8c;
  -webkit-text-fill-color: #8c8c8c;
}
html.light .project-card {
  background: rgba(17, 17, 17, 0.94) !important;
  border-color: #272727 !important;
  box-shadow: 0 1px 4px rgba(255, 113, 57, 0.04), 0 2px 12px rgba(0, 0, 0, 0.22) !important;
  backdrop-filter: none;
}
html.light .project-card::before {
  background: linear-gradient(135deg, rgba(255, 113, 57, 0.04) 0%, transparent 60%);
}
html.light .project-card:hover {
  border-color: rgba(255, 113, 57, 0.6) !important;
  background: #151515 !important;
  box-shadow: 0 12px 36px rgba(255, 113, 57, 0.1), 0 0 0 1px rgba(255, 113, 57, 0.12), 0 2px 8px rgba(0, 0, 0, 0.32) !important;
}
html.light .action-card {
  background: linear-gradient(135deg, rgba(255, 113, 57, 0.08) 0%, rgba(255, 113, 57, 0.03) 100%) !important;
  border-color: rgba(255, 113, 57, 0.4) !important;
}
html.light .action-card:hover {
  background: linear-gradient(135deg, rgba(255, 113, 57, 0.13) 0%, rgba(255, 113, 57, 0.06) 100%) !important;
  border-color: rgba(255, 113, 57, 0.65) !important;
}
html.light .action-card-title { color: #ff8c5e !important; }
html.light .project-title { color: #f5f5f5 !important; }
html.light .project-desc { color: #a3a3a3 !important; }
html.light .project-meta { color: #737373 !important; }
html.light .example-hint-text { color: #8c8c8c !important; }
html.light .badge-status--draft {
  background: rgba(115, 115, 115, 0.12);
  color: #a3a3a3;
  border-color: rgba(115, 115, 115, 0.28);
}

</style>
