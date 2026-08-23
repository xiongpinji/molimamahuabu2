CREATE TABLE IF NOT EXISTS billing_reconciliation_events (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL,
  tenant_id TEXT,
  user_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('refund')),
  previous_status TEXT NOT NULL,
  result_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  safety_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_reconciliation_created
  ON billing_reconciliation_events(created_at DESC);
