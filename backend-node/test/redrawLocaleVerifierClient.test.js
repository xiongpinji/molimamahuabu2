const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

function nativePack() {
  return {
    id: 'es@1',
    language: 'es',
    locale: null,
    scope: 'language',
    prompt_language_label: '西班牙语',
    model_manifest_sha256: 'c'.repeat(64),
    calibration_manifest_sha256: 'd'.repeat(64),
    thresholds: {
      language_probability_min: 0.8,
      dialogue_similarity_min: 0.8,
      speech_chars_per_second_max: 20,
    },
  };
}

function validNativeRequest(audioPath) {
  return {
    audioPath,
    audioSha256: crypto.createHash('sha256').update('fake-audio').digest('hex'),
    approvedText: 'Hola, pequeño.',
    expectedLanguage: 'es',
    packId: 'es@1',
    detectedLanguage: 'en',
    detectedLocale: 'es-MX',
    thresholds: { language_probability_min: 0 },
    requestId: 'caller-must-not-control-this',
    videoInvocation: {
      provider: 'toapis',
      model: 'seedance-2-fast',
      aiServiceConfigId: 16,
      configUpdatedAt: '2026-08-09T00:00:00.000Z',
      providerTaskId: 'provider-real-1',
      artifactSha256: 'e'.repeat(64),
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

function nativeOkResponse(request, overrides = {}) {
  return {
    ok: true,
    result: {
      request_id: request.request_id,
      audio_sha256: request.audio_sha256,
      locale_pack: 'es@1',
      source: 'offline-worker',
      detected_language: 'es',
      detected_locale: null,
      language_verified: true,
      locale_verified: false,
      transcript_sha256: 'f'.repeat(64),
      transcript: 'must not be returned',
      metrics: { transcript: 'must not be returned' },
      dialogue_similarity: 0.96,
      speech_chars_per_second: 12.5,
      segments: [{ start_ms: 0, end_ms: 1200, text_sha256: '1'.repeat(64) }],
      model_manifest_sha256: 'c'.repeat(64),
      calibration_manifest_sha256: 'd'.repeat(64),
      video_invocation: {
        provider: request.video_invocation.provider,
        model: request.video_invocation.model,
        ai_service_config_id: request.video_invocation.ai_service_config_id,
        config_updated_at: request.video_invocation.config_updated_at,
        artifact_sha256: request.video_invocation.artifact_sha256,
        provider_task_id_sha256: crypto.createHash('sha256')
          .update(request.video_invocation.provider_task_id)
          .digest('hex'),
      },
      completed_at: '2026-08-09T00:00:01.000Z',
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

test('native client sends the exact server-generated language-pack request and returns bound evidence', async () => {
  const audio = makeAudio();
  await withServer((socket, request) => {
    socket.end(`${JSON.stringify(nativeOkResponse(request))}\n`);
  }, async ({ socketPath, state }) => {
    const client = createRedrawLocaleVerifierClient({
      socketPath,
      timeoutMs: 500,
      registry: {
        assertReady(expected) {
          assert.deepEqual(expected, {
            packId: 'es@1', language: 'es', locale: null, scope: 'language',
          });
          return nativePack();
        },
      },
    });
    const result = await client.verifyNativeAudio(validNativeRequest(audio.audioPath));

    assert.equal(state.requestCount, 1);
    const request = state.requests[0];
    assert.deepEqual(Object.keys(request).sort(), [
      'action',
      'approved_text',
      'audio_path',
      'audio_sha256',
      'locale_pack',
      'request_id',
      'video_invocation',
    ]);
    assert.equal(request.action, 'verify_native_audio');
    assert.notEqual(request.request_id, 'caller-must-not-control-this');
    assert.match(request.request_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(request.video_invocation).sort(), [
      'ai_service_config_id',
      'artifact_sha256',
      'config_updated_at',
      'model',
      'provider',
      'provider_task_id',
    ]);
    assert.equal(Object.hasOwn(request, 'detected_language'), false);
    assert.equal(Object.hasOwn(request, 'detected_locale'), false);
    assert.equal(Object.hasOwn(request, 'thresholds'), false);
    assert.equal(result.requestId, request.request_id);
    assert.equal(result.detectedLanguage, 'es');
    assert.equal(result.detectedLocale, null);
    assert.equal(result.languageVerified, true);
    assert.equal(result.localeVerified, false);
    assert.equal(result.dialogueSimilarity, 0.96);
    assert.equal(result.speechCharsPerSecond, 12.5);
    assert.deepEqual(result.segments, [{
      startMs: 0,
      endMs: 1200,
      textSha256: '1'.repeat(64),
    }]);
    assert.equal(result.videoInvocation.providerTaskIdSha256,
      crypto.createHash('sha256').update('provider-real-1').digest('hex'));
    assert.equal(Object.hasOwn(result, 'transcript'), false);
    assert.equal(JSON.stringify(result).includes('must not be returned'), false);
    assert.equal(JSON.stringify(result).includes('provider-real-1'), false);
  });
});

test('native client rejects language, locale, manifest, and video invocation evidence drift', async () => {
  const cases = [
    { request_id: undefined },
    { request_id: 'response-must-not-rebind-request' },
    { detected_language: 'en' },
    { detected_locale: 'es-MX' },
    { locale_verified: true },
    { model_manifest_sha256: '0'.repeat(64) },
    { transcript_sha256: undefined },
    { dialogue_similarity: '0.96' },
    { segments: [{ start_ms: 0, end_ms: 1200, text: 'must not leak' }] },
    { video_invocation: { provider: 'other' } },
  ];
  for (const overrides of cases) {
    const audio = makeAudio();
    await withServer((socket, request) => {
      const response = nativeOkResponse(request, overrides);
      if (overrides.video_invocation) {
        response.result.video_invocation = {
          ...nativeOkResponse(request).result.video_invocation,
          ...overrides.video_invocation,
        };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    }, async ({ socketPath, state }) => {
      const client = createRedrawLocaleVerifierClient({
        socketPath,
        timeoutMs: 500,
        registry: { assertReady: () => nativePack() },
      });
      await assert.rejects(
        () => client.verifyNativeAudio(validNativeRequest(audio.audioPath)),
        { code: 'REDRAW_LOCALE_EVIDENCE_INVALID' },
      );
      assert.equal(state.requestCount, 1);
    });
  }
});

test('native client reuses bounded single-line timeout and response limits', async () => {
  const cases = [
    {
      code: 'REDRAW_LOCALE_RESPONSE_TOO_LARGE',
      handler(socket) { socket.end(`${'x'.repeat(270 * 1024)}\n`); },
    },
    {
      code: 'REDRAW_LOCALE_VERIFIER_TIMEOUT',
      handler() {},
    },
  ];
  for (const item of cases) {
    const audio = makeAudio();
    await withServer(item.handler, async ({ socketPath, state }) => {
      const client = createRedrawLocaleVerifierClient({
        socketPath,
        timeoutMs: 50,
        registry: { assertReady: () => nativePack() },
      });
      await assert.rejects(
        () => client.verifyNativeAudio(validNativeRequest(audio.audioPath)),
        { code: item.code },
      );
      assert.equal(state.requestCount, 1);
    });
  }
});
