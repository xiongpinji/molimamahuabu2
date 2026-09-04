import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildFuminEpisodeExecutionPlan } from './fuminEpisodeExecutionPlan.mjs'
import {
  materializeFuminExecutionMotion,
  validateFuminExecutionMotionProbe,
} from './fuminExecutionMotion.mjs'

const FUMIN_BASE_URL = 'https://fumin.ai'
const FUMIN_MODEL = 'fumin-seedance-2.0-mini'
export const ASR_MODEL_IDS = ['Systran/faster-whisper-base', 'Systran/faster-whisper-small']
const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../backend-node/', import.meta.url))

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function fail(code, message) {
  throw codedError(code, message)
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath))
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalHash(value, omittedKey) {
  const copy = JSON.parse(JSON.stringify(value))
  if (omittedKey) delete copy[omittedKey]
  return sha256Buffer(canonicalJson(copy))
}

function normalizedWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function targetDialogue(pack) {
  return (Array.isArray(pack?.dialogue) ? pack.dialogue : [])
    .map((turn) => String(turn.text || turn.localized_text || '').trim())
    .filter(Boolean)
}

async function responseJson(response) {
  const raw = await response.text()
  try { return JSON.parse(raw) } catch { return null }
}

function pick(value, paths) {
  for (const parts of paths) {
    let current = value
    for (const part of parts) current = current?.[part]
    if (current != null && current !== '') return current
  }
  return null
}

function parseSubmission(payload) {
  const taskId = pick(payload, [['id'], ['task_id'], ['data', 'id'], ['data', 'task_id']])
  if (!taskId) fail('FUMIN_EPISODE_SUBMISSION_ID_MISSING')
  return { task_id: String(taskId) }
}

function parseStatus(payload) {
  const raw = String(pick(payload, [['status'], ['state'], ['data', 'status'], ['data', 'state']]) || '').toLowerCase()
  const videoUrl = pick(payload, [
    ['video_url'],
    ['url'],
    ['output', 'video_url'],
    ['data', 'video_url'],
    ['data', 'url'],
    ['data', 'output', 'video_url'],
  ])
  if (/success|succeed|completed|finished/.test(raw)) {
    if (!/^https:\/\//i.test(String(videoUrl || ''))) fail('FUMIN_EPISODE_RESULT_URL_MISSING')
    return { state: 'completed', video_url: String(videoUrl) }
  }
  if (/fail|error|reject|cancel/.test(raw)) {
    fail('FUMIN_EPISODE_PROVIDER_FAILED', raw)
  }
  return { state: 'running' }
}

function runProcess(command, args, code, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 120_000,
    env: options.env || process.env,
  })
  if (result.error || result.status !== 0) {
    fail(code, result.error?.message || result.stderr || `exit ${result.status}`)
  }
  return result.stdout
}

function defaultFfmpegPath() {
  try {
    return require(path.join(backendRoot, 'src', 'utils', 'ffmpegPath')).getFfmpegPath()
  } catch {
    return process.env.FFMPEG_PATH || 'ffmpeg'
  }
}

function quoteConcatPath(filePath) {
  return String(path.resolve(filePath)).replace(/\\/g, '/').replace(/'/g, "'\\''")
}

function writeConcatList(shotPaths, outputPath) {
  const listPath = path.join(path.dirname(outputPath), `concat-${process.pid}-${Date.now()}.txt`)
  const lines = shotPaths.map((shotPath) => `file '${quoteConcatPath(shotPath)}'`)
  fs.writeFileSync(listPath, `${lines.join('\n')}\n`, { flag: 'wx' })
  return listPath
}

export function probeMediaWithFfprobe(filePath, adapters = {}) {
  const output = (adapters.runProcess || runProcess)(
    adapters.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
    'FUMIN_EPISODE_FFPROBE_FAILED',
  )
  const payload = JSON.parse(output)
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  if (!video) fail('FUMIN_EPISODE_VIDEO_STREAM_MISSING')
  const rotation = Number(
    video.tags?.rotate
      ?? video.side_data_list?.find((item) => item?.rotation != null)?.rotation
      ?? 0,
  )
  return {
    duration_seconds: Number(payload.format?.duration),
    width: Number(video.width),
    height: Number(video.height),
    video_codec: String(video.codec_name || ''),
    has_audio: Boolean(audio),
    audio_codec: String(audio?.codec_name || ''),
    audio_channels: Number(audio?.channels || 0),
    rotation: Number.isFinite(rotation) ? rotation : 0,
  }
}

export function validateGeneratedMediaForUnit(unit, probe) {
  const expectedSeconds = Number(unit?.provider_duration_seconds)
  if (expectedSeconds !== 5) fail('FUMIN_EPISODE_PROVIDER_DURATION_INVALID')
  if (!String(probe?.video_codec || '').trim()
    || !Number.isFinite(Number(probe?.width))
    || !Number.isFinite(Number(probe?.height))) {
    fail('FUMIN_EPISODE_OUTPUT_VIDEO_MISSING')
  }
  const quarterTurn = Math.abs(Number(probe.rotation || 0)) % 180 === 90
  const displayWidth = quarterTurn ? Number(probe.height) : Number(probe.width)
  const displayHeight = quarterTurn ? Number(probe.width) : Number(probe.height)
  if (![480, 496].includes(displayWidth) || displayHeight !== 864) {
    fail('FUMIN_EPISODE_OUTPUT_DIMENSIONS_INVALID', `${probe.width}x${probe.height}`)
  }
  if (!Number.isFinite(Number(probe.duration_seconds))
    || Math.abs(Number(probe.duration_seconds) - expectedSeconds) > 0.1) {
    fail('FUMIN_EPISODE_OUTPUT_DURATION_INVALID', String(probe.duration_seconds))
  }
  if (!probe.has_audio) fail('FUMIN_EPISODE_OUTPUT_AUDIO_MISSING')
  return { ...probe, media_passed: true }
}

export function validateGeneratedMediaForPack(pack, probe) {
  return validateGeneratedMediaForUnit(pack, probe)
}

export function transcribeEnglish(filePath, pythonPath, modelId = ASR_MODEL_IDS[0], adapters = {}) {
  if (!pythonPath || !fs.existsSync(pythonPath)) fail('FUMIN_EPISODE_VERIFIER_PYTHON_MISSING')
  if (!ASR_MODEL_IDS.includes(modelId)) fail('FUMIN_EPISODE_ASR_MODEL_INVALID', modelId)
  const code = [
    'import json,sys',
    'from faster_whisper import WhisperModel',
    'model_id=sys.argv[2]',
    'm=WhisperModel(model_id,device="cpu",compute_type="int8",local_files_only=True)',
    'segments,info=m.transcribe(sys.argv[1],beam_size=5,vad_filter=True)',
    'print(json.dumps({"model_id":model_id,"language":info.language,"probability":info.language_probability,"text":" ".join(s.text.strip() for s in segments).strip()},ensure_ascii=False))',
  ].join(';')
  const stdout = (adapters.runProcess || runProcess)(pythonPath, ['-c', code, filePath, modelId], 'FUMIN_EPISODE_ASR_FAILED', {
    timeout: 12 * 60_000,
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  })
  return JSON.parse(stdout)
}

export function transcribeEnglishConsensus(filePath, pythonPath, adapters = {}) {
  return ASR_MODEL_IDS.map((modelId) => transcribeEnglish(filePath, pythonPath, modelId, adapters))
}

export function verifyTranscriptConsensusForUnit(unit, transcripts) {
  if (!Array.isArray(transcripts) || transcripts.length !== ASR_MODEL_IDS.length) {
    fail('FUMIN_EPISODE_ASR_CONSENSUS_UNAVAILABLE')
  }
  const byModel = new Map(transcripts.map((transcript) => [transcript?.model_id, transcript]))
  if (byModel.size !== ASR_MODEL_IDS.length || ASR_MODEL_IDS.some((modelId) => !byModel.has(modelId))) {
    fail('FUMIN_EPISODE_ASR_CONSENSUS_UNAVAILABLE')
  }
  const ordered = ASR_MODEL_IDS.map((modelId) => byModel.get(modelId))
  const expected = targetDialogue(unit)
  const speechRequired = expected.length > 0
  const actuals = ordered.map((transcript) => normalizedWords(transcript?.text))
  if (!speechRequired) {
    const speech = actuals.find(Boolean)
    if (speech) fail('FUMIN_EPISODE_UNAPPROVED_DIALOGUE', speech)
    return { speech_required: false, consensus_passed: true, exact_dialogue_present: true, models: ordered }
  }
  const locale = String(unit?.locale || unit?.audio_contract?.locale || 'en-US')
  if (locale !== 'en-US') fail('FUMIN_EPISODE_TARGET_LOCALE_FAILED', locale)
  for (const transcript of ordered) {
    const probability = Number(transcript.probability)
    if (String(transcript.language || '').toLowerCase() !== 'en'
      || !Number.isFinite(probability) || probability < 0.8) {
      fail('FUMIN_EPISODE_TARGET_LANGUAGE_FAILED', transcript.model_id)
    }
  }
  if (!actuals[0] || actuals[0] !== actuals[1]) fail('FUMIN_EPISODE_ASR_CONSENSUS_FAILED')
  const approved = normalizedWords(expected.join(' '))
  if (actuals[0] !== approved) {
    if (actuals[0].startsWith(`${approved} `)) fail('FUMIN_EPISODE_UNAPPROVED_DIALOGUE', actuals[0])
    fail('FUMIN_EPISODE_EXACT_DIALOGUE_FAILED', approved)
  }
  return {
    speech_required: true,
    consensus_passed: true,
    exact_dialogue_present: true,
    target_dialogue: expected,
    models: ordered.map((transcript) => ({
      model_id: transcript.model_id,
      detected_language: transcript.language,
      detected_language_probability: Number(transcript.probability),
      transcript: transcript.text,
    })),
  }
}

export function verifyTranscriptConsensusForPack(pack, transcripts) {
  return verifyTranscriptConsensusForUnit(pack, transcripts)
}

function buildPrompt(pack) {
  return [
    String(pack.prompt || '').trim(),
    'Create one vertical 9:16 cinematic live-action shot at 480p.',
    'Use only the supplied identity and motion references.',
    'Generate synchronized target-language audio exactly matching the approved dialogue when speech is required.',
    'Do not add subtitles, captions, watermarks, logos, Chinese text, or unapproved dialogue.',
  ].filter(Boolean).join('\n')
}

function sameOrInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertPathHasNoSymlink(targetPath) {
  const resolved = path.resolve(targetPath)
  const root = path.parse(resolved).root
  let current = root
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail('FUMIN_EPISODE_STATE_SYMLINK_REJECTED', current)
    }
  }
  return resolved
}

function safeStateRoot(stateDir, pkg) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    fail('FUMIN_EPISODE_STATE_PATH_INVALID')
  }
  const stateRoot = assertPathHasNoSymlink(stateDir)
  const inputs = [
    pkg?.package_path,
    pkg?.source_media?.path,
    ...(Array.isArray(pkg?.identity_references) ? pkg.identity_references.map((item) => item?.path) : []),
    ...(Array.isArray(pkg?.motion_references) ? pkg.motion_references.map((item) => item?.path) : []),
  ].filter((item) => typeof item === 'string' && path.isAbsolute(item))
  for (const input of inputs) {
    const resolvedInput = path.resolve(input)
    if (sameOrInside(stateRoot, resolvedInput) || sameOrInside(resolvedInput, stateRoot)) {
      fail('FUMIN_EPISODE_STATE_OVERLAPS_INPUT', input)
    }
  }
  return stateRoot
}

function motionArtifactId(unitId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(String(unitId))
    || String(unitId).includes('..') || String(unitId).endsWith('.')) {
    fail('FUMIN_EPISODE_UNIT_ID_UNSAFE', unitId)
  }
  return `provider/fumin/motion/${unitId}.mp4`
}

function artifactPath(stateRoot, artifactId) {
  if (typeof artifactId !== 'string' || path.posix.isAbsolute(artifactId)
    || artifactId.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('FUMIN_EPISODE_MOTION_ARTIFACT_ID_INVALID')
  }
  const outputPath = path.resolve(stateRoot, ...artifactId.split('/'))
  if (!sameOrInside(stateRoot, outputPath)) fail('FUMIN_EPISODE_STATE_PATH_ESCAPE')
  return outputPath
}

function withMaterializedEvidence(basePlan, evidenceByUnit) {
  const plan = JSON.parse(JSON.stringify(basePlan))
  delete plan.execution_plan_hash
  plan.units = plan.units.map((baseUnit) => {
    const unit = { ...baseUnit, materialized_motion: evidenceByUnit.get(baseUnit.unit_id) }
    delete unit.unit_hash
    unit.unit_hash = canonicalHash(unit)
    return unit
  })
  plan.execution_plan_hash = canonicalHash(plan)
  return plan
}

function receiptPath(stateRoot) {
  return path.join(stateRoot, 'provider', 'fumin', 'execution-plan.json')
}

function probeMaterializedMotion(filePath, adapters) {
  const stdout = (adapters.runProcess || runProcess)(
    adapters.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
    'FUMIN_EXECUTION_MOTION_FFPROBE_FAILED',
  )
  let raw
  try { raw = JSON.parse(stdout) } catch { fail('FUMIN_EXECUTION_MOTION_FFPROBE_INVALID') }
  return validateFuminExecutionMotionProbe(raw)
}

function validateReceiptHashes(plan) {
  if (!plan || !Array.isArray(plan.units)
    || canonicalHash(plan, 'execution_plan_hash') !== plan.execution_plan_hash) {
    fail('FUMIN_EPISODE_PLAN_DRIFT')
  }
  for (const unit of plan.units) {
    if (canonicalHash(unit, 'unit_hash') !== unit.unit_hash) fail('FUMIN_EPISODE_PLAN_DRIFT')
  }
}

function prepareFuminEpisode(pkg, stateDir, mode, adapters) {
  if (mode !== 'materialize' && mode !== 'verify') fail('FUMIN_EPISODE_PREPARE_MODE_INVALID', mode)
  const stateRoot = safeStateRoot(stateDir, pkg)
  const basePlan = buildFuminEpisodeExecutionPlan(pkg)
  const packs = new Map(pkg.production_packs.map((pack) => [pack.shot_id, pack]))
  const motions = Array.isArray(pkg.motion_references) ? pkg.motion_references : []
  const planReceipt = receiptPath(stateRoot)

  if (mode === 'materialize') {
    if (fs.existsSync(planReceipt)) fail('FUMIN_EPISODE_PREPARE_OUTPUT_EXISTS', planReceipt)
    const work = basePlan.units.map((unit) => {
      const pack = packs.get(unit.parent_shot_id)
      const matches = motions.filter((item) => String(item.shot_id) === unit.parent_shot_id)
      if (!pack || matches.length !== 1 || !unit.motion_reference_id) {
        fail('FUMIN_EPISODE_MOTION_REFERENCE_MISSING', unit.unit_id)
      }
      const sourcePath = matches[0].path
      if (!sourcePath || !fs.existsSync(sourcePath) || fs.lstatSync(sourcePath).isSymbolicLink()
        || !fs.lstatSync(sourcePath).isFile()) {
        fail('FUMIN_EPISODE_MOTION_REFERENCE_MISSING', unit.unit_id)
      }
      if (sha256File(sourcePath) !== String(matches[0].sha256 || '').toLowerCase()) {
        fail('FUMIN_EPISODE_MOTION_REFERENCE_HASH_MISMATCH', unit.unit_id)
      }
      const artifactId = motionArtifactId(unit.unit_id)
      const outputPath = artifactPath(stateRoot, artifactId)
      if (fs.existsSync(outputPath)) fail('FUMIN_EPISODE_PREPARE_OUTPUT_EXISTS', artifactId)
      return { unit, pack, sourcePath, artifactId, outputPath }
    })
    const evidenceByUnit = new Map()
    for (const item of work) {
      const created = materializeFuminExecutionMotion({
        sourcePath: item.sourcePath,
        outputPath: item.outputPath,
        offsetMs: item.unit.source_start_ms - item.pack.start_ms,
        keepDurationMs: item.unit.keep_duration_ms,
        providerDurationSeconds: item.unit.provider_duration_seconds,
      }, adapters)
      evidenceByUnit.set(item.unit.unit_id, {
        artifact_id: item.artifactId,
        sha256: created.sha256,
        duration_seconds: created.duration_seconds,
        probe: created.probe,
      })
    }
    const plan = withMaterializedEvidence(basePlan, evidenceByUnit)
    fs.mkdirSync(path.dirname(planReceipt), { recursive: true })
    fs.writeFileSync(planReceipt, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return plan
  }

  if (!fs.existsSync(planReceipt) || fs.lstatSync(planReceipt).isSymbolicLink()
    || !fs.lstatSync(planReceipt).isFile()) {
    fail('FUMIN_EPISODE_PLAN_RECEIPT_MISSING')
  }
  let receipt
  try { receipt = JSON.parse(fs.readFileSync(planReceipt, 'utf8')) } catch { fail('FUMIN_EPISODE_PLAN_DRIFT') }
  validateReceiptHashes(receipt)
  if (receipt.units.length !== basePlan.units.length
    || receipt.units.some((unit, index) => unit.unit_id !== basePlan.units[index].unit_id)) {
    fail('FUMIN_EPISODE_PLAN_DRIFT')
  }
  const evidenceByUnit = new Map()
  for (const unit of basePlan.units) {
    const sourceMatches = motions.filter((item) => String(item.shot_id) === unit.parent_shot_id)
    if (sourceMatches.length !== 1 || !sourceMatches[0].path
      || !fs.existsSync(sourceMatches[0].path)
      || fs.lstatSync(sourceMatches[0].path).isSymbolicLink()
      || !fs.lstatSync(sourceMatches[0].path).isFile()) {
      fail('FUMIN_EPISODE_MOTION_REFERENCE_MISSING', unit.unit_id)
    }
    if (sha256File(sourceMatches[0].path) !== String(sourceMatches[0].sha256 || '').toLowerCase()) {
      fail('FUMIN_EPISODE_MOTION_REFERENCE_HASH_MISMATCH', unit.unit_id)
    }
    const expected = receipt.units.find((item) => item.unit_id === unit.unit_id)?.materialized_motion
    const artifactId = motionArtifactId(unit.unit_id)
    if (!expected || expected.artifact_id !== artifactId) fail('FUMIN_EPISODE_PLAN_DRIFT')
    const outputPath = artifactPath(stateRoot, artifactId)
    if (!fs.existsSync(outputPath) || fs.lstatSync(outputPath).isSymbolicLink()
      || !fs.lstatSync(outputPath).isFile()) {
      fail('FUMIN_EPISODE_MOTION_MISSING', artifactId)
    }
    if (sha256File(outputPath) !== expected.sha256) {
      fail('FUMIN_EPISODE_MOTION_HASH_MISMATCH', artifactId)
    }
    const probe = probeMaterializedMotion(outputPath, adapters)
    evidenceByUnit.set(unit.unit_id, {
      artifact_id: artifactId,
      sha256: expected.sha256,
      duration_seconds: probe.duration_seconds,
      probe,
    })
  }
  const verified = withMaterializedEvidence(basePlan, evidenceByUnit)
  if (canonicalJson(verified) !== canonicalJson(receipt)) fail('FUMIN_EPISODE_PLAN_DRIFT')
  return verified
}

function safeReference(reference) {
  const bytes = Buffer.isBuffer(reference?.bytes) ? reference.bytes : fs.readFileSync(reference?.path)
  const actual = sha256Buffer(bytes)
  if (actual !== String(reference?.sha256 || '').toLowerCase()) {
    fail('FUMIN_EPISODE_REFERENCE_HASH_MISMATCH')
  }
  return {
    id: String(reference.id || ''),
    kind: String(reference.kind || ''),
    path: reference.path,
    mime_type: reference.mime_type || 'application/octet-stream',
    bytes,
    sha256: actual,
  }
}

export function createFuminEpisodeProviderAdapter(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const apiKey = options.apiKey || process.env.FUMIN_API_KEY
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const verifierPython = options.verifierPython || process.env.REDRAW_VERIFIER_PYTHON
  if (typeof fetchImpl !== 'function') fail('FUMIN_EPISODE_FETCH_UNAVAILABLE')

  return {
    name: 'fumin',
    async prepareEpisode(input) {
      return prepareFuminEpisode(input?.package, input?.state_dir, input?.mode, options)
    },
    async uploadReference(reference) {
      if (!apiKey) fail('FUMIN_EPISODE_API_KEY_MISSING')
      const safe = safeReference(reference)
      const form = new FormData()
      form.append('file', new Blob([safe.bytes], { type: safe.mime_type }), path.basename(safe.path))
      let response
      try {
        response = await fetchImpl(`${FUMIN_BASE_URL}/api/v3/files/uploads?volc_asset=true`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(180_000),
        })
      } catch (error) {
        fail('FUMIN_EPISODE_REFERENCE_UPLOAD_UNKNOWN', error.message)
      }
      const payload = await responseJson(response)
      if (!response.ok) fail('FUMIN_EPISODE_REFERENCE_UPLOAD_REJECTED', `HTTP ${response.status}`)
      const assetId = pick(payload, [['id'], ['file_id'], ['data', 'id'], ['data', 'file_id']])
      const url = pick(payload, [['url'], ['data', 'url'], ['file', 'url'], ['data', 'file', 'url']])
      if (!assetId) fail('FUMIN_EPISODE_REFERENCE_UPLOAD_ID_MISSING')
      if (!/^https:\/\//i.test(String(url || ''))) fail('FUMIN_EPISODE_REFERENCE_URL_INVALID')
      return { asset_id: String(assetId), sha256: safe.sha256, bytes: safe.bytes.length, mime_type: safe.mime_type, reference_id: safe.id }
    },
    async submitGeneration({ pack, unit, uploaded_references = [] }) {
      if (!apiKey) fail('FUMIN_EPISODE_API_KEY_MISSING')
      const planned = unit || pack
      if (Number(planned?.provider_duration_seconds) !== 5) {
        fail('FUMIN_EPISODE_PROVIDER_DURATION_INVALID')
      }
      const body = {
        model: FUMIN_MODEL,
        prompt: buildPrompt(planned),
        duration: 5,
        resolution: '480p',
        aspect_ratio: '9:16',
        generate_audio: true,
        references: uploaded_references.map((item) => ({
          asset_id: item.asset_id,
          mime_type: item.mime_type,
          reference_id: item.reference_id,
        })),
      }
      let response
      try {
        response = await fetchImpl(`${FUMIN_BASE_URL}/api/v3/contents/generations/tasks`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        })
      } catch (error) {
        fail('FUMIN_EPISODE_SUBMISSION_UNKNOWN', error.message)
      }
      const payload = await responseJson(response)
      if (!response.ok) fail('FUMIN_EPISODE_SUBMISSION_REJECTED', `HTTP ${response.status}`)
      return parseSubmission(payload)
    },
    async pollGeneration({ task_id }) {
      if (!apiKey) fail('FUMIN_EPISODE_API_KEY_MISSING')
      const deadline = Date.now() + 30 * 60_000
      while (Date.now() < deadline) {
        let response
        try {
          response = await fetchImpl(`${FUMIN_BASE_URL}/api/v3/contents/generations/tasks/${encodeURIComponent(task_id)}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(30_000),
          })
        } catch (error) {
          fail('FUMIN_EPISODE_STATUS_UNKNOWN', error.message)
        }
        const payload = await responseJson(response)
        if (!response.ok) fail('FUMIN_EPISODE_STATUS_REJECTED', `HTTP ${response.status}`)
        const status = parseStatus(payload || {})
        if (status.state === 'completed') return status
        await sleep(5_000)
      }
      fail('FUMIN_EPISODE_STATUS_TIMEOUT')
    },
    async downloadResult({ video_url, output_path }) {
      let response
      try {
        response = await fetchImpl(video_url, { signal: AbortSignal.timeout(10 * 60_000) })
      } catch (error) {
        fail('FUMIN_EPISODE_RESULT_DOWNLOAD_UNKNOWN', error.message)
      }
      if (!response.ok) fail('FUMIN_EPISODE_RESULT_DOWNLOAD_REJECTED', `HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length < 1) fail('FUMIN_EPISODE_RESULT_TOO_SMALL')
      fs.mkdirSync(path.dirname(output_path), { recursive: true })
      fs.writeFileSync(output_path, bytes, { flag: 'wx' })
      return { path: output_path, sha256: sha256Buffer(bytes), bytes: bytes.length }
    },
    async inspectArtifact({ output_path, raw_path, pack, unit, parent_pack }) {
      const filePath = output_path || raw_path
      const planned = unit
        ? { ...unit, locale: unit.locale || parent_pack?.audio_contract?.locale || pack?.audio_contract?.locale || 'en-US' }
        : pack
      const media = validateGeneratedMediaForUnit(planned, probeMediaWithFfprobe(filePath, options))
      const transcripts = options.transcribeConsensus
        ? await options.transcribeConsensus(filePath, verifierPython)
        : transcribeEnglishConsensus(filePath, verifierPython, options)
      const speech = verifyTranscriptConsensusForUnit(planned, transcripts)
      if (options.createContactSheet) {
        options.createContactSheet(filePath, `${filePath}.contact-sheet.jpg`)
      }
      return {
        media,
        language: { locale: planned?.locale || planned?.audio_contract?.locale || parent_pack?.audio_contract?.locale || 'en-US', passed: true },
        role: { characters: (parent_pack?.characters || pack?.characters || []).map((item) => item.id).filter(Boolean), passed: true },
        dialogue: speech,
      }
    },
    async assembleEpisode({ shot_paths, output_path }) {
      fs.mkdirSync(path.dirname(output_path), { recursive: true })
      if (fs.existsSync(output_path)) fail('FUMIN_EPISODE_ASSEMBLE_OUTPUT_EXISTS', output_path)
      for (const shotPath of shot_paths) {
        if (!fs.existsSync(shotPath) || !fs.statSync(shotPath).isFile()) {
          fail('FUMIN_EPISODE_ASSEMBLE_INPUT_MISSING', shotPath)
        }
      }
      const listPath = writeConcatList(shot_paths, output_path)
      try {
        ;(options.runProcess || runProcess)(
          options.ffmpegPath || defaultFfmpegPath(),
          ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output_path],
          'FUMIN_EPISODE_ASSEMBLE_FFMPEG_FAILED',
        )
      } finally {
        fs.rmSync(listPath, { force: true })
      }
      if (!fs.existsSync(output_path)) fail('FUMIN_EPISODE_ASSEMBLE_OUTPUT_MISSING', output_path)
      const bytes = fs.readFileSync(output_path)
      if (bytes.length < 1) fail('FUMIN_EPISODE_ASSEMBLE_OUTPUT_EMPTY', output_path)
      return { path: output_path, sha256: sha256Buffer(bytes), bytes: bytes.length }
    },
    async inspectEpisode({ output_path }) {
      return { media: probeMediaWithFfprobe(output_path, options) }
    },
  }
}
