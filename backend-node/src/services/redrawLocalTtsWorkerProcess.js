const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NOT_READY = 'REDRAW_LOCAL_TTS_NOT_READY';
const OUTPUT_INVALID = 'REDRAW_LOCAL_TTS_OUTPUT_INVALID';
const RESULT_UNKNOWN = 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN';
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 300000;
const MAX_WAV_BYTES = 64 * 1024 * 1024;
const MAX_WAV_CHUNKS = 128;
const MANIFEST_KEYS = [
  'schema_version',
  'engine',
  'engine_version',
  'executable_path',
  'executable_sha256',
  'profiles',
  'manifest_sha256',
];
const PROFILE_KEYS = ['profile_key', 'locale', 'voice', 'pitch', 'rate', 'amplitude'];
const EVIDENCE_KEYS = [
  'source',
  'engine',
  'engine_version',
  'binary_sha256',
  'manifest_sha256',
  'profile',
  'target_locale',
];

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function canonicalManifestSha256(manifest) {
  const { manifest_sha256: _manifestSha256, ...hashable } = manifest || {};
  return sha256(stableJson(hashable));
}

function safeWorkerEnv() {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'];
  const env = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) env[key] = process.env[key];
  }
  return env;
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function realpath(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function isExactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const found = Object.keys(value);
  return found.length === keys.length && keys.every((key) => found.includes(key));
}

function assertHex(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw codedError(NOT_READY);
}

function assertSafeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value)) {
    throw codedError(NOT_READY);
  }
}

function assertLocale(value) {
  if (typeof value !== 'string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(value)) throw codedError(NOT_READY);
}

function assertVersion(value) {
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value)) {
    throw codedError(NOT_READY);
  }
}

function assertProfile(profile) {
  if (!isExactObject(profile, PROFILE_KEYS)) throw codedError(NOT_READY);
  assertSafeId(profile.profile_key);
  assertLocale(profile.locale);
  if (typeof profile.voice !== 'string' || !/^[A-Za-z][A-Za-z0-9_+.-]{0,63}$/.test(profile.voice)) {
    throw codedError(NOT_READY);
  }
  if (!Number.isInteger(profile.pitch) || profile.pitch < 0 || profile.pitch > 99) throw codedError(NOT_READY);
  if (!Number.isInteger(profile.rate) || profile.rate < 80 || profile.rate > 450) throw codedError(NOT_READY);
  if (!Number.isInteger(profile.amplitude) || profile.amplitude < 0 || profile.amplitude > 200) {
    throw codedError(NOT_READY);
  }
}

function validateManifest(manifest, context, expectedManifestSha256, expectedEngineVersion) {
  const keys = manifest?.test_only === true ? [...MANIFEST_KEYS, 'test_only'] : MANIFEST_KEYS;
  if (!isExactObject(manifest, keys)) throw codedError(NOT_READY);
  if (manifest.schema_version !== 'local-tts-manifest-v1' || manifest.engine !== 'eSpeak NG') {
    throw codedError(NOT_READY);
  }
  assertVersion(manifest.engine_version);
  assertVersion(expectedEngineVersion);
  if (manifest.engine_version !== expectedEngineVersion) throw codedError(NOT_READY);
  if (manifest.test_only === true && context !== 'test') throw codedError(NOT_READY);
  if (!path.isAbsolute(manifest.executable_path)) throw codedError(NOT_READY);
  assertHex(manifest.executable_sha256);
  assertHex(manifest.manifest_sha256);
  assertHex(expectedManifestSha256);
  const computedManifestSha256 = canonicalManifestSha256(manifest);
  if (manifest.manifest_sha256 !== computedManifestSha256 || expectedManifestSha256 !== computedManifestSha256) {
    throw codedError(NOT_READY);
  }
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0 || manifest.profiles.length > 128) {
    throw codedError(NOT_READY);
  }
  const profileKeys = new Set();
  for (const profile of manifest.profiles) {
    assertProfile(profile);
    if (profileKeys.has(profile.profile_key)) throw codedError(NOT_READY);
    profileKeys.add(profile.profile_key);
  }
}

function inspectRealPath(targetPath, kind, code) {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) throw codedError(code);
  try {
    const lstat = fs.lstatSync(targetPath);
    if (lstat.isSymbolicLink()) throw codedError(code);
    if (kind === 'file' ? !lstat.isFile() : !lstat.isDirectory()) throw codedError(code);
    const resolved = realpath(targetPath);
    if (!samePath(resolved, targetPath)) throw codedError(code);
    return { path: resolved, dev: lstat.dev, ino: lstat.ino };
  } catch (error) {
    if (error?.code === code) throw error;
    throw codedError(code);
  }
}

function sameIdentity(left, right) {
  return samePath(left.path, right.path) && left.dev === right.dev && left.ino === right.ino;
}

function assertExecutable(manifest, expectedIdentity, permissions = {}) {
  const identity = inspectRealPath(manifest.executable_path, 'file', NOT_READY);
  if (expectedIdentity && !sameIdentity(identity, expectedIdentity)) throw codedError(NOT_READY);
  const platform = permissions.platform || process.platform;
  const accessSync = permissions.accessSync || fs.accessSync;
  if (platform !== 'win32') {
    try {
      accessSync(identity.path, fs.constants.X_OK);
    } catch (_) {
      throw codedError(NOT_READY);
    }
  }
  if (sha256File(identity.path) !== manifest.executable_sha256) throw codedError(NOT_READY);
  return identity;
}

function assertAllowedRoot(allowedOutputRoot, expectedIdentity) {
  const identity = inspectRealPath(allowedOutputRoot, 'directory', NOT_READY);
  try {
    fs.accessSync(identity.path, fs.constants.R_OK | fs.constants.W_OK);
  } catch (_) {
    throw codedError(NOT_READY);
  }
  if (expectedIdentity && !sameIdentity(identity, expectedIdentity)) throw codedError(NOT_READY);
  return identity;
}

function resolveProfile(manifest, locale, profileKey) {
  const profile = manifest.profiles.find((item) => item.locale === locale && item.profile_key === profileKey);
  if (!profile) throw codedError(NOT_READY);
  return profile;
}

function prepareOutputRoot(outputRoot, allowedIdentity) {
  let identity;
  try {
    identity = inspectRealPath(outputRoot, 'directory', OUTPUT_INVALID);
    const relative = path.relative(allowedIdentity.path, identity.path);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw codedError(OUTPUT_INVALID);
    }
    if (fs.readdirSync(identity.path).length !== 0) throw codedError(OUTPUT_INVALID);
  } catch (error) {
    if (error?.code === OUTPUT_INVALID) throw error;
    throw codedError(OUTPUT_INVALID);
  }
  return identity;
}

function resolveOutputPath(outputIdentity, outputNameFactory) {
  let outputName;
  try {
    outputName = outputNameFactory();
  } catch (_) {
    throw codedError(OUTPUT_INVALID);
  }
  if (typeof outputName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.wav$/.test(outputName)) {
    throw codedError(OUTPUT_INVALID);
  }
  const outputPath = path.join(outputIdentity.path, outputName);
  if (!samePath(path.dirname(outputPath), outputIdentity.path) || fs.existsSync(outputPath)) {
    throw codedError(OUTPUT_INVALID);
  }
  return { outputName, outputPath };
}

function assertPcmWave(bytes) {
  if (bytes.length < 12 || bytes.length > MAX_WAV_BYTES
    || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
    || bytes.subarray(8, 12).toString('ascii') !== 'WAVE'
    || bytes.readUInt32LE(4) !== bytes.length - 8) {
    throw codedError(OUTPUT_INVALID);
  }

  let offset = 12;
  let chunkCount = 0;
  let format = null;
  let dataSize = null;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length || ++chunkCount > MAX_WAV_CHUNKS) throw codedError(OUTPUT_INVALID);
    const chunkId = bytes.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkSize > bytes.length - chunkStart) throw codedError(OUTPUT_INVALID);
    const chunkEnd = chunkStart + chunkSize;
    const paddedEnd = chunkEnd + (chunkSize % 2);
    if (paddedEnd > bytes.length) throw codedError(OUTPUT_INVALID);

    if (chunkId === 'fmt ') {
      if (format || chunkSize !== 16) throw codedError(OUTPUT_INVALID);
      const audioFormat = bytes.readUInt16LE(chunkStart);
      const channels = bytes.readUInt16LE(chunkStart + 2);
      const sampleRate = bytes.readUInt32LE(chunkStart + 4);
      const byteRate = bytes.readUInt32LE(chunkStart + 8);
      const blockAlign = bytes.readUInt16LE(chunkStart + 12);
      const bitsPerSample = bytes.readUInt16LE(chunkStart + 14);
      if (audioFormat !== 1 || channels < 1 || channels > 8
        || sampleRate < 8000 || sampleRate > 192000
        || ![8, 16, 24, 32].includes(bitsPerSample)) {
        throw codedError(OUTPUT_INVALID);
      }
      const expectedBlockAlign = channels * (bitsPerSample / 8);
      if (blockAlign !== expectedBlockAlign || byteRate !== sampleRate * blockAlign) {
        throw codedError(OUTPUT_INVALID);
      }
      format = { blockAlign };
    } else if (chunkId === 'data') {
      if (dataSize !== null || chunkSize === 0) throw codedError(OUTPUT_INVALID);
      dataSize = chunkSize;
    }

    // RIFF chunks with an odd payload use one padding byte that is excluded from chunkSize.
    offset = paddedEnd;
  }
  if (!format || dataSize === null || dataSize % format.blockAlign !== 0) throw codedError(OUTPUT_INVALID);
}

function assertWaveOutput(outputIdentity, outputName, outputPath) {
  const currentIdentity = inspectRealPath(outputIdentity.path, 'directory', OUTPUT_INVALID);
  if (!sameIdentity(currentIdentity, outputIdentity)) throw codedError(OUTPUT_INVALID);
  const entries = fs.readdirSync(outputIdentity.path);
  if (entries.length !== 1 || entries[0] !== outputName) throw codedError(OUTPUT_INVALID);
  const fileIdentity = inspectRealPath(outputPath, 'file', OUTPUT_INVALID);
  if (!samePath(fileIdentity.path, outputPath)) throw codedError(OUTPUT_INVALID);
  const stat = fs.statSync(fileIdentity.path);
  if (stat.size < 12 || stat.size > MAX_WAV_BYTES) throw codedError(OUTPUT_INVALID);
  const bytes = fs.readFileSync(fileIdentity.path);
  assertPcmWave(bytes);
  return sha256(bytes);
}

function createRedrawLocalTtsWorkerProcess(options = {}) {
  const context = options.context || 'production';
  if (context !== 'production' && context !== 'test') throw codedError(NOT_READY);
  if (typeof options.spawnImpl !== 'undefined' && typeof options.spawnImpl !== 'function') throw codedError(NOT_READY);
  if (typeof options.accessSync !== 'undefined' && typeof options.accessSync !== 'function') throw codedError(NOT_READY);
  if (typeof options.platform !== 'undefined' && typeof options.platform !== 'string') throw codedError(NOT_READY);
  if (typeof options.outputNameFactory !== 'undefined' && typeof options.outputNameFactory !== 'function') {
    throw codedError(NOT_READY);
  }
  if (typeof options.allowedOutputRoot !== 'string' || typeof options.expectedManifestSha256 !== 'string'
    || typeof options.expectedEngineVersion !== 'string') {
    throw codedError(NOT_READY);
  }
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw codedError(NOT_READY);
  const permissionOptions = {
    accessSync: options.accessSync,
    platform: options.platform,
  };

  let manifest;
  try {
    manifest = structuredClone(options.manifest);
  } catch (_) {
    throw codedError(NOT_READY);
  }
  const expectedManifestSha256 = options.expectedManifestSha256;
  const expectedEngineVersion = options.expectedEngineVersion;
  validateManifest(manifest, context, expectedManifestSha256, expectedEngineVersion);
  const executableIdentity = assertExecutable(manifest, undefined, permissionOptions);
  const allowedIdentity = assertAllowedRoot(options.allowedOutputRoot);
  const spawnImpl = options.spawnImpl || spawn;
  const outputNameFactory = options.outputNameFactory || (() => `${crypto.randomUUID()}.wav`);

  function assertConfigured() {
    validateManifest(manifest, context, expectedManifestSha256, expectedEngineVersion);
    assertExecutable(manifest, executableIdentity, permissionOptions);
    assertAllowedRoot(allowedIdentity.path, allowedIdentity);
  }

  function assertReady(locale) {
    assertConfigured();
    assertLocale(locale);
    if (!manifest.profiles.some((profile) => profile.locale === locale)) throw codedError(NOT_READY);
  }

  function synthesize(input) {
    return new Promise((resolve, reject) => {
      let child = null;
      let settled = false;
      let killAttempted = false;
      let timer = null;
      let abortHandler = null;
      let processListeners = [];

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (abortHandler && input?.signal) {
          try { input.signal.removeEventListener('abort', abortHandler); } catch (_) {}
        }
        abortHandler = null;
        for (const [emitter, event, handler] of processListeners) {
          try { emitter.removeListener(event, handler); } catch (_) {}
        }
        processListeners = [];
      };
      const listen = (emitter, event, handler) => {
        emitter.on(event, handler);
        processListeners.push([emitter, event, handler]);
      };
      const killOnce = () => {
        if (!child || killAttempted) return;
        killAttempted = true;
        try { child.kill(); } catch (_) {}
      };
      const rejectOnce = (code, shouldKill = true) => {
        if (settled) return;
        settled = true;
        if (shouldKill) killOnce();
        cleanup();
        reject(codedError(code));
      };
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      let profile;
      let outputIdentity;
      let outputName;
      let outputPath;
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw codedError(OUTPUT_INVALID);
        const hasSignal = Object.prototype.hasOwnProperty.call(input, 'signal');
        const inputKeys = hasSignal
          ? ['requestId', 'approvedText', 'locale', 'profileKey', 'outputRoot', 'signal']
          : ['requestId', 'approvedText', 'locale', 'profileKey', 'outputRoot'];
        if (!isExactObject(input, inputKeys)) throw codedError(OUTPUT_INVALID);
        assertReady(input.locale);
        if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.requestId)) {
          throw codedError(OUTPUT_INVALID);
        }
        if (typeof input.approvedText !== 'string' || input.approvedText.trim().length === 0
          || Buffer.byteLength(input.approvedText) > MAX_TEXT_BYTES) {
          throw codedError(OUTPUT_INVALID);
        }
        if (hasSignal && input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== 'boolean'
          || typeof input.signal.addEventListener !== 'function' || typeof input.signal.removeEventListener !== 'function')) {
          throw codedError(OUTPUT_INVALID);
        }
        if (input.signal?.aborted) {
          rejectOnce(RESULT_UNKNOWN, false);
          return;
        }
        profile = resolveProfile(manifest, input.locale, input.profileKey);
        assertAllowedRoot(allowedIdentity.path, allowedIdentity);
        outputIdentity = prepareOutputRoot(input.outputRoot, allowedIdentity);
        ({ outputName, outputPath } = resolveOutputPath(outputIdentity, outputNameFactory));
      } catch (error) {
        rejectOnce(error?.code || OUTPUT_INVALID, false);
        return;
      }

      const args = [
        '--stdin',
        '-v', profile.voice,
        '-p', String(profile.pitch),
        '-s', String(profile.rate),
        '-a', String(profile.amplitude),
        '-w', outputPath,
      ];
      try {
        child = spawnImpl(manifest.executable_path, args, {
          cwd: outputIdentity.path,
          env: safeWorkerEnv(),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (_) {
        rejectOnce(RESULT_UNKNOWN, false);
        return;
      }
      if (!child || typeof child.on !== 'function' || typeof child.kill !== 'function'
        || !child.stdin || typeof child.stdin.on !== 'function' || typeof child.stdin.end !== 'function'
        || !child.stdout || typeof child.stdout.on !== 'function'
        || !child.stderr || typeof child.stderr.on !== 'function') {
        rejectOnce(RESULT_UNKNOWN);
        return;
      }

      let stdoutBytes = 0;
      let stderrBytes = 0;
      const onDiagnostic = (kind, chunk) => {
        if (settled) return;
        const size = Buffer.byteLength(chunk);
        if (kind === 'stdout') stdoutBytes += size;
        else stderrBytes += size;
        if (stdoutBytes > MAX_DIAGNOSTIC_BYTES || stderrBytes > MAX_DIAGNOSTIC_BYTES || size > 0) {
          rejectOnce(RESULT_UNKNOWN);
        }
      };
      listen(child, 'error', () => rejectOnce(RESULT_UNKNOWN));
      listen(child.stdin, 'error', () => rejectOnce(RESULT_UNKNOWN));
      listen(child.stdout, 'error', () => rejectOnce(RESULT_UNKNOWN));
      listen(child.stderr, 'error', () => rejectOnce(RESULT_UNKNOWN));
      listen(child.stdout, 'data', (chunk) => onDiagnostic('stdout', chunk));
      listen(child.stderr, 'data', (chunk) => onDiagnostic('stderr', chunk));
      listen(child, 'close', (code) => {
        if (settled) return;
        if (code !== 0) {
          rejectOnce(RESULT_UNKNOWN, false);
          return;
        }
        try {
          assertAllowedRoot(allowedIdentity.path, allowedIdentity);
          const outputSha256 = assertWaveOutput(outputIdentity, outputName, outputPath);
          resolveOnce({
            source: 'local_offline_tts',
            engine: manifest.engine,
            engine_version: manifest.engine_version,
            binary_sha256: manifest.executable_sha256,
            manifest_sha256: manifest.manifest_sha256,
            target_locale: input.locale,
            output_path: outputPath,
            output_sha256: outputSha256,
            profile: { ...profile },
            completed_at: new Date().toISOString(),
            ...(manifest.test_only === true ? { test_only: true } : {}),
          });
        } catch (_) {
          rejectOnce(OUTPUT_INVALID, false);
        }
      });
      if (input.signal) {
        abortHandler = () => rejectOnce(RESULT_UNKNOWN);
        input.signal.addEventListener('abort', abortHandler, { once: true });
        if (input.signal.aborted) {
          rejectOnce(RESULT_UNKNOWN);
          return;
        }
      }
      timer = setTimeout(() => rejectOnce(RESULT_UNKNOWN), timeoutMs);
      try {
        child.stdin.end(input.approvedText);
      } catch (_) {
        rejectOnce(RESULT_UNKNOWN);
      }
    });
  }

  function assertEvidenceTrusted(evidence) {
    assertConfigured();
    const keys = manifest.test_only === true ? [...EVIDENCE_KEYS, 'test_only'] : EVIDENCE_KEYS;
    if (!isExactObject(evidence, keys)) throw codedError(NOT_READY);
    if (evidence.source !== 'local_offline_tts' || evidence.engine !== manifest.engine
      || evidence.engine_version !== manifest.engine_version
      || evidence.binary_sha256 !== manifest.executable_sha256
      || evidence.manifest_sha256 !== manifest.manifest_sha256) {
      throw codedError(NOT_READY);
    }
    if (manifest.test_only === true && evidence.test_only !== true) throw codedError(NOT_READY);
    assertLocale(evidence.target_locale);
    const profile = resolveProfile(manifest, evidence.target_locale, evidence.profile);
    return { profile: { ...profile } };
  }

  return { assertReady, synthesize, assertEvidenceTrusted };
}

module.exports = {
  canonicalManifestSha256,
  createRedrawLocalTtsWorkerProcess,
};
