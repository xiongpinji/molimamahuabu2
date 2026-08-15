const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  detectFrames,
  safeWorkerEnv,
} = require('../src/services/redrawFullFrameDetectorProcess');
const {
  parseArgs,
  resolveOfficialComponent,
  venvPython,
  runProcess,
  runFetchModels,
} = require('../scripts/fetch-redraw-full-frame-models-local');

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFakeWorker(t, mode = 'ok') {
  const root = tempDir(t, 'redraw-worker-');
  const src = path.join(root, 'src', 'redraw_full_frame_auditor');
  fs.mkdirSync(src, { recursive: true });
  const capturePath = path.join(root, 'capture.json');
  fs.writeFileSync(path.join(src, 'worker.py'), `
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
const capture = ${JSON.stringify(capturePath)};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const lines = input.split(/\\r?\\n/).filter(Boolean);
  fs.writeFileSync(capture, JSON.stringify({ env: Object.keys(process.env).sort(), stdin: lines }));
  if (mode === 'timeout') return setTimeout(() => {}, 5000);
  if (mode === 'nonzero') { process.stderr.write('C:/secret/model-lock.json'); process.exit(7); }
  if (mode === 'invalid-json') { process.stdout.write('{bad\\n'); return; }
  if (mode === 'huge-stderr') { process.stderr.write('x'.repeat(1024 * 1024 + 1)); process.exit(1); }
  if (mode === 'huge-stdout') { process.stdout.write('x'.repeat(256 * 1024 * 1024 + 1)); return; }
  if (mode === 'extra') {
    for (const line of lines) {
      const frame = JSON.parse(line);
      process.stdout.write(JSON.stringify({ frame_index: frame.frame_index, persons: [], faces: [], texts: [] }) + '\\n');
    }
    process.stdout.write(JSON.stringify({ frame_index: 999, persons: [], faces: [], texts: [] }) + '\\n');
    return;
  }
  if (mode === 'duplicate') {
    const frame = JSON.parse(lines[0]);
    const out = JSON.stringify({ frame_index: frame.frame_index, persons: [], faces: [], texts: [] }) + '\\n';
    process.stdout.write(out + out);
    return;
  }
  if (mode === 'missing') {
    const frame = JSON.parse(lines[0]);
    process.stdout.write(JSON.stringify({ frame_index: frame.frame_index, persons: [], faces: [], texts: [] }) + '\\n');
    return;
  }
  for (const line of lines.reverse()) {
    const frame = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      frame_index: frame.frame_index,
      persons: [{ candidate_id: 'person_1', track_key: 'track_1', kind: 'person_candidate', bbox: { x: 1, y: 2, width: 3, height: 4 }, confidence: 0.9 }],
      faces: [],
      texts: []
    }) + '\\n');
  }
});
`, 'utf8');
  return { root, capturePath };
}

async function assertUnavailable(promise, secretPattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE');
    assert.equal(error.message, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE');
    assert.equal(error.cause, undefined);
    const serialized = JSON.stringify(error);
    assert.doesNotMatch(serialized, secretPattern);
    assert.doesNotMatch(serialized, /C:\\|C:\//);
    return true;
  });
}

test('safeWorkerEnv keeps only the allowlist and fixed Python UTF-8 setting', () => {
  const previous = { ...process.env };
  process.env.PATH = 'path-value';
  process.env.SystemRoot = 'system-root';
  process.env.WINDIR = 'windir';
  process.env.TEMP = 'temp';
  process.env.TMP = 'tmp';
  process.env.OPENAI_API_KEY = 'secret';
  process.env.AUTHORIZATION = 'Bearer secret';
  process.env.HOME = 'home';
  process.env.CODEX_HOME = 'codex';
  process.env.PYTHONPATH = 'pythonpath';
  try {
    assert.deepEqual(safeWorkerEnv(), {
      PATH: 'path-value',
      SystemRoot: 'system-root',
      WINDIR: 'windir',
      TEMP: 'temp',
      TMP: 'tmp',
      PYTHONUTF8: '1',
    });
  } finally {
    process.env = previous;
  }
});

test('detectFrames sends sorted JSONL, returns sorted sanitized detections, and uses safe env', async (t) => {
  const previousPython = process.env.REDRAW_AUDITOR_PYTHON;
  delete process.env.REDRAW_AUDITOR_PYTHON;
  process.env.OPENAI_API_KEY = 'secret';
  t.after(() => {
    delete process.env.OPENAI_API_KEY;
    if (previousPython !== undefined) process.env.REDRAW_AUDITOR_PYTHON = previousPython;
  });
  const { root, capturePath } = writeFakeWorker(t);
  const modelLockPath = path.join(root, 'model-lock.json');
  fs.writeFileSync(modelLockPath, '{}');

  const results = await detectFrames({
    pythonPath: process.execPath,
    workerRoot: root,
    modelLockPath,
    timeoutMs: 3000,
    frames: [
      { frame_index: 2, timestamp_ms: 20, frame_path: 'C:/secret/frame2.png' },
      { frame_index: 1, timestamp_ms: 10, frame_path: 'C:/secret/frame1.png' },
    ],
  });

  assert.deepEqual(results.map((item) => item.frame_index), [1, 2]);
  assert.equal(results[0].persons[0].kind, 'person_candidate');
  assert.doesNotMatch(JSON.stringify(results), /secret|frame_path|C:\//);
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.deepEqual(capture.stdin.map((line) => JSON.parse(line).frame_index), [1, 2]);
  assert.match(capture.stdin[0], /frame_path/);
  assert(!capture.env.includes('OPENAI_API_KEY'));
  assert(!capture.env.includes('PYTHONPATH'));
  assert(capture.env.includes('PYTHONUTF8'));
});

test('detectFrames rejects invalid inputs and child protocol failures with a stable sanitized error', async (t) => {
  const { root } = writeFakeWorker(t);
  const common = {
    pythonPath: process.execPath,
    workerRoot: root,
    modelLockPath: path.join(root, 'model-lock.json'),
    frames: [{ frame_index: 1, timestamp_ms: 10, frame_path: 'C:/secret/frame.png' }],
    timeoutMs: 1000,
  };
  await assertUnavailable(detectFrames({ ...common, frames: [] }), /secret|model-lock|redraw-worker/);
  await assertUnavailable(detectFrames({ ...common, frames: [{ ...common.frames[0], extra: true }] }), /secret|model-lock|redraw-worker/);
  await assertUnavailable(detectFrames({ ...common, frames: [common.frames[0], common.frames[0]] }), /secret|model-lock|redraw-worker/);

  for (const mode of ['timeout', 'nonzero', 'invalid-json', 'extra', 'duplicate', 'missing', 'huge-stderr', 'huge-stdout']) {
    const fake = writeFakeWorker(t, mode);
    fs.writeFileSync(path.join(fake.root, 'model-lock.json'), '{}');
    const frames = mode === 'missing'
      ? [common.frames[0], { frame_index: 2, timestamp_ms: 20, frame_path: 'C:/secret/frame2.png' }]
      : common.frames;
    await assertUnavailable(detectFrames({
      ...common,
      workerRoot: fake.root,
      modelLockPath: path.join(fake.root, 'model-lock.json'),
      frames,
      timeoutMs: mode === 'timeout' ? 50 : 1000,
    }), /secret|model-lock|redraw-worker/);
  }
  await assertUnavailable(detectFrames({
    ...common,
    frames: Array.from({ length: 100001 }, (_, index) => ({ frame_index: index, timestamp_ms: index, frame_path: `C:/secret/${index}.png` })),
  }), /secret|model-lock|redraw-worker/);
});

test('fetch model CLI args only accept help or an output directory', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs(['--output-dir', 'cache']), { outputDir: 'cache' });
  for (const argv of [
    [],
    ['--output-dir'],
    ['--output-dir', 'a', '--output-dir', 'b'],
    ['--url', 'https://example.test'],
    ['--approved'],
    ['--output-dir', 'https://secret.example/cache'],
    ['--output-dir', 'file:///C:/secret/cache'],
    ['--output-dir', 'cache?api_key=secret'],
    ['--output-dir', 'cache?authorization=Bearer-secret'],
    ['--output-dir', 'cache?access-token=secret'],
    ['--output-dir', 'cache?client_secret=secret'],
    ['--output-dir', 'bad\u0000path'],
  ]) {
    assert.throws(() => parseArgs(argv), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  }
  assert.deepEqual(parseArgs(['--output-dir', 'C:\\local\\cache']), { outputDir: 'C:\\local\\cache' });
});

test('runFetchModels builds a fixture cache, validates lock, and leaves no final directory on failure', async (t) => {
  const parent = tempDir(t, 'redraw-model-fetch-');
  const outputDir = path.join(parent, 'cache');
  const calls = [];
  const deps = {
    randomHex: () => 'abc123',
    fetchComponent: async (source) => {
      calls.push(source.component);
      return {
        revision: `fixed-${source.component}-20260815`,
        artifact_name: `${source.component}.bin`,
        artifact_bytes: Buffer.from(`${source.component}:artifact`),
        license_name: `${source.component}.license`,
        license_bytes: Buffer.from(`${source.component}:license`),
      };
    },
    createVenv: async () => calls.push('venv'),
    installRuntime: async () => calls.push('install'),
    pipFreeze: async () => ['a-package==1.2.3', 'b-package==4.5.6'],
    bootstrapWorker: async () => calls.push('bootstrap'),
    pythonVersion: async () => 'Python 3.11.9',
  };

  const result = await runFetchModels({ outputDir }, deps);

  assert.deepEqual(result.components, ['face_detector', 'person_detector', 'text_detector', 'tracker']);
  assert.match(result.canonical_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.runtime_lock, 'runtime/pip-freeze.txt');
  assert(fs.existsSync(path.join(outputDir, 'model-lock.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(outputDir, 'model-lock.json'), 'utf8'));
  assert.equal(lock.schema_version, 'redraw-full-frame-model-lock-v1');
  assert.deepEqual(lock.runtime.pip_freeze, ['a-package==1.2.3', 'b-package==4.5.6']);
  for (const component of lock.components) {
    assert.equal(
      component.artifact_sha256,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(outputDir, component.artifact_path))).digest('hex'),
    );
    assert.equal(
      component.license_evidence_sha256,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(outputDir, component.license_evidence_path))).digest('hex'),
    );
  }

  const occupied = path.join(parent, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'keep');
  await assert.rejects(runFetchModels({ outputDir: occupied }, deps), /REDRAW_FULL_FRAME_OUTPUT_INVALID/);
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'keep');

  const failed = path.join(parent, 'failed');
  await assert.rejects(runFetchModels({
    outputDir: failed,
  }, { ...deps, fetchComponent: async () => { throw new Error('https://secret.example/model'); } }), /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/);
  assert.equal(fs.existsSync(failed), false);
});

test('default fetch path resolves official HTTPS catalog without unconditional stubs', async () => {
  const calls = [];
  const deps = {
    requestJson: async (url) => {
      calls.push(['json', url]);
      assert.match(url, /^https:\/\/api\.github\.com\//);
      if (url.includes('/commits/')) return { sha: '0123456789abcdef0123456789abcdef01234567' };
      return {
        tag_name: 'v1.2.3',
        target_commitish: 'main',
        assets: [{ name: 'yolox_s.pth', browser_download_url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/v0.3.0/yolox_s.pth' }],
      };
    },
    requestBytes: async (url) => {
      calls.push(['bytes', url]);
      assert.match(url, /^https:\/\//);
      return Buffer.from(url.includes('LICENSE') ? 'license-bytes' : 'artifact-bytes');
    },
  };

  const evidence = await resolveOfficialComponent({
    component: 'person_detector',
    project: 'YOLOX',
    repository: 'Megvii-BaseDetection/YOLOX',
    license_path: 'LICENSE',
  }, deps);

  assert.equal(evidence.revision, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(evidence.artifact_name, 'yolox_s.pth');
  assert(Buffer.isBuffer(evidence.artifact_bytes));
  assert(Buffer.isBuffer(evidence.license_bytes));
  assert.deepEqual(calls.map((call) => call[0]), ['json', 'json', 'bytes', 'bytes']);
  await assert.rejects(resolveOfficialComponent({
    component: 'person_detector',
    project: 'YOLOX',
    repository: 'Megvii-BaseDetection/YOLOX',
    license_path: 'LICENSE',
  }, { ...deps, requestJson: async (url) => (url.includes('/commits/') ? { sha: 'main' } : { tag_name: 'v1.2.3', assets: [{ name: 'yolox_s.pth', browser_download_url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/v0.3.0/yolox_s.pth' }] }) }), /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/);
});

test('default runtime helpers use safe argv spawn contracts and reject non-exact freeze lines', async (t) => {
  const calls = [];
  const deps = {
    spawnProcess: async (command, args, options) => {
      calls.push({ command, args, env: options.env, cwd: options.cwd });
      if (args.includes('freeze')) return 'pkg==1.0.0\n';
      if (args.includes('--version')) return 'Python 3.11.9\n';
      return '';
    },
    env: { REDRAW_AUDITOR_PYTHON: 'python-fixture', OPENAI_API_KEY: 'secret', PATH: 'path' },
  };
  const parent = tempDir(t, 'redraw-runtime-');
  const fetchModule = require('../scripts/fetch-redraw-full-frame-models-local');
  const expectedPython = venvPython(parent);

  await fetchModule.createVenv(parent, deps);
  await fetchModule.installRuntime(parent, [], deps);
  assert.deepEqual(await fetchModule.pipFreeze(parent, deps), ['pkg==1.0.0']);
  assert.equal(await fetchModule.pythonVersion(parent, deps), 'Python 3.11.9');
  await fetchModule.bootstrapWorker(parent, path.join(parent, 'model-lock.json'), deps);
  assert.equal(calls[0].command, 'python-fixture');
  assert(calls.slice(1).every((call) => call.command === expectedPython), JSON.stringify(calls));
  assert(calls.every((call) => Array.isArray(call.args)));
  assert(calls.every((call) => call.env.PYTHONUTF8 === '1'));
  assert(calls.every((call) => !Object.prototype.hasOwnProperty.call(call.env, 'OPENAI_API_KEY')));
  const installArgs = calls
    .filter((call) => call.args.includes('install'))
    .flatMap((call) => call.args)
    .filter((arg) => /^[A-Za-z0-9_.-]+[<>=!~]/.test(arg));
  assert(installArgs.includes('numpy==1.26.4'));
  assert(installArgs.includes('opencv-python-headless==4.10.0.84'));
  assert(installArgs.includes('torch==2.3.1'));
  assert(installArgs.includes('mediapipe==0.10.14'));
  assert(installArgs.includes('paddlepaddle==2.6.2'));
  assert(installArgs.includes('paddleocr==2.8.1'));
  assert(installArgs.every((arg) => /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.!+-]+$/.test(arg)));

  await assert.rejects(
    fetchModule.pipFreeze(parent, { ...deps, spawnProcess: async () => 'pkg>=1.0.0\n' }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
});

test('runProcess consumes stderr, enforces limits, timeout, and settles once', async (t) => {
  const script = path.join(tempDir(t, 'redraw-run-process-'), 'child.js');
  fs.writeFileSync(script, `
const mode = process.argv[2];
if (mode === 'stderr') { process.stderr.write('x'.repeat(1024 * 1024 + 1)); }
else if (mode === 'timeout') { setTimeout(() => {}, 5000); }
else { process.stderr.write('warn'); process.stdout.write('ok'); }
`, 'utf8');
  assert.equal(await runProcess(process.execPath, [script, 'ok'], { timeoutMs: 1000 }), 'ok');
  await assert.rejects(runProcess(process.execPath, [script, 'stderr'], { timeoutMs: 1000 }), /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/);
  await assert.rejects(runProcess(process.execPath, [script, 'timeout'], { timeoutMs: 50 }), /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/);
});
