import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function writeFixture(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

function makeSourceState() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-derived-state-'))
  const sourceRoot = path.join(fixtureRoot, 'r4')
  const targetRoot = path.join(fixtureRoot, 'r5')
  const manifest = sourceManifest()

  for (let shotNumber = 1; shotNumber <= 6; shotNumber += 1) {
    const suffix = String(shotNumber).padStart(2, '0')
    const video = Buffer.from(`shot-${suffix}-video`)
    writeFixture(path.join(sourceRoot, 'artifacts', `shot-${suffix}.mp4`), video)
    writeFixture(path.join(sourceRoot, 'locks', `shot-${suffix}-submit.lock.json`), JSON.stringify({
      schema_version: 'fumin-paid-submission-lock-v1',
      shot_number: shotNumber,
      scope: 'reference_upload_and_paid_submission',
      external_actions_locked_before_network: true,
      retry_allowed: false,
    }))
    manifest.tasks[shotNumber - 1].balance_evidence = {
      observed_at: `2026-08-25T06:0${shotNumber}:00.000Z`,
      balance_usd: 60 - shotNumber,
    }
    if (shotNumber <= 5) {
      manifest.tasks[shotNumber - 1].artifact = { sha256: digest(video) }
      writeFixture(path.join(sourceRoot, 'artifacts', `shot-${suffix}-contact-sheet.jpg`), 'contact-sheet')
      writeFixture(path.join(sourceRoot, `shot-${suffix}-public-evidence.json`), '{}')
    }
  }
  for (let shotNumber = 1; shotNumber <= 9; shotNumber += 1) {
    writeFixture(
      path.join(sourceRoot, 'motion', `shot-${String(shotNumber).padStart(2, '0')}-motion.mp4`),
      `motion-${shotNumber}`,
    )
  }
  for (const identityId of ['mateo', 'diego', 'lucas', 'elena', 'rafael']) {
    writeFixture(path.join(sourceRoot, 'runtime', 'identities', `${identityId}.png`), identityId)
  }
  manifest.references = { identities: { mateo: { asset_id: 'old-asset' } } }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  writeFixture(path.join(sourceRoot, 'private-manifest.json'), manifestBytes)
  writeFixture(path.join(sourceRoot, 'private-runtime-secrets.json'), JSON.stringify({
    schema_version: 'fumin-private-runtime-secrets-v1',
    identity_references: { mateo: { url: 'https://signed.example.test/mateo.png?token=secret' } },
  }))

  const adapters = {
    now: () => new Date('2026-08-25T08:00:00.000Z'),
    sha256Buffer: digest,
    sha256File: (filePath) => (
      path.basename(filePath) === 'shot-06.mp4'
        ? derivedState.R4_SHOT6_ARTIFACT_SHA256
        : digest(fs.readFileSync(filePath))
    ),
    publicEvidence: (value) => structuredClone(value),
    revalidateShot6: ({ stagingRoot, derivedManifest }) => {
      const task = derivedManifest.tasks[5]
      task.status = 'awaiting_human_review'
      delete task.error_code
      task.artifact = {
        artifact_id: 'shot-06.mp4',
        sha256: derivedState.R4_SHOT6_ARTIFACT_SHA256,
      }
      task.revalidation = {
        schema_version: 'fumin-shot-local-revalidation-v1',
        source_status: 'failed',
        source_error_code: 'FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED',
        artifact_sha256: derivedState.R4_SHOT6_ARTIFACT_SHA256,
        verifier_result: 'passed',
        revalidated_at: '2026-08-25T08:00:00.000Z',
      }
      writeFixture(path.join(stagingRoot, 'artifacts', 'shot-06-contact-sheet.jpg'), 'contact-sheet')
    },
  }

  return {
    fixtureRoot,
    sourceRoot,
    targetRoot,
    adapters,
    options: {
      sourceStateRoot: sourceRoot,
      targetStateRoot: targetRoot,
      expectedSourceManifestSha256: digest(manifestBytes),
    },
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

test('目标状态已存在时拒绝覆盖', () => {
  assert.equal(typeof derivedState.deriveFuminFullEpisodeState, 'function')
  const fixture = makeSourceState()
  try {
    fs.mkdirSync(fixture.targetRoot)
    assert.throws(
      () => derivedState.deriveFuminFullEpisodeState(fixture.options, fixture.adapters),
      /FUMIN_DERIVE_TARGET_EXISTS/,
    )
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('缺少提交锁时拒绝派生', () => {
  assert.equal(typeof derivedState.deriveFuminFullEpisodeState, 'function')
  const fixture = makeSourceState()
  try {
    fs.rmSync(path.join(fixture.sourceRoot, 'locks', 'shot-06-submit.lock.json'))
    assert.throws(
      () => derivedState.deriveFuminFullEpisodeState(fixture.options, fixture.adapters),
      /FUMIN_DERIVE_SOURCE_LOCK_INVALID/,
    )
    assert.equal(fs.existsSync(fixture.targetRoot), false)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('已验收视频哈希漂移时拒绝派生', () => {
  assert.equal(typeof derivedState.deriveFuminFullEpisodeState, 'function')
  const fixture = makeSourceState()
  try {
    fs.appendFileSync(path.join(fixture.sourceRoot, 'artifacts', 'shot-01.mp4'), 'drift')
    assert.throws(
      () => derivedState.deriveFuminFullEpisodeState(fixture.options, fixture.adapters),
      /FUMIN_DERIVE_SOURCE_ARTIFACT_HASH_MISMATCH/,
    )
    assert.equal(fs.existsSync(fixture.targetRoot), false)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('合法源状态原子派生为第六镜待人工验收的新状态', () => {
  assert.equal(typeof derivedState.deriveFuminFullEpisodeState, 'function')
  const fixture = makeSourceState()
  try {
    const result = derivedState.deriveFuminFullEpisodeState(fixture.options, fixture.adapters)
    const manifest = JSON.parse(fs.readFileSync(
      path.join(fixture.targetRoot, 'private-manifest.json'),
      'utf8',
    ))
    const secrets = JSON.parse(fs.readFileSync(
      path.join(fixture.targetRoot, 'private-runtime-secrets.json'),
      'utf8',
    ))

    assert.equal(result.status, 'awaiting_human_review')
    assert.equal(manifest.tasks.length, 6)
    assert.equal(manifest.tasks[5].status, 'awaiting_human_review')
    assert.equal(manifest.tasks[5].revalidation.source_status, 'failed')
    assert.deepEqual(manifest.references.identities, {})
    assert.deepEqual(secrets, { schema_version: 'fumin-private-runtime-secrets-v1' })
    assert.equal(fs.existsSync(path.join(
      fixture.targetRoot,
      'artifacts',
      'shot-06-contact-sheet.jpg',
    )), true)
    assert.doesNotMatch(JSON.stringify(secrets), /https:\/\//)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})
