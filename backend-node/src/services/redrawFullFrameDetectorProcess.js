const { spawn } = require('node:child_process');
const path = require('node:path');

const ERROR_CODE = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';

function unavailable() {
  const error = new Error(ERROR_CODE);
  error.code = ERROR_CODE;
  return error;
}

function safeWorkerEnv() {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'];
  const env = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      env[key] = process.env[key];
    }
  }
  env.PYTHONUTF8 = '1';
  return env;
}

function assertFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw unavailable();
  const keys = Object.keys(frame);
  if (keys.length !== 3 || !keys.includes('frame_index') || !keys.includes('timestamp_ms') || !keys.includes('frame_path')) throw unavailable();
  if (!Number.isInteger(frame.frame_index) || frame.frame_index < 0) throw unavailable();
  if (!Number.isInteger(frame.timestamp_ms) || frame.timestamp_ms < 0) throw unavailable();
  if (typeof frame.frame_path !== 'string' || frame.frame_path.length === 0) throw unavailable();
}

function finite(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw unavailable();
  return value;
}

function id(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_:-]+$/.test(value)) throw unavailable();
  return value;
}

function bbox(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const keys = Object.keys(value);
  if (keys.length !== 4 || !keys.includes('x') || !keys.includes('y') || !keys.includes('width') || !keys.includes('height')) throw unavailable();
  const box = {
    x: finite(value.x),
    y: finite(value.y),
    width: finite(value.width),
    height: finite(value.height),
  };
  if (box.width <= 0 || box.height <= 0) throw unavailable();
  return box;
}

function confidence(value) {
  value = finite(value);
  if (value < 0 || value > 1) throw unavailable();
  return value;
}

function polygon(value) {
  if (!Array.isArray(value) || value.length < 3) throw unavailable();
  const points = value.map((point) => {
    if (!point || typeof point !== 'object' || Array.isArray(point)) throw unavailable();
    const keys = Object.keys(point);
    if (keys.length !== 2 || !keys.includes('x') || !keys.includes('y')) throw unavailable();
    return { x: finite(point.x), y: finite(point.y) };
  });
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  if (Math.abs(area) <= 1e-9) throw unavailable();
  return points;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const found = Object.keys(value);
  if (found.length !== keys.length || !keys.every((key) => found.includes(key))) throw unavailable();
}

function validateCandidate(kind, item) {
  if (kind === 'person') {
    exactKeys(item, ['candidate_id', 'track_key', 'kind', 'bbox', 'confidence']);
    if (item.kind !== 'person_candidate') throw unavailable();
    return { candidate_id: id(item.candidate_id), track_key: id(item.track_key), kind: item.kind, bbox: bbox(item.bbox), confidence: confidence(item.confidence) };
  }
  if (kind === 'face') {
    exactKeys(item, ['candidate_id', 'kind', 'bbox', 'confidence']);
    if (item.kind !== 'face_candidate') throw unavailable();
    return { candidate_id: id(item.candidate_id), kind: item.kind, bbox: bbox(item.bbox), confidence: confidence(item.confidence) };
  }
  exactKeys(item, ['candidate_id', 'kind', 'polygon', 'confidence']);
  if (item.kind !== 'text_candidate') throw unavailable();
  return { candidate_id: id(item.candidate_id), kind: item.kind, polygon: polygon(item.polygon), confidence: confidence(item.confidence) };
}

function validateResult(result) {
  exactKeys(result, ['frame_index', 'persons', 'faces', 'texts']);
  if (!Number.isInteger(result.frame_index) || result.frame_index < 0) throw unavailable();
  if (!Array.isArray(result.persons) || !Array.isArray(result.faces) || !Array.isArray(result.texts)) throw unavailable();
  return {
    frame_index: result.frame_index,
    persons: result.persons.map((item) => validateCandidate('person', item)),
    faces: result.faces.map((item) => validateCandidate('face', item)),
    texts: result.texts.map((item) => validateCandidate('text', item)),
  };
}

function detectFrames({ pythonPath, workerRoot, modelLockPath, frames, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof pythonPath !== 'string' || !pythonPath || typeof workerRoot !== 'string' || !workerRoot || typeof modelLockPath !== 'string' || !modelLockPath) throw unavailable();
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw unavailable();
      if (!Array.isArray(frames) || frames.length === 0) throw unavailable();
      const seen = new Set();
      const sortedFrames = frames.map((frame) => {
        assertFrame(frame);
        if (seen.has(frame.frame_index)) throw unavailable();
        seen.add(frame.frame_index);
        return {
          frame_index: frame.frame_index,
          timestamp_ms: frame.timestamp_ms,
          frame_path: frame.frame_path,
        };
      }).sort((a, b) => a.frame_index - b.frame_index);

      const workerPath = path.join(workerRoot, 'src', 'redraw_full_frame_auditor', 'worker.py');
      const child = spawn(pythonPath, [workerPath, 'run', '--model-lock', modelLockPath], {
        env: safeWorkerEnv(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let settled = false;
      let stdout = '';
      let stderr = '';
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        child.removeAllListeners();
        child.stdin.removeAllListeners();
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(unavailable());
      };
      const timer = setTimeout(() => {
        child.kill();
        fail();
      }, timeoutMs);

      child.on('error', fail);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => {
        if (settled) return;
        try {
          if (code !== 0 || stderr.length > 0) throw unavailable();
          const normalizedStdout = stdout.endsWith('\n') ? stdout.slice(0, -1).replace(/\r$/, '') : stdout;
          const lines = normalizedStdout.length === 0 ? [] : normalizedStdout.split(/\r?\n/);
          if (lines.some((line) => line.length === 0)) throw unavailable();
          if (lines.length !== sortedFrames.length) throw unavailable();
          const byFrame = new Map();
          for (const line of lines) {
            const parsed = validateResult(JSON.parse(line));
            if (!seen.has(parsed.frame_index) || byFrame.has(parsed.frame_index)) throw unavailable();
            byFrame.set(parsed.frame_index, parsed);
          }
          const ordered = sortedFrames.map((frame) => {
            const result = byFrame.get(frame.frame_index);
            if (!result) throw unavailable();
            return result;
          });
          settled = true;
          cleanup();
          resolve(ordered);
        } catch (_) {
          fail();
        }
      });

      for (const frame of sortedFrames) {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      }
      child.stdin.end();
    } catch (_) {
      reject(unavailable());
    }
  });
}

module.exports = { detectFrames, safeWorkerEnv };
