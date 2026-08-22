const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const nativeAudio = require('../src/services/redrawNativeAudioService');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-native-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function makeVideo(root, name = 'shot.mp4', options = {}) {
  const output = path.join(root, name);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=24:duration=${options.videoDuration || 1.2}`,
  ];
  if (options.audio !== false) {
    args.push('-f', 'lavfi', '-i', options.silent
      ? `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${options.audioDuration || 1.2}`
      : `sine=frequency=880:sample_rate=44100:duration=${options.audioDuration || 1.2}`);
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-map', '0:v:0');
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (options.audio !== false) args.push('-c:a', 'aac', '-shortest');
  args.push(output);
  execFileSync(getFfmpegPath(), args);
  return output;
}

function makeAudioOnly(root, name = 'audio-only.mp4') {
  const output = path.join(root, name);
  execFileSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=1.2',
    '-map', '0:a:0',
    '-c:a', 'aac',
    output,
  ]);
  return output;
}

function workerEvidence(overrides = {}) {
  return {
    requestId: 'worker-request-1',
    source: 'offline-worker',
    audioSha256: overrides.audioSha256 || 'a'.repeat(64),
    localePack: 'es@1',
    expectedLanguage: 'es',
    detectedLanguage: 'es',
    detectedLocale: null,
    languageVerified: true,
    localeVerified: false,
    transcriptSha256: 'b'.repeat(64),
    dialogueSimilarity: 0.92,
    speechCharsPerSecond: 7.5,
    segments: [{ startMs: 0, endMs: 900, textSha256: 'c'.repeat(64) }],
    modelManifestSha256: 'd'.repeat(64),
    calibrationManifestSha256: 'e'.repeat(64),
    videoInvocation: {
      provider: 'toapis',
      model: 'seedance-2-fast',
      aiServiceConfigId: 16,
      configUpdatedAt: '2026-08-09T00:00:00.000Z',
      artifactSha256: 'f'.repeat(64),
      providerTaskIdSha256: crypto.createHash('sha256').update('provider-task-1').digest('hex'),
    },
    ...overrides,
  };
}

function requestFor(videoPath, overrides = {}) {
  return {
    storageRoot: path.dirname(videoPath),
    videoPath,
    approvedText: 'Hola, pequeño.',
    expectedLanguage: 'es',
    localePack: {
      id: 'es@1',
      language: 'es',
      thresholds: {
        dialogue_similarity_min: 0.8,
        speech_chars_per_second_max: 20,
      },
    },
    videoInvocation: {
      provider: 'toapis',
      model: 'seedance-2-fast',
      aiServiceConfigId: 16,
      configUpdatedAt: '2026-08-09T00:00:00.000Z',
      providerTaskId: 'provider-task-1',
      artifactSha256: sha256File(videoPath),
    },
    ...overrides,
  };
}

test('验证普通 MP4 音轨并输出稳定紧凑证据，Worker 只收到服务端 approved text/pack/video invocation', async (t) => {
  const root = makeRoot(t);
  const videoPath = makeVideo(root);
  let workerRequest;

  const result = await nativeAudio.validateNativeAudio(requestFor(videoPath, {
    localeVerifier: {
      async verifyNativeAudio(input) {
        workerRequest = input;
        assert.equal(input.approvedText, 'Hola, pequeño.');
        assert.equal(input.packId, 'es@1');
        assert.equal(input.expectedLanguage, 'es');
        assert.equal(input.videoInvocation.providerTaskId, 'provider-task-1');
        assert.equal(Object.hasOwn(input, 'detectedLocale'), false);
        return workerEvidence({
          audioSha256: input.audioSha256,
          videoInvocation: {
            provider: input.videoInvocation.provider,
            model: input.videoInvocation.model,
            aiServiceConfigId: input.videoInvocation.aiServiceConfigId,
            configUpdatedAt: input.videoInvocation.configUpdatedAt,
            artifactSha256: input.videoInvocation.artifactSha256,
            providerTaskIdSha256: crypto.createHash('sha256').update(input.videoInvocation.providerTaskId).digest('hex'),
          },
        });
      },
    },
  }));

  assert.equal(isInside(root, workerRequest.audioPath), false, '临时 WAV 不应位于公开 storageRoot');
  assert.equal(fs.existsSync(workerRequest.audioPath), false, '临时 WAV 应在 finally 清理');
  assert.equal(result.contract, 'redraw-native-audio-validation-v1');
  assert.equal(result.artifact_sha256, sha256File(videoPath));
  assert.equal(result.audio_stream.codec_type, 'audio');
  assert.equal(result.video_duration_ms > 900, true);
  assert.equal(result.silence.rms_db > result.silence.threshold_db, true);
  assert.deepEqual(result.verification, {
    detected_language: 'es',
    detected_locale: null,
    language_verified: true,
    locale_verified: false,
    transcript_sha256: 'b'.repeat(64),
    dialogue_similarity: 0.92,
    speech_chars_per_second: 7.5,
  });
  assert.match(result.validation_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes('Hola, pequeño.'), false);
  assert.equal(JSON.stringify(result).includes('provider-task-1'), false);
});

test('原生音轨验证临时快照和 WAV 必须写入非静态私有目录并清理', async (t) => {
  const root = makeRoot(t);
  const privateTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-native-private-'));
  t.after(() => fs.rmSync(privateTempRoot, { recursive: true, force: true }));
  const videoPath = makeVideo(root);
  const originalCopyFileSync = fs.copyFileSync;
  let copiedSnapshot = null;
  let workerRequest = null;
  t.after(() => { fs.copyFileSync = originalCopyFileSync; });
  fs.copyFileSync = function guardedCopyFileSync(src, dest, ...args) {
    originalCopyFileSync.call(this, src, dest, ...args);
    if (src === videoPath && path.basename(dest).startsWith('artifact')) copiedSnapshot = dest;
  };

  await nativeAudio.validateNativeAudio(requestFor(videoPath, {
    privateTempRoot,
    localeVerifier: {
      async verifyNativeAudio(input) {
        workerRequest = input;
        return workerEvidence({
          audioSha256: input.audioSha256,
          videoInvocation: {
            provider: input.videoInvocation.provider,
            model: input.videoInvocation.model,
            aiServiceConfigId: input.videoInvocation.aiServiceConfigId,
            configUpdatedAt: input.videoInvocation.configUpdatedAt,
            artifactSha256: input.videoInvocation.artifactSha256,
            providerTaskIdSha256: crypto.createHash('sha256').update(input.videoInvocation.providerTaskId).digest('hex'),
          },
        });
      },
    },
  }));

  assert.ok(copiedSnapshot, 'must copy video artifact to a private snapshot');
  assert.equal(isInside(root, copiedSnapshot), false, 'snapshot must not be under public storageRoot');
  assert.equal(isInside(root, workerRequest.audioPath), false, 'audio.wav must not be under public storageRoot');
  assert.equal(isInside(privateTempRoot, copiedSnapshot), true, 'snapshot must stay under privateTempRoot');
  assert.equal(isInside(privateTempRoot, workerRequest.audioPath), true, 'audio.wav must stay under privateTempRoot');
  assert.equal(fs.existsSync(path.dirname(copiedSnapshot)), false, 'private validation temp dir must be cleaned');
  assert.deepEqual(fs.readdirSync(privateTempRoot), []);
});

test('原生音轨验证拒绝位于 storageRoot 内的 privateTempRoot', async (t) => {
  const root = makeRoot(t);
  const videoPath = makeVideo(root);
  const publicSubdir = path.join(root, 'native-private');
  fs.mkdirSync(publicSubdir);
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(videoPath, {
      privateTempRoot: publicSubdir,
      localeVerifier: { verifyNativeAudio: async () => assert.fail('worker must not run with public privateTempRoot') },
    })),
    { code: 'REDRAW_NATIVE_AUDIO_PRIVATE_TEMP_INVALID' },
  );
});

test('媒体门禁拒绝路径越界、无音轨、近似静音、损坏音频、时长漂移和 Worker 证据漂移', async (t) => {
  const root = makeRoot(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-native-outside-'));
  const outside = makeVideo(outsideRoot, 'outside.mp4');
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const audioOnly = makeAudioOnly(root);
  const noAudio = makeVideo(root, 'no-audio.mp4', { audio: false });
  const silent = makeVideo(root, 'silent.mp4', { silent: true });
  const normal = makeVideo(root, 'normal.mp4');
  const corrupted = path.join(root, 'corrupted.mp4');
  fs.writeFileSync(corrupted, fs.readFileSync(normal).subarray(0, 256));
  let symlinkPath = null;
  try {
    symlinkPath = path.join(root, 'symlink-outside.mp4');
    fs.symlinkSync(outside, symlinkPath);
  } catch (_) {
    symlinkPath = null;
  }

  const baseVerifier = {
    async verifyNativeAudio(input) {
      return workerEvidence({
        audioSha256: input.audioSha256,
        videoInvocation: {
          provider: input.videoInvocation.provider,
          model: input.videoInvocation.model,
          aiServiceConfigId: input.videoInvocation.aiServiceConfigId,
          configUpdatedAt: input.videoInvocation.configUpdatedAt,
          artifactSha256: input.videoInvocation.artifactSha256,
          providerTaskIdSha256: crypto.createHash('sha256').update(input.videoInvocation.providerTaskId).digest('hex'),
        },
      });
    },
  };

  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(outside, { storageRoot: root, localeVerifier: baseVerifier })),
    { code: 'REDRAW_NATIVE_AUDIO_PATH_INVALID' },
  );
  if (symlinkPath) {
    await assert.rejects(
      () => nativeAudio.validateNativeAudio(requestFor(symlinkPath, { storageRoot: root, localeVerifier: baseVerifier })),
      { code: 'REDRAW_NATIVE_AUDIO_PATH_INVALID' },
    );
  }
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(audioOnly, { localeVerifier: baseVerifier })),
    { code: 'REDRAW_NATIVE_AUDIO_VIDEO_STREAM_MISSING' },
  );
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(noAudio, { localeVerifier: baseVerifier })),
    { code: 'REDRAW_NATIVE_AUDIO_STREAM_MISSING' },
  );
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(silent, { localeVerifier: baseVerifier })),
    { code: 'REDRAW_NATIVE_AUDIO_SILENT' },
  );
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(corrupted, { localeVerifier: baseVerifier })),
    { code: 'REDRAW_NATIVE_AUDIO_FFPROBE_FAILED' },
  );
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(normal, {
      expectedDurationMs: 4000,
      localeVerifier: baseVerifier,
    })),
    { code: 'REDRAW_NATIVE_AUDIO_DURATION_MISMATCH' },
  );
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(normal, {
      localeVerifier: {
        async verifyNativeAudio(input) {
          return workerEvidence({ audioSha256: input.audioSha256, detectedLanguage: 'en' });
        },
      },
    })),
    { code: 'REDRAW_NATIVE_AUDIO_WORKER_EVIDENCE_INVALID' },
  );
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(normal, {
      localeVerifier: {
        async verifyNativeAudio(input) {
          return workerEvidence({
            audioSha256: input.audioSha256,
            dialogueSimilarity: 0.2,
            videoInvocation: {
              provider: input.videoInvocation.provider,
              model: input.videoInvocation.model,
              aiServiceConfigId: input.videoInvocation.aiServiceConfigId,
              configUpdatedAt: input.videoInvocation.configUpdatedAt,
              artifactSha256: input.videoInvocation.artifactSha256,
              providerTaskIdSha256: crypto.createHash('sha256').update(input.videoInvocation.providerTaskId).digest('hex'),
            },
          });
        },
      },
    })),
    { code: 'REDRAW_NATIVE_AUDIO_WORKER_EVIDENCE_INVALID' },
  );
});

test('ffprobe、ffmpeg、PCM 字节和 Worker timeout 都 fail closed 且清理受控临时目录', async (t) => {
  const root = makeRoot(t);
  const videoPath = makeVideo(root);
  const verifier = {
    async verifyNativeAudio(input) {
      return workerEvidence({ audioSha256: input.audioSha256 });
    },
  };

  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(videoPath, {
      localeVerifier: verifier,
      ffprobeTimeoutMs: 1,
    })),
    { code: 'REDRAW_NATIVE_AUDIO_FFPROBE_FAILED' },
  );
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(videoPath, {
      localeVerifier: verifier,
      ffmpegTimeoutMs: 1,
    })),
    { code: 'REDRAW_NATIVE_AUDIO_FFMPEG_FAILED' },
  );
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(videoPath, {
      localeVerifier: verifier,
      maxPcmBytes: 128,
    })),
    { code: 'REDRAW_NATIVE_AUDIO_PCM_LIMIT_EXCEEDED' },
  );
  let workerAbortObserved = false;
  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(videoPath, {
      localeVerifier: {
        verifyNativeAudio(input) {
          assert.ok(input.signal instanceof AbortSignal);
          input.signal.addEventListener('abort', () => { workerAbortObserved = true; });
          return new Promise(() => {});
        },
      },
      workerTimeoutMs: 1,
    })),
    { code: 'REDRAW_NATIVE_AUDIO_WORKER_TIMEOUT' },
  );
  assert.equal(workerAbortObserved, true);

  const leftovers = fs.readdirSync(root).filter((name) => name.startsWith('native-audio-'));
  assert.deepEqual(leftovers, []);
});

test('WAV RMS 分析使用分块读取，不把抽取文件一次性载入内存', async (t) => {
  const root = makeRoot(t);
  const videoPath = makeVideo(root);
  const originalReadFileSync = fs.readFileSync;
  t.after(() => { fs.readFileSync = originalReadFileSync; });
  fs.readFileSync = function guardedReadFileSync(file, ...args) {
    if (String(file).endsWith(`${path.sep}audio.wav`)) {
      throw new Error('audio.wav must not be read with readFileSync');
    }
    return originalReadFileSync.call(this, file, ...args);
  };

  const result = await nativeAudio.validateNativeAudio(requestFor(videoPath, {
    localeVerifier: {
      async verifyNativeAudio(input) {
        return workerEvidence({
          audioSha256: input.audioSha256,
          videoInvocation: {
            provider: input.videoInvocation.provider,
            model: input.videoInvocation.model,
            aiServiceConfigId: input.videoInvocation.aiServiceConfigId,
            configUpdatedAt: input.videoInvocation.configUpdatedAt,
            artifactSha256: input.videoInvocation.artifactSha256,
            providerTaskIdSha256: crypto.createHash('sha256').update(input.videoInvocation.providerTaskId).digest('hex'),
          },
        });
      },
    },
  }));

  assert.match(result.validation_hash, /^[0-9a-f]{64}$/);
});

test('验证前复制受控私有视频快照且完成前重 hash 原 artifact 防 TOCTOU', async (t) => {
  const root = makeRoot(t);
  const videoPath = makeVideo(root);
  const originalCopyFileSync = fs.copyFileSync;
  let copiedSnapshot = null;
  t.after(() => { fs.copyFileSync = originalCopyFileSync; });
  fs.copyFileSync = function guardedCopyFileSync(src, dest, ...args) {
    originalCopyFileSync.call(this, src, dest, ...args);
    if (src === videoPath && String(dest).includes(`${path.sep}native-audio-`)) {
      copiedSnapshot = dest;
      fs.copyFileSync = originalCopyFileSync;
      fs.writeFileSync(videoPath, Buffer.from('artifact changed after private snapshot'));
    }
  };

  await assert.rejects(
    () => nativeAudio.validateNativeAudio(requestFor(videoPath, {
      localeVerifier: {
        async verifyNativeAudio(input) {
          if (copiedSnapshot) {
            assert.equal(input.videoInvocation.artifactSha256, sha256File(copiedSnapshot));
          }
          return workerEvidence({
            audioSha256: input.audioSha256,
            videoInvocation: {
              provider: input.videoInvocation.provider,
              model: input.videoInvocation.model,
              aiServiceConfigId: input.videoInvocation.aiServiceConfigId,
              configUpdatedAt: input.videoInvocation.configUpdatedAt,
              artifactSha256: input.videoInvocation.artifactSha256,
              providerTaskIdSha256: crypto.createHash('sha256').update(input.videoInvocation.providerTaskId).digest('hex'),
            },
          });
        },
      },
    })),
    { code: 'REDRAW_NATIVE_AUDIO_ARTIFACT_CHANGED' },
  );
  assert.ok(copiedSnapshot, 'must copy artifact to a private native-audio snapshot before probing');
  assert.equal(fs.existsSync(path.dirname(copiedSnapshot)), false, 'snapshot temp dir must be cleaned');
});
