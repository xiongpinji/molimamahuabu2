#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const aiConfigService = require('../src/services/aiConfigService');
const videoClient = require('../src/services/videoClient');
const {
  EXPECTED_CAST_SHA256,
  EXPECTED_SOURCE_SHA256,
  ICREAT_MINI_MODEL,
  buildIcreatMiniCaseSnapshot,
  buildRedactedEvidence,
  canonicalJson,
  consumeSubmissionLock,
  createSubmissionLock,
  prepareCaseMedia,
  updateSubmissionLock,
  verifyCandidateMedia,
} = require('../src/services/icreatMiniReferenceVideoCaseService');
const { startTemporaryMediaTunnel } = require('../src/services/temporaryMediaTunnelService');

const PAID_CONFIRMATION = 'ICREAT_MINI_ONE_PAID_SUBMISSION';
const MAX_CREDITS = 50;
const MAX_USD = 0.25;
const PRICE_CONFIRMATION_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_SOURCE_PATH = 'C:\\Users\\canqu\\Desktop\\ac087bcd4cf5f856f85182834794853a.mp4';
const DEFAULT_CAST_PATH = path.resolve(
  __dirname,
  '..', '..', 'frontweb', 'e2e', 'fixtures', 'redraw-latin-american-case', 'actor-cast-reference.png',
);
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..', 'output', 'icreat-mini-reference-video');

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (value == null || String(value).startsWith('--')) {
    throw codedError('ICREAT_CASE_CLI_INVALID', `${name} 缺少参数值`);
  }
  return value;
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    sourcePath: DEFAULT_SOURCE_PATH,
    castPath: DEFAULT_CAST_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    databasePath: null,
    submitPaidOnce: false,
    maxCredits: null,
    maxUsd: null,
    confirmation: '',
    expectedCredits: null,
    expectedUsd: null,
    availableCredits: null,
    priceSource: '',
    priceConfirmedAt: '',
    help: false,
  };
  const valueFlags = new Map([
    ['--source', 'sourcePath'],
    ['--cast', 'castPath'],
    ['--output-dir', 'outputDir'],
    ['--database', 'databasePath'],
    ['--max-credits', 'maxCredits'],
    ['--max-usd', 'maxUsd'],
    ['--confirm', 'confirmation'],
    ['--expected-credits', 'expectedCredits'],
    ['--expected-usd', 'expectedUsd'],
    ['--available-credits', 'availableCredits'],
    ['--price-source', 'priceSource'],
    ['--price-confirmed-at', 'priceConfirmedAt'],
  ]);
  const numericFields = new Set(['maxCredits', 'maxUsd', 'expectedCredits', 'expectedUsd', 'availableCredits']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--submit-paid-once') {
      options.submitPaidOnce = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const field = valueFlags.get(arg);
    if (!field) throw codedError('ICREAT_CASE_CLI_INVALID', `未知参数: ${arg}`);
    const value = readValue(argv, index, arg);
    options[field] = numericFields.has(field) ? parseNumber(value) : value;
    index += 1;
  }
  options.sourcePath = path.resolve(options.sourcePath);
  options.castPath = path.resolve(options.castPath);
  options.outputDir = path.resolve(options.outputDir);
  if (options.databasePath) options.databasePath = path.resolve(options.databasePath);
  options.mode = options.submitPaidOnce ? 'paid-once' : 'dry-run';
  return options;
}

function assertPaidAuthorization(options = {}, preflight = {}) {
  const maxCredits = Number(options.maxCredits);
  const maxUsd = Number(options.maxUsd);
  if (options.submitPaidOnce !== true || options.confirmation !== PAID_CONFIRMATION
    || !Number.isFinite(maxCredits) || maxCredits <= 0 || maxCredits > MAX_CREDITS
    || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > MAX_USD) {
    throw codedError(
      'ICREAT_PAID_AUTHORIZATION_REQUIRED',
      '付费提交需要精确确认短语及不超过 50 积分 / 0.25 美元的双重上限',
    );
  }
  const expectedCredits = Number(preflight.expectedCredits);
  const expectedUsd = Number(preflight.expectedUsd);
  if (preflight.priceConfirmed !== true || preflight.keyGroupAuthorized !== true
    || preflight.balanceSufficient !== true
    || !Number.isFinite(expectedCredits) || expectedCredits <= 0 || expectedCredits > maxCredits
    || !Number.isFinite(expectedUsd) || expectedUsd < 0 || expectedUsd > maxUsd) {
    throw codedError(
      'ICREAT_PAID_PREFLIGHT_FAILED',
      'iCreat 价格、余额或 Key 分组只读预检未通过，禁止提交',
    );
  }
  return { expectedCredits, expectedUsd, maxCredits, maxUsd };
}

function parseSettings(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function loadLocalIcreatConfig(options = {}) {
  const Database = require('better-sqlite3');
  let databasePath = options.databasePath;
  if (!databasePath) {
    const { loadConfig } = require('../src/config');
    const config = loadConfig();
    databasePath = path.resolve(process.cwd(), String(config.database?.path || ''));
  }
  let db;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const config = videoClient.getDefaultVideoConfig(db, ICREAT_MINI_MODEL);
    const provider = String(config?.provider || '').trim().toLowerCase();
    const protocol = videoClient.resolveVideoProtocol(config || {}, ICREAT_MINI_MODEL);
    const configuredModels = [
      ...(Array.isArray(config?.model) ? config.model : [config?.model]),
      config?.default_model,
    ].map((value) => String(value || '').trim()).filter(Boolean).map(videoClient.normalizeIcreatModel);
    if (!config || !['icreat', 'icreat_ai', 'icreat-seedance'].includes(provider)
      || protocol !== 'icreat_task' || !configuredModels.includes(ICREAT_MINI_MODEL)
      || !String(config.api_key || '').trim()) {
      throw codedError('ICREAT_PAID_PREFLIGHT_FAILED', '本地数据库中没有可用的精确 iCreat Mini 配置');
    }
    return { db, config, databasePath };
  } catch (error) {
    db?.close?.();
    if (error?.code) throw error;
    throw codedError('ICREAT_PAID_PREFLIGHT_FAILED', '无法只读打开本地 iCreat 配置', error);
  }
}

async function runReadOnlyPreflight({ config, options, nowMs = Date.now() }) {
  let keyGroupAuthorized = false;
  try {
    await aiConfigService.testConnection({
      base_url: config.base_url,
      api_key: config.api_key,
      model: config.model,
      provider: config.provider,
      endpoint: config.endpoint,
      query_endpoint: config.query_endpoint,
      api_protocol: config.api_protocol,
      service_type: config.service_type,
      settings: config.settings,
    });
    keyGroupAuthorized = true;
  } catch (_) {
    keyGroupAuthorized = false;
  }
  const expectedCredits = Number(options.expectedCredits);
  const expectedUsd = Number(options.expectedUsd);
  const availableCredits = Number(options.availableCredits);
  const confirmedAt = Date.parse(String(options.priceConfirmedAt || ''));
  const ageMs = nowMs - confirmedAt;
  const priceConfirmed = String(options.priceSource || '').trim().toLowerCase() === 'icreat-console'
    && Number.isFinite(confirmedAt) && ageMs >= -60_000 && ageMs <= PRICE_CONFIRMATION_MAX_AGE_MS
    && Number.isFinite(expectedCredits) && expectedCredits > 0
    && Number.isFinite(expectedUsd) && expectedUsd >= 0;
  return {
    priceConfirmed,
    keyGroupAuthorized,
    balanceSufficient: Number.isFinite(availableCredits) && availableCredits >= expectedCredits,
    expectedCredits,
    expectedUsd,
    availableCredits,
    configId: Number(config.id),
    groupConfigured: Boolean(String(parseSettings(config.settings).icreat_group || 'default')),
  };
}

function runId(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(6).toString('hex')}`;
}

function stableSubmissionHash(snapshot, media) {
  return crypto.createHash('sha256').update(canonicalJson({
    contract: 'icreat-mini-reference-video-real-shot-v1',
    source_sha256: media.source.sha256,
    cast_sha256: media.cast.sha256,
    model: snapshot.model,
    prompt: snapshot.prompt,
    duration: snapshot.duration,
    resolution: snapshot.resolution,
    aspect_ratio: snapshot.aspect_ratio,
    generate_audio: snapshot.generate_audio,
  })).digest('hex');
}

function dryRunUrls(media) {
  return {
    shot: `https://dry-run.localhost.run/${media.segment.sha256}`,
    mateo: `https://dry-run.localhost.run/${media.mateo.sha256}`,
    cast: `https://dry-run.localhost.run/${media.cast.sha256}`,
  };
}

function snapshotFromMedia(media, urls) {
  return buildIcreatMiniCaseSnapshot({
    sourceSha256: media.source.sha256,
    castSha256: media.cast.sha256,
    sourceProbe: media.source.probe,
    segmentSha256: media.segment.sha256,
    mateoSha256: media.mateo.sha256,
    segmentUrl: urls.shot,
    mateoUrl: urls.mateo,
    castUrl: urls.cast,
  });
}

function mediaEvidence(media, candidate) {
  return {
    source: { sha256: media.source.sha256 },
    segment: {
      sha256: media.segment.sha256,
      width: media.segment.probe?.width,
      height: media.segment.probe?.height,
      duration_seconds: media.segment.probe?.durationSeconds,
      video_codec: media.segment.probe?.videoCodec,
      audio_codec: media.segment.probe?.audioCodec,
      audio_mode: 'strip',
    },
    mateo: { sha256: media.mateo.sha256 },
    cast: { sha256: media.cast.sha256 },
    ...(candidate ? { candidate } : {}),
  };
}

function ensureRunDirectory(outputDir, id) {
  const runDirectory = path.join(outputDir, 'runs', id);
  fs.mkdirSync(runDirectory, { recursive: true });
  try { fs.chmodSync(runDirectory, 0o700); } catch (_) {}
  return runDirectory;
}

async function writeEvidence(runDirectory, evidence) {
  const target = path.join(runDirectory, 'evidence.json');
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return target;
}

function privateLog() {
  return { info() {}, warn() {}, error() {} };
}

async function downloadCandidate(url, targetPath, options = {}) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch (_) {}
  if (!parsed || parsed.protocol !== 'https:') {
    throw codedError('ICREAT_CASE_CANDIDATE_INVALID', '候选下载地址必须是 HTTPS');
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(parsed.toString(), {
    method: 'GET',
    redirect: 'follow',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(60_000)
      : undefined,
  });
  if (!response?.ok) throw codedError('ICREAT_CASE_CANDIDATE_INVALID', `候选下载失败: ${response?.status}`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > 100 * 1024 * 1024) {
    throw codedError('ICREAT_CASE_CANDIDATE_INVALID', '候选视频超过 100MB 上限');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 100 * 1024 * 1024) {
    throw codedError('ICREAT_CASE_CANDIDATE_INVALID', '候选视频为空或超过 100MB 上限');
  }
  fs.writeFileSync(targetPath, bytes, { flag: 'wx' });
  return targetPath;
}

async function runCase(options = parseArgs(), deps = {}) {
  const prepareMedia = deps.prepareCaseMedia || prepareCaseMedia;
  const loadConfig = deps.loadLocalIcreatConfig || loadLocalIcreatConfig;
  const paidPreflight = deps.runReadOnlyPreflight || runReadOnlyPreflight;
  const startTunnel = deps.startTemporaryMediaTunnel || startTemporaryMediaTunnel;
  const callVideo = deps.callVideoApi || videoClient.callVideoApi;
  const pollVideo = deps.pollVideoTask || videoClient.pollVideoTask;
  const download = deps.downloadCandidate || downloadCandidate;
  const verifyCandidate = deps.verifyCandidateMedia || verifyCandidateMedia;
  const persistEvidence = deps.writeEvidence || writeEvidence;
  const id = deps.runId || runId();
  const runDirectory = ensureRunDirectory(options.outputDir || DEFAULT_OUTPUT_DIR, id);
  let media;
  let tunnel;
  let db;
  let config;
  let snapshot;
  let providerTaskId;
  let lockConsumed = false;
  let evidencePath;
  try {
    media = await prepareMedia({ sourcePath: options.sourcePath, castPath: options.castPath });
    if (options.mode !== 'paid-once') {
      snapshot = snapshotFromMedia(media, dryRunUrls(media));
      const evidence = buildRedactedEvidence({
        run_id: id,
        request_snapshot_sha256: snapshot.request_sha256,
        status: 'dry_run',
        media: mediaEvidence(media),
      });
      evidencePath = await persistEvidence(runDirectory, evidence);
      return {
        mode: 'dry-run',
        run_id: id,
        source_sha256: media.source.sha256,
        segment_sha256: media.segment.sha256,
        mateo_sha256: media.mateo.sha256,
        cast_sha256: media.cast.sha256,
        request_snapshot_sha256: snapshot.request_sha256,
        evidence_path: evidencePath,
        provider_called: false,
        tunnel_started: false,
      };
    }

    ({ db, config } = await loadConfig(options));
    const preflight = await paidPreflight({ config, options });
    const cost = assertPaidAuthorization(options, preflight);
    tunnel = await startTunnel({
      assets: [
        { id: 'shot', path: media.segment.path, contentType: 'video/mp4' },
        { id: 'mateo', path: media.mateo.path, contentType: 'image/png' },
        { id: 'cast', path: media.cast.path, contentType: 'image/png' },
      ],
    });
    const tunneled = Object.fromEntries((tunnel.urls || []).map((item) => [item.id, item]));
    if (!['shot', 'mateo', 'cast'].every((key) => tunneled[key]?.head_ok === true)) {
      throw codedError('ICREAT_PAID_PREFLIGHT_FAILED', '三份临时媒体 HEAD 预检未全部通过');
    }
    snapshot = snapshotFromMedia(media, {
      shot: tunneled.shot.url,
      mateo: tunneled.mateo.url,
      cast: tunneled.cast.url,
    });
    const submissionHash = deps.requestHashForTest || stableSubmissionHash(snapshot, media);
    const statePath = options.statePath || path.join(options.outputDir, 'locks', `${submissionHash}.json`);
    createSubmissionLock(statePath, submissionHash);
    consumeSubmissionLock(statePath, submissionHash, { attempted_at: new Date().toISOString() });
    lockConsumed = true;

    const result = await callVideo(db, privateLog(), snapshot);
    if (result?.task_id) {
      providerTaskId = String(result.task_id);
      updateSubmissionLock(statePath, submissionHash, {
        status: 'submitted', task_id: providerTaskId, updated_at: new Date().toISOString(),
      });
    }
    if (result?.error || (!result?.task_id && !result?.video_url)) {
      throw codedError('ICREAT_CASE_SUBMISSION_UNKNOWN', 'iCreat POST 未返回可确认的任务或结果，禁止重试');
    }
    let videoUrl = result.video_url;
    if (!videoUrl) {
      const polled = await pollVideo(db, privateLog(), id, providerTaskId, config, 60, 10_000);
      if (polled?.indeterminate) {
        updateSubmissionLock(statePath, submissionHash, { status: 'needs_attention', updated_at: new Date().toISOString() });
        throw codedError('ICREAT_CASE_NEEDS_ATTENTION', '供应商状态不确定，禁止重试');
      }
      if (polled?.error || !polled?.video_url) {
        updateSubmissionLock(statePath, submissionHash, { status: 'failed', updated_at: new Date().toISOString() });
        throw codedError('ICREAT_CASE_PROVIDER_FAILED', 'iCreat 任务失败或没有可下载结果');
      }
      videoUrl = polled.video_url;
    }
    const candidatePath = path.join(runDirectory, 'candidate.mp4');
    await download(videoUrl, candidatePath);
    const candidate = await verifyCandidate({ outputPath: candidatePath });
    const evidence = buildRedactedEvidence({
      run_id: id,
      config_id: config.id,
      task_id: providerTaskId,
      request_snapshot_sha256: snapshot.request_sha256,
      status: 'succeeded_pending_manual_review',
      estimated_cost: { credits: cost.expectedCredits, usd: cost.expectedUsd },
      media: mediaEvidence(media, candidate),
    });
    evidencePath = await persistEvidence(runDirectory, evidence);
    updateSubmissionLock(statePath, submissionHash, {
      status: 'succeeded_pending_manual_review', clear_task_id: true, updated_at: new Date().toISOString(),
    });
    return {
      mode: 'paid-once',
      run_id: id,
      request_snapshot_sha256: snapshot.request_sha256,
      provider_task_id_sha256: providerTaskId ? crypto.createHash('sha256').update(providerTaskId).digest('hex') : null,
      candidate_sha256: candidate.sha256,
      evidence_path: evidencePath,
      visual_actor_replacement_verified: false,
    };
  } catch (error) {
    if (lockConsumed) {
      const status = ['ICREAT_CASE_NEEDS_ATTENTION', 'ICREAT_CASE_SUBMISSION_UNKNOWN'].includes(error?.code)
        ? error.code === 'ICREAT_CASE_NEEDS_ATTENTION' ? 'needs_attention' : 'submission_unknown'
        : 'failed';
      const evidence = buildRedactedEvidence({
        run_id: id,
        config_id: config?.id,
        task_id: providerTaskId,
        request_snapshot_sha256: snapshot?.request_sha256,
        status,
        media: media ? mediaEvidence(media) : {},
      });
      try { evidencePath = await persistEvidence(runDirectory, evidence); } catch (_) {}
    }
    throw error;
  } finally {
    await tunnel?.close?.();
    db?.close?.();
    await media?.cleanup?.();
  }
}

function helpText() {
  return [
    '默认仅执行本地 dry-run，不读取 Key、不启动隧道、不调用供应商。',
    '用法: npm run verify:icreat-mini-reference-video -- --source <mp4>',
    '付费分支还必须显式提供 --submit-paid-once、费用/余额只读快照、双重上限和确认短语。',
  ].join('\n');
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const result = await runCase(options);
  for (const [key, value] of Object.entries(result)) {
    if (value !== null && value !== undefined) process.stdout.write(`${key}=${value}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`error_code=${error.code || 'ICREAT_CASE_FAILED'}\n`);
    process.stderr.write(`error=${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PAID_CONFIRMATION,
  assertPaidAuthorization,
  downloadCandidate,
  loadLocalIcreatConfig,
  parseArgs,
  runCase,
  runReadOnlyPreflight,
};
