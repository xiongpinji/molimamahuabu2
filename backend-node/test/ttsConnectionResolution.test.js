'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const tts = require('../src/services/ttsService');
const validMp3 = require('./fixtures/minimalMp3');

for (const [name, config, expected] of [
  ['MiniMax default preserves raw config key', { provider: 'MINIMAX', api_key: ' raw-key ' }, { kind: 'minimax', url: 'https://api.minimaxi.com/v1/t2a_v2', authorization: 'Bearer  raw-key ' }],
  ['MiniMax full endpoint', { provider: 'minimax', base_url: 'https://tts.synthetic.invalid/v1/t2a_v2///', api_key: '' }, { kind: 'minimax', url: 'https://tts.synthetic.invalid/v1/t2a_v2', authorization: 'Bearer ' }],
  ['OpenAI optional auth', { provider: 'openai', api_key: '' }, { kind: 'openai', url: 'https://api.openai.com/v1/audio/speech', authorization: null }],
  ['custom URL uses OpenAI branch', { provider: 'custom', base_url: 'https://tts.synthetic.invalid/custom///', api_key: 'config-key' }, { kind: 'openai', url: 'https://tts.synthetic.invalid/custom/audio/speech', authorization: 'Bearer config-key' }],
  ['unknown without URL', { provider: 'custom', api_key: 'not-enough' }, null],
]) test(`pure TTS connection: ${name}`, () => {
  assert.deepEqual(tts.resolveTtsConnection(config), expected);
});

// Replace only the transport boundary. The real synthesize, branch selection, body,
// response parsing, MP3 validation and persistence run unchanged; no socket is opened.
for (const provider of ['minimax', 'openai', 'custom']) for (const defaults of [false, true]) test(`real ${provider} synthesis consumes the same connection and preserves model/voice/body: defaults=${defaults}`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selected-tts-connection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const request = (...args) => {
    const [destination, options, callback] = args.length === 3 ? args : [null, args[0], args[1]];
    const req = new EventEmitter(); const chunks = [];
    req.write = (value) => { chunks.push(Buffer.from(value)); return true; };
    req.setTimeout = () => req;
    req.destroy = () => req;
    req.end = () => {
      calls.push({ destination, options, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const res = new EventEmitter(); res.statusCode = 200;
      res.headers = { 'content-type': provider === 'minimax' ? 'application/json' : 'audio/mpeg', 'x-request-id': 'synthetic-request' };
      res.complete = true; res.destroy = () => res;
      callback(res);
      queueMicrotask(() => {
        res.emit('data', provider === 'minimax' ? Buffer.from(JSON.stringify({ data: { audio: validMp3.toString('hex'), status: 2 },
          base_resp: { status_code: 0 }, extra_info: { audio_length: 1250 }, trace_id: 'synthetic-minimax-task' })) : validMp3);
        res.emit('end');
      });
      return req;
    };
    return req;
  };
  t.mock.method(http, 'request', request); t.mock.method(https, 'request', request);
  const config = { provider, base_url: 'https://tts.synthetic.invalid/v1///', api_key: provider === 'openai' ? '' : 'synthetic-config-key',
    default_model: defaults ? '' : 'pinned-speech-model',
    settings: defaults ? '{}' : JSON.stringify({ speed: 0.8, voice_id: 'configured-voice', volume: 0.7, pitch: 2 }) };
  const result = await tts.synthesize(null, { info() {} }, { config, text: 'Synthetic dialogue.', storage_base: root,
    ...(defaults ? {} : { voice_id: 'requested-voice', speed: 1.1, volume: 1.2, pitch: -1, emotion: 'happy', pronunciation_tones: ['word/(word)'] }) });
  assert.equal(calls.length, 1);
  const connection = tts.resolveTtsConnection(config);
  assert.ok(connection, 'the real synthesis branch must expose its actual connection');
  const call = calls[0];
  assert.equal(call.options.headers.Authorization ?? null, connection.authorization);
  assert.equal(call.destination ? call.destination.href : `https://${call.options.hostname}${call.options.path}`, connection.url);
  const model = defaults ? provider === 'minimax' ? 'speech-02-hd' : 'tts-1' : 'pinned-speech-model';
  const voice = defaults ? provider === 'minimax' ? 'female-shaonv' : 'alloy' : 'requested-voice';
  assert.equal(call.body.model, model);
  if (provider === 'minimax') assert.deepEqual(call.body, { model, text: 'Synthetic dialogue.', stream: false, output_format: 'hex',
    voice_setting: defaults ? { voice_id: voice, speed: 1, vol: 1, pitch: 0 }
      : { voice_id: voice, speed: 1.1, vol: 1.2, pitch: -1, emotion: 'happy' },
    ...(defaults ? {} : { pronunciation_dict: { tone: ['word/(word)'] } }),
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 } });
  else assert.deepEqual(call.body, { model, input: 'Synthetic dialogue.', voice, response_format: 'mp3', speed: defaults ? 1 : 1.1 });
  assert.equal(result.model, model); assert.equal(result.voice_id, voice);
  assert.deepEqual(fs.readFileSync(path.join(root, result.local_path)), validMp3);
});
