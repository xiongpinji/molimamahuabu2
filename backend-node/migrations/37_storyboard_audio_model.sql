-- 保存画布分镜级 TTS 模型，空值表示跟随项目或 AI 配置默认模型。
ALTER TABLE storyboards ADD COLUMN audio_model TEXT;
