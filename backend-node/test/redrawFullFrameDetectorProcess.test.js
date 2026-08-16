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
  assertAllowedUrl,
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

  const bootstrapFailed = path.join(parent, 'bootstrap-failed');
  const rawBootstrapError = new Error('C:\\Users\\private\\model-lock.json Authorization: Bearer secret-token Key=secret-key');
  rawBootstrapError.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
  rawBootstrapError.cause = new Error('C:\\Users\\private\\worker.py');
  rawBootstrapError.context = { authorization: 'Bearer secret-token', key: 'secret-key' };
  await assert.rejects(runFetchModels({
    outputDir: bootstrapFailed,
  }, {
    ...deps,
    randomHex: () => 'bootstrap123',
    bootstrapWorker: async () => { throw rawBootstrapError; },
  }), (error) => {
    assert.equal(error.code, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE');
    assert.equal(error.message, 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE');
    assert.deepEqual(Object.keys(error), ['code']);
    assert.equal(error.cause, undefined);
    assert.equal(error.context, undefined);
    assert.doesNotMatch(JSON.stringify(error), /private|Authorization|secret-token|secret-key|model-lock|worker\.py/i);
    return true;
  });
  assert.equal(fs.existsSync(bootstrapFailed), false);
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
  assert(installArgs.includes('numpy==1.26.4'));
  assert(installArgs.includes('opencv-python-headless==4.10.0.84'));
  assert(installArgs.includes('torch==2.3.1'));
  assert(installArgs.includes('torchvision==0.18.1'));
  assert(installArgs.includes('mediapipe==0.10.14'));
  assert(installArgs.includes('paddlepaddle==2.6.2'));
  assert(installArgs.includes('paddleocr==2.8.1'));
  assert(installArgs.includes('Cython==3.2.9'));
  assert(installArgs.includes('cython-bbox==0.1.5'));
  assert(installArgs.includes('yolox==0.3.0'));
  assert(installArgs.includes('pycocotools==2.0.11'));
  assert(installArgs.includes('loguru==0.7.2'));
  assert(installArgs.includes('tabulate==0.9.0'));
  assert(installArgs.includes('thop==0.1.1.post2209072238'));
  assert(installArgs.includes('lap==0.5.13'));
  assert(installArgs.every((arg) => /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.!+-]+$/.test(arg)));
  const yoloxInstallCalls = installCalls.filter((call) => call.args.includes('yolox==0.3.0'));
  assert.equal(yoloxInstallCalls.length, 1);
  assert(yoloxInstallCalls[0].args.includes('--no-deps'), JSON.stringify(yoloxInstallCalls[0]));
  assert(installCalls
    .filter((call) => !call.args.includes('yolox==0.3.0'))
    .every((call) => !call.args.includes('--no-deps')), JSON.stringify(installCalls));

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
