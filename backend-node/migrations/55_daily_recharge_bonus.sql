ALTER TABLE recharge_packages ADD COLUMN daily_bonus_credits INTEGER NOT NULL DEFAULT 0 CHECK (daily_bonus_credits >= 0);
ALTER TABLE recharge_packages ADD COLUMN benefit_version TEXT NOT NULL DEFAULT 'legacy_once';

ALTER TABLE tenant_recharge_orders ADD COLUMN base_credits INTEGER;
ALTER TABLE tenant_recharge_orders ADD COLUMN daily_bonus_credits INTEGER NOT NULL DEFAULT 0 CHECK (daily_bonus_credits >= 0);
ALTER TABLE tenant_recharge_orders ADD COLUMN benefit_days INTEGER NOT NULL DEFAULT 0 CHECK (benefit_days >= 0);
ALTER TABLE tenant_recharge_orders ADD COLUMN benefit_version TEXT NOT NULL DEFAULT 'legacy_once';

CREATE TABLE IF NOT EXISTS tenant_recharge_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  recharge_order_id TEXT NOT NULL UNIQUE,
  package_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  daily_bonus_credits INTEGER NOT NULL CHECK (daily_bonus_credits >= 0),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_active_recharge_membership
  ON tenant_recharge_memberships(tenant_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS tenant_daily_bonus_buckets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  benefit_date TEXT NOT NULL,
  granted INTEGER NOT NULL CHECK (granted >= 0),
  available INTEGER NOT NULL CHECK (available >= 0),
  held INTEGER NOT NULL CHECK (held >= 0),
  spent INTEGER NOT NULL CHECK (spent >= 0),
  expired INTEGER NOT NULL CHECK (expired >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (membership_id, benefit_date)
);

CREATE INDEX IF NOT EXISTS idx_tenant_daily_bonus_buckets_tenant_date
  ON tenant_daily_bonus_buckets(tenant_id, benefit_date);

CREATE TABLE IF NOT EXISTS tenant_usage_reservation_allocations (
  reservation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bonus_bucket_id TEXT,
  bonus_amount INTEGER NOT NULL CHECK (bonus_amount >= 0),
  permanent_amount INTEGER NOT NULL CHECK (permanent_amount >= 0),
  created_at TEXT NOT NULL,
  CHECK (bonus_amount + permanent_amount > 0)
);

UPDATE recharge_packages
SET daily_bonus_credits = CASE
      WHEN credits > amount_cents THEN credits - amount_cents
      ELSE 0
    END,
    benefit_version = 'daily_30d_v1'
WHERE benefit_version = 'legacy_once';

UPDATE recharge_packages
SET credits = amount_cents
WHERE benefit_version = 'daily_30d_v1';

UPDATE tenant_recharge_orders
SET base_credits = credits
WHERE base_credits IS NULL;

