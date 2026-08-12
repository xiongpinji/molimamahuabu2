import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function readSource(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

const apiSource = readSource('../src/api/redraw.js')
const workspaceSource = readSource('../src/views/RedrawWorkspace.vue')
const assetStepSource = readSource('../src/components/redraw/RedrawAssetStep.vue')
const assetCardSource = readSource('../src/components/redraw/RedrawAssetCard.vue')
const voicePickerSource = readSource('../src/components/redraw/RedrawVoicePicker.vue')
const reviewGateSource = readSource('../src/components/redraw/RedrawReviewGate.vue')
const stateSource = readSource('../src/utils/redrawAssetState.js')

test('资产步骤 API 覆盖版本、资产生成、审核和门禁回读', () => {
  for (const name of ['createVersion', 'listAssets', 'updateAsset', 'generateAsset', 'reviewAsset', 'getGenerationGate', 'getAssetQuote']) {
    assert.match(apiSource, new RegExp(`${name}\\(`), name)
  }
  assert.match(apiSource, /generation-gate/)
  assert.match(apiSource, /expected_updated_at/)
  assert.match(apiSource, /asset.*quote|quote.*asset/)
})

test('资产步骤展示三视图、场景分段、物品、音色和审核定位', () => {
  assert.match(assetStepSource, /RedrawAssetCard/)
  assert.match(assetStepSource, /RedrawVoicePicker/)
  assert.match(assetStepSource, /RedrawReviewGate/)
  assert.match(assetCardSource, /三视图/)
  assert.match(assetCardSource, /原场景/)
  assert.match(assetCardSource, /本地化/)
  assert.match(assetCardSource, /去人净景/)
  assert.match(assetCardSource, /预计扣除/)
  assert.match(voicePickerSource, /试听/)
  assert.match(reviewGateSource, /missing/)
  assert.match(reviewGateSource, /scrollIntoView/)
})

test('资产卡使用鉴权 Blob 展示真实人物图片且释放本地预览 URL', () => {
  assert.match(apiSource, /getAssetPreview\(assetId,\s*variant\)/)
  assert.match(apiSource, /assets\/\$\{assetId\}\/preview\/\$\{encodeURIComponent\(variant\)\}/)
  assert.match(assetCardSource, /<img[^>]+:src="previewUrl"/)
  assert.match(assetCardSource, /redrawAPI\.getAssetPreview/)
  assert.match(assetCardSource, /URL\.createObjectURL/)
  assert.match(assetCardSource, /URL\.revokeObjectURL/)
  assert.match(assetCardSource, /尚未生成角色图片/)
  assert.doesNotMatch(assetCardSource, /v-for="view in \['正面', '侧面', '背面'\]"/)
})

test('资产状态纯函数不会在前端伪造 approved，且门禁才开放第三步', () => {
  assert.match(stateSource, /approval_status/)
  assert.match(stateSource, /generationGate/)
  assert.match(stateSource, /missing/)
  assert.doesNotMatch(stateSource, /approval_status\\s*[:=]\\s*['"]approved/)
  assert.match(workspaceSource, /RedrawAssetStep/)
  assert.match(workspaceSource, /allowedStep === 3/)
})

test('资产生成请求不提交客户端模型或积分，生成时由后端重新报价', () => {
  assert.match(assetStepSource, /getAssetQuote\(asset\.id\)/)
  assert.match(assetStepSource, /generateAsset\(asset\.id,\s*\{\s*prompt:\s*asset\.prompt,\s*quote_hash:\s*confirmation\.quoteHash,?\s*\}\)/)
  assert.doesNotMatch(assetStepSource, /credit_amount/)
  assert.doesNotMatch(assetStepSource, /generateAsset\([^\n]*model/)
})

test('资产批量按钮要求完整服务端报价且部分失败只重试失败项', async () => {
  const state = await import('../src/utils/redrawAssetState.js')
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 18, blocking: [] }, null), true)
  assert.equal(state.canStartAssetBatch({ priced: false, total_credits: null, blocking: ['tts'], items: [{ asset_id: 1 }] }, null), false)
  assert.deepEqual(state.failedAssetIds({ items: [
    { asset_id: 1, status: 'generated' },
    { asset_id: 2, status: 'failed' },
    { asset_id: 3, status: 'failed' },
  ]}), [2, 3])
})

test('资产批量状态纯函数 fail closed 并计算进度', async () => {
  const state = await import('../src/utils/redrawAssetState.js')

  assert.equal(state.assetBatchCredits({ priced: true, total_credits: 1 }), 1)
  assert.equal(state.assetBatchCredits({ priced: true, total_credits: 0 }), null)
  assert.equal(state.assetBatchCredits({ priced: true, total_credits: 1.5 }), null)
  assert.equal(state.assetBatchCredits({ priced: true, total_credits: Number.MAX_SAFE_INTEGER + 1 }), null)

  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: [], items: [{ asset_id: 1 }] }, null), true)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: ['asset'], items: [{ asset_id: 1 }] }, null), false)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocking: ['asset'], items: [{ asset_id: 1 }] }, null), false)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: [], blocking: ['asset'] }, null), false)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: ['asset'], blocking: [] }, null), false)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12 }, null), false)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: [] }, null), true)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: [], items: [] }, null), false)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: [], items: [{ asset_id: 1 }] }, { status: 'pending' }), false)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: [], items: [{ asset_id: 1 }] }, { status: 'processing' }), false)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: [], items: [{ asset_id: 1 }] }, { status: 'partial_failed' }), false)
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 12, blocked: [], items: [{ asset_id: 1 }] }, { status: 'needs_attention' }), false)
  assert.match(assetStepSource, /function batchTerminal[\s\S]*needs_attention/)

  assert.deepEqual(state.failedAssetIds({ items: [
    { id: 2, status: 'failed' },
    { asset_id: 2, status: 'failed' },
    { asset_id: -1, status: 'failed' },
    { asset_id: 1.5, status: 'failed' },
    { asset_id: 3, status: 'generated' },
    { asset_id: 4, status: 'failed' },
  ]}), [2, 4])

  assert.deepEqual(state.assetBatchProgress(null), { percent: 0, successCount: 0, failedCount: 0, totalCount: 0 })
  assert.deepEqual(state.assetBatchProgress({ total_count: 0, success_count: 5, failed_count: 2 }), { percent: 0, successCount: 5, failedCount: 2, totalCount: 0 })
  assert.deepEqual(state.assetBatchProgress({ total_count: 4, success_count: 1, failed_count: 1 }), { percent: 50, successCount: 1, failedCount: 1, totalCount: 4 })
  assert.deepEqual(state.assetBatchProgress({ total_count: 4, success_count: 8, failed_count: 1 }), { percent: 100, successCount: 8, failedCount: 1, totalCount: 4 })
  assert.deepEqual(state.assetBatchProgress({ total_count: 4, success_count: 'bad', failed_count: 1 }), { percent: 25, successCount: 0, failedCount: 1, totalCount: 4 })
  assert.deepEqual(state.assetBatchProgress({ total_count: Infinity, success_count: -1, failed_count: Infinity }), { percent: 0, successCount: 0, failedCount: 0, totalCount: 0 })
  assert.deepEqual(state.assetBatchProgress({ total_count: -4, success_count: 2, failed_count: -1 }), { percent: 0, successCount: 2, failedCount: 0, totalCount: 0 })
})

test('资产批量跨版本异步响应必须按版本上下文丢弃', async () => {
  const state = await import('../src/utils/redrawAssetState.js')

  assert.equal(state.isAssetVersionContextCurrent('A', 'A'), true)
  assert.equal(state.isAssetVersionContextCurrent('A', 'B'), false)
  assert.equal(state.isAssetVersionContextCurrent(1, '1'), true)

  assert.match(assetStepSource, /isAssetVersionContextCurrent/)
  assert.match(assetStepSource, /listAssets\(versionId\)/)
  assert.match(assetStepSource, /getGenerationGate\(versionId\)/)
  assert.match(assetStepSource, /getAssetQuote\(asset\.id\)/)
})

test('资产批量 API 与 UI 只使用服务端报价、hash 确认和安全创建字段', () => {
  assert.match(apiSource, /quoteAssetBatch\(versionId,\s*body\s*=\s*\{\}\)/)
  assert.match(apiSource, /assets\/batch-quote/)
  assert.match(apiSource, /createAssetBatch\(versionId,\s*body\)/)
  assert.match(apiSource, /assets\/batches/)

  assert.match(assetStepSource, /quoteAssetBatch\(versionId,\s*\{\s*\}\s*\)/)
  assert.match(assetStepSource, /quote_hash/)
  assert.match(assetStepSource, /idempotency_key/)
  assert.match(assetStepSource, /failedAssetIds/)
  assert.match(assetStepSource, /getWork\(props\.work\.id\)/)
  assert.match(assetStepSource, /canvas-credit-callout-v1/)
  assert.match(assetStepSource, /积分待管理员配置/)
  assert.match(assetStepSource, /一键重试失败项/)
  assert.match(assetStepSource, /startAssetBatch\(failedIds\.value\)/)
  assert.match(assetStepSource, /ids\.length\)\s*body\.asset_ids\s*=\s*ids/)
  assert.doesNotMatch(assetStepSource, /createAssetBatch\([^)]*model/)
  assert.doesNotMatch(assetStepSource, /createAssetBatch\([^)]*provider/)
  assert.doesNotMatch(assetStepSource, /createAssetBatch\([^)]*credits/)
  assert.doesNotMatch(assetStepSource, /createAssetBatch\([^)]*credit_amount/)
})

test('单项音色生成只提交用户已看到且再次确认未变化的 quote_hash', async () => {
  const state = await import('../src/utils/redrawAssetState.js')
  let displayed = { id: 1, kind: 'voice', quote_hash: 'H1', quote_credits: 3 }
  let generateCalls = 0
  const changed = state.confirmSingleAssetQuote(displayed, { priced: true, quote_hash: 'H2', credits: 4 })
  if (changed.confirmed) generateCalls += 1
  displayed = changed.asset
  assert.equal(changed.confirmed, false)
  assert.equal(displayed.quote_hash, 'H2')
  assert.equal(generateCalls, 0)
  const confirmed = state.confirmSingleAssetQuote(displayed, { priced: true, quote_hash: 'H2', credits: 4 })
  if (confirmed.confirmed) generateCalls += 1
  assert.equal(confirmed.confirmed, true)
  assert.equal(generateCalls, 1)

  assert.match(assetStepSource, /getAssetQuote\(asset\.id\)/)
  assert.match(assetStepSource, /confirmSingleAssetQuote\(asset,\s*quoteResult\)/)
  assert.match(assetStepSource, /asset\.kind === 'voice' && !confirmation\.confirmed/)
  assert.match(assetStepSource, /generateAsset\(asset\.id,\s*\{\s*prompt:\s*asset\.prompt,\s*quote_hash:\s*confirmation\.quoteHash,?\s*\}\)/)
  assert.doesNotMatch(assetStepSource, /generateAsset\(asset\.id,[^)]*model/)
  assert.doesNotMatch(assetStepSource, /generateAsset\(asset\.id,[^)]*credits/)
})

test('单项生成返回 needs_attention 时刷新资产但不误报成功', async () => {
  const state = await import('../src/utils/redrawAssetState.js')
  let refreshCalls = 0
  let successCalls = 0
  const warnings = []
  const result = { asset: { status: 'needs_attention' }, status: 'needs_attention' }
  refreshCalls += 1
  const notice = state.singleAssetGenerationNotice(result)
  if (notice.type === 'success') successCalls += 1
  if (notice.type === 'warning') warnings.push(notice.message)

  assert.equal(refreshCalls, 1)
  assert.equal(successCalls, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /人工确认/)
  assert.match(assetStepSource, /const result = await redrawAPI\.generateAsset[\s\S]*await refresh\(\)[\s\S]*singleAssetGenerationNotice\(result\)/)
})
