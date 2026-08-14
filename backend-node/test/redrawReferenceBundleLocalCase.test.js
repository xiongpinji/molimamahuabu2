const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

const { getFfprobePath, hasLocalFfmpeg, hasLocalFfprobe } = require('../src/utils/ffmpegPath');
const {
  MOTION_FILENAME,
  CONTACT_SHEET_FILENAME,
  MANIFEST_FILENAME,
  main,
} = require('../scripts/run-redraw-reference-bundle-local-case');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-reference-bundle-local-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function captureStreams() {
  const chunks = { stdout: '', stderr: '' };
  return {
    chunks,
    streams: {
      stdout: { write(value) { chunks.stdout += String(value); } },
      stderr: { write(value) { chunks.stderr += String(value); } },
    },
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readManifest(outputDir) {
  return JSON.parse(fs.readFileSync(path.join(outputDir, MANIFEST_FILENAME), 'utf8'));
}

function ffprobe(filePath) {
  return JSON.parse(execFileSync(getFfprobePath(), [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
}

function assertNoLeaks(value, outputDir) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(outputDir), false);
  assert.equal(/[A-Za-z]:[\\/]/.test(serialized), false);
  assert.equal(serialized.includes('sk-'), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('http://'), false);
  assert.equal(serialized.includes('https://'), false);
  assert.equal(/[\u3400-\u9fff]/.test(serialized), false);
}

test('fixture CLI 生成真实五秒参考包 manifest、无声 H264 motion 和 960x360 contact sheet', async (t) => {
  if (!hasLocalFfmpeg() || !hasLocalFfprobe()) return t.skip('ffmpeg/ffprobe unavailable');
  const outputDir = tempDir(t);
  const { chunks, streams } = captureStreams();

  const exitCode = await main(['--fixture', '--output-dir', outputDir], streams);

  assert.equal(exitCode, 0);
  assert.equal(chunks.stdout, 'REDRAW_REFERENCE_BUNDLE_LOCAL_OK\n');
  assert.equal(chunks.stderr, '');

  const manifestPath = path.join(outputDir, MANIFEST_FILENAME);
  const motionPath = path.join(outputDir, MOTION_FILENAME);
  const contactSheetPath = path.join(outputDir, CONTACT_SHEET_FILENAME);
  assert.equal(fs.existsSync(manifestPath), true);
  assert.equal(fs.existsSync(motionPath), true);
  assert.equal(fs.existsSync(contactSheetPath), true);

  const manifest = readManifest(outputDir);
  assert.equal(manifest.schema_version, 'redraw-reference-bundle-local-manifest-v1');
  assert.equal(manifest.reference_gate, 'ready');
  assert.equal(manifest.locale, 'en-US');
  assert.equal(manifest.market, 'US');
  assert.equal(manifest.motion.filename, MOTION_FILENAME);
  assert.equal(manifest.motion.sha256, sha256File(motionPath));
  assert.equal(manifest.motion.duration_ms >= 4900 && manifest.motion.duration_ms <= 5100, true);
  assert.equal(manifest.motion.width, 864);
  assert.equal(manifest.motion.height, 496);
  assert.equal(manifest.motion.video_codec, 'h264');
  assert.equal(manifest.motion.audio_stream_count, 0);
  assert.equal(manifest.bundle.motion_reference.sha256, manifest.motion.sha256);
  assert.equal(manifest.bundle.coverage_sha256, manifest.coverage_sha256);
  assert.deepEqual(manifest.bundle.face_tracks.map((entry) => entry.track_key), ['face-001', 'face-002']);
  assert.deepEqual(manifest.bundle.text_regions.map((entry) => entry.kind), ['text_subtitle', 'text_screen']);
  assert.deepEqual(manifest.characters.map((entry) => entry.target_character_name), ['Ethan', 'Maya']);
  assert.equal(manifest.characters.every((entry) => (
    entry.persona_origin === 'fictional_ai_generated'
      && entry.target_country === 'US'
      && entry.adult_status === 'verified_18_plus'
      && entry.approval_status === 'approved'
  )), true);
  assertNoLeaks(manifest, outputDir);

  const probed = ffprobe(motionPath);
  const video = probed.streams.find((stream) => stream.codec_type === 'video');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 864);
  assert.equal(video.height, 496);
  assert.equal(probed.streams.filter((stream) => stream.codec_type === 'audio').length, 0);
  assert.equal(Math.abs(Math.round(Number(probed.format.duration) * 1000) - 5000) <= 100, true);

  const sheet = await sharp(contactSheetPath).metadata();
  assert.equal(sheet.format, 'jpeg');
  assert.equal(sheet.width, 960);
  assert.equal(sheet.height, 360);
});

test('fixture manifest 的规范证据在重复运行间稳定', async (t) => {
  if (!hasLocalFfmpeg() || !hasLocalFfprobe()) return t.skip('ffmpeg/ffprobe unavailable');
  const firstDir = tempDir(t);
  const secondDir = tempDir(t);

  assert.equal(await main(['--fixture', '--output-dir', firstDir], captureStreams().streams), 0);
  assert.equal(await main(['--fixture', '--output-dir', secondDir], captureStreams().streams), 0);

  const first = readManifest(firstDir);
  const second = readManifest(secondDir);
  assert.deepEqual({
    motion: first.motion,
    coverage_sha256: first.coverage_sha256,
    reference_bundle_hash: first.reference_bundle_hash,
    bundle: first.bundle,
    characters: first.characters,
    text_regions: first.text_regions,
  }, {
    motion: second.motion,
    coverage_sha256: second.coverage_sha256,
    reference_bundle_hash: second.reference_bundle_hash,
    bundle: second.bundle,
    characters: second.characters,
    text_regions: second.text_regions,
  });
});

test('CLI 参数错误、manifest 不可读和 output-dir 文件路径均稳定失败且不留最终文件', async (t) => {
  const outputDir = tempDir(t);
  const unknown = captureStreams();
  assert.equal(await main(['--unknown', '--output-dir', outputDir], unknown.streams), 2);
  assert.match(unknown.chunks.stderr, /REDRAW_REFERENCE_BUNDLE_LOCAL_CLI_INVALID/);

  const both = captureStreams();
  assert.equal(await main(['--fixture', '--manifest', path.join(outputDir, 'missing.json'), '--output-dir', outputDir], both.streams), 2);
  assert.match(both.chunks.stderr, /REDRAW_REFERENCE_BUNDLE_LOCAL_CLI_INVALID/);

  const unreadable = captureStreams();
  assert.equal(await main(['--manifest', path.join(outputDir, 'missing.json'), '--output-dir', outputDir], unreadable.streams), 1);
  assert.match(unreadable.chunks.stderr, /REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID/);

  const fileOutput = path.join(outputDir, 'not-a-dir');
  fs.writeFileSync(fileOutput, 'x');
  const outputError = captureStreams();
  assert.equal(await main(['--fixture', '--output-dir', fileOutput], outputError.streams), 1);
  assert.match(outputError.chunks.stderr, /REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_INVALID/);

  assert.equal(fs.existsSync(path.join(outputDir, MANIFEST_FILENAME)), false);
  assert.equal(fs.existsSync(path.join(outputDir, MOTION_FILENAME)), false);
  assert.equal(fs.existsSync(path.join(outputDir, CONTACT_SHEET_FILENAME)), false);
});

test('注入 ffmpeg 失败时脱敏失败并清理本次最终输出', async (t) => {
  const outputDir = tempDir(t);
  const { chunks, streams } = captureStreams();
  const exitCode = await main(['--fixture', '--output-dir', outputDir], streams, {
    execFile() {
      throw Object.assign(new Error(`ffmpeg failed at ${outputDir} with sk-secret`), { code: 'ENOENT' });
    },
  });

  assert.equal(exitCode, 1);
  assert.match(chunks.stderr, /REDRAW_REFERENCE_BUNDLE_LOCAL_FFMPEG_FAILED/);
  assert.equal(chunks.stderr.includes(outputDir), false);
  assert.equal(chunks.stderr.includes('sk-secret'), false);
  assert.equal(fs.existsSync(path.join(outputDir, MANIFEST_FILENAME)), false);
  assert.equal(fs.existsSync(path.join(outputDir, MOTION_FILENAME)), false);
  assert.equal(fs.existsSync(path.join(outputDir, CONTACT_SHEET_FILENAME)), false);
});
