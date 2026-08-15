const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
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

function containsChinese(value) {
  return /[\u3400-\u9fff]/.test(JSON.stringify(value));
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
  const lock = {
    schema_version: 'redraw-full-frame-model-lock-v1',
    runtime: { node: 'test' },
    components,
  };
  const validated = await validateModelLock({ cacheRoot, sourcePolicy, lock });
  const lockPath = path.join(cacheRoot, 'model-lock.json');
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  return { cacheRoot, lockPath, validated };
}

function buildSyntheticCase({ videoPath, width = 64, height = 36, frameCount = 9, durationMs = 9000, codec = 'h264', frameRate = 1 }) {
  const cast = [
    { id: 'mateo', role: 'protagonist', age_min: 18 },
    { id: 'diego', role: 'classmate', age_min: 18 },
    { id: 'lucas', role: 'friend', age_min: 18 },
    { id: 'elena', role: 'mother', age_min: 35 },
    { id: 'rafael', role: 'father', age_min: 35 },
  ];
  return {
    case_id: 'synthetic-local-case',
    source: {
      sha256: sha256File(videoPath),
      duration_ms: durationMs,
      duration_tolerance_ms: 80,
      video: { width, height, codec, frame_rate: frameRate },
    },
    target: { language: 'en', locale: 'en-US', market: 'US' },
    cast,
    shots: Array.from({ length: 9 }, (_, index) => {
      const start = index * 1000;
      return {
        id: `shot-${index + 1}`,
        start_ms: start,
        end_ms: index === 8 ? durationMs : start + 1000,
        speaking_character_ids: index === 0 ? ['mateo'] : [],
        text_regions: [
          {
            region_key: `shot-${index + 1}-subtitle-1`,
            kind: 'text_subtitle',
            time_ranges: [[start, Math.min(start + 900, durationMs)]],
            treatment: 'translate_subtitle',
          },
          ...(index === 4 ? [{
            region_key: 'shot-5-screen-1',
            kind: 'text_screen',
            time_ranges: [[start, start + 900]],
            treatment: 'localize_screen',
          }] : []),
        ],
      };
    }),
  };
}

async function writeSyntheticVideo(t, root) {
  if (!hasLocalFfmpeg() || !hasLocalFfprobe()) t.skip('ffmpeg/ffprobe unavailable');
  const frameDir = path.join(root, 'input-frames');
  fs.mkdirSync(frameDir);
  for (let index = 0; index < 9; index += 1) {
    const bytes = await sharp({
      create: {
        width: 64,
        height: 36,
        channels: 3,
        background: { r: 20 + (index * 20), g: 80, b: 120 },
      },
    }).png().toBuffer();
    fs.writeFileSync(path.join(frameDir, `frame-${String(index).padStart(3, '0')}.png`), bytes);
  }
  const videoPath = path.join(root, 'source.mp4');
  const result = spawnSync(getFfmpegPath(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-framerate',
    '1',
    '-i',
    path.join(frameDir, 'frame-%03d.png'),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    videoPath,
  ], { shell: false, windowsHide: true });
  if (result.status !== 0) t.skip('ffmpeg cannot encode synthetic fixture');
  return videoPath;
}

function fakeDetections(frames) {
  return frames.map((frame) => ({
    frame_index: frame.frame_index,
    persons: [
      {
        candidate_id: `person-${frame.frame_index}`,
        track_key: frame.frame_index === 0 ? 'character:mateo' : 'crowd-1',
        kind: 'person_candidate',
        bbox: { x: 4, y: 4, width: 12, height: 14 },
        confidence: frame.frame_index === 0 ? 0.91 : 0.7,
      },
    ],
    faces: frame.frame_index === 2 ? [{
      candidate_id: 'face-only',
      kind: 'face_candidate',
      bbox: { x: 40, y: 6, width: 8, height: 8 },
      confidence: 0.88,
    }] : [],
    texts: [
      {
        candidate_id: frame.frame_index === 4 ? 'screen-text' : `subtitle-${frame.frame_index}`,
        kind: 'text_candidate',
        polygon: frame.frame_index === 4
          ? [{ x: 5, y: 5 }, { x: 28, y: 5 }, { x: 28, y: 12 }, { x: 5, y: 12 }]
          : [{ x: 8, y: 26 }, { x: 56, y: 26 }, { x: 56, y: 34 }, { x: 8, y: 34 }],
        confidence: 0.82,
      },
      ...(frame.frame_index === 7 ? [{
        candidate_id: 'watermark',
        kind: 'text_candidate',
        polygon: [{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 5 }, { x: 1, y: 5 }],
        confidence: 0.72,
      }] : []),
    ],
  }));
}

test('exporter projects only the approved audit case fields and writes atomically', async (t) => {
  const fixture = await exporter.buildAuditCaseFixture();
  assert.equal(fixture.case_id, 'ac087bcd-latam-en-us');
  assert.equal(fixture.cast.length, 5);
  assert.deepEqual(fixture.shots.map((shot) => shot.id), ['shot-1', 'shot-2', 'shot-3', 'shot-4', 'shot-5', 'shot-6', 'shot-7', 'shot-8', 'shot-9']);
  assert.equal(fixture.shots[0].start_ms, 0);
  assert.equal(fixture.shots.at(-1).end_ms, 68733);
  assert.equal(fixture.target.language, 'en');
  assert.equal(fixture.target.locale, 'en-US');
  assert.equal(fixture.target.market, 'US');
  assert(!containsChinese(fixture));
  assertSanitized(fixture);
  assert(!JSON.stringify(fixture).includes('"title"'));
  assert(fixture.shots.every((shot) => shot.text_regions.every((region) => (
    ['text_subtitle', 'text_screen'].includes(region.kind)
      && ['translate_subtitle', 'localize_screen'].includes(region.treatment)
  ))));

  const root = tempDir(t, 'redraw-export-');
  const outputPath = path.join(root, 'audit-case.json');
  const result = await exporter.writeAuditCaseFile({ outputPath });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), fixture);
  await assert.rejects(exporter.writeAuditCaseFile({ outputPath }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.throws(() => exporter.parseArgs(['--output', outputPath, '--output', 'other']), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.throws(() => exporter.parseArgs(['--output', 'https://example.test/out.json']), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.deepEqual(exporter.parseArgs(['--help']), { help: true });
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
  assert.deepEqual(runner.parseArgs(['analyze', '--source', source, '--case', casePath, '--model-lock', lockPath, '--output-dir', outputDir]), {
    command: 'analyze',
    source,
    casePath,
    modelLockPath: lockPath,
    outputDir,
  });
  for (const argv of [
    [],
    ['analyze', '--source', source, '--case', casePath, '--model-lock', lockPath],
    ['analyze', '--source', source, '--source', source, '--case', casePath, '--model-lock', lockPath, '--output-dir', outputDir],
    ['analyze', '--source', 'https://example.test/source.mp4', '--case', casePath, '--model-lock', lockPath, '--output-dir', outputDir],
    ['analyze', '--source', source, '--case', casePath, '--model-lock', lockPath, '--output-dir', outputDir, '--approved'],
    ['analyze', '--source', source, '--case', casePath, '--model-lock', lockPath, '--output-dir', 'out?api_key=secret'],
  ]) {
    assert.throws(() => runner.parseArgs(argv), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  }
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'keep');
  await assert.rejects(runner.runAnalyze({ source, casePath, modelLockPath: lockPath, outputDir }, {
    probeVideo: async () => ({ frame_count: 1 }),
  }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.equal(fs.readFileSync(path.join(outputDir, 'keep.txt'), 'utf8'), 'keep');
});

test('analyze builds offline review artifacts from real ffprobe/ffmpeg frames and fake detector without leaking inputs', async (t) => {
  const root = tempDir(t, 'redraw-local-analyze-');
  const videoPath = await writeSyntheticVideo(t, root);
  const casePath = path.join(root, 'case.json');
  fs.writeFileSync(casePath, JSON.stringify(buildSyntheticCase({ videoPath }), null, 2));
  const { lockPath, validated } = await writeModelLock(t);
  const outputDir = path.join(root, 'out');
  const beforeSourceSha = sha256File(videoPath);

  const first = await runner.runAnalyze({
    source: videoPath,
    casePath,
    modelLockPath: lockPath,
    outputDir,
  }, {
    ffmpegPath: getFfmpegPath(),
    ffprobePath: getFfprobePath(),
    detectFrames: async ({ frames }) => fakeDetections(frames),
    randomHex: () => 'abcdef123456',
  });

  assert.equal(sha256File(videoPath), beforeSourceSha);
  assert.equal(first.manifest.source.frame_count, 9);
  assert.equal(first.manifest.models.model_lock_sha256, validated.canonical_sha256);
  assert.equal(first.manifest.status, 'generated');
  assert.equal(first.manifest.approval_status, 'pending');
  assert.equal(first.manifest.ready_for_reference, false);
  assert.equal(first.contact_sheets.length, 9);
  assertSanitized(first);
  assert.equal(fs.existsSync(path.join(outputDir, 'redraw-full-frame-coverage-manifest.json')), true);
  assert.equal(fs.readdirSync(path.join(outputDir, 'frames')).filter((name) => name.endsWith('.png')).length, 9);
  for (const relative of first.contact_sheets) {
    const metadata = await sharp(path.join(outputDir, relative)).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 960);
    assert(metadata.height >= 180);
  }
  const template = JSON.parse(fs.readFileSync(path.join(outputDir, 'review-decisions.template.json'), 'utf8'));
  assert.equal(template.schema_version, 'redraw-full-frame-review-decisions-v1');
  assert.equal(template.analysis_sha256, first.manifest.analysis_sha256);
  assert.equal(template.reviewer, null);
  assert(!JSON.stringify(template).includes('approved'));
  assert.deepEqual(template.review_points.map((point) => point.frame_index), first.manifest.frames.filter((frame) => frame.review_point_reasons.length).map((frame) => frame.frame_index));
  const html = fs.readFileSync(path.join(outputDir, 'review', 'index.html'), 'utf8');
  assert.match(html, /shot-1/);
  assertSanitized(html);
  assert.doesNotMatch(html, /<script|https?:\/\//i);
  assert(first.manifest.person_tracks.some((track) => track.kind === 'story_role' && track.source_character_key === 'mateo'));
  assert(first.manifest.person_tracks.some((track) => track.kind === 'background_extra'));
  assert(first.manifest.person_tracks.some((track) => track.regions.some((region) => region.detector_disagreement)));
  assert(first.manifest.text_tracks.some((track) => track.kind === 'subtitle' && track.treatment === 'translate_subtitle' && track.target_text_key));
  assert(first.manifest.text_tracks.some((track) => track.kind === 'screen' && track.treatment === 'localize_screen' && track.target_text_key));
  assert(first.manifest.text_tracks.some((track) => track.kind === 'watermark' && track.treatment === 'remove' && track.target_text_key === null));

  const secondOutput = path.join(root, 'out2');
  const second = await runner.runAnalyze({
    source: videoPath,
    casePath,
    modelLockPath: lockPath,
    outputDir: secondOutput,
  }, {
    ffmpegPath: getFfmpegPath(),
    ffprobePath: getFfprobePath(),
    detectFrames: async ({ frames }) => fakeDetections(frames),
    randomHex: () => 'fedcba654321',
  });
  assert.equal(second.manifest.analysis_sha256, first.manifest.analysis_sha256);
});

test('analyze failures are sanitized and leave no final directory while preserving occupied output', async (t) => {
  const root = tempDir(t, 'redraw-local-fail-');
  const videoPath = path.join(root, 'source.mp4');
  fs.writeFileSync(videoPath, 'not-video');
  const casePath = path.join(root, 'case.json');
  fs.writeFileSync(casePath, JSON.stringify(buildSyntheticCase({ videoPath })));
  const { lockPath } = await writeModelLock(t);
  const outputDir = path.join(root, 'out');
  await assert.rejects(runner.runAnalyze({
    source: videoPath,
    casePath,
    modelLockPath: lockPath,
    outputDir,
  }, {
    ffmpegPath: getFfmpegPath(),
    ffprobePath: getFfprobePath(),
    detectFrames: async () => { throw new Error('C:\\secret\\model'); },
    randomHex: () => 'failurecase',
  }), (error) => {
    assert(['REDRAW_FULL_FRAME_SOURCE_MISMATCH', 'REDRAW_FULL_FRAME_FRAME_GAP'].includes(error.code));
    assert.equal(error.cause, undefined);
    assertSanitized(error);
    return true;
  });
  assert.equal(fs.existsSync(outputDir), false);

  const occupied = path.join(root, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'keep');
  await assert.rejects(runner.runAnalyze({
    source: videoPath,
    casePath,
    modelLockPath: lockPath,
    outputDir: occupied,
  }), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'keep');
});
