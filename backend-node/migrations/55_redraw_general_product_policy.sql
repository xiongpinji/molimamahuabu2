ALTER TABLE redraw_projects ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'safe'
  CHECK (execution_mode IN ('safe', 'auto'));
ALTER TABLE redraw_projects ADD COLUMN budget_limit_credits INTEGER
  CHECK (budget_limit_credits IS NULL OR budget_limit_credits > 0);
ALTER TABLE redraw_projects ADD COLUMN max_auto_attempts_per_shot INTEGER
  CHECK (max_auto_attempts_per_shot IS NULL OR max_auto_attempts_per_shot BETWEEN 1 AND 5);
ALTER TABLE redraw_projects ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1
  CHECK (policy_version > 0);
ALTER TABLE redraw_projects ADD COLUMN automation_policy_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE redraw_workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  evidence_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES redraw_projects(id)
);

CREATE INDEX idx_redraw_workflow_events_project
  ON redraw_workflow_events(tenant_id, user_id, project_id, id DESC);

CREATE TRIGGER redraw_workflow_events_immutable_update
BEFORE UPDATE ON redraw_workflow_events
BEGIN SELECT RAISE(ABORT, 'redraw workflow events are immutable'); END;

CREATE TRIGGER redraw_workflow_events_immutable_delete
BEFORE DELETE ON redraw_workflow_events
BEGIN SELECT RAISE(ABORT, 'redraw workflow events are immutable'); END;
