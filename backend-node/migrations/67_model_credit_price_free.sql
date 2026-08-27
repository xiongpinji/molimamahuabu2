ALTER TABLE model_credit_prices ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'paid';

CREATE TABLE IF NOT EXISTS __model_credit_prices_free_rebuild (
  model TEXT PRIMARY KEY,
  credits INTEGER NOT NULL CHECK (
    (pricing_mode = 'paid' AND credits > 0)
    OR (pricing_mode = 'free' AND credits = 0)
  ),
  pricing_mode TEXT NOT NULL DEFAULT 'paid' CHECK (pricing_mode IN ('paid', 'free')),
  display_name TEXT,
  public_note TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'enabled',
  billing_unit TEXT NOT NULL DEFAULT '',
  cost_unit TEXT NOT NULL DEFAULT 'request',
  cost_micros_per_unit INTEGER NOT NULL DEFAULT 0,
  input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0,
  output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT INTO __model_credit_prices_free_rebuild (
  model, credits, pricing_mode, display_name, public_note, category, status,
  billing_unit, cost_unit, cost_micros_per_unit, input_cost_micros_per_1k,
  output_cost_micros_per_1k, updated_at
)
SELECT
  model, credits, pricing_mode, display_name, public_note, category, status,
  billing_unit, cost_unit, cost_micros_per_unit, input_cost_micros_per_1k,
  output_cost_micros_per_1k, updated_at
FROM model_credit_prices;

DROP TABLE model_credit_prices;

ALTER TABLE __model_credit_prices_free_rebuild RENAME TO model_credit_prices;
