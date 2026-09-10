'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const PASSWORD = 'G3-local-synthetic-form-only-20260909!';
const SEGMENTS = [{ startMs: 1000, endMs: 2200,
  text: 'LOCAL DOUBLE ONLY: the second uploaded source.', speakerClusterId: 'speaker-cluster-1' }];

// Deliberately fabricated recognizer output. This is a connection regression,
// not evidence that sine audio contains speech or that a supplier is ready.
function localVisualDoubleFacts(duration, marker) {
  return {
    schema_version: '2.0', duration_ms: duration,
    story: [`LOCAL DOUBLE ONLY: ${marker}`],
    characters: [{ id: 'c1', display_name: 'Synthetic marker', relationships: [] }],
    scenes: [{ id: 's1', location: 'Synthetic test pattern', time: 'Synthetic',
      source_ranges: [{ start_ms: 0, end_ms: duration }] }],
    props: [{ id: 'p1', name: 'Synthetic pattern', evidence_ranges: [{ start_ms: 0, end_ms: duration }] }],
    shots: [{ id: 'shot1', index: 1, start_ms: 0, end_ms: duration,
      composition: marker, camera_movement: 'Static', opening_state: 'Pattern visible',
      continuous_action: 'Pattern persists', ending_state: 'Pattern visible',
      visible_character_ids: ['c1'], dialogue: [], text_regions: [],
      audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.9, speaker_mapping: 0, text_regions: 0.9, shot_boundary: 0.9 } }],
    causal_chain: [`LOCAL DOUBLE ONLY: ${marker}`], locked_facts: [`LOCAL DOUBLE ONLY: ${marker}`],
    reversals: ['LOCAL DOUBLE ONLY: No reversal is claimed for this synthetic pattern.'], episode_hook: 'Synthetic fixture ends.',
  };
}

async function createFixture(t) {
  // Requiring this helper without the reviewed, fresh, fixed launcher fails closed.
  const guard = globalThis.__g3MultiInputHttpGuard;
  assert.ok(guard, 'Use the reviewed g3-multi-input-http launcher; never bare node/npm');
  const { run, ffmpeg, ffprobe } = guard;
  const Database = require('better-sqlite3');
  const { createZipBuffer } = require('../../src/services/zipArchiveService');
  const express = require('express');
  const db = new Database(path.join(run, 'fixture.sqlite'));
  const storageRoot = path.join(run, 'storage');
  const privateAudioRoot = path.join(run, 'private-audio');
  const evidenceRoot = path.join(run, 'observed-media');
  for (const directory of [storageRoot, privateAudioRoot, evidenceRoot]) fs.mkdirSync(directory);
  const write = (name, data) => fs.writeFileSync(path.join(run, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (...args) => {
    const value = args.find((arg) => arg && typeof arg === 'object');
    fs.appendFileSync(path.join(run, 'application-events.jsonl'), JSON.stringify({ level,
      code: value?.err?.code || value?.code || null }) + '\n');
  }]));
  let server;
  const calls = { worker: [], vision: [] }, loginTokens = new Set();
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => {
      server.close(resolve); server.closeAllConnections();
    });
    try {
      write('final-state.json', {
        quick_check: db.pragma('quick_check'),
        works: db.prepare('SELECT * FROM redraw_works').all(),
        tasks: db.prepare('SELECT * FROM async_tasks').all(),
        blueprints: db.prepare('SELECT * FROM redraw_episode_blueprints').all(),
        assets: db.prepare('SELECT * FROM assets').all(), calls,
        boundary: 'Local synthetic HTTP connection only; G2, browser and recognition quality remain unverified.',
      });
    } finally { db.close(); }
  });
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  require('../../src/db/migrate').runMigrationsAndEnsure(db);
  const users = ['owner', 'other-owner'].map((name) => require('../../src/services/userAuthService').register(db, {
    email: `g3-multi-input-${name}-20260909@example.invalid`, password: PASSWORD,
  }));
  assert.ok(users.every((user) => user.role === 'user'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redraw_works').get().n, 0);

  // This otherwise-empty disposable DB contains test-only capability/price rows.
  // The true-shaped verification flag exercises the existing service contract;
  // it must never be copied into production or browser/provider acceptance data.
  const now = new Date().toISOString();
  const testOnlySettings = { test_only: true, evidence_scope: 'synthetic-local-double-not-provider-readiness',
    real_generation_verified: true, evidence: { provider_task_id: 'LOCAL-DOUBLE-ONLY',
      result_asset_id: 'LOCAL-DOUBLE-ONLY', result_asset_readable: true, completed_at: now } };
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, is_active, is_default, settings, created_at, updated_at)
    VALUES ('video_understanding', 'synthetic-local-double', 'TEST ONLY - NOT PROVIDER READINESS',
      'GPT-5.5', 'GPT-5.5', 1, 1, ?, ?, ?)`).run(JSON.stringify(testOnlySettings), now, now);
  require('../../src/services/modelPriceService').set(db, 'GPT-5.5', 6);

  const sources = [
    { name: '01-landscape-silent.mp4', width: 192, height: 128, durationMs: 12000, audio: false, speech: false },
    { name: '02-portrait-synthetic-audio.mov', width: 128, height: 192, durationMs: 14000, audio: true, speech: true },
    { name: '03-square-music-only.mp4', width: 160, height: 160, durationMs: 12000, audio: true, speech: false },
  ];
  function probe(file) {
    return JSON.parse(execFileSync(ffprobe,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
  }
  for (const source of sources) {
    source.path = path.join(run, source.name);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i',
      `testsrc=size=${source.width}x${source.height}:rate=4`,
      ...(source.audio ? ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=16000'] : []),
      '-t', String(source.durationMs / 1000), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-preset', 'ultrafast', ...(source.audio ? ['-c:a', 'aac', '-b:a', '32k'] : ['-an']),
      '-threads', '1', source.path];
    execFileSync(ffmpeg, args, { encoding: 'utf8' });
    source.sha256 = sha256(fs.readFileSync(source.path));
    source.probe = probe(source.path);
    const video = source.probe.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.width, source.width); assert.equal(video.height, source.height);
    assert.equal(Math.round(Number(video.duration) * 1000), source.durationMs);
    assert.equal(source.probe.streams.some((stream) => stream.codec_type === 'audio'), source.audio);
  }
  assert.equal(new Set(sources.map((source) => source.sha256)).size, sources.length);
  const zipBytes = createZipBuffer(sources.map((source) => [source.name, fs.readFileSync(source.path)]));
  fs.writeFileSync(path.join(run, 'three-new-synthetic-sources.zip'), zipBytes, { flag: 'wx' });
  write('synthetic-inputs.json', { sources, zip_sha256: sha256(zipBytes), testOnlySettings });

  const sourceAudioWorkerClient = {
    async analyzeSourceAudio(input) {
      const wav = fs.readFileSync(input.audioPath);
      assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
      assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
      assert.equal(sha256(wav), input.audioSha256);
      const extracted = probe(input.audioPath);
      assert.equal(extracted.streams[0].codec_name, 'pcm_s16le');
      assert.equal(extracted.streams[0].sample_rate, '16000');
      assert.equal(extracted.streams[0].channels, 1);
      const snapshot = path.join(path.dirname(input.audioPath), `source-${input.requestId}.bin`);
      const sourceSha256 = sha256(fs.readFileSync(snapshot));
      const source = sources.find((item) => item.sha256 === sourceSha256);
      assert.ok(source?.audio, 'Worker input must bind one uploaded source with an audio track');
      assert.ok(Math.abs(Number(extracted.format.duration) * 1000 - source.durationMs) < 100);
      const copied = path.join(evidenceRoot, `work-${input.requestId}-real-extracted.wav`);
      fs.writeFileSync(copied, wav, { flag: 'wx' });
      calls.worker.push({ request_id: input.requestId, source_sha256: source.sha256,
        audio_sha256: input.audioSha256, artifact: copied, probe: extracted });
      if (!source.speech) {
        return { requestId: input.requestId, audioSha256: input.audioSha256,
          transcriptSha256: sha256('[]'), sourceLanguage: null, languageProbability: null, segments: [],
          noSpeechEvidence: { method: 'faster-whisper-vad', audio_duration_ms: source.durationMs,
            speech_duration_ms: 0 } };
      }
      return { requestId: input.requestId, audioSha256: input.audioSha256,
        transcriptSha256: sha256(JSON.stringify(SEGMENTS)), sourceLanguage: 'en', languageProbability: 0.99,
        segments: SEGMENTS };
    },
  };
  async function localVisionDetailedDouble(payload) {
    const work = db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(payload.source.work_id);
    const source = sources.find((item) => item.sha256 === work.source_fingerprint);
    assert.ok(source, 'visual work must bind one of this run\'s three uploaded SHA values');
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(work.source_asset_id);
    assert.equal(payload.source.source_asset_id, asset.id);
    assert.equal(sha256(fs.readFileSync(path.join(storageRoot, asset.local_path))), source.sha256);
    const measured = payload.userPrompt.match(/Measured video metadata: duration_ms=(\d+), width=(\d+), height=(\d+)/);
    assert.ok(measured); assert.equal(Number(measured[2]), source.width); assert.equal(Number(measured[3]), source.height);
    assert.ok(payload.imageSources.length > 0 && payload.imageSources.length <= 6);
    const sheets = payload.imageSources.map(({ localAbsPath }, index) => {
      const bytes = fs.readFileSync(localAbsPath);
      assert.equal(bytes.readUInt16BE(0), 0xffd8);
      const image = probe(localAbsPath).streams[0];
      assert.equal(image.codec_name, 'mjpeg'); assert.ok(image.width > source.width && image.height > 0);
      const command = guard.commands.findLast((item) => item.output === localAbsPath);
      assert.equal(command?.kind, 'contact-sheet');
      assert.equal(command.source_sha256, source.sha256, 'sheet command must use this exact uploaded source');
      const artifact = path.join(evidenceRoot, `work-${work.id}-vision-${calls.vision.length + 1}-sheet-${index + 1}.jpg`);
      fs.writeFileSync(artifact, bytes, { flag: 'wx' });
      return { sha256: sha256(bytes), artifact, width: image.width, height: image.height };
    });
    calls.vision.push({ work_id: work.id, source_asset_id: asset.id, source_sha256: source.sha256,
      duration_ms: Number(measured[1]), sheets });
    return { text: JSON.stringify({ source_facts: localVisualDoubleFacts(Number(measured[1]), source.audio ? 'portrait synthetic sine pattern' : 'landscape silent synthetic pattern') }),
      provider_task_id: `local-double-vision-${calls.vision.length}`, model: 'GPT-5.5',
      raw_hash: sha256(`local double ${calls.vision.length}`), usage: { total_tokens: 10 } };
  }

  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    if (req.headers.authorization) assert.ok(loginTokens.has(req.headers.authorization.slice(7)),
      'Only tokens returned by this fixture\'s real HTTP login may be replayed');
    assert.equal(req.headers['x-tenant-id'], undefined, 'Use the default personal tenant');
    if (!((req.method === 'GET' && /^\/api\/v1\/(?:auth\/me|redraw\/(?:projects(?:\/\d+(?:\/works)?)?|works\/\d+(?:\/blueprint)?))$/.test(req.path))
      || (req.method === 'POST' && /^\/api\/v1\/(?:auth\/login|redraw\/(?:projects(?:\/\d+\/works)?|works\/\d+\/analyze))$/.test(req.path)))) {
      return res.status(403).json({ error: 'G3_HTTP_SCOPE_ONLY' });
    }
    res.on('finish', () => fs.appendFileSync(path.join(run, 'requests.jsonl'), JSON.stringify({
      method: req.method, path: req.path, status: res.statusCode,
    }) + '\n'));
    next();
  });
  app.use('/api/v1', require('../../src/routes').setupRouter({ storage: { local_path: storageRoot } }, db, log, {
    sourceAudioWorkerClient,
    redrawOptions: { visionDetailed: localVisionDetailedDouble,
      analysisOptions: { analysisContext: { privateAudioRoot } } },
  }));
  server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  function request(method, route, { token, json, upload } = {}) {
    const boundary = 'g3-synthetic-zip-boundary';
    const bytes = upload ? Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="three-new-synthetic-sources.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      zipBytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]) : json === undefined ? null : Buffer.from(JSON.stringify(json));
    assert.ok(!token || loginTokens.has(token), 'No fabricated JWT or out-of-band issueToken is allowed');
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(bytes ? { 'Content-Length': bytes.length,
      'Content-Type': upload ? `multipart/form-data; boundary=${boundary}` : 'application/json' } : {}) };
    return new Promise((resolve, reject) => {
      const req = http.request(`${origin}/api/v1${route}`, { method, headers, agent: false }, (res) => {
        const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (method === 'POST' && route === '/auth/login' && res.statusCode === 200 && typeof body.data?.token === 'string') {
              loginTokens.add(body.data.token);
            }
            resolve({ status: res.statusCode, body, headers: res.headers });
          }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(120000, () => req.destroy(new Error('G3_OWN_HTTP_TIMEOUT')));
      req.on('error', reject); req.end(bytes);
    });
  }
  return { db, run, storageRoot, sources, calls, users, request, write, password: PASSWORD, segments: SEGMENTS };
}

module.exports = { createFixture, sha256 };
