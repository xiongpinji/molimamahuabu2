ALTER TABLE model_credit_prices ADD COLUMN display_name TEXT;
ALTER TABLE model_credit_prices ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE model_credit_prices ADD COLUMN status TEXT NOT NULL DEFAULT 'enabled';

CREATE TABLE IF NOT EXISTS redeem_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  label TEXT,
  credits INTEGER NOT NULL CHECK (credits > 0),
  max_redemptions INTEGER NOT NULL CHECK (max_redemptions > 0),
  redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redeem_code_usages (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  redeemed_at TEXT NOT NULL,
  UNIQUE (code_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS tenant_credit_adjustments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('redeem', 'admin_adjust')),
  amount INTEGER NOT NULL CHECK (amount != 0),
  reason TEXT NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, reference_type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_credit_adjustments_tenant_created
  ON tenant_credit_adjustments(tenant_id, created_at DESC);
