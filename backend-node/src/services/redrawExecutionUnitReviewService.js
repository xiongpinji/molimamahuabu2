'use strict';

const path = require('node:path');
const { hashPlanValue: hash } = require('./redrawExecutionPlanService');
const { getExecutionQueue } = require('./redrawExecutionQueueService');
const { readCurrentUnitProductionPack } = require('./redrawUnitReferenceMaterialsInternal');
const { consumePreparedUnitReferenceMaterials } = require('./redrawUnitReferenceDerivationService');
const { probeVideo, assertExecutionUnitCandidate, assertExecutionUnitCandidateProbe, openExecutionUnitCandidate } = require('./redrawSourceConditioningService');

const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const same = (a, b) => hash(a) === hash(b);
const fail = (code = 'EXECUTION_UNIT_REVIEW_CONFLICT') => { throw Object.assign(new Error(code), { code }); };
const check = value => { if (!value) fail(); };
const json = value => { try { return JSON.parse(value); } catch { fail(); } };
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const freezeSnapshot = value => { if (Array.isArray(value) || plain(value)) { Object.values(value).forEach(freezeSnapshot); Object.freeze(value); } return value; };

function requiredChecks(pack, audioMode) {
  const keys = ['scene_action_continuity', 'source_text_and_caption_residue'];
  if (pack.parent_contexts.some(parent => parent.visible_character_ids.length)) keys.push('character_identity');
  if (audioMode === 'native') {
    if (pack.dialogues.length) {
      keys.push('target_dialogue_complete', 'speaker_order');
      if (Object.keys(pack.character_name_map).length) keys.push('target_names');
      keys.push('language_and_locale', 'voice_and_emotion', 'no_extra_dialogue');
      if (pack.dialogues.some(dialogue => pack.parent_contexts.some(parent => parent.visible_character_ids.length
        && parent.unit_start_ms < dialogue.unit_end_ms && parent.unit_end_ms > dialogue.unit_start_ms))) keys.push('lip_sync');
    } else keys.push('no_dialogue');
    keys.push('ambient_audio');
  }
  return keys;
}

function checkDecision(input, keys) {
  if (!exact(input, ['expected_revision', 'expected_candidate_hash', 'decision', 'checks'])
    || !nonnegative(input.expected_revision) || !sha(input.expected_candidate_hash)
    || !['approved', 'rejected'].includes(input.decision) || !exact(input.checks, keys)) fail('EXECUTION_UNIT_REVIEW_INPUT_INVALID');
  for (const value of Object.values(input.checks)) {
    if (!exact(value, ['basis', 'result']) || !['passed', 'failed', 'not_checked'].includes(value.result)
      || value.basis !== (value.result === 'not_checked' ? 'not_checked' : 'human_watch_listen')
      || (input.decision === 'approved' && value.result !== 'passed')) fail('EXECUTION_UNIT_REVIEW_INPUT_INVALID');
  }
}

function ledgerSnapshot(db, tenantId) {
  // Direct SELECT only: the ledger's public getters also call ensureSchema.
  return {
    account: db.prepare('SELECT * FROM tenant_credit_accounts WHERE tenant_id=?').get(tenantId),
    reservations: db.prepare('SELECT * FROM tenant_usage_reservations WHERE tenant_id=? ORDER BY id').all(tenantId),
    entries: db.prepare('SELECT * FROM tenant_credit_ledger WHERE tenant_id=? ORDER BY id').all(tenantId),
    allocations: db.prepare('SELECT * FROM tenant_usage_reservation_allocations WHERE tenant_id=? ORDER BY reservation_id').all(tenantId),
    buckets: db.prepare('SELECT * FROM tenant_daily_bonus_buckets WHERE tenant_id=? ORDER BY id').all(tenantId),
    memberships: db.prepare('SELECT * FROM tenant_recharge_memberships WHERE tenant_id=? ORDER BY id').all(tenantId),
  };
}

function reservationSnapshot(db, reservationId) {
  if (reservationId === null) return null;
  const allocation = db.prepare('SELECT * FROM tenant_usage_reservation_allocations WHERE reservation_id=?').get(reservationId);
  return { reservation: db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=?').get(reservationId), allocation,
    entries: db.prepare('SELECT * FROM tenant_credit_ledger WHERE reservation_id=? ORDER BY id').all(reservationId),
    bucket: allocation?.bonus_bucket_id ? db.prepare('SELECT * FROM tenant_daily_bonus_buckets WHERE id=?').get(allocation.bonus_bucket_id) : null };
}

function billingState(ctx, run, attempt, task, model) {
  const operation = `redraw_execution_unit:${attempt.id}`;
  const reservations = ctx.db.prepare(`SELECT * FROM tenant_usage_reservations WHERE tenant_id=?
    AND (id=? OR operation_key=? OR (resource_type='redraw_execution_unit' AND resource_id=?))`)
    .all(run.tenant_id, attempt.reservation_id, operation, String(attempt.id));
  if (attempt.billing_mode === 'no_charge') {
    check(attempt.quoted_amount === 0 && attempt.reservation_id === null && task.credit_reservation_id === null && !reservations.length);
    return { status: 'no_charge', amount: 0 };
  }
  check(attempt.billing_mode === 'paid' && positive(attempt.quoted_amount) && text(attempt.reservation_id)
    && task.credit_reservation_id === attempt.reservation_id && reservations.length === 1);
  const row = reservations[0];
  check(row.id === attempt.reservation_id && row.tenant_id === run.tenant_id && row.actor_user_id === run.user_id
    && row.resource_type === 'redraw_execution_unit' && row.resource_id === String(attempt.id)
    && row.operation_key === operation && row.model === model && row.amount === attempt.quoted_amount
    && row.status === (attempt.status === 'approved' ? 'confirmed' : 'held'));
  const allocation = ctx.db.prepare('SELECT * FROM tenant_usage_reservation_allocations WHERE reservation_id=?').get(row.id);
  if (allocation) {
    check(allocation.tenant_id === run.tenant_id && nonnegative(allocation.bonus_amount)
      && nonnegative(allocation.permanent_amount) && allocation.bonus_amount + allocation.permanent_amount === row.amount);
    if (allocation.bonus_bucket_id !== null) {
      const bucket = ctx.db.prepare('SELECT * FROM tenant_daily_bonus_buckets WHERE id=?').get(allocation.bonus_bucket_id);
      check(bucket && bucket.tenant_id === run.tenant_id && (row.status === 'confirmed' || bucket.held >= allocation.bonus_amount));
    } else check(allocation.bonus_amount === 0);
  }
  const entries = ctx.db.prepare('SELECT * FROM tenant_credit_ledger WHERE reservation_id=? ORDER BY id').all(row.id);
  check(entries.length === (row.status === 'confirmed' ? 2 : 1));
  for (const entry of entries) {
    check(entry.tenant_id === run.tenant_id && entry.actor_user_id === run.user_id && time(entry.created_at));
    check(entry.event_type === 'reserve'
      ? entry.available_delta === -row.amount && entry.held_delta === row.amount && entry.spent_delta === 0
      : row.status === 'confirmed' && entry.event_type === 'confirm' && entry.available_delta === 0
        && entry.held_delta === -row.amount && entry.spent_delta === row.amount && entry.reason === 'generation_completed');
  }
  check(entries.filter(entry => entry.event_type === 'reserve').length === 1);
  if (row.status === 'confirmed') check(row.reason === 'generation_completed');
  return { status: row.status, amount: row.amount };
}

function bindings(state) {
  const { run, unit } = state;
  return { version_id: run.version_id, review_id: run.review_id, queue_id: run.queue_id,
    plan_hash: run.plan_hash, unit_id: unit.unit_id, unit_hash: unit.unit_hash };
}

function readState(ctx, versionId, runId, unitId) {
  if (!ctx?.db || typeof ctx.db.prepare !== 'function' || !path.isAbsolute(String(ctx.storageRoot || ''))
    || !text(ctx.tenantId) || !text(ctx.userId) || !positive(versionId) || !positive(runId) || !text(unitId)) fail('EXECUTION_UNIT_REVIEW_INPUT_INVALID');
  const version = ctx.db.prepare(`SELECT v.*, w.project_id, p.execution_mode, p.policy_version FROM redraw_versions v
    JOIN redraw_works w ON w.id=v.work_id AND w.tenant_id=v.tenant_id AND w.user_id=v.user_id AND w.deleted_at IS NULL
    JOIN redraw_projects p ON p.id=w.project_id AND p.tenant_id=v.tenant_id AND p.user_id=v.user_id AND p.deleted_at IS NULL
    WHERE v.id=? AND v.tenant_id=? AND v.user_id=? AND v.deleted_at IS NULL`).get(versionId, ctx.tenantId, ctx.userId);
  if (!version) fail('REDRAW_VERSION_NOT_FOUND');
  const dto = require('./redrawExecutionRunService').getExecutionRun(ctx, versionId, runId);
  const run = ctx.db.prepare('SELECT * FROM redraw_execution_runs WHERE id=?').get(runId);
  check(dto.binding_status === 'current' && ['safe', 'auto'].includes(version.execution_mode) && positive(version.policy_version));
  const queue = getExecutionQueue(ctx, versionId);
  check(queue.queue?.id === run.queue_id && queue.queue.status === 'waiting_readiness'
    && queue.saved_review?.id === run.review_id && queue.saved_review.status === 'current' && queue.preview.plan_hash === run.plan_hash);
  const units = ctx.db.prepare('SELECT * FROM redraw_execution_queue_units WHERE queue_id=? ORDER BY ordinal').all(run.queue_id);
  const unit = units.find(value => value.unit_id === unitId);
  if (!unit) fail('EXECUTION_UNIT_CANDIDATE_NOT_FOUND');
  const attempts = ctx.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE run_id=? ORDER BY id').all(run.id);
  const selected = attempts.filter(value => value.queue_unit_id === unit.id);
  if (selected.length !== 1 || selected[0].output_asset_id === null) fail('EXECUTION_UNIT_CANDIDATE_NOT_FOUND');
  const attempt = selected[0];
  check(['waiting_review', 'approved', 'rejected'].includes(attempt.status) && attempt.attempt_no === 1 && attempt.unit_hash === unit.unit_hash);
  const envelope = json(attempt.quality_json);
  check(plain(envelope) && envelope.schema_version === 'redraw-execution-unit-submission-v1'
    && Reflect.ownKeys(envelope).every(key => ['schema_version', 'submission', 'observation', 'download_started_at', 'candidate', 'review'].includes(key))
    && time(envelope.download_started_at));
  const submission = envelope.submission, candidate = envelope.candidate;
  check(plain(submission) && submission.tenant_id === run.tenant_id && submission.user_id === run.user_id
    && submission.work_id === run.work_id && submission.version_id === versionId && submission.run_id === run.id
    && submission.attempt_id === attempt.id && submission.task_id === attempt.task_id
    && submission.claim_hash === hash(attempt.claim_token) && submission.request_hash === attempt.request_hash
    && sha(submission.request_hash) && submission.submit_started_at === attempt.submit_started_at && time(submission.submit_started_at)
    && submission.plan_hash === run.plan_hash && submission.quote_hash === attempt.quote_hash
    && nonnegative(submission.expected_revision) && submission.expected_revision < run.revision
    && sha(submission.prepared_materials_hash));
  const state = { version, run, units, attempts, unit, attempt, envelope };
  const pack = readCurrentUnitProductionPack(ctx, bindings(state));
  const plan = queue.saved_review.plan;
  check(submission.production_pack_hash === pack.production_pack_hash && same(submission.output_contract, {
    durationMs: pack.timeline.generated_duration_ms, audioMode: plan.capability.audio_mode,
    resolution: dto.output_parameters.resolution, aspectRatio: dto.output_parameters.aspect_ratio }));
  check(exact(submission.connection, ['config_id', 'config_updated_at', 'provider', 'protocol', 'model', 'connection_fingerprint'])
    && sha(submission.connection.connection_fingerprint));
  for (const key of ['config_id', 'config_updated_at', 'provider', 'protocol', 'model']) check(submission.connection[key] === plan.capability[key]);
  const task = ctx.db.prepare('SELECT * FROM async_tasks WHERE id=? AND deleted_at IS NULL').get(attempt.task_id);
  check(task && task.type === 'redraw_execution_unit' && task.resource_id === String(attempt.id)
    && task.tenant_id === run.tenant_id && task.user_id === run.user_id && task.model === plan.capability.model
    && task.status === (attempt.status === 'approved' ? 'completed' : 'needs_attention')
    && task.provider_task_id === attempt.provider_task_id && text(attempt.provider_task_id)
    && hash(task.metadata) === submission.task_metadata_hash);
  if (task.result !== null) check(same(json(task.result), {
    schema_version: 'redraw-execution-unit-safe-receipt-v1', tenant_id: run.tenant_id, user_id: run.user_id,
    work_id: run.work_id, version_id: versionId, run_id: run.id, attempt_id: attempt.id, task_id: task.id,
    request_hash: attempt.request_hash, submit_started_at: attempt.submit_started_at,
    provider_task_id: attempt.provider_task_id, status: 'needs_attention', reason_code: 'PROVIDER_RECEIPT_PERSISTENCE_FAILED' }));
  const metadata = json(task.metadata);
  check(nonnegative(metadata?.binding_revision) && metadata.binding_revision < submission.expected_revision
    && same(metadata, { schema_version: 'redraw-execution-unit-task-binding-v1', tenant_id: run.tenant_id,
      user_id: run.user_id, work_id: run.work_id, version_id: versionId, run_id: run.id, attempt_id: attempt.id,
      queue_id: run.queue_id, queue_unit_id: unit.id, unit_id: unitId, unit_hash: unit.unit_hash,
      review_id: run.review_id, plan_hash: run.plan_hash, quote_hash: attempt.quote_hash, binding_revision: metadata.binding_revision }));
  check(envelope.observation?.status === 'completed_candidate' && envelope.observation.provider_task_id === attempt.provider_task_id);
  check(exact(candidate, ['asset_id', 'relative_path', 'sha256', 'bytes', 'mime_type', 'duration_ms', 'width', 'height',
    'video_codec', 'audio_codec', 'review_status', 'qa_status']) && candidate.asset_id === attempt.output_asset_id
    && candidate.sha256 === attempt.output_sha256 && positive(candidate.bytes) && positive(candidate.duration_ms)
    && positive(candidate.width) && positive(candidate.height) && text(candidate.video_codec)
    && (candidate.audio_codec === null || text(candidate.audio_codec)) && candidate.mime_type === 'video/mp4'
    && candidate.review_status === 'pending' && candidate.qa_status === 'not_checked'
    && attempt.candidate_hash === hash({ request_hash: attempt.request_hash, candidate }));
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id=? AND deleted_at IS NULL').get(candidate.asset_id);
  check(asset && asset.type === 'video' && asset.category === 'redraw_execution_unit_candidate'
    && asset.drama_id === null && asset.storyboard_id === null && asset.video_gen_id === null && asset.image_gen_id === null
    && asset.local_path === candidate.relative_path && asset.file_size === candidate.bytes && asset.mime_type === candidate.mime_type
    && asset.width === candidate.width && asset.height === candidate.height && asset.duration === candidate.duration_ms / 1000
    && same(json(asset.metadata), { schema_version: 'redraw-execution-unit-candidate-v1', tenant_id: run.tenant_id,
      user_id: run.user_id, work_id: run.work_id, version_id: versionId, run_id: run.id, attempt_id: attempt.id,
      task_id: task.id, request_hash: attempt.request_hash, sha256: candidate.sha256, review_status: 'pending' }));
  assertExecutionUnitCandidate({ storageRoot: ctx.storageRoot, runId, attemptId: attempt.id }, candidate);
  return { ...state, task, asset, pack, plan, billing: billingState(ctx, run, attempt, task, plan.capability.model),
    required_checks: requiredChecks(pack, plan.capability.audio_mode),
    queue_row: ctx.db.prepare('SELECT * FROM redraw_execution_queues WHERE id=?').get(run.queue_id),
    plan_review: ctx.db.prepare('SELECT * FROM redraw_execution_plan_reviews WHERE id=?').get(run.review_id) };
}

function reviewBindings(state) {
  const { run, unit, attempt, envelope, version } = state;
  return { tenant_id: run.tenant_id, user_id: run.user_id, work_id: run.work_id, version_id: run.version_id,
    project_id: version.project_id, run_id: run.id, queue_id: run.queue_id, review_id: run.review_id,
    queue_unit_id: unit.id, unit_id: unit.unit_id, unit_hash: unit.unit_hash, attempt_id: attempt.id,
    task_id: attempt.task_id, request_hash: attempt.request_hash, candidate_hash: attempt.candidate_hash,
    output_asset_id: attempt.output_asset_id, output_sha256: attempt.output_sha256, plan_hash: run.plan_hash,
    production_pack_hash: state.pack.production_pack_hash, prepared_materials_hash: envelope.submission.prepared_materials_hash,
    output_contract_hash: hash(envelope.submission.output_contract) };
}

function reviewPolicy(state) {
  return { execution_mode: state.version.execution_mode, policy_version: state.version.policy_version, human_required: true,
    reason_codes: [state.unit.ordinal === 0 ? 'first_unit' : 'machine_content_evidence_missing'] };
}

function assertTechnical(state, probe) {
  check(exact(probe, ['durationMs', 'width', 'height', 'videoCodec', 'audioCodec', 'displayWidth'])
    && positive(probe.durationMs) && positive(probe.width) && positive(probe.height)
    && Number.isFinite(probe.displayWidth) && probe.displayWidth > 0);
  assertExecutionUnitCandidateProbe(state.envelope.submission.output_contract, probe);
  const candidate = state.envelope.candidate;
  check(candidate.duration_ms === probe.durationMs && candidate.width === probe.width && candidate.height === probe.height
    && candidate.video_codec === probe.videoCodec && candidate.audio_codec === probe.audioCodec);
}

function assertStoredReview(state) {
  const { attempt, envelope } = state, review = envelope.review;
  if (attempt.status === 'waiting_review') { check(review === undefined && attempt.approved_by === null && attempt.approved_at === null); return; }
  check(exact(review, ['schema_version', 'bindings', 'expected_revision', 'decision', 'required_checks', 'checks', 'policy',
    'technical_qa', 'machine_content_qa', 'reviewed_by', 'reviewed_at', 'review_hash'])
    && review.schema_version === 'redraw-execution-unit-review-v1' && review.review_hash === hash(without(review, ['review_hash']))
    && same(review.bindings, reviewBindings(state)) && same(review.required_checks, state.required_checks)
    && same(review.policy, reviewPolicy(state)) && review.reviewed_by === state.run.user_id && time(review.reviewed_at)
    && review.machine_content_qa === 'not_available' && review.decision === (attempt.status === 'approved' ? 'approved' : 'rejected')
    && review.expected_revision < state.run.revision);
  checkDecision({ expected_revision: review.expected_revision, expected_candidate_hash: attempt.candidate_hash,
    decision: review.decision, checks: review.checks }, state.required_checks);
  check(review.technical_qa?.status === 'passed' && review.technical_qa.method === 'ffprobe');
  assertTechnical(state, review.technical_qa.probe);
  check(attempt.status === 'approved'
    ? attempt.approved_by === review.reviewed_by && attempt.approved_at === review.reviewed_at
    : attempt.approved_by === null && attempt.approved_at === null);
}

function publicCandidate(state, technical, newlyReviewed) {
  const candidate = state.envelope.candidate, review = state.envelope.review;
  return { schema_version: 'redraw-execution-unit-candidate-review-v1', run_id: state.run.id, run_revision: state.run.revision,
    unit_id: state.unit.unit_id, ordinal: state.unit.ordinal, attempt_id: state.attempt.id, status: state.attempt.status,
    candidate_hash: state.attempt.candidate_hash, asset: { id: candidate.asset_id,
      ...without(candidate, ['asset_id', 'relative_path', 'review_status', 'qa_status']) },
    output_contract: structuredClone(state.envelope.submission.output_contract), billing: state.billing,
    required_checks: [...state.required_checks], review_policy: reviewPolicy(state), technical_qa: technical,
    content_qa: { status: review && Object.values(review.checks).every(value => value.result !== 'not_checked')
      ? 'human_reviewed' : 'requires_human_review', machine_evidence: 'not_available',
      final_audio_review: state.plan.capability.audio_mode === 'replace' ? 'deferred_to_composition' : 'not_composed' },
    target_contract: { character_name_map: structuredClone(state.pack.character_name_map),
      dialogues: state.pack.dialogues.map(value => ({ target_speaker_name: value.target_speaker_name, target_text: value.target_text,
        unit_start_ms: value.unit_start_ms, unit_end_ms: value.unit_end_ms, emotion: value.emotion, pronunciation_hint: value.pronunciation_hint })),
      shots: state.pack.parent_contexts.map(value => ({ unit_start_ms: value.unit_start_ms, unit_end_ms: value.unit_end_ms,
        composition: value.composition, camera_movement: value.camera_movement, opening_state: value.opening_state,
        continuous_action: value.continuous_action, ending_state: value.ending_state })) },
    review: review ? { decision: review.decision, checks: structuredClone(review.checks), reviewed_by: review.reviewed_by,
      reviewed_at: review.reviewed_at, review_hash: review.review_hash } : null,
    ...(newlyReviewed === undefined ? {} : { newly_reviewed: newlyReviewed }) };
}

async function withCandidate(ctx, versionId, runId, unitId, consumer, mode) {
  if (!ctx?.db || typeof ctx.db.transaction !== 'function') fail('EXECUTION_UNIT_REVIEW_INPUT_INVALID');
  let originalReservation;
  const initial = ctx.db.transaction(() => {
    const state = readState(ctx, versionId, runId, unitId);
    originalReservation = reservationSnapshot(ctx.db, state.attempt.reservation_id);
    return state;
  }).deferred();
  let probe;
  try {
    probe = await probeVideo(path.resolve(ctx.storageRoot, initial.envelope.candidate.relative_path), {}, { resultGeometry: true });
  } catch (error) {
    // A changed/missing candidate is a conflict; an unchanged file does not turn
    // a tool or system failure into a business rejection. Do not probe again.
    assertExecutionUnitCandidate({ storageRoot: ctx.storageRoot, runId, attemptId: initial.attempt.id }, initial.envelope.candidate);
    throw error;
  }
  assertTechnical(initial, probe);
  const technical = { status: 'passed', method: 'ffprobe', probe };
  return consumePreparedUnitReferenceMaterials(ctx, bindings(initial), material => {
    const state = readState(ctx, versionId, runId, unitId);
    check(same(state, initial) && same(originalReservation, reservationSnapshot(ctx.db, state.attempt.reservation_id))
      && material.status === 'prepared'
      && material.prepared_materials.prepared_materials_hash === state.envelope.submission.prepared_materials_hash);
    assertStoredReview(state);
    return consumer(state, technical);
  }, mode);
}

async function getExecutionUnitCandidate(ctx, versionId, runId, unitId) {
  return withCandidate(ctx, versionId, runId, unitId, (state, technical) => publicCandidate(state, technical), 'deferred');
}

async function prepareExecutionUnitCandidateMedia(ctx, versionId, runId, unitId, expectedHash) {
  if (!sha(expectedHash)) fail('EXECUTION_UNIT_REVIEW_INPUT_INVALID');
  let handle;
  try {
    return await withCandidate(ctx, versionId, runId, unitId, state => {
      check(state.attempt.candidate_hash === expectedHash);
      const reservation = reservationSnapshot(ctx.db, state.attempt.reservation_id);
      handle = openExecutionUnitCandidate({ storageRoot: ctx.storageRoot, runId, attemptId: state.attempt.id }, state.envelope.candidate);
      return { ...handle, assertCurrentBinding() {
        ctx.db.transaction(() => {
          const current = readState(ctx, versionId, runId, unitId);
          check(same(current, state) && same(reservation, reservationSnapshot(ctx.db, state.attempt.reservation_id)));
          assertStoredReview(current);
          handle.assertCurrentBinding();
        }).deferred();
      } };
    }, 'deferred');
  } catch (error) { handle?.cleanup(); throw error; }
}

function assertConfirmedDelta(before, after, reservationId) {
  const original = before.reservations.find(row => row.id === reservationId);
  const row = after.reservations.find(value => value.id === reservationId);
  check(original?.status === 'held' && row?.status === 'confirmed' && row.reason === 'generation_completed' && time(row.updated_at));
  const now = row.updated_at, amount = original.amount;
  const oldIds = new Set(before.entries.map(value => value.id));
  const added = after.entries.filter(value => !oldIds.has(value.id));
  check(added.length === 1);
  check(same(added[0], { id: added[0].id, reservation_id: reservationId, tenant_id: original.tenant_id,
    actor_user_id: original.actor_user_id, event_type: 'confirm', available_delta: 0, held_delta: -amount,
    spent_delta: amount, reason: 'generation_completed', created_at: now }));
  const allocation = before.allocations.find(value => value.reservation_id === reservationId);
  const expected = { ...before,
    account: { ...before.account, held: before.account.held - amount, spent: before.account.spent + amount, updated_at: now },
    reservations: before.reservations.map(value => value.id === reservationId
      ? { ...value, status: 'confirmed', reason: 'generation_completed', updated_at: now } : value),
    entries: [...before.entries, added[0]].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    buckets: before.buckets.map(value => allocation?.bonus_amount > 0 && value.id === allocation.bonus_bucket_id
      ? { ...value, held: value.held - allocation.bonus_amount, spent: value.spent + allocation.bonus_amount, updated_at: now } : value) };
  check(same(expected, after));
}

function assertPredecessors(ctx, state) {
  // No future or missing attempt can be hidden by a collection of approved labels.
  check(state.attempts.length === state.unit.ordinal + 1);
  for (const unit of state.units.slice(0, state.unit.ordinal)) {
    const predecessor = state.attempts.find(value => value.queue_unit_id === unit.id);
    check(predecessor);
    assertApprovedExecutionUnit(ctx, state, predecessor);
  }
}

async function reviewExecutionUnitCandidate(ctx, versionId, runId, unitId, input) {
  return withCandidate(ctx, versionId, runId, unitId, (state, technical) => {
    checkDecision(input, state.required_checks);
    const { run, attempt, task, envelope } = state;
    check(input.expected_candidate_hash === attempt.candidate_hash);
    if (envelope.review) {
      check(input.decision === envelope.review.decision && same(input.checks, envelope.review.checks)
        && [envelope.review.expected_revision, run.revision].includes(input.expected_revision));
      return publicCandidate(state, technical, false);
    }
    check(run.revision === input.expected_revision && run.revision < Number.MAX_SAFE_INTEGER
      && ['waiting_review', 'paused'].includes(run.status));
    if (input.decision === 'approved') assertPredecessors(ctx, state);
    const now = new Date().toISOString();
    const review = { schema_version: 'redraw-execution-unit-review-v1', bindings: reviewBindings(state),
      expected_revision: input.expected_revision, decision: input.decision, required_checks: state.required_checks,
      checks: structuredClone(input.checks), policy: reviewPolicy(state), technical_qa: technical,
      machine_content_qa: 'not_available', reviewed_by: ctx.userId, reviewed_at: now };
    review.review_hash = hash(review);
    const approved = input.decision === 'approved';
    const nextAttempt = { ...attempt, status: input.decision, quality_json: JSON.stringify({ ...envelope, review }),
      approved_by: approved ? ctx.userId : null, approved_at: approved ? now : null, updated_at: now };
    const nextTask = { ...task, status: approved ? 'completed' : 'needs_attention', updated_at: now };
    const allApproved = approved && state.units.every(unit => unit.id === state.unit.id
      || state.attempts.some(value => value.queue_unit_id === unit.id && value.status === 'approved'));
    const nextRun = { ...run, status: !approved ? 'needs_attention' : allApproved ? 'completed' : run.pause_requested ? 'paused' : 'ready',
      revision: run.revision + 1, updated_at: now };
    const beforeLedger = ledgerSnapshot(ctx.db, run.tenant_id);
    if (approved && attempt.billing_mode === 'paid') {
      require('./creditLedgerService').confirmForScope(ctx.db, attempt.reservation_id, { tenantId: run.tenant_id });
    }
    check(ctx.db.prepare(`UPDATE redraw_execution_unit_attempts SET status=?,quality_json=?,approved_by=?,approved_at=?,updated_at=?
      WHERE id=? AND run_id=? AND status='waiting_review' AND quality_json=? AND candidate_hash=? AND task_id=?`)
      .run(nextAttempt.status, nextAttempt.quality_json, nextAttempt.approved_by, nextAttempt.approved_at, now,
        attempt.id, run.id, attempt.quality_json, attempt.candidate_hash, task.id).changes === 1);
    check(ctx.db.prepare(`UPDATE async_tasks SET status=?,updated_at=? WHERE id=? AND status='needs_attention'
      AND metadata=? AND credit_reservation_id IS ? AND provider_task_id=? AND deleted_at IS NULL`)
      .run(nextTask.status, now, task.id, task.metadata, task.credit_reservation_id, task.provider_task_id).changes === 1);
    check(ctx.db.prepare(`UPDATE redraw_execution_runs SET status=?,revision=revision+1,updated_at=?
      WHERE id=? AND tenant_id=? AND user_id=? AND revision=? AND pause_requested=? AND status=?`)
      .run(nextRun.status, now, run.id, run.tenant_id, run.user_id, input.expected_revision, run.pause_requested, run.status).changes === 1);
    const after = readState(ctx, versionId, runId, unitId);
    const expected = { ...state, run: nextRun, attempt: nextAttempt, task: nextTask,
      attempts: state.attempts.map(value => value.id === attempt.id ? nextAttempt : value),
      envelope: { ...envelope, review }, billing: approved && attempt.billing_mode === 'paid'
        ? { status: 'confirmed', amount: attempt.quoted_amount } : state.billing };
    check(same(after, expected));
    assertStoredReview(after);
    if (approved) assertPredecessors(ctx, after);
    const afterLedger = ledgerSnapshot(ctx.db, run.tenant_id);
    if (approved && attempt.billing_mode === 'paid') assertConfirmedDelta(beforeLedger, afterLedger, attempt.reservation_id);
    else check(same(beforeLedger, afterLedger));
    return publicCandidate(after, technical, true);
  }, 'immediate');
}

function assertApprovedExecutionUnit(ctx, authority, attempt) {
  const unit = authority.units.find(value => value.id === attempt.queue_unit_id);
  check(unit && attempt.status === 'approved');
  const state = readState(ctx, authority.run.version_id, authority.run.id, unit.unit_id);
  check(same(state.attempt, attempt));
  assertStoredReview(state);
  return true;
}

async function prepareApprovedExecutionUnitMedia(ctx, versionId, runId, unitId, expectedCandidateHash) {
  if (!sha(expectedCandidateHash)) fail('EXECUTION_UNIT_REVIEW_INPUT_INVALID');
  let handle;
  try {
    return await withCandidate(ctx, versionId, runId, unitId, state => {
      check(state.attempt.candidate_hash === expectedCandidateHash);
      assertApprovedExecutionUnit(ctx, state, state.attempt);
      const reservation = reservationSnapshot(ctx.db, state.attempt.reservation_id);
      handle = openExecutionUnitCandidate({ storageRoot: ctx.storageRoot, runId, attemptId: state.attempt.id }, state.envelope.candidate);
      const candidate = state.envelope.candidate;
      return freezeSnapshot({
        schema_version: 'redraw-approved-execution-unit-media-v1',
        bindings: reviewBindings(state),
        run_revision: state.run.revision,
        ordinal: state.unit.ordinal,
        candidate: {
          hash: state.attempt.candidate_hash,
          sha256: candidate.sha256,
          bytes: candidate.bytes,
          mime_type: candidate.mime_type,
          duration_ms: candidate.duration_ms,
          width: candidate.width,
          height: candidate.height,
          video_codec: candidate.video_codec,
          audio_codec: candidate.audio_codec,
        },
        review_hash: state.envelope.review.review_hash,
        audio_mode: state.plan.capability.audio_mode,
        timeline: structuredClone(state.pack.timeline),
        parent_shots: structuredClone(state.pack.parent_contexts),
        dialogues: structuredClone(state.pack.dialogues),
        size: handle.size,
        sha256: handle.sha256,
        mime: handle.mime,
        createReadStream: handle.createReadStream,
        cleanup: handle.cleanup,
        assertCurrentBinding() {
          ctx.db.transaction(() => {
            const current = readState(ctx, versionId, runId, unitId);
            check(same(current, state) && same(reservation, reservationSnapshot(ctx.db, state.attempt.reservation_id)));
            assertApprovedExecutionUnit(ctx, current, current.attempt);
            handle.assertCurrentBinding();
          }).deferred();
        },
      });
    }, 'deferred');
  } catch (error) { handle?.cleanup(); throw error; }
}

module.exports = { getExecutionUnitCandidate, prepareExecutionUnitCandidateMedia, reviewExecutionUnitCandidate,
  assertApprovedExecutionUnit, prepareApprovedExecutionUnitMedia };
