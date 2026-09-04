import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as derivedState from './fuminFullEpisodeDerivedState.mjs'
import {
  validateGeneratedMediaForPack,
  verifyTranscriptConsensusForPack,
} from './fuminEpisodeProviderAdapter.mjs'
import { assertNextShotAllowed } from './fuminFullEpisodePaidGuard.mjs'

const sourceManifestSha256 = '4449766d1b76e8d37b6d26ca3c6acb7a180eceddd352e90049f31a29a8ac8ddc'

function sourceManifest() {
  return {
    schema_version: 'redraw-fumin-full-episode-paid-private-v1',
    case_id: 'ac087bcd-latam-en-us',
    provider: 'fumin.ai',
    status: 'preflight_complete',
    contract: {
      expectedShots: 9,
      maxPaidSubmits: 9,
      spendCapUsd: 25,
      estimatedPerShotUsd: 2.384848,
      estimatedTotalUsd: 21.463632,
      initialBalanceUsd: 35.95,
      accountId: 'xiongpinji',
    },
    generation: {
      model: 'fumin-seedance-2.0-mini',
      upstream_model: 'seedance-2.0-mini',
      resolution: '480p',
      aspect_ratio: '9:16',
      duration_seconds: 8,
      generate_audio: true,
      retries_allowed: false,
    },
    tasks: Array.from({ length: 4 }, (_, index) => ({
      shot_number: index + 1,
      task_id: `task-${index + 1}`,
      status: index < 3 ? 'completed_verified' : 'failed',
      error_code: index === 3 ? 'FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED' : undefined,
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

  for (let shotNumber = 1; shotNumber <= 4; shotNumber += 1) {
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
      observed_at: `2026-09-03T0${shotNumber}:00:00.000Z`,
      balance_usd: 36 - shotNumber,
    }
    if (shotNumber <= 3) {
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

  const calls = []
  const adapters = {
    now: () => new Date('2026-09-03T08:00:00.000Z'),
    sha256Buffer: digest,
    sha256File: (filePath) => (
      path.basename(filePath) === 'shot-04.mp4'
        ? derivedState.R4_SHOT4_ARTIFACT_SHA256
        : digest(fs.readFileSync(filePath))
    ),
    publicEvidence: (value) => structuredClone(value),
    providerRequest: () => calls.push('provider-request'),
    revalidateShot4: ({ stagingRoot, derivedManifest }) => {
      calls.push('revalidate-shot-4')
      const task = derivedManifest.tasks[3]
      task.status = 'awaiting_human_review'
      delete task.error_code
      task.artifact = {
        artifact_id: 'shot-04.mp4',
        sha256: derivedState.R4_SHOT4_ARTIFACT_SHA256,
      }
      task.revalidation = {
        schema_version: 'fumin-shot-local-revalidation-v2',
        source_status: 'failed',
        source_error_code: 'FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED',
        artifact_sha256: derivedState.R4_SHOT4_ARTIFACT_SHA256,
        verifier_result: 'passed',
        revalidated_at: '2026-09-03T08:00:00.000Z',
      }
      writeFixture(path.join(stagingRoot, 'artifacts', 'shot-04-contact-sheet.jpg'), 'contact-sheet')
    },
  }

  return {
    fixtureRoot,
    sourceRoot,
    targetRoot,
    calls,
    adapters,
    sourceManifestBytes: manifestBytes,
    options: {
      sourceStateRoot: sourceRoot,
      targetStateRoot: targetRoot,
      expectedSourceManifestSha256: digest(manifestBytes),
    },
  }
}

test('只接受锁定合同、锁定 SHA 和第 4 镜指定误判的 2026-09-03 r4', () => {
  assert.equal(typeof derivedState.assertR4DerivationSource, 'function')
  assert.equal(derivedState.assertR4DerivationSource({
    manifest: sourceManifest(),
    actualManifestSha256: sourceManifestSha256,
    expectedManifestSha256: sourceManifestSha256,
  }), true)
})

test('源 manifest SHA 漂移时拒绝派生', () => {
  assert.throws(() => derivedState.assertR4DerivationSource({
    manifest: sourceManifest(),
    actualManifestSha256: 'f'.repeat(64),
    expectedManifestSha256: sourceManifestSha256,
  }), /FUMIN_DERIVE_SOURCE_MANIFEST_CAS_MISMATCH/)
})

test('第 5 镜已存在或第 4 镜不是指定误判时拒绝派生', () => {
  const withShot5 = sourceManifest()
  withShot5.tasks.push({ shot_number: 5, task_id: 'task-5', status: 'completed_verified' })
  assert.throws(() => derivedState.assertR4DerivationSource({
    manifest: withShot5,
    actualManifestSha256: sourceManifestSha256,
    expectedManifestSha256: sourceManifestSha256,
  }), /FUMIN_DERIVE_SOURCE_TASKS_INVALID/)

  const wrongShot4Error = sourceManifest()
  wrongShot4Error.tasks[3].error_code = 'FUMIN_FULL_EPISODE_ASR_FAILED'
  assert.throws(() => derivedState.assertR4DerivationSource({
    manifest: wrongShot4Error,
    actualManifestSha256: sourceManifestSha256,
    expectedManifestSha256: sourceManifestSha256,
  }), /FUMIN_DERIVE_SOURCE_TASKS_INVALID/)
})

test('目标状态已存在时拒绝覆盖', () => {
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

test('缺少第 4 镜提交锁时拒绝派生且不留下目标状态', () => {
  const fixture = makeSourceState()
  try {
    fs.rmSync(path.join(fixture.sourceRoot, 'locks', 'shot-04-submit.lock.json'))
    assert.throws(
      () => derivedState.deriveFuminFullEpisodeState(fixture.options, fixture.adapters),
      /FUMIN_DERIVE_SOURCE_LOCK_INVALID/,
    )
    assert.equal(fs.existsSync(fixture.targetRoot), false)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('第 5—9 镜已有锁或成品时拒绝派生', () => {
  const fixture = makeSourceState()
  try {
    writeFixture(path.join(fixture.sourceRoot, 'locks', 'shot-05-submit.lock.json'), '{}')
    assert.throws(
      () => derivedState.deriveFuminFullEpisodeState(fixture.options, fixture.adapters),
      /FUMIN_DERIVE_LATER_SHOT_PRESENT/,
    )
    assert.equal(fs.existsSync(fixture.targetRoot), false)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('已验收视频哈希漂移时拒绝派生', () => {
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

test('合法源状态原子派生为第 4 镜待人工验收的新状态且不调用供应商', () => {
  const fixture = makeSourceState()
  try {
    const sourceBefore = fs.readFileSync(path.join(fixture.sourceRoot, 'private-manifest.json'))
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
    assert.equal(manifest.tasks.length, 4)
    assert.equal(manifest.tasks[3].status, 'awaiting_human_review')
    assert.equal(manifest.tasks[3].revalidation.source_status, 'failed')
    assert.equal(manifest.derived_from.source_state_label, 'fumin-full-episode-20260903-r4')
    assert.equal(manifest.derived_from.reason, 'dual_asr_orthographic_false_negative')
    assert.deepEqual(manifest.references.identities, {})
    assert.deepEqual(secrets, { schema_version: 'fumin-private-runtime-secrets-v1' })
    assert.equal(fs.existsSync(path.join(
      fixture.targetRoot,
      'artifacts',
      'shot-04-contact-sheet.jpg',
    )), true)
    assert.doesNotMatch(JSON.stringify(secrets), /https:\/\//)
    assert.deepEqual(fixture.calls, ['revalidate-shot-4'])
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.sourceRoot, 'private-manifest.json')),
      sourceBefore,
    )
    assert.throws(
      () => assertNextShotAllowed(manifest, 5, {}),
      /FUMIN_FULL_EPISODE_PREVIOUS_NOT_VERIFIED/,
    )
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('第 4 镜只调用新 Fumin adapter 的固定五秒单元媒体与双 ASR 纯验收并保留原失败审计', () => {
  const fixture = makeSourceState()
  const calls = []
  try {
    fixture.adapters.revalidateShot4 = ({ stagingRoot, derivedManifest }) => {
      const videoPath = path.join(stagingRoot, 'artifacts', 'shot-04.mp4')
      assert.equal(fs.existsSync(videoPath), true)
      const pack = {
        shot_id: 'shot-04',
        duration_ms: 8000,
        provider_duration_seconds: 5,
        characters: [{ id: 'lead', name: 'Marcus' }],
        dialogue: [{ speaker_id: 'lead', speaker_name: 'Marcus', text: 'We leave tonight.' }],
        audio_contract: { locale: 'en-US', speech_required: true },
      }
      calls.push('validate-media')
      const media = validateGeneratedMediaForPack(pack, {
        video_codec: 'h264',
        width: 496,
        height: 864,
        duration_seconds: 5.01,
        has_audio: true,
      })
      calls.push('verify-consensus')
      const speech = verifyTranscriptConsensusForPack(pack, [
        { model_id: 'Systran/faster-whisper-base', language: 'en', probability: 0.96, text: 'We leave tonight.' },
        { model_id: 'Systran/faster-whisper-small', language: 'en', probability: 0.95, text: 'We leave tonight.' },
      ])
      calls.push('contact-sheet')
      writeFixture(path.join(stagingRoot, 'artifacts', 'shot-04-contact-sheet.jpg'), 'contact-sheet')
      const task = derivedManifest.tasks[3]
      task.status = 'awaiting_human_review'
      task.artifact = {
        artifact_id: 'shot-04.mp4',
        sha256: derivedState.R4_SHOT4_ARTIFACT_SHA256,
        ffprobe: media,
      }
      task.contact_sheet_id = 'shot-04-contact-sheet.jpg'
      task.speech = speech
      task.revalidation = {
        schema_version: 'fumin-shot-local-revalidation-v2',
        source_status: 'failed',
        source_error_code: 'FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED',
        artifact_sha256: derivedState.R4_SHOT4_ARTIFACT_SHA256,
        verifier_result: 'passed',
        revalidated_at: '2026-09-03T08:00:00.000Z',
      }
    }

    derivedState.deriveFuminFullEpisodeState(fixture.options, fixture.adapters)
    const manifest = JSON.parse(fs.readFileSync(
      path.join(fixture.targetRoot, 'private-manifest.json'),
      'utf8',
    ))

    assert.deepEqual(calls, [
      'validate-media',
      'verify-consensus',
      'contact-sheet',
    ])
    assert.equal(manifest.tasks[3].status, 'awaiting_human_review')
    assert.equal(manifest.tasks[3].revalidation.source_status, 'failed')
    assert.equal(
      manifest.tasks[3].revalidation.source_error_code,
      'FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED',
    )
    assert.doesNotMatch(JSON.stringify(manifest), /https:\/\//)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})
