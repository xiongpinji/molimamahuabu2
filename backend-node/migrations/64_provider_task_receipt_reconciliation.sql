ALTER TABLE generation_route_attempts ADD COLUMN config_fingerprint TEXT;
ALTER TABLE generation_route_attempts ADD COLUMN query_protocol TEXT;
ALTER TABLE generation_route_attempts ADD COLUMN reconcile_claim_token TEXT;
ALTER TABLE generation_route_attempts ADD COLUMN reconcile_lease_until TEXT;
ALTER TABLE generation_route_attempts ADD COLUMN reconcile_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_generation_route_attempts_reconcile
  ON generation_route_attempts(request_id, state, reconcile_lease_until);

CREATE TRIGGER IF NOT EXISTS generation_route_attempts_receipt_identity_immutable
BEFORE UPDATE OF config_id, provider, upstream_model, config_fingerprint, query_protocol
ON generation_route_attempts
WHEN OLD.config_id IS NOT NEW.config_id
  OR OLD.provider IS NOT NEW.provider
  OR OLD.upstream_model IS NOT NEW.upstream_model
  OR OLD.config_fingerprint IS NOT NEW.config_fingerprint
  OR OLD.query_protocol IS NOT NEW.query_protocol
BEGIN
  SELECT RAISE(ABORT, 'provider receipt identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS generation_route_attempts_provider_task_id_insert_null
BEFORE INSERT ON generation_route_attempts
WHEN NEW.provider_task_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'provider task id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS generation_route_attempts_provider_task_id_immutable
BEFORE UPDATE OF provider_task_id ON generation_route_attempts
WHEN NEW.provider_task_id IS NULL
  OR trim(NEW.provider_task_id,
    char(9) || char(10) || char(11) || char(12) || char(13) || ' ') = ''
  OR (OLD.provider_task_id IS NOT NULL
    AND OLD.provider_task_id IS NOT NEW.provider_task_id)
BEGIN
  SELECT RAISE(ABORT, 'provider task id is immutable');
END;
