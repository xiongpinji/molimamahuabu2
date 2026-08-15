const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const sharp = require('sharp');

const {
  buildGeneratedCoverageManifest,
  canonicalCoverageSha256,
  validateGeneratedCoverageManifest,
} = require('../src/services/redrawFullFrameCoverageService');

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const WIDTH = 64;
const HEIGHT = 96;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function writePng(filePath, { width = WIDTH, height = HEIGHT, channels = 3, value = 64 } = {}) {
  const bytes = await sharp(Buffer.alloc(width * height * channels, value), {
    raw: { width, height, channels },
  }).png().toBuffer();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return sha256(bytes);
}

async function writeMask(filePath, { width = WIDTH, height = HEIGHT, value = 0, fillRect = true } = {}) {
  const pixels = Buffer.alloc(width * height, value);
  if (fillRect) {
    for (let y = 8; y < 20 && y < height; y += 1) {
      for (let x = 7; x < 19 && x < width; x += 1) pixels[(y * width) + x] = 255;
    }
  }
  const bytes = await sharp(pixels, { raw: { width, height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return sha256(bytes);
}

function validModelLock() {
  const components = [
    'tracker',
    'text_detector',
    'person_detector',
    'face_detector',
  ].map((component) => ({
    component,
    project: {
      face_detector: 'MediaPipe face detection',
      person_detector: 'YOLOX',
      text_detector: 'PaddleOCR',
      tracker: 'ByteTrack',
    }[component],
    repository: {
      face_detector: 'google-ai-edge/mediapipe',
      person_detector: 'Megvii-BaseDetection/YOLOX',
      text_detector: 'PaddlePaddle/PaddleOCR',
      tracker: 'FoundationVision/ByteTrack',
    }[component],
    revision: `rev-${component}-20260815`,
    artifact_name: `${component}.bin`,
    artifact_path: `${component}/model.bin`,
    artifact_sha256: HEX_A,
    license_name: `${component}-LICENSE`,
    license_evidence_path: `${component}/LICENSE.txt`,
    license_evidence_sha256: HEX_B,
  }));
  return {
    schema_version: 'redraw-full-frame-model-lock-v1',
    runtime: { node: 'test' },
    components,
    canonical_sha256: 'c'.repeat(64),
  };
}

async function createFixture(t) {
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-frame-coverage-'));
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));

  const frameShas = [];
  for (let index = 0; index < 6; index += 1) {
    frameShas[index] = await writePng(path.join(evidenceRoot, 'frames', `frame-${index}.png`), { value: 20 + index });
  }

  const maskPaths = [
    'masks/person-a-0.png',
    'masks/person-a-1.png',
    'masks/person-a-2.png',
    'masks/person-b-1.png',
    'masks/person-b-3.png',
    'masks/text-sub-0.png',
    'masks/text-sub-2.png',
    'masks/text-ui-4.png',
    'masks/text-ui-5.png',
  ];
  const maskShas = {};
  for (const maskPath of maskPaths) {
    maskShas[maskPath] = await writeMask(path.join(evidenceRoot, maskPath));
  }

  const mask = (maskPath) => ({
    path: maskPath,
    sha256: maskShas[maskPath],
    width: WIDTH,
    height: HEIGHT,
    mime_type: 'image/png',
  });

  const source = {
    sha256: 'd'.repeat(64),
    duration_ms: 6000,
    width: WIDTH,
    height: HEIGHT,
    frame_count: 6,
    time_base: { numerator: 1, denominator: 1 },
  };

  const frames = [5, 4, 3, 2, 1, 0].map((index) => ({
    frame_index: index,
    timestamp_ticks: index,
    timestamp_ms: index * 1000,
    shot_id: index < 3 ? 'shot-1' : 'shot-2',
    path: `frames\\frame-${index}.png`,
    sha256: frameShas[index],
    width: WIDTH,
    height: HEIGHT,
    person_region_ids: {
      0: ['p-a-0'],
      1: ['p-b-1', 'p-a-1'],
      2: ['p-a-2'],
      3: ['p-b-3'],
      4: [],
      5: [],
    }[index],
    text_region_ids: {
      0: ['t-sub-0'],
      1: [],
      2: ['t-sub-2'],
      3: [],
      4: ['t-ui-4'],
      5: ['t-ui-5'],
    }[index],
    review_point_reasons: index === 0 ? ['shot_start'] : [],
    review_status: 'not_required',
  }));

  const personTracks = [
    {
      track_key: 'person-extra',
      kind: 'background_extra',
      source_character_key: null,
      target_strategy: 'foreign_adult_extra',
      frame_ranges: [{ start_frame: 3, end_frame: 3 }, { start_frame: 1, end_frame: 1 }],
      visibility: [
        { start_frame: 1, end_frame: 1, state: 'partial' },
        { start_frame: 3, end_frame: 3, state: 'back_view' },
      ],
      regions: [
        {
          region_id: 'p-b-3',
          frame_index: 3,
          bbox: { x: 8, y: 8, width: 12, height: 12 },
          mask: mask('masks/person-b-3.png'),
          association_confidence: 0.75,
          detector_disagreement: false,
        },
        {
          region_id: 'p-b-1',
          frame_index: 1,
          bbox: { x: 8, y: 8, width: 12, height: 12 },
          mask: mask('masks/person-b-1.png'),
          association_confidence: 0.8,
          detector_disagreement: false,
        },
      ],
      review_status: 'pending',
      reviewer: null,
    },
    {
      track_key: 'person-hero',
      kind: 'story_role',
      source_character_key: 'role-hero',
      target_strategy: 'fixed_actor',
      frame_ranges: [{ start_frame: 2, end_frame: 2 }, { start_frame: 0, end_frame: 1 }],
      visibility: [
        { start_frame: 0, end_frame: 1, state: 'visible' },
        { start_frame: 2, end_frame: 2, state: 'occluded' },
      ],
      regions: [
        {
          region_id: 'p-a-2',
          frame_index: 2,
          bbox: { x: 7, y: 8, width: 12, height: 12 },
          mask: mask('masks/person-a-2.png'),
          association_confidence: 0.49,
          detector_disagreement: true,
        },
        {
          region_id: 'p-a-0',
          frame_index: 0,
          bbox: { x: 7, y: 8, width: 12, height: 12 },
          mask: mask('masks/person-a-0.png'),
          association_confidence: 0.95,
          detector_disagreement: false,
        },
        {
          region_id: 'p-a-1',
          frame_index: 1,
          bbox: { x: 7, y: 8, width: 12, height: 12 },
          mask: mask('masks/person-a-1.png'),
          association_confidence: 0.9,
          detector_disagreement: false,
        },
      ],
      review_status: 'pending',
      reviewer: null,
    },
  ];

  const textTracks = [
    {
      region_key: 'text-ui-blur',
      kind: 'ui',
      treatment: 'generalize',
      target_text_key: null,
      frame_ranges: [{ start_frame: 5, end_frame: 5 }, { start_frame: 4, end_frame: 4 }],
      regions: [
        {
          region_id: 't-ui-5',
          frame_index: 5,
          polygon: [{ x: 6, y: 30 }, { x: 18, y: 30 }, { x: 18, y: 38 }],
          mask: mask('masks/text-ui-5.png'),
        },
        {
          region_id: 't-ui-4',
          frame_index: 4,
          polygon: [{ x: 6, y: 30 }, { x: 18, y: 30 }, { x: 18, y: 38 }],
          mask: mask('masks/text-ui-4.png'),
        },
      ],
      review_status: 'pending',
      reviewer: null,
    },
    {
      region_key: 'text-subtitle',
      kind: 'subtitle',
      treatment: 'translate_subtitle',
      target_text_key: 'subtitle-line-1',
      frame_ranges: [{ start_frame: 2, end_frame: 2 }, { start_frame: 0, end_frame: 0 }],
      regions: [
        {
          region_id: 't-sub-2',
          frame_index: 2,
          polygon: [{ x: 10, y: 70 }, { x: 42, y: 70 }, { x: 42, y: 82 }],
          mask: mask('masks/text-sub-2.png'),
        },
        {
          region_id: 't-sub-0',
          frame_index: 0,
          polygon: [{ x: 10, y: 70 }, { x: 42, y: 70 }, { x: 42, y: 82 }],
          mask: mask('masks/text-sub-0.png'),
        },
      ],
      review_status: 'pending',
      reviewer: null,
    },
  ];

  return {
    evidenceRoot,
    input: {
      evidenceRoot,
      source,
      shots: [
        { shot_id: 'shot-2', start_ms: 3000, end_ms: 6000 },
        { shot_id: 'shot-1', start_ms: 0, end_ms: 3000 },
      ],
      frames,
      personTracks,
      textTracks,
      modelLock: validModelLock(),
    },
  };
}

async function buildValid(t) {
  const fixture = await createFixture(t);
  return {
    ...fixture,
    manifest: await buildGeneratedCoverageManifest(fixture.input),
  };
}

async function assertInvalid(promise, expectedCode, root) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error.code, expectedCode);
      const serialized = JSON.stringify(error);
      assert.equal(error.message, expectedCode);
      assert.doesNotMatch(serialized, /cause|ocr|secret|token|authorization|text source/);
      assert.doesNotMatch(serialized, /[A-Za-z]:\\/);
      if (root) assert.doesNotMatch(serialized, new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
      return true;
    },
  );
}

test('builds generated coverage manifest with sorted evidence, stable hash, pending review, and no root leakage', async (t) => {
  const { evidenceRoot, input, manifest } = await buildValid(t);
  const before = JSON.stringify(input);

  assert.deepEqual(Object.keys(manifest), [
    'schema_version',
    'status',
    'source',
    'models',
    'shots',
    'frames',
    'person_tracks',
    'text_tracks',
    'review',
    'unresolved_person_count',
    'unresolved_text_region_count',
    'approval_status',
    'ready_for_reference',
    'analysis_sha256',
  ]);
  assert.equal(manifest.schema_version, 'redraw-full-frame-coverage-v1');
  assert.equal(manifest.status, 'generated');
  assert.equal(manifest.approval_status, 'pending');
  assert.equal(manifest.ready_for_reference, false);
  assert.equal(manifest.unresolved_person_count, 0);
  assert.equal(manifest.unresolved_text_region_count, 0);
  assert.match(manifest.analysis_sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.analysis_sha256, canonicalCoverageSha256(manifest));
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(evidenceRoot.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));

  assert.deepEqual(manifest.shots.map((shot) => shot.shot_id), ['shot-1', 'shot-2']);
  assert.deepEqual(manifest.frames.map((frame) => frame.frame_index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(manifest.person_tracks.map((track) => track.track_key), ['person-extra', 'person-hero']);
  assert.deepEqual(manifest.text_tracks.map((track) => track.region_key), ['text-subtitle', 'text-ui-blur']);
  assert.deepEqual(manifest.frames[1].person_region_ids, ['p-a-1', 'p-b-1']);
  assert.deepEqual(manifest.models.components.map((item) => item.component), ['face_detector', 'person_detector', 'text_detector', 'tracker']);
  assert.equal(manifest.models.model_lock_sha256, input.modelLock.canonical_sha256);

  for (const frame of manifest.frames) {
    assert.equal(frame.path, `frames/frame-${frame.frame_index}.png`);
    assert.equal(frame.sha256, sha256(fs.readFileSync(path.join(evidenceRoot, frame.path))));
    assert.equal(frame.width, WIDTH);
    assert.equal(frame.height, HEIGHT);
    assert.doesNotMatch(frame.path, /\\/);
  }
  for (const track of manifest.person_tracks) {
    assert.equal(track.review_status, 'pending');
    assert.equal(track.reviewer, null);
    for (const region of track.regions) assert.equal(region.mask.sha256, sha256(fs.readFileSync(path.join(evidenceRoot, region.mask.path))));
  }
  for (const track of manifest.text_tracks) {
    assert.equal(track.review_status, 'pending');
    assert.equal(track.reviewer, null);
    for (const region of track.regions) assert.equal(region.mask.sha256, sha256(fs.readFileSync(path.join(evidenceRoot, region.mask.path))));
  }

  assert.ok(manifest.frames[0].review_point_reasons.includes('shot_start'));
  assert.ok(manifest.frames[2].review_point_reasons.includes('shot_end'));
  assert.ok(manifest.frames[2].review_point_reasons.includes('low_track_confidence'));
  assert.ok(manifest.frames[2].review_point_reasons.includes('detector_disagreement'));
  assert.ok(manifest.frames[2].review_point_reasons.includes('visibility_change'));
  assert.ok(manifest.frames[3].review_point_reasons.includes('shot_boundary'));
  assert.ok(manifest.frames[4].review_point_reasons.includes('text_region_count_change'));
  assert.equal(manifest.frames.filter((frame) => frame.review_point_reasons.length > 0).length, manifest.review.required_review_point_count);
  assert.equal(manifest.review.status, 'pending');
  assert.equal(manifest.review.reviewed_point_count, 0);
  assert.equal(manifest.review.reviewer, null);
  for (const frame of manifest.frames) {
    assert.equal(frame.review_status, frame.review_point_reasons.length > 0 ? 'pending' : 'not_required');
  }

  const reversed = clone(manifest);
  reversed.frames.reverse();
  reversed.shots.reverse();
  reversed.person_tracks.reverse();
  reversed.text_tracks.reverse();
  reversed.person_tracks.forEach((track) => {
    track.regions.reverse();
    track.frame_ranges.reverse();
    track.visibility.reverse();
  });
  reversed.text_tracks.forEach((track) => {
    track.regions.reverse();
    track.frame_ranges.reverse();
  });
  assert.equal(canonicalCoverageSha256(reversed), manifest.analysis_sha256);

  await assert.deepEqual(await validateGeneratedCoverageManifest({ evidenceRoot, manifest }), manifest);
  assert.equal(JSON.stringify(input), before);
});

test('frame coverage, timestamp drift, shot continuity, and empty shot gaps fail closed', async (t) => {
  const { evidenceRoot, input } = await createFixture(t);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    frames: input.frames.filter((frame) => frame.frame_index !== 5),
  }), 'REDRAW_FULL_FRAME_FRAME_GAP', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    frames: input.frames.concat({ ...input.frames[0] }),
  }), 'REDRAW_FULL_FRAME_FRAME_GAP', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    frames: input.frames.map((frame) => frame.frame_index === 2 ? { ...frame, timestamp_ms: 2001 } : frame),
  }), 'REDRAW_FULL_FRAME_FRAME_GAP', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    shots: [
      { shot_id: 'shot-1', start_ms: 0, end_ms: 2000 },
      { shot_id: 'shot-2', start_ms: 3000, end_ms: 6000 },
    ],
  }), 'REDRAW_FULL_FRAME_FRAME_GAP', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    shots: [
      { shot_id: 'shot-1', start_ms: 0, end_ms: 1000 },
      { shot_id: 'shot-2', start_ms: 1000, end_ms: 6000 },
    ],
  }), 'REDRAW_FULL_FRAME_FRAME_GAP', evidenceRoot);
});

test('person track classification and mapping rules fail closed', async (t) => {
  const { evidenceRoot, input } = await createFixture(t);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    personTracks: input.personTracks.map((track) => track.track_key === 'person-hero' ? { ...track, kind: 'unknown' } : track),
  }), 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    personTracks: input.personTracks.map((track) => track.track_key === 'person-hero' ? { ...track, source_character_key: '' } : track),
  }), 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    personTracks: input.personTracks.map((track) => track.track_key === 'person-extra' ? { ...track, target_strategy: 'fixed_actor' } : track),
  }), 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED', evidenceRoot);
});

test('text kind, treatment, target key, OCR, and unknown fields fail closed', async (t) => {
  const { evidenceRoot, input } = await createFixture(t);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    textTracks: input.textTracks.map((track) => track.region_key === 'text-subtitle' ? { ...track, kind: 'unknown' } : track),
  }), 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    textTracks: input.textTracks.map((track) => track.region_key === 'text-subtitle' ? { ...track, treatment: 'remove' } : track),
  }), 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    textTracks: input.textTracks.map((track) => track.region_key === 'text-subtitle' ? { ...track, target_text_key: 'placeholder' } : track),
  }), 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    textTracks: input.textTracks.map((track) => track.region_key === 'text-ui-blur' ? { ...track, target_text_key: 'ui-copy' } : track),
  }), 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    textTracks: input.textTracks.map((track) => track.region_key === 'text-ui-blur' ? { ...track, ocr_text: 'text source' } : track),
  }), 'REDRAW_FULL_FRAME_OUTPUT_INVALID', evidenceRoot);
});

test('geometry and per-frame region references fail closed', async (t) => {
  const { evidenceRoot, input } = await createFixture(t);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    personTracks: input.personTracks.map((track) => track.track_key === 'person-hero' ? {
      ...track,
      regions: track.regions.map((region) => region.region_id === 'p-a-0' ? { ...region, bbox: { x: 63, y: 0, width: 2, height: 2 } } : region),
    } : track),
  }), 'REDRAW_FULL_FRAME_MASK_INVALID', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    textTracks: input.textTracks.map((track) => track.region_key === 'text-subtitle' ? {
      ...track,
      regions: track.regions.map((region) => region.region_id === 't-sub-0' ? { ...region, polygon: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] } : region),
    } : track),
  }), 'REDRAW_FULL_FRAME_MASK_INVALID', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    frames: input.frames.map((frame) => frame.frame_index === 1 ? { ...frame, person_region_ids: ['p-a-1'] } : frame),
  }), 'REDRAW_FULL_FRAME_OUTPUT_INVALID', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    frames: input.frames.map((frame) => frame.frame_index === 1 ? { ...frame, text_region_ids: ['missing-region'] } : frame),
  }), 'REDRAW_FULL_FRAME_OUTPUT_INVALID', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    frames: input.frames.map((frame) => frame.frame_index === 1 ? { ...frame, person_region_ids: ['p-a-1', 'p-a-1', 'p-b-1'] } : frame),
  }), 'REDRAW_FULL_FRAME_OUTPUT_INVALID', evidenceRoot);
});

test('path safety, artifact hash drift, and mask validity fail closed', async (t) => {
  const { evidenceRoot, input } = await createFixture(t);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    frames: input.frames.map((frame) => frame.frame_index === 0 ? { ...frame, path: path.join(evidenceRoot, 'frames', 'frame-0.png') } : frame),
  }), 'REDRAW_FULL_FRAME_SOURCE_MISMATCH', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    frames: input.frames.map((frame) => frame.frame_index === 0 ? { ...frame, path: '../frame-0.png' } : frame),
  }), 'REDRAW_FULL_FRAME_SOURCE_MISMATCH', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    frames: input.frames.map((frame) => frame.frame_index === 0 ? { ...frame, sha256: '0'.repeat(64) } : frame),
  }), 'REDRAW_FULL_FRAME_SOURCE_MISMATCH', evidenceRoot);

  const badSizeMask = 'masks/bad-size.png';
  const badSizeSha = await writeMask(path.join(evidenceRoot, badSizeMask), { width: 32, height: HEIGHT });
  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    personTracks: input.personTracks.map((track) => track.track_key === 'person-hero' ? {
      ...track,
      regions: track.regions.map((region) => region.region_id === 'p-a-0' ? {
        ...region,
        mask: { ...region.mask, path: badSizeMask, sha256: badSizeSha, width: 32 },
      } : region),
    } : track),
  }), 'REDRAW_FULL_FRAME_MASK_INVALID', evidenceRoot);

  const nonBinaryMask = 'masks/non-binary.png';
  const nonBinarySha = await writeMask(path.join(evidenceRoot, nonBinaryMask), { value: 7, fillRect: false });
  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    personTracks: input.personTracks.map((track) => track.track_key === 'person-hero' ? {
      ...track,
      regions: track.regions.map((region) => region.region_id === 'p-a-0' ? {
        ...region,
        mask: { ...region.mask, path: nonBinaryMask, sha256: nonBinarySha },
      } : region),
    } : track),
  }), 'REDRAW_FULL_FRAME_MASK_INVALID', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    personTracks: input.personTracks.map((track) => track.track_key === 'person-hero' ? {
      ...track,
      regions: track.regions.map((region) => region.region_id === 'p-a-0' ? {
        ...region,
        mask: { ...region.mask, sha256: '0'.repeat(64) },
      } : region),
    } : track),
  }), 'REDRAW_FULL_FRAME_MASK_INVALID', evidenceRoot);
});

test('unknown nested fields, approvals, invalid model lock, and manifest hash drift fail closed', async (t) => {
  const { evidenceRoot, input, manifest } = await buildValid(t);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    approval_status: 'approved',
  }), 'REDRAW_FULL_FRAME_OUTPUT_INVALID', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    modelLock: { ...input.modelLock, canonical_sha256: 'z' },
  }), 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    modelLock: { schema_version: input.modelLock.schema_version, components: input.modelLock.components, canonical_sha256: input.modelLock.canonical_sha256 },
  }), 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    personTracks: input.personTracks.map((track) => track.track_key === 'person-hero' ? {
      ...track,
      regions: track.regions.map((region) => region.region_id === 'p-a-0' ? { ...region, candidate: true } : region),
    } : track),
  }), 'REDRAW_FULL_FRAME_OUTPUT_INVALID', evidenceRoot);

  await assertInvalid(buildGeneratedCoverageManifest({
    ...input,
    textTracks: input.textTracks.map((track) => track.region_key === 'text-subtitle' ? {
      ...track,
      regions: track.regions.map((region) => region.region_id === 't-sub-0' ? { ...region, content: 'text source' } : region),
    } : track),
  }), 'REDRAW_FULL_FRAME_OUTPUT_INVALID', evidenceRoot);

  await assertInvalid(validateGeneratedCoverageManifest({
    evidenceRoot,
    manifest: { ...manifest, analysis_sha256: '0'.repeat(64) },
  }), 'REDRAW_FULL_FRAME_OUTPUT_INVALID', evidenceRoot);

  await assertInvalid(validateGeneratedCoverageManifest({
    evidenceRoot,
    manifest: { ...manifest, url: 'https://example.test/output.json' },
  }), 'REDRAW_FULL_FRAME_OUTPUT_INVALID', evidenceRoot);

  await assertInvalid(validateGeneratedCoverageManifest({
    evidenceRoot,
    manifest: { ...manifest, approval_status: 'approved' },
  }), 'REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN', evidenceRoot);
});

test('symlink escape fails closed when supported', async (t) => {
  const { evidenceRoot, input } = await createFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-frame-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideFrame = path.join(outside, 'frame-0.png');
  fs.copyFileSync(path.join(evidenceRoot, 'frames', 'frame-0.png'), outsideFrame);
  fs.rmSync(path.join(evidenceRoot, 'frames', 'frame-0.png'));
  try {
    fs.symlinkSync(outsideFrame, path.join(evidenceRoot, 'frames', 'frame-0.png'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assertInvalid(buildGeneratedCoverageManifest(input), 'REDRAW_FULL_FRAME_SOURCE_MISMATCH', evidenceRoot);
});

test('read-time file identity drift fails closed', async (t) => {
  const { evidenceRoot, input } = await createFixture(t);
  const originalOpen = fsp.open;
  let patched = false;
  t.after(() => { fsp.open = originalOpen; });

  fsp.open = async (...args) => {
    const handle = await originalOpen.apply(fsp, args);
    if (!patched && String(args[0]).endsWith(path.join('frames', 'frame-0.png'))) {
      patched = true;
      const originalStat = handle.stat.bind(handle);
      let calls = 0;
      handle.stat = async (...statArgs) => {
        const stat = await originalStat(...statArgs);
        calls += 1;
        if (calls > 1) {
          return { ...stat, size: typeof stat.size === 'bigint' ? stat.size + 1n : stat.size + 1 };
        }
        return stat;
      };
    }
    return handle;
  };

  await assertInvalid(buildGeneratedCoverageManifest(input), 'REDRAW_FULL_FRAME_SOURCE_MISMATCH', evidenceRoot);
});
