const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  buildFeituoStatusUrl,
  buildFeituoVideoBody,
  callFeituoVideoApi,
  normalizeFeituoBaseUrl,
  parseFeituoStatusPayload,
} = require('../src/services/feituoVideoClient');

const BASE_URL = 'https://feituokuajing.com';
const STATE_VERSION = 'feituo-video-verification-state-v1';
const EVIDENCE_VERSION = 'feituo-video-real-verification-v1';
const LOG = { info() {}, warn() {}, error() {} };
const REQUIRED_MATRIX = Object.freeze([
  Object.freeze({ id: 'h3-2k', model: 'xuan-video-v1-6e7b4763634e6206', resolution: '2k', duration: 15 }),
  Object.freeze({ id: 'seedance25-480', model: 'xuan-seedance-2.5', resolution: '480p', duration: 4 }),
  Object.freeze({ id: 'seedance25-720', model: 'xuan-seedance-2.5', resolution: '720p', duration: 4 }),
]);

function buildRequiredMatrix() {
  return REQUIRED_MATRIX.map((item) => ({ ...item }));
}

function buildVerificationRequest(item) {
  if (!item || !REQUIRED_MATRIX.some((entry) => entry.id === item.id)) throw new Error('未知飞拓验证用例');
  return buildFeituoVideoBody({
    model: item.model,
    resolution: item.resolution,
    duration: item.duration,
    aspect_ratio: '16:9',
    prompt: item.model === 'xuan-video-v1-6e7b4763634e6206'
      ? '雨后森林中的橙色小猫沿石板路缓慢前行，镜头平稳跟随，电影感，无文字。'
      : '雨后森林中的探险者沿石板路缓慢前行，镜头平稳跟随，电影感，无文字。',
  });
}

function decideResumeAction(entry) {
  if (!entry) return 'submit';
  if (entry.status === 'completed' && entry.artifact?.sha256) return 'finalize';
  if (['submitting', 'indeterminate'].includes(entry.submission_state)) return 'stop-indeterminate';
  if (['rejected', 'failed'].includes(entry.status) || entry.submission_state === 'rejected') return 'stop-rejected';
  if (entry.provider_task_id) return 'poll';
  return 'submit';
}

function redactEvidence(value) {
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(?:authorization|api[_-]?key|access[_-]?token|^token$|^headers$)/i.test(key)) continue;
      output[key] = redactEvidence(item);
    }
    return output;
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, '[redacted]')
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, 'authorization=[redacted]')
    .replace(/(api[_-]?key|access[_-]?token|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function round(value, precision = 3) {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function parseFfprobeJson(raw) {
  let payload;
  try { payload = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) {
    throw new Error('ffprobe 返回无效 JSON');
  }
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((item) => item?.codec_type === 'video');
  if (!video || !Number(video.width) || !Number(video.height)) throw new Error('ffprobe 未找到有效视频流');
  const duration = Number(video.duration ?? payload?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe 未取得有效时长');
  const audio = streams.find((item) => item?.codec_type === 'audio');
  return {
    format: String(payload?.format?.format_name || ''),
    width: Number(video.width),
    height: Number(video.height),
    duration_seconds: round(duration),
    video_codec: String(video.codec_name || ''),
    has_audio: Boolean(audio),
    audio_codec: audio ? String(audio.codec_name || '') : null,
  };
}

function assertResolutionBand(resolution, ffprobe) {
  const width = Number(ffprobe?.width) || 0;
  const height = Number(ffprobe?.height) || 0;
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  if (resolution === '480p' && shortEdge >= 400 && shortEdge <= 576) return;
  if (resolution === '720p' && shortEdge >= 640 && shortEdge <= 800) return;
  if (resolution === '2k' && longEdge >= 1800 && longEdge <= 2304) return;
  throw new Error(`${resolution} 结果尺寸不在对应档位: ${width}x${height}`);
}

function validateCompletedResult(item) {
  const expected = REQUIRED_MATRIX.find((entry) => entry.id === item?.id);
  if (!expected || item.status !== 'completed') return false;
  if (item.model !== expected.model
      || item.requested_resolution !== expected.resolution
      || Number(item.requested_duration) !== expected.duration
      || !String(item.provider_task_id || '').trim()) return false;
  const artifact = item.artifact || {};
  if (!/^https:\/\/molimama\.vip\/verification-assets\/feituo\/[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(String(artifact.public_url || ''))
      || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ''))
      || Number(artifact.bytes) < 1024
      || !artifact.ffprobe?.video_codec) return false;
  try { assertResolutionBand(expected.resolution, artifact.ffprobe); } catch (_) { return false; }
  if (Math.abs(Number(artifact.ffprobe.duration_seconds) - expected.duration) > 2) return false;
  const speed = item.speed || {};
  if (!Number.isFinite(Number(speed.submit_latency_ms)) || Number(speed.submit_latency_ms) < 0
      || !Number.isFinite(Number(speed.generation_elapsed_seconds)) || Number(speed.generation_elapsed_seconds) <= 0
      || !Number.isFinite(Number(speed.download_latency_ms)) || Number(speed.download_latency_ms) < 0
      || !Number.isFinite(Number(speed.total_elapsed_seconds)) || Number(speed.total_elapsed_seconds) <= 0) return false;
  return Number.isFinite(Date.parse(item.started_at)) && Number.isFinite(Date.parse(item.completed_at));
}

function hasCompleteRequiredMatrix(results) {
  if (!Array.isArray(results) || results.length !== REQUIRED_MATRIX.length) return false;
  if (!results.every(validateCompletedResult)) return false;
  return new Set(results.map((item) => item.provider_task_id)).size === REQUIRED_MATRIX.length;
}

function stats(values) {
  return {
    sample_count: values.length,
    min_seconds: Math.min(...values),
    max_seconds: Math.max(...values),
    avg_seconds: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function buildSpeedEvidenceSummary(results = []) {
  const cases = REQUIRED_MATRIX.map((expected) => {
    const item = results.find((entry) => entry?.id === expected.id) || {};
    return {
      id: expected.id,
      model: expected.model,
      resolution: expected.resolution,
      submit_latency_ms: Number(item.speed?.submit_latency_ms),
      generation_elapsed_seconds: Number(item.speed?.generation_elapsed_seconds),
      download_latency_ms: Number(item.speed?.download_latency_ms),
      total_elapsed_seconds: Number(item.speed?.total_elapsed_seconds),
    };
  });
  const models = [...new Set(REQUIRED_MATRIX.map((item) => item.model))];
  return {
    measurement_basis: 'actual_paid_verification_run_not_provider_sla',
    cases,
    model_summary: Object.fromEntries(models.map((model) => {
      const values = cases.filter((item) => item.model === model).map((item) => item.generation_elapsed_seconds).filter(Number.isFinite);
      return [model, values.length ? stats(values) : { sample_count: 0, min_seconds: null, max_seconds: null, avg_seconds: null }];
    })),
  };
}

function buildReleaseEvidence(results, now = new Date()) {
  const generated = new Date(now);
  if (!Number.isFinite(generated.getTime()) || !hasCompleteRequiredMatrix(results)) {
    throw new Error('飞拓三组真实验证尚未完整通过');
  }
  return redactEvidence({
    contract_version: EVIDENCE_VERSION,
    provider_origin: BASE_URL,
    generated_at: generated.toISOString(),
    valid_until: new Date(generated.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    verification_scope: {
      models: ['xuan-video-v1-6e7b4763634e6206', 'xuan-seedance-2.5'],
      resolutions: { 'xuan-video-v1-6e7b4763634e6206': ['2k'], 'xuan-seedance-2.5': ['480p', '720p'] },
      durations: { 'xuan-video-v1-6e7b4763634e6206': [15], 'xuan-seedance-2.5': [4] },
      reference_inputs: 'not_verified_text_only',
    },
    pricing_basis: {
      source: 'administrator_approved_supplier_public_price_2026-08-08',
      h3_yuan_per_request: 1.5,
      seedance25_yuan_per_second: 0.4,
      supplier_task_billing_endpoint: 'not_available',
    },
    results,
    speed_evidence: buildSpeedEvidenceSummary(results),
  });
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(redactEvidence(payload), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function acquireLock(lockPath) {
  let fd;
  try { fd = fs.openSync(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有飞拓真实验证进程，禁止并发付费提交');
    throw error;
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  return () => {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  };
}

function safeChildProcessEnv(env = process.env) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL'];
  return Object.fromEntries(allowed.filter((key) => env[key] != null).map((key) => [key, env[key]]));
}

function runFfprobe(filePath, executable = process.env.FFPROBE_PATH || 'ffprobe') {
  const result = spawnSync(executable, [
    '-v', 'error', '-show_entries',
    'format=format_name,duration:stream=codec_type,codec_name,width,height,duration',
    '-of', 'json', filePath,
  ], { encoding: 'utf8', windowsHide: true, env: safeChildProcessEnv() });
  if (result.error) throw new Error(`ffprobe 执行失败: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffprobe 校验失败: ${String(result.stderr || '').trim().slice(0, 300)}`);
  return parseFfprobeJson(result.stdout);
}

function resolvePaths(env = process.env) {
  const outputDir = path.resolve(String(env.FEITUO_VERIFY_OUTPUT_DIR || ''));
  const publicDir = path.resolve(String(env.FEITUO_VERIFY_PUBLIC_ARTIFACT_DIR || ''));
  if (!env.FEITUO_VERIFY_OUTPUT_DIR || !env.FEITUO_VERIFY_PUBLIC_ARTIFACT_DIR
      || !path.isAbsolute(env.FEITUO_VERIFY_OUTPUT_DIR) || !path.isAbsolute(env.FEITUO_VERIFY_PUBLIC_ARTIFACT_DIR)
      || outputDir === publicDir) throw new Error('飞拓验证私有目录与公网成品目录必须是不同的绝对路径');
  const base = String(env.FEITUO_VERIFY_PUBLIC_ASSET_BASE_URL || '').replace(/\/+$/, '');
  if (base !== 'https://molimama.vip/verification-assets/feituo') {
    throw new Error('飞拓公网成品基址必须固定为 https://molimama.vip/verification-assets/feituo');
  }
  return {
    outputDir,
    publicDir,
    publicBaseUrl: base,
    statePath: path.join(outputDir, 'feituo-video-verification-state.json'),
    evidencePath: path.join(outputDir, 'feituo-video-verification.json'),
    lockPath: path.join(outputDir, '.feituo-video-verification.lock'),
  };
}

function requireApiKey(env = process.env) {
  const filePath = String(env.FEITUO_VERIFY_API_KEY_FILE || '').trim();
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('FEITUO_VERIFY_API_KEY_FILE 必须是绝对路径');
  const key = fs.readFileSync(filePath, 'utf8').trim();
  if (!key) throw new Error('飞拓验证密钥文件为空');
  return key;
}

async function fetchStatus(config, taskId, deps = {}) {
  const response = await (deps.fetchImpl || fetch)(buildFeituoStatusUrl(config.base_url, taskId), {
    headers: { Authorization: `Bearer ${config.api_key}`, 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { payload = null; }
  if (!response.ok || !payload) throw new Error(`飞拓任务查询失败 (${response.status})`);
  return parseFeituoStatusPayload(payload);
}

async function waitForTask(config, taskId, onProgress, deps = {}) {
  const pollMs = Number(deps.pollMs ?? process.env.FEITUO_VERIFY_POLL_MS ?? 10000);
  const maxPolls = Number(deps.maxPolls ?? process.env.FEITUO_VERIFY_MAX_POLLS ?? 180);
  for (let index = 0; index < maxPolls; index += 1) {
    if (index > 0 || !deps.skipInitialWait) await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(pollMs);
    const status = await fetchStatus(config, taskId, deps);
    onProgress?.(status);
    if (status.state === 'completed') return status.videoUrl;
    if (status.state === 'failed') throw new Error(status.error || '飞拓任务失败');
  }
  throw new Error('飞拓任务轮询超时；任务编号已保存，禁止重新提交，可继续轮询');
}

async function assertPublicArtifact(url, expectedSha256, fetchImpl = fetch) {
  const response = await fetchImpl(url);
  if (response.status !== 200) throw new Error(`飞拓成品公网读取失败 (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== expectedSha256) {
    throw new Error('飞拓公网成品与本地文件哈希不一致');
  }
}

async function downloadAndInspect(url, filePath, item, publicUrl, deps = {}) {
  const started = Date.now();
  const response = await (deps.fetchImpl || fetch)(url);
  if (!response.ok) throw new Error(`飞拓成品下载失败 (${response.status})`);
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('video/') && contentType !== 'application/octet-stream') throw new Error(`飞拓成品 MIME 不是视频: ${contentType}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error('飞拓成品为空或过小');
  await fs.promises.writeFile(filePath, buffer);
  const ffprobe = (deps.runFfprobe || runFfprobe)(filePath);
  assertResolutionBand(item.resolution, ffprobe);
  if (Math.abs(ffprobe.duration_seconds - item.duration) > 2) throw new Error('飞拓成品时长与请求不符');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  await (deps.assertPublicArtifact || assertPublicArtifact)(publicUrl, sha256, deps.fetchImpl || fetch);
  return {
    artifact: { public_url: publicUrl, output_file: path.basename(filePath), content_type: contentType, bytes: buffer.length, sha256, ffprobe },
    downloadLatencyMs: Date.now() - started,
  };
}

async function verifyStoredArtifact(entry, item, context, deps = {}) {
  const fileName = String(entry.artifact?.output_file || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(fileName)) throw new Error(`${item.id} 成品文件名无效`);
  const filePath = path.join(context.publicDir, fileName);
  const buffer = await fs.promises.readFile(filePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== entry.artifact.sha256) throw new Error(`${item.id} 本地成品哈希不匹配`);
  const ffprobe = (deps.runFfprobe || runFfprobe)(filePath);
  assertResolutionBand(item.resolution, ffprobe);
  await (deps.assertPublicArtifact || assertPublicArtifact)(entry.artifact.public_url, sha256, deps.fetchImpl || fetch);
  entry.artifact.ffprobe = ffprobe;
}

async function processCase(item, context, deps = {}) {
  let entry = context.state.cases[item.id];
  const action = decideResumeAction(entry);
  if (action === 'stop-indeterminate') throw new Error(`${item.id} 创建结果不确定，禁止自动重试`);
  if (action === 'stop-rejected') throw new Error(`${item.id} 已失败或拒绝，禁止自动重试`);
  if (action === 'finalize') {
    await verifyStoredArtifact(entry, item, context, deps);
    return entry;
  }
  if (action === 'submit') {
    const startedAt = new Date();
    entry = {
      id: item.id,
      model: item.model,
      requested_resolution: item.resolution,
      requested_duration: item.duration,
      status: 'submitting',
      submission_state: 'submitting',
      started_at: startedAt.toISOString(),
    };
    context.state.cases[item.id] = entry;
    writeJsonAtomic(context.statePath, context.state);
    const created = await callFeituoVideoApi(context.config, LOG, buildVerificationRequest(item), { fetchImpl: deps.fetchImpl });
    const acceptedAt = new Date();
    if (created.indeterminate) {
      entry.status = 'indeterminate';
      entry.submission_state = 'indeterminate';
      entry.error = created.error;
      writeJsonAtomic(context.statePath, context.state);
      throw new Error(created.error);
    }
    if (created.error || !created.task_id) {
      entry.status = 'rejected';
      entry.submission_state = 'rejected';
      entry.error = created.error || '飞拓未返回 jobId';
      writeJsonAtomic(context.statePath, context.state);
      throw new Error(entry.error);
    }
    entry.provider_task_id = String(created.task_id);
    entry.submission_state = 'accepted';
    entry.status = 'processing';
    entry.speed = { submit_latency_ms: acceptedAt.getTime() - startedAt.getTime() };
    writeJsonAtomic(context.statePath, context.state);
  }
  const videoUrl = await waitForTask(context.config, entry.provider_task_id, (status) => {
    entry.status = status.state;
    writeJsonAtomic(context.statePath, context.state);
  }, deps);
  const completedAt = new Date();
  const fileName = `${item.id}-${entry.provider_task_id}.mp4`.replace(/[^A-Za-z0-9._~-]+/g, '-');
  const downloaded = await downloadAndInspect(videoUrl, path.join(context.publicDir, fileName), item, `${context.publicBaseUrl}/${fileName}`, deps);
  entry.artifact = downloaded.artifact;
  entry.status = 'completed';
  entry.completed_at = completedAt.toISOString();
  entry.speed = {
    ...entry.speed,
    generation_elapsed_seconds: round((completedAt.getTime() - Date.parse(entry.started_at)) / 1000),
    download_latency_ms: downloaded.downloadLatencyMs,
    total_elapsed_seconds: round((Date.now() - Date.parse(entry.started_at)) / 1000),
  };
  writeJsonAtomic(context.statePath, context.state);
  return entry;
}

async function runVerification(deps = {}) {
  normalizeFeituoBaseUrl(process.env.FEITUO_BASE_URL || BASE_URL);
  if (normalizeFeituoBaseUrl(process.env.FEITUO_BASE_URL || BASE_URL) !== BASE_URL) throw new Error('飞拓真实验证只允许官方已批准域名');
  const paths = resolvePaths(process.env);
  fs.mkdirSync(paths.outputDir, { recursive: true });
  fs.mkdirSync(paths.publicDir, { recursive: true });
  const releaseLock = acquireLock(paths.lockPath);
  try {
    const apiKey = requireApiKey();
    const state = readJson(paths.statePath, { state_version: STATE_VERSION, cases: {} });
    if (state.state_version !== STATE_VERSION || !state.cases) throw new Error('飞拓验证状态文件版本不兼容');
    const context = { ...paths, config: { base_url: BASE_URL, api_key: apiKey }, state };
    for (const item of REQUIRED_MATRIX) {
      const result = await processCase(item, context, deps);
      process.stdout.write(`FEITUO_VERIFIED ${item.id} task=${result.provider_task_id} generation_seconds=${result.speed.generation_elapsed_seconds}\n`);
    }
    const results = [];
    for (const item of REQUIRED_MATRIX) {
      const entry = state.cases[item.id];
      await verifyStoredArtifact(entry, item, context, deps);
      results.push(entry);
    }
    const evidence = buildReleaseEvidence(results);
    writeJsonAtomic(paths.evidencePath, evidence);
    process.stdout.write(`FEITUO_VIDEO_VERIFIED 3/3 evidence=${paths.evidencePath}\n`);
    return evidence;
  } catch (error) {
    writeJsonAtomic(path.join(paths.outputDir, 'feituo-video-verification-failure.json'), {
      contract_version: EVIDENCE_VERSION,
      failed_at: new Date().toISOString(),
      error: String(redactEvidence(error.message || error)).slice(0, 800),
    });
    throw error;
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  runVerification().catch((error) => {
    process.stderr.write(`FEITUO_VIDEO_VERIFICATION_FAILED: ${redactEvidence(error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EVIDENCE_VERSION,
  buildRequiredMatrix,
  buildReleaseEvidence,
  buildSpeedEvidenceSummary,
  buildVerificationRequest,
  decideResumeAction,
  hasCompleteRequiredMatrix,
  parseFfprobeJson,
  processCase,
  redactEvidence,
  runVerification,
  validateCompletedResult,
};
