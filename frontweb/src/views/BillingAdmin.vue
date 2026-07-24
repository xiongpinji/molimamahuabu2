<template>
  <main class="admin-page">
    <PlatformHeader title="平台管理后台" back-to="/" back-label="返回" />
    <section class="admin-shell">
      <header class="page-heading">
        <div>
          <h1>平台管理后台</h1>
          <p>统一管理账号、兑换码、积分流水和每个模型的独立计费规则。</p>
        </div>
      </header>

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
        v-if="!unlocked"
        title="管理员令牌只保存在当前浏览器会话，不会写入长期存储。"
        type="info"
        :closable="false"
      />

      <el-tabs v-else v-model="activeTab" class="admin-tabs">
        <el-tab-pane label="模型计费" name="models">
          <section class="panel">
            <div class="panel-heading">
              <div>
                <h2>模型计费</h2>
                <p>每个实际模型单独配置积分、类型和启停状态；停用后立即禁止新生成。</p>
              </div>
            </div>
            <div class="model-list">
              <div v-for="item in prices" :key="item.model" class="model-row">
                <el-input v-model="item.display_name" placeholder="展示名称" />
                <el-select v-model="item.category">
                  <el-option label="文本" value="text" />
                  <el-option label="图片" value="image" />
                  <el-option label="视频" value="video" />
                  <el-option label="音频" value="audio" />
                  <el-option label="其他" value="other" />
                </el-select>
                <el-input-number v-model="item.credits" :min="1" :step="1" step-strictly />
                <el-select v-model="item.status">
                  <el-option label="启用" value="enabled" />
                  <el-option label="停用" value="disabled" />
                </el-select>
                <el-button :loading="savingModel === item.model" @click="saveModel(item)">保存</el-button>
                <small>{{ item.model }}</small>
              </div>
            </div>
            <div class="new-model">
              <el-input v-model.trim="newModel.model" placeholder="模型 ID" />
              <el-input v-model.trim="newModel.display_name" placeholder="展示名称" />
              <el-select v-model="newModel.category">
                <el-option label="文本" value="text" />
                <el-option label="图片" value="image" />
                <el-option label="视频" value="video" />
                <el-option label="音频" value="audio" />
                <el-option label="其他" value="other" />
              </el-select>
              <el-input-number v-model="newModel.credits" :min="1" :step="1" step-strictly />
              <el-button type="primary" :loading="savingModel === newModel.model" @click="addModel">
                新增模型
              </el-button>
            </div>
          </section>
        </el-tab-pane>

        <el-tab-pane label="兑换码" name="codes">
          <RedeemOperationsPanel :users="users" :tenants="tenants" />
        </el-tab-pane>

        <el-tab-pane label="账号管理" name="accounts">
          <section class="panel">
            <el-table :data="users" empty-text="暂无账号">
              <el-table-column prop="email" label="邮箱" min-width="230" />
              <el-table-column label="平台角色" width="150">
                <template #default="{ row }">
                  <el-select v-model="row.role">
                    <el-option label="用户" value="user" />
                    <el-option label="管理员" value="admin" />
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

        <el-tab-pane label="积分流水" name="credits">
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
      </el-tabs>
    </section>
  </main>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import PlatformHeader from '@/components/PlatformHeader.vue'
import RedeemOperationsPanel from '@/components/RedeemOperationsPanel.vue'
import {
  adjustTenantCredits,
  listAdminCreditTransactions,
  listAdminTenants,
  listModelPrices,
  listPlatformUsers,
  updateModelPrice,
  updatePlatformUser,
} from '@/api/billing'
import { saveAdminToken } from '@/utils/authSession'

const adminToken = ref('')
const loading = ref(false)
const unlocked = ref(false)
const activeTab = ref('models')
const prices = ref([])
const users = ref([])
const tenants = ref([])
const transactions = ref([])
const savingModel = ref('')
const savingUser = ref('')
const adjustingCredits = ref(false)
const newModel = reactive({
  model: '',
  display_name: '',
  category: 'video',
  credits: 1,
})
const creditForm = reactive({
  tenant_id: '',
  amount: 100,
  reason: '',
})

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '永久'
}

async function loadAll() {
  const [modelRows, userRows, tenantRows, transactionRows] = await Promise.all([
    listModelPrices(),
    listPlatformUsers(),
    listAdminTenants(),
    listAdminCreditTransactions(),
  ])
  prices.value = modelRows.map((item) => ({
    ...item,
    status: item.status === 'unconfigured' ? 'enabled' : item.status,
  }))
  users.value = userRows
  tenants.value = tenantRows
  transactions.value = transactionRows
  if (!creditForm.tenant_id) creditForm.tenant_id = tenantRows[0]?.id || ''
}

async function unlock() {
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
  savingModel.value = item.model
  try {
    const saved = await updateModelPrice(item.model, {
      credits: item.credits,
      display_name: item.display_name,
      category: item.category,
      status: item.status === 'unconfigured' ? 'enabled' : item.status,
    })
    Object.assign(item, saved)
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
    })
    const index = prices.value.findIndex((item) => item.model === saved.model)
    if (index >= 0) prices.value[index] = saved
    else prices.value.push(saved)
    Object.assign(newModel, { model: '', display_name: '', category: 'video', credits: 1 })
    ElMessage.success('模型计费规则已新增')
  } finally {
    savingModel.value = ''
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
</script>

<style scoped>
.admin-page { min-height: 100vh; padding: 0 20px 56px; color: #f5f5f7; background: #111214; }
.admin-shell { width: min(1180px, 100%); margin: 24px auto 0; }
.page-heading { margin-bottom: 20px; }
.page-heading h1, .panel h2 { margin: 0 0 8px; }
.page-heading p, .panel-heading p, .field-hint { margin: 0; color: #a8a9af; }
.admin-auth { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin-bottom: 18px; }
.admin-tabs { margin-top: 22px; }
.panel { padding: 22px; border: 1px solid #303136; border-radius: 16px; background: #1b1c20; }
.panel-heading { margin-bottom: 18px; }
.model-list { display: grid; gap: 10px; }
.model-row { display: grid; grid-template-columns: 1.2fr 120px 150px 120px auto; gap: 10px; align-items: center; padding: 14px; border: 1px solid #303136; border-radius: 12px; }
.model-row small { grid-column: 1 / -1; color: #8f9098; }
.new-model, .credit-form { display: grid; gap: 10px; align-items: center; margin: 18px 0 8px; padding-top: 18px; border-top: 1px dashed #3f4047; }
.new-model { grid-template-columns: 1.2fr 1fr 120px 150px auto; }
.credit-form { grid-template-columns: 1.2fr 160px 1.5fr auto; }
.panel :deep(.el-table) { margin-top: 18px; }
.field-hint { font-size: 12px; }
@media (max-width: 900px) {
  .model-row, .new-model, .credit-form, .admin-auth { grid-template-columns: 1fr; }
}
</style>
