CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id TEXT PRIMARY KEY,
  available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  held INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  spent INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_reservations (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('held','confirmed','refunded')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('reserve','confirm','refund')),
  available_delta INTEGER NOT NULL,
  held_delta INTEGER NOT NULL,
  spent_delta INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (reservation_id, event_type)
);
