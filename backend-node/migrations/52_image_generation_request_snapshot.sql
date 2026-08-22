ALTER TABLE image_generations ADD COLUMN resolution TEXT;
ALTER TABLE image_generations ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE image_generations ADD COLUMN request_snapshot TEXT;
ALTER TABLE image_generations ADD COLUMN result_images TEXT;
