CREATE TABLE IF NOT EXISTS model_image_resolution_prices (
  model TEXT NOT NULL COLLATE NOCASE,
  resolution TEXT NOT NULL CHECK (resolution IN ('1k', '2k', '4k')),
  credits INTEGER NOT NULL CHECK (credits > 0),
  cost_micros_per_unit INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros_per_unit >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (model, resolution)
);
