'use strict';

const crypto = require('node:crypto');

const { evaluateAutomationDecision, requiredAnalysisConfidenceKeys } = require('./redrawAutomationPolicyService');
const { prepareReferenceCleanRequirement } = require('./redrawAssetService');
const { buildCharacterPlan } = require('./redrawCharacterPlanService');
const {
  preparationEvidenceHash,
  readCurrentCleanResultEvidence,
} = require('./redrawPreparationGateService');
const {
  buildTrustedReferenceBundleInput,
  canonicalBundleHash,
  loadReviewedReferenceCoverage,
  REFERENCE_BUNDLE_SCHEMA_VERSION,
  saveReferenceBundle: defaultSaveReferenceBundle,
} = require('./redrawReferenceBundleService');
const { appendWorkflowEvent } = require('./redrawWorkflowEventService');
const taskService = require('./taskService');

const TASK_TYPE = 'redraw_reference_preparation';
const HEX_64 = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._:-]{1,160}$/;
const TERMINAL_SUCCESS = new Set(['completed', 'complete', 'succeeded', 'success', 'done']);
const TERMINAL_FAILURE = new Set(['failed', 'error', 'rejected']);
const UNKNOWN = new Set(['unknown', 'needs_attention', 'submission_unknown']);

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
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
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function parseObject(value, fallback = null) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function trim(value) {
  return String(value ?? '').trim();
}

function normalizeContext(ctx = {}, input = {}) {
  if (!ctx.db || typeof ctx.db.prepare !== 'function') {
    throw codedError('REDRAW_REFERENCE_PREPARATION_DB_REQUIRED', '缺少数据库');
  }
  const tenantId = trim(ctx.tenantId ?? ctx.tenant_id);
  const userId = trim(ctx.userId ?? ctx.user_id);
  const contextVersionId = Number(ctx.versionId ?? ctx.version_id);
  const inputVersionId = Number(input.version_id ?? input.versionId ?? contextVersionId);
  if (!tenantId || !userId || !Number.isSafeInteger(inputVersionId) || inputVersionId <= 0
    || (Number.isSafeInteger(contextVersionId) && contextVersionId > 0 && contextVersionId !== inputVersionId)) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_CONTEXT_INVALID', '缺少或冲突的 owner/版本');
  }
  return { ...ctx, db: ctx.db, tenantId, userId, versionId: inputVersionId };
}

function normalizeShotIds(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_SHOTS_INVALID', '镜头集合不合法');
  }
  const ids = value.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_SHOTS_INVALID', '镜头集合不合法');
  }
  return ids.sort((left, right) => left - right);
}

function normalizeIdempotencyKey(input = {}) {
  const value = trim(input.idempotency_key ?? input.idempotencyKey);
  if (!value || value.length > 160) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_IDEMPOTENCY_REQUIRED', '缺少准备幂等键');
  }
  return value;
}

function timestamp(ctx, previous) {
  const supplied = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const candidate = Date.parse(String(supplied || ''));
  const prior = Date.parse(String(previous || ''));
  if (Number.isFinite(candidate) && (!Number.isFinite(prior) || candidate > prior)) return new Date(candidate).toISOString();
  return new Date((Number.isFinite(prior) ? prior : Date.now()) + 1).toISOString();
}

function readScope(ctx) {
  const scope = ctx.db.prepare(`
    SELECT v.*, w.project_id, w.source_fingerprint,
           p.execution_mode, p.budget_limit_credits, p.max_auto_attempts_per_shot,
           p.policy_version, p.automation_policy_json,
           p.updated_at AS project_updated_at
    FROM redraw_versions v
    JOIN redraw_works w
      ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
      AND w.deleted_at IS NULL
    JOIN redraw_projects p
      ON p.id = w.project_id AND p.tenant_id = v.tenant_id AND p.user_id = v.user_id
      AND p.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
  `).get(ctx.versionId, ctx.tenantId, ctx.userId);
  if (!scope) throw codedError('REDRAW_REFERENCE_PREPARATION_VERSION_NOT_FOUND', '本地化版本不存在');
  return scope;
}

function readShots(ctx) {
  return ctx.db.prepare(`
    SELECT * FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(ctx.versionId, ctx.tenantId, ctx.userId);
}

function currentCharacterPlan(ctx, deps) {
  const plan = (typeof deps.getCharacterPlan === 'function' ? deps.getCharacterPlan : buildCharacterPlan)(ctx, ctx.versionId);
  if (!plan || plan.ready !== true || Number(plan.version_id) !== ctx.versionId || !HEX_64.test(trim(plan.plan_hash))) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_CHARACTER_PLAN_NOT_READY', '整集角色计划未就绪');
  }
  return plan;
}

function confidenceSnapshot(scope) {
  const facts = parseObject(scope.source_facts_json, {});
  const shots = Array.isArray(facts.shots) ? facts.shots : [];
  const result = {};
  for (const key of requiredAnalysisConfidenceKeys) {
    const values = shots.map((shot) => Number(shot?.confidence?.[key])).filter(Number.isFinite);
    if (shots.length > 0 && values.length === shots.length) result[key] = Math.min(...values);
  }
  return result;
}

function automationDecision(scope, coverage) {
  const policy = parseObject(scope.automation_policy_json, {});
  return evaluateAutomationDecision({
    execution_mode: trim(scope.execution_mode) || 'safe',
    gates: {
      media: Boolean(scope.source_fingerprint),
      timeline: coverage.status === 'approved',
      facts: Boolean(parseObject(scope.source_facts_json, null)) && HEX_64.test(trim(scope.facts_hash)),
    },
    confidence: confidenceSnapshot(scope),
    thresholds: parseObject(policy.analysis_confidence_thresholds, {}),
    budget_configured: scope.budget_limit_credits != null,
  });
}

function assertRequirements(value) {
  if (!Array.isArray(value)) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_INVALID', '全帧审核缺少净景要求');
  }
  const seen = new Set();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_INVALID', '净景要求不合法');
    }
    const kind = trim(raw.kind);
    const key = trim(raw.key);
    if (!['person_clean', 'text_clean'].includes(kind) || !SAFE_SEGMENT.test(key) || seen.has(`${kind}:${key}`)) {
      throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_INVALID', '净景要求不合法');
    }
    seen.add(`${kind}:${key}`);
    return { ...raw, kind, key };
  }).sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));
}

async function reviewedCoverage(ctx, shots, deps, scope) {
  const injected = typeof deps.getReviewedCoverage === 'function';
  let coverage;
  try {
    coverage = injected
      ? await deps.getReviewedCoverage({ ctx, version_id: ctx.versionId, shots })
      : await loadReviewedReferenceCoverage(ctx);
  } catch (error) {
    if (injected) throw error;
    throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_NOT_APPROVED', '全帧覆盖尚未审核');
  }
  if (!coverage || coverage.status !== 'approved' || !Array.isArray(coverage.shots)) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_NOT_APPROVED', '全帧覆盖尚未审核');
  }
  const byId = new Map();
  for (const raw of coverage.shots) {
    const id = Number(raw?.shot_id);
    if (!Number.isSafeInteger(id) || id <= 0 || byId.has(id)) {
      throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_INVALID', '全帧审核镜头集合不合法');
    }
    byId.set(id, { ...raw, shot_id: id, requirements: assertRequirements(raw.requirements) });
  }
  const expected = shots.map((shot) => Number(shot.id)).sort((left, right) => left - right);
  const actual = [...byId.keys()].sort((left, right) => left - right);
  if (stableJson(expected) !== stableJson(actual)) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_INVALID', '全帧审核未覆盖当前版本全部镜头');
  }
  const binding = coverage.coverage_binding;
  if (!binding || binding.schema_version !== 'redraw-coverage-preparation-binding-v1'
    || Number(binding.version_id) !== ctx.versionId
    || !HEX_64.test(trim(binding.analysis_sha256))
    || !trim(binding.approved_by) || !trim(binding.approved_at)
    || !HEX_64.test(trim(binding.facts_hash)) || !HEX_64.test(trim(binding.source_fingerprint))
    || binding.facts_hash !== scope?.facts_hash || binding.source_fingerprint !== scope?.source_fingerprint
    || !Array.isArray(binding.shots)) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_INVALID', '全帧审核绑定不合法');
  }
  const bindingById = new Map();
  for (const item of binding.shots) {
    const id = Number(item?.shot_id);
    const keys = Array.isArray(item?.requirement_keys) ? [...item.requirement_keys].map(trim).sort() : null;
    if (!Number.isSafeInteger(id) || id <= 0 || bindingById.has(id) || !keys
      || keys.some((key) => !/^(person_clean|text_clean):[A-Za-z0-9._:-]{1,160}$/.test(key))
      || new Set(keys).size !== keys.length || item.requirement_hash !== sha256(keys)) {
      throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_INVALID', '全帧审核绑定不合法');
    }
    bindingById.set(id, { requirement_keys: keys, requirement_hash: item.requirement_hash });
  }
  if (stableJson([...bindingById.keys()].sort((a, b) => a - b)) !== stableJson(actual)) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_INVALID', '全帧审核绑定未覆盖全部镜头');
  }
  for (const [id, descriptor] of byId) {
    const keys = descriptor.requirements.map((item) => `${item.kind}:${item.key}`).sort();
    const shotBinding = bindingById.get(id);
    if (stableJson(keys) !== stableJson(shotBinding.requirement_keys)) {
      throw codedError('REDRAW_REFERENCE_PREPARATION_COVERAGE_INVALID', '全帧审核要求绑定不一致');
    }
    descriptor.coverage_binding = {
      analysis_sha256: binding.analysis_sha256,
      approved_by: binding.approved_by,
      approved_at: binding.approved_at,
      facts_hash: binding.facts_hash,
      source_fingerprint: binding.source_fingerprint,
      ...shotBinding,
    };
  }
  return { ...coverage, shots: actual.map((id) => byId.get(id)), byId };
}

function parseBundle(row) {
  const bundle = parseObject(row.reference_bundle_json, null);
  if (!bundle || bundle.schema_version !== REFERENCE_BUNDLE_SCHEMA_VERSION) return null;
  if (!HEX_64.test(trim(row.reference_bundle_hash)) || canonicalBundleHash(bundle) !== row.reference_bundle_hash) return null;
  return bundle;
}

function currentCoverageBinding(snapshot, descriptor) {
  const binding = descriptor?.coverage_binding;
  return snapshot?.schema_version === 'redraw-reference-preparation-v2'
    && snapshot.coverage_analysis_sha256 === binding?.analysis_sha256
    && snapshot.coverage_approved_by === binding?.approved_by
    && snapshot.coverage_approved_at === binding?.approved_at
    && snapshot.coverage_facts_hash === binding?.facts_hash
    && snapshot.coverage_source_fingerprint === binding?.source_fingerprint
    && stableJson(snapshot.coverage_requirement_keys) === stableJson(binding?.requirement_keys)
    && snapshot.coverage_requirement_hash === binding?.requirement_hash;
}

function isCurrentReady(row, characterPlanHash, descriptor) {
  if (row.preparation_state !== 'reference_ready' || !parseBundle(row)) return false;
  const snapshot = parseObject(row.preparation_snapshot_json, null);
  if (!snapshot
    || Number(snapshot.version_id) !== Number(row.version_id)
    || Number(snapshot.shot_id) !== Number(row.id)
    || Number(snapshot.preparation_version) !== Number(row.preparation_version)
    || snapshot.character_plan_hash !== characterPlanHash
    || snapshot.reference_bundle_hash !== row.reference_bundle_hash
    || snapshot.status !== 'completed'
    || !currentCoverageBinding(snapshot, descriptor)) return false;
  return row.preparation_evidence_hash === preparationEvidenceHash(row);
}

function snapshotStatus(row) {
  return parseObject(row.preparation_snapshot_json, {})?.status || '';
}

async function reusableCleanResults(ctx, row, descriptor, expectedBaseline, characterPlanHash, deps) {
  const snapshot = parseObject(row.preparation_snapshot_json, {});
  if (Number(snapshot.version_id) !== ctx.versionId
    || Number(snapshot.shot_id) !== Number(row.id)
    || Number(snapshot.preparation_version) !== Number(row.preparation_version)
    || snapshot.character_plan_hash !== characterPlanHash
    || !currentCoverageBinding(snapshot, descriptor)
    || stableJson(snapshot.requirements) !== stableJson(descriptor.requirements.map((item) => ({ kind: item.kind, key: item.key })))
    || !Array.isArray(snapshot.clean_results)) return [];
  const reusable = [];
  for (const result of snapshot.clean_results) {
    const requirement = descriptor.requirements.find((item) => item.kind === result?.kind && item.key === result?.key);
    const assetId = Number(result?.redraw_asset_id);
    if (!requirement || !['completed', 'unknown'].includes(result?.status)
      || !Number.isSafeInteger(assetId) || assetId <= 0) continue;
    let current;
    if (typeof deps.isCleanResultCurrent === 'function') {
      current = result.status === 'completed'
        ? await deps.isCleanResultCurrent({ ctx, shot: row, requirement, result })
        : false;
    } else if (requirement.kind === 'person_clean') {
      current = readCurrentCleanResultEvidence(ctx, row, requirement, assetId);
    } else if (result.status === 'unknown') {
      current = readCurrentCleanResultEvidence(ctx, row, requirement, assetId);
    } else {
      current = Boolean(ctx.db.prepare(`
        SELECT id FROM redraw_assets
        WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
          AND kind = 'scene' AND status = 'generated' AND approval_status = 'approved'
          AND clean_plate_asset_id IS NOT NULL AND deleted_at IS NULL
      `).get(assetId, ctx.versionId, ctx.tenantId, ctx.userId));
    }
    if (current === true || (current && typeof current === 'object')) {
      reusable.push(safeResult({ ...result, status: 'completed', ...(current === true ? {} : { evidence: current }) }, requirement));
    }
  }
  if (snapshot.version_snapshot_hash !== expectedBaseline.snapshot_hash) {
    const priorVersionTime = Date.parse(String(snapshot.version_updated_at || ''));
    const approvalTimes = reusable.map((result) => Date.parse(String(result.evidence?.approved_at || '')));
    const approvalRefresh = snapshot.version_recovery_hash === expectedBaseline.recovery_hash
      && reusable.length > 0
      && Number.isFinite(priorVersionTime)
      && approvalTimes.every((value) => Number.isFinite(value) && value >= priorVersionTime)
      && approvalTimes.some((value) => value > priorVersionTime)
      && Math.max(...approvalTimes) === Date.parse(String(expectedBaseline.version_updated_at || ''));
    if (!approvalRefresh) return [];
  }
  return reusable.sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));
}

function baseline(scope, characterPlanHash, coverage) {
  const value = {
    version_id: Number(scope.id),
    version_updated_at: scope.updated_at,
    facts_hash: scope.facts_hash,
    project_id: Number(scope.project_id),
    project_policy_version: Number(scope.policy_version),
    project_updated_at: scope.project_updated_at,
    character_plan_hash: characterPlanHash,
    coverage_hash: sha256({ status: coverage.status, shots: coverage.shots }),
  };
  const recovery = {
    version_id: value.version_id,
    facts_hash: value.facts_hash,
    project_id: value.project_id,
    project_policy_version: value.project_policy_version,
    project_updated_at: value.project_updated_at,
    character_plan_hash: value.character_plan_hash,
    coverage_hash: value.coverage_hash,
  };
  return { ...value, snapshot_hash: sha256(value), recovery_hash: sha256(recovery) };
}

function selectShots(shots, shotIds) {
  if (!shotIds) return shots;
  const allowed = new Set(shots.map((shot) => Number(shot.id)));
  if (shotIds.some((id) => !allowed.has(id))) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_SHOTS_INVALID', '镜头不属于当前版本');
  }
  const selected = new Set(shotIds);
  return shots.filter((shot) => selected.has(Number(shot.id)));
}

async function buildQuote(rawCtx, input = {}, deps = {}) {
  const ctx = normalizeContext(rawCtx, input);
  const scope = readScope(ctx);
  const shots = readShots(ctx);
  if (shots.length === 0) throw codedError('REDRAW_REFERENCE_PREPARATION_SHOTS_REQUIRED', '当前版本没有镜头');
  const shotIds = normalizeShotIds(input.shot_ids ?? input.shotIds);
  const selected = selectShots(shots, shotIds);
  const plan = await currentCharacterPlan(ctx, deps);
  const coverage = await reviewedCoverage(ctx, shots, deps, scope);
  const decision = automationDecision(scope, coverage);
  const snapshot = baseline(scope, plan.plan_hash, coverage);
  const reused = [];
  const needsAttention = [];
  const missing = [];
  const items = [];
  const reusableByShot = new Map();
  let credits = 0;
  let priced = true;
  for (const shot of selected) {
    const descriptor = coverage.byId.get(Number(shot.id));
    if (isCurrentReady(shot, plan.plan_hash, descriptor)) {
      reused.push(Number(shot.id));
      continue;
    }
    const reusable = await reusableCleanResults(ctx, shot, descriptor, snapshot, plan.plan_hash, deps);
    reusableByShot.set(Number(shot.id), reusable);
    const reusableKeys = new Set(reusable.map((item) => `${item.kind}:${item.key}`));
    const previous = parseObject(shot.preparation_snapshot_json, {});
    const unresolvedKeys = Array.isArray(previous.clean_results)
      ? previous.clean_results
        .filter((item) => ['unknown', 'needs_attention'].includes(item?.status))
        .map((item) => `${item.kind}:${item.key}`)
      : [];
    const attentionResolved = unresolvedKeys.length > 0
      && unresolvedKeys.every((key) => reusableKeys.has(key));
    if ((shot.preparation_state === 'needs_attention'
      || ['unknown', 'needs_attention', 'processing'].includes(snapshotStatus(shot)))
      && !attentionResolved) {
      needsAttention.push(Number(shot.id));
      continue;
    }
    missing.push(Number(shot.id));
    for (const requirement of descriptor.requirements) {
      if (reusableKeys.has(`${requirement.kind}:${requirement.key}`)) continue;
      const quote = typeof deps.quoteCleanRequirement === 'function'
        ? await deps.quoteCleanRequirement({ ctx, scope, shot, coverage_shot: descriptor, requirement })
        : { priced: false, credits: 0 };
      const amount = Number(quote?.credits);
      if (quote?.priced !== true || !Number.isSafeInteger(amount) || amount < 0) priced = false;
      else credits += amount;
      items.push({
        shot_id: Number(shot.id),
        kind: requirement.kind,
        key: requirement.key,
        priced: quote?.priced === true && Number.isSafeInteger(amount) && amount >= 0,
        credits: quote?.priced === true && Number.isSafeInteger(amount) && amount >= 0 ? amount : null,
      });
    }
  }
  const unpriced = items.length > 0 && !priced;
  const quoteBody = {
    schema_version: 'redraw-reference-preparation-quote-v1',
    version_id: ctx.versionId,
    version_snapshot_hash: snapshot.snapshot_hash,
    character_plan_hash: plan.plan_hash,
    execution_mode: scope.execution_mode,
    effective_mode: decision.effective_mode,
    action: unpriced ? 'blocked' : decision.action,
    reason_codes: unpriced
      ? [...new Set([...decision.reason_codes, 'reference_cost_unpriced'])].sort()
      : [...decision.reason_codes],
    selected_shot_ids: selected.map((shot) => Number(shot.id)),
    missing_shot_ids: missing,
    reused_shot_ids: reused,
    needs_attention_shot_ids: needsAttention,
    items,
    priced,
    credits: priced ? credits : null,
  };
  return {
    ctx,
    scope,
    shots,
    selected,
    plan,
    coverage,
    baseline: snapshot,
    reusableByShot,
    quote: {
      ...quoteBody,
      confirmation_required: decision.action === 'needs_review',
      quote_hash: sha256(quoteBody),
    },
  };
}

async function quoteVersionPreparation(ctx, input = {}, deps = {}) {
  return (await buildQuote(ctx, input, deps)).quote;
}

async function assertBaselineCurrent(ctx, expected, deps) {
  const scope = readScope(ctx);
  const plan = currentCharacterPlan(ctx, deps);
  const coverage = await reviewedCoverage(ctx, readShots(ctx), deps, scope);
  const current = {
    version_id: Number(scope.id),
    version_updated_at: scope.updated_at,
    facts_hash: scope.facts_hash,
    project_id: Number(scope.project_id),
    project_policy_version: Number(scope.policy_version),
    project_updated_at: scope.project_updated_at,
    character_plan_hash: plan.plan_hash,
    coverage_hash: sha256({ status: coverage.status, shots: coverage.shots }),
  };
  if (sha256(current) !== expected.snapshot_hash) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_DRIFT', '准备期间上游版本已变化');
  }
  return { scope, plan };
}

function requestHash(ctx, idempotencyKey, quote) {
  return sha256({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    version_id: ctx.versionId,
    idempotency_key_hash: sha256(idempotencyKey),
    quote_hash: quote.quote_hash,
    selected_shot_ids: quote.selected_shot_ids,
  });
}

function claimShot(ctx, shot, descriptor, baselineSnapshot, characterPlanHash, request, idempotencyKey, reusable = []) {
  const previous = parseObject(shot.preparation_snapshot_json, {});
  const idemHash = sha256(idempotencyKey);
  const unresolvedKeys = Array.isArray(previous.clean_results)
    ? previous.clean_results
      .filter((item) => ['unknown', 'needs_attention'].includes(item?.status))
      .map((item) => `${item.kind}:${item.key}`)
    : [];
  const reusableKeys = new Set(reusable.map((item) => `${item.kind}:${item.key}`));
  const attentionResolved = unresolvedKeys.length > 0
    && unresolvedKeys.every((key) => reusableKeys.has(key));
  if ((shot.preparation_state === 'needs_attention'
    || ['unknown', 'needs_attention', 'processing'].includes(previous.status)) && !attentionResolved) {
    return { status: 'needs_attention' };
  }
  if (shot.preparation_state === 'failed' && previous.status === 'failed'
    && previous.idempotency_key_hash === idemHash) return { status: 'failed' };
  const now = timestamp(ctx, shot.updated_at);
  const snapshot = {
    schema_version: 'redraw-reference-preparation-v2',
    version_id: ctx.versionId,
    shot_id: Number(shot.id),
    preparation_version: Number(shot.preparation_version),
    character_plan_hash: characterPlanHash,
    version_snapshot_hash: baselineSnapshot.snapshot_hash,
    version_recovery_hash: baselineSnapshot.recovery_hash,
    version_updated_at: baselineSnapshot.version_updated_at,
    coverage_analysis_sha256: descriptor.coverage_binding.analysis_sha256,
    coverage_approved_by: descriptor.coverage_binding.approved_by,
    coverage_approved_at: descriptor.coverage_binding.approved_at,
    coverage_facts_hash: descriptor.coverage_binding.facts_hash,
    coverage_source_fingerprint: descriptor.coverage_binding.source_fingerprint,
    coverage_requirement_keys: descriptor.coverage_binding.requirement_keys,
    coverage_requirement_hash: descriptor.coverage_binding.requirement_hash,
    request_hash: request,
    idempotency_key_hash: idemHash,
    status: 'processing',
    requirements: descriptor.requirements.map((item) => ({ kind: item.kind, key: item.key })),
    clean_results: reusable,
  };
  const updated = ctx.db.prepare(`
    UPDATE redraw_shots
    SET preparation_state = 'clean_ready', preparation_snapshot_json = ?,
        preparation_evidence_hash = ?, stale_reason_code = NULL, updated_at = ?
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
      AND updated_at = ? AND deleted_at IS NULL
  `).run(
    stableJson(snapshot), sha256(snapshot), now, Number(shot.id), ctx.versionId,
    ctx.tenantId, ctx.userId, shot.updated_at,
  );
  if (updated.changes !== 1) return { status: 'needs_attention' };
  return { status: 'claimed', row: { ...shot, updated_at: now }, snapshot };
}

function providerIdentity(value = {}) {
  const providerTaskId = trim(value.provider_task_id ?? value.providerTaskId ?? value.task_id ?? value.taskId);
  const reservationId = trim(value.reservation_id ?? value.reservationId);
  return {
    ...(SAFE_SEGMENT.test(providerTaskId) ? { provider_task_id: providerTaskId } : {}),
    ...(SAFE_SEGMENT.test(reservationId) ? { reservation_id: reservationId } : {}),
  };
}

function normalizeOutcome(value) {
  const status = trim(value?.status).toLowerCase();
  if (TERMINAL_SUCCESS.has(status)) {
    const assetId = Number(value.redraw_asset_id ?? value.redrawAssetId ?? value.asset_id ?? value.assetId);
    if (Number.isSafeInteger(assetId) && assetId > 0) return { status: 'completed', redraw_asset_id: assetId, ...providerIdentity(value) };
    return { status: 'failed', error_code: 'REDRAW_REFERENCE_PREPARATION_ASSET_INVALID' };
  }
  if (UNKNOWN.has(status)) {
    const assetId = Number(value.redraw_asset_id ?? value.redrawAssetId ?? value.asset_id ?? value.assetId);
    return {
      status: 'unknown',
      ...(Number.isSafeInteger(assetId) && assetId > 0 ? { redraw_asset_id: assetId } : {}),
      ...providerIdentity(value),
    };
  }
  if (TERMINAL_FAILURE.has(status)) {
    return { status: 'failed', error_code: trim(value.error_code ?? value.errorCode) || 'REDRAW_REFERENCE_PREPARATION_CLEAN_FAILED' };
  }
  return { status: 'unknown', ...providerIdentity(value) };
}

function unknownError(error) {
  const code = trim(error?.code).toUpperCase();
  return error?.unknown === true || code.includes('UNKNOWN') || code.includes('TIMEOUT');
}

function persistShotSnapshot(ctx, shotId, expectedUpdatedAt, state, snapshot, reasonCode = null) {
  const now = timestamp(ctx, expectedUpdatedAt);
  const changed = ctx.db.prepare(`
    UPDATE redraw_shots
    SET preparation_state = ?, preparation_snapshot_json = ?, preparation_evidence_hash = ?,
        stale_reason_code = ?, updated_at = ?
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
      AND updated_at = ? AND deleted_at IS NULL
  `).run(
    state, stableJson(snapshot), sha256(snapshot), reasonCode, now,
    shotId, ctx.versionId, ctx.tenantId, ctx.userId, expectedUpdatedAt,
  );
  if (changed.changes !== 1) throw codedError('REDRAW_REFERENCE_PREPARATION_CONFLICT', '镜头准备状态已被其他操作更新');
  return now;
}

function safeResult(result, requirement) {
  return {
    kind: requirement.kind,
    key: requirement.key,
    status: result.status,
    ...(result.redraw_asset_id ? { redraw_asset_id: result.redraw_asset_id } : {}),
    ...providerIdentity(result),
    ...(result.error_code ? { error_code: result.error_code } : {}),
    ...(result.evidence && typeof result.evidence === 'object' && !Array.isArray(result.evidence)
      ? { evidence: result.evidence }
      : {}),
  };
}

async function executeShot(ctx, built, shot, descriptor, idempotencyKey, deps) {
  const request = requestHash(ctx, idempotencyKey, built.quote);
  const claim = claimShot(
    ctx,
    shot,
    descriptor,
    built.baseline,
    built.plan.plan_hash,
    request,
    idempotencyKey,
    built.reusableByShot.get(Number(shot.id)) || [],
  );
  if (claim.status !== 'claimed') return claim.status;
  let currentUpdatedAt = claim.row.updated_at;
  const snapshot = claim.snapshot;
  const completedKeys = new Set(snapshot.clean_results.map((item) => `${item.kind}:${item.key}`));
  for (const requirement of descriptor.requirements) {
    if (completedKeys.has(`${requirement.kind}:${requirement.key}`)) continue;
    const operationKey = [
      'redraw-reference-clean', ctx.tenantId, ctx.userId, ctx.versionId, shot.id,
      shot.preparation_version, requirement.kind, requirement.key, sha256(idempotencyKey),
    ].join(':');
    let outcome;
    try {
      const payload = {
        ctx,
        scope: built.scope,
        shot,
        coverage_shot: descriptor,
        requirement,
        operation_key: operationKey,
        idempotency_key: idempotencyKey,
        provider: deps.provider || ctx.provider,
      };
      const rawOutcome = typeof deps.prepareCleanRequirement === 'function'
        ? await deps.prepareCleanRequirement(payload)
        : await prepareReferenceCleanRequirement({
            ...ctx,
            provider: deps.provider || ctx.provider,
          }, payload);
      outcome = normalizeOutcome(rawOutcome);
    } catch (error) {
      outcome = unknownError(error)
        ? { status: 'unknown', ...providerIdentity(error) }
        : { status: 'failed', error_code: trim(error?.code) || 'REDRAW_REFERENCE_PREPARATION_CLEAN_FAILED' };
    }
    snapshot.clean_results.push(safeResult(outcome, requirement));
    if (outcome.status === 'unknown') {
      snapshot.status = 'unknown';
      Object.assign(snapshot, providerIdentity(outcome));
      persistShotSnapshot(ctx, shot.id, currentUpdatedAt, 'needs_attention', snapshot, 'clean_plate_status_unknown');
      return 'needs_attention';
    }
    if (outcome.status === 'failed') {
      snapshot.status = 'failed';
      snapshot.error_code = outcome.error_code;
      persistShotSnapshot(ctx, shot.id, currentUpdatedAt, 'failed', snapshot, outcome.error_code.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64));
      return 'failed';
    }
    currentUpdatedAt = persistShotSnapshot(ctx, shot.id, currentUpdatedAt, 'clean_ready', snapshot);
  }
  try {
    await assertBaselineCurrent(ctx, built.baseline, deps);
  } catch (error) {
    snapshot.status = 'needs_attention';
    snapshot.error_code = 'REDRAW_REFERENCE_PREPARATION_DRIFT';
    persistShotSnapshot(ctx, shot.id, currentUpdatedAt, 'needs_attention', snapshot, 'upstream_version_drift');
    throw error;
  }
  const bundleInput = typeof deps.buildReferenceBundleInput === 'function'
    ? await deps.buildReferenceBundleInput({
        ctx,
        scope: built.scope,
        shot,
        coverage_shot: descriptor,
        clean_results: snapshot.clean_results,
      })
    : await buildTrustedReferenceBundleInput(ctx, {
        shot_id: Number(shot.id),
        clean_results: snapshot.clean_results,
      });
  if (!bundleInput || typeof bundleInput !== 'object' || Array.isArray(bundleInput)) {
    snapshot.status = 'failed';
    snapshot.error_code = 'REDRAW_REFERENCE_PREPARATION_BUNDLE_INPUT_REQUIRED';
    persistShotSnapshot(ctx, shot.id, currentUpdatedAt, 'failed', snapshot, 'reference_bundle_input_missing');
    return 'failed';
  }
  const saveBundle = typeof deps.saveReferenceBundle === 'function' ? deps.saveReferenceBundle : defaultSaveReferenceBundle;
  const saved = await saveBundle(ctx, {
    ...bundleInput,
    shot_id: Number(shot.id),
    expected_updated_at: currentUpdatedAt,
  });
  if (!saved || Number(saved.shot_id) !== Number(shot.id) || !HEX_64.test(trim(saved.reference_bundle_hash))) {
    snapshot.status = 'failed';
    snapshot.error_code = 'REDRAW_REFERENCE_PREPARATION_BUNDLE_INVALID';
    const current = ctx.db.prepare('SELECT updated_at FROM redraw_shots WHERE id = ?').get(Number(shot.id));
    persistShotSnapshot(ctx, shot.id, current?.updated_at || currentUpdatedAt, 'failed', snapshot, 'reference_bundle_invalid');
    return 'failed';
  }
  const current = ctx.db.prepare(`
    SELECT * FROM redraw_shots
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(shot.id), ctx.versionId, ctx.tenantId, ctx.userId);
  if (!current || current.reference_bundle_hash !== saved.reference_bundle_hash || !parseBundle(current)) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_BUNDLE_INVALID', '参考包保存证据不一致');
  }
  const completedAt = timestamp(ctx, current.updated_at);
  const completedSnapshot = {
    ...snapshot,
    status: 'completed',
    reference_bundle_hash: saved.reference_bundle_hash,
  };
  delete completedSnapshot.error_code;
  const projected = {
    ...current,
    reference_bundle_hash: saved.reference_bundle_hash,
    preparation_snapshot_json: stableJson(completedSnapshot),
  };
  const evidence = preparationEvidenceHash(projected);
  ctx.db.transaction(() => {
    const updated = ctx.db.prepare(`
      UPDATE redraw_shots
      SET preparation_state = 'reference_ready', preparation_snapshot_json = ?,
          preparation_evidence_hash = ?, stale_reason_code = NULL, updated_at = ?
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
        AND updated_at = ? AND reference_bundle_hash = ? AND deleted_at IS NULL
    `).run(
      stableJson(completedSnapshot), evidence, completedAt, Number(shot.id), ctx.versionId,
      ctx.tenantId, ctx.userId, current.updated_at, saved.reference_bundle_hash,
    );
    if (updated.changes !== 1) throw codedError('REDRAW_REFERENCE_PREPARATION_CONFLICT', '镜头准备收口冲突');
    appendWorkflowEvent(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      projectId: Number(built.scope.project_id),
      resourceType: 'shot',
      resourceId: String(shot.id),
      fromState: shot.preparation_state || null,
      toState: 'reference_ready',
      reasonCode: 'reference_preparation_completed',
      evidenceHash: evidence,
      metadata: {
        preparation_version: Number(shot.preparation_version),
        requirement_keys: descriptor.requirements.map((item) => `${item.kind}:${item.key}`),
        reference_bundle_hash: saved.reference_bundle_hash,
        request_hash: request,
      },
      createdAt: completedAt,
    });
  }).immediate();
  return 'prepared';
}

async function prepareVersionReferences(rawCtx, input = {}, deps = {}) {
  const idempotencyKey = normalizeIdempotencyKey(input);
  const built = await buildQuote(rawCtx, input, deps);
  if (built.quote.action === 'blocked') {
    throw codedError('REDRAW_REFERENCE_PREPARATION_BLOCKED', '当前准备门禁已阻断', { quote: built.quote });
  }
  const submittedQuote = trim(input.quote_hash ?? input.quoteHash);
  if (built.quote.confirmation_required && !submittedQuote) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_CONFIRMATION_REQUIRED', '安全模式需要确认当次报价', { quote: built.quote });
  }
  if (submittedQuote && submittedQuote !== built.quote.quote_hash) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_QUOTE_MISMATCH', '准备报价已变化', { quote: built.quote });
  }
  const result = {
    version_id: built.ctx.versionId,
    quote_hash: built.quote.quote_hash,
    prepared_shot_ids: [],
    reused_shot_ids: [],
    failed_shot_ids: [],
    needs_attention_shot_ids: [],
  };
  for (const original of built.selected) {
    const shot = built.ctx.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(Number(original.id));
    const descriptor = built.coverage.byId.get(Number(shot.id));
    if (isCurrentReady(shot, built.plan.plan_hash, descriptor)) {
      result.reused_shot_ids.push(Number(shot.id));
      continue;
    }
    const status = await executeShot(
      built.ctx,
      built,
      shot,
      descriptor,
      idempotencyKey,
      deps,
    );
    if (status === 'prepared') result.prepared_shot_ids.push(Number(shot.id));
    else if (status === 'failed') result.failed_shot_ids.push(Number(shot.id));
    else result.needs_attention_shot_ids.push(Number(shot.id));
  }
  for (const key of ['prepared_shot_ids', 'reused_shot_ids', 'failed_shot_ids', 'needs_attention_shot_ids']) {
    result[key].sort((left, right) => left - right);
  }
  return result;
}

function taskResourceId(ctx, idempotencyKey) {
  return `${TASK_TYPE}:${ctx.versionId}:${sha256(`${ctx.tenantId}:${ctx.userId}:${ctx.versionId}:${idempotencyKey}`)}`;
}

function existingTask(ctx, resourceId) {
  return ctx.db.prepare(`
    SELECT * FROM async_tasks
    WHERE type = ? AND resource_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC LIMIT 1
  `).get(TASK_TYPE, resourceId, ctx.tenantId, ctx.userId);
}

function createOrReuseTask(ctx, idempotencyKey, quote) {
  const resourceId = taskResourceId(ctx, idempotencyKey);
  let selected;
  let created = false;
  ctx.db.transaction(() => {
    const existing = existingTask(ctx, resourceId);
    if (existing) {
      const metadata = parseObject(existing.metadata, {});
      if (metadata.quote_hash !== quote.quote_hash) {
        throw codedError('REDRAW_REFERENCE_PREPARATION_IDEMPOTENCY_CONFLICT', '幂等键已绑定其他准备报价');
      }
      selected = existing;
      return;
    }
    const task = taskService.createTask(ctx.db, ctx.log || { info() {}, warn() {}, error() {} }, TASK_TYPE, resourceId);
    const now = timestamp(ctx, task.updated_at);
    ctx.db.prepare(`
      UPDATE async_tasks
      SET tenant_id = ?, user_id = ?, status = 'pending', progress = 0,
          message = ?, metadata = ?, updated_at = ? WHERE id = ?
    `).run(
      ctx.tenantId,
      ctx.userId,
      '逐镜参考准备任务已创建',
      stableJson({ quote_hash: quote.quote_hash, version_snapshot_hash: quote.version_snapshot_hash }),
      now,
      task.id,
    );
    selected = taskService.getTask(ctx.db, task.id);
    created = true;
  }).immediate();
  return { task: selected, created };
}

function defaultSchedule(job) {
  return new Promise((resolve, reject) => {
    setImmediate(() => Promise.resolve().then(job).then(resolve, reject));
  });
}

function setTaskNeedsAttention(ctx, taskId, message) {
  const now = timestamp(ctx);
  ctx.db.prepare(`
    UPDATE async_tasks
    SET status = 'needs_attention', progress = CASE WHEN COALESCE(progress, 0) > 90 THEN progress ELSE 90 END,
        message = ?, error = ?, completed_at = NULL, updated_at = ? WHERE id = ?
  `).run(message, message, now, taskId);
}

function scheduleFailure() {
  return codedError('REDRAW_REFERENCE_PREPARATION_SCHEDULE_FAILED', '逐镜参考准备调度失败，状态需要人工确认');
}

async function startVersionPreparation(rawCtx, input = {}, deps = {}) {
  const ctx = normalizeContext(rawCtx, input);
  const idempotencyKey = normalizeIdempotencyKey(input);
  const quote = await quoteVersionPreparation(ctx, input, deps);
  const submittedQuote = trim(input.quote_hash ?? input.quoteHash);
  if (!submittedQuote || submittedQuote !== quote.quote_hash) {
    throw codedError('REDRAW_REFERENCE_PREPARATION_QUOTE_MISMATCH', '准备报价缺失或已变化', { quote });
  }
  if (quote.action === 'blocked') throw codedError('REDRAW_REFERENCE_PREPARATION_BLOCKED', '当前准备门禁已阻断', { quote });
  const { task, created } = createOrReuseTask(ctx, idempotencyKey, quote);
  if (!created) return { task_id: task.id, status: task.status, quote, completion: null };
  const schedule = typeof deps.schedule === 'function' ? deps.schedule : defaultSchedule;
  const job = async () => {
    ctx.db.prepare(`UPDATE async_tasks SET status = 'processing', progress = 10,
      message = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run('正在准备逐镜净景与参考包', timestamp(ctx), task.id);
    try {
      const result = await prepareVersionReferences(ctx, input, deps);
      if (result.needs_attention_shot_ids.length > 0) {
        setTaskNeedsAttention(ctx, task.id, '逐镜参考准备存在结果未知项，请人工确认');
      } else if (result.failed_shot_ids.length > 0) {
        taskService.updateTaskError(ctx.db, task.id, '逐镜参考准备存在明确失败镜头');
      } else {
        taskService.updateTaskResult(ctx.db, task.id, result);
      }
      return result;
    } catch (error) {
      if (error.code === 'REDRAW_REFERENCE_PREPARATION_DRIFT' || unknownError(error)) {
        setTaskNeedsAttention(ctx, task.id, '逐镜参考准备状态需要人工确认');
      } else {
        taskService.updateTaskError(ctx.db, task.id, '逐镜参考准备失败');
      }
      throw error;
    }
  };
  let scheduled;
  try {
    scheduled = schedule(job);
  } catch (_) {
    setTaskNeedsAttention(ctx, task.id, '逐镜参考准备调度失败，状态需要人工确认');
    const completion = taskService.trackInFlightTask(task.id, Promise.reject(scheduleFailure()));
    return { task_id: task.id, status: 'needs_attention', quote, completion };
  }
  const completion = taskService.trackInFlightTask(task.id, Promise.resolve(scheduled).catch((error) => {
    const current = taskService.getTask(ctx.db, task.id);
    if (current && ['pending', 'processing'].includes(current.status)) {
      setTaskNeedsAttention(ctx, task.id, '逐镜参考准备调度失败，状态需要人工确认');
      throw scheduleFailure();
    }
    throw error;
  }));
  return { task_id: task.id, status: 'pending', quote, completion };
}

function reconcileInterruptedPreparations(rawCtx = {}) {
  const ctx = normalizeContext(rawCtx, rawCtx);
  let tasks;
  try {
    tasks = ctx.db.prepare(`
      SELECT * FROM async_tasks
      WHERE type = ? AND tenant_id = ? AND user_id = ?
        AND status IN ('pending', 'processing') AND deleted_at IS NULL
    `).all(TASK_TYPE, ctx.tenantId, ctx.userId)
      .filter((task) => Number(String(task.resource_id || '').split(':')[1]) === ctx.versionId);
  } catch (error) {
    if (/no such (table|column)/i.test(trim(error?.message))) return { needs_attention: 0 };
    throw error;
  }
  if (tasks.length === 0) return { needs_attention: 0 };
  const now = timestamp(ctx);
  ctx.db.transaction(() => {
    for (const task of tasks) setTaskNeedsAttention({ ...ctx, now }, task.id, '服务中断后逐镜参考准备状态未知，请人工确认');
    const shots = readShots(ctx);
    for (const shot of shots) {
      const snapshot = parseObject(shot.preparation_snapshot_json, {});
      if (snapshot.status !== 'processing') continue;
      snapshot.status = 'needs_attention';
      snapshot.error_code = 'REDRAW_REFERENCE_PREPARATION_INTERRUPTED';
      ctx.db.prepare(`
        UPDATE redraw_shots
        SET preparation_state = 'needs_attention', preparation_snapshot_json = ?,
            preparation_evidence_hash = ?, stale_reason_code = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(
        stableJson(snapshot), sha256(snapshot), 'preparation_interrupted', now,
        Number(shot.id), shot.updated_at,
      );
    }
  }).immediate();
  return { needs_attention: tasks.length };
}

module.exports = {
  quoteVersionPreparation,
  startVersionPreparation,
  prepareVersionReferences,
  reconcileInterruptedPreparations,
};
