const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  validateGenerationEvidence,
  listPublicStylePresets,
  summarizeLocaleCapability,
  listLocaleCapabilities,
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

    CREATE TABLE redraw_locale_capabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      locale TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT '',
      text_evidence_json TEXT NOT NULL DEFAULT '{}',
      subtitles_evidence_json TEXT NOT NULL DEFAULT '{}',
      tts_evidence_json TEXT NOT NULL DEFAULT '{}',
      video_evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
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

function insertLocale(db, values) {
  db.prepare(`
    INSERT INTO redraw_locale_capabilities
      (locale, market, text_evidence_json, subtitles_evidence_json, tts_evidence_json, video_evidence_json, status, created_at, updated_at)
    VALUES
      (@locale, @market, @text_evidence_json, @subtitles_evidence_json, @tts_evidence_json, @video_evidence_json, @status, @created_at, @updated_at)
  `).run({
    locale: 'en-US',
    market: 'US',
    text_evidence_json: '{}',
    subtitles_evidence_json: '{}',
    tts_evidence_json: '{}',
    video_evidence_json: '{}',
    status: 'verified',
    created_at: NOW,
    updated_at: NOW,
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

test('summarizeLocaleCapability maps verified outputs to production status', () => {
  assert.equal(summarizeLocaleCapability({ text: true, subtitles: true, tts: true, video: true }), 'full_output');
  assert.equal(summarizeLocaleCapability({ text: true, subtitles: true, tts: false, video: true }), 'subtitle_only');
  assert.equal(summarizeLocaleCapability({ text: true, subtitles: true, tts: false, video: false }), 'voice_pending');
  assert.equal(summarizeLocaleCapability({ text: true, subtitles: false, tts: true, video: true }), 'blocking');
});

test('listLocaleCapabilities ignores unreadable evidence and returns blocking reasons', () => {
  const db = createDb();
  insertLocale(db, {
    locale: 'en-US',
    market: 'US',
    text_evidence_json: JSON.stringify(validEvidence(1)),
    subtitles_evidence_json: JSON.stringify(validEvidence(2)),
    tts_evidence_json: JSON.stringify(validEvidence(3)),
    video_evidence_json: JSON.stringify(validEvidence(4)),
  });
  insertLocale(db, {
    locale: 'ja-JP',
    market: 'JP',
    text_evidence_json: JSON.stringify(validEvidence(5)),
    subtitles_evidence_json: JSON.stringify(validEvidence(6)),
    video_evidence_json: JSON.stringify(validEvidence(7)),
  });
  insertLocale(db, {
    locale: 'ko-KR',
    market: 'KR',
    text_evidence_json: JSON.stringify(validEvidence(8)),
    subtitles_evidence_json: JSON.stringify(validEvidence(404)),
    tts_evidence_json: JSON.stringify(validEvidence(9)),
    video_evidence_json: JSON.stringify(validEvidence(10)),
  });

  const rows = listLocaleCapabilities(db, (id) => id !== 404);

  assert.deepEqual(rows, [
    { locale: 'en-US', market: 'US', status: 'full_output', blocking: [] },
    { locale: 'ja-JP', market: 'JP', status: 'subtitle_only', blocking: ['tts'] },
    { locale: 'ko-KR', market: 'KR', status: 'blocking', blocking: ['subtitles'] },
  ]);
});
