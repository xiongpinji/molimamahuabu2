ALTER TABLE redraw_versions ADD COLUMN localization_task_id TEXT;

ALTER TABLE redraw_versions ADD COLUMN localization_credit_reservation_id TEXT;

ALTER TABLE redraw_versions ADD COLUMN localization_input_hash TEXT;

ALTER TABLE redraw_versions ADD COLUMN localization_idempotency_key TEXT;

ALTER TABLE redraw_versions ADD COLUMN localization_model_snapshot_json TEXT NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_localization_idempotency
  ON redraw_versions(tenant_id, user_id, work_id, localization_idempotency_key)
  WHERE localization_idempotency_key IS NOT NULL
    AND trim(localization_idempotency_key) <> ''
    AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS redraw_asset_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  quote_snapshot_json TEXT NOT NULL DEFAULT '{}',
  asset_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'partial_failed', 'failed', 'needs_attention')),
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_asset_batch_idempotency
  ON redraw_asset_batches(tenant_id, user_id, version_id, idempotency_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_redraw_asset_batch_version
  ON redraw_asset_batches(version_id, status, updated_at DESC);
