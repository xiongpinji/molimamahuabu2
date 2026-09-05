const test = require('node:test');
const assert = require('node:assert/strict');

const { fuseEpisodeEvidence } = require('../src/services/redrawEvidenceFusionService');

const HASH = {
  source: 'a'.repeat(64),
  visual: 'b'.repeat(64),
  audio: 'c'.repeat(64),
};

function source() {
  return {
    asset_id: 101,
    sha256: HASH.source,
    duration_ms: 6_000,
    width: 1080,
    height: 1920,
    fps: 25,
    video_codec: 'h264',
    audio_codec: 'aac',
    audio_sample_rate_hz: 48_000,
    audio_channels: 2,
  };
}

function evidenceAssets() {
  return [
    {
      id: 'evidence-visual-1',
      kind: 'visual',
      asset_id: 201,
      sha256: HASH.visual,
      tool: 'native-source-analysis',
      tool_version: '1.0.0',
    },
    {
      id: 'evidence-audio-1',
      kind: 'audio_transcript',
      asset_id: 202,
      sha256: HASH.audio,
      tool: 'source-audio-evidence',
      tool_version: '1.0.0',
    },
  ];
}

function visualFacts() {
  return {
    schema_version: '2.0',
    duration_ms: 6_000,
    result_asset_id: 201,
    sha256: HASH.visual,
    story: ['林娜在客厅发现一封信。', '她拿起信封。'],
    characters: [{
      id: 'character-lin-na',
      source_name: '林娜',
      display_name: '林娜',
      relationship: '主人公',
      relationships: [],
    }],
    scenes: [{
      id: 'scene-living-room',
      location: '客厅',
      time: '白天',
      source_ranges: [{ start_ms: 0, end_ms: 6_000 }],
    }],
    props: [{
      id: 'prop-letter',
      name: '信封',
      evidence_ranges: [{ start_ms: 200, end_ms: 5_800 }],
    }],
    shots: [
      {
        id: 'shot-1',
        index: 1,
        start_ms: 0,
        end_ms: 3_000,
        composition: '林娜站在桌边的中景。',
        camera_movement: '固定机位',
        opening_state: '信封放在桌上。',
        continuous_action: '林娜伸手拿起信封。',
        ending_state: '信封停在她胸前。',
        visible_character_ids: ['character-lin-na'],
        dialogue: [{
          id: 'visual-guessed-line',
          speaker_id: 'character-lin-na',
          source_text: '画面模型猜测的对白',
          start_ms: 400,
          end_ms: 900,
        }],
        text_regions: [],
        audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
        confidence: {
          character_mapping: 0.84,
          speaker_mapping: 0.91,
          text_regions: 0.8,
          shot_boundary: 0.95,
        },
      },
      {
        id: 'shot-2',
        index: 2,
        start_ms: 3_000,
        end_ms: 6_000,
        composition: '信封占据画面中央。',
        camera_movement: '缓慢推近',
        opening_state: '林娜看向信封。',
        continuous_action: '她拆开封口。',
        ending_state: '信纸露出一角。',
        visible_character_ids: ['character-lin-na'],
        dialogue: [],
        text_regions: [{
          id: 'text-letter',
          kind: 'screen_text',
          source_text: '请勿回头',
          polygon: [[0.2, 0.3], [0.8, 0.3], [0.8, 0.45], [0.2, 0.45]],
        }],
        audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
        confidence: {
          character_mapping: 0.88,
          speaker_mapping: 0.2,
          text_regions: 0.9,
          shot_boundary: 0.93,
        },
      },
    ],
    causal_chain: ['林娜拿起信封后看见警告。'],
    locked_facts: ['林娜在客厅拿起信封。'],
    reversals: ['信中要求她不要回头。'],
    episode_hook: '林娜即将发现写信者。',
  };
}

function audioEvidence(segments = [{
  start_ms: 400,
  end_ms: 1_100,
  source_text: '这是谁寄来的？',
  speaker_cluster_id: 'speaker-cluster-1',
}]) {
  return {
    schema_version: 'redraw-source-audio-evidence-v1',
    source_asset_id: 101,
    source_video_sha256: HASH.source,
    dialogue_mode: 'spoken',
    source_language: 'zh-CN',
    language_probability: 0.97,
    segments,
    result_asset_id: 202,
    evidence_sha256: HASH.audio,
  };
}

function fuse(overrides = {}) {
  return fuseEpisodeEvidence({
    source: source(),
    visualFacts: visualFacts(),
    audioEvidence: audioEvidence(),
    evidenceAssets: evidenceAssets(),
    ...overrides,
  });
}

test('fuses timed audio transcript into visual shots without accepting guessed visual dialogue', () => {
  const blueprint = fuse();

  assert.equal(blueprint.schema_version, 'episode-blueprint-v1');
  assert.equal(blueprint.shots[0].dialogue.length, 1);
  assert.equal(blueprint.shots[0].dialogue[0].source_text, '这是谁寄来的？');
  assert.equal(blueprint.shots[0].dialogue[0].speaker_id, 'speaker-cluster-1');
  assert.equal(blueprint.shots[0].dialogue[0].speaker_kind, 'voice_cluster');
  assert.equal(blueprint.shots[0].dialogue[0].review_status, 'needs_review');
  assert.deepEqual(blueprint.shots[0].dialogue[0].evidence_refs, ['evidence-audio-1']);
  assert.equal(JSON.stringify(blueprint).includes('画面模型猜测的对白'), false);
  assert.equal(blueprint.review.status, 'needs_review');
  assert.match(blueprint.blueprint_hash, /^[a-f0-9]{64}$/);
});

test('assigns a cross-shot segment once to its largest-overlap shot and clips only the dialogue projection', () => {
  const segment = {
    id: 'audio-segment-crossing',
    evidence_ref: 'evidence-audio-1',
    start_ms: 2_500,
    end_ms: 4_500,
    source_text: '不要打开那封信。',
    speaker_cluster_id: 'speaker-cluster-2',
  };
  const blueprint = fuse({ audioEvidence: audioEvidence([segment]) });
  const outputTurns = blueprint.shots.flatMap((shot) => shot.dialogue);

  assert.equal(outputTurns.length, 1);
  assert.equal(outputTurns[0].id, 'audio-segment-crossing');
  assert.equal(outputTurns[0].source_text, segment.source_text);
  assert.equal(outputTurns[0].speaker_id, 'speaker-cluster-2');
  assert.equal(outputTurns[0].start_ms, 3_000);
  assert.equal(outputTurns[0].end_ms, 4_500);
  assert.equal(blueprint.shots[1].dialogue[0], outputTurns[0]);
});

test('uses midpoint ownership at an exact shot boundary when cross-shot overlap is tied', () => {
  const segment = {
    start_ms: 2_000,
    end_ms: 4_000,
    source_text: '边界上的一句话。',
    speaker_cluster_id: 'speaker-cluster-3',
  };
  const first = fuse({ audioEvidence: audioEvidence([segment]) });
  const second = fuse({
    audioEvidence: audioEvidence([segment]),
    evidenceAssets: evidenceAssets().reverse(),
  });

  assert.equal(first.shots[0].dialogue.length, 0);
  assert.equal(first.shots[1].dialogue.length, 1);
  assert.equal(first.shots[1].dialogue[0].start_ms, 3_000);
  assert.equal(first.shots[1].dialogue[0].end_ms, 4_000);
  assert.equal(first.shots[1].dialogue[0].id, second.shots[1].dialogue[0].id);
  assert.equal(first.blueprint_hash, second.blueprint_hash);
});

test('keeps unresolved clusters unclaimed even when a character is visible', () => {
  const blueprint = fuse();
  const turn = blueprint.shots[0].dialogue[0];

  assert.equal(turn.speaker_id, 'speaker-cluster-1');
  assert.equal(turn.speaker_kind, 'voice_cluster');
  assert.equal(turn.review_status, 'needs_review');
  assert.notEqual(turn.speaker_id, blueprint.shots[0].visible_character_ids[0]);
});

test('creates a visual-only blueprint with explicit silent audio evidence', () => {
  const silent = audioEvidence([]);
  silent.dialogue_mode = 'silent';
  silent.source_language = null;
  silent.language_probability = null;
  const assets = evidenceAssets();
  assets[1].kind = 'audio';

  const blueprint = fuse({ audioEvidence: silent, evidenceAssets: assets });

  assert.deepEqual(blueprint.shots.flatMap((shot) => shot.dialogue), []);
  assert.ok(blueprint.shots.every((shot) => shot.audio_contract.dialogue_mode === 'silent'));
  assert.ok(blueprint.shots.every((shot) => shot.evidence_refs.includes('evidence-audio-1')));
  assert.equal(blueprint.review.status, 'needs_review');
});

test('rejects visual gap, overlap, duration mismatch and out-of-range shots instead of filling time', () => {
  const gap = visualFacts();
  gap.shots[1].start_ms = 3_100;
  assert.throws(() => fuse({ visualFacts: gap }), /EVIDENCE_FUSION_TIMELINE_INVALID/);

  const overlap = visualFacts();
  overlap.shots[1].start_ms = 2_900;
  assert.throws(() => fuse({ visualFacts: overlap }), /EVIDENCE_FUSION_TIMELINE_INVALID/);

  const durationMismatch = visualFacts();
  durationMismatch.duration_ms = 6_001;
  assert.throws(() => fuse({ visualFacts: durationMismatch }), /EVIDENCE_FUSION_DURATION_MISMATCH/);

  const outOfRange = visualFacts();
  outOfRange.shots[1].end_ms = 6_001;
  assert.throws(() => fuse({ visualFacts: outOfRange }), /EVIDENCE_FUSION_TIMELINE_INVALID/);
});

test('fails closed for invalid manifest refs, unknown audio refs and silent transcript conflicts', () => {
  const invalidShaAssets = evidenceAssets();
  invalidShaAssets[0].sha256 = 'invalid';
  assert.throws(
    () => fuse({ evidenceAssets: invalidShaAssets }),
    /EVIDENCE_FUSION_EVIDENCE_INVALID/,
  );

  const unknownAudioRef = audioEvidence([{
    id: 'audio-segment-unknown-ref',
    evidence_ref: 'evidence-missing',
    start_ms: 500,
    end_ms: 900,
    source_text: '不能丢失。',
    speaker_cluster_id: 'speaker-cluster-1',
  }]);
  assert.throws(
    () => fuse({ audioEvidence: unknownAudioRef }),
    /EVIDENCE_FUSION_EVIDENCE_INVALID/,
  );

  const silentConflict = audioEvidence();
  silentConflict.dialogue_mode = 'silent';
  assert.throws(
    () => fuse({ audioEvidence: silentConflict }),
    /EVIDENCE_FUSION_AUDIO_INVALID/,
  );
});

test('rejects explicit evidence refs whose asset id or SHA disagrees with the manifest', () => {
  const mismatchedVisualAsset = visualFacts();
  mismatchedVisualAsset.evidence_ref = 'evidence-visual-1';
  mismatchedVisualAsset.result_asset_id = 999;
  assert.throws(
    () => fuse({ visualFacts: mismatchedVisualAsset }),
    /EVIDENCE_FUSION_EVIDENCE_INVALID/,
  );

  const mismatchedVisualSha = visualFacts();
  mismatchedVisualSha.evidence_ref = 'evidence-visual-1';
  mismatchedVisualSha.sha256 = 'd'.repeat(64);
  assert.throws(
    () => fuse({ visualFacts: mismatchedVisualSha }),
    /EVIDENCE_FUSION_EVIDENCE_INVALID/,
  );

  const mismatchedAudioAsset = audioEvidence();
  mismatchedAudioAsset.evidence_ref = 'evidence-audio-1';
  mismatchedAudioAsset.result_asset_id = 999;
  assert.throws(
    () => fuse({ audioEvidence: mismatchedAudioAsset }),
    /EVIDENCE_FUSION_EVIDENCE_INVALID/,
  );

  const mismatchedAudioSha = audioEvidence();
  mismatchedAudioSha.evidence_ref = 'evidence-audio-1';
  mismatchedAudioSha.evidence_sha256 = 'd'.repeat(64);
  assert.throws(
    () => fuse({ audioEvidence: mismatchedAudioSha }),
    /EVIDENCE_FUSION_EVIDENCE_INVALID/,
  );
});

test('rejects present but invalid story, character, shot and dialogue confidence values', () => {
  const invalidStory = visualFacts();
  invalidStory.story_confidence = '0.9';
  assert.throws(
    () => fuse({ visualFacts: invalidStory }),
    /EVIDENCE_FUSION_CONFIDENCE_INVALID/,
  );

  const invalidCharacter = visualFacts();
  invalidCharacter.characters[0].confidence = Number.NaN;
  assert.throws(
    () => fuse({ visualFacts: invalidCharacter }),
    /EVIDENCE_FUSION_CONFIDENCE_INVALID/,
  );

  const invalidShot = visualFacts();
  invalidShot.shots[0].confidence.character_mapping = -0.1;
  assert.throws(
    () => fuse({ visualFacts: invalidShot }),
    /EVIDENCE_FUSION_CONFIDENCE_INVALID/,
  );

  const invalidDialogue = audioEvidence();
  invalidDialogue.segments[0].confidence = 2;
  assert.throws(
    () => fuse({ audioEvidence: invalidDialogue }),
    /EVIDENCE_FUSION_CONFIDENCE_INVALID/,
  );
});

test('rejects transcript segments that do not overlap any source shot', () => {
  const unassigned = audioEvidence([{
    start_ms: 6_000,
    end_ms: 6_100,
    source_text: '越界对白。',
    speaker_cluster_id: 'speaker-cluster-1',
  }]);

  assert.throws(
    () => fuse({ audioEvidence: unassigned }),
    /EVIDENCE_FUSION_SEGMENT_UNASSIGNED/,
  );

  const partiallyOutOfRange = audioEvidence([{
    start_ms: 5_900,
    end_ms: 6_100,
    source_text: '部分越界对白。',
    speaker_cluster_id: 'speaker-cluster-1',
  }]);
  assert.throws(
    () => fuse({ audioEvidence: partiallyOutOfRange }),
    /EVIDENCE_FUSION_SEGMENT_UNASSIGNED/,
  );
});
