-- 在分镜生成时记录当前角色音色快照，后续视频重试/批量生成复用同一份参考音频。
ALTER TABLE storyboards ADD COLUMN voice_snapshot TEXT;
