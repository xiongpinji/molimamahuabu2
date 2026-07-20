-- 保存画布分镜级图像模型与分镜图版式，供画布恢复后继续使用。
ALTER TABLE storyboards ADD COLUMN image_model TEXT;
ALTER TABLE storyboards ADD COLUMN grid_frame_type TEXT NOT NULL DEFAULT 'single';
