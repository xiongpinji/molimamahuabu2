const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const sourcePolicy = require('../config/redraw-full-frame-model-sources.json');
const {
  canonicalSha256,
  canonicalizeModelLock,
  validateModelLock,
} = require('../src/services/redrawFullFrameModelLockService');

const COMPONENTS = [
  ['face_detector', 'MediaPipe face detection', 'google-ai-edge/mediapipe'],
  ['person_detector', 'YOLOX', 'Megvii-BaseDetection/YOLOX'],
  ['text_detector', 'PaddleOCR', 'PaddlePaddle/PaddleOCR'],
  ['tracker', 'ByteTrack', 'FoundationVision/ByteTrack'],
];

const RUNTIME_FREEZE = {
  main: 'mediapipe==0.10.14\nprotobuf==4.25.9\n',
  text: 'paddleocr==2.8.1\npaddlepaddle==2.6.2\nprotobuf==3.20.2\n',
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function withTempCache(t) {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-frame-lock-'));
  t.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  return cacheRoot;
}

function writeCacheFile(cacheRoot, relativePath, bytes) {
  const target = path.join(cacheRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return sha256(bytes);
}

function createRuntime(cacheRoot, name) {
  const interpreterPath = `runtime/${name}/.venv/Scripts/python.exe`;
  const freezePath = `runtime/${name}/pip-freeze.txt`;
  writeCacheFile(cacheRoot, interpreterPath, Buffer.from(`${name}:python.exe\n`));
  return {
    python_version: name === 'main' ? '3.11.9' : '3.10.14',
    interpreter_path: interpreterPath,
    pip_freeze_path: freezePath,
    pip_freeze_sha256: writeCacheFile(cacheRoot, freezePath, Buffer.from(RUNTIME_FREEZE[name])),
  };
}

function createValidLock(t) {
  const cacheRoot = withTempCache(t);
  const components = COMPONENTS.map(([component, project, repository]) => {
    const artifactPath = path.join(component, 'model.bin');
    const licensePath = path.join(component, 'LICENSE.txt');
    const artifactBytes = Buffer.from(`${component}:model:v1\n`);
    const licenseBytes = Buffer.from(`${component}:license:v1\n`);
    return {
      component,
      project,
      repository,
      revision: `rev-${component}-20260815`,
      artifact_name: `${component}-model.bin`,
      artifact_path: artifactPath,
      artifact_sha256: writeCacheFile(cacheRoot, artifactPath, artifactBytes),
      license_name: `${component}-LICENSE.txt`,
      license_evidence_path: licensePath,
      license_evidence_sha256: writeCacheFile(cacheRoot, licensePath, licenseBytes),
    };
  });
  return {
    cacheRoot,
    lock: {
      schema_version: 'redraw-full-frame-model-lock-v2',
      runtimes: {
        main: createRuntime(cacheRoot, 'main'),
        text: createRuntime(cacheRoot, 'text'),
      },
      components: components.slice().reverse(),
    },
  };
}

async function assertInvalid(promise, cacheRoot) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error.code, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
      assert.equal(error.message, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
      assert.equal(error.cause, undefined);
      const serialized = JSON.stringify(error);
      assert.doesNotMatch(error.message, /ENOENT|EISDIR|EACCES|EPERM|cause|context|model:v1|license:v1|python\.exe|pip-freeze/);
      assert.doesNotMatch(serialized, /ENOENT|EISDIR|EACCES|EPERM|cause|context|model:v1|license:v1|python\.exe|pip-freeze/);
      assert.doesNotMatch(error.message, new RegExp(cacheRoot.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
      assert.doesNotMatch(serialized, new RegExp(cacheRoot.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
      assert.doesNotMatch(error.message, /[A-Za-z]:\\/);
      assert.doesNotMatch(serialized, /[A-Za-z]:\\/);
      return true;
    },
  );
}

function mutateRuntime(lock, name, patch) {
  return {
    ...lock,
    runtimes: {
      ...lock.runtimes,
      [name]: {
        ...lock.runtimes[name],
        ...patch,
      },
    },
  };
}

function setFirstComponent(lock, patch) {
  return {
    ...lock,
    components: lock.components.map((item, index) => index === 0 ? { ...item, ...patch } : item),
  };
}

async function withPatchedFs(api, method, replacement, callback) {
  const original = api[method];
  api[method] = replacement(original);
  try {
    await callback();
  } finally {
    api[method] = original;
  }
}

test('valid v2 lock returns sorted dual-runtime canonical evidence without leaking cache root', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const before = JSON.stringify(lock);
  const result = await validateModelLock({ cacheRoot, sourcePolicy, lock });

  assert.deepEqual(Object.keys(result), ['schema_version', 'runtimes', 'components', 'canonical_sha256']);
  assert.deepEqual(Object.keys(result.runtimes), ['main', 'text']);
  for (const name of ['main', 'text']) {
    assert.deepEqual(Object.keys(result.runtimes[name]), [
      'python_version',
      'interpreter_path',
      'pip_freeze_path',
      'pip_freeze_sha256',
    ]);
    assert.equal(result.runtimes[name].interpreter_path, `runtime/${name}/.venv/Scripts/python.exe`);
    assert.equal(result.runtimes[name].pip_freeze_path, `runtime/${name}/pip-freeze.txt`);
    assert.doesNotMatch(result.runtimes[name].interpreter_path, /\\/);
    assert.doesNotMatch(result.runtimes[name].pip_freeze_path, /\\/);
  }
  assert.deepEqual(result.components.map((item) => item.component), [
    'face_detector',
    'person_detector',
    'text_detector',
    'tracker',
  ]);
  assert.match(result.canonical_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(cacheRoot.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  assert.equal(JSON.stringify(lock), before);
});

test('v1 lock schema_version fails closed', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, schema_version: 'redraw-full-frame-model-lock-v1' },
  }), cacheRoot);
});

test('top-level and runtime keys are exact', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);

  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: { ...lock, extra: true } }), cacheRoot);
  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { schema_version: lock.schema_version, runtime: { node: '20.9.0' }, components: lock.components },
  }), cacheRoot);
  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: { ...lock, runtimes: { main: lock.runtimes.main } } }), cacheRoot);
  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: { ...lock, runtimes: { ...lock.runtimes, worker: lock.runtimes.main } } }), cacheRoot);
  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: mutateRuntime(lock, 'main', { extra: true }) }), cacheRoot);
  const { pip_freeze_sha256, ...textWithoutHash } = lock.runtimes.text;
  assert.equal(pip_freeze_sha256.length, 64);
  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, runtimes: { main: lock.runtimes.main, text: textWithoutHash } },
  }), cacheRoot);
});

test('canonical hash is stable across object key order and input component order', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const reordered = {
    components: lock.components.map((component) => ({
      license_evidence_sha256: component.license_evidence_sha256,
      license_evidence_path: component.license_evidence_path,
      license_name: component.license_name,
      artifact_sha256: component.artifact_sha256,
      artifact_path: component.artifact_path,
      artifact_name: component.artifact_name,
      revision: component.revision,
      repository: component.repository,
      project: component.project,
      component: component.component,
    })).reverse(),
    runtimes: {
      text: {
        pip_freeze_sha256: lock.runtimes.text.pip_freeze_sha256,
        pip_freeze_path: lock.runtimes.text.pip_freeze_path,
        interpreter_path: lock.runtimes.text.interpreter_path,
        python_version: lock.runtimes.text.python_version,
      },
      main: {
        pip_freeze_sha256: lock.runtimes.main.pip_freeze_sha256,
        pip_freeze_path: lock.runtimes.main.pip_freeze_path,
        interpreter_path: lock.runtimes.main.interpreter_path,
        python_version: lock.runtimes.main.python_version,
      },
    },
    schema_version: lock.schema_version,
  };

  const first = await validateModelLock({ cacheRoot, sourcePolicy, lock });
  const second = await validateModelLock({ cacheRoot, sourcePolicy, lock: reordered });

  assert.equal(first.canonical_sha256, second.canonical_sha256);
  assert.equal(canonicalSha256(canonicalizeModelLock(lock)), canonicalSha256(canonicalizeModelLock(reordered)));
});

test('canonical runtime paths normalize separators to forward slash', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const withBackslash = {
    ...lock,
    runtimes: {
      main: {
        ...lock.runtimes.main,
        interpreter_path: lock.runtimes.main.interpreter_path.replace(/\//g, '\\'),
        pip_freeze_path: lock.runtimes.main.pip_freeze_path.replace(/\//g, '\\'),
      },
      text: {
        ...lock.runtimes.text,
        interpreter_path: lock.runtimes.text.interpreter_path.replace(/\//g, '\\'),
        pip_freeze_path: lock.runtimes.text.pip_freeze_path.replace(/\//g, '\\'),
      },
    },
  };

  const first = await validateModelLock({ cacheRoot, sourcePolicy, lock });
  const second = await validateModelLock({ cacheRoot, sourcePolicy, lock: withBackslash });

  assert.equal(first.canonical_sha256, second.canonical_sha256);
  for (const runtime of Object.values(second.runtimes)) {
    assert.doesNotMatch(runtime.interpreter_path, /\\/);
    assert.doesNotMatch(runtime.pip_freeze_path, /\\/);
  }
});

test('runtime path and hash matrix fails closed on both main and text', async (t) => {
  for (const runtimeName of ['main', 'text']) {
    for (const field of ['interpreter_path', 'pip_freeze_path']) {
      const absoluteCase = createValidLock(t);
      await assertInvalid(validateModelLock({
        cacheRoot: absoluteCase.cacheRoot,
        sourcePolicy,
        lock: mutateRuntime(absoluteCase.lock, runtimeName, { [field]: path.join(absoluteCase.cacheRoot, absoluteCase.lock.runtimes[runtimeName][field]) }),
      }), absoluteCase.cacheRoot);

      const driveRelativeCase = createValidLock(t);
      await assertInvalid(validateModelLock({
        cacheRoot: driveRelativeCase.cacheRoot,
        sourcePolicy,
        lock: mutateRuntime(driveRelativeCase.lock, runtimeName, { [field]: 'C:runtime-file' }),
      }), driveRelativeCase.cacheRoot);

      const escapeCase = createValidLock(t);
      await assertInvalid(validateModelLock({
        cacheRoot: escapeCase.cacheRoot,
        sourcePolicy,
        lock: mutateRuntime(escapeCase.lock, runtimeName, { [field]: `runtime/${runtimeName}/../outside` }),
      }), escapeCase.cacheRoot);

      const directoryCase = createValidLock(t);
      fs.rmSync(path.join(directoryCase.cacheRoot, directoryCase.lock.runtimes[runtimeName][field]));
      fs.mkdirSync(path.join(directoryCase.cacheRoot, directoryCase.lock.runtimes[runtimeName][field]));
      await assertInvalid(validateModelLock({ cacheRoot: directoryCase.cacheRoot, sourcePolicy, lock: directoryCase.lock }), directoryCase.cacheRoot);

      const missingCase = createValidLock(t);
      fs.rmSync(path.join(missingCase.cacheRoot, missingCase.lock.runtimes[runtimeName][field]));
      await assertInvalid(validateModelLock({ cacheRoot: missingCase.cacheRoot, sourcePolicy, lock: missingCase.lock }), missingCase.cacheRoot);
    }

    const outsideFolderCase = createValidLock(t);
    await assertInvalid(validateModelLock({
      cacheRoot: outsideFolderCase.cacheRoot,
      sourcePolicy,
      lock: mutateRuntime(outsideFolderCase.lock, runtimeName, {
        interpreter_path: `runtime/${runtimeName === 'main' ? 'text' : 'main'}/.venv/Scripts/python.exe`,
      }),
    }), outsideFolderCase.cacheRoot);

    const pythonTrimCase = createValidLock(t);
    await assertInvalid(validateModelLock({
      cacheRoot: pythonTrimCase.cacheRoot,
      sourcePolicy,
      lock: mutateRuntime(pythonTrimCase.lock, runtimeName, { python_version: ` ${pythonTrimCase.lock.runtimes[runtimeName].python_version}` }),
    }), pythonTrimCase.cacheRoot);

    const freezeHashCase = createValidLock(t);
    freezeHashCase.lock.runtimes[runtimeName].pip_freeze_sha256 = '0'.repeat(64);
    await assertInvalid(validateModelLock({ cacheRoot: freezeHashCase.cacheRoot, sourcePolicy, lock: freezeHashCase.lock }), freezeHashCase.cacheRoot);

    const freezeBytesCase = createValidLock(t);
    fs.writeFileSync(path.join(freezeBytesCase.cacheRoot, freezeBytesCase.lock.runtimes[runtimeName].pip_freeze_path), 'tampered');
    await assertInvalid(validateModelLock({ cacheRoot: freezeBytesCase.cacheRoot, sourcePolicy, lock: freezeBytesCase.lock }), freezeBytesCase.cacheRoot);
  }
});

test('runtime symlink escape fails closed when supported', async (t) => {
  for (const runtimeName of ['main', 'text']) {
    const { cacheRoot, lock } = createValidLock(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `redraw-full-frame-outside-${runtimeName}-`));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const outsideFile = path.join(outside, 'python.exe');
    fs.writeFileSync(outsideFile, 'outside');
    const linkPath = path.join(cacheRoot, lock.runtimes[runtimeName].interpreter_path);
    fs.rmSync(linkPath);
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip(`symlink unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock }), cacheRoot);
  }
});

test('runtime read-time realpath and identity drift fail closed on both sides', async (t) => {
  for (const runtimeName of ['main', 'text']) {
    const realpathCase = createValidLock(t);
    const target = fs.realpathSync(path.join(realpathCase.cacheRoot, realpathCase.lock.runtimes[runtimeName].interpreter_path));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `redraw-full-frame-realpath-${runtimeName}-`));
    const outsideFile = path.join(outside, 'python.exe');
    fs.writeFileSync(outsideFile, 'outside');
    let calls = 0;
    await withPatchedFs(fsp, 'realpath', (originalRealpath) => async (...args) => {
      const resolved = await originalRealpath.apply(fsp, args);
      if (resolved === target) {
        calls += 1;
        if (calls > 1) return outsideFile;
      }
      return resolved;
    }, async () => {
      await assertInvalid(validateModelLock({ cacheRoot: realpathCase.cacheRoot, sourcePolicy, lock: realpathCase.lock }), realpathCase.cacheRoot);
    });
    fs.rmSync(outside, { recursive: true, force: true });

    const identityCase = createValidLock(t);
    let patched = false;
    await withPatchedFs(fsp, 'open', (originalOpen) => async (...args) => {
      const handle = await originalOpen.apply(fsp, args);
      if (!patched && String(args[0]).endsWith(path.normalize(identityCase.lock.runtimes[runtimeName].interpreter_path))) {
        patched = true;
        const originalStat = handle.stat.bind(handle);
        let statCalls = 0;
        handle.stat = async (...statArgs) => {
          const stat = await originalStat(...statArgs);
          statCalls += 1;
          if (statCalls > 1) return { ...stat, size: typeof stat.size === 'bigint' ? stat.size + 1n : stat.size + 1 };
          return stat;
        };
      }
      return handle;
    }, async () => {
      await assertInvalid(validateModelLock({ cacheRoot: identityCase.cacheRoot, sourcePolicy, lock: identityCase.lock }), identityCase.cacheRoot);
    });
  }
});

test('two runtimes cannot point to the same interpreter file', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: mutateRuntime(lock, 'main', { interpreter_path: 'runtime/text/.venv/Scripts/python.exe' }),
  }), cacheRoot);
});

test('component set and official source policy are strict', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);

  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: { ...lock, components: lock.components.filter((item) => item.component !== 'tracker') } }), cacheRoot);
  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: { ...lock, components: lock.components.concat({ ...lock.components[0] }) } }), cacheRoot);
  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: { ...lock, components: lock.components.concat({ ...lock.components[0], component: 'other' }) } }), cacheRoot);
  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: setFirstComponent(lock, { project: 'Other' }) }), cacheRoot);
  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy: { ...sourcePolicy, sources: sourcePolicy.sources.map((item) => item.component === 'tracker' ? { ...item, repository: 'Other/Repo' } : item) },
    lock,
  }), cacheRoot);
  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy: { ...sourcePolicy, sources: sourcePolicy.sources.filter((item) => item.component !== 'tracker') }, lock }), cacheRoot);
  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy: { ...sourcePolicy, sources: sourcePolicy.sources.concat({ ...sourcePolicy.sources[0] }) }, lock }), cacheRoot);
  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy: { ...sourcePolicy, sources: sourcePolicy.sources.concat({ component: 'other', project: 'Other', repository: 'Other/Repo', license_path: 'LICENSE' }) },
    lock,
  }), cacheRoot);
  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy: { ...sourcePolicy, unexpected: true }, lock }), cacheRoot);
});

test('component fields, placeholders, paths, hashes, files, and drift fail closed', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);

  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: setFirstComponent(lock, { extra: true }) }), cacheRoot);

  for (const field of ['revision', 'artifact_name', 'artifact_path', 'artifact_sha256', 'license_name', 'license_evidence_path', 'license_evidence_sha256']) {
    const placeholderCase = createValidLock(t);
    await assertInvalid(validateModelLock({
      cacheRoot: placeholderCase.cacheRoot,
      sourcePolicy,
      lock: setFirstComponent(placeholderCase.lock, { [field]: ' latest ' }),
    }), placeholderCase.cacheRoot);
  }

  const revisionCase = createValidLock(t);
  await assertInvalid(validateModelLock({
    cacheRoot: revisionCase.cacheRoot,
    sourcePolicy,
    lock: setFirstComponent(revisionCase.lock, { revision: 'release-latest-face_detector' }),
  }), revisionCase.cacheRoot);

  const fixedRevisionCase = createValidLock(t);
  const fixedLock = setFirstComponent(fixedRevisionCase.lock, { revision: 'a'.repeat(40) });
  const result = await validateModelLock({ cacheRoot: fixedRevisionCase.cacheRoot, sourcePolicy, lock: fixedLock });
  assert.equal(result.components.find((item) => item.component === fixedRevisionCase.lock.components[0].component).revision, 'a'.repeat(40));

  const absoluteCase = createValidLock(t);
  await assertInvalid(validateModelLock({
    cacheRoot: absoluteCase.cacheRoot,
    sourcePolicy,
    lock: setFirstComponent(absoluteCase.lock, { artifact_path: path.join(absoluteCase.cacheRoot, absoluteCase.lock.components[0].artifact_path) }),
  }), absoluteCase.cacheRoot);

  const driveRelativeCase = createValidLock(t);
  await assertInvalid(validateModelLock({
    cacheRoot: driveRelativeCase.cacheRoot,
    sourcePolicy,
    lock: setFirstComponent(driveRelativeCase.lock, { artifact_path: 'C:model.bin' }),
  }), driveRelativeCase.cacheRoot);

  const escapeCase = createValidLock(t);
  await assertInvalid(validateModelLock({
    cacheRoot: escapeCase.cacheRoot,
    sourcePolicy,
    lock: setFirstComponent(escapeCase.lock, { license_evidence_path: '..\\outside-license.txt' }),
  }), escapeCase.cacheRoot);

  const artifactHashCase = createValidLock(t);
  artifactHashCase.lock.components[0].artifact_sha256 = '0'.repeat(64);
  await assertInvalid(validateModelLock({ cacheRoot: artifactHashCase.cacheRoot, sourcePolicy, lock: artifactHashCase.lock }), artifactHashCase.cacheRoot);

  const licenseHashCase = createValidLock(t);
  licenseHashCase.lock.components[0].license_evidence_sha256 = '0'.repeat(64);
  await assertInvalid(validateModelLock({ cacheRoot: licenseHashCase.cacheRoot, sourcePolicy, lock: licenseHashCase.lock }), licenseHashCase.cacheRoot);

  const tamperedCase = createValidLock(t);
  fs.writeFileSync(path.join(tamperedCase.cacheRoot, tamperedCase.lock.components[0].artifact_path), 'tampered');
  await assertInvalid(validateModelLock({ cacheRoot: tamperedCase.cacheRoot, sourcePolicy, lock: tamperedCase.lock }), tamperedCase.cacheRoot);

  const missingCase = createValidLock(t);
  fs.rmSync(path.join(missingCase.cacheRoot, missingCase.lock.components[0].license_evidence_path));
  await assertInvalid(validateModelLock({ cacheRoot: missingCase.cacheRoot, sourcePolicy, lock: missingCase.lock }), missingCase.cacheRoot);

  const directoryCase = createValidLock(t);
  fs.rmSync(path.join(directoryCase.cacheRoot, directoryCase.lock.components[0].artifact_path));
  fs.mkdirSync(path.join(directoryCase.cacheRoot, directoryCase.lock.components[0].artifact_path));
  await assertInvalid(validateModelLock({ cacheRoot: directoryCase.cacheRoot, sourcePolicy, lock: directoryCase.lock }), directoryCase.cacheRoot);

  const identityCase = createValidLock(t);
  let patched = false;
  await withPatchedFs(fsp, 'open', (originalOpen) => async (...args) => {
    const handle = await originalOpen.apply(fsp, args);
    if (!patched && String(args[0]).endsWith(path.normalize(identityCase.lock.components[0].artifact_path))) {
      patched = true;
      const originalStat = handle.stat.bind(handle);
      let calls = 0;
      handle.stat = async (...statArgs) => {
        const stat = await originalStat(...statArgs);
        calls += 1;
        if (calls > 1) return { ...stat, size: typeof stat.size === 'bigint' ? stat.size + 1n : stat.size + 1 };
        return stat;
      };
    }
    return handle;
  }, async () => {
    await assertInvalid(validateModelLock({ cacheRoot: identityCase.cacheRoot, sourcePolicy, lock: identityCase.lock }), identityCase.cacheRoot);
  });

  const realpathCase = createValidLock(t);
  const target = fs.realpathSync(path.join(realpathCase.cacheRoot, realpathCase.lock.components[0].artifact_path));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-frame-realpath-component-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, 'model.bin');
  fs.writeFileSync(outsideFile, 'outside');
  let calls = 0;
  await withPatchedFs(fsp, 'realpath', (originalRealpath) => async (...args) => {
    const resolved = await originalRealpath.apply(fsp, args);
    if (resolved === target) {
      calls += 1;
      if (calls > 1) return outsideFile;
    }
    return resolved;
  }, async () => {
    await assertInvalid(validateModelLock({ cacheRoot: realpathCase.cacheRoot, sourcePolicy, lock: realpathCase.lock }), realpathCase.cacheRoot);
  });
});

test('component symlink escape fails closed when supported', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-frame-outside-component-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, 'model.bin');
  fs.writeFileSync(outsideFile, 'outside');
  const linkPath = path.join(cacheRoot, lock.components[0].artifact_path);
  fs.rmSync(linkPath);
  try {
    fs.symlinkSync(outsideFile, linkPath, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock }), cacheRoot);
});
