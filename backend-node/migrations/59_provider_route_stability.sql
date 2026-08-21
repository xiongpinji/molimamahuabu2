ALTER TABLE ai_service_configs ADD COLUMN logical_model_id TEXT;
ALTER TABLE ai_service_configs ADD COLUMN failover_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE ai_service_configs ADD COLUMN verified_at TEXT;
ALTER TABLE ai_service_configs ADD COLUMN verification_evidence TEXT;
ALTER TABLE video_generations ADD COLUMN config_id INTEGER;

CREATE TABLE IF NOT EXISTS generation_route_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  service_type TEXT NOT NULL,
  business_type TEXT NOT NULL,
  business_id TEXT,
  tenant_id TEXT,
  user_id TEXT,
  logical_model_id TEXT NOT NULL,
  capability_fingerprint TEXT NOT NULL,
  user_price_snapshot TEXT,
  candidate_config_ids TEXT NOT NULL,
  state TEXT NOT NULL,
  credit_reservation_id TEXT,
  final_config_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_route_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  config_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  state TEXT NOT NULL,
  provider_task_id TEXT,
  http_status INTEGER,
  error_category TEXT,
  safe_error_summary TEXT,
  provider_cost_snapshot TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(request_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS provider_route_health (
  config_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'healthy',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  open_until TEXT,
  half_open_claimed_at TEXT,
  last_error_category TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_stability_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,
  event_type TEXT NOT NULL,
  request_id TEXT,
  tenant_id TEXT,
  user_ref TEXT,
  logical_model_id TEXT,
  config_id INTEGER,
  target_config_id INTEGER,
  task_state TEXT,
  credit_state TEXT,
  safe_details TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_route_requests_state
  ON generation_route_requests(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_generation_route_attempts_provider_task
  ON generation_route_attempts(provider_task_id);
CREATE INDEX IF NOT EXISTS idx_provider_stability_events_created
  ON provider_stability_events(created_at);
