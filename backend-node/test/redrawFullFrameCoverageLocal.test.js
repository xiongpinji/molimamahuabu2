const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const sharp = require('sharp');

const sourcePolicy = require('../config/redraw-full-frame-model-sources.json');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg, hasLocalFfprobe } = require('../src/utils/ffmpegPath');
const { validateModelLock } = require('../src/services/redrawFullFrameModelLockService');
const exporter = require('../scripts/export-redraw-full-frame-audit-case');
const runner = require('../scripts/run-redraw-full-frame-coverage-local');

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertSanitized(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(serialized, /https?:\/\/|file:\/\//i);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\/);
  assert.doesNotMatch(serialized, /authorization\s*[:=]|api[_-]?key\s*[:=]|client_secret\s*[:=]|access-token\s*[:=]|bearer\s+/i);
  assert.doesNotMatch(serialized, /不是哥们|新浪体育|南非对墨西哥|世界杯/i);
}

async function writeModelLock(t) {
  const cacheRoot = tempDir(t, 'redraw-local-lock-');
  const components = sourcePolicy.sources.map((source) => {
    const artifactPath = `${source.component}/model.bin`;
    const licensePath = `${source.component}/LICENSE.txt`;
    fs.mkdirSync(path.join(cacheRoot, source.component), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, artifactPath), `${source.component}:artifact\n`);
    fs.writeFileSync(path.join(cacheRoot, licensePath), `${source.component}:license\n`);
    return {
      component: source.component,
      project: source.project,
      repository: source.repository,
      revision: `fixed-${source.component}-20260815`,
      artifact_name: `${source.component}.bin`,
      artifact_path: artifactPath,
      artifact_sha256: sha256File(path.join(cacheRoot, artifactPath)),
      license_name: `${source.component}-license.txt`,
      license_evidence_path: licensePath,
      license_evidence_sha256: sha256File(path.join(cacheRoot, licensePath)),
    };
  });
  const lock = { schema_version: 'redraw-full-frame-model-lock-v1', runtime: { node: 'test' }, components };
  const validated = await validateModelLock({ cacheRoot, sourcePolicy, lock });
  const lockPath = path.join(cacheRoot, 'model-lock.json');
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  return { cacheRoot, lockPath, validated };
}

function buildSyntheticCase({ videoPath, width = 64, height = 36, durationMs = 9000, codec = 'h264', frameRate = 1, caseId = 'synthetic-local-case', shots } = {}) {
  const cast = [
    { id: 'mateo', role: 'protagonist', age_min: 18 },
    { id: 'diego', role: 'classmate', age_min: 18 },
    { id: 'lucas', role: 'friend', age_min: 18 },
    { id: 'elena', role: 'mother', age_min: 35 },
    { id: 'rafael', role: 'father', age_min: 35 },
  ];
  const defaultShots = Array.from({ length: 9 }, (_, index) => {
    const start = index * 1000;
    return {
      id: `shot-${index + 1}`,
      start_ms: start,
      end_ms: index === 8 ? durationMs : start + 1000,
      speaking_character_ids: index === 0 ? ['mateo'] : [],
      text_regions: index === 7 ? [] : [
        { region_key: `shot-${index + 1}-subtitle-1`, kind: 'text_subtitle', time_ranges: [[start, Math.min(start + 900, durationMs)]], treatment: 'translate_subtitle' },
        ...(index === 4 ? [{ region_key: 'shot-5-screen-1', kind: 'text_screen', time_ranges: [[start, start + 900]], treatment: 'localize_screen' }] : []),
      ],
    };
  });
  return {
    case_id: caseId,
    source: {
      sha256: sha256File(videoPath),
      duration_ms: durationMs,
      duration_tolerance_ms: 80,
      video: { width, height, codec, frame_rate: frameRate },
      audio: { codec: 'aac', channels: 1, sample_rate: 44100 },
    },
    target: { language: 'en', locale: 'en-US', market: 'US' },
    cast,
    shots: shots || defaultShots,
  };
}

function casePolicyFromCase(caseData) {
  return {
    case_id: caseData.case_id,
    duration_ms: caseData.source.duration_ms,
    source: { sha256: caseData.source.sha256, video: caseData.source.video, audio: caseData.source.audio },
    target: caseData.target,
    cast_ids: caseData.cast.map((item) => item.id),
    shots: caseData.shots.map(({ id, start_ms, end_ms }) => ({ id, start_ms, end_ms })),
  };
}

async function writeSyntheticVideo(t, root, { width = 64, height = 36, audio = 'ok' } = {}) {
  if (!hasLocalFfmpeg() || !hasLocalFfprobe()) t.skip('ffmpeg/ffprobe unavailable');
  const frameDir = path.join(root, 'input-frames');
  fs.mkdirSync(frameDir);
  for (let index = 0; index < 9; index += 1) {
    const bytes = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 20 + (index * 20), g: 80, b: 120 },
      },
    }).png().toBuffer();
    fs.writeFileSync(path.join(frameDir, `frame-${String(index).padStart(3, '0')}.png`), bytes);
  }
  const videoPath = path.join(root, 'source.mp4');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-framerate', '1',
    '-i', path.join(frameDir, 'frame-%03d.png'),
  ];
  if (audio !== 'none') {
    args.push('-f', 'lavfi', '-i', audio === 'drift'
      ? 'anullsrc=channel_layout=stereo:sample_rate=48000'
      : 'anullsrc=channel_layout=mono:sample_rate=44100');
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio !== 'none') args.push('-c:a', 'aac', '-ac', audio === 'drift' ? '2' : '1', '-ar', audio === 'drift' ? '48000' : '44100', '-shortest');
  args.push('-movflags', '+faststart', videoPath);
  const result = spawnSync(getFfmpegPath(), args, { shell: false, windowsHide: true });
  if (result.status !== 0) t.skip('ffmpeg cannot encode synthetic fixture');
  return videoPath;
}

function fakeDetections(frames, overrides = {}) {
  return frames.map((frame) => ({
    frame_index: frame.frame_index,
    persons: [{
      candidate_id: `person-${frame.frame_index}`,
      track_key: frame.frame_index === 0 ? 'character:mateo' : 'crowd-1',
      kind: 'person_candidate',
      bbox: { x: 4, y: 4, width: 12, height: 14 },
      confidence: frame.frame_index === 0 ? 0.91 : 0.7,
    }],
    faces: frame.frame_index === 2 ? [{ candidate_id: 'face-only', kind: 'face_candidate', bbox: { x: 40, y: 6, width: 8, height: 8 }, confidence: 0.88 }] : [],
    texts: overrides.texts?.(frame) || [
      {
        candidate_id: frame.frame_index === 4 ? 'screen-text' : `subtitle-${frame.frame_index}`,
        kind: 'text_candidate',
        polygon: frame.frame_index === 4
          ? [{ x: 5, y: 5 }, { x: 28, y: 5 }, { x: 28, y: 12 }, { x: 5, y: 12 }]
          : [{ x: 8, y: 26 }, { x: 56, y: 26 }, { x: 56, y: 34 }, { x: 8, y: 34 }],
        confidence: 0.82,
      },
      ...(frame.frame_index === 7 ? [{ candidate_id: 'watermark', kind: 'text_candidate', polygon: [{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 5 }, { x: 1, y: 5 }], confidence: 0.72 }] : []),
    ],
  }));
}

async function prepareSyntheticRun(t, { caseData } = {}) {
  const root = tempDir(t, 'redraw-local-run-');
  const videoPath = await writeSyntheticVideo(t, root);
  const finalCase = caseData || buildSyntheticCase({ videoPath });
  const casePath = path.join(root, 'case.json');
  fs.writeFileSync(casePath, JSON.stringify(finalCase, null, 2));
  const { lockPath, validated } = await writeModelLock(t);
  return {
    root,
    videoPath,
    caseData: finalCase,
    casePath,
    lockPath,
    validated,
    outputDir: path.join(root, 'out'),
    deps: {
      ffmpegPath: getFfmpegPath(),
      ffprobePath: getFfprobePath(),
      casePolicy: casePolicyFromCase(finalCase),
      detectFrames: async ({ frames }) => fakeDetections(frames),
      randomHex: () => 'abcdef123456',
    },
  };
}

async function assertRunRejectsNoFinal(setup, expectedCode, depsPatch = {}) {
  const outputDir = path.join(setup.root, `fail-${expectedCode}-${Math.random().toString(16).slice(2)}`);
  await assert.rejects(runner.runAnalyze({
    source: setup.videoPath,
    casePath: setup.casePath,
    modelLockPath: setup.lockPath,
    outputDir,
  }, { ...setup.deps, ...depsPatch }), (error) => {
    assert.equal(error.code, expectedCode);
    assert.equal(error.cause, undefined);
    assertSanitized(error);
    return true;
  });
  assert.equal(fs.existsSync(outputDir), false);
}

test('exporter projects only the approved audit case fields and writes atomically', async (t) => {
  const fixture = await exporter.buildAuditCaseFixture();
  assert.equal(fixture.case_id, 'ac087bcd-latam-en-us');
  assert.equal(fixture.cast.length, 5);
  assert.deepEqual(fixture.shots.map((shot) => shot.id), ['shot-1', 'shot-2', 'shot-3', 'shot-4', 'shot-5', 'shot-6', 'shot-7', 'shot-8', 'shot-9']);
  assert.equal(fixture.shots[0].start_ms, 0);
  assert.equal(fixture.shots.at(-1).end_ms, 68733);
  assert.deepEqual(fixture.source.audio, { codec: 'aac', channels: 1, sample_rate: 44100 });
  assert.equal(fixture.target.language, 'en');
  assert.equal(fixture.target.locale, 'en-US');
  assert.equal(fixture.target.market, 'US');
  assert(!/[\u3400-\u9fff]/.test(JSON.stringify(fixture)));
  assertSanitized(fixture);
  assert(!JSON.stringify(fixture).includes('"title"'));
  assert(fixture.shots.every((shot) => shot.text_regions.every((region) => ['text_subtitle', 'text_screen'].includes(region.kind) && ['translate_subtitle', 'localize_screen'].includes(region.treatment))));

  const root = tempDir(t, 'redraw-export-');
  const outputPath = path.join(root, 'audit-case.json');
  assert.deepEqual(await exporter.writeAuditCaseFile({ outputPath }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), fixture);
  await assert.rejects(exporter.writeAuditCaseFile({ outputPath }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.throws(() => exporter.parseArgs(['--output', outputPath, '--output', 'other']), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.throws(() => exporter.parseArgs(['--output', 'https://example.test/out.json']), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.deepEqual(exporter.parseArgs(['--help']), { help: true });
});

test('exported case schema is accepted by runner gate and reaches source mismatch instead of case rejection', async (t) => {
  const root = tempDir(t, 'redraw-export-runner-schema-');
  const videoPath = await writeSyntheticVideo(t, root);
  const casePath = path.join(root, 'exported-case.json');
  fs.writeFileSync(casePath, JSON.stringify(await exporter.buildAuditCaseFixture(), null, 2));
  const { lockPath } = await writeModelLock(t);
  await assert.rejects(runner.runAnalyze({
    source: videoPath,
    casePath,
    modelLockPath: lockPath,
    outputDir: path.join(root, 'out'),
  }, { ffmpegPath: getFfmpegPath(), ffprobePath: getFfprobePath(), detectFrames: async ({ frames }) => fakeDetections(frames), randomHex: () => 'schema123' }), (error) => {
    assert.equal(error.code, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');
    assertSanitized(error);
    return true;
  });
});

test('default runner policy locks the approved case and rejects synthetic case before internal casePolicy is supplied', async (t) => {
  const setup = await prepareSyntheticRun(t);
  await assert.rejects(runner.runAnalyze({
    source: setup.videoPath,
    casePath: setup.casePath,
    modelLockPath: setup.lockPath,
    outputDir: path.join(setup.root, 'default-reject'),
  }, { ffmpegPath: getFfmpegPath(), ffprobePath: getFfprobePath(), detectFrames: async ({ frames }) => fakeDetections(frames), randomHex: () => 'defaultreject' }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.equal(fs.existsSync(path.join(setup.root, 'default-reject')), false);
  await assert.rejects(runner.runAnalyze({
    source: setup.videoPath,
    casePath: setup.casePath,
    modelLockPath: setup.lockPath,
    outputDir: path.join(setup.root, 'bad-policy'),
  }, { ...setup.deps, casePolicy: true }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  await assert.rejects(runner.runAnalyze({
    source: setup.videoPath,
    casePath: setup.casePath,
    modelLockPath: setup.lockPath,
    outputDir: path.join(setup.root, 'missing-policy-sha'),
  }, { ...setup.deps, casePolicy: { ...casePolicyFromCase(setup.caseData), source: { video: setup.caseData.source.video, audio: setup.caseData.source.audio } } }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
});

test('analyze args reject CLI-only dangerous options and non-empty output dirs', async (t) => {
  const root = tempDir(t, 'redraw-args-');
  const source = path.join(root, 'source.mp4');
  const casePath = path.join(root, 'case.json');
  const lockPath = path.join(root, 'model-lock.json');
  const outputDir = path.join(root, 'out');
  fs.writeFileSync(source, 'video');
  fs.writeFileSync(casePath, '{}');
  fs.writeFileSync(lockPath, '{}');
  assert.deepEqual(runner.parseArgs(['--help']), { help: true });
  assert.deepEqual(runner.parseArgs(['analyze', '--source', source, '--case', casePath, '--model-lock', lockPath, '--output-dir', outputDir]), { command: 'analyze', source, casePath, modelLockPath: lockPath, outputDir });
  for (const argv of [
    [],
    ['analyze', '--source', source, '--case', casePath, '--model-lock', lockPath],
    ['analyze', '--source', source, '--source', source, '--case', casePath, '--model-lock', lockPath, '--output-dir', outputDir],
    ['analyze', '--source', 'https://example.test/source.mp4', '--case', casePath, '--model-lock', lockPath, '--output-dir', outputDir],
    ['analyze', '--source', source, '--case', casePath, '--model-lock', lockPath, '--output-dir', outputDir, '--approved'],
    ['analyze', '--source', source, '--case', casePath, '--model-lock', lockPath, '--output-dir', 'out?api_key=secret'],
  ]) assert.throws(() => runner.parseArgs(argv), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'keep');
  await assert.rejects(runner.runAnalyze({ source, casePath, modelLockPath: lockPath, outputDir }, { probeVideo: async () => ({ frame_count: 1 }) }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.equal(fs.readFileSync(path.join(outputDir, 'keep.txt'), 'utf8'), 'keep');
});

test('analyze builds offline review artifacts from real ffprobe/ffmpeg frames and fake detector without leaking inputs', async (t) => {
  const setup = await prepareSyntheticRun(t);
  const beforeSourceSha = sha256File(setup.videoPath);
  const first = await runner.runAnalyze({ source: setup.videoPath, casePath: setup.casePath, modelLockPath: setup.lockPath, outputDir: setup.outputDir }, setup.deps);
  assert.equal(sha256File(setup.videoPath), beforeSourceSha);
  assert.equal(first.manifest.source.frame_count, 9);
  assert.equal(first.manifest.models.model_lock_sha256, setup.validated.canonical_sha256);
  assert.equal(first.manifest.status, 'generated');
  assert.equal(first.manifest.approval_status, 'pending');
  assert.equal(first.manifest.ready_for_reference, false);
  assert.equal(first.contact_sheets.length, 9);
  assertSanitized(first);
  assert.equal(fs.existsSync(path.join(setup.outputDir, 'redraw-full-frame-coverage-manifest.json')), true);
  assert.equal(fs.readdirSync(path.join(setup.outputDir, 'frames')).filter((name) => name.endsWith('.png')).length, 9);
  for (const relative of first.contact_sheets) {
    const metadata = await sharp(path.join(setup.outputDir, relative)).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 960);
    assert(metadata.height >= 180);
  }
  const template = JSON.parse(fs.readFileSync(path.join(setup.outputDir, 'review-decisions.template.json'), 'utf8'));
  assert.equal(template.schema_version, 'redraw-full-frame-review-decisions-v1');
  assert.equal(template.analysis_sha256, first.manifest.analysis_sha256);
  assert.equal(template.reviewer, null);
  assert(!JSON.stringify(template).includes('approved'));
  assert.deepEqual(template.review_points.map((point) => point.frame_index), first.manifest.frames.filter((frame) => frame.review_point_reasons.length).map((frame) => frame.frame_index));
  const html = fs.readFileSync(path.join(setup.outputDir, 'review', 'index.html'), 'utf8');
  assert.match(html, /shot-1/);
  assertSanitized(html);
  assert.doesNotMatch(html, /<script|https?:\/\//i);
  assert(first.manifest.person_tracks.some((track) => track.kind === 'story_role' && track.source_character_key === 'mateo'));
  assert(first.manifest.person_tracks.some((track) => track.kind === 'background_extra'));
  assert(first.manifest.person_tracks.some((track) => track.regions.some((region) => region.detector_disagreement)));
  assert(first.manifest.text_tracks.some((track) => track.kind === 'subtitle' && track.treatment === 'translate_subtitle' && track.target_text_key));
  assert(first.manifest.text_tracks.some((track) => track.kind === 'screen' && track.treatment === 'localize_screen' && track.target_text_key));
  assert(first.manifest.text_tracks.some((track) => track.kind === 'watermark' && track.treatment === 'remove' && track.target_text_key === null));
  const second = await runner.runAnalyze({ source: setup.videoPath, casePath: setup.casePath, modelLockPath: setup.lockPath, outputDir: path.join(setup.root, 'out2') }, { ...setup.deps, randomHex: () => 'fedcba654321' });
  assert.equal(second.manifest.analysis_sha256, first.manifest.analysis_sha256);
  assert(!JSON.stringify(first).includes('casePolicy'));
  assert(!JSON.stringify(first).includes('fault'));
});

test('contact sheets contain portrait frames without stretching them', async (t) => {
  const root = tempDir(t, 'redraw-portrait-contact-');
  const videoPath = await writeSyntheticVideo(t, root, { width: 36, height: 64 });
  const caseData = buildSyntheticCase({ videoPath, width: 36, height: 64 });
  const casePath = path.join(root, 'case.json');
  fs.writeFileSync(casePath, JSON.stringify(caseData, null, 2));
  const { lockPath } = await writeModelLock(t);
  const result = await runner.runAnalyze({
    source: videoPath,
    casePath,
    modelLockPath: lockPath,
    outputDir: path.join(root, 'out'),
  }, {
    ffmpegPath: getFfmpegPath(),
    ffprobePath: getFfprobePath(),
    casePolicy: casePolicyFromCase(caseData),
    detectFrames: async ({ frames }) => frames.map((frame) => ({
      frame_index: frame.frame_index,
      persons: [{ candidate_id: `p-${frame.frame_index}`, track_key: 'character:mateo', kind: 'person_candidate', bbox: { x: 8, y: 8, width: 12, height: 20 }, confidence: 0.9 }],
      faces: [],
      texts: [],
    })),
    randomHex: () => 'portraitcontact',
  });
  const sheetPath = path.join(root, 'out', result.contact_sheets[0]);
  const metadata = await sharp(sheetPath).metadata();
  assert.equal(metadata.width, 960);
  assert.equal(metadata.height, 180);
  const edge = await sharp(sheetPath).extract({ left: 2, top: 90, width: 1, height: 1 }).raw().toBuffer();
  const center = await sharp(sheetPath).extract({ left: 160, top: 90, width: 1, height: 1 }).raw().toBuffer();
  assert(edge[0] < 30 && edge[1] < 30 && edge[2] < 30, 'source cell keeps dark side letterbox');
  assert(center[0] > 30 || center[1] > 30 || center[2] > 30, 'source image remains visible in contained center');
});

test('analyze failure matrix reaches the intended legal-media stages and leaves no final directory', async (t) => {
  const setup = await prepareSyntheticRun(t);
  await assertRunRejectsNoFinal(setup, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH', { probeVideo: async () => { throw Object.assign(new Error('C:\\secret\\ffprobe'), { code: 'REDRAW_FULL_FRAME_SOURCE_MISMATCH' }); } });
  const driftCase = { ...setup.caseData, source: { ...setup.caseData.source, sha256: '0'.repeat(64) } };
  const driftCasePath = path.join(setup.root, 'drift-case.json');
  fs.writeFileSync(driftCasePath, JSON.stringify(driftCase));
  await assert.rejects(runner.runAnalyze({ source: setup.videoPath, casePath: driftCasePath, modelLockPath: setup.lockPath, outputDir: path.join(setup.root, 'hash-drift') }, setup.deps), /REDRAW_FULL_FRAME_SOURCE_MISMATCH/);
  assert.equal(fs.existsSync(path.join(setup.root, 'hash-drift')), false);
  await assertRunRejectsNoFinal(setup, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH', { probeVideo: async () => ({ width: 65, height: 36, codec: 'h264', frame_rate: 1, duration_ms: 9000, frame_count: 9, time_base: { numerator: 1, denominator: 1 }, timestamps: Array.from({ length: 9 }, (_, index) => ({ timestamp_ticks: index, timestamp_ms: index * 1000 })) }) });
  fs.writeFileSync(setup.lockPath, '{"bad":true}');
  await assertRunRejectsNoFinal(setup, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');

  const setup2 = await prepareSyntheticRun(t);
  await assertRunRejectsNoFinal(setup2, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH', { ffmpegPath: path.join(setup2.root, 'missing-ffmpeg.exe') });
  let detectorCalled = false;
  await assertRunRejectsNoFinal(setup2, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE', { detectFrames: async () => { detectorCalled = true; throw new Error('C:\\secret\\detector'); } });
  assert.equal(detectorCalled, true);
  await assertRunRejectsNoFinal(setup2, 'REDRAW_FULL_FRAME_MASK_INVALID', { fault: 'mask_write' });
  await assert.rejects(runner.runAnalyze({ source: setup2.videoPath, casePath: setup2.casePath, modelLockPath: setup2.lockPath, outputDir: path.join(setup2.root, 'unknown-fault') }, { ...setup2.deps, fault: 'unknown' }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
});

test('analyze fails closed when detector omits frames or emits no candidates for the whole video', async (t) => {
  const setup = await prepareSyntheticRun(t);
  const textOnly = (frame) => ({
    frame_index: frame.frame_index,
    persons: [],
    faces: [],
    texts: [{ candidate_id: `text-${frame.frame_index}`, kind: 'text_candidate', polygon: [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 8, y: 8 }, { x: 1, y: 8 }], confidence: 0.8 }],
  });
  await assertRunRejectsNoFinal(setup, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE', {
    detectFrames: async ({ frames }) => frames.slice(0, -1).map(textOnly),
  });
  await assertRunRejectsNoFinal(setup, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE', {
    detectFrames: async ({ frames }) => frames.map((frame) => ({ frame_index: frame.frame_index, persons: [], faces: [], texts: [] })),
  });
  await assertRunRejectsNoFinal(setup, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE', {
    detectFrames: async ({ frames }) => [...frames.map(textOnly), textOnly(frames[0])],
  });
  await assertRunRejectsNoFinal(setup, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE', {
    detectFrames: async ({ frames }) => [...frames.map(textOnly), { ...textOnly(frames[0]), frame_index: 99 }],
  });
});

test('analyze validates actual AAC mono 44100 audio stream from ffprobe', async (t) => {
  const noAudioRoot = tempDir(t, 'redraw-no-audio-');
  const noAudioVideo = await writeSyntheticVideo(t, noAudioRoot, { audio: 'none' });
  const noAudioCase = buildSyntheticCase({ videoPath: noAudioVideo });
  const noAudioCasePath = path.join(noAudioRoot, 'case.json');
  fs.writeFileSync(noAudioCasePath, JSON.stringify(noAudioCase, null, 2));
  const { lockPath: lockPath1 } = await writeModelLock(t);
  await assertRunRejectsNoFinal({
    root: noAudioRoot,
    videoPath: noAudioVideo,
    casePath: noAudioCasePath,
    lockPath: lockPath1,
    deps: { ffmpegPath: getFfmpegPath(), ffprobePath: getFfprobePath(), casePolicy: casePolicyFromCase(noAudioCase), detectFrames: async ({ frames }) => fakeDetections(frames), randomHex: () => 'noaudio' },
  }, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');

  const driftRoot = tempDir(t, 'redraw-audio-drift-');
  const driftVideo = await writeSyntheticVideo(t, driftRoot, { audio: 'drift' });
  const driftCase = buildSyntheticCase({ videoPath: driftVideo });
  const driftCasePath = path.join(driftRoot, 'case.json');
  fs.writeFileSync(driftCasePath, JSON.stringify(driftCase, null, 2));
  const { lockPath: lockPath2 } = await writeModelLock(t);
  await assertRunRejectsNoFinal({
    root: driftRoot,
    videoPath: driftVideo,
    casePath: driftCasePath,
    lockPath: lockPath2,
    deps: { ffmpegPath: getFfmpegPath(), ffprobePath: getFfprobePath(), casePolicy: casePolicyFromCase(driftCase), detectFrames: async ({ frames }) => fakeDetections(frames), randomHex: () => 'audiodrift' },
  }, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');
});

test('manifest and template atomic rename failures prove temp write and clean final state', async (t) => {
  const setup = await prepareSyntheticRun(t);
  for (const targetName of ['redraw-full-frame-coverage-manifest.json', 'review-decisions.template.json']) {
    const calls = [];
    const outputDir = path.join(setup.root, `atomic-${targetName.replace(/[^a-z0-9]/gi, '-')}`);
    await assert.rejects(runner.runAnalyze({
      source: setup.videoPath,
      casePath: setup.casePath,
      modelLockPath: setup.lockPath,
      outputDir,
    }, {
      ...setup.deps,
      randomHex: () => `atomic${targetName.length}`,
      fsOps: {
        writeFile: async (...args) => fs.promises.writeFile(...args),
        rename: async (from, to) => {
          calls.push({ from, to, tempExists: fs.existsSync(from), targetExistsBefore: fs.existsSync(to) });
          if (path.basename(to) === targetName) throw new Error(`C:\\secret\\${targetName}`);
          await fs.promises.rename(from, to);
        },
        rmdir: async (...args) => fs.promises.rmdir(...args),
      },
    }), (error) => {
      assert.equal(error.code, 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
      assertSanitized(error);
      return true;
    });
    const matched = calls.find((call) => path.basename(call.to) === targetName);
    assert(matched, `rename called for ${targetName}`);
    assert.equal(matched.tempExists, true);
    assert.equal(matched.targetExistsBefore, false);
    assert.equal(fs.existsSync(outputDir), false);
    assert.deepEqual(fs.readdirSync(setup.root).filter((name) => name.includes('redraw-full-frame-staging')), []);
  }
});

test('publish rename failure runs after artifact verification and leaves no partial output', async (t) => {
  const setup = await prepareSyntheticRun(t);
  for (const precreate of [false, true]) {
    const calls = [];
    const outputDir = path.join(setup.root, precreate ? 'publish-empty-target' : 'publish-missing-target');
    if (precreate) fs.mkdirSync(outputDir);
    await assert.rejects(runner.runAnalyze({
      source: setup.videoPath,
      casePath: setup.casePath,
      modelLockPath: setup.lockPath,
      outputDir,
    }, {
      ...setup.deps,
      randomHex: () => precreate ? 'publishempty' : 'publishmissing',
      fsOps: {
        writeFile: async (...args) => fs.promises.writeFile(...args),
        rename: async (from, to) => {
          calls.push({ from, to, isPublish: to === path.resolve(outputDir), stagingHasManifest: fs.existsSync(path.join(from, 'redraw-full-frame-coverage-manifest.json')) });
          if (to === path.resolve(outputDir)) throw new Error('C:\\secret\\publish');
          await fs.promises.rename(from, to);
        },
        rmdir: async (...args) => fs.promises.rmdir(...args),
      },
    }), (error) => {
      assert.equal(error.code, 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
      assertSanitized(error);
      return true;
    });
    const publishCall = calls.find((call) => call.isPublish);
    assert(publishCall, 'publish rename called');
    assert.equal(publishCall.stagingHasManifest, true);
    assert.equal(fs.existsSync(outputDir), false);
    assert.deepEqual(fs.readdirSync(setup.root).filter((name) => name.includes('redraw-full-frame-staging')), []);
  }
});

test('analyze preserves occupied output bytes and atomically replaces empty output directory', async (t) => {
  const setup = await prepareSyntheticRun(t);
  const occupied = path.join(setup.root, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'keep');
  await assert.rejects(runner.runAnalyze({ source: setup.videoPath, casePath: setup.casePath, modelLockPath: setup.lockPath, outputDir: occupied }, setup.deps), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'keep');
  const empty = path.join(setup.root, 'empty-output');
  fs.mkdirSync(empty);
  await runner.runAnalyze({ source: setup.videoPath, casePath: setup.casePath, modelLockPath: setup.lockPath, outputDir: empty }, { ...setup.deps, randomHex: () => 'emptyreplace' });
  assert.equal(fs.existsSync(path.join(empty, 'redraw-full-frame-coverage-manifest.json')), true);
});

test('text mapping uses active case window before spatial fallback', async (t) => {
  const root = tempDir(t, 'redraw-text-window-');
  const videoPath = await writeSyntheticVideo(t, root);
  const baseCase = buildSyntheticCase({ videoPath });
  const shots = baseCase.shots.map((shot) => ({ ...shot, text_regions: [] }));
  shots[0].text_regions = [{ region_key: 'shot-1-screen-low', kind: 'text_screen', time_ranges: [[0, 900]], treatment: 'localize_screen' }];
  shots[1].text_regions = [{ region_key: 'shot-2-subtitle-high', kind: 'text_subtitle', time_ranges: [[1000, 1900]], treatment: 'translate_subtitle' }];
  shots[2].text_regions = [
    { region_key: 'shot-3-subtitle', kind: 'text_subtitle', time_ranges: [[2000, 2900]], treatment: 'translate_subtitle' },
    { region_key: 'shot-3-screen', kind: 'text_screen', time_ranges: [[2000, 2900]], treatment: 'localize_screen' },
  ];
  const caseData = buildSyntheticCase({ videoPath, shots });
  const casePath = path.join(root, 'case.json');
  fs.writeFileSync(casePath, JSON.stringify(caseData, null, 2));
  const { lockPath } = await writeModelLock(t);
  const low = [{ x: 8, y: 26 }, { x: 56, y: 26 }, { x: 56, y: 34 }, { x: 8, y: 34 }];
  const high = [{ x: 8, y: 2 }, { x: 56, y: 2 }, { x: 56, y: 10 }, { x: 8, y: 10 }];
  const result = await runner.runAnalyze({
    source: videoPath,
    casePath,
    modelLockPath: lockPath,
    outputDir: path.join(root, 'out'),
  }, {
    ffmpegPath: getFfmpegPath(),
    ffprobePath: getFfprobePath(),
    casePolicy: casePolicyFromCase(caseData),
    detectFrames: async ({ frames }) => fakeDetections(frames, {
      texts: (frame) => {
        if (frame.frame_index === 0) return [{ candidate_id: 'low-screen', kind: 'text_candidate', polygon: low, confidence: 0.9 }];
        if (frame.frame_index === 1) return [{ candidate_id: 'high-subtitle', kind: 'text_candidate', polygon: high, confidence: 0.9 }];
        if (frame.frame_index === 2) return [
          { candidate_id: 'multi-low', kind: 'text_candidate', polygon: low, confidence: 0.9 },
          { candidate_id: 'multi-high', kind: 'text_candidate', polygon: high, confidence: 0.9 },
        ];
        return [{ candidate_id: 'inactive', kind: 'text_candidate', polygon: low, confidence: 0.9 }];
      },
    }),
    randomHex: () => 'textwindow',
  });
  const byKey = new Map(result.manifest.text_tracks.map((track) => [track.region_key, track]));
  assert.equal(byKey.get('shot-1-screen-low').kind, 'screen');
  assert.equal(byKey.get('shot-1-screen-low').treatment, 'localize_screen');
  assert.equal(byKey.get('shot-2-subtitle-high').kind, 'subtitle');
  assert.equal(byKey.get('shot-2-subtitle-high').treatment, 'translate_subtitle');
  assert.equal(byKey.get('shot-3-subtitle').kind, 'subtitle');
  assert.equal(byKey.get('shot-3-screen').kind, 'screen');
  assert([...byKey.values()].some((track) => track.kind === 'watermark' && track.treatment === 'remove' && track.target_text_key === null));
});
