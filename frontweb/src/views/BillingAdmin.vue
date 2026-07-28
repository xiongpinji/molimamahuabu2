<template>
  <AdminWorkspaceShell
    title="运营与计费"
    header-title="平台管理后台"
    eyebrow="平台运营控制台"
    :description="isSuperAdmin
      ? '统一管理兑换码、积分流水、成本利润、对账和每个模型的独立计费规则。'
      : '生成、查询和停用平台兑换码。'"
  >
    <section v-if="requiresAdminToken && !unlocked" class="unlock-panel" aria-labelledby="unlock-title">
      <div>
        <p class="panel-kicker">敏感操作保护</p>
        <h2 id="unlock-title">验证管理员身份</h2>
        <p>令牌仅保存在当前浏览器会话，用于调用现有平台管理接口。</p>
      </div>
      <div class="admin-auth">
        <el-input
          v-model="adminToken"
          type="password"
          show-password
          autocomplete="off"
          placeholder="输入平台管理员令牌"
        />
        <el-button type="primary" :loading="loading" @click="unlock">验证并读取</el-button>
      </div>
      <el-alert
        title="管理员令牌只保存在当前浏览器会话，不会写入长期存储。"
        type="info"
        :closable="false"
      />
    </section>

    <template v-else>
      <section v-if="isSuperAdmin" class="billing-summary" aria-label="运营概览">
        <article>
          <span>计费模型</span>
          <strong>{{ prices.length }}</strong>
        </article>
        <article>
          <span>平台账号</span>
          <strong>{{ users.length }}</strong>
        </article>
        <article>
          <span>工作区</span>
          <strong>{{ tenants.length }}</strong>
        </article>
        <article>
          <span>积分流水</span>
          <strong>{{ transactions.length }}</strong>
        </article>
      </section>

      <el-tabs v-model="activeTab" class="admin-tabs">
        <el-tab-pane v-if="isSuperAdmin" label="模型计费" name="models">
          <section class="panel">
            <div class="panel-heading">
              <div>
                <h2>模型计费</h2>
                <p>自动汇总 AI 配置中的实际模型；每个模型单独设置积分、类型和启停状态。</p>
              </div>
            </div>
            <div class="model-pricing-summary" aria-label="模型计费状态">
              <el-tag type="success">已定价 {{ configuredModelCount }}</el-tag>
              <el-tag type="warning">未定价 {{ unconfiguredModelCount }}</el-tag>
              <el-tag type="info">已停用 {{ disabledModelCount }}</el-tag>
            </div>
            <div class="model-filters">
              <el-input
                v-model.trim="modelSearch"
                clearable
                placeholder="搜索模型名称或 ID"
              />
              <el-select v-model="modelCategory" aria-label="模型类型筛选">
                <el-option label="全部类型" value="all" />
                <el-option label="文本" value="text" />
                <el-option label="图片" value="image" />
                <el-option label="视频" value="video" />
                <el-option label="音频" value="audio" />
                <el-option label="其他" value="other" />
              </el-select>
              <el-select v-model="modelPricingState" aria-label="计费状态筛选">
                <el-option label="全部状态" value="all" />
                <el-option label="已定价" value="configured" />
                <el-option label="未定价" value="unconfigured" />
                <el-option label="已停用" value="disabled" />
              </el-select>
            </div>
            <div class="model-list">
              <div v-for="item in filteredPrices" :key="item.model" class="model-row">
                <label class="model-field"><span>展示名称</span><el-input v-model="item.display_name" /></label>
                <label class="model-field">
                  <span>模型类型</span>
                  <el-select v-model="item.category">
                    <el-option label="文本" value="text" />
                    <el-option label="图片" value="image" />
                    <el-option label="视频" value="video" />
                    <el-option label="音频" value="audio" />
                    <el-option label="其他" value="other" />
                  </el-select>
                </label>
                <label class="model-field">
                  <span>用户收费（积分）</span>
                  <el-input-number v-model="item.credits" :min="1" :step="1" step-strictly />
                </label>
                <label class="model-field">
                  <span>计费状态</span>
                  <el-select v-model="item.status">
                    <el-option label="启用" value="enabled" />
                    <el-option label="停用" value="disabled" />
                  </el-select>
                </label>
                <el-button :loading="savingModel === item.model" @click="saveModel(item)">保存</el-button>
                <small>
                  {{ item.model }}
                  <el-tag v-if="!item.configured" type="warning" size="small">未定价</el-tag>
                </small>
                <div class="cost-editor">
                  <span>API 成本</span>
                  <el-select v-model="item.cost_unit">
                    <el-option label="按次" value="request" />
                    <el-option label="按张" value="image" />
                    <el-option label="按秒" value="second" />
                    <el-option label="按 Token" value="token" />
                  </el-select>
                  <template v-if="item.cost_unit === 'token'">
                    <el-input-number v-model="item.input_cost_yuan_per_1k" :min="0" :precision="6" :step="0.001" />
                    <span>元 / 千输入 Token</span>
                    <el-input-number v-model="item.output_cost_yuan_per_1k" :min="0" :precision="6" :step="0.001" />
                    <span>元 / 千输出 Token</span>
                  </template>
                  <template v-else>
                    <el-input-number v-model="item.cost_yuan_per_unit" :min="0" :precision="6" :step="0.01" />
                    <span>元 / {{ costUnitLabel(item.cost_unit) }}</span>
                  </template>
                </div>
              </div>
              <el-empty v-if="filteredPrices.length === 0" description="没有匹配的模型" />
            </div>
            <div class="new-model">
              <label class="model-field"><span>模型 ID</span><el-input v-model.trim="newModel.model" /></label>
              <label class="model-field"><span>展示名称</span><el-input v-model.trim="newModel.display_name" /></label>
              <label class="model-field">
                <span>模型类型</span>
                <el-select v-model="newModel.category">
                  <el-option label="文本" value="text" />
                  <el-option label="图片" value="image" />
                  <el-option label="视频" value="video" />
                  <el-option label="音频" value="audio" />
                  <el-option label="其他" value="other" />
                </el-select>
              </label>
              <label class="model-field"><span>用户收费（积分）</span><el-input-number v-model="newModel.credits" :min="1" :step="1" step-strictly /></label>
              <label class="model-field">
                <span>平台成本单位</span>
                <el-select v-model="newModel.cost_unit">
                  <el-option label="按次成本" value="request" />
                  <el-option label="按张成本" value="image" />
                  <el-option label="按秒成本" value="second" />
                  <el-option label="按 Token 成本" value="token" />
                </el-select>
              </label>
              <template v-if="newModel.cost_unit === 'token'">
                <label class="model-field"><span>千输入 Token 成本（元）</span><el-input-number v-model="newModel.input_cost_yuan_per_1k" :min="0" :precision="6" :step="0.001" /></label>
                <label class="model-field"><span>千输出 Token 成本（元）</span><el-input-number v-model="newModel.output_cost_yuan_per_1k" :min="0" :precision="6" :step="0.001" /></label>
              </template>
              <label v-else class="model-field"><span>单位成本（元）</span><el-input-number v-model="newModel.cost_yuan_per_unit" :min="0" :precision="6" :step="0.01" /></label>
              <el-button type="primary" :loading="savingModel === newModel.model" @click="addModel">
                新增模型
              </el-button>
            </div>
          </section>
        </el-tab-pane>

        <el-tab-pane v-if="isSuperAdmin" label="经营台账" name="ledger">
          <section class="panel">
            <div class="panel-heading ledger-heading">
              <div>
                <h2>经营台账</h2>
                <p>按模型核算积分消耗、API 成本与预计利润；文本及推理模型按输入、输出 Token 统计。</p>
              </div>
              <div class="ledger-controls">
                <el-select v-model="ledgerPeriod" @change="loadLedgerReport">
                  <el-option label="日报" value="day" />
                  <el-option label="月报" value="month" />
                  <el-option label="年报" value="year" />
                </el-select>
                <el-input-number
                  v-model="creditValueYuan"
                  :min="0"
                  :precision="6"
                  :step="0.01"
                  aria-label="每积分估值"
                />
                <span>元 / 积分</span>
                <el-button :loading="savingLedgerSettings" @click="saveLedgerSettings">保存估值</el-button>
              </div>
            </div>
            <el-alert
              title="收入与利润为估算值：预计收入 = 消耗积分 × 每积分估值；推理 Token 已包含在输出 Token 中，不重复计费。"
              type="info"
              :closable="false"
            />
            <div class="ledger-summary">
              <article><span>调用量</span><strong>{{ ledgerReport.summary.usage_count }}</strong></article>
              <article><span>消耗积分</span><strong>{{ ledgerReport.summary.credits_consumed }}</strong></article>
              <article><span>API 成本</span><strong>{{ formatMoney(ledgerReport.summary.cost_micros) }}</strong></article>
              <article><span>预计利润</span><strong>{{ formatMoney(ledgerReport.summary.estimated_profit_micros) }}</strong></article>
            </div>
            <el-table :data="ledgerReport.rows" empty-text="暂无已完成的生成记录">
              <el-table-column prop="period" label="周期" width="110" />
              <el-table-column prop="model" label="模型" min-width="180" />
              <el-table-column prop="resource_type" label="类型" width="100" />
              <el-table-column prop="usage_count" label="调用量" width="90" />
              <el-table-column prop="credits_consumed" label="消耗积分" width="100" />
              <el-table-column prop="input_tokens" label="输入 Token" width="120" />
              <el-table-column prop="output_tokens" label="输出 Token" width="120" />
              <el-table-column prop="reasoning_tokens" label="推理 Token" width="120" />
              <el-table-column label="API 成本" width="120">
                <template #default="{ row }">{{ formatMoney(row.cost_micros) }}</template>
              </el-table-column>
              <el-table-column label="预计收入" width="120">
                <template #default="{ row }">{{ formatMoney(row.estimated_revenue_micros) }}</template>
              </el-table-column>
              <el-table-column label="预计利润" width="120">
                <template #default="{ row }">{{ formatMoney(row.estimated_profit_micros) }}</template>
              </el-table-column>
              <el-table-column prop="uncosted_usage_count" label="未取得用量" width="110" />
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane label="兑换码" name="codes">
          <RedeemOperationsPanel :users="users" :tenants="tenants" />
        </el-tab-pane>

        <el-tab-pane v-if="isSuperAdmin" label="账号管理" name="accounts">
          <section class="panel">
            <el-table :data="users" empty-text="暂无账号">
              <el-table-column prop="email" label="邮箱" min-width="230" />
              <el-table-column label="平台角色" width="150">
                <template #default="{ row }">
                  <el-select v-model="row.role">
                    <el-option label="用户" value="user" />
                    <el-option label="总管理员" value="admin" />
                    <el-option label="兑换码管理员" value="redeem_admin" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="150">
                <template #default="{ row }">
                  <el-select v-model="row.status">
                    <el-option label="启用" value="active" />
                    <el-option label="停用" value="disabled" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column prop="tenant_count" label="工作区" width="90" />
              <el-table-column label="操作" width="100" align="right">
                <template #default="{ row }">
                  <el-button :loading="savingUser === row.id" @click="saveUser(row)">保存</el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane v-if="isSuperAdmin" label="积分流水" name="credits">
          <section class="panel">
            <div class="credit-form">
              <el-select v-model="creditForm.tenant_id" filterable placeholder="选择工作区">
                <el-option
                  v-for="tenant in tenants"
                  :key="tenant.id"
                  :label="`${tenant.name}（余额 ${tenant.available}）`"
                  :value="tenant.id"
                />
              </el-select>
              <el-input-number v-model="creditForm.amount" :step="100" step-strictly />
              <el-input v-model.trim="creditForm.reason" placeholder="调账原因" />
              <el-button type="primary" :loading="adjustingCredits" @click="submitAdjustment">确认调账</el-button>
            </div>
            <p class="field-hint">正数增加积分，负数扣回积分；扣回后余额不能小于零。</p>
            <el-table :data="transactions" empty-text="暂无积分流水">
              <el-table-column prop="tenant_name" label="工作区" min-width="160" />
              <el-table-column prop="amount" label="变动" width="100" />
              <el-table-column prop="reason" label="原因" min-width="200" />
              <el-table-column prop="event_type" label="类型" width="120" />
              <el-table-column label="时间" min-width="180">
                <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
              </el-table-column>
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane v-if="isSuperAdmin" label="积分对账" name="reconciliation">
          <BillingReconciliationPanel />
        </el-tab-pane>
      </el-tabs>
    </template>
  </AdminWorkspaceShell>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import AdminWorkspaceShell from '@/components/AdminWorkspaceShell.vue'
import RedeemOperationsPanel from '@/components/RedeemOperationsPanel.vue'
import BillingReconciliationPanel from '@/components/BillingReconciliationPanel.vue'
import {
  adjustTenantCredits,
  getLedgerReport,
  getLedgerSettings,
  listAdminCreditTransactions,
  listAdminTenants,
  listModelPrices,
  listPlatformUsers,
  updateModelPrice,
  updateLedgerSettings,
  updatePlatformUser,
} from '@/api/billing'
import { readSession, saveAdminToken } from '@/utils/authSession'

const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const route = useRoute()
const sessionRole = readSession()?.user?.role
const isSuperAdmin = sessionRole ? sessionRole === 'admin' : !publicMode
const requiresAdminToken = isSuperAdmin && publicMode && !sessionRole
const adminToken = ref('')
const loading = ref(false)
const unlocked = ref(!requiresAdminToken)
const requestedTab = String(route.query.tab || '')
const requestedModel = String(route.query.model || '').trim()
const activeTab = ref(isSuperAdmin && ['models', 'ledger', 'codes', 'users', 'transactions', 'reconciliation'].includes(requestedTab)
  ? requestedTab
  : (isSuperAdmin ? 'models' : 'codes'))
const prices = ref([])
const users = ref([])
const tenants = ref([])
const transactions = ref([])
const savingModel = ref('')
const savingUser = ref('')
const adjustingCredits = ref(false)
const modelSearch = ref(requestedModel)
const modelCategory = ref('all')
const modelPricingState = ref('all')
const ledgerPeriod = ref('day')
const creditValueYuan = ref(0)
const savingLedgerSettings = ref(false)
const emptyLedgerReport = () => ({
  summary: {
    usage_count: 0,
    credits_consumed: 0,
    cost_micros: 0,
    estimated_revenue_micros: 0,
    estimated_profit_micros: 0,
    uncosted_usage_count: 0,
  },
  rows: [],
})
const ledgerReport = ref(emptyLedgerReport())
const newModel = reactive({
  model: '',
  display_name: '',
  category: 'video',
  credits: 1,
  cost_unit: 'request',
  cost_yuan_per_unit: 0,
  input_cost_yuan_per_1k: 0,
  output_cost_yuan_per_1k: 0,
})
const creditForm = reactive({
  tenant_id: '',
  amount: 100,
  reason: '',
})

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '永久'
}

function microsToYuan(value) {
  return Number(value || 0) / 1_000_000
}

function yuanToMicros(value) {
  return Math.round(Number(value || 0) * 1_000_000)
}

function formatMoney(value) {
  return `¥${microsToYuan(value).toFixed(4)}`
}

function costUnitLabel(value) {
  return { request: '次', image: '张', second: '秒', token: '千 Token' }[value] || '次'
}

function normalizePrice(item) {
  return {
    ...item,
    configured: item.credits != null && item.status !== 'unconfigured',
    status: item.status === 'unconfigured' ? 'enabled' : item.status,
    cost_yuan_per_unit: microsToYuan(item.cost_micros_per_unit),
    input_cost_yuan_per_1k: microsToYuan(item.input_cost_micros_per_1k),
    output_cost_yuan_per_1k: microsToYuan(item.output_cost_micros_per_1k),
  }
}

const configuredModelCount = computed(() => prices.value.filter(
  (item) => item.configured && item.status === 'enabled',
).length)
const unconfiguredModelCount = computed(() => prices.value.filter((item) => !item.configured).length)
const disabledModelCount = computed(() => prices.value.filter(
  (item) => item.configured && item.status === 'disabled',
).length)
const filteredPrices = computed(() => {
  const query = modelSearch.value.toLowerCase()
  return prices.value.filter((item) => {
    const matchesSearch = !query
      || String(item.model).toLowerCase().includes(query)
      || String(item.display_name || '').toLowerCase().includes(query)
    const matchesCategory = modelCategory.value === 'all' || item.category === modelCategory.value
    const matchesState = modelPricingState.value === 'all'
      || (modelPricingState.value === 'configured' && item.configured && item.status === 'enabled')
      || (modelPricingState.value === 'unconfigured' && !item.configured)
      || (modelPricingState.value === 'disabled' && item.configured && item.status === 'disabled')
    return matchesSearch && matchesCategory && matchesState
  })
})

async function loadAll() {
  if (!isSuperAdmin) return
  const [modelRows, userRows, tenantRows, transactionRows, ledgerSettings, report] = await Promise.all([
    listModelPrices(),
    listPlatformUsers(),
    listAdminTenants(),
    listAdminCreditTransactions(),
    getLedgerSettings(),
    getLedgerReport(ledgerPeriod.value),
  ])
  prices.value = modelRows.map(normalizePrice)
  users.value = userRows
  tenants.value = tenantRows
  transactions.value = transactionRows
  creditValueYuan.value = microsToYuan(ledgerSettings.credit_value_micros)
  ledgerReport.value = {
    ...emptyLedgerReport(),
    ...report,
    summary: { ...emptyLedgerReport().summary, ...(report?.summary || {}) },
    rows: Array.isArray(report?.rows) ? report.rows : [],
  }
  if (!creditForm.tenant_id) creditForm.tenant_id = tenantRows[0]?.id || ''
}

async function unlock() {
  if (!isSuperAdmin) return
  if (adminToken.value.length < 32) return ElMessage.warning('管理员令牌长度不能少于 32 位')
  saveAdminToken(adminToken.value)
  loading.value = true
  try {
    await loadAll()
    unlocked.value = true
  } finally {
    loading.value = false
  }
}

async function saveModel(item) {
  if (!Number.isSafeInteger(Number(item.credits)) || Number(item.credits) <= 0) {
    return ElMessage.warning('请填写正整数积分')
  }
  savingModel.value = item.model
  try {
    const saved = await updateModelPrice(item.model, {
      credits: item.credits,
      display_name: item.display_name,
      category: item.category,
      status: item.status === 'unconfigured' ? 'enabled' : item.status,
      cost_unit: item.cost_unit,
      cost_micros_per_unit: yuanToMicros(item.cost_yuan_per_unit),
      input_cost_micros_per_1k: yuanToMicros(item.input_cost_yuan_per_1k),
      output_cost_micros_per_1k: yuanToMicros(item.output_cost_yuan_per_1k),
    })
    Object.assign(item, normalizePrice(saved), { configured: true })
    ElMessage.success(`${saved.display_name || saved.model} 已保存`)
  } finally {
    savingModel.value = ''
  }
}

async function addModel() {
  if (!newModel.model) return ElMessage.warning('请填写模型 ID')
  savingModel.value = newModel.model
  try {
    const saved = await updateModelPrice(newModel.model, {
      credits: newModel.credits,
      display_name: newModel.display_name || newModel.model,
      category: newModel.category,
      status: 'enabled',
      cost_unit: newModel.cost_unit,
      cost_micros_per_unit: yuanToMicros(newModel.cost_yuan_per_unit),
      input_cost_micros_per_1k: yuanToMicros(newModel.input_cost_yuan_per_1k),
      output_cost_micros_per_1k: yuanToMicros(newModel.output_cost_yuan_per_1k),
    })
    const index = prices.value.findIndex((item) => item.model === saved.model)
    if (index >= 0) prices.value[index] = { ...normalizePrice(saved), configured: true }
    else prices.value.push({ ...normalizePrice(saved), configured: true })
    Object.assign(newModel, {
      model: '',
      display_name: '',
      category: 'video',
      credits: 1,
      cost_unit: 'request',
      cost_yuan_per_unit: 0,
      input_cost_yuan_per_1k: 0,
      output_cost_yuan_per_1k: 0,
    })
    ElMessage.success('模型计费规则已新增')
  } finally {
    savingModel.value = ''
  }
}

async function loadLedgerReport() {
  const report = await getLedgerReport(ledgerPeriod.value)
  ledgerReport.value = {
    ...emptyLedgerReport(),
    ...report,
    summary: { ...emptyLedgerReport().summary, ...(report?.summary || {}) },
    rows: Array.isArray(report?.rows) ? report.rows : [],
  }
}

async function saveLedgerSettings() {
  savingLedgerSettings.value = true
  try {
    const saved = await updateLedgerSettings({
      credit_value_micros: yuanToMicros(creditValueYuan.value),
    })
    creditValueYuan.value = microsToYuan(saved.credit_value_micros)
    await loadLedgerReport()
    ElMessage.success('每积分估值已保存')
  } finally {
    savingLedgerSettings.value = false
  }
}

async function saveUser(row) {
  savingUser.value = row.id
  try {
    const saved = await updatePlatformUser(row.id, { role: row.role, status: row.status })
    Object.assign(row, saved)
    ElMessage.success('账号状态已保存')
  } finally {
    savingUser.value = ''
  }
}

async function submitAdjustment() {
  if (!creditForm.tenant_id || !creditForm.amount || !creditForm.reason) {
    return ElMessage.warning('请选择工作区并填写非零积分和调账原因')
  }
  adjustingCredits.value = true
  try {
    await adjustTenantCredits(creditForm.tenant_id, {
      amount: creditForm.amount,
      reason: creditForm.reason,
    })
    const [tenantRows, transactionRows] = await Promise.all([
      listAdminTenants(),
      listAdminCreditTransactions(),
    ])
    tenants.value = tenantRows
    transactions.value = transactionRows
    creditForm.amount = 100
    creditForm.reason = ''
    ElMessage.success('积分调账已完成')
  } finally {
    adjustingCredits.value = false
  }
}

onMounted(async () => {
  if (isSuperAdmin && unlocked.value) {
    loading.value = true
    try {
      await loadAll()
      modelSearch.value = requestedModel
    } finally {
      loading.value = false
    }
  }
})
</script>

<style scoped>
.unlock-panel,
.billing-summary article,
.panel {
  border: 1px solid #292929;
  border-radius: 18px;
  background: rgba(18, 18, 18, .96);
  box-shadow: 0 20px 58px rgba(0, 0, 0, .22);
}
.unlock-panel { display: grid; gap: 20px; padding: 24px; }
.unlock-panel h2, .panel h2 { margin: 0 0 8px; }
.unlock-panel p, .panel-heading p, .field-hint { margin: 0; color: #929292; }
.panel-kicker { margin-bottom: 8px !important; color: #ff7139 !important; font-size: 12px; font-weight: 700; letter-spacing: .12em; }
.admin-auth { display: grid; grid-template-columns: 1fr auto; gap: 12px; }
.billing-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
.billing-summary article { display: grid; gap: 7px; padding: 18px 20px; }
.billing-summary span { color: #858585; font-size: 12px; }
.billing-summary strong { font-size: 24px; }
.admin-tabs { margin-top: 10px; }
.panel { padding: 22px; }
.panel-heading { margin-bottom: 18px; }
.model-pricing-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.model-filters { display: grid; grid-template-columns: minmax(220px, 1fr) 150px 150px; gap: 10px; margin-bottom: 14px; }
.model-list { display: grid; gap: 10px; }
.model-row { display: grid; grid-template-columns: 1.2fr 120px 150px 120px auto; gap: 10px; align-items: center; padding: 14px; border: 1px solid #292929; border-radius: 12px; }
.model-row small { display: flex; grid-column: 1 / -1; gap: 8px; align-items: center; color: #8f9098; }
.cost-editor { display: grid; grid-column: 1 / -1; grid-template-columns: auto 140px 180px auto 180px auto; gap: 10px; align-items: center; padding-top: 10px; border-top: 1px dashed #353535; color: #9a9a9a; font-size: 12px; }
.new-model, .credit-form { display: grid; gap: 10px; align-items: center; margin: 18px 0 8px; padding-top: 18px; border-top: 1px dashed #3f4047; }
.model-field { display: grid; gap: 6px; color: #a8a9af; font-size: 12px; }
.model-field :deep(.el-input-number), .model-field :deep(.el-select) { width: 100%; }
.new-model { grid-template-columns: repeat(4, minmax(150px, 1fr)); align-items: end; }
.credit-form { grid-template-columns: 1.2fr 160px 1.5fr auto; }
.ledger-heading { display: flex; justify-content: space-between; gap: 20px; align-items: end; }
.ledger-controls { display: flex; gap: 8px; align-items: center; color: #929292; font-size: 12px; }
.ledger-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
.ledger-summary article { display: grid; gap: 6px; padding: 16px; border: 1px solid #292929; border-radius: 12px; background: #151515; }
.ledger-summary span { color: #8f9098; font-size: 12px; }
.ledger-summary strong { font-size: 20px; }
.panel :deep(.el-table) { margin-top: 18px; }
.field-hint { font-size: 12px; }
@media (max-width: 900px) {
  .billing-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .model-row, .model-filters, .new-model, .credit-form, .admin-auth, .cost-editor { grid-template-columns: 1fr; }
  .ledger-heading, .ledger-controls { align-items: stretch; flex-direction: column; }
  .ledger-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 520px) {
  .billing-summary { grid-template-columns: 1fr; }
  .ledger-summary { grid-template-columns: 1fr; }
}
</style>
