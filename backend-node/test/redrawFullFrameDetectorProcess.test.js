const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  detectFrames,
  safeWorkerEnv,
} = require('../src/services/redrawFullFrameDetectorProcess');
const {
  assertPinnedFreeze,
  assertAllowedUrl,
  parseArgs,
  resolveOfficialComponent,
  venvPython,
  runProcess,
  runFetchModels,
  runCli,
  installRuntime,
} = require('../scripts/fetch-redraw-full-frame-models-local');

const EXPECTED_RUNTIME_PACKAGE_SPECS = [
  { requirement: 'setuptools==80.9.0' },
  { requirement: 'wheel==0.43.0' },
  { requirement: 'numpy==1.26.4' },
  { requirement: 'protobuf==4.25.9' },
  { requirement: 'Pillow==11.3.0' },
  { requirement: 'six==1.17.0' },
  { requirement: 'scipy==1.17.1' },
  { requirement: 'imageio==2.37.4' },
  { requirement: 'tifffile==2026.3.3' },
  { requirement: 'scikit-image==0.26.0' },
  { requirement: 'Shapely==2.1.2' },
  { requirement: 'pyclipper==1.4.0' },
  { requirement: 'lmdb==2.3.0' },
  { requirement: 'tqdm==4.68.1' },
  { requirement: 'requests==2.33.0' },
  { requirement: 'absl-py==2.5.0' },
  { requirement: 'attrs==26.1.0' },
  { requirement: 'flatbuffers==25.12.19' },
  { requirement: 'matplotlib==3.11.1' },
  { requirement: 'sounddevice==0.5.5' },
  { requirement: 'httpx==0.27.0' },
  { requirement: 'decorator==5.3.1' },
  { requirement: 'astor==0.8.1' },
  { requirement: 'opt-einsum==3.3.0' },
  { requirement: 'opencv-python-headless==4.10.0.84' },
  { requirement: 'torch==2.3.1' },
  { requirement: 'torchvision==0.18.1' },
  { requirement: 'yolox==0.3.0', noDeps: true },
  { requirement: 'pycocotools==2.0.11' },
  { requirement: 'loguru==0.7.2' },
  { requirement: 'tabulate==0.9.0' },
  { requirement: 'thop==0.1.1.post2209072238' },
  { requirement: 'lap==0.5.13' },
  { requirement: 'Cython==3.2.9' },
  { requirement: 'cython-bbox==0.1.5' },
  { requirement: 'imgaug==0.4.0', noDeps: true },
  { requirement: 'mediapipe==0.10.14', noDeps: true },
  { requirement: 'paddlepaddle==2.6.2', noDeps: true },
  { requirement: 'beautifulsoup4==4.15.0' },
  { requirement: 'fire==0.7.1' },
  { requirement: 'lxml==6.1.1' },
  { requirement: 'python-docx==1.2.0' },
  { requirement: 'PyYAML==6.0.3' },
  { requirement: 'RapidFuzz==3.14.5' },
  { requirement: 'soupsieve==2.9.2' },
  { requirement: 'termcolor==3.3.0' },
  { requirement: 'paddleocr==2.8.1', noDeps: true },
];
const EXPECTED_RUNTIME_FREEZE = EXPECTED_RUNTIME_PACKAGE_SPECS.map((spec) => spec.requirement);
const ALLOWED_RUNTIME_TRANSITIVE_FREEZE = [
  'anyio==4.14.2',
  'certifi==2026.7.22',
  'cffi==2.1.1',
  'charset-normalizer==3.5.1',
  'colorama==0.4.6',
  'contourpy==1.3.3',
  'cycler==0.12.1',
  'filelock==3.32.3',
  'fonttools==4.63.0',
  'fsspec==2026.7.0',
  'h11==0.16.0',
  'httpcore==1.0.9',
  'idna==3.18',
  'intel-openmp==2021.4.0',
  'Jinja2==3.1.6',
  'kiwisolver==1.5.0',
  'lazy-loader==0.5',
  'MarkupSafe==3.0.3',
  'mkl==2021.4.0',
  'mpmath==1.3.0',
  'networkx==3.6.1',
  'packaging==26.3',
  'pycparser==3.0',
  'pyparsing==3.3.2',
  'python-dateutil==2.9.0.post0',
  'sniffio==1.3.1',
  'sympy==1.14.0',
  'tbb==2021.13.1',
  'typing-extensions==4.16.0',
  'urllib3==2.7.0',
  'win32-setctime==1.2.0',
];
const WINDOWS_ONLY_RUNTIME_TRANSITIVE_NAMES = new Set([
  'colorama',
  'intel-openmp',
  'mkl',
  'tbb',
  'win32-setctime',
]);
const CROSS_PLATFORM_RUNTIME_TRANSITIVE_FREEZE = ALLOWED_RUNTIME_TRANSITIVE_FREEZE.filter((requirement) => (
  !WINDOWS_ONLY_RUNTIME_TRANSITIVE_NAMES.has(requirement.split('==')[0].toLowerCase().replace(/[-_.]+/g, '-'))
));
const EXPECTED_RUNTIME_FREEZE_WITH_TRANSITIVES = [
  ...EXPECTED_RUNTIME_FREEZE,
  ...(process.platform === 'win32' ? ALLOWED_RUNTIME_TRANSITIVE_FREEZE : CROSS_PLATFORM_RUNTIME_TRANSITIVE_FREEZE),
];
const FORBIDDEN_RUNTIME_PACKAGES = new Set([
  'opencv-python',
  'opencv-contrib-python',
  'jax',
  'jaxlib',
  'ml-dtypes',
]);

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
if (mode === 'instant-exit') process.exit(7);
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

function assertStableFetchError(error, expectedStage) {
  assert.equal(error.code, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE');
  assert.equal(error.message, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE');
  assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(error.stage, expectedStage);
  assert.equal(Object.getOwnPropertyDescriptor(error, 'stage').enumerable, false);
  assert.equal(error.cause, undefined);
  assert.equal(error.context, undefined);
  assert.doesNotMatch(
    JSON.stringify(error),
    /private|Authorization|secret-token|secret-key|model-lock|worker\.py|paddleocr\.py/i,
  );
  return true;
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

test('detectFrames sanitizes EPIPE when worker exits while frames are being written', async (t) => {
  const fake = writeFakeWorker(t, 'instant-exit');
  const modelLockPath = path.join(fake.root, 'model-lock.json');
  fs.writeFileSync(modelLockPath, '{}');
  const uncaught = [];
  const unhandled = [];
  const onUncaught = (error) => {
    uncaught.push(error);
  };
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onUnhandled);
  });

  await assertUnavailable(detectFrames({
    pythonPath: process.execPath,
    workerRoot: fake.root,
    modelLockPath,
    timeoutMs: 3000,
    frames: Array.from({ length: 50000 }, (_, index) => ({
      frame_index: index,
      timestamp_ms: index,
      frame_path: `C:/secret/frame-${index}.png`,
    })),
  }), /secret|model-lock|redraw-worker/);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(uncaught, []);
  assert.deepEqual(unhandled, []);
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

test('model artifact URL validator keeps only the official model source hosts', () => {
  for (const url of [
    'https://api.github.com/repos/Megvii-BaseDetection/YOLOX/commits/e1052df71842031413f6030723c3607b839c80ce',
    'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.pth',
    'https://codeload.github.com/FoundationVision/ByteTrack/zip/d1bf0191adff59bc8fcfeaa0b33d3d1642552a99',
    'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/40c56628fda416e1c8710eb19e4b260536902520/LICENSE',
    'https://release-assets.githubusercontent.com/github-production-release-asset/example',
    'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    'https://paddleocr.bj.bcebos.com/PP-OCRv3/english/en_PP-OCRv3_det_infer.tar',
  ]) {
    assert.equal(assertAllowedUrl(url).protocol, 'https:');
  }

  for (const url of [
    'https://pypi.org/simple/paddleocr/',
    'https://files.pythonhosted.org/packages/example.whl',
    'http://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.pth',
    'https://example.com/model.bin',
  ]) {
    assert.throws(() => assertAllowedUrl(url), /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/);
  }
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
    pipFreeze: async () => EXPECTED_RUNTIME_FREEZE_WITH_TRANSITIVES,
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
  assert.deepEqual(
    lock.runtime.pip_freeze,
    EXPECTED_RUNTIME_FREEZE_WITH_TRANSITIVES.slice().sort((a, b) => a.localeCompare(b)),
  );
  const frozenPackages = new Map(lock.runtime.pip_freeze.map((line) => {
    const [name, version] = line.split('==');
    return [name.toLowerCase().replace(/[-_.]+/g, '-'), version];
  }));
  for (const requirement of EXPECTED_RUNTIME_FREEZE) {
    const [name, version] = requirement.split('==');
    assert.equal(frozenPackages.get(name.toLowerCase().replace(/[-_.]+/g, '-')), version);
  }
  for (const forbidden of FORBIDDEN_RUNTIME_PACKAGES) assert.equal(frozenPackages.has(forbidden), false);
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
  }, { ...deps, fetchComponent: async () => { throw new Error('https://secret.example/model'); } }), (error) => (
    assertStableFetchError(error, 'fetch:face_detector')
  ));
  assert.equal(fs.existsSync(failed), false);

  const bootstrapFailed = path.join(parent, 'bootstrap-failed');
  const rawBootstrapError = new Error('C:\\Users\\private\\model-lock.json Authorization: Bearer secret-token Key=secret-key');
  rawBootstrapError.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
  rawBootstrapError.cause = new Error('C:\\Users\\private\\worker.py');
  rawBootstrapError.context = { authorization: 'Bearer secret-token', key: 'secret-key' };
  rawBootstrapError.stage = 'bootstrap:C:\\Users\\private\\worker.py';
  await assert.rejects(runFetchModels({
    outputDir: bootstrapFailed,
  }, {
    ...deps,
    randomHex: () => 'bootstrap123',
    bootstrapWorker: async () => { throw rawBootstrapError; },
  }), (error) => assertStableFetchError(error, 'bootstrap'));
  assert.equal(fs.existsSync(bootstrapFailed), false);
  assert.deepEqual(
    fs.readdirSync(parent).filter((entry) => entry.startsWith('.redraw-full-frame-staging-')),
    [],
  );
});

test('runCli emits only stable sanitized install and bootstrap stages', async (t) => {
  const parent = tempDir(t, 'redraw-model-cli-stage-');
  const originalGet = https.get;
  https.get = () => { throw new Error('network must not be reached'); };
  t.after(() => { https.get = originalGet; });

  const privateFailure = (fileName) => {
    const raw = new Error(`C:\\Users\\private\\${fileName} Authorization: Bearer secret-token Key=secret-key`);
    raw.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
    raw.cause = new Error(`C:\\Users\\private\\${fileName}`);
    raw.context = { authorization: 'Bearer secret-token', key: 'secret-key' };
    raw.stage = `install:C:\\Users\\private\\${fileName}`;
    return raw;
  };
  const fixtureDeps = {
    randomHex: () => 'cli-stage',
    fetchComponent: async (source) => ({
      revision: `fixed-${source.component}-20260816`,
      artifact_name: `${source.component}.bin`,
      artifact_bytes: Buffer.from(`${source.component}:artifact`),
      license_name: `${source.component}.license`,
      license_bytes: Buffer.from(`${source.component}:license`),
    }),
    createVenv: async () => {},
    pipFreeze: async () => EXPECTED_RUNTIME_FREEZE_WITH_TRANSITIVES,
    pythonVersion: async () => 'Python 3.11.9',
    bootstrapWorker: async () => {},
  };
  const capture = async (argv, injectedDeps) => {
    let stderr = '';
    const stderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
    try {
      return { code: await runCli(argv, injectedDeps), stderr };
    } finally {
      process.stderr.write = stderrWrite;
    }
  };

  const installResult = await capture(['--output-dir', path.join(parent, 'install-failed')], {
    ...fixtureDeps,
    installRuntime: async (staging, components) => installRuntime(staging, components, {
      spawnProcess: async (_command, args) => {
        if (args[args.length - 1] === 'paddleocr==2.8.1') throw privateFailure('paddleocr.py');
        return '';
      },
      env: { PATH: 'path' },
    }),
  });
  assert.deepEqual(installResult, {
    code: 1,
    stderr: 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=install:paddleocr\n',
  });

  const bootstrapResult = await capture(['--output-dir', path.join(parent, 'bootstrap-failed')], {
    ...fixtureDeps,
    installRuntime: async () => {},
    bootstrapWorker: async () => { throw privateFailure('worker.py'); },
  });
  assert.deepEqual(bootstrapResult, {
    code: 1,
    stderr: 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=bootstrap\n',
  });

  const unknownResult = await capture(['--url', 'https://secret.example/model'], fixtureDeps);
  assert.deepEqual(unknownResult, {
    code: 1,
    stderr: 'REDRAW_FULL_FRAME_OUTPUT_INVALID stage=unknown\n',
  });
  assert.doesNotMatch(
    `${installResult.stderr}${bootstrapResult.stderr}${unknownResult.stderr}`,
    /private|Authorization|secret-token|secret-key|worker\.py|paddleocr\.py|https?:/i,
  );
  assert.deepEqual(
    fs.readdirSync(parent).filter((entry) => entry.startsWith('.redraw-full-frame-staging-')),
    [],
  );
});

test('default fetch path resolves four fixed official sources from exact revisions and artifact URLs', async () => {
  const expected = {
    face_detector: {
      repository: 'google-ai-edge/mediapipe',
      revision: '4cf89a70942ca3252e46ace7e4552f53be9bef2e',
      artifactName: 'blaze_face_short_range.tflite',
      artifactUrl: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    },
    person_detector: {
      repository: 'Megvii-BaseDetection/YOLOX',
      revision: 'e1052df71842031413f6030723c3607b839c80ce',
      artifactName: 'yolox_s.pth',
      artifactUrl: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.pth',
    },
    text_detector: {
      repository: 'PaddlePaddle/PaddleOCR',
      revision: '40c56628fda416e1c8710eb19e4b260536902520',
      artifactName: 'en_PP-OCRv3_det_infer.tar',
      artifactUrl: 'https://paddleocr.bj.bcebos.com/PP-OCRv3/english/en_PP-OCRv3_det_infer.tar',
    },
    tracker: {
      repository: 'FoundationVision/ByteTrack',
      revision: 'd1bf0191adff59bc8fcfeaa0b33d3d1642552a99',
      artifactName: 'bytetrack-source.zip',
      artifactUrl: 'https://codeload.github.com/FoundationVision/ByteTrack/zip/d1bf0191adff59bc8fcfeaa0b33d3d1642552a99',
    },
  };
  const calls = [];
  const deps = {
    requestJson: async (url) => {
      calls.push(['json', url]);
      const entry = Object.values(expected).find((item) => url === `https://api.github.com/repos/${item.repository}/commits/${item.revision}`);
      assert(entry, `unexpected JSON request: ${url}`);
      return { sha: entry.revision };
    },
    requestBytes: async (url) => {
      calls.push(['bytes', url]);
      const entry = Object.values(expected).find((item) => item.artifactUrl === url || url === `https://raw.githubusercontent.com/${item.repository}/${item.revision}/LICENSE`);
      assert(entry, `unexpected bytes request: ${url}`);
      return Buffer.from(url.includes('/LICENSE') ? `${entry.repository}:license` : `${entry.repository}:artifact`);
    },
  };

  for (const source of [
    { component: 'face_detector', project: 'MediaPipe face detection', repository: 'google-ai-edge/mediapipe', license_path: 'LICENSE' },
    { component: 'person_detector', project: 'YOLOX', repository: 'Megvii-BaseDetection/YOLOX', license_path: 'LICENSE' },
    { component: 'text_detector', project: 'PaddleOCR', repository: 'PaddlePaddle/PaddleOCR', license_path: 'LICENSE' },
    { component: 'tracker', project: 'ByteTrack', repository: 'FoundationVision/ByteTrack', license_path: 'LICENSE' },
  ]) {
    const evidence = await resolveOfficialComponent(source, deps);
    assert.equal(evidence.revision, expected[source.component].revision);
    assert.equal(evidence.artifact_name, expected[source.component].artifactName);
    assert(Buffer.isBuffer(evidence.artifact_bytes));
    assert(Buffer.isBuffer(evidence.license_bytes));
  }

  assert.equal(calls.filter((call) => call[0] === 'json').length, 4);
  assert.equal(calls.filter((call) => call[0] === 'bytes').length, 8);
  assert(calls.every((call) => !call[1].includes('/releases/tags/')), JSON.stringify(calls));
  assert(calls.some((call) => call[1] === 'https://release-assets.githubusercontent.com/injected.bin') === false);
});

test('default fetch path rejects official revision drift and injected artifact URLs', async () => {
  const source = {
    component: 'person_detector',
    project: 'YOLOX',
    repository: 'Megvii-BaseDetection/YOLOX',
    license_path: 'LICENSE',
  };
  await assert.rejects(resolveOfficialComponent(source, {
    requestJson: async () => ({ sha: '0'.repeat(40) }),
    requestBytes: async () => Buffer.from('must-not-download'),
  }), /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/);

  const bytesCalls = [];
  const evidence = await resolveOfficialComponent(source, {
    requestJson: async (url) => {
      if (url.endsWith('/e1052df71842031413f6030723c3607b839c80ce')) {
        return { sha: 'e1052df71842031413f6030723c3607b839c80ce' };
      }
      return {
        tag_name: '0.1.1rc0',
        assets: [{ name: 'yolox_s.pth', browser_download_url: 'https://release-assets.githubusercontent.com/injected.bin' }],
      };
    },
    requestBytes: async (url) => {
      bytesCalls.push(url);
      if (url === 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.pth') return Buffer.from('official-artifact');
      if (url === 'https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/e1052df71842031413f6030723c3607b839c80ce/LICENSE') return Buffer.from('license');
      throw new Error(`injected URL was used: ${url}`);
    },
  });
  assert.equal(evidence.revision, 'e1052df71842031413f6030723c3607b839c80ce');
  assert.deepEqual(bytesCalls, [
    'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.pth',
    'https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/e1052df71842031413f6030723c3607b839c80ce/LICENSE',
  ]);
});

test('default runtime helpers use safe argv spawn contracts and reject non-exact freeze lines', async (t) => {
  const calls = [];
  const deps = {
    spawnProcess: async (command, args, options) => {
      calls.push({ command, args, env: options.env, cwd: options.cwd });
      if (args.includes('freeze')) return `${EXPECTED_RUNTIME_FREEZE_WITH_TRANSITIVES.join('\n')}\n`;
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
  assert.equal(EXPECTED_RUNTIME_PACKAGE_SPECS.length, 47);
  assert.equal(ALLOWED_RUNTIME_TRANSITIVE_FREEZE.length, 31);
  const directNames = EXPECTED_RUNTIME_FREEZE.map((requirement) => (
    requirement.split('==')[0].toLowerCase().replace(/[-_.]+/g, '-')
  ));
  const transitiveNames = ALLOWED_RUNTIME_TRANSITIVE_FREEZE.map((requirement) => (
    requirement.split('==')[0].toLowerCase().replace(/[-_.]+/g, '-')
  ));
  assert.equal(new Set(directNames).size, directNames.length);
  assert.equal(new Set(transitiveNames).size, transitiveNames.length);
  assert.deepEqual(directNames.filter((name) => new Set(transitiveNames).has(name)), []);
  assert.deepEqual(
    await fetchModule.pipFreeze(parent, deps),
    EXPECTED_RUNTIME_FREEZE_WITH_TRANSITIVES.slice().sort((a, b) => a.localeCompare(b)),
  );
  assert.deepEqual(
    assertPinnedFreeze([...EXPECTED_RUNTIME_FREEZE, ...CROSS_PLATFORM_RUNTIME_TRANSITIVE_FREEZE], 'linux'),
    [...EXPECTED_RUNTIME_FREEZE, ...CROSS_PLATFORM_RUNTIME_TRANSITIVE_FREEZE].sort((a, b) => a.localeCompare(b)),
  );
  for (const requirement of ALLOWED_RUNTIME_TRANSITIVE_FREEZE.filter((line) => (
    WINDOWS_ONLY_RUNTIME_TRANSITIVE_NAMES.has(line.split('==')[0].toLowerCase().replace(/[-_.]+/g, '-'))
  ))) {
    assert.throws(
      () => assertPinnedFreeze([...EXPECTED_RUNTIME_FREEZE, requirement], 'linux'),
      /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
    );
  }
  assert.doesNotThrow(() => assertPinnedFreeze(
    [...EXPECTED_RUNTIME_FREEZE, ...ALLOWED_RUNTIME_TRANSITIVE_FREEZE],
    'win32',
  ));
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
  const installCalls = calls.filter((call) => call.args.includes('install'));
  assert(installCalls.every((call) => {
    const index = call.args.indexOf('--index-url');
    const isolated = call.args.indexOf('--isolated');
    const install = call.args.indexOf('install');
    return index >= 0
      && call.args[index + 1] === 'https://pypi.org/simple'
      && isolated >= 0
      && isolated < install
      && !call.args.includes('--extra-index-url')
      && !call.args.includes('--find-links');
  }), JSON.stringify(installCalls));
  assert.deepEqual(installArgs, EXPECTED_RUNTIME_FREEZE);
  assert(installArgs.every((arg) => /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.!+-]+$/.test(arg)));
  assert.deepEqual(
    installCalls.map((call) => ({
      requirement: call.args[call.args.length - 1],
      noDeps: call.args.includes('--no-deps'),
    })),
    EXPECTED_RUNTIME_PACKAGE_SPECS.map((spec) => ({
      requirement: spec.requirement,
      noDeps: spec.noDeps === true,
    })),
  );
  assert.deepEqual(
    installCalls.filter((call) => call.args.includes('--no-deps')).map((call) => call.args[call.args.length - 1]),
    ['yolox==0.3.0', 'imgaug==0.4.0', 'mediapipe==0.10.14', 'paddlepaddle==2.6.2', 'paddleocr==2.8.1'],
  );
  assert(installArgs.every((requirement) => {
    const [name] = requirement.split('==');
    return !FORBIDDEN_RUNTIME_PACKAGES.has(name.toLowerCase().replace(/[-_.]+/g, '-'));
  }));

  await assert.rejects(
    fetchModule.pipFreeze(parent, { ...deps, spawnProcess: async () => 'pkg>=1.0.0\n' }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    fetchModule.installRuntime(parent, [], { ...deps, runtimePackageSpecs: [{ requirement: 'pkg>=1.0.0' }] }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    fetchModule.installRuntime(parent, [], { ...deps, runtimePackageSpecs: [{ requirement: 'pkg==1.0.0', unexpected: true }] }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    fetchModule.installRuntime(parent, [], { ...deps, runtimePackageSpecs: [{ requirement: 'pkg==1.0.0', noDeps: true }] }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  for (const requirement of ['yolox==0.3.0', 'imgaug==0.4.0', 'mediapipe==0.10.14', 'paddlepaddle==2.6.2', 'paddleocr==2.8.1']) {
    await assert.rejects(
      fetchModule.installRuntime(parent, [], { ...deps, runtimePackageSpecs: [{ requirement }] }),
      /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
    );
  }
  await assert.rejects(
    fetchModule.installRuntime(parent, [], { ...deps, runtimePackageSpecs: [{ requirement: 'paddleocr==2.8.2', noDeps: true }] }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  const rawInstallError = new Error('C:\\Users\\private\\paddleocr.py Authorization: Bearer secret-token Key=secret-key');
  rawInstallError.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
  rawInstallError.cause = new Error('C:\\Users\\private\\paddleocr.py');
  rawInstallError.context = { authorization: 'Bearer secret-token', key: 'secret-key' };
  rawInstallError.stage = 'install:C:\\Users\\private\\paddleocr.py';
  await assert.rejects(
    fetchModule.installRuntime(parent, [], {
      ...deps,
      spawnProcess: async (_command, args) => {
        if (args[args.length - 1] === 'paddleocr==2.8.1') throw rawInstallError;
        return '';
      },
    }),
    (error) => assertStableFetchError(error, 'install:paddleocr'),
  );
  for (const requirement of [
    'opencv-python==4.10.0.84',
    'opencv-contrib-python==4.10.0.84',
    'jax==0.4.30',
    'jaxlib==0.4.30',
    'ml-dtypes==0.4.0',
    'opencv--python==4.10.0.84',
    'opencv._-python==4.10.0.84',
    'ml--dtypes==0.4.0',
  ]) {
    await assert.rejects(
      fetchModule.installRuntime(parent, [], { ...deps, runtimePackageSpecs: [{ requirement }] }),
      /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
    );
  }
  await assert.rejects(
    fetchModule.pipFreeze(parent, {
      ...deps,
      spawnProcess: async () => `${EXPECTED_RUNTIME_FREEZE.join('\n')}\nopencv-python==4.10.0.84\n`,
    }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  for (const requirement of [
    'opencv--python==4.10.0.84',
    'opencv._-python==4.10.0.84',
    'ml--dtypes==0.4.0',
  ]) {
    await assert.rejects(
      fetchModule.pipFreeze(parent, {
        ...deps,
        spawnProcess: async () => `${EXPECTED_RUNTIME_FREEZE.join('\n')}\n${requirement}\n`,
      }),
      /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
    );
  }
  await assert.rejects(
    fetchModule.pipFreeze(parent, {
      ...deps,
      spawnProcess: async () => `${EXPECTED_RUNTIME_FREEZE.join('\n')}\nunapproved-extra-package==9.9.9\n`,
    }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  for (const requirement of [
    'anyio==999.0.0',
    'intel-openmp==999.0.0',
    'mkl==999.0.0',
    'win32-setctime==999.0.0',
  ]) {
    await assert.rejects(
      fetchModule.pipFreeze(parent, {
        ...deps,
        spawnProcess: async () => `${EXPECTED_RUNTIME_FREEZE.join('\n')}\n${requirement}\n`,
      }),
      /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
    );
  }
  await assert.rejects(
    fetchModule.pipFreeze(parent, {
      ...deps,
      spawnProcess: async () => `${EXPECTED_RUNTIME_FREEZE.join('\n')}\nNumPy==1.26.4\n`,
    }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    fetchModule.pipFreeze(parent, {
      ...deps,
      spawnProcess: async () => `${EXPECTED_RUNTIME_FREEZE.filter((line) => line !== 'protobuf==4.25.9').join('\n')}\n`,
    }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    fetchModule.pipFreeze(parent, {
      ...deps,
      spawnProcess: async () => `${EXPECTED_RUNTIME_FREEZE.map((line) => (
        line === 'protobuf==4.25.9' ? 'protobuf==4.25.8' : line
      )).join('\n')}\n`,
    }),
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
