import crypto from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  buildFuminEpisodePrompt,
  createFuminEpisodeProviderAdapter,
} from './fuminEpisodeProviderAdapter.mjs'
import { episodeVideoRoute } from './episodeVideoRouteRegistry.mjs'

const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../backend-node/', import.meta.url))
const {
  buildToapisVideoBody,
  callToapisVideoApi,
  fetchToapisTask,
} = require(path.join(backendRoot, 'src', 'services', 'toapisVideoClient'))
const {
  buildToapisWan3VideoBody,
  callToapisWan3VideoApi,
  fetchToapisWan3Task,
} = require(path.join(backendRoot, 'src', 'services', 'toapisWan3VideoClient'))
const {
  buildFeituoStatusUrl,
  buildFeituoVideoBody,
  callFeituoVideoApi,
  fetchFeituoText,
  normalizeFeituoBaseUrl,
  parseFeituoStatusPayload,
} = require(path.join(backendRoot, 'src', 'services', 'feituoVideoClient'))

const TOAPIS_BASE_URL = 'https://toapis.xyz'
const FEITUO_BASE_URL = 'https://feituokuajing.com'

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalHash(value, omittedKey) {
  const copy = JSON.parse(JSON.stringify(value))
  if (omittedKey) delete copy[omittedKey]
  return crypto.createHash('sha256').update(stableStringify(copy)).digest('hex')
}

function codedError(code, reason, attributes = {}) {
  const error = new Error(`${code}: ${reason || code}`)
  error.code = code
  Object.assign(error, attributes)
  return error
}

function unknown(code, reason) {
  throw codedError(code, reason, { indeterminate: true, provider_reason: String(reason || code) })
}

function explicitFailure(code, reason) {
  throw codedError(code, reason, {
    provider_terminal_failure: true,
    provider_reason: String(reason || code),
  })
}

function localFailure(code, reason) {
  throw codedError(code, reason, { provider_reason: String(reason || code) })
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

function referenceUrls(uploaded = []) {
  const result = { images: [], videos: [], audio: [], videoDurations: [], audioDurations: [] }
  for (const reference of uploaded) {
    const url = String(reference?.url || '').trim()
    const mime = String(reference?.mime_type || '').trim().toLowerCase()
    if (!/^https:\/\//iu.test(url)) localFailure('REDRAW_EPISODE_REFERENCE_URL_INVALID', 'reference URL must be HTTPS')
    if (mime.startsWith('image/')) result.images.push(url)
    else if (mime === 'video/mp4') {
      result.videos.push(url)
      result.videoDurations.push(Number(reference.duration_seconds))
    } else if (mime.startsWith('audio/')) {
      result.audio.push(url)
      result.audioDurations.push(Number(reference.duration_seconds))
    }
    else localFailure('REDRAW_EPISODE_REFERENCE_MIME_UNSUPPORTED', mime || 'missing')
  }
  return result
}

function providerOptions(route, unit, uploaded) {
  const references = referenceUrls(uploaded)
  const common = {
    model: route.provider_model,
    prompt: buildFuminEpisodePrompt(unit),
    duration: route.duration_seconds,
    resolution: route.resolution,
    aspect_ratio: route.aspect_ratio,
    generate_audio: true,
    reference_urls: references.images,
    reference_video_urls: references.videos,
    reference_audio_urls: references.audio,
    reference_video_durations: references.videoDurations,
    reference_audio_durations: references.audioDurations,
    client_business_id: `redraw_${route.id.replace(/[^a-z0-9]+/giu, '_')}_${String(unit?.unit_hash || '')}`,
  }
  return route.provider === 'toapis-wan3' ? { ...common, audio: true, watermark: false } : common
}

function assertCreateResult(route, result) {
  if (result?.indeterminate === true) {
    unknown('REDRAW_EPISODE_PROVIDER_SUBMISSION_UNKNOWN', result.error || `${route.id} submission unknown`)
  }
  if (result?.error) {
    if (result?.route_meta?.explicitlyRejected === true && result?.route_meta?.requestBodySent === true) {
      explicitFailure('REDRAW_EPISODE_PROVIDER_REJECTED', result.error)
    }
    if (route.provider === 'feituo') {
      explicitFailure('REDRAW_EPISODE_PROVIDER_REJECTED', result.error)
    }
    localFailure('REDRAW_EPISODE_PROVIDER_SUBMISSION_REJECTED', result.error)
  }
  if (result?.video_url) return { direct_video_url: String(result.video_url) }
  if (!result?.task_id) unknown('REDRAW_EPISODE_PROVIDER_SUBMISSION_UNKNOWN', `${route.id} returned no task id`)
  return { task_id: String(result.task_id) }
}

function rewritePlanProvider(plan, provider) {
  const rewritten = JSON.parse(JSON.stringify(plan))
  rewritten.provider = provider
  rewritten.execution_plan_hash = canonicalHash(rewritten, 'execution_plan_hash')
  return rewritten
}

function toapisPollFailureClass(result) {
  const reason = String(result?.error || '')
  if (result?.queryFailed === true || result?.retryable === true || /^ToAPIs 查询任务失败 \(/u.test(reason)) {
    return 'unknown'
  }
  if (result?.artifactUnreadable === true || reason === 'ToAPIs 任务完成但未返回视频地址') {
    return 'artifact_unreadable'
  }
  if (/^ToAPIs (?:API Key 未配置|task_id 不能为空|fetch 不可用|官方入口)/u.test(reason)) {
    return 'local'
  }
  return result?.terminalFailure === true || result?.state === 'failed' ? 'explicit' : null
}

export function createEpisodeVideoProviderAdapter(options = {}) {
  const route = typeof options.route === 'string' ? episodeVideoRoute(options.route) : options.route
  if (!route || route !== episodeVideoRoute(route.id)) {
    localFailure('REDRAW_EPISODE_VIDEO_ROUTE_NOT_APPROVED', route?.id || 'missing')
  }
  const providerApiKey = String(options.providerApiKey || '').trim()
  const referenceApiKey = String(options.referenceApiKey || '').trim()
  if (!providerApiKey) localFailure('REDRAW_EPISODE_PROVIDER_KEY_MISSING', route.key_id)
  if (!referenceApiKey) localFailure('REDRAW_EPISODE_REFERENCE_KEY_MISSING', 'fumin')
  const beforeGenerationSubmit = options.beforeGenerationSubmit || (async () => {})
  const common = options.commonAdapter || createFuminEpisodeProviderAdapter({
    ...options,
    apiKey: referenceApiKey,
    model: route.provider === 'fumin' ? route.model : undefined,
    beforeGenerationSubmit: route.provider === 'fumin'
      ? ({ unit_id }) => beforeGenerationSubmit({ route_id: route.id, unit_id, model: route.model })
      : undefined,
  })
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const pollAttempts = positiveInteger(options.pollAttempts, 360)
  const directResults = new Map()

  async function submitGeneration({ unit, uploaded_references = [] }) {
    if (route.provider === 'fumin') return common.submitGeneration({ unit, pack: unit, uploaded_references })
    const request = providerOptions(route, unit, uploaded_references)
    try {
      if (route.provider === 'toapis') buildToapisVideoBody(request)
      else if (route.provider === 'toapis-wan3') buildToapisWan3VideoBody(request)
      else if (route.provider === 'feituo') buildFeituoVideoBody(request)
      else localFailure('REDRAW_EPISODE_VIDEO_ROUTE_NOT_APPROVED', route.id)
    } catch (error) {
      localFailure('REDRAW_EPISODE_PROVIDER_CONTRACT_INVALID', error.message)
    }
    await beforeGenerationSubmit({ route_id: route.id, unit_id: unit.unit_id, model: route.model })
    let result
    if (route.provider === 'toapis') {
      result = await callToapisVideoApi(
        { base_url: TOAPIS_BASE_URL },
        null,
        request,
        { apiKey: providerApiKey, fetchImpl: options.fetchImpl },
      )
    } else if (route.provider === 'toapis-wan3') {
      result = await callToapisWan3VideoApi(
        { base_url: TOAPIS_BASE_URL },
        null,
        request,
        { apiKey: providerApiKey, fetchImpl: options.fetchImpl },
      )
    } else {
      result = await callFeituoVideoApi(
        { base_url: options.feituoBaseUrl || FEITUO_BASE_URL, api_key: providerApiKey },
        null,
        request,
        { fetchImpl: options.fetchImpl },
      )
    }
    const checked = assertCreateResult(route, result)
    if (checked.direct_video_url) {
      const taskId = `direct-${crypto.randomUUID()}`
      directResults.set(taskId, checked.direct_video_url)
      return { task_id: taskId }
    }
    return checked
  }

  async function pollToapis(taskId, wan3) {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const result = wan3
        ? await fetchToapisWan3Task(
          { base_url: TOAPIS_BASE_URL },
          taskId,
          { apiKey: providerApiKey, fetchImpl: options.fetchImpl },
        )
        : await fetchToapisTask(
          { base_url: TOAPIS_BASE_URL },
          taskId,
          { apiKey: providerApiKey, fetchImpl: options.fetchImpl },
        )
      const failure = toapisPollFailureClass(result)
      if (failure === 'unknown') {
        unknown('REDRAW_EPISODE_PROVIDER_STATUS_UNKNOWN', result.error || `${route.id} query failed`)
      }
      if (result?.state === 'completed' && result?.videoUrl) {
        return { state: 'completed', video_url: String(result.videoUrl) }
      }
      if (failure === 'explicit') {
        explicitFailure('REDRAW_EPISODE_PROVIDER_FAILED', result.error || `${route.id} failed`)
      }
      if (failure === 'artifact_unreadable' || failure === 'local') {
        localFailure('REDRAW_EPISODE_PROVIDER_RESULT_INVALID', result.error || `${route.id} result invalid`)
      }
      await sleep(5_000)
    }
    unknown('REDRAW_EPISODE_PROVIDER_STATUS_UNKNOWN', `${route.id} polling deadline reached`)
  }

  async function pollFeituo(taskId) {
    if (directResults.has(taskId)) {
      return { state: 'completed', video_url: directResults.get(taskId) }
    }
    const baseUrl = normalizeFeituoBaseUrl(options.feituoBaseUrl || FEITUO_BASE_URL)
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      let fetched
      try {
        fetched = await fetchFeituoText(
          buildFeituoStatusUrl(baseUrl, taskId),
          { method: 'GET', headers: { Authorization: `Bearer ${providerApiKey}` } },
          { fetchImpl: options.fetchImpl },
        )
      } catch (error) {
        unknown('REDRAW_EPISODE_PROVIDER_STATUS_UNKNOWN', error.message)
      }
      if (!fetched.response.ok) {
        unknown('REDRAW_EPISODE_PROVIDER_STATUS_UNKNOWN', `Feituo query HTTP ${fetched.response.status}`)
      }
      let payload
      try { payload = JSON.parse(fetched.raw) } catch { payload = null }
      if (!payload) unknown('REDRAW_EPISODE_PROVIDER_STATUS_UNKNOWN', 'Feituo query returned non-JSON')
      const result = parseFeituoStatusPayload(payload)
      if (result.state === 'completed') return { state: 'completed', video_url: String(result.videoUrl) }
      if (result.state === 'failed') {
        const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
          ? { ...payload, ...payload.data }
          : payload
        const status = String(data?.status || data?.state || '').trim().toLowerCase()
        if (['success', 'succeeded', 'completed', 'done'].includes(status)) {
          localFailure('REDRAW_EPISODE_PROVIDER_RESULT_INVALID', result.error)
        }
        explicitFailure('REDRAW_EPISODE_PROVIDER_FAILED', result.error)
      }
      await sleep(5_000)
    }
    unknown('REDRAW_EPISODE_PROVIDER_STATUS_UNKNOWN', `${route.id} polling deadline reached`)
  }

  return {
    ...common,
    name: route.id,
    route,
    async prepareEpisode(input) {
      return rewritePlanProvider(await common.prepareEpisode(input), route.id)
    },
    submitGeneration,
    async pollGeneration({ task_id }) {
      if (route.provider === 'fumin') return common.pollGeneration({ task_id })
      if (route.provider === 'toapis') return pollToapis(task_id, false)
      if (route.provider === 'toapis-wan3') return pollToapis(task_id, true)
      return pollFeituo(task_id)
    },
  }
}
