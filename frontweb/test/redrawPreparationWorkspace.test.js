import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

function source(path) {
  const url = new URL(path, import.meta.url)
  return existsSync(url) ? readFileSync(url, 'utf8') : ''
}

async function identityState() {
  return import('../src/utils/redrawCharacterIdentity.js')
}

async function shotState() {
  return import('../src/utils/redrawShotState.js')
}

const apiSource = source('../src/api/redraw.js')
const workspaceSource = source('../src/views/RedrawWorkspace.vue')
const assetStepSource = source('../src/components/redraw/RedrawAssetStep.vue')
const shotStepSource = source('../src/components/redraw/RedrawShotStep.vue')
const characterPanelSource = source('../src/components/redraw/RedrawCharacterLibraryPanel.vue')
const shotPanelSource = source('../src/components/redraw/RedrawShotPreparationPanel.vue')

test('角色计划投影固定显示姓名、身份、声音和服装且不带路径', async () => {
  const { projectRedrawCharacterPlan } = await identityState()
  const projected = projectRedrawCharacterPlan({
    version_id: 7,
    ready: true,
    plan_hash: 'a'.repeat(64),
    characters: [{
      source_character_key: 'char-a',
      target_name: 'Alice Carter',
      identity_pack_sha256: 'b'.repeat(64),
      adult_status: 'verified_18_plus',
      voice: { asset_id: 31, language: 'en-US', sha256: 'c'.repeat(64), ready: true, local_path: 'secret.mp3' },
      wardrobe: { label: '整集主服装', asset_id: 41, sha256: 'd'.repeat(64), ready: true, url: 'https://secret' },
    }],
  })
  assert.equal(projected.ready, true)
  assert.equal(projected.characters[0].name, 'Alice Carter')
  assert.equal(projected.characters[0].identity.label, '成年虚构角色')
  assert.equal(projected.characters[0].voice.label, 'en-US')
  assert.equal(projected.characters[0].wardrobe.label, '整集主服装')
  assert.equal(JSON.stringify(projected).includes('local_path'), false)
  assert.equal(JSON.stringify(projected).includes('https://secret'), false)
})

test('逐镜准备投影显示四类证据、失效来源和只返工当前镜头', async () => {
  const { projectShotPreparation, preparationActionState } = await shotState()
  const shot = projectShotPreparation({
    id: 12,
    preparation_state: 'stale',
    stale_reason_code: 'identity_changed',
    preparation: {
      status: 'stale',
      requirements: [
        { kind: 'person_clean', key: 'person-a' },
        { kind: 'text_clean', key: 'subtitle-a' },
      ],
      clean_results: [{ kind: 'person_clean', key: 'person-a', status: 'completed' }],
    },
    reference_bundle_hash: '',
  }, { missing: [{ scope: 'shot', id: 12, code: 'reference_bundle_missing' }] })
  assert.equal(shot.personCoverage.label, '人物覆盖')
  assert.equal(shot.textCoverage.label, '文字覆盖')
  assert.equal(shot.cleanPlate.label, '净景')
  assert.equal(shot.referenceBundle.label, '参考包')
  assert.match(shot.staleReason, /角色身份/)
  assert.equal(shot.reworkScope, '只返工此镜头')
  const quotedShot = projectShotPreparation({ id: 13, preparation_state: 'localized' }, {}, {
    items: [
      { shot_id: 13, kind: 'person_clean', key: 'person-b' },
      { shot_id: 13, kind: 'text_clean', key: 'subtitle-b' },
    ],
  })
  assert.equal(quotedShot.personCoverage.required, 1)
  assert.equal(quotedShot.textCoverage.required, 1)
  assert.deepEqual(preparationActionState({ preparation_state: 'needs_attention' }), {
    canRetry: false,
    manualReviewOnly: true,
    label: '人工核对',
  })
})

test('参考准备 API 固定路径且执行 payload 只保留三项白名单', async () => {
  for (const pattern of [
    /getCharacterPlan\(versionId\)/,
    /getPreparationGate\(versionId\)/,
    /quoteReferencePreparation\(versionId/,
    /startReferencePreparation\(versionId/,
    /\/redraw\/versions\/\$\{versionId\}\/character-plan/,
    /\/redraw\/versions\/\$\{versionId\}\/preparation-gate/,
    /reference-preparation-quote/,
    /reference-preparations/,
  ]) assert.match(apiSource, pattern)

  const executableSource = apiSource.replace("import request from '@/utils/request'", 'const request = {}')
  const apiModule = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString('base64')}`)
  assert.deepEqual(apiModule.buildReferencePreparationPayload({
    quote_hash: 'server-quote',
    idempotency_key: 'prep-once',
    shot_ids: [3, 1],
    model: 'attacker-model',
    provider: 'attacker-provider',
    credits: 1,
    reservation_id: 'attacker-reservation',
    reference_bundle_hash: 'attacker-hash',
    local_path: 'C:/secret',
    url: 'https://secret',
  }), {
    quote_hash: 'server-quote',
    idempotency_key: 'prep-once',
    shot_ids: [3, 1],
  })
})

test('角色库和逐镜工作台覆盖 A/B 模式、服务端积分与人工核对边界', () => {
  for (const label of ['姓名', '身份', '声音', '服装']) assert.match(characterPanelSource, new RegExp(label), label)
  for (const label of ['人物覆盖', '文字覆盖', '净景', '参考包', '失效原因', '返工范围']) {
    assert.match(shotPanelSource, new RegExp(label), label)
  }
  assert.match(shotPanelSource, /A 模式/)
  assert.match(shotPanelSource, /逐项确认/)
  assert.match(shotPanelSource, /B 模式/)
  assert.match(shotPanelSource, /自动推进/)
  assert.match(shotPanelSource, /降级原因/)
  assert.match(shotPanelSource, /只返工此镜头/)
  assert.match(shotPanelSource, /人工核对/)
  assert.doesNotMatch(shotPanelSource, /重试/)
  assert.match(shotPanelSource, /本次预计扣除/)
  assert.match(shotPanelSource, /积分待管理员配置/)
  assert.match(shotPanelSource, /quote\.credits|props\.quote/)
  assert.doesNotMatch(shotPanelSource, /v-model[^>]*(?:model|provider|price|credits)/i)
})

test('工作台真实接入角色计划与逐镜准备组件', () => {
  assert.match(workspaceSource, /:execution-mode="project\?\.execution_mode"/)
  assert.match(assetStepSource, /RedrawCharacterLibraryPanel/)
  assert.match(assetStepSource, /getCharacterPlan/)
  assert.match(shotStepSource, /RedrawShotPreparationPanel/)
  assert.match(shotStepSource, /getPreparationGate/)
  assert.match(shotStepSource, /quoteReferencePreparation/)
  assert.match(shotStepSource, /startReferencePreparation/)
})
