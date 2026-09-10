'use strict';

const { isDeepStrictEqual } = require('node:util');
const { hashPlanValue } = require('./redrawExecutionPlanService');
const { validateSavedPlan } = require('./redrawExecutionPlanReviewService');
const { assertBlueprintLockable } = require('./redrawEpisodeBlueprintService');
const {
  episodeLocalizationHash,
  assertSafeLocalizationReviewValue,
} = require('./localizationService');

const HEX_64 = /^[a-f0-9]{64}$/;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const sha = (value) => typeof value === 'string' && HEX_64.test(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function fail(code, reason) {
  throw Object.assign(new Error(`unit production pack ${reason}`), { code });
}

const invalid = () => fail('REDRAW_UNIT_PRODUCTION_PACK_INVALID', 'invalid');
const stale = () => fail('REDRAW_UNIT_PRODUCTION_PACK_STALE', 'stale');

function validOwner(owner) {
  return object(owner) && text(owner.tenantId) && text(owner.userId)
    && positive(owner.workId) && positive(owner.versionId);
}

function validExpected(expected) {
  return object(expected) && positive(expected.review_id) && positive(expected.queue_id)
    && sha(expected.plan_hash) && text(expected.unit_id) && sha(expected.unit_hash);
}

function assertUnitStructure(unit) {
  if (!object(unit) || !text(unit.id)
    || !nonnegative(unit.source_start_ms) || !positive(unit.source_end_ms)
    || unit.source_end_ms <= unit.source_start_ms
    || unit.retained_duration_ms !== unit.source_end_ms - unit.source_start_ms
    || !positive(unit.generated_duration_ms) || unit.generated_duration_ms < unit.retained_duration_ms
    || unit.padding_ms !== unit.generated_duration_ms - unit.retained_duration_ms
    || !Array.isArray(unit.parent_shots) || unit.parent_shots.length === 0
    || !Array.isArray(unit.dialogues) || !Array.isArray(unit.reference_requirements)) invalid();
  let end = unit.source_start_ms;
  const parentIds = new Set();
  for (const parent of unit.parent_shots) {
    if (!object(parent) || !text(parent.id) || parentIds.has(parent.id) || !sha(parent.contract_hash)
      || parent.source_start_ms !== end || !positive(parent.source_end_ms)
      || parent.source_end_ms <= end || parent.source_end_ms > unit.source_end_ms
      || parent.unit_start_ms !== parent.source_start_ms - unit.source_start_ms
      || parent.unit_end_ms !== parent.source_end_ms - unit.source_start_ms) invalid();
    parentIds.add(parent.id);
    end = parent.source_end_ms;
  }
  if (end !== unit.source_end_ms) invalid();
  for (const dialogue of unit.dialogues) {
    if (!object(dialogue) || !nonnegative(dialogue.start_ms) || !positive(dialogue.end_ms)
      || dialogue.start_ms < unit.source_start_ms || dialogue.end_ms > unit.source_end_ms
      || dialogue.end_ms <= dialogue.start_ms
      || dialogue.unit_start_ms !== dialogue.start_ms - unit.source_start_ms
      || dialogue.unit_end_ms !== dialogue.end_ms - unit.source_start_ms
      || !Number.isFinite(dialogue.estimated_duration_ms) || dialogue.estimated_duration_ms <= 0
      || dialogue.estimated_duration_ms > dialogue.end_ms - dialogue.start_ms) invalid();
  }
}

function assertQueueState(owner, expected, queueState) {
  if (!object(queueState) || !object(queueState.preview)
    || !object(queueState.saved_review) || !object(queueState.queue)) invalid();
  const { preview, saved_review: review, queue } = queueState;
  if (!positive(review.id) || !sha(review.plan_hash) || review.status !== 'current'
    || !object(review.plan) || !positive(queue.id) || !positive(queue.work_id)
    || !positive(queue.version_id) || !sha(queue.plan_hash)
    || !Array.isArray(queue.units) || !Array.isArray(queue.execution_blockers)) invalid();
  if (review.id !== expected.review_id || queue.id !== expected.queue_id
    || preview.plan_hash !== expected.plan_hash || review.plan_hash !== expected.plan_hash
    || queue.plan_hash !== expected.plan_hash || queue.status !== 'waiting_readiness'
    || queue.executable !== false || queue.work_id !== owner.workId || queue.version_id !== owner.versionId) stale();
  const plan = review.plan;
  if (!Array.isArray(plan.units)) invalid();
  plan.units.forEach(assertUnitStructure);
  const selected = queue.units.find((unit) => unit?.id === expected.unit_id);
  if (!selected || !object(selected.plan_unit)) stale();
  assertUnitStructure(selected.plan_unit);
  if (selected.unit_hash !== expected.unit_hash || selected.status !== 'pending'
    || !sha(selected.unit_hash) || selected.unit_hash !== hashPlanValue(selected.plan_unit)) stale();
  const checkRow = {
    id: review.id,
    tenant_id: owner.tenantId,
    user_id: owner.userId,
    work_id: owner.workId,
    version_id: owner.versionId,
    plan_hash: review.plan_hash,
    created_at: review.saved_at,
  };
  if (!validateSavedPlan(plan, checkRow, {
    tenantId: owner.tenantId,
    userId: owner.userId,
  }, {
    id: owner.versionId,
    work_id: owner.workId,
  })) stale();
  if (!isDeepStrictEqual(preview, plan)
    || !isDeepStrictEqual(queue.execution_blockers, plan.execution_blockers)
    || queue.units.length !== plan.units.length) stale();
  for (const [ordinal, publicUnit] of queue.units.entries()) {
    const planUnit = plan.units[ordinal];
    if (!object(publicUnit) || publicUnit.ordinal !== ordinal || publicUnit.id !== planUnit?.id
      || publicUnit.status !== 'pending' || !sha(publicUnit.unit_hash)
      || publicUnit.unit_hash !== hashPlanValue(planUnit)
      || !isDeepStrictEqual(publicUnit.plan_unit, planUnit)) stale();
  }
  if (!isDeepStrictEqual(selected.plan_unit, plan.units[selected.ordinal])) stale();
  return { plan, selected };
}

function assertCurrentBindings(owner, plan, blueprint, localization) {
  try {
    assertBlueprintLockable(blueprint);
  } catch (error) {
    if (error?.code === 'BLUEPRINT_HASH_MISMATCH') stale();
    if (error?.code) throw error;
    invalid();
  }
  if (!object(localization)) invalid();
  assertSafeLocalizationReviewValue(localization);
  const bindings = plan.bindings;
  if (!object(bindings) || bindings.tenant_id !== owner.tenantId
    || bindings.user_id !== owner.userId || bindings.work_id !== owner.workId
    || bindings.version_id !== owner.versionId || blueprint.blueprint_hash !== bindings.blueprint_hash
    || String(blueprint.source?.asset_id) !== String(bindings.source_asset_id)
    || blueprint.source?.sha256 !== bindings.source_sha256
    || localization.schema_version !== 'episode-localization-v1'
    || localization.blueprint_hash !== blueprint.blueprint_hash
    || localization.localization_hash !== bindings.localization_hash
    || episodeLocalizationHash(localization) !== bindings.localization_hash
    || localization.review?.status !== bindings.localization_review_status
    || plan.capability?.capability_hash !== bindings.capability_hash) stale();
}

function assertDialogueCoverage(plan, blueprint, localization) {
  const blueprintIds = blueprint.shots.flatMap((shot) => shot.dialogue.map((turn) => turn.id)).sort();
  const localizationIds = Array.isArray(localization.dialogue_map)
    ? localization.dialogue_map.map((turn) => turn?.source_dialogue_id).sort() : null;
  const planIds = plan.units.flatMap((unit) => unit.dialogues.map((turn) => turn.id)).sort();
  if (!localizationIds || !blueprintIds.every(text) || !localizationIds.every(text) || !planIds.every(text)
    || !isDeepStrictEqual(localizationIds, blueprintIds) || !isDeepStrictEqual(planIds, blueprintIds)) stale();
}

function referenceGroups(blueprint, localization) {
  const characters = new Map(blueprint.characters.map((character) => [character.id, character]));
  return blueprint.shots.map((shot) => ([
    ...shot.visible_character_ids.map((id) => ({
      id: `identity-${id}`,
      kind: 'image',
      requirement_hash: hashPlanValue({
        character: characters.get(id),
        target_name: localization.character_name_map?.[id] || '',
      }),
    })),
    {
      id: `motion-${shot.id}`,
      kind: 'video',
      requirement_hash: hashPlanValue({
        source: blueprint.source,
        start_ms: shot.start_ms,
        end_ms: shot.end_ms,
      }),
    },
  ]));
}

function expectedReferences(groups, blueprint, start, end) {
  const references = new Map();
  blueprint.shots.forEach((shot, index) => {
    if (shot.start_ms < end && shot.end_ms > start) {
      groups[index].forEach((reference) => references.set(reference.id, reference));
    }
  });
  return [...references.values()];
}

function textRegions(shot, localization) {
  const mappings = Array.isArray(localization.text_region_map) ? localization.text_region_map : [];
  return shot.text_regions.map((region) => {
    const matches = mappings.filter((item) => item?.text_region_id === region.id);
    if (region.source_text) {
      if (matches.length !== 1 || matches[0].shot_id !== shot.id
        || matches[0].source_text !== region.source_text || !text(matches[0].target_text)) stale();
      return { ...clone(region), target_text: matches[0].target_text };
    }
    if (matches.length > 0) stale();
    return clone(region);
  });
}

function parentContexts(unit, blueprint, localization) {
  const shots = new Map(blueprint.shots.map((shot) => [shot.id, shot]));
  return unit.parent_shots.map((parent) => {
    const shot = shots.get(parent.id);
    const expectedStart = Math.max(unit.source_start_ms, shot?.start_ms ?? -1);
    const expectedEnd = Math.min(unit.source_end_ms, shot?.end_ms ?? -1);
    if (!shot || parent.contract_hash !== hashPlanValue({
      shot,
      localization_hash: localization.localization_hash,
    }) || parent.source_start_ms !== expectedStart || parent.source_end_ms !== expectedEnd) stale();
    return {
      parent_shot_id: shot.id,
      parent_contract_hash: parent.contract_hash,
      parent_start_ms: shot.start_ms,
      parent_end_ms: shot.end_ms,
      source_start_ms: parent.source_start_ms,
      source_end_ms: parent.source_end_ms,
      unit_start_ms: parent.unit_start_ms,
      unit_end_ms: parent.unit_end_ms,
      composition: shot.composition,
      camera_movement: shot.camera_movement,
      opening_state: shot.opening_state,
      continuous_action: shot.continuous_action,
      ending_state: shot.ending_state,
      visible_character_ids: clone(shot.visible_character_ids),
      text_regions: textRegions(shot, localization),
      audio_contract: clone(shot.audio_contract),
      confidence: clone(shot.confidence),
      evidence_refs: clone(shot.evidence_refs),
    };
  });
}

function compiledDialogues(unit, blueprint, localization) {
  const sourceTurns = [];
  for (const shot of blueprint.shots) {
    for (const turn of shot.dialogue) sourceTurns.push({ shot, turn });
  }
  const mappings = Array.isArray(localization.dialogue_map) ? localization.dialogue_map : [];
  return unit.dialogues.map((dialogue) => {
    const sources = sourceTurns.filter(({ turn }) => turn.id === dialogue.id);
    const targets = mappings.filter((item) => item?.source_dialogue_id === dialogue.id);
    if (sources.length !== 1 || targets.length !== 1) stale();
    const { shot, turn } = sources[0];
    const target = targets[0];
    const evidence = blueprint.evidence_manifest.items.filter((item) => item.id === dialogue.evidence_ref);
    if (target.shot_id !== shot.id || target.target_text !== dialogue.target_text
      || (target.source_text != null && target.source_text !== dialogue.source_text)
      || (target.speaker_id != null && target.speaker_id !== turn.speaker_id)
      || (target.speaker_kind != null && target.speaker_kind !== turn.speaker_kind)
      || (target.emotion != null && target.emotion !== turn.emotion)
      || turn.source_text !== dialogue.source_text || !turn.evidence_refs.includes(dialogue.evidence_ref)
      || evidence.length !== 1 || evidence[0].sha256 !== dialogue.evidence_sha256) stale();
    const mappedName = localization.character_name_map?.[turn.speaker_id];
    if (turn.speaker_kind === 'character' && !text(mappedName)) stale();
    return {
      ...clone(dialogue),
      speaker_id: turn.speaker_id,
      speaker_kind: turn.speaker_kind,
      target_speaker_name: mappedName || turn.speaker_id,
      emotion: target.emotion ?? turn.emotion,
      pronunciation_hint: target.pronunciation_hint || '',
    };
  });
}

function referencedCharacterNameMap(parentContextsValue, dialogues, localization) {
  const ids = new Set();
  parentContextsValue.forEach((parent) => parent.visible_character_ids.forEach((id) => ids.add(id)));
  dialogues.forEach((dialogue) => ids.add(dialogue.speaker_id));
  const result = {};
  [...ids].sort().forEach((id) => {
    const name = localization.character_name_map?.[id];
    if (text(name)) result[id] = name;
  });
  return result;
}

function compileUnitProductionPack(input = {}) {
  if (!object(input) || !validOwner(input.owner) || !validExpected(input.expected)) invalid();
  const { owner, expected, queueState, blueprint, localization } = input;
  const { plan, selected } = assertQueueState(owner, expected, queueState);
  assertCurrentBindings(owner, plan, blueprint, localization);
  assertDialogueCoverage(plan, blueprint, localization);
  const unit = selected.plan_unit;
  const groups = referenceGroups(blueprint, localization);
  const logicalReferencesHash = hashPlanValue(groups.map((group) => group.map((reference) => ({
    id: reference.id,
    kind: reference.kind,
    sha256: reference.requirement_hash,
  }))));
  const references = expectedReferences(groups, blueprint, unit.source_start_ms, unit.source_end_ms);
  if (plan.bindings.reference_requirements_hash !== logicalReferencesHash
    || !isDeepStrictEqual(unit.reference_requirements, references)) stale();
  const contexts = parentContexts(unit, blueprint, localization);
  const dialogues = compiledDialogues(unit, blueprint, localization);
  const pack = {
    schema_version: 'redraw-unit-production-pack-v1',
    bindings: {
      tenant_id: owner.tenantId,
      user_id: owner.userId,
      work_id: owner.workId,
      version_id: owner.versionId,
      review_id: expected.review_id,
      queue_id: expected.queue_id,
      plan_hash: expected.plan_hash,
      unit_id: expected.unit_id,
      unit_hash: expected.unit_hash,
      source_asset_id: plan.bindings.source_asset_id,
      source_sha256: plan.bindings.source_sha256,
      blueprint_hash: plan.bindings.blueprint_hash,
      localization_hash: plan.bindings.localization_hash,
      capability_hash: plan.bindings.capability_hash,
    },
    timeline: {
      source_start_ms: unit.source_start_ms,
      source_end_ms: unit.source_end_ms,
      retained_duration_ms: unit.retained_duration_ms,
      generated_duration_ms: unit.generated_duration_ms,
      padding_ms: unit.padding_ms,
    },
    parent_contexts: contexts,
    dialogues,
    character_name_map: referencedCharacterNameMap(contexts, dialogues, localization),
    reference_requirements: clone(unit.reference_requirements),
  };
  pack.production_pack_hash = hashPlanValue(pack);
  return pack;
}

module.exports = { compileUnitProductionPack };
