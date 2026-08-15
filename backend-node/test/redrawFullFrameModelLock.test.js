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
      schema_version: 'redraw-full-frame-model-lock-v1',
      runtime: { node: '20.9.0', platform: 'test' },
      components: components.slice().reverse(),
    },
  };
}

async function assertInvalid(promise, cacheRoot) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error.code, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
      const serialized = JSON.stringify(error);
      assert.doesNotMatch(error.message, /ENOENT|EISDIR|EACCES|EPERM|cause|model:v1|license:v1/);
      assert.doesNotMatch(serialized, /ENOENT|EISDIR|EACCES|EPERM|cause|model:v1|license:v1/);
      assert.doesNotMatch(error.message, new RegExp(cacheRoot.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
      assert.doesNotMatch(serialized, new RegExp(cacheRoot.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
      assert.doesNotMatch(error.message, /[A-Za-z]:\\/);
      assert.doesNotMatch(serialized, /[A-Za-z]:\\/);
      return true;
    },
  );
}

test('valid lock returns sorted canonical evidence without leaking cache root', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const before = JSON.stringify(lock);
  const result = await validateModelLock({ cacheRoot, sourcePolicy, lock });

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
    runtime: { platform: 'test', node: '20.9.0' },
    schema_version: lock.schema_version,
  };

  const first = await validateModelLock({ cacheRoot, sourcePolicy, lock });
  const second = await validateModelLock({ cacheRoot, sourcePolicy, lock: reordered });

  assert.equal(first.canonical_sha256, second.canonical_sha256);
  assert.equal(canonicalSha256(canonicalizeModelLock(lock)), canonicalSha256(canonicalizeModelLock(reordered)));
});

test('tampered artifact bytes fail declared hash verification', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  fs.writeFileSync(path.join(cacheRoot, lock.components[0].artifact_path), 'tampered');

  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock }), cacheRoot);
});

test('component set and official source policy are strict', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.filter((item) => item.component !== 'tracker') },
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.concat({ ...lock.components[0] }) },
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.concat({ ...lock.components[0], component: 'other' }) },
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.map((item) => item.component === 'tracker' ? { ...item, project: 'Other' } : item) },
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy: { ...sourcePolicy, sources: sourcePolicy.sources.map((item) => item.component === 'tracker' ? { ...item, repository: 'Other/Repo' } : item) },
    lock,
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy: { ...sourcePolicy, sources: sourcePolicy.sources.filter((item) => item.component !== 'tracker') },
    lock,
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy: { ...sourcePolicy, sources: sourcePolicy.sources.concat({ ...sourcePolicy.sources[0] }) },
    lock,
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy: { ...sourcePolicy, sources: sourcePolicy.sources.concat({ component: 'other', project: 'Other', repository: 'Other/Repo', license_path: 'LICENSE' }) },
    lock,
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy: { ...sourcePolicy, unexpected: true },
    lock,
  }), cacheRoot);
});

test('unknown top-level and component fields fail closed', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);

  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock: { ...lock, extra: true } }), cacheRoot);
  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.map((item, index) => index === 0 ? { ...item, extra: true } : item) },
  }), cacheRoot);
});

test('placeholder and floating values fail closed', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const fields = ['revision', 'artifact_name', 'artifact_path', 'artifact_sha256', 'license_name', 'license_evidence_path', 'license_evidence_sha256'];

  for (const field of fields) {
    await assertInvalid(validateModelLock({
      cacheRoot,
      sourcePolicy,
      lock: { ...lock, components: lock.components.map((item, index) => index === 0 ? { ...item, [field]: ' latest ' } : item) },
    }), cacheRoot);
  }
});

test('revision rejects embedded floating and placeholder tokens without rejecting fixed values', async (t) => {
  const invalidRevisions = ['release-latest-face_detector', 'MODEL_Main_build', 'todo-revision'];
  for (const revision of invalidRevisions) {
    const { cacheRoot, lock } = createValidLock(t);
    await assertInvalid(validateModelLock({
      cacheRoot,
      sourcePolicy,
      lock: { ...lock, components: lock.components.map((item, index) => index === 0 ? { ...item, revision } : item) },
    }), cacheRoot);
  }

  const { cacheRoot, lock } = createValidLock(t);
  const fixedLock = {
    ...lock,
    components: lock.components.map((item, index) => index === 0 ? { ...item, revision: 'a'.repeat(40) } : item),
  };
  const result = await validateModelLock({ cacheRoot, sourcePolicy, lock: fixedLock });
  assert.equal(result.components.find((item) => item.component === lock.components[0].component).revision, 'a'.repeat(40));
});

test('artifact and license hash drift fail independently', async (t) => {
  const first = createValidLock(t);
  first.lock.components[0].artifact_sha256 = '0'.repeat(64);
  await assertInvalid(validateModelLock({ cacheRoot: first.cacheRoot, sourcePolicy, lock: first.lock }), first.cacheRoot);

  const second = createValidLock(t);
  second.lock.components[0].license_evidence_sha256 = '0'.repeat(64);
  await assertInvalid(validateModelLock({ cacheRoot: second.cacheRoot, sourcePolicy, lock: second.lock }), second.cacheRoot);
});

test('absolute and escaping paths fail closed for artifacts and licenses', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const absolute = path.join(cacheRoot, lock.components[0].artifact_path);
  const absoluteLicense = path.join(cacheRoot, lock.components[0].license_evidence_path);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.map((item, index) => index === 0 ? { ...item, artifact_path: absolute } : item) },
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.map((item, index) => index === 0 ? { ...item, artifact_path: '../outside-model.bin' } : item) },
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.map((item, index) => index === 0 ? { ...item, artifact_path: 'C:model.bin' } : item) },
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.map((item, index) => index === 0 ? { ...item, license_evidence_path: absoluteLicense } : item) },
  }), cacheRoot);

  await assertInvalid(validateModelLock({
    cacheRoot,
    sourcePolicy,
    lock: { ...lock, components: lock.components.map((item, index) => index === 0 ? { ...item, license_evidence_path: '..\\outside-license.txt' } : item) },
  }), cacheRoot);
});

test('symlink escape fails closed when supported', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-frame-outside-'));
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

test('non-regular files and read-time identity drift fail closed', async (t) => {
  const first = createValidLock(t);
  fs.rmSync(path.join(first.cacheRoot, first.lock.components[0].artifact_path));
  fs.mkdirSync(path.join(first.cacheRoot, first.lock.components[0].artifact_path));
  await assertInvalid(validateModelLock({ cacheRoot: first.cacheRoot, sourcePolicy, lock: first.lock }), first.cacheRoot);

  const second = createValidLock(t);
  const originalOpen = fsp.open;
  let patched = false;
  fsp.open = async (...args) => {
    const handle = await originalOpen.apply(fsp, args);
    if (!patched && String(args[0]).endsWith(second.lock.components[0].artifact_path)) {
      patched = true;
      const originalStat = handle.stat.bind(handle);
      let calls = 0;
      handle.stat = async (...statArgs) => {
        const stat = await originalStat(...statArgs);
        calls += 1;
        if (calls > 1) {
          return { ...stat, size: typeof stat.size === 'bigint' ? stat.size + 1n : stat.size + 1 };
        }
        return stat;
      };
    }
    return handle;
  };
  t.after(() => { fsp.open = originalOpen; });

  await assertInvalid(validateModelLock({ cacheRoot: second.cacheRoot, sourcePolicy, lock: second.lock }), second.cacheRoot);
});

test('opened file descriptor must match the pre-open in-cache file identity', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-frame-fd-redirect-'));
  const originalOpen = fsp.open;
  const target = fs.realpathSync(path.join(cacheRoot, lock.components[0].artifact_path));
  const outsideFile = path.join(outside, 'model.bin');
  fs.writeFileSync(outsideFile, fs.readFileSync(target));
  t.after(() => {
    fsp.open = originalOpen;
    fs.rmSync(outside, { recursive: true, force: true });
  });

  fsp.open = async (...args) => {
    if (args[0] === target) return originalOpen.call(fsp, outsideFile, ...args.slice(1));
    return originalOpen.apply(fsp, args);
  };

  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock }), cacheRoot);
});

test('read-time realpath drift fails closed', async (t) => {
  const { cacheRoot, lock } = createValidLock(t);
  const originalRealpath = fsp.realpath;
  const target = fs.realpathSync(path.join(cacheRoot, lock.components[0].artifact_path));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-frame-realpath-'));
  t.after(() => {
    fsp.realpath = originalRealpath;
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const outsideFile = path.join(outside, 'model.bin');
  fs.writeFileSync(outsideFile, 'outside');
  let calls = 0;
  fsp.realpath = async (...args) => {
    const resolved = await originalRealpath.apply(fsp, args);
    if (resolved === target) {
      calls += 1;
      if (calls > 1) return outsideFile;
    }
    return resolved;
  };

  await assertInvalid(validateModelLock({ cacheRoot, sourcePolicy, lock }), cacheRoot);
});
