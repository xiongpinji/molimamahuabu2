import { expect, test } from '@playwright/test'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { redrawLatinAmericanCase } from './fixtures/redraw-latin-american-case.js'
import { redrawLiveNineShotProject } from './fixtures/redraw-live-nine-shot-project.js'
import * as liveHarness from './support/redraw-live-product-harness.mjs'

const harnessPath = fileURLToPath(new URL('./support/redraw-live-product-harness.mjs', import.meta.url))
const launcherPath = fileURLToPath(new URL('../scripts/run-redraw-live-product.mjs', import.meta.url))
const localVoiceFixturePath = fileURLToPath(new URL('./fixtures/redraw-local-english-voice-fixtures.js', import.meta.url))
const harnessSource = fs.readFileSync(harnessPath, 'utf8')
const launcherSource = fs.readFileSync(launcherPath, 'utf8')

function liveFixture() {
  return liveHarness.buildRedrawLiveProductFixture(
    redrawLatinAmericanCase,
    redrawLiveNineShotProject.required_inputs,
  )
}

function fakeInputEnvironment(root) {
  const env = {
    REDRAW_LIVE_SOURCE_VIDEO: path.join(root, 'source.mp4'),
  }
  for (let index = 1; index <= 5; index += 1) {
    env[`REDRAW_LIVE_IDENTITY_${index}`] = path.join(root, `identity-${index}.png`)
  }
  for (let index = 1; index <= 9; index += 1) {
    env[`REDRAW_LIVE_MOTION_${index}`] = path.join(root, `motion-${index}.mp4`)
  }
  return env
}

test('launcher source contains no auth injection service override direct ready or placeholder media shortcut', () => {
  expect(harnessSource).not.toMatch(/req\.user\s*=/)
  expect(harnessSource).not.toMatch(/req\.tenant\s*=/)
  expect(harnessSource).not.toMatch(/referenceBundleService\s*:/)
  expect(harnessSource).not.toMatch(/localVoiceRegistrationService\s*:/)
  expect(harnessSource).not.toMatch(/createDryRunReferenceBundleService|saveReferenceBundle\s*\(/)
  expect(harnessSource).not.toMatch(/UPDATE\s+redraw_shots/i)
  expect(harnessSource).not.toMatch(/preparation_state\s*=\s*['"]reference_ready['"]/)
  expect(harnessSource).not.toMatch(/source placeholder|new Blob\s*\(/)
  expect(harnessSource).not.toMatch(/expandFixtureSourceUpload/)
  expect(launcherSource).not.toMatch(/FUMIN|api[_-]?key|key[_-]?file/i)
})

test('launcher builds the approved nine-shot contract and requires one source five identities and nine motions', () => {
  expect(typeof liveHarness.buildRedrawLiveProductFixture).toBe('function')
  expect(typeof liveHarness.loadRedrawLiveProductInputs).toBe('function')
  const fixture = liveFixture()
  expect(fixture.source).toMatchObject({
    sha256: redrawLatinAmericanCase.source.sha256,
    duration_ms: 68_733,
    width: 720,
    height: 1280,
  })
  expect(fixture.characters).toHaveLength(5)
  expect(fixture.shots).toHaveLength(9)
  expect(fixture.required_inputs.identity_images).toHaveLength(5)
  expect(fixture.required_inputs.motion_references).toHaveLength(9)
})

test('Rafael fixture is only the shot-6 owner approval request input and never persisted evidence', async () => {
  const fixtureModule = await import('./fixtures/redraw-local-english-voice-fixtures.js')
  const supplemental = fixtureModule.redrawLocalEnglishVoiceSupplementalDialogue
  expect(Object.keys(supplemental).sort()).toEqual([
    'shot_id',
    'source_character_key',
    'source_translation',
    'target_text',
  ])
  expect(supplemental).toEqual({
    shot_id: 'shot-6',
    source_character_key: 'rafael',
    target_text: 'Welcome home, son.',
    source_translation: false,
  })

  const fixture = liveFixture()
  const shot = fixture.shots.find((entry) => entry.shot_id === 'shot-6')
  expect(shot.source_dialogue.some((turn) => turn.speaker_id === 'rafael')).toBe(false)
  expect(shot.localized_dialogue.some((turn) => turn.speaker_id === 'rafael')).toBe(false)
  expect(shot.character_ids).toContain('rafael')
  expect(harnessSource).toContain('/supplemental-dialogue-approvals')
  expect(harnessSource).not.toContain('createSupplementalUserApprovedDialogueEvidenceView')
  expect(harnessSource).not.toMatch(/new Proxy\(db|localized_dialogue_json[\s\S]{0,400}new Proxy/i)
  expect(harnessSource).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+redraw_supplemental_dialogue_approvals/i)
})

test('supplemental dialogue cannot make Rafael authoritative or enter registration when source facts hide him', async () => {
  const fixture = liveHarness.buildRedrawLiveProductFixture(
    redrawLatinAmericanCase,
    redrawLiveNineShotProject.required_inputs,
    { authoritativeVisibleCharacterIdsByShot: { 'shot-6': ['mateo', 'elena'] } },
  )
  expect(fixture.shots.find((entry) => entry.shot_id === 'shot-6').character_ids)
    .not.toContain('rafael')

  expect(typeof liveHarness.verifySupplementalDialogueAuthorityViaHttp).toBe('function')
  const result = await liveHarness.verifySupplementalDialogueAuthorityViaHttp({ fixture })
  expect(result).toEqual({
    approval_status: 422,
    approval_error_code: 'REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY',
    supplemental_dialogue_approvals: 0,
    local_voice_registrations: 0,
    registration_attempts: 0,
    voice_provider_calls: 0,
    provider_paid_submits: 0,
    generation_submits: 0,
    external_fetches: 0,
  })
})

test('launcher input preflight fails closed for missing and forged local media', async () => {
  expect(typeof liveHarness.loadRedrawLiveProductInputs).toBe('function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-live-launcher-inputs-'))
  try {
    const fixture = liveFixture()
    const env = fakeInputEnvironment(root)
    await expect(liveHarness.loadRedrawLiveProductInputs({ fixture, env }))
      .rejects.toThrow(/required local media is missing/i)

    for (const filePath of Object.values(env)) fs.writeFileSync(filePath, Buffer.from('synthetic-placeholder'))
    await expect(liveHarness.loadRedrawLiveProductInputs({ fixture, env }))
      .rejects.toThrow(/local media is invalid|source fingerprint mismatch/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('process network guard blocks DNS private public and dangerous local routes before handlers', async () => {
  expect(typeof liveHarness.installRedrawLiveNetworkGuard).toBe('function')
  const server = http.createServer((_req, res) => {
    res.writeHead(204)
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const localBaseUrl = `http://127.0.0.1:${server.address().port}`
  const counts = {
    externalFetches: 0,
    blockedExternalAttempts: 0,
    blockedDangerousRoutes: 0,
  }
  const guard = liveHarness.installRedrawLiveNetworkGuard({ counts })
  try {
    await expect(fetch('https://example.com/')).rejects.toThrow(/network guard blocked/i)
    await expect(fetch(new URL('http://192.168.1.20/private'))).rejects.toThrow(/network guard blocked/i)
    await expect(fetch(new Request('http://localhost/'))).rejects.toThrow(/network guard blocked/i)
    await expect(fetch('http://127.0.0.1/api/v1/redraw/shots/1/generate', { method: 'POST' }))
      .rejects.toThrow(/dangerous product route blocked/i)
    await expect(fetch('http://[::1]/api/v1/ai-configs/1/connection', { method: 'POST' }))
      .rejects.toThrow(/dangerous product route blocked/i)
    await expect(fetch(`${localBaseUrl}/api/v1/redraw/versions/1/assets/batches`, { method: 'POST' }))
      .rejects.toThrow(/dangerous product route blocked/i)
    await expect(fetch(`${localBaseUrl}/api/v1/redraw/versions/1/dialogue/start`, { method: 'POST' }))
      .rejects.toThrow(/dangerous product route blocked/i)
    expect(() => http.request(new URL(localBaseUrl), {
      method: 'POST',
      path: '/api/v1/redraw/shots/1/generate',
    })).toThrow(/dangerous product route blocked/i)
    expect(() => http.request(localBaseUrl, {
      method: 'POST',
      pathname: '/api/v1/redraw/versions/1/assets/batches',
    })).toThrow(/dangerous product route blocked/i)
    const localRegistration = await fetch(
      `${localBaseUrl}/api/v1/redraw/versions/1/voices/2/local-production-registrations`,
      { method: 'POST' },
    )
    expect(localRegistration.status).toBe(204)
    expect(counts).toMatchObject({
      externalFetches: 0,
      blockedExternalAttempts: 3,
      blockedDangerousRoutes: 6,
    })
  } finally {
    guard.restore()
    server.closeAllConnections?.()
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('five-voice test fixture and HTTP-only chain stay test-only and bind real audio evidence', async () => {
  expect(fs.existsSync(localVoiceFixturePath)).toBe(true)
  if (!fs.existsSync(localVoiceFixturePath)) return
  const fixtureModule = await import('./fixtures/redraw-local-english-voice-fixtures.js')
  expect(fixtureModule.redrawLocalEnglishVoiceFixture).toMatchObject({
    source: 'test_only_local_fixture',
    generator: 'Microsoft Zira Desktop',
    locale: 'en-US',
    test_only: true,
    production_manifest_eligible: false,
    acceptance_scope: 'test_fixture_only_not_espeak_ng_acceptance',
  })
  expect(fixtureModule.redrawLocalEnglishVoiceProfiles).toHaveLength(5)
  expect(new Set(fixtureModule.redrawLocalEnglishVoiceProfiles.map((item) => item.profile_key)).size).toBe(5)
  expect(typeof fixtureModule.writeRedrawLocalEnglishVoiceFixture).toBe('function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-local-zira-fixture-'))
  try {
    const outputPath = path.join(root, 'zira-test-only.wav')
    const written = fixtureModule.writeRedrawLocalEnglishVoiceFixture(outputPath)
    const bytes = fs.readFileSync(outputPath)
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(written.audio_sha256)
    expect(crypto.createHash('sha256').update(written.text).digest('hex')).toBe(written.text_sha256)
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath,
    ], { encoding: 'utf8', windowsHide: true }))
    expect(probe.streams.filter((stream) => stream.codec_type === 'audio')).toHaveLength(1)
    expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  expect(harnessSource).toContain('/local-production-registrations')
  expect(harnessSource).toContain('verifyLocalVoice')
  expect(harnessSource).not.toMatch(/UPDATE\s+redraw_assets[\s\S]{0,200}(?:voice_asset_id|approval_status|status)/i)
  expect(harnessSource).not.toMatch(/UPDATE\s+redraw_local_voice_registrations/i)
  expect(launcherSource).toContain('buildRedrawLiveProductFixture')
  expect(launcherSource).toContain('redrawLatinAmericanCase')
  expect(launcherSource).toContain('redrawLiveNineShotProject.required_inputs')
})

test('network guard wraps node http https and undici request fetch client pool agent entry points', () => {
  expect(typeof liveHarness.installRedrawLiveNetworkGuard).toBe('function')
  expect(harnessSource).toMatch(/node:http/)
  expect(harnessSource).toMatch(/node:https/)
  expect(harnessSource).toMatch(/undici/)
  for (const entry of ['globalThis.fetch', 'http.request', 'http.get', 'https.request', 'https.get', 'undici.fetch', 'undici.request', 'undici.Client', 'undici.Pool', 'undici.Agent']) {
    expect(harnessSource).toContain(entry)
  }
})

test('clean provider shot lookup fails closed instead of reusing the first fixture shot', () => {
  expect(typeof liveHarness.requiredRedrawLiveFixtureShotIndex).toBe('function')
  const fixture = liveFixture()
  expect(liveHarness.requiredRedrawLiveFixtureShotIndex(fixture, 'shot-6')).toBe(5)
  expect(() => liveHarness.requiredRedrawLiveFixtureShotIndex(fixture, ''))
    .toThrow(/clean provider shot contract drift/i)
  expect(() => liveHarness.requiredRedrawLiveFixtureShotIndex(fixture, 'shot-missing'))
    .toThrow(/clean provider shot contract drift/i)
})

test('redacted launcher summary contains hashes and zero-cost counters but no secrets or absolute paths', () => {
  expect(typeof liveHarness.redactLiveProductSummary).toBe('function')
  const token = 'launcher-secret-token'
  const result = {
    context: {
      authToken: token,
      tenantId: 'personal:1',
      sourcePath: 'C:\\private\\source.mp4',
      identityPaths: ['/Users/private/identity.png'],
    },
    summary: {
      dry_run: true,
      shot_count: 9,
      reference_ready: 9,
      generation_submits: 0,
      external_fetches: 0,
      provider_paid_submits: 0,
      voice_provider_calls: 0,
      voice_registered: 5,
      supplemental_dialogue_approvals: 1,
      local_voice_registrations: 5,
      character_plan_ready: 5,
      local_tts_syntheses: 5,
      locale_verification_calls: 5,
      reservation_rows: 0,
      reservation_delta: 0,
      reserved_credits: 0,
      held_credits: 0,
      charged_credits: 0,
      media: {
        source: { basename: 'source.mp4', sha256: 'a'.repeat(64) },
        identities: [{ basename: 'identity.png', sha256: 'b'.repeat(64) }],
        motions: [{ basename: 'motion.mp4', sha256: 'c'.repeat(64) }],
      },
    },
  }
  const redacted = liveHarness.redactLiveProductSummary(result)
  const text = JSON.stringify(redacted)
  expect(redacted).toMatchObject({
    reference_ready: 9,
    generation_submits: 0,
    external_fetches: 0,
    provider_paid_submits: 0,
    voice_provider_calls: 0,
    voice_registered: 5,
    supplemental_dialogue_approvals: 1,
    local_voice_registrations: 5,
    character_plan_ready: 5,
    local_tts_syntheses: 5,
    locale_verification_calls: 5,
    reservation_rows: 0,
    reservation_delta: 0,
    reserved_credits: 0,
    held_credits: 0,
    charged_credits: 0,
  })
  expect(text).toContain('source.mp4')
  expect(text).not.toContain(token)
  expect(text).not.toMatch(/Authorization|Bearer|api[_-]?key|provider[_-]?secret|[A-Za-z]:[\\/]|\/Users\/|\/home\//i)
})

test('approved local media run reaches nine reference-ready shots through the product chain with zero side effects', async () => {
  test.skip(process.env.REDRAW_LIVE_PRODUCT_E2E !== '1', 'requires the approved local media environment')
  const fixture = liveFixture()
  const harness = await liveHarness.createRedrawLiveProductHarness({ fixture, env: process.env })
  try {
    const result = await harness.prepareDryRun()
    expect(result.shots).toHaveLength(9)
    expect(result.shots.every((shot) => shot.preparation_state === 'reference_ready')).toBe(true)
    expect(result.summary).toMatchObject({
      shot_count: 9,
      reference_ready: 9,
      generation_submits: 0,
      external_fetches: 0,
      provider_paid_submits: 0,
      voice_provider_calls: 0,
      voice_registered: 5,
      supplemental_dialogue_approvals: 1,
      local_voice_registrations: 5,
      character_plan_ready: 5,
      local_tts_syntheses: 5,
      locale_verification_calls: 5,
      reservation_rows: 0,
      reservation_delta: 0,
      reserved_credits: 0,
      held_credits: 0,
      charged_credits: 0,
    })
    expect(result.counts).toMatchObject({
      generationSubmits: 0,
      externalFetches: 0,
      providerPaidSubmits: 0,
      voiceProviderCalls: 0,
      supplementalDialogueApprovals: 1,
      localTtsSyntheses: 5,
      localeVerificationCalls: 5,
      voiceReviews: 5,
      characterVoiceAssignments: 5,
      characterReviews: 5,
    })
  } finally {
    await harness.close()
  }
})
