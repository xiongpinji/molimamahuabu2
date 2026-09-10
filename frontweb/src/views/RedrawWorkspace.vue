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
          :class="{ active: allowedStep === item.step, locked: stepLocked(item.step) }"
          :disabled="stepLocked(item.step)"
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
          <el-tag v-if="work?.status" class="redraw-workspace__status-tag">{{ work.status }}</el-tag>
        </header>

        <div class="redraw-workspace-works">
          <label for="redraw-work-selector">选择作品</label>
          <select id="redraw-work-selector" aria-label="选择作品" :value="workId"
            :disabled="loading || Boolean(workspaceError)" @change="selectWork($event.target.value)">
            <option value="new">上传新作品</option>
            <option v-for="item in projectWorks" :key="item.id" :value="String(item.id)">{{ item.title }}</option>
          </select>
          <el-button :disabled="worksLoading || loading || Boolean(workspaceError)" @click="refreshProjectWorks">刷新作品列表</el-button>
          <el-button :disabled="loading || Boolean(workspaceError)" @click="selectWork('new')">上传新作品</el-button>
          <p v-if="worksError" role="alert">{{ worksError }}</p>
          <p v-else-if="!worksLoading && !projectWorks.length">项目中暂无作品，请上传源片。</p>
        </div>

        <RedrawProjectOverview
          :project="project"
          :work="work"
          :events="projectEvents"
          :stages="eightStageState"
        />

        <div v-if="workspaceError" class="redraw-events-alert" role="alert">
          <p>{{ workspaceError }}</p>
          <el-button :disabled="loading" @click="loadWorkspace">重新读取工作台</el-button>
        </div>

        <el-alert
          v-if="projectEventsError"
          class="redraw-events-alert"
          type="warning"
          :closable="false"
          :title="projectEventsError"
          show-icon
        />

        <nav class="redraw-workspace-tabs" aria-label="通用转绘工作区">
          <span v-for="tab in workspaceTabs" :key="tab">{{ tab }}</span>
        </nav>
        <p v-if="allowedStep >= 3" class="redraw-delivery-scope">
          生成队列 · 候选 QA · 整集 readiness 均以服务端证据为准
        </p>

        <RedrawSourceStep
          v-if="allowedStep === 1"
          :key="'source-' + workRouteVisit"
          :project-id="projectId"
          :default-locale="project?.default_locale"
          :default-market="project?.default_market"
          :initial-work="work"
          :events="projectEvents"
          :blueprint-record="blueprintRecord"
          :blueprint-loading="blueprintLoading"
          :blueprint-error="blueprintError"
          :project-policy="projectPolicy"
          :blocked="loading || Boolean(workspaceError)"
          @work-updated="workEventHandlers.work"
          @blueprint-updated="workEventHandlers.blueprint"
          @refresh-blueprint="workEventHandlers.refreshBlueprint"
          @unit-delivery-requested="workEventHandlers.unitDelivery"
        />
        <RedrawAssetStep
          v-else-if="allowedStep === 2"
          :key="'asset-' + workRouteVisit"
          :work="work"
          :version-id="work?.version_id"
          :execution-mode="project?.execution_mode"
          @work-updated="workEventHandlers.work"
        />
        <RedrawShotStep
          v-else-if="allowedStep === 3"
          :key="'shot-' + workRouteVisit"
          :work="work"
          :version-id="work?.version_id"
          :execution-mode="project?.execution_mode"
          @work-updated="workEventHandlers.work"
        />
        <RedrawEditStep
          v-else-if="allowedStep === 4"
          :key="'edit-' + workRouteVisit"
          :work="work"
          :version-id="work?.version_id"
          :target-locale="project?.default_locale"
          :unit-mode="unitDeliveryMode"
          :unit-intent="unitDeliveryIntent"
          :unit-context="unitDeliveryContext"
          @work-updated="workEventHandlers.work"
        />
        <div v-else class="redraw-placeholder">
          当前步骤由后端门禁控制。
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PlatformHeader from '@/components/PlatformHeader.vue'
import RedrawSourceStep from '@/components/redraw/RedrawSourceStep.vue'
import RedrawProjectOverview from '@/components/redraw/RedrawProjectOverview.vue'
import RedrawAssetStep from '@/components/redraw/RedrawAssetStep.vue'
import RedrawShotStep from '@/components/redraw/RedrawShotStep.vue'
import RedrawEditStep from '@/components/redraw/RedrawEditStep.vue'
import { redrawAPI } from '@/api/redraw'
import { readSession, readCurrentTenantId } from '@/utils/authSession'
import {
  isExistingWorkId,
  normalizeStep,
  resolveEightStageState,
  resolveAllowedStep,
  resolveProjectEventsState,
  resolveUpdatedStep,
} from '@/utils/redrawWorkspaceState'

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const project = ref(null)
const workspaceError = ref('')
const projectPolicy = reactive({ project_id: null, execution_mode: null, policy_version: null, epoch: 0 })
const unitDeliveryMode = ref(false)
const unitDeliveryIntent = ref(null)
const work = ref(null)
const projectWorks = ref([])
const worksLoading = ref(false)
const worksError = ref('')
const workRouteVisit = ref(0)
const workEventVisit = ref(0)
const projectEvents = ref([])
const projectEventsError = ref('')
const blueprintRecord = ref(undefined)
const blueprintLoading = ref(false)
const blueprintError = ref('')
let workspaceRequestSequence = 0
let blueprintRequestSequence = 0
let worksRequestSequence = 0
let observedOwner = workspaceOwner()

function workspaceOwner() {
  try {
    const session = readSession(), tenant = readCurrentTenantId()
    return session?.token && session.user?.id != null ? JSON.stringify([tenant == null ? null : String(tenant), String(session.user.id)]) : null
  } catch { return null }
}

function sessionUser(raw) {
  try {
    const session = JSON.parse(raw)
    return session?.token && session.user?.id != null ? String(session.user.id) : null
  } catch { return null }
}

function checkWorkspaceOwner(event) {
  let changed = false
  if (event?.type !== 'focus' && event && (!event.storageArea || event.storageArea === window.localStorage)) {
    if (event.key === null) changed = true
    if (event.key === 'moli_mama_session') changed = sessionUser(event.oldValue) !== sessionUser(event.newValue)
    if (event.key === 'moli_mama_tenant_id') changed = event.oldValue !== event.newValue
  }
  const identity = workspaceOwner()
  if (!changed && identity === observedOwner) return
  observedOwner = identity
  workspaceRequestSequence += 1
  blueprintRequestSequence += 1
  worksRequestSequence += 1
  workEventVisit.value += 1
  projectWorks.value = []
  worksLoading.value = false
  worksError.value = ''
  workspaceError.value = '账号或租户已变化，请重新读取工作台并复核本地化'
  loading.value = false
  blueprintLoading.value = false
  // Queued storage ABA must invalidate children even when the visible error is unchanged.
  projectPolicy.epoch += 1
}

const projectId = computed(() => route.params.projectId)
const workId = computed(() => route.params.workId)
const workEventHandlers = computed(() => {
  const visit = workEventVisit.value, owner = observedOwner
  const current = () => visit === workEventVisit.value && owner === workspaceOwner()
  return {
    work: next => { if (current()) onWorkUpdated(next) },
    blueprint: next => { if (current()) onBlueprintUpdated(next) },
    refreshBlueprint: () => { if (current()) return refreshBlueprint() },
    unitDelivery: value => { if (current()) onUnitDeliveryRequested(value) },
  }
})
const backendStep = computed(() => normalizeStep(work.value?.current_step || 1))
const allowedStep = computed(() => workspaceStep(route.query.step, work.value?.current_step || 1))
const unitDeliveryContext = computed(() => {
  if (loading.value || workspaceError.value || !projectScopeValid(project.value)
    || !workScopeValid(work.value, workId.value, project.value)) return null
  return { project_id: project.value.id, work_id: work.value.id, version_id: work.value.version_id,
    owner: [project.value.tenant_id, String(project.value.user_id)], policy: projectPolicy }
})
const eightStageState = computed(() => resolveEightStageState({
  ...(work.value || {}),
  events: projectEvents.value,
}))
const workspaceTabs = ['项目设置', '分析本地化', '角色资产库', '逐镜工作台', '生成与 QA', '合并与导出']
const steps = [
  { step: 1, label: '源片与风格' },
  { step: 2, label: '资产审核' },
  { step: 3, label: '批量转绘' },
  { step: 4, label: '导出交付' },
]

const positiveId = value => Number.isSafeInteger(value) && value > 0
function projectScopeValid(value) {
  const identity = workspaceOwner()
  if (!identity || !value || !positiveId(value.id) || String(value.id) !== String(projectId.value)
    || typeof value.tenant_id !== 'string' || !value.tenant_id.trim()
    || !((typeof value.user_id === 'string' && value.user_id.trim()) || positiveId(value.user_id))
    || !['safe', 'auto'].includes(value.execution_mode) || !positiveId(value.policy_version)) return false
  const [tenant, user] = JSON.parse(identity)
  return String(value.user_id) === user && (tenant === null || tenant === value.tenant_id)
}
function workScopeValid(value, requestedId, parent) {
  return value && positiveId(value.id) && String(value.id) === String(requestedId)
    && value.project_id === parent?.id && positiveId(value.version_id)
}
function workspaceStep(requested, backend) {
  return unitDeliveryMode.value && String(requested) === '4' ? 4 : resolveAllowedStep(requested, backend)
}
function stepLocked(step) { return step > backendStep.value && !(step === 4 && unitDeliveryMode.value) }
function onUnitDeliveryRequested(value) {
  const context = unitDeliveryContext.value
  if (!context || value?.project_id !== context.project_id || value.work_id !== context.work_id
    || value.version_id !== context.version_id || !positiveId(value.run_id)
    || typeof value.plan_hash !== 'string' || value.plan_hash.length !== 64 || !/^[a-f0-9]{64}$/.test(value.plan_hash)
    || !Number.isSafeInteger(value.run_revision) || value.run_revision < 0
    || JSON.stringify(value.owner) !== JSON.stringify(context.owner)
    || JSON.stringify(value.project_policy) !== JSON.stringify(projectPolicy)) return
  unitDeliveryMode.value = true
  router.replace({ query: { ...route.query, step: '4', unit_run: String(value.run_id), unit_version: String(value.version_id),
    unit_plan: value.plan_hash, unit_revision: String(value.run_revision) } })
}
function readUnitDeliveryIntent(query) {
  const integer = (value, zero = false) => typeof value === 'string' && (zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value)
    && Number.isSafeInteger(Number(value)) && String(Number(value)) === value
  if (!integer(query.unit_run) || !integer(query.unit_version) || !integer(query.unit_revision, true)
    || typeof query.unit_plan !== 'string' || query.unit_plan.length !== 64 || !/^[a-f0-9]{64}$/.test(query.unit_plan)) return null
  return { run_id: Number(query.unit_run), version_id: Number(query.unit_version), plan_hash: query.unit_plan,
    run_revision: Number(query.unit_revision) }
}

function selectWork(nextWorkId) {
  checkWorkspaceOwner()
  if (loading.value || workspaceError.value || String(nextWorkId) === String(workId.value)) return
  if (nextWorkId !== 'new' && !projectWorks.value.some(item => String(item.id) === String(nextWorkId))) return
  const query = { ...route.query, step: 1 }
  for (const key of ['unit_run', 'unit_version', 'unit_plan', 'unit_revision']) delete query[key]
  unitDeliveryMode.value = false
  unitDeliveryIntent.value = null
  return router.replace({ name: 'redraw-workspace',
    params: { projectId: projectId.value, workId: nextWorkId }, query })
}

async function refreshProjectWorks() {
  checkWorkspaceOwner()
  if (!observedOwner || workspaceError.value) return
  const requestSequence = ++worksRequestSequence
  const requestedProjectId = String(projectId.value || ''), visit = workEventVisit.value, owner = observedOwner
  const current = () => requestSequence === worksRequestSequence && visit === workEventVisit.value
    && requestedProjectId === String(projectId.value || '') && owner === workspaceOwner()
  worksLoading.value = true
  worksError.value = ''
  try {
    const items = await redrawAPI.listProjectWorks(requestedProjectId)
    if (!current()) return
    if (!Array.isArray(items)) throw new Error('作品列表格式无效')
    projectWorks.value = items
  } catch (error) {
    if (current()) worksError.value = error?.message || '作品列表读取失败'
  } finally {
    if (current()) worksLoading.value = false
  }
}

async function loadWorkspace() {
  checkWorkspaceOwner()
  if (!observedOwner) {
    workspaceError.value = '账号未就绪，请重新登录后读取工作台'
    return
  }
  const requestSequence = ++workspaceRequestSequence
  const requestedProjectId = String(projectId.value || '')
  const requestedWorkId = String(workId.value || '')
  loading.value = true
  workspaceError.value = ''
  blueprintRequestSequence += 1
  blueprintRecord.value = undefined
  blueprintLoading.value = isExistingWorkId(requestedWorkId)
  blueprintError.value = ''
  try {
    const eventsRequest = redrawAPI.listProjectEvents(projectId.value)
      .then((nextEvents) => resolveProjectEventsState({ previousEvents: projectEvents.value, nextEvents }))
      .catch((error) => resolveProjectEventsState({ previousEvents: projectEvents.value, error }))
    const nextProject = await redrawAPI.getProject(requestedProjectId)
    if (!isCurrentWorkspaceRequest(requestSequence, requestedProjectId, requestedWorkId)) return
    if (unitDeliveryMode.value && !projectScopeValid(nextProject)) throw Error('项目归属或策略未通过核验')
    const nextWork = isExistingWorkId(requestedWorkId) ? await redrawAPI.getWork(requestedWorkId) : null
    if (!isCurrentWorkspaceRequest(requestSequence, requestedProjectId, requestedWorkId)) return
    if (unitDeliveryMode.value && !workScopeValid(nextWork, requestedWorkId, nextProject)) throw Error('作品或版本绑定未通过核验')
    project.value = nextProject
    work.value = nextWork
    if (nextWork?.id && String(nextWork.id) === requestedWorkId) {
      await loadBlueprint(nextWork.id)
    }
    const nextEventsState = await eventsRequest
    if (!isCurrentWorkspaceRequest(requestSequence, requestedProjectId, requestedWorkId)) return
    applyProjectEventsState(nextEventsState)
    const nextStep = workspaceStep(route.query.step, work.value?.current_step || 1)
    if (String(route.query.step || '1') !== String(nextStep)) {
      router.replace({ query: { ...route.query, step: nextStep } })
    }
  } catch (error) {
    if (isCurrentWorkspaceRequest(requestSequence, requestedProjectId, requestedWorkId)) {
      workspaceError.value = error?.message || '项目读取失败，请刷新'
    }
  } finally {
    if (requestSequence === workspaceRequestSequence) {
      loading.value = false
      if (!workspaceError.value) refreshProjectWorks()
    }
  }
}

function isCurrentWorkspaceRequest(requestSequence, requestedProjectId, requestedWorkId) {
  return requestSequence === workspaceRequestSequence
    && String(projectId.value || '') === requestedProjectId
    && String(workId.value || '') === requestedWorkId
}

async function loadBlueprint(targetWorkId) {
  if (!isExistingWorkId(targetWorkId)) {
    blueprintRecord.value = undefined
    blueprintLoading.value = false
    blueprintError.value = ''
    return undefined
  }
  const requestSequence = ++blueprintRequestSequence
  const requestedWorkId = String(targetWorkId)
  blueprintRecord.value = undefined
  blueprintLoading.value = true
  blueprintError.value = ''
  try {
    const next = await redrawAPI.getBlueprint(targetWorkId)
    if (!isCurrentBlueprintRequest(requestSequence, requestedWorkId)) return undefined
    if (next == null) {
      blueprintError.value = '读取母本蓝图返回空结果'
      return undefined
    }
    blueprintRecord.value = next
    blueprintError.value = ''
    return next
  } catch (error) {
    if (!isCurrentBlueprintRequest(requestSequence, requestedWorkId)) return undefined
    if (Number(error?.response?.status) === 404) {
      blueprintRecord.value = null
      blueprintError.value = ''
      return null
    }
    blueprintRecord.value = undefined
    blueprintError.value = error?.response?.data?.error?.message || error?.message || '读取母本蓝图失败'
    return undefined
  } finally {
    if (isCurrentBlueprintRequest(requestSequence, requestedWorkId)) blueprintLoading.value = false
  }
}

function isCurrentBlueprintRequest(requestSequence, requestedWorkId) {
  return requestSequence === blueprintRequestSequence
    && String(workId.value || '') === requestedWorkId
    && String(work.value?.id || '') === requestedWorkId
}

function refreshBlueprint() {
  if (workspaceError.value) return
  return loadBlueprint(work.value?.id)
}

function onBlueprintUpdated(nextBlueprint) {
  if (loading.value || workspaceError.value) return
  if (!nextBlueprint?.work_id || String(nextBlueprint.work_id) !== String(workId.value)
    || String(nextBlueprint.work_id) !== String(work.value?.id)) return
  blueprintRequestSequence += 1
  blueprintLoading.value = false
  blueprintError.value = ''
  blueprintRecord.value = nextBlueprint
}

function goStep(step) {
  const nextStep = step === 4 && unitDeliveryMode.value ? 4 : Math.min(normalizeStep(step), backendStep.value)
  router.replace({ query: { ...route.query, step: nextStep } })
}

function onWorkUpdated(nextWork) {
  if (loading.value || workspaceError.value) return
  if (nextWork?.project_id != null && String(nextWork.project_id) !== String(projectId.value)) return
  if (isExistingWorkId(workId.value) && String(nextWork?.id || '') !== String(workId.value)) return
  const previousBackendStep = work.value?.current_step || 1
  const previousAnalysisStatus = String(work.value?.analysis_task?.status || work.value?.task_status || '').toLowerCase()
  work.value = nextWork
  refreshProjectEvents()
  const nextAnalysisStatus = String(nextWork?.analysis_task?.status || nextWork?.task_status || '').toLowerCase()
  if (nextWork?.id && blueprintRecord.value == null
    && previousAnalysisStatus !== 'completed' && nextAnalysisStatus === 'completed') {
    loadBlueprint(nextWork.id)
  }
  if (nextWork?.id && String(workId.value) !== String(nextWork.id)) {
    router.replace({
      name: 'redraw-workspace',
      params: { projectId: projectId.value, workId: nextWork.id },
      query: { ...route.query, step: resolveAllowedStep(route.query.step, nextWork.current_step || 1) },
    })
    return
  }
  const nextStep = unitDeliveryMode.value && String(route.query.step) === '4' ? 4 : resolveUpdatedStep({
    routeStep: route.query.step,
    previousBackendStep,
    nextBackendStep: nextWork?.current_step || 1,
  })
  if (String(route.query.step || '1') !== String(nextStep)) {
    router.replace({ query: { ...route.query, step: nextStep } })
  }
}

async function refreshProjectEvents() {
  if (workspaceError.value) return
  const requestSequence = workspaceRequestSequence
  const requestedProjectId = String(projectId.value || ''), requestedWorkId = String(workId.value || '')
  const nextState = await redrawAPI.listProjectEvents(projectId.value)
    .then((nextEvents) => resolveProjectEventsState({ previousEvents: projectEvents.value, nextEvents }))
    .catch((error) => resolveProjectEventsState({ previousEvents: projectEvents.value, error }))
  if (isCurrentWorkspaceRequest(requestSequence, requestedProjectId, requestedWorkId)) applyProjectEventsState(nextState)
}

function applyProjectEventsState(nextState) {
  projectEvents.value = nextState.events
  projectEventsError.value = nextState.error
}

watch(() => [projectId.value, workId.value, loading.value, workspaceError.value,
  work.value?.version_id, project.value?.id, project.value?.execution_mode, project.value?.policy_version], () => {
  projectPolicy.epoch += 1
  const current = project.value
  const valid = !loading.value && !workspaceError.value && Number.isSafeInteger(current?.id) && current.id > 0
    && String(current.id) === String(projectId.value) && ['safe', 'auto'].includes(current.execution_mode)
    && Number.isSafeInteger(current.policy_version) && current.policy_version > 0
  projectPolicy.project_id = valid ? current.id : null
  projectPolicy.execution_mode = valid ? current.execution_mode : null
  projectPolicy.policy_version = valid ? current.policy_version : null
}, { immediate: true, flush: 'sync' })
watch(() => route.query, query => {
  if (['unit_run', 'unit_version', 'unit_plan', 'unit_revision'].some(key => Object.hasOwn(query, key))) unitDeliveryMode.value = true
  unitDeliveryIntent.value = readUnitDeliveryIntent(query)
}, { immediate: true, deep: true, flush: 'sync' })
onMounted(() => {
  window.addEventListener('storage', checkWorkspaceOwner)
  window.addEventListener('focus', checkWorkspaceOwner)
  loadWorkspace()
})
onUnmounted(() => {
  workspaceRequestSequence += 1; blueprintRequestSequence += 1
  worksRequestSequence += 1; workEventVisit.value += 1
  window.removeEventListener('storage', checkWorkspaceOwner)
  window.removeEventListener('focus', checkWorkspaceOwner)
})
watch(() => [route.params.projectId, route.params.workId], () => {
  workRouteVisit.value += 1
  workEventVisit.value += 1
  work.value = null
  projectWorks.value = []
  loadWorkspace()
}, { flush: 'sync' })
</script>

<style scoped>
.redraw-workspace-page {
  min-height: 100vh;
  background: #080808;
  color: #f5f5f5;
}

.redraw-workspace-works {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.redraw-workspace-works select {
  min-width: 0;
  max-width: 100%;
  padding: 8px;
  border: 1px solid #333;
  border-radius: 6px;
  background: #151515;
  color: inherit;
}

.redraw-workspace-works p {
  flex-basis: 100%;
  margin: 0;
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

.redraw-workspace-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.redraw-events-alert {
  margin-bottom: 14px;
}

.redraw-workspace-tabs span {
  padding: 7px 10px;
  border: 1px solid #333;
  border-radius: 999px;
  color: #d8d8d8;
  font-size: 13px;
}

.redraw-delivery-scope {
  margin: -4px 0 14px;
  color: #999;
  font-size: 13px;
}

.redraw-workspace__heading > div {
  min-width: 0;
}

.redraw-workspace__heading .redraw-workspace__status-tag {
  color: #f5f5f5;
  background: #252525;
  border-color: #454545;
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
