const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const sharp = require('sharp');

const {
  buildGeneratedCoverageManifest,
  canonicalCoverageSha256,
  validateGeneratedCoverageManifest,
} = require('../src/services/redrawFullFrameCoverageService');
const {
  canonicalizeModelLock,
  canonicalSha256: canonicalModelLockSha256,
} = require('../src/services/redrawFullFrameModelLockService');
const review = require('../src/services/redrawFullFrameReviewService');
const recorder = require('../scripts/record-redraw-full-frame-review-local');

const WIDTH = 64;
const HEIGHT = 96;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function writePng(filePath, { channels = 3, value = 64, rect } = {}) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * channels, value);
  if (rect) {
    pixels.fill(0);
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) pixels[(y * WIDTH) + x] = 255;
    }
  }
  const image = sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels } });
  const bytes = await (channels === 1 ? image.toColourspace('b-w') : image).png().toBuffer();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return sha256(bytes);
}

function validModelLock() {
  const components = ['tracker', 'text_detector', 'person_detector', 'face_detector'].map((component) => ({
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
    revision: `rev-${component}-20260816`,
    artifact_name: `${component}.bin`,
    artifact_path: `${component}/model.bin`,
    artifact_sha256: 'a'.repeat(64),
    license_name: `${component}-LICENSE`,
    license_evidence_path: `${component}/LICENSE.txt`,
    license_evidence_sha256: 'b'.repeat(64),
  }));
  const lock = {
    schema_version: 'redraw-full-frame-model-lock-v2',
    runtimes: {
      main: {
        python_version: 'Python 3.11.9',
        interpreter_path: 'runtime/main/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/main/pip-freeze.txt',
        pip_freeze_sha256: '1'.repeat(64),
      },
      text: {
        python_version: 'Python 3.11.9',
        interpreter_path: 'runtime/text/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/text/pip-freeze.txt',
        pip_freeze_sha256: '2'.repeat(64),
      },
    },
    components,
  };
  return { ...lock, canonical_sha256: canonicalModelLockSha256(canonicalizeModelLock(lock)) };
}

async function fixture(t, { shotCount = 9 } = {}) {
  const evidenceRoot = tempDir(t, 'redraw-review-analysis-');
  const frameShas = [];
  for (let i = 0; i < shotCount; i += 1) frameShas[i] = await writePng(path.join(evidenceRoot, 'frames', `frame-${i}.png`), { value: 20 + (i % 100) });
  const maskPaths = ['masks/person-a-0.png', 'masks/person-a-1.png', 'masks/person-b-1.png', 'masks/text-sub-0.png', 'masks/text-ui-4.png'];
  const maskShas = {};
  for (const rel of maskPaths) maskShas[rel] = await writePng(path.join(evidenceRoot, rel), { channels: 1, rect: { x: 8, y: 8, width: 14, height: 14 } });
  const mask = (rel) => ({ path: rel, sha256: maskShas[rel], width: WIDTH, height: HEIGHT, mime_type: 'image/png' });
  const source = { sha256: 'd'.repeat(64), duration_ms: shotCount * 1000, width: WIDTH, height: HEIGHT, frame_count: shotCount, time_base: { numerator: 1, denominator: 1 } };
  const includeUiTrack = shotCount > 4;
  const frames = Array.from({ length: shotCount }, (_, i) => ({
    frame_index: i,
    timestamp_ticks: i,
    timestamp_ms: i * 1000,
    shot_id: `shot-${i + 1}`,
    path: `frames/frame-${i}.png`,
    sha256: frameShas[i],
    width: WIDTH,
    height: HEIGHT,
    person_region_ids: i === 0 ? ['p-a-0'] : i === 1 ? ['p-a-1', 'p-b-1'] : [],
    text_region_ids: i === 0 ? ['t-sub-0'] : includeUiTrack && i === 4 ? ['t-ui-4'] : [],
    review_point_reasons: [],
    review_status: 'not_required',
  }));
  const manifest = await buildGeneratedCoverageManifest({
    evidenceRoot,
    source,
    shots: Array.from({ length: shotCount }, (_, i) => ({ shot_id: `shot-${i + 1}`, start_ms: i * 1000, end_ms: (i + 1) * 1000 })),
    frames,
    personTracks: [
      {
        track_key: 'person-a',
        kind: 'story_role',
        source_character_key: 'role-a',
        target_strategy: 'fixed_actor',
        frame_ranges: [{ start_frame: 0, end_frame: 1 }],
        visibility: [{ start_frame: 0, end_frame: 1, state: 'visible' }],
        regions: [
          { region_id: 'p-a-0', frame_index: 0, bbox: { x: 8, y: 8, width: 14, height: 14 }, mask: mask('masks/person-a-0.png'), association_confidence: 0.9, detector_disagreement: false },
          { region_id: 'p-a-1', frame_index: 1, bbox: { x: 9, y: 9, width: 14, height: 14 }, mask: mask('masks/person-a-1.png'), association_confidence: 0.4, detector_disagreement: true },
        ],
        review_status: 'pending',
        reviewer: null,
      },
      {
        track_key: 'person-b',
        kind: 'background_extra',
        source_character_key: null,
        target_strategy: 'foreign_adult_extra',
        frame_ranges: [{ start_frame: 1, end_frame: 1 }],
        visibility: [{ start_frame: 1, end_frame: 1, state: 'partial' }],
        regions: [{ region_id: 'p-b-1', frame_index: 1, bbox: { x: 30, y: 8, width: 10, height: 16 }, mask: mask('masks/person-b-1.png'), association_confidence: 0.8, detector_disagreement: false }],
        review_status: 'pending',
        reviewer: null,
      },
    ],
    textTracks: [
      {
        region_key: 'subtitle-a',
        kind: 'subtitle',
        treatment: 'translate_subtitle',
        target_text_key: 'subtitle-a',
        frame_ranges: [{ start_frame: 0, end_frame: 0 }],
        regions: [{ region_id: 't-sub-0', frame_index: 0, polygon: [{ x: 8, y: 70 }, { x: 40, y: 70 }, { x: 40, y: 80 }], mask: mask('masks/text-sub-0.png') }],
        review_status: 'pending',
        reviewer: null,
      },
      includeUiTrack ? {
        region_key: 'ui-a',
        kind: 'ui',
        treatment: 'remove',
        target_text_key: null,
        frame_ranges: [{ start_frame: 4, end_frame: 4 }],
        regions: [{ region_id: 't-ui-4', frame_index: 4, polygon: [{ x: 5, y: 5 }, { x: 20, y: 5 }, { x: 20, y: 20 }], mask: mask('masks/text-ui-4.png') }],
        review_status: 'pending',
        reviewer: null,
      } : null,
    ].filter(Boolean),
    modelLock: validModelLock(),
  });
  fs.writeFileSync(path.join(evidenceRoot, 'redraw-full-frame-coverage-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { evidenceRoot, manifest };
}

function decisionsFor(manifest, mutate = (point) => ({ ...point, decision: 'accepted', corrections: [] })) {
  return {
    schema_version: 'redraw-full-frame-review-decisions-v1',
    analysis_sha256: manifest.analysis_sha256,
    reviewer: 'codex-local-review',
    review_points: manifest.frames
      .filter((frame) => frame.review_point_reasons.length > 0)
      .map((frame) => mutate({
        frame_index: frame.frame_index,
        reasons: frame.review_point_reasons,
        decision: 'pending',
        corrections: [],
      })),
  };
}

async function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const stat = fs.lstatSync(abs);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (stat.isDirectory()) walk(abs);
      else out[rel] = `${stat.size}:${sha256(fs.readFileSync(abs))}`;
    }
  };
  walk(root);
  return out;
}

function assertNoTempOrLock(dir) {
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-') || name.endsWith('.lock')), []);
}

function makeJunctionOrSkip(t, target, link) {
  try {
    fs.symlinkSync(target, link, 'junction');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`junction unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
  return true;
}

test('normalizes all accepted decisions and rejects drift, pending, corrections, approvals, and secret shapes', async (t) => {
  const { manifest } = await fixture(t);
  const input = decisionsFor(manifest);
  const before = JSON.stringify(input);
  const normalized = review.normalizeReviewDecisions({ generatedManifest: manifest, decisions: input });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(normalized.review_points.map((point) => point.decision), input.review_points.map(() => 'accepted'));

  for (const bad of [
    { ...input, reviewer: '' },
    { ...input, analysis_sha256: '0'.repeat(64) },
    { ...input, review_points: input.review_points.slice(1) },
    { ...input, review_points: [...input.review_points, input.review_points[0]] },
    { ...input, review_points: input.review_points.map((point, index) => index === 0 ? { ...point, frame_index: 999 } : point) },
    { ...input, review_points: input.review_points.map((point, index) => index === 0 ? { ...point, reasons: [...point.reasons].reverse() } : point) },
    { ...input, review_points: input.review_points.map((point, index) => index === 0 ? { ...point, decision: 'pending' } : point) },
    { ...input, review_points: input.review_points.map((point, index) => index === 0 ? { ...point, corrections: [{ action: 'remove_person_candidate', region_id: 'p-a-0' }] } : point) },
    { ...input, approved: true },
    { ...input, review_points: input.review_points.map((point, index) => index === 0 ? { ...point, corrections: [{ action: 'bad' }], decision: 'corrected' } : point) },
  ]) {
    assert.throws(() => review.normalizeReviewDecisions({ generatedManifest: manifest, decisions: bad }), /REDRAW_FULL_FRAME_REVIEW_INCOMPLETE|REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN/);
  }
});

test('applies all correction action families without mutating the generated manifest', async (t) => {
  const { evidenceRoot, manifest } = await fixture(t);
  const correctedDecisions = decisionsFor(manifest, (point) => point.frame_index === 1 ? {
      ...point,
      decision: 'corrected',
      corrections: [
        { action: 'add_person_region', region_id: 'p-new-1', frame_index: 1, track_key: 'person-new', bbox: { x: 42, y: 10, width: 10, height: 12 }, visibility: 'visible', kind: 'background_extra', source_character_key: null, target_strategy: 'foreign_adult_extra' },
        { action: 'remove_person_candidate', region_id: 'p-b-1' },
        { action: 'merge_person_tracks', source_track_keys: ['person-a', 'person-new'], target_track_key: 'person-a', kind: 'story_role', source_character_key: 'role-a', target_strategy: 'fixed_actor' },
        { action: 'split_person_track', track_key: 'person-a', split_frame_index: 1, new_track_key: 'person-a-late' },
        { action: 'add_text_region', region_id: 't-new-1', frame_index: 1, region_key: 'screen-new', polygon: [{ x: 6, y: 6 }, { x: 26, y: 6 }, { x: 26, y: 18 }], kind: 'screen', treatment: 'localize_screen', target_text_key: 'screen-new' },
        { action: 'add_text_region', region_id: 't-remove-1', frame_index: 1, region_key: 'screen-remove', polygon: [{ x: 30, y: 6 }, { x: 46, y: 6 }, { x: 46, y: 18 }], kind: 'screen', treatment: 'localize_screen', target_text_key: 'screen-remove' },
        { action: 'remove_text_candidate', region_id: 't-remove-1' },
        { action: 'change_text_kind', region_key: 'ui-a', kind: 'watermark' },
        { action: 'change_text_treatment', region_key: 'ui-a', treatment: 'generalize', target_text_key: null },
      ],
    } : { ...point, decision: 'accepted', corrections: [] });
  const decisions = review.normalizeReviewDecisions({
    generatedManifest: manifest,
    decisions: correctedDecisions,
  });
  const before = JSON.stringify(manifest);
  const result = review.applyCorrections({ generatedManifest: manifest, normalizedDecisions: decisions });
  assert.equal(JSON.stringify(manifest), before);
  assert.equal(result.pending_masks.length, 2);
  assert.equal(result.summary.action_counts.add_person_region, 1);
  assert(result.manifest.person_tracks.some((track) => track.track_key === 'person-a-late'));
  assert(result.manifest.text_tracks.some((track) => track.region_key === 'screen-new'));

  const outputRoot = path.join(tempDir(t, 'redraw-review-final-'), 'reviewed');
  const finalized = await review.finalizeReviewedCoverage({ analysisRoot: evidenceRoot, decisions: correctedDecisions, outputRoot });
  assert.equal(finalized.reviewed_manifest.review.status, 'reviewed');
  assert.equal(fs.existsSync(path.join(outputRoot, 'redraw-full-frame-reviewed-manifest.json')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, 'masks', 'review', 'person', 'p-new-1.png')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, 'masks', 'review', 'text', 't-new-1.png')), true);
});

test('finalize writes immutable reviewed evidence, summary, decisions, sheets, html, and rejects unsafe outputs', async (t) => {
  const { evidenceRoot, manifest } = await fixture(t);
  const before = await snapshot(evidenceRoot);
  const root = tempDir(t, 'redraw-review-publish-');
  const outputRoot = path.join(root, 'reviewed');
  const result = await review.finalizeReviewedCoverage({ analysisRoot: evidenceRoot, decisions: decisionsFor(manifest), outputRoot });
  assert.deepEqual(await snapshot(evidenceRoot), before);
  assert.equal(result.files.manifest, 'redraw-full-frame-reviewed-manifest.json');
  const reviewed = JSON.parse(fs.readFileSync(path.join(outputRoot, 'redraw-full-frame-reviewed-manifest.json'), 'utf8'));
  assert.equal(reviewed.status, 'reviewed');
  assert.equal(reviewed.review.status, 'reviewed');
  assert.equal(reviewed.review.reviewed, true);
  assert.equal(reviewed.review.reviewed_point_count, reviewed.review.required_review_point_count);
  assert.equal(reviewed.approval_status, 'pending');
  assert.equal(reviewed.ready_for_reference, false);
  assert.equal(fs.existsSync(path.join(outputRoot, 'review-correction-summary.json')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, 'review-decisions.json')), true);
  assert.equal(fs.readdirSync(path.join(outputRoot, 'reviewed-contact-sheets')).length, 1);
  assert.match(fs.readFileSync(path.join(outputRoot, 'reviewed-review', 'index.html'), 'utf8'), /reviewed-contact-sheets/);
  assert.doesNotMatch(JSON.stringify(result), /[A-Za-z]:\\|https?:\/\//);
  await review.validateReviewedCoverageManifest({ evidenceRoot: outputRoot, manifest: reviewed });
  await assert.rejects(review.validateReviewedCoverageManifest({
    evidenceRoot: outputRoot,
    manifest: { ...reviewed, frames: reviewed.frames.map((frame, index) => index === 0 ? { ...frame, review_status: 'pending' } : frame) },
  }), /REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN|REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  const duplicatedShot = JSON.parse(JSON.stringify(reviewed));
  duplicatedShot.shots = [...duplicatedShot.shots, duplicatedShot.shots[0]];
  duplicatedShot.analysis_sha256 = canonicalCoverageSha256(duplicatedShot);
  await assert.rejects(review.validateReviewedCoverageManifest({ evidenceRoot: outputRoot, manifest: duplicatedShot }), /REDRAW_FULL_FRAME_/);

  const extraShot = JSON.parse(JSON.stringify(reviewed));
  extraShot.shots = [...extraShot.shots, { shot_id: 'shot-10', start_ms: 9000, end_ms: 10000 }];
  extraShot.analysis_sha256 = canonicalCoverageSha256(extraShot);
  await assert.rejects(review.validateReviewedCoverageManifest({ evidenceRoot: outputRoot, manifest: extraShot }), /REDRAW_FULL_FRAME_/);

  const missingShot = JSON.parse(JSON.stringify(reviewed));
  missingShot.shots = missingShot.shots.slice(1);
  missingShot.analysis_sha256 = canonicalCoverageSha256(missingShot);
  await assert.rejects(review.validateReviewedCoverageManifest({ evidenceRoot: outputRoot, manifest: missingShot }), /REDRAW_FULL_FRAME_/);

  await assert.rejects(review.finalizeReviewedCoverage({ analysisRoot: evidenceRoot, decisions: decisionsFor(manifest), outputRoot: evidenceRoot }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  fs.mkdirSync(path.join(root, 'occupied'));
  fs.writeFileSync(path.join(root, 'occupied', 'keep.txt'), 'keep');
  await assert.rejects(review.finalizeReviewedCoverage({ analysisRoot: evidenceRoot, decisions: decisionsFor(manifest), outputRoot: path.join(root, 'occupied') }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.equal(fs.readFileSync(path.join(root, 'occupied', 'keep.txt'), 'utf8'), 'keep');
});

test('finalize rejects path-escaping review region ids and leaves no output or external pollution', async (t) => {
  const { evidenceRoot, manifest } = await fixture(t);
  const root = tempDir(t, 'redraw-review-escape-');
  const outputRoot = path.join(root, 'reviewed');
  const outsidePerson = path.join(root, 'person-escape.png');
  const outsideText = path.join(root, 'text-escape.png');
  const frameIndex = manifest.frames.find((frame) => frame.review_point_reasons.length > 0).frame_index;

  for (const corrections of [
    [{ action: 'add_person_region', region_id: '..\\..\\person-escape', frame_index: frameIndex, track_key: 'person-new', bbox: { x: 42, y: 10, width: 10, height: 12 }, visibility: 'visible', kind: 'background_extra', source_character_key: null, target_strategy: 'foreign_adult_extra' }],
    [{ action: 'add_text_region', region_id: '..\\..\\text-escape', frame_index: frameIndex, region_key: 'screen-new', polygon: [{ x: 6, y: 6 }, { x: 26, y: 6 }, { x: 26, y: 18 }], kind: 'screen', treatment: 'localize_screen', target_text_key: 'screen-new' }],
  ]) {
    const decisions = decisionsFor(manifest, (point) => point.frame_index === frameIndex
      ? { ...point, decision: 'corrected', corrections }
      : { ...point, decision: 'accepted', corrections: [] });
    await assert.rejects(review.finalizeReviewedCoverage({ analysisRoot: evidenceRoot, decisions, outputRoot }), (error) => {
      assert.match(error.code, /^REDRAW_FULL_FRAME_/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(fs.existsSync(outputRoot), false);
    assert.equal(fs.existsSync(outsidePerson), false);
    assert.equal(fs.existsSync(outsideText), false);
  }
});

test('finalize supports 3 and 12 shot analyses with internally derived contact sheet counts', async (t) => {
  for (const [shotCount, expectedSheetCount] of [[3, 1], [12, 2]]) {
    const { evidenceRoot, manifest } = await fixture(t, { shotCount });
    const outputRoot = path.join(tempDir(t, `redraw-review-${shotCount}-shot-`), 'reviewed');
    const result = await review.finalizeReviewedCoverage({ analysisRoot: evidenceRoot, decisions: decisionsFor(manifest), outputRoot });
    const reviewed = JSON.parse(fs.readFileSync(path.join(outputRoot, 'redraw-full-frame-reviewed-manifest.json'), 'utf8'));

    assert.equal(result.reviewed_manifest.shots.length, shotCount);
    assert.equal(reviewed.shots.length, shotCount);
    assert.equal(reviewed.review.status, 'reviewed');
    assert.equal(fs.readdirSync(path.join(outputRoot, 'reviewed-contact-sheets')).length, expectedSheetCount);
    assert.equal(result.contact_sheets.length, expectedSheetCount);
    await review.validateReviewedCoverageManifest({ evidenceRoot: outputRoot, manifest: reviewed });
  }
});

test('analysis snapshot detects empty directory drift before publish and preserves output absence', async (t) => {
  const { evidenceRoot, manifest } = await fixture(t);
  const outputRoot = path.join(tempDir(t, 'redraw-review-drift-'), 'reviewed');
  const originalRename = fs.promises.rename;
  let injected = false;
  t.after(() => { fs.promises.rename = originalRename; });
  fs.promises.rename = async (from, to) => {
    if (!injected && path.resolve(to) === path.resolve(outputRoot)) {
      injected = true;
      fs.mkdirSync(path.join(evidenceRoot, 'empty-drift-dir'));
    }
    return originalRename.call(fs.promises, from, to);
  };
  await assert.rejects(review.finalizeReviewedCoverage({ analysisRoot: evidenceRoot, decisions: decisionsFor(manifest), outputRoot }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.equal(fs.existsSync(outputRoot), false);
  assert.equal(fs.existsSync(path.join(evidenceRoot, 'empty-drift-dir')), true);
});

test('recorder init, decide, show-pending, argument gates, and CLI smoke are deterministic', async (t) => {
  const { evidenceRoot, manifest } = await fixture(t);
  const root = tempDir(t, 'redraw-review-recorder-');
  const decisionsPath = path.join(root, 'decisions.json');
  assert.deepEqual(recorder.parseArgs(['init', '--analysis-dir', evidenceRoot, '--output', decisionsPath]), { command: 'init', analysisDir: evidenceRoot, output: decisionsPath });
  await recorder.runInit({ analysisDir: evidenceRoot, output: decisionsPath });
  let stored = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  assert.equal(stored.reviewer, 'codex-local-review');
  assert.deepEqual(stored.review_points.map((point) => point.decision), stored.review_points.map(() => 'pending'));
  assert.deepEqual(await recorder.runShowPending({ decisions: decisionsPath }), { pending: stored.review_points.map((point) => ({ frame_index: point.frame_index, reasons: point.reasons })) });
  const first = stored.review_points[0];
  await recorder.runDecide({ decisions: decisionsPath, frameIndex: first.frame_index, decision: 'accepted' });
  stored = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  assert.equal(stored.review_points[0].decision, 'accepted');
  const afterFirstHash = sha256(fs.readFileSync(decisionsPath));
  await assert.rejects(recorder.runDecide({ decisions: decisionsPath, frameIndex: first.frame_index, decision: 'accepted' }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.equal(sha256(fs.readFileSync(decisionsPath)), afterFirstHash);
  const second = stored.review_points.find((point) => point.decision === 'pending');
  await recorder.runDecide({ decisions: decisionsPath, frameIndex: second.frame_index, decision: 'corrected', correctionJson: JSON.stringify({ action: 'change_text_treatment', region_key: 'ui-a', treatment: 'remove', target_text_key: null }) });
  assert.throws(() => recorder.parseArgs(['decide', '--decisions', decisionsPath, '--frame-index', String(first.frame_index), '--decision', 'accepted', '--approved']), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.throws(() => recorder.parseArgs(['init', '--analysis-dir', 'https://example.test/a', '--output', decisionsPath]), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);

  const cli = spawnSync(process.execPath, ['scripts/record-redraw-full-frame-review-local.js', 'show-pending', '--decisions', decisionsPath], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /"pending"/);
  assert.doesNotMatch(cli.stdout, /[A-Za-z]:\\|https?:\/\//);
  assert.equal(manifest.analysis_sha256, stored.analysis_sha256);
});

test('recorder concurrent decide uses lock and permits exactly one writer without lost update', async (t) => {
  const { evidenceRoot } = await fixture(t);
  const root = tempDir(t, 'redraw-review-recorder-race-');
  const decisionsPath = path.join(root, 'decisions.json');
  await recorder.runInit({ analysisDir: evidenceRoot, output: decisionsPath });
  const stored = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  const frameIndex = stored.review_points[0].frame_index;
  const workers = await Promise.allSettled([
    recorder.runDecide({ decisions: decisionsPath, frameIndex, decision: 'accepted' }),
    recorder.runDecide({ decisions: decisionsPath, frameIndex, decision: 'accepted' }),
  ]);
  assert.equal(workers.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(workers.filter((item) => item.status === 'rejected' && /^REDRAW_FULL_FRAME_/.test(item.reason.code)).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(decisionsPath, 'utf8')).review_points.find((point) => point.frame_index === frameIndex).decision, 'accepted');
  assert.equal(fs.existsSync(`${decisionsPath}.lock`), false);
});

test('recorder rejects init and decide through a junction parent without touching the real target', async (t) => {
  const { evidenceRoot } = await fixture(t);
  const root = tempDir(t, 'redraw-review-recorder-junction-');
  const realTarget = path.join(root, 'real-target');
  const junction = path.join(root, 'junction-parent');
  fs.mkdirSync(realTarget);
  if (!makeJunctionOrSkip(t, realTarget, junction)) return;

  await assert.rejects(recorder.runInit({ analysisDir: evidenceRoot, output: path.join(junction, 'decisions.json') }), (error) => {
    assert.equal(error.code, 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
    assert.doesNotMatch(JSON.stringify(error), /[A-Za-z]:\\/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(realTarget), []);
  assertNoTempOrLock(realTarget);

  const decisionsPath = path.join(realTarget, 'decisions.json');
  await recorder.runInit({ analysisDir: evidenceRoot, output: decisionsPath });
  const beforeHash = sha256(fs.readFileSync(decisionsPath));
  const frameIndex = JSON.parse(fs.readFileSync(decisionsPath, 'utf8')).review_points[0].frame_index;
  await assert.rejects(recorder.runDecide({ decisions: path.join(junction, 'decisions.json'), frameIndex, decision: 'accepted' }), (error) => {
    assert.equal(error.code, 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
    assert.doesNotMatch(JSON.stringify(error), /[A-Za-z]:\\/);
    return true;
  });
  assert.equal(sha256(fs.readFileSync(decisionsPath)), beforeHash);
  assertNoTempOrLock(realTarget);
});

test('recorder preserves existing locks and only removes its own lock on internal failure', async (t) => {
  const { evidenceRoot } = await fixture(t);
  const root = tempDir(t, 'redraw-review-recorder-locks-');
  const decisionsPath = path.join(root, 'decisions.json');
  await recorder.runInit({ analysisDir: evidenceRoot, output: decisionsPath });
  const frameIndex = JSON.parse(fs.readFileSync(decisionsPath, 'utf8')).review_points[0].frame_index;
  const beforeHash = sha256(fs.readFileSync(decisionsPath));
  const lockPath = `${decisionsPath}.lock`;
  fs.writeFileSync(lockPath, '{"owner":"external"}\n');
  await assert.rejects(recorder.runDecide({ decisions: decisionsPath, frameIndex, decision: 'accepted' }), (error) => {
    assert.equal(error.code, 'REDRAW_FULL_FRAME_REVIEW_LOCKED');
    return true;
  });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '{"owner":"external"}\n');
  assert.equal(sha256(fs.readFileSync(decisionsPath)), beforeHash);
  const cli = spawnSync(process.execPath, ['scripts/record-redraw-full-frame-review-local.js', 'decide', '--decisions', decisionsPath, '--frame-index', String(frameIndex), '--decision', 'accepted'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr.trim(), 'REDRAW_FULL_FRAME_REVIEW_LOCKED');
  fs.rmSync(lockPath);

  const originalRename = fs.promises.rename;
  let observedLock = null;
  t.after(() => { fs.promises.rename = originalRename; });
  fs.promises.rename = async (from, to) => {
    if (path.resolve(to) === path.resolve(decisionsPath)) {
      observedLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      throw new Error('synthetic rename failure');
    }
    return originalRename.call(fs.promises, from, to);
  };
  await assert.rejects(recorder.runDecide({ decisions: decisionsPath, frameIndex, decision: 'accepted' }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.match(String(observedLock.pid), /^\d+$/);
  assert.match(observedLock.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(observedLock.decisions_sha256, beforeHash);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(sha256(fs.readFileSync(decisionsPath)), beforeHash);
  assertNoTempOrLock(root);
});
