import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  actorReferenceUrl,
  buildLocalIdentityPackInput,
  buildLocalCaseManifest,
  redrawLatinAmericanCase,
} from './fixtures/redraw-latin-american-case.js'
import {
  genericLocalization,
  genericReferencePreparationCase,
  genericRedrawProject,
  genericSpanishSpeechFixtures,
  genericSourceFacts,
} from './fixtures/redraw-generic-project.js'

const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../backend-node/', import.meta.url))
const express = require(path.join(backendRoot, 'node_modules', 'express'))
const Database = require(path.join(backendRoot, 'node_modules', 'better-sqlite3'))
const sharp = require(path.join(backendRoot, 'node_modules', 'sharp'))
const { runMigrationsAndEnsure } = require(path.join(backendRoot, 'src', 'db', 'migrate'))
const { setupRouter } = require(path.join(backendRoot, 'src', 'routes'))
const redrawUploadService = require(path.join(backendRoot, 'src', 'services', 'redrawUploadService'))
const assetService = require(path.join(backendRoot, 'src', 'services', 'assetService'))
const redrawAssetService = require(path.join(backendRoot, 'src', 'services', 'redrawAssetService'))
const creditLedger = require(path.join(backendRoot, 'src', 'services', 'creditLedgerService'))
const modelPrices = require(path.join(backendRoot, 'src', 'services', 'modelPriceService'))
const videoService = require(path.join(backendRoot, 'src', 'services', 'videoService'))
const { buildLocalizationInput } = require(path.join(backendRoot, 'src', 'services', 'localizationService'))
const { serverAutomationPolicySnapshot } = require(path.join(backendRoot, 'src', 'services', 'redrawProjectPolicyService'))
const {
  buildGeneratedCoverageManifest,
} = require(path.join(backendRoot, 'src', 'services', 'redrawFullFrameCoverageService'))
const {
  canonicalizeModelLock,
  canonicalSha256: canonicalModelLockSha256,
} = require(path.join(backendRoot, 'src', 'services', 'redrawFullFrameModelLockService'))
const {
  buildCurrentReferenceBindings,
  loadReviewedReferenceCoverage,
  projectReferenceBundleForGeneration,
} = require(path.join(backendRoot, 'src', 'services', 'redrawReferenceBundleService'))
const {
  finalizeReviewedCoverage,
  validateReviewedCoverageManifest,
} = require(path.join(backendRoot, 'src', 'services', 'redrawFullFrameReviewService'))
const { getFfmpegPath, getFfprobePath } = require(path.join(backendRoot, 'src', 'utils', 'ffmpegPath'))

let backendServer
let database
let sourceVideoPath
let storageRoot
let tempRoot
let uploadedHeaderHex = ''
let analysisEvidenceAssetId
let ttsConfigId
let ttsConfigUpdatedAt
let videoConfigId
let videoConfigUpdatedAt
let nativeVideoConfigId
const providerArtifacts = {}
const providerTasks = new Map()
const providerAudit = []
const candidateAudioEvidence = new Map()
const coverageInstallationByVersion = new Map()
let genericPreparationFiles
let referencePreparationProviderCalls = 0
const runtimeErrors = []
let originalNodeFetch
let originalStorageLocalPath
let originalStorageBaseUrl
let fakeProviderOrigin

function logValue(value) {
  if (!value || typeof value !== 'object') return String(value)
  try { return JSON.stringify(value) } catch (_) { return String(value) }
}

const log = {
  info() {},
  warn(...args) { runtimeErrors.push(['warn', ...args.map(logValue)]) },
  error(...args) { runtimeErrors.push(['error', ...args.map(logValue)]) },
}
const owner = {
  tenant: { id: 'tenant-redraw-local' },
  user: { id: 'user-redraw-local' },
}

const defaultSourceFacts = {
  schema_version: '2.0',
  duration_ms: 16_000,
  story: ['旧手机消息让阿岚发现三年前事件仍在继续'],
  characters: [{ id: 'c1', source_name: '阿岚', relationships: [] }],
  scenes: [{ id: 's1', location: '天台', time: '夜', source_ranges: [{ start_ms: 0, end_ms: 16_000 }] }],
  props: [{ id: 'p1', name: '旧手机', evidence_ranges: [{ start_ms: 1_000, end_ms: 3_000 }] }],
  shots: [
    {
      id: 'shot-1',
      index: 1,
      start_ms: 0,
      end_ms: 8_000,
      composition: '阿岚站在天台边，旧手机屏幕映出三年前的时间',
      camera_movement: '手持轻微前推',
      opening_state: '阿岚站在天台边',
      continuous_action: '阿岚低头查看旧手机',
      ending_state: '屏幕亮起陌生消息',
      visible_character_ids: ['c1'],
      dialogue: [{
        id: 'shot-1-turn-1',
        speaker_id: 'c1',
        source_text: '别回头',
        start_ms: 1_000,
        end_ms: 3_000,
      }],
      text_regions: [{
        id: 'shot-1-text-1',
        kind: 'screen_text',
        source_text: '三年前',
        polygon: [[0.22, 0.12], [0.46, 0.12], [0.46, 0.24], [0.22, 0.24]],
      }],
      audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.99, speaker_mapping: 0.99, text_regions: 0.99, shot_boundary: 0.99 },
    },
    {
      id: 'shot-2',
      index: 2,
      start_ms: 8_000,
      end_ms: 16_000,
      composition: '屏幕显示未来日期，阿岚抬头环顾空旷天台',
      camera_movement: '定机位微抖',
      opening_state: '屏幕显示未来日期',
      continuous_action: '阿岚抬头环顾天台',
      ending_state: '阿岚转身离开',
      visible_character_ids: ['c1'],
      dialogue: [],
      text_regions: [],
      audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.99, speaker_mapping: 0.99, text_regions: 0.99, shot_boundary: 0.99 },
    },
  ],
  causal_chain: ['手机消息促使阿岚离开'],
  locked_facts: ['阿岚在天台收到旧手机消息'],
  reversals: ['朋友其实在楼下等待'],
  episode_hook: '阿岚发现消息来自未来',
}

const fullProductMode = process.env.REDRAW_E2E_FAKE_PROVIDER === '1'
const activeCase = !fullProductMode && process.env.REDRAW_E2E_CASE === 'latam-real-source'
  ? redrawLatinAmericanCase
  : null
const sourceFacts = fullProductMode
  ? {
      ...genericSourceFacts,
      shots: genericSourceFacts.shots.map((shot) => ({
        ...shot,
        confidence: { ...shot.confidence, speaker_mapping: 0.96 },
      })),
    }
  : activeCase?.sourceFacts || defaultSourceFacts
const generationDurations = fullProductMode ? [5, 5, 5] : activeCase?.generationDurations || [8, 8]
const artifactDurations = fullProductMode
  ? sourceFacts.shots.map((shot) => (Number(shot.end_ms) - Number(shot.start_ms)) / 1000)
  : activeCase
  ? sourceFacts.shots.map((shot) => (Number(shot.end_ms) - Number(shot.start_ms)) / 1000)
  : generationDurations
const expectedShotCount = sourceFacts.shots.length
const expectedOutputDuration = artifactDurations.reduce((sum, duration) => sum + duration, 0)
const expectedAssetCount = sourceFacts.schema_version === '2.0'
  ? sourceFacts.characters.length * 2
  : sourceFacts.characters.length * 2 + sourceFacts.scenes.length + sourceFacts.props.length
const expectedAssetCredits = expectedAssetCount * 5
const localizationOverrides = fullProductMode ? genericLocalization : activeCase?.localization || {
  name_map: { c1: 'Aran' },
  culture_map: { 天台: 'rooftop' },
  glossary: { 旧手机: 'old phone' },
  dialogue: [{
    shot_id: 'shot-1',
    turns: [{ id: 'shot-1-turn-1', speaker_id: 'c1', localized_text: "Don't look back" }],
  }],
  text_map: { 'shot-1:shot-1-text-1': 'Three years ago' },
  confidence: {
    names: 0.99,
    dialogue_semantics: 0.99,
    dialogue_timing: 0.99,
    culture: 0.99,
    screen_text: 0.99,
  },
}
let activeAnalysisFacts = sourceFacts
let activeLocalizationOverrides = localizationOverrides
let providerCallCounts = { asset: 0, video: 0, dialogue: 0 }
const expectedDialogueSegmentCount = sourceFacts.shots.reduce(
  (count, shot) => count + (Array.isArray(shot.dialogue) ? shot.dialogue.length : 0),
  0,
)
const expectedDialogueCredits = expectedDialogueSegmentCount * 3
const fixtureLocale = fullProductMode ? genericRedrawProject.target.locale : 'en-US'
const fixtureMarket = fullProductMode ? genericRedrawProject.target.market : 'US'

test.setTimeout(fullProductMode ? 240_000 : 120_000)
test.describe.configure({ mode: 'serial' })
const integrationTest = (title, callback) => {
  if (!fullProductMode) test(title, callback)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'redraw-local-browser-session',
      user: { id: 'user-redraw-local', email: 'redraw-local@example.test', role: 'user' },
    }))
  })
})

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function browserApi(page, pathname, init = {}) {
  return page.evaluate(async ({ target, options }) => {
    const response = await fetch(target, options)
    return { status: response.status, body: await response.json() }
  }, { target: pathname, options: init })
}

async function clickForJsonResponse(page, locator, predicate) {
  const responsePromise = page.waitForResponse(predicate)
  await locator.click()
  const response = await responsePromise
  let payload = null
  try { payload = JSON.parse(await response.text()) } catch (_) {}
  return { response, payload }
}

function apiResponse(method, pathnamePattern) {
  return (response) => response.request().method() === method
    && pathnamePattern.test(new URL(response.url()).pathname)
}

function runFfmpeg(args, label) {
  const result = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) {
    throw new Error(`${label}失败：${result.stderr || result.error?.message || result.status}`)
  }
}

function insertProviderArtifact({ name, type, relativePath, mimeType, duration = null, width = null, height = null }) {
  const absolutePath = path.join(storageRoot, relativePath)
  const digest = sha256File(absolutePath)
  const now = new Date().toISOString()
  const publicPath = relativePath.replace(/\\/g, '/')
  return Number(database.prepare(`
    INSERT INTO assets
      (name, type, category, url, local_path, file_size, mime_type, duration, width, height,
       metadata, created_at, updated_at)
    VALUES (?, ?, 'redraw', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    type,
    `https://media.example.test/static/${publicPath}?expires=4102444800&signature=local-fixture`,
    publicPath,
    fs.statSync(absolutePath).size,
    mimeType,
    duration,
    width,
    height,
    JSON.stringify({ sha256: digest }),
    now,
    now,
  ).lastInsertRowid)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Value(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex')
}

function sha256File(filePath) {
  return sha256Value(fs.readFileSync(filePath))
}

function normalizedTranscript(value) {
  return String(value || '').normalize('NFC').trim()
}

function synthesizeOfflineSpeech(transcript, outputPath) {
  const text = normalizedTranscript(transcript)
  if (!text) throw new Error('离线语音缺少目标语台词')
  const fixture = genericSpanishSpeechFixtures[text]
  if (!fixture) throw new Error(`缺少固定西语语音夹具：${text}`)
  const bytes = Buffer.from(fixture.base64, 'base64')
  if (sha256Value(bytes) !== fixture.sha256) throw new Error(`西语语音夹具哈希漂移：${text}`)
  fs.writeFileSync(outputPath, bytes)
  const probe = probeFixtureMedia(outputPath)
  if (!probe.audio || !Number.isFinite(probe.duration) || probe.duration <= 0) {
    throw new Error('离线语音产物不可解码')
  }
  return {
    schema_version: 'redraw-local-speech-evidence-v1',
    locale: 'es-ES',
    transcript: text,
    transcript_sha256: sha256Value(text),
    source_audio_sha256: sha256File(outputPath),
    source_audio_duration_ms: Math.round(probe.duration * 1000),
    synthesis: fixture.synthesis,
  }
}

function probeFixtureMedia(filePath) {
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) {
    throw new Error(`本地候选 ffprobe 失败：${result.stderr || result.error?.message || result.status}`)
  }
  const parsed = JSON.parse(result.stdout)
  return {
    duration: Number(parsed.format?.duration),
    video: parsed.streams.find((stream) => stream.codec_type === 'video') || null,
    audio: parsed.streams.find((stream) => stream.codec_type === 'audio') || null,
  }
}

function qualityCandidate(input) {
  const row = database.prepare(`
    SELECT s.*, v.locale, v.market, vg.local_path, vg.provider_task_id
    FROM redraw_shots s
    JOIN redraw_versions v ON v.id = s.version_id
    JOIN video_generations vg ON vg.id = s.video_generation_id
    WHERE s.id = ? AND s.version_id = ? AND vg.id = ?
  `).get(Number(input.shot_id), Number(input.version_id), Number(input.video_generation_id))
  if (!row?.local_path) throw new Error('本地候选媒体未就绪')
  const filePath = path.join(storageRoot, row.local_path)
  const localizedDialogue = JSON.parse(row.localized_dialogue_json || '[]')
  return { row, filePath, localizedDialogue, probe: probeFixtureMedia(filePath) }
}

function candidateSpeechEvidence(candidate) {
  const candidateSha256 = sha256File(candidate.filePath)
  const direct = candidateAudioEvidence.get(candidateSha256)
  if (direct) return direct
  const match = String(candidate.row.provider_task_id || '').match(/^local-fixture-video-task-([1-9]\d*)$/)
  const artifact = match ? providerArtifacts[`shot-${match[1]}`] : null
  const sourceSha256 = artifact?.absolutePath && fs.existsSync(artifact.absolutePath)
    ? sha256File(artifact.absolutePath)
    : null
  if (!artifact?.audioEvidence || sourceSha256 !== artifact.audioEvidence.candidate_sha256) return null
  const rebound = {
    ...artifact.audioEvidence,
    provider_task_id: candidate.row.provider_task_id,
    normalized_from_candidate_sha256: sourceSha256,
    candidate_sha256: candidateSha256,
  }
  candidateAudioEvidence.delete(sourceSha256)
  candidateAudioEvidence.set(candidateSha256, rebound)
  return rebound
}

const candidateQualityDependencies = {
  async probeMedia(_ctx, input) {
    const candidate = qualityCandidate(input)
    const width = Number(candidate.probe.video?.width)
    const height = Number(candidate.probe.video?.height)
    return {
      readable: true,
      duration_matches: Math.abs(candidate.probe.duration * 1000 - Number(candidate.row.duration_ms)) <= 100,
      dimensions_match: width > 0 && height > 0 && Math.abs((width / height) - (16 / 9)) < 0.01,
      candidate_sha256: sha256File(candidate.filePath),
    }
  },
  async verifyFullFrameCoverage(_ctx, input) {
    return {
      dependency_hash: input.dependency_hash,
      dependencies_current: true,
      original_person_residual: false,
      original_text_residual: false,
      identity: {
        all_bound: true,
        stable: true,
        person_count_matches: true,
        relationships_match: true,
      },
    }
  },
  async verifyLocale(_ctx, input) {
    const candidate = qualityCandidate(input)
    const digest = sha256File(candidate.filePath)
    const audioEvidence = candidateSpeechEvidence(candidate)
    return {
      language: audioEvidence?.locale || candidate.row.locale,
      target_language_matches: fullProductMode
        ? audioEvidence?.locale === 'es-ES' && audioEvidence.candidate_sha256 === digest
        : true,
    }
  },
  async verifyNativeAudio(_ctx, input) {
    const candidate = qualityCandidate(input)
    const hasDialogue = candidate.localizedDialogue.length > 0
    const candidateSha256 = sha256File(candidate.filePath)
    const audioEvidence = candidateSpeechEvidence(candidate)
    const expectedTranscript = normalizedTranscript(candidate.localizedDialogue
      .map((turn) => turn.localized_text)
      .join(' '))
    const sourceAudioCurrent = Boolean(audioEvidence?.source_audio_path
      && fs.existsSync(audioEvidence.source_audio_path)
      && sha256File(audioEvidence.source_audio_path) === audioEvidence.source_audio_sha256)
    const exactTargetText = hasDialogue
      ? Boolean(audioEvidence
        && audioEvidence.speech_required === true
        && audioEvidence.locale === candidate.row.locale
        && audioEvidence.transcript === expectedTranscript
        && audioEvidence.transcript_sha256 === sha256Value(expectedTranscript)
        && audioEvidence.synthesis?.engine === 'eSpeak NG'
        && audioEvidence.synthesis?.culture === 'es-ES'
        && audioEvidence.synthesis?.voice_code === 'es'
        && sourceAudioCurrent)
      : null
    const ambientAudioSafe = hasDialogue
      ? Boolean(candidate.probe.audio && exactTargetText)
      : Boolean(audioEvidence
        && audioEvidence.speech_required === false
        && audioEvidence.ambience_kind === 'rain-like-pink-noise'
        && audioEvidence.candidate_sha256 === candidateSha256)
    const evidence = {
      shot_id: Number(candidate.row.id),
      candidate_sha256: candidateSha256,
      dialogue_mode: hasDialogue ? 'dialogue' : 'silent',
      has_audio: Boolean(candidate.probe.audio),
      locale: audioEvidence?.locale || null,
      transcript_sha256: audioEvidence?.transcript_sha256 || null,
      source_audio_sha256: audioEvidence?.source_audio_sha256 || null,
      speech_required: audioEvidence?.speech_required,
    }
    return {
      has_audio: evidence.has_audio,
      dialogue_mode: evidence.dialogue_mode,
      language: hasDialogue ? audioEvidence?.locale || null : null,
      exact_target_text: exactTargetText,
      speaker_voice_matches: hasDialogue ? exactTargetText : true,
      ambient_audio_safe: fullProductMode ? ambientAudioSafe : evidence.has_audio,
      evidence_hash: sha256Value(stableJson(evidence)),
    }
  },
  async verifySubtitles(_ctx, input) {
    const candidate = qualityCandidate(input)
    return { present: candidate.localizedDialogue.length > 0, within_shot: true }
  },
  async verifyLipSync() {
    return { evidence_available: true, passed: true }
  },
}

function assertDialogueSpeechEvidence(segments, versionId) {
  const expectedTranscripts = new Map(database.prepare(`
    SELECT id, localized_dialogue_json
    FROM redraw_shots
    WHERE version_id = ?
    ORDER BY shot_index
  `).all(Number(versionId)).flatMap((shot) => (
    JSON.parse(shot.localized_dialogue_json || '[]').map((turn, turnIndex) => ([
      `${shot.id}:${turnIndex}`,
      normalizedTranscript(turn.localized_text),
    ]))
  )))
  for (const segment of segments) {
    const asset = database.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL')
      .get(Number(segment.audio_asset_id))
    expect(asset, `缺少对白音频资产 ${segment.segment_id}`).toBeTruthy()
    const absolutePath = path.join(storageRoot, asset.local_path)
    expect(fs.existsSync(absolutePath)).toBe(true)
    const evidence = JSON.parse(asset.metadata || '{}').redraw_dialogue?.speech_evidence
    const expectedTranscript = expectedTranscripts.get(String(segment.segment_id))
    expect(expectedTranscript, `对白片段 ${segment.segment_id} 未绑定当前版本本地化台词`).toBeTruthy()
    expect(evidence).toMatchObject({
      schema_version: 'redraw-local-speech-evidence-v1',
      locale: 'es-ES',
      transcript: expectedTranscript,
      transcript_sha256: sha256Value(expectedTranscript),
      audio_sha256: sha256File(absolutePath),
      synthesis: { engine: 'eSpeak NG', culture: 'es-ES', voice_code: 'es' },
    })
    expect(evidence.source_audio_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(probeFixtureMedia(absolutePath).audio).toBeTruthy()
  }
}

function assertNoPreparationLeaks(value) {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(tempRoot)
  expect(serialized).not.toContain(storageRoot)
  expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/)
  expect(serialized).not.toMatch(/https?:\/\//i)
  expect(serialized).not.toMatch(/\bAuthorization\b/i)
  expect(serialized).not.toMatch(/\bapi[_-]?key\b/i)
  expect(serialized).not.toContain('sk-')
}

function insertStoredArtifact({
  name,
  type,
  relativePath,
  mimeType,
  width = null,
  height = null,
  duration = null,
  metadata = {},
}) {
  const absolutePath = path.join(storageRoot, relativePath)
  const digest = sha256File(absolutePath)
  const now = new Date().toISOString()
  return Number(database.prepare(`
    INSERT INTO assets
      (name, type, category, local_path, file_size, mime_type, duration, width, height,
       metadata, created_at, updated_at)
    VALUES (?, ?, 'redraw', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    type,
    relativePath.replace(/\\/g, '/'),
    fs.statSync(absolutePath).size,
    mimeType,
    duration,
    width,
    height,
    JSON.stringify({ sha256: digest, ...metadata }),
    now,
    now,
  ).lastInsertRowid)
}

async function writeSolidPng(relativePath, color, width = 320, height = 180) {
  const absolutePath = path.join(storageRoot, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(absolutePath)
  return { absolutePath, relativePath, sha256: sha256File(absolutePath), width, height }
}

async function writeMaskPng(relativePath, { x, y, width, height }, frameWidth = 320, frameHeight = 180) {
  const pixels = Buffer.alloc(frameWidth * frameHeight)
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) pixels[(row * frameWidth) + column] = 255
  }
  const absolutePath = path.join(storageRoot, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  await sharp(pixels, { raw: { width: frameWidth, height: frameHeight, channels: 1 } })
    .toColourspace('b-w')
    .png()
    .toFile(absolutePath)
  return { absolutePath, relativePath, sha256: sha256File(absolutePath), width: frameWidth, height: frameHeight }
}

async function createGenericPreparationFiles() {
  const characters = new Map()
  for (const character of genericReferencePreparationCase.characters) {
    const identity = await writeSolidPng(character.identity.relative_path, character.identity.color, 320, 480)
    const wardrobe = await writeSolidPng(character.wardrobe.relative_path, character.wardrobe.color, 320, 480)
    const replacementIdentity = character.replacement_identity
      ? await writeSolidPng(character.replacement_identity.relative_path, character.replacement_identity.color, 320, 480)
      : null
    const voicePath = path.join(storageRoot, character.voice.relative_path)
    fs.mkdirSync(path.dirname(voicePath), { recursive: true })
    runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `sine=frequency=${character.voice.frequency}:sample_rate=44100`,
      '-t', '1.2', '-c:a', 'libmp3lame', '-y', voicePath,
    ], `通用角色 ${character.source_character_key} 音色生成`)
    characters.set(character.source_character_key, {
      definition: character,
      identity,
      wardrobe,
      replacementIdentity,
      voice: {
        absolutePath: voicePath,
        relativePath: character.voice.relative_path,
        sha256: sha256File(voicePath),
        duration: 1.2,
      },
    })
  }

  const shots = new Map()
  for (const [index, shot] of genericReferencePreparationCase.shots.entries()) {
    const frame = await writeSolidPng(shot.representative_frame.relative_path, shot.color)
    const personMask = await writeMaskPng(
      shot.person_mask.relative_path,
      { x: 36 + (index * 12), y: 24, width: 84, height: 118 },
    )
    const textMask = await writeMaskPng(
      shot.text_mask.relative_path,
      { x: 56, y: 142, width: 208, height: 24 },
    )
    const cleanPlate = await writeSolidPng(shot.clean_plate.relative_path, '#20252b')
    const sourceMotionPath = path.join(storageRoot, shot.motion_reference.relative_path)
    fs.mkdirSync(path.dirname(sourceMotionPath), { recursive: true })
    runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `color=c=${shot.color}:size=320x180:rate=12`,
      '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', sourceMotionPath,
    ], `通用镜头 ${shot.source_shot_id} 运动参考生成`)
    const motionSha256 = sha256File(sourceMotionPath)
    const motionRelativePath = `redraw-conditioning/${motionSha256}.mp4`
    const motionPath = path.join(storageRoot, motionRelativePath)
    fs.mkdirSync(path.dirname(motionPath), { recursive: true })
    fs.copyFileSync(sourceMotionPath, motionPath)
    shots.set(shot.source_shot_id, {
      definition: shot,
      frame,
      personMask,
      textMask,
      cleanPlate,
      motion: {
        absolutePath: motionPath,
        relativePath: motionRelativePath,
        sha256: motionSha256,
        duration: 4,
      },
    })
  }
  return { characters, shots }
}

function genericModelLock() {
  const projects = {
    face_detector: ['MediaPipe face detection', 'google-ai-edge/mediapipe'],
    person_detector: ['YOLOX', 'Megvii-BaseDetection/YOLOX'],
    text_detector: ['PaddleOCR', 'PaddlePaddle/PaddleOCR'],
    tracker: ['ByteTrack', 'FoundationVision/ByteTrack'],
  }
  const components = ['tracker', 'text_detector', 'person_detector', 'face_detector'].map((component) => ({
    component,
    project: projects[component][0],
    repository: projects[component][1],
    revision: `fixture-${component}-20260823`,
    artifact_name: `${component}.bin`,
    artifact_path: `${component}/model.bin`,
    artifact_sha256: 'a'.repeat(64),
    license_name: `${component}-LICENSE`,
    license_evidence_path: `${component}/LICENSE.txt`,
    license_evidence_sha256: 'b'.repeat(64),
  }))
  const lock = {
    schema_version: 'redraw-full-frame-model-lock-v2',
    runtimes: {
      main: {
        python_version: 'Python 3.11.9', interpreter_path: 'runtime/main/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/main/pip-freeze.txt', pip_freeze_sha256: '1'.repeat(64),
      },
      text: {
        python_version: 'Python 3.11.9', interpreter_path: 'runtime/text/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/text/pip-freeze.txt', pip_freeze_sha256: '2'.repeat(64),
      },
    },
    components,
  }
  return { ...lock, canonical_sha256: canonicalModelLockSha256(canonicalizeModelLock(lock)) }
}

test.beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-redraw-browser-backend-'))
  storageRoot = path.join(tempRoot, 'storage')
  fs.mkdirSync(storageRoot, { recursive: true })
  const backendPort = Number(process.env.REDRAW_E2E_BACKEND_PORT || new URL(
    process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:5679',
  ).port || 5679)
  fakeProviderOrigin = `http://127.0.0.1:${backendPort}`
  originalStorageLocalPath = process.env.STORAGE_LOCAL_PATH
  originalStorageBaseUrl = process.env.STORAGE_BASE_URL
  process.env.STORAGE_LOCAL_PATH = storageRoot
  process.env.STORAGE_BASE_URL = 'https://media.example.test'
  if (fullProductMode) {
    originalNodeFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
        throw new Error(`完整本地验收禁止公网请求：${url.origin}`)
      }
      return originalNodeFetch(input, init)
    }
  }
  genericPreparationFiles = await createGenericPreparationFiles()
  if (activeCase) {
    sourceVideoPath = path.resolve(process.env.REDRAW_E2E_SOURCE_VIDEO)
  } else {
    sourceVideoPath = path.join(tempRoot, `source-${sourceFacts.duration_ms / 1000}s.mp4`)
    runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=navy:size=320x180:rate=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', String(sourceFacts.duration_ms / 1000), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-shortest', '-y', sourceVideoPath,
    ], '本地转绘源片生成')
  }
  const artifactRoot = path.join(storageRoot, 'redraw-local-provider')
  fs.mkdirSync(artifactRoot, { recursive: true })
  for (const [kind, color] of [['character', 'red'], ['scene', 'green'], ['prop', 'yellow']]) {
    const target = path.join(artifactRoot, `${kind}.png`)
    if (activeCase && kind === 'character') {
      fs.copyFileSync(fileURLToPath(actorReferenceUrl), target)
      providerArtifacts[kind] = {
        absolutePath: target,
        relativePath: `redraw-local-provider/${kind}.png`,
        width: activeCase.castingReference.width,
        height: activeCase.castingReference.height,
        castingReference: true,
      }
    } else {
      const width = activeCase && kind === 'scene' ? activeCase.source.video.width : 320
      const height = activeCase && kind === 'scene' ? activeCase.source.video.height : 180
      runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `color=c=${color}:size=${width}x${height}`, '-frames:v', '1', '-y', target,
      ], `本地${kind}图片生成`)
      providerArtifacts[kind] = {
        absolutePath: target,
        relativePath: `redraw-local-provider/${kind}.png`,
        width,
        height,
      }
    }
  }
  const voiceWavePath = path.join(artifactRoot, 'voice-source.mp3')
  const voiceSpeechEvidence = fullProductMode
    ? synthesizeOfflineSpeech('Fue aquí.', voiceWavePath)
    : null
  const voicePath = path.join(artifactRoot, 'voice.mp3')
  runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    ...(fullProductMode
      ? ['-i', voiceWavePath]
      : ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100']),
    '-t', '1.2', '-c:a', 'libmp3lame', '-y', voicePath,
  ], '本地音色样音生成')
  providerArtifacts.voice = {
    absolutePath: voicePath,
    relativePath: 'redraw-local-provider/voice.mp3',
    speechEvidence: voiceSpeechEvidence,
  }
  const shotColors = ['blue', 'purple', 'teal', 'orange', 'brown', 'pink', 'gray', 'cyan', 'magenta']
  for (const [offset, duration] of generationDurations.entries()) {
    const index = String(offset + 1)
    const color = shotColors[offset % shotColors.length]
    const artifactDuration = artifactDurations[offset]
    const target = path.join(artifactRoot, `shot-${index}.mp4`)
    const dialogue = genericLocalization.dialogue[offset]?.turns || []
    const transcript = normalizedTranscript(dialogue.map((turn) => turn.localized_text).join(' '))
    let speechEvidence = null
    let speechPath = null
    if (fullProductMode && transcript) {
      speechPath = path.join(artifactRoot, `shot-${index}-speech.mp3`)
      speechEvidence = synthesizeOfflineSpeech(transcript, speechPath)
    }
    const inputs = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:size=320x180:rate=12`,
    ]
    if (speechPath) {
      inputs.push('-i', speechPath)
    } else if (fullProductMode) {
      inputs.push('-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.025:sample_rate=44100')
    } else if (index === '1') {
      const frequency = index === '1' ? 520 : index === '2' ? 610 : 180
      inputs.push('-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100`)
    }
    inputs.push(
      '-t', String(artifactDuration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      ...(fullProductMode
        ? ['-af', 'apad', '-c:a', 'aac']
        : index === '1' ? ['-c:a', 'aac', '-shortest'] : ['-an']),
      '-y', target,
    )
    runFfmpeg(inputs, `本地第 ${index} 镜视频生成`)
    const candidateSha256 = sha256File(target)
    const audioEvidence = fullProductMode
      ? speechEvidence
        ? {
            ...speechEvidence,
            shot_index: Number(index),
            speech_required: true,
            candidate_sha256: candidateSha256,
            source_audio_path: speechPath,
          }
        : {
            schema_version: 'redraw-local-speech-evidence-v1',
            locale: 'es-ES',
            shot_index: Number(index),
            transcript: null,
            transcript_sha256: null,
            speech_required: false,
            ambience_kind: 'rain-like-pink-noise',
            candidate_sha256: candidateSha256,
          }
      : null
    providerArtifacts[`shot-${index}`] = {
      absolutePath: target,
      relativePath: `redraw-local-provider/shot-${index}.mp4`,
      audioEvidence,
    }
  }
  database = new Database(path.join(tempRoot, 'redraw.sqlite'))
  runMigrationsAndEnsure(database)
  const now = new Date().toISOString()
  const evidencePath = path.join(storageRoot, 'redraw-evidence', 'analysis.json')
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
  fs.writeFileSync(evidencePath, JSON.stringify(sourceFacts))
  analysisEvidenceAssetId = Number(database.prepare(`
    INSERT INTO assets
      (name, type, category, url, local_path, file_size, mime_type, created_at, updated_at)
    VALUES ('本地分析证据', 'text', 'redraw', '/static/redraw-evidence/analysis.json',
      'redraw-evidence/analysis.json', ?, 'application/json', ?, ?)
  `).run(fs.statSync(evidencePath).size, now, now).lastInsertRowid)
  database.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video_understanding', 'local-fake', '本地分析模拟器', 'fake-analysis', 'fake-analysis',
      1, 1, 0, ?, ?, ?)
  `).run(JSON.stringify({
    real_generation_verified: true,
    evidence: {
      provider_task_id: 'local-fixture-analysis-evidence',
      result_asset_id: analysisEvidenceAssetId,
      result_asset_readable: true,
      completed_at: now,
    },
  }), now, now)
  database.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('text', 'local-fake', '本地英文复刻模拟器', 'fake-localizer', 'fake-localizer',
      1, 1, 10, ?, ?, ?)
  `).run(JSON.stringify({
    redraw_locale_capabilities: ['en-US|US', 'es-ES|ES'].map((target) => {
      const [locale, market] = target.split('|')
      return {
        locale, market, status: 'verified',
        evidence: {
          text: {
            provider: 'local-fake', model: 'fake-localizer',
            task_id: `local-fixture-localization-${locale}`,
            terminal_status: 'completed',
            artifact_id: analysisEvidenceAssetId,
          },
        },
      }
    }),
  }), now, now)
  database.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('redraw', 'local-fake', '本地资产模拟器', ?, 'fake-character', 1, 1, 9, ?, ?, ?)
  `).run(
    JSON.stringify(['fake-character', 'fake-clean-plate']),
    JSON.stringify({
      redraw_locale_capabilities: ['en-US|US', 'es-ES|ES'].map((target) => {
        const [locale, market] = target.split('|')
        return {
          locale, market, status: 'verified',
          evidence: {
            character_image: {
              provider: 'local-fake', model: 'fake-character',
              task_id: `local-fixture-character-${locale}`,
              terminal_status: 'completed',
              artifact_id: analysisEvidenceAssetId,
            },
            clean_plate_image: {
              provider: 'local-fake', model: 'fake-clean-plate',
              task_id: `local-fixture-clean-plate-${locale}`,
              terminal_status: 'completed',
              artifact_id: analysisEvidenceAssetId,
            },
          },
        }
      }),
    }),
    now,
    now,
  )
  ttsConfigUpdatedAt = now
  ttsConfigId = Number(database.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('tts', 'local-fake-tts', '本地音色模拟器', ?, 'fake-tts', 1, 0, 8, '{}', ?, ?)
  `).run(JSON.stringify(['fake-tts']), now, now).lastInsertRowid)
  database.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify({
    redraw_locale_capabilities: ['en-US|US', 'es-ES|ES'].map((target) => {
      const [locale, market] = target.split('|')
      return {
        locale, market, status: 'verified',
        evidence: {
          tts: {
            provider: 'local-fake-tts', model: 'fake-tts',
            task_id: `local-fixture-tts-${locale}`,
            terminal_status: 'completed',
            artifact_id: analysisEvidenceAssetId,
            ai_service_config_id: ttsConfigId,
            config_updated_at: ttsConfigUpdatedAt,
          },
        },
      }
    }),
  }), ttsConfigId)
  videoConfigUpdatedAt = now
  videoConfigId = Number(database.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, model, default_model, base_url, api_key,
       is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video', 'local-fake-video', 'icreat_task', '本地视频模拟器', ?, 'bytedance/seedance-2-0-mini',
      ?, 'local-test-only', 1, 1, 7, '{}', ?, ?)
  `).run(
    JSON.stringify(['bytedance/seedance-2-0-mini']),
    `${fakeProviderOrigin}/fake-provider`,
    now,
    now,
  ).lastInsertRowid)
  database.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify({
    redraw_locale_capabilities: ['en-US|US', 'es-ES|ES'].map((target) => {
      const [locale, market] = target.split('|')
      return {
        locale, market, status: 'verified',
        evidence: {
          video: {
            provider: 'local-fake-video', model: 'bytedance/seedance-2-0-mini',
            task_id: `local-fixture-video-${locale}`,
            terminal_status: 'completed',
            artifact_id: analysisEvidenceAssetId,
            config_id: videoConfigId,
            config_updated_at: videoConfigUpdatedAt,
          },
        },
      }
    }),
  }), videoConfigId)
  nativeVideoConfigId = Number(database.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, model, default_model, base_url, api_key,
       is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video', 'local-fake-native', 'toapis_video', '本地原生英文对白模拟器',
      'seedance-2-fast', 'seedance-2-fast', 'https://toapis.com', 'local-test-only',
      1, 0, 6, '{}', ?, ?)
  `).run(now, now).lastInsertRowid)
  database.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify({
    redraw_locale_capabilities: [{
      language: 'en', locale: 'en', target_language: 'en', target_locale: null, market: '', status: 'verified',
      evidence: {
        native_dialogue_audio: {
          contract: 'redraw-native-dialogue-audio-v1',
          provider: 'local-fake-native', protocol: 'toapis_video', model: 'seedance-2-fast',
          config_id: nativeVideoConfigId, config_updated_at: videoConfigUpdatedAt,
          provider_task_id: 'local-fixture-native-evidence', terminal_status: 'completed',
          artifact_id: analysisEvidenceAssetId, artifact_sha256: 'e'.repeat(64),
          media: { video_stream: true, audio_stream: true },
          locale_verification: { language: 'en', language_verified: true, locale_verified: false },
          human_review: {
            status: 'passed', speaker_order: 'passed', lip_sync: 'passed', extra_dialogue: 'passed',
          },
        },
      },
    }],
  }), nativeVideoConfigId)
  modelPrices.set(database, 'fake-analysis', 6, { category: 'text' })
  modelPrices.set(database, 'fake-localizer', 7, { category: 'text' })
  modelPrices.set(database, 'fake-character', 7, { category: 'image' })
  modelPrices.set(database, 'fake-clean-plate', 5, { category: 'image' })
  modelPrices.set(database, 'fake-tts', 3, { category: 'audio' })
  modelPrices.set(database, 'bytedance/seedance-2-0-mini', 2, {
    category: 'video',
    billing_unit: 'second',
    resolution_prices: { '720p': { credits: 3 } },
  })
  modelPrices.set(database, 'seedance-2-fast', 2, {
    category: 'video',
    billing_unit: 'second',
    resolution_prices: { '720p': { credits: 3 } },
  })
  creditLedger.setTenantAccountBalance(database, owner.tenant.id, 1_000)
  const localeVerifier = {
    assertReady(locale) {
      if (locale && typeof locale === 'object') {
        if (locale.language !== 'en') throw new Error('本地原生英文语言包未就绪')
        return {
          id: 'en@fixture', language: 'en', locale: null, scope: 'language',
          prompt_language_label: 'English',
          model_manifest_sha256: 'a'.repeat(64),
          calibration_manifest_sha256: 'b'.repeat(64),
          thresholds: {
            language_probability_min: 0.8,
            dialogue_similarity_min: 0.8,
            speech_chars_per_second_max: 20,
          },
        }
      }
      if (!['en-US', 'es-ES'].includes(locale)) throw new Error('本地语言包未就绪')
      return {
        id: `${locale}@fixture`,
        model_manifest_sha256: 'a'.repeat(64),
        calibration_manifest_sha256: 'b'.repeat(64),
      }
    },
  }

  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use((request, _response, next) => {
    request.tenant = owner.tenant
    request.user = owner.user
    next()
  })
  app.use('/static/redraw-local-provider', (request, _response, next) => {
    if (fullProductMode && /^\/shot-\d+\.mp4$/.test(request.path)) {
      providerAudit.push({ stage: 'download', path: request.path })
    }
    next()
  })
  app.use('/static', express.static(storageRoot))
  app.post(/^\/fake-provider\/v1\/task\/submit\/.+$/, (request, response) => {
    const authorization = String(request.headers.authorization || '')
    const group = String(request.headers['x-icreat-ai-group'] || '')
    const prompt = String(request.body?.content?.find?.((part) => part?.type === 'text')?.text || '')
    const shotIndex = prompt.includes('Fue aquí.')
      ? 1
      : prompt.includes('No sigas.')
        ? 2
        : prompt.includes('Dialogue mode: silent.')
          ? 3
          : Number.NaN
    if (!fullProductMode || authorization !== 'Bearer local-test-only' || !group
      || !Number.isSafeInteger(shotIndex) || !providerArtifacts[`shot-${shotIndex}`]) {
      return response.status(422).json({ error: 'local fake provider request rejected' })
    }
    const taskId = `local-fixture-video-task-${shotIndex}`
    providerTasks.set(taskId, shotIndex)
    providerCallCounts.video += 1
    providerAudit.push({
      stage: 'submit',
      task_id: taskId,
      adapter: 'icreat_task',
      duration: Number(request.body.duration),
      has_content: Array.isArray(request.body.content),
      prompt,
    })
    return response.status(202).json({ task_id: taskId, status: 'accepted' })
  })
  app.post('/fake-provider/v1/task/query-status', (request, response) => {
    const taskId = String(request.body?.task_id || '')
    const shotIndex = providerTasks.get(taskId)
    if (!fullProductMode || !shotIndex) {
      return response.status(404).json({ status: 'NOT_FOUND' })
    }
    providerAudit.push({ stage: 'poll', task_id: taskId })
    return response.json({
      status: 'COMPLETED',
      data: {
        video_url: `${fakeProviderOrigin}/static/${providerArtifacts[`shot-${shotIndex}`].relativePath}`,
      },
    })
  })
  app.use('/api/v1', setupRouter({
    app: { name: 'redraw local browser integration', version: 'test' },
    server: { cors_origins: [] },
    storage: { local_path: storageRoot, base_url: '' },
  }, database, log, {
    localizationProvider: async (input) => ({
      provider_task_id: `local-fixture-localization-${input.locale || 'default'}`,
      result: input.input.source_facts?.schema_version === '2.0'
        ? {
            facts_hash: buildLocalizationInput(input.input.source_facts, { locale: input.locale }).source_facts_hash,
            locale: input.locale,
            market: input.market,
            confidence: {
              names: 0.99,
              dialogue_semantics: 0.99,
              dialogue_timing: 0.99,
              culture: 0.99,
              screen_text: 0.99,
            },
            ...activeLocalizationOverrides,
          }
        : {
            ...input.input.source_facts,
            facts_hash: buildLocalizationInput(input.input.source_facts, { locale: input.locale }).source_facts_hash,
            ...activeLocalizationOverrides,
          },
    }),
    assetGenerationProvider: async ({ taskId, asset }) => {
      if (fullProductMode) {
        const versionId = Number(asset.version_id)
        if (!coverageInstallationByVersion.has(versionId)) {
          coverageInstallationByVersion.set(versionId, installGenericReviewedCoverage(versionId))
        }
        await coverageInstallationByVersion.get(versionId)
      }
      providerCallCounts.asset += 1
      const kind = String(asset.kind)
      const providerArtifact = providerArtifacts[kind]
      const artifactId = insertProviderArtifact(kind === 'voice'
        ? {
            name: '本地英文音色', type: 'audio', relativePath: providerArtifact.relativePath,
            mimeType: 'audio/mpeg', duration: 1.2,
          }
        : {
            name: `本地${kind}资产`, type: 'image', relativePath: providerArtifact.relativePath,
            mimeType: 'image/png', width: providerArtifact.width, height: providerArtifact.height,
          })
      const providerTaskId = `local-fixture-${kind}-${taskId}`
      const result = {
        status: 'completed',
        provider_task_id: providerTaskId,
        asset_id: artifactId,
      }
      if (kind === 'character') {
        result.metadata = providerArtifact.castingReference
          ? { casting_reference: true, production_identity_pack: false }
          : { views: ['front', 'side', 'back'] }
      }
      if (kind === 'scene') {
        result.quality = {
          width: providerArtifact.width,
          height: providerArtifact.height,
          mask_area_changed: true,
          non_mask_similarity: 0.99,
        }
      }
      if (kind === 'voice') {
        result.duration = 1.2
        result.voice_evidence = {
          source: 'offline-worker', locale: fixtureLocale, market: fixtureMarket,
          locale_pack: `${fixtureLocale}@fixture`,
          audio_sha256: crypto.createHash('sha256').update(fs.readFileSync(providerArtifact.absolutePath)).digest('hex'),
          transcript_sha256: providerArtifact.speechEvidence?.transcript_sha256 || 'd'.repeat(64),
          model_manifest_sha256: 'a'.repeat(64),
          calibration_manifest_sha256: 'b'.repeat(64),
          asr_model_revision: 'local-asr-en-1', accent_model_revision: 'local-accent-en-1',
          metrics: { word_error_rate: 0, accent_confidence: 0.99 },
          completed_at: new Date().toISOString(),
          provider: 'local-fake-tts', model: 'fake-tts',
          ai_service_config_id: ttsConfigId, config_updated_at: ttsConfigUpdatedAt,
          voice_id: 'fixture-voice', task_id: providerTaskId, terminal_status: 'completed',
          audio_asset_id: artifactId, duration_ms: 1_200,
          real_generation_verified: true, language_verified: true, detected_locale: fixtureLocale,
          is_cloned: false, authorization_asset_id: null,
        }
      }
      return result
    },
    dialogueProvider: async ({ segment }) => {
      providerCallCounts.dialogue += 1
      const safeSegmentId = String(segment.segment_id).replace(/[^a-zA-Z0-9_-]/g, '-')
      const transcript = normalizedTranscript(segment.localized_text || segment.text || segment.target_text)
      if (fullProductMode && !transcript) throw new Error(`本地对白 ${segment.segment_id} 缺少目标语文本`)
      const wavePath = path.join(storageRoot, `redraw-local-provider/dialogue-${safeSegmentId}-source.mp3`)
      const speechEvidence = fullProductMode ? synthesizeOfflineSpeech(transcript, wavePath) : null
      const relativePath = `redraw-local-provider/dialogue-${safeSegmentId}.mp3`
      const absolutePath = path.join(storageRoot, relativePath)
      const windowSeconds = (Number(segment.end_ms) - Number(segment.start_ms)) / 1000
      const audioDuration = Math.max(0.25, Math.min(1.2, windowSeconds - 0.05))
      runFfmpeg([
        '-hide_banner', '-loglevel', 'error',
        ...(fullProductMode
          ? ['-i', wavePath, '-af', 'apad']
          : ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100']),
        '-t', String(audioDuration),
        '-c:a', 'libmp3lame', '-y', absolutePath,
      ], `本地对白 ${segment.segment_id} 生成`)
      const now = new Date().toISOString()
      const providerTaskId = `local-fixture-dialogue-${safeSegmentId}`
      const audioSha256 = sha256File(absolutePath)
      const metadata = {
        redraw_dialogue: {
          tenant_id: segment.tenant_id,
          user_id: segment.user_id,
          version_id: segment.version_id,
          segment_id: segment.segment_id,
          idempotency_key: segment.idempotency_key,
          reservation_id: segment.reservation_id,
          provider_task_id: providerTaskId,
          provider: segment.voice_snapshot.provider,
          model: segment.voice_snapshot.model,
          ai_service_config_id: segment.voice_snapshot.ai_service_config_id,
          config_updated_at: segment.voice_snapshot.config_updated_at,
          voice_snapshot: segment.voice_snapshot,
          ...(speechEvidence ? {
            speech_evidence: {
              ...speechEvidence,
              audio_sha256: audioSha256,
              source_audio_path: undefined,
            },
          } : {}),
        },
      }
      const assetId = Number(database.prepare(`
        INSERT INTO assets
          (name, type, category, url, local_path, file_size, mime_type, duration, metadata, created_at, updated_at)
        VALUES (?, 'audio', 'redraw_dialogue', ?, ?, ?, 'audio/mpeg', ?, ?, ?, ?)
      `).run(
        `本地对白 ${segment.segment_id}`,
        `https://media.example.test/static/${relativePath}?expires=4102444800&signature=local-fixture`,
        relativePath,
        fs.statSync(absolutePath).size,
        audioDuration,
        JSON.stringify(metadata),
        now,
        now,
      ).lastInsertRowid)
      return {
        status: 'completed', asset_id: assetId, provider_task_id: providerTaskId,
        duration: audioDuration,
        ...(speechEvidence ? {
          speech_evidence: {
            ...speechEvidence,
            audio_sha256: audioSha256,
          },
        } : {}),
      }
    },
    localeVerifier,
    redrawOptions: {
      localeVerifier,
      uploadLimits: {
        minDurationMs: 1_000,
        maxDurationMs: 60_000,
      },
      referencePreparationProvider: async ({ input }) => {
        referencePreparationProviderCalls += 1
        const shot = genericPreparationFiles.shots.get(String(input.shot_id || ''))
        if (!shot) throw new Error('通用逐镜净景缺少本地输出')
        const artifactId = insertStoredArtifact({
          name: `本地逐镜净景 ${input.shot_id}`,
          type: 'image',
          relativePath: shot.cleanPlate.relativePath,
          mimeType: 'image/png',
          width: shot.cleanPlate.width,
          height: shot.cleanPlate.height,
          metadata: {
            fixture_version_id: Number(input.version_id),
            fixture_shot_id: String(input.shot_id || ''),
          },
        })
        return {
          status: 'completed',
          provider_task_id: `local-clean-${input.version_id}-${input.shot_id}-${input.mode}`,
          asset_id: artifactId,
          clean_plate: true,
          quality: {
            width: shot.cleanPlate.width,
            height: shot.cleanPlate.height,
            mask_area_changed: true,
            non_mask_similarity: 0.99,
          },
        }
      },
      uploadService: {
        async expandSourceUpload(file, ...args) {
          uploadedHeaderHex = fs.readFileSync(file.path).subarray(0, 12).toString('hex')
          return redrawUploadService.expandSourceUpload(file, ...args)
        },
      },
      capabilityService: {
        listPublicStylePresets: () => [{
          id: 1,
          stable_key: 'local-fixture-live-action',
          name: '本地写实复刻',
          category: 'live_action',
          verification_evidence_json: JSON.stringify({ artifact_id: analysisEvidenceAssetId }),
        }],
        listLocaleCapabilities: () => [
          { locale: 'en-US', market: 'US', status: 'full_output', blocking: [] },
          { locale: 'es-ES', market: 'ES', status: 'full_output', blocking: [] },
        ],
      },
      canReadArtifact: (assetId) => {
        const asset = database.prepare('SELECT local_path FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId))
        return Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path)))
      },
      localeRegistry: {
        assertEvidenceTrusted(evidence) {
          if (evidence?.source !== 'offline-worker'
            || evidence?.locale_pack !== `${fixtureLocale}@fixture`
            || evidence?.model_manifest_sha256 !== 'a'.repeat(64)
            || evidence?.calibration_manifest_sha256 !== 'b'.repeat(64)) {
            throw new Error('本地语言证据不可信')
          }
          return evidence
        },
      },
      generationOptions: {
        candidateQualityDependencies,
        assetReader: {
          canRead: (asset) => Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path))),
          owns: (asset) => Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path))),
        },
        createReferenceUrl: ({ asset_id: assetId, kind }) => `https://media.example.test/redraw/${kind}/${assetId}`,
        preparationContext: {
          storageRoot,
          canReadArtifact: (assetId) => {
            const asset = database.prepare('SELECT local_path FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId))
            return Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path)))
          },
          assetReader: {
            canRead: (asset) => Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path))),
            owns: (asset) => Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path))),
          },
        },
        resolveVideoConditioningCapability: (_db, model, capability) => (
          String(model).toLowerCase() === 'seedance-2-fast'
            ? {
                ...(capability || {}),
                config_id: nativeVideoConfigId,
                config_updated_at: videoConfigUpdatedAt,
                provider: 'local-fake-native',
                protocol: 'toapis_video',
                model,
                supportsAudio: true,
                maxVideoReferences: 1,
              }
            : {
                ...(capability || {}),
                config_id: videoConfigId,
                config_updated_at: videoConfigUpdatedAt,
                provider: 'local-fake-video',
                protocol: 'icreat_task',
                model,
                supportsAudio: true,
                max_videos: 3,
              }
        ),
        prepareSourceConditioning: async ({ shot }) => {
          const billingSnapshot = {
            source_asset_id: Number(shot.source_asset_id),
            source_fingerprint: String(shot.source_fingerprint),
            start_ms: Number(shot.start_ms),
            end_ms: Number(shot.end_ms),
            segment_sha256: crypto.createHash('sha256')
              .update(`${shot.source_fingerprint}:${shot.start_ms}:${shot.end_ms}`)
              .digest('hex'),
          }
          return {
            referenceVideoUrl: `https://local-fixture.invalid/${billingSnapshot.segment_sha256}.mp4?sig=local-only`,
            billingSnapshot,
            auditSnapshot: {
              ...billingSnapshot,
              relative_path: `redraw-conditioning/${billingSnapshot.segment_sha256}.mp4`,
            },
          }
        },
        videoProcessor: async (db, fixtureLogger, videoGenerationId) => {
          if (fullProductMode) {
            await videoService.processVideoGeneration(db, fixtureLogger, videoGenerationId, {
              providerAssetStorageBaseUrl: 'https://media.example.test',
              providerAssetSigningSecret: 'local-fixture-provider-asset-secret-32-bytes',
              providerAssetNowMs: Date.UTC(2030, 0, 1),
              providerAssetTtlSeconds: 1_800,
            })
            return
          }
          providerCallCounts.video += 1
          const row = db.prepare(`
            SELECT shot.shot_index
            FROM redraw_shots shot
            WHERE shot.video_generation_id = ?
          `).get(Number(videoGenerationId))
          const template = providerArtifacts[`shot-${Number(row?.shot_index || 1)}`]
          const relativePath = `redraw-local-provider/generated-${videoGenerationId}.mp4`
          fs.copyFileSync(template.absolutePath, path.join(storageRoot, relativePath))
          db.prepare(`
            UPDATE video_generations
            SET status = 'completed', provider_task_id = ?, video_url = ?, local_path = ?, updated_at = ?
            WHERE id = ?
          `).run(
            `local-fixture-video-${videoGenerationId}`,
            `/static/${relativePath}`,
            relativePath,
            new Date().toISOString(),
            Number(videoGenerationId),
          )
        },
        nativeAudioValidator: async ({ storageRoot: root, videoPath }) => {
          const absolutePath = path.join(root, videoPath)
          return {
            contract: 'redraw-native-audio-validation-v1',
            artifact_sha256: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'),
            audio_stream: { codec: 'aac', channels: 1, sample_rate: 44_100, duration_ms: 8_000 },
            video_duration_ms: 8_000,
            silence: { rms_db: -24, threshold_db: -45 },
            verification: {
              detected_language: 'en', detected_locale: null,
              language_verified: true, locale_verified: false,
              transcript_sha256: 'f'.repeat(64), dialogue_similarity: 0.99,
              speech_chars_per_second: 3,
            },
            validation_hash: 'c'.repeat(64),
          }
        },
      },
      analysisOptions: {
        provider: {
          startAnalysis: async () => ({
            status: 'completed',
            provider_task_id: 'local-fixture-analysis-1',
            result_asset_id: analysisEvidenceAssetId,
            facts: activeAnalysisFacts,
          }),
        },
      },
    },
  }))

  backendServer = http.createServer(app)
  const backendTarget = new URL(process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:5679')
  await listen(backendServer, Number(process.env.REDRAW_E2E_BACKEND_PORT || backendTarget.port || 5679))
})

test.afterAll(async () => {
  if (backendServer) await close(backendServer)
  database?.close()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  if (originalNodeFetch) globalThis.fetch = originalNodeFetch
  if (originalStorageLocalPath === undefined) delete process.env.STORAGE_LOCAL_PATH
  else process.env.STORAGE_LOCAL_PATH = originalStorageLocalPath
  if (originalStorageBaseUrl === undefined) delete process.env.STORAGE_BASE_URL
  else process.env.STORAGE_BASE_URL = originalStorageBaseUrl
})

function resetProviderFixture(facts = sourceFacts, localization = localizationOverrides) {
  activeAnalysisFacts = facts
  activeLocalizationOverrides = localization
  providerCallCounts = { asset: 0, video: 0, dialogue: 0 }
  referencePreparationProviderCalls = 0
  providerTasks.clear()
  providerAudit.length = 0
  candidateAudioEvidence.clear()
  for (const [key, artifact] of Object.entries(providerArtifacts)) {
    if (key.startsWith('shot-') && artifact.audioEvidence) {
      candidateAudioEvidence.set(artifact.audioEvidence.candidate_sha256, artifact.audioEvidence)
    }
  }
  uploadedHeaderHex = ''
  runtimeErrors.length = 0
}

function createGenericSourceVideo({
  filename = 'generic-source-12s.mp4',
  color = 'darkgreen',
  frequency = 380,
} = {}) {
  const videoPath = path.join(tempRoot, filename)
  runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:size=320x180:rate=12`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100`,
    '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-shortest', '-y', videoPath,
  ], '通用三镜源片生成')
  return videoPath
}

async function createProjectFromRedraw(page, project) {
  await page.goto('/redraw')
  await page.getByRole('button', { name: '新建转绘项目' }).click()
  await page.locator('.create-field').filter({ hasText: '项目名称' }).locator('input')
    .fill(project.title)
  if (project.execution_mode === 'auto') {
    await page.getByText('auto', { exact: true }).click()
  }
  await page.locator('.create-field').filter({ hasText: '目标语言' }).locator('input')
    .fill(project.default_locale)
  await page.locator('.create-field').filter({ hasText: '目标市场' }).locator('input')
    .fill(project.default_market)
  if (project.budget_limit_credits != null) {
    await page.locator('.create-field').filter({ hasText: '预算上限' }).locator('input')
      .fill(String(project.budget_limit_credits))
  }
  if (project.max_auto_attempts_per_shot != null) {
    await page.locator('.create-field').filter({ hasText: '自动尝试上限' }).locator('input')
      .fill(String(project.max_auto_attempts_per_shot))
  }
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && /\/api\/v1\/redraw\/projects$/.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '创建' }).click()
  const response = await responsePromise
  const payload = JSON.parse(await response.text())
  expect(response.status(), JSON.stringify(payload)).toBe(201)
  const projectId = Number(payload.data.id)
  const savedPolicy = database.prepare('SELECT automation_policy_json FROM redraw_projects WHERE id = ?')
    .get(projectId)
  expect(JSON.parse(savedPolicy.automation_policy_json)).toEqual(serverAutomationPolicySnapshot())
  return projectId
}

async function createGenericProjectFromRedraw(page) {
  return createProjectFromRedraw(page, genericRedrawProject.project)
}

function genericHighConfidenceSourceFacts() {
  return {
    ...genericSourceFacts,
    shots: genericSourceFacts.shots.map((shot) => ({
      ...shot,
      confidence: {
        ...shot.confidence,
        speaker_mapping: 0.96,
      },
    })),
  }
}

function currentGenericPreparationFactsHash(versionId) {
  const version = database.prepare('SELECT * FROM redraw_versions WHERE id = ?').get(Number(versionId))
  return String(version.facts_hash || '')
}

async function materializeGenericCharacterPlan(page, versionId) {
  const factsHash = currentGenericPreparationFactsHash(versionId)
  const characterRows = database.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND kind = 'character' AND deleted_at IS NULL ORDER BY id
  `).all(Number(versionId))
  const voiceRows = database.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND kind = 'voice' AND deleted_at IS NULL ORDER BY id
  `).all(Number(versionId))
  expect(characterRows).toHaveLength(2)
  expect(voiceRows).toHaveLength(2)
  const characterByKey = new Map()

  for (const character of genericReferencePreparationCase.characters) {
    const files = genericPreparationFiles.characters.get(character.source_character_key)
    const characterRow = characterRows.find((row) => (
      JSON.parse(row.source_ref_json).source_ref?.source_character_key === character.source_character_key
    ))
    const voiceRow = voiceRows.find((row) => (
      JSON.parse(row.source_ref_json).source_ref?.source_character_key === character.source_character_key
    ))
    expect(characterRow).toBeTruthy()
    expect(voiceRow).toBeTruthy()
    const identityAssetId = insertStoredArtifact({
      name: `${character.target_actor_label} identity`, type: 'image',
      relativePath: files.identity.relativePath, mimeType: 'image/png', width: 320, height: 480,
    })
    const wardrobeAssetId = insertStoredArtifact({
      name: `${character.target_actor_label} wardrobe`, type: 'image',
      relativePath: files.wardrobe.relativePath, mimeType: 'image/png', width: 320, height: 480,
    })
    const voiceAssetId = insertStoredArtifact({
      name: `${character.target_actor_label} voice`, type: 'audio',
      relativePath: files.voice.relativePath, mimeType: 'audio/mpeg', duration: files.voice.duration,
    })
    const characterPayload = JSON.parse(characterRow.source_ref_json)
    characterPayload.snapshot = {
      ...(characterPayload.snapshot || {}),
      voice_snapshot: {
        locale: genericRedrawProject.target.locale,
        market: genericRedrawProject.target.market,
        audio_sha256: files.voice.sha256,
        audio_asset_id: voiceAssetId,
        language_verified: true,
        detected_locale: genericRedrawProject.target.locale,
      },
    }
    database.prepare(`
      UPDATE redraw_assets SET asset_id = ?, source_ref_json = ?, status = 'generated'
      WHERE id = ?
    `).run(identityAssetId, JSON.stringify(characterPayload), Number(characterRow.id))
    database.prepare(`
      UPDATE redraw_assets SET voice_asset_id = ?, status = 'generated', approval_status = 'pending'
      WHERE id = ?
    `).run(voiceAssetId, Number(voiceRow.id))

    const currentCharacter = database.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(characterRow.id))
    const identityResponse = await browserApi(page, `/api/v1/redraw/assets/${characterRow.id}/identity-pack`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_actor_label: character.target_actor_label,
        confirmed_views: ['front', 'profile', 'full_body'],
        live_action_human_confirmed: true,
        adult_status: 'verified_18_plus',
        identity_consistency_confirmed: true,
        wardrobe_reference_asset_id: wardrobeAssetId,
        wardrobe_consistency_confirmed: true,
        expected_updated_at: currentCharacter.updated_at,
      }),
    })
    expect(identityResponse.status, JSON.stringify(identityResponse.body)).toBe(200)
    expect(identityResponse.body.data.identity_pack_status).toMatchObject({ ready: true })
    expect(identityResponse.body.data.identity_pack).toMatchObject({
      persona_origin: 'fictional_ai_generated',
      target_country: genericRedrawProject.target.market,
    })
    assertNoPreparationLeaks(identityResponse.body)

    for (const row of [
      database.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(characterRow.id)),
      database.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(voiceRow.id)),
    ]) {
      const review = await browserApi(page, `/api/v1/redraw/assets/${row.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approved', expected_updated_at: row.updated_at }),
      })
      expect(review.status, JSON.stringify(review.body)).toBe(200)
      assertNoPreparationLeaks(review.body)
    }
    characterByKey.set(character.source_character_key, {
      redrawAssetId: Number(characterRow.id),
      voiceRedrawAssetId: Number(voiceRow.id),
      identityAssetId,
      wardrobeAssetId,
      voiceAssetId,
    })
  }

  const plan = await browserApi(page, `/api/v1/redraw/versions/${versionId}/character-plan`)
  expect(plan.status, JSON.stringify(plan.body)).toBe(200)
  expect(plan.body.data).toMatchObject({ ready: true, version_id: Number(versionId) })
  expect(plan.body.data.characters).toHaveLength(2)
  expect(plan.body.data.characters.every((character) => (
    character.voice.ready === true && character.wardrobe.ready === true
  ))).toBe(true)
  assertNoPreparationLeaks(plan.body)
  return { characterByKey, factsHash, plan: plan.body.data }
}

async function installGenericReviewedCoverage(versionId, options = {}) {
  const version = database.prepare(`
    SELECT v.*, w.source_asset_id, w.source_fingerprint, w.duration_ms
    FROM redraw_versions v JOIN redraw_works w ON w.id = v.work_id
    WHERE v.id = ?
  `).get(Number(versionId))
  const shots = database.prepare(`
    SELECT * FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
  `).all(Number(versionId))
  const characterKeysByShot = Array.isArray(options.characterKeysByShot)
    ? options.characterKeysByShot.map((keys) => [...new Set((keys || []).map(String))])
    : genericReferencePreparationCase.shots.map((shot) => shot.character_keys)
  const characterKeys = [...new Set(characterKeysByShot.flat())]
  const baseRelative = `generic-preparation/version-${Number(versionId)}/analysis`
  const scopedEvidenceFile = (file) => {
    const sourceRelativePath = String(file.relativePath).replace(/\\/g, '/')
    const relativePath = path.posix.join(
      baseRelative,
      path.posix.relative('generic-preparation', sourceRelativePath),
    )
    const absolutePath = path.join(storageRoot, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.copyFileSync(path.join(storageRoot, sourceRelativePath), absolutePath)
    return { ...file, absolutePath, relativePath }
  }
  const frameById = new Map()
  const mask = (file) => ({
    path: path.posix.relative(baseRelative, file.relativePath.replace(/\\/g, '/')),
    sha256: file.sha256,
    width: file.width,
    height: file.height,
    mime_type: 'image/png',
  })
  for (const shot of shots) {
    const sourceFiles = genericPreparationFiles.shots.get(String(shot.shot_id))
    const files = {
      frame: scopedEvidenceFile(sourceFiles.frame),
      personMask: scopedEvidenceFile(sourceFiles.personMask),
      textMask: scopedEvidenceFile(sourceFiles.textMask),
    }
    for (const [label, file] of [
      ['frame', files.frame], ['person mask', files.personMask], ['text mask', files.textMask],
    ]) {
      assetService.create(database, log, {
        name: `${shot.shot_id} ${label}`,
        type: 'image',
        category: 'redraw',
        url: `/static/${file.relativePath}`,
        local_path: file.relativePath,
        file_size: fs.statSync(file.absolutePath).size,
        mime_type: 'image/png',
        width: file.width,
        height: file.height,
        metadata: { sha256: file.sha256 },
      })
    }
    frameById.set(String(shot.shot_id), files)
  }

  const frames = shots.map((shot, index) => {
    const files = frameById.get(String(shot.shot_id))
    const characters = characterKeysByShot[index] || []
    return {
      frame_index: index,
      timestamp_ticks: Number(shot.start_ms),
      timestamp_ms: Number(shot.start_ms),
      shot_id: String(shot.shot_id),
      path: path.posix.relative(baseRelative, files.frame.relativePath),
      sha256: files.frame.sha256,
      width: 320,
      height: 180,
      person_region_ids: characters.map((key) => `person-${key}-${index}`),
      text_region_ids: [`text-${index}`],
      review_point_reasons: [],
      review_status: 'not_required',
    }
  })
  const personTracks = characterKeys.map((sourceCharacterKey) => {
    const indexes = characterKeysByShot
      .map((keys, index) => keys.includes(sourceCharacterKey) ? index : null)
      .filter((index) => index !== null)
    return {
      track_key: `track-${sourceCharacterKey}`,
      kind: 'story_role',
      source_character_key: sourceCharacterKey,
      target_strategy: 'fixed_actor',
      frame_ranges: indexes.map((index) => ({ start_frame: index, end_frame: index })),
      visibility: indexes.map((index) => ({ start_frame: index, end_frame: index, state: 'visible' })),
      regions: indexes.map((index) => {
        const files = frameById.get(String(shots[index].shot_id))
        return {
          region_id: `person-${sourceCharacterKey}-${index}`,
          frame_index: index,
          bbox: { x: sourceCharacterKey === 'c1' ? 36 : 164, y: 24, width: 84, height: 118 },
          mask: mask(files.personMask),
          association_confidence: 0.99,
          detector_disagreement: false,
        }
      }),
      review_status: 'pending',
      reviewer: null,
    }
  })
  const textTracks = shots.map((shot, index) => {
    const files = frameById.get(String(shot.shot_id))
    return {
      region_key: `region-${shot.shot_id}`,
      kind: index === 0 ? 'subtitle' : 'screen',
      treatment: index === 0 ? 'translate_subtitle' : 'localize_screen',
      target_text_key: `region-${shot.shot_id}`,
      frame_ranges: [{ start_frame: index, end_frame: index }],
      regions: [{
        region_id: `text-${index}`,
        frame_index: index,
        polygon: [{ x: 56, y: 142 }, { x: 264, y: 142 }, { x: 264, y: 166 }, { x: 56, y: 166 }],
        mask: mask(files.textMask),
      }],
      review_status: 'pending',
      reviewer: null,
    }
  })
  const generated = await buildGeneratedCoverageManifest({
    evidenceRoot: path.join(storageRoot, baseRelative),
    source: {
      sha256: version.source_fingerprint,
      duration_ms: Number(version.duration_ms),
      width: 320,
      height: 180,
      frame_count: shots.length,
      time_base: { numerator: 1, denominator: 1000 },
    },
    shots: shots.map((shot) => ({
      shot_id: String(shot.shot_id), start_ms: Number(shot.start_ms), end_ms: Number(shot.end_ms),
    })),
    frames,
    personTracks,
    textTracks,
    modelLock: genericModelLock(),
  })
  const analysisRoot = path.join(storageRoot, baseRelative)
  fs.writeFileSync(
    path.join(analysisRoot, 'redraw-full-frame-coverage-manifest.json'),
    `${JSON.stringify(generated, null, 2)}\n`,
  )
  const reviewedRelative = `generic-preparation/version-${Number(versionId)}/reviewed`
  const reviewedRoot = path.join(storageRoot, reviewedRelative)
  const finalized = await finalizeReviewedCoverage({
    analysisRoot,
    decisions: {
      schema_version: 'redraw-full-frame-review-decisions-v1',
      analysis_sha256: generated.analysis_sha256,
      reviewer: 'codex-local-review',
      review_points: generated.frames
        .filter((frame) => frame.review_point_reasons.length > 0)
        .map((frame) => ({
          frame_index: frame.frame_index,
          reasons: frame.review_point_reasons,
          decision: 'accepted',
          corrections: [],
        })),
    },
    outputRoot: reviewedRoot,
  })
  const reviewed = finalized.reviewed_manifest
  try {
    await validateReviewedCoverageManifest({ evidenceRoot: reviewedRoot, manifest: reviewed })
  } catch (error) {
    throw new Error(`generic reviewed coverage invalid: ${error.code || error.message}`)
  }
  const reviewedEvidence = [
    ...reviewed.frames.map((frame) => ({ label: `frame ${frame.frame_index}`, file: frame })),
    ...reviewed.person_tracks.flatMap((track) => track.regions.map((region) => ({
      label: `person mask ${region.region_id}`,
      file: region.mask,
    }))),
    ...reviewed.text_tracks.flatMap((track) => track.regions.map((region) => ({
      label: `text mask ${region.region_id}`,
      file: region.mask,
    }))),
  ]
  const registeredEvidencePaths = new Set()
  for (const evidence of reviewedEvidence) {
    const relativePath = path.posix.join(reviewedRelative, evidence.file.path)
    if (registeredEvidencePaths.has(relativePath)) continue
    registeredEvidencePaths.add(relativePath)
    const absolutePath = path.join(storageRoot, relativePath)
    assetService.create(database, log, {
      name: `reviewed coverage ${evidence.label}`,
      type: 'image',
      category: 'redraw',
      url: `/static/${relativePath}`,
      local_path: relativePath,
      file_size: fs.statSync(absolutePath).size,
      mime_type: evidence.file.mime_type || 'image/png',
      width: evidence.file.width,
      height: evidence.file.height,
      metadata: { sha256: evidence.file.sha256 },
    })
  }
  const manifestRelativePath = `${reviewedRelative}/redraw-full-frame-reviewed-manifest.json`
  const manifestPath = path.join(storageRoot, manifestRelativePath)
  const manifestAsset = assetService.create(database, log, {
    name: 'generic reviewed full frame coverage',
    type: 'document',
    category: 'redraw',
    url: `/static/${manifestRelativePath}`,
    local_path: manifestRelativePath,
    file_size: fs.statSync(manifestPath).size,
    mime_type: 'application/json',
    metadata: { sha256: sha256File(manifestPath) },
  })
  const assetContext = {
    db: database,
    tenantId: owner.tenant.id,
    userId: owner.user.id,
    versionId: Number(versionId),
    allowUnmaterializedDraft: true,
    assetReader: {
      canRead: (asset) => Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path))),
    },
  }
  const attempt = redrawAssetService.createAssetAttempt(assetContext, {
    kind: 'scene',
    sourceRef: { stable_id: 'full-frame-reviewed-coverage' },
    snapshot: {
      mode: 'full_frame_reviewed_coverage',
      version_id: Number(versionId),
      facts_hash: version.facts_hash,
      source_fingerprint: version.source_fingerprint,
      analysis_sha256: reviewed.analysis_sha256,
    },
    localizedName: 'reviewed full frame coverage',
    model: 'local-full-frame-review',
    operationKey: `local-full-frame-review:${Number(versionId)}:${reviewed.analysis_sha256}`,
  })
  const coverageAsset = redrawAssetService.finalizeAssetAttempt(assetContext, attempt.id, {
    status: 'completed',
    provider_task_id: `local-full-frame-review-${Number(versionId)}`,
    asset_id: manifestAsset.id,
  })
  expect(coverageAsset).toMatchObject({ status: 'generated', approval_status: 'pending' })
  assertNoPreparationLeaks(reviewed)
  return { reviewed, coverageAsset }
}

function approvedCleanRows(versionId) {
  return database.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND kind = 'scene' AND approval_status = 'approved'
      AND clean_plate_asset_id IS NOT NULL AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(Number(versionId))
}

async function registerGenericMotionAssetForShot(versionId, shotId) {
  const ctx = {
    db: database,
    tenantId: owner.tenant.id,
    userId: owner.user.id,
    versionId: Number(versionId),
    storageRoot,
    assetReader: { canRead: () => true, owns: () => true },
  }
  const coverage = await loadReviewedReferenceCoverage(ctx)
  const rows = database.prepare('SELECT * FROM redraw_shots WHERE version_id = ? ORDER BY shot_index')
    .all(Number(versionId))
  const cleanRows = approvedCleanRows(versionId)
  const cleanByKey = new Map()
  for (const row of cleanRows) {
    const payload = JSON.parse(row.source_ref_json || '{}')
    const stableId = String(payload.source_ref?.stable_id || '')
    const kind = String(payload.source_ref?.kind || '')
    if (stableId && ['person_clean', 'text_subtitle', 'text_screen'].includes(kind)) {
      cleanByKey.set(`${kind === 'person_clean' ? 'person_clean' : 'text_clean'}:${stableId}`, Number(row.id))
    }
  }
  const descriptor = coverage.shots.find((item) => Number(item.shot_id) === Number(shotId))
  if (!descriptor || descriptor.requirements.some((item) => !cleanByKey.has(`${item.kind}:${item.key}`))) return null
  const row = rows.find((item) => Number(item.id) === Number(descriptor.shot_id))
  if (!row) return null
  const bindings = await buildCurrentReferenceBindings(ctx, {
    shot_id: Number(row.id),
    clean_results: descriptor.requirements.map((requirement) => ({
      kind: requirement.kind,
      key: requirement.key,
      status: 'completed',
      redraw_asset_id: cleanByKey.get(`${requirement.kind}:${requirement.key}`),
    })),
  })
  const shotFiles = genericPreparationFiles.shots.get(String(row.shot_id))
  const expectedDuration = (Number(row.end_ms) - Number(row.start_ms)) / 1000
  let file = shotFiles.motion
  if (Math.abs(file.duration - expectedDuration) > 0.1) {
    const safeShotId = String(row.shot_id).replace(/[^a-zA-Z0-9_-]/g, '-')
    const sourceRelativePath = `generic-preparation/runtime-motion/${safeShotId}-${Number(row.end_ms) - Number(row.start_ms)}.mp4`
    const sourcePath = path.join(storageRoot, sourceRelativePath)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `color=c=${shotFiles.definition.color}:size=320x180:rate=12`,
      '-t', String(expectedDuration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', sourcePath,
    ], `${row.shot_id} 运动参考生成`)
    const sha256 = sha256File(sourcePath)
    const relativePath = `redraw-conditioning/${sha256}.mp4`
    const absolutePath = path.join(storageRoot, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.copyFileSync(sourcePath, absolutePath)
    file = { absolutePath, relativePath, sha256, duration: expectedDuration }
  }
  const metadata = {
    sha256: file.sha256,
    redraw_motion_reference: {
      schema_version: 'redraw-motion-reference-v1',
      tenant_id: owner.tenant.id,
      user_id: owner.user.id,
      version_id: Number(versionId),
      shot_id: Number(row.id),
      source_asset_id: bindings.source.asset_id,
      source_fingerprint: bindings.source.fingerprint,
      clip_start_ms: bindings.clip.start_ms,
      clip_end_ms: bindings.clip.end_ms,
      face_coverage_sha256: bindings.face_coverage_sha256,
      text_coverage_sha256: bindings.text_coverage_sha256,
      coverage_binding_sha256: bindings.coverage_binding_sha256,
      identity_binding_sha256: bindings.identity_binding_sha256,
      clean_binding_sha256: bindings.clean_binding_sha256,
      file_sha256: file.sha256,
    },
  }
  const existing = database.prepare("SELECT id, metadata FROM assets WHERE type = 'video' AND category = 'redraw'")
    .all().find((asset) => stableJson(JSON.parse(asset.metadata || '{}').redraw_motion_reference) === stableJson(metadata.redraw_motion_reference))
  if (existing) return existing
  const artifact = assetService.create(database, log, {
    name: `${row.shot_id} motion reference`,
    type: 'video',
    category: 'redraw',
    url: `/static/${file.relativePath}`,
    local_path: file.relativePath,
    file_size: fs.statSync(path.join(storageRoot, file.relativePath)).size,
    mime_type: 'video/mp4',
    duration: file.duration,
    width: 320,
    height: 180,
    metadata,
  })
  return artifact
}

async function prepareGenericReferences(page, versionId, idempotencyPrefix) {
  const publicResponses = []
  const maxRounds = genericReferencePreparationCase.shots
    .reduce((total, shot) => total + shot.character_keys.length + 3, 0)
  for (let round = 1; round <= maxRounds; round += 1) {
    const shotIds = database.prepare('SELECT id FROM redraw_shots WHERE version_id = ? ORDER BY shot_index')
      .all(Number(versionId))
    for (const shot of shotIds) await registerGenericMotionAssetForShot(versionId, shot.id)
    const gate = await browserApi(page, `/api/v1/redraw/versions/${versionId}/preparation-gate`)
    expect(gate.status, JSON.stringify(gate.body)).toBe(200)
    publicResponses.push(gate.body)
    if (gate.body.data.ok === true) return publicResponses
    const discovered = await browserApi(page, `/api/v1/redraw/versions/${versionId}/reference-preparation-quote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(discovered.status, JSON.stringify(discovered.body)).toBe(200)
    const selectedShotIds = [...new Set([
      ...discovered.body.data.missing_shot_ids,
      ...discovered.body.data.needs_attention_shot_ids,
    ])].slice(0, 1)
    expect(selectedShotIds.length, JSON.stringify({
      gate: gate.body,
      discovered: discovered.body,
    })).toBeGreaterThan(0)
    publicResponses.push(discovered.body)
    const quote = await browserApi(page, `/api/v1/redraw/versions/${versionId}/reference-preparation-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shot_ids: selectedShotIds }),
    })
    expect(quote.status, JSON.stringify(quote.body)).toBe(200)
    expect(quote.body.data).toMatchObject({
      priced: true,
      quote_hash: expect.any(String),
      selected_shot_ids: selectedShotIds,
    })
    publicResponses.push(quote.body)
    const started = await browserApi(page, `/api/v1/redraw/versions/${versionId}/reference-preparations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quote_hash: quote.body.data.quote_hash,
        idempotency_key: `${idempotencyPrefix}-${round}`,
        shot_ids: selectedShotIds,
      }),
    })
    expect(started.status, JSON.stringify(started.body)).toBe(202)
    publicResponses.push(started.body)
    const taskId = String(started.body.data?.task_id ?? started.body.data?.taskId ?? started.body.task_id ?? '').trim()
    expect(taskId.length > 0, JSON.stringify(started.body)).toBe(true)
    await expect.poll(() => database.prepare('SELECT status FROM async_tasks WHERE id = ?').get(taskId)?.status, {
      timeout: 15_000,
    }).toMatch(/^(completed|needs_attention|failed)$/)
    const task = database.prepare('SELECT status, error, message, result FROM async_tasks WHERE id = ?').get(taskId)
    expect(task.status, JSON.stringify({
      task,
      runtimeErrors,
      shots: database.prepare(`
        SELECT id, shot_id, preparation_state, stale_reason_code, draft_json
        FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
      `).all(Number(versionId)),
    })).not.toBe('failed')
    const pending = database.prepare(`
      SELECT * FROM redraw_assets
      WHERE version_id = ? AND kind = 'scene' AND clean_plate_asset_id IS NOT NULL
        AND approval_status = 'pending' AND deleted_at IS NULL ORDER BY id
    `).all(Number(versionId))
    for (const asset of pending) {
      const review = await browserApi(page, `/api/v1/redraw/assets/${asset.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approved', expected_updated_at: asset.updated_at }),
      })
      expect(review.status, JSON.stringify(review.body)).toBe(200)
      publicResponses.push(review.body)
    }
  }
  const finalGate = await browserApi(page, `/api/v1/redraw/versions/${versionId}/preparation-gate`)
  const finalQuote = await browserApi(page, `/api/v1/redraw/versions/${versionId}/reference-preparation-quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  throw new Error(JSON.stringify({
    finalGate: finalGate.body,
    finalQuote: finalQuote.body,
    providerCalls: referencePreparationProviderCalls,
    shots: database.prepare(`
      SELECT id, shot_id, preparation_state, stale_reason_code FROM redraw_shots
      WHERE version_id = ? ORDER BY shot_index
    `).all(Number(versionId)),
    held: database.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'held'").get().count,
  }))
}

async function prepareGenericReferencesThroughUi(page, versionId, interaction, waitForRequestsToSettle) {
  const maxRounds = genericReferencePreparationCase.shots
    .reduce((total, shot) => total + shot.character_keys.length + 3, 0)
  for (let round = 0; round < maxRounds; round += 1) {
    const shotIds = database.prepare('SELECT id FROM redraw_shots WHERE version_id = ? ORDER BY shot_index')
      .all(Number(versionId))
    for (const shot of shotIds) await registerGenericMotionAssetForShot(versionId, shot.id)
    const gate = await browserApi(page, `/api/v1/redraw/versions/${versionId}/preparation-gate`)
    expect(gate.status, JSON.stringify(gate.body)).toBe(200)
    if (gate.body.data.ok === true) return gate.body.data

    await waitForRequestsToSettle()
    await page.locator('.redraw-step').filter({ hasText: '批量转绘' }).click()
    await waitForRequestsToSettle()
    await page.reload()
    await waitForRequestsToSettle()
    await expect(page.getByRole('heading', { name: '人物、文字、净景与参考包' })).toBeVisible()
    const prepareButton = page.getByRole('button', { name: '按服务端策略自动准备', exact: true })
    await expect(prepareButton).toBeEnabled()
    const started = await clickForJsonResponse(
      page,
      prepareButton,
      apiResponse('POST', new RegExp(`/api/v1/redraw/versions/${versionId}/reference-preparations$`)),
    )
    expect(started.response.status(), JSON.stringify(started.payload)).toBe(202)
    interaction.reference_preparations += 1
    const taskId = String(started.payload?.data?.task_id || '')
    expect(taskId).not.toBe('')
    await expect.poll(() => database.prepare('SELECT status FROM async_tasks WHERE id = ?').get(taskId)?.status, {
      timeout: 15_000,
    }).toMatch(/^(completed|needs_attention|failed)$/)
    const preparationTask = database.prepare(`
      SELECT status, error, message, result FROM async_tasks WHERE id = ?
    `).get(taskId)
    expect(preparationTask.status, JSON.stringify({
      task: preparationTask,
      runtimeErrors,
      shots: database.prepare(`
        SELECT id, shot_id, start_ms, end_ms, duration_ms,
               source_dialogue_json, localized_dialogue_json,
               preparation_state, stale_reason_code, preparation_snapshot_json
        FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
      `).all(Number(versionId)),
    })).not.toBe('failed')

    const pending = database.prepare(`
      SELECT id FROM redraw_assets
      WHERE version_id = ? AND kind = 'scene' AND clean_plate_asset_id IS NOT NULL
        AND approval_status = 'pending' AND deleted_at IS NULL ORDER BY id
    `).all(Number(versionId))
    if (pending.length) {
      await waitForRequestsToSettle()
      await page.locator('.redraw-step').filter({ hasText: '资产审核' }).click()
      await expect(page.getByRole('heading', { name: '确认本地化资产后再进入批量转绘' })).toBeVisible()
      await page.locator('.asset-tabs').getByRole('button', { name: '场景', exact: true }).click()
      for (const asset of pending) {
        const review = await clickForJsonResponse(
          page,
          page.locator(`#asset-${asset.id}-scene`).getByRole('button', { name: '批准', exact: true }),
          apiResponse('POST', new RegExp(`/api/v1/redraw/assets/${asset.id}/review$`)),
        )
        expect(review.response.status(), JSON.stringify(review.payload)).toBe(200)
        interaction.reference_asset_approvals += 1
      }
    }
  }
  const finalGate = await browserApi(page, `/api/v1/redraw/versions/${versionId}/preparation-gate`)
  throw new Error(`UI 逐镜参考准备未收口：${JSON.stringify(finalGate.body)}`)
}

integrationTest('通用三镜项目完成前链分析并在低说话人置信度下降级 safe', async ({ page }) => {
  resetProviderFixture(genericSourceFacts, genericLocalization)
  const browserErrors = []
  page.on('pageerror', (error) => browserErrors.push(`pageerror:${error.message}`))
  page.on('requestfailed', (request) => {
    browserErrors.push(`requestfailed:${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`)
  })
  const genericVideoPath = createGenericSourceVideo()
  const projectId = await createGenericProjectFromRedraw(page)
  await expect(page).toHaveURL(new RegExp(`/redraw/projects/${projectId}/works/new\\?step=1`))
  const createdProject = await browserApi(page, `/api/v1/redraw/projects/${projectId}`)
  expect(createdProject.body.data).toMatchObject({
    execution_mode: 'auto',
    default_locale: genericRedrawProject.target.locale,
    default_market: genericRedrawProject.target.market,
  })
  expect(JSON.stringify(createdProject.body.data)).toContain('es-ES')
  expect(JSON.stringify(createdProject.body.data)).toContain('ES')
  expect(JSON.stringify(createdProject.body.data)).not.toContain('en-US')
  await expect(page.getByText('原始模式').locator('..').getByText('auto', { exact: true })).toBeVisible()

  await page.locator('input[type="file"][accept*="video/mp4"]').setInputFiles(genericVideoPath)
  const uploadResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && /\/api\/v1\/redraw\/projects\/\d+\/works$/.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '上传源片', exact: true }).click()
  const uploadResponse = await uploadResponsePromise
  const uploadPayload = JSON.parse(await uploadResponse.text())
  expect(uploadResponse.status(), JSON.stringify(uploadPayload)).toBe(201)
  const workId = Number(uploadPayload.data.items[0].id)
  await expect.poll(() => uploadedHeaderHex).toBe(
    fs.readFileSync(genericVideoPath).subarray(0, 12).toString('hex'),
  )

  const analysisStart = await browserApi(page, `/api/v1/redraw/works/${workId}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locale: genericRedrawProject.target.locale,
      market: genericRedrawProject.target.market,
      aspect_ratio: '16:9',
      style_preset_id: 1,
    }),
  })
  expect([201, 202], JSON.stringify(analysisStart.body)).toContain(analysisStart.status)

  let analyzed
  await expect.poll(async () => {
    const result = await browserApi(page, `/api/v1/redraw/works/${workId}`)
    analyzed = result.body?.data
    return analyzed?.analysis_decision?.effective_mode || ''
  }, { timeout: 15_000, message: JSON.stringify(analyzed) }).toBe('safe')

  expect(analyzed).toMatchObject({
    workflow_phase: 'analysis_review',
    current_step: 1,
    analysis_decision: {
      action: 'needs_review',
      effective_mode: 'safe',
      reason_codes: ['speaker_mapping_low_confidence'],
    },
  })
  expect(analyzed.shots).toHaveLength(0)
  const sourceVersions = database.prepare(`
    SELECT id, locale, market, source_facts_json FROM redraw_versions
    WHERE work_id = ? ORDER BY id
  `).all(workId)
  expect(sourceVersions).toHaveLength(1)
  expect(sourceVersions[0]).toMatchObject({ locale: 'source', market: '' })
  const persistedFacts = JSON.parse(sourceVersions[0].source_facts_json)
  expect(persistedFacts).toMatchObject({
    duration_ms: 12_000,
  })
  expect(persistedFacts.shots.map((shot) => [shot.id, shot.start_ms, shot.end_ms])).toEqual([
    ['shot-1', 0, 4_000],
    ['shot-2', 4_000, 8_000],
    ['shot-3', 8_000, 12_000],
  ])
  expect(persistedFacts.characters.map((character) => character.id).sort()).toEqual(['c1', 'c2'])
  expect(persistedFacts.characters.map((character) => character.source_name).sort()).toEqual(['周启', '林薇'])
  expect(JSON.stringify(persistedFacts)).not.toContain('阿岚')
  expect(persistedFacts.shots).toHaveLength(3)
  expect(persistedFacts.shots.filter((shot) => shot.audio_contract.dialogue_mode === 'silent')).toHaveLength(1)
  expect(persistedFacts.shots.some((shot) => shot.text_regions.length > 0)).toBe(true)

  await page.reload()
  await expect(page.getByText('服务端分析摘要')).toBeVisible()
  await expect(page.getByText('原始模式').locator('..').getByText('auto', { exact: true })).toBeVisible()
  await expect(page.getByText('有效模式').locator('..').getByText('safe', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(window.localStorage)
    .filter((key) => /redraw|workflow/i.test(key))
    .sort())).toEqual([])
  expect(await page.evaluate(() => Object.keys(window.sessionStorage)
    .filter((key) => /redraw|workflow/i.test(key))
    .sort())).toEqual([])
  const refreshed = await browserApi(page, `/api/v1/redraw/works/${workId}`)
  expect(refreshed.body.data.analysis_decision).toMatchObject({
    action: 'needs_review',
    effective_mode: 'safe',
    reason_codes: ['speaker_mapping_low_confidence'],
  })
  expect(refreshed.body.data.analysis_billing).toMatchObject({ held: 0, released: 0 })
  expect(refreshed.body.data.localization_billing).toMatchObject({ held: 0, charged: 0, released: 0 })
  expect(database.prepare('SELECT COUNT(*) AS count FROM redraw_assets').get().count).toBe(0)
  expect(database.prepare('SELECT COUNT(*) AS count FROM redraw_asset_batches').get().count).toBe(0)
  expect(database.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count).toBe(0)
  expect(database.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'held'").get().count).toBe(0)
  expect(database.prepare(`
    SELECT COUNT(*) AS count FROM tenant_usage_reservations
    WHERE resource_type IN ('redraw_localization', 'redraw_asset', 'redraw_shot', 'redraw_dialogue')
  `).get().count).toBe(0)
  expect(providerCallCounts).toEqual({ asset: 0, video: 0, dialogue: 0 })
  expect(browserErrors, JSON.stringify(browserErrors)).toEqual([])
  expect(runtimeErrors, JSON.stringify(runtimeErrors)).toEqual([])
})

integrationTest('通用三镜项目高置信度分析后完成 es-ES 本地化并物化三镜', async ({ page }) => {
  resetProviderFixture(genericHighConfidenceSourceFacts(), genericLocalization)
  const browserErrors = []
  page.on('pageerror', (error) => browserErrors.push(`pageerror:${error.message}`))
  page.on('requestfailed', (request) => {
    browserErrors.push(`requestfailed:${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`)
  })
  const genericVideoPath = createGenericSourceVideo({
    filename: 'generic-source-12s-high-confidence.mp4',
    color: 'darkblue',
    frequency: 420,
  })
  const projectId = await createGenericProjectFromRedraw(page)
  await expect(page).toHaveURL(new RegExp(`/redraw/projects/${projectId}/works/new\\?step=1`))

  await page.locator('input[type="file"][accept*="video/mp4"]').setInputFiles(genericVideoPath)
  const uploadResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && /\/api\/v1\/redraw\/projects\/\d+\/works$/.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '上传源片', exact: true }).click()
  const uploadResponse = await uploadResponsePromise
  const uploadPayload = JSON.parse(await uploadResponse.text())
  expect(uploadResponse.status(), JSON.stringify(uploadPayload)).toBe(201)
  const workId = Number(uploadPayload.data.items[0].id)

  const analysisStart = await browserApi(page, `/api/v1/redraw/works/${workId}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locale: genericRedrawProject.target.locale,
      market: genericRedrawProject.target.market,
      aspect_ratio: '16:9',
      style_preset_id: 1,
    }),
  })
  expect([201, 202], JSON.stringify(analysisStart.body)).toContain(analysisStart.status)

  let analyzed
  await expect.poll(async () => {
    const result = await browserApi(page, `/api/v1/redraw/works/${workId}`)
    analyzed = result.body?.data
    return analyzed?.analysis_decision?.effective_mode || ''
  }, { timeout: 15_000, message: JSON.stringify(analyzed) }).toBe('auto')
  expect(analyzed).toMatchObject({
    analysis_decision: {
      action: 'advance',
      effective_mode: 'auto',
      reason_codes: [],
    },
  })

  const quoteResponse = await browserApi(page, `/api/v1/redraw/works/${workId}/localization-quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locale: genericRedrawProject.target.locale,
      market: genericRedrawProject.target.market,
      localization_level: genericRedrawProject.project.localization_level,
    }),
  })
  expect(quoteResponse.status, JSON.stringify(quoteResponse.body)).toBe(200)
  expect(quoteResponse.body.data).toMatchObject({ priced: true, quote_hash: expect.any(String) })
  const localizationStart = await browserApi(page, `/api/v1/redraw/works/${workId}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locale: genericRedrawProject.target.locale,
      market: genericRedrawProject.target.market,
      localization_level: genericRedrawProject.project.localization_level,
      quote_hash: quoteResponse.body.data.quote_hash,
      idempotency_key: 'generic-es-localization-1',
    }),
  })
  expect(localizationStart.status, JSON.stringify(localizationStart.body)).toBe(202)

  let localizationDebug
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await browserApi(page, `/api/v1/redraw/works/${workId}`)
    const work = result.body?.data
    localizationDebug = {
      status: result.status,
      phase: work?.workflow_phase,
      versionId: work?.version_id,
      localizationTask: work?.localization_task,
      versions: database.prepare('SELECT id, version, locale, market, status, localization_task_id FROM redraw_versions WHERE work_id = ? ORDER BY version').all(workId),
    }
    if (work?.version_id) break
    await page.waitForTimeout(250)
  }
  expect(localizationDebug, JSON.stringify(localizationDebug)).toMatchObject({
    status: 200,
    phase: 'asset_review',
    versionId: expect.any(Number),
  })

  const localizedResult = await browserApi(page, `/api/v1/redraw/works/${workId}`)
  const localized = localizedResult.body.data
  expect(localized).toMatchObject({
    workflow_phase: 'asset_review',
    version_id: expect.any(Number),
  })
  const localizedVersion = database.prepare(`
    SELECT id, locale, market, status, facts_hash, source_facts_json, name_map_json
    FROM redraw_versions WHERE id = ?
  `).get(Number(localized.version_id))
  expect(localizedVersion).toMatchObject({
    locale: genericRedrawProject.target.locale,
    market: genericRedrawProject.target.market,
    status: 'asset_review',
  })
  const localizedSourceFacts = JSON.parse(localizedVersion.source_facts_json)
  expect(localizedSourceFacts).not.toHaveProperty('script_sha256')
  expect(localizedSourceFacts).not.toHaveProperty('name_map_source_sha256')
  const localizedShots = database.prepare(`
    SELECT shot_id, start_ms, end_ms FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
  `).all(Number(localized.version_id))
  expect(localizedShots.map((shot) => [shot.shot_id, shot.start_ms, shot.end_ms])).toEqual([
    ['shot-1', 0, 4_000],
    ['shot-2', 4_000, 8_000],
    ['shot-3', 8_000, 12_000],
  ])
  expect(localized.shots).toHaveLength(3)

  const characterSetup = await materializeGenericCharacterPlan(page, Number(localized.version_id))
  expect(characterSetup.plan.characters.map((character) => character.source_character_key)).toEqual(['c1', 'c2'])
  expect(characterSetup.plan).toMatchObject({ ready: true, missing: [] })
  expect(characterSetup.plan.characters.every((character) => (
    character.voice.ready === true && character.wardrobe.ready === true
  ))).toBe(true)
  const reviewedCoverage = await installGenericReviewedCoverage(Number(localized.version_id))
  expect(reviewedCoverage.reviewed.shots).toHaveLength(3)
  expect(reviewedCoverage.reviewed.frames).toHaveLength(3)
  const coverageReview = await browserApi(
    page,
    `/api/v1/redraw/assets/${reviewedCoverage.coverageAsset.id}/review`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'approved',
        expected_updated_at: reviewedCoverage.coverageAsset.updated_at,
      }),
    },
  )
  expect(coverageReview.status, JSON.stringify(coverageReview.body)).toBe(200)
  assertNoPreparationLeaks(reviewedCoverage.reviewed)
  const preparationResponses = await prepareGenericReferences(
    page,
    Number(localized.version_id),
    'generic-reference-initial',
  )
  preparationResponses.forEach(assertNoPreparationLeaks)

  let preparedRows = database.prepare(`
    SELECT id, shot_id, start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
           preparation_state, reference_bundle_json, reference_bundle_hash
    FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
  `).all(Number(localized.version_id))
  expect(preparedRows.map((shot) => [shot.shot_id, shot.preparation_state])).toEqual([
    ['shot-1', 'reference_ready'],
    ['shot-2', 'reference_ready'],
    ['shot-3', 'reference_ready'],
  ])
  const expectedDialogueByShot = new Map([
    ['shot-1', [{ speaker_id: 'c1', localized_text: 'Fue aquí.', start_ms: 900, end_ms: 2_300 }]],
    ['shot-2', [{ speaker_id: 'c2', localized_text: 'No sigas.', start_ms: 800, end_ms: 2_500 }]],
    ['shot-3', []],
  ])
  const canonicalNameMap = Object.fromEntries(Object.entries(JSON.parse(localizedVersion.name_map_json))
    .map(([key, value]) => [key.trim(), value.trim()])
    .sort(([left], [right]) => left.localeCompare(right)))
  const characterNameMapSha256 = sha256Value(stableJson(canonicalNameMap))
  const expectedDialogueEvidenceByShot = new Map(preparedRows.map((shot) => {
    const sourceDialogue = JSON.parse(shot.source_dialogue_json).map((turn) => ({
      id: String(turn.id || '').trim(),
      speaker_id: String(turn.speaker_id || '').trim(),
      source_text: String(turn.source_text ?? turn.text ?? '').trim(),
      start_ms: Number(turn.start_ms) - Number(shot.start_ms),
      end_ms: Number(turn.end_ms) - Number(shot.start_ms),
    })).sort((left, right) => left.start_ms - right.start_ms
      || left.end_ms - right.end_ms
      || left.speaker_id.localeCompare(right.speaker_id)
      || left.id.localeCompare(right.id))
    const turns = JSON.parse(shot.localized_dialogue_json).map((turn) => ({
      speaker_id: String(turn.speaker_id || '').trim(),
      localized_text: String(turn.localized_text || '').trim(),
      start_ms: Number(turn.start_ms) - Number(shot.start_ms),
      end_ms: Number(turn.end_ms) - Number(shot.start_ms),
    })).sort((left, right) => left.start_ms - right.start_ms
      || left.end_ms - right.end_ms
      || left.speaker_id.localeCompare(right.speaker_id))
    expect(turns).toEqual(expectedDialogueByShot.get(shot.shot_id))
    const sourceDialogueSha256 = sha256Value(stableJson(sourceDialogue))
    const scriptSha256 = sha256Value(stableJson(turns))
    const binding = {
      contract: 'redraw-localization-binding-v1',
      version_id: Number(localizedVersion.id),
      facts_hash: localizedVersion.facts_hash,
      target: { locale: localizedVersion.locale, market: localizedVersion.market },
      shot: {
        id: Number(shot.id),
        shot_id: shot.shot_id,
        start_ms: Number(shot.start_ms),
        end_ms: Number(shot.end_ms),
        duration_ms: Number(shot.duration_ms),
      },
      source_dialogue_sha256: sourceDialogueSha256,
      script_sha256: scriptSha256,
      character_name_map_sha256: characterNameMapSha256,
    }
    return [shot.shot_id, {
      source_dialogue_sha256: sourceDialogueSha256,
      script_sha256: scriptSha256,
      character_name_map_sha256: characterNameMapSha256,
      localization_binding_sha256: sha256Value(stableJson(binding)),
    }]
  }))
  const initialBundleByShot = new Map()
  const dialogueStates = []
  for (const shot of preparedRows) {
    expect(shot.reference_bundle_hash).toMatch(/^[a-f0-9]{64}$/)
    const bundle = JSON.parse(shot.reference_bundle_json)
    initialBundleByShot.set(shot.shot_id, { hash: shot.reference_bundle_hash, bundle })
    expect(bundle).toMatchObject({
      schema_version: 'redraw-reference-bundle-v2',
      locale: genericRedrawProject.target.locale,
      market: genericRedrawProject.target.market,
      name_map: genericLocalization.name_map,
    })
    const expectedTurns = expectedDialogueByShot.get(shot.shot_id)
    const expectedEvidence = expectedDialogueEvidenceByShot.get(shot.shot_id)
    expect(bundle.dialogue).toMatchObject({
      target_locale: 'es-ES',
      target_market: 'ES',
      kind: expectedTurns.length ? 'spoken' : 'silent',
      speech_required: expectedTurns.length > 0,
      ...expectedEvidence,
      turns: expectedTurns,
    })
    for (const field of [
      'source_dialogue_sha256',
      'script_sha256',
      'character_name_map_sha256',
      'localization_binding_sha256',
    ]) expect(bundle.dialogue[field]).toMatch(/^[a-f0-9]{64}$/)
    dialogueStates.push([
      bundle.dialogue.kind,
      bundle.dialogue.speech_required,
      bundle.dialogue.turns.length,
    ])
    expect(JSON.stringify(bundle)).not.toMatch(/[\u3400-\u9fff]/)
    assertNoPreparationLeaks(bundle)
    const apiBundle = await browserApi(page, `/api/v1/redraw/shots/${shot.id}/reference-bundle`)
    expect(apiBundle.status, JSON.stringify(apiBundle.body)).toBe(200)
    expect(apiBundle.body.data.reference_bundle_hash).toBe(shot.reference_bundle_hash)
    expect(apiBundle.body.data.bundle).toMatchObject({
      schema_version: bundle.schema_version,
      shot_id: bundle.shot_id,
      version_id: bundle.version_id,
      locale: bundle.locale,
      market: bundle.market,
      name_map: bundle.name_map,
      dialogue: bundle.dialogue,
    })
    assertNoPreparationLeaks(apiBundle.body)
  }
  expect(dialogueStates).toEqual([
    ['spoken', true, 1],
    ['spoken', true, 1],
    ['silent', false, 0],
  ])

  const c1 = genericPreparationFiles.characters.get('c1')
  const c1State = characterSetup.characterByKey.get('c1')
  const replacementIdentityAssetId = insertStoredArtifact({
    name: 'Clara Vega replacement identity', type: 'image',
    relativePath: c1.replacementIdentity.relativePath, mimeType: 'image/png', width: 320, height: 480,
  })
  database.prepare('UPDATE redraw_assets SET asset_id = ? WHERE id = ?')
    .run(replacementIdentityAssetId, c1State.redrawAssetId)
  const c1BeforeChange = database.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(c1State.redrawAssetId)
  const changedIdentity = await browserApi(page, `/api/v1/redraw/assets/${c1State.redrawAssetId}/identity-pack`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_actor_label: c1.definition.target_actor_label,
      confirmed_views: ['front', 'profile', 'full_body'],
      live_action_human_confirmed: true,
      adult_status: 'verified_18_plus',
      identity_consistency_confirmed: true,
      wardrobe_reference_asset_id: c1State.wardrobeAssetId,
      wardrobe_consistency_confirmed: true,
      expected_updated_at: c1BeforeChange.updated_at,
    }),
  })
  expect(changedIdentity.status, JSON.stringify(changedIdentity.body)).toBe(200)
  expect(changedIdentity.body.data.identity_pack).toMatchObject({
    persona_origin: 'fictional_ai_generated',
    target_country: genericRedrawProject.target.market,
  })
  assertNoPreparationLeaks(changedIdentity.body)
  preparedRows = database.prepare(`
    SELECT id, shot_id, preparation_state, reference_bundle_json, reference_bundle_hash
    FROM redraw_shots
    WHERE version_id = ? ORDER BY shot_index
  `).all(Number(localized.version_id))
  expect(preparedRows.map((shot) => [shot.shot_id, shot.preparation_state])).toEqual([
    ['shot-1', 'stale'],
    ['shot-2', 'stale'],
    ['shot-3', 'reference_ready'],
  ])
  const c1AfterChange = database.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(c1State.redrawAssetId)
  const c1Review = await browserApi(page, `/api/v1/redraw/assets/${c1State.redrawAssetId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approved', expected_updated_at: c1AfterChange.updated_at }),
  })
  expect(c1Review.status, JSON.stringify(c1Review.body)).toBe(200)
  assertNoPreparationLeaks(c1Review.body)
  const providerCallsBeforeRecovery = referencePreparationProviderCalls
  const recoveryResponses = await prepareGenericReferences(
    page,
    Number(localized.version_id),
    'generic-reference-recovery',
  )
  recoveryResponses.forEach(assertNoPreparationLeaks)
  expect(referencePreparationProviderCalls).toBe(providerCallsBeforeRecovery)
  preparedRows = database.prepare(`
    SELECT id, shot_id, preparation_state, reference_bundle_json, reference_bundle_hash
    FROM redraw_shots
    WHERE version_id = ? ORDER BY shot_index
  `).all(Number(localized.version_id))
  expect(preparedRows.map((shot) => [shot.shot_id, shot.preparation_state])).toEqual([
    ['shot-1', 'reference_ready'],
    ['shot-2', 'reference_ready'],
    ['shot-3', 'reference_ready'],
  ])
  const restoredPlan = await browserApi(page, `/api/v1/redraw/versions/${localized.version_id}/character-plan`)
  expect(restoredPlan.status, JSON.stringify(restoredPlan.body)).toBe(200)
  expect(restoredPlan.body.data.ready).toBe(true)
  assertNoPreparationLeaks(restoredPlan.body)
  const c2State = characterSetup.characterByKey.get('c2')
  for (const shot of preparedRows) {
    const initial = initialBundleByShot.get(shot.shot_id)
    const bundle = JSON.parse(shot.reference_bundle_json)
    const c1Faces = bundle.face_tracks.filter((face) => face.source_character_key === 'c1')
    const c2Faces = bundle.face_tracks.filter((face) => face.source_character_key === 'c2')
    if (genericReferencePreparationCase.shots
      .find((fixtureShot) => fixtureShot.source_shot_id === shot.shot_id)
      .character_keys.includes('c1')) {
      expect(shot.reference_bundle_hash).not.toBe(initial.hash)
      expect(c1Faces.length).toBeGreaterThan(0)
      expect(c1Faces.every((face) => face.identity_asset_id === replacementIdentityAssetId)).toBe(true)
    } else {
      expect(shot.reference_bundle_hash).toBe(initial.hash)
      expect(bundle).toEqual(initial.bundle)
    }
    expect(c2Faces.every((face) => face.identity_asset_id === c2State.identityAssetId)).toBe(true)
    expect(bundle.dialogue).toMatchObject({
      target_locale: 'es-ES',
      target_market: 'ES',
      ...expectedDialogueEvidenceByShot.get(shot.shot_id),
      turns: expectedDialogueByShot.get(shot.shot_id),
    })
    expect(JSON.stringify(bundle)).not.toMatch(/[\u3400-\u9fff]/)
    assertNoPreparationLeaks(bundle)

    const projection = await projectReferenceBundleForGeneration({
      db: database,
      tenantId: owner.tenant.id,
      userId: owner.user.id,
      versionId: Number(localized.version_id),
      storageRoot,
      canReadArtifact: (assetId) => {
        const asset = database.prepare('SELECT local_path FROM assets WHERE id = ? AND deleted_at IS NULL')
          .get(Number(assetId))
        return Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path)))
      },
      assetReader: { canRead: () => true, owns: () => true },
      createReferenceUrl: ({ asset_id: assetId, kind }) => `/static/redraw/${kind}/${assetId}`,
    }, Number(shot.id))
    expect(projection.targetLocale).toBe(genericRedrawProject.target.locale)
    expect(projection.prompt).toContain(`market ${genericRedrawProject.target.market}`)
    for (const face of bundle.face_tracks) {
      expect(projection.prompt).toContain(face.target_character_name)
    }
    for (const turn of bundle.dialogue.turns) expect(projection.prompt).toContain(turn.localized_text)
    expect(projection.prompt).not.toMatch(/[\u3400-\u9fff]/)
    const { prompt: projectedPrompt, ...projectionMetadata } = projection
    assertNoPreparationLeaks(projectionMetadata)
    expect(projectedPrompt).not.toContain(tempRoot)
    expect(projectedPrompt).not.toContain(storageRoot)
    expect(projectedPrompt).not.toMatch(/(?:^|\s)[A-Za-z]:[\\/]/)
    expect(projectedPrompt).not.toMatch(/https?:\/\//i)
    expect(projectedPrompt).not.toMatch(/\bBearer\s+[A-Za-z0-9._~-]+/i)
    expect(projectedPrompt).not.toMatch(/\bapi[_-]?key\s*[:=]/i)
    expect(projectedPrompt).not.toContain('sk-')
  }

  const preparationGate = await browserApi(
    page,
    `/api/v1/redraw/versions/${localized.version_id}/preparation-gate`,
  )
  expect(preparationGate.status, JSON.stringify(preparationGate.body)).toBe(200)
  expect(preparationGate.body.data).toMatchObject({
    ok: true,
    ready_shot_ids: preparedRows.map((shot) => Number(shot.id)),
    missing: [],
  })
  assertNoPreparationLeaks(preparationGate.body)
  const generationGate = await browserApi(
    page,
    `/api/v1/redraw/versions/${localized.version_id}/generation-gate`,
  )
  expect(generationGate.status, JSON.stringify(generationGate.body)).toBe(200)
  expect(generationGate.body.data).toMatchObject({ ok: true, current_step: 3, missing: [], blocking: [] })
  assertNoPreparationLeaks(generationGate.body)

  const cleanAttempts = database.prepare(`
    SELECT status, approval_status, generation_task_id, credit_reservation_id
    FROM redraw_assets
    WHERE version_id = ? AND kind = 'scene' AND clean_plate_asset_id IS NOT NULL
      AND deleted_at IS NULL ORDER BY id
  `).all(Number(localized.version_id))
  expect(cleanAttempts).toHaveLength(7)
  expect(cleanAttempts.every((attempt) => (
    ['generated', 'needs_attention'].includes(attempt.status)
      && attempt.approval_status === 'approved'
      && /^local-clean-\d+$/.test(attempt.generation_task_id)
      && typeof attempt.credit_reservation_id === 'string'
  )), JSON.stringify(cleanAttempts)).toBe(true)
  expect(new Set(cleanAttempts.map((attempt) => attempt.generation_task_id)).size).toBe(7)
  expect(new Set(cleanAttempts.map((attempt) => attempt.credit_reservation_id)).size).toBe(7)
  const reservations = database.prepare(`
    SELECT id, model, resource_type, amount, status
    FROM tenant_usage_reservations
    WHERE tenant_id = ? AND model = 'fake-clean-plate' AND resource_type = 'redraw_asset'
    ORDER BY created_at, id
  `).all(owner.tenant.id)
  expect(reservations).toHaveLength(7)
  expect(reservations.every((reservation) => (
    reservation.model === 'fake-clean-plate'
      && reservation.resource_type === 'redraw_asset'
      && reservation.amount === 5
      && reservation.status === 'confirmed'
  )), JSON.stringify(reservations)).toBe(true)
  expect(new Set(reservations.map((reservation) => reservation.id))).toEqual(
    new Set(cleanAttempts.map((attempt) => attempt.credit_reservation_id)),
  )
  expect(referencePreparationProviderCalls).toBe(7)
  expect(providerCallCounts).toEqual({ asset: 0, video: 0, dialogue: 0 })
  expect(database.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count).toBe(0)
  expect(database.prepare('SELECT COUNT(*) AS count FROM redraw_asset_batches').get().count).toBe(0)
  expect(database.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'held'").get().count).toBe(0)
  expect(database.prepare('SELECT held FROM tenant_credit_accounts WHERE tenant_id = ?').get(owner.tenant.id).held).toBe(0)

  await page.reload()
  const refreshed = await browserApi(page, `/api/v1/redraw/works/${workId}`)
  expect(refreshed.body.data).toMatchObject({
    workflow_phase: 'asset_review',
    version_id: Number(localized.version_id),
  })
  expect(await page.evaluate(() => Object.keys(window.localStorage)
    .filter((key) => /redraw|workflow/i.test(key))
    .sort())).toEqual([])
  expect(await page.evaluate(() => Object.keys(window.sessionStorage)
    .filter((key) => /redraw|workflow/i.test(key))
    .sort())).toEqual([])
  expect(providerCallCounts).toEqual({ asset: 0, video: 0, dialogue: 0 })
  expect(database.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count).toBe(0)
  expect(database.prepare('SELECT COUNT(*) AS count FROM redraw_asset_batches').get().count).toBe(0)
  expect(database.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'held'").get().count).toBe(0)
  expect(browserErrors, JSON.stringify(browserErrors)).toEqual([])
  expect(runtimeErrors, JSON.stringify(runtimeErrors)).toEqual([])
})

export async function runRedrawFullProductFlow({ page }) {
  resetProviderFixture()
  const interaction = {
    ui_driven: fullProductMode,
    asset_batches: 0,
    identity_packs: 0,
    voice_bindings: 0,
    asset_approvals: 0,
    coverage_approvals: 0,
    reference_preparations: 0,
    reference_asset_approvals: 0,
    shot_saves: 0,
    generation_batches: 0,
    candidate_qa_presented: 0,
    dialogue_starts: 0,
    release_creates: 0,
    downloads: 0,
  }
  if (process.env.REDRAW_E2E_CASE === 'latam-real-source') {
    expect(sourceVideoPath).toBe(path.resolve(process.env.REDRAW_E2E_SOURCE_VIDEO))
    expect(sourceFacts.duration_ms).toBe(redrawLatinAmericanCase.sourceFacts.duration_ms)
    expect(sourceFacts.shots).toHaveLength(redrawLatinAmericanCase.sourceFacts.shots.length)
  }
  const browserErrors = []
  const browserRequests = []
  const pendingRedrawRequests = new Set()
  let redrawRequestActivity = 0
  const tracksRedrawRequest = (request) => {
    const url = new URL(request.url())
    return ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.pathname.startsWith('/api/v1/redraw/')
  }
  page.on('pageerror', (error) => browserErrors.push(`pageerror:${error.message}`))
  page.on('request', (request) => {
    browserRequests.push(request.url())
    if (!tracksRedrawRequest(request)) return
    pendingRedrawRequests.add(request)
    redrawRequestActivity += 1
  })
  page.on('requestfinished', (request) => {
    if (!tracksRedrawRequest(request)) return
    pendingRedrawRequests.delete(request)
    redrawRequestActivity += 1
  })
  page.on('requestfailed', (request) => {
    if (tracksRedrawRequest(request)) {
      pendingRedrawRequests.delete(request)
      redrawRequestActivity += 1
    }
    browserErrors.push(`requestfailed:${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`)
  })
  const waitForRedrawRequestsToSettle = async () => {
    await expect.poll(async () => {
      const activity = redrawRequestActivity
      if (pendingRedrawRequests.size) return false
      await page.waitForTimeout(600)
      return pendingRedrawRequests.size === 0 && redrawRequestActivity === activity
    }, { timeout: 10_000 }).toBe(true)
  }
  const projectInput = fullProductMode ? genericRedrawProject.project : {
    title: '本地模拟供应商验收项目',
    execution_mode: 'auto',
    default_locale: 'en-US',
    default_market: 'US',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 1,
  }
  const projectId = await createProjectFromRedraw(page, projectInput)
  await expect(page).toHaveURL(/\/redraw\/projects\/\d+\/works\/new\?step=1/)

  await page.locator('input[type="file"][accept*="video/mp4"]').setInputFiles(sourceVideoPath)
  const uploadResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && /\/api\/v1\/redraw\/projects\/\d+\/works$/.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '上传源片', exact: true }).click()
  const uploadResponse = await uploadResponsePromise
  const uploadPayload = JSON.parse(await uploadResponse.text())
  expect(uploadResponse.status(), JSON.stringify(uploadPayload)).toBe(201)
  const workId = Number(uploadPayload.data.items[0].id)
  await expect.poll(() => uploadedHeaderHex).toBe(
    fs.readFileSync(sourceVideoPath).subarray(0, 12).toString('hex'),
  )
  await expect(page).toHaveURL(/\/redraw\/projects\/\d+\/works\/\d+\?step=1/)
  if (fullProductMode) {
    const selectors = page.locator('.source-grid .inline-fields .el-select')
    await selectors.nth(0).click()
    await page.getByRole('option', { name: genericRedrawProject.target.locale, exact: true }).click()
    await selectors.nth(1).click()
    await page.getByRole('option', { name: genericRedrawProject.target.market, exact: true }).click()
  }
  await expect(page.getByText('本次预计扣除 6 积分')).toBeVisible()
  await page.getByText('真人写实风格', { exact: true }).click()
  await page.getByRole('button', { name: '本地写实复刻' }).click()
  await expect(page.getByRole('button', { name: '开始分析' })).toBeEnabled()
  await page.getByRole('button', { name: '开始分析' }).click()
  await expect(page.getByText('服务端分析摘要')).toBeVisible()
  await expect(page.getByText('本地化报价 7 积分')).toBeVisible()
  await page.getByRole('button', { name: '确认英文 1:1 本地化' }).click()
  let localizationDebug
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await browserApi(page, `/api/v1/redraw/works/${workId}`)
    localizationDebug = {
      status: result.status,
      phase: result.body?.data?.workflow_phase,
      versionId: result.body?.data?.version_id,
      localizationTask: result.body?.data?.localization_task,
      versions: database.prepare('SELECT version, locale, status, localization_task_id FROM redraw_versions WHERE work_id = ? ORDER BY version').all(workId),
    }
    if (localizationDebug.versionId) break
    await page.waitForTimeout(250)
  }
  expect(localizationDebug, JSON.stringify(localizationDebug)).toMatchObject({
    status: 200, phase: 'asset_review', versionId: expect.any(Number),
  })
  const versionId = Number(localizationDebug.versionId)
  if (fullProductMode) {
    expect(database.prepare(`
      SELECT locale, market FROM redraw_versions WHERE id = ?
    `).get(versionId)).toEqual({ locale: 'es-ES', market: 'ES' })
  }
  const voiceRows = database.prepare(`
    SELECT id, source_ref_json FROM redraw_assets
    WHERE version_id = ? AND kind = 'voice' AND deleted_at IS NULL
    ORDER BY id DESC
  `).all(versionId)
  expect(voiceRows).toHaveLength(sourceFacts.characters.length)
  await waitForRedrawRequestsToSettle()
  await page.reload()
  await waitForRedrawRequestsToSettle()
  await expect(page.getByRole('heading', { name: '确认本地化资产后再进入批量转绘' })).toBeVisible()
  await expect(page.getByText(`${expectedAssetCount} 项资产`)).toBeVisible()

  let generatedAssets = []
  let identityCharacterAssets = []
  let voiceAssignments = []
  if (fullProductMode) {
    const batchButton = page.getByRole('button', { name: '一键批量生成全部资产', exact: true })
    await expect(batchButton).toBeEnabled()
    const batchAction = await clickForJsonResponse(
      page,
      batchButton,
      apiResponse('POST', new RegExp(`/api/v1/redraw/versions/${versionId}/assets/batches$`)),
    )
    expect(batchAction.response.status(), JSON.stringify(batchAction.payload)).toBe(202)
    interaction.asset_batches += 1
    const batchId = Number(batchAction.payload?.data?.batch_id)
    let batchRow
    await expect.poll(() => {
      batchRow = database.prepare('SELECT * FROM redraw_asset_batches WHERE id = ?').get(batchId)
      return batchRow?.status
    }, { timeout: 15_000 }).not.toMatch(/^(pending|processing)$/)
    const attemptIds = JSON.parse(batchRow.asset_ids_json || '[]').map(Number)
    const childTaskIds = attemptIds.length
      ? database.prepare(`
          SELECT generation_task_id FROM redraw_assets
          WHERE id IN (${attemptIds.map(() => '?').join(',')})
        `).all(...attemptIds).map((row) => row.generation_task_id).filter(Boolean)
      : []
    const taskIds = [batchRow.task_id, ...childTaskIds]
    const batchTasks = database.prepare(`
      SELECT id, status, error, message FROM async_tasks
      WHERE id IN (${taskIds.map(() => '?').join(',')}) ORDER BY created_at, id
    `).all(...taskIds)
    expect(batchRow, JSON.stringify({ batch: batchRow, tasks: batchTasks })).toMatchObject({ status: 'completed' })
    await expect(page.getByText(`${expectedAssetCount} 成功 / 0 失败 / ${expectedAssetCount} 总数`)).toBeVisible({ timeout: 10_000 })
    await waitForRedrawRequestsToSettle()
    await page.reload()
    await waitForRedrawRequestsToSettle()
    await expect(page.getByRole('heading', { name: '确认本地化资产后再进入批量转绘' })).toBeVisible()

    const assetsResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets`)
    expect(assetsResponse.status, JSON.stringify(assetsResponse.body)).toBe(200)
    generatedAssets = assetsResponse.body.data.filter((asset) => (
      asset.source_ref?.stable_id !== 'full-frame-reviewed-coverage'
        && (asset.asset_id || asset.voice_asset_id || asset.clean_plate_asset_id)
    ))
    expect(generatedAssets).toHaveLength(expectedAssetCount)
    identityCharacterAssets = generatedAssets.filter((asset) => asset.kind === 'character')
    expect(identityCharacterAssets).toHaveLength(sourceFacts.characters.length)

    for (const asset of identityCharacterAssets) {
      const sourceCharacterKey = String(asset.source_ref?.stable_id
        || asset.source_ref?.id
        || asset.source_ref?.source_character_key
        || '')
      const actor = genericReferencePreparationCase.characters.find(
        (candidate) => candidate.source_character_key === sourceCharacterKey,
      )
      expect(actor, `角色 ${sourceCharacterKey} 缺少身份夹具`).toBeTruthy()
      let card = page.locator(`#asset-${asset.id}-character`)
      await card.locator('input[placeholder="填写目标演员"]').fill(actor.target_actor_label)
      for (const label of ['front', 'profile', 'full_body', '真人确认', '18+确认', '一致性确认']) {
        await card.locator('.identity-form .el-checkbox__label').getByText(label, { exact: true }).click()
      }
      await card.locator('.identity-form__field').filter({ hasText: '服装参考图' }).locator('.el-select').click()
      await page.getByRole('option', {
        name: `${asset.localized_name} · ${Number(asset.asset_id)}`,
        exact: true,
      }).click()
      await card.locator('.identity-form .el-checkbox__label').getByText('服装一致性确认', { exact: true }).click()
      const identityAction = await clickForJsonResponse(
        page,
        card.getByRole('button', { name: '保存身份包', exact: true }),
        apiResponse('PUT', new RegExp(`/api/v1/redraw/assets/${asset.id}/identity-pack$`)),
      )
      expect(identityAction.response.status(), JSON.stringify(identityAction.payload)).toBe(200)
      interaction.identity_packs += 1
      card = page.locator(`#asset-${asset.id}-character`)
      await expect(card.getByText('服务端已确认', { exact: true })).toBeVisible()
      await expect(card.getByText(/资产 \d+ · 已确认/)).toBeVisible()
    }

    const voiceTab = page.locator('.asset-tabs').getByRole('button', { name: '音色', exact: true })
    const voiceListPromise = page.waitForResponse(apiResponse(
      'GET',
      new RegExp(`/api/v1/redraw/versions/${versionId}/voices$`),
    ))
    await voiceTab.click()
    expect((await voiceListPromise).status()).toBe(200)
    await expect(page.locator('#redraw-character-select')).toBeVisible()
    const bindableAssets = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets`)
    expect(bindableAssets.status, JSON.stringify(bindableAssets.body)).toBe(200)
    const characterAssets = bindableAssets.body.data.filter((asset) => asset.kind === 'character')
    const voiceAssets = bindableAssets.body.data.filter((asset) => asset.kind === 'voice')
    const coverageAssets = bindableAssets.body.data.filter((asset) => (
      asset.kind === 'scene' && asset.source_ref?.stable_id === 'full-frame-reviewed-coverage'
    ))
    expect(characterAssets).toHaveLength(sourceFacts.characters.length)
    expect(voiceAssets).toHaveLength(sourceFacts.characters.length)
    expect(coverageAssets).toHaveLength(1)
    for (const characterAsset of characterAssets) {
      const stableId = String(characterAsset.source_ref?.stable_id
        || characterAsset.source_ref?.id
        || characterAsset.source_ref?.source_character_key
        || '')
      const voiceAsset = voiceAssets.find((candidate) => (
        String(candidate.source_ref?.stable_id
          || candidate.source_ref?.id
          || candidate.source_ref?.source_character_key
          || '') === stableId
      ))
      expect(voiceAsset, `角色 ${stableId} 缺少匹配音色`).toBeTruthy()
      const characterInput = page.locator('#redraw-character-select')
      const characterListboxId = await characterInput.getAttribute('aria-controls')
      await page.locator('.voice-field').filter({ hasText: '目标角色' }).locator('.el-select').click()
      await page.locator(`[id="${characterListboxId}"]`).getByRole('option', {
        name: characterAsset.localized_name,
        exact: true,
      }).click()
      const voiceInput = page.locator('#redraw-voice-select')
      const voiceListboxId = await voiceInput.getAttribute('aria-controls')
      await page.locator('.voice-field').filter({ hasText: '已验证音色' }).locator('.el-select').click()
      await page.locator(`[id="${voiceListboxId}"]`).getByRole('option', {
        name: voiceAsset.localized_name,
        exact: true,
      }).click()
      const voiceAction = await clickForJsonResponse(
        page,
        page.getByRole('button', { name: '绑定音色', exact: true }),
        apiResponse('POST', new RegExp(`/api/v1/redraw/assets/${characterAsset.id}/voice$`)),
      )
      expect(voiceAction.response.status(), JSON.stringify(voiceAction.payload)).toBe(200)
      expect(voiceAction.payload?.data?.voice_snapshot).toMatchObject({
        provider: 'local-fake-tts', model: 'fake-tts', voice_id: 'fixture-voice', locale: fixtureLocale,
      })
      interaction.voice_bindings += 1
      voiceAssignments.push({ stableId, characterAssetId: characterAsset.id, voiceAssetId: voiceAsset.id })
      await expect(page.getByText(`已绑定 ${voiceAsset.localized_name}`, { exact: true })).toBeVisible()
    }
    expect(voiceAssignments).toHaveLength(sourceFacts.characters.length)

    await page.locator('.asset-tabs').getByRole('button', { name: '角色', exact: true }).click()
    for (const asset of identityCharacterAssets) {
      const reviewAction = await clickForJsonResponse(
        page,
        page.locator(`#asset-${asset.id}-character`).getByRole('button', { name: '批准', exact: true }),
        apiResponse('POST', new RegExp(`/api/v1/redraw/assets/${asset.id}/review$`)),
      )
      expect(reviewAction.response.status(), JSON.stringify(reviewAction.payload)).toBe(200)
      interaction.asset_approvals += 1
    }
    await page.locator('.asset-tabs').getByRole('button', { name: '音色', exact: true }).click()
    for (const asset of voiceAssets) {
      const reviewAction = await clickForJsonResponse(
        page,
        page.locator(`#asset-${asset.id}-voice`).getByRole('button', { name: '批准', exact: true }),
        apiResponse('POST', new RegExp(`/api/v1/redraw/assets/${asset.id}/review$`)),
      )
      expect(reviewAction.response.status(), JSON.stringify(reviewAction.payload)).toBe(200)
      interaction.asset_approvals += 1
    }
    await page.locator('.asset-tabs').getByRole('button', { name: '场景', exact: true }).click()
    for (const asset of coverageAssets) {
      const reviewAction = await clickForJsonResponse(
        page,
        page.locator(`#asset-${asset.id}-scene`).getByRole('button', { name: '批准', exact: true }),
        apiResponse('POST', new RegExp(`/api/v1/redraw/assets/${asset.id}/review$`)),
      )
      expect(reviewAction.response.status(), JSON.stringify(reviewAction.payload)).toBe(200)
      interaction.asset_approvals += 1
      interaction.coverage_approvals += 1
    }
    await page.locator('.redraw-step').filter({ hasText: '批量转绘' }).click()
    await expect(page.getByRole('heading', { name: '按分镜生成并从后端恢复真实进度' })).toBeVisible()
  } else {
    const quoteResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets/batch-quote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(quoteResponse.status, JSON.stringify(quoteResponse.body)).toBe(200)
    expect(quoteResponse.body.data).toMatchObject({ priced: true, total_credits: expectedAssetCredits })
    const batchResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets/batches`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote_hash: quoteResponse.body.data.quote_hash, idempotency_key: 'local-fixture-asset-batch-1' }),
    })
    expect(batchResponse.status, JSON.stringify(batchResponse.body)).toBe(202)
    let batchRow
    await expect.poll(() => {
      batchRow = database.prepare('SELECT * FROM redraw_asset_batches WHERE id = ?')
        .get(Number(batchResponse.body.data.batch_id))
      return batchRow?.status
    }).toBe('completed')
    const assetsResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets`)
    generatedAssets = assetsResponse.body.data.filter((asset) => (
      asset.source_ref?.stable_id !== 'full-frame-reviewed-coverage'
        && (asset.asset_id || asset.voice_asset_id || asset.clean_plate_asset_id)
    ))
    identityCharacterAssets = generatedAssets.filter((asset) => asset.kind === 'character')
    const castById = new Map(activeCase ? activeCase.cast.map((actor) => [String(actor.id), actor]) : [])
    for (const asset of identityCharacterAssets) {
      const sourceCharacterKey = String(asset.source_ref?.stable_id || asset.source_ref?.id || asset.source_ref?.source_character_key || '')
      const actor = castById.get(sourceCharacterKey) || { target_name: asset.localized_name }
      const result = await browserApi(page, `/api/v1/redraw/assets/${asset.id}/identity-pack`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...buildLocalIdentityPackInput(actor), wardrobe_reference_asset_id: Number(asset.asset_id), wardrobe_consistency_confirmed: true, expected_updated_at: asset.updated_at }),
      })
      expect(result.status, JSON.stringify(result.body)).toBe(200)
    }
    const bindableAssets = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets`)
    const characterAssets = bindableAssets.body.data.filter((asset) => asset.kind === 'character')
    const voiceAssets = bindableAssets.body.data.filter((asset) => asset.kind === 'voice')
    for (const characterAsset of characterAssets) {
      const stableId = String(characterAsset.source_ref?.stable_id || characterAsset.source_ref?.id || characterAsset.source_ref?.source_character_key || '')
      const voiceAsset = voiceAssets.find((candidate) => String(candidate.source_ref?.stable_id || candidate.source_ref?.id || candidate.source_ref?.source_character_key || '') === stableId)
      const result = await browserApi(page, `/api/v1/redraw/assets/${characterAsset.id}/voice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_asset_id: voiceAsset.id, expected_updated_at: characterAsset.updated_at }),
      })
      expect(result.status, JSON.stringify(result.body)).toBe(200)
      voiceAssignments.push({ stableId, characterAssetId: characterAsset.id, voiceAssetId: voiceAsset.id })
    }
    const reviewAssets = (await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets`)).body.data
      .filter((asset) => asset.asset_id || asset.voice_asset_id || asset.clean_plate_asset_id)
    for (const asset of reviewAssets) {
      const result = await browserApi(page, `/api/v1/redraw/assets/${asset.id}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approved', expected_updated_at: asset.updated_at }),
      })
      expect(result.status, JSON.stringify(result.body)).toBe(200)
    }
  }

  let dialogueTaskId = null
  let dialogueSegments = []
  if (!fullProductMode) {
  const dialogueQuote = await browserApi(page, `/api/v1/redraw/versions/${versionId}/dialogue/quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  expect(dialogueQuote.status, JSON.stringify(dialogueQuote.body)).toBe(200)
  expect(dialogueQuote.body.data).toMatchObject({
    status: 'ready',
    segment_count: expectedDialogueSegmentCount,
    total_credits: expectedDialogueCredits,
  })
  const dialogueStart = await browserApi(page, `/api/v1/redraw/versions/${versionId}/dialogue/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quote_hash: dialogueQuote.body.data.quote_hash,
      idempotency_key: 'local-fixture-dialogue-1',
    }),
  })
  expect(dialogueStart.status, JSON.stringify(dialogueStart.body)).toBe(202)
  dialogueTaskId = dialogueStart.body.data.task_id
  let dialogueTask
  await expect.poll(async () => {
    const result = await browserApi(
      page,
      `/api/v1/redraw/versions/${versionId}/dialogue/tasks/${dialogueTaskId}`,
    )
    dialogueTask = result.body?.data
    return dialogueTask?.status
  }, { timeout: 15_000, message: JSON.stringify(dialogueTask) }).toBe('completed')
  const dialogueAudits = database.prepare(`
    SELECT shot_index, draft_json FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
  `).all(versionId).map((row) => ({
    shot_index: row.shot_index,
    audit: JSON.parse(row.draft_json || '{}').dialogue_generation || null,
  }))
  dialogueSegments = dialogueAudits.flatMap(({ audit }) => audit?.segments || [])
  expect(dialogueSegments).toHaveLength(expectedDialogueSegmentCount)
  expect(dialogueAudits.filter(({ audit }) => audit).every(({ audit }) => audit.status === 'completed')).toBe(true)
  expect(dialogueSegments.every((segment) => (
    segment.status === 'completed'
      && segment.reservation_status === 'confirmed'
      && segment.provider === 'local-fake-tts'
      && segment.model === 'fake-tts'
  ))).toBe(true)
  for (const segment of dialogueSegments) {
    const dialogueArtifact = database.prepare('SELECT * FROM assets WHERE id = ?')
      .get(Number(segment.audio_asset_id))
    expect(dialogueArtifact, `缺少对白音频资产 ${segment.segment_id}`).toBeTruthy()
    expect(fs.existsSync(path.join(storageRoot, dialogueArtifact.local_path))).toBe(true)
  }
  }

  const readyWork = await browserApi(page, `/api/v1/redraw/works/${workId}`)
  const preparedShots = []
  for (const shot of readyWork.body.data.shots) {
    const sourceShotId = sourceFacts.shots[Number(shot.shot_index) - 1]?.id
    const sourceShot = sourceFacts.shots[Number(shot.shot_index) - 1]
    const prompt = fullProductMode
      ? `LOCAL_FIXTURE_SHOT_${Number(shot.shot_index)} · ${Number(shot.shot_index) === 1
          ? 'Clara Vega says exactly: Fue aquí.'
          : Number(shot.shot_index) === 2
            ? 'Diego Santos says exactly: No sigas.'
            : 'No dialogue or intelligible voice; preserve rain ambience only.'}`
      : activeCase
        ? activeCase.shotPrompts[sourceShotId]
        : (Number(shot.shot_index) === 1
            ? 'Cinematic rooftop at night. Aran checks an old phone as a strange message appears.'
            : 'Cinematic rooftop at night. Aran looks around, turns, and leaves.')
    const references = Array.isArray(sourceShot?.dialogue) && sourceShot.dialogue.length > 0
      ? shot.references.filter((reference) => reference.kind === 'character').slice(0, 1)
      : shot.references
    if (fullProductMode) {
      await page.locator('.batch-panel .shot-row').filter({ hasText: `镜头 ${shot.shot_index}` }).click()
      const promptField = page.locator('.shot-editor .el-form-item')
        .filter({ has: page.getByText('提示词', { exact: true }) })
        .locator('textarea')
      await promptField.fill(prompt)
      const saveAction = await clickForJsonResponse(
        page,
        page.getByRole('button', { name: '保存镜头', exact: true }),
        apiResponse('PUT', new RegExp(`/api/v1/redraw/shots/${shot.id}$`)),
      )
      expect(saveAction.response.status(), JSON.stringify(saveAction.payload)).toBe(200)
      expect(saveAction.payload?.data?.compiled_prompt?.text).toBe(prompt)
      expect(
        saveAction.payload?.data?.localized_dialogue,
        JSON.stringify({ shot_id: shot.shot_id, before: shot.localized_dialogue, after: saveAction.payload?.data?.localized_dialogue }),
      ).toEqual(shot.localized_dialogue)
      interaction.shot_saves += 1
      preparedShots.push(saveAction.payload.data)
      continue
    }
    const updateResponse = await browserApi(page, `/api/v1/redraw/shots/${shot.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_updated_at: shot.updated_at,
        prompt,
        model: 'bytedance/seedance-2-0-mini',
        duration: generationDurations[Number(shot.shot_index) - 1],
        resolution: '720p',
        count: 1,
        references,
      }),
    })
    expect(updateResponse.status, JSON.stringify(updateResponse.body)).toBe(200)
    expect(updateResponse.body.data.compiled_prompt.text).toBe(prompt)
    preparedShots.push(updateResponse.body.data)
  }
  if (fullProductMode) {
    await prepareGenericReferencesThroughUi(page, versionId, interaction, waitForRedrawRequestsToSettle)
    await page.locator('.redraw-step').filter({ hasText: '批量转绘' }).click()
    await waitForRedrawRequestsToSettle()
    await page.reload()
    await waitForRedrawRequestsToSettle()
    await expect(page.getByRole('heading', { name: '按分镜生成并从后端恢复真实进度' })).toBeVisible()
  } else {
    const reviewedCoverage = await installGenericReviewedCoverage(versionId, {
      characterKeysByShot: sourceFacts.shots.map((shot) => shot.visible_character_ids || []),
    })
    expect(reviewedCoverage.reviewed.shots).toHaveLength(expectedShotCount)
    const coverageReview = await browserApi(page, `/api/v1/redraw/assets/${reviewedCoverage.coverageAsset.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'approved',
        expected_updated_at: reviewedCoverage.coverageAsset.updated_at,
      }),
    })
    expect(coverageReview.status, JSON.stringify(coverageReview.body)).toBe(200)
    await prepareGenericReferences(page, versionId, 'local-fixture-reference')
  }
  const preparedReferenceRows = database.prepare(`
    SELECT preparation_state, reference_bundle_hash
    FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
  `).all(versionId)
  expect(preparedReferenceRows).toHaveLength(expectedShotCount)
  expect(preparedReferenceRows.every((shot) => (
    shot.preparation_state === 'reference_ready'
      && /^[a-f0-9]{64}$/.test(String(shot.reference_bundle_hash || ''))
  ))).toBe(true)
  const gateResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/generation-gate`)
  expect(gateResponse.status, JSON.stringify(gateResponse.body)).toBe(200)
  expect(gateResponse.body.data.ok, JSON.stringify(gateResponse.body)).toBe(true)

  const shotIds = preparedShots.map((shot) => Number(shot.id))
  expect(shotIds).toHaveLength(expectedShotCount)
  let videoBatchResponse
  if (fullProductMode) {
    const batchAction = await clickForJsonResponse(
      page,
      page.getByRole('button', { name: `批量生成 ${expectedShotCount} 镜`, exact: true }),
      apiResponse('POST', new RegExp(`/api/v1/redraw/works/${workId}/generate-batch$`)),
    )
    expect(batchAction.response.status(), JSON.stringify(batchAction.payload)).toBe(202)
    expect(batchAction.payload?.data?.results).toHaveLength(expectedShotCount)
    interaction.generation_batches += 1
    videoBatchResponse = { status: batchAction.response.status(), body: batchAction.payload }
  } else {
    videoBatchResponse = await browserApi(page, `/api/v1/redraw/works/${workId}/generate-batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_id: versionId, shot_ids: shotIds }),
    })
    expect(videoBatchResponse.status, JSON.stringify(videoBatchResponse.body)).toBe(202)
    expect(videoBatchResponse.body.data.results).toHaveLength(expectedShotCount)
  }
  let videoShotRows = []
  for (let attempt = 0; attempt < 120; attempt += 1) {
    videoShotRows = database.prepare(`
      SELECT id, shot_index, status, video_generation_id, error_code, error_message
      FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
    `).all(versionId)
    if (videoShotRows.filter((shot) => shot.status === 'approved').length === expectedShotCount) break
    if (videoShotRows.some((shot) => shot.status === 'approved')
      && videoShotRows.every((shot) => !['pending', 'processing'].includes(shot.status))) break
    await page.waitForTimeout(250)
  }
  expect(
    videoShotRows.filter((shot) => shot.status === 'approved'),
    JSON.stringify({
      shots: videoShotRows,
      videos: database.prepare('SELECT id, status, error_msg, local_path FROM video_generations ORDER BY id').all(),
      tasks: database.prepare("SELECT id, status, error FROM async_tasks WHERE type = 'redraw_shot' ORDER BY created_at").all(),
      reviews: database.prepare(`
        SELECT shot_id, decision, reason_codes_json, metrics_json
        FROM redraw_candidate_reviews ORDER BY shot_id
      `).all(),
      batchResponse: videoBatchResponse.body,
      providerAudit,
      runtimeErrors,
    }),
  ).toHaveLength(expectedShotCount)
  const composedWork = await browserApi(page, `/api/v1/redraw/works/${workId}`)
  expect(composedWork.body.data).toMatchObject({ current_step: 4, workflow_phase: 'video_generation' })
  expect(composedWork.body.data.shots.every((shot) => shot.new_video_ref?.asset_id)).toBe(true)

  const candidateReviews = database.prepare(`
    SELECT r.*, s.shot_index
    FROM redraw_candidate_reviews r
    JOIN redraw_shots s ON s.id = r.shot_id
    WHERE r.version_id = ?
    ORDER BY s.shot_index, r.review_version
  `).all(versionId)
  expect(candidateReviews).toHaveLength(expectedShotCount)
  expect(candidateReviews.every((review) => (
    review.decision === 'approved' && review.decision_source === 'automatic'
  ))).toBe(true)
  if (fullProductMode) {
    await expect(page.locator('.redraw-step.active')).toContainText('导出交付', { timeout: 15_000 })
    await page.locator('.redraw-step').filter({ hasText: '批量转绘' }).click()
    await expect(page.getByRole('heading', { name: '质量审核' })).toBeVisible()
    await waitForRedrawRequestsToSettle()
    await page.reload()
    await waitForRedrawRequestsToSettle()
    await expect(page.getByRole('heading', { name: '质量审核' })).toBeVisible()
    await expect(page.getByText('B 自动批准证据：质量门禁全部通过', { exact: true })).toHaveCount(expectedShotCount)
    interaction.candidate_qa_presented = expectedShotCount
  }
  const candidateModes = candidateReviews.map((review) => JSON.parse(review.metrics_json).dialogue)
  if (fullProductMode) {
    expect(candidateModes.map((dialogue) => dialogue.dialogue_mode)).toEqual(['dialogue', 'dialogue', 'silent'])
    expect(candidateModes.every((dialogue) => dialogue.has_audio && dialogue.ambient_audio_safe)).toBe(true)
    const generatedMedia = database.prepare(`
      SELECT provider_task_id, local_path FROM video_generations
      WHERE tenant_id = ? AND user_id = ? ORDER BY id
    `).all(owner.tenant.id, owner.user.id)
    expect(generatedMedia).toHaveLength(3)
    for (const media of generatedMedia) {
      expect(media.provider_task_id).toMatch(/^local-fixture-video-task-[123]$/)
      expect(media.local_path).not.toContain('redraw-local-provider')
      const mediaProbe = probeFixtureMedia(path.join(storageRoot, media.local_path))
      expect(mediaProbe.audio).toBeTruthy()
      expect(mediaProbe.duration).toBeGreaterThanOrEqual(3.9)
      expect(mediaProbe.duration).toBeLessThanOrEqual(4.1)
    }
  }

  if (fullProductMode) {
    await page.locator('.redraw-step').filter({ hasText: '导出交付' }).click()
    await expect(page.getByRole('heading', { name: `${fixtureLocale} 配音、合成预览与下载` })).toBeVisible()
    const dialogueButton = page.getByRole('button', { name: `生成${fixtureLocale} 配音`, exact: true })
    const dialogueQuoteProbe = await browserApi(page, `/api/v1/redraw/versions/${versionId}/dialogue/quote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    await expect(dialogueButton, JSON.stringify(dialogueQuoteProbe)).toBeEnabled()
    const dialogueAction = await clickForJsonResponse(
      page,
      dialogueButton,
      apiResponse('POST', new RegExp(`/api/v1/redraw/versions/${versionId}/dialogue/start$`)),
    )
    expect(dialogueAction.response.status(), JSON.stringify(dialogueAction.payload)).toBe(202)
    interaction.dialogue_starts += 1
    dialogueTaskId = String(dialogueAction.payload?.data?.task_id || '')
    expect(dialogueTaskId).not.toBe('')
    await expect(page.getByText(new RegExp(`任务 ${dialogueTaskId} · 完成`))).toBeVisible({ timeout: 15_000 })
    const dialogueAudits = database.prepare(`
      SELECT shot_index, draft_json FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
    `).all(versionId).map((row) => ({
      shot_index: row.shot_index,
      audit: JSON.parse(row.draft_json || '{}').dialogue_generation || null,
    }))
    dialogueSegments = dialogueAudits.flatMap(({ audit }) => audit?.segments || [])
    expect(dialogueSegments).toHaveLength(expectedDialogueSegmentCount)
    expect(dialogueAudits.filter(({ audit }) => audit).every(({ audit }) => audit.status === 'completed')).toBe(true)
    expect(dialogueSegments.every((segment) => (
      segment.status === 'completed'
        && segment.reservation_status === 'confirmed'
        && segment.provider === 'local-fake-tts'
        && segment.model === 'fake-tts'
    ))).toBe(true)
    assertDialogueSpeechEvidence(dialogueSegments, versionId)
    await expect(page.getByText('可发布', { exact: true })).toBeVisible({ timeout: 15_000 })
  }

  let composeStart
  if (fullProductMode) {
    const readiness = await browserApi(page, `/api/v1/redraw/versions/${versionId}/release-readiness`)
    expect(readiness.status, JSON.stringify(readiness.body)).toBe(200)
    expect(readiness.body.data, JSON.stringify(readiness.body)).toMatchObject({
      ready: true,
      shot_count: 3,
      readiness_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      quality_summary: {
        decision: 'approved', approved_shot_count: 3, automatic_review_count: 3, human_review_count: 0,
      },
    })
    const releaseAction = await clickForJsonResponse(
      page,
      page.getByRole('button', { name: '创建整集 release', exact: true }),
      apiResponse('POST', new RegExp(`/api/v1/redraw/versions/${versionId}/releases$`)),
    )
    interaction.release_creates += 1
    composeStart = { status: releaseAction.response.status(), body: releaseAction.payload }
  } else {
    composeStart = await browserApi(page, `/api/v1/redraw/versions/${versionId}/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'local-fixture-compose-1', audio_mode: 'replace' }),
    })
  }
  expect(composeStart.status, JSON.stringify(composeStart.body)).toBe(202)
  const exportId = Number(composeStart.body.data.export_id)
  let exportDetail
  await expect.poll(async () => {
    const result = await browserApi(page, `/api/v1/redraw/exports/${exportId}`)
    exportDetail = result.body?.data
    return exportDetail?.status
  }, { timeout: 30_000, message: JSON.stringify(exportDetail) }).toBe('completed')
  expect(exportDetail.output_asset_ids).toMatchObject({
    mp4: expect.any(Number), srt: expect.any(Number), vtt: expect.any(Number),
  })
  expect(exportDetail.hashes.mp4).toMatch(/^[0-9a-f]{64}$/)

  let downloaded
  const releaseDownloads = []
  if (fullProductMode) {
    const labels = { mp4: 'MP4 下载', srt: 'SRT 下载', vtt: 'VTT 下载', report: '报告下载' }
    const artifacts = {}
    for (const kind of ['mp4', 'srt', 'vtt', 'report']) {
      const button = page.getByRole('button', { name: labels[kind], exact: true })
      await expect(button).toBeEnabled({ timeout: 15_000 })
      const artifactPath = kind === 'report'
        ? `/api/v1/redraw/exports/${exportId}`
        : `/api/v1/redraw/exports/${exportId}/download/${kind}`
      const responsePromise = page.waitForResponse(apiResponse(
        'GET',
        new RegExp(`${artifactPath}$`),
      ))
      const downloadPromise = page.waitForEvent('download')
      await button.click()
      const [response, browserDownload] = await Promise.all([responsePromise, downloadPromise])
      expect(response.status()).toBe(200)
      const browserPath = await browserDownload.path()
      expect(browserPath).toBeTruthy()
      const bytes = fs.readFileSync(browserPath)
      artifacts[kind] = {
        kind,
        status: response.status(),
        size: bytes.length,
        bytes,
        text: ['srt', 'vtt', 'report'].includes(kind) ? bytes.toString('utf8') : '',
        digest: sha256Value(bytes),
        responseHash: response.headers()['x-content-sha256'] || null,
        contentType: response.headers()['content-type'] || '',
      }
      interaction.downloads += 1
      releaseDownloads.push(kind)
    }
    downloaded = {
      ...artifacts.mp4,
      magic: artifacts.mp4.bytes.subarray(4, 8).toString('ascii'),
    }
    for (const kind of ['srt', 'vtt']) {
      expect(artifacts[kind]).toMatchObject({
        kind,
        status: 200,
        digest: exportDetail.hashes[kind],
        responseHash: exportDetail.hashes[kind],
      })
      expect(artifacts[kind].size).toBeGreaterThan(20)
      expect(artifacts[kind].text).toContain('Fue aquí.')
      expect(artifacts[kind].text).toContain('No sigas.')
    }
    expect(() => JSON.parse(artifacts.report.text)).not.toThrow()
  } else {
    downloaded = await page.evaluate(async (url) => {
      const response = await fetch(url)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      return {
        status: response.status,
        size: bytes.byteLength,
        magic: String.fromCharCode(...bytes.slice(4, 8)),
        digest: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        responseHash: response.headers.get('x-content-sha256'),
        contentType: response.headers.get('content-type'),
      }
    }, `/api/v1/redraw/exports/${exportId}/download/mp4`)
    releaseDownloads.push('mp4')
  }
  expect(downloaded).toMatchObject({
    status: 200,
    magic: 'ftyp',
    digest: exportDetail.hashes.mp4,
    responseHash: exportDetail.hashes.mp4,
    contentType: 'video/mp4',
  })
  expect(downloaded.size).toBeGreaterThan(1_000)
  if (fullProductMode) {
    expect(exportDetail).toMatchObject({
      status: 'completed',
      release_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      quality_summary: {
        decision: 'approved', approved_shot_count: 3, automatic_review_count: 3, human_review_count: 0,
      },
      episode_release: { schema_version: 'redraw-episode-release-v1', shots: expect.any(Array) },
    })
    expect(exportDetail.episode_release.shots).toHaveLength(3)
    expect(JSON.stringify(exportDetail)).not.toContain(tempRoot)
  }

  const exportRow = database.prepare('SELECT manifest_json FROM redraw_exports WHERE id = ?').get(exportId)
  const manifest = JSON.parse(exportRow.manifest_json)
  const finalPath = path.join(storageRoot, manifest.outputs.mp4_path)
  const probeResult = spawnSync(getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', finalPath,
  ], { encoding: 'utf8', timeout: 30_000 })
  expect(probeResult.status, probeResult.stderr || probeResult.error?.message).toBe(0)
  const probe = JSON.parse(probeResult.stdout)
  const videoStream = probe.streams.find((stream) => stream.codec_type === 'video')
  const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio')
  expect(videoStream).toMatchObject({ width: 1280, height: 720 })
  expect(audioStream).toBeTruthy()
  expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(expectedOutputDuration - 0.1)
  expect(Number(probe.format.duration)).toBeLessThanOrEqual(expectedOutputDuration + 0.1)
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourceVideoPath)).digest('hex')
  expect(downloaded.digest).not.toBe(sourceHash)

  const heldReservations = database.prepare(`
    SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE tenant_id = ? AND status = 'held'
  `).get(owner.tenant.id).count
  const activeTasks = database.prepare(`
    SELECT COUNT(*) AS count FROM async_tasks WHERE tenant_id = ? AND status IN ('pending', 'processing')
  `).get(owner.tenant.id).count
  expect(heldReservations).toBe(0)
  expect(activeTasks).toBe(0)
  let recoveryEvidence = null
  if (fullProductMode) {
    const submitted = providerAudit.filter((entry) => entry.stage === 'submit')
    const polled = providerAudit.filter((entry) => entry.stage === 'poll')
    const providerDownloads = providerAudit.filter((entry) => entry.stage === 'download')
    expect(submitted).toHaveLength(3)
    expect(polled).toHaveLength(3)
    expect(providerDownloads).toHaveLength(3)
    expect(submitted.every((entry) => (
      entry.adapter === 'icreat_task' && entry.duration === 5 && entry.has_content === true
    ))).toBe(true)
    expect(submitted.map((entry) => entry.prompt)).toEqual(expect.arrayContaining([
      expect.stringContaining('Clara Vega: Fue aquí.'),
      expect.stringContaining('Diego Santos: No sigas.'),
      expect.stringContaining('Dialogue mode: silent.'),
    ]))
    const confirmedShotReservations = database.prepare(`
      SELECT COUNT(*) AS count FROM tenant_usage_reservations
      WHERE tenant_id = ? AND resource_type = 'redraw_shot' AND status = 'confirmed'
    `).get(owner.tenant.id).count
    expect(confirmedShotReservations).toBe(3)

    const publicRequests = browserRequests.filter((raw) => {
      if (!/^https?:/i.test(raw)) return false
      const hostname = new URL(raw).hostname
      return !['127.0.0.1', 'localhost'].includes(hostname)
    })
    expect(publicRequests).toEqual([])

    const recoveryUrl = new URL(page.url())
    recoveryUrl.searchParams.set('step', '4')
    await page.evaluate((url) => window.history.replaceState(null, '', url), recoveryUrl.toString())
    await waitForRedrawRequestsToSettle()
    await page.reload()
    await waitForRedrawRequestsToSettle()
    await expect(page.getByRole('heading', { name: '整集 readiness' })).toBeVisible()
    await expect(page.getByText(new RegExp(`任务 ${dialogueTaskId} · 完成`))).toBeVisible()
    const recoveredWork = await browserApi(page, `/api/v1/redraw/works/${workId}`)
    const recoveredExports = await browserApi(page, `/api/v1/redraw/versions/${versionId}/exports`)
    expect(recoveredWork.status, JSON.stringify(recoveredWork.body)).toBe(200)
    expect(recoveredWork.body.data.shots).toHaveLength(3)
    expect(recoveredWork.body.data.shots.every((shot) => shot.status === 'included')).toBe(true)
    expect(recoveredExports.status, JSON.stringify(recoveredExports.body)).toBe(200)
    expect(recoveredExports.body.data.filter((item) => item.status === 'completed')).toHaveLength(1)
    recoveryEvidence = {
      refreshed_from_backend: true,
      approved_shots: recoveredWork.body.data.shots.filter((shot) => (
        ['approved', 'included'].includes(shot.status)
      )).length,
      completed_exports: recoveredExports.body.data.filter((item) => item.status === 'completed').length,
    }
  }
  expect(runtimeErrors, JSON.stringify(runtimeErrors)).toEqual([])
  expect(browserErrors, JSON.stringify(browserErrors)).toEqual([])

  if (activeCase) {
    const outputDir = path.resolve(process.env.REDRAW_E2E_CASE_OUTPUT_DIR)
    fs.mkdirSync(outputDir, { recursive: true })
    const persistedOutputs = {
      mp4: path.join(outputDir, 'ac087bcd-latam-local-fixture.mp4'),
      srt: path.join(outputDir, 'ac087bcd-latam-local-fixture.srt'),
      vtt: path.join(outputDir, 'ac087bcd-latam-local-fixture.vtt'),
    }
    for (const [kind, target] of Object.entries(persistedOutputs)) {
      fs.copyFileSync(path.join(storageRoot, manifest.outputs[`${kind}_path`]), target)
    }
    expect(
      crypto.createHash('sha256').update(fs.readFileSync(persistedOutputs.mp4)).digest('hex'),
    ).toBe(downloaded.digest)
    const caseManifest = {
      ...buildLocalCaseManifest({
        source_upload_verified: true,
        workflow_contract_verified: true,
      }),
      evidence: {
        source_path: sourceVideoPath,
        source_sha256: sourceHash,
        source_uploaded_header_hex: uploadedHeaderHex,
        work_id: workId,
        version_id: versionId,
        shots: videoShotRows.map((shot) => ({
          shot_index: Number(shot.shot_index),
          status: shot.status,
          video_generation_id: Number(shot.video_generation_id),
        })),
        output: {
          path: persistedOutputs.mp4,
          srt_path: persistedOutputs.srt,
          vtt_path: persistedOutputs.vtt,
          sha256: downloaded.digest,
          srt_sha256: exportDetail.hashes.srt,
          vtt_sha256: exportDetail.hashes.vtt,
          size: downloaded.size,
          duration_seconds: Number(probe.format.duration),
          width: Number(videoStream.width),
          height: Number(videoStream.height),
          has_audio: Boolean(audioStream),
        },
        held_reservations: heldReservations,
        active_tasks: activeTasks,
      },
      limitations: [
        'Video, image, analysis and TTS providers are local fixtures.',
        'The generated MP4 does not prove visual actor replacement.',
        'English lip sync and final aesthetic quality are not verified.',
      ],
    }
    fs.writeFileSync(
      path.join(outputDir, 'run-manifest.json'),
      `${JSON.stringify(caseManifest, null, 2)}\n`,
    )
  }

  if (fullProductMode) {
    return {
      project: {
        locale: fixtureLocale,
        market: fixtureMarket,
        execution_mode: projectInput.execution_mode,
        budget_limit_credits: projectInput.budget_limit_credits,
        id: projectId,
      },
      source: { duration_ms: sourceFacts.duration_ms, sha256: sourceHash },
      characters: {
        identities: identityCharacterAssets.length,
        voices: voiceAssignments.length,
        wardrobes: identityCharacterAssets.length,
      },
      shots: { total: 3, dialogue: 2, silent_with_ambience: 1 },
      audio_evidence: {
        spoken_transcripts: [...candidateAudioEvidence.values()]
          .filter((item) => item.speech_required === true)
          .sort((left, right) => left.shot_index - right.shot_index)
          .map((item) => item.transcript),
        offline_synthesis: [...candidateAudioEvidence.values()]
          .filter((item) => item.speech_required === true)
          .every((item) => item.synthesis?.engine === 'eSpeak NG'
            && item.synthesis?.culture === 'es-ES'
            && item.synthesis?.voice_code === 'es'),
        silent_ambience: [...candidateAudioEvidence.values()]
          .filter((item) => item.speech_required === false && item.ambience_kind === 'rain-like-pink-noise').length,
      },
      provider: {
        adapter: 'icreat_task',
        submitted: providerAudit.filter((entry) => entry.stage === 'submit').length,
        polled: providerAudit.filter((entry) => entry.stage === 'poll').length,
        downloaded: providerAudit.filter((entry) => entry.stage === 'download').length,
      },
      candidate_qa: {
        approved: candidateReviews.filter((review) => review.decision === 'approved').length,
        automatic: candidateReviews.filter((review) => review.decision_source === 'automatic').length,
        held_reservations: heldReservations,
      },
      release: {
        status: exportDetail.status,
        duration_seconds: Math.round(Number(probe.format.duration)),
        has_audio: Boolean(audioStream),
        downloads: releaseDownloads,
        release_hash: exportDetail.release_hash,
      },
      recovery: recoveryEvidence,
      interaction,
      network: { public_requests: 0, real_provider_requests: 0 },
    }
  }
}

if (!fullProductMode) {
  test('真实前后端与本地模拟供应商完成转绘同链', runRedrawFullProductFlow)
}
