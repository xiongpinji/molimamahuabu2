<template>
  <article :id="assetAnchor(asset)" class="asset-card" tabindex="-1">
    <header class="asset-heading">
      <div>
        <p class="asset-kind">{{ kindLabel }}</p>
        <h3>{{ asset.localized_name || `${kindLabel}资产` }}</h3>
      </div>
      <el-tag :type="isApprovedAsset(asset) ? 'success' : asset.approval_status === 'rejected' ? 'danger' : 'warning'">{{ reviewLabel(asset) }}</el-tag>
    </header>

    <div v-if="asset.kind === 'character'" class="media-preview character-preview" aria-label="角色身份包预览">
      <img v-if="previewUrl" :src="previewUrl" :alt="`${asset.localized_name || '角色'}真人参考图`" />
      <span v-if="previewUrl" class="media-label">{{ identityPack?.confirmedViewLabels.length ? identityPack.confirmedViewLabels.join(' / ') : '身份包视图证据' }}</span>
      <span v-else class="preview-empty">{{ emptyPreviewText }}</span>
    </div>
    <div v-else-if="asset.kind === 'scene'" class="scene-panel">
      <div class="scene-tabs">
        <button v-for="item in sceneModes" :key="item.key" type="button" :class="{ active: sceneMode === item.key }" @click="sceneMode = item.key">{{ item.label }}</button>
      </div>
      <div class="media-preview scene-media">
        <img v-if="previewUrl" :src="previewUrl" :alt="`${asset.localized_name || '场景'}${previewLabel}`" />
        <span v-if="previewUrl" class="media-label">{{ previewLabel }}</span>
        <span v-else class="preview-empty">{{ emptyPreviewText }}</span>
      </div>
    </div>
    <div v-else-if="asset.kind === 'prop'" class="media-preview prop-preview">
      <img v-if="previewUrl" :src="previewUrl" :alt="`${asset.localized_name || '物品'}参考图`" />
      <span v-if="previewUrl" class="media-label">物品生成图</span>
      <span v-else class="preview-empty">{{ emptyPreviewText }}</span>
    </div>
    <div v-else class="media-tile"><span>目标音色证据</span></div>

    <p v-if="asset.localized_description" class="asset-description">{{ asset.localized_description }}</p>
    <div v-if="asset.kind === 'character'" class="identity-upload">
      <label>
        <span>选择身份图片</span>
        <input ref="identityFileInput" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" :disabled="uploadingIdentity || refreshingIdentity || identitySaving" @change="selectIdentityFile" />
      </label>
      <p class="identity-upload__hint">PNG / JPEG / WebP，最大 20 MiB；宽高不超过 4096 像素。上传免费，上传后需重新确认身份包。</p>
      <p v-if="identityFile" class="identity-upload__filename">{{ identityFile.name }}</p>
      <div class="action-buttons">
        <el-button size="small" :disabled="!identityFile || uploadingIdentity || refreshingIdentity" @click="cancelIdentityFile">取消选择</el-button>
        <el-button size="small" type="primary" :loading="uploadingIdentity" :disabled="!identityFile || identityRefreshRequired || identitySaving" @click="uploadIdentityReference">上传身份图片</el-button>
        <el-button v-if="identityRefreshRequired" size="small" :loading="refreshingIdentity" :disabled="uploadingIdentity || refreshingIdentity" @click="refreshIdentityReference">刷新当前角色状态</el-button>
      </div>
      <p v-if="identityUploadError" class="identity-upload__error" role="status">{{ identityUploadError }}</p>
      <p v-else-if="identityRefreshRequired" class="identity-upload__hint" role="status">正在核对当前角色状态，操作暂时冻结。</p>
    </div>
    <div v-if="identityPack" class="identity-pack">
      <div class="identity-pack__row">
        <span>目标演员</span>
        <strong>{{ identityPack.targetActorLabel || '待确认' }}</strong>
      </div>
      <div class="identity-pack__row">
        <span>三视图确认</span>
        <strong>{{ identityPack.confirmedViewLabels.length ? identityPack.confirmedViewLabels.join(' / ') : '缺项' }}</strong>
      </div>
      <div class="identity-pack__row">
        <span>真人 / 18+ / 一致性</span>
        <strong>
          {{ identityPack.liveActionHumanConfirmed ? '真人确认' : '真人缺项' }}
          · {{ identityPack.adultStatus === 'verified_18_plus' ? '18+确认' : '18+缺项' }}
          · {{ identityPack.identityConsistencyConfirmed ? '一致性确认' : '一致性缺项' }}
        </strong>
      </div>
      <div class="identity-pack__row">
        <span>服装参考 / 一致性</span>
        <strong>{{ identityPack.wardrobeReady ? `资产 ${identityPack.wardrobeReferenceAssetId} · 已确认` : '服装缺项' }}</strong>
      </div>
      <div class="identity-pack__row">
        <span>确认状态</span>
        <strong :class="{ ready: identityPack.ready }">{{ identityPack.ready ? '服务端已确认' : '服务端未确认' }}</strong>
      </div>
      <p v-if="identityPack.shortHash" class="identity-pack__hash">#{{ identityPack.shortHash }}</p>
      <p v-if="identityPack.missingLabels.length" class="identity-pack__missing">缺项：{{ identityPack.missingLabels.join('、') }}</p>
    </div>
    <div v-if="asset.kind === 'character'" class="identity-form">
      <div class="identity-form__field">
        <span>目标演员</span>
        <el-input v-model="identityForm.target_actor_label" placeholder="填写目标演员" />
      </div>
      <div class="identity-form__field">
        <span>三视图确认</span>
        <el-checkbox-group v-model="identityForm.confirmed_views">
          <el-checkbox label="front">front</el-checkbox>
          <el-checkbox label="profile">profile</el-checkbox>
          <el-checkbox label="full_body">full_body</el-checkbox>
        </el-checkbox-group>
      </div>
      <div class="identity-form__field">
        <el-checkbox v-model="identityForm.live_action_human_confirmed">真人确认</el-checkbox>
      </div>
      <div class="identity-form__field">
        <el-checkbox v-model="identityForm.adult_status">18+确认</el-checkbox>
      </div>
      <div class="identity-form__field">
        <el-checkbox v-model="identityForm.identity_consistency_confirmed">一致性确认</el-checkbox>
      </div>
      <div class="identity-form__field">
        <span>服装参考图</span>
        <el-select v-model="identityForm.wardrobe_reference_asset_id" clearable placeholder="选择当前版本已有图片资产">
          <el-option
            v-for="option in wardrobeOptions"
            :key="option.assetId"
            :label="option.label"
            :value="option.assetId"
          />
        </el-select>
      </div>
      <div class="identity-form__field">
        <el-checkbox v-model="identityForm.wardrobe_consistency_confirmed">服装一致性确认</el-checkbox>
      </div>
    </div>
    <div class="asset-actions">
      <strong class="canvas-credit-callout-v1">{{ quote > 0 ? `本次预计扣除 ${quote} 积分` : '积分待管理员配置' }}</strong>
      <div class="action-buttons">
        <el-button size="small" :icon="Refresh" :disabled="quote <= 0 || identityRefreshRequired" @click="emit('generate', asset)">重绘</el-button>
        <el-button v-if="asset.kind === 'character'" size="small" type="primary" :loading="identitySaving" :disabled="identityRefreshRequired" @click="saveIdentityPack">保存身份包</el-button>
        <el-button size="small" type="success" :icon="Check" :disabled="approveDisabled" @click="emit('review', asset, 'approved')">批准</el-button>
        <el-button size="small" type="danger" plain :icon="CloseBold" :disabled="identityRefreshRequired" @click="emit('review', asset, 'rejected')">退回</el-button>
      </div>
    </div>
  </article>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, CloseBold, Refresh } from '@element-plus/icons-vue'
import { redrawAPI } from '@/api/redraw'
import { isRedrawCharacterIdentityPackReady, projectRedrawCharacterIdentityPack } from '@/utils/redrawCharacterIdentity'
import { ASSET_KINDS, assetAnchor, isApprovedAsset, reviewLabel } from '@/utils/redrawAssetState'

const props = defineProps({
  asset: { type: Object, required: true },
  versionId: { type: [String, Number], default: null },
  identityUploadBlocked: { type: Boolean, default: false },
  quote: { type: Number, default: 0 },
  wardrobeReferenceAssets: { type: Array, default: () => [] },
})
const emit = defineEmits(['generate', 'review', 'identity-saved', 'identity-upload-state'])
const sceneMode = ref(props.asset.kind === 'scene' && props.asset.asset_id ? 'localized' : 'source')
const previewUrl = ref('')
const previewLoading = ref(false)
const previewFailed = ref(false)
const identitySaving = ref(false)
const identityFile = ref(null)
const identityFileInput = ref(null)
const uploadingIdentity = ref(false)
const refreshingIdentity = ref(false)
const identityRefreshRequired = ref(Boolean(props.identityUploadBlocked))
const identityUploadError = ref('')
let identityEpoch = 0
let identityDisposed = false
let acceptedIdentityContext = ''
let uploadedIdentity = null
const identityForm = ref({
  target_actor_label: '',
  confirmed_views: [],
  live_action_human_confirmed: false,
  adult_status: false,
  identity_consistency_confirmed: false,
  wardrobe_reference_asset_id: null,
  wardrobe_consistency_confirmed: false,
})
let previewRequestId = 0
const sceneModes = [
  { key: 'source', label: '原场景' },
  { key: 'localized', label: '本地化' },
  { key: 'clean_plate', label: '去人净景' },
]
const kindLabel = computed(() => ASSET_KINDS.find((item) => item.key === props.asset.kind)?.label || '资产')
const identityPack = computed(() => (props.asset.kind === 'character' ? projectRedrawCharacterIdentityPack(props.asset) : null))
const wardrobeOptions = computed(() => {
  const seen = new Set()
  return props.wardrobeReferenceAssets.flatMap((item) => {
    const assetId = Number(item?.asset_id)
    if (!Number.isSafeInteger(assetId) || assetId <= 0 || seen.has(assetId)) return []
    seen.add(assetId)
    return [{
      assetId,
      label: `${item.localized_name || item.display_name || item.name || `图片资产 ${assetId}`} · ${assetId}`,
    }]
  })
})
const approveDisabled = computed(() => (
  identityRefreshRequired.value
  || (!props.asset.asset_id && !props.asset.voice_asset_id && !props.asset.clean_plate_asset_id)
  || (props.asset.kind === 'character' && !isRedrawCharacterIdentityPackReady(props.asset))
))
const previewVariant = computed(() => {
  if (props.asset.kind === 'character' || props.asset.kind === 'prop') return 'primary'
  if (props.asset.kind !== 'scene') return null
  if (sceneMode.value === 'localized') return 'primary'
  if (sceneMode.value === 'clean_plate') return 'clean_plate'
  return null
})
const previewAssetId = computed(() => {
  if (previewVariant.value === 'primary') return Number(props.asset.asset_id) || null
  if (previewVariant.value === 'clean_plate') return Number(props.asset.clean_plate_asset_id) || null
  return null
})
const previewLabel = computed(() => sceneModes.find((item) => item.key === sceneMode.value)?.label || '场景')
const emptyPreviewText = computed(() => {
  if (previewLoading.value) return '正在加载图片…'
  if (previewFailed.value) return '图片不可读取，请重新生成或检查产物'
  if (props.asset.kind === 'character') return '尚未生成身份包图片'
  if (props.asset.kind === 'prop') return '尚未生成物品图片'
  if (sceneMode.value === 'source') return '原场景预览尚未生成'
  if (sceneMode.value === 'clean_plate') return '尚未生成去人净景图片'
  return '尚未生成本地化场景图片'
})

function hydrateIdentityForm() {
  const pack = props.asset?.identity_pack && typeof props.asset.identity_pack === 'object' ? props.asset.identity_pack : {}
  identityForm.value = {
    target_actor_label: String(pack.target_actor_label || '').trim(),
    confirmed_views: Array.isArray(pack.confirmed_views) ? pack.confirmed_views.filter((item) => ['front', 'profile', 'full_body'].includes(String(item))) : [],
    live_action_human_confirmed: pack.live_action_human_confirmed === true,
    adult_status: pack.adult_status === 'verified_18_plus',
    identity_consistency_confirmed: pack.identity_consistency_confirmed === true,
    wardrobe_reference_asset_id: Number.isSafeInteger(Number(pack?.wardrobe?.reference_asset_id))
      && Number(pack.wardrobe.reference_asset_id) > 0
      ? Number(pack.wardrobe.reference_asset_id)
      : null,
    wardrobe_consistency_confirmed: pack?.wardrobe?.consistency_confirmed === true,
  }
}

function releasePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}

function identityContext(asset = props.asset) {
  return JSON.stringify([props.versionId || asset.version_id, asset.version_id, asset.id, asset.kind, asset.updated_at, asset.asset_id])
}

function cancelIdentityFile() {
  identityEpoch += 1
  identityFile.value = null
  if (identityFileInput.value) identityFileInput.value.value = ''
  uploadingIdentity.value = false
  refreshingIdentity.value = false
  acceptedIdentityContext = ''
  uploadedIdentity = null
}

function selectIdentityFile(event) {
  const selected = event?.target?.files?.[0] || null
  cancelIdentityFile()
  identityFile.value = selected
  identityUploadError.value = identityRefreshRequired.value ? '上传结果尚待核对，请先刷新当前角色状态。' : ''
}

function identityFileError() {
  if (!identityFile.value) return '请先选择身份图片'
  const extension = /\.([^.]+)$/.exec(identityFile.value.name || '')?.[1]?.toLowerCase()
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[extension]
  if (!mime || identityFile.value.type !== mime) return '仅支持 PNG、JPEG 或 WebP 图片，文件类型必须匹配'
  if (identityFile.value.size <= 0 || identityFile.value.size > 20 * 1024 * 1024) return '身份图片大小必须在 0 至 20 MiB 之间'
  if (!String(props.asset.updated_at || '').trim()) return '当前角色版本信息缺失，请先刷新页面'
  return ''
}

function validIdentityUpload(result) {
  const image = result?.asset, asset = result?.redraw_asset
  return result?.purpose === 'identity' && Number.isSafeInteger(image?.id) && image.id > 0
    && image.type === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(image.mime_type)
    && /^[a-f0-9]{64}$/.test(image.sha256) && [image.width, image.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096)
    && Number.isSafeInteger(image.file_size) && image.file_size > 0 && image.file_size <= 20 * 1024 * 1024
    && asset?.id === Number(props.asset.id) && asset.asset_id === image.id && asset.status === 'generated'
    && asset.approval_status === 'pending' && typeof asset.updated_at === 'string' && Boolean(asset.updated_at.trim())
    && asset.updated_at !== props.asset.updated_at
    && result.billing?.credits === 0 && result.billing?.held === 0 && result.billing?.charged === 0
}

async function uploadIdentityReference() {
  if (props.asset.kind !== 'character' || uploadingIdentity.value || identityRefreshRequired.value || identitySaving.value) return
  identityUploadError.value = identityFileError()
  if (identityUploadError.value) return
  let idempotencyKey
  try { idempotencyKey = crypto.randomUUID() }
  catch (_) { identityUploadError.value = '无法创建安全上传标识，请刷新页面后重试'; return }
  const epoch = identityEpoch, context = identityContext()
  const isCurrent = () => !identityDisposed && identityEpoch === epoch && identityContext() === context
  identityRefreshRequired.value = true
  uploadingIdentity.value = true
  try {
    const result = await redrawAPI.uploadIdentityReference(props.asset.id, identityFile.value, {
      expected_updated_at: props.asset.updated_at, idempotencyKey,
    })
    if (!isCurrent()) return
    if (!validIdentityUpload(result)) throw new Error('上传响应不完整，不能确认绑定成功')
    uploadedIdentity = result.redraw_asset
  } catch (error) {
    if (!isCurrent()) return
    identityUploadError.value = `${error?.message || '上传结果未知'}；不会自动重传，先刷新当前角色核对。`
  } finally {
    if (isCurrent()) {
      uploadingIdentity.value = false
      refreshIdentityReference()
    }
  }
}

function refreshIdentityReference() {
  if (identityDisposed || uploadingIdentity.value || refreshingIdentity.value || !identityRefreshRequired.value) return
  const epoch = identityEpoch, context = identityContext()
  const isCurrent = () => !identityDisposed && identityEpoch === epoch && identityContext() === context
  refreshingIdentity.value = true
  emit('identity-saved', {
    assetId: props.asset.id,
    versionId: props.versionId || props.asset.version_id,
    isCurrent,
    async complete({ asset, error } = {}) {
      if (!isCurrent()) return
      const validRow = asset?.id === Number(props.asset.id) && asset.kind === 'character'
        && String(asset.version_id) === String(props.versionId || props.asset.version_id)
        && typeof asset.updated_at === 'string' && Boolean(asset.updated_at.trim())
      if (error || !validRow || (uploadedIdentity && (asset.asset_id !== uploadedIdentity.asset_id || asset.updated_at !== uploadedIdentity.updated_at))) {
        refreshingIdentity.value = false
        identityUploadError.value = '刷新失败或状态尚未同步，操作保持冻结；请刷新当前角色状态核对。'
        return
      }
      acceptedIdentityContext = identityContext(asset)
      await nextTick()
      if (identityDisposed || identityEpoch !== epoch || identityContext() !== acceptedIdentityContext) return
      const confirmedUpload = Boolean(uploadedIdentity)
      cancelIdentityFile()
      identityRefreshRequired.value = false
      identityUploadError.value = confirmedUpload ? '' : '已刷新当前角色，请核对主图；如需上传请重新选择文件。'
      if (confirmedUpload) ElMessage.success('身份图片已上传，请重新确认身份包并保存后批准')
    },
  })
}

async function saveIdentityPack() {
  if (props.asset.kind !== 'character' || identitySaving.value || identityRefreshRequired.value) return
  identitySaving.value = true
  try {
    const wardrobeReferenceAssetId = Number(identityForm.value.wardrobe_reference_asset_id)
    const wardrobeInput = Number.isSafeInteger(wardrobeReferenceAssetId) && wardrobeReferenceAssetId > 0
      ? {
          wardrobe_reference_asset_id: identityForm.value.wardrobe_reference_asset_id,
          wardrobe_consistency_confirmed: identityForm.value.wardrobe_consistency_confirmed,
        }
      : {}
    await redrawAPI.saveRedrawCharacterIdentityPack(props.asset.id, {
      target_actor_label: identityForm.value.target_actor_label,
      confirmed_views: identityForm.value.confirmed_views,
      live_action_human_confirmed: identityForm.value.live_action_human_confirmed,
      adult_status: identityForm.value.adult_status ? 'verified_18_plus' : 'unverified',
      identity_consistency_confirmed: identityForm.value.identity_consistency_confirmed,
      ...wardrobeInput,
      expected_updated_at: props.asset.updated_at,
    })
    ElMessage.success('身份包已保存，请重新批准')
    emit('identity-saved')
  } catch (error) {
    ElMessage.error(error?.message || '身份包保存失败')
  } finally {
    identitySaving.value = false
  }
}

async function loadPreview() {
  const requestId = ++previewRequestId
  releasePreview()
  previewFailed.value = false
  if (!previewVariant.value || !previewAssetId.value) {
    previewLoading.value = false
    return
  }
  previewLoading.value = true
  try {
    const blob = await redrawAPI.getAssetPreview(props.asset.id, previewVariant.value)
    const nextUrl = URL.createObjectURL(blob)
    if (requestId !== previewRequestId) {
      URL.revokeObjectURL(nextUrl)
      return
    }
    previewUrl.value = nextUrl
  } catch (_) {
    if (requestId === previewRequestId) previewFailed.value = true
  } finally {
    if (requestId === previewRequestId) previewLoading.value = false
  }
}

watch(
  () => [props.asset.id, props.asset.asset_id, props.asset.clean_plate_asset_id, previewVariant.value],
  loadPreview,
  { immediate: true },
)
watch(() => props.asset, hydrateIdentityForm, { immediate: true })
watch(() => props.identityUploadBlocked, (blocked) => {
  if (blocked) identityRefreshRequired.value = true
})
watch(identityRefreshRequired, (blocked) => {
  emit('identity-upload-state', { assetId: props.asset.id, versionId: props.versionId || props.asset.version_id, blocked })
}, { flush: 'sync' })
watch(identityContext, (context) => {
  if (context !== acceptedIdentityContext) cancelIdentityFile()
}, { flush: 'sync' })

onBeforeUnmount(() => {
  identityDisposed = true
  identityEpoch += 1
  previewRequestId += 1
  releasePreview()
})
</script>

<style scoped>
.asset-card { display: grid; gap: 12px; min-width: 0; box-sizing: border-box; padding: 16px; border: 1px solid #2a2a2a; border-radius: 8px; background: #151515; }
.asset-heading, .asset-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-width: 0; }
.asset-heading > div { min-width: 0; }
.asset-kind { margin: 0 0 4px; color: #ff9a6d; font-size: 11px; font-weight: 800; }
h3 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
.media-tile { display: grid; place-items: end start; aspect-ratio: 4 / 3; min-width: 0; padding: 10px; border: 1px solid #343434; border-radius: 6px; background: linear-gradient(135deg, #252525, #101010); color: #bbb; }
.media-preview { position: relative; display: grid; place-items: center; min-width: 0; overflow: hidden; border: 1px solid #343434; border-radius: 8px; background: #0d0d0d; }
.media-preview img { display: block; width: 100%; height: 100%; object-fit: contain; background: #0a0a0a; }
.character-preview, .prop-preview { aspect-ratio: 4 / 3; }
.media-label { position: absolute; left: 8px; bottom: 8px; padding: 4px 7px; border-radius: 4px; background: rgba(0, 0, 0, 0.72); color: #fff; font-size: 12px; }
.preview-empty { padding: 18px; color: #888; line-height: 1.5; text-align: center; }
.scene-panel { display: grid; gap: 8px; }
.scene-tabs { display: flex; gap: 6px; overflow-x: auto; }
.scene-tabs button { flex: 0 0 auto; padding: 7px 10px; border: 1px solid #353535; border-radius: 6px; background: #111; color: #aaa; }
.scene-tabs button.active { border-color: #ff7139; color: #fff; }
.scene-media { aspect-ratio: 16 / 9; }
.asset-description { margin: 0; color: #aaa; line-height: 1.5; overflow-wrap: anywhere; }
.identity-pack { display: grid; gap: 6px; padding: 12px; border: 1px solid #3a302a; border-radius: 6px; background: #1b120f; color: #f2ded4; }
.identity-pack__row { display: flex; justify-content: space-between; gap: 12px; min-width: 0; }
.identity-pack__row span { color: #c5aca0; font-size: 12px; flex: 0 0 auto; }
.identity-pack__row strong { min-width: 0; overflow-wrap: anywhere; text-align: right; }
.identity-pack__row strong.ready { color: #9ad7a8; }
.identity-pack__hash, .identity-pack__missing { margin: 0; color: #d8c2b7; font-size: 12px; overflow-wrap: anywhere; }
.identity-form { display: grid; gap: 10px; padding: 12px; border: 1px solid #313131; border-radius: 6px; background: #121212; }
.identity-form__field { display: grid; gap: 6px; min-width: 0; color: #ddd; }
.identity-form__field span { color: #aaa; font-size: 12px; }
.identity-upload { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid #383838; border-radius: 6px; }
.identity-upload label { display: grid; gap: 8px; min-width: 0; color: #ddd; }
.identity-upload input { width: 100%; min-width: 0; color: #bbb; }
.identity-upload__hint, .identity-upload__filename, .identity-upload__error { margin: 0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.identity-upload__hint { color: #aaa; }
.identity-upload__error { color: #ffb185; }
.identity-form :deep(.el-checkbox-group) { display: flex; flex-wrap: wrap; gap: 10px 12px; }
.asset-actions { align-items: flex-end; flex-wrap: wrap; }
.canvas-credit-callout-v1 { color: #fff; font-size: 13px; font-weight: 800; }
.action-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
@media (max-width: 600px) { .asset-actions { align-items: stretch; flex-direction: column; } .action-buttons { width: 100%; } .action-buttons :deep(.el-button) { flex: 1; min-width: 0; } }
</style>
