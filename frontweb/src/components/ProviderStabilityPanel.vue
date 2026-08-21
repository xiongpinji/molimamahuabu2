<template>
  <section class="provider-stability" aria-label="供应商稳定性管理">
    <div class="panel-toolbar">
      <div>
        <h3>模型稳定性与自动切换</h3>
        <p>中转关联仅管理员可见；结果未知保持占用且不会自动重试。</p>
      </div>
      <div class="toolbar-actions">
        <el-tag effect="plain">巡检模式：{{ canaryModeLabel }}</el-tag>
        <el-button :loading="loading" @click="loadAll">刷新</el-button>
      </div>
    </div>

    <div class="budget-grid" aria-label="巡检预算">
      <article class="budget-card" data-testid="daily-canary-budget">
        <span>今日巡检预算</span>
        <strong>{{ formatMoney(budget.daily_used_micros) }} / {{ formatMoney(budget.daily_limit_micros) }}</strong>
        <small>
          剩余 {{ formatMoney(budget.daily_remaining_micros) }}；结果未知占用
          {{ formatMoney(budget.daily_unknown_micros) }}
        </small>
        <el-progress :percentage="budgetPercent(budget.daily_used_micros, budget.daily_limit_micros)" :show-text="false" />
      </article>
      <article class="budget-card" data-testid="monthly-canary-budget">
        <span>本月巡检预算</span>
        <strong>{{ formatMoney(budget.monthly_used_micros) }} / {{ formatMoney(budget.monthly_limit_micros) }}</strong>
        <small>
          剩余 {{ formatMoney(budget.monthly_remaining_micros) }}；结果未知占用
          {{ formatMoney(budget.monthly_unknown_micros) }}
        </small>
        <el-progress :percentage="budgetPercent(budget.monthly_used_micros, budget.monthly_limit_micros)" :show-text="false" />
      </article>
    </div>

    <h3 class="section-title">巡检线路状态</h3>
    <div class="table-shell" data-testid="canary-route-table">
      <el-table v-loading="loading" :data="canaryRoutes" stripe>
        <el-table-column prop="logical_model_id" label="逻辑模型" min-width="150" />
        <el-table-column label="用户目录状态" width="130">
          <template #default="{ row }">
            <el-tag :type="row.public_state === 'visible' ? 'success' : 'danger'">
              {{ row.public_state === 'visible' ? '可见' : '已隐藏' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="证据状态" width="130">
          <template #default="{ row }">
            <el-tag :type="evidenceTag(row.evidence_state)">{{ evidenceLabel(row.evidence_state) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近零成本检查" min-width="190">
          <template #default="{ row }">
            <div>{{ zeroCostLabel(row.latest_zero_cost_check) }}</div>
            <small>{{ formatTime(row.latest_zero_cost_check?.checked_at) }}</small>
          </template>
        </el-table-column>
        <el-table-column label="最近真实成功" min-width="170">
          <template #default="{ row }">{{ formatTime(row.latest_real_success_at) }}</template>
        </el-table-column>
        <el-table-column label="证据过期时间" min-width="190">
          <template #default="{ row }">
            <div>{{ formatTime(row.evidence_expires_at) }}</div>
            <el-tag :type="expiryStatus(row.evidence_expires_at).type" size="small">
              {{ expiryStatus(row.evidence_expires_at).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="巡检暂停" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              :type="row.canary_paused ? 'success' : 'warning'"
              :loading="pausingIds.has(row.route_id)"
              @click="toggleCanaryPause(row)"
            >
              {{ row.canary_paused ? '恢复巡检' : '巡检暂停' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <h3 class="section-title">供应商线路与熔断</h3>
    <div class="table-shell" data-testid="provider-route-table">
      <el-table v-loading="loading" :data="configs" stripe>
        <el-table-column prop="logical_model_id" label="逻辑模型" min-width="150" />
        <el-table-column label="关联中转站" min-width="220">
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
        <el-table-column label="供应商成本" min-width="150">
          <template #default="{ row }">{{ routeCostLabel(row.route_cost) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="330" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">策略</el-button>
            <el-button link type="primary" @click="openCost(row)">成本</el-button>
            <el-button link type="primary" @click="resetHealth(row)">重置健康</el-button>
            <el-button link type="success" @click="verifyFromGeneration(row)">生成记录验证</el-button>
            <el-button link :type="row.admin_paused ? 'success' : 'warning'" @click="togglePause(row)">
              {{ row.admin_paused ? '恢复' : '暂停' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="section-heading">
      <div>
        <h3 class="section-title">巡检运行</h3>
        <small>结果未知置顶；“只读对账”只查询已有任务，不创建新提交。</small>
      </div>
      <el-tag v-if="unknownRunCount" type="danger">结果未知 {{ unknownRunCount }}</el-tag>
    </div>
    <div class="run-list" aria-label="巡检运行列表">
      <article
        v-for="run in sortedCanaryRuns"
        :key="run.id"
        class="run-row"
        data-testid="canary-run-row"
      >
        <div class="run-main">
          <div class="run-title">
            <strong>{{ run.id }}</strong>
            <el-tag :type="runStateTag(run.state)" size="small">{{ runStateLabel(run.state) }}</el-tag>
          </div>
          <div>{{ run.logical_model_id || '未关联模型' }} · {{ run.route_name }} · {{ run.service_type }}</div>
          <small>{{ runSafeSummary(run) }}</small>
        </div>
        <div class="run-meta">
          <span>预占 {{ formatMoney(run.cost?.reserved_micros) }}</span>
          <span>实际 {{ run.cost?.actual_micros == null ? '待确认' : formatMoney(run.cost.actual_micros) }}</span>
          <span>{{ formatTime(run.times?.updated_at) }}</span>
        </div>
        <el-button
          v-if="isUnknownRun(run)"
          type="warning"
          plain
          :disabled="!run.reconcilable"
          :loading="reconcilingIds.has(run.id)"
          @click="reconcileRun(run)"
        >
          只读对账
        </el-button>
      </article>
      <el-empty v-if="!sortedCanaryRuns.length && !loading" description="暂无巡检运行" />
    </div>
    <el-button
      v-if="nextCursor"
      class="load-more"
      :loading="loadingMore"
      @click="loadMoreRuns"
    >
      加载更多巡检记录
    </el-button>

    <h3 class="section-title">任务与积分状态</h3>
    <div class="table-shell">
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
    </div>

    <div class="section-heading">
      <h3 class="section-title">告警日志</h3>
      <div class="severity-legend" aria-label="告警等级">
        <el-tag type="danger">P0</el-tag>
        <el-tag type="danger" effect="plain">P1</el-tag>
        <el-tag type="warning">P2</el-tag>
        <el-tag type="info">P3</el-tag>
      </div>
    </div>
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
    <div class="table-shell">
      <el-table :data="normalEvents" size="small" max-height="320">
        <el-table-column label="级别" width="90">
          <template #default="{ row }">
            <el-tag :type="severityTag(row)">{{ severityLabel(row) }}</el-tag>
          </template>
        </el-table-column>
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
    </div>

    <el-dialog v-model="editVisible" title="稳定性策略" width="min(480px, 92vw)">
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

    <el-dialog v-model="costVisible" title="供应商线路成本" width="min(620px, 94vw)">
      <el-alert
        title="用户积分价格与供应商实际成本相互独立"
        description="此处仅用于后台核算实际供应商成本，不会修改前端用户积分定价。"
        type="info"
        :closable="false"
        show-icon
      />
      <el-form class="cost-form" label-width="128px">
        <el-form-item label="计费单位">
          <el-select v-model="costForm.cost_unit">
            <el-option label="每次请求" value="request" />
            <el-option label="每张图片" value="image" />
            <el-option label="每秒视频" value="second" />
            <el-option label="Token" value="token" />
          </el-select>
        </el-form-item>
        <template v-if="costForm.cost_unit === 'token'">
          <el-form-item label="输入/千 Token">
            <el-input-number v-model="costForm.input_yuan" :min="0" :precision="6" :step="0.001" />
          </el-form-item>
          <el-form-item label="输出/千 Token">
            <el-input-number v-model="costForm.output_yuan" :min="0" :precision="6" :step="0.001" />
          </el-form-item>
        </template>
        <el-form-item v-else label="基础单价（元）">
          <el-input-number v-model="costForm.unit_yuan" :min="0.000001" :precision="6" :step="0.01" />
        </el-form-item>
        <el-form-item v-if="costForm.cost_unit !== 'token'" label="分辨率档位">
          <div class="resolution-costs">
            <div v-for="(tier, index) in costForm.resolution_prices" :key="index" class="resolution-cost-row">
              <el-input v-model="tier.resolution" placeholder="例如 720p / 2k" maxlength="32" />
              <el-input-number v-model="tier.yuan" :min="0.000001" :precision="6" :step="0.01" />
              <el-button link type="danger" @click="removeResolutionCost(index)">删除</el-button>
            </div>
            <el-button @click="addResolutionCost">添加档位</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="costVisible = false">取消</el-button>
        <el-button type="primary" :loading="costSaving" @click="saveRouteCost">保存成本</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { providerStabilityAPI } from '@/api/providerStability'

const loading = ref(false)
const loadingMore = ref(false)
const saving = ref(false)
const configs = ref([])
const requests = ref([])
const events = ref([])
const canarySummary = ref({ mode: 'off', budget: {}, routes: [] })
const canaryRuns = ref([])
const nextCursor = ref(null)
const reconcilingIds = ref(new Set())
const pausingIds = ref(new Set())
const editVisible = ref(false)
const editingId = ref(null)
const editForm = ref({ logical_model_id: '', priority: 0, failover_enabled: false })
const costVisible = ref(false)
const costSaving = ref(false)
const costEditingId = ref(null)
const costForm = ref({
  cost_unit: 'request',
  unit_yuan: 0.000001,
  input_yuan: 0,
  output_yuan: 0,
  resolution_prices: [],
})

const unknownStates = new Set(['submission_unknown', 'result_unknown', 'artifact_unreadable'])
const priorityTypes = new Set(['route_opened', 'provider_request_needs_attention', 'provider_artifact_unreadable'])
const budget = computed(() => canarySummary.value?.budget || {})
const canaryRoutes = computed(() => canarySummary.value?.routes || [])
const canaryModeLabel = computed(() => ({ off: '关闭', shadow: '影子', enforce: '强制门禁' })[
  canarySummary.value?.mode
] || '关闭')
const priorityEvents = computed(() => events.value.filter((event) => (
  ['P0', 'P1'].includes(severityLabel(event)) || priorityTypes.has(event.event_type)
)))
const normalEvents = computed(() => events.value.filter((event) => !priorityEvents.value.includes(event)))
const sortedCanaryRuns = computed(() => [...canaryRuns.value].sort((left, right) => {
  const unknownOrder = Number(isUnknownRun(right)) - Number(isUnknownRun(left))
  if (unknownOrder) return unknownOrder
  return String(right.times?.updated_at || '').localeCompare(String(left.times?.updated_at || ''))
}))
const unknownRunCount = computed(() => canaryRuns.value.filter(isUnknownRun).length)

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN')
}

function formatMoney(value) {
  const amount = Number(value)
  return `¥${(Number.isFinite(amount) ? amount / 1_000_000 : 0).toFixed(2)}`
}

function microsToYuan(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount / 1_000_000 : 0
}

function yuanToMicros(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('请输入有效的供应商成本')
  const micros = Math.round(amount * 1_000_000)
  if (!Number.isSafeInteger(micros)) throw new Error('供应商成本超出安全范围')
  return micros
}

function routeCostLabel(cost) {
  if (!cost) return '未配置'
  if (cost.cost_unit === 'token') {
    return `输入 ${formatMoney(cost.input_cost_micros_per_1k)} / 输出 ${formatMoney(cost.output_cost_micros_per_1k)}`
  }
  const unit = ({ request: '次', image: '张', second: '秒' })[cost.cost_unit] || cost.cost_unit
  return `${formatMoney(cost.micros_per_unit)} / ${unit}`
}

function budgetPercent(used, limit) {
  const total = Number(limit)
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((Number(used) || 0) / total * 100)))
}

function healthLabel(state) {
  return ({ healthy: '健康', degraded: '降级', open: '已熔断', half_open: '半开', disabled: '已停用' })[state] || '未知'
}

function healthTag(state) {
  return ({ healthy: 'success', degraded: 'warning', open: 'danger', half_open: 'warning', disabled: 'info' })[state] || 'info'
}

function evidenceLabel(state) {
  return ({
    fresh: '新鲜', stale: '已过期', failing: '失败', submission_unknown: '结果未知',
    budget_blocked: '预算阻断', disabled: '已停用', never_verified: '未验证',
  })[state] || '未知'
}

function evidenceTag(state) {
  return ({ fresh: 'success', stale: 'danger', failing: 'danger', submission_unknown: 'danger', budget_blocked: 'warning', disabled: 'info' })[state] || 'info'
}

function zeroCostLabel(check) {
  if (!check) return '尚未检查'
  const label = ({ healthy: '正常', degraded: '异常', failed: '失败' })[check.state] || '未知'
  return check.category ? `${label} · ${check.category}` : label
}

function expiryStatus(value) {
  const expiry = Date.parse(value || '')
  if (!Number.isFinite(expiry)) return { label: '无新鲜证据', type: 'info' }
  const remaining = expiry - Date.now()
  if (remaining <= 0) return { label: '已过期', type: 'danger' }
  const minutes = Math.max(1, Math.ceil(remaining / 60_000))
  const label = minutes >= 60 ? `剩余 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `剩余 ${minutes} 分`
  return { label, type: minutes <= 360 ? 'warning' : 'success' }
}

function severityLabel(event) {
  if (['P0', 'P1', 'P2', 'P3'].includes(event?.alert_level)) return event.alert_level
  return event?.severity === 'critical' ? 'P0'
    : event?.severity === 'error' || priorityTypes.has(event?.event_type) ? 'P1'
      : event?.severity === 'info' ? 'P3' : 'P2'
}

function severityTag(event) {
  return ({ P0: 'danger', P1: 'danger', P2: 'warning', P3: 'info' })[severityLabel(event)] || 'info'
}

function safeDetails(event) {
  const details = event?.safe_details
  if (!details || typeof details !== 'object') return '无可展示摘要'
  return Object.entries(details).map(([key, value]) => `${key}: ${String(value)}`).join('；') || '无可展示摘要'
}

function isUnknownRun(run) {
  return unknownStates.has(run?.state)
}

function runStateLabel(state) {
  return ({
    reserved: '已预占', submitting: '提交中', accepted: '已受理', verifying: '验证中',
    succeeded: '成功', failed: '失败', submission_unknown: '结果未知',
    result_unknown: '结果未知', artifact_unreadable: '结果未知', budget_blocked: '预算阻断',
  })[state] || state || '未知'
}

function runStateTag(state) {
  if (isUnknownRun({ state }) || state === 'failed') return 'danger'
  if (state === 'succeeded') return 'success'
  if (state === 'budget_blocked') return 'warning'
  return 'info'
}

function runSafeSummary(run) {
  const parts = []
  if (run.error_category) parts.push(`分类：${run.error_category}`)
  const capability = run.capability
  if (capability && typeof capability === 'object') {
    for (const key of ['resolution', 'aspectRatio', 'duration', 'referenceImageCount', 'referenceVideoCount', 'referenceAudioCount']) {
      if (capability[key] != null) parts.push(`${key}: ${String(capability[key])}`)
    }
  }
  return parts.join('；') || '无异常安全摘要'
}

function showError(error, fallback) {
  if (error?.config && !error.config.silentError) return
  ElMessage.error(error?.message || fallback)
}

async function loadAll() {
  loading.value = true
  try {
    const [routeData, eventData, summaryData, runData] = await Promise.all([
      providerStabilityAPI.listRoutes(),
      providerStabilityAPI.listEvents(),
      providerStabilityAPI.getCanarySummary(),
      providerStabilityAPI.listCanaryRuns({ limit: 50 }),
    ])
    configs.value = routeData?.configs || []
    requests.value = routeData?.requests || []
    events.value = eventData || []
    canarySummary.value = summaryData || { mode: 'off', budget: {}, routes: [] }
    canaryRuns.value = runData?.items || []
    nextCursor.value = runData?.pagination?.next_cursor || null
  } catch (error) {
    showError(error, '稳定性巡检数据加载失败')
  } finally {
    loading.value = false
  }
}

async function loadMoreRuns() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const page = await providerStabilityAPI.listCanaryRuns({ limit: 50, before: nextCursor.value })
    const known = new Set(canaryRuns.value.map((run) => run.id))
    const additions = []
    for (const run of page?.items || []) {
      if (known.has(run.id)) continue
      known.add(run.id)
      additions.push(run)
    }
    canaryRuns.value = [...canaryRuns.value, ...additions]
    nextCursor.value = page?.pagination?.next_cursor || null
  } catch (error) {
    showError(error, '加载更多巡检记录失败')
  } finally {
    loadingMore.value = false
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

async function openCost(row) {
  costEditingId.value = row.id
  try {
    const cost = await providerStabilityAPI.getRouteCost(row.id)
    const unit = cost?.cost_unit || ({ video: 'second', image: 'image' })[row.service_type] || 'request'
    costForm.value = {
      cost_unit: unit,
      unit_yuan: Math.max(0.000001, microsToYuan(cost?.micros_per_unit)),
      input_yuan: microsToYuan(cost?.input_cost_micros_per_1k),
      output_yuan: microsToYuan(cost?.output_cost_micros_per_1k),
      resolution_prices: Object.entries(cost?.resolution_prices || {}).map(([resolution, tier]) => ({
        resolution,
        yuan: microsToYuan(tier?.micros_per_unit),
      })),
    }
    costVisible.value = true
  } catch (error) {
    showError(error, '供应商线路成本加载失败')
  }
}

function addResolutionCost() {
  costForm.value.resolution_prices.push({ resolution: '', yuan: 0.000001 })
}

function removeResolutionCost(index) {
  costForm.value.resolution_prices.splice(index, 1)
}

async function saveRouteCost() {
  costSaving.value = true
  try {
    const tiers = {}
    for (const tier of costForm.value.resolution_prices) {
      const resolution = String(tier.resolution || '').trim().toLowerCase()
      if (!resolution || Object.prototype.hasOwnProperty.call(tiers, resolution)) {
        throw new Error('分辨率档位不能为空或重复')
      }
      tiers[resolution] = { micros_per_unit: yuanToMicros(tier.yuan) }
    }
    const token = costForm.value.cost_unit === 'token'
    await providerStabilityAPI.updateRouteCost(costEditingId.value, {
      currency: 'CNY',
      cost_unit: costForm.value.cost_unit,
      micros_per_unit: token ? 0 : yuanToMicros(costForm.value.unit_yuan),
      input_cost_micros_per_1k: token ? yuanToMicros(costForm.value.input_yuan) : 0,
      output_cost_micros_per_1k: token ? yuanToMicros(costForm.value.output_yuan) : 0,
      resolution_prices: token ? {} : tiers,
    })
    costVisible.value = false
    ElMessage.success('供应商线路成本已保存')
    await loadAll()
  } catch (error) {
    showError(error, '供应商线路成本保存失败')
  } finally {
    costSaving.value = false
  }
}

async function savePolicy() {
  saving.value = true
  try {
    await providerStabilityAPI.updateRoute(editingId.value, editForm.value)
    editVisible.value = false
    ElMessage.success('稳定性策略已保存')
    await loadAll()
  } catch (error) {
    showError(error, '稳定性策略保存失败')
  } finally {
    saving.value = false
  }
}

async function togglePause(row) {
  try {
    await providerStabilityAPI.updateRoute(row.id, { admin_paused: !row.admin_paused })
    ElMessage.success(row.admin_paused ? '中转已恢复' : '中转已暂停')
    await loadAll()
  } catch (error) {
    showError(error, '中转状态更新失败')
  }
}

async function toggleCanaryPause(row) {
  const pausing = !row.canary_paused
  try {
    await ElMessageBox.confirm(
      pausing
        ? '证据失效后模型可能从用户目录隐藏。确认暂停该线路巡检？'
        : '确认恢复该线路巡检？恢复不会绕过新鲜证据门禁。',
      pausing ? '巡检暂停' : '恢复巡检',
      { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' },
    )
  } catch (_) {
    return
  }
  pausingIds.value = new Set(pausingIds.value).add(row.route_id)
  try {
    await providerStabilityAPI.updateRoute(row.route_id, { canary_paused: pausing })
    ElMessage.success(pausing ? '巡检已暂停' : '巡检已恢复')
    await loadAll()
  } catch (error) {
    showError(error, '巡检暂停状态更新失败')
  } finally {
    const next = new Set(pausingIds.value)
    next.delete(row.route_id)
    pausingIds.value = next
  }
}

async function reconcileRun(run) {
  if (!run.reconcilable || reconcilingIds.value.has(run.id)) return
  reconcilingIds.value = new Set(reconcilingIds.value).add(run.id)
  try {
    const result = await providerStabilityAPI.reconcileCanaryRun(run.id)
    canaryRuns.value = canaryRuns.value.map((item) => item.id === run.id
      ? { ...item, ...result }
      : item)
    ElMessage.success(result?.reconciled ? '对账已完成' : '仍为结果未知，未重试')
    const summary = await providerStabilityAPI.getCanarySummary()
    canarySummary.value = summary || canarySummary.value
  } catch (error) {
    showError(error, '巡检对账失败')
  } finally {
    const next = new Set(reconcilingIds.value)
    next.delete(run.id)
    reconcilingIds.value = next
  }
}

async function resetHealth(row) {
  try {
    await ElMessageBox.confirm(`确认重置 ${row.name} 的健康状态？`, '重置健康', { type: 'warning' })
    await providerStabilityAPI.resetHealth(row.id)
    ElMessage.success('健康状态已重置并写入审计')
    await loadAll()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') showError(error, '重置健康失败')
  }
}

async function verifyFromGeneration(row) {
  try {
    const { value } = await ElMessageBox.prompt('请输入该配置真实成功且产物可读的生成记录 ID', '生成记录验证', {
      inputPattern: /^\d+$/,
      inputErrorMessage: '请输入有效的生成记录 ID',
    })
    await providerStabilityAPI.verifyFromGeneration(row.id, Number(value))
    ElMessage.success('真实生成证据验证通过')
    await loadAll()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') showError(error, '生成记录验证失败')
  }
}

onMounted(loadAll)
</script>

<style scoped>
.provider-stability {
  display: grid;
  gap: 16px;
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
}
.provider-stability * { box-sizing: border-box; }
.panel-toolbar, .section-heading, .toolbar-actions, .run-title, .run-meta, .severity-legend {
  display: flex;
  align-items: center;
  gap: 12px;
}
.panel-toolbar, .section-heading { justify-content: space-between; }
.panel-toolbar h3, .panel-toolbar p, .section-title { margin: 0; }
.panel-toolbar p { margin-top: 6px; color: #8d94a3; }
.budget-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.budget-card {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--el-fill-color-extra-light);
}
.budget-card strong { font-size: 20px; }
.section-title { margin-top: 12px; font-size: 16px; }
.table-shell { min-width: 0; max-width: 100%; overflow-x: auto; }
.run-list { display: grid; gap: 10px; min-width: 0; }
.run-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 16px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
}
.run-main, .run-main > div, .run-meta { min-width: 0; }
.run-main > div { overflow-wrap: anywhere; }
.run-meta { flex-wrap: wrap; color: #8d94a3; font-size: 12px; }
.load-more { justify-self: center; }
.priority-alert { margin-bottom: 8px; }
.cost-form { margin-top: 16px; }
.resolution-costs { display: grid; gap: 8px; width: 100%; }
.resolution-cost-row { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(150px, 1fr) auto; gap: 8px; }
small { display: block; margin-top: 4px; color: #8d94a3; }

@media (max-width: 760px) {
  .provider-stability {
    max-height: calc(100dvh - 170px);
    overflow-y: auto;
    padding-right: 2px;
  }
  .panel-toolbar, .section-heading { align-items: flex-start; flex-direction: column; }
  .toolbar-actions { width: 100%; justify-content: space-between; }
  .budget-grid { grid-template-columns: minmax(0, 1fr); }
  .run-row { grid-template-columns: minmax(0, 1fr); }
  .run-meta { display: grid; gap: 4px; }
  .resolution-cost-row { grid-template-columns: minmax(0, 1fr); }
}
</style>
