ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE ai_service_configs ADD COLUMN verified_capabilities TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_service_configs ADD COLUMN verified_at TEXT;
ALTER TABLE ai_service_configs ADD COLUMN verification_error TEXT;
ALTER TABLE model_credit_prices ADD COLUMN public_note TEXT;
