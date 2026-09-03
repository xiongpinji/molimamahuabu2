import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { redrawLatinAmericanCase } from '../e2e/fixtures/redraw-latin-american-case.js'
import {
  assertNextShotAllowed,
  validateBalanceEvidence,
  validatePaidContract,
} from './fuminFullEpisodePaidGuard.mjs'
import { loadCharacterNeutralMotionPack } from './fuminCharacterNeutralMotionPack.mjs'
import {
  loadProductionIdentityPacks,
  shotCharacterIds,
} from './fuminProductionIdentityPacks.mjs'
import {
  deriveFuminFullEpisodeState,
  R4_SHOT4_ARTIFACT_SHA256,
} from './fuminFullEpisodeDerivedState.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const backendRoot = path.join(repositoryRoot, 'backend-node')
const { getFfmpegPath, getFfprobePath } = require(path.join(backendRoot, 'src', 'utils', 'ffmpegPath'))
const {
  buildFuminVideoBody,
  parseFuminStatusPayload,
  parseFuminSubmitResponse,
} = require(path.join(backendRoot, 'src', 'services', 'fuminVideoClient'))

const FUMIN_BASE_URL = 'https://fumin.ai'
const MANIFEST_NAME = 'private-manifest.json'
const RUNTIME_SECRETS_NAME = 'private-runtime-secrets.json'
const HEX_64 = /^[a-f0-9]{64}$/i
const ASR_MODEL_IDS = [
  'Systran/faster-whisper-small',
  'Systran/faster-whisper-base',
]
const NUMBER_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion',
])
const NEGATION_WORDS = new Set([
  'no', 'not', 'never', 'nor', 'neither', 'cannot', 'wont', 'dont', 'doesnt', 'didnt',
  'isnt', 'arent', 'wasnt', 'werent', 'havent', 'hasnt', 'hadnt', 'couldnt',
  'wouldnt', 'shouldnt', 'mustnt', 'neednt',
])

function fail(code, message = code) {
  throw Object.assign(new Error(`${code}: ${message}`), { code })
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath))
}

function normalizedWords(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]
}

function orderedTurnsPresent(actual, turns) {
  let cursor = 0
  for (const turn of turns) {
    const expected = normalizedWords(turn.localized_text)
    const index = actual.indexOf(expected, cursor)
    if (index < 0) return false
    cursor = index + expected.length
  }
  return true
}

function criticalDialogueTokens(testCase, turns) {
  const targetTokens = normalizedWords(turns.map((turn) => turn.localized_text).join(' ')).split(' ')
  const characterTokens = new Set(testCase.cast.flatMap(
    (actor) => normalizedWords(actor.target_name).split(' ').filter(Boolean),
  ))
  return [...new Set(targetTokens.filter((token) => (
    characterTokens.has(token)
      || /^\d+$/.test(token)
      || NUMBER_WORDS.has(token)
      || NEGATION_WORDS.has(token)
  )))]
}

function pick(payload, paths) {
  for (const parts of paths) {
    let value = payload
    for (const part of parts) value = value?.[part]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

async function responseJson(response) {
  const raw = await response.text()
  try { return JSON.parse(raw) } catch { return null }
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, filePath)
}

function readManifest(stateRoot) {
  const filePath = path.join(stateRoot, MANIFEST_NAME)
  if (!fs.existsSync(filePath)) fail('FUMIN_FULL_EPISODE_MANIFEST_MISSING')
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeManifest(stateRoot, manifest) {
  manifest.updated_at = new Date().toISOString()
  atomicJson(path.join(stateRoot, MANIFEST_NAME), manifest)
}

function readRuntimeSecrets(stateRoot) {
  const filePath = path.join(stateRoot, RUNTIME_SECRETS_NAME)
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
    : { schema_version: 'fumin-private-runtime-secrets-v1' }
}

function writeRuntimeSecrets(stateRoot, value) {
  atomicJson(path.join(stateRoot, RUNTIME_SECRETS_NAME), value)
}

export function buildShotPrompt(testCase, shotNumber) {
  const index = Number(shotNumber) - 1
  const shot = testCase?.sourceFacts?.shots?.[index]
  const dialogue = testCase?.localization?.dialogue?.find((item) => item.shot_id === shot?.id)
  if (!shot || !dialogue) fail('FUMIN_FULL_EPISODE_SHOT_INVALID', `镜头 ${shotNumber} 不存在`)
  const castById = new Map(testCase.cast.map((actor) => [actor.id, actor.target_name]))
  const names = shotCharacterIds(testCase, shotNumber).map((id) => castById.get(id))
  const base = [
    testCase.shotPrompts[shot.id],
    `Use the same fixed adult Latin American cast from the supplied identity reference${names.length ? `: ${names.join(', ')}` : ''}.`,
    'Match the supplied motion reference for blocking, camera direction, pose, action timing, scene continuity, wardrobe continuity, and props.',
    'Create a vertical 9:16 cinematic live-action shot, exactly 8 seconds, without subtitles, captions, watermarks, logos, or Chinese text.',
  ]
  if (Number(shotNumber) === 5) {
    base.push('The television must show only generic, unbranded, unreadable sports imagery: no scoreboard, broadcast graphics, readable text, brand, or logo.')
  }
  if (!dialogue.speech_required) {
    base.push('Generate natural synchronized ambience and sound effects only; no spoken dialogue, voiceover, narration, singing, or intelligible vocalization.')
  } else {
    base.push('All speech must be natural American English only. Do not speak Chinese, Spanish, or any other language.')
    base.push('Generate synchronized en-US speech audio for the approved dialogue timing only.')
    if (dialogue.turns.some((turn) => /\bMateo\b/i.test(turn.localized_text))) {
      base.push('Pronunciation: Mateo must be spoken as three distinct syllables: mah-TEH-oh, with the final "oh" fully audible.')
    }
    if (Number(shotNumber) === 5) {
      base.push('For Mateo\'s line, the first audible word must be "I", spoken clearly at full volume after a brief silent lead-in; do not clip or drop it.')
    }
    base.push('Speak these exact lines once, in this exact order, assigned to these exact characters:')
    dialogue.turns.forEach((turn, turnIndex) => {
      base.push(`${turnIndex + 1}. ${castById.get(turn.speaker_id)}: "${turn.localized_text}" (${turn.start_ms}-${turn.end_ms}ms)`)
    })
    base.push('Do not compress, clip, or drop any word or final vowel to fit the timing.')
    base.push('Do not add, omit, translate, paraphrase, repeat, or reassign any spoken words.')
  }
  return base.filter(Boolean).join('\n')
}

function validateProductionIdentityPacks(identityPacks) {
  if (!Array.isArray(identityPacks)
    || identityPacks.length !== redrawLatinAmericanCase.cast.length) {
    fail('FUMIN_FULL_EPISODE_PRODUCTION_IDENTITY_PACK_REQUIRED')
  }
  return redrawLatinAmericanCase.cast.map((actor, index) => {
    const pack = identityPacks[index]
    if (pack?.schema_version !== 'target-actor-identity-v1'
      || pack.source_character_key !== actor.id
      || pack.target_actor_label !== actor.target_name
      || pack.live_action_human_confirmed !== true
      || pack.adult_status !== 'verified_18_plus'
      || pack.identity_consistency_confirmed !== true
      || pack.persona_origin !== 'fictional_ai_generated'
      || pack.target_country !== 'US'
      || pack.ready !== true
      || pack.review_status !== 'approved'
      || JSON.stringify(pack.confirmed_views) !== JSON.stringify(['front', 'profile', 'full_body'])
      || !HEX_64.test(String(pack.pack_sha256 || ''))
      || !HEX_64.test(String(pack.artifact?.sha256 || ''))
      || pack.artifact?.mime_type !== 'image/png') {
      fail('FUMIN_FULL_EPISODE_PRODUCTION_IDENTITY_PACK_REQUIRED', actor.id)
    }
    return {
      schema_version: pack.schema_version,
      source_character_key: actor.id,
      target_actor_label: actor.target_name,
      artifact: {
        artifact_id: pack.artifact.artifact_id,
        sha256: String(pack.artifact.sha256).toLowerCase(),
        bytes: pack.artifact.bytes,
        width: pack.artifact.width,
        height: pack.artifact.height,
        mime_type: 'image/png',
      },
      confirmed_views: ['front', 'profile', 'full_body'],
      live_action_human_confirmed: true,
      adult_status: 'verified_18_plus',
      identity_consistency_confirmed: true,
      persona_origin: 'fictional_ai_generated',
      target_country: 'US',
      ready: true,
      pack_sha256: String(pack.pack_sha256).toLowerCase(),
      review_status: 'approved',
    }
  })
}

function validateMotionVisualSanitization(segment) {
  const sanitization = segment?.visual_sanitization
  if (segment?.conditioning_mode !== 'character_neutral_motion'
    || !sanitization
    || sanitization.schema_version !== 'redraw-motion-visual-sanitization-v1'
    || sanitization.privacy_transform_scope !== 'full_frame'
    || sanitization.source_identity_obscured !== true
    || sanitization.source_text_obscured !== true
    || sanitization.review_status !== 'approved'
    || !HEX_64.test(String(sanitization.evidence_sha256 || ''))) {
    fail(
      'FUMIN_FULL_EPISODE_MOTION_VISUAL_SANITIZATION_REQUIRED',
      `镜头 ${segment?.shot_number || 'unknown'} 未通过全帧身份与文字遮蔽人工审核`,
    )
  }
  return {
    schema_version: sanitization.schema_version,
    privacy_transform_scope: 'full_frame',
    source_identity_obscured: true,
    source_text_obscured: true,
    review_status: 'approved',
    evidence_sha256: String(sanitization.evidence_sha256).toLowerCase(),
  }
}

export function assertPaidReferenceGate(manifest) {
  const gate = manifest?.reference_gate
  const segments = manifest?.motion_segments
  if (gate?.status !== 'approved'
    || !Array.isArray(segments)
    || segments.length !== 9) {
    fail('FUMIN_FULL_EPISODE_REFERENCE_GATE_NOT_APPROVED')
  }
  try {
    validateProductionIdentityPacks(gate.identities)
    segments.forEach(validateMotionVisualSanitization)
  } catch (_) {
    fail('FUMIN_FULL_EPISODE_REFERENCE_GATE_NOT_APPROVED')
  }
  return true
}

export function createInitialManifest({
  contract,
  sourcePath,
  sourceSha256,
  identityPacks,
  motionSegments,
}) {
  const safeContract = validatePaidContract(contract)
  if (String(sourceSha256).toLowerCase() !== redrawLatinAmericanCase.source.sha256) {
    fail('FUMIN_FULL_EPISODE_SOURCE_HASH_MISMATCH')
  }
  if (!Array.isArray(motionSegments) || motionSegments.length !== 9) {
    fail('FUMIN_FULL_EPISODE_MOTION_SEGMENTS_INVALID')
  }
  const identityGate = validateProductionIdentityPacks(identityPacks)
  for (const [index, segment] of motionSegments.entries()) {
    if (segment.shot_number !== index + 1 || segment.shot_id !== `shot-${index + 1}`
      || !/^[a-f0-9]{64}$/i.test(String(segment.sha256 || '')) || segment.has_audio !== false) {
      fail('FUMIN_FULL_EPISODE_MOTION_SEGMENTS_INVALID', `镜头 ${index + 1} 动作参考无效`)
    }
    validateMotionVisualSanitization(segment)
  }
  const manifest = {
    schema_version: 'redraw-fumin-full-episode-paid-private-v1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    case_id: redrawLatinAmericanCase.id,
    provider: 'fumin.ai',
    contract: safeContract,
    generation: {
      model: 'fumin-seedance-2.0-mini',
      upstream_model: 'seedance-2.0-mini',
      resolution: '480p',
      aspect_ratio: '9:16',
      duration_seconds: 8,
      generate_audio: true,
      retries_allowed: false,
    },
    source_sha256: String(sourceSha256).toLowerCase(),
    reference_gate: {
      status: 'approved',
      identities: identityGate,
      motion_segment_count: 9,
    },
    motion_segments: motionSegments.map(({ path: _path, ...segment }) => segment),
    references: { identities: {} },
    tasks: [],
    status: 'preflight_complete',
  }
  assertPaidReferenceGate(manifest)
  return manifest
}

export function beginSubmissionAttempt(stateRoot, shotNumber) {
  const locksRoot = path.join(stateRoot, 'locks')
  fs.mkdirSync(locksRoot, { recursive: true })
  const lockPath = path.join(locksRoot, `shot-${String(shotNumber).padStart(2, '0')}-submit.lock.json`)
  const record = {
    schema_version: 'fumin-paid-submission-lock-v1',
    shot_number: Number(shotNumber),
    scope: 'reference_upload_and_paid_submission',
    external_actions_locked_before_network: true,
    created_at: new Date().toISOString(),
    retry_allowed: false,
  }
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') fail('FUMIN_FULL_EPISODE_SHOT_LOCK_EXISTS', `镜头 ${shotNumber} 已锁定`)
    throw error
  }
  return record
}

const PRIVATE_KEYS = /(^|_)(api_?key|authorization|token|secret|password|path|url|raw_response)$/i

export function publicEvidence(value) {
  if (Array.isArray(value)) return value.map(publicEvidence)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEYS.test(key)) continue
    output[key] = publicEvidence(item)
  }
  return output
}

export function validateRuntimeIdentityReference(runtimeReference, manifestReference, identityPack) {
  if (!/^https:\/\//i.test(String(runtimeReference?.url || ''))
    || String(runtimeReference?.asset_id || '') !== String(manifestReference?.asset_id || '')
    || String(runtimeReference?.sha256 || '').toLowerCase() !== String(manifestReference?.sha256 || '').toLowerCase()
    || String(runtimeReference?.sha256 || '').toLowerCase() !== String(identityPack?.artifact?.sha256 || '').toLowerCase()
    || String(runtimeReference?.pack_sha256 || '').toLowerCase() !== String(identityPack?.pack_sha256 || '').toLowerCase()) {
    fail('FUMIN_FULL_EPISODE_IDENTITY_RUNTIME_BINDING_MISMATCH')
  }
  return runtimeReference.url
}

export function parseSuccessfulSubmission(payload) {
  if (!payload || typeof payload !== 'object') {
    fail('FUMIN_FULL_EPISODE_SUBMISSION_UNKNOWN', '生成 POST 返回 2xx 但响应不是可识别 JSON')
  }
  const parsed = parseFuminSubmitResponse(payload)
  if (parsed.error || (!parsed.task_id && !parsed.video_url)) {
    fail('FUMIN_FULL_EPISODE_SUBMISSION_UNKNOWN', parsed.error || '生成 POST 返回 2xx 但缺少任务身份')
  }
  return parsed
}

export function buildConcatList(filePaths) {
  return filePaths.map((filePath) => {
    const normalized = path.resolve(filePath).replaceAll('\\', '/')
    return `file '${normalized.replaceAll("'", "'\\''")}'`
  }).join('\n') + '\n'
}

export function assertFinalizeReady(manifest) {
  validatePaidContract(manifest?.contract)
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : []
  if (tasks.length !== 9
    || tasks.some((task, index) => task.shot_number !== index + 1 || task.status !== 'completed_verified')) {
    fail('FUMIN_FULL_EPISODE_NOT_READY', '必须九镜全部逐镜验收后才能合并')
  }
  return true
}

function runProcess(executable, args, code, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 10 * 60 * 1_000,
    env: options.env ?? process.env,
  })
  if (result.error || result.status !== 0) {
    fail(code, String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).slice(0, 1_000))
  }
  return result.stdout
}

export function probeMedia(filePath) {
  const payload = JSON.parse(runProcess(getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], 'FUMIN_FULL_EPISODE_FFPROBE_FAILED'))
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  if (!video) fail('FUMIN_FULL_EPISODE_VIDEO_STREAM_MISSING')
  return {
    duration_seconds: Number(payload.format?.duration),
    width: Number(video.width),
    height: Number(video.height),
    video_codec: String(video.codec_name || ''),
    has_audio: Boolean(audio),
    audio_codec: String(audio?.codec_name || ''),
    audio_channels: Number(audio?.channels || 0),
  }
}

function assertStateOutsideRepository(stateRoot) {
  const relative = path.relative(repositoryRoot, stateRoot)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    fail('FUMIN_FULL_EPISODE_STATE_INSIDE_REPOSITORY')
  }
}

async function uploadReference(apiKey, filePath, mimeType) {
  const bytes = fs.readFileSync(filePath)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mimeType }), path.basename(filePath))
  let response
  try {
    response = await fetch(`${FUMIN_BASE_URL}/api/v3/files/uploads?volc_asset=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    })
  } catch (error) {
    fail('FUMIN_FULL_EPISODE_REFERENCE_UPLOAD_UNKNOWN', error.message)
  }
  const payload = await responseJson(response)
  if (!response.ok) fail('FUMIN_FULL_EPISODE_REFERENCE_UPLOAD_REJECTED', `HTTP ${response.status}`)
  const assetId = pick(payload, [['id'], ['file_id'], ['data', 'id'], ['data', 'file_id']])
  let url = pick(payload, [['url'], ['data', 'url'], ['file', 'url'], ['data', 'file', 'url']])
  if (!assetId) fail('FUMIN_FULL_EPISODE_REFERENCE_UPLOAD_ID_MISSING')
  if (!url) {
    let metadata
    try {
      metadata = await fetch(`${FUMIN_BASE_URL}/api/v3/files/${encodeURIComponent(assetId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      fail('FUMIN_FULL_EPISODE_REFERENCE_METADATA_UNKNOWN', error.message)
    }
    const metadataPayload = await responseJson(metadata)
    if (!metadata.ok) fail('FUMIN_FULL_EPISODE_REFERENCE_URL_UNAVAILABLE', `HTTP ${metadata.status}`)
    url = pick(metadataPayload, [['url'], ['data', 'url'], ['file', 'url'], ['data', 'file', 'url']])
  }
  if (!/^https:\/\//i.test(String(url || ''))) fail('FUMIN_FULL_EPISODE_REFERENCE_URL_INVALID')
  return {
    asset_id: String(assetId),
    url: String(url),
    sha256: sha256Buffer(bytes),
    bytes: bytes.length,
  }
}

async function submitGeneration(apiKey, body) {
  let response
  try {
    response = await fetch(`${FUMIN_BASE_URL}/api/v3/contents/generations/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
  } catch (error) {
    fail('FUMIN_FULL_EPISODE_SUBMISSION_UNKNOWN', error.message)
  }
  const payload = await responseJson(response)
  if (!response.ok) fail('FUMIN_FULL_EPISODE_SUBMISSION_REJECTED', `HTTP ${response.status}`)
  return parseSuccessfulSubmission(payload)
}

export async function pollGeneration(apiKey, taskId, {
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
} = {}) {
  const deadline = now() + 30 * 60 * 1_000
  let previousTransportFailure = false
  while (now() < deadline) {
    let response
    try {
      response = await fetchImpl(`${FUMIN_BASE_URL}/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      if (previousTransportFailure) fail('FUMIN_FULL_EPISODE_STATUS_UNKNOWN', error.message)
      previousTransportFailure = true
      await sleep(5_000)
      continue
    }
    previousTransportFailure = false
    const payload = await responseJson(response)
    if (!response.ok) fail('FUMIN_FULL_EPISODE_STATUS_REJECTED', `HTTP ${response.status}`)
    const status = parseFuminStatusPayload(payload || {})
    if (status.state === 'completed') return status.videoUrl
    if (status.state === 'failed') fail('FUMIN_FULL_EPISODE_PROVIDER_FAILED', status.error)
    await sleep(5_000)
  }
  fail('FUMIN_FULL_EPISODE_STATUS_TIMEOUT')
}

async function downloadResult(url, outputPath) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1_000) })
  } catch (error) {
    fail('FUMIN_FULL_EPISODE_RESULT_DOWNLOAD_UNKNOWN', error.message)
  }
  if (!response.ok) fail('FUMIN_FULL_EPISODE_RESULT_DOWNLOAD_REJECTED', `HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 100_000) fail('FUMIN_FULL_EPISODE_RESULT_TOO_SMALL')
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, bytes, { flag: 'wx' })
  return { sha256: sha256Buffer(bytes), bytes: bytes.length }
}

export function transcribeEnglish(filePath, pythonPath, modelId = ASR_MODEL_IDS[0]) {
  if (!pythonPath || !fs.existsSync(pythonPath)) fail('FUMIN_FULL_EPISODE_VERIFIER_PYTHON_MISSING')
  if (!ASR_MODEL_IDS.includes(modelId)) fail('FUMIN_FULL_EPISODE_ASR_MODEL_INVALID', modelId)
  const code = [
    'import json,sys',
    'from faster_whisper import WhisperModel',
    'model_id=sys.argv[2]',
    'm=WhisperModel(model_id,device="cpu",compute_type="int8",local_files_only=True)',
    'segments,info=m.transcribe(sys.argv[1],beam_size=5,vad_filter=True)',
    'print(json.dumps({"model_id":model_id,"language":info.language,"probability":info.language_probability,"text":" ".join(s.text.strip() for s in segments).strip()},ensure_ascii=False))',
  ].join(';')
  const stdout = runProcess(pythonPath, ['-c', code, filePath, modelId], 'FUMIN_FULL_EPISODE_ASR_FAILED', {
    timeout: 12 * 60 * 1_000,
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  })
  return JSON.parse(stdout)
}

export function transcribeEnglishConsensus(filePath, pythonPath) {
  return ASR_MODEL_IDS.map((modelId) => transcribeEnglish(filePath, pythonPath, modelId))
}

export function verifyTranscript(testCase, shotNumber, transcript) {
  const dialogue = testCase.localization.dialogue[shotNumber - 1]
  const actual = normalizedWords(transcript?.text)
  if (!dialogue.speech_required) {
    if (actual) fail('FUMIN_FULL_EPISODE_SILENT_SHOT_HAS_SPEECH', actual)
    return { speech_required: false, transcript: '', exact_dialogue_present: true }
  }
  if (String(transcript?.language || '').toLowerCase() !== 'en' || Number(transcript?.probability) < 0.8) {
    fail('FUMIN_FULL_EPISODE_TARGET_LANGUAGE_FAILED', JSON.stringify(transcript))
  }
  for (const turn of dialogue.turns) {
    if (!actual.includes(normalizedWords(turn.localized_text))) {
      fail('FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED', `${turn.speaker_id}: ${turn.localized_text}`)
    }
  }
  return {
    speech_required: true,
    detected_language: transcript.language,
    detected_language_probability: Number(transcript.probability),
    transcript: transcript.text,
    exact_dialogue_present: true,
  }
}

export function verifyTranscriptConsensus(testCase, shotNumber, transcripts) {
  if (!Array.isArray(transcripts) || transcripts.length !== ASR_MODEL_IDS.length) {
    fail('FUMIN_FULL_EPISODE_ASR_CONSENSUS_UNAVAILABLE')
  }
  const byModel = new Map(transcripts.map((transcript) => [transcript?.model_id, transcript]))
  if (byModel.size !== ASR_MODEL_IDS.length
    || ASR_MODEL_IDS.some((modelId) => !byModel.has(modelId))) {
    fail('FUMIN_FULL_EPISODE_ASR_CONSENSUS_UNAVAILABLE')
  }
  const dialogue = testCase.localization.dialogue[shotNumber - 1]
  if (!dialogue) fail('FUMIN_FULL_EPISODE_SHOT_INVALID', String(shotNumber))
  const ordered = ASR_MODEL_IDS.map((modelId) => byModel.get(modelId))
  const actuals = ordered.map((transcript) => normalizedWords(transcript.text))
  if (!dialogue.speech_required) {
    const speech = actuals.find(Boolean)
    if (speech) fail('FUMIN_FULL_EPISODE_SILENT_SHOT_HAS_SPEECH', speech)
    return {
      speech_required: false,
      consensus_passed: true,
      exact_dialogue_present: true,
      models: ordered.map((transcript) => ({
        model_id: transcript.model_id,
        transcript: '',
      })),
    }
  }

  ordered.forEach((transcript, index) => {
    if (!actuals[index]) fail('FUMIN_FULL_EPISODE_ASR_CONSENSUS_EMPTY', transcript.model_id)
    if (String(transcript.language || '').toLowerCase() !== 'en'
      || Number(transcript.probability) < 0.8) {
      fail('FUMIN_FULL_EPISODE_TARGET_LANGUAGE_FAILED', transcript.model_id)
    }
  })

  const target = normalizedWords(dialogue.turns.map((turn) => turn.localized_text).join(' '))
  const targetWords = target.split(' ')
  const criticalTokens = criticalDialogueTokens(testCase, dialogue.turns)
  const requiredCriticalCounts = new Map(criticalTokens.map((token) => [
    token,
    targetWords.filter((word) => word === token).length,
  ]))
  const models = ordered.map((transcript, index) => {
    const actual = actuals[index]
    const actualWords = actual.split(' ')
    const wordErrorRate = editDistance(targetWords, actualWords) / targetWords.length
    const characterErrorRate = editDistance([...target], [...actual]) / target.length
    const exactDialoguePresent = orderedTurnsPresent(actual, dialogue.turns)
    const missingCriticalTokens = criticalTokens.filter((token) => (
      actualWords.filter((word) => word === token).length < requiredCriticalCounts.get(token)
    ))
    if (missingCriticalTokens.length) {
      fail(
        'FUMIN_FULL_EPISODE_CRITICAL_TOKEN_FAILED',
        `${transcript.model_id}: ${missingCriticalTokens.join(',')}`,
      )
    }
    return {
      model_id: transcript.model_id,
      detected_language: transcript.language,
      detected_language_probability: Number(transcript.probability),
      transcript: transcript.text,
      exact_dialogue_present: exactDialoguePresent,
      word_error_rate: Number(wordErrorRate.toFixed(6)),
      character_error_rate: Number(characterErrorRate.toFixed(6)),
      critical_tokens_present: true,
    }
  })
  const exact = models.find((model) => model.exact_dialogue_present)
  if (!exact) fail('FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED')
  const distanceInvalid = models.some((model) => (
    model.word_error_rate > 0.1 || model.character_error_rate > 0.03
  ))
  if (distanceInvalid) fail('FUMIN_FULL_EPISODE_ASR_CONSENSUS_DISTANCE_FAILED')
  return {
    speech_required: true,
    consensus_passed: true,
    exact_dialogue_present: true,
    exact_model_id: exact.model_id,
    critical_tokens: criticalTokens,
    models,
  }
}

export function createContactSheet(videoPath, outputPath) {
  runProcess(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    '-vf', 'fps=1,scale=248:-2,tile=8x1', '-frames:v', '1', '-y', outputPath,
  ], 'FUMIN_FULL_EPISODE_CONTACT_SHEET_FAILED')
}

export function validateGeneratedMedia(probe) {
  if (probe.width !== 496 || probe.height !== 864) {
    fail('FUMIN_FULL_EPISODE_OUTPUT_DIMENSIONS_INVALID', `${probe.width}x${probe.height}`)
  }
  if (probe.duration_seconds < 7.2 || probe.duration_seconds > 8.8) {
    fail('FUMIN_FULL_EPISODE_OUTPUT_DURATION_INVALID', String(probe.duration_seconds))
  }
  if (!probe.has_audio) fail('FUMIN_FULL_EPISODE_OUTPUT_AUDIO_MISSING')
}

export function revalidateDerivedShot4(
  { stagingRoot, derivedManifest },
  verifierPython,
  adapters = {},
) {
  const local = {
    probeMedia,
    validateGeneratedMedia,
    transcribeEnglishConsensus,
    verifyTranscriptConsensus,
    sha256File,
    createContactSheet,
    now: () => new Date(),
    ...adapters,
  }
  const videoPath = path.join(stagingRoot, 'artifacts', 'shot-04.mp4')
  const probe = local.probeMedia(videoPath)
  local.validateGeneratedMedia(probe)
  const transcripts = local.transcribeEnglishConsensus(videoPath, verifierPython)
  const speech = local.verifyTranscriptConsensus(redrawLatinAmericanCase, 4, transcripts)
  const artifactSha256 = local.sha256File(videoPath)
  if (artifactSha256 !== R4_SHOT4_ARTIFACT_SHA256) fail('FUMIN_DERIVE_SHOT4_HASH_MISMATCH')
  const contactSheetPath = path.join(stagingRoot, 'artifacts', 'shot-04-contact-sheet.jpg')
  local.createContactSheet(videoPath, contactSheetPath)

  const task = derivedManifest.tasks[3]
  task.status = 'awaiting_human_review'
  delete task.error_code
  task.artifact = {
    artifact_id: 'shot-04.mp4',
    sha256: artifactSha256,
    bytes: fs.statSync(videoPath).size,
    ffprobe: probe,
  }
  task.contact_sheet_id = 'shot-04-contact-sheet.jpg'
  task.speech = speech
  task.revalidation = {
    schema_version: 'fumin-shot-local-revalidation-v2',
    source_status: 'failed',
    source_error_code: 'FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED',
    artifact_sha256: artifactSha256,
    verifier_result: 'passed',
    revalidated_at: local.now().toISOString(),
  }
}

async function runPreflight(options) {
  assertStateOutsideRepository(options.stateRoot)
  if (fs.existsSync(path.join(options.stateRoot, MANIFEST_NAME))) fail('FUMIN_FULL_EPISODE_STATE_ALREADY_EXISTS')
  for (const filePath of [options.source, options.identityPackRoot, options.motionPackRoot]) {
    if (!filePath || !fs.existsSync(filePath)) fail('FUMIN_FULL_EPISODE_INPUT_MISSING')
  }
  const sourceSha256 = sha256File(options.source)
  if (sourceSha256 !== redrawLatinAmericanCase.source.sha256) {
    fail('FUMIN_FULL_EPISODE_SOURCE_HASH_MISMATCH')
  }
  const identityPacks = loadProductionIdentityPacks(
    path.resolve(options.identityPackRoot),
    redrawLatinAmericanCase,
  )
  const motionSegments = loadCharacterNeutralMotionPack(
    path.resolve(options.motionPackRoot),
    redrawLatinAmericanCase,
  )
  fs.mkdirSync(options.stateRoot, { recursive: true })
  const runtimeIdentityRoot = path.join(options.stateRoot, 'runtime', 'identities')
  const motionRoot = path.join(options.stateRoot, 'motion')
  fs.mkdirSync(runtimeIdentityRoot, { recursive: true })
  fs.mkdirSync(motionRoot, { recursive: true })
  for (const pack of identityPacks) {
    fs.copyFileSync(pack.artifact.path, path.join(runtimeIdentityRoot, `${pack.source_character_key}.png`))
  }
  for (const segment of motionSegments) {
    fs.copyFileSync(
      segment.path,
      path.join(options.stateRoot, 'motion', `shot-${String(segment.shot_number).padStart(2, '0')}-motion.mp4`),
    )
  }
  const estimatedPerShotUsd = Number(options.estimatedPerShotUsd)
  const manifest = createInitialManifest({
    contract: {
      expectedShots: 9,
      maxPaidSubmits: 9,
      spendCapUsd: Number(options.spendCapUsd),
      estimatedPerShotUsd,
      estimatedTotalUsd: Number((estimatedPerShotUsd * 9).toFixed(6)),
      initialBalanceUsd: Number(options.initialBalanceUsd),
      accountId: String(options.accountId || '').trim(),
    },
    sourcePath: options.source,
    sourceSha256,
    identityPacks,
    motionSegments,
  })
  writeManifest(options.stateRoot, manifest)
  atomicJson(path.join(options.stateRoot, 'public-preflight-evidence.json'), publicEvidence(manifest))
  return publicEvidence(manifest)
}

async function runShot(options) {
  const manifest = readManifest(options.stateRoot)
  assertPaidReferenceGate(manifest)
  const shotNumber = Number(options.shot)
  if (!options.balanceEvidence || !fs.existsSync(options.balanceEvidence)) {
    fail('FUMIN_FULL_EPISODE_BALANCE_EVIDENCE_MISSING')
  }
  const balanceEvidenceBytes = fs.readFileSync(options.balanceEvidence)
  const balanceEvidence = validateBalanceEvidence(
    manifest,
    JSON.parse(balanceEvidenceBytes.toString('utf8')),
  )
  assertNextShotAllowed(manifest, shotNumber, balanceEvidence)
  if (!options.keyFile || !fs.existsSync(options.keyFile)) fail('FUMIN_FULL_EPISODE_KEY_FILE_MISSING')
  const apiKey = fs.readFileSync(options.keyFile, 'utf8').trim()
  if (!apiKey) fail('FUMIN_FULL_EPISODE_KEY_EMPTY')
  beginSubmissionAttempt(options.stateRoot, shotNumber)
  const identityIds = shotCharacterIds(redrawLatinAmericanCase, shotNumber)
  const task = {
    shot_number: shotNumber,
    shot_id: `shot-${shotNumber}`,
    status: 'reference_upload_started',
    balance_evidence: {
      schema_version: balanceEvidence.schema_version,
      provider: balanceEvidence.provider,
      account_id: balanceEvidence.account_id,
      captured_by: balanceEvidence.captured_by,
      observed_at: balanceEvidence.observed_at,
      balance_usd: balanceEvidence.balance_usd,
      estimated_per_shot_usd: balanceEvidence.estimated_per_shot_usd,
      model: balanceEvidence.model,
      duration_seconds: balanceEvidence.duration_seconds,
      aspect_ratio: balanceEvidence.aspect_ratio,
      resolution: balanceEvidence.resolution,
      dom_snapshot_sha256: balanceEvidence.dom_snapshot_sha256,
      evidence_file_sha256: sha256Buffer(balanceEvidenceBytes),
    },
    estimated_charge_usd: manifest.contract.estimatedPerShotUsd,
    prompt_sha256: sha256Buffer(buildShotPrompt(redrawLatinAmericanCase, shotNumber)),
    started_at: new Date().toISOString(),
  }
  manifest.tasks.push(task)
  writeManifest(options.stateRoot, manifest)
  const runtimeSecrets = readRuntimeSecrets(options.stateRoot)
  runtimeSecrets.identity_references ||= {}
  manifest.references.identities ||= {}
  let motionReference
  try {
    for (const identityId of identityIds) {
      if (!manifest.references.identities[identityId]) {
        const identityPack = manifest.reference_gate.identities.find(
          (item) => item.source_character_key === identityId,
        )
        const uploadedIdentity = await uploadReference(
          apiKey,
          path.join(options.stateRoot, 'runtime', 'identities', `${identityId}.png`),
          'image/png',
        )
        runtimeSecrets.identity_references[identityId] = {
          url: uploadedIdentity.url,
          asset_id: uploadedIdentity.asset_id,
          sha256: uploadedIdentity.sha256,
          pack_sha256: identityPack.pack_sha256,
        }
        const { url: _identityUrl, ...identityEvidence } = uploadedIdentity
        manifest.references.identities[identityId] = identityEvidence
        writeRuntimeSecrets(options.stateRoot, runtimeSecrets)
        writeManifest(options.stateRoot, manifest)
      }
    }
    const motionPath = path.join(options.stateRoot, 'motion', `shot-${String(shotNumber).padStart(2, '0')}-motion.mp4`)
    motionReference = await uploadReference(apiKey, motionPath, 'video/mp4')
  } catch (error) {
    task.status = String(error.code || '').includes('UNKNOWN') ? 'needs_attention' : 'failed'
    task.error_code = error.code || 'FUMIN_FULL_EPISODE_REFERENCE_UPLOAD_FAILED'
    writeManifest(options.stateRoot, manifest)
    throw error
  }
  writeRuntimeSecrets(options.stateRoot, runtimeSecrets)
  writeManifest(options.stateRoot, manifest)
  const identityUrls = identityIds.map((identityId) => validateRuntimeIdentityReference(
    runtimeSecrets.identity_references[identityId],
    manifest.references.identities[identityId],
    manifest.reference_gate.identities.find((item) => item.source_character_key === identityId),
  ))
  Object.assign(task, {
    status: 'submission_started',
    identity_references: identityIds.map((identityId) => ({
      source_character_key: identityId,
      ...manifest.references.identities[identityId],
    })),
    motion_reference: {
      asset_id: motionReference.asset_id,
      sha256: motionReference.sha256,
      bytes: motionReference.bytes,
    },
  })
  writeManifest(options.stateRoot, manifest)
  const body = buildFuminVideoBody({
    model: manifest.generation.model,
    prompt: buildShotPrompt(redrawLatinAmericanCase, shotNumber),
    duration: manifest.generation.duration_seconds,
    resolution: manifest.generation.resolution,
    aspect_ratio: manifest.generation.aspect_ratio,
    generate_audio: true,
    reference_urls: identityUrls,
    reference_video_urls: [motionReference.url],
  })
  let submitted
  try {
    submitted = await submitGeneration(apiKey, body)
  } catch (error) {
    task.status = error.code === 'FUMIN_FULL_EPISODE_SUBMISSION_UNKNOWN' ? 'submission_unknown' : 'failed'
    task.error_code = error.code || 'FUMIN_FULL_EPISODE_SUBMISSION_FAILED'
    writeManifest(options.stateRoot, manifest)
    throw error
  }
  task.task_id = submitted.task_id || null
  task.status = 'provider_processing'
  writeManifest(options.stateRoot, manifest)
  let videoUrl = submitted.video_url
  try {
    if (!videoUrl) videoUrl = await pollGeneration(apiKey, submitted.task_id)
  } catch (error) {
    task.status = error.code?.includes('UNKNOWN') || error.code?.includes('TIMEOUT') ? 'needs_attention' : 'failed'
    task.error_code = error.code || 'FUMIN_FULL_EPISODE_STATUS_FAILED'
    writeManifest(options.stateRoot, manifest)
    throw error
  }
  const artifactsRoot = path.join(options.stateRoot, 'artifacts')
  const videoPath = path.join(artifactsRoot, `shot-${String(shotNumber).padStart(2, '0')}.mp4`)
  const contactSheetPath = path.join(artifactsRoot, `shot-${String(shotNumber).padStart(2, '0')}-contact-sheet.jpg`)
  try {
    const artifact = await downloadResult(videoUrl, videoPath)
    const probe = probeMedia(videoPath)
    validateGeneratedMedia(probe)
    const transcripts = transcribeEnglishConsensus(videoPath, options.verifierPython)
    const speech = verifyTranscriptConsensus(redrawLatinAmericanCase, shotNumber, transcripts)
    createContactSheet(videoPath, contactSheetPath)
    Object.assign(task, {
      status: 'awaiting_human_review',
      completed_at: new Date().toISOString(),
      artifact: { ...artifact, artifact_id: path.basename(videoPath), ffprobe: probe },
      contact_sheet_id: path.basename(contactSheetPath),
      speech,
    })
    writeManifest(options.stateRoot, manifest)
    atomicJson(path.join(options.stateRoot, `shot-${String(shotNumber).padStart(2, '0')}-public-evidence.json`), publicEvidence(task))
    return publicEvidence(task)
  } catch (error) {
    task.status = 'failed'
    task.error_code = error.code || 'FUMIN_FULL_EPISODE_VERIFICATION_FAILED'
    writeManifest(options.stateRoot, manifest)
    throw error
  }
}

function runReview(options) {
  const manifest = readManifest(options.stateRoot)
  const shotNumber = Number(options.shot)
  const task = manifest.tasks.find((item) => item.shot_number === shotNumber)
  if (!task || task.status !== 'awaiting_human_review') fail('FUMIN_FULL_EPISODE_REVIEW_NOT_READY')
  if (!['pass', 'fail'].includes(options.decision)) fail('FUMIN_FULL_EPISODE_REVIEW_DECISION_INVALID')
  task.human_review = {
    reviewer: String(options.reviewer || 'codex-visual-review'),
    decision: options.decision,
    notes: String(options.notes || ''),
    reviewed_at: new Date().toISOString(),
  }
  task.status = options.decision === 'pass' ? 'completed_verified' : 'failed'
  writeManifest(options.stateRoot, manifest)
  atomicJson(path.join(options.stateRoot, `shot-${String(shotNumber).padStart(2, '0')}-public-evidence.json`), publicEvidence(task))
  return publicEvidence(task)
}

function runFinalize(options) {
  const manifest = readManifest(options.stateRoot)
  assertFinalizeReady(manifest)
  const artifactsRoot = path.join(options.stateRoot, 'artifacts')
  const concatPath = path.join(options.stateRoot, 'concat.txt')
  const shotPaths = manifest.tasks.map((task) => path.join(
    artifactsRoot,
    `shot-${String(task.shot_number).padStart(2, '0')}.mp4`,
  ))
  fs.writeFileSync(concatPath, buildConcatList(shotPaths))
  const episodePath = path.join(artifactsRoot, 'redraw-fumin-full-episode.mp4')
  runProcess(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-y', episodePath,
  ], 'FUMIN_FULL_EPISODE_FINALIZE_FAILED', { timeout: 30 * 60 * 1_000 })
  const probe = probeMedia(episodePath)
  if (!probe.has_audio || probe.duration_seconds < 64.8 || probe.duration_seconds > 79.2) {
    fail('FUMIN_FULL_EPISODE_FINAL_OUTPUT_INVALID')
  }
  manifest.status = 'completed_verified'
  manifest.final_artifact = {
    artifact_id: path.basename(episodePath),
    sha256: sha256File(episodePath),
    bytes: fs.statSync(episodePath).size,
    ffprobe: probe,
  }
  writeManifest(options.stateRoot, manifest)
  const evidence = publicEvidence(manifest)
  atomicJson(path.join(options.stateRoot, 'public-final-evidence.json'), evidence)
  return evidence
}

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) fail('FUMIN_FULL_EPISODE_ARGUMENT_INVALID', item)
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const value = argv[index + 1]
    if (value == null || value.startsWith('--')) fail('FUMIN_FULL_EPISODE_ARGUMENT_VALUE_MISSING', item)
    options[key] = value
    index += 1
  }
  for (const key of [
    'stateRoot', 'sourceState', 'source', 'identity', 'keyFile', 'verifierPython', 'balanceEvidence',
  ]) {
    if (options[key]) options[key] = path.resolve(options[key])
  }
  if (options.expectedSourceManifestSha256) {
    options.expectedSourceManifestSha256 = String(options.expectedSourceManifestSha256).toLowerCase()
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.stage || !options.stateRoot) fail('FUMIN_FULL_EPISODE_STAGE_OR_STATE_MISSING')
  let result
  if (options.stage === 'derive') {
    if (!options.sourceState || !options.expectedSourceManifestSha256 || !options.verifierPython) {
      fail('FUMIN_DERIVE_ARGUMENT_MISSING')
    }
    assertStateOutsideRepository(options.sourceState)
    assertStateOutsideRepository(options.stateRoot)
    result = deriveFuminFullEpisodeState({
      sourceStateRoot: options.sourceState,
      targetStateRoot: options.stateRoot,
      expectedSourceManifestSha256: options.expectedSourceManifestSha256,
      verifierPython: options.verifierPython,
    }, {
      now: () => new Date(),
      sha256Buffer,
      sha256File,
      publicEvidence,
      revalidateShot4: (context) => revalidateDerivedShot4(context, options.verifierPython),
    })
  } else if (options.stage === 'preflight') result = await runPreflight(options)
  else if (options.stage === 'shot') result = await runShot(options)
  else if (options.stage === 'review') result = runReview(options)
  else if (options.stage === 'finalize') result = runFinalize(options)
  else fail('FUMIN_FULL_EPISODE_STAGE_INVALID', options.stage)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.code || error?.message || 'FUMIN_FULL_EPISODE_FAILED'))
    process.exitCode = 1
  })
}
