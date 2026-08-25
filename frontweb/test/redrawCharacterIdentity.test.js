import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

function source(path) {
  const url = new URL(path, import.meta.url)
  return existsSync(url) ? readFileSync(url, 'utf8') : ''
}

async function identityState() {
  try {
    return await import('../src/utils/redrawCharacterIdentity.js')
  } catch (error) {
    assert.fail(`角色身份包工具尚未实现: ${error.code || error.message}`)
  }
}

const apiSource = source('../src/api/redraw.js')
const assetCardSource = source('../src/components/redraw/RedrawAssetCard.vue')
const assetStepSource = source('../src/components/redraw/RedrawAssetStep.vue')
const shotEditorSource = source('../src/components/redraw/RedrawShotEditor.vue')

test('身份包投影输出 ready、缺项和短 hash，且不暴露路径字段', async () => {
  const { projectRedrawCharacterIdentityPack, shortIdentityPackHash } = await identityState()

  assert.equal(shortIdentityPackHash('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), '01234567')
  assert.equal(shortIdentityPackHash('not-a-hash'), '')

  const projected = projectRedrawCharacterIdentityPack({
    localized_name: 'Maya',
    identity_pack: {
      source_character_key: 'character-7',
      target_actor_label: '演员 A',
      confirmed_views: ['front', 'profile'],
      live_action_human_confirmed: true,
      adult_status: 'verified_18_plus',
      identity_consistency_confirmed: false,
      wardrobe: null,
      pack_sha256: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      source_ref_json: '{"storage_root":"C:/secret","source_ref":{"local_path":"private/path"}}',
    },
    identity_pack_status: {
      ready: false,
      missing_views: ['full_body'],
      missing_confirmations: ['identity_consistency_confirmed', 'wardrobe'],
      hash_valid: true,
      has_identity_pack: true,
    },
  })

  assert.equal(projected.sourceLabel, 'Maya')
  assert.equal(projected.targetActorLabel, '演员 A')
  assert.equal(projected.shortHash, 'abcdefab')
  assert.equal(projected.ready, false)
  assert.deepEqual(projected.confirmedViews, ['front', 'profile'])
  assert.deepEqual(projected.missingViews, ['full_body'])
  assert.deepEqual(projected.missingConfirmations, ['identity_consistency_confirmed', 'wardrobe'])
  assert.deepEqual(projected.missing, ['full_body', 'identity_consistency_confirmed', 'wardrobe'])
  assert.equal(projected.wardrobeReady, false)
  assert.equal(projected.hashValid, true)
  assert.ok(!Object.prototype.hasOwnProperty.call(projected, 'source_ref_json'))
  assert.ok(!Object.prototype.hasOwnProperty.call(projected, 'storageRoot'))
  assert.ok(!Object.prototype.hasOwnProperty.call(projected, 'local_path'))
})

test('角色卡、逐镜编辑器和 API 暴露身份包确认与保存入口', () => {
  assert.match(apiSource, /put\(`\/redraw\/assets\/\$\{assetId\}\/identity-pack`/)
  assert.match(apiSource, /saveRedrawCharacterIdentityPack/)
  assert.doesNotMatch(assetCardSource, /角色生成图 · 正面 \/ 侧面 \/ 背面/)
  assert.match(assetCardSource, /target_actor_label|targetActorLabel|目标演员/)
  assert.match(assetCardSource, /front|profile|full_body/)
  assert.match(assetCardSource, /live_action_human_confirmed|真人/)
  assert.match(assetCardSource, /adult_status|18\+/)
  assert.match(assetCardSource, /identity_consistency_confirmed|一致性/)
  assert.match(assetCardSource, /wardrobe_reference_asset_id|服装参考/)
  assert.match(assetCardSource, /wardrobe_consistency_confirmed|服装一致性/)
  assert.match(assetCardSource, /saveRedrawCharacterIdentityPack/)
  assert.match(assetCardSource, /emit\('identity-saved'/)
  assert.match(assetCardSource, /target_actor_label: identityForm\.value\.target_actor_label/)
  assert.match(assetCardSource, /confirmed_views: identityForm\.value\.confirmed_views/)
  assert.match(assetCardSource, /live_action_human_confirmed: identityForm\.value\.live_action_human_confirmed/)
  assert.match(assetCardSource, /adult_status: identityForm\.value\.adult_status \? 'verified_18_plus' : 'unverified'/)
  assert.match(assetCardSource, /identity_consistency_confirmed: identityForm\.value\.identity_consistency_confirmed/)
  assert.match(assetCardSource, /wardrobe_reference_asset_id: identityForm\.value\.wardrobe_reference_asset_id/)
  assert.match(assetCardSource, /wardrobe_consistency_confirmed: identityForm\.value\.wardrobe_consistency_confirmed/)
  assert.match(assetCardSource, /expected_updated_at: props\.asset\.updated_at/)
  assert.doesNotMatch(assetCardSource, /source_character_key|pack_sha256|source_ref_json|hash_valid|identity_pack_status/)
  assert.doesNotMatch(assetCardSource, /['"]ready['"]/)
  assert.match(assetCardSource, /服务端已确认/)
  assert.match(assetCardSource, /服务端未确认/)
  assert.match(assetCardSource, /projectRedrawCharacterIdentityPack/)
  assert.match(assetCardSource, /approveDisabled/)
  assert.match(assetStepSource, /@identity-saved="handleIdentitySaved"/)
  assert.match(assetStepSource, /await redrawAPI\.getWork\(props\.work\.id\)/)
  assert.match(assetStepSource, /emit\('work-updated', nextWork\)/)
  assert.match(assetStepSource, /isRedrawCharacterIdentityPackReady/)
  assert.match(assetStepSource, /:wardrobe-reference-assets="wardrobeReferenceAssets"/)
  assert.match(assetStepSource, /角色身份包未就绪，不能批准/)
  assert.match(shotEditorSource, /projectRedrawCharacterIdentityPack/)
  assert.match(shotEditorSource, /shortHash/)
  assert.match(shotEditorSource, /源角色/)
  assert.match(shotEditorSource, /目标演员/)
})
