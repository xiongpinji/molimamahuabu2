<template>
  <article :id="assetAnchor(asset)" class="asset-card" tabindex="-1">
    <header class="asset-heading">
      <div>
        <p class="asset-kind">{{ kindLabel }}</p>
        <h3>{{ asset.localized_name || `${kindLabel}资产` }}</h3>
      </div>
      <el-tag :type="isApprovedAsset(asset) ? 'success' : asset.approval_status === 'rejected' ? 'danger' : 'warning'">{{ reviewLabel(asset) }}</el-tag>
    </header>

    <div v-if="asset.kind === 'character'" class="media-grid three-view-grid" aria-label="角色三视图">
      <div v-for="view in ['正面', '侧面', '背面']" :key="view" class="media-tile"><span>{{ view }}</span></div>
    </div>
    <div v-else-if="asset.kind === 'scene'" class="scene-panel">
      <div class="scene-tabs">
        <button v-for="item in sceneModes" :key="item.key" type="button" :class="{ active: sceneMode === item.key }" @click="sceneMode = item.key">{{ item.label }}</button>
      </div>
      <div class="media-tile scene-media"><span>{{ sceneModes.find((item) => item.key === sceneMode)?.label }}</span></div>
    </div>
    <div v-else class="media-tile"><span>{{ asset.kind === 'prop' ? '物品文字与参考' : '目标音色证据' }}</span></div>

    <p v-if="asset.localized_description" class="asset-description">{{ asset.localized_description }}</p>
    <div class="asset-actions">
      <strong class="canvas-credit-callout-v1">{{ quote > 0 ? `本次预计扣除 ${quote} 积分` : '积分待管理员配置' }}</strong>
      <div class="action-buttons">
        <el-button size="small" :icon="Refresh" :disabled="quote <= 0" @click="emit('generate', asset)">重绘</el-button>
        <el-button size="small" type="success" :icon="Check" :disabled="!asset.asset_id && !asset.voice_asset_id && !asset.clean_plate_asset_id" @click="emit('review', asset, 'approved')">批准</el-button>
        <el-button size="small" type="danger" plain :icon="CloseBold" @click="emit('review', asset, 'rejected')">退回</el-button>
      </div>
    </div>
  </article>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Check, CloseBold, Refresh } from '@element-plus/icons-vue'
import { ASSET_KINDS, assetAnchor, isApprovedAsset, reviewLabel } from '@/utils/redrawAssetState'

const props = defineProps({
  asset: { type: Object, required: true },
  quote: { type: Number, default: 0 },
})
const emit = defineEmits(['generate', 'review'])
const sceneMode = ref('source')
const sceneModes = [
  { key: 'source', label: '原场景' },
  { key: 'localized', label: '本地化' },
  { key: 'clean_plate', label: '去人净景' },
]
const kindLabel = computed(() => ASSET_KINDS.find((item) => item.key === props.asset.kind)?.label || '资产')
</script>

<style scoped>
.asset-card { display: grid; gap: 12px; min-width: 0; box-sizing: border-box; padding: 16px; border: 1px solid #2a2a2a; border-radius: 8px; background: #151515; }
.asset-heading, .asset-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-width: 0; }
.asset-heading > div { min-width: 0; }
.asset-kind { margin: 0 0 4px; color: #ff9a6d; font-size: 11px; font-weight: 800; }
h3 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
.media-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.media-tile { display: grid; place-items: end start; aspect-ratio: 4 / 3; min-width: 0; padding: 10px; border: 1px solid #343434; border-radius: 6px; background: linear-gradient(135deg, #252525, #101010); color: #bbb; }
.scene-panel { display: grid; gap: 8px; }
.scene-tabs { display: flex; gap: 6px; overflow-x: auto; }
.scene-tabs button { flex: 0 0 auto; padding: 7px 10px; border: 1px solid #353535; border-radius: 6px; background: #111; color: #aaa; }
.scene-tabs button.active { border-color: #ff7139; color: #fff; }
.scene-media { aspect-ratio: 16 / 9; }
.asset-description { margin: 0; color: #aaa; line-height: 1.5; overflow-wrap: anywhere; }
.asset-actions { align-items: flex-end; flex-wrap: wrap; }
.canvas-credit-callout-v1 { color: #fff; font-size: 13px; font-weight: 800; }
.action-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
@media (max-width: 600px) { .asset-actions { align-items: stretch; flex-direction: column; } .action-buttons { width: 100%; } .action-buttons :deep(.el-button) { flex: 1; min-width: 0; } }
</style>
