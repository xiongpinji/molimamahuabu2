'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const config = require('../config');
const { getFfprobePath } = require('../utils/ffmpegPath');
const taskService = require('./taskService');
const videoService = require('./videoService');
const assetService = require('./assetService');
const redrawBillingService = require('./redrawBillingService');
const redrawReviewService = require('./redrawReviewService');

const execFileAsync = promisify(execFile);
const UNCERTAIN_MARKERS = ['结果未知', '状态未知', '仍可能处理中', '请勿重新提交'];

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function strictJson(value, label) {
  if (value == null || value === '') return {};
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  throw codedError('REDRAW_INVALID_JSON', `${label} JSON 无效`);
}

function strictJsonArray(value, label) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  throw codedError('REDRAW_INVALID_JSON', `${label} JSON 无效`);
}

function now(ctx) {
  return ctx.clock ? ctx.clock() : new Date().toISOString();
}

function normalizeDuration(value) {
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < 5 || duration > 15) {
    throw codedError('INVALID_VIDEO_DURATION', '视频时长必须是 5 到 15 秒之间的整数');
  }
  return duration;
}

function normalizeResolution(value) {
  if (value == null || value === '') return null;
  return String(value).trim().toLowerCase();
}

function normalizeAspectRatio(value) {
  if (value == null || value === '') return null;
  return String(value).trim();
}

function selectShot(db, ctx, shotInput) {
  const shotKey = shotInput.shot_id ?? shotInput.shotId;
  if (shotKey == null || String(shotKey).trim() === '') {
    throw codedError('REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在');
  }
  const rows = db.prepare(`
    SELECT s.*, v.work_id, v.style_snapshot_json, v.locale AS version_locale,
           v.status AS version_status, v.deleted_at AS version_deleted_at
    FROM redraw_shots s
    JOIN redraw_versions v ON v.id = s.version_id
    WHERE s.deleted_at IS NULL
      AND v.deleted_at IS NULL
      AND s.tenant_id = ?
      AND s.user_id = ?
      AND (CAST(s.id AS TEXT) = ? OR s.shot_id = ?)
    ORDER BY s.id ASC
    LIMIT 1
  `).all(String(ctx.tenantId), String(ctx.userId), String(shotKey), String(shotKey));
  const shot = rows[0] || null;
  if (!shot) throw codedError('REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在或无权访问');
  return shot;
}

function ensureGateOpen(db, ctx, versionId) {
  const gate = redrawReviewService.evaluateGenerationGate(db, versionId, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  });
  if (!gate.ok) {
    throw codedError('REDRAW_ASSET_REVIEW_REQUIRED', '转绘资产审核未通过，不能生成单镜视频', {
      missing: gate.missing || [],
    });
  }
  return gate;
}

function buildGenerationInput(shot, input, parsed) {
  const compiled = parsed.compiled;
  const draft = parsed.draft;
  const promptBase = String(compiled.text || compiled.prompt || shot.prompt || '').trim();
  const negative = String(
    input.negative_prompt ?? input.negativePrompt ?? compiled.negative_prompt ?? compiled.negativePrompt ?? shot.negative_prompt ?? '',
  ).trim();
  const prompt = negative ? `${promptBase}\n\nNegative prompt: ${negative}` : promptBase;
  const model = String(input.model || draft.model || compiled.model || 'seedance 2.0').trim();
  const duration = normalizeDuration(input.duration ?? draft.duration ?? compiled.duration ?? 5);
  const resolution = normalizeResolution(input.resolution ?? draft.resolution ?? compiled.resolution ?? '720p');
  const aspectRatio = normalizeAspectRatio(input.aspect_ratio ?? input.aspectRatio ?? draft.aspect_ratio ?? draft.aspectRatio
    ?? compiled.aspect_ratio ?? compiled.aspectRatio ?? '16:9');
  return {
    prompt,
    model,
    duration,
    resolution,
    aspect_ratio: aspectRatio,
    count: 1,
    locale: input.locale || draft.locale || shot.version_locale || null,
    attempt: Number(input.attempt ?? draft.generation?.attempt ?? draft.attempt ?? 1),
  };
}

function parseReferenceValue(value, fallbackKind = null, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) parseReferenceValue(item, fallbackKind, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const kind = String(value.kind || value.type || value.asset_kind || fallbackKind || '').trim();
  let rawId = value.redraw_asset_id ?? value.redrawAssetId ?? value.asset_id ?? value.assetId;
  if (rawId == null && value.clean_plate_asset_id != null) rawId = value.clean_plate_asset_id;
  const id = Number(rawId);
  if (['character', 'scene', 'prop', 'voice'].includes(kind) && Number.isInteger(id) && id > 0) {
    out.push({ kind, id });
  }
  for (const key of ['references', 'assets', 'asset_references', 'assetReferences']) {
    if (value[key] != null) parseReferenceValue(value[key], fallbackKind, out);
  }
  return out;
}

function assetUrl(row) {
  if (!row) return null;
  const url = String(row.url || '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  const localPath = String(row.local_path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!localPath || localPath.includes('..')) return null;
  return `/static/${localPath}`;
}

function collectReferenceImageUrls(db, shot, parsed) {
  const refs = [];
  parseReferenceValue(parsed.references, null, refs);
  parseReferenceValue(parsed.draft.references || parsed.draft.assets || parsed.draft.asset_references, null, refs);
  const urls = [];
  const seen = new Set();
  for (const ref of refs) {
    if (ref.kind === 'voice') continue;
    const row = db.prepare(`
      SELECT * FROM redraw_assets
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
        AND kind = ? AND deleted_at IS NULL AND approval_status = 'approved'
      LIMIT 1
    `).get(ref.id, shot.version_id, shot.tenant_id, shot.user_id, ref.kind);
    if (!row) continue;
    const sourceId = ref.kind === 'scene' ? (row.clean_plate_asset_id || row.asset_id) : row.asset_id;
    if (!sourceId) continue;
    const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(sourceId));
    const url = assetUrl(asset);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function parseShotPayload(shot) {
  return {
    references: strictJsonArray(shot.references_json, 'references_json'),
    compiled: strictJson(shot.compiled_prompt_json, 'compiled_prompt_json'),
    draft: strictJson(shot.draft_json, 'draft_json'),
    styleSnapshot: strictJson(shot.style_snapshot_json, 'style_snapshot_json'),
  };
}

function findReusable(db, shot, attempt) {
  if (!shot.video_generation_id) return null;
  const video = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(shot.video_generation_id));
  if (!video || !['processing', 'completed', 'needs_attention'].includes(String(video.status))) return null;
  const draft = strictJson(shot.draft_json, 'draft_json');
  if (Number(draft.generation?.attempt ?? draft.attempt ?? 1) !== Number(attempt)) return null;
  const task = video.task_id
    ? db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(video.task_id)
    : null;
  return {
    status: video.status,
    reused: true,
    task_id: task?.id || video.task_id || null,
    video_generation_id: video.id,
    reservation_id: draft.generation?.reservation_id || null,
  };
}

function mergeDraft(draft, patch) {
  return JSON.stringify({
    ...draft,
    generation: {
      ...(draft.generation || {}),
      ...patch.generation,
    },
    ...(patch.new_video_ref ? { new_video_ref: patch.new_video_ref } : {}),
  });
}

async function generateShot(ctx, input = {}) {
  const { db } = ctx;
  if (!db || !ctx.tenantId || !ctx.userId) throw codedError('REDRAW_CONTEXT_INVALID', '缺少转绘生成上下文');
  const shot = selectShot(db, ctx, input);
  const parsed = parseShotPayload(shot);
  ensureGateOpen(db, ctx, shot.version_id);
  const generation = buildGenerationInput(shot, input, parsed);
  if (!Number.isSafeInteger(generation.attempt) || generation.attempt <= 0) {
    throw codedError('INVALID_REDRAW_GENERATION_INPUT', 'attempt 必须是正整数');
  }
  const reusable = findReusable(db, shot, generation.attempt);
  if (reusable) return reusable;
  if (shot.video_generation_id) {
    const existing = db.prepare('SELECT status FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(shot.video_generation_id));
    if (existing?.status === 'failed') {
      throw codedError('REDRAW_SHOT_RETRY_REQUIRED', '该镜头上次生成失败，请使用重试流程');
    }
  }
  const referenceImageUrls = collectReferenceImageUrls(db, shot, parsed);
  const created = db.transaction(() => {
    ensureGateOpen(db, ctx, shot.version_id);
    const reservation = redrawBillingService.reserveShotGeneration(db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      actorUserId: ctx.userId,
      versionId: shot.version_id,
      shotId: String(shot.id),
      model: generation.model,
      duration: generation.duration,
      resolution: generation.resolution,
      count: 1,
      locale: generation.locale,
      styleSnapshot: parsed.styleSnapshot,
      attempt: generation.attempt,
    });
    if (!reservation.success) {
      throw codedError('REDRAW_SHOT_PRICING_UNCONFIGURED', reservation.message || '单镜视频模型未配置价格');
    }
    const task = taskService.createTask(db, ctx.log || logNoop, 'redraw_shot', String(shot.id));
    const timestamp = now(ctx);
    const metadata = {
      redraw_shot: {
        reservation_id: reservation.reservation_id,
        operation_key: reservation.operation_key,
        billing: reservation.billing,
        quote: reservation.quote,
        version_id: shot.version_id,
        shot_id: shot.id,
        attempt: generation.attempt,
      },
    };
    db.prepare(`
      UPDATE async_tasks
      SET status = 'processing', progress = 1, message = ?, tenant_id = ?, user_id = ?,
          model = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run('单镜视频生成已开始', String(ctx.tenantId), String(ctx.userId), generation.model, JSON.stringify(metadata), timestamp, task.id);
    const videoId = db.prepare(`INSERT INTO video_generations
      (provider, prompt, model, duration, aspect_ratio, resolution, reference_image_urls,
       status, task_id, tenant_id, user_id, credit_reservation_id, created_at, updated_at)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, NULL, ?, ?)`)
      .run(
        generation.prompt,
        generation.model,
        generation.duration,
        generation.aspect_ratio,
        generation.resolution,
        JSON.stringify(referenceImageUrls),
        task.id,
        String(ctx.tenantId),
        String(ctx.userId),
        timestamp,
        timestamp,
      ).lastInsertRowid;
    db.prepare(`
      UPDATE redraw_shots
      SET video_generation_id = ?, status = 'processing', error_code = NULL, error_message = NULL,
          draft_json = ?, updated_at = ?
      WHERE id = ?
    `).run(videoId, mergeDraft(parsed.draft, {
      generation: {
        task_id: task.id,
        video_generation_id: videoId,
        reservation_id: reservation.reservation_id,
        operation_key: reservation.operation_key,
        model: generation.model,
        duration: generation.duration,
        resolution: generation.resolution,
        aspect_ratio: generation.aspect_ratio,
        count: 1,
        attempt: generation.attempt,
      },
    }), timestamp, shot.id);
    return {
      status: 'processing',
      task_id: task.id,
      video_generation_id: videoId,
      reservation_id: reservation.reservation_id,
    };
  })();

  if (ctx.awaitCompletion === true) return runShotGeneration(ctx, created.task_id);
  const schedule = ctx.schedule || ((callback) => setImmediate(callback));
  schedule(() => {
    runShotGeneration(ctx, created.task_id).catch((error) => {
      ctx.log?.error?.('redraw shot background generation failed', { task_id: created.task_id, error: error.message });
    });
  });
  return created;
}

const logNoop = { info() {}, warn() {}, error() {} };

function taskMetadata(task) {
  return strictJson(task.metadata, 'async_tasks.metadata').redraw_shot || {};
}

function getTask(db, taskId) {
  const task = db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(String(taskId));
  if (!task || task.type !== 'redraw_shot') throw codedError('REDRAW_SHOT_TASK_NOT_FOUND', '单镜视频任务不存在');
  return task;
}

function getVideoForTask(db, task) {
  const row = db.prepare('SELECT * FROM video_generations WHERE task_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1').get(task.id);
  if (!row) throw codedError('REDRAW_VIDEO_NOT_FOUND', '单镜视频记录不存在');
  return row;
}

function getShotForTask(db, task) {
  const shot = db.prepare('SELECT * FROM redraw_shots WHERE id = ? AND deleted_at IS NULL').get(Number(task.resource_id));
  if (!shot) throw codedError('REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在');
  return shot;
}

function classifyVideoOutcome(row, verification) {
  const status = String(row?.status || '').toLowerCase();
  const error = String(row?.error_msg || row?.error || '');
  if (status === 'completed') {
    if (row.local_path && verification?.duration > 0 && verification?.width > 0 && verification?.height > 0) {
      return { status: 'completed' };
    }
    return { status: 'needs_attention', error: '视频完成记录缺少可验证的本地成片或素材入库结果，请人工确认后处理' };
  }
  if (status === 'failed') return { status: 'failed', error: error || '供应商视频生成失败' };
  if (status === 'processing' || UNCERTAIN_MARKERS.some((marker) => error.includes(marker))) {
    return { status: 'needs_attention', error: error || '视频结果未知或仍可能处理中，请勿重新提交' };
  }
  return { status: 'needs_attention', error: error || '视频状态未知，请人工确认后处理' };
}

function updateNeedsAttention(db, taskId, shotId, message, timestamp) {
  db.prepare(`
    UPDATE redraw_shots
    SET status = 'needs_attention', error_code = 'REDRAW_VIDEO_NEEDS_ATTENTION',
        error_message = ?, updated_at = ?
    WHERE id = ?
  `).run(String(message || '').slice(0, 500), timestamp, shotId);
  db.prepare(`
    UPDATE async_tasks
    SET status = 'needs_attention', progress = 90, message = ?, error = ?, updated_at = ?
    WHERE id = ?
  `).run(String(message || '').slice(0, 500), String(message || '').slice(0, 500), timestamp, taskId);
}

async function runShotGeneration(ctx, taskId) {
  const { db } = ctx;
  const task = getTask(db, taskId);
  const metadata = taskMetadata(task);
  const video = getVideoForTask(db, task);
  const shot = getShotForTask(db, task);
  const processor = ctx.videoProcessor || ((database, logger, videoGenerationId) => (
    videoService.processVideoGeneration(database, logger, videoGenerationId)
  ));
  await processor(db, ctx.log || logNoop, video.id);
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(video.id);
  let verification = null;
  let imported = null;
  if (row?.status === 'completed' && row.local_path) {
    try {
      const verifier = ctx.artifactVerifier || verifyVideoArtifact;
      verification = await verifier(ctx, row.id, {});
      const importer = ctx.assetImporter || ((database, logger, videoGenerationId) => (
        assetService.importFromVideo(database, logger, videoGenerationId)
      ));
      imported = await importer(db, ctx.log || logNoop, row.id);
    } catch (error) {
      const timestamp = now(ctx);
      updateNeedsAttention(db, task.id, shot.id, error.message, timestamp);
      return { status: 'needs_attention', error: error.message, task_id: task.id, video_generation_id: row.id };
    }
  }
  const outcome = classifyVideoOutcome(row, verification);
  const timestamp = now(ctx);
  if (outcome.status === 'completed') {
    if (!imported?.id) {
      updateNeedsAttention(db, task.id, shot.id, '视频成片素材入库失败，请人工确认后处理', timestamp);
      return { status: 'needs_attention', task_id: task.id, video_generation_id: row.id };
    }
    const draft = strictJson(shot.draft_json, 'draft_json');
    const newVideoRef = {
      asset_id: imported.id,
      video_generation_id: row.id,
      video_url: row.video_url || null,
      local_path: row.local_path,
      probe: verification,
    };
    db.prepare(`
      UPDATE redraw_shots
      SET status = 'completed', video_generation_id = ?, error_code = NULL, error_message = NULL,
          draft_json = ?, updated_at = ?
      WHERE id = ?
    `).run(row.id, mergeDraft(draft, { generation: { completed_at: timestamp }, new_video_ref: newVideoRef }), timestamp, shot.id);
    taskService.updateTaskResult(db, task.id, {
      status: 'completed',
      shot_id: shot.id,
      video_generation_id: row.id,
      asset_id: imported.id,
      video_url: row.video_url || null,
      local_path: row.local_path,
      probe: verification,
    });
    redrawBillingService.settleShotGeneration(db, metadata.reservation_id, 'completed');
    return { status: 'completed', task_id: task.id, video_generation_id: row.id, asset_id: imported.id };
  }
  if (outcome.status === 'failed') {
    db.prepare(`
      UPDATE redraw_shots
      SET status = 'failed', error_code = 'REDRAW_VIDEO_FAILED',
          error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(String(outcome.error || '').slice(0, 500), timestamp, shot.id);
    taskService.updateTaskError(db, task.id, outcome.error || '单镜视频生成失败');
    redrawBillingService.settleShotGeneration(db, metadata.reservation_id, 'failed', outcome.error || '单镜视频生成失败');
    return { status: 'failed', error: outcome.error, task_id: task.id, video_generation_id: row.id };
  }
  updateNeedsAttention(db, task.id, shot.id, outcome.error, timestamp);
  return { status: 'needs_attention', error: outcome.error, task_id: task.id, video_generation_id: row.id };
}

function isInside(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveStorageRoot(ctx) {
  if (ctx.storageRoot) return path.resolve(ctx.storageRoot);
  const cfg = config.loadConfig();
  const storagePath = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(storagePath) ? storagePath : path.join(process.cwd(), storagePath);
}

async function defaultProbe(absPath) {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    absPath,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] || {};
  return {
    duration: Number(parsed.format?.duration),
    width: Number(stream.width),
    height: Number(stream.height),
  };
}

async function verifyVideoArtifact(ctx, videoGenerationId) {
  const row = ctx.db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenerationId));
  if (!row || row.status !== 'completed' || !row.local_path) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片记录不完整');
  }
  const storageRoot = resolveStorageRoot(ctx);
  const relativePath = String(row.local_path).replace(/^\/static\//, '').replace(/\\/g, '/');
  const absPath = path.resolve(storageRoot, relativePath);
  if (!isInside(storageRoot, absPath)) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片路径越界');
  }
  try {
    fs.accessSync(absPath, fs.constants.R_OK);
  } catch (_) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片文件不可读取');
  }
  const probe = ctx.probeRunner ? await ctx.probeRunner(absPath, row) : await defaultProbe(absPath);
  if (!(probe?.duration > 0 && probe?.width > 0 && probe?.height > 0)) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片元数据无效');
  }
  return { duration: probe.duration, width: probe.width, height: probe.height };
}

module.exports = {
  generateShot,
  runShotGeneration,
  verifyVideoArtifact,
  classifyVideoOutcome,
};
