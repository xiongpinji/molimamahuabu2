ALTER TABLE provider_canary_runs ADD COLUMN reconcile_claim_token TEXT;

ALTER TABLE provider_canary_runs ADD COLUMN reconcile_lease_until TEXT;

ALTER TABLE provider_canary_runs ADD COLUMN reconcile_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_provider_canary_runs_reconcile_claim
  ON provider_canary_runs(state, reconcile_lease_until, reconcile_checked_at);
