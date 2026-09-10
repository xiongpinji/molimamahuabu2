'use strict';

const { hashPlanValue } = require('./redrawExecutionPlanService');
const { previewVersionExecutionPlan } = require('./redrawExecutionPlanPreviewService');

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const strings = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const executionBlockers = ['PREVIEW_ONLY', 'SOURCE_MEDIA_NOT_RECHECKED', 'REFERENCE_ASSETS_NOT_VERIFIED',
  'CREDENTIAL_READINESS_NOT_CHECKED', 'DYNAMIC_EXECUTOR_NOT_CONNECTED'];

function ownedVersion(ctx, versionId) {
  if (!positive(Number(versionId)) || !ctx.tenantId || !ctx.userId) fail('REDRAW_VERSION_NOT_FOUND');
  const version = ctx.db.prepare(`SELECT v.id, v.work_id FROM redraw_versions v
    JOIN redraw_works w ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL AND w.deleted_at IS NULL`)
    .get(Number(versionId), ctx.tenantId, ctx.userId);
  if (!version) fail('REDRAW_VERSION_NOT_FOUND');
  return version;
}

function contentHash(value, field) {
  const { [field]: ignored, ...content } = value;
  return hashPlanValue(content);
}

// Historical snapshots are checked independently of live bindings, which may legitimately drift.
function validPlan(plan, row, ctx, version) {
  if (!object(plan) || !sha(row.plan_hash) || plan.plan_hash !== row.plan_hash
    || contentHash(plan, 'plan_hash') !== row.plan_hash
    || plan.schema_version !== 'redraw-execution-plan-preview-v1' || plan.status !== 'ready'
    || plan.executable !== false || plan.reference_readiness !== 'not_checked'
    || plan.source_media_readiness !== 'not_checked'
    || plan.parameter_evidence_scope !== 'approved_envelope_not_exhaustive_tuples'
    || plan.reference_semantics !== 'logical_requirements_not_assets'
    || !Array.isArray(plan.blocking_reasons) || plan.blocking_reasons.length !== 0
    || !strings(plan.execution_blockers) || !executionBlockers.every((code) => plan.execution_blockers.includes(code))) return false;
  const b = plan.bindings; const c = plan.capability;
  if (row.tenant_id !== ctx.tenantId || row.user_id !== ctx.userId
    || row.work_id !== version.work_id || row.version_id !== version.id
    || !object(b) || b.tenant_id !== row.tenant_id || b.user_id !== row.user_id
    || b.work_id !== row.work_id || b.version_id !== row.version_id
    || b.source_asset_id == null || !positive(b.blueprint_revision)
    || !['source_sha256', 'blueprint_hash', 'localization_hash', 'source_dialogue_hash',
      'reference_requirements_hash', 'capability_hash'].every((key) => sha(b[key]))
    || !['review', 'locked'].includes(b.localization_review_status)
    || !['localization_updated_at', 'version_updated_at', 'locale', 'market'].every((key) => text(b[key]))
    || !object(c) || c.capability_hash !== b.capability_hash || contentHash(c, 'capability_hash') !== c.capability_hash
    || !positive(c.config_id) || !['config_updated_at', 'provider', 'protocol', 'model'].every((key) => text(c[key]))
    || c.locale !== b.locale || c.market !== b.market || c.credential_readiness !== 'not_checked'
    || !sha(c.evidence_hash) || !sha(c.adapter_hash) || !strings(c.resolutions) || !strings(c.aspect_ratios)
    || !Array.isArray(c.durations_ms) || !c.durations_ms.length || !c.durations_ms.every(positive)
    || !object(c.max_references) || !['image', 'video', 'audio'].every((kind) => nonnegative(c.max_references[kind]))
    || !['native', 'replace', 'not_required'].includes(c.audio_mode)
    || !object(c.audio_verification) || c.audio_verification.mode !== c.audio_mode
    || typeof c.audio_verification.locale_verified !== 'boolean'
    || (c.audio_mode === 'native' && b.market && !plan.execution_blockers.includes('TARGET_REGION_AUDIO_NOT_VERIFIED'))
    || !Array.isArray(plan.units) || !plan.units.length) return false;
  let end = 0; const unitIds = new Set(); const dialogueIds = new Set();
  for (const unit of plan.units) {
    if (!object(unit) || !text(unit.id) || unitIds.has(unit.id)
      || unit.source_start_ms !== end || !positive(unit.source_end_ms) || unit.source_end_ms <= end
      || unit.retained_duration_ms !== unit.source_end_ms - end
      || !c.durations_ms.includes(unit.generated_duration_ms)
      || !nonnegative(unit.padding_ms) || unit.padding_ms !== unit.generated_duration_ms - unit.retained_duration_ms
      || !Array.isArray(unit.parent_shots) || !unit.parent_shots.length
      || !Array.isArray(unit.dialogues) || !Array.isArray(unit.reference_requirements)) return false;
    unitIds.add(unit.id);
    let parentEnd = end;
    for (const parent of unit.parent_shots) {
      if (!object(parent) || !text(parent.id) || !sha(parent.contract_hash)
        || parent.source_start_ms !== parentEnd || !positive(parent.source_end_ms)
        || parent.source_end_ms <= parentEnd || parent.source_end_ms > unit.source_end_ms
        || parent.unit_start_ms !== parent.source_start_ms - end
        || parent.unit_end_ms !== parent.source_end_ms - end) return false;
      parentEnd = parent.source_end_ms;
    }
    if (parentEnd !== unit.source_end_ms) return false;
    for (const dialogue of unit.dialogues) {
      if (!object(dialogue) || !text(dialogue.id) || dialogueIds.has(dialogue.id)
        || !['source_text', 'target_text', 'evidence_ref'].every((key) => text(dialogue[key]))
        || !sha(dialogue.evidence_sha256) || !nonnegative(dialogue.start_ms) || !positive(dialogue.end_ms)
        || dialogue.start_ms < end || dialogue.end_ms > unit.source_end_ms || dialogue.end_ms <= dialogue.start_ms
        || !Number.isFinite(dialogue.estimated_duration_ms) || dialogue.estimated_duration_ms <= 0
        || dialogue.estimated_duration_ms > dialogue.end_ms - dialogue.start_ms
        || dialogue.unit_start_ms !== dialogue.start_ms - end || dialogue.unit_end_ms !== dialogue.end_ms - end) return false;
      dialogueIds.add(dialogue.id);
    }
    const references = new Set();
    for (const reference of unit.reference_requirements) {
      if (!object(reference) || !text(reference.id) || references.has(reference.id)
        || !['image', 'video', 'audio'].includes(reference.kind) || !sha(reference.requirement_hash)) return false;
      references.add(reference.id);
    }
    if (!['image', 'video', 'audio'].every((kind) => unit.reference_requirements
      .filter((reference) => reference.kind === kind).length <= c.max_references[kind])) return false;
    end = unit.source_end_ms;
  }
  return true;
}

function selectedReview(ctx, version, preview) {
  return ctx.db.prepare(`SELECT id, tenant_id, user_id, work_id, version_id, plan_hash, plan_json, created_at
    FROM redraw_execution_plan_reviews WHERE tenant_id = ? AND user_id = ? AND version_id = ?
    ORDER BY (plan_hash = ?) DESC, id DESC LIMIT 1`)
    .get(ctx.tenantId, ctx.userId, version.id, preview.plan_hash);
}

function publicReview(row, preview, ctx, version) {
  if (!row) return null;
  let plan;
  try { plan = JSON.parse(row.plan_json); } catch { plan = null; }
  const valid = validPlan(plan, row, ctx, version);
  return { id: row.id, plan_hash: row.plan_hash, saved_at: row.created_at,
    status: valid ? (preview.status === 'ready' && row.plan_hash === preview.plan_hash ? 'current' : 'stale') : 'invalid',
    plan: valid ? plan : null };
}

function getExecutionPlanReview(ctx, versionId) {
  return ctx.db.transaction(() => {
    const version = ownedVersion(ctx, versionId);
    const preview = previewVersionExecutionPlan(ctx, version.id);
    return { preview, saved_review: publicReview(selectedReview(ctx, version, preview), preview, ctx, version) };
  })();
}

function saveExecutionPlanReview(ctx, versionId, input) {
  return ctx.db.transaction(() => {
    const version = ownedVersion(ctx, versionId);
    if (!object(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'expected_plan_hash')
      || !sha(input.expected_plan_hash)) fail('EXECUTION_PLAN_REVIEW_INPUT_INVALID');
    // Re-check inside the write transaction even for duplicate submissions.
    const preview = previewVersionExecutionPlan(ctx, version.id);
    if (preview.status !== 'ready') fail('EXECUTION_PLAN_BLOCKED');
    if (preview.plan_hash !== input.expected_plan_hash) fail('EXECUTION_PLAN_CONFLICT');
    const saved = publicReview(selectedReview(ctx, version, preview), preview, ctx, version);
    if (saved?.status === 'invalid') fail('EXECUTION_PLAN_REVIEW_INVALID');
    if (saved?.status === 'current') return { preview, saved_review: saved };
    const row = { tenant_id: ctx.tenantId, user_id: ctx.userId, work_id: version.work_id,
      version_id: version.id, plan_hash: preview.plan_hash, plan_json: JSON.stringify(preview), created_at: new Date().toISOString() };
    if (!validPlan(preview, row, ctx, version)) fail('EXECUTION_PLAN_REVIEW_INVALID');
    const result = ctx.db.prepare(`INSERT INTO redraw_execution_plan_reviews
      (tenant_id, user_id, work_id, version_id, plan_hash, plan_json, created_at)
      VALUES (@tenant_id, @user_id, @work_id, @version_id, @plan_hash, @plan_json, @created_at)`).run(row);
    return { preview, saved_review: publicReview({ ...row, id: Number(result.lastInsertRowid) }, preview, ctx, version) };
  }).immediate();
}

module.exports = { getExecutionPlanReview, saveExecutionPlanReview, validateSavedPlan: validPlan };
