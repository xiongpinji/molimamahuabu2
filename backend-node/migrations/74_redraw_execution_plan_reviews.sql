CREATE TABLE IF NOT EXISTS redraw_execution_plan_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  work_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^a-f0-9]*'),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, user_id, version_id, plan_hash),
  FOREIGN KEY(work_id) REFERENCES redraw_works(id),
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_redraw_execution_plan_reviews_latest
  ON redraw_execution_plan_reviews(tenant_id, user_id, version_id, id DESC);

CREATE TRIGGER IF NOT EXISTS redraw_execution_plan_reviews_immutable_update
BEFORE UPDATE ON redraw_execution_plan_reviews
BEGIN
  SELECT RAISE(ABORT, 'redraw execution plan review immutable');
END;

CREATE TRIGGER IF NOT EXISTS redraw_execution_plan_reviews_immutable_delete
BEFORE DELETE ON redraw_execution_plan_reviews
BEGIN
  SELECT RAISE(ABORT, 'redraw execution plan review immutable');
END;
