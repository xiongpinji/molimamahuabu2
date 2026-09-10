CREATE TABLE IF NOT EXISTS redraw_execution_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  work_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  review_id INTEGER NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL CHECK (status = 'waiting_readiness'),
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, user_id, version_id, plan_hash),
  FOREIGN KEY(work_id) REFERENCES redraw_works(id),
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id),
  FOREIGN KEY(review_id) REFERENCES redraw_execution_plan_reviews(id)
);

CREATE INDEX IF NOT EXISTS idx_redraw_execution_queues_latest
  ON redraw_execution_queues(tenant_id, user_id, version_id, id DESC);

CREATE TABLE IF NOT EXISTS redraw_execution_queue_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL,
  unit_id TEXT NOT NULL CHECK (length(trim(unit_id)) > 0),
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  unit_hash TEXT NOT NULL CHECK (length(unit_hash) = 64 AND unit_hash NOT GLOB '*[^a-f0-9]*'),
  unit_json TEXT NOT NULL CHECK (json_valid(unit_json)),
  status TEXT NOT NULL CHECK (status = 'pending'),
  UNIQUE(queue_id, unit_id),
  UNIQUE(queue_id, ordinal),
  FOREIGN KEY(queue_id) REFERENCES redraw_execution_queues(id)
);

CREATE TRIGGER IF NOT EXISTS redraw_execution_queues_immutable_update
BEFORE UPDATE ON redraw_execution_queues
BEGIN
  SELECT RAISE(ABORT, 'redraw execution queue immutable');
END;

CREATE TRIGGER IF NOT EXISTS redraw_execution_queues_immutable_delete
BEFORE DELETE ON redraw_execution_queues
BEGIN
  SELECT RAISE(ABORT, 'redraw execution queue immutable');
END;

CREATE TRIGGER IF NOT EXISTS redraw_execution_queue_units_immutable_update
BEFORE UPDATE ON redraw_execution_queue_units
BEGIN
  SELECT RAISE(ABORT, 'redraw execution queue unit immutable');
END;

CREATE TRIGGER IF NOT EXISTS redraw_execution_queue_units_immutable_delete
BEFORE DELETE ON redraw_execution_queue_units
BEGIN
  SELECT RAISE(ABORT, 'redraw execution queue unit immutable');
END;
