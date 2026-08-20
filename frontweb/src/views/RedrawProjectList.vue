<template>
  <div class="redraw-project-list-page">
    <PlatformHeader title="一键转绘" :show-ai-config="false" />

    <main class="redraw-project-list">
      <section class="redraw-project-list__toolbar">
        <div>
          <p class="eyebrow">源片转绘工作台</p>
          <h1>一键转绘项目</h1>
        </div>
        <el-button type="primary" @click="createDialogVisible = true">新建转绘项目</el-button>
      </section>

      <el-dialog v-model="createDialogVisible" title="新建转绘项目" width="520px">
        <div class="create-form">
          <label class="create-field">
            <span>项目名称</span>
            <el-input v-model="createForm.title" />
          </label>
          <label class="create-field">
            <span>执行模式</span>
            <el-radio-group v-model="createForm.execution_mode">
              <el-radio-button label="safe">safe</el-radio-button>
              <el-radio-button label="auto">auto</el-radio-button>
            </el-radio-group>
          </label>
          <div class="create-form__pair">
            <label class="create-field">
              <span>目标语言</span>
              <el-input v-model="createForm.default_locale" placeholder="en-US" />
            </label>
            <label class="create-field">
              <span>目标市场</span>
              <el-input v-model="createForm.default_market" placeholder="US" />
            </label>
          </div>
          <div class="create-form__pair">
            <label class="create-field">
              <span>预算上限</span>
              <el-input-number v-model="createForm.budget_limit_credits" :min="1" :step="10" controls-position="right" />
            </label>
            <label class="create-field">
              <span>自动尝试上限</span>
              <el-input-number v-model="createForm.max_auto_attempts_per_shot" :min="1" :max="5" controls-position="right" />
            </label>
          </div>
        </div>
        <template #footer>
          <el-button @click="createDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="creating" @click="createDraftProject">创建</el-button>
        </template>
      </el-dialog>

      <section v-loading="loading" class="redraw-project-grid">
        <button
          v-for="project in projects"
          :key="project.id"
          type="button"
          class="redraw-project-card"
          @click="openProject(project)"
        >
          <strong>{{ project.title || '未命名转绘项目' }}</strong>
          <span>{{ project.default_locale || 'en-US' }} · {{ project.default_market || '默认地区' }}</span>
          <em>{{ statusText(project.status) }} · {{ formatDate(project.updated_at) }}</em>
        </button>

        <div v-if="!loading && projects.length === 0" class="redraw-project-empty">
          还没有一键转绘项目
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import PlatformHeader from '@/components/PlatformHeader.vue'
import { redrawAPI } from '@/api/redraw'
import { buildCreateProjectPayload } from '@/utils/redrawWorkspaceState'

const router = useRouter()
const loading = ref(false)
const creating = ref(false)
const projects = ref([])
const createDialogVisible = ref(false)
const createForm = ref({
  title: '',
  execution_mode: 'safe',
  budget_limit_credits: null,
  max_auto_attempts_per_shot: null,
  default_locale: 'en-US',
  default_market: 'US',
  localization_level: 'faithful',
})

function formatDate(value) {
  if (!value) return '未更新'
  return new Date(value).toLocaleDateString('zh-CN')
}

function statusText(status) {
  return ({
    draft: '草稿',
    active: '处理中',
    completed: '已完成',
    failed: '失败',
  })[status] || status || '草稿'
}

async function loadProjects() {
  loading.value = true
  try {
    projects.value = await redrawAPI.listProjects()
  } finally {
    loading.value = false
  }
}

async function createDraftProject() {
  creating.value = true
  try {
    const project = await redrawAPI.createProject(buildCreateProjectPayload({
      ...createForm.value,
      title: createForm.value.title || `转绘项目 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    }))
    createDialogVisible.value = false
    router.push({ name: 'redraw-workspace', params: { projectId: project.id, workId: 'new' }, query: { step: 1 } })
  } catch (error) {
    ElMessage.error(error.message || '创建转绘项目失败')
  } finally {
    creating.value = false
  }
}

function openProject(project) {
  router.push({ name: 'redraw-workspace', params: { projectId: project.id, workId: 'new' }, query: { step: 1 } })
}

onMounted(loadProjects)
</script>

<style scoped>
.redraw-project-list-page {
  min-height: 100vh;
  background: #080808;
  color: #f5f5f5;
}

.redraw-project-list {
  width: min(1180px, calc(100% - 32px));
  margin: 0 auto;
  padding: 28px 0 48px;
}

.redraw-project-list__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #ff9a6d;
  font-size: 12px;
  font-weight: 700;
}

h1 {
  margin: 0;
  font-size: 26px;
}

.redraw-project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}

.redraw-project-card {
  display: grid;
  gap: 10px;
  min-height: 132px;
  padding: 18px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  background: #151515;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.redraw-project-card:hover,
.redraw-project-card:focus-visible {
  outline: none;
  border-color: #ff7139;
}

.redraw-project-card strong {
  font-size: 17px;
}

.redraw-project-card span,
.redraw-project-card em {
  color: #a5a5a5;
  font-style: normal;
  font-size: 13px;
}

.redraw-project-empty {
  grid-column: 1 / -1;
  padding: 42px;
  border: 1px dashed #383838;
  border-radius: 8px;
  color: #a5a5a5;
  text-align: center;
}

.create-form {
  display: grid;
  gap: 14px;
}

.create-form__pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.create-field {
  display: grid;
  gap: 8px;
}

.create-field span {
  color: #d8d8d8;
  font-size: 13px;
}

@media (max-width: 720px) {
  .redraw-project-list__toolbar {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
