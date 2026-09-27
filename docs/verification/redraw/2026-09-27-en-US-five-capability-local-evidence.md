# 2026-09-27 en-US/US 五类能力真实生成证据（本地）

**授权**：用户在会话中选择方案 2：text、subtitles、character_image、clean_plate_image、video 各真实生成一次；音频（tts / native_dialogue_audio）另开一轮。
**范围**：本机 AppData 数据库（`DATABASE_PATH`），不涉及生产库和生产存储。
**工具**：`backend-node/scripts/run-redraw-locale-capability-evidence.js`（默认 dry-run；付费执行需要 `--commit --confirm=AUTHORIZE_REDRAW_LOCALE_CAPABILITY_EVIDENCE`）。
**载体**：config `#22` 的 `settings.redraw_locale_capabilities[]` 中 `locale=en-US, market=US` 条目。

## 证据（不含密钥和供应商 URL）

| 能力 | config | 模型 | task_id | artifact | 大小 | 说明 |
|---|---|---|---|---|---|---|
| text | #22 | gpt-5.6-sol | `resp_07c051d0…d5dd64` | #30 | 26 B | "Who the hell are you, bro?" |
| subtitles | #22 | gpt-5.6-sol | `resp_031d3dbd…f6dda0f5` | #31 | 28 B | "I won't let you leave again." |
| character_image | #26 | token6688-gpt-image-2 | `img-character_image-1790516767658` | #32 | 227,714 B | 1024² PNG |
| clean_plate_image | #26 | token6688-gpt-image-2 | `img-clean_plate_image-1790516797604` | #33 | 303,644 B | 1024² PNG |
| video | #27 | seedance-2-mini | `tsk_vid_01M3HHYXKYHCE9X8HWJW01C15A` | #34 | 982,883 B | ffprobe：4.04 s，496×864，无音轨 |

每个 artifact 都登记了 sha256（写在 asset metadata 和 evidence 的 `artifact_sha256` 字段），并通过了 `validateGenerationEvidence`，回读使用后端同一个 `createAssetReader`。

## 执行记录

- 首轮执行时，四类图文能力完成；视频任务在供应商侧已经完成，但下载时出现 `fetch failed`。
- 第二轮用 `--resume-video-task` 只重新查询并下载同一个任务，**没有重新提交，视频只计费一次**。
- 两轮都没有写回能力记录：脚本里的存储根目录是工作树中的目录联接路径，`createAssetReader` 做 realpath 比较时判定产物不在存储根之内。
  - 已修复：脚本改为使用 realpath 后的存储根。
  - 修复前的这一次，用同一套 `validateGenerationEvidence` 加真实存储根，对已落盘的 5 个产物逐项校验通过后，才写入 en-US/US 条目。
- 写库前两次备份：`drama_generator.before-locale-evidence-en-US-*.bak`。

## 结果

- `GET /api/v1/redraw/locales`：en-US/US 的 `status` 为 `subtitle_only`，`blocking=["tts","native_dialogue_audio"]`。其余五类已不再阻塞。
- 作品 #5：分析人工确认后，`POST /redraw/works/5/localization-quote` 返回 `priced=true`、10 积分、模型 gpt-5.6-sol。

## 未做

- 音频能力（tts / native_dialogue_audio）：按授权另开一轮处理。
- 本地化启动（`createVersion`）：会产生一次 gpt-5.6-sol 付费调用，尚未执行。
