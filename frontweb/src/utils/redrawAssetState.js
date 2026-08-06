export const ASSET_KINDS = [
  { key: 'character', label: '角色' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '物品' },
  { key: 'voice', label: '音色' },
]

export function isApprovedAsset(asset) {
  return asset?.approval_status === 'approved'
    && ['generated', 'needs_attention'].includes(String(asset?.status || ''))
}

export function assetAnchor(asset) {
  return `asset-${asset?.id || asset?.asset_id || 'unknown'}-${asset?.kind || 'asset'}`
}

export function groupAssets(assets, kind) {
  return (Array.isArray(assets) ? assets : []).filter((asset) => !kind || asset.kind === kind)
}

export function generationGateOpen(gate) {
  return gate?.ok === true && (!Array.isArray(gate.missing) || gate.missing.length === 0)
}

export function canGenerateAsset(asset, quote) {
  const credits = Number(quote)
  return Boolean(asset?.id) && Number.isSafeInteger(credits) && credits > 0
}

export function reviewLabel(asset) {
  if (isApprovedAsset(asset)) return '已批准'
  if (asset?.approval_status === 'rejected') return '已退回'
  if (asset?.status === 'failed') return '生成失败'
  return '待审核'
}
