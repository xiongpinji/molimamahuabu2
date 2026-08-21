const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createRedrawLocaleVerifierClient } = require('../src/services/redrawLocaleVerifierClient');

function pack() {
  return {
    id: 'en-US@1',
    locale: 'en-US',
    model_manifest_sha256: 'a'.repeat(64),
    calibration_manifest_sha256: 'b'.repeat(64),
  };
}

function validRequest(audioPath) {
  return {
    requestId: 'voice-1:locale',
    audioPath,
    approvedText: 'Anna did not pay 50 dollars.',
    locale: 'en-US',
    ttsInvocation: {
      provider: 'minimax',
      model: 'speech-02-hd',
      aiServiceConfigId: 7,
      configUpdatedAt: '2026-08-08T00:00:00.000Z',
      providerTaskId: 'task-1',
    },
  };
}

function makeAudio() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-locale-client-'));
  const audioPath = path.join(tmp, 'voice.wav');
  fs.writeFileSync(audioPath, Buffer.from('fake-audio'));
  return { tmp, audioPath };
}

function okResponse(request, overrides = {}) {
  return {
    ok: true,
    result: {
      request_id: request.request_id,
      audio_sha256: request.audio_sha256,
      locale_pack: 'en-US@1',
      source: 'offline-worker',
      language_verified: true,
      detected_locale: 'en-US',
      transcript_sha256: 'c'.repeat(64),
      model_manifest_sha256: 'a'.repeat(64),
      calibration_manifest_sha256: 'b'.repeat(64),
      metrics: { word_error_rate: 0 },
      completed_at: '2026-08-08T00:00:01.000Z',
      ...overrides,
    },
  };
}

async function withServer(handler, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-locale-sock-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\redraw-locale-${process.pid}-${Date.now()}-${Math.random()}`
    : path.join(tmp, 'verifier.sock');
  const state = { requestCount: 0, requests: [] };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let body = '';
    socket.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (!body.includes('\n')) return;
      state.requestCount += 1;
      state.requests.push(JSON.parse(body.trim()));
      handler(socket, state.requests.at(-1), state);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    return await fn({ socketPath, state });
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

function clientFor(socketPath, options = {}) {
  return createRedrawLocaleVerifierClient({
    socketPath,
    timeoutMs: 500,
    registry: {
      assertReady(locale) {
        assert.equal(locale, 'en-US');
        return pack();
      },
    },
    ...options,
  });
}

test('client maps camelCase request fields, hashes audio, and returns camelCase evidence', async () => {
  const audio = makeAudio();
  await withServer((socket, request) => {
    socket.end(`${JSON.stringify(okResponse(request, {
      raw: { should_not_leak: true },
      transcript: 'Anna did not pay 50 dollars.',
      transcript_text: 'Anna did not pay 50 dollars.',
      approved_text: request.approved_text,
    }))}\n`);
  }, async ({ socketPath, state }) => {
    const result = await clientFor(socketPath).verify(validRequest(audio.audioPath));
    assert.equal(state.requestCount, 1);
    assert.deepEqual(Object.keys(state.requests[0]).sort(), [
      'action',
      'approved_text',
      'audio_path',
      'audio_sha256',
      'locale_pack',
      'request_id',
      'tts_invocation',
    ]);
    assert.equal(state.requests[0].tts_invocation.ai_service_config_id, 7);
    assert.equal(result.requestId, 'voice-1:locale');
    assert.equal(result.audioSha256, state.requests[0].audio_sha256);
    assert.equal(result.source, 'offline-worker');
    assert.equal(result.modelManifestSha256, 'a'.repeat(64));
    assert.equal(result.calibrationManifestSha256, 'b'.repeat(64));
    assert.equal(Object.hasOwn(result, 'raw'), false);
    assert.equal(Object.hasOwn(result, 'transcript'), false);
    assert.equal(Object.hasOwn(result, 'transcriptText'), false);
    assert.equal(Object.hasOwn(result, 'approvedText'), false);
  });
});

test('client rejects response drift and does not retry', async () => {
  const audio = makeAudio();
  await withServer((socket, request) => {
    socket.end(`${JSON.stringify(okResponse(request, { audio_sha256: 'd'.repeat(64) }))}\n`);
  }, async ({ socketPath, state }) => {
    await assert.rejects(() => clientFor(socketPath).verify(validRequest(audio.audioPath)), {
      code: 'REDRAW_LOCALE_EVIDENCE_INVALID',
    });
    assert.equal(state.requestCount, 1);
  });
});

test('client requires offline-worker evidence source', async () => {
  const cases = [
    { name: 'missing', overrides: { source: undefined } },
    { name: 'wrong', overrides: { source: 'tts-provider' } },
  ];
  for (const item of cases) {
    const audio = makeAudio();
    await withServer((socket, request) => {
      const response = okResponse(request, item.overrides);
      if (item.name === 'missing') {
        delete response.result.source;
      }
      socket.end(`${JSON.stringify(response)}\n`);
    }, async ({ socketPath, state }) => {
      await assert.rejects(() => clientFor(socketPath).verify(validRequest(audio.audioPath)), {
        code: 'REDRAW_LOCALE_EVIDENCE_INVALID',
      });
      assert.equal(state.requestCount, 1);
    });
  }
});

test('client maps worker ok:false error_code without retry', async () => {
  const audio = makeAudio();
  await withServer((socket) => {
    socket.end(`${JSON.stringify({
      ok: false,
      error_code: 'LOCALE_VERIFY_REQUEST_INVALID',
      message: 'worker rejected request',
    })}\n`);
  }, async ({ socketPath, state }) => {
    await assert.rejects(() => clientFor(socketPath).verify(validRequest(audio.audioPath)), {
      code: 'LOCALE_VERIFY_REQUEST_INVALID',
    });
    assert.equal(state.requestCount, 1);
  });
});

test('client rejects malformed worker wrapper', async () => {
  const audio = makeAudio();
  await withServer((socket, request) => {
    socket.end(`${JSON.stringify({ result: okResponse(request).result })}\n`);
  }, async ({ socketPath, state }) => {
    await assert.rejects(() => clientFor(socketPath).verify(validRequest(audio.audioPath)), {
      code: 'REDRAW_LOCALE_EVIDENCE_INVALID',
    });
    assert.equal(state.requestCount, 1);
  });
});

test('client rejects oversized, invalid, timeout, and close-before-newline responses without retry', async () => {
  const cases = [
    {
      code: 'REDRAW_LOCALE_RESPONSE_TOO_LARGE',
      handler(socket) { socket.end(`${'x'.repeat(270 * 1024)}\n`); },
    },
    {
      code: 'REDRAW_LOCALE_RESPONSE_INVALID_JSON',
      handler(socket) { socket.end('{bad-json}\n'); },
    },
    {
      code: 'REDRAW_LOCALE_VERIFIER_TIMEOUT',
      handler() {},
    },
    {
      code: 'REDRAW_LOCALE_VERIFIER_CLOSED',
      handler(socket) { socket.end('partial'); },
    },
  ];
  for (const item of cases) {
    const audio = makeAudio();
    await withServer(item.handler, async ({ socketPath, state }) => {
      await assert.rejects(() => clientFor(socketPath).verify(validRequest(audio.audioPath)), {
        code: item.code,
      });
      assert.equal(state.requestCount, 1);
    });
  }
});

test('client rejects oversized requests before connecting', async () => {
  const audio = makeAudio();
  const client = clientFor('unused', {
    registry: { assertReady: () => ({ ...pack(), id: `en-US@1${'x'.repeat(70 * 1024)}` }) },
  });
  await assert.rejects(() => client.verify(validRequest(audio.audioPath)), {
    code: 'REDRAW_LOCALE_REQUEST_TOO_LARGE',
  });
});
