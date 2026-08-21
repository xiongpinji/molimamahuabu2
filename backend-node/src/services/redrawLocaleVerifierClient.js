const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');

const REQUEST_LIMIT_BYTES = 64 * 1024;
const RESPONSE_LIMIT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

function createRedrawLocaleVerifierClient(options = {}) {
  const socketPath = options.socketPath;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const registry = options.registry;
  if (!registry || typeof registry.assertReady !== 'function') {
    throw codedError('REDRAW_LOCALE_VERIFIER_CONFIG_INVALID');
  }

  async function verify(input = {}) {
    const pack = registry.assertReady(input.locale);
    const audioSha256 = await sha256File(input.audioPath);
    const request = toWorkerRequest(input, pack, audioSha256);
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line, 'utf8') > REQUEST_LIMIT_BYTES) {
      throw codedError('REDRAW_LOCALE_REQUEST_TOO_LARGE');
    }
    const response = await roundTrip(socketPath, line, timeoutMs);
    return validateWrapper(response, request, pack);
  }

  return { verify };
}

function toWorkerRequest(input, pack, audioSha256) {
  return {
    action: 'verify',
    request_id: String(input.requestId || ''),
    audio_path: String(input.audioPath || ''),
    audio_sha256: audioSha256,
    approved_text: String(input.approvedText || ''),
    locale_pack: pack.id,
    tts_invocation: {
      provider: String(input.ttsInvocation?.provider || ''),
      model: String(input.ttsInvocation?.model || ''),
      ai_service_config_id: Number(input.ttsInvocation?.aiServiceConfigId),
      config_updated_at: String(input.ttsInvocation?.configUpdatedAt || ''),
      provider_task_id: String(input.ttsInvocation?.providerTaskId || ''),
    },
  };
}

function roundTrip(socketPath, line, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer = '';
    let bytes = 0;
    const timer = setTimeout(() => {
      fail(codedError('REDRAW_LOCALE_VERIFIER_TIMEOUT'));
    }, timeoutMs);

    socket.setNoDelay(true);
    socket.on('connect', () => {
      socket.write(line);
    });
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > RESPONSE_LIMIT_BYTES) {
        fail(codedError('REDRAW_LOCALE_RESPONSE_TOO_LARGE'));
        return;
      }
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const firstLine = buffer.slice(0, newline);
      let parsed;
      try {
        parsed = JSON.parse(firstLine);
      } catch {
        fail(codedError('REDRAW_LOCALE_RESPONSE_INVALID_JSON'));
        return;
      }
      settle(() => resolve(parsed));
    });
    socket.on('end', () => {
      if (!settled && !buffer.includes('\n')) {
        fail(codedError('REDRAW_LOCALE_VERIFIER_CLOSED'));
      }
    });
    socket.on('close', () => {
      if (!settled && !buffer.includes('\n')) {
        fail(codedError('REDRAW_LOCALE_VERIFIER_CLOSED'));
      }
    });
    socket.on('error', (error) => {
      if (!settled) {
        const wrapped = codedError('REDRAW_LOCALE_VERIFIER_CONNECTION_FAILED');
        wrapped.cause = error;
        fail(wrapped);
      }
    });

    function settle(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    }

    function fail(error) {
      settle(() => reject(error));
    }
  });
}

function validateWrapper(response, request, pack) {
  if (!response || typeof response !== 'object') {
    throw codedError('REDRAW_LOCALE_EVIDENCE_INVALID');
  }
  if (response.ok === false) {
    throw codedError(String(response.error_code || 'REDRAW_LOCALE_VERIFY_FAILED'));
  }
  if (response.ok !== true || !response.result || typeof response.result !== 'object') {
    throw codedError('REDRAW_LOCALE_EVIDENCE_INVALID');
  }
  return validateEvidence(response.result, request, pack);
}

function validateEvidence(evidence, request, pack) {
  if (!evidence || typeof evidence !== 'object'
    || evidence.source !== 'offline-worker'
    || evidence.request_id !== request.request_id
    || evidence.audio_sha256 !== request.audio_sha256
    || evidence.locale_pack !== pack.id
    || evidence.model_manifest_sha256 !== pack.model_manifest_sha256
    || evidence.calibration_manifest_sha256 !== pack.calibration_manifest_sha256
    || evidence.language_verified !== true) {
    throw codedError('REDRAW_LOCALE_EVIDENCE_INVALID');
  }
  if (!isOptionalSha(evidence.transcript_sha256)) {
    throw codedError('REDRAW_LOCALE_EVIDENCE_INVALID');
  }
  return {
    requestId: evidence.request_id,
    source: evidence.source,
    audioSha256: request.audio_sha256,
    localePack: evidence.locale_pack,
    languageVerified: true,
    detectedLocale: evidence.detected_locale || null,
    transcriptSha256: evidence.transcript_sha256 || null,
    modelManifestSha256: evidence.model_manifest_sha256,
    calibrationManifestSha256: evidence.calibration_manifest_sha256,
    metrics: evidence.metrics || {},
    completedAt: evidence.completed_at || null,
  };
}

function isOptionalSha(value) {
  return value == null || /^[0-9a-f]{64}$/.test(String(value));
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (error) => {
      const wrapped = codedError('REDRAW_LOCALE_AUDIO_HASH_FAILED');
      wrapped.cause = error;
      reject(wrapped);
    });
  });
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  REQUEST_LIMIT_BYTES,
  RESPONSE_LIMIT_BYTES,
  createRedrawLocaleVerifierClient,
};
