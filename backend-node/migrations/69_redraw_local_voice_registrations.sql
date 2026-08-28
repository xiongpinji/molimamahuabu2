CREATE TABLE IF NOT EXISTS redraw_local_voice_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version_id INTEGER NOT NULL,
  voice_redraw_asset_id INTEGER NOT NULL,
  source_character_key TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  target_market TEXT NOT NULL DEFAULT '',
  approved_text_sha256 TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  engine_manifest_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'needs_attention', 'failed')),
  audio_asset_id INTEGER,
  audio_sha256 TEXT,
  locale_evidence_sha256 TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id),
  FOREIGN KEY(voice_redraw_asset_id) REFERENCES redraw_assets(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_local_voice_registration_idempotency
  ON redraw_local_voice_registrations(tenant_id, user_id, version_id, voice_redraw_asset_id, idempotency_hash)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_redraw_local_voice_registration_version
  ON redraw_local_voice_registrations(version_id, status, updated_at DESC);
