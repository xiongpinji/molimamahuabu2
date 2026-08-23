'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  PUBLIC_MODEL,
  UPSTREAM_MODEL,
  OFFICIAL_BASE_URL,
  DURATIONS,
  RATIOS,
  MAX_IMAGE_REFERENCES,
  buildLingjingDownloadUrl,
  buildLingjingVideoBody,
  callLingjingVideoApi,
  fetchLingjingTask,
  normalizeLingjingBaseUrl,
} = require('../src/services/lingjingVideoClient');

const STATE_VERSION = 'lingjing-video-verification-state-v1';
const EVIDENCE_VERSION = 'lingjing-video-real-verification-v1';
const PUBLIC_SETTINGS_URL = 'https://seed.alimyun.xyz/api/public/settings';
const CONFIRMATION = 'LINGJING_ONE_PAID_4S_IMAGE';
const REFERENCE_DECLARATION = 'NON_PERSON_REFERENCE_APPROVED';
const LOG = { info() {}, warn() {}, error() {} };

function buildVerificationCase() {
  return {
    id: 'relay-image-4s',
    model: PUBLIC_MODEL,
    upstreamModel: UPSTREAM_MODEL,
    mode: 'omni',
    duration: 4,
    aspectRatio: '16:9',
  };
}

function buildVerificationRequest(item = buildVerificationCase(), options = {}) {
  if (item.id !== 'relay-image-4s') throw new Error('未知灵境验证用例');
  const requestId = String(options.requestId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error('灵境验证 request_id 必须是 UUID v4');
  }
  const reference = options.reference;
  if (!reference || !Buffer.isBuffer(reference.bytes) || !reference.bytes.length) {
    throw new Error('灵境验证必须提供一张非真人参考图');
  }
  return {
    model: item.model,
    prompt: '一只橙色布偶猫在雨后森林石板路上缓慢前行，镜头平稳跟随，电影感，无人物，无文字。',
    duration: item.duration,
    aspect_ratio: item.aspectRatio,
    request_id: requestId,
    reference_images: [reference],
  };
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
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(?:authorization|api[_-]?key|access[_-]?token|^token$|^headers$)/i.test(key))
      .map(([key, item]) => [key, redactEvidence(item)]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, '[redacted]')
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, 'authorization=[redacted]');
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
  const video = streams.find((stream) => stream?.codec_type === 'video');
  const width = Number(video?.width);
  const height = Number(video?.height);
  const duration = Number(video?.duration ?? payload?.format?.duration);
  if (!video || !Number.isSafeInteger(width) || width < 64 || !Number.isSafeInteger(height) || height < 64) {
    throw new Error('ffprobe 未找到有效视频流');
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe 未取得有效时长');
  const audio = streams.find((stream) => stream?.codec_type === 'audio');
  return {
    format: String(payload?.format?.format_name || ''),
    width,
    height,
    duration_seconds: round(duration),
    video_codec: String(video.codec_name || ''),
    has_audio: Boolean(audio),
    audio_codec: audio ? String(audio.codec_name || '') : null,
  };
}

function validateMediaEvidence(ffprobe, item = buildVerificationCase()) {
  const ratio = Number(ffprobe?.width) / Number(ffprobe?.height);
  if (!Number.isFinite(ratio) || Math.abs(ratio - (16 / 9)) > 0.12) throw new Error('灵境成品画幅不是 16:9');
  if (Math.abs(Number(ffprobe?.duration_seconds) - item.duration) > 2) throw new Error('灵境成品时长与请求不符');
  if (!String(ffprobe?.video_codec || '').trim()) throw new Error('灵境成品缺少视频编码');
  if (typeof ffprobe?.has_audio !== 'boolean') throw new Error('灵境成品音轨探测结果无效');
  if (ffprobe.has_audio && !String(ffprobe.audio_codec || '').trim()) throw new Error('灵境成品音轨缺少编码信息');
  if (!ffprobe.has_audio && ffprobe.audio_codec !== null) throw new Error('灵境成品无音轨时不应声明音频编码');
}

function validateCompletedResult(result) {
  const item = buildVerificationCase();
  if (!result || result.id !== item.id || result.model !== item.model
      || result.upstream_model !== item.upstreamModel || result.mode !== item.mode
      || Number(result.requested_duration) !== item.duration
      || result.requested_aspect_ratio !== item.aspectRatio
      || result.requested_resolution !== null || Number(result.reference_count) !== 1
      || result.status !== 'completed' || result.submission_state !== 'accepted'
      || !String(result.provider_task_id || '').trim()
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(result.request_id || ''))) return false;
  if (result.request?.model_key !== UPSTREAM_MODEL || Number(result.request?.duration) !== 4
      || result.request?.ratio !== '16:9' || Number(result.request?.reference_count) !== 1
      || result.request?.request_id !== result.request_id || Object.hasOwn(result.request || {}, 'resolution')) return false;
  const audit = result.provider_audit || {};
  const uploads = Array.isArray(audit.uploads) ? audit.uploads : [];
  const upload = uploads[0] || {};
  const costFields = Array.isArray(audit.supplier_cost_fields) ? audit.supplier_cost_fields : [];
  const costUnavailable = audit.supplier_cost_unavailable === true;
  if (!/^[a-f0-9]{64}$/.test(String(audit.request_body_sha256 || ''))
      || !/^[a-f0-9]{64}$/.test(String(audit.creation_response_sha256 || ''))
      || !/^[a-f0-9]{64}$/.test(String(audit.terminal_response_sha256 || ''))
      || Number(audit.creation_http_status) < 200 || Number(audit.creation_http_status) >= 300
      || Number(audit.terminal_http_status) < 200 || Number(audit.terminal_http_status) >= 300
      || uploads.length !== 1
      || !/^[a-f0-9]{64}$/.test(String(upload.reference_sha256 || ''))
      || !/^uploads\/[A-Za-z0-9._/-]+$/.test(String(upload.upload_path || ''))
      || String(upload.upload_path || '').includes('..')
      || !/^[a-f0-9]{64}$/.test(String(upload.upload_response_sha256 || ''))
      || Number(upload.upload_http_status) < 200 || Number(upload.upload_http_status) >= 300
      || (costUnavailable ? costFields.length !== 0 : costFields.length === 0)
      || costFields.some((field) => !['creation', 'terminal'].includes(field?.source)
        || !['cost', 'credits', 'credits_used', 'charged_credits', 'charge', 'charged_amount', 'amount'].includes(field?.field)
        || !['number', 'string'].includes(typeof field?.value))) return false;
  const artifact = result.artifact || {};
  const expectedOutput = `${item.id}-${String(result.provider_task_id || '')}.mp4`.replace(/[^A-Za-z0-9._~-]+/g, '-');
  if (!/^https:\/\/molimama\.vip\/verification-assets\/lingjing\/[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(String(artifact.public_url || ''))
      || path.basename(String(artifact.output_file || '')) !== artifact.output_file
      || !/^[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(String(artifact.output_file || ''))
      || artifact.output_file !== expectedOutput
      || artifact.public_url !== `https://molimama.vip/verification-assets/lingjing/${expectedOutput}`
      || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ''))
      || Number(artifact.bytes) < 1024 || artifact.content_type !== 'video/mp4') return false;
  try { validateMediaEvidence(artifact.ffprobe, item); } catch (_) { return false; }
  const started = Date.parse(result.started_at);
  const completed = Date.parse(result.completed_at);
  const speed = result.speed || {};
  return Number.isFinite(started) && Number.isFinite(completed) && completed > started
    && Number.isSafeInteger(Number(speed.submit_latency_ms)) && Number(speed.submit_latency_ms) >= 0
    && Number.isFinite(Number(speed.generation_elapsed_seconds)) && Number(speed.generation_elapsed_seconds) > 0
    && Number.isSafeInteger(Number(speed.download_latency_ms)) && Number(speed.download_latency_ms) >= 0
    && Number.isFinite(Number(speed.total_elapsed_seconds))
    && Number(speed.total_elapsed_seconds) >= Number(speed.generation_elapsed_seconds);
}

function hasCompleteRequiredMatrix(results) {
  return Array.isArray(results) && results.length === 1 && validateCompletedResult(results[0]);
}

function validatePricingSnapshot(pricing) {
  return Boolean(pricing
    && pricing.provider_settings_url === PUBLIC_SETTINGS_URL
    && /^[a-f0-9]{64}$/.test(String(pricing.response_sha256 || ''))
    && Number.isFinite(Date.parse(pricing.captured_at))
    && pricing.model_key === UPSTREAM_MODEL
    && pricing.public_model === PUBLIC_MODEL
    && pricing.billing_mode === 'per_second'
    && Number(pricing.price_per_second_credits) === 1
    && Number(pricing.rmb_per_credit) === 0.17
    && Number(pricing.cost_yuan_per_second) === 0.17
    && Number(pricing.credits_per_second) === 149
    && pricing.reviewed === true);
}

async function fetchPublicPricing(fetchImpl = fetch, now = new Date()) {
  const response = await fetchImpl(PUBLIC_SETTINGS_URL, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`灵境公开计费配置读取失败 (${response.status})`);
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { throw new Error('灵境公开计费配置不是 JSON'); }
  const model = Array.isArray(payload?.models) ? payload.models.find((item) => item?.key === UPSTREAM_MODEL) : null;
  if (payload?.api_model_name !== PUBLIC_MODEL || !model || model.billing_mode !== 'per_second'
      || Number(model.price_per_second) !== 1 || Number(payload.rmb_per_credit) !== 0.17
      || Number(model.max_images) !== MAX_IMAGE_REFERENCES || Number(model.max_videos) !== 0
      || Number(model.max_audios) !== 0 || model.audio_supported !== false
      || JSON.stringify(model.allowed_durations) !== JSON.stringify(DURATIONS)
      || JSON.stringify(model.allowed_ratios) !== JSON.stringify(RATIOS)
      || !Array.isArray(model.resolutions) || model.resolutions.length !== 0) {
    throw new Error('灵境 relay 公开能力或计费与审核合同不一致');
  }
  const cost = round(Number(model.price_per_second) * Number(payload.rmb_per_credit), 6);
  return {
    provider_settings_url: PUBLIC_SETTINGS_URL,
    response_sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    captured_at: new Date(now).toISOString(),
    model_key: UPSTREAM_MODEL,
    public_model: PUBLIC_MODEL,
    billing_mode: 'per_second',
    price_per_second_credits: Number(model.price_per_second),
    rmb_per_credit: Number(payload.rmb_per_credit),
    cost_yuan_per_second: cost,
    credits_per_second: Math.ceil(cost * 875),
    max_image_references: Number(model.max_images),
    allowed_durations: [...model.allowed_durations],
    allowed_ratios: [...model.allowed_ratios],
    resolutions: [...model.resolutions],
    reviewed: true,
  };
}

function buildReleaseEvidence(results, pricing, now = new Date(), referenceSha256 = '') {
  const generated = new Date(now);
  if (!Number.isFinite(generated.getTime()) || !hasCompleteRequiredMatrix(results)) {
    throw new Error('灵境真实验证尚未完整通过');
  }
  if (!validatePricingSnapshot(pricing)) throw new Error('灵境公开计费尚未审核通过');
  if (referenceSha256 && !/^[a-f0-9]{64}$/.test(referenceSha256)) throw new Error('灵境参考图 SHA-256 无效');
  if (referenceSha256 && results[0].provider_audit.uploads[0].reference_sha256 !== referenceSha256) {
    throw new Error('灵境上传路径未绑定到本次参考图 SHA-256');
  }
  return redactEvidence({
    contract_version: EVIDENCE_VERSION,
    provider_origin: 'https://seed.alimyun.xyz',
    generated_at: generated.toISOString(),
    valid_until: new Date(generated.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    verification_scope: {
      public_model: PUBLIC_MODEL,
      upstream_model: UPSTREAM_MODEL,
      real_case: { duration: 4, aspect_ratio: '16:9', reference_images: 1, resolution: null },
      documented_capabilities: {
        durations: [...DURATIONS],
        aspect_ratios: [...RATIOS],
        resolutions: [],
        max_image_references: MAX_IMAGE_REFERENCES,
        max_video_references: 0,
        max_audio_references: 0,
        supports_first_frame: false,
        supports_last_frame: false,
        supports_audio: false,
      },
      reference_image_sha256: referenceSha256 || null,
    },
    results,
    pricing,
    speed_evidence: {
      measurement_basis: 'actual_paid_verification_run_not_provider_sla',
      cases: results.map((result) => ({
        id: result.id,
        model: result.model,
        submit_latency_ms: result.speed.submit_latency_ms,
        generation_elapsed_seconds: result.speed.generation_elapsed_seconds,
        download_latency_ms: result.speed.download_latency_ms,
        total_elapsed_seconds: result.speed.total_elapsed_seconds,
      })),
    },
  });
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
    if (error.code === 'EEXIST') throw new Error('已有灵境真实验证进程，禁止并发付费提交');
    throw error;
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  return () => {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  };
}

function requireAbsoluteFile(filePath, label) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error(`${label}必须是绝对路径`);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}必须是普通文件`);
  return fs.readFileSync(filePath);
}

function resolvePaths(env) {
  const outputDir = path.resolve(String(env.LINGJING_VERIFY_OUTPUT_DIR || ''));
  const publicDir = path.resolve(String(env.LINGJING_VERIFY_PUBLIC_ARTIFACT_DIR || ''));
  if (!env.LINGJING_VERIFY_OUTPUT_DIR || !env.LINGJING_VERIFY_PUBLIC_ARTIFACT_DIR
      || !path.isAbsolute(env.LINGJING_VERIFY_OUTPUT_DIR) || !path.isAbsolute(env.LINGJING_VERIFY_PUBLIC_ARTIFACT_DIR)
      || outputDir === publicDir) throw new Error('灵境验证私有目录与公网成品目录必须是不同的绝对路径');
  const publicBaseUrl = String(env.LINGJING_VERIFY_PUBLIC_ASSET_BASE_URL || '').replace(/\/+$/, '');
  if (publicBaseUrl !== 'https://molimama.vip/verification-assets/lingjing') {
    throw new Error('灵境公网成品基址必须固定为 https://molimama.vip/verification-assets/lingjing');
  }
  return {
    outputDir,
    publicDir,
    publicBaseUrl,
    statePath: path.join(outputDir, 'lingjing-video-verification-state.json'),
    evidencePath: path.join(outputDir, 'lingjing-video-verification.json'),
    failurePath: path.join(outputDir, 'lingjing-video-verification-failure.json'),
    lockPath: path.join(outputDir, '.lingjing-video-verification.lock'),
  };
}

function loadCredentialsAndReference(env) {
  const apiKey = requireAbsoluteFile(String(env.LINGJING_VERIFY_API_KEY_FILE || ''), 'LINGJING_VERIFY_API_KEY_FILE').toString('utf8').trim();
  if (!apiKey) throw new Error('灵境验证密钥文件为空');
  if (env.LINGJING_VERIFY_REFERENCE_DECLARATION !== REFERENCE_DECLARATION) {
    throw new Error(`LINGJING_VERIFY_REFERENCE_DECLARATION 必须是 ${REFERENCE_DECLARATION}`);
  }
  const referenceFile = String(env.LINGJING_VERIFY_REFERENCE_IMAGE_FILE || '');
  const bytes = requireAbsoluteFile(referenceFile, 'LINGJING_VERIFY_REFERENCE_IMAGE_FILE');
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('灵境验证参考图大小无效');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const expected = String(env.LINGJING_VERIFY_REFERENCE_IMAGE_SHA256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== sha256) throw new Error('灵境验证参考图 SHA-256 不匹配');
  const extension = path.extname(referenceFile).toLowerCase();
  const mimeType = extension === '.png' ? 'image/png' : ['.jpg', '.jpeg'].includes(extension) ? 'image/jpeg' : '';
  if (!mimeType) throw new Error('灵境验证参考图只允许 PNG/JPEG');
  return { apiKey, reference: { bytes, mimeType, filename: path.basename(referenceFile) }, referenceSha256: sha256 };
}

async function assertPublicArtifact(url, expectedSha256, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  if (response.status !== 200) throw new Error(`灵境成品公网读取失败 (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    throw new Error('灵境公网成品与本地文件哈希不一致');
  }
}

async function verifyStoredArtifact(entry, context, deps = {}) {
  if (!validateCompletedResult(entry)) throw new Error('灵境已保存结果结构无效');
  const filePath = path.join(context.publicDir, entry.artifact.output_file);
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('灵境已保存成品不是普通文件');
  const bytes = await fs.promises.readFile(filePath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== entry.artifact.sha256) throw new Error('灵境已保存成品哈希不一致');
  const ffprobe = (deps.runFfprobe || runFfprobe)(filePath);
  validateMediaEvidence(ffprobe);
  await (deps.assertPublicArtifact || assertPublicArtifact)(entry.artifact.public_url, sha256, deps.fetchImpl || fetch);
  entry.artifact.ffprobe = ffprobe;
}

async function waitForTask(config, taskId, context, deps = {}) {
  const pollMs = Number(deps.pollMs ?? context.env.LINGJING_VERIFY_POLL_MS ?? 10000);
  const maxPolls = Number(deps.maxPolls ?? context.env.LINGJING_VERIFY_MAX_POLLS ?? 180);
  for (let index = 0; index < maxPolls; index += 1) {
    if (index > 0 || !deps.skipInitialWait) await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(pollMs);
    const status = await fetchLingjingTask(config, taskId, {
      fetchImpl: deps.fetchImpl || fetch,
      captureAudit: true,
    });
    if (status.state === 'completed') return status;
    if (status.state === 'failed') throw new Error(status.error || '灵境任务失败');
  }
  throw new Error('灵境任务轮询超时；任务编号已保存，禁止重新提交，可继续轮询');
}

async function downloadAndInspect(config, taskId, filePath, publicUrl, deps = {}) {
  try {
    await fs.promises.lstat(filePath);
    throw new Error('灵境成品目标文件已存在，拒绝覆盖');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const started = Date.now();
  const response = await (deps.fetchImpl || fetch)(buildLingjingDownloadUrl(config.base_url, taskId), {
    headers: { Authorization: `Bearer ${config.api_key}` },
  });
  if (!response.ok) throw new Error(`灵境成品下载失败 (${response.status})`);
  const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['video/mp4', 'application/octet-stream'].includes(contentType)) throw new Error(`灵境成品 MIME 不是 MP4: ${contentType}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024) throw new Error('灵境成品为空或过小');
  let created = false;
  try {
    const handle = await fs.promises.open(filePath, 'wx', 0o444);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    created = true;
    await fs.promises.chmod(filePath, 0o444);
    const ffprobe = (deps.runFfprobe || runFfprobe)(filePath);
    validateMediaEvidence(ffprobe);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    await (deps.assertPublicArtifact || assertPublicArtifact)(publicUrl, sha256, deps.fetchImpl || fetch);
    return {
      artifact: {
        public_url: publicUrl,
        output_file: path.basename(filePath),
        content_type: 'video/mp4',
        bytes: bytes.length,
        sha256,
        ffprobe,
      },
      downloadLatencyMs: Date.now() - started,
    };
  } catch (error) {
    if (created) await fs.promises.unlink(filePath).catch(() => {});
    throw error;
  }
}

async function processCase(context, deps = {}) {
  const item = buildVerificationCase();
  let entry = context.state.cases[item.id];
  const action = decideResumeAction(entry);
  if (action === 'stop-indeterminate') throw new Error('灵境创建结果不确定，禁止自动重试');
  if (action === 'stop-rejected') throw new Error('灵境创建已明确失败，禁止自动重试');
  if (action === 'finalize') {
    await verifyStoredArtifact(entry, context, deps);
    return entry;
  }
  if (action === 'submit') {
    const started = new Date();
    const requestId = (deps.randomUUID || crypto.randomUUID)();
    entry = {
      id: item.id,
      model: item.model,
      upstream_model: item.upstreamModel,
      mode: item.mode,
      requested_duration: item.duration,
      requested_aspect_ratio: item.aspectRatio,
      requested_resolution: null,
      reference_count: 1,
      request_id: requestId,
      request: { model_key: UPSTREAM_MODEL, duration: 4, ratio: '16:9', reference_count: 1, request_id: requestId },
      status: 'submitting',
      submission_state: 'submitting',
      started_at: started.toISOString(),
    };
    context.state.cases[item.id] = entry;
    writeJsonAtomic(context.statePath, context.state);
    const created = await callLingjingVideoApi(context.config, LOG, buildVerificationRequest(item, {
      requestId,
      reference: context.reference,
    }), { fetchImpl: deps.fetchImpl || fetch, captureAudit: true });
    const accepted = new Date();
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
      entry.error = created.error || '灵境未返回 task_id';
      writeJsonAtomic(context.statePath, context.state);
      throw new Error(entry.error);
    }
    entry.provider_task_id = String(created.task_id);
    entry.provider_audit = created.provider_audit;
    entry.submission_state = 'accepted';
    entry.status = 'processing';
    entry.speed = { submit_latency_ms: accepted.getTime() - started.getTime() };
    writeJsonAtomic(context.statePath, context.state);
  }
  const terminal = await waitForTask(context.config, entry.provider_task_id, context, deps);
  const creationCostFields = Array.isArray(entry.provider_audit?.supplier_cost_fields)
    ? entry.provider_audit.supplier_cost_fields : [];
  const terminalCostFields = Array.isArray(terminal.provider_audit?.supplier_cost_fields)
    ? terminal.provider_audit.supplier_cost_fields : [];
  entry.provider_audit = {
    ...entry.provider_audit,
    terminal_response_sha256: terminal.provider_audit?.terminal_response_sha256,
    terminal_http_status: terminal.provider_audit?.terminal_http_status,
    supplier_cost_fields: [...creationCostFields, ...terminalCostFields],
    supplier_cost_unavailable: creationCostFields.length + terminalCostFields.length === 0,
  };
  const completed = new Date();
  const fileName = `${item.id}-${entry.provider_task_id}.mp4`.replace(/[^A-Za-z0-9._~-]+/g, '-');
  const downloaded = await downloadAndInspect(
    context.config,
    entry.provider_task_id,
    path.join(context.publicDir, fileName),
    `${context.publicBaseUrl}/${fileName}`,
    deps,
  );
  entry.status = 'completed';
  entry.completed_at = completed.toISOString();
  entry.artifact = downloaded.artifact;
  entry.speed = {
    ...entry.speed,
    generation_elapsed_seconds: round((completed.getTime() - Date.parse(entry.started_at)) / 1000),
    download_latency_ms: downloaded.downloadLatencyMs,
    total_elapsed_seconds: round((Date.now() - Date.parse(entry.started_at)) / 1000),
  };
  writeJsonAtomic(context.statePath, context.state);
  return entry;
}

async function runVerification(deps = {}) {
  const env = deps.env || process.env;
  if (env.LINGJING_VERIFY_CONFIRM_PAID_CALL !== CONFIRMATION) {
    throw new Error(`LINGJING_VERIFY_CONFIRM_PAID_CALL 必须是 ${CONFIRMATION}`);
  }
  normalizeLingjingBaseUrl(env.LINGJING_BASE_URL || OFFICIAL_BASE_URL);
  const paths = resolvePaths(env);
  fs.mkdirSync(paths.outputDir, { recursive: true });
  fs.mkdirSync(paths.publicDir, { recursive: true });
  const releaseLock = acquireLock(paths.lockPath);
  try {
    const { apiKey, reference, referenceSha256 } = loadCredentialsAndReference(env);
    const state = readJson(paths.statePath, { state_version: STATE_VERSION, cases: {} });
    if (state.state_version !== STATE_VERSION || !state.cases) throw new Error('灵境验证状态文件版本不兼容');
    const context = {
      ...paths,
      env,
      config: { base_url: OFFICIAL_BASE_URL, api_key: apiKey },
      reference,
      state,
    };
    const result = await processCase(context, deps);
    await verifyStoredArtifact(result, context, deps);
    const pricing = await fetchPublicPricing(deps.fetchImpl || fetch, deps.now || new Date());
    const evidence = buildReleaseEvidence([result], pricing, deps.now || new Date(), referenceSha256);
    writeJsonAtomic(paths.evidencePath, evidence);
    process.stdout.write(`LINGJING_VIDEO_VERIFIED 1/1 task=${result.provider_task_id} generation_seconds=${result.speed.generation_elapsed_seconds} evidence=${paths.evidencePath}\n`);
    return evidence;
  } catch (error) {
    writeJsonAtomic(paths.failurePath, {
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
    process.stderr.write(`LINGJING_VIDEO_VERIFICATION_FAILED: ${redactEvidence(error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EVIDENCE_VERSION,
  buildReleaseEvidence,
  buildVerificationCase,
  buildVerificationRequest,
  decideResumeAction,
  downloadAndInspect,
  fetchPublicPricing,
  hasCompleteRequiredMatrix,
  parseFfprobeJson,
  processCase,
  redactEvidence,
  runVerification,
  validateCompletedResult,
  validatePricingSnapshot,
};
