const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const test = require('node:test');

const {
  canonicalManifestSha256,
  createRedrawLocalTtsWorkerProcess,
} = require('../src/services/redrawLocalTtsWorkerProcess');

const NOT_READY = 'REDRAW_LOCAL_TTS_NOT_READY';
const OUTPUT_INVALID = 'REDRAW_LOCAL_TTS_OUTPUT_INVALID';
const RESULT_UNKNOWN = 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function wavChunk(id, body) {
  assert.equal(Buffer.byteLength(id, 'ascii'), 4);
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, ...(body.length % 2 === 1 ? [Buffer.alloc(1)] : [])]);
}

function pcmFormat(overrides = {}) {
  const values = {
    audioFormat: 1,
    channels: 1,
    sampleRate: 16000,
    bitsPerSample: 16,
    ...overrides,
  };
  const blockAlign = overrides.blockAlign ?? (values.channels * values.bitsPerSample) / 8;
  const byteRate = overrides.byteRate ?? values.sampleRate * blockAlign;
  const body = Buffer.alloc(16);
  body.writeUInt16LE(values.audioFormat, 0);
  body.writeUInt16LE(values.channels, 2);
  body.writeUInt32LE(values.sampleRate, 4);
  body.writeUInt32LE(byteRate, 8);
  body.writeUInt16LE(blockAlign, 12);
  body.writeUInt16LE(values.bitsPerSample, 14);
  return body;
}

function riffWave(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WAVE', 8, 4, 'ascii');
  return Buffer.concat([header, body]);
}

function waveBytes({ format = pcmFormat(), samples = Buffer.from([0, 0, 1, 0]), extraChunks = [] } = {}) {
  return riffWave([
    wavChunk('fmt ', format),
    ...extraChunks,
    wavChunk('data', samples),
  ]);
}

function assertProcessListenersRemoved(child) {
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdin.listenerCount('error'), 0);
  assert.equal(child.stdout.listenerCount('error'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('error'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
}

function fixture(t, { testOnly = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-local-tts-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, process.platform === 'win32' ? 'espeak-ng.exe' : 'espeak-ng');
  fs.writeFileSync(executablePath, 'pinned-test-binary');
  if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o755);
  const allowedOutputRoot = path.join(root, 'private-output');
  const outputRoot = path.join(allowedOutputRoot, 'request-1');
  fs.mkdirSync(outputRoot, { recursive: true });
  const manifest = {
    schema_version: 'local-tts-manifest-v1',
    engine: 'eSpeak NG',
    engine_version: '1.52.0-test',
    executable_path: executablePath,
    executable_sha256: sha256(fs.readFileSync(executablePath)),
    profiles: [{
      profile_key: 'role-1',
      locale: 'en-US',
      voice: 'en-us',
      pitch: 45,
      rate: 155,
      amplitude: 90,
    }],
    ...(testOnly ? { test_only: true } : {}),
  };
  manifest.manifest_sha256 = canonicalManifestSha256(manifest);
  return {
    root,
    allowedOutputRoot,
    outputRoot,
    executablePath,
    binarySha256: manifest.executable_sha256,
    manifest,
  };
}

function rehash(manifest) {
  const next = structuredClone(manifest);
  next.manifest_sha256 = canonicalManifestSha256(next);
  return next;
}

function workerOptions(current, overrides = {}) {
  const manifest = overrides.manifest || current.manifest;
  return {
    manifest,
    context: 'test',
    allowedOutputRoot: current.allowedOutputRoot,
    expectedManifestSha256: manifest.manifest_sha256,
    expectedEngineVersion: manifest.engine_version,
    timeoutMs: 1000,
    ...overrides,
  };
}

function synthInput(current, overrides = {}) {
  return {
    requestId: 'req-1',
    approvedText: 'Hello from the approved script.',
    locale: 'en-US',
    profileKey: 'role-1',
    outputRoot: current.outputRoot,
    ...overrides,
  };
}

function fakeSpawn({ outputBytes = waveBytes(), onStart, onEnd, closeCode = 0 } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killCount = 0;
    child.kill = () => {
      child.killCount += 1;
      return true;
    };
    let stdinText = '';
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdinText += chunk.toString('utf8');
        callback();
      },
      final(callback) {
        try {
          onEnd?.({ child, command, args, options, stdinText });
          if (outputBytes !== null) {
            const outputIndex = args.indexOf('-w');
            fs.writeFileSync(args[outputIndex + 1], outputBytes);
          }
          queueMicrotask(() => child.emit('close', closeCode));
          callback();
        } catch (error) {
          callback(error);
        }
      },
    });
    onStart?.({ child, command, args, options });
    return child;
  };
}

test('constructor requires trusted roots and externally pinned manifest identity', (t) => {
  const current = fixture(t);
  assert.deepEqual(Object.keys(createRedrawLocalTtsWorkerProcess(workerOptions(current))), [
    'assertReady',
    'synthesize',
    'assertEvidenceTrusted',
  ]);
  for (const missing of ['allowedOutputRoot', 'expectedManifestSha256', 'expectedEngineVersion']) {
    const options = workerOptions(current);
    delete options[missing];
    assert.throws(() => createRedrawLocalTtsWorkerProcess(options), { code: NOT_READY });
  }
  assert.throws(() => createRedrawLocalTtsWorkerProcess({
    ...workerOptions(current),
    expectedManifestSha256: '0'.repeat(64),
  }), { code: NOT_READY });
  assert.throws(() => createRedrawLocalTtsWorkerProcess({
    ...workerOptions(current),
    expectedEngineVersion: '1.52.0-other',
  }), { code: NOT_READY });
  assert.throws(() => createRedrawLocalTtsWorkerProcess({
    ...workerOptions(current),
    timeoutMs: 0,
  }), { code: NOT_READY });
});

test('assertReady requires an exact pinned manifest, ordinary executable, and locale profile', (t) => {
  const current = fixture(t);
  const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current));
  assert.doesNotThrow(() => worker.assertReady('en-US'));
  assert.throws(() => worker.assertReady('es-MX'), { code: NOT_READY });

  const withExtraKey = rehash({ ...current.manifest, unexpected: true });
  assert.throws(() => createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    manifest: withExtraKey,
  })), { code: NOT_READY });

  const production = fixture(t, { testOnly: false });
  assert.doesNotThrow(() => createRedrawLocalTtsWorkerProcess(workerOptions(production, {
    context: 'production',
  })).assertReady('en-US'));
  assert.throws(() => createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    context: 'production',
  })), { code: NOT_READY });
  assert.throws(() => createRedrawLocalTtsWorkerProcess(workerOptions(production, {
    manifest: rehash({ ...production.manifest, test_only: false }),
    context: 'production',
  })), { code: NOT_READY });

  const changedBinary = fixture(t);
  const changedWorker = createRedrawLocalTtsWorkerProcess(workerOptions(changedBinary));
  fs.appendFileSync(changedBinary.executablePath, 'changed');
  assert.throws(() => changedWorker.assertReady('en-US'), { code: NOT_READY });
});

test('assertReady rejects a pinned POSIX binary that is not executable', (t) => {
  const current = fixture(t);
  let accessChecks = 0;
  const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    platform: 'linux',
    accessSync(targetPath, mode) {
      accessChecks += 1;
      assert.equal(targetPath, current.executablePath);
      assert.equal(mode, fs.constants.X_OK);
      if (accessChecks > 1) {
        const error = new Error(`permission denied: ${targetPath}`);
        error.code = 'EACCES';
        throw error;
      }
    },
  }));

  assert.throws(() => worker.assertReady('en-US'), (error) => {
    assert.equal(error.code, NOT_READY);
    assert.equal(error.message.includes(current.root), false);
    return true;
  });
  assert.equal(accessChecks, 2);
});

test('manifest profiles have exact keys, unique identities, safe values, and fixed numeric ranges', (t) => {
  const current = fixture(t);
  const invalidProfiles = [
    { ...current.manifest.profiles[0], extra: true },
    { ...current.manifest.profiles[0], voice: '--path' },
    { ...current.manifest.profiles[0], locale: 'english' },
    { ...current.manifest.profiles[0], pitch: -1 },
    { ...current.manifest.profiles[0], pitch: 100 },
    { ...current.manifest.profiles[0], rate: 79 },
    { ...current.manifest.profiles[0], rate: 451 },
    { ...current.manifest.profiles[0], amplitude: -1 },
    { ...current.manifest.profiles[0], amplitude: 201 },
  ];
  for (const profile of invalidProfiles) {
    const manifest = rehash({ ...current.manifest, profiles: [profile] });
    assert.throws(() => createRedrawLocalTtsWorkerProcess(workerOptions(current, { manifest })), { code: NOT_READY });
  }

  const boundaryManifest = rehash({
    ...current.manifest,
    profiles: [
      { ...current.manifest.profiles[0], pitch: 0, rate: 80, amplitude: 0 },
      { ...current.manifest.profiles[0], profile_key: 'role-2', pitch: 99, rate: 450, amplitude: 200 },
    ],
  });
  assert.doesNotThrow(() => createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    manifest: boundaryManifest,
  })));

  const duplicateManifest = rehash({
    ...current.manifest,
    profiles: [
      current.manifest.profiles[0],
      { ...current.manifest.profiles[0], locale: 'es-MX', voice: 'es-mx' },
    ],
  });
  assert.throws(() => createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    manifest: duplicateManifest,
  })), { code: NOT_READY });
});

test('executable and allowed output root reject symlinks and realpath drift', (t) => {
  const current = fixture(t);
  const realExecutableDirectory = path.join(current.root, 'real-bin');
  fs.mkdirSync(realExecutableDirectory);
  const realExecutable = path.join(realExecutableDirectory, path.basename(current.executablePath));
  fs.copyFileSync(current.executablePath, realExecutable);
  const executableDirectoryLink = path.join(current.root, 'linked-bin');
  const outputLink = path.join(current.root, 'linked-output');
  try {
    fs.symlinkSync(realExecutableDirectory, executableDirectoryLink, process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(current.allowedOutputRoot, outputLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory reparse-point creation unavailable: ${error.code}`);
    return;
  }
  const linkedManifest = rehash({
    ...current.manifest,
    executable_path: path.join(executableDirectoryLink, path.basename(current.executablePath)),
    executable_sha256: sha256(fs.readFileSync(realExecutable)),
  });
  assert.throws(() => createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    manifest: linkedManifest,
  })), { code: NOT_READY });
  assert.throws(() => createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    allowedOutputRoot: outputLink,
  })), { code: NOT_READY });
});

test('synthesize uses the official eSpeak NG stdin and short-option CLI without shell', async (t) => {
  const current = fixture(t);
  let captured;
  const spawnImpl = fakeSpawn({
    onEnd(details) { captured = details; },
  });
  const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    spawnImpl,
    outputNameFactory: () => 'voice.wav',
  }));
  const result = await worker.synthesize(synthInput(current));
  const outputPath = path.join(current.outputRoot, 'voice.wav');

  assert.equal(captured.command, current.executablePath);
  assert.deepEqual(captured.args, [
    '--stdin',
    '-v', 'en-us',
    '-p', '45',
    '-s', '155',
    '-a', '90',
    '-w', outputPath,
  ]);
  assert.equal(captured.args.includes('Hello from the approved script.'), false);
  assert.equal(captured.stdinText, 'Hello from the approved script.');
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.windowsHide, true);
  assert.deepEqual(captured.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(captured.options.cwd, current.outputRoot);
  assert.equal(result.source, 'local_offline_tts');
  assert.equal(result.target_locale, 'en-US');
  assert.equal(result.output_sha256, sha256(waveBytes()));
  assert.equal(result.profile.profile_key, 'role-1');
  assert.equal(result.test_only, true);
});

test('output root must be an empty real child directory below the trusted root', async (t) => {
  const current = fixture(t);
  const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    spawnImpl: fakeSpawn(),
    outputNameFactory: () => 'voice.wav',
  }));

  await assert.rejects(worker.synthesize(synthInput(current, {
    outputRoot: current.allowedOutputRoot,
  })), { code: OUTPUT_INVALID });
  const outside = path.join(current.root, 'outside');
  fs.mkdirSync(outside);
  await assert.rejects(worker.synthesize(synthInput(current, { outputRoot: outside })), { code: OUTPUT_INVALID });
  const linkedTarget = path.join(current.allowedOutputRoot, 'linked-target');
  const linkedOutput = path.join(current.allowedOutputRoot, 'linked-request');
  fs.mkdirSync(linkedTarget);
  fs.symlinkSync(linkedTarget, linkedOutput, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(worker.synthesize(synthInput(current, { outputRoot: linkedOutput })), { code: OUTPUT_INVALID });
  fs.writeFileSync(path.join(current.outputRoot, 'preexisting.txt'), 'occupied');
  await assert.rejects(worker.synthesize(synthInput(current)), { code: OUTPUT_INVALID });
});

test('output root and output file reject symlinks, extra files, empty files, and invalid WAV headers', async (t) => {
  const declaredSizeMismatch = Buffer.from(waveBytes());
  declaredSizeMismatch.writeUInt32LE(declaredSizeMismatch.readUInt32LE(4) - 1, 4);
  const truncatedChunk = Buffer.from(waveBytes());
  truncatedChunk.writeUInt32LE(0xffffffff, 16);
  const cases = [
    {
      name: 'extra-file',
      outputBytes: waveBytes(),
      onEnd({ options }) { fs.writeFileSync(path.join(options.cwd, 'extra.txt'), 'extra'); },
    },
    { name: 'empty', outputBytes: Buffer.alloc(0) },
    { name: 'bad-header', outputBytes: Buffer.from('not-a-wave') },
    { name: 'header-only', outputBytes: riffWave([]) },
    { name: 'missing-fmt', outputBytes: riffWave([wavChunk('data', Buffer.from([0, 0]))]) },
    { name: 'missing-data', outputBytes: riffWave([wavChunk('fmt ', pcmFormat())]) },
    { name: 'empty-data', outputBytes: riffWave([wavChunk('fmt ', pcmFormat()), wavChunk('data', Buffer.alloc(0))]) },
    { name: 'declared-size-mismatch', outputBytes: declaredSizeMismatch },
    { name: 'truncated-file', outputBytes: waveBytes().subarray(0, waveBytes().length - 1) },
    { name: 'truncated-chunk', outputBytes: truncatedChunk },
    { name: 'non-pcm-format', outputBytes: waveBytes({ format: pcmFormat({ audioFormat: 3 }) }) },
    { name: 'zero-channels', outputBytes: waveBytes({ format: pcmFormat({ channels: 0, blockAlign: 0, byteRate: 0 }) }) },
    { name: 'zero-sample-rate', outputBytes: waveBytes({ format: pcmFormat({ sampleRate: 0, byteRate: 0 }) }) },
    { name: 'zero-block-align', outputBytes: waveBytes({ format: pcmFormat({ blockAlign: 0, byteRate: 0 }) }) },
    { name: 'mismatched-byte-rate', outputBytes: waveBytes({ format: pcmFormat({ byteRate: 1 }) }) },
    { name: 'invalid-bits-per-sample', outputBytes: waveBytes({ format: pcmFormat({ bitsPerSample: 12, blockAlign: 2 }) }) },
    { name: 'unaligned-data', outputBytes: waveBytes({ samples: Buffer.from([0, 1, 2]) }) },
    {
      name: 'duplicate-fmt',
      outputBytes: waveBytes({ extraChunks: [wavChunk('fmt ', pcmFormat())] }),
    },
    {
      name: 'duplicate-data',
      outputBytes: waveBytes({ extraChunks: [wavChunk('data', Buffer.from([0, 0]))] }),
    },
    { name: 'missing-file', outputBytes: null },
    {
      name: 'output-root-replaced',
      outputBytes: waveBytes(),
      onEnd({ options }) {
        fs.rmSync(options.cwd, { recursive: true, force: true });
        fs.mkdirSync(options.cwd);
      },
    },
  ];
  for (const currentCase of cases) {
    await t.test(currentCase.name, async (st) => {
      const current = fixture(st);
      const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
        spawnImpl: fakeSpawn(currentCase),
        outputNameFactory: () => 'voice.wav',
      }));
      await assert.rejects(worker.synthesize(synthInput(current)), { code: OUTPUT_INVALID });
    });
  }

  await t.test('standard odd-chunk padding is accepted', async (st) => {
    const current = fixture(st);
    const paddedWave = waveBytes({
      format: pcmFormat({ bitsPerSample: 8, blockAlign: 1, byteRate: 16000 }),
      samples: Buffer.from([0, 1, 2]),
      extraChunks: [wavChunk('JUNK', Buffer.from([1]))],
    });
    const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
      spawnImpl: fakeSpawn({ outputBytes: paddedWave }),
      outputNameFactory: () => 'voice.wav',
    }));
    const result = await worker.synthesize(synthInput(current));
    assert.equal(result.output_sha256, sha256(paddedWave));
  });

  await t.test('symlink-output', async (st) => {
    const current = fixture(st);
    const target = path.join(current.root, 'target-directory');
    fs.mkdirSync(target);
    const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
      spawnImpl: fakeSpawn({
        outputBytes: null,
        onEnd({ args }) {
          const outputPath = args[args.indexOf('-w') + 1];
          fs.symlinkSync(target, outputPath, process.platform === 'win32' ? 'junction' : 'dir');
        },
      }),
      outputNameFactory: () => 'voice.wav',
    }));
    try {
      await assert.rejects(worker.synthesize(synthInput(current)), { code: OUTPUT_INVALID });
    } catch (error) {
      if (error.code === 'EPERM') st.skip('output reparse-point creation unavailable');
      else throw error;
    }
  });
});

test('any stdout or stderr is a stable unknown result and kills once', async (t) => {
  for (const streamName of ['stdout', 'stderr']) {
    await t.test(streamName, async (st) => {
      const current = fixture(st);
      let child;
      const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
        spawnImpl: fakeSpawn({
          onStart(details) {
            child = details.child;
            queueMicrotask(() => child[streamName].emit('data', Buffer.from('unexpected')));
          },
        }),
        outputNameFactory: () => 'voice.wav',
      }));
      await assert.rejects(worker.synthesize(synthInput(current)), { code: RESULT_UNKNOWN });
      assertProcessListenersRemoved(child);
      child.emit('close', 0);
      child.stdout.emit('data', Buffer.from('late'));
      assert.equal(child.killCount, 1);
    });
  }

  await t.test('output-limit', async (st) => {
    const current = fixture(st);
    let child;
    const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
      spawnImpl: fakeSpawn({
        onStart(details) {
          child = details.child;
          queueMicrotask(() => child.stdout.emit('data', Buffer.alloc(64 * 1024 + 1)));
        },
      }),
      outputNameFactory: () => 'voice.wav',
    }));
    await assert.rejects(worker.synthesize(synthInput(current)), { code: RESULT_UNKNOWN });
    assertProcessListenersRemoved(child);
    assert.equal(child.killCount, 1);
  });
});

test('pre-aborted and running AbortSignal fail once as result unknown', async (t) => {
  const current = fixture(t);
  const preAborted = new AbortController();
  preAborted.abort();
  let spawnCount = 0;
  const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    spawnImpl: (...args) => {
      spawnCount += 1;
      return fakeSpawn()(...args);
    },
    outputNameFactory: () => 'voice.wav',
  }));
  await assert.rejects(worker.synthesize(synthInput(current, { signal: preAborted.signal })), { code: RESULT_UNKNOWN });
  assert.equal(spawnCount, 0);

  const runningRoot = path.join(current.allowedOutputRoot, 'request-2');
  fs.mkdirSync(runningRoot);
  const controller = new AbortController();
  let runningChild;
  const runningWorker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    spawnImpl: (command, args, options) => {
      runningChild = fakeSpawn({ outputBytes: null })(command, args, options);
      runningChild.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      return runningChild;
    },
    outputNameFactory: () => 'voice.wav',
  }));
  const pending = runningWorker.synthesize(synthInput(current, {
    outputRoot: runningRoot,
    signal: controller.signal,
  }));
  controller.abort();
  await assert.rejects(pending, { code: RESULT_UNKNOWN });
  assertProcessListenersRemoved(runningChild);
  runningChild.emit('close', 0);
  runningChild.stderr.emit('data', Buffer.from('late'));
  assert.equal(runningChild.killCount, 1);
});

test('timeout, spawn error, stdin error, nonzero close, and duplicate events settle once', async (t) => {
  const cases = [
    {
      name: 'timeout',
      build(current) {
        let child;
        return {
          options: workerOptions(current, {
            timeoutMs: 5,
            spawnImpl: (command, args, options) => {
              child = fakeSpawn({ outputBytes: null })(command, args, options);
              child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
              return child;
            },
            outputNameFactory: () => 'voice.wav',
          }),
          child: () => child,
        };
      },
    },
    {
      name: 'spawn-error',
      build(current) {
        return {
          options: workerOptions(current, {
            spawnImpl() { throw new Error('private spawn failure'); },
            outputNameFactory: () => 'voice.wav',
          }),
          child: () => null,
        };
      },
    },
    {
      name: 'stdin-error',
      build(current) {
        let child;
        return {
          options: workerOptions(current, {
            spawnImpl(command, args, options) {
              child = fakeSpawn({ outputBytes: null })(command, args, options);
              child.stdin = new Writable({
                write(_chunk, _encoding, callback) { callback(new Error('private stdin failure')); },
              });
              return child;
            },
            outputNameFactory: () => 'voice.wav',
          }),
          child: () => child,
        };
      },
    },
    {
      name: 'nonzero-close',
      build(current) {
        let child;
        return {
          options: workerOptions(current, {
            spawnImpl: fakeSpawn({ closeCode: 9, onStart(details) { child = details.child; }, outputBytes: null }),
            outputNameFactory: () => 'voice.wav',
          }),
          child: () => child,
        };
      },
    },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.name, async (st) => {
      const current = fixture(st);
      const built = currentCase.build(current);
      const worker = createRedrawLocalTtsWorkerProcess(built.options);
      await assert.rejects(worker.synthesize(synthInput(current)), (error) => {
        assert.equal(error.code, RESULT_UNKNOWN);
        assert.equal(error.message.includes('private'), false);
        assert.equal(error.message.includes(current.root), false);
        return true;
      });
      const child = built.child();
      if (child) {
        assertProcessListenersRemoved(child);
        child.emit('close', 0);
        child.stdout.emit('data', Buffer.from('late'));
        assert.equal(child.killCount, currentCase.name === 'nonzero-close' ? 0 : 1);
      }
    });
  }
});

test('successful close ignores duplicate late process events', async (t) => {
  const current = fixture(t);
  let child;
  const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current, {
    spawnImpl: fakeSpawn({ onStart(details) { child = details.child; } }),
    outputNameFactory: () => 'voice.wav',
  }));
  const result = await worker.synthesize(synthInput(current));
  assertProcessListenersRemoved(child);
  child.emit('close', 0);
  child.stderr.emit('data', Buffer.from('late'));
  assert.equal(result.output_sha256, sha256(waveBytes()));
  assert.equal(child.killCount, 0);
});

test('assertEvidenceTrusted accepts only exact local evidence for the pinned context', (t) => {
  const current = fixture(t);
  const worker = createRedrawLocalTtsWorkerProcess(workerOptions(current));
  const evidence = {
    source: 'local_offline_tts',
    engine: 'eSpeak NG',
    engine_version: current.manifest.engine_version,
    binary_sha256: current.binarySha256,
    manifest_sha256: current.manifest.manifest_sha256,
    profile: 'role-1',
    target_locale: 'en-US',
    test_only: true,
  };
  assert.doesNotThrow(() => worker.assertEvidenceTrusted(evidence));
  for (const mutation of [
    { ...evidence, provider_task_id: 'remote-task' },
    { ...evidence, ai_service_config_id: 16 },
    { ...evidence, real_generation_verified: true },
    { ...evidence, source: 'real_generation_verified' },
    { ...evidence, manifest_sha256: '0'.repeat(64) },
    { ...evidence, profile: 'role-2' },
    { ...evidence, target_locale: 'es-MX' },
    { ...evidence, test_only: false },
  ]) {
    assert.throws(() => worker.assertEvidenceTrusted(mutation), { code: NOT_READY });
  }
  const missing = { ...evidence };
  delete missing.binary_sha256;
  assert.throws(() => worker.assertEvidenceTrusted(missing), { code: NOT_READY });

  const production = fixture(t, { testOnly: false });
  const productionWorker = createRedrawLocalTtsWorkerProcess(workerOptions(production, {
    context: 'production',
  }));
  const productionEvidence = {
    source: 'local_offline_tts',
    engine: 'eSpeak NG',
    engine_version: production.manifest.engine_version,
    binary_sha256: production.binarySha256,
    manifest_sha256: production.manifest.manifest_sha256,
    profile: 'role-1',
    target_locale: 'en-US',
  };
  assert.doesNotThrow(() => productionWorker.assertEvidenceTrusted(productionEvidence));
  assert.throws(() => productionWorker.assertEvidenceTrusted({
    ...productionEvidence,
    test_only: false,
  }), { code: NOT_READY });
});
