CREATE TABLE IF NOT EXISTS model_resolution_prices (
  model TEXT NOT NULL COLLATE NOCASE,
  resolution TEXT NOT NULL CHECK (resolution IN ('480p', '720p')),
  credits INTEGER NOT NULL CHECK (credits > 0),
  cost_micros_per_second INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros_per_second >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (model, resolution)
);

ALTER TABLE generation_cost_records ADD COLUMN resolution TEXT;
