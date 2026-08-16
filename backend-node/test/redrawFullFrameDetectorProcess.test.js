const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  bootstrapWorker,
  preflightRuntimePython,
} = require('../scripts/fetch-redraw-full-frame-models-local');

const WINDOWS_ONLY_RUNTIME_TRANSITIVE_NAMES = new Set([
  'colorama',
  'intel-openmp',
  'mkl',
  'tbb',
  'win32-setctime',
]);
const EXPECTED_MAIN_RUNTIME_PACKAGE_SPECS = [
  { requirement: 'setuptools==80.9.0' },
  { requirement: 'wheel==0.43.0' },
  { requirement: 'numpy==1.26.4' },
  { requirement: 'protobuf==4.25.9' },
  { requirement: 'Pillow==11.3.0' },
  { requirement: 'six==1.17.0' },
  { requirement: 'absl-py==2.5.0' },
  { requirement: 'attrs==26.1.0' },
  { requirement: 'flatbuffers==25.12.19' },
  { requirement: 'matplotlib==3.11.1' },
  { requirement: 'sounddevice==0.5.5' },
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
  { requirement: 'mediapipe==0.10.14', noDeps: true },
];
const EXPECTED_TEXT_RUNTIME_PACKAGE_SPECS = [
  { requirement: 'setuptools==80.9.0' },
  { requirement: 'wheel==0.43.0' },
  { requirement: 'numpy==1.26.4' },
  { requirement: 'protobuf==3.20.2' },
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
  { requirement: 'httpx==0.27.0' },
  { requirement: 'decorator==5.3.1' },
  { requirement: 'astor==0.8.1' },
  { requirement: 'opt-einsum==3.3.0' },
  { requirement: 'opencv-python-headless==4.10.0.84' },
  { requirement: 'imgaug==0.4.0', noDeps: true },
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
const EXPECTED_MAIN_RUNTIME_FREEZE = EXPECTED_MAIN_RUNTIME_PACKAGE_SPECS.map((spec) => spec.requirement);
const EXPECTED_TEXT_RUNTIME_FREEZE = EXPECTED_TEXT_RUNTIME_PACKAGE_SPECS.map((spec) => spec.requirement);
const EXPECTED_MAIN_RUNTIME_TRANSITIVE_FREEZE = [
  'cffi==2.1.1',
  'colorama==0.4.6',
  'contourpy==1.3.3',
  'cycler==0.12.1',
  'filelock==3.32.3',
  'fonttools==4.63.0',
  'fsspec==2026.7.0',
  'intel-openmp==2021.4.0',
  'Jinja2==3.1.6',
  'kiwisolver==1.5.0',
  'MarkupSafe==3.0.3',
  'mkl==2021.4.0',
  'mpmath==1.3.0',
  'networkx==3.6.1',
  'packaging==26.3',
  'pycparser==3.0',
  'pyparsing==3.3.2',
  'python-dateutil==2.9.0.post0',
  'sympy==1.14.0',
  'tbb==2021.13.1',
  'typing-extensions==4.16.0',
  'win32-setctime==1.2.0',
];
const EXPECTED_TEXT_RUNTIME_TRANSITIVE_FREEZE = [
  'anyio==4.14.2',
  'certifi==2026.7.22',
  'charset-normalizer==3.5.1',
  'h11==0.16.0',
  'httpcore==1.0.9',
  'idna==3.18',
  'lazy-loader==0.5',
  'networkx==3.6.1',
  'packaging==26.3',
  'sniffio==1.3.1',
  'typing-extensions==4.16.0',
  'urllib3==2.7.0',
];
const EXPECTED_MAIN_RUNTIME_FREEZE_WITH_TRANSITIVES = [
  ...EXPECTED_MAIN_RUNTIME_FREEZE,
  ...(process.platform === 'win32'
    ? EXPECTED_MAIN_RUNTIME_TRANSITIVE_FREEZE
    : EXPECTED_MAIN_RUNTIME_TRANSITIVE_FREEZE.filter((requirement) => (
      !WINDOWS_ONLY_RUNTIME_TRANSITIVE_NAMES.has(requirement.split('==')[0].toLowerCase().replace(/[-_.]+/g, '-'))
    ))),
];
const EXPECTED_TEXT_RUNTIME_FREEZE_WITH_TRANSITIVES = [
  ...EXPECTED_TEXT_RUNTIME_FREEZE,
  ...EXPECTED_TEXT_RUNTIME_TRANSITIVE_FREEZE,
];
const FORBIDDEN_RUNTIME_PACKAGES = new Set([
  'opencv-python',
  'opencv-contrib-python',
  'jax',
  'jaxlib',
  'ml-dtypes',
]);
const RUNTIME_KEYS = ['python_version', 'interpreter_path', 'pip_freeze_path', 'pip_freeze_sha256'];
const PADDLE_WHEEL_RELATIVE_DIR = 'runtime/text/.wheel-stage/paddlepaddle';
const PADDLE_WHEEL_FILE = 'paddlepaddle-2.6.2-cp312-cp312-win_amd64.whl';
const PADDLE_WHEEL_RELATIVE_PATH = `${PADDLE_WHEEL_RELATIVE_DIR}/${PADDLE_WHEEL_FILE}`;

function pickEnvValue(sourceEnv, canonicalKey) {
  if (sourceEnv[canonicalKey] !== undefined) return sourceEnv[canonicalKey];
  const found = Object.keys(sourceEnv).find((key) => key.toLowerCase() === canonicalKey.toLowerCase());
  return found ? sourceEnv[found] : undefined;
}

function contractProbePython(sourceEnv = process.env) {
  return sourceEnv.REDRAW_AUDITOR_PYTHON || null;
}

function contractProbeEnv(repoRoot, sourceEnv = process.env) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const value = pickEnvValue(sourceEnv, key);
    if (value !== undefined) env[key] = value;
  }
  env.PYTHONPATH = path.join(repoRoot, 'workers', 'redraw-full-frame-auditor', 'src');
  env.PYTHONUTF8 = '1';
  return env;
}

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeBootstrapStageChild(t) {
  const script = path.join(tempDir(t, 'redraw-bootstrap-stage-child-'), 'child.js');
  fs.writeFileSync(script, `
const mode = process.argv[2];
const code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
if (mode.startsWith('stage=')) {
  process.stderr.write('ordinary diagnostic\\n');
  process.stderr.write(code + ' stage=' + mode.slice('stage='.length) + '\\n');
  process.exit(1);
}
if (mode === 'not-last') {
  process.stderr.write(code + ' stage=load:text:output_limit\\nwarning after stage\\n');
  process.exit(1);
}
if (mode === 'bare-key') {
  process.stderr.write('ordinary key reference\\n');
  process.stderr.write(code + ' stage=load:text\\n');
  process.exit(1);
}
if (mode.startsWith('sensitive=')) {
  const warnings = {
    auth: 'Authorization: opaque-value',
    auth_short: 'AuTh: opaque-value',
    bearer: 'Bearer opaque-value',
    key: 'Key: opaque-value',
    api_dash_key: 'API-Key: opaque-value',
    api_underscore_key: 'api_key=opaque-value',
    api_space_key: 'api key=opaque-value',
    token: 'token=opaque-value',
    password: 'PASSWORD=opaque-value',
    credential: 'credential=opaque-value',
    proxy: 'Proxy=opaque-value',
    secret: 'secret=opaque-value',
    sensitive: 'Sensitive=opaque-value',
    path: 'failure at C:/private/worker.py',
  };
  process.stderr.write(warnings[mode.slice('sensitive='.length)] + '\\n');
  process.stderr.write(code + ' stage=load:text\\n');
  process.exit(1);
}
if (mode === 'huge') {
  process.stderr.write('x'.repeat(257));
  process.stderr.write('\\n' + code + ' stage=load:text\\n');
  process.exit(1);
}
if (mode === 'zero') {
  process.stderr.write(code + ' stage=load:text\\n');
  process.exit(0);
}
process.exit(2);
`, 'utf8');
  return script;
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
  assert(Object.getOwnPropertySymbols(error).every((symbol) => (
    Object.getOwnPropertyDescriptor(error, symbol).enumerable === false
  )));
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

function assertSerializedFetchErrorIsSanitized(error) {
  const serialized = JSON.stringify(error);
  assert.doesNotMatch(serialized, /C:\\|C:\/|redraw-paddle|paddlepaddle-2\.6\.2|Authorization|secret-token|secret-key|Key/i);
}

function buildSuccessfulFetchDeps(randomHexValue = 'fixture') {
  const freezeByRuntime = {
    main: EXPECTED_MAIN_RUNTIME_FREEZE_WITH_TRANSITIVES,
    text: EXPECTED_TEXT_RUNTIME_FREEZE_WITH_TRANSITIVES,
  };
  return {
    randomHex: () => randomHexValue,
    preflightRuntimePython: async () => {},
    fetchComponent: async (source) => ({
      revision: `fixed-${source.component}-20260816`,
      artifact_name: `${source.component}.bin`,
      artifact_bytes: Buffer.from(`${source.component}:artifact`),
      license_name: `${source.component}.license`,
      license_bytes: Buffer.from(`${source.component}:license`),
    }),
    createVenv: async (staging, runtimeName) => {
      const interpreter = venvPython(staging, runtimeName);
      await fsp.mkdir(path.dirname(interpreter), { recursive: true });
      await fsp.writeFile(interpreter, `${runtimeName}:python`);
    },
    installRuntime: async () => {},
    pipFreeze: async (_staging, runtimeName) => freezeByRuntime[runtimeName],
    pythonVersion: async (_staging, runtimeName) => `Python 3.11.9 ${runtimeName}`,
    bootstrapWorker: async () => {},
  };
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

test('runFetchModels rejects a missing auditor Python before fetch or staging', async (t) => {
  const parent = tempDir(t, 'redraw-model-python-preflight-');
  const outputDir = path.join(parent, 'cache');
  let fetchCalls = 0;
  let randomCalls = 0;
  const deps = {
    ...buildSuccessfulFetchDeps('python-preflight'),
    env: { PATH: 'path-only' },
    preflightRuntimePython: (runtimeDeps) => preflightRuntimePython(runtimeDeps),
    randomHex: () => {
      randomCalls += 1;
      return 'python-preflight';
    },
    fetchComponent: async () => {
      fetchCalls += 1;
      throw new Error('network must not be reached');
    },
  };

  await assert.rejects(
    runFetchModels({ outputDir }, deps),
    (error) => assertStableFetchError(error, 'python_preflight'),
  );

  assert.equal(fetchCalls, 0);
  assert.equal(randomCalls, 0);
  assert.equal(fs.existsSync(outputDir), false);
  assert.deepEqual(
    fs.readdirSync(parent).filter((entry) => entry.startsWith('.redraw-full-frame-staging-')),
    [],
  );
});

test('auditor Python preflight requires an absolute interpreter and safe version probe', async () => {
  const python = process.platform === 'win32' ? 'C:\\runtime\\python.exe' : '/runtime/python';
  const calls = [];
  const deps = {
    env: {
      REDRAW_AUDITOR_PYTHON: python,
      PATH: 'path-value',
      SystemRoot: 'system-root',
      OPENAI_API_KEY: 'secret',
      HTTPS_PROXY: 'https://proxy.invalid',
      PYTHONPATH: 'private-python-path',
    },
    spawnProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      return 'Python 3.12.13\n';
    },
  };

  assert.equal(await preflightRuntimePython(deps), python);
  assert.deepEqual(calls, [{
    command: python,
    args: ['--version'],
    options: {
      cwd: path.resolve(__dirname, '..', '..'),
      env: {
        PATH: 'path-value',
        SystemRoot: 'system-root',
        PYTHONUTF8: '1',
      },
    },
  }]);

  for (const invalidDeps of [
    { env: {} },
    { env: { REDRAW_AUDITOR_PYTHON: 'python' } },
    {
      env: { REDRAW_AUDITOR_PYTHON: python },
      spawnProcess: async () => 'not-python',
    },
  ]) {
    await assert.rejects(
      preflightRuntimePython(invalidDeps),
      (error) => assertStableFetchError(error, 'python_preflight'),
    );
  }
});

test('runFetchModels builds separate main and text runtimes with a v2 lock', async (t) => {
  const parent = tempDir(t, 'redraw-model-fetch-dual-runtime-');
  const outputDir = path.join(parent, 'cache');
  const calls = [];
  const freezeByRuntime = {
    main: EXPECTED_MAIN_RUNTIME_FREEZE_WITH_TRANSITIVES,
    text: EXPECTED_TEXT_RUNTIME_FREEZE_WITH_TRANSITIVES,
  };
  const versionByRuntime = {
    main: 'Python 3.11.9 main',
    text: 'Python 3.11.9 text',
  };
  const writeFakeInterpreter = async (staging, runtimeName) => {
    const interpreter = venvPython(staging, runtimeName);
    await fsp.mkdir(path.dirname(interpreter), { recursive: true });
    await fsp.writeFile(interpreter, `${runtimeName}:python`);
  };
  const deps = {
    randomHex: () => 'dual123',
    preflightRuntimePython: async () => calls.push('preflight_python'),
    fetchComponent: async (source) => {
      calls.push(`fetch:${source.component}`);
      return {
        revision: `fixed-${source.component}-20260816`,
        artifact_name: `${source.component}.bin`,
        artifact_bytes: Buffer.from(`${source.component}:artifact`),
        license_name: `${source.component}.license`,
        license_bytes: Buffer.from(`${source.component}:license`),
      };
    },
    createVenv: async (staging, runtimeName) => {
      assert(['main', 'text'].includes(runtimeName));
      calls.push(`create:${runtimeName}`);
      await writeFakeInterpreter(staging, runtimeName);
    },
    installRuntime: async (_staging, _components, runtimeName) => {
      assert(['main', 'text'].includes(runtimeName));
      calls.push(`install:${runtimeName}`);
    },
    pipFreeze: async (_staging, runtimeName) => {
      assert(['main', 'text'].includes(runtimeName));
      calls.push(`freeze:${runtimeName}`);
      return freezeByRuntime[runtimeName];
    },
    pythonVersion: async (_staging, runtimeName) => {
      assert(['main', 'text'].includes(runtimeName));
      calls.push(`version:${runtimeName}`);
      return versionByRuntime[runtimeName];
    },
    bootstrapWorker: async (staging, modelLockPath, runtimeName) => {
      assert.equal(runtimeName, 'main');
      calls.push('bootstrap:main');
      const lock = JSON.parse(await fsp.readFile(modelLockPath, 'utf8'));
      assert.equal(lock.schema_version, 'redraw-full-frame-model-lock-v2');
      assert.deepEqual(Object.keys(lock.runtimes), ['main', 'text']);
      assert.equal(lock.runtimes.main.python_version, versionByRuntime.main);
      assert.equal(lock.runtimes.text.python_version, versionByRuntime.text);
      assert.equal(lock.runtimes.main.interpreter_path, 'runtime/main/.venv/Scripts/python.exe');
      assert.equal(lock.runtimes.text.interpreter_path, 'runtime/text/.venv/Scripts/python.exe');
      assert.equal(lock.runtimes.main.pip_freeze_path, 'runtime/main/pip-freeze.txt');
      assert.equal(lock.runtimes.text.pip_freeze_path, 'runtime/text/pip-freeze.txt');
      for (const runtimeName of ['main', 'text']) {
        const freezePath = path.join(staging, lock.runtimes[runtimeName].pip_freeze_path);
        const freezeBytes = await fsp.readFile(freezePath);
        assert.equal(
          lock.runtimes[runtimeName].pip_freeze_sha256,
          crypto.createHash('sha256').update(freezeBytes).digest('hex'),
        );
      }
    },
    validateModelLock: async ({ lock }) => {
      calls.push('validate');
      return {
        canonical_sha256: 'a'.repeat(64),
        components: lock.components,
      };
    },
    publishCache: async (staging, target) => {
      calls.push('publish');
      await fsp.rename(staging, target);
    },
  };

  const result = await runFetchModels({ outputDir }, deps);

  assert.deepEqual(calls, [
    'preflight_python',
    'fetch:face_detector',
    'fetch:person_detector',
    'fetch:text_detector',
    'fetch:tracker',
    'create:main',
    'install:main',
    'freeze:main',
    'version:main',
    'create:text',
    'install:text',
    'freeze:text',
    'version:text',
    'bootstrap:main',
    'validate',
    'publish',
  ]);
  assert.equal(result.runtime_lock, undefined);
  assert.deepEqual(result.runtime_locks, {
    main: 'runtime/main/pip-freeze.txt',
    text: 'runtime/text/pip-freeze.txt',
  });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(outputDir, 'model-lock.json'), 'utf8')).runtimes), ['main', 'text']);
  assert.equal(
    fs.readFileSync(path.join(outputDir, 'runtime', 'main', 'pip-freeze.txt'), 'utf8'),
    `${EXPECTED_MAIN_RUNTIME_FREEZE_WITH_TRANSITIVES.slice().sort((a, b) => a.localeCompare(b)).join('\n')}\n`,
  );
  assert.equal(
    fs.readFileSync(path.join(outputDir, 'runtime', 'text', 'pip-freeze.txt'), 'utf8'),
    `${EXPECTED_TEXT_RUNTIME_FREEZE_WITH_TRANSITIVES.slice().sort((a, b) => a.localeCompare(b)).join('\n')}\n`,
  );
});

test('runFetchModels restores a pre-existing empty output directory when publish rename fails', async (t) => {
  const parent = tempDir(t, 'redraw-model-publish-existing-');
  const outputDir = path.join(parent, 'cache');
  fs.mkdirSync(outputDir);
  const originalRename = fsp.rename;
  fsp.rename = async (source, target) => {
    if (target === outputDir) {
      throw new Error(`rename failed from ${source} to ${target} with Authorization secret-token`);
    }
    return originalRename.call(fsp, source, target);
  };
  t.after(() => { fsp.rename = originalRename; });

  await assert.rejects(
    runFetchModels({ outputDir }, buildSuccessfulFetchDeps('publish-existing')),
    (error) => assertStableFetchError(error, 'publish'),
  );

  assert.equal(fs.existsSync(outputDir), true);
  assert.deepEqual(fs.readdirSync(outputDir), []);
  assert.equal(fs.existsSync(path.join(outputDir, 'model-lock.json')), false);
  assert.deepEqual(
    fs.readdirSync(parent).filter((entry) => entry.startsWith('.redraw-full-frame-staging-')),
    [],
  );
});

test('runFetchModels reports publish failure when restoring a removed empty output directory also fails', async (t) => {
  const parent = tempDir(t, 'redraw-model-publish-restore-failed-');
  const outputDir = path.join(parent, 'cache');
  fs.mkdirSync(outputDir);
  let restoreMkdirCalls = 0;
  const originalRename = fsp.rename;
  const originalMkdir = fsp.mkdir;
  fsp.rename = async (source, target) => {
    if (target === outputDir) {
      throw new Error(`rename failed from ${source} to ${target} with Authorization secret-token`);
    }
    return originalRename.call(fsp, source, target);
  };
  fsp.mkdir = async (target, options) => {
    if (target === outputDir) {
      restoreMkdirCalls += 1;
      const restoreError = new Error(`restore failed for ${target} with Authorization secret-token`);
      restoreError.code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID';
      throw restoreError;
    }
    return originalMkdir.call(fsp, target, options);
  };
  t.after(() => {
    fsp.rename = originalRename;
    fsp.mkdir = originalMkdir;
  });

  await assert.rejects(
    runFetchModels({ outputDir }, buildSuccessfulFetchDeps('publish-restore-failed')),
    (error) => {
      assert.equal(error.code, 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
      assert.equal(error.message, 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
      assert.deepEqual(Object.keys(error), ['code']);
      assert.equal(error.stage, 'publish');
      assert.equal(error.cause, undefined);
      assert.equal(error.context, undefined);
      assert.doesNotMatch(JSON.stringify(error), /redraw-model-publish-restore-failed|Authorization|secret-token|cache/i);
      return true;
    },
  );

  assert.equal(restoreMkdirCalls, 1);
  assert.equal(fs.existsSync(outputDir), false);
  assert.deepEqual(
    fs.readdirSync(parent).filter((entry) => entry.startsWith('.redraw-full-frame-staging-')),
    [],
  );
});

test('runFetchModels does not create a missing output directory when publish rename fails', async (t) => {
  const parent = tempDir(t, 'redraw-model-publish-missing-');
  const outputDir = path.join(parent, 'cache');
  const originalRename = fsp.rename;
  fsp.rename = async (source, target) => {
    if (target === outputDir) {
      throw new Error(`rename failed from ${source} to ${target} with Authorization secret-token`);
    }
    return originalRename.call(fsp, source, target);
  };
  t.after(() => { fsp.rename = originalRename; });

  await assert.rejects(
    runFetchModels({ outputDir }, buildSuccessfulFetchDeps('publish-missing')),
    (error) => assertStableFetchError(error, 'publish'),
  );

  assert.equal(fs.existsSync(outputDir), false);
  assert.deepEqual(
    fs.readdirSync(parent).filter((entry) => entry.startsWith('.redraw-full-frame-staging-')),
    [],
  );
});

test('runFetchModels removes staging when Paddle wheel download fails', async (t) => {
  const parent = tempDir(t, 'redraw-model-paddle-download-fail-');
  const outputDir = path.join(parent, 'cache');
  const raw = new Error('C:\\Users\\private\\paddle.py Authorization: Bearer secret-token Key=secret-key root=/private/root');
  raw.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
  raw.stage = 'download:C:\\Users\\private\\paddle.py';
  raw.cause = new Error('C:\\Users\\private\\root\\paddle.py');
  raw.context = { authorization: 'Bearer secret-token', key: 'secret-key', root: '/private/root' };
  const processDeps = {
    env: { PATH: 'path-value', SystemRoot: 'system-root', WINDIR: 'windir', TEMP: 'temp', TMP: 'tmp' },
    spawnProcess: async (_command, args) => {
      assert(Array.isArray(args));
      if (args.includes('download')) throw raw;
      return '';
    },
  };
  const deps = {
    ...buildSuccessfulFetchDeps('paddle-download'),
    createVenv: async (staging, runtimeName) => {
      await fsp.mkdir(path.join(staging, 'runtime', runtimeName, '.venv'), { recursive: true });
    },
    installRuntime: async (staging, components, runtimeName) => (
      installRuntime(staging, components, runtimeName, processDeps)
    ),
  };

  await assert.rejects(
    runFetchModels({ outputDir }, deps),
    (error) => {
      assertStableFetchError(error, 'download:text:paddlepaddle');
      const serialized = JSON.stringify(error);
      assert.doesNotMatch(serialized, /private|root|Authorization|secret-token|secret-key/i);
      return true;
    },
  );

  assert.equal(fs.existsSync(outputDir), false);
  assert.equal(fs.existsSync(path.join(outputDir, 'model-lock.json')), false);
  assert.deepEqual(
    fs.readdirSync(parent).filter((entry) => entry.startsWith('.redraw-full-frame-staging-')),
    [],
  );
});

test('runFetchModels builds a fixture cache, validates lock, and leaves no final directory on failure', async (t) => {
  const parent = tempDir(t, 'redraw-model-fetch-');
  const outputDir = path.join(parent, 'cache');
  const calls = [];
  const writeFakeInterpreter = async (staging, runtimeName) => {
    const interpreter = venvPython(staging, runtimeName);
    await fsp.mkdir(path.dirname(interpreter), { recursive: true });
    await fsp.writeFile(interpreter, `${runtimeName}:python`);
  };
  const freezeByRuntime = {
    main: EXPECTED_MAIN_RUNTIME_FREEZE_WITH_TRANSITIVES,
    text: EXPECTED_TEXT_RUNTIME_FREEZE_WITH_TRANSITIVES,
  };
  const deps = {
    randomHex: () => 'abc123',
    preflightRuntimePython: async () => {},
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
    createVenv: async (staging, runtimeName) => {
      calls.push(`venv:${runtimeName}`);
      await writeFakeInterpreter(staging, runtimeName);
    },
    installRuntime: async (_staging, _components, runtimeName) => calls.push(`install:${runtimeName}`),
    pipFreeze: async (_staging, runtimeName) => freezeByRuntime[runtimeName],
    bootstrapWorker: async () => calls.push('bootstrap'),
    pythonVersion: async (_staging, runtimeName) => `Python 3.11.9 ${runtimeName}`,
  };

  const result = await runFetchModels({ outputDir }, deps);

  assert.deepEqual(result.components, ['face_detector', 'person_detector', 'text_detector', 'tracker']);
  assert.match(result.canonical_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.runtime_locks, {
    main: 'runtime/main/pip-freeze.txt',
    text: 'runtime/text/pip-freeze.txt',
  });
  assert(fs.existsSync(path.join(outputDir, 'model-lock.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(outputDir, 'model-lock.json'), 'utf8'));
  assert.equal(lock.schema_version, 'redraw-full-frame-model-lock-v2');
  assert.deepEqual(Object.keys(lock.runtimes), ['main', 'text']);
  for (const runtimeName of ['main', 'text']) {
    const freezeBytes = fs.readFileSync(path.join(outputDir, lock.runtimes[runtimeName].pip_freeze_path));
    assert.equal(
      lock.runtimes[runtimeName].pip_freeze_sha256,
      crypto.createHash('sha256').update(freezeBytes).digest('hex'),
    );
    const frozenPackages = new Map(String(freezeBytes).trim().split(/\r?\n/).map((line) => {
      const [name, version] = line.split('==');
      return [name.toLowerCase().replace(/[-_.]+/g, '-'), version];
    }));
    for (const forbidden of FORBIDDEN_RUNTIME_PACKAGES) assert.equal(frozenPackages.has(forbidden), false);
  }
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
  const rawFetchError = new Error('C:\\Users\\private\\face.bin Authorization: Bearer secret-token Key=secret-key');
  rawFetchError.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
  rawFetchError.cause = new Error('C:\\Users\\private\\face.bin');
  rawFetchError.context = { authorization: 'Bearer secret-token', key: 'secret-key' };
  rawFetchError.stage = 'install:paddleocr';
  await assert.rejects(runFetchModels({
    outputDir: failed,
  }, { ...deps, fetchComponent: async () => { throw rawFetchError; } }), (error) => (
    assertStableFetchError(error, 'fetch:face_detector')
  ));
  assert.equal(fs.existsSync(failed), false);

  const bootstrapFailed = path.join(parent, 'bootstrap-failed');
  const rawBootstrapError = new Error('C:\\Users\\private\\model-lock.json Authorization: Bearer secret-token Key=secret-key');
  rawBootstrapError.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
  rawBootstrapError.cause = new Error('C:\\Users\\private\\worker.py');
  rawBootstrapError.context = { authorization: 'Bearer secret-token', key: 'secret-key' };
  rawBootstrapError.stage = 'bootstrap:load:text:output_limit';
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
  const stageChild = writeBootstrapStageChild(t);
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
    preflightRuntimePython: async () => {},
    fetchComponent: async (source) => ({
      revision: `fixed-${source.component}-20260816`,
      artifact_name: `${source.component}.bin`,
      artifact_bytes: Buffer.from(`${source.component}:artifact`),
      license_name: `${source.component}.license`,
      license_bytes: Buffer.from(`${source.component}:license`),
    }),
    createVenv: async (staging, runtimeName) => {
      const interpreter = venvPython(staging, runtimeName);
      await fsp.mkdir(path.dirname(interpreter), { recursive: true });
      await fsp.writeFile(interpreter, `${runtimeName}:python`);
    },
    pipFreeze: async (_staging, runtimeName) => (
      runtimeName === 'main' ? EXPECTED_MAIN_RUNTIME_FREEZE_WITH_TRANSITIVES : EXPECTED_TEXT_RUNTIME_FREEZE_WITH_TRANSITIVES
    ),
    pythonVersion: async (_staging, runtimeName) => `Python 3.11.9 ${runtimeName}`,
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
    installRuntime: async (staging, components, runtimeName) => installRuntime(staging, components, runtimeName, {
      spawnProcess: async (_command, args, options) => {
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          await fsp.mkdir(path.join(options.cwd, dest), { recursive: true });
          await fsp.writeFile(path.join(options.cwd, dest, PADDLE_WHEEL_FILE), 'fixture-wheel');
          return '';
        }
        if (args[args.length - 1] === 'paddleocr==2.8.1') throw privateFailure('paddleocr.py');
        return '';
      },
      env: { PATH: 'path' },
    }),
  });
  assert.deepEqual(installResult, {
    code: 1,
    stderr: 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=install:text:paddleocr\n',
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

  const bootstrapChildResult = await capture(['--output-dir', path.join(parent, 'bootstrap-child-failed')], {
    ...fixtureDeps,
    installRuntime: async () => {},
    bootstrapWorker: async (staging, modelLockPath) => bootstrapWorker(staging, modelLockPath, {
      env: process.env,
      spawnProcess: async (_command, _args, options) => (
        runProcess(process.execPath, [stageChild, 'stage=load:text:output_limit'], options)
      ),
    }),
  });
  assert.deepEqual(bootstrapChildResult, {
    code: 1,
    stderr: 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=bootstrap:load:text:output_limit\n',
  });

  const unknownResult = await capture(['--url', 'https://secret.example/model'], fixtureDeps);
  assert.deepEqual(unknownResult, {
    code: 1,
    stderr: 'REDRAW_FULL_FRAME_OUTPUT_INVALID stage=unknown\n',
  });
  assert.doesNotMatch(
    `${installResult.stderr}${bootstrapResult.stderr}${bootstrapChildResult.stderr}${unknownResult.stderr}`,
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
  const freezeByRuntime = {
    main: EXPECTED_MAIN_RUNTIME_FREEZE_WITH_TRANSITIVES,
    text: EXPECTED_TEXT_RUNTIME_FREEZE_WITH_TRANSITIVES,
  };
  const deps = {
    spawnProcess: async (command, args, options) => {
      calls.push({ command, args, env: options.env, cwd: options.cwd });
      if (args.includes('download')) {
        const dest = args[args.indexOf('--dest') + 1];
        await fsp.mkdir(path.join(options.cwd, dest), { recursive: true });
        await fsp.writeFile(path.join(options.cwd, dest, PADDLE_WHEEL_FILE), 'fixture-wheel');
      }
      if (args.includes('freeze')) {
        const runtimeName = command.includes(`${path.sep}text${path.sep}`) ? 'text' : 'main';
        return `${freezeByRuntime[runtimeName].join('\n')}\n`;
      }
      if (args.includes('--version')) return 'Python 3.11.9\n';
      return '';
    },
    env: { REDRAW_AUDITOR_PYTHON: 'python-fixture', OPENAI_API_KEY: 'secret', PATH: 'path' },
  };
  const parent = tempDir(t, 'redraw-runtime-');
  const fetchModule = require('../scripts/fetch-redraw-full-frame-models-local');

  await fetchModule.createVenv(parent, 'main', deps);
  await fetchModule.installRuntime(parent, [], 'main', deps);
  await fetchModule.createVenv(parent, 'text', deps);
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });
  await fetchModule.installRuntime(parent, [], 'text', deps);
  assert.equal(EXPECTED_MAIN_RUNTIME_PACKAGE_SPECS.length, 23);
  assert.equal(EXPECTED_TEXT_RUNTIME_PACKAGE_SPECS.length, 31);
  assert.equal(
    EXPECTED_MAIN_RUNTIME_PACKAGE_SPECS.length + EXPECTED_TEXT_RUNTIME_PACKAGE_SPECS.length - 1,
    53,
  );
  assert.equal(EXPECTED_MAIN_RUNTIME_TRANSITIVE_FREEZE.length, 22);
  assert.equal(EXPECTED_TEXT_RUNTIME_TRANSITIVE_FREEZE.length, 12);
  for (const [runtimeName, directFreeze] of Object.entries({
    main: EXPECTED_MAIN_RUNTIME_FREEZE,
    text: EXPECTED_TEXT_RUNTIME_FREEZE,
  })) {
    const directNames = directFreeze.map((requirement) => (
      requirement.split('==')[0].toLowerCase().replace(/[-_.]+/g, '-')
    ));
    assert.equal(new Set(directNames).size, directNames.length);
    assert.deepEqual(
      await fetchModule.pipFreeze(parent, runtimeName, deps),
      freezeByRuntime[runtimeName].slice().sort((a, b) => a.localeCompare(b)),
    );
  }
  const mainLinuxFreeze = [
    ...EXPECTED_MAIN_RUNTIME_FREEZE,
    ...EXPECTED_MAIN_RUNTIME_TRANSITIVE_FREEZE.filter((requirement) => (
      !WINDOWS_ONLY_RUNTIME_TRANSITIVE_NAMES.has(requirement.split('==')[0].toLowerCase().replace(/[-_.]+/g, '-'))
    )),
  ];
  assert.deepEqual(
    assertPinnedFreeze(mainLinuxFreeze, 'linux', 'main'),
    mainLinuxFreeze.slice().sort((a, b) => a.localeCompare(b)),
  );
  for (const requirement of EXPECTED_MAIN_RUNTIME_TRANSITIVE_FREEZE.filter((line) => (
    WINDOWS_ONLY_RUNTIME_TRANSITIVE_NAMES.has(line.split('==')[0].toLowerCase().replace(/[-_.]+/g, '-'))
  ))) {
    assert.throws(
      () => assertPinnedFreeze([...EXPECTED_MAIN_RUNTIME_FREEZE, requirement], 'linux', 'main'),
      /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
    );
  }
  assert.doesNotThrow(() => assertPinnedFreeze(
    [...EXPECTED_MAIN_RUNTIME_FREEZE, ...EXPECTED_MAIN_RUNTIME_TRANSITIVE_FREEZE],
    'win32',
    'main',
  ));
  assert.equal(await fetchModule.pythonVersion(parent, 'main', deps), 'Python 3.11.9');
  await fetchModule.bootstrapWorker(parent, path.join(parent, 'model-lock.json'), deps);
  assert(calls.filter((call) => call.args.includes('venv')).every((call) => call.command === 'python-fixture'));
  assert(calls.filter((call) => !call.args.includes('venv')).every((call) => (
    call.command === venvPython(parent, 'main') || call.command === venvPython(parent, 'text')
  )), JSON.stringify(calls));
  assert(calls.every((call) => Array.isArray(call.args)));
  assert(calls.every((call) => call.env.PYTHONUTF8 === '1'));
  assert(calls.every((call) => !Object.prototype.hasOwnProperty.call(call.env, 'OPENAI_API_KEY')));
  assert(calls.every((call) => call.cwd === parent));
  const installCalls = calls.filter((call) => call.args.includes('install'));
  const downloadCalls = calls.filter((call) => call.args.includes('download'));
  assert.equal(downloadCalls.length, 1);
  assert.deepEqual(downloadCalls[0].args, [
    '-m',
    'pip',
    '--isolated',
    'download',
    '--disable-pip-version-check',
    '--no-input',
    '--index-url',
    'https://pypi.org/simple',
    '--no-deps',
    '--only-binary=:all:',
    '--dest',
    PADDLE_WHEEL_RELATIVE_DIR,
    'paddlepaddle==2.6.2',
  ]);
  const indexedInstallCalls = installCalls.filter((call) => !call.args.includes('--no-index'));
  const localInstallCalls = installCalls.filter((call) => call.args.includes('--no-index'));
  assert.equal(indexedInstallCalls.length, 53);
  assert.equal(localInstallCalls.length, 1);
  assert.equal(localInstallCalls[0].command, venvPython(parent, 'text'));
  assert.deepEqual(localInstallCalls[0].args, [
    '-m',
    'pip',
    '--isolated',
    'install',
    '--disable-pip-version-check',
    '--no-input',
    '--no-index',
    '--no-deps',
    PADDLE_WHEEL_RELATIVE_PATH,
  ]);
  assert(indexedInstallCalls.every((call) => {
    const index = call.args.indexOf('--index-url');
    const isolated = call.args.indexOf('--isolated');
    const install = call.args.indexOf('install');
    return index >= 0
      && call.args[index + 1] === 'https://pypi.org/simple'
      && isolated >= 0
      && isolated < install
      && !call.args.includes('--extra-index-url')
      && !call.args.includes('--find-links');
  }), JSON.stringify(indexedInstallCalls));
  assert.deepEqual(
    indexedInstallCalls.map((call) => call.args[call.args.length - 1]),
    [
      ...EXPECTED_MAIN_RUNTIME_PACKAGE_SPECS.map((spec) => spec.requirement),
      ...EXPECTED_TEXT_RUNTIME_PACKAGE_SPECS
        .filter((spec) => spec.requirement !== 'paddlepaddle==2.6.2')
        .map((spec) => spec.requirement),
    ],
  );
  assert.deepEqual(
    indexedInstallCalls.filter((call) => call.command === venvPython(parent, 'main')).map((call) => ({
      requirement: call.args[call.args.length - 1],
      noDeps: call.args.includes('--no-deps'),
    })),
    EXPECTED_MAIN_RUNTIME_PACKAGE_SPECS.map((spec) => ({
      requirement: spec.requirement,
      noDeps: spec.noDeps === true,
    })),
  );
  assert.deepEqual(
    indexedInstallCalls.filter((call) => call.command === venvPython(parent, 'text')).map((call) => ({
      requirement: call.args[call.args.length - 1],
      noDeps: call.args.includes('--no-deps'),
    })),
    EXPECTED_TEXT_RUNTIME_PACKAGE_SPECS.filter((spec) => spec.requirement !== 'paddlepaddle==2.6.2').map((spec) => ({
      requirement: spec.requirement,
      noDeps: spec.noDeps === true,
    })),
  );
  assert.deepEqual(
    installCalls.filter((call) => call.args.includes('--no-deps')).map((call) => call.args[call.args.length - 1]),
    ['yolox==0.3.0', 'mediapipe==0.10.14', 'imgaug==0.4.0', PADDLE_WHEEL_RELATIVE_PATH, 'paddleocr==2.8.1'],
  );
  assert.deepEqual(
    [
      ...EXPECTED_MAIN_RUNTIME_PACKAGE_SPECS,
      ...EXPECTED_TEXT_RUNTIME_PACKAGE_SPECS,
    ].filter((spec) => spec.noDeps).map((spec) => spec.requirement),
    ['yolox==0.3.0', 'mediapipe==0.10.14', 'imgaug==0.4.0', 'paddlepaddle==2.6.2', 'paddleocr==2.8.1'],
  );
  assert(indexedInstallCalls.every((call) => !call.args.includes('--no-index')));

  await assert.rejects(
    fetchModule.pipFreeze(parent, 'main', { ...deps, spawnProcess: async () => 'pkg>=1.0.0\n' }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    fetchModule.installRuntime(parent, [], 'main', { ...deps, runtimePackageSpecs: [{ requirement: 'pkg==1.0.0' }] }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  const rawInstallError = new Error('C:\\Users\\private\\paddleocr.py Authorization: Bearer secret-token Key=secret-key');
  rawInstallError.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
  rawInstallError.cause = new Error('C:\\Users\\private\\paddleocr.py');
  rawInstallError.context = { authorization: 'Bearer secret-token', key: 'secret-key' };
  rawInstallError.stage = 'install:C:\\Users\\private\\paddleocr.py';
  await assert.rejects(
    fetchModule.installRuntime(parent, [], 'text', {
      ...deps,
      spawnProcess: async (_command, args, options) => {
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          await fsp.mkdir(path.join(options.cwd, dest), { recursive: true });
          await fsp.writeFile(path.join(options.cwd, dest, PADDLE_WHEEL_FILE), 'fixture-wheel');
          return '';
        }
        if (args[args.length - 1] === 'paddleocr==2.8.1') throw rawInstallError;
        return '';
      },
    }),
    (error) => assertStableFetchError(error, 'install:text:paddleocr'),
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
      fetchModule.pipFreeze(parent, 'main', {
        ...deps,
        spawnProcess: async () => `${EXPECTED_MAIN_RUNTIME_FREEZE.join('\n')}\n${requirement}\n`,
      }),
      /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
    );
  }
  for (const [runtimeName, directFreeze] of Object.entries({
    main: EXPECTED_MAIN_RUNTIME_FREEZE,
    text: EXPECTED_TEXT_RUNTIME_FREEZE,
  })) {
    await assert.rejects(
      fetchModule.pipFreeze(parent, runtimeName, {
        ...deps,
        spawnProcess: async () => `${directFreeze.join('\n')}\nunapproved-extra-package==9.9.9\n`,
      }),
      /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
    );
    await assert.rejects(
      fetchModule.pipFreeze(parent, runtimeName, {
        ...deps,
        spawnProcess: async () => `${directFreeze.join('\n')}\nNumPy==1.26.4\n`,
      }),
      /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
    );
  }
  await assert.rejects(
    fetchModule.pipFreeze(parent, 'main', {
      ...deps,
      spawnProcess: async () => `${EXPECTED_MAIN_RUNTIME_FREEZE.join('\n')}\npaddleocr==2.8.1\n`,
    }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    fetchModule.pipFreeze(parent, 'text', {
      ...deps,
      spawnProcess: async () => `${EXPECTED_TEXT_RUNTIME_FREEZE.join('\n')}\ntorch==2.3.1\n`,
    }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    fetchModule.pipFreeze(parent, 'main', {
      ...deps,
      spawnProcess: async () => `${EXPECTED_MAIN_RUNTIME_FREEZE.filter((line) => line !== 'protobuf==4.25.9').join('\n')}\n`,
    }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    fetchModule.pipFreeze(parent, 'text', {
      ...deps,
      spawnProcess: async () => `${EXPECTED_TEXT_RUNTIME_FREEZE.map((line) => (
        line === 'protobuf==3.20.2' ? 'protobuf==4.25.9' : line
      )).join('\n')}\n`,
    }),
    /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/,
  );
});

test('PaddlePaddle text runtime downloads the pinned wheel before local no-index install', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-wheel-');
  const calls = [];
  const deps = {
    env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
    spawnProcess: async (command, args, options) => {
      calls.push({ command, args: args.slice(), env: { ...options.env }, cwd: options.cwd });
      if (args.includes('download')) {
        const dest = args[args.indexOf('--dest') + 1];
        await fsp.mkdir(path.join(options.cwd, dest), { recursive: true });
        await fsp.writeFile(path.join(options.cwd, dest, PADDLE_WHEEL_FILE), 'fixture-wheel');
      }
      return '';
    },
  };
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });

  await installRuntime(parent, [], 'text', deps);

  const downloadCalls = calls.filter((call) => call.args.includes('download'));
  const localInstallCalls = calls.filter((call) => call.args.includes('--no-index'));
  assert.equal(downloadCalls.length, 1);
  assert.equal(localInstallCalls.length, 1);
  assert.deepEqual(downloadCalls[0].args, [
    '-m',
    'pip',
    '--isolated',
    'download',
    '--disable-pip-version-check',
    '--no-input',
    '--index-url',
    'https://pypi.org/simple',
    '--no-deps',
    '--only-binary=:all:',
    '--dest',
    PADDLE_WHEEL_RELATIVE_DIR,
    'paddlepaddle==2.6.2',
  ]);
  assert(localInstallCalls[0].args.includes('--no-index'));
  assert(localInstallCalls[0].args.includes('--no-deps'));
  assert(!localInstallCalls[0].args.includes('--index-url'));
  assert.equal(localInstallCalls[0].args[localInstallCalls[0].args.length - 1], PADDLE_WHEEL_RELATIVE_PATH);
  assert.equal(path.isAbsolute(localInstallCalls[0].args[localInstallCalls[0].args.length - 1]), false);
  assert(calls.indexOf(downloadCalls[0]) < calls.indexOf(localInstallCalls[0]));
  for (const call of [downloadCalls[0], localInstallCalls[0]]) {
    assert.equal(call.command, venvPython(parent, 'text'));
    assert.equal(call.cwd, parent);
    assert.equal(call.env.PYTHONUTF8, '1');
    assert(!Object.prototype.hasOwnProperty.call(call.env, 'OPENAI_API_KEY'));
  }
  assert.equal(fs.existsSync(path.join(parent, 'runtime', 'text', '.wheel-stage')), false);
});

test('PaddlePaddle wheel evidence rejects ambiguous or mismatched download results before local install', async (t) => {
  const cases = [
    {
      name: 'empty directory',
      write: async () => {},
    },
    {
      name: 'valid wheel plus extra file',
      write: async (wheelDir) => {
        await fsp.writeFile(path.join(wheelDir, PADDLE_WHEEL_FILE), 'fixture-wheel');
        await fsp.writeFile(path.join(wheelDir, 'extra.txt'), 'extra');
      },
    },
    {
      name: 'wrong package name',
      write: async (wheelDir) => {
        await fsp.writeFile(path.join(wheelDir, 'notpaddle-2.6.2-cp312-cp312-win_amd64.whl'), 'fixture-wheel');
      },
    },
    {
      name: 'wrong version',
      write: async (wheelDir) => {
        await fsp.writeFile(path.join(wheelDir, 'paddlepaddle-2.6.1-cp312-cp312-win_amd64.whl'), 'fixture-wheel');
      },
    },
    {
      name: 'source archive',
      write: async (wheelDir) => {
        await fsp.writeFile(path.join(wheelDir, 'paddlepaddle-2.6.2.tar.gz'), 'fixture-wheel');
      },
    },
    {
      name: 'same-name directory',
      write: async (wheelDir) => {
        await fsp.mkdir(path.join(wheelDir, PADDLE_WHEEL_FILE));
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const parent = tempDir(subtest, 'redraw-paddle-wheel-evidence-');
      const calls = [];
      await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });

      await assert.rejects(
        installRuntime(parent, [], 'text', {
          env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
          spawnProcess: async (_command, args, options) => {
            calls.push(args.slice());
            if (args.includes('download')) {
              const dest = args[args.indexOf('--dest') + 1];
              const wheelDir = path.join(options.cwd, dest);
              await fsp.mkdir(wheelDir, { recursive: true });
              await item.write(wheelDir);
            }
            return '';
          },
        }),
        (error) => {
          assertStableFetchError(error, 'download:text:paddlepaddle');
          assertSerializedFetchErrorIsSanitized(error);
          return true;
        },
      );

      assert.equal(calls.filter((args) => args.includes('--no-index')).length, 0);
    });
  }
});

test('PaddlePaddle wheel symlink pointing outside staging is rejected before local install', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-wheel-symlink-');
  const outside = path.join(tempDir(t, 'redraw-paddle-wheel-outside-'), 'outside.whl');
  await fsp.writeFile(outside, 'fixture-wheel');
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });
  const calls = [];

  await assert.rejects(
    installRuntime(parent, [], 'text', {
      env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
      spawnProcess: async (_command, args, options) => {
        calls.push(args.slice());
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          const wheelDir = path.join(options.cwd, dest);
          await fsp.mkdir(wheelDir, { recursive: true });
          try {
            await fsp.symlink(outside, path.join(wheelDir, PADDLE_WHEEL_FILE));
          } catch (err) {
            if (err && err.code === 'EPERM') {
              t.skip(`symlink creation not permitted: ${err.code}`);
              return;
            }
            throw err;
          }
        }
        return '';
      },
    }),
    (error) => {
      assertStableFetchError(error, 'download:text:paddlepaddle');
      assertSerializedFetchErrorIsSanitized(error);
      return true;
    },
  );
  assert.equal(calls.filter((args) => args.includes('--no-index')).length, 0);
});

test('PaddlePaddle wheel junction replacing package directory is rejected before local install', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-wheel-junction-');
  const outside = tempDir(t, 'redraw-paddle-wheel-junction-outside-');
  await fsp.writeFile(path.join(outside, PADDLE_WHEEL_FILE), 'fixture-wheel');
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });
  const calls = [];

  await assert.rejects(
    installRuntime(parent, [], 'text', {
      env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
      spawnProcess: async (_command, args, options) => {
        calls.push(args.slice());
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          const wheelDir = path.join(options.cwd, dest);
          await fsp.rmdir(wheelDir);
          try {
            await fsp.symlink(outside, wheelDir, process.platform === 'win32' ? 'junction' : 'dir');
          } catch (err) {
            if (err && err.code === 'EPERM') {
              t.skip(`junction creation not permitted: ${err.code}`);
              return;
            }
            throw err;
          }
        }
        return '';
      },
    }),
    (error) => {
      assertStableFetchError(error, 'download:text:paddlepaddle');
      assertSerializedFetchErrorIsSanitized(error);
      return true;
    },
  );
  assert.equal(calls.filter((args) => args.includes('--no-index')).length, 0);
});

test('PaddlePaddle wheel drift rejects realpath escape during download evidence read', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-wheel-drift-download-');
  const outside = tempDir(t, 'redraw-paddle-wheel-drift-outside-');
  const originalRealpath = fsp.realpath;
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });
  t.after(() => { fsp.realpath = originalRealpath; });

  await assert.rejects(
    installRuntime(parent, [], 'text', {
      env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
      spawnProcess: async (_command, args, options) => {
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          const wheelDir = path.join(options.cwd, dest);
          await fsp.mkdir(wheelDir, { recursive: true });
          await fsp.writeFile(path.join(wheelDir, PADDLE_WHEEL_FILE), 'fixture-wheel');
          fsp.realpath = async (target, ...rest) => {
            if (path.resolve(target) === path.resolve(wheelDir)) return path.join(outside, 'paddlepaddle');
            return originalRealpath.call(fsp, target, ...rest);
          };
        }
        return '';
      },
    }),
    (error) => {
      assertStableFetchError(error, 'download:text:paddlepaddle');
      assertSerializedFetchErrorIsSanitized(error);
      return true;
    },
  );
});

test('PaddlePaddle wheel drift rejects realpath escape after local install', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-wheel-drift-install-');
  const outside = tempDir(t, 'redraw-paddle-wheel-drift-install-outside-');
  const originalRealpath = fsp.realpath;
  let drift = false;
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });
  t.after(() => { fsp.realpath = originalRealpath; });

  await assert.rejects(
    installRuntime(parent, [], 'text', {
      env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
      spawnProcess: async (_command, args, options) => {
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          const wheelDir = path.join(options.cwd, dest);
          await fsp.mkdir(wheelDir, { recursive: true });
          await fsp.writeFile(path.join(wheelDir, PADDLE_WHEEL_FILE), 'fixture-wheel');
          fsp.realpath = async (target, ...rest) => {
            if (drift && path.resolve(target) === path.resolve(path.join(wheelDir, PADDLE_WHEEL_FILE))) {
              return path.join(outside, PADDLE_WHEEL_FILE);
            }
            return originalRealpath.call(fsp, target, ...rest);
          };
        }
        if (args.includes('--no-index')) drift = true;
        return '';
      },
    }),
    (error) => {
      assertStableFetchError(error, 'install:text:paddlepaddle');
      assertSerializedFetchErrorIsSanitized(error);
      return true;
    },
  );
});

test('PaddlePaddle wheel drift rejects same-name wheel content replacement after local install', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-wheel-drift-content-');
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });

  await assert.rejects(
    installRuntime(parent, [], 'text', {
      env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
      spawnProcess: async (_command, args, options) => {
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          const wheelDir = path.join(options.cwd, dest);
          await fsp.mkdir(wheelDir, { recursive: true });
          await fsp.writeFile(path.join(wheelDir, PADDLE_WHEEL_FILE), 'fixture-wheel');
        }
        if (args.includes('--no-index')) {
          await fsp.writeFile(path.join(options.cwd, PADDLE_WHEEL_RELATIVE_PATH), 'fixture-wheel-rewritten');
        }
        return '';
      },
    }),
    (error) => {
      assertStableFetchError(error, 'install:text:paddlepaddle');
      assertSerializedFetchErrorIsSanitized(error);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(parent, PADDLE_WHEEL_RELATIVE_PATH)), true);
});

test('PaddlePaddle wheel hard link from outside staging is rejected before local install', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-wheel-hardlink-download-');
  const outside = path.join(tempDir(t, 'redraw-paddle-wheel-hardlink-outside-'), PADDLE_WHEEL_FILE);
  await fsp.writeFile(outside, 'fixture-wheel');
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });
  const calls = [];
  let linkCreated = false;

  await assert.rejects(
    installRuntime(parent, [], 'text', {
      env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
      spawnProcess: async (_command, args, options) => {
        calls.push(args.slice());
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          const wheelDir = path.join(options.cwd, dest);
          await fsp.mkdir(wheelDir, { recursive: true });
          try {
            await fsp.link(outside, path.join(wheelDir, PADDLE_WHEEL_FILE));
            linkCreated = true;
          } catch (err) {
            if (err && err.code === 'EPERM') {
              t.skip(`hard link creation not permitted: ${err.code}`);
              return;
            }
            throw err;
          }
        }
        return '';
      },
    }),
    (error) => {
      assert.equal(linkCreated, true);
      assertStableFetchError(error, 'download:text:paddlepaddle');
      assertSerializedFetchErrorIsSanitized(error);
      return true;
    },
  );
  assert.equal(calls.filter((args) => args.includes('--no-index')).length, 0);
});

test('PaddlePaddle wheel hard link created during local install is rejected after install', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-wheel-hardlink-install-');
  const outside = path.join(tempDir(t, 'redraw-paddle-wheel-hardlink-install-outside-'), PADDLE_WHEEL_FILE);
  const originalLstat = fsp.lstat;
  let wheelPath = null;
  let preLinkStat = null;
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });
  let linkCreated = false;
  t.after(() => { fsp.lstat = originalLstat; });

  await assert.rejects(
    installRuntime(parent, [], 'text', {
      env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
      spawnProcess: async (_command, args, options) => {
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          const wheelDir = path.join(options.cwd, dest);
          wheelPath = path.join(wheelDir, PADDLE_WHEEL_FILE);
          await fsp.mkdir(wheelDir, { recursive: true });
          await fsp.writeFile(wheelPath, 'fixture-wheel');
        }
        if (args.includes('--no-index')) {
          try {
            preLinkStat = await originalLstat(wheelPath, { bigint: true });
            await fsp.link(wheelPath, outside);
            linkCreated = true;
            fsp.lstat = async (target, options) => {
              const stat = await originalLstat(target, options);
              if (path.resolve(target) !== path.resolve(wheelPath) || stat.nlink !== 2n) return stat;
              Object.defineProperties(stat, {
                dev: { value: preLinkStat.dev },
                ino: { value: preLinkStat.ino },
                size: { value: preLinkStat.size },
                mtimeNs: { value: preLinkStat.mtimeNs },
                ctimeNs: { value: preLinkStat.ctimeNs },
              });
              return stat;
            };
          } catch (err) {
            if (err && err.code === 'EPERM') {
              t.skip(`hard link creation not permitted: ${err.code}`);
              return;
            }
            throw err;
          }
        }
        return '';
      },
    }),
    (error) => {
      assert.equal(linkCreated, true);
      assertStableFetchError(error, 'install:text:paddlepaddle');
      assertSerializedFetchErrorIsSanitized(error);
      return true;
    },
  );
});

test('PaddlePaddle download failure returns only the trusted sanitized stage', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-download-fail-');
  const raw = new Error('C:\\Users\\private\\paddle.py Authorization: Bearer secret-token Key=secret-key');
  raw.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
  raw.stage = 'download:C:\\Users\\private\\paddle.py';
  raw.cause = new Error('C:\\Users\\private\\paddle.py');
  raw.context = { authorization: 'Bearer secret-token', key: 'secret-key' };
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });

  await assert.rejects(
    installRuntime(parent, [], 'text', {
      env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
      spawnProcess: async (_command, args) => {
        if (args.includes('download')) throw raw;
        return '';
      },
    }),
    (error) => assertStableFetchError(error, 'download:text:paddlepaddle'),
  );
});

test('PaddlePaddle local wheel install failure returns only the trusted sanitized stage', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-install-fail-');
  const raw = new Error('C:\\Users\\private\\paddle.py Authorization: Bearer secret-token Key=secret-key');
  raw.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
  raw.stage = 'install:C:\\Users\\private\\paddle.py';
  raw.cause = new Error('C:\\Users\\private\\paddle.py');
  raw.context = { authorization: 'Bearer secret-token', key: 'secret-key' };
  await fsp.mkdir(path.join(parent, 'runtime', 'text'), { recursive: true });

  await assert.rejects(
    installRuntime(parent, [], 'text', {
      env: { OPENAI_API_KEY: 'secret', PATH: 'path' },
      spawnProcess: async (_command, args, options) => {
        if (args.includes('download')) {
          const dest = args[args.indexOf('--dest') + 1];
          await fsp.mkdir(path.join(options.cwd, dest), { recursive: true });
          await fsp.writeFile(path.join(options.cwd, dest, PADDLE_WHEEL_FILE), 'fixture-wheel');
          return '';
        }
        if (args.includes('--no-index')) throw raw;
        return '';
      },
    }),
    (error) => assertStableFetchError(error, 'install:text:paddlepaddle'),
  );
});

test('contract probe requires an explicit auditor Python interpreter', () => {
  assert.equal(contractProbePython({ PATH: 'path-value' }), null);
});

test('contract probe passes only the safe Python runtime environment allowlist', () => {
  const env = contractProbeEnv('repo-root', {
    PATH: 'path-value',
    SYSTEMROOT: 'system-root',
    WINDIR: 'windir',
    TEMP: 'temp',
    TMP: 'tmp',
    REDRAW_AUDITOR_PYTHON: 'python-fixture',
    OPENAI_API_KEY: 'secret',
    HTTPS_PROXY: 'proxy',
    PYTHONHOME: 'pythonhome',
    PYTHONIOENCODING: 'utf-8',
  });
  assert.deepEqual(env, {
    PATH: 'path-value',
    SystemRoot: 'system-root',
    WINDIR: 'windir',
    TEMP: 'temp',
    TMP: 'tmp',
    PYTHONPATH: path.join('repo-root', 'workers', 'redraw-full-frame-auditor', 'src'),
    PYTHONUTF8: '1',
  });
});

test('Node fetcher and Python worker expose the same v2 runtime contract', (t) => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const python = contractProbePython();
  if (!python) {
    t.skip('REDRAW_AUDITOR_PYTHON is required for the Python contract probe');
    return;
  }
  const probe = [
    'import json',
    'from redraw_full_frame_auditor import worker',
    'print(json.dumps({',
    '    "lock_schema": worker.LOCK_SCHEMA,',
    '    "runtime_names": list(worker.RUNTIME_NAMES),',
    '    "runtime_keys": list(worker.RUNTIME_KEYS),',
    '}))',
  ].join('\n');
  const result = spawnSync(python, ['-c', probe], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: contractProbeEnv(repoRoot),
  });
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  assert.equal(contract.lock_schema, 'redraw-full-frame-model-lock-v2');
  assert.deepEqual(contract.runtime_names, ['main', 'text']);
  assert.deepEqual(contract.runtime_keys, RUNTIME_KEYS);
  assert.deepEqual(
    assertPinnedFreeze(EXPECTED_MAIN_RUNTIME_FREEZE, 'win32', 'main').filter((line) => line.startsWith('protobuf==')),
    ['protobuf==4.25.9'],
  );
  assert.deepEqual(
    assertPinnedFreeze(EXPECTED_TEXT_RUNTIME_FREEZE, 'win32', 'text').filter((line) => line.startsWith('protobuf==')),
    ['protobuf==3.20.2'],
  );
  assert(!EXPECTED_MAIN_RUNTIME_FREEZE.some((line) => /^paddle(?:paddle|ocr)==/i.test(line)));
  assert(!EXPECTED_TEXT_RUNTIME_FREEZE.some((line) => /^(torch|torchvision|yolox|mediapipe)==/i.test(line)));
});

test('runProcess only trusts fixed bootstrap child stages when explicitly enabled', async (t) => {
  const script = writeBootstrapStageChild(t);
  const parseOptions = { timeoutMs: 1000, parseBootstrapErrorStage: true };
  const allowedStages = [
    'validate_lock',
    'load',
    'load:person',
    'load:tracker',
    'load:face',
    'load:text',
    'probe_frame',
    'probe',
    'probe:person',
    'probe:face',
    'probe:text',
    'probe:tracker',
    'adapter_probe',
    'close',
    'load:text:validate_lock',
    'load:text:import_cv2',
    'load:text:import_paddle',
    'load:text:build_args',
    'load:text:model_dir',
    'load:text:detector_init',
    'load:text:adapter_init',
    'load:text:output_limit',
  ];
  const fetchSource = fs.readFileSync(path.resolve(__dirname, '../scripts/fetch-redraw-full-frame-models-local.js'), 'utf8');
  const workerSource = fs.readFileSync(path.resolve(__dirname, '../../workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py'), 'utf8');
  const nodeBlock = /const PYTHON_BOOTSTRAP_SAFE_STAGES = new Set\(\[([\s\S]*?)\]\);/.exec(fetchSource);
  const pythonTextBlock = /_TEXT_LOAD_STAGES = frozenset\(\(([\s\S]*?)\)\)/.exec(workerSource);
  const pythonBootstrapBlock = /_BOOTSTRAP_STAGES = frozenset\(\(([\s\S]*?)\)\) \|/.exec(workerSource);
  assert(nodeBlock && pythonTextBlock && pythonBootstrapBlock);
  const quotedStages = (block) => Array.from(
    block.matchAll(/["']([a-z0-9_]+(?::[a-z0-9_]+)*)["']/g),
    (match) => match[1],
  );
  const nodeStages = quotedStages(nodeBlock[1]);
  const pythonTextStages = quotedStages(pythonTextBlock[1]);
  const pythonStages = [
    ...quotedStages(pythonBootstrapBlock[1]),
    ...pythonTextStages.map((stage) => `load:text:${stage}`),
  ];
  assert.equal(new Set(nodeStages).size, 22);
  assert.equal(new Set(pythonStages).size, 22);
  assert.deepEqual(nodeStages.slice().sort(), pythonStages.slice().sort());
  assert.deepEqual(allowedStages.slice().sort(), pythonStages.slice().sort());
  for (const stage of allowedStages) {
    await assert.rejects(
      runProcess(process.execPath, [script, `stage=${stage}`], parseOptions),
      (error) => assertStableFetchError(error, `bootstrap:${stage}`),
    );
  }
  await assert.rejects(
    runProcess(process.execPath, [script, 'stage=load:text:output_limit'], { timeoutMs: 1000 }),
    (error) => assertStableFetchError(error, 'unknown'),
  );
  await assert.rejects(
    runProcess(process.execPath, [script, 'bare-key'], parseOptions),
    (error) => assertStableFetchError(error, 'bootstrap:load:text'),
  );
  for (const mode of [
    'stage=load:unknown',
    'stage=load:text:unknown',
    'stage=load:text:output_limit:extra',
    'stage=load:text:output_limit extra',
    'stage=load:text:/private',
    'not-last',
    'sensitive=auth',
    'sensitive=auth_short',
    'sensitive=bearer',
    'sensitive=key',
    'sensitive=api_dash_key',
    'sensitive=api_underscore_key',
    'sensitive=api_space_key',
    'sensitive=token',
    'sensitive=password',
    'sensitive=credential',
    'sensitive=proxy',
    'sensitive=secret',
    'sensitive=sensitive',
    'sensitive=path',
  ]) {
    await assert.rejects(
      runProcess(process.execPath, [script, mode], parseOptions),
      (error) => assertStableFetchError(error, 'unknown'),
    );
  }
  await assert.rejects(
    runProcess(process.execPath, [script, 'huge'], { ...parseOptions, stderrMaxBytes: 256 }),
    (error) => assertStableFetchError(error, 'unknown'),
  );
  assert.equal(await runProcess(process.execPath, [script, 'zero'], parseOptions), '');

  const parent = tempDir(t, 'redraw-bootstrap-stage-wrapper-');
  const withChild = (mode) => bootstrapWorker(parent, path.join(parent, 'model-lock.json'), {
    env: process.env,
    spawnProcess: async (_command, _args, options) => runProcess(process.execPath, [script, mode], options),
  });
  await assert.rejects(
    withChild('stage=load:text:output_limit'),
    (error) => assertStableFetchError(error, 'bootstrap:load:text:output_limit'),
  );
  await assert.rejects(
    withChild('stage=load:unknown'),
    (error) => assertStableFetchError(error, 'bootstrap'),
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
  const shellLiteral = 'redraw&echo REDRAW_SHELL_WAS_USED';
  const argvProbe = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', shellLiteral],
    { timeoutMs: 1000 },
  );
  assert.equal(argvProbe, JSON.stringify([shellLiteral]));
  assert.deepEqual(JSON.parse(argvProbe), [shellLiteral]);
  await assert.rejects(runProcess(process.execPath, [script, 'stderr'], { timeoutMs: 1000 }), /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/);
  await assert.rejects(runProcess(process.execPath, [script, 'timeout'], { timeoutMs: 50 }), /REDRAW_FULL_FRAME_MODEL_UNAVAILABLE/);
});
