CREATE TABLE IF NOT EXISTS redraw_episode_blueprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked')),
  blueprint_json TEXT NOT NULL,
  blueprint_hash TEXT NOT NULL,
  evidence_manifest_json TEXT NOT NULL DEFAULT '{}',
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(work_id, revision),
  UNIQUE(work_id, blueprint_hash),
  FOREIGN KEY(work_id) REFERENCES redraw_works(id)
);

CREATE INDEX IF NOT EXISTS idx_redraw_episode_blueprints_owner
  ON redraw_episode_blueprints(tenant_id, user_id, work_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_redraw_episode_blueprints_work_status
  ON redraw_episode_blueprints(work_id, status, revision DESC);

CREATE TRIGGER IF NOT EXISTS redraw_episode_blueprints_locked_immutable_update
BEFORE UPDATE ON redraw_episode_blueprints
WHEN OLD.status = 'locked'
BEGIN
  SELECT RAISE(ABORT, 'redraw episode blueprint immutable');
END;

CREATE TRIGGER IF NOT EXISTS redraw_episode_blueprints_locked_immutable_delete
BEFORE DELETE ON redraw_episode_blueprints
WHEN OLD.status = 'locked'
BEGIN
  SELECT RAISE(ABORT, 'redraw episode blueprint immutable');
END;

ALTER TABLE redraw_versions ADD COLUMN blueprint_hash TEXT;

ALTER TABLE redraw_versions ADD COLUMN localization_hash TEXT;

ALTER TABLE redraw_versions ADD COLUMN localization_review_json TEXT;
