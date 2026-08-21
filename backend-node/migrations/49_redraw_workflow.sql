CREATE TABLE IF NOT EXISTS redraw_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  default_locale TEXT NOT NULL DEFAULT 'en-US',
  default_market TEXT NOT NULL DEFAULT '',
  localization_level TEXT NOT NULL DEFAULT 'faithful',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_redraw_projects_owner
  ON redraw_projects(tenant_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS redraw_style_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  user_id TEXT,
  stable_key TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('anime_2d', 'anime_3d', 'live_action', 'free')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  prompt_template TEXT NOT NULL DEFAULT '',
  negative_prompt_template TEXT NOT NULL DEFAULT '',
  preview_asset_id INTEGER,
  compatible_models_json TEXT NOT NULL DEFAULT '[]',
  supported_ratios_json TEXT NOT NULL DEFAULT '[]',
  verification_evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_style_version
  ON redraw_style_presets(stable_key, version);

CREATE INDEX IF NOT EXISTS idx_redraw_style_catalog
  ON redraw_style_presets(category, status, sort_order);

CREATE TABLE IF NOT EXISTS redraw_works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_asset_id INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 12000 AND 3600000),
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 4),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'analyzing', 'asset_review', 'ready_to_generate', 'generating', 'composing', 'completed', 'failed', 'needs_attention', 'needs_review', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(project_id) REFERENCES redraw_projects(id)
);

DROP INDEX IF EXISTS uq_redraw_work_source;

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_work_source
  ON redraw_works(tenant_id, user_id, source_fingerprint) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_redraw_work_owner
  ON redraw_works(tenant_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS redraw_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  tenant_id TEXT,
  user_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  locale TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT '',
  localization_level TEXT NOT NULL DEFAULT 'faithful',
  source_facts_json TEXT,
  glossary_json TEXT NOT NULL DEFAULT '{}',
  name_map_json TEXT NOT NULL DEFAULT '{}',
  culture_map_json TEXT NOT NULL DEFAULT '{}',
  text_map_json TEXT NOT NULL DEFAULT '{}',
  style_snapshot_json TEXT NOT NULL DEFAULT '{}',
  capability_snapshot_json TEXT NOT NULL DEFAULT '{}',
  facts_hash TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'analyzing', 'asset_review', 'ready_to_generate', 'generating', 'composing', 'completed', 'failed', 'needs_attention', 'needs_review', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(work_id) REFERENCES redraw_works(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_version_number
  ON redraw_versions(work_id, version);

CREATE INDEX IF NOT EXISTS idx_redraw_version_work
  ON redraw_versions(work_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS redraw_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  tenant_id TEXT,
  user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'scene', 'prop', 'voice')),
  source_ref_json TEXT NOT NULL DEFAULT '{}',
  localized_name TEXT NOT NULL DEFAULT '',
  localized_description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  asset_id INTEGER,
  voice_asset_id INTEGER,
  clean_plate_asset_id INTEGER,
  mask_asset_id INTEGER,
  generation_task_id TEXT,
  version_number INTEGER NOT NULL DEFAULT 1 CHECK (version_number > 0),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approved_by TEXT,
  approved_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'processing', 'generated', 'failed', 'needs_attention')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_redraw_assets_version
  ON redraw_assets(version_id, kind, approval_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS redraw_shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  tenant_id TEXT,
  user_id TEXT,
  batch_index INTEGER NOT NULL CHECK (batch_index > 0),
  shot_index INTEGER NOT NULL CHECK (shot_index > 0),
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  source_dialogue_json TEXT NOT NULL DEFAULT '[]',
  localized_dialogue_json TEXT NOT NULL DEFAULT '[]',
  references_json TEXT NOT NULL DEFAULT '[]',
  opening_state TEXT NOT NULL DEFAULT '',
  continuous_action TEXT NOT NULL DEFAULT '',
  ending_state TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  compiled_prompt_json TEXT NOT NULL DEFAULT '{}',
  video_generation_id INTEGER,
  audio_asset_id INTEGER,
  subtitle_asset_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'processing', 'completed', 'failed', 'needs_attention')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_shot_order
  ON redraw_shots(version_id, batch_index, shot_index);

CREATE INDEX IF NOT EXISTS idx_redraw_shots_version
  ON redraw_shots(version_id, status, batch_index, shot_index);

CREATE TABLE IF NOT EXISTS redraw_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  tenant_id TEXT,
  user_id TEXT,
  export_type TEXT NOT NULL CHECK (export_type IN ('video', 'subtitle_srt', 'subtitle_vtt', 'jianying', 'factory_import', 'project_archive')),
  video_merge_id INTEGER,
  asset_id INTEGER,
  subtitle_asset_id INTEGER,
  project_asset_id INTEGER,
  version_number INTEGER NOT NULL DEFAULT 1 CHECK (version_number > 0),
  manifest_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'needs_attention')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_redraw_exports_version
  ON redraw_exports(version_id, export_type, version_number DESC);

INSERT OR IGNORE INTO redraw_style_presets
  (stable_key, name, category, sort_order, version, verification_evidence_json, status, created_at, updated_at)
VALUES
  ('redraw-live-action-style-001', '默认风格', 'live_action', 1, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-002', '古典武侠风', 'live_action', 2, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-003', '宫斗权谋冷峻风格', 'live_action', 3, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-004', '国产悬疑冷调', 'live_action', 4, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-005', '古偶唯美柔光', 'live_action', 5, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-006', '国产都市写实', 'live_action', 6, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-007', '武侠江湖写实摄影风格', 'live_action', 7, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-008', '90 年代中国农村电影风格', 'live_action', 8, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-009', '中式暖调蓝辉风格', 'live_action', 9, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-010', '90 年代港片风格', 'live_action', 10, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-011', '日式青春胶片', 'live_action', 11, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-012', '日式生活自然', 'live_action', 12, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-013', '日本黑白胶片摄影风格', 'live_action', 13, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-014', '韩剧都市柔光', 'live_action', 14, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-015', '韩国冷淡风电影风格', 'live_action', 15, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-016', '复古科幻原子朋克', 'live_action', 16, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-017', '90 年代写实电影风格', 'live_action', 17, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-018', '复古叙事电影风格', 'live_action', 18, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-019', '美式复古好莱坞', 'live_action', 19, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-020', '老式工业影视风格', 'live_action', 20, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-021', '复古战争电影风格', 'live_action', 21, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-022', '复古电影摄影风格', 'live_action', 22, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-023', '美式复古怪异影视风格', 'live_action', 23, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-024', '美式经济上行风格', 'live_action', 24, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-025', '美式复古影视风格', 'live_action', 25, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-026', '好莱坞黑白电影风格', 'live_action', 26, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-027', '霓虹赛博电影风格', 'live_action', 27, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-028', '荒野电影风格', 'live_action', 28, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-029', '橙黄色电影风格', 'live_action', 29, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-030', '恐怖电影风格', 'live_action', 30, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-031', '荒诞高调白色色调电影风格', 'live_action', 31, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-032', '蓝橙色调影视风格', 'live_action', 32, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-033', '工业电影风格', 'live_action', 33, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-034', '科技感电影风格', 'live_action', 34, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-035', '悬疑电影风格', 'live_action', 35, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-036', '希腊神话电影风格', 'live_action', 36, 1, '{}', 'draft', datetime('now'), datetime('now')),
  ('redraw-live-action-style-037', '紫色色调电影风格', 'live_action', 37, 1, '{}', 'draft', datetime('now'), datetime('now'));
