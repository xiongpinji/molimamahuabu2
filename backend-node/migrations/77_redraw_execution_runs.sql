CREATE TABLE IF NOT EXISTS redraw_execution_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id,char(9,10,11,12,13,32))) > 0),
  user_id TEXT NOT NULL CHECK (length(trim(user_id,char(9,10,11,12,13,32))) > 0),
  work_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  queue_id INTEGER NOT NULL,
  review_id INTEGER NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('ready','running','waiting_review','paused','failed','needs_attention','stale','completed')),
  pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  output_parameters_json TEXT CHECK (output_parameters_json IS NULL OR CASE WHEN json_valid(output_parameters_json)
    THEN COALESCE(json_type(output_parameters_json) = 'object'
      AND json_type(output_parameters_json,'$.resolution') = 'text'
      AND json_type(output_parameters_json,'$.aspect_ratio') = 'text'
      AND length(trim(json_extract(output_parameters_json,'$.resolution'))) > 0
      AND length(trim(json_extract(output_parameters_json,'$.aspect_ratio'))) > 0
      AND json_remove(output_parameters_json,'$.resolution','$.aspect_ratio') = '{}',0)
    ELSE 0 END),
  output_parameters_hash TEXT CHECK (output_parameters_hash IS NULL OR (length(output_parameters_hash) = 64 AND output_parameters_hash NOT GLOB '*[^a-f0-9]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((output_parameters_json IS NULL AND output_parameters_hash IS NULL)
    OR (output_parameters_json IS NOT NULL AND output_parameters_hash IS NOT NULL)),
  UNIQUE(tenant_id,user_id,queue_id),
  FOREIGN KEY(work_id) REFERENCES redraw_works(id),
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id),
  FOREIGN KEY(queue_id) REFERENCES redraw_execution_queues(id),
  FOREIGN KEY(review_id) REFERENCES redraw_execution_plan_reviews(id)
);

CREATE TABLE IF NOT EXISTS redraw_execution_unit_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  queue_unit_id INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no = 1),
  unit_hash TEXT NOT NULL CHECK (length(unit_hash) = 64 AND unit_hash NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('claimed','submitting','running','waiting_review','approved','rejected','failed','needs_attention')),
  claim_token TEXT NOT NULL CHECK (length(trim(claim_token)) > 0),
  readiness_hash TEXT NOT NULL CHECK (length(readiness_hash) = 64 AND readiness_hash NOT GLOB '*[^a-f0-9]*'),
  quote_hash TEXT NOT NULL CHECK (length(quote_hash) = 64 AND quote_hash NOT GLOB '*[^a-f0-9]*'),
  quoted_amount INTEGER NOT NULL CHECK (typeof(quoted_amount) = 'integer' AND quoted_amount BETWEEN 0 AND 9007199254740991),
  billing_mode TEXT NOT NULL CHECK (billing_mode IN ('paid','no_charge')),
  request_hash TEXT CHECK (request_hash IS NULL OR (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*')),
  task_id TEXT CHECK (task_id IS NULL OR length(trim(task_id)) > 0),
  reservation_id TEXT CHECK (reservation_id IS NULL OR length(trim(reservation_id)) > 0),
  provider_task_id TEXT CHECK (provider_task_id IS NULL OR length(trim(provider_task_id)) > 0),
  output_asset_id INTEGER CHECK (output_asset_id IS NULL OR (typeof(output_asset_id) = 'integer' AND output_asset_id > 0)),
  output_sha256 TEXT CHECK (output_sha256 IS NULL OR (length(output_sha256) = 64 AND output_sha256 NOT GLOB '*[^a-f0-9]*')),
  candidate_hash TEXT CHECK (candidate_hash IS NULL OR (length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^a-f0-9]*')),
  quality_json TEXT CHECK (quality_json IS NULL OR json_valid(quality_json)),
  approved_by TEXT,
  approved_at TEXT,
  submit_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((billing_mode = 'no_charge' AND quoted_amount = 0 AND reservation_id IS NULL)
    OR (billing_mode = 'paid' AND quoted_amount > 0)),
  UNIQUE(run_id,queue_unit_id,attempt_no),
  UNIQUE(task_id),
  UNIQUE(reservation_id),
  FOREIGN KEY(run_id) REFERENCES redraw_execution_runs(id),
  FOREIGN KEY(queue_unit_id) REFERENCES redraw_execution_queue_units(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_redraw_execution_unit_attempts_active_run
  ON redraw_execution_unit_attempts(run_id) WHERE status IN ('claimed','submitting','running');
