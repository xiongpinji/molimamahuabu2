#!/usr/bin/env node
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validateModelLock } = require('../src/services/redrawFullFrameModelLockService');
const sourcePolicy = require('../config/redraw-full-frame-model-sources.json');

const OUTPUT_ERROR = 'REDRAW_FULL_FRAME_OUTPUT_INVALID';
const MODEL_ERROR = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
const COMPONENT_ORDER = ['face_detector', 'person_detector', 'text_detector', 'tracker'];
const ALLOWED_HTTPS_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'codeload.github.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  'storage.googleapis.com',
  'paddleocr.bj.bcebos.com',
  'files.pythonhosted.org',
  'pypi.org',
]);
const OFFICIAL_CATALOG = Object.freeze({
  face_detector: Object.freeze({
    repository: 'google-ai-edge/mediapipe',
    revision: '4cf89a70942ca3252e46ace7e4552f53be9bef2e',
    artifactUrl: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    artifactName: 'blaze_face_short_range.tflite',
    licensePath: 'LICENSE',
  }),
  person_detector: Object.freeze({
    repository: 'Megvii-BaseDetection/YOLOX',
    revision: 'e1052df71842031413f6030723c3607b839c80ce',
    artifactUrl: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.pth',
    artifactName: 'yolox_s.pth',
    licensePath: 'LICENSE',
  }),
  text_detector: Object.freeze({
    repository: 'PaddlePaddle/PaddleOCR',
    revision: '40c56628fda416e1c8710eb19e4b260536902520',
    artifactUrl: 'https://paddleocr.bj.bcebos.com/PP-OCRv3/english/en_PP-OCRv3_det_infer.tar',
    artifactName: 'en_PP-OCRv3_det_infer.tar',
    licensePath: 'LICENSE',
  }),
  tracker: Object.freeze({
    repository: 'FoundationVision/ByteTrack',
    revision: 'd1bf0191adff59bc8fcfeaa0b33d3d1642552a99',
    artifactUrl: 'https://codeload.github.com/FoundationVision/ByteTrack/zip/d1bf0191adff59bc8fcfeaa0b33d3d1642552a99',
    artifactName: 'bytetrack-source.zip',
    licensePath: 'LICENSE',
  }),
});
const RUNTIME_PACKAGES = Object.freeze([
  'setuptools==80.9.0',
  'wheel==0.43.0',
  'numpy==1.26.4',
  'opencv-python-headless==4.10.0.84',
  'torch==2.3.1',
  'yolox==0.3.0',
  'mediapipe==0.10.14',
  'paddlepaddle==2.6.2',
  'paddleocr==2.8.1',
]);
const JSON_MAX_BYTES = 2 * 1024 * 1024;
const LICENSE_MAX_BYTES = 2 * 1024 * 1024;
const ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
const PROCESS_STDOUT_MAX_BYTES = 4 * 1024 * 1024;
const PROCESS_STDERR_MAX_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;

function error(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function sanitizeEnv(env = process.env) {
  const safe = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (Object.prototype.hasOwnProperty.call(env, key)) safe[key] = env[key];
  }
  safe.PYTHONUTF8 = '1';
  return safe;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length !== 2 || argv[0] !== '--output-dir' || !argv[1]) throw error(OUTPUT_ERROR);
  assertSafeOutputDirArg(argv[1]);
  return { outputDir: argv[1] };
}

function assertSafeOutputDirArg(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw error(OUTPUT_ERROR);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) throw error(OUTPUT_ERROR);
  if (/(^|[?&#;_\-\s])(api[_-]?key|authorization|token|secret)=/i.test(value)) throw error(OUTPUT_ERROR);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function assertEmptyOrMissing(outputDir) {
  if (typeof outputDir !== 'string' || !outputDir) throw error(OUTPUT_ERROR);
  if (await exists(outputDir)) {
    const stat = await fsp.stat(outputDir);
    if (!stat.isDirectory()) throw error(OUTPUT_ERROR);
    const entries = await fsp.readdir(outputDir);
    if (entries.length > 0) throw error(OUTPUT_ERROR);
  }
}

function randomHex() {
  return crypto.randomBytes(16).toString('hex');
}

async function writeFileAtomic(target, bytes) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomHex()}.tmp`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, target);
}

function assertPinnedFreeze(lines) {
  if (!Array.isArray(lines)) throw error(MODEL_ERROR);
  const sorted = lines.filter((line) => line.length > 0).slice().sort((a, b) => a.localeCompare(b));
  for (const line of sorted) {
    if (!/^[A-Za-z0-9_.-]+==[A-Za-z0-9_.!+-]+$/.test(line)) throw error(MODEL_ERROR);
  }
  return sorted;
}

function assertAllowedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw error(MODEL_ERROR);
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HTTPS_HOSTS.has(parsed.hostname)) throw error(MODEL_ERROR);
  return parsed;
}

function assertCommitSha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw error(MODEL_ERROR);
  return value.toLowerCase();
}

function assertNonFloating(value) {
  if (typeof value !== 'string' || !value || /(^|[^a-z0-9])(latest|main|master|placeholder|unknown|todo)([^a-z0-9]|$)/i.test(value)) {
    throw error(MODEL_ERROR);
  }
  return value;
}

function requestBuffer(rawUrl, redirects = 0, maxBytes = ARTIFACT_MAX_BYTES) {
  const parsed = assertAllowedUrl(rawUrl);
  if (redirects > 5) return Promise.reject(error(MODEL_ERROR));
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(error(MODEL_ERROR));
    };
    const req = https.get(parsed, { headers: { 'User-Agent': 'moli-redraw-full-frame-bootstrap' } }, (res) => {
      const status = res.statusCode || 0;
      const contentLength = Number(res.headers['content-length'] || 0);
      if (contentLength > maxBytes) {
        res.destroy();
        fail();
        return;
      }
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location;
        res.resume();
        if (!location) {
          reject(error(MODEL_ERROR));
          return;
        }
        const redirected = new URL(location, parsed).toString();
        try {
          assertAllowedUrl(redirected);
        } catch (err) {
          reject(err);
          return;
        }
        requestBuffer(redirected, redirects + 1, maxBytes).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(error(MODEL_ERROR));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          fail();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('error', fail);
    req.setTimeout(30000, () => {
      req.destroy();
      fail();
    });
  });
}

async function requestJson(rawUrl) {
  const bytes = await requestBuffer(rawUrl, 0, JSON_MAX_BYTES);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    throw error(MODEL_ERROR);
  }
}

async function requestBytes(rawUrl) {
  return requestBuffer(rawUrl, 0, ARTIFACT_MAX_BYTES);
}

async function resolveOfficialComponent(source, deps = {}) {
  const catalog = OFFICIAL_CATALOG[source.component];
  if (!catalog || catalog.repository !== source.repository || catalog.licensePath !== source.license_path) throw error(MODEL_ERROR);
  const jsonRequest = deps.requestJson || requestJson;
  const bytesRequest = deps.requestBytes || requestBytes;
  const expectedRevision = assertCommitSha(catalog.revision);
  const commit = await jsonRequest(`https://api.github.com/repos/${catalog.repository}/commits/${expectedRevision}`);
  const revision = assertCommitSha(commit.sha);
  if (revision !== expectedRevision) throw error(MODEL_ERROR);
  const artifactUrl = assertAllowedUrl(catalog.artifactUrl).toString();
  if (artifactUrl !== catalog.artifactUrl) throw error(MODEL_ERROR);
  const licenseUrl = `https://raw.githubusercontent.com/${catalog.repository}/${revision}/${catalog.licensePath}`;
  const artifactBytes = await bytesRequest(artifactUrl);
  const licenseBytes = deps.requestBytes ? await bytesRequest(licenseUrl) : await requestBuffer(licenseUrl, 0, LICENSE_MAX_BYTES);
  if (!Buffer.isBuffer(artifactBytes) && !(artifactBytes instanceof Uint8Array)) throw error(MODEL_ERROR);
  if (!Buffer.isBuffer(licenseBytes) && !(licenseBytes instanceof Uint8Array)) throw error(MODEL_ERROR);
  if (artifactBytes.length === 0 || licenseBytes.length === 0) throw error(MODEL_ERROR);
  return {
    revision,
    artifact_name: catalog.artifactName,
    artifact_bytes: Buffer.from(artifactBytes),
    license_name: `${source.component}-LICENSE.txt`,
    license_bytes: Buffer.from(licenseBytes),
  };
}

function assertComponentEvidence(source, evidence) {
  if (!evidence || typeof evidence !== 'object') throw error(MODEL_ERROR);
  for (const key of ['revision', 'artifact_name', 'artifact_bytes', 'license_name', 'license_bytes']) {
    if (!(key in evidence)) throw error(MODEL_ERROR);
  }
  if (!evidence.revision || /(^|[^a-z0-9])(latest|main|master|placeholder|unknown|todo)([^a-z0-9]|$)/i.test(evidence.revision)) throw error(MODEL_ERROR);
  if (!evidence.artifact_name || !evidence.license_name) throw error(MODEL_ERROR);
  if (!Buffer.isBuffer(evidence.artifact_bytes) && !(evidence.artifact_bytes instanceof Uint8Array)) throw error(MODEL_ERROR);
  if (!Buffer.isBuffer(evidence.license_bytes) && !(evidence.license_bytes instanceof Uint8Array)) throw error(MODEL_ERROR);
  return {
    component: source.component,
    project: source.project,
    repository: source.repository,
    revision: evidence.revision,
    artifact_name: evidence.artifact_name,
    artifact_path: `models/${source.component}/${evidence.artifact_name}`,
    artifact_bytes: Buffer.from(evidence.artifact_bytes),
    license_name: evidence.license_name,
    license_evidence_path: `licenses/${source.component}/${evidence.license_name}`,
    license_bytes: Buffer.from(evidence.license_bytes),
  };
}

function defaultDeps() {
  return {
    randomHex,
    fetchComponent: resolveOfficialComponent,
    createVenv,
    installRuntime,
    pipFreeze,
    pythonVersion,
    bootstrapWorker,
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || sanitizeEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const finishReject = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error(MODEL_ERROR));
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stdout.trim());
    };
    const timer = setTimeout(finishReject, options.timeoutMs || PROCESS_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > (options.stdoutMaxBytes || PROCESS_STDOUT_MAX_BYTES)) {
        finishReject();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > (options.stderrMaxBytes || PROCESS_STDERR_MAX_BYTES)) {
        finishReject();
      }
    });
    child.on('error', finishReject);
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) finishReject();
      else finishResolve();
    });
  });
}

function spawnProcess(command, args, options) {
  return runProcess(command, args, options);
}

function runtimePython(deps = {}) {
  const env = deps.env || process.env;
  const python = env.REDRAW_AUDITOR_PYTHON;
  if (typeof python !== 'string' || python.length === 0) throw error(MODEL_ERROR);
  return python;
}

function venvPython(staging) {
  return process.platform === 'win32'
    ? path.join(staging, '.venv', 'Scripts', 'python.exe')
    : path.join(staging, '.venv', 'bin', 'python');
}

async function createVenv(staging, deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  await runner(runtimePython(deps), ['-m', 'venv', '.venv'], { cwd: staging, env: sanitizeEnv(deps.env) });
}

async function installRuntime(staging, _components = [], deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  const python = venvPython(staging);
  for (const requirement of RUNTIME_PACKAGES) {
    if (!/^[A-Za-z0-9_.-]+==[A-Za-z0-9_.!+-]+$/.test(requirement)) throw error(MODEL_ERROR);
    await runner(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', requirement], { cwd: staging, env: sanitizeEnv(deps.env) });
  }
}

async function pipFreeze(staging, deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  const output = await runner(venvPython(staging), ['-m', 'pip', 'freeze'], { cwd: staging, env: sanitizeEnv(deps.env) });
  return assertPinnedFreeze(String(output).split(/\r?\n/));
}

async function pythonVersion(staging, deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  return String(await runner(venvPython(staging), ['--version'], { cwd: staging, env: sanitizeEnv(deps.env) })).trim();
}

async function bootstrapWorker(staging, _modelLockPath, deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  const worker = path.resolve(__dirname, '../../workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py');
  await runner(venvPython(staging), [worker, 'bootstrap', '--model-lock', path.join(staging, 'model-lock.json')], { cwd: staging, env: sanitizeEnv(deps.env) });
}

async function runFetchModels(options, injectedDeps = {}) {
  const deps = { ...defaultDeps(), ...injectedDeps };
  const outputDir = path.resolve(options.outputDir);
  await assertEmptyOrMissing(outputDir);
  const parent = path.dirname(outputDir);
  await fsp.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.redraw-full-frame-staging-${deps.randomHex()}`);
  let complete = false;
  try {
    await fsp.mkdir(staging, { recursive: false });
    const byComponent = new Map(sourcePolicy.sources.map((source) => [source.component, source]));
    const components = [];
    for (const componentName of COMPONENT_ORDER) {
      const source = byComponent.get(componentName);
      if (!source) throw error(MODEL_ERROR);
      const evidence = assertComponentEvidence(source, await deps.fetchComponent(source));
      await writeFileAtomic(path.join(staging, evidence.artifact_path), evidence.artifact_bytes);
      await writeFileAtomic(path.join(staging, evidence.license_evidence_path), evidence.license_bytes);
      components.push({
        component: evidence.component,
        project: evidence.project,
        repository: evidence.repository,
        revision: evidence.revision,
        artifact_name: evidence.artifact_name,
        artifact_path: evidence.artifact_path,
        artifact_sha256: sha256(evidence.artifact_bytes),
        license_name: evidence.license_name,
        license_evidence_path: evidence.license_evidence_path,
        license_evidence_sha256: sha256(evidence.license_bytes),
      });
    }
    await deps.createVenv(staging);
    await deps.installRuntime(staging, components);
    const freeze = assertPinnedFreeze(await deps.pipFreeze(staging));
    const pythonVersion = await deps.pythonVersion(staging);
    await writeFileAtomic(path.join(staging, 'runtime', 'pip-freeze.txt'), Buffer.from(`${freeze.join('\n')}\n`));
    const lock = {
      schema_version: 'redraw-full-frame-model-lock-v1',
      runtime: { python_version: pythonVersion, pip_freeze: freeze },
      components,
    };
    await writeFileAtomic(path.join(staging, 'model-lock.json'), Buffer.from(`${JSON.stringify(lock, null, 2)}\n`));
    await deps.bootstrapWorker(staging, path.join(staging, 'model-lock.json'));
    const validated = await validateModelLock({ cacheRoot: staging, sourcePolicy, lock });
    await assertEmptyOrMissing(outputDir);
    if (await exists(outputDir)) await fsp.rmdir(outputDir);
    await fsp.rename(staging, outputDir);
    complete = true;
    return {
      canonical_sha256: validated.canonical_sha256,
      components: validated.components.map((component) => component.component),
      runtime_lock: 'runtime/pip-freeze.txt',
    };
  } catch (err) {
    if (err && (err.code === OUTPUT_ERROR || err.code === MODEL_ERROR)) throw err;
    throw error(MODEL_ERROR);
  } finally {
    if (!complete) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write('Usage: fetch-redraw-full-frame-models-local --output-dir <empty-or-missing-dir>\n');
      return 0;
    }
    const result = await runFetchModels({ outputDir: args.outputDir });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    const code = err && err.code === OUTPUT_ERROR ? OUTPUT_ERROR : MODEL_ERROR;
    process.stderr.write(`${code}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((code) => { process.exitCode = code; });
}

module.exports = {
  parseArgs,
  resolveOfficialComponent,
  venvPython,
  runProcess,
  createVenv,
  installRuntime,
  pipFreeze,
  pythonVersion,
  bootstrapWorker,
  runFetchModels,
  runCli,
};
