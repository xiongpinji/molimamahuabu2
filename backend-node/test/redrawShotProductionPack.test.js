const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  compileEpisodeProductionPacks,
  productionPackHash,
} = require('../src/services/redrawShotProductionPackService');
const {
  episodeLocalizationHash,
  lockLocalizationReview,
  normalizeLocalizationResultV2,
} = require('../src/services/localizationService');

const BLUEPRINT_HASH = 'b'.repeat(64);

function lockedBlueprint(overrides = {}) {
  return {
    schema_version: 'episode-blueprint-v1',
    blueprint_hash: BLUEPRINT_HASH,
    review: { status: 'locked', reviewer: 'reviewer-a' },
    characters: [
      { id: 'character-lead', source_name: '小满' },
      { id: 'offscreen-dispatcher', source_name: '调度员' },
    ],
    shots: [
      {
        id: 'shot-1', index: 1, start_ms: 0, end_ms: 4_000,
        composition: 'medium shot on 小满', camera_movement: 'slow push',
        opening_state: '小满 returns to the dispatch desk',
        continuous_action: '小满 reports to 调度员',
        ending_state: 'the dispatcher points toward the exit',
        visible_character_ids: ['character-lead'],
        dialogue: [
          { id: 'dialogue-1', speaker_id: 'character-lead', speaker_kind: 'character', source_text: '调度员，我回来了。', start_ms: 500, end_ms: 2_000, emotion: 'relieved' },
          { id: 'dialogue-2', speaker_id: 'offscreen-dispatcher', speaker_kind: 'off_screen', source_text: '先把订单送完。', start_ms: 2_100, end_ms: 3_500, emotion: 'firm' },
        ],
        text_regions: [{ id: 'text-1', kind: 'order_number', source_text: '尾号八七' }],
        audio_contract: { ambience: 'quiet dispatch office' },
      },
      {
        id: 'shot-2', index: 2, start_ms: 4_000, end_ms: 7_000,
        composition: 'wide exit shot', camera_movement: 'static',
        opening_state: 'the exit door opens', continuous_action: 'the courier leaves',
        ending_state: 'the door closes', visible_character_ids: ['character-lead'],
        dialogue: [], text_regions: [], audio_contract: {},
      },
    ],
    ...overrides,
  };
}

function lockedLocalization(overrides = {}) {
  return {
    schema_version: 'episode-localization-v1',
    blueprint_hash: BLUEPRINT_HASH,
    localization_hash: 'c'.repeat(64),
    locale: 'en-US',
    market: 'US',
    character_name_map: { 'character-lead': 'Marcus', 'offscreen-dispatcher': 'Avery' },
    dialogue_map: [
      { source_dialogue_id: 'dialogue-1', shot_id: 'shot-1', speaker_id: 'character-lead', speaker_kind: 'character', source_text: '调度员，我回来了。', target_text: 'Avery, I came back.', start_ms: 500, end_ms: 2_000, emotion: 'relieved' },
      { source_dialogue_id: 'dialogue-2', shot_id: 'shot-1', speaker_id: 'offscreen-dispatcher', speaker_kind: 'off_screen', source_text: '先把订单送完。', target_text: 'Finish the delivery first.', start_ms: 2_100, end_ms: 3_500, emotion: 'firm' },
    ],
    text_region_map: [{ text_region_id: 'text-1', shot_id: 'shot-1', source_text: '尾号八七', target_text: 'ORDER 87' }],
    cultural_adaptations: [], glossary: [], locked_terms: [],
    review: { status: 'locked' },
    ...overrides,
  };
}

test('compiles every shot from locked blueprint and localization hashes', () => {
  const blueprint = lockedBlueprint();
  const localization = lockedLocalization();
  const packs = compileEpisodeProductionPacks({
    blueprint,
    localization,
    assets: [{
      kind: 'character', source_character_key: 'character-lead', localized_name: 'Marcus',
      asset_id: 41, local_path: 'must-not-leak/portrait.png', provider: 'must-not-leak',
    }],
    references: { 'shot-1': [{ kind: 'character', asset_id: 41, anchor: 'character:character-lead' }] },
  });

  assert.equal(packs.length, blueprint.shots.length);
  assert.deepEqual(Object.keys(packs[0]), [
    'schema_version', 'shot_id', 'start_ms', 'end_ms', 'duration_ms',
    'blueprint_hash', 'localization_hash', 'characters', 'dialogue',
    'visual_contract', 'audio_contract', 'prompt', 'production_pack_hash',
  ]);
  assert.equal(packs[0].schema_version, 'redraw-shot-production-pack-v1');
  assert.equal(packs[0].shot_id, 'shot-1');
  assert.equal(packs[0].duration_ms, 4_000);
  assert.equal(packs[0].blueprint_hash, blueprint.blueprint_hash);
  assert.equal(packs[0].localization_hash, localization.localization_hash);
  assert.equal(packs[0].dialogue[0].text, 'Avery, I came back.');
  assert.equal(packs[0].characters[0].name, 'Marcus');
  assert.deepEqual(packs[0].characters[0].assets, [{ kind: 'character', asset_id: 41 }]);
  assert.equal(packs[0].production_pack_hash, productionPackHash(packs[0]));
  assert.match(packs[0].production_pack_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(packs), /must-not-leak|local_path|provider/);
});

test('English production prompt uses target names, dialogue, and screen text without source Chinese identity or lines', () => {
  const [pack] = compileEpisodeProductionPacks({ blueprint: lockedBlueprint(), localization: lockedLocalization() });
  assert.match(pack.prompt, /Marcus/);
  assert.match(pack.prompt, /Avery/);
  assert.match(pack.prompt, /Avery, I came back\./);
  assert.match(pack.prompt, /Finish the delivery first\./);
  assert.match(pack.prompt, /ORDER 87/);
  assert.doesNotMatch(pack.prompt, /小满|调度员，我回来了|先把订单送完|尾号八七/);
});

test('English production pack rejects source-language visual and audio free text after name replacement', () => {
  const cases = [
    ['composition', (shot) => { shot.composition = '室内中景 on 小满'; }],
    ['camera_movement', (shot) => { shot.camera_movement = '镜头缓慢推进'; }],
    ['opening_state', (shot) => { shot.opening_state = '门口有雨声'; }],
    ['continuous_action', (shot) => { shot.continuous_action = 'Marcus checks the 订单'; }],
    ['ending_state', (shot) => { shot.ending_state = '灯光变暗'; }],
    ['audio_contract ambience', (shot) => { shot.audio_contract = { ambience: '安静的调度站' }; }],
  ];
  for (const [name, mutate] of cases) {
    const blueprint = lockedBlueprint();
    mutate(blueprint.shots[0]);
    assert.throws(
      () => compileEpisodeProductionPacks({ blueprint, localization: lockedLocalization() }),
      (error) => error.code === 'REDRAW_PRODUCTION_PACK_SOURCE_TEXT_REMAINS',
      name,
    );
  }
});

test('canonical production pack hash changes when a structured field changes', () => {
  const input = { blueprint: lockedBlueprint(), localization: lockedLocalization() };
  const [first] = compileEpisodeProductionPacks(input);
  const changedBlueprint = structuredClone(input.blueprint);
  changedBlueprint.shots[0].camera_movement = 'locked-off camera';
  const [changed] = compileEpisodeProductionPacks({ ...input, blueprint: changedBlueprint });
  assert.notEqual(changed.production_pack_hash, first.production_pack_hash);
  assert.equal(changed.production_pack_hash, productionPackHash(changed));
});

test('rejects unlocked blueprint or localization and keeps optional assets and references explicit', () => {
  assert.throws(
    () => compileEpisodeProductionPacks({ blueprint: lockedBlueprint({ review: { status: 'approved' } }), localization: lockedLocalization() }),
    (error) => error.code === 'REDRAW_BLUEPRINT_NOT_LOCKED',
  );
  assert.throws(
    () => compileEpisodeProductionPacks({ blueprint: lockedBlueprint(), localization: lockedLocalization({ review: { status: 'review' } }) }),
    (error) => error.code === 'REDRAW_LOCALIZATION_NOT_LOCKED',
  );
  const packs = compileEpisodeProductionPacks({ blueprint: lockedBlueprint(), localization: lockedLocalization() });
  assert.deepEqual(packs[1].characters[0].assets, []);
  assert.deepEqual(packs[1].visual_contract.assets, []);
  assert.deepEqual(packs[1].visual_contract.references, []);
});

function reviewLocalization(blueprint) {
  const localization = normalizeLocalizationResultV2({
    blueprint_hash: blueprint.blueprint_hash, locale: 'en-US', market: 'US',
    name_map: { 'character-lead': 'Marcus', 'offscreen-dispatcher': 'Avery' },
    dialogue: [{ shot_id: 'shot-1', turns: [
      { id: 'dialogue-1', speaker_id: 'character-lead', target_text: 'Avery, I came back.' },
      { id: 'dialogue-2', speaker_id: 'offscreen-dispatcher', target_text: 'Finish the delivery first.' },
    ] }],
    text_map: { 'shot-1:text-1': 'ORDER 87' }, culture_map: [], glossary: [], locked_terms: [],
  }, blueprint, {
    locale: 'en-US', market: 'US', blueprintHash: blueprint.blueprint_hash,
    validateTargetText: ({ text }) => !/[\u3400-\u9fff]/u.test(text),
  });
  localization.review = {
    status: 'review', updated_at: '2026-09-03T00:00:01.000Z',
    character_name_map: { 'character-lead': true, 'offscreen-dispatcher': true },
    dialogue_map: { 'dialogue-1': true, 'dialogue-2': true }, text_region_map: { 'text-1': true },
    cultural_adaptations: {}, glossary: {}, locked_terms: {},
  };
  localization.localization_hash = episodeLocalizationHash(localization);
  return localization;
}

function createLockDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_works (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, current_version INTEGER NOT NULL, current_step INTEGER NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE redraw_versions (id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, version INTEGER NOT NULL, locale TEXT, market TEXT, status TEXT NOT NULL, blueprint_hash TEXT, localization_hash TEXT, localization_review_json TEXT, updated_at TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE redraw_episode_blueprints (id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, blueprint_json TEXT NOT NULL, blueprint_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE redraw_assets (id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT, source_ref_json TEXT, localized_name TEXT, asset_id INTEGER, voice_asset_id INTEGER, clean_plate_asset_id INTEGER, mask_asset_id INTEGER, approval_status TEXT, status TEXT, deleted_at TEXT);
    CREATE TABLE redraw_shots (id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL, shot_id TEXT NOT NULL, version_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, batch_index INTEGER NOT NULL, shot_index INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, references_json TEXT NOT NULL, compiled_prompt_json TEXT NOT NULL, preparation_snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
  `);
  const blueprint = lockedBlueprint();
  const localization = reviewLocalization(blueprint);
  const now = '2026-09-03T00:00:00.000Z';
  db.prepare("INSERT INTO redraw_works VALUES (1, 'tenant-a', 'user-a', 1, 1, 'needs_review', ?)").run(now);
  db.prepare(`INSERT INTO redraw_versions (id, work_id, tenant_id, user_id, version, locale, market, status, blueprint_hash, localization_hash, localization_review_json, updated_at)
    VALUES (10, 1, 'tenant-a', 'user-a', 1, 'en-US', 'US', 'needs_review', ?, ?, ?, ?)`)
    .run(blueprint.blueprint_hash, localization.localization_hash, JSON.stringify(localization), localization.review.updated_at);
  db.prepare(`INSERT INTO redraw_episode_blueprints VALUES (20, 1, 'tenant-a', 'user-a', 1, 'locked', ?, ?, ?)`)
    .run(JSON.stringify(blueprint), blueprint.blueprint_hash, now);
  const insertShot = db.prepare(`INSERT INTO redraw_shots (id, work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms, references_json, compiled_prompt_json, preparation_snapshot_json, updated_at)
    VALUES (?, 1, ?, 10, 'tenant-a', 'user-a', 1, ?, ?, ?, ?, '[]', ?, ?, ?)`);
  blueprint.shots.forEach((shot, index) => insertShot.run(
    100 + index, shot.id, index + 1, shot.start_ms, shot.end_ms, shot.end_ms - shot.start_ms,
    JSON.stringify({ legacy: true }), JSON.stringify({ existing: 'kept' }), now,
  ));
  db.prepare(`INSERT INTO redraw_assets (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name, asset_id, approval_status, status)
    VALUES (30, 10, 'tenant-a', 'user-a', 'character', ?, 'Marcus', 41, 'approved', 'generated')`)
    .run(JSON.stringify({ source_ref: { stable_id: 'character-lead' } }));
  return { db, blueprint, localization };
}

function lockInput(state) {
  return {
    blueprintHash: state.blueprint.blueprint_hash,
    expectedLocalizationHash: state.localization.localization_hash,
    expectedUpdatedAt: state.localization.review.updated_at,
    validateTargetText: ({ text }) => !/[\u3400-\u9fff]/u.test(text),
    now: '2026-09-03T00:00:02.000Z',
  };
}

function dbUpdateBlueprint(db, blueprint) {
  db.prepare('UPDATE redraw_episode_blueprints SET blueprint_json = ? WHERE id = 20')
    .run(JSON.stringify(blueprint));
}

test('localization lock atomically writes every existing owned shot pack and hash bindings', () => {
  const state = createLockDb();
  try {
    const locked = lockLocalizationReview(state.db, { tenantId: 'tenant-a', userId: 'user-a' }, 10, lockInput(state));
    const shots = state.db.prepare('SELECT shot_id, compiled_prompt_json, preparation_snapshot_json FROM redraw_shots ORDER BY shot_index').all();
    assert.equal(shots.length, 2);
    for (const row of shots) {
      const pack = JSON.parse(row.compiled_prompt_json);
      const snapshot = JSON.parse(row.preparation_snapshot_json);
      assert.equal(pack.shot_id, row.shot_id);
      assert.equal(pack.blueprint_hash, state.blueprint.blueprint_hash);
      assert.equal(pack.localization_hash, locked.localization_hash);
      assert.equal(pack.production_pack_hash, productionPackHash(pack));
      assert.equal(snapshot.existing, 'kept');
      assert.equal(snapshot.production_pack_hash, pack.production_pack_hash);
      assert.equal(snapshot.blueprint_hash, pack.blueprint_hash);
      assert.equal(snapshot.localization_hash, pack.localization_hash);
    }
  } finally {
    state.db.close();
  }
});

test('localization lock rolls back version, work, and earlier shot writes when pack persistence fails midway', () => {
  const state = createLockDb();
  let writes = 0;
  try {
    assert.throws(
      () => lockLocalizationReview(state.db, { tenantId: 'tenant-a', userId: 'user-a' }, 10, lockInput(state), {
        persistProductionPack(db, { row, pack, snapshot, now }) {
          writes += 1;
          if (writes === 2) throw new Error('injected pack persistence failure');
          db.prepare('UPDATE redraw_shots SET compiled_prompt_json = ?, preparation_snapshot_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(pack), JSON.stringify(snapshot), now, row.id);
        },
      }),
      /injected pack persistence failure/,
    );
    assert.equal(writes, 2);
    assert.deepEqual(state.db.prepare('SELECT status, localization_hash FROM redraw_versions WHERE id = 10').get(), {
      status: 'needs_review', localization_hash: state.localization.localization_hash,
    });
    assert.deepEqual(state.db.prepare('SELECT current_step, status FROM redraw_works WHERE id = 1').get(), {
      current_step: 1, status: 'needs_review',
    });
    const shots = state.db.prepare('SELECT compiled_prompt_json, preparation_snapshot_json FROM redraw_shots ORDER BY id').all();
    assert.equal(shots.every((row) => JSON.parse(row.compiled_prompt_json).legacy === true), true);
    assert.equal(shots.every((row) => JSON.parse(row.preparation_snapshot_json).existing === 'kept'), true);
  } finally {
    state.db.close();
  }
});

test('localization lock rolls back when English production pack keeps source-language visual text', () => {
  const state = createLockDb();
  try {
    const blueprint = structuredClone(state.blueprint);
    blueprint.shots[0].composition = '室内中景 on 小满';
    dbUpdateBlueprint(state.db, blueprint);
    assert.throws(
      () => lockLocalizationReview(state.db, { tenantId: 'tenant-a', userId: 'user-a' }, 10, lockInput(state)),
      (error) => error.code === 'REDRAW_PRODUCTION_PACK_SOURCE_TEXT_REMAINS',
    );
    assert.deepEqual(state.db.prepare('SELECT status, localization_hash FROM redraw_versions WHERE id = 10').get(), {
      status: 'needs_review', localization_hash: state.localization.localization_hash,
    });
    assert.deepEqual(state.db.prepare('SELECT current_step, status FROM redraw_works WHERE id = 1').get(), {
      current_step: 1, status: 'needs_review',
    });
    const shots = state.db.prepare('SELECT compiled_prompt_json, preparation_snapshot_json FROM redraw_shots ORDER BY id').all();
    assert.equal(shots.every((row) => JSON.parse(row.compiled_prompt_json).legacy === true), true);
    assert.equal(shots.every((row) => JSON.parse(row.preparation_snapshot_json).existing === 'kept'), true);
  } finally {
    state.db.close();
  }
});

test('localization lock fails closed and rolls back when blueprint shots have no matching DB rows', () => {
  for (const [name, arrange] of [
    ['all rows missing', (db) => db.prepare('DELETE FROM redraw_shots').run()],
    ['one row missing', (db) => db.prepare("DELETE FROM redraw_shots WHERE shot_id = 'shot-2'").run()],
    ['unexpected extra row', (db) => db.prepare(`INSERT INTO redraw_shots
      (id, work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
       start_ms, end_ms, duration_ms, references_json, compiled_prompt_json, preparation_snapshot_json, updated_at)
      VALUES (999, 1, 'shot-extra', 10, 'tenant-a', 'user-a', 1, 99, 7000, 8000, 1000, '[]', ?, ?, ?)`)
      .run(JSON.stringify({ legacy: true }), JSON.stringify({ existing: 'kept' }), '2026-09-03T00:00:00.000Z')],
    ['wrong shot id set', (db) => db.prepare("UPDATE redraw_shots SET shot_id = 'shot-missing' WHERE shot_id = 'shot-2'").run()],
  ]) {
    const state = createLockDb();
    try {
      arrange(state.db);
      assert.throws(
        () => lockLocalizationReview(state.db, { tenantId: 'tenant-a', userId: 'user-a' }, 10, lockInput(state)),
        (error) => error.code === 'REDRAW_PRODUCTION_PACK_STALE',
        name,
      );
      assert.deepEqual(state.db.prepare('SELECT status, localization_hash, localization_review_json FROM redraw_versions WHERE id = 10').get(), {
        status: 'needs_review',
        localization_hash: state.localization.localization_hash,
        localization_review_json: JSON.stringify(state.localization),
      });
      assert.deepEqual(state.db.prepare('SELECT current_step, status FROM redraw_works WHERE id = 1').get(), {
        current_step: 1, status: 'needs_review',
      });
      assert.equal(
        state.db.prepare("SELECT COUNT(*) AS count FROM redraw_shots WHERE compiled_prompt_json != ? OR preparation_snapshot_json != ?")
          .get(JSON.stringify({ legacy: true }), JSON.stringify({ existing: 'kept' })).count,
        0,
        name,
      );
    } finally {
      state.db.close();
    }
  }
});
