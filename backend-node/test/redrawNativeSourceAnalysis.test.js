const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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

    assert.equal(calls.length, 1);
    assert.equal(result.status, 'completed');
    assert.equal(result.provider_task_id, 'vision-real-id-1');
    assert.equal(result.facts.characters[0].source_name, '林娜');
    assert.deepEqual(result.source, {
      asset_id: 1,
      sha256: crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(storageRoot, sourceRelative)))
        .digest('hex'),
      duration_ms: 1_000,
      width: 320,
      height: 180,
      fps: 12,
      video_codec: 'h264',
      audio_codec: 'aac',
      audio_sample_rate_hz: 44_100,
      audio_channels: 1,
    });
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

test('buildPrompt sends only minimal transcript evidence and forbids transcript rewriting or identity claims', () => {
  const prompt = nativeAnalysis.buildPrompt({ duration_ms: 6_000, width: 1080, height: 1920 }, {
    result_asset_id: 202,
    dialogue_mode: 'spoken',
    source_language: 'zh-CN',
    local_path: 'C:\\private\\audio.wav',
    api_key: 'must-not-leak',
    segments: [{
      id: 'audio-segment-1',
      evidence_ref: 'evidence-audio-1',
      start_ms: 500,
      end_ms: 1_200,
      source_text: '这是谁寄来的？',
      speaker_cluster_id: 'speaker-cluster-2',
    }],
  });

  assert.match(prompt, /Do not rewrite transcript text/);
  assert.match(prompt, /speaker-cluster-2/);
  assert.match(prompt, /这是谁寄来的？/);
  assert.match(prompt, /evidence-audio-1/);
  assert.match(prompt, /visual evidence.*possible association/i);
  assert.doesNotMatch(prompt, /No transcript evidence is provided here/);
  assert.doesNotMatch(prompt, /C:\\private|must-not-leak|api_key/i);

  assert.throws(
    () => nativeAnalysis.buildPrompt({ duration_ms: 6_000, width: 1080, height: 1920 }, {
      dialogue_mode: 'spoken',
      source_language: 'zh-CN',
      segments: [{
        start_ms: 500,
        end_ms: 1_200,
        source_text: '打开 C:\\private\\secret.txt',
        speaker_cluster_id: 'speaker-cluster-2',
      }],
    }),
    (error) => error.code === 'REDRAW_NATIVE_AUDIO_PROMPT_UNSAFE',
  );
});

test('analyzeNativeSource passes audio evidence to vision but removes visual-model dialogue guesses', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-redraw-audio-prompt-'));
  const db = createDb();
  try {
    const sourceRelative = createSampleVideo(storageRoot);
    addWork(db, { localPath: sourceRelative });
    const providerFacts = validFacts();
    providerFacts.shots[0].dialogue = [{
      id: 'visual-guessed-line',
      speaker_id: 'c1',
      start_ms: 100,
      end_ms: 700,
      source_text: '视觉模型改写的对白',
    }];
    providerFacts.shots[0].audio_contract.dialogue_mode = 'spoken';
    let providerPrompt = '';
    const evidence = {
      result_asset_id: 202,
      dialogue_mode: 'spoken',
      source_language: 'zh-CN',
      segments: [{
        id: 'audio-segment-1',
        evidence_ref: 'evidence-audio-1',
        start_ms: 100,
        end_ms: 700,
        source_text: '音频证据原文',
        speaker_cluster_id: 'speaker-cluster-1',
      }],
    };

    const result = await nativeAnalysis.analyzeNativeSource({
      db,
      log,
      storageRoot,
      assetService,
      visionDetailed: async (payload) => {
        providerPrompt = payload.userPrompt;
        return {
          text: JSON.stringify({ source_facts: providerFacts }),
          provider_task_id: 'vision-audio-evidence-id',
          model: 'vision-model',
          raw_hash: 'f'.repeat(64),
        };
      },
    }, {
      workId: 1,
      tenantId: 'tenant-1',
      userId: 'user-1',
      taskId: 'task-native-audio-evidence',
      model: 'vision-model',
    }, evidence);

    assert.match(providerPrompt, /音频证据原文/);
    assert.deepEqual(result.facts.shots[0].dialogue, []);
    assert.equal(result.facts.shots[0].audio_contract.dialogue_mode, 'silent');
    assert.equal(result.facts.shots[0].confidence.speaker_mapping, 0);
    assert.equal(JSON.stringify(result.facts).includes('视觉模型改写的对白'), false);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

test('analyzeNativeSource ignores visual dialogue without exact timings', async () => {
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
    const result = await nativeAnalysis.analyzeNativeSource({
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
    });
    assert.deepEqual(result.facts.shots[0].dialogue, []);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_analysis'").get().count,
      1,
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

test('analyzeNativeSource ignores guessed spoken dialogue without visible text evidence', async () => {
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

    const result = await nativeAnalysis.analyzeNativeSource({
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
    });
    assert.deepEqual(result.facts.shots[0].dialogue, []);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM assets WHERE category = 'redraw_source_analysis'").get().count,
      1,
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
