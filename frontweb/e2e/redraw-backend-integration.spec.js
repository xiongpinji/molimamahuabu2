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
  genericRedrawProject,
  genericSourceFacts,
} from './fixtures/redraw-generic-project.js'

const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../backend-node/', import.meta.url))
const express = require(path.join(backendRoot, 'node_modules', 'express'))
const Database = require(path.join(backendRoot, 'node_modules', 'better-sqlite3'))
const { runMigrationsAndEnsure } = require(path.join(backendRoot, 'src', 'db', 'migrate'))
const { setupRouter } = require(path.join(backendRoot, 'src', 'routes'))
const redrawUploadService = require(path.join(backendRoot, 'src', 'services', 'redrawUploadService'))
const creditLedger = require(path.join(backendRoot, 'src', 'services', 'creditLedgerService'))
const modelPrices = require(path.join(backendRoot, 'src', 'services', 'modelPriceService'))
const { buildLocalizationInput } = require(path.join(backendRoot, 'src', 'services', 'localizationService'))
const { serverAutomationPolicySnapshot } = require(path.join(backendRoot, 'src', 'services', 'redrawProjectPolicyService'))
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
const runtimeErrors = []

const log = {
  info() {},
  warn(...args) { runtimeErrors.push(['warn', ...args.map(String)]) },
  error(...args) { runtimeErrors.push(['error', ...args.map(String)]) },
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

const activeCase = process.env.REDRAW_E2E_CASE === 'latam-real-source'
  ? redrawLatinAmericanCase
  : null
const sourceFacts = activeCase?.sourceFacts || defaultSourceFacts
const generationDurations = activeCase?.generationDurations || [8, 8]
const artifactDurations = activeCase
  ? sourceFacts.shots.map((shot) => (Number(shot.end_ms) - Number(shot.start_ms)) / 1000)
  : generationDurations
const expectedShotCount = sourceFacts.shots.length
const expectedOutputDuration = artifactDurations.reduce((sum, duration) => sum + duration, 0)
const expectedAssetCount = sourceFacts.schema_version === '2.0'
  ? sourceFacts.characters.length * 2
  : sourceFacts.characters.length * 2 + sourceFacts.scenes.length + sourceFacts.props.length
const expectedAssetCredits = expectedAssetCount * 5
const localizationOverrides = activeCase?.localization || {
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

test.setTimeout(120_000)
test.describe.configure({ mode: 'serial' })

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

function runFfmpeg(args, label) {
  const result = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) {
    throw new Error(`${label}失败：${result.stderr || result.error?.message || result.status}`)
  }
}

function insertProviderArtifact({ name, type, relativePath, mimeType, duration = null, width = null, height = null }) {
  const absolutePath = path.join(storageRoot, relativePath)
  const now = new Date().toISOString()
  const publicPath = relativePath.replace(/\\/g, '/')
  return Number(database.prepare(`
    INSERT INTO assets
      (name, type, category, url, local_path, file_size, mime_type, duration, width, height, created_at, updated_at)
    VALUES (?, ?, 'redraw', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    now,
    now,
  ).lastInsertRowid)
}

test.beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-redraw-browser-backend-'))
  storageRoot = path.join(tempRoot, 'storage')
  fs.mkdirSync(storageRoot, { recursive: true })
  if (activeCase) {
    sourceVideoPath = path.resolve(process.env.REDRAW_E2E_SOURCE_VIDEO)
  } else {
    sourceVideoPath = path.join(tempRoot, 'source-16s.mp4')
    runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=navy:size=320x180:rate=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
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
  const voicePath = path.join(artifactRoot, 'voice.mp3')
  runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=660:sample_rate=44100', '-t', '1.2', '-c:a', 'libmp3lame', '-y', voicePath,
  ], '本地音色样音生成')
  providerArtifacts.voice = { absolutePath: voicePath, relativePath: 'redraw-local-provider/voice.mp3' }
  const shotColors = ['blue', 'purple', 'teal', 'orange', 'brown', 'pink', 'gray', 'cyan', 'magenta']
  for (const [offset, duration] of generationDurations.entries()) {
    const index = String(offset + 1)
    const color = shotColors[offset % shotColors.length]
    const artifactDuration = artifactDurations[offset]
    const target = path.join(artifactRoot, `shot-${index}.mp4`)
    const inputs = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:size=320x180:rate=12`,
    ]
    if (index === '1') inputs.push('-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=44100')
    inputs.push(
      '-t', String(artifactDuration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      ...(index === '1' ? ['-c:a', 'aac', '-shortest'] : ['-an']),
      '-y', target,
    )
    runFfmpeg(inputs, `本地第 ${index} 镜视频生成`)
    providerArtifacts[`shot-${index}`] = { absolutePath: target, relativePath: `redraw-local-provider/shot-${index}.mp4` }
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
      (service_type, provider, api_protocol, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video', 'local-fake-video', 'feituo_open', '本地视频模拟器', ?, 'fake-video',
      1, 1, 7, '{}', ?, ?)
  `).run(JSON.stringify(['fake-video']), now, now).lastInsertRowid)
  database.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify({
    redraw_locale_capabilities: ['en-US|US', 'es-ES|ES'].map((target) => {
      const [locale, market] = target.split('|')
      return {
        locale, market, status: 'verified',
        evidence: {
          video: {
            provider: 'local-fake-video', model: 'fake-video',
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
  modelPrices.set(database, 'fake-video', 2, {
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
  app.use('/static', express.static(storageRoot))
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
          source: 'offline-worker', locale: 'en-US', market: 'US',
          locale_pack: 'en-US@fixture',
          audio_sha256: crypto.createHash('sha256').update(fs.readFileSync(providerArtifact.absolutePath)).digest('hex'),
          transcript_sha256: 'd'.repeat(64),
          model_manifest_sha256: 'a'.repeat(64),
          calibration_manifest_sha256: 'b'.repeat(64),
          asr_model_revision: 'local-asr-en-1', accent_model_revision: 'local-accent-en-1',
          metrics: { word_error_rate: 0, accent_confidence: 0.99 },
          completed_at: new Date().toISOString(),
          provider: 'local-fake-tts', model: 'fake-tts',
          ai_service_config_id: ttsConfigId, config_updated_at: ttsConfigUpdatedAt,
          voice_id: 'fixture-voice', task_id: providerTaskId, terminal_status: 'completed',
          audio_asset_id: artifactId, duration_ms: 1_200,
          real_generation_verified: true, language_verified: true, detected_locale: 'en-US',
          is_cloned: false, authorization_asset_id: null,
        }
      }
      return result
    },
    dialogueProvider: async ({ segment }) => {
      providerCallCounts.dialogue += 1
      const safeSegmentId = String(segment.segment_id).replace(/[^a-zA-Z0-9_-]/g, '-')
      const relativePath = `redraw-local-provider/dialogue-${safeSegmentId}.mp3`
      const absolutePath = path.join(storageRoot, relativePath)
      const windowSeconds = (Number(segment.end_ms) - Number(segment.start_ms)) / 1000
      const audioDuration = Math.max(0.25, Math.min(1.2, windowSeconds - 0.05))
      runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'sine=frequency=660:sample_rate=44100', '-t', String(audioDuration),
        '-c:a', 'libmp3lame', '-y', absolutePath,
      ], `本地对白 ${segment.segment_id} 生成`)
      const now = new Date().toISOString()
      const providerTaskId = `local-fixture-dialogue-${safeSegmentId}`
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
      }
    },
    localeVerifier,
    redrawOptions: {
      uploadLimits: {
        minDurationMs: 1_000,
        maxDurationMs: 60_000,
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
            || evidence?.locale_pack !== 'en-US@fixture'
            || evidence?.model_manifest_sha256 !== 'a'.repeat(64)
            || evidence?.calibration_manifest_sha256 !== 'b'.repeat(64)) {
            throw new Error('本地语言证据不可信')
          }
          return evidence
        },
      },
      generationOptions: {
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
                protocol: 'feituo_open',
                model,
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
        videoProcessor: async (db, _logger, videoGenerationId) => {
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
})

function resetProviderFixture(facts = sourceFacts, localization = localizationOverrides) {
  activeAnalysisFacts = facts
  activeLocalizationOverrides = localization
  providerCallCounts = { asset: 0, video: 0, dialogue: 0 }
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

test('通用三镜项目完成前链分析并在低说话人置信度下降级 safe', async ({ page }) => {
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
    ['generic-1', 0, 4_000],
    ['generic-2', 4_000, 8_000],
    ['generic-3', 8_000, 12_000],
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

test('通用三镜项目高置信度分析后完成 es-ES 本地化并物化三镜', async ({ page }) => {
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
    SELECT id, locale, market, status FROM redraw_versions WHERE id = ?
  `).get(Number(localized.version_id))
  expect(localizedVersion).toMatchObject({
    locale: genericRedrawProject.target.locale,
    market: genericRedrawProject.target.market,
    status: 'asset_review',
  })
  const localizedShots = database.prepare(`
    SELECT shot_id, start_ms, end_ms FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
  `).all(Number(localized.version_id))
  expect(localizedShots.map((shot) => [shot.shot_id, shot.start_ms, shot.end_ms])).toEqual([
    ['generic-1', 0, 4_000],
    ['generic-2', 4_000, 8_000],
    ['generic-3', 8_000, 12_000],
  ])
  expect(localized.shots).toHaveLength(3)

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

test('真实前后端与本地模拟供应商完成转绘同链', async ({ page }) => {
  resetProviderFixture()
  if (process.env.REDRAW_E2E_CASE === 'latam-real-source') {
    expect(sourceVideoPath).toBe(path.resolve(process.env.REDRAW_E2E_SOURCE_VIDEO))
    expect(sourceFacts.duration_ms).toBe(redrawLatinAmericanCase.sourceFacts.duration_ms)
    expect(sourceFacts.shots).toHaveLength(redrawLatinAmericanCase.sourceFacts.shots.length)
  }
  const browserErrors = []
  page.on('pageerror', (error) => browserErrors.push(`pageerror:${error.message}`))
  page.on('requestfailed', (request) => {
    browserErrors.push(`requestfailed:${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`)
  })
  await createProjectFromRedraw(page, {
    title: '本地模拟供应商验收项目',
    execution_mode: 'auto',
    default_locale: 'en-US',
    default_market: 'US',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 1,
  })
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
  const voiceRows = database.prepare(`
    SELECT id, source_ref_json FROM redraw_assets
    WHERE version_id = ? AND kind = 'voice' AND deleted_at IS NULL
    ORDER BY id DESC
  `).all(versionId)
  expect(voiceRows).toHaveLength(sourceFacts.characters.length)
  for (const voiceRow of voiceRows) {
    const voiceSource = JSON.parse(voiceRow.source_ref_json)
    voiceSource.source_ref.voice_id = 'fixture-voice'
    voiceSource.source_ref.is_cloned = false
    database.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = ?')
      .run(JSON.stringify(voiceSource), voiceRow.id)
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: '确认本地化资产后再进入批量转绘' })).toBeVisible()
  await expect(page.getByText(`${expectedAssetCount} 项资产`)).toBeVisible()

  const quoteResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets/batch-quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  expect(quoteResponse.status, JSON.stringify(quoteResponse.body)).toBe(200)
  expect(quoteResponse.body.data).toMatchObject({ priced: true, total_credits: expectedAssetCredits })
  const batchResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quote_hash: quoteResponse.body.data.quote_hash,
      idempotency_key: 'local-fixture-asset-batch-1',
    }),
  })
  expect(batchResponse.status, JSON.stringify(batchResponse.body)).toBe(202)
  let batchRow
  for (let attempt = 0; attempt < 60; attempt += 1) {
    batchRow = database.prepare('SELECT * FROM redraw_asset_batches WHERE id = ?')
      .get(Number(batchResponse.body.data.batch_id))
    if (['completed', 'partial_failed', 'failed', 'needs_attention'].includes(String(batchRow?.status))) break
    await page.waitForTimeout(250)
  }
  const batchAttempts = JSON.parse(batchRow?.asset_ids_json || '[]').map((assetId) => (
    database.prepare(`
      SELECT id, kind, status, error_code, error_message
      FROM redraw_assets WHERE id = ?
    `).get(Number(assetId))
  ))
  expect(batchRow?.status, JSON.stringify({ batch: batchRow, attempts: batchAttempts })).toBe('completed')

  const assetsResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets`)
  expect(assetsResponse.status, JSON.stringify(assetsResponse.body)).toBe(200)
  const generatedAssets = assetsResponse.body.data.filter((asset) => (
    asset.asset_id || asset.voice_asset_id || asset.clean_plate_asset_id
  ))
  expect(generatedAssets).toHaveLength(expectedAssetCount)
  const castById = new Map(activeCase ? activeCase.cast.map((actor) => [String(actor.id), actor]) : [])
  const identityCharacterAssets = generatedAssets.filter((asset) => asset.kind === 'character')
  expect(identityCharacterAssets).toHaveLength(sourceFacts.characters.length)
  for (const asset of identityCharacterAssets) {
    if (asset.identity_pack_status?.ready === true) continue
    const sourceRef = asset.source_ref && typeof asset.source_ref === 'object'
      ? asset.source_ref
      : {}
    const sourceCharacterKey = [
      sourceRef.stable_id,
      sourceRef.id,
      sourceRef.source_character_id,
      sourceRef.source_character_key,
    ]
      .map((value) => String(value || '').trim())
      .find(Boolean)
    const actor = castById.get(sourceCharacterKey) || {
      target_name: String(asset.localized_name || sourceCharacterKey || `Actor ${asset.id}`).trim(),
    }
    const identityResponse = await browserApi(page, `/api/v1/redraw/assets/${asset.id}/identity-pack`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...buildLocalIdentityPackInput(actor),
        expected_updated_at: asset.updated_at,
      }),
    })
    expect(identityResponse.status, JSON.stringify(identityResponse.body)).toBe(200)
    expect(identityResponse.body.data.identity_pack_status).toMatchObject({ ready: true })
  }
  const reviewAssetsResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets`)
  expect(reviewAssetsResponse.status, JSON.stringify(reviewAssetsResponse.body)).toBe(200)
  const reviewAssets = reviewAssetsResponse.body.data.filter((asset) => (
    asset.asset_id || asset.voice_asset_id || asset.clean_plate_asset_id
  ))
  expect(reviewAssets).toHaveLength(expectedAssetCount)
  for (const asset of reviewAssets) {
    const reviewResponse = await browserApi(page, `/api/v1/redraw/assets/${asset.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approved', expected_updated_at: asset.updated_at }),
    })
    expect(reviewResponse.status, JSON.stringify(reviewResponse.body)).toBe(200)
  }
  const readyWork = await browserApi(page, `/api/v1/redraw/works/${workId}`)
  const preparedShots = []
  for (const shot of readyWork.body.data.shots) {
    const sourceShotId = sourceFacts.shots[Number(shot.shot_index) - 1]?.id
    const sourceShot = sourceFacts.shots[Number(shot.shot_index) - 1]
    const prompt = activeCase
      ? activeCase.shotPrompts[sourceShotId]
      : (Number(shot.shot_index) === 1
          ? 'Cinematic rooftop at night. Aran checks an old phone as a strange message appears.'
          : 'Cinematic rooftop at night. Aran looks around, turns, and leaves.')
    const references = Array.isArray(sourceShot?.dialogue) && sourceShot.dialogue.length > 0
      ? shot.references.filter((reference) => reference.kind === 'character').slice(0, 1)
      : shot.references
    const updateResponse = await browserApi(page, `/api/v1/redraw/shots/${shot.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_updated_at: shot.updated_at,
        prompt,
        model: Number(shot.shot_index) === 1 ? 'seedance-2-fast' : 'fake-video',
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
  const gateResponse = await browserApi(page, `/api/v1/redraw/versions/${versionId}/generation-gate`)
  expect(gateResponse.status, JSON.stringify(gateResponse.body)).toBe(200)
  expect(gateResponse.body.data.ok, JSON.stringify(gateResponse.body)).toBe(true)

  const shotIds = preparedShots.map((shot) => Number(shot.id))
  expect(shotIds).toHaveLength(expectedShotCount)
  const videoBatchResponse = await browserApi(page, `/api/v1/redraw/works/${workId}/generate-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version_id: versionId, shot_ids: shotIds }),
  })
  expect(videoBatchResponse.status, JSON.stringify(videoBatchResponse.body)).toBe(202)
  expect(videoBatchResponse.body.data.results).toHaveLength(expectedShotCount)
  let videoShotRows = []
  for (let attempt = 0; attempt < 120; attempt += 1) {
    videoShotRows = database.prepare(`
      SELECT id, shot_index, status, video_generation_id, error_code, error_message
      FROM redraw_shots WHERE version_id = ? ORDER BY shot_index
    `).all(versionId)
    if (videoShotRows.filter((shot) => shot.status === 'completed').length === expectedShotCount) break
    if (videoShotRows.some((shot) => shot.status === 'completed')
      && videoShotRows.every((shot) => !['pending', 'processing'].includes(shot.status))) break
    await page.waitForTimeout(250)
  }
  expect(
    videoShotRows.filter((shot) => shot.status === 'completed'),
    JSON.stringify({
      shots: videoShotRows,
      videos: database.prepare('SELECT id, status, error_msg, local_path FROM video_generations ORDER BY id').all(),
      tasks: database.prepare("SELECT id, status, error FROM async_tasks WHERE type = 'redraw_shot' ORDER BY created_at").all(),
      batchResponse: videoBatchResponse.body,
      runtimeErrors,
    }),
  ).toHaveLength(expectedShotCount)
  const composedWork = await browserApi(page, `/api/v1/redraw/works/${workId}`)
  expect(composedWork.body.data).toMatchObject({ current_step: 4, workflow_phase: 'video_generation' })
  expect(composedWork.body.data.shots.every((shot) => shot.new_video_ref?.asset_id)).toBe(true)

  const bindableAssets = await browserApi(page, `/api/v1/redraw/versions/${versionId}/assets`)
  expect(bindableAssets.status, JSON.stringify(bindableAssets.body)).toBe(200)
  const characterAssets = bindableAssets.body.data.filter((asset) => asset.kind === 'character')
  const voiceAssets = bindableAssets.body.data.filter((asset) => asset.kind === 'voice')
  expect(characterAssets).toHaveLength(sourceFacts.characters.length)
  expect(voiceAssets).toHaveLength(sourceFacts.characters.length)
  const voiceAssignments = []
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
    const voiceAssignment = await browserApi(page, `/api/v1/redraw/assets/${characterAsset.id}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice_asset_id: voiceAsset.id,
        expected_updated_at: characterAsset.updated_at,
      }),
    })
    expect(voiceAssignment.status, JSON.stringify(voiceAssignment.body)).toBe(200)
    expect(voiceAssignment.body.data.voice_snapshot).toMatchObject({
      provider: 'local-fake-tts', model: 'fake-tts', voice_id: 'fixture-voice', locale: 'en-US',
    })
    voiceAssignments.push({ stableId, characterAssetId: characterAsset.id, voiceAssetId: voiceAsset.id })
  }
  expect(voiceAssignments).toHaveLength(sourceFacts.characters.length)

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
  const dialogueTaskId = dialogueStart.body.data.task_id
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
  const dialogueSegments = dialogueAudits.flatMap(({ audit }) => audit?.segments || [])
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

  const composeStart = await browserApi(page, `/api/v1/redraw/versions/${versionId}/compose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotency_key: 'local-fixture-compose-1', audio_mode: 'replace' }),
  })
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

  const downloaded = await page.evaluate(async (url) => {
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
  expect(downloaded).toMatchObject({
    status: 200,
    magic: 'ftyp',
    digest: exportDetail.hashes.mp4,
    responseHash: exportDetail.hashes.mp4,
    contentType: 'video/mp4',
  })
  expect(downloaded.size).toBeGreaterThan(1_000)

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
  expect(videoStream).toMatchObject({ width: 320, height: 180 })
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
})
