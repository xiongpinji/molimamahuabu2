const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const assetService = require('../src/services/assetService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const sourceAudioEvidenceService = require('../src/services/redrawSourceAudioEvidenceService');

test('source audio evidence service exposes analyzeSourceAudio', () => {
  assert.equal(typeof sourceAudioEvidenceService?.analyzeSourceAudio, 'function');
});

const { analyzeSourceAudio } = sourceAudioEvidenceService;
const log = { info() {}, warn() {}, error() {} };
const AUDIO_BYTES = Buffer.from('private-pcm-wav-bytes');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createHarness(t, overrides = {}) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audio-storage-'));
  const privateAudioRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audio-private-'));
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  t.after(() => {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(privateAudioRoot, { recursive: true, force: true });
  });

  const sourceRelative = 'uploads/source-video.mp4';
  const sourcePath = path.join(storageRoot, sourceRelative);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, 'registered-source-video');
  const sourceAsset = assetService.create(db, log, {
    name: 'source-video.mp4',
    type: 'video',
    category: 'redraw_source',
    local_path: sourceRelative,
    mime_type: 'video/mp4',
    metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
  });
  const now = '2026-09-03T01:02:03.000Z';
  db.prepare(`
    INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, 'tenant-1', 'user-1', 'source audio', 'draft', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO redraw_works
      (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, status, current_step, created_at, updated_at)
    VALUES (1, 1, 'tenant-1', 'user-1', 'source audio', ?, ?, 12000, 'draft', 1, ?, ?)
  `).run(sourceAsset.id, sha256(fs.readFileSync(sourcePath)), now, now);

  const execCalls = [];
  const workerCalls = [];
  const ids = ['task-7fdca1', 'wav-6e91b2', 'tmp-495e0a'];
  const ctx = {
    db,
    log,
    storageRoot,
    privateAudioRoot,
    assetService,
    ffmpegPath: 'ffmpeg-test',
    now: () => now,
    idFactory: () => ids.shift(),
    execFile: async (command, args, options) => {
      const inputPath = args[args.indexOf('-i') + 1];
      execCalls.push({ command, args, options, sourceBytes: fs.readFileSync(inputPath) });
      fs.writeFileSync(args.at(-1), AUDIO_BYTES);
    },
    workerClient: {
      async analyzeSourceAudio(input) {
        workerCalls.push(input);
        assert.equal(fs.existsSync(input.audioPath), true);
        return {
          requestId: input.requestId,
          sourceLanguage: 'zh',
          languageProbability: 0.98,
          audioSha256: input.audioSha256,
          transcriptSha256: 'b'.repeat(64),
          segments: [{
            startMs: 0,
            endMs: 720,
            text: '你回来了',
            speakerClusterId: 'speaker-cluster-1',
          }],
        };
      },
    },
    ...overrides,
  };
  return {
    ctx,
    db,
    execCalls,
    privateAudioRoot,
    sourceAsset,
    sourcePath,
    storageRoot,
    workerCalls,
  };
}

function validInput(sourceAssetId) {
  return {
    workId: 1,
    sourceAssetId,
    tenantId: 'tenant-1',
    userId: 'user-1',
  };
}

test('analyzeSourceAudio extracts private PCM WAV and atomically registers bound evidence', async (t) => {
  const harness = createHarness(t);
  const result = await analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id));

  assert.equal(harness.execCalls.length, 1);
  assert.equal(harness.execCalls[0].command, 'ffmpeg-test');
  const sourceSnapshotPath = harness.execCalls[0].args[5];
  assert.deepEqual(harness.execCalls[0].args, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourceSnapshotPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    harness.workerCalls[0].audioPath,
  ]);
  assert.notEqual(sourceSnapshotPath, harness.sourcePath);
  assert.equal(path.dirname(sourceSnapshotPath), path.dirname(harness.workerCalls[0].audioPath));
  assert.deepEqual(harness.execCalls[0].sourceBytes, fs.readFileSync(harness.sourcePath));
  assert.equal(harness.execCalls[0].options.shell, false);
  assert.equal(harness.workerCalls.length, 1);
  assert.equal(path.isAbsolute(harness.workerCalls[0].audioPath), true);
  assert.equal(path.relative(harness.privateAudioRoot, harness.workerCalls[0].audioPath).startsWith('..'), false);
  assert.match(path.basename(harness.workerCalls[0].audioPath), /^wav-6e91b2\.wav$/);
  assert.equal(harness.workerCalls[0].audioSha256, sha256(AUDIO_BYTES));
  assert.equal(harness.workerCalls[0].privateAudioRoot, fs.realpathSync.native(harness.privateAudioRoot));

  assert.equal(result.schema_version, 'redraw-source-audio-evidence-v1');
  assert.equal(result.dialogue_mode, 'spoken');
  assert.equal(result.segments[0].speaker_cluster_id, 'speaker-cluster-1');
  assert.match(result.audio_sha256, /^[0-9a-f]{64}$/);
  assert.match(result.transcript_sha256, /^[0-9a-f]{64}$/);
  assert.match(result.source_video_sha256, /^[0-9a-f]{64}$/);
  assert.match(result.evidence_sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(result, 'local_path'), false);
  assert.doesNotMatch(JSON.stringify(result), /source-audio-private-|source-audio-storage-/);

  const asset = harness.db.prepare('SELECT * FROM assets WHERE id = ?').get(result.result_asset_id);
  assert.equal(asset.type, 'json');
  assert.equal(asset.category, 'redraw_source_audio_evidence');
  assert.equal(path.isAbsolute(asset.local_path), false);
  assert.match(asset.local_path.replace(/\\/g, '/'), /^redraw-source-audio-evidence\/task-7fdca1\/audio-evidence\.json$/);
  const saved = JSON.parse(fs.readFileSync(path.join(harness.storageRoot, asset.local_path), 'utf8'));
  assert.equal(saved.schema_version, 'redraw-source-audio-evidence-v1');
  assert.equal(saved.source_asset_id, harness.sourceAsset.id);
  assert.equal(saved.audio_sha256, sha256(AUDIO_BYTES));
  assert.equal(saved.transcript_sha256, 'b'.repeat(64));
  assert.equal(saved.segments[0].source_text, '你回来了');
  assert.equal(Object.hasOwn(saved, 'local_path'), false);
  assert.doesNotMatch(JSON.stringify(saved), /source-audio-private-|source-audio-storage-/);

  const metadata = JSON.parse(asset.metadata);
  assert.equal(metadata.tenant_id, 'tenant-1');
  assert.equal(metadata.user_id, 'user-1');
  assert.equal(metadata.work_id, 1);
  assert.equal(metadata.source_asset_id, harness.sourceAsset.id);
  assert.equal(metadata.source_video_sha256, result.source_video_sha256);
  assert.equal(metadata.audio_sha256, result.audio_sha256);
  assert.equal(metadata.transcript_sha256, result.transcript_sha256);
  assert.equal(fs.existsSync(harness.sourcePath), true);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio persists explicit silent evidence when ffmpeg proves no audio stream', async (t) => {
  let workerCalls = 0;
  const harness = createHarness(t, {
    execFile: async () => {
      const error = new Error('ffmpeg failed');
      error.stderr = 'Output file #0 does not contain any stream';
      throw error;
    },
    workerClient: {
      async analyzeSourceAudio() {
        workerCalls += 1;
        throw new Error('worker must not run');
      },
    },
  });

  const result = await analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id));
  assert.equal(workerCalls, 0);
  assert.equal(result.dialogue_mode, 'silent');
  assert.deepEqual(result.segments, []);
  assert.equal(result.audio_sha256, null);
  assert.equal(result.transcript_sha256, sha256('[]'));
  assert.match(result.source_video_sha256, /^[0-9a-f]{64}$/);
  const asset = harness.db.prepare('SELECT * FROM assets WHERE id = ?').get(result.result_asset_id);
  const saved = JSON.parse(fs.readFileSync(path.join(harness.storageRoot, asset.local_path), 'utf8'));
  assert.equal(saved.dialogue_mode, 'silent');
  assert.deepEqual(saved.segments, []);
  assert.equal(saved.source_asset_id, harness.sourceAsset.id);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio maps timeout to unknown once and leaves no evidence or temp audio', async (t) => {
  let workerCalls = 0;
  const harness = createHarness(t, {
    workerClient: {
      async analyzeSourceAudio() {
        workerCalls += 1;
        const error = new Error('private timeout details');
        error.code = 'REDRAW_LOCALE_VERIFIER_TIMEOUT';
        throw error;
      },
    },
  });

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    (error) => error.code === 'SOURCE_AUDIO_RESULT_UNKNOWN'
      && error.message === 'SOURCE_AUDIO_RESULT_UNKNOWN'
      && !JSON.stringify(error).includes('private'),
  );
  assert.equal(workerCalls, 1);
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
  assert.equal(fs.existsSync(path.join(harness.storageRoot, 'redraw-source-audio-evidence')), false);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
  assert.equal(fs.existsSync(harness.sourcePath), true);
});

test('analyzeSourceAudio rejects owner drift, source mismatch, unsafe registered paths and caller paths before ffmpeg', async (t) => {
  const harness = createHarness(t);
  const other = assetService.create(harness.db, log, {
    name: 'other.mp4',
    type: 'video',
    category: 'redraw_source',
    local_path: 'uploads/other.mp4',
    metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
  });
  fs.writeFileSync(path.join(harness.storageRoot, other.local_path), 'other');

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, { ...validInput(harness.sourceAsset.id), tenantId: 'tenant-2' }),
    { code: 'SOURCE_AUDIO_WORK_NOT_FOUND' },
  );
  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(other.id)),
    { code: 'SOURCE_AUDIO_SOURCE_ASSET_MISMATCH' },
  );
  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, {
      ...validInput(harness.sourceAsset.id),
      sourcePath: path.join(os.tmpdir(), 'caller-controlled.mp4'),
    }),
    { code: 'SOURCE_AUDIO_INPUT_INVALID' },
  );
  harness.db.prepare('UPDATE assets SET local_path = ? WHERE id = ?')
    .run('../outside.mp4', harness.sourceAsset.id);
  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    { code: 'SOURCE_AUDIO_SOURCE_PATH_INVALID' },
  );
  assert.equal(harness.execCalls.length, 0);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio cleans private WAV and avoids persistence after deterministic worker rejection', async (t) => {
  let workerCalls = 0;
  const harness = createHarness(t, {
    workerClient: {
      async analyzeSourceAudio() {
        workerCalls += 1;
        const error = new Error('C:\\private\\audio.wav rejected');
        error.code = 'SOURCE_AUDIO_ANALYSIS_FAILED';
        throw error;
      },
    },
  });

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    (error) => error.code === 'SOURCE_AUDIO_ANALYSIS_FAILED'
      && error.message === 'SOURCE_AUDIO_ANALYSIS_FAILED'
      && !JSON.stringify(error).includes('private'),
  );
  assert.equal(workerCalls, 1);
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
  assert.equal(fs.existsSync(harness.sourcePath), true);
});

test('analyzeSourceAudio rejects path-bearing injected Worker evidence before persistence', async (t) => {
  const harness = createHarness(t, {
    workerClient: {
      async analyzeSourceAudio(input) {
        return {
          requestId: input.requestId,
          sourceLanguage: 'zh',
          languageProbability: 0.9,
          audioSha256: input.audioSha256,
          transcriptSha256: 'c'.repeat(64),
          segments: [{
            startMs: 0,
            endMs: 500,
            text: 'C:\\private\\worker\\audio.wav',
            speakerClusterId: 'speaker-cluster-1',
          }],
        };
      },
    },
  });

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    { code: 'SOURCE_AUDIO_EVIDENCE_INVALID' },
  );
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio refuses an evidence-root symlink without writing or registering outside storage', async (t) => {
  const harness = createHarness(t);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audio-evidence-outside-'));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const evidenceRoot = path.join(harness.storageRoot, 'redraw-source-audio-evidence');
  fs.symlinkSync(externalRoot, evidenceRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.lstatSync(evidenceRoot).isSymbolicLink(), true);

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    { code: 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID' },
  );

  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
  assert.equal(fs.existsSync(path.join(externalRoot, 'task-7fdca1', 'audio-evidence.json')), false);
});

test('analyzeSourceAudio refuses a storage-root symlink before ffmpeg or Worker runs', async (t) => {
  const harness = createHarness(t);
  const linkedStorageRoot = path.join(os.tmpdir(), `source-audio-storage-link-${crypto.randomUUID()}`);
  fs.symlinkSync(
    harness.storageRoot,
    linkedStorageRoot,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  t.after(() => fs.rmSync(linkedStorageRoot, { recursive: true, force: true }));
  assert.equal(fs.lstatSync(linkedStorageRoot).isSymbolicLink(), true);

  await assert.rejects(
    () => analyzeSourceAudio({ ...harness.ctx, storageRoot: linkedStorageRoot }, validInput(harness.sourceAsset.id)),
    (error) => error.code === 'SOURCE_AUDIO_STORAGE_ROOT_INVALID'
      && error.message === 'SOURCE_AUDIO_STORAGE_ROOT_INVALID'
      && !error.message.includes(linkedStorageRoot),
  );

  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.workerCalls.length, 0);
});

test('analyzeSourceAudio refuses a private-root symlink before ffmpeg or Worker runs', async (t) => {
  const harness = createHarness(t);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audio-private-outside-'));
  const linkedRoot = path.join(os.tmpdir(), `source-audio-private-link-${crypto.randomUUID()}`);
  fs.symlinkSync(externalRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => {
    fs.rmSync(linkedRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  });
  assert.equal(fs.lstatSync(linkedRoot).isSymbolicLink(), true);

  await assert.rejects(
    () => analyzeSourceAudio({ ...harness.ctx, privateAudioRoot: linkedRoot }, validInput(harness.sourceAsset.id)),
    { code: 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID' },
  );

  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.workerCalls.length, 0);
  assert.deepEqual(fs.readdirSync(externalRoot), []);
});

test('analyzeSourceAudio creates the private root and task directory as 0700 and WAV as 0600', async (t) => {
  const harness = createHarness(t);
  const privateAudioRoot = path.join(os.tmpdir(), `source-audio-private-new-${crypto.randomUUID()}`);
  t.after(() => fs.rmSync(privateAudioRoot, { recursive: true, force: true }));
  const mkdirCalls = [];
  const openCalls = [];
  const writeCalls = [];
  const renameCalls = [];
  const fsApi = Object.create(fs);
  fsApi.mkdirSync = (target, options) => {
    mkdirCalls.push({ target: path.resolve(target), options });
    return fs.mkdirSync(target, options);
  };
  fsApi.openSync = (target, flags, mode) => {
    openCalls.push({ target: path.resolve(target), flags, mode });
    return fs.openSync(target, flags, mode);
  };
  fsApi.writeFileSync = (target, value, options) => {
    writeCalls.push({ target: path.resolve(target), options });
    return fs.writeFileSync(target, value, options);
  };
  fsApi.renameSync = (source, target) => {
    renameCalls.push({ source: path.resolve(source), target: path.resolve(target) });
    return fs.renameSync(source, target);
  };
  const ctx = {
    ...harness.ctx,
    fs: fsApi,
    privateAudioRoot,
    execFile: async (command, args) => {
      const wavPath = args.at(-1);
      assert.equal(fs.lstatSync(wavPath).isFile(), true);
      fs.writeFileSync(wavPath, AUDIO_BYTES);
    },
  };

  await analyzeSourceAudio(ctx, validInput(harness.sourceAsset.id));

  assert.deepEqual(mkdirCalls.find((call) => call.target === path.resolve(privateAudioRoot))?.options, {
    recursive: true,
    mode: 0o700,
  });
  const taskDirectory = path.join(privateAudioRoot, 'source-audio-task-7fdca1');
  assert.deepEqual(mkdirCalls.find((call) => call.target === path.resolve(taskDirectory))?.options, {
    mode: 0o700,
  });
  assert.deepEqual(openCalls.map(({ target, flags, mode }) => ({ target, flags, mode })), [{
    target: path.resolve(harness.sourcePath),
    flags: 'r',
    mode: undefined,
  }, {
    target: path.resolve(taskDirectory, 'source-task-7fdca1.bin'),
    flags: 'wx',
    mode: 0o600,
  }, {
    target: path.resolve(taskDirectory, 'wav-6e91b2.wav'),
    flags: 'wx',
    mode: 0o600,
  }]);
  const evidenceWrite = writeCalls.find((call) => path.basename(call.target).startsWith('.audio-evidence-'));
  assert.deepEqual(evidenceWrite?.options, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  assert.equal(path.dirname(evidenceWrite.target), path.resolve(
    harness.storageRoot,
    'redraw-source-audio-evidence',
    'task-7fdca1',
  ));
  assert.deepEqual(renameCalls, [{
    source: evidenceWrite.target,
    target: path.resolve(
      harness.storageRoot,
      'redraw-source-audio-evidence',
      'task-7fdca1',
      'audio-evidence.json',
    ),
  }]);
});

test('analyzeSourceAudio rejects a group-writable existing private root on POSIX', {
  skip: process.platform === 'win32',
}, async (t) => {
  const harness = createHarness(t);
  fs.chmodSync(harness.privateAudioRoot, 0o770);

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    { code: 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID' },
  );

  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.workerCalls.length, 0);
});

test('analyzeSourceAudio fails closed without deleting a pre-existing private task directory', async (t) => {
  const harness = createHarness(t);
  const occupiedTaskDir = path.join(harness.privateAudioRoot, 'source-audio-task-7fdca1');
  const sentinelPath = path.join(occupiedTaskDir, 'keep.txt');
  fs.mkdirSync(occupiedTaskDir, { mode: 0o700 });
  fs.writeFileSync(sentinelPath, 'keep');

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    (error) => error.code === 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID'
      && error.message === 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID'
      && !error.message.includes(harness.privateAudioRoot),
  );

  assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'keep');
  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.workerCalls.length, 0);
});

test('analyzeSourceAudio never recursively cleans a task directory swapped to an outside junction', async (t) => {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audio-cleanup-outside-'));
  const sentinelPath = path.join(externalRoot, 'keep.txt');
  fs.writeFileSync(sentinelPath, 'keep');
  let swappedTaskDir;
  const harness = createHarness(t, {
    workerClient: {
      async analyzeSourceAudio(input) {
        swappedTaskDir = path.dirname(input.audioPath);
        for (const entry of fs.readdirSync(swappedTaskDir)) {
          fs.rmSync(path.join(swappedTaskDir, entry), { force: true });
        }
        fs.rmdirSync(swappedTaskDir);
        fs.symlinkSync(externalRoot, swappedTaskDir, process.platform === 'win32' ? 'junction' : 'dir');
        const error = new Error('worker result unknown');
        error.code = 'SOURCE_AUDIO_RESULT_UNKNOWN';
        throw error;
      },
    },
  });
  t.after(() => {
    if (swappedTaskDir) fs.rmSync(swappedTaskDir, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    { code: 'SOURCE_AUDIO_PRIVATE_CLEANUP_FAILED' },
  );

  assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(swappedTaskDir).isSymbolicLink(), true);
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
});

test('analyzeSourceAudio removes the evidence file when asset registration fails', async (t) => {
  const harness = createHarness(t);
  const failingAssetService = {
    getById: assetService.getById,
    create(db, serviceLog, payload) {
      if (payload.category === 'redraw_source_audio_evidence') {
        throw new Error('registration failed');
      }
      return assetService.create(db, serviceLog, payload);
    },
  };

  await assert.rejects(
    () => analyzeSourceAudio({ ...harness.ctx, assetService: failingAssetService }, validInput(harness.sourceAsset.id)),
    { code: 'SOURCE_AUDIO_PERSISTENCE_FAILED' },
  );

  const evidenceRoot = path.join(harness.storageRoot, 'redraw-source-audio-evidence');
  assert.equal(fs.existsSync(path.join(evidenceRoot, 'task-7fdca1', 'audio-evidence.json')), false);
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio feeds ffmpeg an immutable private snapshot when the registered source path changes', async (t) => {
  const harness = createHarness(t);
  const originalBytes = fs.readFileSync(harness.sourcePath);
  const replacementBytes = Buffer.from('replacement-source-video');
  let ffmpegInput;
  const ctx = {
    ...harness.ctx,
    execFile: async (command, args) => {
      fs.writeFileSync(harness.sourcePath, replacementBytes);
      ffmpegInput = args[args.indexOf('-i') + 1];
      assert.notEqual(ffmpegInput, harness.sourcePath);
      assert.deepEqual(fs.readFileSync(ffmpegInput), originalBytes);
      fs.writeFileSync(args.at(-1), AUDIO_BYTES);
    },
  };

  const result = await analyzeSourceAudio(ctx, validInput(harness.sourceAsset.id));

  assert.equal(result.source_video_sha256, sha256(originalBytes));
  assert.equal(fs.readFileSync(harness.sourcePath, 'utf8'), replacementBytes.toString('utf8'));
  assert.equal(fs.existsSync(ffmpegInput), false);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio rejects malformed or mismatched work source fingerprints before ffmpeg', async (t) => {
  const harness = createHarness(t);
  for (const fingerprint of ['not-a-sha256', '0'.repeat(64)]) {
    harness.db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = 1').run(fingerprint);
    await assert.rejects(
      () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
      (error) => error.code === 'SOURCE_AUDIO_SOURCE_FINGERPRINT_INVALID'
        && error.message === 'SOURCE_AUDIO_SOURCE_FINGERPRINT_INVALID'
        && !error.message.includes(harness.sourcePath),
    );
  }

  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.workerCalls.length, 0);
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio rejects a source asset SHA that does not match snapshot bytes', async (t) => {
  const harness = createHarness(t);
  harness.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify({
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    sha256: '0'.repeat(64),
  }), harness.sourceAsset.id);

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    (error) => error.code === 'SOURCE_AUDIO_SOURCE_ASSET_HASH_INVALID'
      && error.message === 'SOURCE_AUDIO_SOURCE_ASSET_HASH_INVALID'
      && !error.message.includes(harness.sourcePath),
  );

  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.workerCalls.length, 0);
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio rejects registered source asset size drift before ffmpeg', async (t) => {
  const harness = createHarness(t);
  harness.db.prepare('UPDATE assets SET file_size = ? WHERE id = ?')
    .run(fs.statSync(harness.sourcePath).size + 1, harness.sourceAsset.id);

  await assert.rejects(
    () => analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id)),
    (error) => error.code === 'SOURCE_AUDIO_SOURCE_ASSET_SIZE_INVALID'
      && error.message === 'SOURCE_AUDIO_SOURCE_ASSET_SIZE_INVALID'
      && !error.message.includes(harness.sourcePath),
  );

  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.workerCalls.length, 0);
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio supports a legacy empty fingerprint using the immutable snapshot SHA', async (t) => {
  const harness = createHarness(t);
  const sourceBytes = fs.readFileSync(harness.sourcePath);
  harness.db.prepare("UPDATE redraw_works SET source_fingerprint = '' WHERE id = 1").run();

  const result = await analyzeSourceAudio(harness.ctx, validInput(harness.sourceAsset.id));

  assert.equal(result.source_video_sha256, sha256(sourceBytes));
  assert.equal(result.source_asset_id, harness.sourceAsset.id);
  assert.equal(harness.execCalls.length, 1);
  assert.equal(harness.workerCalls.length, 1);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});

test('analyzeSourceAudio sanitizes source snapshot open and copy failures before ffmpeg', async (t) => {
  for (const failure of ['open', 'copy']) {
    await t.test(failure, async (child) => {
      const harness = createHarness(child);
      const fsApi = Object.create(fs);
      let sourceDescriptor;
      fsApi.openSync = (target, flags, mode) => {
        if (path.resolve(target) === path.resolve(harness.sourcePath) && flags === 'r') {
          if (failure === 'open') throw new Error(`cannot open ${harness.sourcePath}`);
          sourceDescriptor = fs.openSync(target, flags, mode);
          return sourceDescriptor;
        }
        return fs.openSync(target, flags, mode);
      };
      fsApi.readSync = (descriptor, ...args) => {
        if (failure === 'copy' && descriptor === sourceDescriptor) {
          throw new Error(`cannot copy ${harness.sourcePath}`);
        }
        return fs.readSync(descriptor, ...args);
      };

      await assert.rejects(
        () => analyzeSourceAudio({ ...harness.ctx, fs: fsApi }, validInput(harness.sourceAsset.id)),
        (error) => error.code === 'SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED'
          && error.message === 'SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED'
          && !error.message.includes(harness.sourcePath),
      );

      assert.equal(harness.execCalls.length, 0);
      assert.equal(harness.workerCalls.length, 0);
      assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
      assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
    });
  }
});

test('analyzeSourceAudio rejects a source path swapped to a junction immediately before open', async (t) => {
  const harness = createHarness(t);
  const sourceDirectory = path.dirname(harness.sourcePath);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audio-open-race-'));
  fs.writeFileSync(path.join(externalRoot, path.basename(harness.sourcePath)), 'raced-source-video');
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const fsApi = Object.create(fs);
  let swapped = false;
  fsApi.openSync = (target, flags, mode) => {
    if (!swapped && path.resolve(target) === path.resolve(harness.sourcePath) && flags === 'r') {
      swapped = true;
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
      fs.symlinkSync(externalRoot, sourceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return fs.openSync(target, flags, mode);
  };

  await assert.rejects(
    () => analyzeSourceAudio({ ...harness.ctx, fs: fsApi }, validInput(harness.sourceAsset.id)),
    (error) => error.code === 'SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED'
      && error.message === 'SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED'
      && !error.message.includes(harness.sourcePath),
  );

  assert.equal(swapped, true);
  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.workerCalls.length, 0);
  assert.equal(harness.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_audio_evidence'").get().count, 0);
  assert.deepEqual(fs.readdirSync(harness.privateAudioRoot), []);
});
