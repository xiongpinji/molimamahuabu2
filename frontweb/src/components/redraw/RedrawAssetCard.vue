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
        <span>状态</span>
        <strong :class="{ ready: identityPack.ready }">{{ identityPack.ready ? 'ready' : '缺项' }}</strong>
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
    </div>
    <div class="asset-actions">
      <strong class="canvas-credit-callout-v1">{{ quote > 0 ? `本次预计扣除 ${quote} 积分` : '积分待管理员配置' }}</strong>
      <div class="action-buttons">
        <el-button size="small" :icon="Refresh" :disabled="quote <= 0" @click="emit('generate', asset)">重绘</el-button>
        <el-button v-if="asset.kind === 'character'" size="small" type="primary" :loading="identitySaving" @click="saveIdentityPack">保存身份包</el-button>
        <el-button size="small" type="success" :icon="Check" :disabled="approveDisabled" @click="emit('review', asset, 'approved')">批准</el-button>
        <el-button size="small" type="danger" plain :icon="CloseBold" @click="emit('review', asset, 'rejected')">退回</el-button>
      </div>
    </div>
  </article>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, CloseBold, Refresh } from '@element-plus/icons-vue'
import { redrawAPI } from '@/api/redraw'
import { isRedrawCharacterIdentityPackReady, projectRedrawCharacterIdentityPack } from '@/utils/redrawCharacterIdentity'
import { ASSET_KINDS, assetAnchor, isApprovedAsset, reviewLabel } from '@/utils/redrawAssetState'

const props = defineProps({
  asset: { type: Object, required: true },
  quote: { type: Number, default: 0 },
})
const emit = defineEmits(['generate', 'review', 'identity-saved'])
const sceneMode = ref(props.asset.kind === 'scene' && props.asset.asset_id ? 'localized' : 'source')
const previewUrl = ref('')
const previewLoading = ref(false)
const previewFailed = ref(false)
const identitySaving = ref(false)
const identityForm = ref({
  target_actor_label: '',
  confirmed_views: [],
  live_action_human_confirmed: false,
  adult_status: false,
  identity_consistency_confirmed: false,
})
let previewRequestId = 0
const sceneModes = [
  { key: 'source', label: '原场景' },
  { key: 'localized', label: '本地化' },
  { key: 'clean_plate', label: '去人净景' },
]
const kindLabel = computed(() => ASSET_KINDS.find((item) => item.key === props.asset.kind)?.label || '资产')
const identityPack = computed(() => (props.asset.kind === 'character' ? projectRedrawCharacterIdentityPack(props.asset) : null))
const approveDisabled = computed(() => (
  (!props.asset.asset_id && !props.asset.voice_asset_id && !props.asset.clean_plate_asset_id)
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
  }
}

function releasePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}

async function saveIdentityPack() {
  if (props.asset.kind !== 'character' || identitySaving.value) return
  identitySaving.value = true
  try {
    await redrawAPI.saveRedrawCharacterIdentityPack(props.asset.id, {
      target_actor_label: identityForm.value.target_actor_label,
      confirmed_views: identityForm.value.confirmed_views,
      live_action_human_confirmed: identityForm.value.live_action_human_confirmed,
      adult_status: identityForm.value.adult_status ? 'verified_18_plus' : 'unverified',
      identity_consistency_confirmed: identityForm.value.identity_consistency_confirmed,
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

onBeforeUnmount(() => {
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
.identity-form :deep(.el-checkbox-group) { display: flex; flex-wrap: wrap; gap: 10px 12px; }
.asset-actions { align-items: flex-end; flex-wrap: wrap; }
.canvas-credit-callout-v1 { color: #fff; font-size: 13px; font-weight: 800; }
.action-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
@media (max-width: 600px) { .asset-actions { align-items: stretch; flex-direction: column; } .action-buttons { width: 100%; } .action-buttons :deep(.el-button) { flex: 1; min-width: 0; } }
</style>
