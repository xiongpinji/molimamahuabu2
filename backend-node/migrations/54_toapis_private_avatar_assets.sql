CREATE TABLE IF NOT EXISTS toapis_private_avatar_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ai_service_config_id INTEGER NOT NULL,
  drama_id INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  group_id TEXT,
  asset_id TEXT,
  asset_url TEXT,
  status TEXT NOT NULL DEFAULT 'preparing',
  error_msg TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE(ai_service_config_id, source_kind, source_id, asset_type)
);

CREATE INDEX IF NOT EXISTS idx_toapis_private_avatar_assets_drama
  ON toapis_private_avatar_assets(drama_id, status);
