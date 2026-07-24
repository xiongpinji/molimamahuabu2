<template>
  <main class="billing-page">
    <PlatformHeader title="模型积分定价" back-to="/" back-label="返回" />
    <section class="billing-card">
      <header>
        <div>
          <h1>模型积分定价</h1>
          <p>仅管理平台允许的三个模型。未定价的模型会被禁止生成。</p>
        </div>
      </header>

      <div class="admin-auth">
        <el-input v-model="adminToken" type="password" show-password autocomplete="off" placeholder="输入平台管理员令牌" />
        <el-button type="primary" :loading="loading" @click="unlock">验证并读取</el-button>
      </div>

      <el-alert v-if="!unlocked" title="管理员令牌只保存在当前浏览器会话，不会写入长期存储。" type="info" :closable="false" />

      <div v-else class="price-list">
        <div v-for="item in prices" :key="item.model" class="price-row">
          <div>
            <strong>{{ item.model }}</strong>
            <span>{{ item.credits == null ? '尚未定价，当前禁止生成' : `当前 ${item.credits} 积分/次` }}</span>
          </div>
          <el-input-number v-model="drafts[item.model]" :min="1" :step="1" step-strictly />
          <el-button :loading="saving === item.model" @click="save(item.model)">保存价格</el-button>
        </div>
      </div>

      <section v-if="unlocked" class="plan-admin">
        <header>
          <div>
            <h2>订阅套餐</h2>
            <p>配置可下单的套餐。支付成功、订阅激活和积分发放将在真实支付回调阶段接入。</p>
          </div>
        </header>

        <div v-for="plan in plans" :key="plan.id" class="plan-row">
          <el-input v-model="plan.name" placeholder="套餐名称" />
          <el-input-number v-model="plan.price_cents" :min="0" :step="100" step-strictly />
          <el-input-number v-model="plan.monthly_credits" :min="0" :step="100" step-strictly />
          <el-input v-model.trim="plan.currency" maxlength="3" placeholder="币种" />
          <el-select v-model="plan.status">
            <el-option label="启用" value="active" />
            <el-option label="归档" value="archived" />
          </el-select>
          <el-button :loading="savingPlan === plan.id" @click="savePlan(plan)">保存</el-button>
        </div>

        <div class="new-plan">
          <el-input v-model.trim="newPlan.id" placeholder="英文 ID，例如 creator" />
          <el-input v-model.trim="newPlan.name" placeholder="套餐名称" />
          <el-input-number v-model="newPlan.price_cents" :min="0" :step="100" step-strictly />
          <el-input-number v-model="newPlan.monthly_credits" :min="0" :step="100" step-strictly />
          <el-input v-model.trim="newPlan.currency" maxlength="3" placeholder="币种，例如 CNY" />
          <el-button type="primary" :loading="savingPlan === newPlan.id" @click="createPlan">新增套餐</el-button>
        </div>
        <p class="field-hint">金额单位为分，月度积分为整数，币种使用三个大写字母。</p>
      </section>
    </section>
  </main>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import PlatformHeader from '@/components/PlatformHeader.vue'
import {
  listAdminBillingPlans,
  listModelPrices,
  updateBillingPlan,
  updateModelPrice,
} from '@/api/billing'
import { saveAdminToken } from '@/utils/authSession'

const adminToken = ref('')
const loading = ref(false)
const unlocked = ref(false)
const prices = ref([])
const drafts = reactive({})
const saving = ref('')
const plans = ref([])
const savingPlan = ref('')
const newPlan = reactive({
  id: '',
  name: '',
  price_cents: 0,
  monthly_credits: 0,
  currency: 'CNY',
})

async function unlock() {
  if (adminToken.value.length < 32) return ElMessage.warning('管理员令牌长度不能少于 32 位')
  saveAdminToken(adminToken.value)
  loading.value = true
  try {
    const [modelPrices, billingPlans] = await Promise.all([
      listModelPrices(),
      listAdminBillingPlans(),
    ])
    prices.value = modelPrices
    plans.value = billingPlans
    for (const item of prices.value) drafts[item.model] = item.credits || 1
    unlocked.value = true
  } finally {
    loading.value = false
  }
}

async function save(model) {
  saving.value = model
  try {
    const saved = await updateModelPrice(model, drafts[model])
    const index = prices.value.findIndex((item) => item.model === model)
    if (index >= 0) prices.value[index] = saved
    ElMessage.success(`${model} 价格已保存`)
  } finally {
    saving.value = ''
  }
}

async function savePlan(plan) {
  savingPlan.value = plan.id
  try {
    const saved = await updateBillingPlan(plan.id, {
      name: plan.name,
      description: plan.description || '',
      price_cents: plan.price_cents,
      monthly_credits: plan.monthly_credits,
      currency: String(plan.currency || 'CNY').toUpperCase(),
      status: plan.status,
    })
    const index = plans.value.findIndex((item) => item.id === plan.id)
    if (index >= 0) plans.value[index] = saved
    ElMessage.success(`${saved.name} 已保存`)
  } finally {
    savingPlan.value = ''
  }
}

async function createPlan() {
  if (!newPlan.id || !newPlan.name) return ElMessage.warning('请填写套餐 ID 和名称')
  savingPlan.value = newPlan.id
  try {
    const saved = await updateBillingPlan(newPlan.id, {
      name: newPlan.name,
      description: '',
      price_cents: newPlan.price_cents,
      monthly_credits: newPlan.monthly_credits,
      currency: String(newPlan.currency || '').toUpperCase(),
      status: 'active',
    })
    plans.value.push(saved)
    Object.assign(newPlan, { id: '', name: '', price_cents: 0, monthly_credits: 0, currency: 'CNY' })
    ElMessage.success('套餐已新增')
  } finally {
    savingPlan.value = ''
  }
}
</script>

<style scoped>
.billing-page { min-height: 100vh; padding: 36px 20px; background: #111214; color: #f5f5f7; }
.billing-card { width: min(900px, 100%); margin: auto; padding: 28px; border: 1px solid #303136; border-radius: 20px; background: #1b1c20; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
h1 { margin: 0 0 8px; font-size: 26px; }
header p { margin: 0; color: #a8a9af; }
.admin-auth { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin-bottom: 18px; }
.price-list { display: grid; gap: 12px; margin-top: 24px; }
.price-row { display: grid; grid-template-columns: minmax(220px, 1fr) auto auto; align-items: center; gap: 16px; padding: 18px; border: 1px solid #303136; border-radius: 14px; background: #222328; }
.price-row div:first-child { display: grid; gap: 5px; }
.price-row span { color: #999ba3; font-size: 13px; }
.plan-admin { margin-top: 32px; padding-top: 28px; border-top: 1px solid #303136; }
.plan-admin h2 { margin: 0 0 8px; }
.plan-row, .new-plan { display: grid; grid-template-columns: 1.2fr 150px 150px 90px 110px auto; gap: 10px; align-items: center; margin-top: 12px; }
.new-plan { grid-template-columns: 1fr 1fr 140px 140px 130px auto; padding-top: 18px; border-top: 1px dashed #3f4047; }
.field-hint { color: #999ba3; font-size: 12px; }
@media (max-width: 680px) { .price-row { grid-template-columns: 1fr; } .admin-auth { grid-template-columns: 1fr; } }
@media (max-width: 900px) { .plan-row, .new-plan { grid-template-columns: 1fr; } }
</style>
