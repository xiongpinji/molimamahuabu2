const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  validateGenerationEvidence,
  listPublicStylePresets,
  summarizeLocaleCapability,
  listLocaleCapabilities,
  resolveVerifiedLocaleCapability,
} = require('../src/services/redrawCapabilityService');

const NOW = '2026-08-06T00:00:00.000Z';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_style_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      user_id TEXT,
      stable_key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      prompt_template TEXT NOT NULL DEFAULT '',
      negative_prompt_template TEXT NOT NULL DEFAULT '',
      preview_asset_id INTEGER,
      compatible_models_json TEXT NOT NULL DEFAULT '[]',
      supported_ratios_json TEXT NOT NULL DEFAULT '[]',
      verification_evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT,
      provider TEXT,
      name TEXT,
      model TEXT,
      is_active INTEGER DEFAULT 1,
      is_default INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      settings TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

function validEvidence(artifactId = 1) {
  return {
    provider: 'provider-a',
    model: 'model-a',
    task_id: 'task-a',
    terminal_status: 'completed',
    artifact_id: artifactId,
  };
}

function insertStyle(db, values) {
  db.prepare(`
    INSERT INTO redraw_style_presets
      (stable_key, name, category, sort_order, version, verification_evidence_json, status, created_at, updated_at)
    VALUES
      (@stable_key, @name, @category, @sort_order, @version, @verification_evidence_json, @status, @created_at, @updated_at)
  `).run({
    category: 'live_action',
    sort_order: 1,
    version: 1,
    verification_evidence_json: JSON.stringify(validEvidence()),
    status: 'verified',
    created_at: NOW,
    updated_at: NOW,
    ...values,
  });
}

function insertConfig(db, entries, values = {}) {
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, is_active, settings, deleted_at)
    VALUES
      (@service_type, @provider, @name, @model, @is_active, @settings, @deleted_at)
  `).run({
    service_type: 'video',
    provider: 'provider-a',
    name: 'Locale capability config',
    model: 'model-a',
    is_active: 1,
    settings: JSON.stringify({ redraw_locale_capabilities: entries }),
    deleted_at: null,
    ...values,
  });
}

test('validateGenerationEvidence requires provider, model, completed task, and readable artifact', () => {
  const readable = new Set([1]);
  const canReadArtifact = (id) => readable.has(id);

  assert.equal(validateGenerationEvidence(validEvidence(1), canReadArtifact), true);
  assert.equal(validateGenerationEvidence({ ...validEvidence(1), provider: '' }, canReadArtifact), false);
  assert.equal(validateGenerationEvidence({ ...validEvidence(1), model: '' }, canReadArtifact), false);
  assert.equal(validateGenerationEvidence({ ...validEvidence(1), task_id: '' }, canReadArtifact), false);
  assert.equal(validateGenerationEvidence({ ...validEvidence(1), terminal_status: 'failed' }, canReadArtifact), false);
  assert.equal(validateGenerationEvidence({ ...validEvidence(2) }, canReadArtifact), false);
  assert.equal(validateGenerationEvidence(validEvidence(1), () => {
    throw new Error('artifact store unavailable');
  }), false);
});

test('listPublicStylePresets only exposes verified presets with valid readable evidence', () => {
  const db = createDb();
  insertStyle(db, { stable_key: 'draft', name: '草稿', status: 'draft' });
  insertStyle(db, { stable_key: 'disabled', name: '停用', status: 'disabled' });
  insertStyle(db, { stable_key: 'missing-evidence', name: '缺证据', verification_evidence_json: '{}' });
  insertStyle(db, {
    stable_key: 'unreadable',
    name: '不可读',
    verification_evidence_json: JSON.stringify(validEvidence(404)),
  });
  insertStyle(db, {
    stable_key: 'visible-b',
    name: '可见 B',
    category: 'live_action',
    sort_order: 2,
    version: 1,
    verification_evidence_json: JSON.stringify(validEvidence(2)),
  });
  insertStyle(db, {
    stable_key: 'visible-a',
    name: '可见 A',
    category: 'anime_2d',
    sort_order: 1,
    version: 2,
    verification_evidence_json: JSON.stringify(validEvidence(1)),
  });

  const rows = listPublicStylePresets(db, (id) => id === 1 || id === 2);

  assert.deepEqual(rows.map((row) => row.stable_key), ['visible-a', 'visible-b']);
});

test('listPublicStylePresets skips evidence when artifact read callback throws', () => {
  const db = createDb();
  insertStyle(db, {
    stable_key: 'throws',
    name: '抛错',
    verification_evidence_json: JSON.stringify(validEvidence('throws')),
  });
  insertStyle(db, {
    stable_key: 'visible',
    name: '可见',
    verification_evidence_json: JSON.stringify(validEvidence(1)),
  });

  const rows = listPublicStylePresets(db, (id) => {
    if (id === 'throws') throw new Error('artifact store unavailable');
    return id === 1;
  });

  assert.deepEqual(rows.map((row) => row.stable_key), ['visible']);
});

test('summarizeLocaleCapability maps verified outputs to production status', () => {
  assert.equal(summarizeLocaleCapability({
    text: true,
    subtitles: true,
    character_image: true,
    clean_plate_image: true,
    tts: true,
    video: true,
  }), 'full_output');
  assert.equal(summarizeLocaleCapability({
    text: true,
    subtitles: true,
    character_image: false,
    clean_plate_image: true,
    tts: true,
    video: true,
  }), 'asset_pending');
  assert.equal(summarizeLocaleCapability({
    text: true,
    subtitles: true,
    character_image: true,
    clean_plate_image: false,
    tts: true,
    video: true,
  }), 'asset_pending');
  assert.equal(summarizeLocaleCapability({
    text: true,
    subtitles: true,
    character_image: true,
    clean_plate_image: true,
    tts: false,
    video: true,
  }), 'subtitle_only');
  assert.equal(summarizeLocaleCapability({
    text: true,
    subtitles: true,
    character_image: true,
    clean_plate_image: true,
    tts: false,
    video: false,
  }), 'voice_pending');
  assert.equal(summarizeLocaleCapability({
    text: true,
    subtitles: false,
    character_image: true,
    clean_plate_image: true,
    tts: true,
    video: true,
  }), 'blocking');
});

test('resolveVerifiedLocaleCapability returns only exact verified readable locale capability', () => {
  const db = createDb();
  insertConfig(db, [
    {
      locale: 'en-US',
      market: 'US',
      status: 'verified',
      evidence: {
        text: validEvidence(31),
      },
    },
  ]);

  assert.deepEqual(resolveVerifiedLocaleCapability(db, {
    locale: 'en-US',
    market: 'US',
    capability: 'text',
    canReadArtifact: (id) => id === 31,
  }), {
    provider: 'provider-a',
    model: 'model-a',
    evidence: validEvidence(31),
  });
  assert.equal(resolveVerifiedLocaleCapability(db, {
    locale: 'en-GB',
    market: 'GB',
    capability: 'text',
    canReadArtifact: (id) => id === 31,
  }), null);
  assert.equal(resolveVerifiedLocaleCapability(db, {
    locale: 'en-US',
    market: 'US',
    capability: 'text',
    canReadArtifact: () => false,
  }), null);
});

test('listLocaleCapabilities ignores unreadable evidence and returns blocking reasons', () => {
  const db = createDb();
  insertConfig(db, [
    null,
    'bad-entry',
    ['bad-entry'],
    {
      locale: 'en-US',
      market: 'US',
      status: 'verified',
      evidence: {
        text: validEvidence(1),
        subtitles: validEvidence(2),
        character_image: validEvidence(23),
        clean_plate_image: validEvidence(24),
        tts: validEvidence(3),
        video: validEvidence(4),
      },
    },
    {
      locale: 'ja-JP',
      market: 'JP',
      status: 'verified',
      evidence: {
        text: validEvidence(5),
        subtitles: validEvidence(6),
        video: validEvidence(7),
      },
    },
    {
      locale: 'ko-KR',
      market: 'KR',
      status: 'verified',
      evidence: {
        text: validEvidence(8),
        subtitles: validEvidence(404),
        character_image: validEvidence(25),
        clean_plate_image: validEvidence(26),
        tts: validEvidence(9),
        video: validEvidence(10),
      },
    },
    {
      locale: 'de-DE',
      market: 'DE',
      status: 'verified',
      evidence: {
        text: validEvidence('throws'),
        subtitles: validEvidence(20),
        character_image: validEvidence(27),
        clean_plate_image: validEvidence(28),
        tts: validEvidence(21),
        video: validEvidence(22),
      },
    },
    {
      locale: 'zh-CN',
      market: 'CN',
      status: 'draft',
      evidence: {
        text: validEvidence(11),
        subtitles: validEvidence(12),
        tts: validEvidence(13),
        video: validEvidence(14),
      },
    },
  ]);
  insertConfig(db, [
    {
      locale: 'fr-FR',
      market: 'FR',
      status: 'verified',
      evidence: {
        text: validEvidence(15),
        subtitles: validEvidence(16),
        character_image: validEvidence(29),
        clean_plate_image: validEvidence(30),
        tts: validEvidence(17),
        video: validEvidence(18),
      },
    },
  ], { is_active: 0 });

  const rows = listLocaleCapabilities(db, (id) => {
    if (id === 'throws') throw new Error('artifact store unavailable');
    return id !== 404;
  });

  assert.deepEqual(rows, [
    { locale: 'de-DE', market: 'DE', status: 'blocking', blocking: ['text'] },
    { locale: 'en-US', market: 'US', status: 'full_output', blocking: [] },
    { locale: 'ja-JP', market: 'JP', status: 'subtitle_only', blocking: ['character_image', 'clean_plate_image', 'tts'] },
    { locale: 'ko-KR', market: 'KR', status: 'blocking', blocking: ['subtitles'] },
  ]);
});
