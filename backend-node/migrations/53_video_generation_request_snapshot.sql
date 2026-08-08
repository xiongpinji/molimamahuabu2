ALTER TABLE video_generations ADD COLUMN reference_mode TEXT;
ALTER TABLE video_generations ADD COLUMN generate_audio INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_generations ADD COLUMN reference_video_urls TEXT;
ALTER TABLE video_generations ADD COLUMN reference_audio_urls TEXT;
ALTER TABLE video_generations ADD COLUMN request_snapshot TEXT;
