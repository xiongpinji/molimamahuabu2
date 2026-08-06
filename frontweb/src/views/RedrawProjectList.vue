<template>
  <div class="redraw-project-list-page">
    <PlatformHeader title="一键转绘" :show-ai-config="false" />

    <main class="redraw-project-list">
      <section class="redraw-project-list__toolbar">
        <div>
          <p class="eyebrow">源片转绘工作台</p>
          <h1>一键转绘项目</h1>
        </div>
        <el-button type="primary" :loading="creating" @click="createDraftProject">新建转绘项目</el-button>
      </section>

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

const router = useRouter()
const loading = ref(false)
const creating = ref(false)
const projects = ref([])

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
    const project = await redrawAPI.createProject({
      title: `转绘项目 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      default_locale: 'zh-CN',
      default_market: 'CN',
      localization_level: 'faithful',
    })
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

@media (max-width: 720px) {
  .redraw-project-list__toolbar {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
