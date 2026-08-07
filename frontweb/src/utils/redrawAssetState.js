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

export function assetBatchCredits(quote) {
  const credits = Number(quote?.total_credits)
  return quote?.priced === true && Number.isSafeInteger(credits) && credits > 0 ? credits : null
}

function batchBlockers(quote) {
  if (Array.isArray(quote?.blocked)) return quote.blocked
  if (Array.isArray(quote?.blocking)) return quote.blocking
  return null
}

export function canStartAssetBatch(quote, batch) {
  const blockers = batchBlockers(quote)
  const items = Array.isArray(quote?.items) ? quote.items : null
  const status = String(batch?.status || '')
  return assetBatchCredits(quote) !== null
    && Array.isArray(blockers)
    && blockers.length === 0
    && (!items || items.length > 0)
    && !['pending', 'processing'].includes(status)
}

export function failedAssetIds(source) {
  const seen = new Set()
  const ids = []
  for (const item of Array.isArray(source?.items) ? source.items : []) {
    const id = Number(item?.asset_id || item?.id)
    if (item?.status === 'failed' && Number.isSafeInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

export function assetBatchProgress(batch) {
  const totalCount = Math.max(0, Number(batch?.total_count || batch?.totalCount || 0))
  const successCount = Math.max(0, Number(batch?.success_count || batch?.successCount || 0))
  const failedCount = Math.max(0, Number(batch?.failed_count || batch?.failedCount || 0))
  const done = successCount + failedCount
  const percent = totalCount > 0 ? Math.max(0, Math.min(100, Math.round((done / totalCount) * 100))) : 0
  return { percent, successCount, failedCount, totalCount }
}

export function reviewLabel(asset) {
  if (isApprovedAsset(asset)) return '已批准'
  if (asset?.approval_status === 'rejected') return '已退回'
  if (asset?.status === 'failed') return '生成失败'
  return '待审核'
}
