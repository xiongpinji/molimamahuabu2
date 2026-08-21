ALTER TABLE video_generations ADD COLUMN reference_video_urls TEXT;

ALTER TABLE video_generations ADD COLUMN source_conditioning_json TEXT;

ALTER TABLE video_generations ADD COLUMN ai_service_config_id INTEGER;
