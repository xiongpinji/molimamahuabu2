CREATE TABLE IF NOT EXISTS redraw_unit_reference_derivations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  work_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  queue_id INTEGER NOT NULL,
  queue_unit_id INTEGER NOT NULL,
  requirement_id TEXT NOT NULL CHECK (length(trim(requirement_id)) > 0),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^a-f0-9]*'),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  output_json TEXT NOT NULL CHECK (json_valid(output_json)),
  output_asset_id INTEGER NOT NULL,
  output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64 AND output_sha256 NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, user_id, queue_unit_id, requirement_id, input_hash),
  FOREIGN KEY(work_id) REFERENCES redraw_works(id),
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id),
  FOREIGN KEY(queue_id) REFERENCES redraw_execution_queues(id),
  FOREIGN KEY(queue_unit_id) REFERENCES redraw_execution_queue_units(id),
  FOREIGN KEY(output_asset_id) REFERENCES assets(id)
);

CREATE TRIGGER IF NOT EXISTS redraw_unit_reference_derivations_immutable_update
BEFORE UPDATE ON redraw_unit_reference_derivations
BEGIN
  SELECT RAISE(ABORT, 'redraw unit reference derivation immutable');
END;

CREATE TRIGGER IF NOT EXISTS redraw_unit_reference_derivations_immutable_delete
BEFORE DELETE ON redraw_unit_reference_derivations
BEGIN
  SELECT RAISE(ABORT, 'redraw unit reference derivation immutable');
END;
