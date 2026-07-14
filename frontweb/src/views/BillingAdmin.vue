<template>
  <main class="billing-page">
    <section class="billing-card">
      <header>
        <div>
          <h1>模型积分定价</h1>
          <p>仅管理平台允许的三个模型。未定价的模型会被禁止生成。</p>
        </div>
        <el-button @click="$router.push('/')">返回项目</el-button>
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
    </section>
  </main>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listModelPrices, updateModelPrice } from '@/api/billing'
import { saveAdminToken } from '@/utils/authSession'

const adminToken = ref('')
const loading = ref(false)
const unlocked = ref(false)
const prices = ref([])
const drafts = reactive({})
const saving = ref('')

async function unlock() {
  if (adminToken.value.length < 32) return ElMessage.warning('管理员令牌长度不能少于 32 位')
  saveAdminToken(adminToken.value)
  loading.value = true
  try {
    prices.value = await listModelPrices()
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
@media (max-width: 680px) { .price-row { grid-template-columns: 1fr; } .admin-auth { grid-template-columns: 1fr; } }
</style>
