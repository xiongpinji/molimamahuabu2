CREATE TABLE IF NOT EXISTS redraw_reference_artifact_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version_id INTEGER NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('character', 'shot')),
  scope_id INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('identity', 'wardrobe', 'motion')),
  idempotency_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  stored_asset_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_reference_artifact_imports_idempotency
  ON redraw_reference_artifact_imports(
    tenant_id,
    user_id,
    version_id,
    scope_type,
    scope_id,
    purpose,
    idempotency_hash
  );

CREATE INDEX IF NOT EXISTS idx_redraw_reference_artifact_imports_scope_status
  ON redraw_reference_artifact_imports(
    tenant_id,
    user_id,
    version_id,
    scope_type,
    scope_id,
    status
  );
