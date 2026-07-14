CREATE TABLE IF NOT EXISTS model_credit_prices (
  model TEXT PRIMARY KEY,
  credits INTEGER NOT NULL CHECK (credits > 0),
  updated_at TEXT NOT NULL
);
