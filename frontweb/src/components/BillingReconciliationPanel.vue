<template>
  <section class="reconciliation-panel">
    <div class="panel-heading">
      <div>
        <h2>积分预扣对账</h2>
        <p>仅允许退还已有明确失败终态、且不存在继续运行风险的陈旧冻结。</p>
      </div>
      <el-button :loading="loading" @click="refresh">
        刷新对账
      </el-button>
    </div>
    <el-table :data="anomalies" empty-text="暂无陈旧冻结">
      <el-table-column prop="scope" label="账户" width="90" />
      <el-table-column prop="operation_key" label="操作号" min-width="180" />
      <el-table-column prop="amount" label="冻结积分" width="100" />
      <el-table-column label="判定" min-width="190">
        <template #default="{ row }">{{ statusLabel(row.safety_status) }}</template>
      </el-table-column>
      <el-table-column label="冻结时间" min-width="180">
        <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120" align="right">
        <template #default="{ row }">
          <el-button
            v-if="row.refundable"
            type="danger"
            :loading="refundingReservation === row.reservation_id"
            @click="refundHeldReservation(row)"
          >
            安全退款
          </el-button>
          <span v-else class="blocked-label">禁止退款</span>
        </template>
      </el-table-column>
    </el-table>

    <h3 class="history-title">对账处理历史</h3>
    <el-table :data="history" empty-text="暂无处理历史">
      <el-table-column prop="reservation_id" label="预扣 ID" min-width="210" />
      <el-table-column prop="result_status" label="结果" width="110" />
      <el-table-column prop="reason" label="原因" min-width="220" />
      <el-table-column prop="safety_code" label="安全依据" min-width="170" />
      <el-table-column label="时间" min-width="180">
        <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
      </el-table-column>
    </el-table>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listReconciliationAnomalies,
  listReconciliationHistory,
  refundReconciliationReservation,
} from '@/api/billingReconciliation'

const anomalies = ref([])
const history = ref([])
const loading = ref(false)
const refundingReservation = ref('')

const statusLabels = {
  definite_failure: '明确失败，可退款',
  running: '仍在运行',
  indeterminate: '供应商结果不确定',
  cancelled_may_still_run: '已取消但可能仍运行',
  completed_requires_review: '已完成，需人工复核',
  missing_terminal_evidence: '缺少终态证据',
  inconsistent_evidence: '关联状态不一致',
}

function statusLabel(value) {
  return statusLabels[value] || value || '未知'
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}

async function refresh() {
  loading.value = true
  try {
    const [anomalyRows, historyRows] = await Promise.all([
      listReconciliationAnomalies(),
      listReconciliationHistory(),
    ])
    anomalies.value = anomalyRows
    history.value = historyRows
  } finally {
    loading.value = false
  }
}

async function refundHeldReservation(row) {
  const { value: reason } = await ElMessageBox.prompt(
    '请输入已核验明确失败的退款原因',
    '安全退款确认',
    { inputPattern: /\S+/, inputErrorMessage: '退款原因不能为空', type: 'warning' },
  )
  refundingReservation.value = row.reservation_id
  try {
    await refundReconciliationReservation(row.reservation_id, {
      idempotency_key: `reconciliation-refund:${row.reservation_id}`,
      reason,
    })
    await refresh()
    ElMessage.success('冻结积分已安全退回')
  } finally {
    refundingReservation.value = ''
  }
}

onMounted(refresh)
</script>

<style scoped>
.reconciliation-panel {
  padding: 22px;
  border: 1px solid #292929;
  border-radius: 18px;
  background: rgba(18, 18, 18, .96);
  box-shadow: 0 20px 58px rgba(0, 0, 0, .22);
}
.panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  margin-bottom: 18px;
}
.panel-heading h2 { margin: 0 0 8px; }
.panel-heading p { margin: 0; color: #a8a9af; }
.history-title { margin: 28px 0 0; }
.blocked-label { color: #8f9098; font-size: 12px; }
@media (max-width: 900px) {
  .panel-heading { align-items: flex-start; flex-direction: column; }
}
</style>
