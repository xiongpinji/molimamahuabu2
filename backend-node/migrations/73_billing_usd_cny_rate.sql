ALTER TABLE billing_business_settings
  ADD COLUMN usd_cny_rate_micros INTEGER NOT NULL DEFAULT 7200000;
