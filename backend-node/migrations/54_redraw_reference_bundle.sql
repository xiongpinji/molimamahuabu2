ALTER TABLE redraw_versions ADD COLUMN reference_bundle_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE redraw_shots ADD COLUMN reference_bundle_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE redraw_shots ADD COLUMN reference_bundle_hash TEXT;
ALTER TABLE redraw_shots ADD COLUMN reference_bundle_updated_at TEXT;
