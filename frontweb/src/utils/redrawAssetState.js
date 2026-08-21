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

export function confirmSingleAssetQuote(asset, quote) {
  const displayedHash = String(asset?.quote_hash || '')
  const nextHash = String(quote?.quote_hash || '')
  return {
    confirmed: quote?.priced === true && Boolean(displayedHash && nextHash && displayedHash === nextHash),
    quoteHash: nextHash,
    asset: {
      ...asset,
      quote_credits: quote?.credits || null,
      quote_hash: nextHash,
    },
  }
}

export function singleAssetGenerationNotice(result) {
  const status = String(result?.asset?.status || result?.status || '')
  return status === 'needs_attention'
    ? { type: 'warning', message: '资产生成结果需要人工确认' }
    : { type: 'success', message: '资产生成任务已完成' }
}

export function assetBatchCredits(quote) {
  const credits = Number(quote?.total_credits)
  return quote?.priced === true && Number.isSafeInteger(credits) && credits > 0 ? credits : null
}

function batchBlockers(quote) {
  const hasBlocked = Array.isArray(quote?.blocked)
  const hasBlocking = Array.isArray(quote?.blocking)
  if (!hasBlocked && !hasBlocking) return null
  return [
    ...(hasBlocked ? quote.blocked : []),
    ...(hasBlocking ? quote.blocking : []),
  ]
}

export function canStartAssetBatch(quote, batch) {
  const blockers = batchBlockers(quote)
  const items = Array.isArray(quote?.items) ? quote.items : null
  const status = String(batch?.status || '')
  return assetBatchCredits(quote) !== null
    && Array.isArray(blockers)
    && blockers.length === 0
    && (!items || items.length > 0)
    && !['pending', 'processing', 'partial_failed', 'needs_attention'].includes(status)
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

function nonNegativeFinite(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

export function assetBatchProgress(batch) {
  const totalCount = nonNegativeFinite(batch?.total_count ?? batch?.totalCount)
  const successCount = nonNegativeFinite(batch?.success_count ?? batch?.successCount)
  const failedCount = nonNegativeFinite(batch?.failed_count ?? batch?.failedCount)
  const done = successCount + failedCount
  const percent = totalCount > 0 ? Math.max(0, Math.min(100, Math.round((done / totalCount) * 100))) : 0
  return { percent, successCount, failedCount, totalCount }
}

export function isAssetVersionContextCurrent(expected, current) {
  return String(expected ?? '') === String(current ?? '')
}

export function reviewLabel(asset) {
  if (isApprovedAsset(asset)) return '已批准'
  if (asset?.approval_status === 'rejected') return '已退回'
  if (asset?.status === 'failed') return '生成失败'
  return '待审核'
}
