<template>
  <div class="media-library-page">
    <PlatformHeader title="媒体素材库" back-to="/" back-label="返回">
      <template #actions>
        <el-button type="primary" plain @click="triggerUpload">
          <el-icon><Upload /></el-icon>
          上传素材
        </el-button>
        <input ref="uploadInput" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.mp4,.mov,.m4a,.m4b,.webm,.wav,.mp3,.ogg,.oga,.flac,.aac" multiple style="display:none" @change="onUpload" />
      </template>
    </PlatformHeader>

    <!-- 筛选栏 -->
    <div class="filter-bar">
      <el-select
        v-model="libraryDramaId"
        class="project-filter"
        placeholder="选择素材项目"
        filterable
        @change="onLibraryDramaChange"
      >
        <el-option
          v-for="drama in libraryDramas"
          :key="drama.id"
          :label="drama.title || ('项目' + drama.id)"
          :value="drama.id"
        />
      </el-select>
      <el-radio-group v-model="mediaType" class="type-filter" @change="loadMedia">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="image">图片</el-radio-button>
        <el-radio-button value="video">视频</el-radio-button>
        <el-radio-button value="audio">音频</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="keyword"
        placeholder="搜索素材..."
        class="search-input"
        clearable
        @input="debouncedLoad"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
    </div>

    <!-- 上传进度 -->
    <div v-if="uploading" class="upload-progress">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在上传 {{ uploadProgress.current }}/{{ uploadProgress.total }}...</span>
    </div>

    <!-- 媒体网格 -->
    <div v-loading="loading" class="media-grid">
      <div
        v-for="item in mediaItems"
        :key="item.id"
        class="media-card"
        :class="{ selected: selectedIds.has(item.id), targeted: isTargetAsset(item) }"
        @click="toggleSelect(item)"
      >
        <div class="media-thumb">
          <video v-if="item.type === 'video'" :src="itemUrl(item)" class="thumb-video" muted />
          <div v-else-if="item.type === 'audio'" class="thumb-audio">♪</div>
          <img v-else :src="itemUrl(item)" class="thumb-img" />
          <span v-if="isTargetAsset(item)" class="locate-badge">画布结果定位</span>
          <div class="media-overlay">
            <el-icon v-if="selectedIds.has(item.id)" class="check-icon"><CircleCheck /></el-icon>
            <div class="overlay-actions" @click.stop>
              <el-button
                size="small"
                type="primary"
                plain
                @click.stop="openUseDialog(item)"
              >
                使用
              </el-button>
              <el-button
                size="small"
                plain
                class="preview-btn"
                @click.stop="openPreview(item)"
              >
                <el-icon><ZoomIn /></el-icon>
              </el-button>
              <el-button
                size="small"
                type="danger"
                plain
                @click.stop="deleteItem(item)"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
          </div>
        </div>
        <div class="media-info">
          <span class="media-name" :title="item.name">{{ item.name || '未命名' }}</span>
          <span class="media-meta">{{ formatSize(item.size) }}</span>
        </div>
      </div>

      <div v-if="!loading && mediaItems.length === 0" class="empty-media">
        <el-icon class="empty-icon"><Files /></el-icon>
        <p>暂无素材，点击上传按钮添加</p>
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="total > pageSize" class="pagination">
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next"
        @current-change="loadMedia"
      />
    </div>

    <!-- 批量操作 -->
    <div v-if="selectedIds.size > 0" class="batch-bar">
      <span>已选 {{ selectedIds.size }} 项</span>
      <el-button size="small" @click="selectedIds.clear()">取消选择</el-button>
      <el-button size="small" type="danger" plain @click="batchDelete">批量删除</el-button>
    </div>

    <!-- 预览弹窗 -->
    <el-dialog v-model="showPreview" title="素材预览" width="800px" destroy-on-close>
      <div class="preview-content">
        <video
          v-if="previewItem?.type === 'video'"
          :src="itemUrl(previewItem)"
          controls
          class="preview-video"
          autoplay
        />
        <audio
          v-else-if="previewItem?.type === 'audio'"
          :src="itemUrl(previewItem)"
          controls
          class="preview-audio"
        />
        <img v-else-if="previewItem" :src="itemUrl(previewItem)" class="preview-image" />
      </div>
      <div class="preview-meta">
        <div class="meta-row"><span>名称：</span>{{ previewItem?.name || '未命名' }}</div>
        <div class="meta-row"><span>大小：</span>{{ formatSize(previewItem?.size) }}</div>
        <div class="meta-row"><span>创建时间：</span>{{ previewItem?.created_at }}</div>
      </div>
    </el-dialog>

    <!-- 使用素材弹窗 -->
    <el-dialog v-model="useDialogVisible" :title="useDialogTitle" width="520px" destroy-on-close>
      <div class="use-dialog">
        <div class="use-row">
          <span class="use-label">用途</span>
          <el-radio-group v-model="usePurpose" class="purpose-group" @change="onPurposeChange">
            <template v-if="useItem?.type === 'video'">
              <el-radio-button value="attach">分镜成片</el-radio-button>
            </template>
            <template v-else-if="useItem?.type === 'audio'">
              <el-radio-button value="audio">分镜音频</el-radio-button>
            </template>
            <template v-else>
              <el-radio-button value="reference">分镜参考图</el-radio-button>
              <el-radio-button value="canvas">项目画布</el-radio-button>
            </template>
          </el-radio-group>
        </div>
        <div class="use-row">
          <span class="use-label">目标项目</span>
          <el-select v-model="useDramaId" filterable placeholder="选择项目" style="width:100%" @change="onUseDramaChange">
            <el-option v-for="d in useDramas" :key="d.id" :label="d.title || ('项目' + d.id)" :value="d.id" />
          </el-select>
        </div>
        <div v-if="needsStoryboard" class="use-row">
          <span class="use-label">目标分镜</span>
          <el-select v-model="useStoryboardId" filterable placeholder="选择分镜" style="width:100%" :disabled="!useStoryboards.length">
            <el-option v-for="s in useStoryboards" :key="s.id" :label="`第${s.storyboard_number ?? s.id}镜 ${String(s.title || s.action || '').slice(0, 20)}`" :value="s.id" />
          </el-select>
        </div>
        <p v-if="usePurpose === 'reference'" class="use-hint">设置后，该图片将作为参考图参与该分镜的图片 / 视频生成。</p>
        <p v-else-if="usePurpose === 'audio'" class="use-hint">设置后，该音频将作为该分镜对白音频，画布音频节点可直接回显和复用。</p>
        <div class="use-actions">
          <el-button @click="useDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="useSubmitting" :disabled="!useDramaId || (needsStoryboard && !useStoryboardId)" @click="submitUse">
            确定
          </el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, reactive, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Upload, Search, Loading, CircleCheck,
  ZoomIn, Delete, Files
} from '@element-plus/icons-vue'
import PlatformHeader from '@/components/PlatformHeader.vue'
import { uploadAPI } from '@/api/upload'
import { assetsAPI } from '@/api/assets'
import { videosAPI } from '@/api/videos'
import { dramaAPI } from '@/api/drama'
import { buildAssetReusePayload } from '@/utils/assetReuse'
import request from '@/utils/request'

const route = useRoute()
const loading = ref(false)
const uploading = ref(false)
const uploadProgress = ref({ current: 0, total: 0 })
const mediaItems = ref([])
const mediaType = ref('all')
const keyword = ref('')
const page = ref(1)
const pageSize = ref(30)
const total = ref(0)
const selectedIds = reactive(new Set())
const showPreview = ref(false)
const previewItem = ref(null)
const uploadInput = ref(null)
const highlightedAssetId = ref(null)
const libraryDramas = ref([])
const libraryDramaId = ref(null)
let keywordTimer = null

function applyRouteAssetFocus() {
  const id = Number(route.query.assetId)
  highlightedAssetId.value = Number.isFinite(id) && id > 0 ? id : null
  const type = String(route.query.type || '')
  if (['image', 'video', 'audio'].includes(type)) mediaType.value = type
  const routeDramaId = Number(route.query.dramaId)
  if (Number.isInteger(routeDramaId) && routeDramaId > 0) libraryDramaId.value = routeDramaId
  page.value = 1
}

async function loadLibraryDramas() {
  const res = await dramaAPI.list({ page: 1, page_size: 100 })
  libraryDramas.value = res?.items || []
  const selected = Number(libraryDramaId.value)
  if (!libraryDramas.value.some((item) => Number(item.id) === selected)) {
    libraryDramaId.value = libraryDramas.value[0]?.id || null
  }
}

async function onLibraryDramaChange() {
  page.value = 1
  selectedIds.clear()
  await loadMedia()
}

function triggerUpload() {
  if (!libraryDramaId.value) {
    ElMessage.warning('请先选择素材所属项目')
    return
  }
  uploadInput.value?.click()
}

async function onUpload(e) {
  const files = Array.from(e.target.files || [])
  if (!files.length) return
  if (!libraryDramaId.value) {
    ElMessage.warning('请先选择素材所属项目')
    e.target.value = ''
    return
  }
  uploading.value = true
  uploadProgress.value = { current: 0, total: files.length }
  let successCount = 0
  let failureCount = 0
  for (const file of files) {
    try {
      await uploadAPI.uploadMedia(file, { dramaId: libraryDramaId.value })
      successCount++
      uploadProgress.value.current++
    } catch (err) {
      failureCount++
      uploadProgress.value.current++
      ElMessage.warning(`${file.name} 上传失败: ${err.message}`)
    }
  }
  uploading.value = false
  e.target.value = ''
  if (successCount === 0) {
    ElMessage.error('全部上传失败')
  } else if (failureCount > 0) {
    ElMessage.warning(`成功 ${successCount} 个，失败 ${failureCount} 个`)
  } else {
    ElMessage.success(`${successCount} 个素材上传完成`)
  }
  loadMedia()
}

function debouncedLoad() {
  clearTimeout(keywordTimer)
  keywordTimer = setTimeout(loadMedia, 400)
}

async function loadMedia() {
  if (!libraryDramaId.value) {
    mediaItems.value = []
    total.value = 0
    return
  }
  loading.value = true
  try {
    const params = {
      page: page.value,
      page_size: pageSize.value,
    }
    params.drama_id = libraryDramaId.value
    params.include_global = 1
    if (mediaType.value !== 'all') params.type = mediaType.value
    if (keyword.value) params.keyword = keyword.value
    const res = await request.get('/assets', { params })
    mediaItems.value = (res?.items || []).map(normalizeItem)
    total.value = res?.total || 0
  } catch (err) {
    mediaItems.value = []
  } finally {
    loading.value = false
  }
}

function normalizeItem(item) {
  const url = item.url || item.image_url || item.video_url || item.audio_url || item.voice_url || ''
  const isVideo = url.match(/\.(mp4|webm|mov)$/i) || item.type === 'video'
  const isAudio = url.match(/\.(mp3|wav|m4a|aac|ogg|flac)$/i) || item.type === 'audio'
  return {
    ...item,
    type: isVideo ? 'video' : isAudio ? 'audio' : 'image',
    name: item.name || item.filename || (url.split('/').pop()),
  }
}

function staticAssetUrl(localPath) {
  const path = String(localPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^static\//, '')
  return path ? `/static/${path}` : ''
}

function itemUrl(item) {
  if (!item) return ''
  const lp = item.local_path || item.image_local_path || item.video_local_path || item.audio_local_path || item.voice_local_path
  if (lp) return staticAssetUrl(lp)
  return item.url || item.image_url || item.video_url || item.audio_url || item.voice_url || ''
}

function formatSize(size) {
  if (!size) return ''
  if (size > 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB'
  if (size > 1024) return (size / 1024).toFixed(0) + ' KB'
  return size + ' B'
}

function toggleSelect(item) {
  if (selectedIds.has(item.id)) {
    selectedIds.delete(item.id)
  } else {
    selectedIds.add(item.id)
  }
}

function isTargetAsset(item) {
  return Boolean(highlightedAssetId.value && Number(item?.id) === highlightedAssetId.value)
}

function openPreview(item) {
  previewItem.value = item
  showPreview.value = true
}

// ---------- 素材「使用」：图片→分镜参考图/项目画布；视频→复用为分镜成片；音频→分镜音频 ----------
const useDialogVisible = ref(false)
const useItem = ref(null)
const useDramas = ref([])
const useDramaId = ref(null)
const useStoryboards = ref([])
const useStoryboardId = ref(null)
const useSubmitting = ref(false)
const usePurpose = ref('reference') // reference | canvas | attach | audio

const needsStoryboard = computed(() => usePurpose.value === 'reference' || usePurpose.value === 'attach' || usePurpose.value === 'audio')
const useDialogTitle = computed(() => {
  if (usePurpose.value === 'attach') return '复用为分镜成片'
  if (usePurpose.value === 'audio') return '复用为分镜音频'
  if (usePurpose.value === 'reference') return '设为分镜参考图'
  return '添加到项目画布'
})

async function openUseDialog(item) {
  useItem.value = item
  usePurpose.value = item.type === 'video' ? 'attach' : item.type === 'audio' ? 'audio' : 'reference'
  useDramaId.value = item.drama_id || null
  useStoryboardId.value = null
  useStoryboards.value = []
  useDialogVisible.value = true
  try {
    const res = await dramaAPI.list({ page: 1, page_size: 100 })
    useDramas.value = res?.items || []
    if (useDramaId.value) {
      await onUseDramaChange(useDramaId.value)
      if (item.storyboard_id) useStoryboardId.value = item.storyboard_id
    }
  } catch (e) {
    ElMessage.error(e?.message || '项目列表加载失败')
  }
}

async function onPurposeChange() {
  // 切换到需要分镜的用途时，若尚未加载分镜列表则补加载
  if (needsStoryboard.value && useDramaId.value && !useStoryboards.value.length) {
    await onUseDramaChange(useDramaId.value)
  }
}

async function onUseDramaChange(dramaId) {
  useStoryboardId.value = null
  useStoryboards.value = []
  if (!dramaId || !needsStoryboard.value) return
  try {
    const drama = await dramaAPI.get(dramaId)
    const eps = drama?.episodes || []
    const all = []
    for (const ep of eps) {
      const sbs = ep.storyboards?.length ? ep.storyboards : (await dramaAPI.getStoryboards(ep.id)) || []
      all.push(...sbs)
    }
    useStoryboards.value = all
  } catch (e) {
    ElMessage.error(e?.message || '分镜列表加载失败')
  }
}

async function submitUse() {
  if (useSubmitting.value) return
  const item = useItem.value
  if (!item || !useDramaId.value) return
  if (needsStoryboard.value && !useStoryboardId.value) return
  useSubmitting.value = true
  let reusedAsset = null
  try {
    reusedAsset = await assetsAPI.create(buildAssetReusePayload(item, {
      purpose: usePurpose.value,
      dramaId: useDramaId.value,
      storyboardId: useStoryboardId.value,
    }))
    if (usePurpose.value === 'attach') {
      await videosAPI.attach({
        storyboard_id: useStoryboardId.value,
        drama_id: useDramaId.value,
        video_url: itemUrl(item),
        local_path: item.local_path || undefined,
        duration: item.duration ?? undefined,
      })
      ElMessage.success('已设为该分镜成片，可到画布查看')
    } else if (usePurpose.value === 'audio') {
      const localPath = item.local_path || item.audio_local_path || item.voice_local_path || ''
      await request.put(`/storyboards/${useStoryboardId.value}`, {
        audio_local_path: localPath || undefined,
        audio_url: localPath ? undefined : itemUrl(item),
      })
      ElMessage.success('已设为该分镜音频，可到画布查看')
    } else if (usePurpose.value === 'reference') {
      ElMessage.success('已设为该分镜参考图，生图/生视频时自动带入')
    } else {
      ElMessage.success('已添加到项目，画布「项目截图」区可见')
    }
    useDialogVisible.value = false
  } catch (e) {
    if (reusedAsset?.id) {
      try {
        await request.delete(`/assets/${reusedAsset.id}`, { silentError: true })
      } catch (_) {}
    }
    ElMessage.error(e?.message || '操作失败')
  } finally {
    useSubmitting.value = false
  }
}

async function deleteItem(item) {
  await ElMessageBox.confirm('确定删除该素材？', '删除确认', { type: 'warning' })
  try {
    await request.delete(`/assets/${item.id}`)
    ElMessage.success('已删除')
    loadMedia()
  } catch (err) {
    ElMessage.error(err.message || '删除失败')
  }
}

async function batchDelete() {
  const count = selectedIds.size
  await ElMessageBox.confirm(`确定删除选中的 ${count} 个素材？`, '批量删除', { type: 'warning' })
  let failed = 0
  for (const id of selectedIds) {
    try {
      await request.delete(`/assets/${id}`)
    } catch (_) { failed++ }
  }
  selectedIds.clear()
  if (failed > 0) ElMessage.warning(`${count - failed} 个删除成功，${failed} 个失败`)
  else ElMessage.success(`${count} 个素材已删除`)
  loadMedia()
}

watch(() => [route.query.assetId, route.query.type, route.query.dramaId], async () => {
  applyRouteAssetFocus()
  await loadLibraryDramas()
  await loadMedia()
})

onMounted(async () => {
  applyRouteAssetFocus()
  await loadLibraryDramas()
  await loadMedia()
})
</script>

<style scoped>
.media-library-page {
  min-height: 100vh;
  background: #f5f7fa;
  padding: 20px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: #1a1a2e;
  margin: 0;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.search-input {
  width: 240px;
}

.project-filter {
  width: 220px;
}

.upload-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: #409eff;
  font-size: 14px;
}

.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
  min-height: 200px;
}

.media-card {
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all .2s;
  box-shadow: 0 1px 4px rgba(0,0,0,.06);
}

.media-card:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,.1);
}

.media-card.selected {
  border-color: #409eff;
}

.media-card.targeted {
  border-color: #8b5cf6;
  box-shadow: 0 0 0 3px rgba(139, 92, 246, .18), 0 8px 24px rgba(80, 53, 150, .18);
}

.media-thumb {
  aspect-ratio: 1;
  background: #f3f4f6;
  overflow: hidden;
  position: relative;
}

.locate-badge {
  position: absolute;
  left: 8px;
  top: 8px;
  z-index: 2;
  padding: 3px 7px;
  border-radius: 999px;
  background: rgba(109, 40, 217, .92);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}

.thumb-img,
.thumb-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-audio {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #312e81, #111827);
  color: #c4b5fd;
  font-size: 44px;
}

.media-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,.35);
  opacity: 0;
  transition: opacity .2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.media-card:hover .media-overlay {
  opacity: 1;
}

.media-card.selected .media-overlay {
  opacity: 1;
}

.check-icon {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 20px;
  color: #409eff;
  background: #fff;
  border-radius: 50%;
}

.overlay-actions {
  display: flex;
  gap: 6px;
}

.media-info {
  padding: 8px;
}

.media-name {
  display: block;
  font-size: 12px;
  color: #374151;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.media-meta {
  font-size: 11px;
  color: #9ca3af;
}

.empty-media {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 300px;
  color: #9ca3af;
  gap: 12px;
}

.empty-icon {
  font-size: 48px;
}

.pagination {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}

.batch-bar {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: #1a1a2e;
  color: #fff;
  padding: 10px 20px;
  border-radius: 24px;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  box-shadow: 0 4px 16px rgba(0,0,0,.2);
}

.preview-content {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
}

.preview-image {
  max-width: 100%;
  max-height: 60vh;
  object-fit: contain;
}

.preview-video {
  max-width: 100%;
  max-height: 60vh;
}

.preview-audio {
  width: 100%;
  margin: 48px 24px;
}

.preview-meta {
  margin-top: 16px;
}

.meta-row {
  font-size: 13px;
  color: #6b7280;
  margin-bottom: 4px;
}

.meta-row span {
  font-weight: 500;
  color: #374151;
}

.use-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.use-label {
  display: block;
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 6px;
}

.use-hint {
  margin: 0;
  font-size: 12px;
  color: #9ca3af;
  line-height: 1.5;
}

.purpose-group {
  display: flex;
}

.use-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
