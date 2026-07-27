<template>
  <div class="material-library-page">
    <PlatformHeader
      :title="pageConfig.title"
      back-to="/factory"
      back-label="返回项目"
      :show-theme="false"
    >
      <template #actions>
        <el-button class="secondary-action" @click="router.push({ name: 'media-library' })">
          <el-icon><Files /></el-icon>
          媒体素材
        </el-button>
      </template>
    </PlatformHeader>

    <main class="material-library-main">
      <section class="material-hero" aria-labelledby="material-page-title">
        <span class="material-hero__eyebrow">创作资产中心</span>
        <div class="material-hero__row">
          <div>
            <h1 id="material-page-title">{{ pageConfig.title }}</h1>
            <p>{{ pageConfig.description }}</p>
          </div>
          <span class="material-total" aria-live="polite">{{ total }} 项素材</span>
        </div>
      </section>

      <nav class="material-tabs" aria-label="素材类型">
        <RouterLink
          v-for="tab in materialTabs"
          :key="tab.kind"
          :to="{ name: tab.routeName }"
          class="material-tab"
          :class="{ 'is-active': tab.kind === kind }"
          :aria-current="tab.kind === kind ? 'page' : undefined"
        >
          <el-icon><component :is="tab.icon" /></el-icon>
          {{ tab.label }}
        </RouterLink>
      </nav>

      <section class="material-workspace" aria-label="素材列表">
        <div class="material-toolbar">
          <el-input
            v-model="keyword"
            class="material-search"
            clearable
            :prefix-icon="Search"
            :placeholder="pageConfig.searchPlaceholder"
            :aria-label="pageConfig.searchPlaceholder"
            @keyup.enter="search"
            @clear="search"
          />
          <el-select
            v-model="pageSize"
            class="page-size-select"
            aria-label="每页显示数量"
            @change="changePageSize"
          >
            <el-option label="每页 12 项" :value="12" />
            <el-option label="每页 24 项" :value="24" />
            <el-option label="每页 48 项" :value="48" />
          </el-select>
          <el-button class="secondary-action" :loading="loading" @click="loadList">
            <el-icon><Refresh /></el-icon>
            刷新
          </el-button>
        </div>

        <div v-loading="loading" class="material-grid">
          <article v-for="item in items" :key="item.id" class="material-card">
            <button
              type="button"
              class="material-cover"
              :aria-label="`预览${itemName(item)}`"
              @click="openPreview(item)"
            >
              <img v-if="assetImageUrl(item)" :src="assetImageUrl(item)" :alt="itemName(item)" />
              <span v-else class="material-placeholder">
                <el-icon><component :is="pageConfig.icon" /></el-icon>
                暂无图片
              </span>
            </button>
            <div class="material-card__body">
              <div class="material-card__heading">
                <h2>{{ itemName(item) }}</h2>
                <span v-if="item.category" class="material-category">{{ item.category }}</span>
              </div>
              <p>{{ itemDescription(item) || pageConfig.emptyDescription }}</p>
              <div v-if="itemTags(item).length" class="material-tags" aria-label="素材标签">
                <span v-for="tag in itemTags(item)" :key="tag">{{ tag }}</span>
              </div>
              <div class="material-card__actions">
                <el-button class="secondary-action" size="small" @click="openEdit(item)">编辑</el-button>
                <el-button size="small" type="danger" plain @click="deleteItem(item)">删除</el-button>
              </div>
            </div>
          </article>

          <div v-if="!loading && items.length === 0" class="material-empty">
            <el-icon><component :is="pageConfig.icon" /></el-icon>
            <h2>暂无{{ pageConfig.shortTitle }}</h2>
            <p>{{ pageConfig.emptyHint }}</p>
          </div>
        </div>

        <div v-if="total > pageSize" class="material-pagination">
          <el-pagination
            v-model:current-page="page"
            :page-size="pageSize"
            :total="total"
            layout="prev, pager, next"
            @current-change="loadList"
          />
        </div>
      </section>
    </main>

    <el-dialog
      v-model="editVisible"
      class="material-edit-dialog"
      :title="`编辑${pageConfig.shortTitle}`"
      width="520px"
      :close-on-click-modal="false"
      @closed="editForm = null"
    >
      <el-form v-if="editForm" label-position="top">
        <el-form-item label="素材图片">
          <div class="image-editor">
            <button type="button" class="image-editor__preview" @click="openPreview(editForm)">
              <img v-if="assetImageUrl(editForm)" :src="assetImageUrl(editForm)" alt="" />
              <el-icon v-else><PictureFilled /></el-icon>
            </button>
            <div class="image-editor__actions">
              <el-button :loading="editForm.imgUploading" @click="fileInput?.click()">上传图片</el-button>
              <el-button type="primary" :loading="editForm.imgGenerating" @click="generateImage">
                AI 生成
              </el-button>
            </div>
          </div>
          <input ref="fileInput" type="file" accept="image/*" hidden @change="uploadImage" />
        </el-form-item>
        <el-form-item :label="pageConfig.nameLabel">
          <el-input v-model="editForm[pageConfig.nameKey]" :placeholder="pageConfig.namePlaceholder" />
        </el-form-item>
        <el-form-item v-if="kind === 'scene'" label="时间">
          <el-input v-model="editForm.time" placeholder="如：清晨、黄昏、夜晚" />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="editForm.category" placeholder="可选" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editForm.description" type="textarea" :rows="4" placeholder="补充外观、环境或用途描述" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="editForm.tags" placeholder="可选，使用逗号分隔" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewVisible" class="material-preview-dialog" title="素材预览" width="820px">
      <div class="material-preview">
        <img v-if="previewItem && assetImageUrl(previewItem)" :src="assetImageUrl(previewItem)" :alt="itemName(previewItem)" />
        <div v-else class="material-preview__empty">暂无可预览图片</div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Box,
  Files,
  PictureFilled,
  Refresh,
  Search,
  User,
} from '@element-plus/icons-vue'
import PlatformHeader from '@/components/PlatformHeader.vue'
import { characterLibraryAPI } from '@/api/characterLibrary'
import { sceneLibraryAPI } from '@/api/sceneLibrary'
import { propLibraryAPI } from '@/api/propLibrary'
import { uploadAPI } from '@/api/upload'
import { imagesAPI } from '@/api/images'
import { taskAPI } from '@/api/task'

const props = defineProps({
  kind: {
    type: String,
    required: true,
    validator: (value) => ['character', 'scene', 'prop'].includes(value),
  },
})

const router = useRouter()
const pageConfigs = {
  character: {
    title: '素材角色',
    shortTitle: '角色',
    description: '沉淀可跨项目复用的角色形象、外观说明与标签，让人物设定保持一致。',
    emptyHint: '在短剧项目中将角色加入素材库后，会自动出现在这里。',
    emptyDescription: '暂未补充角色描述',
    searchPlaceholder: '搜索角色名称或描述',
    nameLabel: '名称',
    nameKey: 'name',
    namePlaceholder: '角色名称',
    icon: User,
    api: characterLibraryAPI,
  },
  scene: {
    title: '素材场景',
    shortTitle: '场景',
    description: '集中管理地点、时间、环境与光线设定，在不同分镜间复用一致的空间语言。',
    emptyHint: '在短剧项目中将场景加入素材库后，会自动出现在这里。',
    emptyDescription: '暂未补充场景描述',
    searchPlaceholder: '搜索场景地点或描述',
    nameLabel: '地点',
    nameKey: 'location',
    namePlaceholder: '场景地点',
    icon: PictureFilled,
    api: sceneLibraryAPI,
  },
  prop: {
    title: '素材道具',
    shortTitle: '道具',
    description: '保存关键物件的造型、用途与细节，保证跨镜头出现时视觉连续。',
    emptyHint: '在短剧项目中将道具加入素材库后，会自动出现在这里。',
    emptyDescription: '暂未补充道具描述',
    searchPlaceholder: '搜索道具名称或描述',
    nameLabel: '名称',
    nameKey: 'name',
    namePlaceholder: '道具名称',
    icon: Box,
    api: propLibraryAPI,
  },
}
const materialTabs = [
  { kind: 'character', label: '角色', routeName: 'material-characters', icon: User },
  { kind: 'scene', label: '场景', routeName: 'material-scenes', icon: PictureFilled },
  { kind: 'prop', label: '道具', routeName: 'material-props', icon: Box },
]
const pageConfig = computed(() => pageConfigs[props.kind])
const kind = computed(() => props.kind)

const loading = ref(false)
const items = ref([])
const keyword = ref('')
const page = ref(1)
const pageSize = ref(24)
const total = ref(0)
const editVisible = ref(false)
const editForm = ref(null)
const saving = ref(false)
const fileInput = ref(null)
const previewVisible = ref(false)
const previewItem = ref(null)

function itemName(item) {
  if (!item) return '未命名'
  return String(item[pageConfig.value.nameKey] || item.time || '未命名')
}

function itemDescription(item) {
  return String(item?.description || item?.prompt || '').trim()
}

function itemTags(item) {
  if (Array.isArray(item?.tags)) return item.tags.filter(Boolean).slice(0, 4)
  return String(item?.tags || '')
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 4)
}

function assetImageUrl(item) {
  const localPath = String(item?.local_path || '').trim()
  if (localPath) return `/static/${localPath.replace(/^\/+/, '')}`
  return item?.image_url || ''
}

async function loadList() {
  loading.value = true
  try {
    const response = await pageConfig.value.api.list({
      page: page.value,
      page_size: pageSize.value,
      keyword: keyword.value.trim() || undefined,
      global: 1,
    })
    items.value = response?.items ?? []
    total.value = response?.pagination?.total ?? 0
  } catch (error) {
    items.value = []
    total.value = 0
    ElMessage.error(error?.message || `${pageConfig.value.shortTitle}素材加载失败`)
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  loadList()
}

function changePageSize() {
  page.value = 1
  loadList()
}

function openPreview(item) {
  previewItem.value = item
  previewVisible.value = true
}

function openEdit(item) {
  editForm.value = {
    ...item,
    category: item.category ?? '',
    description: item.description ?? '',
    tags: Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags ?? ''),
    image_url: item.image_url ?? '',
    local_path: item.local_path ?? null,
    imgUploading: false,
    imgGenerating: false,
  }
  editVisible.value = true
}

function editPayload() {
  const form = editForm.value
  const payload = {
    category: form.category || null,
    description: form.description || null,
    tags: form.tags || null,
    image_url: form.image_url || null,
    local_path: form.local_path ?? null,
  }
  payload[pageConfig.value.nameKey] = form[pageConfig.value.nameKey] || ''
  if (props.kind === 'scene') payload.time = form.time || null
  return payload
}

async function saveEdit() {
  if (!editForm.value?.id) return
  saving.value = true
  try {
    await pageConfig.value.api.update(editForm.value.id, editPayload())
    editVisible.value = false
    ElMessage.success('素材已保存')
    await loadList()
  } catch (error) {
    ElMessage.error(error?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function deleteItem(item) {
  try {
    await ElMessageBox.confirm(`确定删除${pageConfig.value.shortTitle}「${itemName(item).slice(0, 20)}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await pageConfig.value.api.delete(item.id)
    ElMessage.success('素材已删除')
    await loadList()
  } catch (error) {
    ElMessage.error(error?.message || '删除失败')
  }
}

async function uploadImage(event) {
  const file = event.target?.files?.[0]
  if (event.target) event.target.value = ''
  if (!file || !editForm.value?.id) return
  editForm.value.imgUploading = true
  try {
    const response = await uploadAPI.uploadImage(file)
    const data = response?.data ?? response
    const imageUrl = data?.url || data?.path || data?.local_path
    if (!imageUrl) throw new Error('上传未返回图片地址')
    editForm.value.image_url = imageUrl
    editForm.value.local_path = data?.local_path ?? null
    await pageConfig.value.api.update(editForm.value.id, {
      image_url: imageUrl,
      local_path: data?.local_path ?? null,
    })
    ElMessage.success('图片已更新')
    await loadList()
  } catch (error) {
    ElMessage.error(error?.message || '上传失败')
  } finally {
    editForm.value.imgUploading = false
  }
}

function generationPrompt() {
  if (!editForm.value) return ''
  if (props.kind === 'scene') {
    return [editForm.value.location, editForm.value.time, editForm.value.description].filter(Boolean).join(', ')
  }
  return [editForm.value.name, editForm.value.description].filter(Boolean).join(', ')
}

async function generateImage() {
  const prompt = generationPrompt().trim()
  if (!prompt) {
    ElMessage.warning(`请先填写${pageConfig.value.nameLabel}或描述`)
    return
  }
  editForm.value.imgGenerating = true
  try {
    const response = await imagesAPI.create({ prompt, drama_id: null })
    const taskId = (response?.data ?? response)?.task_id
    if (!taskId) throw new Error('未返回任务 ID')
    let task = null
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const taskResponse = await taskAPI.get(taskId)
      task = taskResponse?.data ?? taskResponse
      if (task?.status === 'completed') break
      if (task?.status === 'failed') throw new Error(task.error || '生成失败')
    }
    if (task?.status !== 'completed') throw new Error('生成超时')
    const imageUrl = task.result?.image_url || ''
    const localPath = task.result?.local_path ?? null
    if (!imageUrl && !localPath) throw new Error('未获取到图片地址')
    editForm.value.image_url = imageUrl
    editForm.value.local_path = localPath
    await pageConfig.value.api.update(editForm.value.id, {
      image_url: imageUrl || null,
      local_path: localPath,
    })
    ElMessage.success('AI 图片已生成')
    await loadList()
  } catch (error) {
    ElMessage.error(error?.message || '生成失败')
  } finally {
    editForm.value.imgGenerating = false
  }
}

watch(
  () => props.kind,
  () => {
    keyword.value = ''
    page.value = 1
    items.value = []
    loadList()
  },
)

onMounted(loadList)
</script>

<style scoped>
.material-library-page {
  --el-color-primary: #ff7139;
  --el-color-primary-light-3: #ff9167;
  --el-color-primary-light-5: #ffab8d;
  --el-color-primary-light-8: #3a2118;
  --el-color-primary-light-9: #24150f;
  min-height: 100vh;
  color: #f5f5f5;
  background:
    radial-gradient(circle at 50% -20%, rgba(255, 113, 57, .14), transparent 38%),
    #080808;
}

.material-library-main {
  width: min(1480px, calc(100vw - 56px));
  margin: 0 auto;
  padding: 56px 0 72px;
}

.material-hero {
  margin-bottom: 30px;
}

.material-hero__eyebrow {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  padding: 0 10px;
  border: 1px solid rgba(255, 113, 57, .32);
  border-radius: 999px;
  color: #ff956d;
  background: rgba(255, 113, 57, .08);
  font-size: 12px;
  font-weight: 700;
}

.material-hero__row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-top: 16px;
}

.material-hero h1 {
  margin: 0;
  color: #fff;
  font-size: clamp(34px, 4vw, 56px);
  letter-spacing: -.045em;
}

.material-hero p {
  max-width: 760px;
  margin: 14px 0 0;
  color: #919191;
  font-size: 15px;
  line-height: 1.75;
}

.material-total {
  flex: 0 0 auto;
  color: #777;
  font-size: 13px;
}

.material-tabs {
  display: inline-flex;
  gap: 6px;
  margin-bottom: 18px;
  padding: 5px;
  border: 1px solid #272727;
  border-radius: 14px;
  background: #111;
}

.material-tab {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  gap: 7px;
  padding: 0 16px;
  border-radius: 10px;
  color: #8f8f8f;
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  transition: color .18s ease, background-color .18s ease;
}

.material-tab:hover,
.material-tab:focus-visible {
  outline: none;
  color: #fff;
  background: #1c1c1c;
}

.material-tab:focus-visible {
  box-shadow: 0 0 0 2px rgba(255, 113, 57, .7);
}

.material-tab.is-active {
  color: #fff;
  background: rgba(255, 113, 57, .16);
}

.material-workspace {
  min-height: 440px;
  padding: 22px;
  border: 1px solid #252525;
  border-radius: 20px;
  background: rgba(17, 17, 17, .94);
  box-shadow: 0 22px 60px rgba(0, 0, 0, .26);
}

.material-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 22px;
}

.material-search {
  width: min(480px, 100%);
}

.page-size-select {
  width: 150px;
  margin-left: auto;
}

.secondary-action {
  --el-button-bg-color: #171717;
  --el-button-border-color: #303030;
  --el-button-text-color: #c7c7c7;
  --el-button-hover-bg-color: #211710;
  --el-button-hover-border-color: #ff7139;
  --el-button-hover-text-color: #ff9a72;
}

.material-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 16px;
  min-height: 340px;
}

.material-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid #292929;
  border-radius: 15px;
  background: #141414;
  transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
}

.material-card:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 113, 57, .58);
  box-shadow: 0 18px 38px rgba(0, 0, 0, .35);
}

.material-cover {
  position: relative;
  display: flex;
  width: 100%;
  aspect-ratio: 16 / 11;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 0;
  border-bottom: 1px solid #252525;
  color: #686868;
  background: #0e0e0e;
  cursor: zoom-in;
}

.material-cover:focus-visible {
  outline: 2px solid #ff7139;
  outline-offset: -2px;
}

.material-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform .25s ease;
}

.material-card:hover .material-cover img {
  transform: scale(1.025);
}

.material-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  font-size: 12px;
}

.material-placeholder .el-icon {
  font-size: 32px;
}

.material-card__body {
  padding: 15px;
}

.material-card__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.material-card h2 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: #f2f2f2;
  font-size: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.material-category {
  flex: 0 0 auto;
  max-width: 90px;
  overflow: hidden;
  padding: 3px 7px;
  border: 1px solid #353535;
  border-radius: 999px;
  color: #9f9f9f;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.material-card p {
  min-height: 42px;
  margin: 10px 0 12px;
  overflow: hidden;
  color: #818181;
  font-size: 12px;
  line-height: 1.7;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.material-tags {
  display: flex;
  min-height: 23px;
  gap: 6px;
  overflow: hidden;
}

.material-tags span {
  padding: 3px 7px;
  border-radius: 999px;
  color: #a3a3a3;
  background: #202020;
  font-size: 10px;
  white-space: nowrap;
}

.material-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #242424;
}

.material-empty {
  grid-column: 1 / -1;
  display: flex;
  min-height: 330px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #666;
  text-align: center;
}

.material-empty > .el-icon {
  font-size: 48px;
}

.material-empty h2 {
  margin: 14px 0 5px;
  color: #cfcfcf;
  font-size: 18px;
}

.material-empty p {
  margin: 0;
  color: #747474;
  font-size: 13px;
}

.material-pagination {
  display: flex;
  justify-content: center;
  margin-top: 24px;
}

.image-editor {
  display: flex;
  align-items: center;
  gap: 16px;
}

.image-editor__preview {
  display: flex;
  width: 108px;
  height: 108px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid #303030;
  border-radius: 12px;
  color: #707070;
  background: #0e0e0e;
  cursor: zoom-in;
}

.image-editor__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-editor__actions {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.material-preview {
  display: flex;
  min-height: 360px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 12px;
  background: #050505;
}

.material-preview img {
  max-width: 100%;
  max-height: 68vh;
  object-fit: contain;
}

.material-preview__empty {
  color: #666;
}

:global(.material-edit-dialog.el-dialog),
:global(.material-preview-dialog.el-dialog) {
  --el-bg-color: #111;
  --el-bg-color-overlay: #111;
  --el-fill-color-blank: #171717;
  --el-border-color: #303030;
  --el-border-color-light: #292929;
  --el-text-color-primary: #f5f5f5;
  --el-text-color-regular: #bcbcbc;
  --el-text-color-secondary: #7d7d7d;
  border: 1px solid #2b2b2b;
  border-radius: 16px;
  background: #111 !important;
  box-shadow: 0 28px 90px rgba(0, 0, 0, .68);
}

:global(.material-edit-dialog .el-dialog__title),
:global(.material-preview-dialog .el-dialog__title),
:global(.material-edit-dialog .el-form-item__label) {
  color: #f2f2f2 !important;
}

:deep(.el-input__wrapper),
:deep(.el-select__wrapper),
:deep(.el-textarea__inner),
:global(.material-edit-dialog .el-input__wrapper),
:global(.material-edit-dialog .el-textarea__inner) {
  color: #e4e4e4 !important;
  background: #171717 !important;
  box-shadow: 0 0 0 1px #303030 inset !important;
}

:deep(.el-input__wrapper.is-focus),
:deep(.el-select__wrapper.is-focused),
:global(.material-edit-dialog .el-input__wrapper.is-focus),
:global(.material-edit-dialog .el-textarea__inner:focus) {
  box-shadow: 0 0 0 1px #ff7139 inset !important;
}

:deep(.el-input__inner),
:deep(.el-select__selected-item),
:deep(.el-pagination),
:global(.material-edit-dialog .el-input__inner),
:global(.material-edit-dialog .el-textarea__inner) {
  color: #e4e4e4 !important;
}

:global(html.light) .material-library-page {
  color: #f5f5f5;
  background:
    radial-gradient(circle at 50% -20%, rgba(255, 113, 57, .14), transparent 38%),
    #080808;
}

@media (max-width: 760px) {
  .material-library-main {
    width: calc(100vw - 24px);
    padding-top: 34px;
  }

  .material-hero__row {
    display: block;
  }

  .material-total {
    display: inline-block;
    margin-top: 16px;
  }

  .material-tabs {
    display: flex;
    width: 100%;
  }

  .material-tab {
    flex: 1;
    justify-content: center;
  }

  .material-workspace {
    padding: 14px;
  }

  .material-toolbar {
    flex-wrap: wrap;
  }

  .material-search,
  .page-size-select {
    width: 100%;
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .material-card,
  .material-cover img {
    transition: none;
  }
}
</style>
