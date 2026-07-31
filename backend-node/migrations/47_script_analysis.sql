CREATE TABLE IF NOT EXISTS script_analysis_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_script TEXT NOT NULL DEFAULT '',
  locked_facts_json TEXT NOT NULL DEFAULT '[]',
  analysis_json TEXT,
  review_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_script_analysis_projects_user
  ON script_analysis_projects(user_id, updated_at);

CREATE TABLE IF NOT EXISTS script_analysis_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  source_script TEXT NOT NULL,
  package_json TEXT NOT NULL,
  ai_changes_json TEXT NOT NULL DEFAULT '[]',
  approval_status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version),
  FOREIGN KEY(project_id) REFERENCES script_analysis_projects(id)
);
