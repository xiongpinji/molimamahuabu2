import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { redrawLatinAmericanCase } from '../e2e/fixtures/redraw-latin-american-case.js'
import { assertPaidSubmissionAuthorization } from './toapisFullEpisodeGuard.mjs'

const require = createRequire(import.meta.url)
const { getFfmpegPath, getFfprobePath } = require(path.join(
  fileURLToPath(new URL('../../backend-node/', import.meta.url)),
  'src',
  'utils',
  'ffmpegPath',
))

const API_BASE = 'https://toapis.com'
const DEFAULT_KEY_FILE = 'C:/Users/canqu/Desktop/新建 文本文档 (4).txt'
const DEFAULT_SOURCE = 'C:/Users/canqu/Desktop/ac087bcd4cf5f856f85182834794853a.mp4'
const DEFAULT_GROUP_ID = 'pg_01KZWRZPKGMG5F91QCB55S6AWP'
const DEFAULT_IMAGE_ASSET_ID = 'pa_01KZWRZSMARJAPT66DS8KDCY0K'
const EXPECTED_SUBMISSIONS = 9
const REQUEST_DURATION_SECONDS = 8

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function redactMessage(body) {
  const candidate = body?.message || body?.error?.message || body?.error || body?.fail_reason
  return typeof candidate === 'string' ? candidate.slice(0, 300) : undefined
}

class UnknownResultError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownResultError'
    this.unknown = true
  }
}

class KnownApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'KnownApiError'
    this.status = status
    this.unknown = false
  }
}

async function requestJson(method, requestPath, key, { body, form, timeoutMs = 120_000 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  const init = { method, headers, signal: controller.signal }
  if (form) init.body = form
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(`${API_BASE}${requestPath}`, init)
  } catch (error) {
    throw new UnknownResultError(`${method} ${requestPath} 网络结果未知：${error?.message || error}`)
  } finally {
    clearTimeout(timeout)
  }
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new UnknownResultError(`${method} ${requestPath} 返回体不可解析`)
  }
  if (!response.ok) {
    throw new KnownApiError(
      `${method} ${requestPath} HTTP ${response.status}${redactMessage(payload) ? `: ${redactMessage(payload)}` : ''}`,
      response.status,
    )
  }
  return payload
}

function readKey(keyFile) {
  const raw = fs.readFileSync(keyFile, 'utf8')
  const match = raw.match(/sk-[A-Za-z0-9_-]+/)
  if (!match) throw new Error('本地 key 文件未找到 sk- token')
  return match[0]
}

function probe(filePath) {
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], { encoding: 'utf8', timeout: 60_000 })
  if (result.status !== 0) throw new Error(`FFprobe 失败：${result.stderr || result.error?.message || result.status}`)
  const raw = JSON.parse(result.stdout)
  const video = raw.streams?.find((stream) => stream.codec_type === 'video')
  const audio = raw.streams?.find((stream) => stream.codec_type === 'audio')
  return {
    duration_ms: Number(raw.format?.duration || 0) * 1000,
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    video_codec: video?.codec_name || null,
    frame_rate: video?.avg_frame_rate || null,
    audio_codec: audio?.codec_name || null,
    channels: Number(audio?.channels || 0),
    sample_rate: Number(audio?.sample_rate || 0),
    size_bytes: fs.statSync(filePath).size,
  }
}

function decode(filePath) {
  const result = spawnSync(getFfmpegPath(), ['-v', 'error', '-i', filePath, '-f', 'null', '-'], {
    encoding: 'utf8',
    timeout: 180_000,
  })
  return { ok: result.status === 0, stderr: (result.stderr || '').slice(0, 500) }
}

function promptForShot(shot) {
  const localized = redrawLatinAmericanCase.localization.dialogue.find((entry) => entry.shot_id === shot.id)
  const lines = (localized?.turns || []).map((turn) => {
    const cast = redrawLatinAmericanCase.cast.find((actor) => actor.id === turn.speaker_id)
    return `${cast?.target_name || turn.speaker_id}: “${turn.localized_text}”`
  })
  const base = redrawLatinAmericanCase.shotPrompts[shot.id]
  const dialogue = lines.length ? ` English dialogue in order: ${lines.join('; ')}.` : ' No dialogue.'
  const screen = shot.screen_text_status === 'manual_review'
    ? ' Preserve the source screen insert; do not invent or claim unreadable article/banner copy.'
    : ''
  return `${base}${dialogue}${screen} Use natural American English and a fictional adult foreign cast.`
}

async function pollAsset(assetId, key, attempts = 120) {
  const history = []
  for (let index = 0; index < attempts; index += 1) {
    let body
    try {
      body = await requestJson('GET', `/v1/videos/doubao-seedance-2-0/private-avatar/assets/${assetId}`, key)
    } catch (error) {
      if (error.unknown) {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        continue
      }
      throw error
    }
    const status = body?.data?.status || body?.status || 'unknown'
    history.push({ at: new Date().toISOString(), status })
    if (status === 'active' || status === 'failed') return { status, history }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  return { status: 'timeout', history }
}

async function pollGeneration(taskId, key, attempts = 120) {
  const history = []
  for (let index = 0; index < attempts; index += 1) {
    let body
    try {
      body = await requestJson('GET', `/v1/videos/generations/${encodeURIComponent(taskId)}`, key)
    } catch (error) {
      if (error.unknown) {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        continue
      }
      throw error
    }
    const status = body?.status || body?.data?.status || 'unknown'
    history.push({ at: new Date().toISOString(), status, progress: Number(body?.progress || 0) })
    if (status === 'completed' || status === 'failed') {
      const result = body?.result?.data?.[0] || body?.data?.[0] || {}
      const url = result.url || result.video_url || body?.video_url
      return { status, url: typeof url === 'string' ? url : null, history, error: redactMessage(body) }
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  return { status: 'timeout', url: null, history }
}

function createSegment(sourcePath, outputPath, startMs, endMs) {
  const durationSeconds = (endMs - startMs) / 1000
  const result = spawnSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(startMs / 1000), '-i', sourcePath, '-t', String(durationSeconds),
    '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-ar', '44100', '-ac', '1', '-movflags', '+faststart', outputPath,
  ], { encoding: 'utf8', timeout: 180_000 })
  if (result.status !== 0) throw new Error(`源片段生成失败：${result.stderr || result.error?.message || result.status}`)
}

async function uploadVideo(filePath, key) {
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(filePath)], { type: 'video/mp4' }), path.basename(filePath))
  const body = await requestJson('POST', '/v1/uploads/videos', key, { form })
  const url = body?.data?.url
  const uploadId = body?.data?.id
  if (!url || !uploadId) throw new UnknownResultError('视频上传返回缺少 id/url，结果未知')
  return { upload_id: uploadId, url }
}

async function registerAsset(groupId, sourceUrl, name, key) {
  const body = await requestJson('POST', '/v1/videos/doubao-seedance-2-0/private-avatar/assets', key, {
    body: { group_id: groupId, asset_type: 'video', source_url: sourceUrl, name },
  })
  const data = body?.data || {}
  if (!data.asset_id) throw new UnknownResultError('素材注册返回缺少 asset_id，结果未知')
  return { asset_id: data.asset_id, status: data.status || 'processing' }
}

async function submitGeneration(payload, key) {
  const body = await requestJson('POST', '/v1/videos/generations', key, { body: payload })
  const taskId = body?.id || body?.task_id || body?.data?.id
  if (!taskId) throw new UnknownResultError('generation 返回缺少 task id，结果未知')
  return { task_id: taskId, status: body?.status || 'in_progress' }
}

async function downloadVideo(url, outputPath) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  let response
  try {
    response = await fetch(url, { signal: controller.signal })
  } catch (error) {
    throw new Error(`生成文件下载失败：${error?.message || error}`)
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`生成文件下载 HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  fs.writeFileSync(outputPath, buffer)
  return buffer.length
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  const sourcePath = path.resolve(readOption('--source', DEFAULT_SOURCE))
  const outputDir = path.resolve(readOption('--output-dir', 'C:/tmp/toapis-full-episode-20260813'))
  const keyFile = path.resolve(readOption('--key-file', DEFAULT_KEY_FILE))
  const groupId = readOption('--group-id', DEFAULT_GROUP_ID)
  const imageAssetId = readOption('--image-asset-id', DEFAULT_IMAGE_ASSET_ID)
  assertPaidSubmissionAuthorization({
    argv: process.argv.slice(2),
    manifestPath: path.join(outputDir, 'submission-manifest.json'),
  })
  if (!fs.existsSync(sourcePath)) throw new Error(`源片不存在：${sourcePath}`)
  fs.mkdirSync(outputDir, { recursive: true })
  const key = readKey(keyFile)
  const sourceHash = sha256File(sourcePath)
  if (sourceHash !== redrawLatinAmericanCase.source.sha256) throw new Error('源片 SHA-256 不匹配整集合同')

  const preflight = JSON.parse(fs.readFileSync(path.join(outputDir, 'preflight.json'), 'utf8'))
  const segmentsDir = path.join(outputDir, 'segments')
  const generatedDir = path.join(outputDir, 'generated')
  fs.mkdirSync(segmentsDir, { recursive: true })
  fs.mkdirSync(generatedDir, { recursive: true })

  const manifest = {
    case_id: redrawLatinAmericanCase.id,
    source: { basename: path.basename(sourcePath), sha256: sourceHash, duration_ms: redrawLatinAmericanCase.source.duration_ms },
    target: redrawLatinAmericanCase.target,
    model: 'seedance-2-mini',
    resolution: '480p',
    aspect_ratio: '9:16',
    generate_audio: true,
    expected_generation_submissions: EXPECTED_SUBMISSIONS,
    request_duration_seconds: REQUEST_DURATION_SECONDS,
    pricing_reference: { with_reference_video_credits_per_second: 5.58, estimated_credits_for_9x8s: 401.76, source: 'public_model_guide_reference' },
    preflight,
    avatar: { group_id: groupId, image_asset_id: imageAssetId },
    segments: [],
    tasks: [],
    output: null,
  }

  const imageStatus = await requestJson('GET', `/v1/videos/doubao-seedance-2-0/private-avatar/assets/${imageAssetId}`, key)
  const imageState = imageStatus?.data?.status || imageStatus?.status
  if (imageState !== 'active') throw new Error(`角色图片素材不是 active：${imageState || 'unknown'}`)

  for (let index = 0; index < redrawLatinAmericanCase.sourceFacts.shots.length; index += 1) {
    const shot = redrawLatinAmericanCase.sourceFacts.shots[index]
    const number = String(index + 1).padStart(2, '0')
    const segmentPath = path.join(segmentsDir, `shot-${number}.mp4`)
    if (!fs.existsSync(segmentPath)) createSegment(sourcePath, segmentPath, shot.start_ms, shot.end_ms)
    const segment = {
      shot_id: shot.id,
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      source_sha256: sha256File(segmentPath),
      source_probe: probe(segmentPath),
      upload: null,
      asset: null,
    }
    const upload = await uploadVideo(segmentPath, key)
    segment.upload = { upload_id: upload.upload_id, size_bytes: segment.source_probe.size_bytes }
    const registered = await registerAsset(groupId, upload.url, `redraw-${redrawLatinAmericanCase.id}-${shot.id}`, key)
    const assetState = await pollAsset(registered.asset_id, key)
    segment.asset = { asset_id: registered.asset_id, status: assetState.status, history: assetState.history }
    manifest.segments.push(segment)
    writeJson(path.join(outputDir, 'submission-manifest.json'), manifest)
    if (assetState.status !== 'active') throw new Error(`镜头 ${shot.id} 素材未 active：${assetState.status}`)
    console.log(`asset ${index + 1}/${EXPECTED_SUBMISSIONS} active ${registered.asset_id}`)
  }

  for (const [index, shot] of redrawLatinAmericanCase.sourceFacts.shots.entries()) {
    const videoAssetId = manifest.segments[index].asset.asset_id
    const clientBusinessId = `redraw_full_episode_20260813_${shot.id}`
    const payload = {
      model: 'seedance-2-mini',
      client_business_id: clientBusinessId,
      prompt: promptForShot(shot),
      duration: REQUEST_DURATION_SECONDS,
      aspect_ratio: '9:16',
      resolution: '480p',
      generate_audio: true,
      image_with_roles: [{ url: `asset://${imageAssetId}`, role: 'reference_image' }],
      video_with_roles: [{ url: `asset://${videoAssetId}`, role: 'reference_video' }],
    }
    const task = await submitGeneration(payload, key)
    manifest.tasks.push({ shot_id: shot.id, client_business_id: clientBusinessId, task_id: task.task_id, status: task.status, submitted_at: new Date().toISOString() })
    writeJson(path.join(outputDir, 'submission-manifest.json'), manifest)
    console.log(`generation ${index + 1}/${EXPECTED_SUBMISSIONS} accepted ${task.task_id}`)
  }

  const results = await Promise.all(manifest.tasks.map(async (task, index) => {
    const polled = await pollGeneration(task.task_id, key)
    const record = { ...task, terminal_status: polled.status, poll_history: polled.history, error: polled.error }
    if (polled.status === 'completed' && polled.url) {
      const outputPath = path.join(generatedDir, `${redrawLatinAmericanCase.sourceFacts.shots[index].id}.mp4`)
      const bytes = await downloadVideo(polled.url, outputPath)
      const mediaProbe = probe(outputPath)
      const decodeResult = decode(outputPath)
      record.output = { path: outputPath, size_bytes: bytes, sha256: sha256File(outputPath), probe: mediaProbe, decode_ok: decodeResult.ok, decode_stderr: decodeResult.stderr }
    }
    return record
  }))
  manifest.tasks = results
  writeJson(path.join(outputDir, 'submission-manifest.json'), manifest)

  const completed = results.filter((task) => task.terminal_status === 'completed' && task.output?.decode_ok)
  if (completed.length === EXPECTED_SUBMISSIONS) {
    const concatList = path.join(outputDir, 'concat-list.txt')
    fs.writeFileSync(concatList, completed.map((task) => `file '${task.output.path.replaceAll('\\', '/')}'`).join('\n') + '\n')
    const mergedPath = path.join(outputDir, 'redraw-full-episode-toapis-mini-480p.mp4')
    const merge = spawnSync(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
      '-t', '68.733', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-ar', '44100', '-ac', '1', '-movflags', '+faststart', mergedPath,
    ], { encoding: 'utf8', timeout: 600_000 })
    if (merge.status !== 0) throw new Error(`整集合并失败：${merge.stderr || merge.error?.message || merge.status}`)
    const mergedProbe = probe(mergedPath)
    const mergedDecode = decode(mergedPath)
    manifest.output = { path: mergedPath, size_bytes: fs.statSync(mergedPath).size, sha256: sha256File(mergedPath), probe: mergedProbe, decode_ok: mergedDecode.ok, decode_stderr: mergedDecode.stderr }
  }
  writeJson(path.join(outputDir, 'submission-manifest.json'), manifest)
  const post = await requestJson('GET', '/v1/balance', key)
  const postBalance = post || {}
  writeJson(path.join(outputDir, 'postflight.json'), {
    captured_at: new Date().toISOString(),
    remain_credits: postBalance.remain_credits,
    used_credits: postBalance.used_credits,
    remain_balance: postBalance.remain_balance,
    used_balance: postBalance.used_balance,
    credits_per_usd: postBalance.credits_per_usd,
    unlimited_quota: postBalance.unlimited_quota,
  })
  console.log(JSON.stringify({
    expected_generation_submissions: EXPECTED_SUBMISSIONS,
    accepted_generation_submissions: manifest.tasks.length,
    completed_readable: completed.length,
    merged: Boolean(manifest.output),
    output_path: manifest.output?.path || null,
    postflight: { remain_credits: postBalance.remain_credits, used_credits: postBalance.used_credits, unlimited_quota: postBalance.unlimited_quota },
  }, null, 2))
  if (manifest.tasks.length !== EXPECTED_SUBMISSIONS || completed.length !== EXPECTED_SUBMISSIONS || !manifest.output?.decode_ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error?.message || String(error), unknown: Boolean(error?.unknown), status: error?.status || null }, null, 2))
  process.exitCode = 1
})
