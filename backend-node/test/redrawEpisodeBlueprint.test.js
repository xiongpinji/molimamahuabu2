const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const {
  assertBlueprintLockable,
  normalizeEpisodeBlueprint,
  projectSourceFactsV2,
} = require('../src/services/redrawEpisodeBlueprintService');
const { stableStringify } = require('../src/services/redrawEpisodeFactsService');

function fixtureBlueprint() {
  return {
    schema_version: 'episode-blueprint-v1',
    source: {
      asset_id: 'asset-source-1',
      sha256: 'a'.repeat(64),
      duration_ms: 6_000,
      width: 1080,
      height: 1920,
      fps: 25,
      video_codec: 'h264',
      audio_codec: 'aac',
      audio_sample_rate_hz: 48_000,
      audio_channels: 2,
    },
    evidence_manifest: {
      items: [
        {
          id: 'evidence-audio-1',
          kind: 'audio_transcript',
          asset_id: 'asset-audio-1',
          sha256: 'b'.repeat(64),
          tool: 'local-asr',
          tool_version: '1.0.0',
        },
        {
          id: 'evidence-visual-1',
          kind: 'visual',
          asset_id: 'asset-visual-1',
          sha256: 'c'.repeat(64),
          tool: 'contact-sheet-analyzer',
          tool_version: '1.0.0',
        },
      ],
    },
    story: {
      summary: '雨夜订单把乔安重新带回旧案。',
      beats: ['乔安送达订单', '旧案编号重新出现'],
      evidence_refs: ['evidence-visual-1'],
      confidence: 0.88,
    },
    characters: [{
      id: 'character-qiao-an',
      source_name: '乔安',
      display_name: '乔安',
      relationship: '骑手',
      relationships: [],
      face_track_ids: ['face-track-1'],
      evidence_refs: ['evidence-visual-1'],
      confidence: 0.92,
      review_status: 'approved',
    }],
    scenes: [{
      id: 'scene-storefront',
      location: '便利店门口',
      time: '雨夜',
      source_ranges: [{ start_ms: 0, end_ms: 6_000 }],
      evidence_refs: ['evidence-visual-1'],
      confidence: 0.91,
    }],
    props: [{
      id: 'prop-order-bag',
      name: '密封餐袋',
      evidence_ranges: [{ start_ms: 1_000, end_ms: 5_000 }],
      evidence_refs: ['evidence-visual-1'],
      confidence: 0.87,
    }],
    shots: [
      {
        id: 'shot-1',
        index: 1,
        start_ms: 0,
        end_ms: 3_000,
        composition: '乔安站在便利店门口。',
        camera_movement: '缓慢前推',
        opening_state: '乔安抱着餐袋。',
        continuous_action: '乔安抬头望向路边。',
        ending_state: '乔安停在车旁。',
        visible_character_ids: ['character-qiao-an'],
        dialogue: [{
          id: 'dialogue-1',
          speaker_id: 'speaker-cluster-1',
          speaker_kind: 'voice_cluster',
          off_screen: false,
          start_ms: 500,
          end_ms: 1_800,
          source_text: '尾号八七的订单到了。',
          source_language: 'zh-CN',
          emotion: '克制',
          evidence_refs: ['evidence-audio-1'],
          confidence: 0.73,
          review_status: 'needs_review',
        }],
        text_regions: [],
        audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
        confidence: { character_mapping: 0.9, speaker_mapping: 0.73, text_regions: 0.7, shot_boundary: 0.94 },
        evidence_refs: ['evidence-visual-1'],
      },
      {
        id: 'shot-2',
        index: 2,
        start_ms: 3_000,
        end_ms: 6_000,
        composition: '餐袋封条上的旧案编号占满画面。',
        camera_movement: '定机位',
        opening_state: '雨水打湿封条。',
        continuous_action: '编号逐渐显现。',
        ending_state: '画面停在编号上。',
        visible_character_ids: [],
        dialogue: [{
          id: 'dialogue-2',
          speaker_id: 'narrator',
          speaker_kind: 'off_screen',
          off_screen: true,
          start_ms: 3_400,
          end_ms: 4_700,
          source_text: '她以为那件事已经结束。',
          source_language: 'zh-CN',
          emotion: '低沉',
          evidence_refs: ['evidence-audio-1'],
          confidence: 0.96,
          review_status: 'approved',
        }],
        text_regions: [{
          id: 'text-region-1',
          kind: 'screen_text',
          polygon: [[0.2, 0.3], [0.8, 0.3], [0.8, 0.5], [0.2, 0.5]],
          source_text: 'A-87',
          evidence_refs: ['evidence-visual-1'],
          confidence: 0.9,
        }],
        audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
        confidence: { character_mapping: 0.95, speaker_mapping: 0.96, text_regions: 0.9, shot_boundary: 0.93 },
        evidence_refs: ['evidence-visual-1'],
      },
    ],
    causal_chain: [{
      id: 'causal-1',
      cause: '乔安送达超时订单。',
      effect: '旧案编号重新出现。',
      evidence_refs: ['evidence-visual-1'],
      confidence: 0.84,
    }],
    locked_facts: [{
      id: 'fact-1',
      text: '乔安在雨夜送达密封餐袋。',
      evidence_refs: ['evidence-visual-1'],
      confidence: 0.95,
    }],
    reversals: [{
      id: 'reversal-1',
      text: '普通订单与旧案有关。',
      evidence_refs: ['evidence-visual-1'],
      confidence: 0.8,
    }],
    episode_hook: {
      text: '封条露出旧案编号。',
      evidence_refs: ['evidence-visual-1'],
      confidence: 0.9,
    },
    review: {
      status: 'approved',
      reviewer: 'reviewer-1',
    },
  };
}

function lockedBlueprint() {
  const raw = fixtureBlueprint();
  raw.shots[0].dialogue[0] = {
    ...raw.shots[0].dialogue[0],
    speaker_id: 'character-qiao-an',
    speaker_kind: 'character',
    review_status: 'approved',
  };
  return normalizeEpisodeBlueprint(raw);
}

function resignBlueprint(blueprint) {
  const { blueprint_hash: ignored, ...canonical } = blueprint;
  blueprint.blueprint_hash = createHash('sha256').update(stableStringify(canonical)).digest('hex');
  return blueprint;
}

function assertLockAndProjectionReject(mutator, expected) {
  const blueprint = lockedBlueprint();
  mutator(blueprint);
  resignBlueprint(blueprint);
  assert.throws(() => assertBlueprintLockable(blueprint), expected);
  assert.throws(() => projectSourceFactsV2(blueprint), expected);
}

test('normalizes a gap-free episode blueprint with off-screen and unresolved speakers', () => {
  const value = normalizeEpisodeBlueprint(fixtureBlueprint());
  assert.equal(value.schema_version, 'episode-blueprint-v1');
  assert.equal(value.shots.at(-1).end_ms, value.source.duration_ms);
  assert.equal(value.shots[0].dialogue[0].speaker_kind, 'voice_cluster');
  assert.equal(value.shots[0].dialogue[0].speaker_id, 'speaker-cluster-1');
  assert.equal(value.shots[1].dialogue[0].speaker_kind, 'off_screen');
  assert.equal(value.shots[1].dialogue[0].off_screen, true);
  assert.equal(value.review.status, 'needs_review');
  assert.match(value.blueprint_hash, /^[a-f0-9]{64}$/);
});

test('blueprint hash is canonical, excludes its own value and does not mutate input', () => {
  const raw = lockedBlueprint();
  const before = JSON.stringify(raw);
  const reordered = JSON.parse(JSON.stringify(raw));
  reordered.characters.reverse();
  reordered.evidence_manifest.items.reverse();
  reordered.shots[0].evidence_refs.reverse();
  reordered.blueprint_hash = '0'.repeat(64);

  const first = normalizeEpisodeBlueprint(raw);
  const second = normalizeEpisodeBlueprint(reordered);

  assert.equal(JSON.stringify(raw), before);
  assert.equal(first.blueprint_hash, second.blueprint_hash);
  assert.equal(normalizeEpisodeBlueprint(first).blueprint_hash, first.blueprint_hash);
  assert.notEqual(
    normalizeEpisodeBlueprint({ ...raw, episode_hook: { ...raw.episode_hook, text: '另一条钩子。' } }).blueprint_hash,
    first.blueprint_hash,
  );
});

test('rejects invented dialogue without traceable audio or subtitle evidence', () => {
  const withoutEvidence = fixtureBlueprint();
  withoutEvidence.shots[0].dialogue[0].evidence_refs = [];
  assert.throws(
    () => normalizeEpisodeBlueprint(withoutEvidence),
    (error) => error.code === 'DIALOGUE_EVIDENCE_REQUIRED' && /DIALOGUE_EVIDENCE_REQUIRED/.test(error.message),
  );

  const unknownEvidence = fixtureBlueprint();
  unknownEvidence.shots[0].dialogue[0].evidence_refs = ['evidence-missing'];
  assert.throws(
    () => normalizeEpisodeBlueprint(unknownEvidence),
    (error) => error.code === 'DIALOGUE_EVIDENCE_REQUIRED',
  );
});

test('lock gate rejects incomplete timelines, invalid evidence and unresolved speakers', () => {
  const gap = lockedBlueprint();
  gap.shots[1].start_ms = 3_100;
  assert.throws(() => assertBlueprintLockable(gap), /BLUEPRINT_TIMELINE_INCOMPLETE/);

  const invalidEvidence = lockedBlueprint();
  invalidEvidence.evidence_manifest.items[0].sha256 = 'not-a-sha';
  assert.throws(() => assertBlueprintLockable(invalidEvidence), /BLUEPRINT_EVIDENCE_SHA_INVALID/);

  const noDialogueEvidence = lockedBlueprint();
  noDialogueEvidence.shots[0].dialogue[0].evidence_refs = [];
  assert.throws(() => assertBlueprintLockable(noDialogueEvidence), /DIALOGUE_EVIDENCE_REQUIRED/);

  const unresolved = normalizeEpisodeBlueprint(fixtureBlueprint());
  assert.throws(() => assertBlueprintLockable(unresolved), /BLUEPRINT_SPEAKER_REVIEW_REQUIRED/);

  const lockable = lockedBlueprint();
  assert.equal(assertBlueprintLockable(lockable), lockable);
});

test('lock gate rejects re-signed story evidence references outside the manifest', () => {
  assertLockAndProjectionReject((blueprint) => {
    blueprint.story.evidence_refs = ['evidence-missing'];
  }, /未知证据/);
});

test('lock gate rejects re-signed shot evidence references outside the manifest', () => {
  assertLockAndProjectionReject((blueprint) => {
    blueprint.shots[0].evidence_refs = ['evidence-missing'];
  }, /未知证据/);
});

test('lock gate rejects a re-signed dialogue with an invalid speaker kind', () => {
  assertLockAndProjectionReject((blueprint) => {
    blueprint.shots[0].dialogue[0].speaker_kind = 'invented_speaker';
  }, /speaker_kind/);
});

test('lock gate rejects a re-signed on-screen speaker missing from visible characters', () => {
  assertLockAndProjectionReject((blueprint) => {
    blueprint.shots[0].visible_character_ids = [];
  }, /必须可见/);
});

test('lock gate rejects a re-signed blueprint with an unreviewed character', () => {
  assertLockAndProjectionReject((blueprint) => {
    blueprint.characters[0].review_status = 'needs_review';
  }, /BLUEPRINT_REVIEW_REQUIRED/);
});

test('projects only lockable blueprints to source facts without guessing speaker names', () => {
  const facts = projectSourceFactsV2(lockedBlueprint());
  assert.equal(facts.schema_version, '2.0');
  assert.equal(facts.shots[0].dialogue[0].speaker_id, 'character-qiao-an');
  assert.equal(facts.shots[0].dialogue[0].speaker_kind, 'character');
  assert.equal(facts.shots[1].dialogue[0].speaker_id, 'narrator');
  assert.equal(facts.shots[1].dialogue[0].speaker_kind, 'off_screen');
  assert.equal(facts.shots[1].dialogue[0].off_screen, true);
  assert.deepEqual(facts.shots[1].dialogue[0].evidence_refs, ['evidence-audio-1']);
  assert.match(facts.facts_hash, /^[a-f0-9]{64}$/);

  assert.throws(
    () => projectSourceFactsV2(normalizeEpisodeBlueprint(fixtureBlueprint())),
    /BLUEPRINT_SPEAKER_REVIEW_REQUIRED/,
  );
});

module.exports = { fixtureBlueprint, lockedBlueprint };
