import test from 'node:test'
import assert from 'node:assert/strict'

import * as derivedState from './fuminFullEpisodeDerivedState.mjs'

const sourceManifestSha256 = '81cb83879271235739fdc3e9239ff569bf8faf0f860117c72cd4df68b1d8cd4d'

function sourceManifest() {
  return {
    schema_version: 'redraw-fumin-full-episode-paid-private-v1',
    case_id: 'ac087bcd-latam-en-us',
    provider: 'fumin.ai',
    contract: {
      expectedShots: 9,
      maxPaidSubmits: 9,
      spendCapUsd: 25,
      estimatedPerShotUsd: 2.384848,
      estimatedTotalUsd: 21.463632,
      initialBalanceUsd: 60.16,
      accountId: 'xiongpinji',
    },
    generation: {
      upstream_model: 'seedance-2.0-mini',
      resolution: '480p',
      aspect_ratio: '9:16',
      duration_seconds: 8,
      generate_audio: true,
    },
    tasks: Array.from({ length: 6 }, (_, index) => ({
      shot_number: index + 1,
      task_id: `task-${index + 1}`,
      status: index < 5 ? 'completed_verified' : 'failed',
      error_code: index === 5 ? 'FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED' : undefined,
    })),
  }
}

test('只接受锁定合同、锁定 SHA 和第六镜指定误判的 r4', () => {
  assert.equal(typeof derivedState.assertR4DerivationSource, 'function')
  assert.equal(derivedState.assertR4DerivationSource({
    manifest: sourceManifest(),
    actualManifestSha256: sourceManifestSha256,
    expectedManifestSha256: sourceManifestSha256,
  }), true)
})

test('源 manifest SHA 漂移时拒绝派生', () => {
  assert.equal(typeof derivedState.assertR4DerivationSource, 'function')
  assert.throws(() => derivedState.assertR4DerivationSource({
    manifest: sourceManifest(),
    actualManifestSha256: 'f'.repeat(64),
    expectedManifestSha256: sourceManifestSha256,
  }), /FUMIN_DERIVE_SOURCE_MANIFEST_CAS_MISMATCH/)
})

test('第七镜已存在或第六镜不是指定误判时拒绝派生', () => {
  assert.equal(typeof derivedState.assertR4DerivationSource, 'function')
  const withShot7 = sourceManifest()
  withShot7.tasks.push({ shot_number: 7, task_id: 'task-7', status: 'completed_verified' })
  assert.throws(() => derivedState.assertR4DerivationSource({
    manifest: withShot7,
    actualManifestSha256: sourceManifestSha256,
    expectedManifestSha256: sourceManifestSha256,
  }), /FUMIN_DERIVE_SOURCE_TASKS_INVALID/)

  const wrongShot6Error = sourceManifest()
  wrongShot6Error.tasks[5].error_code = 'FUMIN_FULL_EPISODE_ASR_FAILED'
  assert.throws(() => derivedState.assertR4DerivationSource({
    manifest: wrongShot6Error,
    actualManifestSha256: sourceManifestSha256,
    expectedManifestSha256: sourceManifestSha256,
  }), /FUMIN_DERIVE_SOURCE_TASKS_INVALID/)
})
