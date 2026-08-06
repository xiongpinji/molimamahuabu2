<template>
  <div class="redraw-workspace-page">
    <PlatformHeader title="一键转绘工作台" back-to="/redraw" back-label="返回项目" :show-ai-config="false" />

    <main class="redraw-workspace">
      <aside class="redraw-steps" aria-label="转绘步骤">
        <button
          v-for="item in steps"
          :key="item.step"
          type="button"
          class="redraw-step"
          :class="{ active: allowedStep === item.step, locked: item.step > backendStep }"
          :disabled="item.step > backendStep"
          @click="goStep(item.step)"
        >
          <span>{{ String(item.step).padStart(2, '0') }}</span>
          <strong>{{ item.label }}</strong>
        </button>
      </aside>

      <section v-loading="loading" class="redraw-workspace__body">
        <header class="redraw-workspace__heading">
          <div>
            <p class="eyebrow">项目 {{ project?.id || projectId }}</p>
            <h1>{{ project?.title || '一键转绘' }}</h1>
          </div>
          <el-tag v-if="work?.status">{{ work.status }}</el-tag>
        </header>

        <RedrawSourceStep
          v-if="allowedStep === 1"
          :project-id="projectId"
          :initial-work="work"
          @work-updated="onWorkUpdated"
        />
        <RedrawAssetStep
          v-else-if="allowedStep === 2"
          :work="work"
          :version-id="work?.version_id"
          @work-updated="onWorkUpdated"
        />
        <RedrawShotStep
          v-else-if="allowedStep === 3"
          :work="work"
          :version-id="work?.version_id"
          @work-updated="onWorkUpdated"
        />
        <div v-else class="redraw-placeholder">
          当前步骤由后端门禁控制。
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PlatformHeader from '@/components/PlatformHeader.vue'
import RedrawSourceStep from '@/components/redraw/RedrawSourceStep.vue'
import RedrawAssetStep from '@/components/redraw/RedrawAssetStep.vue'
import RedrawShotStep from '@/components/redraw/RedrawShotStep.vue'
import { redrawAPI } from '@/api/redraw'
import { isExistingWorkId, normalizeStep, resolveAllowedStep } from '@/utils/redrawWorkspaceState'

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const project = ref(null)
const work = ref(null)

const projectId = computed(() => route.params.projectId)
const workId = computed(() => route.params.workId)
const backendStep = computed(() => normalizeStep(work.value?.current_step || 1))
const allowedStep = computed(() => resolveAllowedStep(route.query.step, work.value?.current_step || 1))
const steps = [
  { step: 1, label: '源片与风格' },
  { step: 2, label: '资产审核' },
  { step: 3, label: '批量转绘' },
  { step: 4, label: '导出交付' },
]

async function loadWorkspace() {
  loading.value = true
  try {
    project.value = await redrawAPI.getProject(projectId.value)
    work.value = isExistingWorkId(workId.value) ? await redrawAPI.getWork(workId.value) : null
    const nextStep = resolveAllowedStep(route.query.step, work.value?.current_step || 1)
    if (String(route.query.step || '1') !== String(nextStep)) {
      router.replace({ query: { ...route.query, step: nextStep } })
    }
  } finally {
    loading.value = false
  }
}

function goStep(step) {
  const nextStep = Math.min(normalizeStep(step), backendStep.value)
  router.replace({ query: { ...route.query, step: nextStep } })
}

function onWorkUpdated(nextWork) {
  work.value = nextWork
  if (nextWork?.id && String(workId.value) !== String(nextWork.id)) {
    router.replace({
      name: 'redraw-workspace',
      params: { projectId: projectId.value, workId: nextWork.id },
      query: { ...route.query, step: resolveAllowedStep(route.query.step, nextWork.current_step || 1) },
    })
  }
}

onMounted(loadWorkspace)
watch(() => [route.params.projectId, route.params.workId], loadWorkspace)
</script>

<style scoped>
.redraw-workspace-page {
  min-height: 100vh;
  background: #080808;
  color: #f5f5f5;
}

.redraw-workspace {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 22px;
  box-sizing: border-box;
  width: min(1240px, calc(100% - 32px));
  min-width: 0;
  margin: 0 auto;
  padding: 24px 0 48px;
}

.redraw-steps {
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
}

.redraw-step {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 10px;
  align-items: center;
  box-sizing: border-box;
  padding: 14px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  background: #151515;
  color: #d8d8d8;
  text-align: left;
  min-width: 0;
  white-space: normal;
}

.redraw-step.active {
  border-color: #ff7139;
  color: #fff;
}

.redraw-step.locked {
  opacity: .48;
}

.redraw-step span {
  color: #ff9a6d;
  font-weight: 800;
}

.redraw-step strong {
  min-width: 0;
  overflow-wrap: anywhere;
}

.redraw-workspace__body {
  min-width: 0;
}

.redraw-workspace__heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  margin-bottom: 18px;
}

.redraw-workspace__heading > div {
  min-width: 0;
}

.eyebrow {
  margin: 0 0 6px;
  color: #ff9a6d;
  font-size: 12px;
  font-weight: 700;
}

h1 {
  margin: 0;
  font-size: 24px;
  overflow-wrap: anywhere;
}

.redraw-placeholder {
  padding: 28px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  background: #151515;
  color: #a5a5a5;
}

@media (max-width: 800px) {
  .redraw-workspace {
    grid-template-columns: 1fr;
  }

  .redraw-steps {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
