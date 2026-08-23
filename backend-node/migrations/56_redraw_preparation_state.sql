ALTER TABLE redraw_shots ADD COLUMN preparation_state TEXT NOT NULL DEFAULT 'parsed' CHECK (preparation_state IN ('parsed', 'localized', 'identity_bound', 'clean_ready', 'reference_ready', 'needs_review', 'needs_attention', 'failed', 'stale'));
ALTER TABLE redraw_shots ADD COLUMN preparation_version INTEGER NOT NULL DEFAULT 1 CHECK (preparation_version > 0);
ALTER TABLE redraw_shots ADD COLUMN preparation_evidence_hash TEXT;
ALTER TABLE redraw_shots ADD COLUMN preparation_snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE redraw_shots ADD COLUMN stale_reason_code TEXT;
