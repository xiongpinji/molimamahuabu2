#!/usr/bin/env node
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validateModelLock } = require('../src/services/redrawFullFrameModelLockService');
const sourcePolicy = require('../config/redraw-full-frame-model-sources.json');

const OUTPUT_ERROR = 'REDRAW_FULL_FRAME_OUTPUT_INVALID';
const MODEL_ERROR = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
const COMPONENT_ORDER = ['face_detector', 'person_detector', 'text_detector', 'tracker'];

function error(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length !== 2 || argv[0] !== '--output-dir' || !argv[1]) throw error(OUTPUT_ERROR);
  return { outputDir: argv[1] };
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
    async fetchComponent() {
      throw error(MODEL_ERROR);
    },
    async createVenv(staging) {
      const python = process.env.REDRAW_AUDITOR_PYTHON;
      if (!python) throw error(MODEL_ERROR);
      await runProcess(python, ['-m', 'venv', '.venv'], { cwd: staging });
    },
    async installRuntime() {
      throw error(MODEL_ERROR);
    },
    async pipFreeze() {
      throw error(MODEL_ERROR);
    },
    async pythonVersion(staging) {
      const python = process.env.REDRAW_AUDITOR_PYTHON;
      if (!python) throw error(MODEL_ERROR);
      return runProcess(python, ['--version'], { cwd: staging });
    },
    async bootstrapWorker(staging) {
      const python = process.env.REDRAW_AUDITOR_PYTHON;
      if (!python) throw error(MODEL_ERROR);
      const worker = path.resolve(__dirname, '../../workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py');
      await runProcess(python, [worker, 'bootstrap', '--model-lock', 'model-lock.json'], { cwd: staging });
    },
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => reject(error(MODEL_ERROR)));
    child.on('close', (code) => {
      if (code !== 0) reject(error(MODEL_ERROR));
      else resolve(stdout.trim());
    });
  });
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

module.exports = { parseArgs, runFetchModels, runCli };
