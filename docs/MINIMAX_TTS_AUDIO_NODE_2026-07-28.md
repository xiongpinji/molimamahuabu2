# MiniMax TTS 音频节点闭环

## 范围

本阶段只接入 MiniMax 文本转语音（T2A），不包含音乐生成。

## 成功标准

1. MiniMax 密钥、Base URL 与默认模型继续由管理员 AI 配置管理，前端和源码不保存密钥。
2. 画布音频节点支持音色、语速、音量、音调、情绪和多音字配置。
3. 请求通过现有 `/audio/extract` 生成链路，沿用模型选择、积分预留、结算、退款、失败写回和音频结果回写。
4. MiniMax 请求符合官方 `POST /v1/t2a_v2` 契约，音频以 hex 返回并保存为 MP3。
5. 后端回归测试、前端节点请求测试和前端构建全部通过。

## 非目标

- 不新增音乐生成接口。
- 不在用户前端暴露 API 密钥。
- 不重构现有 OpenAI 兼容 TTS 或计费模块。

## MiniMax 字段映射

| 画布字段 | MiniMax 请求字段 |
| --- | --- |
| 音色 | `voice_setting.voice_id` |
| 语速 | `voice_setting.speed` |
| 音量 | `voice_setting.vol` |
| 音调 | `voice_setting.pitch` |
| 情绪 | `voice_setting.emotion` |
| 多音字 | `pronunciation_dict.tone` |
