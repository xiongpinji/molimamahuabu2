CREATE INDEX IF NOT EXISTS idx_provider_canary_runs_admin_page
  ON provider_canary_runs(updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_provider_canary_runs_admin_state_page
  ON provider_canary_runs(state, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_provider_canary_runs_admin_model_page
  ON provider_canary_runs(logical_model_id COLLATE NOCASE, updated_at DESC, id DESC);
