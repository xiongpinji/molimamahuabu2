<template>
  <section class="provider-stability" aria-label="供应商稳定性管理">
    <div class="panel-toolbar">
      <div>
        <h3>模型稳定性与自动切换</h3>
        <p>中转关联和内部错误仅管理员可见；未知提交保持积分冻结，不会自动重试。</p>
      </div>
      <el-button :loading="loading" @click="loadAll">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="configs" stripe>
      <el-table-column prop="logical_model_id" label="逻辑模型" min-width="150" />
      <el-table-column label="关联中转站" min-width="210">
        <template #default="{ row }">
          <div>{{ row.name }} · {{ row.relay_host }} · #{{ row.id }}</div>
          <small>{{ row.provider }} / {{ row.default_model || '未设置上游模型' }}</small>
        </template>
      </el-table-column>
      <el-table-column label="健康" width="110">
        <template #default="{ row }">
          <el-tag :type="healthTag(row.health?.state)">{{ healthLabel(row.health?.state) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="熔断" min-width="155">
        <template #default="{ row }">
          <span v-if="row.health?.open_until">至 {{ formatTime(row.health.open_until) }}</span>
          <span v-else>{{ row.health?.consecutive_failures || 0 }} 次连续失败</span>
        </template>
      </el-table-column>
      <el-table-column label="最近切换" min-width="150">
        <template #default="{ row }">{{ formatTime(row.last_switch_at) }}</template>
      </el-table-column>
      <el-table-column label="验证" width="100">
        <template #default="{ row }">
          <el-tag :type="row.verification_status === 'verified' ? 'success' : 'warning'">
            {{ row.verification_status === 'verified' ? '已验证' : '未验证' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" min-width="280" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">策略</el-button>
          <el-button link type="primary" @click="resetHealth(row)">重置健康</el-button>
          <el-button link type="success" @click="verifyFromGeneration(row)">生成记录验证</el-button>
          <el-button link :type="row.admin_paused ? 'success' : 'warning'" @click="togglePause(row)">
            {{ row.admin_paused ? '恢复' : '暂停' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <h3 class="section-title">任务与积分状态</h3>
    <el-table :data="requests" size="small" max-height="260">
      <el-table-column prop="logical_model_id" label="逻辑模型" min-width="150" />
      <el-table-column prop="business_type" label="业务" min-width="130" />
      <el-table-column prop="state" label="任务状态" width="130" />
      <el-table-column prop="credit_state" label="积分状态" width="120">
        <template #default="{ row }">{{ row.credit_state || '未关联' }}</template>
      </el-table-column>
      <el-table-column prop="updated_at" label="更新时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.updated_at) }}</template>
      </el-table-column>
    </el-table>

    <h3 class="section-title">告警日志</h3>
    <el-alert
      v-for="event in priorityEvents"
      :key="event.id"
      :title="`${severityLabel(event)} · ${event.event_type} · ${event.logical_model_id || '未关联模型'}`"
      :description="safeDetails(event)"
      :type="event.severity === 'critical' ? 'error' : 'warning'"
      :closable="false"
      show-icon
      class="priority-alert"
    />
    <el-table :data="normalEvents" size="small" max-height="320">
      <el-table-column prop="severity" label="级别" width="90" />
      <el-table-column prop="event_type" label="事件" min-width="170" />
      <el-table-column prop="logical_model_id" label="逻辑模型" min-width="150" />
      <el-table-column prop="task_state" label="任务状态" width="120" />
      <el-table-column prop="credit_state" label="积分状态" width="120" />
      <el-table-column label="安全摘要" min-width="220">
        <template #default="{ row }">{{ safeDetails(row) }}</template>
      </el-table-column>
      <el-table-column prop="created_at" label="时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="editVisible" title="稳定性策略" width="480px">
      <el-form label-width="100px">
        <el-form-item label="逻辑模型">
          <el-input v-model="editForm.logical_model_id" maxlength="200" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-input-number v-model="editForm.priority" :min="-100000" :max="100000" />
        </el-form-item>
        <el-form-item label="自动切换">
          <el-switch v-model="editForm.failover_enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="savePolicy">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { providerStabilityAPI } from '@/api/providerStability'

const loading = ref(false)
const saving = ref(false)
const configs = ref([])
const requests = ref([])
const events = ref([])
const editVisible = ref(false)
const editingId = ref(null)
const editForm = ref({ logical_model_id: '', priority: 0, failover_enabled: false })

const priorityTypes = new Set(['route_opened', 'provider_request_needs_attention', 'provider_artifact_unreadable'])
const priorityEvents = computed(() => events.value.filter((event) => (
  ['critical', 'error'].includes(event.severity) || priorityTypes.has(event.event_type)
)))
const normalEvents = computed(() => events.value.filter((event) => !priorityEvents.value.includes(event)))

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN')
}

function healthLabel(state) {
  return ({ healthy: '健康', degraded: '降级', open: '已熔断', half_open: '半开', disabled: '已停用' })[state] || '未知'
}

function healthTag(state) {
  return ({ healthy: 'success', degraded: 'warning', open: 'danger', half_open: 'warning', disabled: 'info' })[state] || 'info'
}

function severityLabel(event) {
  return event.severity === 'critical' ? 'P0'
    : event.severity === 'error' || priorityTypes.has(event.event_type) ? 'P1' : 'P2'
}

function safeDetails(event) {
  const details = event?.safe_details
  if (!details || typeof details !== 'object') return '无可展示摘要'
  return Object.entries(details).map(([key, value]) => `${key}: ${String(value)}`).join('；') || '无可展示摘要'
}

async function loadAll() {
  loading.value = true
  try {
    const [routeData, eventData] = await Promise.all([
      providerStabilityAPI.listRoutes(),
      providerStabilityAPI.listEvents(),
    ])
    configs.value = routeData?.configs || []
    requests.value = routeData?.requests || []
    events.value = eventData || []
  } finally {
    loading.value = false
  }
}

function openEdit(row) {
  editingId.value = row.id
  editForm.value = {
    logical_model_id: row.logical_model_id || '',
    priority: row.priority || 0,
    failover_enabled: !!row.failover_enabled,
  }
  editVisible.value = true
}

async function savePolicy() {
  saving.value = true
  try {
    await providerStabilityAPI.updateRoute(editingId.value, editForm.value)
    editVisible.value = false
    ElMessage.success('稳定性策略已保存')
    await loadAll()
  } finally {
    saving.value = false
  }
}

async function togglePause(row) {
  await providerStabilityAPI.updateRoute(row.id, { admin_paused: !row.admin_paused })
  ElMessage.success(row.admin_paused ? '中转已恢复' : '中转已暂停')
  await loadAll()
}

async function resetHealth(row) {
  await ElMessageBox.confirm(`确认重置 ${row.name} 的健康状态？`, '重置健康', { type: 'warning' })
  await providerStabilityAPI.resetHealth(row.id)
  ElMessage.success('健康状态已重置并写入审计')
  await loadAll()
}

async function verifyFromGeneration(row) {
  const { value } = await ElMessageBox.prompt('请输入该配置真实成功且产物可读的生成记录 ID', '生成记录验证', {
    inputPattern: /^\d+$/,
    inputErrorMessage: '请输入有效的生成记录 ID',
  })
  await providerStabilityAPI.verifyFromGeneration(row.id, Number(value))
  ElMessage.success('真实生成证据验证通过')
  await loadAll()
}

onMounted(loadAll)
</script>

<style scoped>
.provider-stability { display: grid; gap: 16px; }
.panel-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.panel-toolbar h3, .panel-toolbar p, .section-title { margin: 0; }
.panel-toolbar p { margin-top: 6px; color: #8d94a3; }
.section-title { margin-top: 12px; font-size: 16px; }
.priority-alert { margin-bottom: 8px; }
small { display: block; margin-top: 4px; color: #8d94a3; }
</style>
