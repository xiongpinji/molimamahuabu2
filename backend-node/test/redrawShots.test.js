const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const {
  normalizeShot,
  parseShotReferences,
  groupShotsIntoBatches,
  snapshotShots,
} = require('../src/services/redrawShotService');
const { identityBindingForAsset } = require('../src/services/redrawCharacterIdentityService');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalIdentityPack() {
  const pack = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: 'source-character-maya',
    target_actor_label: 'Actor Maya',
    artifact: {
      asset_id: 101,
      sha256: crypto.createHash('sha256').update('maya canonical portrait').digest('hex'),
      width: 640,
      height: 960,
      mime_type: 'image/png',
    },
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: '2026-08-06T00:00:00.000Z',
  };
  return {
    ...pack,
    pack_sha256: crypto.createHash('sha256').update(stableJson(pack)).digest('hex'),
  };
}

const mayaIdentityPack = canonicalIdentityPack();
const mayaIdentityBinding = identityBindingForAsset({ identity_pack: mayaIdentityPack });

const approvedAssets = [
  {
    localized_name: 'Maya',
    asset_id: 101,
    kind: 'character',
    version_number: 3,
    approval_status: 'approved',
    identity_binding: mayaIdentityBinding,
  },
  {
    localized_name: '旧仓库',
    asset_id: 202,
    kind: 'scene',
    version_number: 2,
    approval_status: 'approved',
  },
  {
    localized_name: '怀表',
    asset_id: 303,
    kind: 'prop',
    version_number: 4,
    approval_status: 'approved',
  },
];

test('分镜保留完整源合同并解析三类已批准资产引用', () => {
  const shot = normalizeShot({
    start_ms: 0,
    end_ms: 12000,
    opening_state: '门关着',
    continuous_action: 'Maya 推门并停在门口',
    ending_state: '门打开',
    shot_type: '中景',
    camera_movement: '缓慢推进',
    composition: 'Maya 位于画面右侧',
    lighting: '窗外冷光',
    atmosphere: '紧张',
    source_dialogue: [{ speaker: 'Maya', text: '有人吗？' }],
    localized_dialogue: [{ speaker: 'Maya', text: 'Anyone here?' }],
    speaker: 'Maya',
    speakable_duration_ms: 2600,
    prompt: '@Maya 走进 @旧仓库，拿起 @怀表',
    negative_prompt: '身份漂移，背景跳变',
    compiled_prompt: { provider: 'seedance', text: 'compiled prompt' },
    source_video_ref: { asset_id: 1, start_ms: 0, end_ms: 12000 },
    new_video_ref: { generation_id: 2 },
    audio_ref: { asset_id: 3 },
    subtitle_ref: { asset_id: 4 },
  }, { approvedAssets });

  assert.equal(shot.duration_ms, 12000);
  assert.equal(shot.start_ms, 0);
  assert.equal(shot.end_ms, 12000);
  assert.equal(shot.opening_state, '门关着');
  assert.equal(shot.continuous_action, 'Maya 推门并停在门口');
  assert.equal(shot.ending_state, '门打开');
  assert.equal(shot.shot_type, '中景');
  assert.equal(shot.camera_movement, '缓慢推进');
  assert.equal(shot.composition, 'Maya 位于画面右侧');
  assert.equal(shot.lighting, '窗外冷光');
  assert.equal(shot.atmosphere, '紧张');
  assert.deepEqual(shot.source_dialogue, [{ speaker: 'Maya', text: '有人吗？' }]);
  assert.deepEqual(shot.localized_dialogue, [{ speaker: 'Maya', text: 'Anyone here?' }]);
  assert.equal(shot.speaker, 'Maya');
  assert.equal(shot.speakable_duration_ms, 2600);
  assert.equal(shot.prompt, '@Maya 走进 @旧仓库，拿起 @怀表');
  assert.equal(shot.negative_prompt, '身份漂移，背景跳变');
  assert.deepEqual(shot.compiled_prompt, { provider: 'seedance', text: 'compiled prompt' });
  assert.deepEqual(shot.source_video_ref, { asset_id: 1, start_ms: 0, end_ms: 12000 });
  assert.deepEqual(shot.new_video_ref, { generation_id: 2 });
  assert.deepEqual(shot.audio_ref, { asset_id: 3 });
  assert.deepEqual(shot.subtitle_ref, { asset_id: 4 });
  assert.deepEqual(shot.references, [
    {
      asset_id: 101,
      kind: 'character',
      version_number: 3,
      approval_status: 'approved',
      name: 'Maya',
      source_character_key: 'source-character-maya',
      target_actor_label: 'Actor Maya',
      identity_pack_sha256: mayaIdentityPack.pack_sha256,
    },
    { asset_id: 202, kind: 'scene', version_number: 2, approval_status: 'approved', name: '旧仓库' },
    { asset_id: 303, kind: 'prop', version_number: 4, approval_status: 'approved', name: '怀表' },
  ]);
});

test('非法时间码会失败而不是静默纠正', () => {
  assert.throws(() => normalizeShot({ start_ms: 12000, end_ms: 0 }), /时间码/);
  assert.throws(() => normalizeShot({ start_ms: 0.5, end_ms: 12000 }), /时间码/);
});

test('未知 @ 引用被拒绝而不是静默当普通文本', () => {
  assert.throws(() => parseShotReferences('@不存在'), /未知资产/);
});

test('未批准资产不能成为可生成引用', () => {
  assert.throws(() => parseShotReferences('@草稿道具', [{
    localized_name: '草稿道具',
    asset_id: 404,
    kind: 'prop',
    version_number: 1,
    approval_status: 'pending',
  }]), /未批准/);
});

test('同一资产的多个别名只返回首次出现的一条引用', () => {
  const references = parseShotReferences('@Alice 走向 @艾丽丝，然后看向 @Bob', [
    {
      name: 'Alice',
      localized_name: '艾丽丝',
      asset_id: 501,
      kind: 'character',
      version_number: 2,
      approval_status: 'approved',
    },
    {
      name: 'Bob',
      localized_name: '鲍勃',
      asset_id: 502,
      kind: 'character',
      version_number: 1,
      approval_status: 'approved',
    },
  ]);

  assert.deepEqual(references.map((reference) => reference.asset_id), [501, 502]);
  assert.deepEqual(references.map((reference) => reference.name), ['Alice', 'Bob']);
});

test('角色引用只消费服务端 identity binding 并忽略客户端同名伪造字段', () => {
  const references = parseShotReferences('@Maya', [{
    localized_name: 'Maya',
    asset_id: 101,
    kind: 'character',
    version_number: 3,
    approval_status: 'approved',
    source_character_key: 'forged-source',
    target_actor_label: 'Forged Actor',
    identity_pack_sha256: crypto.createHash('sha256').update('forged identity pack').digest('hex'),
    identity_binding: mayaIdentityBinding,
  }]);

  assert.deepEqual(references, [{
    asset_id: 101,
    kind: 'character',
    version_number: 3,
    approval_status: 'approved',
    name: 'Maya',
    source_character_key: 'source-character-maya',
    target_actor_label: 'Actor Maya',
    identity_pack_sha256: mayaIdentityPack.pack_sha256,
  }]);
});

test('分镜显式 references 会被校验并解析', () => {
  const shot = normalizeShot({
    start_ms: 0,
    end_ms: 12000,
    references: ['@Maya', '@旧仓库'],
  }, { approvedAssets });

  assert.deepEqual(shot.references.map((reference) => reference.asset_id), [101, 202]);
});

test('分镜显式 references 中未知或未审批资产会失败', () => {
  assert.throws(() => normalizeShot({
    start_ms: 0,
    end_ms: 12000,
    references: ['@不存在'],
  }, { approvedAssets }), /未知资产/);

  assert.throws(() => normalizeShot({
    start_ms: 0,
    end_ms: 12000,
    references: ['@草稿道具'],
  }, {
    approvedAssets: [{
      localized_name: '草稿道具',
      asset_id: 404,
      kind: 'prop',
      version_number: 1,
      approval_status: 'pending',
    }],
  }), /未审批/);
});

test('分镜 prompt 与显式 references 合并后按资产身份去重并保持顺序', () => {
  const shot = normalizeShot({
    start_ms: 0,
    end_ms: 12000,
    prompt: '@Maya 走进 @旧仓库',
    references: ['@Maya', '@怀表'],
  }, { approvedAssets });

  assert.deepEqual(shot.references.map((reference) => reference.asset_id), [101, 202, 303]);
});

test('自动分批保持顺序并把相邻镜头控制在 10 到 15 秒目标内', () => {
  const shots = [
    { id: 'shot-1', duration_ms: 4000 },
    { id: 'shot-2', duration_ms: 6000 },
    { id: 'shot-3', duration_ms: 5000 },
    { id: 'shot-4', duration_ms: 6000 },
  ];

  const batches = groupShotsIntoBatches(shots, 10_000, 15_000);

  assert.deepEqual(batches.map((batch) => batch.shots.map((shot) => shot.id)), [
    ['shot-1', 'shot-2'],
    ['shot-3', 'shot-4'],
  ]);
  assert.deepEqual(batches.map((batch) => batch.batch_index), [1, 2]);
  assert.deepEqual(batches.map((batch) => batch.duration_ms), [10000, 11000]);
});

test('自动分批避免刚到目标下限时切出可避免短尾', () => {
  const batches = groupShotsIntoBatches([
    { id: 'shot-1', duration_ms: 6000 },
    { id: 'shot-2', duration_ms: 4000 },
    { id: 'shot-3', duration_ms: 5000 },
  ], 10_000, 15_000);

  assert.deepEqual(batches.map((batch) => batch.duration_ms), [15000]);
  assert.deepEqual(batches[0].shots.map((shot) => shot.id), ['shot-1', 'shot-2', 'shot-3']);
});

test('自动分批追加前不能超过目标上限', () => {
  const batches = groupShotsIntoBatches([
    { id: 'shot-1', duration_ms: 8000 },
    { id: 'shot-2', duration_ms: 8000 },
  ], 10_000, 15_000);

  assert.deepEqual(batches.map((batch) => batch.duration_ms), [8000, 8000]);
  assert.ok(batches.every((batch) => batch.duration_ms <= 15_000));
});

test('超过目标上限的单镜独立成批', () => {
  const shots = [
    { id: 'long', duration_ms: 16000 },
    { id: 'short-1', duration_ms: 5000 },
    { id: 'short-2', duration_ms: 5000 },
  ];

  assert.deepEqual(
    groupShotsIntoBatches(shots).map((batch) => batch.shots.map((shot) => shot.id)),
    [['long'], ['short-1', 'short-2']],
  );
  assert.deepEqual(groupShotsIntoBatches(shots).map((batch) => batch.duration_ms), [16000, 10000]);
});

test('已有手工 batch_index 时保留原批次且不强制重切', () => {
  const shots = [
    { id: 'manual-1', duration_ms: 9000, batch_index: 7 },
    { id: 'manual-2', duration_ms: 9000, batch_index: 7 },
    { id: 'manual-3', duration_ms: 3000, batch_index: 9 },
  ];

  const batches = groupShotsIntoBatches(shots);

  assert.deepEqual(batches.map((batch) => batch.shots.map((shot) => shot.id)), [
    ['manual-1', 'manual-2'],
    ['manual-3'],
  ]);
  assert.deepEqual(batches.map((batch) => batch.batch_index), [7, 9]);
  assert.deepEqual(batches.map((batch) => batch.duration_ms), [18000, 3000]);
  assert.deepEqual(shots.map((shot) => shot.batch_index), [7, 7, 9]);
});

test('提交快照按批次镜头排序、字段完整且不受后续数据库更新影响', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE redraw_shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL,
    batch_index INTEGER NOT NULL,
    shot_index INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    source_dialogue_json TEXT NOT NULL,
    localized_dialogue_json TEXT NOT NULL,
    references_json TEXT NOT NULL,
    opening_state TEXT NOT NULL,
    continuous_action TEXT NOT NULL,
    ending_state TEXT NOT NULL,
    prompt TEXT NOT NULL,
    negative_prompt TEXT NOT NULL,
    compiled_prompt_json TEXT NOT NULL,
    video_generation_id INTEGER,
    audio_asset_id INTEGER,
    subtitle_asset_id INTEGER,
    draft_json TEXT,
    deleted_at TEXT
  )`);
  const insert = db.prepare(`INSERT INTO redraw_shots
    (version_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     source_dialogue_json, localized_dialogue_json, references_json,
     opening_state, continuous_action, ending_state, prompt, negative_prompt,
     compiled_prompt_json, video_generation_id, audio_asset_id, subtitle_asset_id,
     draft_json, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
  const draft = {
    model: 'seedance-2.0',
    duration: 12,
    resolution: '1080p',
    count: 2,
    quote_snapshot: { total_credits: 48, unit_credits: 24 },
    shot_type: '中景',
    camera_movement: '推进',
    composition: '中心构图',
    lighting: '冷光',
    atmosphere: '悬疑',
    speaker: 'Maya',
    speakable_duration_ms: 2400,
    source_video_ref: { asset_id: 8 },
    new_video_ref: { generation_id: 9 },
    audio_ref: { asset_id: 10 },
    subtitle_ref: { asset_id: 11 },
  };
  insert.run(7, 2, 1, 12000, 18000, 6000, '[]', '[]', '[]',
    '走廊无人', 'Maya 转身', 'Maya 离开', 'second', 'second-negative', '{}', null, null, null, '{}');
  insert.run(7, 1, 2, 0, 12000, 12000,
    JSON.stringify([{ speaker: 'Maya', text: '有人吗？' }]),
    JSON.stringify([{ speaker: 'Maya', text: 'Anyone here?' }]),
    JSON.stringify([{ asset_id: 101, kind: 'character', version_number: 3, approval_status: 'approved' }]),
    '门关着', 'Maya 推门', '门打开', 'first', 'first-negative',
    JSON.stringify({ provider: 'seedance', text: 'compiled first' }),
    91, 92, 93, JSON.stringify(draft));

  const snapshot = snapshotShots(db, 7);
  assert.deepEqual(snapshot.map((shot) => [shot.batch_index, shot.shot_index]), [[1, 2], [2, 1]]);
  assert.equal(snapshot[0].prompt, 'first');
  assert.equal(snapshot[0].negative_prompt, 'first-negative');
  assert.deepEqual(snapshot[0].references, [
    { asset_id: 101, kind: 'character', version_number: 3, approval_status: 'approved' },
  ]);
  assert.equal(snapshot[0].model, 'seedance-2.0');
  assert.equal(snapshot[0].duration, 12);
  assert.equal(snapshot[0].duration_ms, 12000);
  assert.equal(snapshot[0].resolution, '1080p');
  assert.equal(snapshot[0].count, 2);
  assert.deepEqual(snapshot[0].quote_snapshot, { total_credits: 48, unit_credits: 24 });
  assert.deepEqual(snapshot[0].compiled_prompt, { provider: 'seedance', text: 'compiled first' });
  assert.deepEqual(snapshot[0].source_dialogue, [{ speaker: 'Maya', text: '有人吗？' }]);
  assert.deepEqual(snapshot[0].localized_dialogue, [{ speaker: 'Maya', text: 'Anyone here?' }]);
  assert.equal(snapshot[0].shot_type, '中景');
  assert.equal(snapshot[0].camera_movement, '推进');
  assert.deepEqual(snapshot[0].source_video_ref, { asset_id: 8 });
  assert.deepEqual(snapshot[0].new_video_ref, { generation_id: 9 });
  assert.deepEqual(snapshot[0].audio_ref, { asset_id: 10 });
  assert.deepEqual(snapshot[0].subtitle_ref, { asset_id: 11 });

  db.prepare(`UPDATE redraw_shots
    SET prompt = 'edited', references_json = '[]', draft_json = '{}'
    WHERE version_id = 7 AND batch_index = 1 AND shot_index = 2`).run();
  assert.equal(snapshot[0].prompt, 'first');
  assert.equal(snapshot[0].model, 'seedance-2.0');
  assert.deepEqual(snapshot[0].references, [
    { asset_id: 101, kind: 'character', version_number: 3, approval_status: 'approved' },
  ]);
  assert.deepEqual(snapshot[0].quote_snapshot, { total_credits: 48, unit_credits: 24 });
  db.close();
});

test('提交快照遇到坏 JSON 或错误结构时失败并指出镜头和列名', () => {
  const cases = [
    ['references_json', '{"bad"', /shot 31.*references_json/],
    ['source_dialogue_json', '{}', /shot 31.*source_dialogue_json/],
    ['localized_dialogue_json', '{"bad"', /shot 31.*localized_dialogue_json/],
    ['compiled_prompt_json', '[]', /shot 31.*compiled_prompt_json/],
    ['draft_json', '{"bad"', /shot 31.*draft_json/],
  ];

  for (const [column, value, pattern] of cases) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE redraw_shots (
      id INTEGER PRIMARY KEY,
      version_id INTEGER NOT NULL,
      batch_index INTEGER NOT NULL,
      shot_index INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      source_dialogue_json TEXT NOT NULL,
      localized_dialogue_json TEXT NOT NULL,
      references_json TEXT NOT NULL,
      opening_state TEXT NOT NULL,
      continuous_action TEXT NOT NULL,
      ending_state TEXT NOT NULL,
      prompt TEXT NOT NULL,
      negative_prompt TEXT NOT NULL,
      compiled_prompt_json TEXT NOT NULL,
      draft_json TEXT,
      deleted_at TEXT
    )`);
    const row = {
      id: 31,
      version_id: 7,
      batch_index: 1,
      shot_index: 1,
      start_ms: 0,
      end_ms: 12000,
      duration_ms: 12000,
      source_dialogue_json: '[]',
      localized_dialogue_json: '[]',
      references_json: '[]',
      opening_state: '',
      continuous_action: '',
      ending_state: '',
      prompt: '',
      negative_prompt: '',
      compiled_prompt_json: '{}',
      draft_json: '{}',
      deleted_at: null,
    };
    row[column] = value;
    db.prepare(`INSERT INTO redraw_shots
      (id, version_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
       source_dialogue_json, localized_dialogue_json, references_json,
       opening_state, continuous_action, ending_state, prompt, negative_prompt,
       compiled_prompt_json, draft_json, deleted_at)
      VALUES
      (@id, @version_id, @batch_index, @shot_index, @start_ms, @end_ms, @duration_ms,
       @source_dialogue_json, @localized_dialogue_json, @references_json,
       @opening_state, @continuous_action, @ending_state, @prompt, @negative_prompt,
       @compiled_prompt_json, @draft_json, @deleted_at)`).run(row);

    assert.throws(() => snapshotShots(db, 7), pattern);
    db.close();
  }
});

test('owner 快照在 SQL 解析前过滤同版本跨租户坏 JSON 且 owner 自身坏 JSON 仍失败', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE redraw_shots (
    id INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL,
    tenant_id TEXT,
    user_id TEXT,
    batch_index INTEGER NOT NULL,
    shot_index INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    source_dialogue_json TEXT NOT NULL,
    localized_dialogue_json TEXT NOT NULL,
    references_json TEXT NOT NULL,
    opening_state TEXT NOT NULL,
    continuous_action TEXT NOT NULL,
    ending_state TEXT NOT NULL,
    prompt TEXT NOT NULL,
    negative_prompt TEXT NOT NULL,
    compiled_prompt_json TEXT NOT NULL,
    draft_json TEXT,
    deleted_at TEXT
  )`);
  const insert = db.prepare(`INSERT INTO redraw_shots
    (id, version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms,
     duration_ms, source_dialogue_json, localized_dialogue_json, references_json,
     opening_state, continuous_action, ending_state, prompt, negative_prompt,
     compiled_prompt_json, draft_json, deleted_at)
    VALUES (?, 7, ?, ?, 1, ?, 0, 6000, 6000, '[]', '[]', ?, '', '', '', ?, '', '{}', '{}', NULL)`);
  insert.run(1, 'tenant-a', 'user-a', 1, '[]', 'owned');
  insert.run(2, 'tenant-b', 'user-b', 2, '{bad json', 'foreign');
  try {
    const snapshots = snapshotShots(db, 7, { tenantId: 'tenant-a', userId: 'user-a' });
    assert.deepEqual(snapshots.map((shot) => shot.id), [1]);
    assert.equal(snapshots[0].prompt, 'owned');

    db.prepare("UPDATE redraw_shots SET references_json = '{bad json' WHERE id = 1").run();
    assert.throws(
      () => snapshotShots(db, 7, { tenantId: 'tenant-a', userId: 'user-a' }),
      /shot 1.*references_json/,
    );
  } finally {
    db.close();
  }
});
