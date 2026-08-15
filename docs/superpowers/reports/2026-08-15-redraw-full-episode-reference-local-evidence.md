# 整集短剧参考包本地主线验收证据

日期：2026-08-15

证据等级：本地真实源片预处理与 fail-closed 门禁验证
结论：**九个镜头均为 `blocked`，当前不可生成；本报告不证明外国人物视觉替换、口型同步或整集 1:1 复刻已经完成。**

## 验收范围与边界

本次只验证用户指定的 68.733 秒源片能否进入逐镜参考包主线，并在人物、身份包、中文字幕净景和运动参考尚未完成审核时稳定拒绝生成。运行未读取 Key，未构造供应商请求，未调用供应商，未产生付费，未部署，未 SSH，未写生产数据库，也未开放线上入口。

本次运行 cwd 为 `backend-node`。案例 JSON 位于独立的仓库外证据目录；最终运行产物位于仓库外目录 `full-episode-reference-20260815-run1`。报告只记录 basename、相对证据文件和哈希，不记录本机绝对路径。

## 案例清单生成方式

`redraw-full-episode-reference-case.json` 由当前 `frontweb/e2e/fixtures/redraw-latin-american-case.js` 机械投影生成，没有手工提升任何审核状态：

- `case_id`、`reference_bundle_required`、`target`、`source` 和九镜固定时间轴直接取自当前案例合同；
- `face_tracks` 只把每镜当前 `speaking_character_ids` 记录为**尚未审核的候选轨迹**，时间范围临时使用整镜；它不是全体可见人物盘点，也不代表整镜都能识别人脸；
- `face_track_review` 与 `text_region_review` 原样保留 `pending` 和未解决原因；
- 候选说话角色对应的 `identity_packs` 全部为 `pending/null`；
- `text_regions` 原样投影，所有 clean plate 均为 `pending/null`；
- 运动参考审核为 `pending/null`；
- 英文对白逐镜取自 `localization.dialogue`，第 3、8 镜固定为 `silent` 且 `turns=[]`。

案例清单 SHA-256：`dd8c2e54bc4c222745944b195428e24e162c531f5d0ea0552e139a39579b00bb`。独立扫描确认案例 JSON 不含绝对路径、公网 URL 或 Key/Auth/Token/Secret 字段。

## 真实源片与 runner 结果

源片 basename：`ac087bcd4cf5f856f85182834794853a.mp4`

| 项目 | 实测值 |
| --- | --- |
| SHA-256 | `24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae` |
| 时长 | 68,733 ms |
| 视频 | HEVC，720 × 1280，30 fps |
| 音频 | AAC，单声道，44,100 Hz |

执行：

```text
node scripts/run-redraw-full-episode-reference-local.js --source <源片 basename> --case-manifest <案例 basename> --output-dir <仓库外输出目录 basename>
```

runner 退出码为 0，输出摘要为 `shot_count=9`、`ready_count=0`、`blocked_count=9`。生成清单：

- `redraw-full-episode-reference-local-manifest.json`
- SHA-256：`7b1d249ba808e6568acb7331b8642415c828dab5cef0869608da8bebdca42e4b`
- `timeline_contiguous=true`
- `provider_request_constructed=false`
- `supplier_call_performed=false`

独立重算写入 `independent-verification.json`，SHA-256 为 `4cf84f87d62f6e24c0a869b923b7a19079ba984898eee896fe9549af1f2fabda`。复核结果：九镜连续覆盖 `0..68733`；九个 `shots/shot-N-motion.mp4` 和九个 `frames/shot-N-representative.jpg` 均存在且 SHA-256 与 manifest 匹配；九个 clip 经 FFprobe 均无音轨；九张代表帧均可读；manifest 不含绝对路径、公网 URL 或 Key/Auth/Token/Secret 字段。

## 逐镜门禁结果

状态缩写：`P` 表示 `pending`；候选人物仅来自当前说话人列表；`identity` 显示待审核身份包；`text clean` 显示待审核文字净景数量。

| 镜头 | 人物轨迹 | identity | text clean | 运动参考 | 英文对白 | reference gate | blockers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shot-1 | P；mateo/diego/lucas | 3 P | 4 P；区域审核 P | P | spoken，4 turns | blocked | face review；identity；text review；text clean；motion |
| shot-2 | P；lucas/mateo | 2 P | 3 P；区域审核 P | P | spoken，3 turns | blocked | face review；identity；text review；text clean；motion |
| shot-3 | P；无说话人候选 | 0 | 0；区域审核 P | P | silent，0 turns | blocked | face review；text review；motion；silent unsupported |
| shot-4 | P；mateo | 1 P | 2 P；区域审核 P | P | spoken，2 turns | blocked | face review；identity；text review；text clean；motion |
| shot-5 | P；mateo | 1 P | 1 P；区域审核 P | P | spoken，1 turn | blocked | face review；identity；text review；text clean；motion |
| shot-6 | P；elena/mateo | 2 P | 3 P；区域审核 P | P | spoken，3 turns | blocked | face review；identity；text review；text clean；motion |
| shot-7 | P；mateo | 1 P | 1 P；区域审核 P | P | spoken，1 turn | blocked | face review；identity；text review；text clean；motion |
| shot-8 | P；无说话人候选 | 0 | 1 P；区域审核 P | P | silent，0 turns | blocked | face review；text review；text clean；motion；silent unsupported |
| shot-9 | P；mateo | 1 P | 1 P；区域审核 P | P | spoken，1 turn | blocked | face review；identity；text review；text clean；motion |

完整 blocker 机器值见 `redraw-full-episode-reference-local-manifest.json` 和 `independent-verification.json`。其中 `shot-3`、`shot-8` 明确包含 `silent_dialogue_contract_unsupported`；其余七镜有英文 turns，但仍因参考包其他部分未批准而 fail closed。

## 同一验收运行的测试与构建

| 验证 | 结果 |
| --- | --- |
| 前端合同/资产/分镜测试 | 44 tests，44 pass，0 fail，0 skip |
| 后端路由/参考包/生成/真实整集 runner 测试，`REQUIRE_LOCAL_FFMPEG=1` | 223 tests，222 pass，0 fail，1 skip |
| 后端 skip 说明 | Windows 当前权限不允许创建 symlink，跳过的是既有 realpath/symlink 安全测试；FFmpeg 真实媒体测试未跳过 |
| `npm --prefix frontweb run build` | exit 0，1,896 modules transformed；仅有既有 chunk size warning |
| `git diff --check` | exit 0 |

## 最终判定与下一门槛

本地参考包主线和“未审核不得生成”的失败关闭行为已取得真实源片证据，但**视觉复刻没有完成**。当前九镜全部 `blocked`，不得创建供应商任务。后续必须先完成逐帧全体人物轨迹审核、五名目标角色身份包、全部中文字幕/屏幕文字 clean plate、无原音运动参考审核，并补齐静默镜头合同；只有九镜都成为 `reference_bundle_ready=true`，再经过本地 UI/API 同链复核和新的预算授权，才可以另行规划一次真实付费生成。
