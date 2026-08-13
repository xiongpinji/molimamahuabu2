-- 保留旧的单值字段用于兼容历史任务，同时为多参考视频/音频保存完整数组。
ALTER TABLE video_generations ADD COLUMN reference_video_urls TEXT;
ALTER TABLE video_generations ADD COLUMN reference_audio_urls TEXT;
