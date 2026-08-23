const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  invalidateCharacterDependents,
  invalidateDialogueDependents,
  invalidateShotTimingDependents,
  invalidateTextDependents,
} = require('../src/services/redrawDependencyInvalidationService');
const { canonicalBundleHash } = require('../src/services/redrawReferenceBundleService');

const NOW = '2026-08-22T10:00:00.000Z';
const NEXT = '2026-08-22T10:00:01.000Z';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, default_locale, default_market, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'dependency invalidation', 'en-US', 'US', ?, ?)`)
    .run(NOW, NOW);
  const projectId = Number(db.prepare('SELECT id FROM redraw_projects').get().id);
  db.prepare(`INSERT INTO assets
    (id, name, type, category, url, local_path, mime_type, metadata, created_at, updated_at)
    VALUES (101, 'source', 'video', 'redraw', '', 'source.mp4', 'video/mp4', '{}', ?, ?)`)
    .run(NOW, NOW);
  db.prepare(`INSERT INTO assets
    (id, name, type, category, url, local_path, mime_type, metadata, created_at, updated_at)
    VALUES (901, 'old output', 'video', 'redraw', '', 'old-output.mp4', 'video/mp4', '{}', ?, ?)`)
    .run(NOW, NOW);
  db.prepare(`INSERT INTO video_generations
    (id, provider, model, status, local_path, tenant_id, user_id, created_at, updated_at)
    VALUES (801, 'fake', 'redraw-local', 'completed', 'old-output.mp4', 'tenant-a', 'user-a', ?, ?)`)
    .run(NOW, NOW);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, ?, 'tenant-a', 'user-a', 'work', 101, ?, 20000, ?, ?)`)
    .run(projectId, '1'.repeat(64), NOW, NOW);
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, name_map_json, source_facts_json,
     facts_hash, status, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 1, 'en-US', 'US', '{}', '{}', ?, 'ready_to_generate', ?, ?)`)
    .run('2'.repeat(64), NOW, NOW).lastInsertRowid);
  const rows = [
    {
      id: 1,
      shot: 'shot-char-a',
      refs: [{ kind: 'character', source_character_key: 'char-a' }],
      bundle: bundle({ characters: ['char-a'], speakers: ['char-a'], texts: ['text-a'] }),
    },
    {
      id: 2,
      shot: 'shot-char-b',
      refs: [{ kind: 'voice', source_character_key: 'char-b' }],
      bundle: bundle({ characters: ['char-b'], speakers: ['char-b'], texts: ['text-b'] }),
    },
    {
      id: 3,
      shot: 'shot-text-c',
      refs: [{ kind: 'text', region_key: 'text-c' }],
      bundle: bundle({ characters: ['char-c'], speakers: [], texts: ['text-c'] }),
    },
    {
      id: 4,
      shot: 'shot-unrelated',
      refs: [{ kind: 'character', source_character_key: 'char-z' }],
      bundle: bundle({ characters: ['char-z'], speakers: [], texts: ['text-z'] }),
    },
    {
      id: 5,
      shot: 'shot-draft-ref-only',
      refs: [{ kind: 'character', source_character_key: 'char-a' }],
      bundle: bundle({ characters: ['char-x'], speakers: [], texts: [] }),
      hash: null,
    },
  ];
  const insert = db.prepare(`INSERT INTO redraw_shots
    (id, work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
     references_json, reference_bundle_json, reference_bundle_hash, reference_bundle_updated_at,
     video_generation_id, preparation_state, preparation_version, status, created_at, updated_at)
    VALUES (?, 1, ?, 'tenant-a', 'user-a', ?, 1, ?, ?, ?, 5000, '[]', '[]',
      ?, ?, ?, ?, 801, 'reference_ready', 3, 'completed', ?, ?)`);
  for (const [index, row] of rows.entries()) {
    insert.run(
      row.id,
      versionId,
      row.shot,
      index + 1,
      index * 5000,
      (index + 1) * 5000,
      stableJson(row.refs),
      stableJson(row.bundle),
      row.hash === undefined ? canonicalBundleHash(row.bundle) : row.hash,
      NOW,
      NOW,
      NOW,
    );
  }
  return {
    db,
    projectId,
    versionId,
    close() {
      db.close();
    },
  };
}

function bundle({ characters, speakers, texts }) {
  return {
    schema_version: 'redraw-reference-bundle-v2',
    face_tracks: characters.map((source_character_key, index) => ({
      track_key: `face-${index + 1}`,
      source_character_key,
      identity: {
        source_character_key,
        identity_pack_sha256: sha256(source_character_key),
        wardrobe: {
          asset_id: 700 + index,
          sha256: sha256(`wardrobe:${source_character_key}`),
        },
      },
    })),
    dialogue: {
      kind: speakers.length ? 'spoken' : 'silent',
      turns: speakers.map((speaker_id, index) => ({
        speaker_id,
        localized_text: `Line ${index + 1}`,
        start_ms: index * 1000,
        end_ms: index * 1000 + 900,
      })),
    },
    text_regions: texts.map((region_key, index) => ({
      region_key,
      kind: index % 2 === 0 ? 'text_subtitle' : 'text_screen',
      clean_plate: {
        pack_sha256: sha256(region_key),
      },
    })),
  };
}

function insertShot(state, input = {}) {
  state.db.prepare(`INSERT INTO redraw_shots
    (id, work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
     references_json, reference_bundle_json, reference_bundle_hash, reference_bundle_updated_at,
     video_generation_id, preparation_state, preparation_version, status, created_at, updated_at)
    VALUES (?, 1, ?, 'tenant-a', 'user-a', ?, 1, ?, ?, ?, 5000, '[]', '[]',
      ?, ?, ?, ?, 801, 'reference_ready', 3, 'completed', ?, ?)`)
    .run(
      Number(input.id),
      state.versionId,
      input.shot || `shot-${input.id}`,
      Number(input.id),
      Number(input.id) * 5000,
      Number(input.id) * 5000 + 5000,
      stableJson(input.refs || []),
      stableJson(input.bundle || bundle({ characters: [], speakers: [], texts: [] })),
      input.hash === undefined
        ? canonicalBundleHash(input.bundle || bundle({ characters: [], speakers: [], texts: [] }))
        : input.hash,
      NOW,
      NOW,
      NOW,
    );
}

function ctx(state) {
  return {
    db: state.db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: state.versionId,
    now: NEXT,
  };
}

function shotRows(db) {
  return db.prepare(`
    SELECT id, shot_id, reference_bundle_json, reference_bundle_hash, video_generation_id,
           preparation_state, preparation_version, preparation_evidence_hash, stale_reason_code,
           status, draft_json, error_code, error_message, updated_at
    FROM redraw_shots
    ORDER BY id
  `).all();
}

function eventRows(db) {
  return db.prepare(`
    SELECT resource_id, from_state, to_state, reason_code, evidence_hash, metadata_json
    FROM redraw_workflow_events
    ORDER BY id
  `).all();
}

test('换角色只失效引用该角色的镜头并保留旧候选', () => {
  const state = setup();
  try {
    const before = shotRows(state.db);
    const affected = invalidateCharacterDependents(ctx(state), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
    });
    assert.deepEqual(affected, [1]);
    const rows = shotRows(state.db);
    assert.equal(rows[0].preparation_state, 'stale');
    assert.equal(rows[0].preparation_version, 4);
    assert.equal(rows[0].reference_bundle_hash, null);
    assert.equal(rows[0].video_generation_id, null);
    assert.equal(rows[0].stale_reason_code, 'character_identity_changed');
    assert.equal(JSON.parse(rows[0].reference_bundle_json).face_tracks[0].source_character_key, 'char-a');
    assert.equal(rows[1].preparation_state, 'reference_ready');
    assert.equal(rows[1].reference_bundle_hash, before[1].reference_bundle_hash);
    assert.equal(rows[1].video_generation_id, 801);
    assert.equal(rows[2].preparation_state, 'reference_ready');
    assert.equal(rows[3].preparation_state, 'reference_ready');
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM video_generations WHERE id = 801').get().count, 1);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM assets WHERE id = 901').get().count, 1);
    const events = eventRows(state.db);
    assert.equal(events.length, 1);
    assert.deepEqual({
      resource_id: events[0].resource_id,
      from_state: events[0].from_state,
      to_state: events[0].to_state,
      reason_code: events[0].reason_code,
    }, {
      resource_id: '1',
      from_state: 'reference_ready',
      to_state: 'stale',
      reason_code: 'character_identity_changed',
    });
    assert.match(events[0].evidence_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(events[0].metadata_json), {
      dependency_kind: 'character',
      dependency_id: 'char-a',
      old_bundle_hash: before[0].reference_bundle_hash,
      old_generation_id: 801,
      previous_preparation_version: 3,
    });
  } finally {
    state.close();
  }
});

test('声音、服装、文字区域和镜头时间变化只失效精确依赖镜头', () => {
  const state = setup();
  try {
    assert.deepEqual(invalidateDialogueDependents(ctx(state), {
      source_character_key: 'char-b',
      dependency_kind: 'voice',
      reason_code: 'voice_changed',
    }), [2]);
    assert.deepEqual(invalidateCharacterDependents(ctx(state), {
      source_character_key: 'char-a',
      dependency_kind: 'wardrobe',
      reason_code: 'character_wardrobe_changed',
    }), [1]);
    assert.deepEqual(invalidateTextDependents(ctx(state), {
      region_key: 'text-c',
      reason_code: 'text_region_changed',
    }), [3]);
    assert.deepEqual(invalidateShotTimingDependents(ctx(state), {
      shot_id: 4,
      reason_code: 'shot_timing_changed',
    }), [4]);
    const rows = shotRows(state.db);
    assert.deepEqual(rows.map((row) => row.preparation_state), ['stale', 'stale', 'stale', 'stale', 'reference_ready']);
    assert.deepEqual(rows.map((row) => row.stale_reason_code), [
      'character_wardrobe_changed',
      'voice_changed',
      'text_region_changed',
      'shot_timing_changed',
      null,
    ]);
    assert.equal(eventRows(state.db).length, 4);
  } finally {
    state.close();
  }
});

test('无关镜头保持不变，CAS 失败零部分写入', () => {
  const state = setup();
  try {
    const before = shotRows(state.db);
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(state), {
        source_character_key: 'char-a',
        reason_code: 'character_identity_changed',
        expected_updated_at_by_shot_id: { 1: 'stale-cas' },
      })), 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT');
    assert.deepEqual(shotRows(state.db), before);
    assert.deepEqual(eventRows(state.db), []);

    assert.deepEqual(invalidateCharacterDependents(ctx(state), {
      source_character_key: 'missing-character',
      reason_code: 'character_identity_changed',
    }), []);
    assert.deepEqual(shotRows(state.db), before);
    assert.deepEqual(eventRows(state.db), []);
  } finally {
    state.close();
  }
});

test('expected_updated_at_by_shot_id 必须与 affected shot ids 精确一致', () => {
  const missing = setup();
  try {
    const before = shotRows(missing.db);
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(missing), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
      expected_updated_at_by_shot_id: {},
    })), 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT');
    assert.deepEqual(shotRows(missing.db), before);
    assert.deepEqual(eventRows(missing.db), []);
  } finally {
    missing.close();
  }

  const extra = setup();
  try {
    const before = shotRows(extra.db);
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(extra), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
      expected_updated_at_by_shot_id: { 1: NOW, 2: NOW },
    })), 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT');
    assert.deepEqual(shotRows(extra.db), before);
    assert.deepEqual(eventRows(extra.db), []);
  } finally {
    extra.close();
  }

  const emptyAffected = setup();
  try {
    const before = shotRows(emptyAffected.db);
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(emptyAffected), {
      source_character_key: 'missing-character',
      reason_code: 'character_identity_changed',
      expected_updated_at_by_shot_id: { 1: NOW },
    })), 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT');
    assert.deepEqual(shotRows(emptyAffected.db), before);
    assert.deepEqual(eventRows(emptyAffected.db), []);
  } finally {
    emptyAffected.close();
  }
});

test('只失效已绑定当前参考包的镜头，草稿引用不被误伤', () => {
  const state = setup();
  try {
    const affected = invalidateCharacterDependents(ctx(state), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
    });
    assert.deepEqual(affected, [1]);
    const draft = shotRows(state.db).find((row) => row.id === 5);
    assert.equal(draft.preparation_state, 'reference_ready');
    assert.equal(draft.reference_bundle_hash, null);
    assert.equal(draft.video_generation_id, 801);
    assert.equal(eventRows(state.db).length, 1);
  } finally {
    state.close();
  }
});

test('失效 completed 候选时转 pending、仅清 draft generation 指针并保留旧视频证据', () => {
  const state = setup();
  try {
    state.db.prepare(`
      UPDATE redraw_shots
      SET status = 'completed',
          video_generation_id = 801,
          draft_json = ?,
          error_code = 'old_error',
          error_message = 'old message'
      WHERE id = 1
    `).run(stableJson({
      generation: {
        video_generation_id: 801,
        provider_task_id: 'old-provider-task',
      },
      preserved_notes: ['keep'],
      reference_evidence: { old: true },
    }));
    const affected = invalidateCharacterDependents(ctx(state), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
      expected_updated_at_by_shot_id: { 1: NOW },
    });
    assert.deepEqual(affected, [1]);
    const row = shotRows(state.db).find((entry) => entry.id === 1);
    assert.equal(row.status, 'pending');
    assert.equal(row.video_generation_id, null);
    assert.equal(row.error_code, null);
    assert.equal(row.error_message, null);
    assert.equal(row.preparation_state, 'stale');
    assert.deepEqual(JSON.parse(row.draft_json), {
      generation: {},
      preserved_notes: ['keep'],
      reference_evidence: { old: true },
    });
    assert.equal(['completed', 'processing'].includes(row.status), false);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM video_generations WHERE id = 801').get().count, 1);
  } finally {
    state.close();
  }
});

test('affected shot 仍在 processing 时整批冲突并零写入', () => {
  const state = setup();
  try {
    state.db.prepare(`
      UPDATE redraw_shots
      SET status = 'processing',
          video_generation_id = 801,
          draft_json = ?
      WHERE id = 1
    `).run(stableJson({ generation: { video_generation_id: 801 }, preserved: true }));
    const before = shotRows(state.db);
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(state), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
      expected_updated_at_by_shot_id: { 1: NOW },
    })), 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT');
    assert.deepEqual(shotRows(state.db), before);
    assert.deepEqual(eventRows(state.db), []);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM video_generations WHERE id = 801').get().count, 1);
  } finally {
    state.close();
  }
});

test('affected shot 的 draft_json malformed 时 fail closed 并回滚', () => {
  const state = setup();
  try {
    state.db.prepare("UPDATE redraw_shots SET draft_json = '{' WHERE id = 1").run();
    const before = shotRows(state.db);
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(state), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
      expected_updated_at_by_shot_id: { 1: NOW },
    })), 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT');
    assert.deepEqual(shotRows(state.db), before);
    assert.deepEqual(eventRows(state.db), []);
  } finally {
    state.close();
  }
});

test('current reference bundle malformed 或 hash drift 时冲突且零写入', () => {
  const malformed = setup();
  try {
    malformed.db.prepare("UPDATE redraw_shots SET reference_bundle_json = '{' WHERE id = 1").run();
    const before = shotRows(malformed.db);
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(malformed), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
      expected_updated_at_by_shot_id: { 1: NOW },
    })), 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT');
    assert.deepEqual(shotRows(malformed.db), before);
    assert.deepEqual(eventRows(malformed.db), []);
  } finally {
    malformed.close();
  }

  const drift = setup();
  try {
    drift.db.prepare("UPDATE redraw_shots SET reference_bundle_hash = ? WHERE id = 1").run('f'.repeat(64));
    const before = shotRows(drift.db);
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(drift), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
      expected_updated_at_by_shot_id: { 1: NOW },
    })), 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT');
    assert.deepEqual(shotRows(drift.db), before);
    assert.deepEqual(eventRows(drift.db), []);
  } finally {
    drift.close();
  }

  const legacy = setup();
  try {
    const rows = legacy.db.prepare(`
      SELECT id, reference_bundle_json
      FROM redraw_shots
      WHERE reference_bundle_hash IS NOT NULL
    `).all();
    for (const row of rows) {
      const referenceBundle = JSON.parse(row.reference_bundle_json);
      referenceBundle.schema_version = 'redraw-reference-bundle-v1';
      legacy.db.prepare(`
        UPDATE redraw_shots
        SET reference_bundle_json = ?, reference_bundle_hash = ?
        WHERE id = ?
      `).run(stableJson(referenceBundle), canonicalBundleHash(referenceBundle), row.id);
    }
    const before = shotRows(legacy.db);
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(legacy), {
      source_character_key: 'char-a',
      reason_code: 'character_identity_changed',
      expected_updated_at_by_shot_id: { 1: NOW },
    })), 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT');
    assert.deepEqual(shotRows(legacy.db), before);
    assert.deepEqual(eventRows(legacy.db), []);
  } finally {
    legacy.close();
  }
});

test('角色、声音和文字依赖按明确 kind role 白名单匹配，跨域同 key 不误伤', () => {
  const state = setup();
  try {
    insertShot(state, {
      id: 11,
      refs: [{ kind: 'voice', source_character_key: 'cross-character' }],
    });
    insertShot(state, {
      id: 12,
      refs: [{ role: 'character', source_character_key: 'cross-voice' }],
    });
    insertShot(state, {
      id: 13,
      refs: [{ kind: 'identity', source_character_key: 'cross-voice-identity' }],
    });
    insertShot(state, {
      id: 14,
      refs: [{ kind: 'character', region_key: 'cross-text' }],
    });
    insertShot(state, {
      id: 15,
      refs: [{ arbitrary: { source_character_key: 'unknown-character', region_key: 'unknown-text' } }],
    });
    insertShot(state, {
      id: 16,
      refs: [],
      bundle: bundle({ characters: ['bundle-face-only'], speakers: [], texts: [] }),
    });
    insertShot(state, {
      id: 17,
      refs: [],
      bundle: bundle({ characters: [], speakers: ['bundle-dialogue-only'], texts: [] }),
    });

    assert.deepEqual(invalidateCharacterDependents(ctx(state), {
      source_character_key: 'cross-character',
      reason_code: 'character_identity_changed',
    }), []);
    assert.deepEqual(invalidateDialogueDependents(ctx(state), {
      source_character_key: 'cross-voice',
      reason_code: 'voice_changed',
    }), []);
    assert.deepEqual(invalidateDialogueDependents(ctx(state), {
      source_character_key: 'cross-voice-identity',
      reason_code: 'voice_changed',
    }), []);
    assert.deepEqual(invalidateTextDependents(ctx(state), {
      region_key: 'cross-text',
      reason_code: 'text_region_changed',
    }), []);
    assert.deepEqual(invalidateCharacterDependents(ctx(state), {
      source_character_key: 'unknown-character',
      reason_code: 'character_identity_changed',
    }), []);
    assert.deepEqual(invalidateTextDependents(ctx(state), {
      region_key: 'unknown-text',
      reason_code: 'text_region_changed',
    }), []);
    assert.deepEqual(invalidateDialogueDependents(ctx(state), {
      source_character_key: 'bundle-face-only',
      reason_code: 'voice_changed',
    }), []);
    assert.deepEqual(invalidateCharacterDependents(ctx(state), {
      source_character_key: 'bundle-dialogue-only',
      reason_code: 'character_identity_changed',
    }), []);
    assert.deepEqual(eventRows(state.db), []);
  } finally {
    state.close();
  }
});

test('dependency_kind 输入只允许各入口合同内的固定种类', () => {
  const state = setup();
  try {
    assert.equal(captureCode(() => invalidateCharacterDependents(ctx(state), {
      source_character_key: 'char-a',
      dependency_kind: 'voice',
      reason_code: 'character_identity_changed',
    })), 'REDRAW_DEPENDENCY_INVALIDATION_INPUT_INVALID');
    assert.equal(captureCode(() => invalidateDialogueDependents(ctx(state), {
      source_character_key: 'char-b',
      dependency_kind: 'character',
      reason_code: 'voice_changed',
    })), 'REDRAW_DEPENDENCY_INVALIDATION_INPUT_INVALID');
    assert.deepEqual(shotRows(state.db).map((row) => row.preparation_state), [
      'reference_ready',
      'reference_ready',
      'reference_ready',
      'reference_ready',
      'reference_ready',
    ]);
    assert.deepEqual(eventRows(state.db), []);
  } finally {
    state.close();
  }
});

function captureCode(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error?.code || null;
  }
}
