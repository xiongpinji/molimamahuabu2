-- 公开平台工程归属：旧数据保持 NULL，不在公开模式下暴露。
ALTER TABLE dramas ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_dramas_user_updated ON dramas(user_id, updated_at DESC);
