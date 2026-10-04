'use strict';

// R93：同一件实物的不同叫法合成一个道具。2026-10-04 作品 9 导入的工厂 #107 里，红衣女子的剑出了 4 个道具
// （红衣女子所持长剑、橙红光长剑、红衣女子手中的长剑、橙红光芒长剑），#98 里 Sari 的剑也有 4 个；
// 每个都出一张道具图，同一把剑在各镜头长得不一样。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { buildRedrawFactoryPackage, isVisualEffectProp, propObjectPhrase } = require('../src/services/redrawFactoryPackageAdapter');
const analysis = require('../src/services/redrawNativeSourceAnalysisService');
const assetService = require('../src/services/assetService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { hasLocalFfmpeg } = require('../src/utils/ffmpegPath');

const log = { info() {}, warn() {}, error() {} };

function shot(id, startMs, endMs, people = ['c2']) {
  return {
    id, index: Number(id.split('-')[1]), start_ms: startMs, end_ms: endMs,
    composition: `${id} 构图`, camera_movement: '', opening_state: `${id} 开始`, continuous_action: `${id} 动作`, ending_state: `${id} 结束`,
    visible_character_ids: people, text_regions: [], dialogue: [],
  };
}

function facts(props, extra = {}) {
  return {
    schema_version: '2.0',
    duration_ms: 30_000,
    story: ['红衣女子在高台上破阵。'],
    characters: [
      { id: 'c1', source_name: '白衣男子', display_name: '白衣男子', relationship: '师兄', relationships: [] },
      { id: 'c2', source_name: '红衣女子', display_name: '红衣女子', relationship: '师妹', relationships: [] },
      { id: 'c3', source_name: '黑袍长者', display_name: '黑袍长者', relationship: '长老', relationships: [] },
    ],
    scenes: [{ id: 's1', location: '高台', time: '白天', source_ranges: [{ start_ms: 0, end_ms: 30_000 }] }],
    props,
    shots: [shot('shot-1', 0, 6000), shot('shot-2', 6000, 12_000), shot('shot-3', 12_000, 18_000),
      shot('shot-4', 18_000, 24_000), shot('shot-5', 24_000, 30_000)],
    causal_chain: ['红衣女子拔出长剑破阵。'],
    reversals: ['长剑发出橙红光芒。'],
    episode_hook: '',
    locked_facts: [],
    ...extra,
  };
}

const range = (start, end) => [{ start_ms: start, end_ms: end }];

function linkedProps(pkg) {
  return pkg.episodes[0].scenes.flatMap((group) => group.shots).map((item) => item.props);
}

test('the names one sword got in different parts and states become one prop linked to every shot', () => {
  const pkg = buildRedrawFactoryPackage({
    sourceFacts: facts([
      { id: 'p1', name: '红衣女子所持长剑', evidence_ranges: range(0, 6000) },
      { id: 'p2', name: '橙红光长剑', evidence_ranges: range(6000, 12_000) },
      { id: 'p3', name: '红衣女子手中的长剑', evidence_ranges: range(12_000, 30_000) },
      { id: 'p4', name: '橙红光芒长剑', evidence_ranges: range(24_000, 30_000) },
    ]),
    analysisSettings: { free_style: { positive: '真人写实风格' } },
  });
  assert.deepEqual(pkg.props.map((prop) => prop.prop_id), ['p3'], 'the name seen in the most shots stays');
  assert.equal(pkg.props[0].name, '红衣女子手中的长剑');
  assert.match(pkg.props[0].prompt, /长剑，作为单独物品放在纯色无缝背景上/);
  assert.deepEqual(linkedProps(pkg), [['p3'], ['p3'], ['p3'], ['p3'], ['p3']]);
});

test('swords of different people are not merged, and a sword without a holder only joins when one person has one', () => {
  const twoOwners = buildRedrawFactoryPackage({
    sourceFacts: facts([
      { id: 'p1', name: '红衣女子手中的长剑', evidence_ranges: range(0, 12_000) },
      { id: 'p2', name: '黑袍长者的长剑', evidence_ranges: range(12_000, 18_000) },
      { id: 'p3', name: '发光长剑', evidence_ranges: range(18_000, 30_000) },
    ]),
  });
  assert.deepEqual(twoOwners.props.map((prop) => prop.prop_id).sort(), ['p1', 'p2', 'p3'], 'nothing merges when it is unclear');

  const noOwner = buildRedrawFactoryPackage({
    sourceFacts: facts([
      { id: 'p1', name: '橙红光长剑', evidence_ranges: range(0, 12_000) },
      { id: 'p2', name: '橙红光芒长剑', evidence_ranges: range(12_000, 30_000) },
    ]),
  });
  assert.deepEqual(noOwner.props.map((prop) => prop.prop_id), ['p2'], 'two names without a holder for the same kind of thing merge');
  assert.deepEqual(linkedProps(noOwner), [['p2'], ['p2'], ['p2'], ['p2'], ['p2']]);
});

test('different objects of one person stay apart, and swarms of floating swords are effects', () => {
  const pkg = buildRedrawFactoryPackage({
    sourceFacts: facts([
      { id: 'p1', name: '红衣女子手中的长剑', evidence_ranges: range(0, 30_000) },
      { id: 'p2', name: '红衣女子腰间的剑鞘', evidence_ranges: range(0, 30_000) },
      { id: 'p3', name: '环绕红衣女子的多柄悬空长剑', evidence_ranges: range(0, 30_000) },
      { id: 'p4', name: '从圆形石台升起的青色灵光', evidence_ranges: range(0, 30_000) },
    ], { causal_chain: ['红衣女子拔出长剑，把剑鞘丢在地上。'] }),
  });
  assert.deepEqual(pkg.props.map((prop) => prop.prop_id), ['p1', 'p2']);
  assert.equal(isVisualEffectProp({ name: '环绕红衣女子的多柄悬空长剑' }), true);
  assert.equal(isVisualEffectProp({ name: '从圆形石台升起的青色灵光' }), true);
  assert.equal(isVisualEffectProp({ name: '红衣女子手中的长剑' }), false);
});

test('a merged prop keeps the localized name of the kept id and hand-picked variants map to it', () => {
  const sourceFacts = facts([
    { id: 'p1', name: '红衣女子手持的发光长剑', evidence_ranges: range(0, 12_000) },
    { id: 'p2', name: '红衣女子手中的长剑', evidence_ranges: range(12_000, 18_000) },
    { id: 'p3', name: '红衣女子手中的橙红发光长剑', evidence_ranges: range(18_000, 30_000) },
  ]);
  const localization = {
    locale: 'id-ID',
    name_map: { c1: 'Arif', c2: 'Sari', c3: 'Pak Jatmiko' },
    culture_map: { props: { p1: { name: 'Sari手持的发光长剑' }, p2: { name: 'Sari手中的长剑' }, p3: { name: 'Sari手中的橙红发光长剑' } } },
  };
  const pkg = buildRedrawFactoryPackage({ sourceFacts, localization });
  assert.deepEqual(pkg.props.map((prop) => [prop.prop_id, prop.name]), [['p1', 'Sari手持的发光长剑']]);
  assert.deepEqual(linkedProps(pkg), [['p1'], ['p1'], ['p1'], ['p1'], ['p1']]);

  const picked = buildRedrawFactoryPackage({ sourceFacts, localization, propIds: ['p3'] });
  assert.deepEqual(picked.props.map((prop) => prop.prop_id), ['p1'], 'a hand-picked variant selects the merged prop');
});

test('English prop names are left alone', () => {
  const pkg = buildRedrawFactoryPackage({
    sourceFacts: facts([
      { id: 'p1', name: 'Sword held by the woman in red', evidence_ranges: range(0, 30_000) },
      { id: 'p2', name: 'Glowing sword', evidence_ranges: range(0, 30_000) },
    ], { causal_chain: ['The woman in red draws her sword and it starts to glow.'] }),
  });
  assert.deepEqual(pkg.props.map((prop) => prop.prop_id), ['p1', 'p2']);
});

test('the prop image prompt drops a holding verb that has no 的 after it', () => {
  assert.equal(propObjectPhrase('红衣女子所持长剑', ['红衣女子']), '长剑');
  assert.equal(propObjectPhrase('红衣女子手中的长剑', ['红衣女子']), '长剑');
  assert.equal(propObjectPhrase('手持剑', []), '手持剑', 'a one-character object keeps its verb');
});

test('the analysis prompt asks for one prop per object and lists the props of earlier parts', () => {
  const prompt = analysis.buildPrompt({ duration_ms: 20_000 }, { knownProps: ['红衣女子手中的长剑'] });
  assert.match(prompt, /List each physical object once: the same object in another state \(glowing, bloodied, sheathed, broken\)/);
  assert.match(prompt, /Props already identified in earlier parts of this episode are listed below; when the same object appears again, reuse its exact name\. Add a new prop only for a different object\.\n\["红衣女子手中的长剑"\]/);
  assert.doesNotMatch(analysis.buildPrompt({ duration_ms: 20_000 }), /Props already identified/);
});

function segmentFacts(durationMs, propName) {
  const half = Math.round(durationMs / 2);
  return {
    schema_version: '2.0',
    duration_ms: durationMs,
    story: ['红衣女子破阵'],
    characters: [{ id: 'c1', source_name: '红衣女子', display_name: '红衣女子', relationship: '主角', relationships: [] }],
    scenes: [{ id: 's1', location: '高台', time: '白天', source_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    props: [{ id: 'p1', name: propName, evidence_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    shots: [[0, half], [half, durationMs]].map(([start, end], index) => ({
      id: `shot-${index + 1}`, index: index + 1, start_ms: start, end_ms: end,
      composition: '构图', camera_movement: '固定', opening_state: '开始', continuous_action: '动作', ending_state: '结束',
      visible_character_ids: ['c1'], dialogue: [], text_regions: [],
      audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.5, speaker_mapping: 0.2, text_regions: 0.5, shot_boundary: 0.5 },
    })),
    causal_chain: ['红衣女子拔剑'],
    locked_facts: ['红衣女子持剑'],
    reversals: ['剑发光'],
    episode_hook: '下一重幻境',
  };
}

test('later parts of a long sample are told the prop names of the earlier parts', { skip: !hasLocalFfmpeg() && 'ffmpeg is not installed' }, async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-prop-names-'));
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  try {
    fs.mkdirSync(path.join(storageRoot, 'uploads'), { recursive: true });
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc=size=160x284:rate=6:duration=40', '-pix_fmt', 'yuv420p', path.join(storageRoot, 'uploads', 'long.mp4')], { stdio: 'pipe' });
    const asset = assetService.create(db, log, {
      name: 'long.mp4', type: 'video', category: 'redraw_source', local_path: 'uploads/long.mp4',
      metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
    });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
      VALUES (1, 'tenant-1', 'user-1', 'p', 'draft', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO redraw_works (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
      duration_ms, status, current_step, created_at, updated_at)
      VALUES (1, 1, 'tenant-1', 'user-1', 'w', ?, 'fp', 40000, 'draft', 1, ?, ?)`).run(asset.id, now, now);
    const firstPassPrompts = [];
    const result = await analysis.analyzeNativeSource({
      db,
      log,
      storageRoot,
      assetService,
      visionDetailed: async (payload) => {
        if (/adding recreation details/.test(payload.userPrompt)) return { text: '{}', provider_task_id: 'enrich' };
        firstPassPrompts.push(payload.userPrompt);
        const duration = Number(/duration_ms=(\d+)/.exec(payload.userPrompt)[1]);
        // 两段都用前面给的同一个名字，拼接时合成一个道具。
        return { text: JSON.stringify({ source_facts: segmentFacts(duration, '红衣女子手中的长剑') }), provider_task_id: `pass-${firstPassPrompts.length}`, model: 'm' };
      },
    }, { workId: 1, tenantId: 'tenant-1', userId: 'user-1', taskId: 'task-props', model: 'm', segmentCount: 2 });
    assert.equal(result.status, 'completed');
    assert.equal(firstPassPrompts.length, 2);
    assert.doesNotMatch(firstPassPrompts[0], /Props already identified/);
    assert.match(firstPassPrompts[1], /Props already identified in earlier parts of this episode[^\n]*\n\["红衣女子手中的长剑"\]/);
    const saved = JSON.parse(fs.readFileSync(path.join(storageRoot,
      db.prepare('SELECT local_path FROM assets WHERE id = ?').get(result.result_asset_id).local_path), 'utf8'));
    // 线上版把 v2 结果存在 facts_v2，main 直接存在 facts。
    assert.deepEqual((saved.facts_v2 || saved.facts).props.map((prop) => prop.name), ['红衣女子手中的长剑'], 'the reused name merges across parts');
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
