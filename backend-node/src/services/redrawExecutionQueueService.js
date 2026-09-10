'use strict';

const { isDeepStrictEqual } = require('node:util');
const { hashPlanValue } = require('./redrawExecutionPlanService');
const { getExecutionPlanReview, validateSavedPlan } = require('./redrawExecutionPlanReviewService');

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

function ownedVersion(ctx, versionId) {
  if (!Number.isSafeInteger(Number(versionId)) || Number(versionId) <= 0 || !ctx.tenantId || !ctx.userId) {
    fail('REDRAW_VERSION_NOT_FOUND');
  }
  const version = ctx.db.prepare(`SELECT v.id, v.work_id FROM redraw_versions v
    JOIN redraw_works w ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL AND w.deleted_at IS NULL`)
    .get(Number(versionId), ctx.tenantId, ctx.userId);
  if (!version) fail('REDRAW_VERSION_NOT_FOUND');
  return version;
}

function selectedQueue(ctx, version, preview) {
  return ctx.db.prepare(`SELECT id, tenant_id, user_id, work_id, version_id, review_id, plan_hash, status, created_at
    FROM redraw_execution_queues WHERE tenant_id = ? AND user_id = ? AND version_id = ?
    ORDER BY (plan_hash = ?) DESC, id DESC LIMIT 1`)
    .get(ctx.tenantId, ctx.userId, version.id, preview.plan_hash);
}

function publicQueue(ctx, version, row, reviewResult) {
  if (!row) return null;
  const invalid = { id: row.id, work_id: version.work_id, version_id: version.id, plan_hash: null,
    status: 'invalid', executable: false, created_at: null, units: [], execution_blockers: ['EXECUTION_QUEUE_INVALID'] };
  if (row.tenant_id !== ctx.tenantId || row.user_id !== ctx.userId || row.work_id !== version.work_id
    || row.version_id !== version.id || !sha(row.plan_hash) || row.status !== 'waiting_readiness'
    || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return invalid;
  // The queue may reference an older review than the selected live review. Validate that exact immutable snapshot.
  const review = ctx.db.prepare(`SELECT id, tenant_id, user_id, work_id, version_id, plan_hash, plan_json, created_at
    FROM redraw_execution_plan_reviews WHERE id = ?`).get(row.review_id);
  if (!review || review.id !== row.review_id || review.plan_hash !== row.plan_hash) return invalid;
  let plan;
  try { plan = JSON.parse(review.plan_json); } catch { return invalid; }
  if (!validateSavedPlan(plan, review, ctx, version)) return invalid;
  const rows = ctx.db.prepare(`SELECT queue_id, unit_id, ordinal, unit_hash, unit_json, status
    FROM redraw_execution_queue_units WHERE queue_id = ? ORDER BY ordinal ASC, id ASC`).all(row.id);
  if (rows.length !== plan.units.length) return invalid;
  const units = [];
  for (const [ordinal, unit] of rows.entries()) {
    const expected = plan.units[ordinal];
    let body;
    try { body = JSON.parse(unit.unit_json); } catch { return invalid; }
    if (unit.queue_id !== row.id || unit.ordinal !== ordinal || unit.unit_id !== expected.id
      || unit.status !== 'pending' || !sha(unit.unit_hash) || unit.unit_hash !== hashPlanValue(expected)
      || unit.unit_hash !== hashPlanValue(body) || !isDeepStrictEqual(body, expected)) return invalid;
    units.push({ id: unit.unit_id, ordinal, status: 'pending', unit_hash: unit.unit_hash, plan_unit: body });
  }
  const { preview, saved_review: saved } = reviewResult;
  const current = preview.status === 'ready' && preview.plan_hash === row.plan_hash
    && saved?.status === 'current' && saved.id === row.review_id;
  return { id: row.id, work_id: row.work_id, version_id: row.version_id, plan_hash: row.plan_hash,
    status: current ? 'waiting_readiness' : 'stale', executable: false, created_at: row.created_at,
    units, execution_blockers: plan.execution_blockers };
}

function getExecutionQueue(ctx, versionId) {
  return ctx.db.transaction(() => {
    const version = ownedVersion(ctx, versionId);
    const review = getExecutionPlanReview(ctx, version.id);
    return { ...review, queue: publicQueue(ctx, version, selectedQueue(ctx, version, review.preview), review) };
  })();
}

function prepareExecutionQueue(ctx, versionId, input) {
  return ctx.db.transaction(() => {
    const version = ownedVersion(ctx, versionId);
    if (!object(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'expected_plan_hash')
      || !sha(input.expected_plan_hash)) fail('EXECUTION_QUEUE_INPUT_INVALID');
    const review = getExecutionPlanReview(ctx, version.id);
    const { preview, saved_review: saved } = review;
    const existing = publicQueue(ctx, version, selectedQueue(ctx, version, preview), review);
    // Never hide damaged current or latest historical evidence by inserting a different queue.
    if (existing?.status === 'invalid') fail('EXECUTION_QUEUE_INVALID');
    const latest = ctx.db.prepare(`SELECT id, tenant_id, user_id, work_id, version_id, review_id, plan_hash, status, created_at
      FROM redraw_execution_queues WHERE tenant_id = ? AND user_id = ? AND version_id = ?
      ORDER BY id DESC LIMIT 1`).get(ctx.tenantId, ctx.userId, version.id);
    if (latest && latest.id !== existing?.id && publicQueue(ctx, version, latest, review).status === 'invalid') {
      fail('EXECUTION_QUEUE_INVALID');
    }
    if (preview.status !== 'ready') fail('EXECUTION_PLAN_BLOCKED');
    if (preview.plan_hash !== input.expected_plan_hash) fail('EXECUTION_PLAN_CONFLICT');
    if (!saved) fail('EXECUTION_PLAN_REVIEW_REQUIRED');
    if (saved.status === 'invalid') fail('EXECUTION_PLAN_REVIEW_INVALID');
    if (saved.status !== 'current') fail('EXECUTION_PLAN_REVIEW_STALE');
    if (existing?.status === 'waiting_readiness') return { ...review, queue: existing };
    const row = { tenant_id: ctx.tenantId, user_id: ctx.userId, work_id: version.work_id, version_id: version.id,
      review_id: saved.id, plan_hash: preview.plan_hash, status: 'waiting_readiness', created_at: new Date().toISOString() };
    const inserted = ctx.db.prepare(`INSERT INTO redraw_execution_queues
      (tenant_id, user_id, work_id, version_id, review_id, plan_hash, status, created_at)
      VALUES (@tenant_id, @user_id, @work_id, @version_id, @review_id, @plan_hash, @status, @created_at)`).run(row);
    row.id = Number(inserted.lastInsertRowid);
    const insertUnit = ctx.db.prepare(`INSERT INTO redraw_execution_queue_units
      (queue_id, unit_id, ordinal, unit_hash, unit_json, status) VALUES (?, ?, ?, ?, ?, 'pending')`);
    saved.plan.units.forEach((unit, ordinal) => {
      insertUnit.run(row.id, unit.id, ordinal, hashPlanValue(unit), JSON.stringify(unit));
    });
    const queue = publicQueue(ctx, version, row, review);
    if (queue.status !== 'waiting_readiness') fail('EXECUTION_QUEUE_INVALID');
    return { ...review, queue };
  }).immediate();
}

function getExecutionQueueSnapshot(ctx, versionId, queueId) {
  return ctx.db.transaction(() => {
    const version = ownedVersion(ctx, versionId);
    if (!Number.isSafeInteger(Number(queueId)) || Number(queueId) <= 0) fail('EXECUTION_QUEUE_NOT_FOUND');
    const row = ctx.db.prepare(`SELECT id, tenant_id, user_id, work_id, version_id, review_id, plan_hash, status, created_at
      FROM redraw_execution_queues WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?`)
      .get(Number(queueId), ctx.tenantId, ctx.userId, version.id);
    if (!row) fail('EXECUTION_QUEUE_NOT_FOUND');
    const review = getExecutionPlanReview(ctx, version.id);
    return { ...review, queue: publicQueue(ctx, version, row, review) };
  })();
}

module.exports = { getExecutionQueue, prepareExecutionQueue, getExecutionQueueSnapshot };
