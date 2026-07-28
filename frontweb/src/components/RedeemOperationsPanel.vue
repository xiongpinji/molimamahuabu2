<template>
  <section class="panel">
    <div class="code-form">
      <label class="code-field"><span>生成数量</span><el-input-number v-model="newCode.quantity" :min="1" :max="500" :step="1" step-strictly /></label>
      <label class="code-field">
        <span>适用工作区</span>
        <el-select v-model="newCode.tenant_id" placeholder="指定租户">
          <el-option label="平台通用" value="" />
          <el-option v-for="tenant in tenants" :key="tenant.id" :label="tenant.name" :value="tenant.id" />
        </el-select>
      </label>
      <label class="code-field"><span>用途说明</span><el-input v-model.trim="newCode.label" /></label>
      <label class="code-field"><span>每次兑换积分</span><el-input-number v-model="newCode.credits" :min="1" :step="100" step-strictly /></label>
      <label class="code-field"><span>每码可兑换次数</span><el-input-number v-model="newCode.max_redemptions" :min="1" :step="1" step-strictly /></label>
      <label class="code-field">
        <span>到期时间</span>
        <el-date-picker v-model="newCode.expires_at" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" placeholder="永久有效" />
      </label>
      <el-button type="primary" :loading="creating" @click="generateCodes">批量生成并导出</el-button>
    </div>
    <p class="field-hint">
      依次填写生成数量、说明、单次积分、单码最大兑换次数和可选到期时间；明文 CSV 只自动下载一次。
    </p>

    <el-table :data="codes" empty-text="暂无兑换码">
      <el-table-column prop="code_hint" label="兑换码" min-width="190" />
      <el-table-column prop="label" label="说明" min-width="150" />
      <el-table-column label="适用范围" min-width="160">
        <template #default="{ row }">
          {{ row.tenant_id ? tenantName(row.tenant_id) : '平台通用' }}
        </template>
      </el-table-column>
      <el-table-column prop="credits" label="积分" width="90" />
      <el-table-column label="使用次数" width="110">
        <template #default="{ row }">{{ row.redeemed_count }}/{{ row.max_redemptions }}</template>
      </el-table-column>
      <el-table-column label="有效期" min-width="245">
        <template #default="{ row }">
          <div class="expiry-editor">
            <el-date-picker
              v-model="row.expires_at"
              type="datetime"
              clearable
              value-format="YYYY-MM-DDTHH:mm:ss.SSSZ"
              placeholder="永久"
            />
            <el-button
              :loading="updating === row.id"
              @click="saveExpiry(row)"
            >
              保存有效期
            </el-button>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-switch
            :model-value="row.status === 'active'"
            :loading="updating === row.id"
            @change="toggleCode(row, $event)"
          />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="showUsages(row)">兑换明细</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="usageDialog" :title="`兑换明细 · ${selectedCodeHint}`" width="900">
      <el-table v-loading="loadingUsages" :data="usages" empty-text="暂无兑换记录">
        <el-table-column label="工作区" min-width="150">
          <template #default="{ row }">{{ tenantName(row.tenant_id) }}</template>
        </el-table-column>
        <el-table-column label="兑换用户" min-width="190">
          <template #default="{ row }">{{ userName(row.user_id) }}</template>
        </el-table-column>
        <el-table-column prop="credits" label="积分" width="80" />
        <el-table-column label="兑换时间" min-width="170">
          <template #default="{ row }">{{ formatDate(row.redeemed_at) }}</template>
        </el-table-column>
        <el-table-column label="账本记录" min-width="210">
          <template #default="{ row }">
            <span v-if="row.ledger_id">
              {{ row.ledger_amount }} 积分 · {{ formatDate(row.ledger_created_at) }}
            </span>
            <span v-else>未找到</span>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </section>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  createRedeemCodes,
  listRedeemCodes,
  listRedeemCodeUsages,
  updateRedeemCode,
} from '@/api/billing'

const props = defineProps({
  users: { type: Array, default: () => [] },
  tenants: { type: Array, default: () => [] },
})

const codes = ref([])
const usages = ref([])
const creating = ref(false)
const updating = ref('')
const loadingUsages = ref(false)
const usageDialog = ref(false)
const selectedCodeHint = ref('')
const newCode = reactive({
  quantity: 1,
  tenant_id: '',
  label: '',
  credits: 100,
  max_redemptions: 1,
  expires_at: null,
})

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '永久'
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function exportCreatedCodes(items) {
  const columns = ['兑换码', '适用租户', '说明', '积分', '最大兑换次数', '到期时间']
  const rows = items.map((item) => [
    item.code,
    item.tenant_id || '平台通用',
    item.label,
    item.credits,
    item.max_redemptions,
    item.expires_at || '',
  ])
  const csv = [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `兑换码-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

async function loadCodes() {
  codes.value = await listRedeemCodes()
}

async function generateCodes() {
  creating.value = true
  try {
    const created = await createRedeemCodes(newCode)
    exportCreatedCodes(created.items)
    for (const item of created.items) delete item.code
    codes.value.unshift(...created.items)
    Object.assign(newCode, {
      quantity: 1,
      tenant_id: '',
      label: '',
      credits: 100,
      max_redemptions: 1,
      expires_at: null,
    })
    ElMessage.success(`已生成并导出 ${created.quantity} 个兑换码，明文无法再次找回`)
  } finally {
    creating.value = false
  }
}

async function saveExpiry(row) {
  updating.value = row.id
  try {
    const saved = await updateRedeemCode(row.id, { expires_at: row.expires_at || null })
    Object.assign(row, saved)
    ElMessage.success('有效期已保存')
  } finally {
    updating.value = ''
  }
}

async function toggleCode(row, enabled) {
  updating.value = row.id
  try {
    const saved = await updateRedeemCode(row.id, { status: enabled ? 'active' : 'disabled' })
    Object.assign(row, saved)
  } finally {
    updating.value = ''
  }
}

function tenantName(tenantId) {
  const tenant = props.tenants.find((item) => item.id === tenantId)
  return tenant ? `${tenant.name}（${tenantId}）` : tenantId
}

function userName(userId) {
  const user = props.users.find((item) => item.id === userId)
  return user ? `${user.email}（${userId}）` : userId
}

async function showUsages(row) {
  selectedCodeHint.value = row.code_hint
  usageDialog.value = true
  loadingUsages.value = true
  try {
    usages.value = await listRedeemCodeUsages(row.id)
  } finally {
    loadingUsages.value = false
  }
}

onMounted(loadCodes)
</script>

<style scoped>
.panel {
  padding: 22px;
  border: 1px solid #292929;
  border-radius: 18px;
  background: rgba(18, 18, 18, .96);
  box-shadow: 0 20px 58px rgba(0, 0, 0, .22);
}
.code-form { display: grid; grid-template-columns: 120px 180px 1fr 150px 160px 220px auto; gap: 10px; align-items: end; margin-bottom: 8px; }
.code-field { display: grid; gap: 6px; color: #a8a9af; font-size: 12px; }
.code-field :deep(.el-input-number), .code-field :deep(.el-select), .code-field :deep(.el-date-editor) { width: 100%; }
.field-hint { margin: 0; color: #a8a9af; font-size: 12px; }
.expiry-editor { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
.panel :deep(.el-table) { margin-top: 18px; }
@media (max-width: 900px) {
  .code-form, .expiry-editor { grid-template-columns: 1fr; }
}
</style>
