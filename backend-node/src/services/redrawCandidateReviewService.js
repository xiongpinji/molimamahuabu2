'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config');
const redrawBillingService = require('./redrawBillingService');
const { verifyCandidateQuality } = require('./redrawCandidateQualityService');

const SHA256 = /^[a-f0-9]{64}$/;

function codedError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function storageRoot(ctx) {
  if (ctx.storageRoot) return path.resolve(ctx.storageRoot);
  const localPath = config.loadConfig().storage?.local_path || './data/storage';
  return path.isAbsolute(localPath) ? localPath : path.join(process.cwd(), localPath);
}

function loadCandidate(ctx, input) {
  const shotId = Number(input?.shot_id);
  const videoGenerationId = input?.video_generation_id == null
    ? null
    : Number(input.video_generation_id);
  if (!Number.isSafeInteger(shotId) || shotId < 1
    || (videoGenerationId != null && (!Number.isSafeInteger(videoGenerationId) || videoGenerationId < 1))) {
    throw codedError('REDRAW_CANDIDATE_REVIEW_INPUT_INVALID', '候选审核输入无效');
  }
  const owner = [String(ctx.tenantId || ''), String(ctx.userId || '')];
  const row = ctx.db.prepare(`
    SELECT s.*, v.work_id, v.locale, v.market, v.localization_level,
           v.facts_hash, v.glossary_json, v.name_map_json, v.culture_map_json,
           v.text_map_json, v.style_snapshot_json,
           w.project_id, p.execution_mode
    FROM redraw_shots s
    JOIN redraw_versions v
      ON v.id = s.version_id AND v.deleted_at IS NULL
    JOIN redraw_works w
      ON w.id = v.work_id AND w.deleted_at IS NULL
    JOIN redraw_projects p
      ON p.id = w.project_id AND p.deleted_at IS NULL
    WHERE s.id = ? AND s.tenant_id = ? AND s.user_id = ? AND s.deleted_at IS NULL
  `).get(shotId, ...owner);
  if (!row) throw codedError('REDRAW_CANDIDATE_NOT_FOUND', '逐镜候选不存在');
  const expectedVideoId = videoGenerationId ?? Number(row.video_generation_id);
  if (!Number.isSafeInteger(expectedVideoId) || expectedVideoId < 1
    || Number(row.video_generation_id) !== expectedVideoId) {
    throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '候选已被其他生成结果替换', 409);
  }
  const video = ctx.db.prepare(`
    SELECT * FROM video_generations
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(expectedVideoId, ...owner);
  if (!video || String(video.status || '') !== 'completed' || !String(video.local_path || '').trim()) {
    throw codedError('REDRAW_CANDIDATE_NOT_READY', '逐镜候选文件尚未就绪');
  }
  return { shot: row, video };
}

function referencedAssetIds(shot) {
  let references;
  try {
    references = JSON.parse(String(shot.references_json || '[]'));
  } catch (_) {
    throw codedError('REDRAW_CANDIDATE_REVIEW_STALE', '候选依赖证据无效');
  }
  if (!Array.isArray(references)) throw codedError('REDRAW_CANDIDATE_REVIEW_STALE', '候选依赖证据无效');
  const ids = new Set();
  for (const reference of references) {
    if (!reference || typeof reference !== 'object') continue;
    for (const key of ['redraw_asset_id', 'redrawAssetId', 'asset_id', 'assetId', 'character_asset_id', 'characterAssetId']) {
      const id = Number(reference[key]);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function dependencyHash(ctx, shot) {
  if (typeof ctx.candidateDependencyHasher === 'function') {
    const injected = String(ctx.candidateDependencyHasher({ ctx, shot }) || '').toLowerCase();
    if (!SHA256.test(injected)) throw codedError('REDRAW_CANDIDATE_REVIEW_STALE', '候选依赖哈希无效');
    return injected;
  }
  const ids = referencedAssetIds(shot);
  const assets = ids.length
    ? ctx.db.prepare(`
        SELECT id, kind, source_ref_json, asset_id, voice_asset_id, clean_plate_asset_id,
               mask_asset_id, version_number, approval_status, status, updated_at
        FROM redraw_assets
        WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
          AND id IN (${ids.map(() => '?').join(',')})
        ORDER BY id
      `).all(Number(shot.version_id), String(ctx.tenantId), String(ctx.userId), ...ids)
    : [];
  if (assets.length !== ids.length) throw codedError('REDRAW_CANDIDATE_REVIEW_STALE', '候选引用资产已失效');
  return sha256(stableJson({
    schema_version: 'redraw-candidate-dependencies-v1',
    version: {
      id: Number(shot.version_id),
      locale: shot.locale,
      market: shot.market,
      localization_level: shot.localization_level,
      facts_hash: shot.facts_hash,
      glossary_json: shot.glossary_json,
      name_map_json: shot.name_map_json,
      culture_map_json: shot.culture_map_json,
      text_map_json: shot.text_map_json,
      style_snapshot_json: shot.style_snapshot_json,
    },
    shot: {
      id: Number(shot.id),
      start_ms: Number(shot.start_ms),
      end_ms: Number(shot.end_ms),
      duration_ms: Number(shot.duration_ms),
      source_dialogue_json: shot.source_dialogue_json,
      localized_dialogue_json: shot.localized_dialogue_json,
      references_json: shot.references_json,
      prompt: shot.prompt,
      negative_prompt: shot.negative_prompt,
      compiled_prompt_json: shot.compiled_prompt_json,
      reference_bundle_hash: shot.reference_bundle_hash,
      preparation_state: shot.preparation_state,
      preparation_version: Number(shot.preparation_version),
      preparation_evidence_hash: shot.preparation_evidence_hash,
      audio_asset_id: shot.audio_asset_id == null ? null : Number(shot.audio_asset_id),
      subtitle_asset_id: shot.subtitle_asset_id == null ? null : Number(shot.subtitle_asset_id),
    },
    assets,
  }));
}

function candidateHash(ctx, shot, video) {
  if (typeof ctx.candidateHasher === 'function') {
    const injected = String(ctx.candidateHasher({ ctx, shot, video }) || '').toLowerCase();
    if (!SHA256.test(injected)) throw codedError('REDRAW_CANDIDATE_REVIEW_STALE', '候选文件哈希无效');
    return injected;
  }
  const root = storageRoot(ctx);
  const relative = String(video.local_path).replace(/^\/static\//, '').replace(/\\/g, '/').replace(/^\/+/, '');
  const absolute = path.resolve(root, relative);
  if (!isInside(root, absolute)) throw codedError('REDRAW_CANDIDATE_REVIEW_STALE', '候选文件路径越界');
  let realRoot;
  let realCandidate;
  try {
    realRoot = fs.realpathSync.native(root);
    realCandidate = fs.realpathSync.native(absolute);
    fs.accessSync(realCandidate, fs.constants.R_OK);
  } catch (_) {
    throw codedError('REDRAW_CANDIDATE_REVIEW_STALE', '候选文件不可读取');
  }
  if (!isInside(realRoot, realCandidate)) throw codedError('REDRAW_CANDIDATE_REVIEW_STALE', '候选文件路径越界');
  return sha256File(realCandidate);
}

function snapshot(ctx, input) {
  const current = loadCandidate(ctx, input);
  return {
    ...current,
    candidate_sha256: candidateHash(ctx, current.shot, current.video),
    dependency_hash: dependencyHash(ctx, current.shot),
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return fallback;
  }
}

function projectReview(row) {
  return row ? {
    id: Number(row.id),
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    version_id: Number(row.version_id),
    shot_id: Number(row.shot_id),
    video_generation_id: Number(row.video_generation_id),
    candidate_sha256: row.candidate_sha256,
    dependency_hash: row.dependency_hash,
    review_version: Number(row.review_version),
    decision: row.decision,
    decision_source: row.decision_source,
    reason_codes: parseJson(row.reason_codes_json, []),
    metrics: parseJson(row.metrics_json, {}),
    reviewer_id: row.reviewer_id,
    created_at: row.created_at,
  } : null;
}

function currentMatchingReview(ctx, current) {
  return ctx.db.prepare(`
    SELECT * FROM redraw_candidate_reviews
    WHERE tenant_id = ? AND user_id = ? AND shot_id = ? AND video_generation_id = ?
      AND candidate_sha256 = ? AND dependency_hash = ?
    ORDER BY review_version DESC, id DESC
    LIMIT 1
  `).get(
    String(ctx.tenantId), String(ctx.userId), Number(current.shot.id), Number(current.video.id),
    current.candidate_sha256, current.dependency_hash,
  );
}

function getCurrentCandidateReview(ctx, input) {
  return projectReview(currentMatchingReview(ctx, snapshot(ctx, input)));
}

function assertCurrentApprovedCandidate(ctx, input) {
  const current = snapshot(ctx, input);
  const pointer = Number(current.shot.approved_candidate_review_id);
  const row = pointer > 0
    ? ctx.db.prepare(`
        SELECT * FROM redraw_candidate_reviews
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND shot_id = ? AND video_generation_id = ?
          AND candidate_sha256 = ? AND dependency_hash = ? AND decision = 'approved'
      `).get(
        pointer, String(ctx.tenantId), String(ctx.userId), Number(current.shot.id), Number(current.video.id),
        current.candidate_sha256, current.dependency_hash,
      )
    : null;
  if (!row) throw codedError('REDRAW_CANDIDATE_NOT_APPROVED', '当前逐镜候选尚未批准', 409);
  return projectReview(row);
}

function normalizeReasons(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw codedError('REDRAW_CANDIDATE_REVIEW_INPUT_INVALID', '候选审核原因无效');
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))].sort();
}

function validateQuality(value) {
  if (!value || !['approved', 'rejected', 'needs_review'].includes(value.decision)
    || !Array.isArray(value.reason_codes)
    || !value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics)) {
    throw codedError('REDRAW_CANDIDATE_QUALITY_EVIDENCE_INVALID', '候选质量证据无效');
  }
  return {
    decision: value.decision,
    reason_codes: normalizeReasons(value.reason_codes),
    metrics: value.metrics,
  };
}

function monotonicTimestamp(candidate, previous) {
  const candidateMs = Date.parse(String(candidate || ''));
  const previousMs = Date.parse(String(previous || ''));
  if (Number.isFinite(candidateMs) && (!Number.isFinite(previousMs) || candidateMs > previousMs)) {
    return new Date(candidateMs).toISOString();
  }
  return new Date((Number.isFinite(previousMs) ? previousMs : Date.now()) + 1).toISOString();
}

function taskReservationId(task) {
  const metadata = parseJson(task?.metadata || '{}', {});
  return metadata?.redraw_shot?.reservation_id || metadata?.reservation_id || null;
}

function advanceVersionWhenAllShotsApproved(db, ctx, versionId, timestamp) {
  const gate = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE
        WHEN s.video_generation_id IS NOT NULL
          AND s.approved_candidate_review_id IS NOT NULL
          AND s.status IN ('approved', 'included', 'completed')
          AND EXISTS (
            SELECT 1
            FROM redraw_candidate_reviews r
            WHERE r.id = s.approved_candidate_review_id
              AND r.tenant_id = s.tenant_id
              AND r.user_id = s.user_id
              AND r.shot_id = s.id
              AND r.video_generation_id = s.video_generation_id
              AND r.decision = 'approved'
          )
        THEN 0 ELSE 1
      END) AS incomplete
    FROM redraw_shots s
    WHERE s.version_id = ? AND s.tenant_id = ? AND s.user_id = ? AND s.deleted_at IS NULL
  `).get(Number(versionId), String(ctx.tenantId), String(ctx.userId));
  if (!gate || Number(gate.total) < 1 || Number(gate.incomplete || 0) !== 0) return false;
  db.prepare(`
    UPDATE redraw_versions
    SET status = 'composing', updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).run(timestamp, Number(versionId), String(ctx.tenantId), String(ctx.userId));
  db.prepare(`
    UPDATE redraw_works
    SET status = 'composing', current_step = 4, updated_at = ?
    WHERE id = (
      SELECT work_id FROM redraw_versions
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    )
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).run(
    timestamp,
    Number(versionId),
    String(ctx.tenantId),
    String(ctx.userId),
    String(ctx.tenantId),
    String(ctx.userId),
  );
  return true;
}

function isSqliteReviewConflict(error) {
  return ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY']
    .includes(String(error?.code || ''));
}

function persistReview(ctx, baseline, input, evidence) {
  const { db } = ctx;
  const transaction = db.transaction(() => {
    const current = snapshot(ctx, input);
    if (current.candidate_sha256 !== baseline.candidate_sha256
      || current.dependency_hash !== baseline.dependency_hash) {
      throw codedError('REDRAW_CANDIDATE_REVIEW_STALE', '审核期间候选或依赖已变化', 409);
    }
    if (input.decision_source === 'human'
      && String(input.candidate_sha256 || '').toLowerCase() !== current.candidate_sha256) {
      throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '候选文件哈希已变化', 409);
    }
    const duplicate = currentMatchingReview(ctx, current);
    if (duplicate?.decision_source === input.decision_source) {
      if (duplicate.decision === evidence.decision) return projectReview(duplicate);
      throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '当前候选已有冲突审核结论', 409);
    }
    if (duplicate?.decision_source === 'human') {
      if (duplicate.decision === evidence.decision) return projectReview(duplicate);
      throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '当前候选已有冲突人工结论', 409);
    }
    if (duplicate && duplicate.decision !== 'needs_review') {
      throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '当前候选已有终态审核结论', 409);
    }
    if (String(current.shot.updated_at) !== String(input.expected_updated_at)
      || Number(current.shot.video_generation_id) !== Number(current.video.id)) {
      throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '镜头已被其他操作更新', 409);
    }
    const nextVersion = Number(db.prepare(`
      SELECT COALESCE(MAX(review_version), 0) + 1 AS version
      FROM redraw_candidate_reviews
      WHERE tenant_id = ? AND user_id = ? AND shot_id = ? AND video_generation_id = ?
    `).get(String(ctx.tenantId), String(ctx.userId), Number(current.shot.id), Number(current.video.id)).version);
    const createdAt = monotonicTimestamp(
      typeof ctx.clock === 'function' ? ctx.clock() : new Date().toISOString(),
      current.shot.updated_at,
    );
    const inserted = db.prepare(`
      INSERT INTO redraw_candidate_reviews
        (tenant_id, user_id, version_id, shot_id, video_generation_id,
         candidate_sha256, dependency_hash, review_version, decision, decision_source,
         reason_codes_json, metrics_json, reviewer_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(ctx.tenantId), String(ctx.userId), Number(current.shot.version_id), Number(current.shot.id),
      Number(current.video.id), current.candidate_sha256, current.dependency_hash, nextVersion,
      evidence.decision, input.decision_source, stableJson(evidence.reason_codes), stableJson(evidence.metrics),
      input.reviewer_id || null, createdAt,
    );
    const reviewId = Number(inserted.lastInsertRowid);
    const approved = evidence.decision === 'approved';
    const shotDraft = parseJson(current.shot.draft_json || '{}', {});
    const nextDraft = approved
      ? {
          ...shotDraft,
          generation: {
            ...(shotDraft.generation && typeof shotDraft.generation === 'object' ? shotDraft.generation : {}),
            completed_at: createdAt,
          },
        }
      : shotDraft;
    const shotUpdate = db.prepare(`
      UPDATE redraw_shots
      SET approved_candidate_review_id = ?, status = ?, error_code = ?, error_message = ?,
          draft_json = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND updated_at = ?
        AND video_generation_id = ? AND deleted_at IS NULL
    `).run(
      approved ? reviewId : null,
      approved ? 'approved' : 'needs_review',
      approved ? null : 'REDRAW_CANDIDATE_REVIEW_REQUIRED',
      approved ? null : (evidence.decision === 'rejected' ? '逐镜候选质量未通过，等待人工处理' : '逐镜候选等待人工审核'),
      stableJson(nextDraft), createdAt, Number(current.shot.id), String(ctx.tenantId), String(ctx.userId),
      String(input.expected_updated_at), Number(current.video.id),
    );
    if (shotUpdate.changes !== 1) throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '镜头已被其他操作更新', 409);

    const task = current.video.task_id
      ? db.prepare(`SELECT * FROM async_tasks WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
        .get(current.video.task_id, String(ctx.tenantId), String(ctx.userId))
      : null;
    if (task) {
      if (approved) {
        const priorResult = parseJson(task.result || '{}', {});
        const candidateRef = shotDraft.new_video_ref || {};
        const taskUpdate = db.prepare(`
          UPDATE async_tasks
          SET status = 'completed', progress = 100, message = '', error = NULL,
              result = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        `).run(stableJson({
          ...priorResult,
          status: 'completed',
          shot_id: Number(current.shot.id),
          video_generation_id: Number(current.video.id),
          asset_id: priorResult.asset_id || candidateRef.asset_id || null,
          candidate_review_id: reviewId,
          video_url: current.video.video_url || null,
          local_path: current.video.local_path,
          probe: priorResult.probe || candidateRef.probe || null,
        }), createdAt, createdAt, task.id, String(ctx.tenantId), String(ctx.userId));
        if (taskUpdate.changes !== 1) {
          throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '候选任务已被其他操作更新', 409);
        }
        const reservationId = taskReservationId(task);
        if (reservationId) redrawBillingService.settleShotGeneration(db, reservationId, 'completed');
      } else {
        const message = evidence.decision === 'rejected'
          ? '逐镜候选质量未通过，等待人工处理'
          : '逐镜候选等待人工审核';
        const taskUpdate = db.prepare(`
          UPDATE async_tasks
          SET status = 'needs_attention', progress = 90, message = ?, error = ?,
              result = ?, completed_at = NULL, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        `).run(message, message, stableJson({
          status: 'candidate',
          shot_id: Number(current.shot.id),
          video_generation_id: Number(current.video.id),
          candidate_review_id: reviewId,
        }), createdAt, task.id, String(ctx.tenantId), String(ctx.userId));
        if (taskUpdate.changes !== 1) {
          throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '候选任务已被其他操作更新', 409);
        }
      }
    }
    if (approved) {
      advanceVersionWhenAllShotsApproved(db, ctx, current.shot.version_id, createdAt);
      if (typeof ctx.beforeCandidateApprovalCommit === 'function') {
        const hookResult = ctx.beforeCandidateApprovalCommit({
          db,
          review_id: reviewId,
          shot_id: Number(current.shot.id),
          video_generation_id: Number(current.video.id),
          timestamp: createdAt,
        });
        if (hookResult && typeof hookResult.then === 'function') {
          throw codedError('REDRAW_CANDIDATE_APPROVAL_HOOK_INVALID', '候选批准事务钩子必须同步完成');
        }
      }
    }
    return projectReview(db.prepare('SELECT * FROM redraw_candidate_reviews WHERE id = ?').get(reviewId));
  });
  try {
    return transaction.immediate();
  } catch (error) {
    if (error?.code?.startsWith?.('REDRAW_')) throw error;
    if (isSqliteReviewConflict(error)) {
      throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '候选审核并发冲突', 409);
    }
    throw error;
  }
}

async function reviewCandidate(ctx, rawInput = {}) {
  const input = { ...rawInput };
  if (!['automatic', 'human'].includes(input.decision_source)) {
    throw codedError('REDRAW_CANDIDATE_REVIEW_INPUT_INVALID', '审核来源无效');
  }
  if (input.decision_source === 'human') {
    if (!['approved', 'rejected'].includes(input.decision)) {
      throw codedError('REDRAW_CANDIDATE_REVIEW_INPUT_INVALID', '人工审核结论无效');
    }
    if (!String(input.expected_updated_at || '').trim()) {
      throw codedError('REDRAW_CANDIDATE_REVIEW_EXPECTED_UPDATED_AT_REQUIRED', 'expected_updated_at 必填');
    }
    if (input.decision === 'approved' && !String(input.candidate_sha256 || '').trim()) {
      throw codedError('REDRAW_CANDIDATE_REVIEW_SHA_REQUIRED', 'candidate_sha256 必填');
    }
  }

  const before = snapshot(ctx, input);
  let evidence;
  if (input.decision_source === 'automatic') {
    const verifier = ctx.candidateQualityVerifier || verifyCandidateQuality;
    const quality = validateQuality(await verifier(ctx, {
      version_id: Number(before.shot.version_id),
      shot_id: Number(before.shot.id),
      video_generation_id: Number(before.video.id),
      candidate_sha256: before.candidate_sha256,
      dependency_hash: before.dependency_hash,
    }, ctx.candidateQualityDependencies));
    const executionMode = ctx.candidateExecutionMode || before.shot.execution_mode;
    evidence = {
      decision: String(executionMode) === 'safe' ? 'needs_review' : quality.decision,
      reason_codes: String(executionMode) === 'safe'
        ? [...new Set(['safe_mode_human_review_required', ...quality.reason_codes])].sort()
        : quality.reason_codes,
      metrics: quality.metrics,
    };
  } else {
    if (String(input.candidate_sha256 || '').toLowerCase() !== before.candidate_sha256) {
      throw codedError('REDRAW_CANDIDATE_REVIEW_CONFLICT', '候选文件哈希已变化', 409);
    }
    evidence = {
      decision: input.decision,
      reason_codes: normalizeReasons(input.reason_codes || (input.decision === 'rejected' ? ['human_rejected'] : [])),
      metrics: {},
    };
  }

  if (typeof ctx.beforeCandidateReviewCommit === 'function') await ctx.beforeCandidateReviewCommit({ ...before, evidence });
  const expectedUpdatedAt = input.expected_updated_at || before.shot.updated_at;
  return persistReview(ctx, before, {
    ...input,
    expected_updated_at: expectedUpdatedAt,
    reviewer_id: input.decision_source === 'human' ? String(ctx.userId || '') : null,
  }, evidence);
}

module.exports = {
  reviewCandidate,
  getCurrentCandidateReview,
  assertCurrentApprovedCandidate,
};
