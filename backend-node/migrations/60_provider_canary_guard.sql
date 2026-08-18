ALTER TABLE ai_service_configs ADD COLUMN canary_paused INTEGER NOT NULL DEFAULT 0
  CHECK (canary_paused IN (0, 1));

CREATE TABLE IF NOT EXISTS provider_canary_runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  config_id INTEGER NOT NULL,
  logical_model_id TEXT NOT NULL,
  service_type TEXT NOT NULL,
  capability_fingerprint TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  cost_fingerprint TEXT NOT NULL,
  runtime_fingerprint TEXT NOT NULL,
  provider_scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'reserved',
    'submitting',
    'accepted',
    'verifying',
    'succeeded',
    'failed',
    'submission_unknown',
    'result_unknown',
    'artifact_unreadable',
    'budget_blocked'
  )),
  reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros >= 0),
  actual_cost_micros INTEGER CHECK (actual_cost_micros >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  budget_day TEXT NOT NULL CHECK (
    length(budget_day) = 10
    AND budget_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  budget_month TEXT NOT NULL CHECK (
    length(budget_month) = 7
    AND budget_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
  ),
  provider_task_id TEXT,
  artifact_path TEXT,
  artifact_sha256 TEXT,
  artifact_bytes INTEGER CHECK (artifact_bytes >= 0),
  error_category TEXT,
  safe_error_summary TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (id, config_id, capability_fingerprint),
  FOREIGN KEY (config_id) REFERENCES ai_service_configs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_canary_evidence (
  config_id INTEGER NOT NULL,
  service_type TEXT NOT NULL,
  capability_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'never_verified',
    'fresh',
    'stale',
    'failing',
    'submission_unknown',
    'budget_blocked',
    'disabled'
  )) CHECK (
    state <> 'fresh'
    OR (
      run_id IS NOT NULL
      AND verified_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > verified_at
    )
  ),
  run_id TEXT,
  config_fingerprint TEXT NOT NULL,
  cost_fingerprint TEXT NOT NULL,
  runtime_fingerprint TEXT NOT NULL,
  verified_at TEXT,
  expires_at TEXT,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (config_id, capability_fingerprint),
  FOREIGN KEY (config_id) REFERENCES ai_service_configs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, config_id, capability_fingerprint)
    REFERENCES provider_canary_runs(id, config_id, capability_fingerprint)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_zero_cost_checks (
  config_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'degraded', 'failed', 'disabled')),
  category TEXT,
  safe_summary TEXT,
  checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (config_id) REFERENCES ai_service_configs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_canary_runs_budget_day
  ON provider_canary_runs(budget_day, state);
CREATE INDEX IF NOT EXISTS idx_provider_canary_runs_budget_month
  ON provider_canary_runs(budget_month, state);
CREATE INDEX IF NOT EXISTS idx_provider_canary_runs_config_state
  ON provider_canary_runs(config_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_provider_canary_evidence_expiry
  ON provider_canary_evidence(expires_at);
CREATE INDEX IF NOT EXISTS idx_provider_canary_evidence_state
  ON provider_canary_evidence(state, updated_at);
