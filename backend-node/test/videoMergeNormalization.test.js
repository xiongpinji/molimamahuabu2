const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const videoMergeService = require('../src/services/videoMergeService');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../src/utils/ffmpegPath');

const log = { info() {}, warn() {}, error() {} };

// R90：#98 第 1 集 KM 片段 480×854 带音轨，换 ToAPIs Seedance 2 Mini 补拍的片段 496×864 无音轨；
// 合成直接 concat 复制流会花屏、后面的声音整体提前。参数不一致时先统一转码，无音轨补静音。
const KM = { width: 480, height: 854, fps: '24/1', videoCodec: 'h264', pixFmt: 'yuv420p', audio: { codec: 'aac', sampleRate: 44100, channels: 2 } };
const TOAPIS_SILENT = { width: 496, height: 864, fps: '24/1', videoCodec: 'h264', pixFmt: 'yuv420p', audio: null };

describe('planClipNormalization', () => {
  it('keeps the old stream-copy concat when every clip has the same picture and sound parameters', () => {
    assert.equal(videoMergeService.planClipNormalization([KM, { ...KM }, { ...KM, audio: { ...KM.audio } }]), null);
  });

  it('normalizes to the most common size and the audio of the clips that have sound when channels are mixed', () => {
    assert.deepEqual(videoMergeService.planClipNormalization([KM, TOAPIS_SILENT, KM]), {
      width: 480, height: 854, fps: '24/1', sampleRate: 44100, channels: 2,
    });
    assert.deepEqual(videoMergeService.planClipNormalization([KM, { ...KM, audio: null }]), {
      width: 480, height: 854, fps: '24/1', sampleRate: 44100, channels: 2,
    }, 'a silent clip alone also needs a silent track');
  });

  it('leaves the episode alone when a clip cannot be probed, and has nothing to do for a single clip', () => {
    assert.equal(videoMergeService.planClipNormalization([KM, null, TOAPIS_SILENT]), null);
    assert.equal(videoMergeService.planClipNormalization([TOAPIS_SILENT]), null);
    assert.equal(videoMergeService.planClipNormalization([]), null);
  });

  it('uses even sizes, a valid frame rate and safe audio defaults', () => {
    const odd = { ...TOAPIS_SILENT, width: 495, height: 863, fps: '0/0' };
    assert.equal(videoMergeService.planClipNormalization([odd, { ...odd }]), null, 'identical clips are left alone even with odd sizes');
    assert.deepEqual(videoMergeService.planClipNormalization([odd, { ...odd, audio: { codec: 'aac', sampleRate: 48000, channels: 6 } }]), {
      width: 496, height: 864, fps: '24/1', sampleRate: 48000, channels: 2,
    });
    assert.deepEqual(videoMergeService.planClipNormalization([{ ...TOAPIS_SILENT, fps: '30000/1001' }, TOAPIS_SILENT, TOAPIS_SILENT, KM]), {
      width: 496, height: 864, fps: '24/1', sampleRate: 44100, channels: 2,
    });
  });
});

describe('normalizeClipsForConcat with ffmpeg', { skip: !hasLocalFfmpeg() && 'ffmpeg is not installed' }, () => {
  function makeClip(dir, name, { width, height, audio, volumeDb = null }) {
    const file = path.join(dir, name);
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=24:duration=1`];
    if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    if (audio && volumeDb != null) args.push('-af', `volume=${volumeDb}dB`);
    if (audio) args.push('-c:a', 'aac', '-ac', '2', '-shortest');
    args.push(file);
    const result = spawnSync(getFfmpegPath(), args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return file;
  }

  function meanVolume(file, start = 0, length = null) {
    const args = ['-hide_banner', '-nostats', '-ss', String(start)];
    if (length != null) args.push('-t', String(length));
    args.push('-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-');
    const result = spawnSync(getFfmpegPath(), args, { encoding: 'utf8' });
    const match = String(result.stderr).match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
    assert.ok(match, result.stderr);
    return match[1] === '-inf' ? -Infinity : Number(match[1]);
  }

  function streams(file) {
    const result = spawnSync(getFfprobePath(), ['-v', 'error', '-show_entries',
      'stream=codec_type,width,height,duration,sample_rate,channels', '-of', 'json', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).streams;
  }

  it('turns a KM-sized clip with sound and a ToAPIs-sized silent clip into one consistent episode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-normalize-'));
    try {
      const clips = [
        makeClip(dir, 'km1.mp4', { width: 480, height: 854, audio: true }),
        makeClip(dir, 'toapis.mp4', { width: 496, height: 864, audio: false }),
        makeClip(dir, 'km2.mp4', { width: 480, height: 854, audio: true }),
      ];
      const normalized = videoMergeService.normalizeClipsForConcat(clips, dir, log);
      assert.ok(normalized.plan, 'mixed clips are normalized');
      assert.equal(normalized.paths.length, 3);
      assert.deepEqual(normalized.created, normalized.paths);
      for (const file of normalized.paths) {
        const info = streams(file);
        const video = info.find((stream) => stream.codec_type === 'video');
        const audio = info.find((stream) => stream.codec_type === 'audio');
        assert.deepEqual([video.width, video.height], [480, 854], file);
        assert.ok(audio, `${file} has a sound track`);
        assert.equal(Number(audio.sample_rate), 44100);
        assert.equal(Number(audio.channels), 2);
      }
      const output = path.join(dir, 'episode.mp4');
      assert.equal(videoMergeService.runFfmpegConcat(normalized.paths, output, log), true);
      const merged = streams(output);
      const video = merged.find((stream) => stream.codec_type === 'video');
      const audio = merged.find((stream) => stream.codec_type === 'audio');
      assert.deepEqual([video.width, video.height], [480, 854]);
      assert.ok(Math.abs(Number(video.duration) - 3) < 0.25, `video ${video.duration}s`);
      assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.25,
        `sound keeps pace with the picture (${audio.duration}s vs ${video.duration}s)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not re-encode an episode whose clips already match', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-normalize-same-'));
    try {
      const clips = [
        makeClip(dir, 'a.mp4', { width: 480, height: 854, audio: true }),
        makeClip(dir, 'b.mp4', { width: 480, height: 854, audio: true }),
      ];
      const normalized = videoMergeService.normalizeClipsForConcat(clips, dir, log);
      assert.equal(normalized.plan, null);
      assert.deepEqual(normalized.paths, clips);
      assert.deepEqual(normalized.created, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // R91：#98 第 1 集 25 段响度从 -32.9 到 -13.3 LUFS 不等。
  // ffmpeg sine 振幅 1/8，转成双声道后均值约 -24 dB：-6 dB → 约 -28 LUFS，+12 dB → 约 -10 LUFS，都在 ±10 dB 调整范围内，
  // 统一到 -18 LUFS 后平均音量都约 -20 dB。
  it('evens out the loudness of redraw clips and fades every clip in and out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-smooth-'));
    try {
      const quiet = makeClip(dir, 'quiet.mp4', { width: 480, height: 854, audio: true, volumeDb: -6 });
      const loud = makeClip(dir, 'loud.mp4', { width: 480, height: 854, audio: true, volumeDb: 12 });
      const before = [meanVolume(quiet), meanVolume(loud)];
      assert.ok(before[1] - before[0] > 15, `test clips differ in loudness: ${before}`);
      const normalized = videoMergeService.normalizeClipsForConcat([quiet, loud], dir, log, { smoothAudio: true });
      assert.ok(normalized.plan, 'matching clips are still re-encoded when the sound is smoothed');
      assert.equal(normalized.created.length, 2);
      const after = normalized.paths.map((file) => meanVolume(file, 0.2, 0.6));
      assert.ok(Math.abs(after[0] - after[1]) < 2, `levels after smoothing: ${after}`);
      for (const level of after) assert.ok(Math.abs(level + 20) < 2.5, `about -20 dB: ${level}`);
      for (const file of normalized.paths) {
        const head = meanVolume(file, 0, 0.02);
        const middle = meanVolume(file, 0.4, 0.2);
        assert.ok(head < middle - 6, `fade in at the cut (${head} dB vs ${middle} dB)`);
      }
      const output = path.join(dir, 'episode.mp4');
      assert.equal(videoMergeService.runFfmpegConcat(normalized.paths, output, log), true);
      const merged = streams(output);
      const video = merged.find((stream) => stream.codec_type === 'video');
      const audio = merged.find((stream) => stream.codec_type === 'audio');
      assert.ok(Math.abs(Number(video.duration) - 2) < 0.25, `video ${video.duration}s`);
      assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.25, `audio ${audio.duration}s`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not boost a clip that is silent and still gives a clip without sound a silent track', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-smooth-silent-'));
    try {
      const hush = makeClip(dir, 'hush.mp4', { width: 480, height: 854, audio: true, volumeDb: -90 });
      const mute = makeClip(dir, 'mute.mp4', { width: 480, height: 854, audio: false });
      const normalized = videoMergeService.normalizeClipsForConcat([hush, mute], dir, log, { smoothAudio: true });
      assert.ok(normalized.plan);
      assert.ok(meanVolume(normalized.paths[0]) < -60, 'a near-silent clip is not amplified into noise');
      assert.ok(streams(normalized.paths[1]).some((stream) => stream.codec_type === 'audio'), 'silent track added');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('processVideoMerge order', () => {
  it('normalizes after trimming to storyboard durations and before concatenating', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/videoMergeService.js'), 'utf8').replace(/\r\n/g, '\n');
    const body = source.slice(source.indexOf('async function processVideoMerge('));
    const trim = body.indexOf('trimClipToDuration(localPaths[i]');
    const normalize = body.indexOf('normalizeClipsForConcat(localPaths, tempDir, log, { smoothAudio: earlyMergeOpts.smooth_audio === true })');
    const concat = body.indexOf('runFfmpegConcat(localPaths, outputPath, log)');
    assert.ok(trim > 0 && normalize > trim && concat > normalize, `${trim} < ${normalize} < ${concat}`);
    assert.match(body, /toCleanup\.push\(\.\.\.normalized\.created\)/, 'normalized temp files are cleaned up');
    assert.ok(body.includes('if (localPaths.length > 1 || earlyMergeOpts.smooth_audio === true) {'), 'a single redraw clip is smoothed too');
  });
});
