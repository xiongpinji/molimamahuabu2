#!/usr/bin/env node
'use strict';

/**
 * 为一个转绘语区（locale + market）生成真实的能力证据并写回 ai_service_configs。
 *
 * 合同（AGENTS.md「外部模型上线」）：只有目标 Key 真实生成成功、产物落盘且可回读，
 * 才写入 settings.redraw_locale_capabilities[].evidence.<capability>；不复制其它语区证据。
 *
 * 默认 dry-run：只校验配置、Key 是否存在、模型与价格，不发起任何供应商请求。
 * 付费执行必须同时提供 --commit 和 --confirm=AUTHORIZE_REDRAW_LOCALE_CAPABILITY_EVIDENCE。
 * 每项能力只提交一次，失败或结果未知时停止该项，不自动重新提交（只对产物下载做有限重试）。
 * 视频已在供应商完成但下载失败时，用 --resume-video-task=<task_id> 只重新查询/下载，不再付费提交。
 * 输出不包含任何密钥或供应商 URL。
 *
 * 用法：
 *   node scripts/run-redraw-locale-capability-evidence.js --locale=en-US --market=US \
 *     --capabilities=text,subtitles,character_image,clean_plate_image,video \
 *     --text-config=22 --image-config=26 --video-config=27 --carrier-config=22 [--commit --confirm=...]
 */

require('../src/config/dotenv.js').loadDotenv();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadConfig } = require('../src/config/index.js');
const Database = require('better-sqlite3');
const token6688Client = require('../src/services/token6688Client');
const toapisVideoClient = require('../src/services/toapisVideoClient');
const capabilityService = require('../src/services/redrawCapabilityService');
const { createAssetReader } = require('../src/services/redrawOrchestrator');

const CONFIRM = 'AUTHORIZE_REDRAW_LOCALE_CAPABILITY_EVIDENCE';
const SUPPORTED = ['text', 'subtitles', 'character_image', 'clean_plate_image', 'video'];
const VIDEO_POLL_MS = 10000;
const VIDEO_TIMEOUT_MS = 15 * 60 * 1000;

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(item);
    if (match) args[match[1]] = match[2] === undefined ? true : match[2];
  }
  return args;
}

function fail(message) {
  process.stderr.write(`[fatal] ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stderr.write(`[info] ${message}\n`);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function modelOf(row) {
  const direct = String(row.default_model || '').trim();
  if (direct) return direct;
  try {
    const list = JSON.parse(row.model || '[]');
    return String(Array.isArray(list) ? list[0] || '' : list).trim();
  } catch (_) {
    return String(row.model || '').trim();
  }
}

function loadServiceConfig(db, id, serviceTypes) {
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) fail(`config #${id} 不存在`);
  if (!row.is_active) fail(`config #${id} 未启用`);
  if (!serviceTypes.includes(String(row.service_type))) fail(`config #${id} service_type=${row.service_type}，需要 ${serviceTypes.join('/')}`);
  if (!String(row.api_key || '').trim()) fail(`config #${id} 缺少 API Key`);
  return row;
}

function priceOf(db, model) {
  try {
    return db.prepare('SELECT credits, billing_unit, pricing_mode FROM model_credit_prices WHERE model = ?').get(model) || null;
  } catch (_) {
    return null;
  }
}

function storageRoot(cfg) {
  const raw = cfg?.storage?.local_path || './data/storage';
  const resolved = path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  // 与后端 canReadArtifact 使用同一个物理根目录，避免符号链接/目录联接导致回读校验误判。
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, '_');
}

function writeArtifact(db, root, { locale, market, capability, taskId, buffer, ext, mime, type, metadata }) {
  const rel = `_system/redraw-locale-evidence/${slug(locale)}-${slug(market || 'none')}/${capability}/${slug(taskId)}.${ext}`;
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  const now = new Date().toISOString();
  const digest = sha256(buffer);
  const id = Number(db.prepare(`
    INSERT INTO assets
      (drama_id, name, type, category, url, local_path, file_size, mime_type, created_at, updated_at, metadata)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `redraw ${locale}/${market} ${capability} evidence`,
    type,
    `redraw_locale_evidence_${capability}`,
    `/static/${rel}`,
    rel,
    buffer.length,
    mime,
    now,
    now,
    JSON.stringify({ ...metadata, capability, locale, market, task_id: taskId, sha256: digest }),
  ).lastInsertRowid);
  return { id, sha256: digest, bytes: buffer.length };
}

async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`产物下载失败 HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw lastError;
}

function prompts(locale, market) {
  const place = market ? `${market} ` : '';
  return {
    text: {
      system: `You localize short-drama dialogue into ${locale}. Reply with plain text only.`,
      user: `Localize this line for a ${place}audience, keeping meaning and tone: "你到底是谁？兄弟。"`,
    },
    subtitles: {
      system: `You write burned-in subtitle lines in ${locale}. Reply with one plain text line only.`,
      user: 'Write a single subtitle line for: "我不会再让你离开了。"',
    },
    character_image: `Photoreal ${place}short-drama character reference sheet, young adult woman, office outfit, neutral expression, clean studio lighting, full body, plain white background, no text, no watermark.`,
    clean_plate_image: `Photoreal empty ${place}office corridor clean plate, daytime, no people, no signage text, no watermark, vertical short-drama background plate.`,
    video: `Photoreal ${place}short drama, a young woman in an office corridor turns toward camera with a surprised expression, steady medium shot, natural light, no on-screen text.`,
  };
}

async function runText(db, root, ctx, capability, row) {
  const model = modelOf(row);
  const base = String(row.base_url || '').replace(/\/+$/, '');
  const endpoint = String(row.endpoint || '/chat/completions');
  const url = `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const p = ctx.prompts[capability];
  info(`${capability} submit config=#${row.id} model=${model}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${row.api_key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 200,
      messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(`${capability} HTTP ${response.status}`);
  const content = String(payload?.choices?.[0]?.message?.content || payload?.output_text || '').trim();
  if (!content) throw new Error(`${capability} 返回空内容`);
  const taskId = String(payload.id || '').trim();
  if (!taskId) throw new Error(`${capability} 缺少供应商 response id`);
  const artifact = writeArtifact(db, root, {
    ...ctx, capability, taskId, buffer: Buffer.from(content, 'utf8'), ext: 'txt', mime: 'text/plain', type: 'document',
    metadata: { config_id: row.id, model },
  });
  return { row, model, taskId, artifact, preview: content.slice(0, 160) };
}

async function runImage(db, root, ctx, capability, row) {
  const model = modelOf(row);
  info(`${capability} submit config=#${row.id} model=${model}`);
  const result = await token6688Client.callImageApi(row, { info() {}, warn() {} }, {
    model,
    prompt: ctx.prompts[capability],
    size: '1024x1024',
  });
  if (result.indeterminate) throw new Error(`${capability} 结果未知，请先核对供应商记录，不要重试`);
  if (result.error || !result.image_url) throw new Error(`${capability} 失败: ${String(result.error || '无图片地址').slice(0, 200)}`);
  const buffer = await download(result.image_url);
  const taskId = `img-${capability}-${Date.now()}`;
  const artifact = writeArtifact(db, root, {
    ...ctx, capability, taskId, buffer, ext: 'png', mime: 'image/png', type: 'image',
    metadata: { config_id: row.id, model },
  });
  return { row, model, taskId, artifact };
}

async function runVideo(db, root, ctx, capability, row) {
  const model = modelOf(row);
  let taskId = ctx.resumeVideoTask;
  if (taskId) {
    info(`video resume existing task=${taskId}（不重新提交）`);
  } else {
    info(`${capability} submit config=#${row.id} model=${model} 4s 480p`);
    const created = await toapisVideoClient.callToapisVideoApi(row, { info() {}, warn() {} }, {
      model,
      prompt: ctx.prompts.video,
      duration: 4,
      resolution: '480p',
      aspect_ratio: '9:16',
      generate_audio: false,
    });
    if (created.error || !created.task_id) throw new Error(`video 提交失败或结果未知: ${String(created.error || '无 task_id').slice(0, 200)}`);
    taskId = created.task_id;
    info(`video task=${taskId} polling`);
  }
  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  let status = null;
  while (Date.now() < deadline) {
    status = await toapisVideoClient.fetchToapisTask(row, taskId);
    if (status.state === 'completed' || (status.state === 'failed' && !status.retryable)) break;
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_MS));
  }
  if (status?.state !== 'completed' || !status.videoUrl) {
    throw new Error(`video 未完成 state=${status?.state || 'timeout'} task=${taskId}；不要重复提交，用 --resume-video-task 继续`);
  }
  let buffer;
  try {
    buffer = await download(status.videoUrl);
  } catch (error) {
    throw new Error(`video 已完成但下载失败 task=${taskId}（${error.message}）；用 --resume-video-task=${taskId} 重新下载`);
  }
  const artifact = writeArtifact(db, root, {
    ...ctx, capability, taskId, buffer, ext: 'mp4', mime: 'video/mp4', type: 'video',
    metadata: { config_id: row.id, model, duration: 4, resolution: '480p' },
  });
  return { row, model, taskId, artifact };
}

function upsertEntry(db, carrierId, locale, market, evidences) {
  const row = db.prepare('SELECT id, settings FROM ai_service_configs WHERE id = ?').get(carrierId);
  let settings = {};
  try { settings = JSON.parse(row.settings || '{}') || {}; } catch (_) { settings = {}; }
  const list = Array.isArray(settings.redraw_locale_capabilities) ? settings.redraw_locale_capabilities : [];
  let entry = list.find((item) => item && item.locale === locale && String(item.market || '') === market);
  if (!entry) {
    entry = { locale, market, language: locale.split('-')[0], status: 'verified', evidence: {} };
    list.push(entry);
  }
  entry.status = 'verified';
  entry.evidence = { ...(entry.evidence || {}), ...evidences };
  settings.redraw_locale_capabilities = list;
  db.prepare('UPDATE ai_service_configs SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(settings), new Date().toISOString(), carrierId);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const locale = String(args.locale || '').trim();
  const market = String(args.market ?? '').trim();
  if (!locale) fail('缺少 --locale');
  const capabilities = String(args.capabilities || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = capabilities.filter((name) => !SUPPORTED.includes(name));
  if (!capabilities.length || unknown.length) fail(`--capabilities 只支持 ${SUPPORTED.join(',')}`);
  const commit = args.commit === true;
  if (commit && args.confirm !== CONFIRM) fail(`付费执行需要 --confirm=${CONFIRM}`);

  const cfg = loadConfig();
  const dbPath = cfg.database?.path;
  if (!dbPath || !fs.existsSync(dbPath)) fail('数据库路径不存在');
  const db = new Database(dbPath);
  const root = storageRoot(cfg);

  const configFor = {
    text: () => loadServiceConfig(db, args['text-config'], ['text']),
    subtitles: () => loadServiceConfig(db, args['text-config'], ['text']),
    character_image: () => loadServiceConfig(db, args['image-config'], ['image', 'storyboard_image']),
    clean_plate_image: () => loadServiceConfig(db, args['image-config'], ['image', 'storyboard_image']),
    video: () => loadServiceConfig(db, args['video-config'], ['video']),
  };
  const carrierId = Number(args['carrier-config']);
  loadServiceConfig(db, carrierId, ['text', 'image', 'storyboard_image', 'video']);

  const plan = capabilities.map((name) => {
    const row = configFor[name]();
    const model = modelOf(row);
    if (name.endsWith('_image') && row.provider !== 'token6688') fail(`${name} 目前只支持 token6688 配置`);
    if (name === 'video' && row.api_protocol !== 'toapis_video') fail('video 目前只支持 toapis_video 配置');
    return { capability: name, config_id: row.id, provider: row.provider, model, price: priceOf(db, model) };
  });
  process.stdout.write(`${JSON.stringify({ mode: commit ? 'commit' : 'dry-run', locale, market, carrier_config_id: carrierId, plan }, null, 2)}\n`);
  if (!commit) {
    db.close();
    return;
  }

  const backupPath = `${dbPath.replace(/\.db$/, '')}.before-locale-evidence-${slug(locale)}-${Date.now()}.bak`;
  await db.backup(backupPath);
  info(`db backup written: ${path.basename(backupPath)}`);

  const ctx = {
    locale,
    market,
    prompts: prompts(locale, market),
    resumeVideoTask: typeof args['resume-video-task'] === 'string' ? args['resume-video-task'].trim() : '',
  };
  const runners = { text: runText, subtitles: runText, character_image: runImage, clean_plate_image: runImage, video: runVideo };
  const evidences = {};
  const report = { mode: 'commit', locale, market, carrier_config_id: carrierId, results: {} };
  for (const item of plan) {
    try {
      const row = configFor[item.capability]();
      const out = await runners[item.capability](db, root, ctx, item.capability, row);
      evidences[item.capability] = {
        provider: String(row.provider),
        model: out.model,
        task_id: out.taskId,
        terminal_status: 'completed',
        artifact_id: out.artifact.id,
        artifact_sha256: out.artifact.sha256,
        config_id: row.id,
        generated_at: new Date().toISOString(),
        purpose: 'redraw-locale-capability-evidence',
      };
      report.results[item.capability] = {
        status: 'completed',
        config_id: row.id,
        model: out.model,
        task_id: out.taskId,
        artifact_id: out.artifact.id,
        artifact_sha256: out.artifact.sha256,
        bytes: out.artifact.bytes,
        ...(out.preview ? { preview: out.preview } : {}),
      };
      info(`${item.capability} completed artifact=#${out.artifact.id}`);
    } catch (error) {
      report.results[item.capability] = { status: 'failed', error: String(error.message || error).slice(0, 300) };
      info(`${item.capability} failed: ${report.results[item.capability].error}`);
    }
  }

  const reader = createAssetReader({ storageRoot: root });
  const canReadArtifact = (id) => reader.canRead(db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(id));
  const verified = Object.fromEntries(Object.entries(evidences)
    .filter(([, evidence]) => capabilityService.validateGenerationEvidence(evidence, canReadArtifact)));
  if (Object.keys(verified).length) upsertEntry(db, carrierId, locale, market, verified);
  report.written = Object.keys(verified);
  report.locales = capabilityService.listLocaleCapabilities(db, canReadArtifact)
    .filter((item) => item.locale === locale && item.market === market);
  db.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => fail(String(error?.message || error).slice(0, 300)));
