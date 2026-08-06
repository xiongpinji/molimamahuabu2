<template>
  <section class="package-admin">
    <div class="panel-heading">
      <div>
        <h2>充值套餐</h2>
        <p>编辑用户端套餐广告、金额、积分和限时规则。推荐套餐由后端事务保证全局唯一。</p>
      </div>
      <el-button type="primary" :disabled="managementLocked" @click="startCreate">新增套餐</el-button>
    </div>

    <div class="admin-grid">
      <aside class="admin-column package-selector" aria-label="套餐排序列表">
        <div class="column-heading">
          <strong>套餐列表</strong>
          <span>拖动或使用按钮排序</span>
        </div>

        <div v-if="loadFailed && !hasLoadedPackages" class="package-load-error" role="alert">
          <strong>套餐列表加载失败</strong>
          <span>尚未确认服务器套餐，已暂停创建和排序，避免重复写入。</span>
          <el-button :loading="loadingPackages" @click="retryLoadPackages">重新加载</el-button>
        </div>
        <div v-else-if="loadingPackages && !hasLoadedPackages" class="package-loading">正在加载套餐…</div>
        <el-empty v-else-if="hasLoadedPackages && packages.length === 0" description="暂无充值套餐" />
        <div v-else-if="hasLoadedPackages" class="sortable-list">
          <article
            v-for="(item, index) in packages"
            :key="item.id"
            class="sortable-item"
            :class="{ 'sortable-item--active': draft.id === item.id }"
            :draggable="hasLoadedPackages && !managementLocked"
            tabindex="0"
            @click="selectItem(item)"
            @keydown.enter.self.prevent="selectItem(item)"
            @keydown.space.self.prevent="selectItem(item)"
            @dragstart="beginDrag(index)"
            @dragover.prevent
            @drop="dropItem(index)"
          >
            <div class="sortable-summary">
              <img v-if="item.image_url" :src="item.image_url" :alt="`${item.name} 广告图缩略图`">
              <div v-else class="sortable-placeholder" aria-hidden="true">图</div>
              <div class="sortable-copy">
                <strong>{{ item.name }}</strong>
                <span>¥{{ Number(item.amount_yuan).toFixed(2) }} · {{ Number(item.credits).toLocaleString('zh-CN') }} 积分</span>
                <small>{{ item.status === 'active' ? '启用' : '停用' }}<template v-if="item.is_featured"> · 推荐</template></small>
              </div>
              <span class="drag-handle" aria-hidden="true">⋮⋮</span>
            </div>
            <div class="sort-actions">
              <button
                type="button"
                :aria-label="`上移 ${item.name}`"
                :disabled="managementLocked || index === 0"
                @click.stop="moveItem(index, index - 1)"
              >上移</button>
              <button
                type="button"
                :aria-label="`下移 ${item.name}`"
                :disabled="managementLocked || index === packages.length - 1"
                @click.stop="moveItem(index, index + 1)"
              >下移</button>
            </div>
          </article>
        </div>
      </aside>

      <section class="admin-column editor-column" aria-labelledby="package-editor-title">
        <div class="column-heading">
          <strong id="package-editor-title">{{ draft.id ? '编辑套餐' : '新增套餐' }}</strong>
          <span>所有广告内容都会同步到用户端卡片</span>
        </div>

        <fieldset class="editor-form" :disabled="managementLocked">
          <label><span>套餐名称</span><el-input v-model.trim="draft.name" maxlength="60" show-word-limit /></label>
          <label><span>角标文案</span><el-input v-model.trim="draft.badge_text" maxlength="20" show-word-limit /></label>
          <label class="field-wide"><span>广告主标题</span><el-input v-model.trim="draft.ad_title" maxlength="48" show-word-limit /></label>
          <label class="field-wide"><span>广告副标题</span><el-input v-model.trim="draft.ad_subtitle" maxlength="80" show-word-limit /></label>
          <label><span>按钮文案</span><el-input v-model.trim="draft.button_text" maxlength="20" show-word-limit /></label>
          <label><span>强调色</span><el-color-picker v-model="draft.accent_color" color-format="hex" /></label>
          <label><span>售价（元）</span><el-input-number v-model="draft.amount_yuan" :min="0.01" :max="50000" :precision="2" /></label>
          <label><span>到账积分</span><el-input-number v-model="draft.credits" :min="1" :max="100000000" :step="1" /></label>
          <label><span>开始时间</span><el-date-picker v-model="draft.starts_at" type="datetime" placeholder="立即生效" /></label>
          <label><span>结束时间</span><el-date-picker v-model="draft.ends_at" type="datetime" placeholder="长期有效" /></label>
          <label><span>状态</span><el-select v-model="draft.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></label>
          <label class="switch-field">
            <span>推荐套餐</span>
            <el-switch v-model="draft.is_featured" inline-prompt active-text="推荐" inactive-text="普通" />
          </label>

          <label class="field-wide image-field">
            <span>广告图片</span>
            <div class="image-controls">
              <el-input v-model.trim="draft.image_url" placeholder="上传图片或填写 HTTPS 地址" />
              <el-button :loading="uploading" :disabled="managementLocked" @click="imageInput?.click()">上传图片</el-button>
              <input
                ref="imageInput"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                :disabled="managementLocked"
                hidden
                @change="uploadImage"
              >
            </div>
            <small>支持 JPG、PNG、WebP；上传失败或保存失败不会清空当前图片。</small>
          </label>
        </fieldset>

        <div class="recommend-note">推荐套餐由后端事务保证全局唯一；保存新的推荐套餐后，原推荐会自动取消。</div>
        <div class="save-bar">
          <el-button :disabled="managementLocked" @click="resetDraft">重置草稿</el-button>
          <el-button type="primary" :loading="Boolean(saving)" :disabled="managementLocked" @click="saveItem">
            {{ draft.id ? '保存套餐' : '创建套餐' }}
          </el-button>
        </div>
      </section>

      <aside class="admin-column preview-column" aria-label="用户端实时预览">
        <div class="column-heading">
          <strong>用户端实时预览</strong>
          <span>预览按钮始终禁用，不会创建订单</span>
        </div>
        <RechargePackageCard :item="draft" preview />
      </aside>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import RechargePackageCard from '@/components/RechargePackageCard.vue'
import {
  createRechargePackage,
  listAdminRechargePackages,
  reorderRechargePackages,
  updateRechargePackage,
} from '@/api/billing'
import { uploadRechargePackageImage } from '@/api/upload'

const packages = ref([])
const stableOrder = ref([])
const hasLoadedPackages = ref(false)
const loadFailed = ref(false)
const loadingPackages = ref(false)
const saving = ref('')
const sorting = ref(false)
const uploading = ref(false)
const imageInput = ref(null)
const draggedIndex = ref(-1)
let loadPromise = null

const operationBusy = computed(() => Boolean(saving.value) || sorting.value || uploading.value || loadingPackages.value)
const managementLocked = computed(() => !hasLoadedPackages.value || loadFailed.value || operationBusy.value)

const emptyDraft = () => ({
  id: '',
  name: '',
  badge_text: '',
  ad_title: '',
  ad_subtitle: '',
  button_text: '立即购买',
  amount_yuan: 10,
  amount_cents: 1000,
  credits: 1000,
  starts_at: null,
  ends_at: null,
  image_url: '',
  accent_color: '#ff7139',
  sort_order: packages.value.length,
  is_featured: false,
  status: 'active',
})
const draft = reactive(emptyDraft())

watch(() => draft.amount_yuan, (value) => {
  draft.amount_cents = Math.round(Number(value || 0) * 100)
})

function normalizePackage(item, index = 0) {
  const amountCents = Number(item.amount_cents || 0)
  const sortOrder = Number(item.sort_order)
  return {
    ...item,
    badge_text: String(item.badge_text || ''),
    ad_title: String(item.ad_title || item.name || ''),
    ad_subtitle: String(item.ad_subtitle || ''),
    button_text: String(item.button_text || '立即购买'),
    amount_yuan: amountCents / 100,
    amount_cents: amountCents,
    starts_at: item.starts_at ? new Date(item.starts_at) : null,
    ends_at: item.ends_at ? new Date(item.ends_at) : null,
    image_url: String(item.image_url || ''),
    accent_color: String(item.accent_color || '#ff7139').toLowerCase(),
    sort_order: Number.isSafeInteger(sortOrder) && sortOrder >= 0 ? sortOrder : index,
    is_featured: Boolean(item.is_featured),
    status: item.status === 'inactive' ? 'inactive' : 'active',
  }
}

function toPayload(item) {
  return {
    name: item.name,
    badge_text: item.badge_text,
    ad_title: item.ad_title,
    ad_subtitle: item.ad_subtitle,
    button_text: item.button_text,
    amount_yuan: Number(item.amount_yuan).toFixed(2),
    credits: Number(item.credits),
    starts_at: item.starts_at ? new Date(item.starts_at).toISOString() : null,
    ends_at: item.ends_at ? new Date(item.ends_at).toISOString() : null,
    image_url: item.image_url,
    accent_color: item.accent_color,
    sort_order: Number(item.sort_order),
    is_featured: item.is_featured,
    status: item.status,
  }
}

function validate(item) {
  const name = String(item.name || '').trim()
  const badgeText = String(item.badge_text || '').trim()
  const adTitle = String(item.ad_title || '').trim()
  const adSubtitle = String(item.ad_subtitle || '').trim()
  const buttonText = String(item.button_text || '').trim()
  const amount = Number(item.amount_yuan)
  const credits = Number(item.credits)
  const imageUrl = String(item.image_url || '').trim()

  if (!name) return '请填写套餐名称'
  if (name.length > 60) return '套餐名称不能超过 60 个字符'
  if (badgeText.length > 20) return '角标文案不能超过 20 个字符'
  if (!adTitle) return '请填写广告主标题'
  if (adTitle.length > 48) return '广告主标题不能超过 48 个字符'
  if (adSubtitle.length > 80) return '广告副标题不能超过 80 个字符'
  if (!buttonText) return '请填写按钮文案'
  if (buttonText.length > 20) return '按钮文案不能超过 20 个字符'
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 50000 || Math.round(amount * 100) / 100 !== amount) return '售价必须为 0.01 至 50000 元且最多两位小数'
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > 100000000) return '到账积分必须为 1 至 100000000 的整数'
  if (item.starts_at && item.ends_at && new Date(item.starts_at) >= new Date(item.ends_at)) return '结束时间必须晚于开始时间'
  if (!imageUrl) return '请填写广告图片'
  if (!isValidPackageImage(imageUrl)) return '广告图片必须来自套餐上传目录或有效的 HTTPS 地址'
  if (!/^#[0-9a-fA-F]{6}$/.test(String(item.accent_color || ''))) return '强调色必须为 #RRGGBB 格式'
  return ''
}

function isValidPackageImage(value) {
  if (/^\/static\/uploads\/recharge-packages\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname)
  } catch (_) {
    return false
  }
}

function selectItem(item) {
  Object.assign(draft, emptyDraft(), normalizePackage(item))
}

function startCreate() {
  if (managementLocked.value) return
  Object.assign(draft, emptyDraft())
}

function resetDraft() {
  if (managementLocked.value) return
  const selected = packages.value.find((item) => item.id === draft.id)
  if (selected) selectItem(selected)
  else startCreate()
}

function replacePackageList(records) {
  const loaded = records.map(normalizePackage)
  packages.value = loaded
  stableOrder.value = loaded.map((item) => item.id)
  hasLoadedPackages.value = true
  loadFailed.value = false
  return loaded
}

function syncDraftSortOrder() {
  const selected = packages.value.find((item) => item.id === draft.id)
  if (selected) draft.sort_order = selected.sort_order
}

function load(preferredId = draft.id) {
  if (loadPromise) return loadPromise
  loadingPackages.value = true
  const request = (async () => {
    try {
      const loaded = replacePackageList(await listAdminRechargePackages())
      const selected = loaded.find((item) => item.id === preferredId)
      if (selected) selectItem(selected)
      else if (loaded.length > 0 && preferredId) selectItem(loaded[0])
      else Object.assign(draft, emptyDraft())
      return loaded
    } catch (error) {
      if (!hasLoadedPackages.value) loadFailed.value = true
      throw error
    }
  })()
  const tracked = request.finally(() => {
    if (loadPromise === tracked) {
      loadPromise = null
      loadingPackages.value = false
    }
  })
  loadPromise = tracked
  return tracked
}

async function retryLoadPackages() {
  try {
    await load()
  } catch (_) {
    // 首次失败由持久错误态承接；已有稳定数据时保持当前列表。
  }
}

async function saveItem() {
  if (managementLocked.value) return
  const error = validate(draft)
  if (error) return ElMessage.warning(error)

  const packageId = draft.id
  saving.value = packageId || 'new'
  try {
    let saved
    try {
      saved = packageId
        ? await updateRechargePackage(packageId, toPayload(draft))
        : await createRechargePackage(toPayload(draft))
    } catch (error) {
      ElMessage.error(error?.message || '套餐保存失败，请稍后重试')
      return
    }

    const savedId = saved?.id || packageId
    const existingIndex = packages.value.findIndex((item) => item.id === savedId)
    const normalizedSaved = normalizePackage({ ...saved, id: savedId }, existingIndex >= 0 ? existingIndex : packages.value.length)
    if (existingIndex >= 0) {
      packages.value = packages.value.map((item, index) => index === existingIndex ? normalizedSaved : item)
    } else {
      packages.value = [...packages.value, normalizedSaved]
    }
    stableOrder.value = packages.value.map((item) => item.id)
    Object.assign(draft, emptyDraft(), normalizedSaved)

    try {
      await load(savedId)
    } catch (error) {
      ElMessage.warning('套餐保存成功但刷新失败，当前草稿已保留')
      return
    }
    ElMessage.success(packageId ? '充值套餐已保存' : '充值套餐已创建')
  } finally {
    saving.value = ''
  }
}

async function uploadImage(event) {
  if (managementLocked.value) {
    event.target.value = ''
    return
  }
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return ElMessage.warning('套餐广告图只支持 JPG、PNG、WebP')
  }

  uploading.value = true
  try {
    const result = await uploadRechargePackageImage(file)
    draft.image_url = result.url
    ElMessage.success('套餐广告图已上传')
  } catch (error) {
    ElMessage.error(error?.message || '套餐广告图上传失败')
  } finally {
    uploading.value = false
  }
}

function beginDrag(index) {
  if (managementLocked.value) return
  draggedIndex.value = index
}

function dropItem(index) {
  if (managementLocked.value) return
  const fromIndex = draggedIndex.value
  draggedIndex.value = -1
  if (fromIndex >= 0) moveItem(fromIndex, index)
}

function moveItem(fromIndex, toIndex) {
  if (managementLocked.value || fromIndex === toIndex) return
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= packages.value.length || toIndex >= packages.value.length) return
  const next = packages.value.slice()
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  persistOrder(next)
}

async function persistOrder(next) {
  if (managementLocked.value) return
  const previous = packages.value
  const previousStableOrder = stableOrder.value.slice()
  packages.value = next
  sorting.value = true
  try {
    const reordered = await reorderRechargePackages(next.map((item) => item.id))
    packages.value = reordered.map(normalizePackage)
    stableOrder.value = packages.value.map((item) => item.id)
    const selected = packages.value.find((item) => item.id === draft.id)
    if (selected) draft.sort_order = selected.sort_order
    ElMessage.success('套餐顺序已保存')
  } catch (error) {
    try {
      replacePackageList(await listAdminRechargePackages())
      syncDraftSortOrder()
      ElMessage.warning('套餐排序失败，已同步服务器最新数据')
    } catch (_) {
      packages.value = previousStableOrder
        .map((id) => previous.find((item) => item.id === id))
        .filter(Boolean)
      stableOrder.value = previousStableOrder
      ElMessage.error('套餐排序与服务器同步均失败，已恢复本地顺序')
    }
  } finally {
    sorting.value = false
  }
}

onMounted(retryLoadPackages)
</script>

<style scoped>
.package-admin { display: grid; gap: 18px; color: #f7f7f7; }
.panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.panel-heading h2 { margin: 0 0 8px; }
.panel-heading p { margin: 0; color: #a7a7ad; }
.admin-grid { display: grid; grid-template-columns: 300px minmax(420px, 1fr) minmax(320px, 420px); gap: 14px; align-items: start; }
.admin-column { min-width: 0; padding: 18px; border: 1px solid #303030; border-radius: 18px; background: #181818; }
.column-heading { display: grid; gap: 4px; margin-bottom: 16px; }
.column-heading strong { font-size: 16px; }
.column-heading span { color: #929298; font-size: 12px; }
.package-load-error { display: grid; gap: 10px; padding: 14px; border: 1px solid #74402f; border-radius: 12px; color: #f2c2ae; background: rgba(255, 113, 57, .08); }
.package-load-error span, .package-loading { color: #a7a7ad; font-size: 12px; }
.package-load-error :deep(.el-button) { justify-self: start; }
.package-loading { padding: 16px 2px; }
.sortable-list { display: grid; gap: 10px; }
.sortable-item { display: grid; gap: 9px; padding: 11px; border: 1px solid #303030; border-radius: 13px; background: #131313; cursor: pointer; }
.sortable-item:hover, .sortable-item:focus-visible { border-color: #6d4636; outline: none; }
.sortable-item--active { border-color: #ff7139; box-shadow: 0 0 0 1px rgba(255, 113, 57, .22); }
.sortable-summary { display: grid; grid-template-columns: 52px minmax(0, 1fr) 18px; gap: 9px; align-items: center; }
.sortable-summary img, .sortable-placeholder { width: 52px; height: 52px; border-radius: 10px; object-fit: cover; }
.sortable-placeholder { display: grid; place-items: center; color: #a7a7ad; background: #292929; }
.sortable-copy { display: grid; min-width: 0; gap: 3px; }
.sortable-copy strong, .sortable-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sortable-copy span, .sortable-copy small { color: #9999a0; font-size: 11px; }
.drag-handle { color: #77777e; font-size: 18px; }
.sort-actions { display: flex; justify-content: flex-end; gap: 7px; }
.sort-actions button { padding: 4px 8px; border: 1px solid #39393c; border-radius: 7px; color: #c7c7ca; background: #202022; cursor: pointer; }
.sort-actions button:disabled { opacity: .38; cursor: not-allowed; }
.sort-actions button:focus-visible { outline: 2px solid #ff7139; outline-offset: 2px; }
.editor-form { display: grid; min-width: 0; margin: 0; padding: 0; border: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; }
.editor-form label { display: grid; align-content: start; gap: 7px; color: #a7a7ad; font-size: 12px; }
.editor-form :deep(.el-input-number), .editor-form :deep(.el-select), .editor-form :deep(.el-date-editor) { width: 100%; }
.field-wide { grid-column: 1 / -1; }
.switch-field { grid-template-columns: 1fr auto; align-items: center; }
.image-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.image-field small { color: #7f7f85; }
.recommend-note { margin-top: 14px; padding: 11px 12px; border-radius: 10px; color: #c2a38f; font-size: 12px; background: rgba(255, 113, 57, .08); }
.save-bar { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; padding-top: 16px; border-top: 1px solid #303030; }
.preview-column { position: sticky; top: 88px; }
.preview-column :deep(.recharge-package-card) { min-height: 570px; }

@media (max-width: 1200px) {
  .admin-grid { grid-template-columns: 300px minmax(0, 1fr); }
  .preview-column { position: static; grid-column: 2; }
}

@media (max-width: 760px) {
  .panel-heading { align-items: stretch; flex-direction: column; }
  .admin-grid { grid-template-columns: 1fr; }
  .preview-column { grid-column: auto; }
  .editor-form { grid-template-columns: 1fr; }
  .field-wide { grid-column: auto; }
  .image-controls { grid-template-columns: 1fr; }
}
</style>
