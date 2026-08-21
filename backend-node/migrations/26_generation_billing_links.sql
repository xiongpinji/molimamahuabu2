ALTER TABLE image_generations ADD COLUMN user_id TEXT;
ALTER TABLE image_generations ADD COLUMN credit_reservation_id TEXT;
ALTER TABLE video_generations ADD COLUMN user_id TEXT;
ALTER TABLE video_generations ADD COLUMN credit_reservation_id TEXT;
