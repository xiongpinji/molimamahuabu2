CREATE TABLE IF NOT EXISTS redraw_candidate_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version_id INTEGER NOT NULL,
  shot_id INTEGER NOT NULL,
  video_generation_id INTEGER NOT NULL,
  candidate_sha256 TEXT NOT NULL,
  dependency_hash TEXT NOT NULL,
  review_version INTEGER NOT NULL CHECK (review_version > 0),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'needs_review')),
  decision_source TEXT NOT NULL CHECK (decision_source IN ('automatic', 'human')),
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  reviewer_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id),
  FOREIGN KEY(shot_id) REFERENCES redraw_shots(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_candidate_review_version
  ON redraw_candidate_reviews(tenant_id, user_id, shot_id, video_generation_id, review_version);

ALTER TABLE redraw_shots ADD COLUMN approved_candidate_review_id INTEGER;

ALTER TABLE redraw_exports ADD COLUMN release_hash TEXT;

ALTER TABLE redraw_exports ADD COLUMN quality_summary_json TEXT NOT NULL DEFAULT '{}';

CREATE TRIGGER IF NOT EXISTS redraw_candidate_reviews_immutable_update
BEFORE UPDATE ON redraw_candidate_reviews
BEGIN
  SELECT RAISE(ABORT, 'redraw candidate reviews are immutable');
END;

CREATE TRIGGER IF NOT EXISTS redraw_candidate_reviews_immutable_delete
BEFORE DELETE ON redraw_candidate_reviews
BEGIN
  SELECT RAISE(ABORT, 'redraw candidate reviews are immutable');
END;
