const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const nativeAnalysis = require('../src/services/redrawNativeSourceAnalysisService');
const assetService = require('../src/services/assetService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function validFacts(durationMs = 1000) {
  return {
    schema_version: '2.0',
    duration_ms: durationMs,
    story: ['林娜在室内发现手机消息'],
    characters: [{ id: 'c1', source_name: '林娜', display_name: '林娜', relationship: '主人公', relationships: [] }],
    scenes: [{ id: 's1', location: '室内', time: '白天', source_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    props: [{ id: 'p1', name: '手机', evidence_ranges: [{ start_ms: 0, end_ms: Math.min(1000, durationMs) }] }],
    shots: [{
      id: 'sh1',
      index: 1,
      start_ms: 0,
      end_ms: durationMs,
      composition: '林娜站在室内桌边的中景',
      camera_movement: '固定机位',
      opening_state: '林娜看向镜头',
      continuous_action: '她举起手机',
      ending_state: '手机停在胸前',
      visible_character_ids: ['c1'],
      dialogue: [],
      text_regions: [{
        id: 'txt1',
        kind: 'subtitle',
        source_text: '未接来电',
        polygon: [[0.2, 0.82], [0.8, 0.82], [0.8, 0.92], [0.2, 0.92]],
      }],
      audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.82, speaker_mapping: 0.2, text_regions: 0.8, shot_boundary: 0.86 },
    }],
    causal_chain: ['林娜举起手机引出下一步行动'],
    locked_facts: ['林娜在室内拿着手机'],
    reversals: ['手机里有未知消息'],
    episode_hook: '未知消息即将揭晓',
  };
}

function addWork(db, { tenantId = 'tenant-1', userId = 'user-1', localPath }) {
  const now = new Date().toISOString();
  const asset = assetService.create(db, log, {
    name: 'source.mp4',
    type: 'video',
    category: 'redraw_source',
    local_path: localPath,
    mime_type: 'video/mp4',
    metadata: { tenant_id: tenantId, user_id: userId },
  });
  db.prepare(`
    INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, ?, ?, 'native test', 'draft', ?, ?)
  `).run(tenantId, userId, now, now);
  db.prepare(`
    INSERT INTO redraw_works
      (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, status, current_step, created_at, updated_at)
    VALUES (1, 1, ?, ?, 'native work', ?, 'source-hash', 15000, 'draft', 1, ?, ?)
  `).run(tenantId, userId, asset.id, now, now);
  return asset;
}

function createSampleVideo(storageRoot) {
  const relative = path.join('uploads', 'native-source.mp4').replace(/\\/g, '/');
  const absolute = path.join(storageRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=320x180:rate=12:duration=1',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=1',
    '-shortest',
    '-pix_fmt', 'yuv420p',
    absolute,
  ], { stdio: 'pipe' });
  return relative;
}

function createLateMarkerVideo(storageRoot) {
  const relative = path.join('uploads', 'native-late-marker.mp4').replace(/\\/g, '/');
  const absolute = path.join(storageRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=blue:size=320x180:rate=12:duration=15',
    '-f', 'lavfi',
    '-i', 'color=c=red:size=320x180:rate=12:duration=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p',
    absolute,
  ], { stdio: 'pipe' });
  return relative;
}

test('analyzeNativeSource creates contact sheets, strict facts JSON and a readable registered result asset', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-storage-'));
  const db = createDb();
  try {
    const sourceRelative = createSampleVideo(storageRoot);
    addWork(db, { localPath: sourceRelative });
    const calls = [];
    const result = await nativeAnalysis.analyzeNativeSource({
      db,
      log,
      storageRoot,
      assetService,
      visionDetailed: async (payload) => {
        calls.push(payload);
        assert.equal(payload.imageSources.length, 2);
        assert.match(payload.userPrompt, /schema_version.*2\.0/);
        assert.match(payload.userPrompt, /start_ms/);
        assert.match(payload.userPrompt, /end_ms/);
        assert.match(payload.userPrompt, /gap-free/);
        assert.match(payload.userPrompt, /do not guess speech/i);
        assert.match(payload.userPrompt, /audio_contract/);
        for (const source of payload.imageSources) {
          assert.match(source.localAbsPath, /redraw-native-/);
          assert.equal(path.resolve(source.localAbsPath).startsWith(path.resolve(storageRoot)), false);
          assert.equal(fs.existsSync(source.localAbsPath), true);
        }
        return {
          text: JSON.stringify({ source_facts: validFacts() }),
          provider_task_id: 'vision-real-id-1',
          model: 'vision-model',
          usage: { total_tokens: 123 },
          raw_hash: 'a'.repeat(64),
        };
      },
    }, {
      workId: 1,
      tenantId: 'tenant-1',
      userId: 'user-1',
      taskId: 'task-native-1',
      model: 'vision-model',
    });

    assert.equal(calls.length, 2, 'first pass plus enrichment pass');
    assert.match(calls[1].userPrompt, /adding recreation details to an existing short-drama analysis/);
    assert.equal(calls[1].options.max_tokens, 6000);
    assert.equal(result.status, 'completed');
    assert.equal(result.provider_task_id, 'vision-real-id-1');
    assert.equal(result.facts.characters[0].source_name, '林娜');
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.diagnostics.sheet_count, 2);
    assert.equal(JSON.stringify(result.diagnostics).includes(storageRoot), false);

    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(result.result_asset_id);
    assert.equal(asset.type, 'json');
    assert.equal(asset.category, 'redraw_source_analysis');
    assert.equal(path.isAbsolute(asset.local_path), false);
    const resultPath = path.join(storageRoot, asset.local_path);
    assert.equal(fs.existsSync(resultPath), true);
    const saved = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(saved.provider_task_id, 'vision-real-id-1');
    assert.equal(saved.schema_version, '2.0');
    assert.equal(saved.raw_hash, 'a'.repeat(64));
    assert.equal(saved.facts.facts_hash, result.facts.facts_hash);
    const metadata = JSON.parse(asset.metadata);
    assert.equal(metadata.schema_version, '2.0');
    assert.deepEqual(Object.keys(metadata.media_probe).sort(), ['codec', 'duration_ms', 'height', 'sheet_count', 'width']);
    assert.equal(typeof metadata.media_probe.duration_ms, 'number');
    assert.equal(typeof metadata.media_probe.width, 'number');
    assert.equal(typeof metadata.media_probe.height, 'number');
    assert.equal(typeof metadata.media_probe.codec, 'string');
    assert.equal(metadata.media_probe.sheet_count, 2);
    assert.equal(JSON.stringify(metadata.media_probe).includes(storageRoot), false);
    assert.equal(/(?:https?:\/\/|file:\/\/|[a-zA-Z]:\\|\\\\)/.test(JSON.stringify(metadata.media_probe)), false);
    assert.equal(calls[0].imageSources.every((source) => !fs.existsSync(source.localAbsPath)), true);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('sheetFilter adds fontfile only when an injected candidate exists', () => {
  const page = { frameCount: 1, startSeconds: 0, sampleRate: 1 };
  const withFont = nativeAnalysis.sheetFilter('full', page, {
    fontCandidates: [__filename],
  });
  assert.match(withFont, /drawtext=fontfile=/);
  assert.match(withFont, /redrawNativeSourceAnalysis\.test\.js/);

  const withoutFont = nativeAnalysis.sheetFilter('full', page, {
    fontCandidates: [path.join(os.tmpdir(), 'missing-redraw-font.ttf')],
  });
  assert.match(withoutFont, /drawtext=text=/);
  assert.doesNotMatch(withoutFont, /fontfile=/);
});

test('sheetFilter escapes drive-letter colons in absolute font paths', () => {
  const page = { frameCount: 1, startSeconds: 0, sampleRate: 1 };
  const fontPath = path.join(os.tmpdir(), `redraw-font-${process.pid}.ttf`);
  fs.writeFileSync(fontPath, '');
  try {
    const filter = nativeAnalysis.sheetFilter('full', page, { fontCandidates: [fontPath] });
    const fontOption = filter.match(/fontfile=('(?:[^'\\]|\\.)*')/)[1];
    assert.doesNotMatch(fontOption, /[^\\]:/);
    assert.doesNotMatch(fontOption, /\\(?!:)/);
  } finally {
    fs.rmSync(fontPath, { force: true });
  }
});

test('analyzeNativeSource samples the full duration and includes a distinct late frame', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-late-'));
  const db = createDb();
  try {
    const sourceRelative = createLateMarkerVideo(storageRoot);
    addWork(db, { localPath: sourceRelative });
    let sheetPaths = [];
    let sawLateRed = false;
    const result = await nativeAnalysis.analyzeNativeSource({
      db,
      log,
      storageRoot,
      assetService,
      visionDetailed: async (payload) => {
        sheetPaths = payload.imageSources.map((source) => source.localAbsPath);
        assert.equal(sheetPaths.length, 5);
        for (const sheetPath of sheetPaths) {
          const { data, info } = await sharp(sheetPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          for (let offset = 0; offset < data.length; offset += info.channels) {
            if (data[offset] > 180 && data[offset + 1] < 90 && data[offset + 2] < 90) {
              sawLateRed = true;
              break;
            }
          }
        }
        return {
          text: JSON.stringify({ source_facts: validFacts(16_000) }),
          provider_task_id: 'vision-late-id',
          model: 'vision-model',
          raw_hash: 'b'.repeat(64),
        };
      },
    }, {
      workId: 1,
      tenantId: 'tenant-1',
      userId: 'user-1',
      taskId: 'task-native-late',
      model: 'vision-model',
    });

    assert.equal(result.diagnostics.sheet_count, 5);
    assert.equal(sawLateRed, true);
    assert.equal(sheetPaths.every((sheetPath) => !fs.existsSync(sheetPath)), true);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('analyzeNativeSource rejects native dialogue without exact timings before asset creation', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-timing-'));
  const db = createDb();
  try {
    const sourceRelative = createSampleVideo(storageRoot);
    addWork(db, { localPath: sourceRelative });
    const facts = validFacts();
    facts.shots[0].audio_contract.dialogue_mode = 'spoken';
    facts.shots[0].dialogue.push({
      id: 't1',
      speaker_id: 'c1',
      source_text: '你好',
      end_ms: 900,
    });
    await assert.rejects(
      () => nativeAnalysis.analyzeNativeSource({
        db,
        log,
        storageRoot,
        assetService,
        visionDetailed: async () => ({
          text: JSON.stringify({ source_facts: facts }),
          provider_task_id: 'vision-missing-timing',
          model: 'vision-model',
          raw_hash: 'c'.repeat(64),
        }),
      }, {
        workId: 1,
        tenantId: 'tenant-1',
        userId: 'user-1',
        taskId: 'task-native-timing',
        model: 'vision-model',
      }),
      /start_ms|dialogue/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_analysis'").get().count,
      0,
    );
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('analyzeNativeSource lowers speaker confidence without transcript evidence and recomputes hash', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-evidence-'));
  const db = createDb();
  try {
    const sourceRelative = createSampleVideo(storageRoot);
    addWork(db, { localPath: sourceRelative });
    const providerFacts = validFacts();
    providerFacts.shots[0].audio_contract.dialogue_mode = 'spoken';
    providerFacts.shots[0].dialogue.push({
      id: 't1',
      speaker_id: 'c1',
      start_ms: 100,
      end_ms: 600,
      source_text: '我看到了',
    });
    providerFacts.shots[0].confidence.speaker_mapping = 0.95;

    const result = await nativeAnalysis.analyzeNativeSource({
      db,
      log,
      storageRoot,
      assetService,
      visionDetailed: async () => ({
        text: JSON.stringify({ source_facts: providerFacts }),
        provider_task_id: 'vision-evidence-id',
        model: 'vision-model',
        raw_hash: 'd'.repeat(64),
      }),
    }, {
      workId: 1,
      tenantId: 'tenant-1',
      userId: 'user-1',
      taskId: 'task-native-evidence',
      model: 'vision-model',
    });

    assert.equal(providerFacts.shots[0].confidence.speaker_mapping, 0.95);
    assert.equal(result.facts.shots[0].confidence.speaker_mapping, 0);
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(result.result_asset_id);
    const saved = JSON.parse(fs.readFileSync(path.join(storageRoot, asset.local_path), 'utf8'));
    const metadata = JSON.parse(asset.metadata);
    assert.equal(saved.facts.shots[0].confidence.speaker_mapping, 0);
    assert.equal(metadata.facts_hash, result.facts.facts_hash);
    assert.equal(saved.facts.facts_hash, result.facts.facts_hash);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('analyzeNativeSource rejects guessed spoken dialogue without visible text evidence', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-no-text-'));
  const db = createDb();
  try {
    const sourceRelative = createSampleVideo(storageRoot);
    addWork(db, { localPath: sourceRelative });
    const facts = validFacts();
    facts.shots[0].audio_contract.dialogue_mode = 'spoken';
    facts.shots[0].dialogue.push({
      id: 't1',
      speaker_id: 'c1',
      start_ms: 100,
      end_ms: 600,
      source_text: '我看到了',
    });
    facts.shots[0].text_regions = [];

    await assert.rejects(
      () => nativeAnalysis.analyzeNativeSource({
        db,
        log,
        storageRoot,
        assetService,
        visionDetailed: async () => ({
          text: JSON.stringify({ source_facts: facts }),
          provider_task_id: 'vision-no-text-id',
          model: 'vision-model',
          raw_hash: 'e'.repeat(64),
        }),
      }, {
        workId: 1,
        tenantId: 'tenant-1',
        userId: 'user-1',
        taskId: 'task-native-no-text',
        model: 'vision-model',
      }),
      (error) => error.code === 'REDRAW_NATIVE_DIALOGUE_TEXT_EVIDENCE_REQUIRED',
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_analysis'").get().count,
      0,
    );
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('analyzeNativeSource enforces tenant and user ownership before reading source files', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-owner-'));
  const db = createDb();
  try {
    const sourceRelative = createSampleVideo(storageRoot);
    addWork(db, { tenantId: 'tenant-1', userId: 'user-1', localPath: sourceRelative });

    await assert.rejects(
      () => nativeAnalysis.analyzeNativeSource({
        db,
        log,
        storageRoot,
        assetService,
        visionDetailed: async () => { throw new Error('should not call provider'); },
      }, {
        workId: 1,
        tenantId: 'tenant-2',
        userId: 'user-1',
        taskId: 'task-native-owner',
      }),
      (error) => error.code === 'REDRAW_WORK_NOT_FOUND',
    );
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('analyzeNativeSource rejects absolute, traversal and symlink source paths and cleans its work dir on failure', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-secure-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-outside-'));
  const db = createDb();
  try {
    const outsideVideo = path.join(outsideRoot, 'outside.mp4');
    fs.writeFileSync(outsideVideo, 'outside');
    addWork(db, { localPath: outsideVideo });
    await assert.rejects(
      () => nativeAnalysis.analyzeNativeSource({
        db,
        log,
        storageRoot,
        assetService,
        visionDetailed: async () => { throw new Error('should not call provider'); },
      }, {
        workId: 1,
        tenantId: 'tenant-1',
        userId: 'user-1',
        taskId: 'task-native-absolute',
      }),
      (error) => error.code === 'SOURCE_PATH_UNSAFE',
    );
    assert.equal(fs.existsSync(path.join(storageRoot, 'redraw-analysis', 'task-native-absolute')), false);

    db.prepare('DELETE FROM assets').run();
    db.prepare('DELETE FROM redraw_works').run();
    db.prepare('DELETE FROM redraw_projects').run();
    addWork(db, { localPath: '../outside.mp4' });
    await assert.rejects(
      () => nativeAnalysis.analyzeNativeSource({
        db,
        log,
        storageRoot,
        assetService,
        visionDetailed: async () => { throw new Error('should not call provider'); },
      }, {
        workId: 1,
        tenantId: 'tenant-1',
        userId: 'user-1',
        taskId: 'task-native-traversal',
      }),
      (error) => error.code === 'SOURCE_PATH_UNSAFE',
    );

    const sourceRelative = createSampleVideo(storageRoot);
    const linkRelative = path.join('uploads', 'linked-outside.mp4').replace(/\\/g, '/');
    try {
      fs.symlinkSync(outsideVideo, path.join(storageRoot, linkRelative));
      db.prepare('DELETE FROM assets').run();
      db.prepare('DELETE FROM redraw_works').run();
      db.prepare('DELETE FROM redraw_projects').run();
      addWork(db, { localPath: linkRelative });
      await assert.rejects(
        () => nativeAnalysis.analyzeNativeSource({
          db,
          log,
          storageRoot,
          assetService,
          visionDetailed: async () => { throw new Error('should not call provider'); },
        }, {
          workId: 1,
          tenantId: 'tenant-1',
          userId: 'user-1',
          taskId: 'task-native-symlink',
        }),
        (error) => error.code === 'SOURCE_PATH_UNSAFE',
      );
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      assert.ok(sourceRelative);
    }
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('coerceCharacterFields turns object relationships into text and fills an empty source_name', () => {
  const coerced = nativeAnalysis.coerceCharacterFields({
    characters: [
      { id: 'c1', source_name: '', display_name: 'Student with bicycle', relationships: [{ character_id: 'c2', relationship: 'classmate who mocks him' }, 'friend of c3'] },
      { id: 'c2', source_name: '陆飞', display_name: 'Lu Fei', relationships: [] },
    ],
  });
  assert.equal(coerced.characters[0].source_name, 'Student with bicycle');
  assert.deepEqual(coerced.characters[0].relationships, ['c2: classmate who mocks him', 'friend of c3']);
  assert.equal(coerced.characters[1].source_name, '陆飞');
});

test('coerceShotAudioContracts drops off-screen dialogue turns and settles invented dialogue modes', () => {
  const coerced = nativeAnalysis.coerceShotAudioContracts({
    shots: [
      {
        id: 'a', visible_character_ids: ['c1'],
        dialogue: [{ speaker_id: 'c1', source_text: '你好' }, { speaker_id: 'c2', source_text: '画外音' }],
        audio_contract: { dialogue_mode: 'subtitle_only', ambient_audio: 'preserve_or_rebuild' },
      },
      {
        id: 'b', visible_character_ids: ['c1'],
        dialogue: [{ speaker_id: 'c2', source_text: '画外音' }],
        audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
      },
      {
        id: 'c', visible_character_ids: [], dialogue: [],
        audio_contract: { dialogue_mode: 'subtitle_only', ambient_audio: 'preserve_or_rebuild' },
      },
    ],
  });
  assert.deepEqual(coerced.shots[0].dialogue.map((turn) => turn.speaker_id), ['c1']);
  assert.equal(coerced.shots[0].audio_contract.dialogue_mode, 'spoken');
  assert.deepEqual(coerced.shots[1].dialogue, []);
  assert.equal(coerced.shots[1].audio_contract.dialogue_mode, 'silent');
  assert.equal(coerced.shots[2].audio_contract.dialogue_mode, 'silent');
});

test('analyzeNativeSource retries a part once when the provider call times out, but not on other errors', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-retry-'));
  const db = createDb();
  try {
    addWork(db, { localPath: createSampleVideo(storageRoot) });
    const facts = validFacts();
    facts.shots[0].visible_character_ids = ['c1'];
    facts.shots[0].text_regions = [{
      id: 't1', kind: 'subtitle', source_text: '你好', polygon: [[0.1, 0.8], [0.9, 0.8], [0.9, 0.9], [0.1, 0.9]],
    }];
    let firstPassCalls = 0;
    const result = await nativeAnalysis.analyzeNativeSource({
      db,
      log,
      storageRoot,
      assetService,
      visionDetailed: async (payload) => {
        if (/recreation details/.test(payload.userPrompt)) throw new Error('enrichment skipped in this test');
        firstPassCalls += 1;
        if (firstPassCalls === 1) {
          throw Object.assign(new Error('AI non-stream request timeout after 540000ms'), { code: 'AI_NON_STREAM_TIMEOUT' });
        }
        return { text: JSON.stringify({ source_facts: facts }), provider_task_id: 'vision-retry', model: 'm' };
      },
    }, { workId: 1, tenantId: 'tenant-1', userId: 'user-1', taskId: 'task-native-retry', model: 'm' });
    assert.equal(firstPassCalls, 2, 'the timed out part ran once more');
    assert.ok(result.result_asset_id);

    let failingCalls = 0;
    await assert.rejects(nativeAnalysis.analyzeNativeSource({
      db,
      log,
      storageRoot,
      assetService,
      visionDetailed: async () => {
        failingCalls += 1;
        throw new Error('HTTP 400 bad request');
      },
    }, { workId: 1, tenantId: 'tenant-1', userId: 'user-1', taskId: 'task-native-noretry', model: 'm' }), /HTTP 400/);
    assert.equal(failingCalls, 1, 'other errors are not retried');
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('coerceShotAudioContracts clamps dialogue that runs past its shot into the shot range', () => {
  const shot = (id, startMs, endMs, dialogue) => ({
    id, start_ms: startMs, end_ms: endMs, visible_character_ids: ['c1', 'c2'], dialogue,
    audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
  });
  const coerced = nativeAnalysis.coerceShotAudioContracts({
    shots: [
      shot('a', 0, 3000, [
        { speaker_id: 'c1', source_text: '跨过剪辑点', start_ms: 2200, end_ms: 3600 },
      ]),
      shot('b', 3000, 6000, [
        { speaker_id: 'c1', source_text: '提前开口', start_ms: 2600, end_ms: 4000 },
        { speaker_id: 'c2', source_text: '和上一句重叠', start_ms: 3800, end_ms: 5000 },
        { speaker_id: 'c2', source_text: '同组抢话', start_ms: 4500, end_ms: 5200, overlap_group: 'g' },
        { speaker_id: 'c1', source_text: '同组抢话', start_ms: 4800, end_ms: 5400, overlap_group: 'g' },
      ]),
      shot('c', 6000, 9000, [
        { speaker_id: 'c1', source_text: '整句在别的分镜', start_ms: 1000, end_ms: 2000 },
      ]),
    ],
  });
  assert.deepEqual(coerced.shots[0].dialogue.map((turn) => [turn.start_ms, turn.end_ms]), [[2200, 3000]]);
  assert.deepEqual(coerced.shots[1].dialogue.map((turn) => [turn.start_ms, turn.end_ms]), [
    [3000, 4000], [4000, 5000], [5000, 5200], [4800, 5400],
  ]);
  assert.deepEqual(coerced.shots[2].dialogue, []);
  assert.equal(coerced.shots[2].audio_contract.dialogue_mode, 'silent');
});
