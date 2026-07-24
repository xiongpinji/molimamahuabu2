ALTER TABLE redeem_codes ADD COLUMN tenant_id TEXT;

CREATE INDEX IF NOT EXISTS idx_redeem_codes_tenant_created
  ON redeem_codes(tenant_id, created_at DESC);
