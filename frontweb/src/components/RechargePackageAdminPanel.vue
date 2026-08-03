<template>
  <section class="package-admin">
    <div class="panel-heading">
      <div>
        <h2>充值套餐</h2>
        <p>设置套餐名称、售价、到账积分、有效期和广告图片。用户付款后按下单快照到账。</p>
      </div>
    </div>

    <div class="package-card new-package">
      <h3>新增套餐</h3>
      <div class="package-form">
        <label><span>套餐名称</span><el-input v-model.trim="draft.name" maxlength="60" /></label>
        <label><span>售价（元）</span><el-input-number v-model="draft.amount_yuan" :min="0.01" :max="50000" :precision="2" /></label>
        <label><span>到账积分</span><el-input-number v-model="draft.credits" :min="1" :max="100000000" :step="100" step-strictly /></label>
        <label><span>开始时间</span><el-date-picker v-model="draft.starts_at" type="datetime" placeholder="立即生效" /></label>
        <label><span>结束时间</span><el-date-picker v-model="draft.ends_at" type="datetime" placeholder="长期有效" /></label>
        <label class="image-field"><span>广告图片（HTTPS 地址）</span><el-input v-model.trim="draft.image_url" placeholder="https://..." /></label>
        <label><span>状态</span><el-select v-model="draft.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></label>
      </div>
      <img v-if="draft.image_url" :src="draft.image_url" alt="新套餐广告图预览" class="ad-preview">
      <el-button type="primary" :loading="saving === 'new'" @click="createItem">新增套餐</el-button>
    </div>

    <div class="package-list">
      <article v-for="item in packages" :key="item.id" class="package-card">
        <div class="package-form">
          <label><span>套餐名称</span><el-input v-model.trim="item.name" maxlength="60" /></label>
          <label><span>售价（元）</span><el-input-number v-model="item.amount_yuan" :min="0.01" :max="50000" :precision="2" /></label>
          <label><span>到账积分</span><el-input-number v-model="item.credits" :min="1" :max="100000000" :step="100" step-strictly /></label>
          <label><span>开始时间</span><el-date-picker v-model="item.starts_at" type="datetime" placeholder="立即生效" /></label>
          <label><span>结束时间</span><el-date-picker v-model="item.ends_at" type="datetime" placeholder="长期有效" /></label>
          <label class="image-field"><span>广告图片（HTTPS 地址）</span><el-input v-model.trim="item.image_url" placeholder="https://..." /></label>
          <label><span>状态</span><el-select v-model="item.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></label>
        </div>
        <img v-if="item.image_url" :src="item.image_url" :alt="`${item.name} 广告图预览`" class="ad-preview">
        <div class="package-actions">
          <small>{{ packageRatio(item) }} 积分 / 元 · 创建于 {{ formatDate(item.created_at) }}</small>
          <el-button :loading="saving === item.id" @click="saveItem(item)">保存</el-button>
        </div>
      </article>
      <el-empty v-if="packages.length === 0" description="暂无充值套餐" />
    </div>
  </section>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  createRechargePackage,
  listAdminRechargePackages,
  updateRechargePackage,
} from '@/api/billing'

const packages = ref([])
const saving = ref('')
const emptyDraft = () => ({
  name: '',
  amount_yuan: 10,
  credits: 1000,
  starts_at: null,
  ends_at: null,
  image_url: '',
  status: 'active',
})
const draft = reactive(emptyDraft())

function normalizePackage(item) {
  return {
    ...item,
    amount_yuan: Number(item.amount_cents || 0) / 100,
    starts_at: item.starts_at ? new Date(item.starts_at) : null,
    ends_at: item.ends_at ? new Date(item.ends_at) : null,
  }
}

function toPayload(item) {
  return {
    name: item.name,
    amount_yuan: Number(item.amount_yuan).toFixed(2),
    credits: Number(item.credits),
    starts_at: item.starts_at ? new Date(item.starts_at).toISOString() : null,
    ends_at: item.ends_at ? new Date(item.ends_at).toISOString() : null,
    image_url: item.image_url,
    status: item.status,
  }
}

function validate(item) {
  if (!item.name) return '请填写套餐名称'
  if (!Number.isFinite(Number(item.amount_yuan)) || Number(item.amount_yuan) < 0.01) return '售价不能低于 0.01 元'
  if (!Number.isSafeInteger(Number(item.credits)) || Number(item.credits) < 1) return '到账积分必须为正整数'
  if (item.starts_at && item.ends_at && new Date(item.starts_at) >= new Date(item.ends_at)) return '结束时间必须晚于开始时间'
  if (!item.image_url) return '请填写广告图片'
  if (!/^https:\/\//i.test(item.image_url)) return '广告图片必须使用 HTTPS 地址'
  return ''
}

function packageRatio(item) {
  const amount = Number(item.amount_yuan || 0)
  return amount > 0 ? (Number(item.credits || 0) / amount).toFixed(2).replace(/\.00$/, '') : '-'
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}

async function load() {
  packages.value = (await listAdminRechargePackages()).map(normalizePackage)
}

async function createItem() {
  const error = validate(draft)
  if (error) return ElMessage.warning(error)
  saving.value = 'new'
  try {
    await createRechargePackage(toPayload(draft))
    Object.assign(draft, emptyDraft())
    await load()
    ElMessage.success('充值套餐已新增')
  } finally {
    saving.value = ''
  }
}

async function saveItem(item) {
  const error = validate(item)
  if (error) return ElMessage.warning(error)
  saving.value = item.id
  try {
    Object.assign(item, normalizePackage(await updateRechargePackage(item.id, toPayload(item))))
    ElMessage.success('充值套餐已保存')
  } finally {
    saving.value = ''
  }
}

onMounted(load)
</script>

<style scoped>
.package-admin { display: grid; gap: 18px; }
.panel-heading h2, .package-card h3 { margin: 0 0 8px; }
.panel-heading p { margin: 0; color: #929292; }
.package-list { display: grid; gap: 14px; }
.package-card { display: grid; gap: 14px; padding: 18px; border: 1px solid #292929; border-radius: 14px; background: #151515; }
.new-package { border-color: #513326; }
.package-form { display: grid; grid-template-columns: repeat(3, minmax(180px, 1fr)); gap: 12px; }
.package-form label { display: grid; gap: 6px; color: #a8a9af; font-size: 12px; }
.package-form :deep(.el-input-number), .package-form :deep(.el-select), .package-form :deep(.el-date-editor) { width: 100%; }
.image-field { grid-column: span 2; }
.ad-preview { width: min(520px, 100%); max-height: 220px; border-radius: 12px; object-fit: cover; }
.package-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.package-actions small { color: #8f9098; }
@media (max-width: 900px) {
  .package-form { grid-template-columns: 1fr; }
  .image-field { grid-column: auto; }
}
</style>
