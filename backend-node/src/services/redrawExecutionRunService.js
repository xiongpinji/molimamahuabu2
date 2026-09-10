'use strict';

const { hashPlanValue } = require('./redrawExecutionPlanService');
const { getExecutionQueue, getExecutionQueueSnapshot } = require('./redrawExecutionQueueService');
const { randomBytes } = require('node:crypto');

const runStates = ['ready', 'running', 'waiting_review', 'paused', 'failed', 'needs_attention', 'stale', 'completed'];
const attemptStates = ['claimed', 'submitting', 'running', 'waiting_review', 'approved', 'rejected', 'failed', 'needs_attention'];
const activeStates = ['claimed', 'submitting', 'running'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const invalid = () => fail('EXECUTION_RUN_INVALID');
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function ownedVersion(ctx, versionId) {
  if (!ctx?.db || !positive(Number(versionId)) || !ctx.tenantId || !ctx.userId) fail('REDRAW_VERSION_NOT_FOUND');
  const version = ctx.db.prepare(`SELECT v.id, v.work_id FROM redraw_versions v
    JOIN redraw_works w ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL AND w.deleted_at IS NULL`)
    .get(Number(versionId), ctx.tenantId, ctx.userId);
  if (!version) fail('REDRAW_VERSION_NOT_FOUND');
  return version;
}

function ownedRun(ctx, version, runId) {
  if (!positive(Number(runId))) fail('EXECUTION_RUN_NOT_FOUND');
  const run = ctx.db.prepare(`SELECT * FROM redraw_execution_runs
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?`)
    .get(Number(runId), ctx.tenantId, ctx.userId, version.id);
  if (!run) fail('EXECUTION_RUN_NOT_FOUND');
  return run;
}

function outputParameters(run, plan) {
  if (run.output_parameters_json === null && run.output_parameters_hash === null) return null;
  let params;
  try { params = JSON.parse(run.output_parameters_json); } catch { invalid(); }
  if (!exact(params, ['resolution', 'aspect_ratio']) || !text(params.resolution) || !text(params.aspect_ratio)
    || !plan.capability.resolutions.includes(params.resolution) || !plan.capability.aspect_ratios.includes(params.aspect_ratio)
    || !sha(run.output_parameters_hash) || hashPlanValue(params) !== run.output_parameters_hash) invalid();
  return params;
}

function validateAttempt(attempt, run, queueUnits) {
  const unit = queueUnits.get(attempt.queue_unit_id);
  if (!positive(attempt.id) || attempt.run_id !== run.id || !unit || unit.queue_id !== run.queue_id
    || attempt.attempt_no !== 1 || attempt.unit_hash !== unit.unit_hash || !sha(attempt.unit_hash)
    || !attemptStates.includes(attempt.status) || !text(attempt.claim_token)
    || !sha(attempt.readiness_hash) || !sha(attempt.quote_hash) || !nonnegative(attempt.quoted_amount)
    || !['paid', 'no_charge'].includes(attempt.billing_mode)
    || (attempt.billing_mode === 'no_charge' && (attempt.quoted_amount !== 0 || attempt.reservation_id !== null))
    || (attempt.billing_mode === 'paid' && attempt.quoted_amount <= 0)
    || !['request_hash', 'output_sha256', 'candidate_hash'].every((key) => attempt[key] === null || sha(attempt[key]))
    || !['task_id', 'reservation_id', 'provider_task_id', 'approved_by'].every((key) => attempt[key] === null || text(attempt[key]))
    || !['approved_at', 'submit_started_at'].every((key) => attempt[key] === null || time(attempt[key]))
    || (attempt.output_asset_id !== null && !positive(attempt.output_asset_id))
    || !time(attempt.created_at) || !time(attempt.updated_at)) invalid();
  if (attempt.quality_json !== null) {
    try { JSON.parse(attempt.quality_json); } catch { invalid(); }
  }
}

function readRun(ctx, version, run) {
  if (!positive(run.id) || run.tenant_id !== ctx.tenantId || run.user_id !== ctx.userId
    || run.work_id !== version.work_id || run.version_id !== version.id
    || !positive(run.queue_id) || !positive(run.review_id) || !sha(run.plan_hash)
    || !runStates.includes(run.status) || ![0, 1].includes(run.pause_requested) || !nonnegative(run.revision)
    || !time(run.created_at) || !time(run.updated_at)) invalid();
  let state;
  try { state = getExecutionQueueSnapshot(ctx, version.id, run.queue_id); }
  catch (error) { if (error.code === 'EXECUTION_QUEUE_NOT_FOUND') invalid(); throw error; }
  const queue = state.queue;
  if (!queue || queue.status === 'invalid' || queue.plan_hash !== run.plan_hash) invalid();
  // The snapshot validator has already verified this exact historical review and its complete plan.
  const linked = ctx.db.prepare(`SELECT q.review_id, r.plan_json FROM redraw_execution_queues q
    JOIN redraw_execution_plan_reviews r ON r.id = q.review_id WHERE q.id = ?`).get(run.queue_id);
  if (!linked || linked.review_id !== run.review_id) invalid();
  const params = outputParameters(run, JSON.parse(linked.plan_json));
  const queueUnits = new Map(ctx.db.prepare(`SELECT id, queue_id, unit_id, unit_hash
    FROM redraw_execution_queue_units WHERE queue_id = ?`).all(run.queue_id).map((unit) => [unit.id, unit]));
  const attempts = ctx.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE run_id = ? ORDER BY id').all(run.id);
  if (attempts.length && params === null) invalid();
  const byUnit = new Map(); let active = 0; const tasks = new Set(); const reservations = new Set();
  for (const attempt of attempts) {
    validateAttempt(attempt, run, queueUnits);
    const unitId = queueUnits.get(attempt.queue_unit_id).unit_id;
    if (byUnit.has(unitId)) invalid();
    byUnit.set(unitId, attempt);
    if (activeStates.includes(attempt.status)) active += 1;
    if (active > 1 || (attempt.task_id !== null && tasks.has(attempt.task_id))
      || (attempt.reservation_id !== null && reservations.has(attempt.reservation_id))) invalid();
    if (attempt.task_id !== null) tasks.add(attempt.task_id);
    if (attempt.reservation_id !== null) reservations.add(attempt.reservation_id);
  }
  const binding = queue.status === 'waiting_readiness' ? 'current' : 'stale';
  return { id: run.id, work_id: run.work_id, version_id: run.version_id, queue_id: run.queue_id, review_id: run.review_id,
    plan_hash: run.plan_hash, status: run.status, binding_status: binding, pause_requested: run.pause_requested === 1,
    revision: run.revision, created_at: run.created_at, updated_at: run.updated_at, executable: false, output_parameters: params,
    units: queue.units.map((unit) => {
      const attempt = byUnit.get(unit.id);
      return { id: unit.id, ordinal: unit.ordinal, unit_hash: unit.unit_hash, status: attempt?.status || 'pending',
        attempts: attempt ? [{ id: attempt.id, attempt_no: attempt.attempt_no, status: attempt.status,
          created_at: attempt.created_at, updated_at: attempt.updated_at }] : [] };
    }),
    execution_blockers: [...queue.execution_blockers, 'EXECUTION_RUN_STORAGE_ONLY', ...(binding === 'stale' ? ['EXECUTION_RUN_STALE'] : [])] };
}

function createExecutionRun(ctx, versionId, input) {
  return ctx.db.transaction(() => {
    const version = ownedVersion(ctx, versionId);
    if (!exact(input, ['expected_plan_hash', 'expected_queue_id']) || !sha(input.expected_plan_hash)
      || !positive(input.expected_queue_id)) fail('EXECUTION_RUN_INPUT_INVALID');
    const current = getExecutionQueue(ctx, version.id);
    if (current.queue?.status === 'invalid' || current.saved_review?.status === 'invalid') invalid();
    if (current.preview.status !== 'ready' || current.saved_review?.status !== 'current'
      || current.queue?.status !== 'waiting_readiness' || current.queue.id !== input.expected_queue_id
      || current.queue.plan_hash !== input.expected_plan_hash || current.preview.plan_hash !== input.expected_plan_hash) fail('EXECUTION_RUN_CONFLICT');
    let run = ctx.db.prepare(`SELECT * FROM redraw_execution_runs WHERE tenant_id = ? AND user_id = ? AND queue_id = ?`)
      .get(ctx.tenantId, ctx.userId, current.queue.id);
    if (!run) {
      const now = new Date().toISOString();
      const inserted = ctx.db.prepare(`INSERT INTO redraw_execution_runs
        (tenant_id,user_id,work_id,version_id,queue_id,review_id,plan_hash,status,pause_requested,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'ready',0,0,?,?)`)
        .run(ctx.tenantId, ctx.userId, version.work_id, version.id, current.queue.id, current.saved_review.id, current.queue.plan_hash, now, now);
      run = ownedRun(ctx, version, Number(inserted.lastInsertRowid));
    }
    const result = readRun(ctx, version, run);
    if (result.binding_status !== 'current') fail('EXECUTION_RUN_CONFLICT');
    return result;
  }).immediate();
}

function getExecutionRun(ctx, versionId, runId) {
  return ctx.db.transaction(() => {
    const version = ownedVersion(ctx, versionId);
    return readRun(ctx, version, ownedRun(ctx, version, runId));
  })();
}

function listExecutionRuns(ctx, versionId) {
  return ctx.db.transaction(() => {
    const version = ownedVersion(ctx, versionId);
    const runs = ctx.db.prepare(`SELECT * FROM redraw_execution_runs
      WHERE tenant_id=? AND user_id=? AND version_id=? ORDER BY id`)
      .all(ctx.tenantId, ctx.userId, version.id).map(run => readRun(ctx, version, run));
    const current = runs.filter(run => run.binding_status === 'current');
    if (current.length > 1) invalid();
    return { version_id: version.id, current_run_id: current[0]?.id ?? null, runs };
  }).deferred();
}

function requestExecutionRunPause(ctx, versionId, runId, input) {
  return ctx.db.transaction(() => {
    const version = ownedVersion(ctx, versionId);
    const run = ownedRun(ctx, version, runId);
    if (!exact(input, ['expected_revision']) || !nonnegative(input.expected_revision)) fail('EXECUTION_RUN_INPUT_INVALID');
    if (run.revision !== input.expected_revision || run.revision === Number.MAX_SAFE_INTEGER) fail('EXECUTION_RUN_CONFLICT');
    const current = readRun(ctx, version, run);
    const stopped = !current.units.some((unit) => [...activeStates, 'needs_attention'].includes(unit.status));
    const status = current.binding_status === 'current' && stopped && ['ready', 'running', 'paused'].includes(run.status) ? 'paused' : run.status;
    const updated = ctx.db.prepare(`UPDATE redraw_execution_runs SET pause_requested = 1, status = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ? AND revision = ?`)
      .run(status, new Date().toISOString(), run.id, ctx.tenantId, ctx.userId, version.id, input.expected_revision);
    if (updated.changes !== 1) fail('EXECUTION_RUN_CONFLICT');
    return readRun(ctx, version, ownedRun(ctx, version, run.id));
  }).immediate();
}

const readinessSchema = 'redraw-execution-run-readiness-v1';
const plain = value => object(value) && Object.getPrototypeOf(value) === Object.prototype;
const allowed = (value, keys) => plain(value) && Reflect.ownKeys(value).every(key => keys.includes(key));
const blocked = code => ({ schema_version: readinessSchema, status: 'blocked', executable: false, reason_codes: [code] });
const conflict = () => fail('EXECUTION_RUN_CONFLICT');

function readinessInput(versionId, runId, input, claiming = false) {
  const required = claiming ? ['expected_revision', 'expected_plan_hash', 'expected_quote_hash'] : [];
  if (!positive(versionId) || !positive(runId) || !allowed(input, [...required, 'output_parameters'])
    || required.some(key => !Object.hasOwn(input, key))) fail('EXECUTION_RUN_INPUT_INVALID');
  const result = Object.fromEntries(required.map(key => [key, input[key]]));
  if (claiming && (!nonnegative(result.expected_revision) || !sha(result.expected_plan_hash)
    || !sha(result.expected_quote_hash))) fail('EXECUTION_RUN_INPUT_INVALID');
  if (Object.hasOwn(input, 'output_parameters')) {
    const params = input.output_parameters;
    if (!allowed(params, ['resolution', 'aspect_ratio']) || Reflect.ownKeys(params).length !== 2
      || !text(params.resolution) || !text(params.aspect_ratio)) fail('EXECUTION_RUN_INPUT_INVALID');
    result.output_parameters = { resolution: params.resolution, aspect_ratio: params.aspect_ratio };
  }
  return result;
}

function runAuthority(ctx, versionId, runId) {
  const version = ownedVersion(ctx, versionId), run = ownedRun(ctx, version, runId);
  const dto = readRun(ctx, version, run);
  const attempts = ctx.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE run_id = ? ORDER BY id').all(run.id);
  const units = ctx.db.prepare('SELECT id, unit_id, unit_hash, ordinal FROM redraw_execution_queue_units WHERE queue_id = ? ORDER BY ordinal')
    .all(run.queue_id);
  return { version, run, dto, attempts, units };
}

function parametersFor(authority, input) {
  const frozen = authority.dto.output_parameters, supplied = input.output_parameters;
  if (frozen && supplied && hashPlanValue(frozen) !== hashPlanValue(supplied)) conflict();
  return frozen || supplied || null;
}

function confirmationHash(run, unit, revision, paramsHash, readinessHash) {
  return hashPlanValue({ schema_version: 'redraw-execution-run-claim-confirmation-v1',
    tenant_id: run.tenant_id, user_id: run.user_id, work_id: run.work_id, version_id: run.version_id,
    run_id: run.id, queue_id: run.queue_id, review_id: run.review_id, plan_hash: run.plan_hash,
    queue_unit_id: unit.id, unit_id: unit.unit_id, unit_hash: unit.unit_hash,
    expected_revision: revision, output_parameters_hash: paramsHash, readiness_hash: readinessHash });
}

function exactReplay(authority, input, params) {
  const { run, attempts, units } = authority;
  if (run.plan_hash !== input.expected_plan_hash || !params) return null;
  const attempt = attempts.find(row => row.quote_hash === input.expected_quote_hash);
  if (!attempt) return null;
  const unit = units.find(row => row.id === attempt.queue_unit_id);
  if (confirmationHash(run, unit, input.expected_revision, hashPlanValue(params), attempt.readiness_hash) !== attempt.quote_hash) return null;
  return { attempt_id: attempt.id, status: attempt.status, newly_claimed: false };
}

function nextReadyState(ctx, authority, params) {
  const { run, dto, attempts, units } = authority;
  if (!['ready', 'running'].includes(run.status) || run.pause_requested) return blocked('EXECUTION_RUN_STOPPED');
  if (dto.binding_status !== 'current') return blocked('EXECUTION_RUN_STALE');
  const current = getExecutionQueue(ctx, run.version_id);
  if (current.queue?.status === 'invalid' || current.saved_review?.status === 'invalid') invalid();
  if (current.preview.status !== 'ready' || current.saved_review?.status !== 'current'
    || current.queue?.status !== 'waiting_readiness' || current.queue.id !== run.queue_id
    || current.saved_review.id !== run.review_id || current.queue.plan_hash !== run.plan_hash) return blocked('EXECUTION_RUN_STALE');
  const plan = current.saved_review.plan;
  if (!params) return blocked('EXECUTION_RUN_OUTPUT_PARAMETERS_REQUIRED');
  if (!plan.capability.resolutions.includes(params.resolution) || !plan.capability.aspect_ratios.includes(params.aspect_ratio)) {
    return blocked('EXECUTION_RUN_OUTPUT_PARAMETERS_UNSUPPORTED');
  }
  const predecessors = [];
  for (const attempt of attempts) {
    try { require('./redrawExecutionUnitReviewService').assertApprovedExecutionUnit(ctx, authority, attempt); }
    catch (_) { return blocked('EXECUTION_RUN_APPROVAL_REQUIRED'); }
  }
  let unit;
  for (const row of units) {
    const attempt = attempts.find(value => value.queue_unit_id === row.id);
    if (!attempt) { unit = row; break; }
    predecessors.push({ attempt_id: attempt.id, queue_unit_id: row.id, unit_id: row.unit_id, unit_hash: row.unit_hash,
      output_asset_id: attempt.output_asset_id, output_sha256: attempt.output_sha256, candidate_hash: attempt.candidate_hash,
      quality_json: attempt.quality_json, approved_by: attempt.approved_by, approved_at: attempt.approved_at });
  }
  if (!unit) return blocked('EXECUTION_RUN_NO_PENDING_UNIT');
  if (predecessors.length !== attempts.length) return blocked('EXECUTION_RUN_PREDECESSOR_REQUIRED');
  return { ...authority, current, plan, params, unit, predecessors };
}

function materialBindings(state) {
  return { version_id: state.run.version_id, review_id: state.run.review_id, queue_id: state.run.queue_id,
    plan_hash: state.run.plan_hash, unit_id: state.unit.unit_id, unit_hash: state.unit.unit_hash };
}

function readinessFor(ctx, state, material) {
  if (material.status !== 'prepared') return blocked('EXECUTION_RUN_PREPARATION_REQUIRED');
  const { inspectSelectedCapabilityReadiness } = require('./redrawSelectedCapabilityReadinessService');
  const { quoteExecutionUnits } = require('./redrawExecutionQuoteService');
  const selected = inspectSelectedCapabilityReadiness(ctx, state.plan.capability);
  if (selected.public_readiness.status !== 'ready') return blocked('EXECUTION_RUN_SELECTED_CAPABILITY_BLOCKED');
  const quote = quoteExecutionUnits(ctx, { plan: state.plan, output_parameters: state.params });
  if (quote.status !== 'quoted') return blocked('EXECUTION_RUN_QUOTE_BLOCKED');
  const { run, unit } = state;
  const readinessHash = hashPlanValue({ schema_version: readinessSchema, plan_bindings: state.plan.bindings,
    run_id: run.id, plan_hash: run.plan_hash, queue_id: run.queue_id, review_id: run.review_id,
    queue_unit_id: unit.id, unit_id: unit.unit_id, unit_hash: unit.unit_hash,
    materials_hash: material.materials_hash, prepared_materials_hash: material.prepared_materials.prepared_materials_hash,
    selected_binding_hash: hashPlanValue(selected.private_binding), output_parameters_hash: hashPlanValue(state.params),
    unit_quote_hash: quote.quote_hash, approved_predecessors: state.predecessors });
  return { schema_version: readinessSchema, status: 'ready', executable: false, run_id: run.id, revision: run.revision,
    plan_hash: run.plan_hash, unit: { id: unit.unit_id, queue_unit_id: unit.id, ordinal: unit.ordinal, unit_hash: unit.unit_hash },
    output_parameters: state.params, readiness_hash: readinessHash,
    quote_hash: confirmationHash(run, unit, run.revision, hashPlanValue(state.params), readinessHash), unit_quote: quote };
}

async function inspectExecutionRunReadiness(ctx, versionId, runId, rawInput = {}) {
  const input = readinessInput(versionId, runId, rawInput);
  const initial = ctx.db.transaction(() => {
    const authority = runAuthority(ctx, versionId, runId);
    return nextReadyState(ctx, authority, parametersFor(authority, input));
  }).deferred();
  if (initial.status === 'blocked') return initial;
  const { consumePreparedUnitReferenceMaterials } = require('./redrawUnitReferenceDerivationService');
  return consumePreparedUnitReferenceMaterials(ctx, materialBindings(initial), material => {
    const authority = runAuthority(ctx, versionId, runId);
    const current = nextReadyState(ctx, authority, parametersFor(authority, input));
    if (current.status === 'blocked') return current;
    if (hashPlanValue(current) !== hashPlanValue(initial)) conflict();
    return readinessFor(ctx, current, material);
  }, 'deferred');
}

async function claimNextUnit(ctx, versionId, runId, rawInput) {
  return claimNextUnitCurrent(ctx, versionId, runId, rawInput);
}

async function claimNextUnitCurrent(ctx, versionId, runId, rawInput, guard) {
  const input = readinessInput(versionId, runId, rawInput, true);
  const inspect = () => {
    const authority = runAuthority(ctx, versionId, runId), params = parametersFor(authority, input);
    const replay = exactReplay(authority, input, params);
    if (replay) return { replay };
    if (authority.run.revision !== input.expected_revision || authority.run.plan_hash !== input.expected_plan_hash
      || authority.run.revision === Number.MAX_SAFE_INTEGER) conflict();
    const state = nextReadyState(ctx, authority, params);
    if (state.status === 'blocked') fail(state.reason_codes[0]);
    return state;
  };
  const initial = ctx.db.transaction(inspect).deferred();
  if (initial.replay) return initial.replay;
  const { consumePreparedUnitReferenceMaterials } = require('./redrawUnitReferenceDerivationService');
  return consumePreparedUnitReferenceMaterials(ctx, materialBindings(initial), material => {
    // A lock waiter may now observe the other process's exact same claim. Never advance it.
    const current = inspect();
    if (current.replay) return current.replay;
    if (hashPlanValue(current) !== hashPlanValue(initial)) conflict();
    const ready = readinessFor(ctx, current, material);
    if (ready.status !== 'ready') fail(ready.reason_codes[0]);
    if (ready.quote_hash !== input.expected_quote_hash) conflict();
    guard?.before(current, material);
    const { run, unit, params } = current, now = new Date().toISOString();
    const updatedRun = { ...run, status: 'running', revision: run.revision + 1, updated_at: now,
      output_parameters_json: run.output_parameters_json ?? JSON.stringify(params), output_parameters_hash: hashPlanValue(params) };
    const updated = ctx.db.prepare(`UPDATE redraw_execution_runs SET status = 'running', revision = revision + 1,
      output_parameters_json = ?, output_parameters_hash = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ? AND revision = ? AND pause_requested = 0`)
      .run(updatedRun.output_parameters_json, updatedRun.output_parameters_hash, now, run.id, ctx.tenantId, ctx.userId,
        versionId, input.expected_revision);
    if (updated.changes !== 1) conflict();
    const attempt = { run_id: run.id, queue_unit_id: unit.id, attempt_no: 1, unit_hash: unit.unit_hash, status: 'claimed',
      claim_token: randomBytes(32).toString('hex'), readiness_hash: ready.readiness_hash, quote_hash: ready.quote_hash,
      quoted_amount: ready.unit_quote.units.find(value => value.unit_id === unit.unit_id).amount,
      billing_mode: ready.unit_quote.pricing_mode === 'free' ? 'no_charge' : 'paid', request_hash: null, task_id: null,
      reservation_id: null, provider_task_id: null, output_asset_id: null, output_sha256: null, candidate_hash: null,
      quality_json: null, approved_by: null, approved_at: null, submit_started_at: null, created_at: now, updated_at: now };
    const keys = Object.keys(attempt);
    attempt.id = Number(ctx.db.prepare(`INSERT INTO redraw_execution_unit_attempts (${keys.join(',')})
      VALUES (${keys.map(key => '@' + key).join(',')})`).run(attempt).lastInsertRowid);
    const after = runAuthority(ctx, versionId, runId);
    if (hashPlanValue(after.run) !== hashPlanValue(updatedRun)
      || hashPlanValue(after.attempts) !== hashPlanValue([...current.attempts, attempt])
      || hashPlanValue(getExecutionQueue(ctx, versionId)) !== hashPlanValue(current.current)
      || hashPlanValue(readinessFor(ctx, current, material)) !== hashPlanValue(ready)) conflict();
    guard?.after();
    // The prepared-material boundary makes its own final current check after this consumer returns.
    return { attempt_id: attempt.id, status: attempt.status, newly_claimed: true };
  }, 'immediate');
}

const unitTaskType = 'redraw_execution_unit';
const bindingSchema = 'redraw-execution-unit-task-binding-v1';
const bindingOperation = attempt => `${unitTaskType}:${attempt.id}`;

function taskBindingMetadata(authority, attempt, unit, revision) {
  const { run } = authority;
  return { schema_version: bindingSchema, tenant_id: run.tenant_id, user_id: run.user_id, work_id: run.work_id,
    version_id: run.version_id, run_id: run.id, attempt_id: attempt.id, queue_id: run.queue_id, queue_unit_id: unit.id,
    unit_id: unit.unit_id, unit_hash: unit.unit_hash, review_id: run.review_id, plan_hash: run.plan_hash,
    quote_hash: attempt.quote_hash, binding_revision: revision };
}

function bindingReservationMatches(reservation, run, attempt, model, held = false) {
  return Boolean(reservation && reservation.tenant_id === run.tenant_id && reservation.actor_user_id === run.user_id
    && reservation.resource_type === unitTaskType && reservation.resource_id === String(attempt.id)
    && reservation.operation_key === bindingOperation(attempt) && reservation.model === model
    && reservation.amount === attempt.quoted_amount && (held ? ['held'] : ['held', 'confirmed', 'refunded']).includes(reservation.status));
}

function taskBindingResult(ctx, authority, attempt, input, newlyBound = false) {
  const { run, units } = authority, unit = units.find(value => value.id === attempt.queue_unit_id);
  const task = ctx.db.prepare('SELECT * FROM async_tasks WHERE id=? AND deleted_at IS NULL').get(attempt.task_id);
  const model = JSON.parse(ctx.db.prepare('SELECT plan_json FROM redraw_execution_plan_reviews WHERE id=?').get(run.review_id).plan_json).capability.model;
  let metadata;
  try { metadata = JSON.parse(task?.metadata); } catch { invalid(); }
  if (!task || task.type !== unitTaskType || task.resource_id !== String(attempt.id)
    || task.tenant_id !== run.tenant_id || task.user_id !== run.user_id || task.model !== model
    || !plain(metadata) || !nonnegative(metadata.binding_revision) || metadata.binding_revision >= run.revision
    || hashPlanValue(metadata) !== hashPlanValue(taskBindingMetadata(authority, attempt, unit, metadata.binding_revision))) invalid();
  let billing = { status: 'no_charge', amount: 0 };
  if (attempt.billing_mode === 'paid') {
    if (!attempt.reservation_id || task.credit_reservation_id !== attempt.reservation_id) invalid();
    // Replay reads the tenant's actual ledger row, without ensureSchema, reserve or any DML.
    const reservation = ctx.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=? AND tenant_id=?')
      .get(attempt.reservation_id, run.tenant_id);
    if (!bindingReservationMatches(reservation, run, attempt, model, newlyBound)) invalid();
    billing = { status: reservation.status, amount: reservation.amount };
  } else if (attempt.reservation_id !== null || task.credit_reservation_id !== null) invalid();
  if (input.expected_revision !== metadata.binding_revision || input.expected_plan_hash !== run.plan_hash
    || input.expected_quote_hash !== attempt.quote_hash) conflict();
  return { newly_bound: newlyBound, executable: false, run_revision: run.revision, attempt_id: attempt.id,
    task_id: task.id, billing_mode: attempt.billing_mode, quoted_amount: attempt.quoted_amount, billing };
}

function bindingLedgerSnapshot(db, tenantId, reservationId) {
  return {
    account: db.prepare('SELECT * FROM tenant_credit_accounts WHERE tenant_id=?').get(tenantId),
    reservation: db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=?').get(reservationId),
    entries: db.prepare('SELECT * FROM tenant_credit_ledger WHERE reservation_id=? ORDER BY id').all(reservationId),
    allocation: db.prepare('SELECT * FROM tenant_usage_reservation_allocations WHERE reservation_id=?').get(reservationId),
    buckets: db.prepare('SELECT * FROM tenant_daily_bonus_buckets WHERE tenant_id=? ORDER BY id').all(tenantId),
    memberships: db.prepare('SELECT * FROM tenant_recharge_memberships WHERE tenant_id=? ORDER BY id').all(tenantId),
  };
}

function bindingState(ctx, versionId, runId, input, authority = runAuthority(ctx, versionId, runId)) {
  const { run, attempts } = authority;
  const attempt = attempts.find(value => value.id === input.attempt_id);
  if (!attempt) conflict();
  if (attempt.task_id !== null) return { replay: taskBindingResult(ctx, authority, attempt, input) };
  if (attempt.reservation_id !== null || ctx.db.prepare('SELECT 1 FROM async_tasks WHERE type=? AND resource_id=? LIMIT 1')
    .get(unitTaskType, String(attempt.id))) invalid();
  if (attempt.status !== 'claimed' || attempt.submit_started_at !== null
    || attempt.provider_task_id !== null || attempt.request_hash !== null || run.revision !== input.expected_revision
    || run.revision === Number.MAX_SAFE_INTEGER || run.plan_hash !== input.expected_plan_hash
    || attempt.quote_hash !== input.expected_quote_hash) conflict();
  // Exclude only the target in a read-only view: all earlier approvals and the first-pending rule still apply.
  const state = nextReadyState(ctx, { ...authority, attempts: attempts.filter(value => value.id !== attempt.id) }, authority.dto.output_parameters);
  if (state.status === 'blocked') fail(state.reason_codes[0]);
  if (state.unit.id !== attempt.queue_unit_id) conflict();
  return { ...state, target: attempt, original_attempts: attempts };
}

async function bindClaimedExecutionUnitTask(ctx, versionId, runId, input) {
  return bindClaimedExecutionUnitTaskCurrent(ctx, versionId, runId, input);
}

async function bindClaimedExecutionUnitTaskCurrent(ctx, versionId, runId, input, guard) {
  const keys = ['attempt_id', 'expected_revision', 'expected_plan_hash', 'expected_quote_hash'];
  if (!positive(versionId) || !positive(runId) || !allowed(input, keys) || Reflect.ownKeys(input).length !== keys.length
    || !positive(input.attempt_id) || !nonnegative(input.expected_revision) || !sha(input.expected_plan_hash)
    || !sha(input.expected_quote_hash)) fail('EXECUTION_RUN_INPUT_INVALID');
  input = Object.fromEntries(keys.map(key => [key, input[key]]));
  const inspect = () => bindingState(ctx, versionId, runId, input);
  const initial = ctx.db.transaction(inspect).deferred();
  if (initial.replay) return initial.replay;
  const { consumePreparedUnitReferenceMaterials } = require('./redrawUnitReferenceDerivationService');
  return consumePreparedUnitReferenceMaterials(ctx, materialBindings(initial), material => {
    const current = inspect();
    if (current.replay) return current.replay;
    if (hashPlanValue(current) !== hashPlanValue(initial)) conflict();
    const ready = readinessFor(ctx, current, material), { run, target: attempt, plan } = current;
    if (ready.status !== 'ready') fail(ready.reason_codes[0]);
    const unitQuote = ready.unit_quote.units.find(value => value.unit_id === current.unit.unit_id);
    if (ready.readiness_hash !== attempt.readiness_hash || unitQuote?.amount !== attempt.quoted_amount
      || (ready.unit_quote.pricing_mode === 'free' ? 'no_charge' : 'paid') !== attempt.billing_mode) conflict();
    guard?.before(current, material);
    // expected_quote_hash is the saved claim confirmation, not a quote regenerated at this newer revision.
    let reservation = null, ledgerSnapshot = null;
    if (attempt.billing_mode === 'paid') {
      const ledger = require('./creditLedgerService');
      reservation = ledger.reserve(ctx.db, { tenantId: run.tenant_id, userId: run.user_id, actorUserId: run.user_id,
        operationKey: bindingOperation(attempt), model: plan.capability.model, resourceType: unitTaskType,
        resourceId: String(attempt.id), amount: attempt.quoted_amount });
      if (!bindingReservationMatches(reservation, run, attempt, plan.capability.model, true)) conflict();
      ledgerSnapshot = bindingLedgerSnapshot(ctx.db, run.tenant_id, reservation.id);
    }
    const { createTask } = require('./taskService');
    const task = createTask(ctx.db, ctx.log, unitTaskType, String(attempt.id));
    const taskBefore = ctx.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(task.id);
    if (!taskBefore || taskBefore.type !== unitTaskType || taskBefore.status !== 'pending' || taskBefore.deleted_at !== null
      || taskBefore.resource_id !== String(attempt.id) || taskBefore.provider_task_id !== null) conflict();
    const metadata = JSON.stringify(taskBindingMetadata(current, attempt, current.unit, input.expected_revision));
    const expectedTask = { ...taskBefore, tenant_id: run.tenant_id, user_id: run.user_id, model: plan.capability.model,
      metadata, credit_reservation_id: reservation?.id ?? null };
    if (ctx.db.prepare(`UPDATE async_tasks SET tenant_id=?,user_id=?,model=?,metadata=?,credit_reservation_id=?
      WHERE id=? AND type=? AND status='pending' AND deleted_at IS NULL`)
      .run(run.tenant_id, run.user_id, plan.capability.model, metadata, reservation?.id ?? null, task.id, unitTaskType).changes !== 1) conflict();
    const now = new Date().toISOString(), expectedAttempt = { ...attempt, task_id: task.id, reservation_id: reservation?.id ?? null, updated_at: now };
    if (ctx.db.prepare(`UPDATE redraw_execution_unit_attempts SET task_id=?,reservation_id=?,updated_at=?
      WHERE id=? AND run_id=? AND status='claimed' AND task_id IS NULL AND reservation_id IS NULL
        AND submit_started_at IS NULL AND provider_task_id IS NULL AND request_hash IS NULL`)
      .run(task.id, reservation?.id ?? null, now, attempt.id, run.id).changes !== 1) conflict();
    const expectedRun = { ...run, revision: run.revision + 1, updated_at: now };
    if (ctx.db.prepare(`UPDATE redraw_execution_runs SET revision=revision+1,updated_at=?
      WHERE id=? AND tenant_id=? AND user_id=? AND version_id=? AND revision=? AND pause_requested=0 AND status IN ('ready','running')`)
      .run(now, run.id, run.tenant_id, run.user_id, versionId, input.expected_revision).changes !== 1) conflict();
    const after = runAuthority(ctx, versionId, runId);
    if (hashPlanValue(after.run) !== hashPlanValue(expectedRun)
      || hashPlanValue(after.attempts) !== hashPlanValue(current.original_attempts.map(value => value.id === attempt.id ? expectedAttempt : value))
      || hashPlanValue(ctx.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(task.id)) !== hashPlanValue(expectedTask)
      || (reservation && hashPlanValue(bindingLedgerSnapshot(ctx.db, run.tenant_id, reservation.id)) !== hashPlanValue(ledgerSnapshot))
      || hashPlanValue(getExecutionQueue(ctx, versionId)) !== hashPlanValue(current.current)
      || hashPlanValue(readinessFor(ctx, current, material)) !== hashPlanValue(ready)) conflict();
    guard?.after();
    return taskBindingResult(ctx, after, expectedAttempt, input, true);
  }, 'immediate');
}

const submissionSchema = 'redraw-execution-unit-submission-v1';

function dispatchInput(versionId, runId, input) {
  const keys = ['attempt_id', 'expected_revision', 'expected_plan_hash', 'expected_quote_hash'];
  if (!positive(versionId) || !positive(runId) || !allowed(input, keys) || Reflect.ownKeys(input).length !== keys.length
    || !positive(input.attempt_id) || !nonnegative(input.expected_revision) || !sha(input.expected_plan_hash)
    || !sha(input.expected_quote_hash)) fail('EXECUTION_RUN_INPUT_INVALID');
  return Object.fromEntries(keys.map(key => [key, input[key]]));
}

function submissionResult(run, attempt, newlySubmitted, receiptPersisted = true) {
  return { run_id: run.id, run_revision: run.revision, attempt_id: attempt.id, task_id: attempt.task_id,
    status: attempt.status, provider_task_id: attempt.provider_task_id, newly_submitted: newlySubmitted,
    receipt_persisted: receiptPersisted, executable: false };
}

function dispatchReplay(ctx, versionId, runId, input) {
  const version = ownedVersion(ctx, versionId), run = ownedRun(ctx, version, runId);
  const attempt = ctx.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=? AND run_id=?').get(input.attempt_id, run.id);
  if (!attempt) conflict();
  if (attempt.request_hash === null && attempt.submit_started_at === null && attempt.provider_task_id === null) return null;
  let envelope;
  try { envelope = JSON.parse(attempt.quality_json); } catch { invalid(); }
  const submitted = envelope?.submission;
  if (envelope?.schema_version !== submissionSchema || !submitted || submitted.request_hash !== attempt.request_hash
    || submitted.submit_started_at !== attempt.submit_started_at || submitted.attempt_id !== attempt.id
    || submitted.run_id !== run.id || submitted.task_id !== attempt.task_id
    || submitted.claim_hash !== hashPlanValue(attempt.claim_token)) invalid();
  if (submitted.expected_revision !== input.expected_revision || submitted.plan_hash !== input.expected_plan_hash
    || submitted.quote_hash !== input.expected_quote_hash) conflict();
  return submissionResult(run, attempt, false);
}

function dispatchState(ctx, versionId, runId, input, authority = runAuthority(ctx, versionId, runId)) {
  const { run, attempts } = authority;
  const attempt = attempts.find(value => value.id === input.attempt_id);
  if (!attempt || attempt.status !== 'claimed' || !attempt.task_id || attempt.request_hash !== null
    || attempt.submit_started_at !== null || attempt.provider_task_id !== null || attempt.quality_json !== null
    || run.revision !== input.expected_revision || run.revision === Number.MAX_SAFE_INTEGER
    || run.plan_hash !== input.expected_plan_hash || attempt.quote_hash !== input.expected_quote_hash) conflict();
  const task = ctx.db.prepare('SELECT * FROM async_tasks WHERE id=? AND deleted_at IS NULL').get(attempt.task_id);
  let metadata;
  try { metadata = JSON.parse(task?.metadata); } catch { invalid(); }
  taskBindingResult(ctx, authority, attempt, { expected_revision: metadata?.binding_revision,
    expected_plan_hash: input.expected_plan_hash, expected_quote_hash: input.expected_quote_hash }, true);
  if (task.status !== 'pending' || task.provider_task_id !== null) conflict();
  const state = nextReadyState(ctx, { ...authority, attempts: attempts.filter(value => value.id !== attempt.id) }, authority.dto.output_parameters);
  if (state.status === 'blocked') fail(state.reason_codes[0]);
  if (state.unit.id !== attempt.queue_unit_id) conflict();
  return { ...state, target: attempt, task, original_attempts: attempts };
}

function unitPrompt(pack, capability) {
  // Project only approved target speech. Never serialize the pack wholesale: it
  // also contains original dialogue, source IDs and provenance not for providers.
  return JSON.stringify({ instruction: 'Generate this approved unit using only the supplied identity and motion references. Preserve complete target dialogue and speaker order; do not add dialogue or captions.',
    locale: capability.locale, market: capability.market, audio_mode: capability.audio_mode,
    timeline: { retained_duration_ms: pack.timeline.retained_duration_ms,
      generated_duration_ms: pack.timeline.generated_duration_ms, padding_ms: pack.timeline.padding_ms },
    character_name_map: pack.character_name_map,
    shots: pack.parent_contexts.map(parent => ({ unit_start_ms: parent.unit_start_ms, unit_end_ms: parent.unit_end_ms,
      composition: parent.composition, camera_movement: parent.camera_movement,
      opening_state: parent.opening_state, continuous_action: parent.continuous_action, ending_state: parent.ending_state,
      visible_character_names: parent.visible_character_ids.map(id => pack.character_name_map[id]) })),
    dialogues: pack.dialogues.map(dialogue => ({ unit_start_ms: dialogue.unit_start_ms, unit_end_ms: dialogue.unit_end_ms,
      target_speaker_name: dialogue.target_speaker_name, target_text: dialogue.target_text,
      emotion: dialogue.emotion, pronunciation_hint: dialogue.pronunciation_hint })) });
}

function submittedAuthority(ctx, submitted) {
  // A POST's receipt is bound to immutable submission facts, not current plan,
  // prices, credentials, pause state or a mutable task-metadata projection.
  if (!submitted || ctx.tenantId !== submitted.tenant_id || ctx.userId !== submitted.user_id) invalid();
  const run = ctx.db.prepare('SELECT * FROM redraw_execution_runs WHERE id=? AND tenant_id=? AND user_id=?')
    .get(submitted.run_id, submitted.tenant_id, submitted.user_id);
  const attempt = ctx.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=? AND run_id=?').get(submitted.attempt_id, submitted.run_id);
  const task = ctx.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(submitted.task_id);
  if (!run || run.work_id !== submitted.work_id || run.version_id !== submitted.version_id
      || !attempt || attempt.task_id !== submitted.task_id || attempt.request_hash !== submitted.request_hash
      || attempt.submit_started_at !== submitted.submit_started_at || hashPlanValue(attempt.claim_token) !== submitted.claim_hash
      || !task || task.type !== unitTaskType || task.resource_id !== String(attempt.id)
      || task.tenant_id !== submitted.tenant_id || task.user_id !== submitted.user_id) invalid();
  return { run, attempt, task };
}

function persistSubmittedObservation(ctx, submitted, observation, newlySubmitted = true, downloadOutcome = false) {
  return ctx.db.transaction(() => {
    const { run, attempt, task } = submittedAuthority(ctx, submitted);
    if (['waiting_review', 'approved', 'rejected', 'failed'].includes(attempt.status)) return submissionResult(run, attempt, false);
    const previous = JSON.parse(attempt.quality_json);
    if (previous.download_started_at && !downloadOutcome) return submissionResult(run, attempt, false);
    const id = observation.provider_task_id || attempt.provider_task_id || null;
    if ((attempt.provider_task_id && id !== attempt.provider_task_id) || (task.provider_task_id && id !== task.provider_task_id)) conflict();
    const status = observation.status === 'failed_terminal' ? 'failed'
      : ['accepted', 'running'].includes(observation.status) ? 'running' : 'needs_attention';
    if (status === 'failed') {
      if (attempt.billing_mode === 'paid') {
        const reservation = ctx.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=? AND tenant_id=?')
          .get(attempt.reservation_id, run.tenant_id);
        if (task.credit_reservation_id !== attempt.reservation_id
          || !bindingReservationMatches(reservation, run, attempt, submitted.connection.model, true)) conflict();
        require('./creditLedgerService').refundForScope(ctx.db, attempt.reservation_id,
          { tenantId: run.tenant_id }, 'redraw_execution_unit_explicit_failure');
      } else if (attempt.billing_mode !== 'no_charge' || attempt.reservation_id !== null || attempt.quoted_amount !== 0) invalid();
    }
    const now = new Date().toISOString();
    const envelope = JSON.stringify({ ...previous, schema_version: submissionSchema, submission: submitted, observation });
    if (ctx.db.prepare(`UPDATE redraw_execution_unit_attempts SET provider_task_id=?,status=?,quality_json=?,updated_at=?
      WHERE id=? AND run_id=? AND request_hash=? AND submit_started_at=? AND task_id=?`)
      .run(id, status, envelope, now, attempt.id, run.id, submitted.request_hash, submitted.submit_started_at, task.id).changes !== 1) conflict();
    if (ctx.db.prepare(`UPDATE async_tasks SET provider_task_id=?,status=?,updated_at=? WHERE id=? AND type=? AND resource_id=?`)
      .run(id, status === 'running' ? 'processing' : status === 'failed' ? 'failed' : 'needs_attention', now, task.id, unitTaskType, String(attempt.id)).changes !== 1) conflict();
    if (run.revision === Number.MAX_SAFE_INTEGER || ctx.db.prepare(`UPDATE redraw_execution_runs SET status=?,revision=revision+1,updated_at=?
      WHERE id=? AND tenant_id=? AND user_id=? AND revision=?`).run(status, now, run.id, submitted.tenant_id, submitted.user_id, run.revision).changes !== 1) conflict();
    return submissionResult({ ...run, status, revision: run.revision + 1 }, { ...attempt, status, provider_task_id: id }, newlySubmitted);
  }).immediate();
}

function safeSubmissionReceipt(submitted, observation) {
  return { schema_version: 'redraw-execution-unit-safe-receipt-v1', tenant_id: submitted.tenant_id,
    user_id: submitted.user_id, work_id: submitted.work_id, version_id: submitted.version_id,
    run_id: submitted.run_id, attempt_id: submitted.attempt_id, task_id: submitted.task_id,
    request_hash: submitted.request_hash, submit_started_at: submitted.submit_started_at,
    provider_task_id: observation.provider_task_id || null, status: 'needs_attention',
    reason_code: 'PROVIDER_RECEIPT_PERSISTENCE_FAILED' };
}

function persistSafeTaskReceipt(ctx, submitted, receipt) {
  return ctx.db.transaction(() => {
    const { run, attempt, task } = submittedAuthority(ctx, submitted);
    const serialized = JSON.stringify(receipt);
    if (!['submitting', 'running', 'needs_attention'].includes(attempt.status)
      || hashPlanValue(task.metadata) !== submitted.task_metadata_hash
      || (task.result !== null && task.result !== serialized)
      || (task.provider_task_id !== null && task.provider_task_id !== receipt.provider_task_id)
      || task.credit_reservation_id !== attempt.reservation_id) conflict();
    if (attempt.billing_mode === 'paid') {
      const reservation = ctx.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=? AND tenant_id=?')
        .get(attempt.reservation_id, run.tenant_id);
      if (!bindingReservationMatches(reservation, run, attempt, submitted.connection.model, true)) conflict();
    } else if (attempt.billing_mode !== 'no_charge' || attempt.reservation_id !== null || attempt.quoted_amount !== 0) invalid();
    if (ctx.db.prepare(`UPDATE async_tasks SET result=?,provider_task_id=?,status='needs_attention',updated_at=?
      WHERE id=? AND type=? AND tenant_id=? AND user_id=? AND resource_id=?
        AND result IS ? AND provider_task_id IS ? AND metadata=? AND credit_reservation_id IS ?`)
      .run(serialized, receipt.provider_task_id, new Date().toISOString(), task.id, unitTaskType, run.tenant_id, run.user_id,
        String(attempt.id), task.result, task.provider_task_id, task.metadata, attempt.reservation_id).changes !== 1) conflict();
    const saved = ctx.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(task.id);
    if (saved.result !== serialized || saved.provider_task_id !== receipt.provider_task_id || saved.status !== 'needs_attention') conflict();
    return true;
  }).immediate();
}

function persistObservationOrSafeReceipt(ctx, submitted, observation, newlySubmitted, downloadOutcome = false) {
  try { return persistSubmittedObservation(ctx, submitted, observation, newlySubmitted, downloadOutcome); }
  catch (_) {
    // The main transaction has rolled back before this independent, minimal public
    // receipt is attempted. Never claim whole-DB failures can be made durable.
    const receipt = safeSubmissionReceipt(submitted, observation);
    let persisted = false;
    try { persisted = persistSafeTaskReceipt(ctx, submitted, receipt); } catch (_) {}
    return { run_id: submitted.run_id, attempt_id: submitted.attempt_id, task_id: submitted.task_id,
      status: 'needs_attention', provider_task_id: receipt.provider_task_id,
      newly_submitted: newlySubmitted, receipt_persisted: false, fallback_receipt_persisted: persisted,
      executable: false, recovery_receipt: receipt };
  }
}

function validTransportRuntime(runtime) {
  return allowed(runtime, ['fetchImpl', 'download']) && typeof runtime.fetchImpl === 'function'
    && (runtime.download === undefined || (allowed(runtime.download, ['fetchImpl', '_dnsLookupForTest'])
      && Object.values(runtime.download).every(value => typeof value === 'function')));
}

async function finishSubmittedObservation(ctx, submitted, observation, runtime, newlySubmitted) {
  const saved = persistObservationOrSafeReceipt(ctx, submitted, observation, newlySubmitted);
  if (!saved.receipt_persisted || observation.status !== 'completed_candidate' || saved.status !== 'needs_attention') return saved;
  const started = ctx.db.transaction(() => {
    const { attempt } = submittedAuthority(ctx, submitted);
    const envelope = JSON.parse(attempt.quality_json);
    if (envelope.download_started_at || attempt.output_asset_id !== null) return false;
    if (hashPlanValue(envelope.observation) !== hashPlanValue(observation)) conflict();
    envelope.download_started_at = new Date().toISOString();
    if (ctx.db.prepare('UPDATE redraw_execution_unit_attempts SET quality_json=?,updated_at=? WHERE id=? AND quality_json=? AND request_hash=?')
      .run(JSON.stringify(envelope), envelope.download_started_at, attempt.id, attempt.quality_json, submitted.request_hash).changes !== 1) conflict();
    return true;
  }).immediate();
  if (!started) return saved;
  try {
    const { materializeExecutionUnitCandidate, assertExecutionUnitCandidate } = require('./redrawSourceConditioningService');
    const input = { storageRoot: ctx.storageRoot, tempRoot: ctx.tempRoot, runId: submitted.run_id,
      attemptId: submitted.attempt_id, ...submitted.output_contract, url: observation.result_url, download: runtime.download };
    const artifact = await materializeExecutionUnitCandidate(input);
    return ctx.db.transaction(() => {
      const { run, attempt, task } = submittedAuthority(ctx, submitted), envelope = JSON.parse(attempt.quality_json);
      if (attempt.output_asset_id !== null || !envelope.download_started_at
        || hashPlanValue(envelope.observation) !== hashPlanValue(observation)) conflict();
      assertExecutionUnitCandidate(input, artifact);
      const metadata = { schema_version: 'redraw-execution-unit-candidate-v1', tenant_id: run.tenant_id,
        user_id: run.user_id, work_id: run.work_id, version_id: run.version_id,
        run_id: run.id, attempt_id: attempt.id, task_id: task.id, request_hash: submitted.request_hash,
        sha256: artifact.sha256, review_status: 'pending' };
      const asset = require('./assetService').create(ctx.db, ctx.log, { type: 'video', category: 'redraw_execution_unit_candidate',
        name: 'Redraw unit candidate', local_path: artifact.relative_path, file_size: artifact.bytes,
        mime_type: artifact.mime_type, width: artifact.width, height: artifact.height,
        duration: artifact.duration_ms / 1000, metadata });
      const candidate = { asset_id: asset.id, ...artifact, review_status: 'pending', qa_status: 'not_checked' };
      const candidateHash = hashPlanValue({ request_hash: submitted.request_hash, candidate });
      envelope.candidate = candidate;
      const now = new Date().toISOString();
      if (ctx.db.prepare(`UPDATE redraw_execution_unit_attempts SET status='waiting_review',output_asset_id=?,output_sha256=?,candidate_hash=?,quality_json=?,updated_at=?
        WHERE id=? AND request_hash=? AND output_asset_id IS NULL AND quality_json=?`)
        .run(asset.id, artifact.sha256, candidateHash, JSON.stringify(envelope), now, attempt.id, submitted.request_hash, attempt.quality_json).changes !== 1) conflict();
      if (ctx.db.prepare("UPDATE async_tasks SET status='needs_attention',updated_at=? WHERE id=? AND type=? AND resource_id=?")
        .run(now, task.id, unitTaskType, String(attempt.id)).changes !== 1) conflict();
      if (ctx.db.prepare("UPDATE redraw_execution_runs SET status='waiting_review',revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .run(now, run.id, run.revision).changes !== 1) conflict();
      assertExecutionUnitCandidate(input, artifact);
      return { ...submissionResult({ ...run, revision: run.revision + 1 }, { ...attempt, status: 'waiting_review' }, newlySubmitted),
        output_asset_id: asset.id, output_sha256: artifact.sha256, candidate_hash: candidateHash };
    }).immediate();
  } catch (_) {
    return persistObservationOrSafeReceipt(ctx, submitted,
      { status: 'result_unavailable', provider_task_id: observation.provider_task_id, safe_stage: 'provider_result' }, newlySubmitted, true);
  }
}

async function recoverExecutionUnitTask(ctx, versionId, runId, input, runtime = {}) {
  if (!positive(versionId) || !positive(runId) || !exact(input, ['attempt_id']) || !positive(input.attempt_id)
    || !validTransportRuntime(runtime)) fail('EXECUTION_RUN_INPUT_INVALID');
  const state = ctx.db.transaction(() => {
    const run = ownedRun(ctx, ownedVersion(ctx, versionId), runId);
    const attempt = ctx.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=? AND run_id=?').get(input.attempt_id, run.id);
    if (!attempt || !sha(attempt.request_hash) || !time(attempt.submit_started_at)) conflict();
    let envelope;
    try { envelope = JSON.parse(attempt.quality_json); } catch { invalid(); }
    if (envelope?.schema_version !== submissionSchema) invalid();
    return { ...submittedAuthority(ctx, envelope.submission), submitted: envelope.submission };
  }).deferred();
  let { run, attempt } = state;
  const { submitted, task } = state;
  if (!attempt.provider_task_id && task.provider_task_id && task.result) {
    let receipt;
    try { receipt = JSON.parse(task.result); } catch { invalid(); }
    if (hashPlanValue(receipt) !== hashPlanValue(safeSubmissionReceipt(submitted, { provider_task_id: task.provider_task_id }))) invalid();
    const restored = persistObservationOrSafeReceipt(ctx, submitted,
      { status: 'submission_unknown', provider_task_id: task.provider_task_id }, false);
    if (!restored.receipt_persisted) return restored;
    ({ run, attempt } = submittedAuthority(ctx, submitted));
  }
  if (['waiting_review', 'approved', 'rejected', 'failed'].includes(attempt.status) || !attempt.provider_task_id
    || JSON.parse(attempt.quality_json).download_started_at) {
    return submissionResult(run, attempt, false);
  }
  let connection;
  try { connection = require('./redrawSelectedCapabilityReadinessService').resolveSubmittedVideoConnection(ctx, submitted.connection); }
  catch (_) { return { ...submissionResult(run, attempt, false), status: 'needs_attention', reason_code: 'SELECTED_CAPABILITY_STALE' }; }
  const observation = await require('./redrawUnitVideoClient').queryRedrawUnitVideo({ ...connection,
    provider_task_id: attempt.provider_task_id }, { fetchImpl: runtime.fetchImpl });
  return finishSubmittedObservation(ctx, submitted, observation, runtime, false);
}

async function dispatchClaimedExecutionUnitTask(ctx, versionId, runId, rawInput, runtime = {}) {
  return dispatchClaimedExecutionUnitTaskCurrent(ctx, versionId, runId, rawInput, runtime);
}

async function dispatchClaimedExecutionUnitTaskCurrent(ctx, versionId, runId, rawInput, runtime, guard) {
  const input = dispatchInput(versionId, runId, rawInput);
  if (!validTransportRuntime(runtime)) fail('EXECUTION_RUN_INPUT_INVALID');
  const replay = ctx.db.transaction(() => dispatchReplay(ctx, versionId, runId, input)).deferred();
  if (replay) return replay;
  const initial = ctx.db.transaction(() => dispatchState(ctx, versionId, runId, input)).deferred();
  const { withPreparedUnitSubmission } = require('./redrawUnitReferenceDerivationService');
  const { resolveSelectedVideoConnection } = require('./redrawSelectedCapabilityReadinessService');
  const { publishPreparedProviderAsset } = require('./redrawSourceConditioningService');
  const { submitRedrawUnitVideo } = require('./redrawUnitVideoClient');
  return withPreparedUnitSubmission(ctx, materialBindings(initial), async scope => {
    const connection = resolveSelectedVideoConnection(ctx, initial.plan.capability);
    const published = [];
    for (const reference of scope.references) {
      const signed = await publishPreparedProviderAsset({ ...ctx.providerAssets, storageRoot: ctx.storageRoot,
        bytes: reference.bytes, segmentSha256: reference.sha256, mimeType: reference.mime_type });
      published.push({ kind: reference.kind, url: signed.url });
    }
    const opts = { model: initial.plan.capability.model, prompt: unitPrompt(scope.productionPack, initial.plan.capability),
      duration: scope.productionPack.timeline.generated_duration_ms / 1000,
      resolution: initial.params.resolution, aspect_ratio: initial.params.aspect_ratio,
      generate_audio: initial.plan.capability.audio_mode === 'native',
      reference_urls: published.filter(value => value.kind === 'image').map(value => value.url),
      reference_video_urls: published.filter(value => value.kind === 'video').map(value => value.url) };
    let submitted;
    const observation = await submitRedrawUnitVideo({ protocol: connection.protocol, config: connection.config, opts }, {
      fetchImpl: runtime.fetchImpl,
      beforeSubmit: marker => {
        let pending;
        const result = scope.consumeCurrent(material => {
          const current = dispatchState(ctx, versionId, runId, input), { run, target: attempt, task } = current;
          if (hashPlanValue(current) !== hashPlanValue(initial)) conflict();
          const ready = readinessFor(ctx, current, material);
          if (ready.status !== 'ready') fail(ready.reason_codes[0]);
          const quote = ready.unit_quote.units.find(value => value.unit_id === current.unit.unit_id);
          const checked = resolveSelectedVideoConnection(ctx, current.plan.capability);
          if (!sha(marker.request_hash) || ready.readiness_hash !== attempt.readiness_hash || quote?.amount !== attempt.quoted_amount
            || (ready.unit_quote.pricing_mode === 'free' ? 'no_charge' : 'paid') !== attempt.billing_mode
            || hashPlanValue(checked.binding) !== hashPlanValue(connection.binding)
            || material.bindings.production_pack_hash !== scope.productionPack.production_pack_hash) conflict();
          guard?.before(current, material);
          const now = new Date().toISOString();
          pending = { tenant_id: run.tenant_id, user_id: run.user_id, work_id: run.work_id, version_id: versionId,
            run_id: run.id, attempt_id: attempt.id, task_id: task.id, claim_hash: hashPlanValue(attempt.claim_token),
            expected_revision: input.expected_revision, plan_hash: run.plan_hash, quote_hash: attempt.quote_hash,
            request_hash: marker.request_hash, submit_started_at: now, connection: connection.binding.video,
            task_metadata_hash: hashPlanValue(task.metadata),
            output_contract: { durationMs: scope.productionPack.timeline.generated_duration_ms,
              audioMode: current.plan.capability.audio_mode, resolution: current.params.resolution, aspectRatio: current.params.aspect_ratio },
            production_pack_hash: scope.productionPack.production_pack_hash,
            prepared_materials_hash: material.prepared_materials.prepared_materials_hash };
          const quality = JSON.stringify({ schema_version: submissionSchema, submission: pending, observation: null });
          const expectedAttempt = { ...attempt, status: 'submitting', request_hash: marker.request_hash,
            submit_started_at: now, quality_json: quality, updated_at: now };
          const expectedTask = { ...task, status: 'processing', updated_at: now };
          const expectedRun = { ...run, revision: run.revision + 1, updated_at: now };
          const ledgerSnapshot = attempt.billing_mode === 'paid'
            ? bindingLedgerSnapshot(ctx.db, run.tenant_id, attempt.reservation_id) : null;
          if (ctx.db.prepare(`UPDATE redraw_execution_unit_attempts SET status='submitting',request_hash=?,submit_started_at=?,quality_json=?,updated_at=?
            WHERE id=? AND run_id=? AND task_id=? AND status='claimed' AND request_hash IS NULL AND submit_started_at IS NULL AND provider_task_id IS NULL`)
            .run(marker.request_hash, now, quality, now, attempt.id, run.id, task.id).changes !== 1) conflict();
          if (ctx.db.prepare(`UPDATE async_tasks SET status='processing',updated_at=?
            WHERE id=? AND type=? AND resource_id=? AND status='pending' AND provider_task_id IS NULL AND deleted_at IS NULL`)
            .run(now, task.id, unitTaskType, String(attempt.id)).changes !== 1) conflict();
          if (ctx.db.prepare(`UPDATE redraw_execution_runs SET revision=revision+1,updated_at=?
            WHERE id=? AND tenant_id=? AND user_id=? AND revision=? AND pause_requested=0 AND status IN ('ready','running')`)
            .run(now, run.id, run.tenant_id, run.user_id, input.expected_revision).changes !== 1) conflict();
          const after = runAuthority(ctx, versionId, runId);
          if (hashPlanValue(after.run) !== hashPlanValue(expectedRun)
            || hashPlanValue(after.attempts) !== hashPlanValue(current.original_attempts.map(value => value.id === attempt.id ? expectedAttempt : value))
            || hashPlanValue(ctx.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(task.id)) !== hashPlanValue(expectedTask)
            || (ledgerSnapshot && hashPlanValue(bindingLedgerSnapshot(ctx.db, run.tenant_id, attempt.reservation_id)) !== hashPlanValue(ledgerSnapshot))) conflict();
          // Marker writes can synchronously trigger connection/price changes. Recheck
          // them before this same transaction commits, using the pre-write revision.
          if (hashPlanValue(readinessFor(ctx, current, material)) !== hashPlanValue(ready)
            || hashPlanValue(resolveSelectedVideoConnection(ctx, current.plan.capability).binding) !== hashPlanValue(connection.binding)) conflict();
          guard?.after();
          return true;
        });
        submitted = pending;
        return result;
      },
    });
    return finishSubmittedObservation(ctx, submitted, observation, runtime, true);
  });
}

const advanceReadinessSchema = 'redraw-execution-run-advance-readiness-v1';

function assertActionContext(ctx) {
  if (!ctx?.db || typeof ctx.db.prepare !== 'function' || typeof ctx.db.transaction !== 'function'
    || !text(ctx.tenantId) || !text(ctx.userId)) fail('REDRAW_VERSION_NOT_FOUND');
}

function actionInput(versionId, runId, input) {
  const keys = ['expected_revision', 'expected_plan_hash', 'expected_quote_hash', 'expected_confirmation_hash'];
  if (!allowed(input, [...keys, 'output_parameters']) || keys.some(key => !Object.hasOwn(input, key))
    || !sha(input.expected_confirmation_hash)) fail('EXECUTION_RUN_INPUT_INVALID');
  const claimInput = { ...input }; delete claimInput.expected_confirmation_hash;
  return { ...readinessInput(versionId, runId, claimInput, true), expected_confirmation_hash: input.expected_confirmation_hash };
}

function actionPolicy(ctx, versionId) {
  const policy = ctx.db.prepare(`SELECT p.id AS project_id,p.execution_mode,p.policy_version FROM redraw_versions v
    JOIN redraw_works w ON w.id=v.work_id AND w.tenant_id=v.tenant_id AND w.user_id=v.user_id AND w.deleted_at IS NULL
    JOIN redraw_projects p ON p.id=w.project_id AND p.tenant_id=v.tenant_id AND p.user_id=v.user_id AND p.deleted_at IS NULL
    WHERE v.id=? AND v.tenant_id=? AND v.user_id=? AND v.deleted_at IS NULL`).get(versionId, ctx.tenantId, ctx.userId);
  if (!policy) fail('REDRAW_VERSION_NOT_FOUND');
  if (!['safe', 'auto'].includes(policy.execution_mode) || !positive(policy.policy_version)) conflict();
  return policy;
}

function actionBlocked(authority, reason) {
  const target = authority.attempts.find(attempt => attempt.status !== 'approved');
  return { schema_version: advanceReadinessSchema, status: 'blocked', executable: false,
    run_id: authority.run.id, run_revision: authority.run.revision, run_status: authority.run.status,
    pause_requested: authority.run.pause_requested === 1, attempt_id: target?.id ?? null,
    attempt_status: target?.status ?? null, reason_codes: [reason] };
}

function actionState(ctx, versionId, runId, input) {
  const authority = runAuthority(ctx, versionId, runId), { run, attempts } = authority;
  const policy = actionPolicy(ctx, versionId), params = parametersFor(authority, input);
  if (!['ready', 'running', 'paused'].includes(run.status)) return actionBlocked(authority, 'EXECUTION_RUN_STOPPED');
  const target = attempts.find(attempt => attempt.status !== 'approved');
  let phase = 'idle';
  if (target) {
    if (target.status !== 'claimed' || ['request_hash', 'submit_started_at', 'provider_task_id', 'quality_json',
      'output_asset_id', 'output_sha256', 'candidate_hash', 'approved_by', 'approved_at'].some(key => target[key] !== null)) {
      return actionBlocked(authority, 'EXECUTION_RUN_STOPPED');
    }
    phase = target.task_id === null ? 'claimed_unbound' : 'claimed_bound';
    if (phase === 'claimed_unbound' && target.reservation_id !== null) invalid();
  }
  const projected = { ...authority, run: run.pause_requested
    ? { ...run, pause_requested: 0, status: target ? 'running' : 'ready' } : run };
  let state;
  if (!target) state = nextReadyState(ctx, projected, params);
  else {
    const internal = { attempt_id: target.id, expected_revision: run.revision,
      expected_plan_hash: run.plan_hash, expected_quote_hash: target.quote_hash };
    state = phase === 'claimed_unbound' ? bindingState(ctx, versionId, runId, internal, projected)
      : dispatchState(ctx, versionId, runId, internal, projected);
  }
  if (state.status === 'blocked') return actionBlocked(authority, state.reason_codes[0]);
  return { ...state, actual_run: run, policy, phase, action: run.pause_requested ? 'resume' : 'advance' };
}

function actionConfirmation(state, readinessHash, quoteHash, revision = state.run.revision) {
  const { run, unit, phase, policy } = state;
  return hashPlanValue({ schema_version: 'redraw-execution-run-action-confirmation-v1', action: state.action,
    phase, attempt_id: phase === 'idle' ? null : state.target.id, tenant_id: run.tenant_id, user_id: run.user_id,
    work_id: run.work_id, version_id: run.version_id, run_id: run.id, queue_id: run.queue_id,
    review_id: run.review_id, plan_hash: run.plan_hash, queue_unit_id: unit.id, unit_id: unit.unit_id,
    unit_hash: unit.unit_hash, expected_revision: revision, output_parameters_hash: hashPlanValue(state.params),
    readiness_hash: readinessHash, quote_hash: quoteHash, policy });
}

function actionReadiness(ctx, state, material) {
  const ready = readinessFor(ctx, state, material);
  if (ready.status !== 'ready') return actionBlocked({ ...state, run: state.actual_run }, ready.reason_codes[0]);
  const quote = ready.unit_quote.units.find(value => value.unit_id === state.unit.unit_id);
  const billingMode = ready.unit_quote.pricing_mode === 'free' ? 'no_charge' : 'paid';
  if (state.target && (ready.readiness_hash !== state.target.readiness_hash
    || quote?.amount !== state.target.quoted_amount || billingMode !== state.target.billing_mode)) conflict();
  const quoteHash = state.target?.quote_hash ?? ready.quote_hash;
  return { schema_version: advanceReadinessSchema, status: 'ready', executable: false, action: state.action,
    phase: state.phase, run_id: state.run.id, run_revision: state.run.revision, plan_hash: state.run.plan_hash,
    unit_id: state.unit.unit_id, attempt_id: state.target?.id ?? null, output_parameters: state.params,
    amount: quote.amount, billing_mode: billingMode, quote_hash: quoteHash,
    confirmation_hash: actionConfirmation(state, ready.readiness_hash, quoteHash),
    policy: { execution_mode: state.policy.execution_mode, policy_version: state.policy.policy_version } };
}

function assertActionConfirmation(ready, input, action) {
  if (ready.status !== 'ready') fail(ready.reason_codes[0]);
  if (ready.action !== action || ready.run_revision !== input.expected_revision || ready.plan_hash !== input.expected_plan_hash
    || ready.quote_hash !== input.expected_quote_hash || ready.confirmation_hash !== input.expected_confirmation_hash) conflict();
}

async function inspectExecutionRunAdvanceReadiness(ctx, versionId, runId, rawInput = {}) {
  assertActionContext(ctx);
  const input = readinessInput(versionId, runId, rawInput);
  const initial = ctx.db.transaction(() => actionState(ctx, versionId, runId, input)).deferred();
  if (initial.status === 'blocked') return initial;
  return require('./redrawUnitReferenceDerivationService').consumePreparedUnitReferenceMaterials(ctx, materialBindings(initial), material => {
    const current = actionState(ctx, versionId, runId, input);
    if (current.status === 'blocked') return current;
    if (hashPlanValue(current) !== hashPlanValue(initial)) conflict();
    return actionReadiness(ctx, current, material);
  }, 'deferred');
}

function actionResult(ctx, versionId, runId, attemptId, changed) {
  const run = ownedRun(ctx, ownedVersion(ctx, versionId), runId);
  const attempt = attemptId == null ? null : ctx.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=? AND run_id=?').get(attemptId, run.id);
  if (attemptId != null && !attempt) invalid();
  return { run_id: run.id, run_revision: run.revision, run_status: run.status, pause_requested: run.pause_requested === 1,
    attempt_id: attempt?.id ?? null, attempt_status: attempt?.status ?? null,
    amount: attempt?.quoted_amount ?? null, billing_mode: attempt?.billing_mode ?? null, changed, executable: false };
}

async function resumeExecutionRun(ctx, versionId, runId, rawInput) {
  assertActionContext(ctx);
  const input = actionInput(versionId, runId, rawInput);
  const inspect = () => {
    const state = actionState(ctx, versionId, runId, input);
    if (state.status === 'blocked') fail(state.reason_codes[0]);
    if (state.action !== 'resume' || state.run.revision !== input.expected_revision
      || state.run.revision === Number.MAX_SAFE_INTEGER || state.run.plan_hash !== input.expected_plan_hash) conflict();
    return state;
  };
  const initial = ctx.db.transaction(inspect).deferred();
  return require('./redrawUnitReferenceDerivationService').consumePreparedUnitReferenceMaterials(ctx, materialBindings(initial), material => {
    const current = inspect();
    if (hashPlanValue(current) !== hashPlanValue(initial)) conflict();
    const ready = actionReadiness(ctx, current, material);
    assertActionConfirmation(ready, input, 'resume');
    const run = current.actual_run, now = new Date().toISOString(), status = current.target ? 'running' : 'ready';
    if (ctx.db.prepare(`UPDATE redraw_execution_runs SET pause_requested=0,status=?,revision=revision+1,updated_at=?
      WHERE id=? AND tenant_id=? AND user_id=? AND version_id=? AND revision=? AND pause_requested=1`)
      .run(status, now, run.id, run.tenant_id, run.user_id, versionId, run.revision).changes !== 1) conflict();
    const after = runAuthority(ctx, versionId, runId);
    if (hashPlanValue(after.run) !== hashPlanValue({ ...run, status, pause_requested: 0, revision: run.revision + 1, updated_at: now })
      || hashPlanValue(after.attempts) !== hashPlanValue(current.original_attempts ?? current.attempts)
      || hashPlanValue(actionPolicy(ctx, versionId)) !== hashPlanValue(current.policy)
      || hashPlanValue(getExecutionQueue(ctx, versionId)) !== hashPlanValue(current.current)
      || hashPlanValue(actionReadiness(ctx, current, material)) !== hashPlanValue(ready)) conflict();
    return actionResult(ctx, versionId, runId, current.target?.id, true);
  }, 'immediate');
}

function advanceReplay(ctx, versionId, runId, input) {
  const authority = runAuthority(ctx, versionId, runId), { run, attempts, units } = authority;
  const params = parametersFor(authority, input), policy = actionPolicy(ctx, versionId);
  const attempt = attempts.find(value => value.quote_hash === input.expected_quote_hash);
  if (!params || !attempt || run.plan_hash !== input.expected_plan_hash) return null;
  const unit = units.find(value => value.id === attempt.queue_unit_id), phases = [];
  // Original claim revision is proven by the stored claim confirmation, never inferred from the current counter.
  if (confirmationHash(run, unit, input.expected_revision, hashPlanValue(params), attempt.readiness_hash) === attempt.quote_hash) phases.push('idle');
  if (attempt.task_id !== null) {
    const task = ctx.db.prepare('SELECT metadata FROM async_tasks WHERE id=? AND deleted_at IS NULL').get(attempt.task_id);
    let metadata;
    try { metadata = JSON.parse(task?.metadata); } catch { invalid(); }
    if (metadata?.binding_revision === input.expected_revision) {
      taskBindingResult(ctx, authority, attempt, input); phases.push('claimed_unbound');
    }
  }
  if (attempt.submit_started_at !== null) {
    let envelope;
    try { envelope = JSON.parse(attempt.quality_json); } catch { invalid(); }
    if (envelope?.submission?.expected_revision === input.expected_revision) {
      dispatchReplay(ctx, versionId, runId, { attempt_id: attempt.id, expected_revision: input.expected_revision,
        expected_plan_hash: input.expected_plan_hash, expected_quote_hash: input.expected_quote_hash });
      phases.push('claimed_bound');
    }
  }
  for (const phase of phases) {
    const state = { run, unit, params, policy, phase, action: 'advance', target: attempt };
    if (actionConfirmation(state, attempt.readiness_hash, attempt.quote_hash, input.expected_revision) === input.expected_confirmation_hash) {
      return actionResult(ctx, versionId, runId, attempt.id, false);
    }
  }
  return null;
}

async function advanceExecutionRun(ctx, versionId, runId, rawInput, runtime = {}) {
  assertActionContext(ctx);
  const input = actionInput(versionId, runId, rawInput);
  if (!validTransportRuntime(runtime)) fail('EXECUTION_RUN_INPUT_INVALID');
  const replay = ctx.db.transaction(() => advanceReplay(ctx, versionId, runId, input)).deferred();
  if (replay) return replay;
  const initial = ctx.db.transaction(() => actionState(ctx, versionId, runId, input)).deferred();
  if (initial.status === 'blocked') fail(initial.reason_codes[0]);
  if (initial.action !== 'advance' || initial.run.revision !== input.expected_revision || initial.run.plan_hash !== input.expected_plan_hash) conflict();
  const assertPolicy = () => {
    if (hashPlanValue(actionPolicy(ctx, versionId)) !== hashPlanValue(initial.policy)) conflict();
  };
  let first = true, actionFailure;
  const actionGuard = check => (...args) => {
    try { return check(...args); }
    catch (error) { actionFailure = error; throw error; }
  };
  const guard = { before: actionGuard((state, material) => {
    assertPolicy();
    if (first) {
      const current = actionState(ctx, versionId, runId, input);
      if (current.status === 'blocked') fail(current.reason_codes[0]);
      if (hashPlanValue(current) !== hashPlanValue(initial)) conflict();
      assertActionConfirmation(actionReadiness(ctx, current, material), input, 'advance');
    }
  }), after: actionGuard(assertPolicy) };
  let attemptId = initial.target?.id;
  const internalInput = () => {
    assertPolicy();
    const run = ownedRun(ctx, ownedVersion(ctx, versionId), runId);
    return { attempt_id: attemptId, expected_revision: run.revision,
      expected_plan_hash: input.expected_plan_hash, expected_quote_hash: input.expected_quote_hash };
  };
  try {
    if (initial.phase === 'idle') {
      const claimInput = { ...input }; delete claimInput.expected_confirmation_hash;
      const claimed = await claimNextUnitCurrent(ctx, versionId, runId, claimInput, guard);
      attemptId = claimed.attempt_id; assertPolicy();
      if (!claimed.newly_claimed) return actionResult(ctx, versionId, runId, attemptId, false);
      first = false;
    }
    if (initial.phase !== 'claimed_bound') {
      const bound = await bindClaimedExecutionUnitTaskCurrent(ctx, versionId, runId, internalInput(), guard);
      assertPolicy();
      if (!bound.newly_bound) return actionResult(ctx, versionId, runId, attemptId, false);
      first = false;
    }
    const submitted = await dispatchClaimedExecutionUnitTaskCurrent(ctx, versionId, runId, internalInput(), runtime, guard);
    // The existing safe receipt may be the only surviving provider ID. Do not reread a failed database here.
    return { ...submitted, attempt_status: submitted.status, changed: submitted.newly_submitted === true };
  } catch (error) {
    // A lock loser may observe the other caller's committed stage. Only echo that proved original action.
    if (actionFailure) throw actionFailure;
    if (!first) throw error;
    const saved = ctx.db.transaction(() => advanceReplay(ctx, versionId, runId, input)).deferred();
    if (saved) return saved;
    throw error;
  }
}

module.exports = { createExecutionRun, getExecutionRun, listExecutionRuns, requestExecutionRunPause, inspectExecutionRunReadiness, claimNextUnit,
  bindClaimedExecutionUnitTask, dispatchClaimedExecutionUnitTask, recoverExecutionUnitTask,
  inspectExecutionRunAdvanceReadiness, resumeExecutionRun, advanceExecutionRun };
