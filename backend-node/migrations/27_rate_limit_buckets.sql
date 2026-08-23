CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
