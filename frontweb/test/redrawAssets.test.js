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
  assert.match(assetStepSource, /generateAsset\(asset\.id,\s*\{\s*prompt:\s*asset\.prompt\s*\}\)/)
  assert.doesNotMatch(assetStepSource, /credit_amount/)
  assert.doesNotMatch(assetStepSource, /generateAsset\([^\n]*model/)
})
