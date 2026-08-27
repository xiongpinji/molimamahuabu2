CREATE TABLE IF NOT EXISTS redraw_coverage_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version_id INTEGER NOT NULL,
  idempotency_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'needs_attention', 'failed')),
  provider_task_id TEXT,
  analysis_sha256 TEXT,
  redraw_asset_id INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id),
  FOREIGN KEY(redraw_asset_id) REFERENCES redraw_assets(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_coverage_registration_idempotency
  ON redraw_coverage_registrations(tenant_id, user_id, version_id, idempotency_hash)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_redraw_coverage_registration_version
  ON redraw_coverage_registrations(version_id, status, updated_at DESC);
