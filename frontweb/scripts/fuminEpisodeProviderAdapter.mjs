import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

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

export function validateGeneratedMediaForPack(pack, probe) {
  if (probe.width !== 496 || probe.height !== 864) {
    fail('FUMIN_EPISODE_OUTPUT_DIMENSIONS_INVALID', `${probe.width}x${probe.height}`)
  }
  const expectedSeconds = Number(pack?.duration_ms || 5000) / 1000
  if (Math.abs(Number(probe.duration_seconds) - expectedSeconds) > 1.0) {
    fail('FUMIN_EPISODE_OUTPUT_DURATION_INVALID', String(probe.duration_seconds))
  }
  if (pack?.audio_contract?.speech_required !== false && !probe.has_audio) {
    fail('FUMIN_EPISODE_OUTPUT_AUDIO_MISSING')
  }
  return { ...probe, media_passed: true }
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

export function verifyTranscriptConsensusForPack(pack, transcripts) {
  if (!Array.isArray(transcripts) || transcripts.length !== ASR_MODEL_IDS.length) {
    fail('FUMIN_EPISODE_ASR_CONSENSUS_UNAVAILABLE')
  }
  const byModel = new Map(transcripts.map((transcript) => [transcript?.model_id, transcript]))
  if (ASR_MODEL_IDS.some((modelId) => !byModel.has(modelId))) {
    fail('FUMIN_EPISODE_ASR_CONSENSUS_UNAVAILABLE')
  }
  const ordered = ASR_MODEL_IDS.map((modelId) => byModel.get(modelId))
  const expected = targetDialogue(pack)
  const speechRequired = pack?.audio_contract?.speech_required !== false && expected.length > 0
  const actuals = ordered.map((transcript) => normalizedWords(transcript?.text))
  if (!speechRequired) {
    const speech = actuals.find(Boolean)
    if (speech) fail('FUMIN_EPISODE_SILENT_SHOT_HAS_SPEECH', speech)
    return { speech_required: false, consensus_passed: true, exact_dialogue_present: true, models: ordered }
  }
  for (const transcript of ordered) {
    if (String(transcript.language || '').toLowerCase() !== 'en' || Number(transcript.probability) < 0.8) {
      fail('FUMIN_EPISODE_TARGET_LANGUAGE_FAILED', transcript.model_id)
    }
  }
  for (const expectedLine of expected.map(normalizedWords)) {
    if (!actuals.every((actual) => actual.includes(expectedLine))) {
      fail('FUMIN_EPISODE_EXACT_DIALOGUE_FAILED', expectedLine)
    }
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

function buildPrompt(pack) {
  return [
    String(pack.prompt || '').trim(),
    'Create one vertical 9:16 cinematic live-action shot at 480p.',
    'Use only the supplied identity and motion references.',
    'Generate synchronized target-language audio exactly matching the approved dialogue when speech is required.',
    'Do not add subtitles, captions, watermarks, logos, Chinese text, or unapproved dialogue.',
  ].filter(Boolean).join('\n')
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
    async submitGeneration({ pack, uploaded_references }) {
      if (!apiKey) fail('FUMIN_EPISODE_API_KEY_MISSING')
      const body = {
        model: FUMIN_MODEL,
        prompt: buildPrompt(pack),
        duration: Math.round(Number(pack.duration_ms || 5000) / 1000),
        resolution: '480p',
        aspect_ratio: '9:16',
        generate_audio: pack?.audio_contract?.speech_required !== false,
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
    async inspectArtifact({ output_path, pack }) {
      const media = validateGeneratedMediaForPack(pack, probeMediaWithFfprobe(output_path, options))
      const transcripts = options.transcribeConsensus
        ? await options.transcribeConsensus(output_path, verifierPython)
        : transcribeEnglishConsensus(output_path, verifierPython, options)
      const speech = verifyTranscriptConsensusForPack(pack, transcripts)
      if (options.createContactSheet) {
        options.createContactSheet(output_path, `${output_path}.contact-sheet.jpg`)
      }
      return {
        media,
        language: { locale: pack?.audio_contract?.locale || 'en-US', passed: true },
        role: { characters: (pack?.characters || []).map((item) => item.id).filter(Boolean), passed: true },
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
