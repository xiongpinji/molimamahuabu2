CREATE TABLE IF NOT EXISTS provider_route_model_costs (
  config_id INTEGER NOT NULL,
  model TEXT NOT NULL COLLATE NOCASE,
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  cost_unit TEXT NOT NULL CHECK (cost_unit IN ('request', 'image', 'second', 'character', 'token')),
  micros_per_unit INTEGER NOT NULL DEFAULT 0 CHECK (micros_per_unit >= 0),
  input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0 CHECK (input_cost_micros_per_1k >= 0),
  output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0 CHECK (output_cost_micros_per_1k >= 0),
  resolution_prices_json TEXT NOT NULL DEFAULT '{}',
  source_currency TEXT NOT NULL DEFAULT 'USD' CHECK (source_currency IN ('USD', 'CNY')),
  source_price_json TEXT NOT NULL DEFAULT '{}',
  source_url TEXT,
  source_fetched_at TEXT,
  source_fingerprint TEXT,
  source_exchange_rate REAL,
  cost_source TEXT NOT NULL DEFAULT 'manual' CHECK (cost_source IN ('manual', 'relay_auto')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (config_id, model),
  FOREIGN KEY (config_id) REFERENCES ai_service_configs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_route_model_costs_model
  ON provider_route_model_costs(model COLLATE NOCASE);
