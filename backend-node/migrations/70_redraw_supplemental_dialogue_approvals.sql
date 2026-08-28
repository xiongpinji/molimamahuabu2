CREATE TABLE IF NOT EXISTS redraw_supplemental_dialogue_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_version TEXT NOT NULL
    CHECK (contract_version = 'redraw-supplemental-dialogue-approval-v1'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  work_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  redraw_shot_id INTEGER NOT NULL,
  shot_id TEXT NOT NULL,
  voice_redraw_asset_id INTEGER NOT NULL,
  source_character_key TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  target_market TEXT NOT NULL DEFAULT '',
  target_text TEXT NOT NULL,
  target_text_sha256 TEXT NOT NULL,
  source_translation INTEGER NOT NULL CHECK (source_translation = 0),
  localization_task_id TEXT NOT NULL,
  localization_decision_sha256 TEXT NOT NULL,
  facts_hash TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  dialogue_context_sha256 TEXT NOT NULL,
  approval_evidence_sha256 TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  approval_source TEXT NOT NULL CHECK (approval_source = 'owner_http'),
  approval_decision TEXT NOT NULL CHECK (approval_decision = 'approved'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revocation_idempotency_hash TEXT,
  revocation_request_hash TEXT,
  revoked_by TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(work_id) REFERENCES redraw_works(id),
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id),
  FOREIGN KEY(redraw_shot_id) REFERENCES redraw_shots(id),
  FOREIGN KEY(voice_redraw_asset_id) REFERENCES redraw_assets(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_supplemental_dialogue_idempotency
  ON redraw_supplemental_dialogue_approvals(tenant_id, user_id, version_id, idempotency_hash)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_supplemental_dialogue_active_scope
  ON redraw_supplemental_dialogue_approvals
    (tenant_id, user_id, version_id, redraw_shot_id, voice_redraw_asset_id, source_character_key)
  WHERE status = 'active' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_redraw_supplemental_dialogue_voice
  ON redraw_supplemental_dialogue_approvals
    (tenant_id, user_id, version_id, voice_redraw_asset_id, status, redraw_shot_id);

CREATE TRIGGER IF NOT EXISTS redraw_supplemental_dialogue_no_reactivate
BEFORE UPDATE OF status ON redraw_supplemental_dialogue_approvals
WHEN OLD.status = 'revoked' AND NEW.status <> 'revoked'
BEGIN
  SELECT RAISE(ABORT, 'revoked supplemental dialogue approval cannot reactivate');
END;

ALTER TABLE redraw_local_voice_registrations
  ADD COLUMN approved_dialogue_evidence_sha256 TEXT;

ALTER TABLE redraw_local_voice_registrations
  ADD COLUMN supplemental_approval_ids_json TEXT NOT NULL DEFAULT '[]';
