'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { fixture } = require('./redrawExecutionPlanPreview.test');
const { fixtureBlueprint } = require('./redrawEpisodeBlueprint.test');
const { normalizeEpisodeBlueprint } = require('../src/services/redrawEpisodeBlueprintService');
const { episodeLocalizationHash } = require('../src/services/localizationService');
const { hashPlanValue } = require('../src/services/redrawExecutionPlanService');
const { saveExecutionPlanReview } = require('../src/services/redrawExecutionPlanReviewService');
const { getExecutionQueue, prepareExecutionQueue } = require('../src/services/redrawExecutionQueueService');
const { compileUnitProductionPack } = require('../src/services/redrawUnitProductionPackService');

const SHA = (letter) => letter.repeat(64);

function actualQueueFixture(t) {
  const h = fixture(t);
  h.localization.text_region_map = [{
    text_region_id: 'text-region-1',
    shot_id: 'shot-2',
    source_text: 'A-87',
    target_text: 'Case A-87',
  }];
  h.localization.localization_hash = episodeLocalizationHash(h.localization);
  h.db.prepare(`UPDATE redraw_versions
    SET localization_hash = ?, localization_review_json = ? WHERE id = 10`)
    .run(h.localization.localization_hash, JSON.stringify(h.localization));
  const preview = h.ctx.db.transaction(() => getExecutionQueue(h.ctx, 10))().preview;
  const saved = saveExecutionPlanReview(h.ctx, 10, { expected_plan_hash: preview.plan_hash });
  prepareExecutionQueue(h.ctx, 10, { expected_plan_hash: saved.preview.plan_hash });
  const queueState = getExecutionQueue(h.ctx, 10);
  const bindings = queueState.saved_review.plan.bindings;
  return {
    h,
    queueState,
    owner: {
      tenantId: bindings.tenant_id,
      userId: bindings.user_id,
      workId: bindings.work_id,
      versionId: bindings.version_id,
    },
    expectedFor(index = 0) {
      const unit = queueState.queue.units[index];
      return {
        review_id: queueState.saved_review.id,
        queue_id: queueState.queue.id,
        plan_hash: queueState.queue.plan_hash,
        unit_id: unit.id,
        unit_hash: unit.unit_hash,
      };
    },
  };
}

function rehashPlan(plan) {
  delete plan.plan_hash;
  plan.plan_hash = hashPlanValue(plan);
  return plan;
}

function logicalReferences(blueprint, localization) {
  const characters = new Map(blueprint.characters.map((character) => [character.id, character]));
  return blueprint.shots.map((shot) => ([
    ...shot.visible_character_ids.map((id) => ({
      id: `identity-${id}`,
      kind: 'image',
      requirement_hash: hashPlanValue({
        character: characters.get(id),
        target_name: localization.character_name_map[id] || '',
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

function parentMappings(blueprint, localization, start, end) {
  return blueprint.shots.filter((shot) => shot.start_ms < end && shot.end_ms > start).map((shot) => {
    const sourceStart = Math.max(start, shot.start_ms);
    const sourceEnd = Math.min(end, shot.end_ms);
    return {
      id: shot.id,
      contract_hash: hashPlanValue({ shot, localization_hash: localization.localization_hash }),
      source_start_ms: sourceStart,
      source_end_ms: sourceEnd,
      unit_start_ms: sourceStart - start,
      unit_end_ms: sourceEnd - start,
    };
  });
}

function unitReferences(referenceGroups, blueprint, start, end) {
  const selected = new Map();
  blueprint.shots.forEach((shot, index) => {
    if (shot.start_ms < end && shot.end_ms > start) {
      referenceGroups[index].forEach((reference) => selected.set(reference.id, reference));
    }
  });
  return [...selected.values()];
}

function rebuildQueueState(base, blueprint, localization, units) {
  const queueState = structuredClone(base.queueState);
  const plan = structuredClone(queueState.saved_review.plan);
  const referenceGroups = logicalReferences(blueprint, localization);
  plan.bindings = {
    ...plan.bindings,
    source_asset_id: blueprint.source.asset_id,
    source_sha256: blueprint.source.sha256,
    blueprint_hash: blueprint.blueprint_hash,
    localization_hash: localization.localization_hash,
    localization_review_status: localization.review.status,
    source_dialogue_hash: hashPlanValue(units.flatMap((unit) => unit.dialogues)),
    reference_requirements_hash: hashPlanValue(referenceGroups.map((group) => group.map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      sha256: reference.requirement_hash,
    })))),
  };
  plan.units = units.map((unit) => ({
    ...unit,
    parent_shots: parentMappings(blueprint, localization, unit.source_start_ms, unit.source_end_ms),
    reference_requirements: unitReferences(
      referenceGroups,
      blueprint,
      unit.source_start_ms,
      unit.source_end_ms,
    ),
  }));
  rehashPlan(plan);
  queueState.preview = structuredClone(plan);
  queueState.saved_review = {
    ...queueState.saved_review,
    plan_hash: plan.plan_hash,
    status: 'current',
    plan: structuredClone(plan),
  };
  queueState.queue = {
    ...queueState.queue,
    plan_hash: plan.plan_hash,
    status: 'waiting_readiness',
    units: plan.units.map((unit, ordinal) => ({
      id: unit.id,
      ordinal,
      status: 'pending',
      unit_hash: hashPlanValue(unit),
      plan_unit: structuredClone(unit),
    })),
    execution_blockers: [...plan.execution_blockers],
  };
  return queueState;
}

function expectedFor(queueState, index = 0) {
  const unit = queueState.queue.units[index];
  return {
    review_id: queueState.saved_review.id,
    queue_id: queueState.queue.id,
    plan_hash: queueState.queue.plan_hash,
    unit_id: unit.id,
    unit_hash: unit.unit_hash,
  };
}

function threeParentFacts() {
  const raw = fixtureBlueprint();
  raw.source.duration_ms = 12_000;
  raw.scenes[0].source_ranges = [{ start_ms: 0, end_ms: 12_000 }];
  raw.props[0].evidence_ranges = [{ start_ms: 1_000, end_ms: 11_000 }];
  const visual = raw.shots[0];
  const silent = (id, index, start_ms, end_ms, values) => ({
    ...structuredClone(visual),
    id,
    index,
    start_ms,
    end_ms,
    ...values,
    dialogue: [],
    audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
  });
  raw.shots = [
    silent('parent-1', 1, 0, 3_000, {
      composition: '乔安位于画面左侧。',
      opening_state: '乔安已经握住餐袋。',
      continuous_action: '乔安向门口移动。',
      ending_state: '乔安到达门口。',
      text_regions: [{
        id: 'region-order',
        kind: 'screen_text',
        polygon: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.2], [0.1, 0.2]],
        source_text: '订单 87',
        evidence_refs: ['evidence-visual-1'],
        confidence: 0.91,
      }],
    }),
    {
      ...silent('parent-2', 2, 3_000, 7_000, {
        composition: '乔安居中面对镜头。',
        opening_state: '乔安开始说话。',
        continuous_action: '乔安连续说完整句话。',
        ending_state: '乔安仍在说话。',
        text_regions: [],
      }),
      dialogue: [{
        id: 'dialogue-cross-three',
        speaker_id: 'character-qiao-an',
        speaker_kind: 'character',
        off_screen: false,
        start_ms: 3_000,
        end_ms: 7_000,
        source_text: '这是一句跨越三个父镜头的完整对白。',
        source_language: 'zh-CN',
        emotion: '坚定',
        evidence_refs: ['evidence-audio-1'],
        confidence: 0.96,
        review_status: 'approved',
      }],
      audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
    },
    silent('parent-3', 3, 7_000, 12_000, {
      composition: '乔安位于画面右侧。',
      opening_state: '乔安继续说话。',
      continuous_action: '乔安走出画面。',
      ending_state: '门口恢复空景。',
      visible_character_ids: [],
      text_regions: [],
    }),
  ];
  raw.review = { status: 'locked', reviewer: 'user-a' };
  const blueprint = normalizeEpisodeBlueprint(raw);
  const localization = {
    schema_version: 'episode-localization-v1',
    blueprint_hash: blueprint.blueprint_hash,
    locale: 'en-US',
    market: 'US',
    character_name_map: { 'character-qiao-an': 'Joanna' },
    dialogue_map: [{
      source_dialogue_id: 'dialogue-cross-three',
      shot_id: 'parent-2',
      speaker_id: 'character-qiao-an',
      speaker_kind: 'character',
      source_text: '这是一句跨越三个父镜头的完整对白。',
      target_text: 'This complete line crosses three parent shots.',
      start_ms: 3_000,
      end_ms: 7_000,
      estimated_duration_ms: 2_000,
      estimated_speech_rate: 8,
      emotion: '坚定',
      pronunciation_hint: 'Jo-AN-na',
    }],
    text_region_map: [{
      text_region_id: 'region-order',
      shot_id: 'parent-1',
      source_text: '订单 87',
      target_text: 'Order 87',
    }],
    cultural_adaptations: [],
    glossary: [],
    locked_terms: [],
    review: { status: 'review', updated_at: '2026-09-07T00:00:00.000Z' },
  };
  localization.localization_hash = episodeLocalizationHash(localization);
  return { blueprint, localization };
}

function oneLongParentFacts() {
  const raw = fixtureBlueprint();
  raw.source.duration_ms = 18_000;
  raw.scenes[0].source_ranges = [{ start_ms: 0, end_ms: 18_000 }];
  raw.props[0].evidence_ranges = [{ start_ms: 1_000, end_ms: 17_000 }];
  raw.shots = [{
    ...structuredClone(raw.shots[0]),
    id: 'long-parent',
    index: 1,
    start_ms: 0,
    end_ms: 18_000,
    composition: '固定广角展示乔安穿过完整长廊。',
    camera_movement: '稳定横移跟拍',
    opening_state: '乔安在长廊入口。',
    continuous_action: '乔安持续穿过长廊且动作连续。',
    ending_state: '乔安在长廊出口停下。',
    dialogue: [],
    text_regions: [],
    audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
  }];
  raw.review = { status: 'locked', reviewer: 'user-a' };
  const blueprint = normalizeEpisodeBlueprint(raw);
  const localization = {
    schema_version: 'episode-localization-v1',
    blueprint_hash: blueprint.blueprint_hash,
    locale: 'en-US',
    market: 'US',
    character_name_map: { 'character-qiao-an': 'Joanna' },
    dialogue_map: [],
    text_region_map: [],
    cultural_adaptations: [],
    glossary: [],
    locked_terms: [],
    review: { status: 'review', updated_at: '2026-09-07T00:00:00.000Z' },
  };
  localization.localization_hash = episodeLocalizationHash(localization);
  return { blueprint, localization };
}

function persistActualFacts(h, blueprint, localization) {
  h.db.prepare(`UPDATE redraw_works SET source_asset_id = ?, source_fingerprint = ?, duration_ms = ? WHERE id = 1`)
    .run(blueprint.source.asset_id, blueprint.source.sha256, blueprint.source.duration_ms);
  h.db.prepare(`INSERT INTO redraw_episode_blueprints
    (work_id, tenant_id, user_id, revision, status, blueprint_json, blueprint_hash, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 2, 'locked', ?, ?, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')`)
    .run(JSON.stringify(blueprint), blueprint.blueprint_hash);
  h.db.prepare(`UPDATE redraw_versions
    SET version = 2, blueprint_hash = ?, localization_hash = ?, localization_review_json = ? WHERE id = 10`)
    .run(blueprint.blueprint_hash, localization.localization_hash, JSON.stringify(localization));
}

function actualInput(h, blueprint, localization) {
  const first = getExecutionQueue(h.ctx, 10);
  assert.equal(first.preview.status, 'ready', JSON.stringify(first.preview.blocking_reasons));
  saveExecutionPlanReview(h.ctx, 10, { expected_plan_hash: first.preview.plan_hash });
  prepareExecutionQueue(h.ctx, 10, { expected_plan_hash: first.preview.plan_hash });
  const queueState = getExecutionQueue(h.ctx, 10);
  assert.equal(queueState.queue.status, 'waiting_readiness');
  const unit = queueState.queue.units[0];
  return {
    owner: { tenantId: 'tenant-a', userId: 'user-a', workId: 1, versionId: 10 },
    expected: {
      review_id: queueState.saved_review.id,
      queue_id: queueState.queue.id,
      plan_hash: queueState.queue.plan_hash,
      unit_id: unit.id,
      unit_hash: unit.unit_hash,
    },
    queueState,
    blueprint,
    localization,
  };
}

function actualThreeParentInput(t) {
  const h = fixture(t);
  const sourceSha = h.blueprint.source.sha256;
  let { blueprint, localization } = threeParentFacts();
  const evidence = structuredClone(h.evidence.evidence);
  evidence.source_video_sha256 = sourceSha;
  evidence.source_language = 'zh';
  evidence.segments = [{
    id: 'dialogue-cross-three',
    start_ms: 1_000,
    end_ms: 9_000,
    source_text: '这是一句跨越三个父镜头的完整对白。',
    speaker_cluster_id: 'speaker-cluster-1',
  }];
  const evidenceBytes = JSON.stringify(evidence);
  fs.writeFileSync(h.evidence.evidencePath, evidenceBytes);
  const evidenceSha = createHash('sha256').update(evidenceBytes).digest('hex');
  const metadata = { ...evidence, evidence_sha256: evidenceSha };
  delete metadata.segments;
  h.db.prepare('UPDATE assets SET metadata = ? WHERE id = 92').run(JSON.stringify(metadata));
  blueprint = structuredClone(blueprint);
  blueprint.source.asset_id = 91;
  blueprint.source.sha256 = sourceSha;
  const visualEvidence = blueprint.evidence_manifest.items.find((item) => item.id === 'evidence-visual-1');
  blueprint.evidence_manifest.items = [visualEvidence, {
    id: 'audio-source',
    kind: 'audio_transcript',
    asset_id: 92,
    sha256: evidenceSha,
    tool: 'source-audio-evidence',
    tool_version: '1',
  }];
  blueprint.shots[1].dialogue[0].source_language = 'zh';
  blueprint.shots[1].dialogue[0].evidence_refs = ['audio-source'];
  blueprint = normalizeEpisodeBlueprint(blueprint);
  localization = structuredClone(localization);
  localization.blueprint_hash = blueprint.blueprint_hash;
  localization.localization_hash = episodeLocalizationHash(localization);
  persistActualFacts(h, blueprint, localization);
  return actualInput(h, blueprint, localization);
}

function actualLongParentInput(t) {
  const h = fixture(t);
  const sourceSha = h.blueprint.source.sha256;
  let { blueprint, localization } = oneLongParentFacts();
  blueprint = structuredClone(blueprint);
  blueprint.source.asset_id = 91;
  blueprint.source.sha256 = sourceSha;
  blueprint = normalizeEpisodeBlueprint(blueprint);
  localization = structuredClone(localization);
  localization.blueprint_hash = blueprint.blueprint_hash;
  localization.localization_hash = episodeLocalizationHash(localization);
  h.capabilities['fumin-seedance-2.0-mini'].durations = [6];
  h.db.prepare('UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = 41')
    .run(JSON.stringify(h.capabilities));
  persistActualFacts(h, blueprint, localization);
  return actualInput(h, blueprint, localization);
}

function actualStringSourceIdInput(t) {
  const h = fixture(t);
  let blueprint = structuredClone(h.blueprint);
  blueprint.source.asset_id = String(blueprint.source.asset_id);
  blueprint = normalizeEpisodeBlueprint(blueprint);
  const localization = structuredClone(h.localization);
  localization.blueprint_hash = blueprint.blueprint_hash;
  localization.text_region_map = [{
    text_region_id: 'text-region-1',
    shot_id: 'shot-2',
    source_text: 'A-87',
    target_text: 'Case A-87',
  }];
  localization.localization_hash = episodeLocalizationHash(localization);
  persistActualFacts(h, blueprint, localization);
  return actualInput(h, blueprint, localization);
}

function synchronizeMutatedPlan(input) {
  const plan = input.queueState.saved_review.plan;
  delete plan.plan_hash;
  plan.plan_hash = hashPlanValue(plan);
  input.queueState.saved_review.plan_hash = plan.plan_hash;
  input.queueState.preview = structuredClone(plan);
  input.queueState.queue.plan_hash = plan.plan_hash;
  input.queueState.queue.units.forEach((unit, index) => {
    unit.plan_unit = structuredClone(plan.units[index]);
    unit.unit_hash = hashPlanValue(unit.plan_unit);
  });
  input.expected.plan_hash = plan.plan_hash;
  const selected = input.queueState.queue.units.find((unit) => unit.id === input.expected.unit_id);
  input.expected.unit_hash = selected.unit_hash;
}

function compile(input) {
  return compileUnitProductionPack(input);
}

test('compiles one actual current registered queue unit without promoting readiness or execution', (t) => {
  const actual = actualQueueFixture(t);
  const pack = compile({
    owner: actual.owner,
    expected: actual.expectedFor(),
    queueState: actual.queueState,
    blueprint: actual.h.blueprint,
    localization: actual.h.localization,
  });
  assert.equal(pack.schema_version, 'redraw-unit-production-pack-v1');
  assert.equal(pack.bindings.queue_id, actual.queueState.queue.id);
  assert.equal(pack.bindings.review_id, actual.queueState.saved_review.id);
  assert.equal(pack.bindings.unit_hash, actual.queueState.queue.units[0].unit_hash);
  assert.equal(pack.ready, undefined);
  assert.equal(pack.executable, undefined);
  assert.equal(pack.status, undefined);
  assert.equal(pack.generated, undefined);
  assert.equal(pack.execution_blockers, undefined);
});

test('compiles actual current queue when upstream accepts numeric-string source asset ID', (t) => {
  const input = actualStringSourceIdInput(t);
  assert.equal(input.blueprint.source.asset_id, '91');
  assert.equal(input.queueState.preview.bindings.source_asset_id, 91);
  const before = structuredClone(input.queueState);
  const pack = compile(input);
  assert.equal(pack.bindings.source_asset_id, 91, 'canonical plan binding must be preserved');
  assert.deepEqual(input.queueState, before);
});

test('rejects internally re-signed plan bound to a genuinely different source asset', (t) => {
  const actual = actualQueueFixture(t);
  const input = {
    owner: actual.owner,
    expected: actual.expectedFor(),
    queueState: structuredClone(actual.queueState),
    blueprint: actual.h.blueprint,
    localization: actual.h.localization,
  };
  input.queueState.saved_review.plan.bindings.source_asset_id = 92;
  synchronizeMutatedPlan(input);
  assert.throws(() => compile(input), { code: 'REDRAW_UNIT_PRODUCTION_PACK_STALE' });
});

test('preserves ordered three-parent overlaps, complete source dialogue, projected localization and visual evidence', (t) => {
  const input = actualThreeParentInput(t);
  const before = structuredClone(input.queueState);
  const dialogue = input.queueState.queue.units[0].plan_unit.dialogues[0];
  const pack = compile(input);
  assert.deepEqual(input.queueState, before, 'actual current queue output must remain untouched');
  assert.deepEqual(pack.timeline, {
    source_start_ms: 0,
    source_end_ms: 12_000,
    retained_duration_ms: 12_000,
    generated_duration_ms: 15_000,
    padding_ms: 3_000,
  });
  assert.deepEqual(pack.parent_contexts.map((parent) => ({
    id: parent.parent_shot_id,
    source: [parent.source_start_ms, parent.source_end_ms],
    unit: [parent.unit_start_ms, parent.unit_end_ms],
  })), [
    { id: 'parent-1', source: [0, 3_000], unit: [0, 3_000] },
    { id: 'parent-2', source: [3_000, 7_000], unit: [3_000, 7_000] },
    { id: 'parent-3', source: [7_000, 12_000], unit: [7_000, 12_000] },
  ]);
  assert.deepEqual(pack.dialogues, [{ ...dialogue, speaker_id: 'character-qiao-an', speaker_kind: 'character',
    target_speaker_name: 'Joanna', emotion: '坚定', pronunciation_hint: 'Jo-AN-na' }]);
  assert.equal(pack.dialogues[0].start_ms, 1_000, 'complete source time must survive');
  assert.equal(pack.dialogues[0].end_ms, 9_000, 'complete source time must survive');
  assert.equal(input.localization.dialogue_map[0].start_ms, 3_000, 'fixture must retain parent projection time');
  assert.equal(input.localization.dialogue_map[0].end_ms, 7_000, 'fixture must retain parent projection time');
  assert.deepEqual(pack.character_name_map, { 'character-qiao-an': 'Joanna' });
  assert.deepEqual(pack.parent_contexts[0].text_regions, [{
    ...input.blueprint.shots[0].text_regions[0],
    target_text: 'Order 87',
  }]);
  assert.deepEqual(pack.parent_contexts[0].evidence_refs, ['evidence-visual-1']);
  assert.deepEqual(pack.parent_contexts[0].confidence, input.blueprint.shots[0].confidence);
  assert.deepEqual(pack.parent_contexts[0].visible_character_ids, ['character-qiao-an']);
  assert.equal(pack.story, undefined);
  assert.equal(pack.scenes, undefined);
  assert.equal(pack.props, undefined);
  assert.equal(pack.causal_chain, undefined);
});

test('keeps long-parent visual facts as parent context across at least three split units', (t) => {
  const input = actualLongParentInput(t);
  const before = structuredClone(input.queueState);
  assert.ok(input.queueState.queue.units.length >= 3, 'actual queue must contain at least three units');
  const packs = input.queueState.queue.units.map((unit) => compile({
    ...input,
    expected: { ...input.expected, unit_id: unit.id, unit_hash: unit.unit_hash },
  }));
  assert.deepEqual(input.queueState, before, 'actual current queue output must remain untouched');
  assert.equal(packs.length, 3);
  for (const [index, pack] of packs.entries()) {
    assert.equal(pack.parent_contexts.length, 1);
    const context = pack.parent_contexts[0];
    assert.equal(context.parent_shot_id, 'long-parent');
    assert.equal(context.opening_state, input.blueprint.shots[0].opening_state);
    assert.equal(context.continuous_action, input.blueprint.shots[0].continuous_action);
    assert.equal(context.ending_state, input.blueprint.shots[0].ending_state);
    assert.deepEqual([context.source_start_ms, context.source_end_ms], [index * 6_000, (index + 1) * 6_000]);
    assert.deepEqual([context.unit_start_ms, context.unit_end_ms], [0, 6_000]);
    assert.equal(pack.opening_state, undefined, 'partial parent state must not masquerade as a unit boundary');
    assert.equal(pack.ending_state, undefined, 'partial parent state must not masquerade as a unit boundary');
  }
});

test('rejects owner and exact review, queue, plan, unit or content drift as stale', (t) => {
  const actual = actualQueueFixture(t);
  const base = {
    owner: actual.owner,
    expected: actual.expectedFor(),
    queueState: actual.queueState,
    blueprint: actual.h.blueprint,
    localization: actual.h.localization,
  };
  const cases = [
    ['owner', (input) => { input.owner.userId = 'other'; }],
    ['review', (input) => { input.expected.review_id += 1; }],
    ['same-plan different queue', (input) => { input.expected.queue_id += 1; }],
    ['plan', (input) => { input.expected.plan_hash = SHA('f'); }],
    ['unit id', (input) => { input.expected.unit_id = 'other-unit'; }],
    ['unit hash', (input) => { input.expected.unit_hash = SHA('f'); }],
    ['queue status', (input) => { input.queueState.queue.status = 'stale'; }],
    ['source binding', (input) => { input.blueprint.source.sha256 = SHA('f'); }],
    ['visual content', (input) => { input.blueprint.shots[0].composition = 'drift'; }],
    ['visual evidence', (input) => { input.blueprint.shots[0].evidence_refs = ['audio-source']; }],
  ];
  for (const [name, mutate] of cases) {
    const input = structuredClone(base);
    mutate(input);
    assert.throws(() => compile(input), (error) => {
      assert.equal(error.code, 'REDRAW_UNIT_PRODUCTION_PACK_STALE', name);
      assert.doesNotMatch(error.message, /other-unit|drift|tenant-a|user-a/i);
      return true;
    });
  }
});

test('rejects internally re-signed dialogue omission, duplication, target, speaker and localized-name drift', (t) => {
  const actual = actualQueueFixture(t);
  const { blueprint, localization } = threeParentFacts();
  const dialogue = {
    id: 'dialogue-cross-three', start_ms: 1_000, end_ms: 9_000,
    source_text: '这是一句跨越三个父镜头的完整对白。',
    target_text: 'This complete line crosses three parent shots.',
    evidence_ref: 'evidence-audio-1', evidence_sha256: SHA('b'),
    estimated_duration_ms: 2_000, unit_start_ms: 1_000, unit_end_ms: 9_000,
  };
  const units = [{
    id: 'unit-three-parents', source_start_ms: 0, source_end_ms: 12_000,
    retained_duration_ms: 12_000, generated_duration_ms: 15_000, padding_ms: 3_000,
    dialogues: [dialogue],
  }];
  const cases = [
    ['omission', (loc) => { loc.dialogue_map = []; }],
    ['duplication', (loc) => { loc.dialogue_map.push(structuredClone(loc.dialogue_map[0])); }],
    ['target', (loc) => { loc.dialogue_map[0].target_text = 'Changed target'; }],
    ['speaker', (loc) => { loc.dialogue_map[0].speaker_id = 'other-speaker'; }],
  ];
  for (const [name, mutate] of cases) {
    const loc = structuredClone(localization);
    mutate(loc);
    loc.localization_hash = episodeLocalizationHash(loc);
    const queueState = rebuildQueueState(actual, blueprint, loc, units);
    assert.throws(() => compile({
      owner: actual.owner,
      expected: expectedFor(queueState),
      queueState,
      blueprint,
      localization: loc,
    }), (error) => {
      assert.equal(error.code, 'REDRAW_UNIT_PRODUCTION_PACK_STALE', name);
      return true;
    });
  }
  const nameDrift = structuredClone(localization);
  nameDrift.character_name_map['character-qiao-an'] = 'Jane';
  nameDrift.localization_hash = episodeLocalizationHash(nameDrift);
  const queueState = rebuildQueueState(actual, blueprint, localization, units);
  assert.throws(() => compile({
    owner: actual.owner,
    expected: expectedFor(queueState),
    queueState,
    blueprint,
    localization: nameDrift,
  }), (error) => {
    assert.equal(error.code, 'REDRAW_UNIT_PRODUCTION_PACK_STALE', 'name');
    return true;
  });
});

test('keeps logical reference requirements unchanged and never promotes them to real assets', (t) => {
  const actual = actualQueueFixture(t);
  const pack = compile({
    owner: actual.owner,
    expected: actual.expectedFor(),
    queueState: actual.queueState,
    blueprint: actual.h.blueprint,
    localization: actual.h.localization,
  });
  assert.deepEqual(pack.reference_requirements, actual.queueState.queue.units[0].plan_unit.reference_requirements);
  assert.ok(pack.reference_requirements.every((reference) => /^[a-f0-9]{64}$/.test(reference.requirement_hash)));
  assert.ok(pack.reference_requirements.every((reference) => reference.sha256 === undefined));
  assert.equal(pack.reference_assets, undefined);
  assert.equal(pack.assets, undefined);
  assert.equal(pack.reference_readiness, undefined);
});

test('is deterministic and non-mutating for recursively frozen inputs', (t) => {
  const actual = actualQueueFixture(t);
  const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      Object.values(value).forEach(freeze);
    }
    return value;
  };
  const input = freeze(structuredClone({
    owner: actual.owner,
    expected: actual.expectedFor(),
    queueState: actual.queueState,
    blueprint: actual.h.blueprint,
    localization: actual.h.localization,
  }));
  const before = structuredClone(input);
  const first = compile(input);
  const second = compile(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  assert.equal(first.production_pack_hash, hashPlanValue(Object.fromEntries(
    Object.entries(first).filter(([key]) => key !== 'production_pack_hash'),
  )));
  assert.equal(first.created_at, undefined);
  assert.equal(first.timestamp, undefined);
});

test('rejects invalid timing and coverage with the single structural error code', (t) => {
  const actual = actualQueueFixture(t);
  const input = {
    owner: actual.owner,
    expected: actual.expectedFor(),
    queueState: structuredClone(actual.queueState),
    blueprint: actual.h.blueprint,
    localization: actual.h.localization,
  };
  const unit = input.queueState.queue.units[0];
  unit.plan_unit.parent_shots[0].unit_start_ms += 1;
  unit.unit_hash = hashPlanValue(unit.plan_unit);
  input.expected.unit_hash = unit.unit_hash;
  assert.throws(() => compile(input), (error) => {
    assert.equal(error.code, 'REDRAW_UNIT_PRODUCTION_PACK_INVALID');
    return true;
  });
});

test('rejects internally re-signed full-plan dialogue omission against supplied facts', (t) => {
  const actual = actualQueueFixture(t);
  const input = {
    owner: actual.owner,
    expected: actual.expectedFor(),
    queueState: structuredClone(actual.queueState),
    blueprint: actual.h.blueprint,
    localization: actual.h.localization,
  };
  assert.equal(input.queueState.saved_review.plan.units[0].dialogues.length, 1);
  input.queueState.saved_review.plan.units[0].dialogues = [];
  synchronizeMutatedPlan(input);
  assert.throws(() => compile(input), (error) => {
    assert.ok(['REDRAW_UNIT_PRODUCTION_PACK_INVALID', 'REDRAW_UNIT_PRODUCTION_PACK_STALE'].includes(error.code));
    return true;
  });
});

test('preserves genuine blueprint schema and review validator codes while valid content drift stays stale', (t) => {
  const cases = [
    ['schema_version', (blueprint) => { blueprint.schema_version = 'invalid'; }, 'BLUEPRINT_SCHEMA_INVALID'],
    ['review', (blueprint) => { blueprint.review.status = 'needs_review'; }, 'BLUEPRINT_REVIEW_REQUIRED'],
  ];
  const actualCodes = [];
  for (const [, mutate] of cases) {
    const actual = actualQueueFixture(t);
    const blueprint = structuredClone(actual.h.blueprint);
    mutate(blueprint);
    try {
      compile({ owner: actual.owner, expected: actual.expectedFor(), queueState: actual.queueState,
        blueprint, localization: actual.h.localization });
    } catch (error) {
      actualCodes.push(error.code);
    }
  }
  assert.deepEqual(actualCodes, cases.map((item) => item[2]));
  const drift = actualQueueFixture(t);
  const blueprint = structuredClone(drift.h.blueprint);
  blueprint.shots[0].composition = 'valid structure but changed current content';
  assert.throws(() => compile({ owner: drift.owner, expected: drift.expectedFor(), queueState: drift.queueState,
    blueprint, localization: drift.h.localization }), { code: 'REDRAW_UNIT_PRODUCTION_PACK_STALE' });
});

test('classifies internally re-signed invalid complete-dialogue timing as structural INVALID', (t) => {
  const actual = actualQueueFixture(t);
  const input = {
    owner: actual.owner,
    expected: actual.expectedFor(),
    queueState: structuredClone(actual.queueState),
    blueprint: actual.h.blueprint,
    localization: actual.h.localization,
  };
  input.queueState.saved_review.plan.units[0].dialogues[0].end_ms = 2_000;
  synchronizeMutatedPlan(input);
  assert.throws(() => compile(input), { code: 'REDRAW_UNIT_PRODUCTION_PACK_INVALID' });
});
