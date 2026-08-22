CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_user
  ON tenant_members(user_id, status, tenant_id);

ALTER TABLE dramas ADD COLUMN tenant_id TEXT;
ALTER TABLE image_generations ADD COLUMN tenant_id TEXT;
ALTER TABLE video_generations ADD COLUMN tenant_id TEXT;
ALTER TABLE async_tasks ADD COLUMN tenant_id TEXT;
ALTER TABLE audit_events ADD COLUMN tenant_id TEXT;

CREATE INDEX IF NOT EXISTS idx_dramas_tenant_updated
  ON dramas(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_credit_accounts (
  tenant_id TEXT PRIMARY KEY,
  available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  held INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  spent INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_usage_reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  actor_user_id TEXT,
  model TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('held', 'confirmed', 'refunded')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, operation_key)
);

CREATE TABLE IF NOT EXISTS tenant_credit_ledger (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('reserve', 'confirm', 'refund')),
  available_delta INTEGER NOT NULL,
  held_delta INTEGER NOT NULL,
  spent_delta INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (reservation_id, event_type)
);

INSERT OR IGNORE INTO tenants
  (id, name, slug, status, created_by, created_at, updated_at)
SELECT
  'personal:' || id,
  COALESCE(NULLIF(substr(email, 1, instr(email, '@') - 1), ''), '个人') || ' 的空间',
  'personal-' || lower(hex(id)),
  'active',
  id,
  COALESCE(created_at, CURRENT_TIMESTAMP),
  COALESCE(updated_at, CURRENT_TIMESTAMP)
FROM platform_users;

INSERT OR IGNORE INTO tenant_members
  (tenant_id, user_id, role, status, created_at, updated_at)
SELECT
  'personal:' || id,
  id,
  'owner',
  'active',
  COALESCE(created_at, CURRENT_TIMESTAMP),
  COALESCE(updated_at, CURRENT_TIMESTAMP)
FROM platform_users;

UPDATE dramas
SET tenant_id = 'personal:' || user_id
WHERE tenant_id IS NULL AND user_id IS NOT NULL;

UPDATE image_generations
SET tenant_id = (
  SELECT dramas.tenant_id FROM dramas WHERE dramas.id = image_generations.drama_id
)
WHERE tenant_id IS NULL AND drama_id IS NOT NULL;

UPDATE video_generations
SET tenant_id = (
  SELECT dramas.tenant_id FROM dramas WHERE dramas.id = video_generations.drama_id
)
WHERE tenant_id IS NULL AND drama_id IS NOT NULL;

UPDATE async_tasks
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM image_generations WHERE image_generations.task_id = async_tasks.id LIMIT 1),
  (SELECT tenant_id FROM video_generations WHERE video_generations.task_id = async_tasks.id LIMIT 1),
  CASE WHEN user_id IS NOT NULL THEN 'personal:' || user_id END
)
WHERE tenant_id IS NULL;

UPDATE audit_events
SET tenant_id = 'personal:' || user_id
WHERE tenant_id IS NULL AND user_id IS NOT NULL;

INSERT OR IGNORE INTO tenant_credit_accounts
  (tenant_id, available, held, spent, updated_at)
SELECT
  'personal:' || user_id,
  available,
  held,
  spent,
  updated_at
FROM credit_accounts;

INSERT OR IGNORE INTO tenant_usage_reservations
  (id, tenant_id, operation_key, actor_user_id, model, resource_type, resource_id, amount, status, reason, created_at, updated_at)
SELECT
  id,
  'personal:' || user_id,
  operation_key,
  user_id,
  model,
  resource_type,
  resource_id,
  amount,
  status,
  reason,
  created_at,
  updated_at
FROM usage_reservations;

INSERT OR IGNORE INTO tenant_credit_ledger
  (id, reservation_id, tenant_id, actor_user_id, event_type, available_delta, held_delta, spent_delta, reason, created_at)
SELECT
  id,
  reservation_id,
  'personal:' || user_id,
  user_id,
  event_type,
  available_delta,
  held_delta,
  spent_delta,
  reason,
  created_at
FROM credit_ledger;
