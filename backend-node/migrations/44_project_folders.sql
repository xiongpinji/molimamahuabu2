CREATE TABLE IF NOT EXISTS project_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

ALTER TABLE dramas ADD COLUMN folder_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_project_folders_tenant_name
  ON project_folders(tenant_id, name);

CREATE INDEX IF NOT EXISTS idx_dramas_tenant_folder_updated
  ON dramas(tenant_id, folder_id, updated_at DESC);
