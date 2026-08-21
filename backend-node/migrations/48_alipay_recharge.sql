CREATE TABLE IF NOT EXISTS recharge_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  credits INTEGER NOT NULL CHECK (credits > 0),
  starts_at TEXT,
  ends_at TEXT,
  image_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_recharge_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  client_order_key TEXT NOT NULL,
  out_trade_no TEXT NOT NULL UNIQUE,
  order_kind TEXT NOT NULL CHECK (order_kind IN ('custom', 'package')),
  package_id TEXT,
  package_name TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  credits INTEGER NOT NULL CHECK (credits > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  alipay_trade_no TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  UNIQUE (tenant_id, created_by, client_order_key)
);

CREATE INDEX IF NOT EXISTS idx_recharge_orders_user_created
  ON tenant_recharge_orders(tenant_id, created_by, created_at DESC);
