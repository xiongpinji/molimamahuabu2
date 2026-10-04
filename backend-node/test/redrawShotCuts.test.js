'use strict';

// R92：样片分析按硬切拆镜、群演带外形、特效不当道具、台词说话人必须正在说话。
// 2026-10-03 #98 第 1 集逐镜对比：约 10 个强切点落在分析出的镜头内部（成片只拍到其中一个画面）、
// 白衣弟子群体没有外形、漫天细小飞刃被当成道具画成一把巨剑、人群喊的台词安到了男主身上。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const analysis = require('../src/services/redrawNativeSourceAnalysisService');
const assetService = require('../src/services/assetService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { buildRedrawFactoryPackage, isKeyProp, isVisualEffectProp } = require('../src/services/redrawFactoryPackageAdapter');
const { buildEnrichmentPrompt } = require('../src/services/redrawSourceEnrichmentService');
const { hasLocalFfmpeg } = require('../src/utils/ffmpegPath');

const log = { info() {}, warn() {}, error() {} };

function frameScores(durationMs, overrides, base = 0.004) {
  const frames = [];
  for (let index = 0; index * (1000 / 30) < durationMs; index += 1) {
    frames.push({ ms: Math.round(index * (1000 / 30)), score: index === 0 ? 0 : base });
  }
  for (const [ms, score] of overrides) {
    const frame = frames.find((item) => item.ms === ms);
    assert.ok(frame, `no frame at ${ms}`);
    frame.score = score;
  }
  return frames;
}

test('cut candidates keep strong cuts and faint cuts between still dark frames, not flicker inside motion', () => {
  const frames = frameScores(6000, [[1000, 0.6], [2000, 0.06], [5000, 0.35], [5133, 0.4]]);
  // 3~4 秒是快速运动：邻近分数都在 0.03 左右，中间 0.08 的闪动不到 8 倍，不算切点。
  for (const frame of frames) if (frame.ms >= 3000 && frame.ms <= 4000) frame.score = 0.03;
  frames.find((frame) => frame.ms === 3500).score = 0.08;
  assert.deepEqual(analysis.pickCutCandidates(frames), [
    { ms: 1000, score: 0.6 },
    { ms: 2000, score: 0.06 },
    { ms: 5133, score: 0.4 },
  ], 'peaks closer than 0.2 s keep only the strongest');
  assert.deepEqual(analysis.pickCutCandidates([]), []);
});

test('scene scores are read from ffmpeg metadata print output', () => {
  const stderr = [
    '[Parsed_metadata_1 @ 0x1] frame:0    pts:0       pts_time:0',
    '[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.000000',
    '[Parsed_metadata_1 @ 0x1] frame:1    pts:512     pts_time:0.0416667\r',
    '[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.512000\r',
  ].join('\n');
  assert.deepEqual(analysis.parseSceneScores(stderr), [{ ms: 0, score: 0 }, { ms: 42, score: 0.512 }]);
});

test('shot boundaries snap to the nearest cut within half a second and scene and prop ranges follow', () => {
  const facts = {
    shots: [
      { id: 'shot-1', start_ms: 0, end_ms: 7000 },
      { id: 'shot-2', start_ms: 7000, end_ms: 10500 },
      { id: 'shot-3', start_ms: 10500, end_ms: 14000 },
      { id: 'shot-4', start_ms: 14000, end_ms: 16500 },
    ],
    scenes: [{ id: 's1', source_ranges: [{ start_ms: 0, end_ms: 10500 }, { start_ms: 10500, end_ms: 16500 }] }],
    props: [{ id: 'p1', evidence_ranges: [{ start_ms: 7000, end_ms: 14000 }] }],
  };
  const snapped = analysis.snapShotBoundaries(facts, [6133, 6400, 6633, 10300, 10533, 15267]);
  assert.deepEqual(snapped.shots.map((shot) => [shot.start_ms, shot.end_ms]),
    [[0, 6633], [6633, 10533], [10533, 14000], [14000, 16500]], '14000 has no cut nearby and stays');
  assert.deepEqual(snapped.scenes[0].source_ranges, [{ start_ms: 0, end_ms: 10533 }, { start_ms: 10533, end_ms: 16500 }]);
  assert.deepEqual(snapped.props[0].evidence_ranges, [{ start_ms: 6633, end_ms: 14000 }]);
  assert.equal(facts.shots[0].end_ms, 7000, 'input is not mutated');

  const tiny = analysis.snapShotBoundaries({ shots: [{ id: 'a', start_ms: 0, end_ms: 1000 }, { id: 'b', start_ms: 1000, end_ms: 1050 }] }, [960]);
  assert.deepEqual(tiny.shots.map((shot) => shot.start_ms), [0, 1000], 'never leaves a shot shorter than 0.1 s');
});

test('strong cuts left inside a shot are reported', () => {
  const facts = { shots: [{ id: 'shot-1', start_ms: 0, end_ms: 4000 }, { id: 'shot-2', start_ms: 4000, end_ms: 8000 }] };
  assert.deepEqual(analysis.unsplitCuts(facts, [{ ms: 2000, score: 0.5 }, { ms: 3900, score: 0.6 }, { ms: 6000, score: 0.06 }]),
    [{ ms: 2000, score: 0.5 }], 'cuts at a boundary or weak ones are not reported');
});

test('the analysis prompt asks for one shot per camera setup, lists cut candidates, and rules on props, crowds and speakers', () => {
  const probe = { duration_ms: 6000, width: 160, height: 284 };
  const plain = analysis.buildPrompt(probe);
  assert.match(plain, /Every hard cut .* MUST start a new shot, even when the new shot lasts less than one second/);
  assert.doesNotMatch(plain, /Candidate hard cuts/);
  assert.match(plain, /Visual effects are never props: sword energy, flying blades/);
  assert.match(plain, /add one character for the group with a short Chinese source_name such as 白衣弟子众人/);
  assert.match(plain, /a character who only listens or reacts is never the speaker\. A line called out from a crowd belongs to the group character/);

  const withCuts = analysis.buildPrompt(probe, {
    cutCandidates: analysis.labelCutCandidates([{ ms: 2000, score: 0.06 }, { ms: 4000, score: 0.9 }]),
    cutSheetCount: 1,
  });
  assert.match(withCuts, /Candidate hard cuts found by pixel analysis, in milliseconds from the start of this clip: \[\{"label":"C1","ms":2000\},\{"label":"C2","ms":4000\}\]/);
  assert.match(withCuts, /The last 1 image\(s\) are cut sheets/);
});

test('too many candidates keep the strongest ones in time order', () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ ms: (index + 1) * 300, score: index % 2 ? 0.9 : 0.06 }));
  const labeled = analysis.labelCutCandidates(many);
  assert.equal(labeled.length, 48);
  assert.equal(labeled.filter((cut) => cut.score === 0.9).length, 30);
  assert.deepEqual(labeled.map((cut) => cut.ms), [...labeled.map((cut) => cut.ms)].sort((a, b) => a - b));
  assert.equal(labeled[0].label, 'C1');
});

test('the enrichment prompt only names visible speakers and describes crowds', () => {
  const prompt = buildEnrichmentPrompt({ characters: [], scenes: [], shots: [] });
  assert.match(prompt, /one on-screen character visibly says in that shot/);
  assert.match(prompt, /a line called out from a crowd belongs to that group character/);
  assert.match(prompt, /For a group character \(a crowd, disciples, onlookers\), describe the shared look and outfit of its members/);
});

// 暗灰蓝切到稍亮的暗灰蓝（分数约 0.1，固定阈值 0.3 会漏掉），再切到红色。
function createCutVideo(dir) {
  const file = path.join(dir, 'cuts.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x101418:size=160x284:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'color=c=0x242c34:size=160x284:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'color=c=red:size=160x284:rate=24:duration=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p',
    file,
  ], { stdio: 'pipe' });
  return file;
}

async function hasRed(file, left, width) {
  const image = sharp(file);
  const { width: total, height } = await image.metadata();
  const { data, info } = await image.extract({ left, top: 0, width: Math.min(width, total - left), height }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset] > 180 && data[offset + 1] < 80 && data[offset + 2] < 80) return true;
  }
  return false;
}

test('cut detection finds a faint cut between dark frames and the cut sheet shows both sides of every cut', { skip: !hasLocalFfmpeg() && 'ffmpeg is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-cuts-'));
  try {
    const video = createCutVideo(dir);
    const detection = await analysis.detectCutCandidates(video, 60000);
    assert.equal(detection.detected, true);
    assert.deepEqual(detection.candidates.map((cut) => cut.ms), [2000, 4000]);
    assert.ok(detection.candidates[0].score < 0.3, `the dark cut is faint (${detection.candidates[0].score})`);
    const sheets = await analysis.createCutSheets(video, 6000, analysis.labelCutCandidates(detection.candidates), dir, 60000);
    assert.equal(sheets.length, 1);
    assert.deepEqual(sheets[0].candidates.map((cut) => cut.label), ['C1', 'C2']);
    assert.equal(fs.existsSync(sheets[0].path), true);
    // 每行 8 格（4 个切点 × 前后两格），格宽 160 加 4 像素间隔：第 4 格（C2 B）是红色，第 3 格（C2 A）不是。
    assert.equal(await hasRed(sheets[0].path, 4 + 3 * 164, 160), true, 'C2 B shows the picture after the cut');
    assert.equal(await hasRed(sheets[0].path, 4 + 2 * 164, 160), false, 'C2 A shows the picture before the cut');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function factsFor(durationMs, boundaries) {
  const edges = [0, ...boundaries, durationMs];
  return {
    schema_version: '2.0',
    duration_ms: durationMs,
    story: ['林娜走进房间'],
    characters: [{ id: 'c1', source_name: '林娜', relationships: [] }],
    scenes: [{ id: 's1', location: '室内', time: '夜', source_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    props: [{ id: 'p1', name: '手机', evidence_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    shots: edges.slice(0, -1).map((start, index) => ({
      id: `shot-${index + 1}`,
      index: index + 1,
      start_ms: start,
      end_ms: edges[index + 1],
      composition: `画面 ${index + 1}`,
      camera_movement: '固定',
      opening_state: '开始',
      continuous_action: '动作',
      ending_state: '结束',
      visible_character_ids: ['c1'],
      dialogue: [],
      text_regions: [],
      audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.5, speaker_mapping: 0.2, text_regions: 0.5, shot_boundary: 0.5 },
    })),
    causal_chain: ['林娜拿起手机'],
    locked_facts: ['林娜在室内'],
    reversals: ['手机响了'],
    episode_hook: '电话是谁打来的',
  };
}

test('analyzeNativeSource shows the cut sheet, snaps the model boundaries to the cuts and marks facts_v2 as cut-aware', { skip: !hasLocalFfmpeg() && 'ffmpeg is not installed' }, async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-cut-analysis-'));
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  try {
    fs.mkdirSync(path.join(storageRoot, 'uploads'), { recursive: true });
    fs.copyFileSync(createCutVideo(storageRoot), path.join(storageRoot, 'uploads', 'cuts.mp4'));
    const asset = assetService.create(db, log, {
      name: 'cuts.mp4', type: 'video', category: 'redraw_source', local_path: 'uploads/cuts.mp4',
      metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
    });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
      VALUES (1, 'tenant-1', 'user-1', 'p', 'draft', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO redraw_works (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
      duration_ms, status, current_step, created_at, updated_at)
      VALUES (1, 1, 'tenant-1', 'user-1', 'w', ?, 'fp', 15000, 'draft', 1, ?, ?)`).run(asset.id, now, now);

    const calls = [];
    const result = await analysis.analyzeNativeSource({
      db,
      log,
      storageRoot,
      assetService,
      visionDetailed: async (payload) => {
        calls.push({ prompt: payload.userPrompt, images: payload.imageSources.map((source) => source.localAbsPath) });
        if (/adding recreation details/.test(payload.userPrompt)) return { text: '{}', provider_task_id: 'enrich-1' };
        // 模型按每秒 1 帧估的边界差了 0.2~0.3 秒。
        return { text: JSON.stringify({ source_facts: factsFor(6000, [1800, 4300]) }), provider_task_id: 'pass-1', model: 'm' };
      },
    }, { workId: 1, tenantId: 'tenant-1', userId: 'user-1', taskId: 'task-cuts', model: 'm' });

    assert.equal(result.status, 'completed');
    assert.equal(calls.length, 2);
    assert.match(calls[0].prompt, /\[\{"label":"C1","ms":2000\},\{"label":"C2","ms":4000\}\]/);
    assert.match(calls[0].prompt, /The last 1 image\(s\) are cut sheets/);
    assert.match(path.basename(calls[0].images.at(-1)), /^cut-sheet-1\.jpg$/);
    assert.deepEqual(calls[1].images, calls[0].images, 'the enrichment pass sees the same images');
    assert.equal(result.diagnostics.sheet_count, calls[0].images.length);

    const saved = JSON.parse(fs.readFileSync(path.join(storageRoot,
      db.prepare('SELECT local_path FROM assets WHERE id = ?').get(result.result_asset_id).local_path), 'utf8'));
    // 线上版把 v2 结果存在 facts_v2，main 直接存在 facts。
    const factsOut = saved.facts_v2 || saved.facts;
    assert.deepEqual(factsOut.shots.map((shot) => [shot.start_ms, shot.end_ms]), [[0, 2000], [2000, 4000], [4000, 6000]]);
    assert.deepEqual(factsOut.shot_detection, { method: 'scene_peaks_v1', detected: true, candidates: 2, unsplit_cuts: [] });
    assert.deepEqual(saved.diagnostics.shot_detection, factsOut.shot_detection);
    assert.equal(saved.diagnostics.sheets.at(-1).mode, 'cuts');
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---------- 导入工厂 ----------

function packageFacts({ shots, cutAware = true }) {
  return {
    schema_version: '2.0',
    duration_ms: shots.at(-1).end_ms,
    ...(cutAware ? { shot_detection: { method: 'scene_peaks_v1', detected: true, candidates: 3, unsplit_cuts: [] } } : {}),
    story: ['林江与师妹在大殿受罚。'],
    characters: [
      { id: 'c1', source_name: '林江', display_name: '林江', relationship: '主角', relationships: [] },
      { id: 'c2', source_name: '白衣弟子众人', display_name: '白衣弟子众人', relationship: '围观的弟子', relationships: [],
        appearance: '十几名年轻男子，身穿白底蓝边交领长袍，束发' },
    ],
    scenes: [
      { id: 's1', location: '大殿', time: '夜', source_ranges: [{ start_ms: 0, end_ms: 6000 }] },
      { id: 's2', location: '广场', time: '白天', source_ranges: [{ start_ms: 6000, end_ms: 20_000 }] },
    ],
    props: [
      { id: 'p1', name: '漫天细小飞刃', evidence_ranges: [{ start_ms: 0, end_ms: 20_000 }] },
      { id: 'p2', name: '林江的火焰纹长剑', evidence_ranges: [{ start_ms: 0, end_ms: 20_000 }] },
    ],
    shots,
    causal_chain: ['飞刃落下，林江拔出火焰纹长剑。'],
    reversals: ['飞刃停在半空。'],
    episode_hook: '',
    locked_facts: [],
  };
}

function shot(id, startMs, endMs, extra = {}) {
  return {
    id, index: Number(id.split('-')[1]), start_ms: startMs, end_ms: endMs,
    composition: `${id} 构图`, camera_movement: '', opening_state: `${id} 开始`, continuous_action: `${id} 动作`, ending_state: `${id} 结束`,
    visible_character_ids: ['c1'], text_regions: [], dialogue: [],
    ...extra,
  };
}

test('crowds get their look written into every shot they appear in, from the localized culture map when there is one', () => {
  const facts = packageFacts({
    cutAware: false,
    shots: [shot('shot-1', 0, 4000, { visible_character_ids: ['c1', 'c2'] }), shot('shot-2', 4000, 8000)],
  });
  const plain = buildRedrawFactoryPackage({ sourceFacts: facts });
  const [first, second] = plain.episodes[0].scenes.flatMap((group) => group.shots);
  assert.deepEqual(plain.characters.map((character) => character.character_id), ['c1'], 'the crowd is still not a character');
  assert.match(first.description, /群演外形：白衣弟子众人：十几名年轻男子，身穿白底蓝边交领长袍，束发。/);
  assert.match(first.video_prompt, /群演外形：白衣弟子众人：十几名年轻男子/);
  assert.match(first.image_prompt, /群演外形：/);
  assert.doesNotMatch(second.description, /群演外形/, 'only where the crowd is visible');

  const localized = buildRedrawFactoryPackage({
    sourceFacts: facts,
    localization: {
      locale: 'id-ID',
      name_map: { c1: 'Arif', c2: 'Murid-murid' },
      culture_map: { characters: { c2: { appearance: '十几名印尼青年，身穿白色武术服，系黑色腰带' } } },
    },
  });
  const [localFirst] = localized.episodes[0].scenes.flatMap((group) => group.shots);
  assert.match(localFirst.description, /群演外形：Murid-murid：十几名印尼青年，身穿白色武术服，系黑色腰带。/);
});

test('visual effects are never key props while a real object with an effect-like pattern still is', () => {
  const facts = packageFacts({ cutAware: false, shots: [shot('shot-1', 0, 4000)] });
  assert.equal(isVisualEffectProp(facts.props[0]), true);
  assert.equal(isKeyProp(facts.props[0], facts), false, 'flying blades are in the story but are an effect');
  assert.equal(isKeyProp(facts.props[1], facts), true, '火焰纹长剑 ends with a sword');
  // #98 道具表里的两个特效：剑阵能量、光罩（网格穹顶）。
  for (const name of ['赤红剑气', '护山大阵', '金色光罩', '刀山', '掌心的火焰', '橙红色环形剑阵能量', '覆盖石台的橙红色网格穹顶',
    'glowing sword energy', 'Magic circle']) {
    assert.equal(isVisualEffectProp({ name }), true, name);
  }
  for (const name of ['火把', '光剑', '能量饮料', '手机', 'golden sword', 'lantern']) {
    assert.equal(isVisualEffectProp({ name }), false, name);
  }
  const pkg = buildRedrawFactoryPackage({ sourceFacts: facts });
  assert.deepEqual(pkg.props.map((prop) => prop.prop_id), ['p2']);
});

test('cut-aware analyses fold quick cuts into one storyboard that lists every picture in order', () => {
  const facts = packageFacts({
    shots: [
      shot('shot-1', 0, 6000),
      shot('shot-2', 6000, 6500, { composition: '男子特写', visible_character_ids: ['c1'],
        text_regions: [{ id: 'txt1', kind: 'subtitle', source_text: '逆天而行', speaker_id: 'c1' }] }),
      shot('shot-3', 6500, 10_000, { composition: '大殿全景，两侧弟子列队', visible_character_ids: ['c1', 'c2'] }),
      shot('shot-4', 10_000, 15_000),
      shot('shot-5', 15_000, 15_600, { composition: '飞刃落下' }),
      shot('shot-6', 15_600, 20_000),
    ],
  });
  const pkg = buildRedrawFactoryPackage({ sourceFacts: facts, analysisSettings: { free_style: { positive: '真人写实' } } });
  const shots = pkg.episodes[0].scenes.flatMap((group) => group.shots);
  assert.deepEqual(shots.map((item) => [item.continuity.start_ms, item.continuity.end_ms]),
    [[0, 6000], [6000, 10_000], [10_000, 15_600], [15_600, 20_000]]);
  assert.deepEqual(shots.map((item) => item.shot_number), [1, 2, 3, 4]);
  assert.deepEqual(shots.map((item) => item.title.replace(/ · .*$/, '')), ['镜头 1', '镜头 2', '镜头 3', '镜头 4']);
  const quick = shots[1];
  assert.deepEqual(quick.continuity.source_shot_ids, ['shot-2', 'shot-3']);
  assert.equal(quick.continuity.source_shot_id, 'shot-2');
  assert.equal(quick.duration, 4);
  assert.match(quick.video_prompt, /^真人写实。 本镜头由 2 个画面组成，画面之间硬切。 画面1（约 0\.5 秒）：男子特写。 shot-2 开始。 shot-2 动作。 shot-2 结束。 画面2（约 3\.5 秒）：大殿全景，两侧弟子列队。 群演外形：白衣弟子众人：/);
  assert.match(quick.video_prompt, /台词：林江：逆天而行。 画面中不要出现字幕。$/);
  assert.equal(quick.description, '画面1：男子特写。 画面2：大殿全景，两侧弟子列队。 群演外形：白衣弟子众人：十几名年轻男子，身穿白底蓝边交领长袍，束发。');
  assert.equal(quick.image_prompt, '真人写实。 男子特写。 角色：林江。 画面中不要出现字幕。', 'the storyboard image is the first picture');
  assert.equal(quick.dialogue, '林江：逆天而行');
  assert.deepEqual(quick.characters, ['c1', 'c2']);
  assert.equal(quick.solo_speaker_id, 'c1');
  assert.deepEqual(pkg.voice_casting, [{ character_id: 'c1', name: '林江', shot_number: 2 }]);
  assert.equal(shots[2].continuity.source_shot_ids.length, 2, 'a quick shot joins the long shot before it');
  assert.equal(shots[2].duration, 6);

  const legacy = buildRedrawFactoryPackage({ sourceFacts: { ...facts, shot_detection: undefined } });
  assert.equal(legacy.episodes[0].scenes.flatMap((group) => group.shots).length, 6, 'older analyses keep one storyboard per shot');
});

test('quick cuts are not folded across scenes or past six seconds', () => {
  const facts = packageFacts({
    shots: [
      shot('shot-1', 0, 5500),
      shot('shot-2', 5500, 6000),
      shot('shot-3', 6000, 6400),
      shot('shot-4', 6400, 12_000),
      shot('shot-5', 12_000, 20_000),
    ],
  });
  const shots = buildRedrawFactoryPackage({ sourceFacts: facts }).episodes[0].scenes.flatMap((group) => group.shots);
  assert.deepEqual(shots.map((item) => [item.continuity.start_ms, item.continuity.end_ms]),
    [[0, 6000], [6000, 12_000], [12_000, 20_000]], 'shot-3 starts the second scene, so it opens a new storyboard');
});
