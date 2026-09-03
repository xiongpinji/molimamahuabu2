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

function validLocalVoiceRequest(audioPath) {
  return {
    requestId: 'voice-local-1:locale',
    audioPath,
    audioSha256: crypto.createHash('sha256').update('fake-audio').digest('hex'),
    approvedText: 'Anna did not pay 50 dollars.',
    locale: 'en-US',
    localTtsInvocation: {
      engine: 'eSpeak NG',
      engineVersion: '1.52.0',
      binarySha256: '6'.repeat(64),
      manifestSha256: '7'.repeat(64),
      profile: 'role-1',
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

function localVoiceOkResponse(request, overrides = {}) {
  return {
    ok: true,
    result: {
      source: 'offline-worker',
      request_id: request.request_id,
      audio_sha256: request.audio_sha256,
      approved_text_sha256: crypto.createHash('sha256').update(request.approved_text).digest('hex'),
      locale_pack: request.locale_pack,
      language_verified: true,
      detected_locale: 'en-US',
      transcript_sha256: '8'.repeat(64),
      model_manifest_sha256: 'a'.repeat(64),
      calibration_manifest_sha256: 'b'.repeat(64),
      models: {
        asr_revision: 'asr-pinned',
        accent_revision: 'accent-pinned',
        asr_tree_sha256: 'c'.repeat(64),
        accent_tree_sha256: 'd'.repeat(64),
      },
      asr: { ok: true, language: 'en', probability: 0.99 },
      accent: { ok: true, label: 'us', probability: 0.99 },
      metrics: {
        word_error_rate: 0,
        character_error_rate: 0,
        critical_tokens_match: true,
      },
      checks: {
        locale_pack: true,
        audio_path: true,
        audio_sha256_matches_request: true,
        asr_inference: true,
        accent_inference: true,
        calibration_thresholds: true,
        language: true,
        language_probability: true,
        word_error_rate: true,
        character_error_rate: true,
        critical_tokens_match: true,
        us_accent_label: true,
        us_accent_probability: true,
        model_manifest: true,
        calibration_manifest: true,
        models: true,
        transcript_present: true,
      },
      local_tts_invocation: { ...request.local_tts_invocation },
      completed_at: '2026-08-28T00:00:01.000Z',
      ...overrides,
    },
  };
}

function sourceAudioOkResponse(request, overrides = {}) {
  return {
    ok: true,
    result: {
      source_language: 'zh',
      language_probability: 0.98,
      segments: [{
        start: 0,
        end: 0.5,
        text: '你回来了',
        speaker_cluster_id: 'speaker-cluster-1',
      }],
      audio_sha256: request.audio_sha256,
      transcript_sha256: '9'.repeat(64),
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

test('client exposes the signed pack readiness assertion used by generation gates', () => {
  const expectedPack = nativePack();
  const calls = [];
  const client = createRedrawLocaleVerifierClient({
    socketPath: 'unused',
    registry: {
      assertReady(expected) {
        calls.push(expected);
        return expectedPack;
      },
    },
  });

  assert.equal(client.assertReady({ language: 'en', scope: 'language' }), expectedPack);
  assert.deepEqual(calls, [{ language: 'en', scope: 'language' }]);
});

test('source audio client sends exact hash-bound request and returns sanitized evidence', async () => {
  const audio = makeAudio();
  await withServer((socket, request) => {
    socket.end(`${JSON.stringify(sourceAudioOkResponse(request))}\n`);
  }, async ({ socketPath, state }) => {
    const client = clientFor(socketPath);
    assert.equal(typeof client.analyzeSourceAudio, 'function');
    const result = await client.analyzeSourceAudio({
      requestId: 'source-audio-1',
      audioPath: audio.audioPath,
      audioSha256: crypto.createHash('sha256').update('fake-audio').digest('hex'),
      privateAudioRoot: audio.tmp,
    });

    assert.equal(state.requestCount, 1);
    assert.deepEqual(Object.keys(state.requests[0]).sort(), [
      'action',
      'audio_path',
      'audio_sha256',
      'request_id',
    ]);
    assert.equal(state.requests[0].action, 'analyze_source_audio');
    assert.equal(result.requestId, 'source-audio-1');
    assert.equal(result.audioSha256, state.requests[0].audio_sha256);
    assert.equal(result.transcriptSha256, '9'.repeat(64));
    assert.equal(result.segments[0].speakerClusterId, 'speaker-cluster-1');
    assert.equal(Object.hasOwn(result, 'localPath'), false);
    assert.equal(JSON.stringify(result).includes(audio.audioPath), false);
  });
});

test('source audio client rejects hash drift and paths outside the private root before connecting', async () => {
  const audio = makeAudio();
  const outside = makeAudio();
  const client = clientFor('unused');
  const base = {
    requestId: 'source-audio-invalid',
    audioPath: audio.audioPath,
    audioSha256: crypto.createHash('sha256').update('fake-audio').digest('hex'),
    privateAudioRoot: audio.tmp,
  };
  await assert.rejects(
    () => client.analyzeSourceAudio({ ...base, audioSha256: '0'.repeat(64) }),
    { code: 'SOURCE_AUDIO_EVIDENCE_INVALID' },
  );
  await assert.rejects(
    () => client.analyzeSourceAudio({ ...base, audioPath: outside.audioPath }),
    { code: 'SOURCE_AUDIO_EVIDENCE_INVALID' },
  );
  await assert.rejects(
    () => client.analyzeSourceAudio({ ...base, requestId: '' }),
    { code: 'SOURCE_AUDIO_EVIDENCE_INVALID' },
  );
});

test('source audio client rejects response drift, unknown fields and absolute paths without retry', async () => {
  const cases = [
    { audio_sha256: '0'.repeat(64) },
    { transcript_sha256: 'bad' },
    { source_language: 'C:\\private\\audio.wav' },
    { segments: [{ start: 0, end: 0.5, text: 'C:\\private\\audio.wav', speaker_cluster_id: 'speaker-cluster-1' }] },
    { segments: [{ start: 0, end: 0.5, text: '你好', speaker_cluster_id: 'speaker-1' }] },
    { local_path: 'C:\\private\\audio.wav' },
  ];
  for (const overrides of cases) {
    const audio = makeAudio();
    await withServer((socket, request) => {
      socket.end(`${JSON.stringify(sourceAudioOkResponse(request, overrides))}\n`);
    }, async ({ socketPath, state }) => {
      await assert.rejects(
        () => clientFor(socketPath).analyzeSourceAudio({
          requestId: 'source-audio-drift',
          audioPath: audio.audioPath,
          audioSha256: crypto.createHash('sha256').update('fake-audio').digest('hex'),
          privateAudioRoot: audio.tmp,
        }),
        { code: 'SOURCE_AUDIO_EVIDENCE_INVALID' },
      );
      assert.equal(state.requestCount, 1);
    });
  }
});

test('source audio client maps transport uncertainty to one stable unknown result without retry', async () => {
  for (const handler of [
    () => {},
    (socket) => socket.end('partial'),
  ]) {
    const audio = makeAudio();
    await withServer(handler, async ({ socketPath, state }) => {
      const client = clientFor(socketPath, { timeoutMs: 30 });
      await assert.rejects(
        () => client.analyzeSourceAudio({
          requestId: 'source-audio-unknown',
          audioPath: audio.audioPath,
          audioSha256: crypto.createHash('sha256').update('fake-audio').digest('hex'),
          privateAudioRoot: audio.tmp,
        }),
        (error) => error.code === 'SOURCE_AUDIO_RESULT_UNKNOWN'
          && error.message === 'SOURCE_AUDIO_RESULT_UNKNOWN'
          && !Object.hasOwn(error, 'cause'),
      );
      assert.equal(state.requestCount, 1);
    });
  }
});

test('source audio client sanitizes deterministic worker rejection and does not retry', async () => {
  const audio = makeAudio();
  await withServer((socket) => {
    socket.end(`${JSON.stringify({ ok: false, error_code: 'C:\\private\\audio.wav' })}\n`);
  }, async ({ socketPath, state }) => {
    await assert.rejects(
      () => clientFor(socketPath).analyzeSourceAudio({
        requestId: 'source-audio-rejected',
        audioPath: audio.audioPath,
        audioSha256: crypto.createHash('sha256').update('fake-audio').digest('hex'),
        privateAudioRoot: audio.tmp,
      }),
      (error) => error.code === 'SOURCE_AUDIO_ANALYSIS_FAILED'
        && error.message === 'SOURCE_AUDIO_ANALYSIS_FAILED'
        && !JSON.stringify(error).includes('private'),
    );
    assert.equal(state.requestCount, 1);
  });
});

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

test('local voice client sends exact independent request and returns fully bound evidence', async () => {
  const audio = makeAudio();
  await withServer((socket, request) => {
    socket.end(`${JSON.stringify(localVoiceOkResponse(request))}\n`);
  }, async ({ socketPath, state }) => {
    const result = await clientFor(socketPath).verifyLocalVoice(validLocalVoiceRequest(audio.audioPath));

    assert.equal(state.requestCount, 1);
    const request = state.requests[0];
    assert.deepEqual(Object.keys(request).sort(), [
      'action',
      'approved_text',
      'audio_path',
      'audio_sha256',
      'local_tts_invocation',
      'locale_pack',
      'request_id',
    ]);
    assert.equal(request.action, 'verify_local_voice');
    assert.equal(request.audio_sha256,
      crypto.createHash('sha256').update(fs.readFileSync(audio.audioPath)).digest('hex'));
    assert.deepEqual(Object.keys(request.local_tts_invocation).sort(), [
      'binary_sha256',
      'engine',
      'engine_version',
      'manifest_sha256',
      'profile',
    ]);
    assert.equal(Object.hasOwn(request, 'tts_invocation'), false);
    assert.equal(Object.hasOwn(request, 'video_invocation'), false);
    assert.equal(JSON.stringify(request).includes('provider'), false);
    assert.equal(result.requestId, request.request_id);
    assert.equal(result.audioSha256, request.audio_sha256);
    assert.equal(result.approvedTextSha256,
      crypto.createHash('sha256').update(request.approved_text).digest('hex'));
    assert.equal(result.localePack, request.locale_pack);
    assert.equal(result.detectedLocale, 'en-US');
    assert.equal(result.languageVerified, true);
    assert.deepEqual(result.localTtsInvocation, validLocalVoiceRequest(audio.audioPath).localTtsInvocation);
    assert.equal(Object.hasOwn(result, 'approvedText'), false);
    assert.equal(JSON.stringify(result).includes(request.approved_text), false);
  });
});

test('local voice client rejects input hash drift and mixed local invocation before connecting', async () => {
  const audio = makeAudio();
  const base = validLocalVoiceRequest(audio.audioPath);
  const invalidInputs = [
    { ...base, audioSha256: '0'.repeat(64) },
    { ...base, localTtsInvocation: { ...base.localTtsInvocation, provider: 'minimax' } },
    { ...base, localTtsInvocation: { ...base.localTtsInvocation, model: 'speech-02-hd' } },
    { ...base, localTtsInvocation: { ...base.localTtsInvocation, aiServiceConfigId: 7 } },
    { ...base, localTtsInvocation: { ...base.localTtsInvocation, providerTaskId: 'secret-task' } },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      () => clientFor('unused').verifyLocalVoice(input),
      { code: 'REDRAW_LOCALE_EVIDENCE_INVALID' },
    );
  }
});

test('local voice client rejects response key and binding drift without leaking worker details', async () => {
  const cases = [
    { audio_sha256: '0'.repeat(64) },
    { approved_text_sha256: '0'.repeat(64) },
    { locale_pack: 'en-GB@1' },
    { detected_locale: 'en-GB' },
    { model_manifest_sha256: '0'.repeat(64) },
    { local_tts_invocation: { engine: 'other' } },
    { provider: 'must-not-be-accepted' },
  ];
  for (const overrides of cases) {
    const audio = makeAudio();
    await withServer((socket, request) => {
      const response = localVoiceOkResponse(request, overrides);
      if (overrides.local_tts_invocation) {
        response.result.local_tts_invocation = {
          ...request.local_tts_invocation,
          ...overrides.local_tts_invocation,
        };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    }, async ({ socketPath, state }) => {
      await assert.rejects(
        () => clientFor(socketPath).verifyLocalVoice(validLocalVoiceRequest(audio.audioPath)),
        { code: 'REDRAW_LOCALE_EVIDENCE_INVALID' },
      );
      assert.equal(state.requestCount, 1);
    });
  }

  const audio = makeAudio();
  await withServer((socket) => {
    socket.end(`${JSON.stringify({
      ok: false,
      error_code: 'C:\\private\\voice.wav',
      message: 'Anna did not pay 50 dollars. API_KEY=secret',
    })}\n`);
  }, async ({ socketPath }) => {
    await assert.rejects(
      () => clientFor(socketPath).verifyLocalVoice(validLocalVoiceRequest(audio.audioPath)),
      (error) => {
        assert.equal(error.code, 'REDRAW_LOCAL_TTS_VERIFICATION_FAILED');
        assert.equal(error.message, 'REDRAW_LOCAL_TTS_VERIFICATION_FAILED');
        assert.equal(JSON.stringify(error).includes('private'), false);
        assert.equal(JSON.stringify(error).includes('secret'), false);
        return true;
      },
    );
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

test('native client timeout and AbortSignal destroy socket and ignore late responses', async () => {
  {
    const audio = makeAudio();
    let closed = false;
    let lateWriteHadNoLiveSocket = false;
    await withServer((socket, request) => {
      socket.on('close', () => { closed = true; });
      setTimeout(() => {
        lateWriteHadNoLiveSocket = socket.destroyed || !socket.write(`${JSON.stringify(nativeOkResponse(request))}\n`);
      }, 80);
    }, async ({ socketPath, state }) => {
      const client = createRedrawLocaleVerifierClient({
        socketPath,
        timeoutMs: 20,
        registry: { assertReady: () => nativePack() },
      });
      await assert.rejects(
        () => client.verifyNativeAudio(validNativeRequest(audio.audioPath)),
        { code: 'REDRAW_LOCALE_VERIFIER_TIMEOUT' },
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(state.requestCount, 1);
      assert.equal(closed, true);
      assert.equal(lateWriteHadNoLiveSocket, true);
    });
  }

  {
    const audio = makeAudio();
    let closed = false;
    await withServer((socket) => {
      socket.on('close', () => { closed = true; });
    }, async ({ socketPath, state }) => {
      const controller = new AbortController();
      const client = createRedrawLocaleVerifierClient({
        socketPath,
        timeoutMs: 500,
        registry: { assertReady: () => nativePack() },
      });
      const promise = client.verifyNativeAudio({
        ...validNativeRequest(audio.audioPath),
        signal: controller.signal,
      });
      while (state.requestCount === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      controller.abort();
      await assert.rejects(() => promise, { code: 'REDRAW_LOCALE_VERIFIER_ABORTED' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(state.requestCount, 1);
      assert.equal(closed, true);
    });
  }
});
