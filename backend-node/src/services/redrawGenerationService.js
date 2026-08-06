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
const { runWithGenerationLimit } = require('./generationConcurrency');

const execFileAsync = promisify(execFile);
const UNCERTAIN_MARKERS = ['结果未知', '状态未知', '仍可能处理中', '请勿重新提交'];
const INTERRUPTED_MESSAGE = '供应商状态未知/服务重启，请勿重新提交';
const DEFAULT_GENERATION_CONCURRENCY = 3;
const DEFAULT_RECOVERY_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_RECOVERY_POLL_MS = 1000;

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

function normalizeVersionId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw codedError('REDRAW_VERSION_NOT_FOUND', '转绘版本不存在');
  }
  return id;
}

function normalizeBatchShotIds(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw codedError('REDRAW_BATCH_SHOT_INVALID', 'shot_ids 必须是非空数组');
  }
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw codedError('REDRAW_BATCH_SHOT_INVALID', '批量镜头不存在、跨版本或无权访问');
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
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

function findReusable(db, shot, attempt, expectedGeneration = null) {
  if (!shot.video_generation_id) return null;
  const video = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(shot.video_generation_id));
  if (!video || !['processing', 'completed', 'needs_attention'].includes(String(video.status))) return null;
  if (expectedGeneration && (
    String(video.model || '') !== String(expectedGeneration.model || '')
    || Number(video.duration) !== Number(expectedGeneration.duration)
    || String(video.resolution || '') !== String(expectedGeneration.resolution || '')
    || String(video.aspect_ratio || '') !== String(expectedGeneration.aspect_ratio || '')
    || String(video.prompt || '') !== String(expectedGeneration.prompt || '')
  )) return null;
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
  const reusable = findReusable(db, shot, generation.attempt, generation);
  if (reusable) return enrichGenerationResult(db, { ...reusable, attempt: generation.attempt });
  if (shot.video_generation_id) {
    const existing = db.prepare('SELECT status FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(shot.video_generation_id));
    if (existing?.status === 'failed' && ctx.retryFailedShot !== true) {
      throw codedError('REDRAW_SHOT_RETRY_REQUIRED', '该镜头上次生成失败，请使用重试流程');
    }
    if (existing && existing.status !== 'failed') {
      throw codedError('REDRAW_SHOT_CONFLICT', '镜头已有不同参数的生成任务，请刷新后重试');
    }
  }
  const referenceImageUrls = collectReferenceImageUrls(db, shot, parsed);
  if (typeof ctx.beforeCreateTransaction === 'function') {
    await ctx.beforeCreateTransaction({ shot, generation });
  }
  let created;
  try {
    created = db.transaction(() => {
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
        styleSnapshot: ctx.batchStyleSnapshot ?? parsed.styleSnapshot,
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
      const changed = db.prepare(`
        UPDATE redraw_shots
        SET video_generation_id = ?, status = 'processing', error_code = NULL, error_message = NULL,
            draft_json = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
          AND status = ? AND video_generation_id IS ? AND updated_at IS ? AND deleted_at IS NULL
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
      }), timestamp, shot.id, String(ctx.tenantId), String(ctx.userId), shot.version_id,
      shot.status, shot.video_generation_id, shot.updated_at);
      if (changed.changes !== 1) {
        throw codedError('REDRAW_SHOT_CREATE_CONFLICT', '转绘镜头生成状态已变化');
      }
      return {
        status: 'processing',
        task_id: task.id,
        video_generation_id: videoId,
        reservation_id: reservation.reservation_id,
      };
    })();
  } catch (error) {
    if (error.code !== 'REDRAW_SHOT_CREATE_CONFLICT') throw error;
    const fresh = selectShot(db, ctx, input);
    const freshReusable = findReusable(db, fresh, generation.attempt, generation);
    if (freshReusable) {
      return enrichGenerationResult(db, { ...freshReusable, attempt: generation.attempt });
    }
    throw codedError('REDRAW_SHOT_CONFLICT', '转绘镜头生成状态已变化，请刷新后重试');
  }

  const enrich = (result) => enrichGenerationResult(db, {
    ...result,
    reservation_id: created.reservation_id,
    attempt: generation.attempt,
  });
  if (ctx.awaitCompletion === true) return enrich(await runShotGeneration(ctx, created.task_id));
  const schedule = ctx.schedule || ((callback) => setImmediate(callback));
  schedule(() => runShotGeneration(ctx, created.task_id).catch((error) => {
    try {
      updateNeedsAttention(db, created.task_id, shot.id, error.message, now(ctx), created.video_generation_id);
    } catch (stateError) {
      ctx.log?.error?.('redraw shot background state update failed', {
        task_id: created.task_id,
        error: stateError.message,
      });
    }
    ctx.log?.error?.('redraw shot background generation failed', { task_id: created.task_id, error: error.message });
    return { status: 'needs_attention', error: error.message };
  }));
  return enrich({ ...created, attempt: generation.attempt });
}

const logNoop = { info() {}, warn() {}, error() {} };

function taskMetadata(task) {
  return strictJson(task.metadata, 'async_tasks.metadata').redraw_shot || {};
}

function billingForReservationRow(row) {
  if (!row) return { held: 0, charged: 0, released: 0 };
  if (row.status === 'confirmed') return { held: 0, charged: row.amount, released: 0 };
  if (row.status === 'refunded') return { held: 0, charged: 0, released: row.amount };
  return { held: row.amount, charged: 0, released: 0 };
}

function enrichGenerationResult(db, result) {
  const reservationId = result?.reservation_id;
  const reservation = reservationId
    ? db.prepare('SELECT id, status, amount FROM tenant_usage_reservations WHERE id = ?').get(reservationId)
    : null;
  return {
    ...result,
    billing: billingForReservationRow(reservation),
  };
}

function ownerMatches(row, ctx) {
  return String(row?.tenant_id || '') === String(ctx.tenantId || '')
    && String(row?.user_id || '') === String(ctx.userId || '');
}

function getTask(db, taskId, ctx = null) {
  const task = db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(String(taskId));
  if (!task || task.type !== 'redraw_shot') throw codedError('REDRAW_SHOT_TASK_NOT_FOUND', '单镜视频任务不存在');
  if (ctx && !ownerMatches(task, ctx)) throw codedError('REDRAW_SHOT_NOT_FOUND', '单镜视频任务不存在或无权访问');
  return task;
}

function getVideoForTask(db, task, ctx = null) {
  const ownerClause = ctx ? ' AND tenant_id = ? AND user_id = ?' : '';
  const ownerParams = ctx ? [String(ctx.tenantId), String(ctx.userId)] : [];
  const row = db.prepare(`SELECT * FROM video_generations
    WHERE task_id = ? AND deleted_at IS NULL${ownerClause}
    ORDER BY id DESC LIMIT 1`).get(task.id, ...ownerParams);
  if (!row) throw codedError('REDRAW_VIDEO_NOT_FOUND', '单镜视频记录不存在');
  return row;
}

function getShotForTask(db, task, ctx = null) {
  const ownerClause = ctx ? ' AND s.tenant_id = ? AND s.user_id = ? AND v.tenant_id = ? AND v.user_id = ?' : '';
  const ownerParams = ctx ? [String(ctx.tenantId), String(ctx.userId), String(ctx.tenantId), String(ctx.userId)] : [];
  const shot = db.prepare(`
    SELECT s.*
    FROM redraw_shots s
    JOIN redraw_versions v ON v.id = s.version_id AND v.deleted_at IS NULL
    WHERE s.id = ? AND s.deleted_at IS NULL${ownerClause}
    LIMIT 1
  `).get(Number(task.resource_id), ...ownerParams);
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

function updateNeedsAttention(db, taskId, shotId, message, timestamp, videoGenerationId = null) {
  const safeMessage = String(message || '').slice(0, 500);
  db.transaction(() => {
    db.prepare(`
      UPDATE redraw_shots
      SET status = 'needs_attention', error_code = 'REDRAW_VIDEO_NEEDS_ATTENTION',
          error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(safeMessage, timestamp, shotId);
    db.prepare(`
      UPDATE async_tasks
      SET status = 'needs_attention', progress = 90, message = ?, error = ?,
          result = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(safeMessage, safeMessage, timestamp, taskId);
    if (videoGenerationId != null) {
      db.prepare(`
        UPDATE video_generations
        SET status = 'needs_attention', error_msg = ?, updated_at = ?
        WHERE id = ? AND task_id = ?
      `).run(safeMessage, timestamp, Number(videoGenerationId), taskId);
    } else {
      db.prepare(`
        UPDATE video_generations
        SET status = 'needs_attention', error_msg = ?, updated_at = ?
        WHERE task_id = ? AND deleted_at IS NULL
      `).run(safeMessage, timestamp, taskId);
    }
  })();
}

function terminalStatus(row) {
  const status = String(row?.status || '');
  return ['completed', 'failed', 'needs_attention'].includes(status) ? status : null;
}

function terminalTaskResult(task, video, shot) {
  const statuses = [terminalStatus(task), terminalStatus(video), terminalStatus(shot)];
  if (!statuses.some(Boolean)) return null;
  const unique = new Set(statuses.filter(Boolean));
  if (unique.size !== 1 || statuses.some((status) => !status)) {
    return { status: 'needs_attention', error: '单镜视频本地终态不一致，请人工确认后处理', degrade: true };
  }
  const status = statuses[0];
  if (status === 'completed') {
    const result = strictJson(task.result, 'async_tasks.result');
    const draft = strictJson(shot.draft_json, 'draft_json');
    const ref = draft.new_video_ref || {};
    return {
      status,
      task_id: task.id,
      video_generation_id: video.id,
      asset_id: result.asset_id || ref.asset_id || null,
      new_video_ref: ref,
    };
  }
  return {
    status,
    error: task.error || task.message || video.error_msg || shot.error_message || null,
    task_id: task.id,
    video_generation_id: video.id,
  };
}

async function runShotGeneration(ctx, taskId) {
  const { db } = ctx;
  const ownerCtx = ctx.tenantId && ctx.userId ? ctx : null;
  const task = getTask(db, taskId, ownerCtx);
  const metadata = taskMetadata(task);
  const video = getVideoForTask(db, task, ownerCtx);
  const shot = getShotForTask(db, task, ownerCtx);
  const terminal = terminalTaskResult(task, video, shot);
  const recoveredRemoteTerminal = ctx.recoverExistingProvider === true
    && !terminalStatus(shot)
    && ['completed', 'failed'].includes(String(video.status))
    && String(task.status) === String(video.status);
  if (terminal && !recoveredRemoteTerminal) {
    if (terminal.degrade) {
      const timestamp = now(ctx);
      updateNeedsAttention(db, task.id, shot.id, terminal.error, timestamp, video.id);
      return { status: 'needs_attention', error: terminal.error, task_id: task.id, video_generation_id: video.id };
    }
    return terminal;
  }
  if (ctx.recoverExistingProvider === true && !String(video.provider_task_id || '').trim()) {
    const timestamp = now(ctx);
    updateNeedsAttention(db, task.id, shot.id, INTERRUPTED_MESSAGE, timestamp, video.id);
    return { status: 'needs_attention', error: INTERRUPTED_MESSAGE, task_id: task.id, video_generation_id: video.id };
  }
  const processor = ctx.recoverExistingProvider === true
    ? (ctx.videoRecoveryProcessor || waitForRecoveredVideo)
    : (ctx.videoProcessor || ((database, logger, videoGenerationId) => (
      videoService.processVideoGeneration(database, logger, videoGenerationId)
    )));
  if (!recoveredRemoteTerminal) await processor(db, ctx.log || logNoop, video.id);
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(video.id);
  let verification = null;
  let imported = null;
  if (row?.status === 'completed' && row.local_path) {
    try {
      const verifier = ctx.artifactVerifier || verifyVideoArtifact;
      verification = await verifier(ctx, row.id, {});
    } catch (error) {
      const timestamp = now(ctx);
      updateNeedsAttention(db, task.id, shot.id, error.message, timestamp, row.id);
      return { status: 'needs_attention', error: error.message, task_id: task.id, video_generation_id: row.id };
    }
  }
  const outcome = classifyVideoOutcome(row, verification);
  const timestamp = now(ctx);
  if (outcome.status === 'completed') {
    const importer = ctx.assetImporter || ((database, logger, videoGenerationId) => (
      assetService.importFromVideo(database, logger, videoGenerationId)
    ));
    try {
      return db.transaction(() => {
        const claimed = db.prepare(`
          UPDATE redraw_shots
          SET status = 'pending', error_code = 'REDRAW_VIDEO_FINALIZING', updated_at = ?
          WHERE id = ? AND status = 'processing' AND video_generation_id = ?
        `).run(timestamp, shot.id, row.id);
        if (claimed.changes !== 1) {
          const freshTask = getTask(db, task.id, ownerCtx);
          const freshVideo = getVideoForTask(db, freshTask, ownerCtx);
          const freshShot = getShotForTask(db, freshTask, ownerCtx);
          const concurrentResult = terminalTaskResult(freshTask, freshVideo, freshShot);
          if (concurrentResult && !concurrentResult.degrade) return concurrentResult;
          throw codedError('REDRAW_VIDEO_FINALIZATION_CONFLICT', '单镜视频正在由其他任务收口，请勿重复导入');
        }
        imported = importer(db, ctx.log || logNoop, row.id);
        if (imported && typeof imported.then === 'function') {
          throw codedError('REDRAW_VIDEO_ASSET_IMPORT_INVALID', '视频成片素材入库必须同步完成');
        }
        if (!imported?.id) {
          throw codedError('REDRAW_VIDEO_ASSET_IMPORT_FAILED', '视频成片素材入库失败，请人工确认后处理');
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
      })();
    } catch (error) {
      updateNeedsAttention(db, task.id, shot.id, error.message, timestamp, row.id);
      return { status: 'needs_attention', task_id: task.id, video_generation_id: row.id };
    }
  }
  if (outcome.status === 'failed') {
    try {
      db.transaction(() => {
        db.prepare(`
          UPDATE redraw_shots
          SET status = 'failed', error_code = 'REDRAW_VIDEO_FAILED',
              error_message = ?, updated_at = ?
          WHERE id = ?
        `).run(String(outcome.error || '').slice(0, 500), timestamp, shot.id);
        taskService.updateTaskError(db, task.id, outcome.error || '单镜视频生成失败');
        redrawBillingService.settleShotGeneration(db, metadata.reservation_id, 'failed', outcome.error || '单镜视频生成失败');
      })();
      return { status: 'failed', error: outcome.error, task_id: task.id, video_generation_id: row.id };
    } catch (error) {
      updateNeedsAttention(db, task.id, shot.id, error.message, timestamp, row.id);
      return { status: 'needs_attention', error: error.message, task_id: task.id, video_generation_id: row.id };
    }
  }
  updateNeedsAttention(db, task.id, shot.id, outcome.error, timestamp, row.id);
  return { status: 'needs_attention', error: outcome.error, task_id: task.id, video_generation_id: row.id };
}

async function waitForRecoveredVideo(db, _log, videoGenerationId, options = {}) {
  const maxWaitMs = Number(options.recoveryMaxWaitMs || DEFAULT_RECOVERY_WAIT_MS);
  const pollMs = Number(options.recoveryPollMs || DEFAULT_RECOVERY_POLL_MS);
  const deadline = Date.now() + (Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : DEFAULT_RECOVERY_WAIT_MS);
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT status FROM video_generations WHERE id = ? AND deleted_at IS NULL')
      .get(Number(videoGenerationId));
    if (!row || row.status !== 'processing') return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_RECOVERY_POLL_MS);
      timer.unref?.();
    });
  }
}

async function runBounded(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const limit = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: limit }, () => consume()));
  return results;
}

function failBatchShotSafely(ctx, shot, error) {
  const { db } = ctx;
  const current = db.prepare('SELECT status, video_generation_id FROM redraw_shots WHERE id = ?').get(shot.id);
  const video = current?.video_generation_id
    ? db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(current.video_generation_id))
    : null;
  const task = video?.task_id
    ? db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(video.task_id)
    : null;
  let reservationId = null;
  try {
    reservationId = task ? taskMetadata(task).reservation_id : null;
  } catch (_) {}
  if (task && video && ['pending', 'processing'].includes(String(task.status))) {
    updateNeedsAttention(db, task.id, shot.id, error.message, now(ctx), video.id);
  }
  const actualStatus = db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shot.id)?.status || 'failed';
  return enrichGenerationResult(db, {
    shot_id: shot.id,
    task_id: task?.id || null,
    video_generation_id: video?.id || null,
    reservation_id: reservationId,
    status: actualStatus,
    error_code: error.code || 'REDRAW_BATCH_SHOT_FAILED',
    error: error.message,
  });
}

function scheduleBatchDrain(ctx, jobs, concurrency) {
  if (!jobs.length) return;
  const configured = Number(process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY || DEFAULT_GENERATION_CONCURRENCY);
  const productionLimit = Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 8)
    : DEFAULT_GENERATION_CONCURRENCY;
  const requestedLimit = Number.isSafeInteger(concurrency) && concurrency > 0
    ? Math.min(concurrency, productionLimit)
    : productionLimit;
  const queueEnv = {
    ...process.env,
    GENERATION_REDRAW_VIDEO_CONCURRENCY: String(requestedLimit),
  };
  const drain = () => Promise.all(jobs.map((job) => (
    runWithGenerationLimit('redraw_video', job, queueEnv).catch((error) => {
      if (error.code === 'GENERATION_QUEUE_FULL' && job.redraw) {
        updateNeedsAttention(
          ctx.db,
          job.redraw.task_id,
          job.redraw.shot_id,
          '转绘视频生成队列已满，请人工确认后重试',
          now(ctx),
          job.redraw.video_generation_id,
        );
      }
      ctx.log?.error?.('redraw batch background generation failed', { error: error.message });
      return null;
    })
  )));
  if (ctx.batchScheduler) {
    ctx.batchScheduler(drain);
    return;
  }
  const immediate = setImmediate(() => {
    drain().catch((error) => {
      ctx.log?.error?.('redraw batch drain failed', { error: error.message });
    });
  });
  immediate.unref?.();
}

async function generateBatch(ctx, input = {}) {
  const { db } = ctx;
  if (!db || !ctx.tenantId || !ctx.userId) throw codedError('REDRAW_CONTEXT_INVALID', '缺少转绘生成上下文');
  if (Object.prototype.hasOwnProperty.call(input, 'shot_id')
    || Object.prototype.hasOwnProperty.call(input, 'shotId')) {
    throw codedError('REDRAW_BATCH_INPUT_INVALID', '批量生成不接受单镜 shot_id 或 shotId');
  }
  const versionId = normalizeVersionId(input.version_id ?? input.versionId);
  const explicitIds = normalizeBatchShotIds(input.shot_ids ?? input.shotIds);
  const preflight = db.transaction(() => {
    const version = db.prepare(`
      SELECT * FROM redraw_versions
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(versionId, String(ctx.tenantId), String(ctx.userId));
    if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '转绘版本不存在或无权访问');
    const batchStyleSnapshot = strictJson(version.style_snapshot_json, 'redraw_versions.style_snapshot_json');
    ensureGateOpen(db, ctx, versionId);

    let rows;
    if (explicitIds) {
      const placeholders = explicitIds.map(() => '?').join(',');
      rows = db.prepare(`
        SELECT * FROM redraw_shots
        WHERE id IN (${placeholders}) AND version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      `).all(...explicitIds, versionId, String(ctx.tenantId), String(ctx.userId));
      if (rows.length !== explicitIds.length) {
        throw codedError('REDRAW_BATCH_SHOT_INVALID', '批量镜头不存在、跨版本或无权访问');
      }
      const byId = new Map(rows.map((row) => [Number(row.id), row]));
      rows = explicitIds.map((id) => byId.get(id));
    } else {
      rows = db.prepare(`
        SELECT * FROM redraw_shots
        WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        ORDER BY batch_index ASC, shot_index ASC, id ASC
      `).all(versionId, String(ctx.tenantId), String(ctx.userId));
    }
    return { batchStyleSnapshot, rows };
  })();
  const { batchStyleSnapshot, rows } = preflight;

  const candidates = rows.filter((row) => !['completed', 'processing'].includes(String(row.status)));
  const skipped = rows.filter((row) => ['completed', 'processing'].includes(String(row.status)))
    .map((row) => ({ shot_id: row.id, status: row.status }));
  const rawConcurrency = Number(ctx.generationConcurrency ?? DEFAULT_GENERATION_CONCURRENCY);
  const concurrency = Number.isSafeInteger(rawConcurrency) && rawConcurrency > 0
    ? Math.min(rawConcurrency, 8)
    : DEFAULT_GENERATION_CONCURRENCY;
  const jobs = [];
  const results = [];
  for (const shot of candidates) {
    try {
      const jobStart = jobs.length;
      const generationContext = {
        ...ctx,
        awaitCompletion: false,
        batchStyleSnapshot,
        schedule: (callback) => jobs.push(callback),
      };
      const shotInput = {
        ...input,
        shot_id: undefined,
        shotId: undefined,
        shot_ids: undefined,
        shotIds: undefined,
        version_id: undefined,
        versionId: undefined,
      };
      shotInput.shotId = shot.id;
      const result = shot.status === 'failed'
        ? await retryShot(generationContext, shotInput)
        : await generateShot(generationContext, shotInput);
      if (jobs[jobStart]) {
        jobs[jobStart].redraw = {
          shot_id: shot.id,
          task_id: result.task_id,
          video_generation_id: result.video_generation_id,
        };
      }
      results.push({ shot_id: shot.id, ...result });
    } catch (error) {
      results.push(failBatchShotSafely(ctx, shot, error));
    }
  }
  scheduleBatchDrain(ctx, jobs, concurrency);
  return { version_id: versionId, results, skipped };
}

function markRetryUncertain(db, shot, task, video, message, timestamp) {
  if (task && video) {
    updateNeedsAttention(db, task.id, shot.id, message, timestamp, video.id);
    return;
  }
  db.prepare(`
    UPDATE redraw_shots
    SET status = 'needs_attention', error_code = 'REDRAW_VIDEO_NEEDS_ATTENTION', error_message = ?, updated_at = ?
    WHERE id = ?
  `).run(message, timestamp, shot.id);
}

async function retryShot(ctx, input = {}) {
  const { db } = ctx;
  if (!db || !ctx.tenantId || !ctx.userId) throw codedError('REDRAW_CONTEXT_INVALID', '缺少转绘生成上下文');
  const shot = selectShot(db, ctx, input);
  if (shot.status !== 'failed') {
    throw codedError('REDRAW_SHOT_RETRY_REQUIRED', '仅明确失败的镜头可以重试');
  }
  const video = shot.video_generation_id
    ? db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(shot.video_generation_id))
    : null;
  const task = video?.task_id
    ? db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(video.task_id)
    : null;
  let metadata = null;
  let reservation = null;
  try {
    metadata = task ? taskMetadata(task) : null;
    reservation = metadata?.reservation_id
      ? db.prepare('SELECT * FROM tenant_usage_reservations WHERE id = ?').get(metadata.reservation_id)
      : null;
  } catch (_) {}
  const oldTerminalClear = video?.status === 'failed'
    && task?.status === 'failed'
    && reservation?.status === 'refunded'
    && String(task?.resource_id || '') === String(shot.id)
    && String(reservation?.tenant_id || '') === String(ctx.tenantId)
    && reservation?.resource_type === 'redraw_shot'
    && String(reservation?.resource_id || '') === String(shot.id)
    && ownerMatches(video, ctx)
    && ownerMatches(task, ctx);
  if (!oldTerminalClear) {
    const message = '旧生成任务终态不明确，请人工确认后处理，禁止重复提交';
    markRetryUncertain(db, shot, task, video, message, now(ctx));
    throw codedError('REDRAW_RETRY_UNCERTAIN', message);
  }
  const draft = strictJson(shot.draft_json, 'draft_json');
  const previousAttempt = Number(draft.generation?.attempt ?? draft.attempt ?? 1);
  const attempt = Number.isSafeInteger(previousAttempt) && previousAttempt > 0 ? previousAttempt + 1 : 2;
  return generateShot({ ...ctx, retryFailedShot: true }, { ...input, shotId: shot.id, attempt });
}

async function recoverInterruptedShotGenerations(ctx) {
  const { db } = ctx;
  if (!db) throw codedError('REDRAW_CONTEXT_INVALID', '缺少转绘生成上下文');
  const ownerClause = ctx.tenantId && ctx.userId ? ' AND t.tenant_id = ? AND t.user_id = ?' : '';
  const ownerParams = ctx.tenantId && ctx.userId ? [String(ctx.tenantId), String(ctx.userId)] : [];
  const rows = db.prepare(`
    SELECT t.id AS task_id
    FROM async_tasks t
    JOIN video_generations v ON v.task_id = t.id AND v.deleted_at IS NULL
    JOIN redraw_shots s ON s.video_generation_id = v.id AND s.deleted_at IS NULL
    WHERE t.type = 'redraw_shot' AND t.deleted_at IS NULL
      AND v.tenant_id = t.tenant_id AND v.user_id = t.user_id
      AND s.tenant_id = t.tenant_id AND s.user_id = t.user_id
      AND s.status = 'processing'
      AND (
        (t.status IN ('pending', 'processing') AND v.status = 'processing')
        OR (t.status = 'completed' AND v.status = 'completed')
        OR (t.status = 'failed' AND v.status = 'failed')
      )
      AND v.provider_task_id IS NOT NULL AND TRIM(v.provider_task_id) != ''${ownerClause}
    ORDER BY t.created_at ASC, t.id ASC
  `).all(...ownerParams);
  const rawConcurrency = Number(ctx.generationConcurrency ?? DEFAULT_GENERATION_CONCURRENCY);
  const concurrency = Number.isSafeInteger(rawConcurrency) && rawConcurrency > 0
    ? Math.min(rawConcurrency, 8)
    : DEFAULT_GENERATION_CONCURRENCY;
  return runBounded(rows, concurrency, async (row) => runShotGeneration({
    ...ctx,
    recoverExistingProvider: true,
    videoRecoveryProcessor: ctx.videoRecoveryProcessor
      ? ((database, logger, videoId) => ctx.videoRecoveryProcessor(database, logger, videoId))
      : ((database, logger, videoId) => waitForRecoveredVideo(database, logger, videoId, ctx)),
  }, row.task_id));
}

function markInterruptedShotGenerationsNeedsAttention(db, log, options = {}) {
  const timestamp = new Date().toISOString();
  let rows;
  try {
    rows = db.prepare(`
      SELECT t.id AS task_id, t.progress AS task_progress,
             s.id AS shot_id, v.id AS video_id, v.provider_task_id
      FROM async_tasks t
      JOIN redraw_shots s
        ON CAST(s.id AS TEXT) = CAST(t.resource_id AS TEXT)
        AND s.deleted_at IS NULL
        AND s.tenant_id = t.tenant_id
        AND s.user_id = t.user_id
      JOIN video_generations v
        ON v.task_id = t.id
        AND v.deleted_at IS NULL
        AND v.tenant_id = t.tenant_id
        AND v.user_id = t.user_id
        AND v.id = s.video_generation_id
      WHERE t.type = 'redraw_shot' AND t.deleted_at IS NULL
        AND (
          t.status IN ('pending', 'processing')
          OR (s.status = 'processing' AND t.status = 'completed' AND v.status = 'completed')
          OR (s.status = 'processing' AND t.status = 'failed' AND v.status = 'failed')
        )
    `).all();
  } catch (error) {
    if (!/no such (table|column)/i.test(String(error.message || ''))) throw error;
    log?.warn?.('Skip redraw shot startup recovery for legacy schema', { error: error.message });
    return 0;
  }
  if (!rows.length) return 0;
  const interrupted = rows.filter((row) => !String(row.provider_task_id || '').trim());
  const recoverable = rows.filter((row) => String(row.provider_task_id || '').trim());
  db.transaction(() => {
    for (const row of interrupted) {
      db.prepare(`
        UPDATE async_tasks
        SET status = 'needs_attention',
            progress = CASE WHEN COALESCE(progress, 0) > 90 THEN progress ELSE 90 END,
            message = ?, error = ?, result = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(INTERRUPTED_MESSAGE, INTERRUPTED_MESSAGE, timestamp, row.task_id);
      db.prepare(`
        UPDATE redraw_shots
        SET status = 'needs_attention', error_code = 'REDRAW_VIDEO_NEEDS_ATTENTION',
            error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(INTERRUPTED_MESSAGE, timestamp, row.shot_id);
      db.prepare(`
        UPDATE video_generations
        SET status = 'needs_attention', error_msg = ?, updated_at = ?
        WHERE id = ?
      `).run(INTERRUPTED_MESSAGE, timestamp, row.video_id);
    }
  })();
  if (interrupted.length) {
    log?.warn?.('Interrupted redraw shot generations marked needs_attention', { count: interrupted.length });
  }
  if (recoverable.length) {
    const schedule = options.schedule || ((callback) => setImmediate(callback));
    schedule(() => recoverInterruptedShotGenerations({
      db,
      log,
      ...(options.recoveryContext || {}),
    }).catch((error) => {
      log?.error?.('Recover redraw shot generations failed', { error: error.message });
    }));
    log?.info?.('Recoverable redraw shot generations scheduled', { count: recoverable.length });
  }
  return interrupted.length;
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
  ], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
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
  let realStorageRoot;
  let realAbsPath;
  try {
    realStorageRoot = fs.realpathSync.native(storageRoot);
    fs.accessSync(absPath, fs.constants.R_OK);
    realAbsPath = fs.realpathSync.native(absPath);
  } catch (_) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片文件不可读取');
  }
  if (!isInside(realStorageRoot, realAbsPath)) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片路径越界');
  }
  const probe = ctx.probeRunner ? await ctx.probeRunner(absPath, row) : await defaultProbe(absPath);
  if (!(probe?.duration > 0 && probe?.width > 0 && probe?.height > 0)) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片元数据无效');
  }
  return { duration: probe.duration, width: probe.width, height: probe.height };
}

module.exports = {
  generateShot,
  generateBatch,
  retryShot,
  recoverInterruptedShotGenerations,
  runShotGeneration,
  markInterruptedShotGenerationsNeedsAttention,
  verifyVideoArtifact,
  classifyVideoOutcome,
};
