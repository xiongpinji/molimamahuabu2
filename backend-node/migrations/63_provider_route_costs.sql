CREATE TABLE IF NOT EXISTS provider_route_costs (
  config_id INTEGER PRIMARY KEY,
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  cost_unit TEXT NOT NULL CHECK (cost_unit IN ('request', 'image', 'second', 'token')),
  micros_per_unit INTEGER NOT NULL DEFAULT 0 CHECK (micros_per_unit >= 0),
  input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0 CHECK (input_cost_micros_per_1k >= 0),
  output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0 CHECK (output_cost_micros_per_1k >= 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (config_id) REFERENCES ai_service_configs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_route_resolution_costs (
  config_id INTEGER NOT NULL,
  resolution TEXT NOT NULL COLLATE NOCASE CHECK (length(resolution) BETWEEN 1 AND 32),
  micros_per_unit INTEGER NOT NULL CHECK (micros_per_unit > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (config_id, resolution),
  FOREIGN KEY (config_id) REFERENCES ai_service_configs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_route_resolution_costs_config
  ON provider_route_resolution_costs(config_id, resolution);

ALTER TABLE generation_cost_records ADD COLUMN config_id INTEGER;
ALTER TABLE generation_cost_records ADD COLUMN cost_snapshot_json TEXT;
ALTER TABLE generation_cost_records ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'unavailable';
