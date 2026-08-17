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
const PYPI_INDEX_URL = 'https://pypi.org/simple';
const RUNTIME_NAMES = Object.freeze(['main', 'text']);
const MAIN_RUNTIME_PACKAGE_SPECS = Object.freeze([
  Object.freeze({ requirement: 'setuptools==80.9.0' }),
  Object.freeze({ requirement: 'wheel==0.43.0' }),
  Object.freeze({ requirement: 'numpy==1.26.4' }),
  Object.freeze({ requirement: 'protobuf==4.25.9' }),
  Object.freeze({ requirement: 'Pillow==11.3.0' }),
  Object.freeze({ requirement: 'six==1.17.0' }),
  Object.freeze({ requirement: 'absl-py==2.5.0' }),
  Object.freeze({ requirement: 'attrs==26.1.0' }),
  Object.freeze({ requirement: 'flatbuffers==25.12.19' }),
  Object.freeze({ requirement: 'matplotlib==3.11.1' }),
  Object.freeze({ requirement: 'sounddevice==0.5.5' }),
  Object.freeze({ requirement: 'opencv-python-headless==4.10.0.84' }),
  Object.freeze({ requirement: 'torch==2.3.1' }),
  Object.freeze({ requirement: 'torchvision==0.18.1' }),
  Object.freeze({ requirement: 'yolox==0.3.0', noDeps: true }),
  Object.freeze({ requirement: 'pycocotools==2.0.11' }),
  Object.freeze({ requirement: 'loguru==0.7.2' }),
  Object.freeze({ requirement: 'tabulate==0.9.0' }),
  Object.freeze({ requirement: 'thop==0.1.1.post2209072238' }),
  Object.freeze({ requirement: 'lap==0.5.13' }),
  Object.freeze({ requirement: 'Cython==3.2.9' }),
  Object.freeze({ requirement: 'cython-bbox==0.1.5' }),
  Object.freeze({ requirement: 'mediapipe==0.10.14', noDeps: true }),
]);
const TEXT_RUNTIME_PACKAGE_SPECS = Object.freeze([
  Object.freeze({ requirement: 'setuptools==80.9.0' }),
  Object.freeze({ requirement: 'wheel==0.43.0' }),
  Object.freeze({ requirement: 'numpy==1.26.4' }),
  Object.freeze({ requirement: 'protobuf==3.20.2' }),
  Object.freeze({ requirement: 'Pillow==11.3.0' }),
  Object.freeze({ requirement: 'six==1.17.0' }),
  Object.freeze({ requirement: 'scipy==1.17.1' }),
  Object.freeze({ requirement: 'imageio==2.37.4' }),
  Object.freeze({ requirement: 'tifffile==2026.3.3' }),
  Object.freeze({ requirement: 'scikit-image==0.26.0' }),
  Object.freeze({ requirement: 'Shapely==2.1.2' }),
  Object.freeze({ requirement: 'pyclipper==1.4.0' }),
  Object.freeze({ requirement: 'lmdb==2.3.0' }),
  Object.freeze({ requirement: 'tqdm==4.68.1' }),
  Object.freeze({ requirement: 'requests==2.33.0' }),
  Object.freeze({ requirement: 'httpx==0.27.0' }),
  Object.freeze({ requirement: 'decorator==5.3.1' }),
  Object.freeze({ requirement: 'astor==0.8.1' }),
  Object.freeze({ requirement: 'opt-einsum==3.3.0' }),
  Object.freeze({ requirement: 'opencv-python-headless==4.10.0.84' }),
  Object.freeze({ requirement: 'imgaug==0.4.0', noDeps: true }),
  Object.freeze({ requirement: 'paddlepaddle==2.6.2', noDeps: true }),
  Object.freeze({ requirement: 'beautifulsoup4==4.15.0' }),
  Object.freeze({ requirement: 'fire==0.7.1' }),
  Object.freeze({ requirement: 'lxml==6.1.1' }),
  Object.freeze({ requirement: 'python-docx==1.2.0' }),
  Object.freeze({ requirement: 'PyYAML==6.0.3' }),
  Object.freeze({ requirement: 'RapidFuzz==3.14.5' }),
  Object.freeze({ requirement: 'soupsieve==2.9.2' }),
  Object.freeze({ requirement: 'termcolor==3.3.0' }),
  Object.freeze({ requirement: 'paddleocr==2.8.1', noDeps: true }),
]);
const RUNTIME_PACKAGE_SPECS = Object.freeze({
  main: MAIN_RUNTIME_PACKAGE_SPECS,
  text: TEXT_RUNTIME_PACKAGE_SPECS,
});
const PADDLE_WHEEL_RUNTIME = 'text';
const PADDLE_WHEEL_REQUIREMENT = 'paddlepaddle==2.6.2';
const PADDLE_WHEEL_RELATIVE_DIR = 'runtime/text/.wheel-stage/paddlepaddle';
const PADDLE_WHEEL_NAME = 'paddlepaddle-2.6.2-cp312-cp312-win_amd64.whl';
const NO_DEPS_REQUIREMENTS = new Set([
  'yolox==0.3.0',
  'imgaug==0.4.0',
  'mediapipe==0.10.14',
  'paddlepaddle==2.6.2',
  'paddleocr==2.8.1',
]);
const NO_DEPS_PACKAGE_NAMES = new Set(['yolox', 'imgaug', 'mediapipe', 'paddlepaddle', 'paddleocr']);
const MAIN_RUNTIME_FREEZE_ALLOWED_TRANSITIVE_SPECS = new Map([
  ['cffi', '2.1.1'],
  ['colorama', '0.4.6'],
  ['contourpy', '1.3.3'],
  ['cycler', '0.12.1'],
  ['filelock', '3.32.3'],
  ['fonttools', '4.63.0'],
  ['fsspec', '2026.7.0'],
  ['intel-openmp', '2021.4.0'],
  ['jinja2', '3.1.6'],
  ['kiwisolver', '1.5.0'],
  ['markupsafe', '3.0.3'],
  ['mkl', '2021.4.0'],
  ['mpmath', '1.3.0'],
  ['networkx', '3.6.1'],
  ['packaging', '26.3'],
  ['pycparser', '3.0'],
  ['pyparsing', '3.3.2'],
  ['python-dateutil', '2.9.0.post0'],
  ['sympy', '1.14.0'],
  ['tbb', '2021.13.1'],
  ['typing-extensions', '4.16.0'],
  ['win32-setctime', '1.2.0'],
]);
const TEXT_RUNTIME_FREEZE_ALLOWED_TRANSITIVE_SPECS = new Map([
  ['anyio', '4.14.2'],
  ['certifi', '2026.7.22'],
  ['charset-normalizer', '3.5.1'],
  ['h11', '0.16.0'],
  ['httpcore', '1.0.9'],
  ['idna', '3.18'],
  ['lazy-loader', '0.5'],
  ['networkx', '3.6.1'],
  ['packaging', '26.3'],
  ['sniffio', '1.3.1'],
  ['typing-extensions', '4.16.0'],
  ['urllib3', '2.7.0'],
]);
const RUNTIME_FREEZE_ALLOWED_TRANSITIVE_SPECS = Object.freeze({
  main: MAIN_RUNTIME_FREEZE_ALLOWED_TRANSITIVE_SPECS,
  text: TEXT_RUNTIME_FREEZE_ALLOWED_TRANSITIVE_SPECS,
});
const WINDOWS_ONLY_RUNTIME_TRANSITIVE_NAMES = new Set([
  'colorama',
  'intel-openmp',
  'mkl',
  'tbb',
  'win32-setctime',
]);
const FORBIDDEN_RUNTIME_PACKAGES = new Set([
  'opencv-python',
  'opencv-contrib-python',
  'jax',
  'jaxlib',
  'ml-dtypes',
]);
const JSON_MAX_BYTES = 2 * 1024 * 1024;
const LICENSE_MAX_BYTES = 2 * 1024 * 1024;
const ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
const PROCESS_STDOUT_MAX_BYTES = 4 * 1024 * 1024;
const PROCESS_STDERR_MAX_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const TRUSTED_SANITIZED_ERROR = Symbol('trustedSanitizedError');
const PYTHON_BOOTSTRAP_SAFE_STAGES = new Set([
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
]);
const FIXED_RUNTIME_STAGES = new Set([
  'unknown',
  'python_preflight',
  'write_model_lock',
  'bootstrap',
  'validate',
  'publish',
]);
const RUNTIME_PACKAGE_STAGE_NAMES = new Set(Object.values(RUNTIME_PACKAGE_SPECS).flat().map((spec) => (
  spec.requirement.slice(0, spec.requirement.indexOf('==')).toLowerCase().replace(/[-_.]+/g, '-')
)));

function normalizeStage(stage) {
  if (typeof stage !== 'string') return 'unknown';
  if (FIXED_RUNTIME_STAGES.has(stage)) return stage;
  if (stage === 'download:text:paddlepaddle') return stage;
  if (stage.startsWith('fetch:') && COMPONENT_ORDER.includes(stage.slice('fetch:'.length))) return stage;
  if (stage.startsWith('bootstrap:') && PYTHON_BOOTSTRAP_SAFE_STAGES.has(stage.slice('bootstrap:'.length))) return stage;
  const runtimeStage = /^(create_venv|freeze|python_version|write_runtime_lock):(main|text)$/.exec(stage);
  if (runtimeStage) return stage;
  const install = /^install:(main|text):([A-Za-z0-9_.-]+)$/.exec(stage);
  if (!install) return 'unknown';
  const packageName = install[2].toLowerCase().replace(/[-_.]+/g, '-');
  return RUNTIME_PACKAGE_STAGE_NAMES.has(packageName) ? `install:${install[1]}:${packageName}` : 'unknown';
}

function error(code, stage = 'unknown') {
  const err = new Error(code);
  err.code = code;
  Object.defineProperty(err, 'stage', { value: normalizeStage(stage), enumerable: false });
  return err;
}

function sanitizedError(err, fallbackStage = 'unknown') {
  const code = err && err.code === OUTPUT_ERROR ? OUTPUT_ERROR : MODEL_ERROR;
  const sourceStage = err && err[TRUSTED_SANITIZED_ERROR] === true
    ? normalizeStage(err.stage)
    : 'unknown';
  const safe = error(code, sourceStage === 'unknown' ? normalizeStage(fallbackStage) : sourceStage);
  Object.defineProperty(safe, TRUSTED_SANITIZED_ERROR, { value: true, enumerable: false });
  return safe;
}

function parseBootstrapErrorStage(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) return null;
  if (/(?:auth|authorization|bearer|token|password|credential|proxy|sensitive|secret|path|(?:api[-_ ]?key|secret[-_ ]?key|\bkey\s*[:=])|https?:\/\/|[A-Za-z]:[\\/]|(?:^|[\s"'(])\/[^\s])/im.test(stderr)) return null;
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const prefix = `${MODEL_ERROR} stage=`;
  const lastLine = lines[lines.length - 1];
  if (!lastLine.startsWith(prefix)) return null;
  const candidate = lastLine.slice(prefix.length);
  if (!/^[a-z0-9_]+(?::[a-z0-9_]+){0,2}$/.test(candidate)) return null;
  if (!PYTHON_BOOTSTRAP_SAFE_STAGES.has(candidate)) return null;
  return `bootstrap:${candidate}`;
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

function normalizePackageName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function splitRequirement(requirement) {
  const match = /^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.!+-]+)$/.exec(requirement);
  if (!match) throw error(MODEL_ERROR);
  return { name: normalizePackageName(match[1]), version: match[2] };
}

function assertRuntimeName(runtimeName) {
  if (!RUNTIME_NAMES.includes(runtimeName)) throw error(MODEL_ERROR);
  return runtimeName;
}

function assertPinnedFreeze(lines, platform = process.platform, runtimeName = 'main') {
  assertRuntimeName(runtimeName);
  if (!Array.isArray(lines) || typeof platform !== 'string' || platform.length === 0) throw error(MODEL_ERROR);
  const sorted = lines.filter((line) => line.length > 0).slice().sort((a, b) => a.localeCompare(b));
  const installed = new Map();
  for (const line of sorted) {
    const requirement = splitRequirement(line);
    if (FORBIDDEN_RUNTIME_PACKAGES.has(requirement.name) || installed.has(requirement.name)) throw error(MODEL_ERROR);
    installed.set(requirement.name, requirement.version);
  }
  const requiredNames = new Set();
  for (const spec of RUNTIME_PACKAGE_SPECS[runtimeName]) {
    const required = splitRequirement(spec.requirement);
    if (requiredNames.has(required.name) || installed.get(required.name) !== required.version) throw error(MODEL_ERROR);
    requiredNames.add(required.name);
  }
  for (const [installedName, installedVersion] of installed.entries()) {
    if (requiredNames.has(installedName)) continue;
    if (RUNTIME_FREEZE_ALLOWED_TRANSITIVE_SPECS[runtimeName].get(installedName) !== installedVersion) throw error(MODEL_ERROR);
    if (runtimeName === 'main' && WINDOWS_ONLY_RUNTIME_TRANSITIVE_NAMES.has(installedName) && platform !== 'win32') throw error(MODEL_ERROR);
  }
  return sorted;
}

function normalizeRuntimePackageSpecs(runtimeName) {
  assertRuntimeName(runtimeName);
  const specs = RUNTIME_PACKAGE_SPECS[runtimeName];
  return specs.map((spec) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw error(MODEL_ERROR);
    const keys = Object.keys(spec).sort();
    if (!keys.every((key) => key === 'noDeps' || key === 'requirement')) throw error(MODEL_ERROR);
    if (typeof spec.requirement !== 'string') throw error(MODEL_ERROR);
    const requirement = splitRequirement(spec.requirement);
    if (FORBIDDEN_RUNTIME_PACKAGES.has(requirement.name)) throw error(MODEL_ERROR);
    if (spec.noDeps !== undefined && spec.noDeps !== true) throw error(MODEL_ERROR);
    const mustUseNoDeps = NO_DEPS_REQUIREMENTS.has(spec.requirement);
    if (NO_DEPS_PACKAGE_NAMES.has(requirement.name) && !mustUseNoDeps) throw error(MODEL_ERROR);
    if (mustUseNoDeps !== (spec.noDeps === true)) throw error(MODEL_ERROR);
    return { requirement: spec.requirement, noDeps: spec.noDeps === true };
  });
}

function isPaddleWheelSpec(runtimeName, spec) {
  return runtimeName === PADDLE_WHEEL_RUNTIME
    && spec.requirement === PADDLE_WHEEL_REQUIREMENT
    && spec.noDeps === true;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameResolvedPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function readPaddleWheelEvidence(staging, wheelDir) {
  const expectedRelativeDir = PADDLE_WHEEL_RELATIVE_DIR.split('/').join(path.sep);
  const stagingRoot = path.resolve(staging);
  const wheelDirPath = path.resolve(wheelDir);
  if (path.relative(stagingRoot, wheelDirPath) !== expectedRelativeDir) throw error(MODEL_ERROR);

  const realStaging = await fsp.realpath(stagingRoot);
  const wheelDirStat = await fsp.lstat(wheelDirPath, { bigint: true });
  if (!wheelDirStat.isDirectory() || wheelDirStat.isSymbolicLink()) throw error(MODEL_ERROR);
  const realWheelDir = await fsp.realpath(wheelDirPath);
  if (!sameResolvedPath(realWheelDir, path.join(realStaging, expectedRelativeDir))) throw error(MODEL_ERROR);

  const entries = await fsp.readdir(wheelDirPath, { withFileTypes: true });
  if (entries.length !== 1) throw error(MODEL_ERROR);
  const entry = entries[0];
  if (!entry.isFile() || entry.isSymbolicLink() || entry.name !== PADDLE_WHEEL_NAME) throw error(MODEL_ERROR);

  const relativePath = `${PADDLE_WHEEL_RELATIVE_DIR}/${entry.name}`;
  if (relativePath.replace(/\\/g, '/') !== `${PADDLE_WHEEL_RELATIVE_DIR}/${entry.name}`) throw error(MODEL_ERROR);
  const absPath = path.join(stagingRoot, relativePath);
  const pathStat = await fsp.lstat(absPath, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n) throw error(MODEL_ERROR);
  const realPath = await fsp.realpath(absPath);
  if (!sameResolvedPath(path.dirname(realPath), realWheelDir)) throw error(MODEL_ERROR);
  return {
    relativePath,
    absPath,
    realDir: realWheelDir,
    realPath,
    pathStat,
  };
}

async function revalidatePaddleWheelEvidence(evidence) {
  const pathStat = await fsp.lstat(evidence.absPath, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n) throw error(MODEL_ERROR);
  const realPath = await fsp.realpath(evidence.absPath);
  if (!sameResolvedPath(realPath, evidence.realPath)) throw error(MODEL_ERROR);
  if (!sameResolvedPath(path.dirname(realPath), evidence.realDir)) throw error(MODEL_ERROR);
  if (!sameFileIdentity(pathStat, evidence.pathStat)) throw error(MODEL_ERROR);
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
    preflightRuntimePython,
    fetchComponent: resolveOfficialComponent,
    createVenv,
    installRuntime,
    pipFreeze,
    pythonVersion,
    bootstrapWorker,
    validateModelLock,
    publishCache,
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
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const finishReject = (bootstrapStage = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(bootstrapStage
        ? sanitizedError(error(MODEL_ERROR), bootstrapStage)
        : error(MODEL_ERROR));
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
        stderr = '';
        finishReject();
        return;
      }
      if (options.parseBootstrapErrorStage === true) stderr += chunk;
    });
    child.on('error', () => finishReject());
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finishReject(options.parseBootstrapErrorStage === true ? parseBootstrapErrorStage(stderr) : null);
      }
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

async function preflightRuntimePython(deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  try {
    const python = runtimePython(deps);
    if (!path.isAbsolute(python)) throw error(MODEL_ERROR);
    const version = String(await runner(python, ['--version'], {
      cwd: path.resolve(__dirname, '../..'),
      env: sanitizeEnv(deps.env),
    })).trim();
    if (!/^Python 3\.12\.[0-9]+$/.test(version)) throw error(MODEL_ERROR);
    return python;
  } catch (err) {
    throw sanitizedError(err, 'python_preflight');
  }
}

function runtimeInterpreterPath(runtimeName) {
  assertRuntimeName(runtimeName);
  return process.platform === 'win32'
    ? `runtime/${runtimeName}/.venv/Scripts/python.exe`
    : `runtime/${runtimeName}/.venv/bin/python`;
}

function venvPython(staging, runtimeName) {
  return path.join(staging, runtimeInterpreterPath(runtimeName));
}

async function createVenv(staging, runtimeName, deps = {}) {
  assertRuntimeName(runtimeName);
  const runner = deps.spawnProcess || spawnProcess;
  try {
    await runner(runtimePython(deps), ['-m', 'venv', path.join('runtime', runtimeName, '.venv')], { cwd: staging, env: sanitizeEnv(deps.env) });
  } catch (err) {
    throw sanitizedError(err, `create_venv:${runtimeName}`);
  }
}

async function installRuntime(staging, _components = [], runtimeName, deps = {}) {
  assertRuntimeName(runtimeName);
  if (Object.prototype.hasOwnProperty.call(deps, 'runtimePackageSpecs')) throw error(MODEL_ERROR);
  const runner = deps.spawnProcess || spawnProcess;
  const python = venvPython(staging, runtimeName);
  const specs = normalizeRuntimePackageSpecs(runtimeName);
  for (const spec of specs) {
    if (isPaddleWheelSpec(runtimeName, spec)) {
      await installPinnedPaddleWheel(staging, python, deps);
      continue;
    }
    const args = ['-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-input', '--index-url', PYPI_INDEX_URL];
    if (spec.noDeps) args.push('--no-deps');
    args.push(spec.requirement);
    try {
      await runner(python, args, { cwd: staging, env: sanitizeEnv(deps.env) });
    } catch (err) {
      throw sanitizedError(err, `install:${runtimeName}:${splitRequirement(spec.requirement).name}`);
    }
  }
}

async function installPinnedPaddleWheel(staging, python, deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  const wheelStageParent = path.join(staging, 'runtime', 'text', '.wheel-stage');
  const wheelDir = path.join(wheelStageParent, 'paddlepaddle');
  let evidence;
  try {
    await fsp.mkdir(wheelStageParent, { recursive: false });
    await fsp.mkdir(wheelDir, { recursive: false });
    await runner(python, [
      '-m',
      'pip',
      '--isolated',
      'download',
      '--disable-pip-version-check',
      '--no-input',
      '--index-url',
      PYPI_INDEX_URL,
      '--no-deps',
      '--only-binary=:all:',
      '--dest',
      PADDLE_WHEEL_RELATIVE_DIR,
      PADDLE_WHEEL_REQUIREMENT,
    ], { cwd: staging, env: sanitizeEnv(deps.env) });
    evidence = await readPaddleWheelEvidence(staging, wheelDir);
    try {
      await runner(python, [
        '-m',
        'pip',
        '--isolated',
        'install',
        '--disable-pip-version-check',
        '--no-input',
        '--no-index',
        '--no-deps',
        evidence.relativePath,
      ], { cwd: staging, env: sanitizeEnv(deps.env) });
      await revalidatePaddleWheelEvidence(evidence);
      await fsp.unlink(evidence.absPath);
      await fsp.rmdir(wheelDir);
      await fsp.rmdir(wheelStageParent);
    } catch (err) {
      throw sanitizedError(err, 'install:text:paddlepaddle');
    }
  } catch (err) {
    if (normalizeStage(err && err.stage) === 'install:text:paddlepaddle') throw err;
    throw sanitizedError(err, 'download:text:paddlepaddle');
  }
}

async function pipFreeze(staging, runtimeName, deps = {}) {
  assertRuntimeName(runtimeName);
  const runner = deps.spawnProcess || spawnProcess;
  try {
    const output = await runner(venvPython(staging, runtimeName), ['-m', 'pip', 'freeze'], { cwd: staging, env: sanitizeEnv(deps.env) });
    return assertPinnedFreeze(String(output).split(/\r?\n/), process.platform, runtimeName);
  } catch (err) {
    throw sanitizedError(err, `freeze:${runtimeName}`);
  }
}

async function pythonVersion(staging, runtimeName, deps = {}) {
  assertRuntimeName(runtimeName);
  const runner = deps.spawnProcess || spawnProcess;
  try {
    return String(await runner(venvPython(staging, runtimeName), ['--version'], { cwd: staging, env: sanitizeEnv(deps.env) })).trim();
  } catch (err) {
    throw sanitizedError(err, `python_version:${runtimeName}`);
  }
}

async function bootstrapWorker(staging, _modelLockPath, runtimeName = 'main', deps = {}) {
  if (runtimeName && typeof runtimeName === 'object') {
    deps = runtimeName;
    runtimeName = 'main';
  }
  assertRuntimeName(runtimeName);
  const runner = deps.spawnProcess || spawnProcess;
  const worker = path.resolve(__dirname, '../../workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py');
  try {
    await runner(venvPython(staging, runtimeName), [worker, 'bootstrap', '--model-lock', path.join(staging, 'model-lock.json')], {
      cwd: staging,
      env: sanitizeEnv(deps.env),
      parseBootstrapErrorStage: true,
    });
  } catch (err) {
    throw sanitizedError(err, 'bootstrap');
  }
}

async function publishCache(staging, outputDir) {
  await assertEmptyOrMissing(outputDir);
  const hadEmptyOutputDir = await exists(outputDir);
  if (hadEmptyOutputDir) await fsp.rmdir(outputDir);
  try {
    await fsp.rename(staging, outputDir);
  } catch (err) {
    if (hadEmptyOutputDir && !(await exists(outputDir))) {
      try {
        await fsp.mkdir(outputDir);
      } catch (restoreErr) {
        if (!(await exists(outputDir))) throw restoreErr;
      }
    }
    throw err;
  }
}

async function runFetchModels(options, injectedDeps = {}) {
  const deps = { ...defaultDeps(), ...injectedDeps };
  const outputDir = path.resolve(options.outputDir);
  await assertEmptyOrMissing(outputDir);
  await deps.preflightRuntimePython(deps);
  const parent = path.dirname(outputDir);
  await fsp.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.redraw-full-frame-staging-${deps.randomHex()}`);
  let complete = false;
  let stage = 'unknown';
  try {
    await fsp.mkdir(staging, { recursive: false });
    const byComponent = new Map(sourcePolicy.sources.map((source) => [source.component, source]));
    const components = [];
    for (const componentName of COMPONENT_ORDER) {
      stage = `fetch:${componentName}`;
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
    const runtimes = {};
    const runtimeLocks = {};
    for (const runtimeName of RUNTIME_NAMES) {
      stage = `create_venv:${runtimeName}`;
      await deps.createVenv(staging, runtimeName);
      stage = 'unknown';
      await deps.installRuntime(staging, components, runtimeName);
      stage = `freeze:${runtimeName}`;
      const freeze = assertPinnedFreeze(await deps.pipFreeze(staging, runtimeName), process.platform, runtimeName);
      stage = `python_version:${runtimeName}`;
      const pythonVersion = await deps.pythonVersion(staging, runtimeName);
      stage = `write_runtime_lock:${runtimeName}`;
      const freezeBytes = Buffer.from(`${freeze.join('\n')}\n`);
      const pipFreezePath = `runtime/${runtimeName}/pip-freeze.txt`;
      await writeFileAtomic(path.join(staging, pipFreezePath), freezeBytes);
      runtimes[runtimeName] = {
        python_version: pythonVersion,
        interpreter_path: runtimeInterpreterPath(runtimeName),
        pip_freeze_path: pipFreezePath,
        pip_freeze_sha256: sha256(freezeBytes),
      };
      runtimeLocks[runtimeName] = pipFreezePath;
    }
    const lock = {
      schema_version: 'redraw-full-frame-model-lock-v2',
      runtimes,
      components,
    };
    stage = 'write_model_lock';
    await writeFileAtomic(path.join(staging, 'model-lock.json'), Buffer.from(`${JSON.stringify(lock, null, 2)}\n`));
    stage = 'bootstrap';
    await deps.bootstrapWorker(staging, path.join(staging, 'model-lock.json'), 'main');
    stage = 'validate';
    const validated = await deps.validateModelLock({ cacheRoot: staging, sourcePolicy, lock });
    stage = 'publish';
    await deps.publishCache(staging, outputDir);
    complete = true;
    return {
      canonical_sha256: validated.canonical_sha256,
      components: validated.components.map((component) => component.component),
      runtime_locks: runtimeLocks,
    };
  } catch (err) {
    throw sanitizedError(err, stage);
  } finally {
    if (!complete) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function runCli(argv = process.argv.slice(2), injectedDeps = {}) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write('Usage: fetch-redraw-full-frame-models-local --output-dir <empty-or-missing-dir>\n');
      return 0;
    }
    const result = await runFetchModels({ outputDir: args.outputDir }, injectedDeps);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    const safe = sanitizedError(err);
    process.stderr.write(`${safe.code} stage=${safe.stage}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((code) => { process.exitCode = code; });
}

module.exports = {
  assertPinnedFreeze,
  assertAllowedUrl,
  parseArgs,
  resolveOfficialComponent,
  venvPython,
  runProcess,
  createVenv,
  installRuntime,
  pipFreeze,
  pythonVersion,
  bootstrapWorker,
  preflightRuntimePython,
  runFetchModels,
  runCli,
};
