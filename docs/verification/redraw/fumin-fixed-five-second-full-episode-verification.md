# Fumin 固定五秒整集零提交验收

## 结论与边界

- 验收日期：2026-09-04。
- 最终验收代码 HEAD：`4994ffe108359015050a7c85c753e7b96edda900`，全部 R8 命令在该提交的 clean detached worktree 中执行。
- R8 结论：Fumin 提交合同修复的本地零提交验收通过；24 个父镜头被规划为 28 个固定五秒执行单元，素材、状态、哈希及指定回归证据闭合。R7 仍是绑定 `2b6c2c9ae54fedc3e4f01b84a5379a7fce153866` 的上一轮成功工件。
- 本报告提交后仓库 HEAD 会变化；R8 测试与工件只绑定上述 source code HEAD，历史 R5–R7 仍各自绑定其明示 HEAD，不把报告提交本身解释为重新执行代码验收。
- 本次没有读取或提供真实 Key，没有真实供应商请求、上传、生成、计费、部署、生产数据库写入或模型配置变更；因此不构成真实供应商付费生成验收或生产交付证明。

## 历史失败工件保持封存

| 工件 | 绑定 HEAD | 终态 | 封存校验 |
| --- | --- | --- | --- |
| R5 | `56174b7dbc2b7d8a72b6c139d5d79d652aa9a85e` | 唯一 preflight 退出 1，`FUMIN_EXECUTION_IDENTITY_REFERENCE_STALE`；未进入外部阶段，供应商计数全 0 | `SHA256SUMS.txt` SHA-256 `73052951b3cbe2fc8e74e5f5e8b8736156228fb88036053f06f02bd70ef4a11b`；46/46 行复核通过；package SHA-256 `640ba3ddb8b060926c871e94aa9b3bed127a1c3c52d44c8287b0d7a630a7a4f8` |
| R6 | `deb1c5acecaa812d33225451b781459d08c569dc` | preflight 通过，但完整前端为 1084 tests / 1080 pass / 2 fail / 0 cancelled / 2 skip，按门禁停止；供应商计数全 0 | `SHA256SUMS.txt` SHA-256 `a5ebe30e9d0d77f1e63e5ecd12a14856f876bf91a6237f1233d609bb6fd51ea4`；82/82 行复核通过；package SHA-256 `6daf236710f8af559b9c741a6ba45955b8c67a487cc0d534e1ea6b704b607e43` |

R8 完成后再次逐行复核 R5、R6、R7，均为 0 个缺失或哈希不匹配；R8 没有修改、删除或复用这些历史工件的 package/state。

## R7 自包含工件

- 根目录：`<r7-root>`（本地隔离验收目录）。
- R7 从 R4 只读独立重建，没有从 R5/R6 复制 package 或 state。R4 输入审计确认：8 张 identity、24 个父 motion、24 个 production pack、15 段 dialogue，锁定蓝图、本地化与生产包哈希全部匹配，锁定内容重新编译一致。
- R7 `SHA256SUMS.txt`：83/83 行复核通过，文件自身 SHA-256 为 `e7d791f0718d74b0dc1538e03c34c795e9af2f583d3b3a84ccaf539b096b9303`；清单按设计不包含自身，避免递归哈希。

### 包、状态与引用哈希

| 对象 | 数量 / 值 | SHA-256 或规范哈希 |
| --- | --- | --- |
| R7 package 文件 | 1 | `8f1c79f72bcb39f013a4cbe596595004f3d1914bfce8a53c9403a121d4824345` |
| R7 package canonical hash | 1 | `73a2292c74b291b7954f4dd4cc55be6676c5b44947f73de7974ebda8cabfcf55` |
| 锁定蓝图文件 / blueprint hash | 1 / 1 | `7fd5149c68f27e404d623051df97c2081c37de9cfc56981739288709adc1fc77` / `f62842d9fbdb006d84b8b7b63ff05c09e7e74850a5d0a86ab5fa01bc607aae8d` |
| 本地化文件 / localization hash | 1 / 1 | `6acd4858a1ca33e916293bc949793a6e3238a3a39e7f6a9d484fc2bfbc5d309c` / `755ecf2ad30aea5430ff1672649a09723fe8745ee050f837df6ac58138d9f6de` |
| production packs 文件 | 24 packs | `c8d2b7bad40c3bef4e3f3cb7372ec06891a8a3635259efe7fa160f3ba18049ee` |
| 源媒体 | 1 | `24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae` |
| identity 文件集合 | 8 | 聚合 SHA-256 `43319fe2b54a63dbfb46f17e91233a6dc907fc1867c2b4d9d42bd15038a96b4e` |
| 父 motion 文件集合 | 24 | 聚合 SHA-256 `d90f6f25137bb21c55bb57f2719b94a713f4a4d2e4fe5636177e56a59b7d7d86` |
| execution plan 文件 / logical hash | 28 units | `a51f527d3c7efbfb98a5b7a9e87854b68c595326df5758e10c861a186b0d214d` / `9afd820eed5622838e08a2ba06187e357faf88c2306624b6049b5c1310b59178` |
| private manifest / public preflight evidence | 各 1 | 均为 `8f5b7d1b8095a1358b712602e95a20681ab6f57e59c7d93a573605a81fe2a299` |
| 物化 execution motion 文件集合 | 28 | 聚合 SHA-256 `52e8db963cf7b4d4a5a06e770e41ce7d6fe6d5dfa4b5f9ec44c8175f0029e5d4` |

所有 package reference path 都解析到 R7 内的真实绝对路径。28 个物化 motion 均重新核对文件 SHA 与 probe：5 秒、496×864、24 fps、H.264、yuv420p、无音轨；总保留时长为 68,733 ms。

## 唯一一次 R7 preflight

实际命令：

```text
node scripts/run-redraw-fumin-full-episode-live.mjs --episode-package "<r7-root>\package\episode-package.json" --state-dir "<r7-root>\state" --stage preflight
```

- 起止 UTC：`2026-09-04T05:33:43.4987104Z` 至 `2026-09-04T05:34:02.3324040Z`；退出码 0；终态 `preflight_passed`。
- 结果：28 execution units、28 个物化 motion、0 tasks、所有 provider duration 为 5 秒、keep duration 合计 68,733 ms。
- 进程级网络硬哨兵：`fetch/http.request/http.get/https.request/https.get/net.connect/net.createConnection/tls.connect` 均为 0。
- provider GET / POST / upload / generation / billed：`0 / 0 / 0 / 0 / 0`。
- execution plan 与 prompt 证据递归字段扫描：`key/token/auth/url/bytes` 命中 0；未记录 Key 路径或秘密。
- 语言审计：CJK 0、Chinese word 0、源角色名 0、`Mateo` 0；模型配置变更 0。
- 完整 stdout/stderr、命令、起止 UTC 与退出码位于 `logs/cli-preflight.log`，其 SHA-256 为 `25c1db2b4293a2a5696311f600c28ef6915f77287714ec3b6e0f23ea03284919`。

## 回归门禁

| 门禁 | 实际命令 | UTC | 结果 |
| --- | --- | --- | --- |
| 受影响前端六文件 | `node --test scripts/fuminEpisodeExecutionPlan.test.mjs scripts/fuminExecutionMotion.test.mjs scripts/fuminEpisodeMediaPipeline.test.mjs scripts/fuminEpisodeProviderAdapter.test.mjs scripts/run-redraw-episode-blueprint-live.test.mjs scripts/run-redraw-fumin-full-episode-live.test.mjs` | `2026-09-04T05:34:40.4974082Z` 至 `2026-09-04T05:35:57.9299341Z` | exit 0；97 tests / 95 pass / 0 fail / 0 cancelled / 2 skip |
| 受影响后端四文件 | `node --test test/redrawShotProductionPack.test.js test/redrawLocalization.test.js test/featureLockManifest.test.js test/incrementalReleaseScope.test.js` | `2026-09-04T05:36:08.6944977Z` 至 `2026-09-04T05:36:10.1771790Z` | exit 0；105/105 pass，0 fail / 0 cancelled / 0 skip |
| 完整前端 | `rg --files scripts test` 后严格筛选并显式展开 `scripts/*.test.mjs`、`test/*.test.js`；实际 144 文件的完整 argv 与清单位于日志 | `2026-09-04T05:36:22.5199648Z` 至 `2026-09-04T05:37:45.2820879Z` | exit 0；1084 tests / 1082 pass / 0 fail / 0 cancelled / 2 skip |
| 完整后端 | `npm test`（实际展开为 `node --test --test-concurrency=1 test/*.test.js`） | `2026-09-04T05:37:56.8414968Z` 至 `2026-09-04T06:35:36.6980546Z` | exit 0；3944 tests / 3934 pass / 0 fail / 0 cancelled / 10 skip |

前端两次出现的 2 个 skip 均为 Windows 主机创建符号链接返回 EPERM。后端 10 个 skip 包括 5 个主机不支持符号链接、3 个 POSIX 权限专用用例，以及 2 个需要显式 `REQUIRE_LOCAL_FFMPEG=1` 或 `REDRAW_AUDITOR_PYTHON` 的选择性能力用例；没有把跳过项记为通过。

日志 SHA-256：

- `affected-frontweb.log`：`692b69b502433fd2f51132c36b0ee414262522512a683ac933341096926446be`。
- `affected-backend.log`：`0e45b1964ec1cce1a883c362c15c42472bfa79066f1c01495858c479f187a78d`。
- `full-frontweb.log`：`eb9935ccaf840eb04f3bb42ab93afe10db056d9e45cf7cf793fc8c7e61a6a769`；`full-frontweb-files.txt`：`047ba965e8014748090ee1bccafa9b67a940a0160580be33b298b59cce2644a9`。
- `full-backend-npm-test.log`：`bb52da380b00a41e3debfb92c1d61096e50353902118e1928806921c62f32f3a`。

## R8 Fumin 提交合同零提交收口

- 根目录：`<r8-root>`（本地隔离验收目录）。
- 绑定 source HEAD：`4994ffe108359015050a7c85c753e7b96edda900`；R8 从 R4 独立重建，没有复制 R5–R7 package/state。
- 输入复核：8 张 identity、24 个父 motion、24 个 production pack、15 段 dialogue；锁定蓝图、本地化、生产包与源媒体哈希匹配，当前 HEAD 重新编译的锁定内容完全一致。
- R8 package 文件 SHA-256：`8d5995989be282ac450d02260026039946e07ae6385f5f2e125af4328db8fa0f`；canonical hash：`de68a8d7a5f3064cf9599df890d6b9496c66e2ed180cdd17e1ccb02613acd271`。
- execution plan 文件 SHA-256：`a51f527d3c7efbfb98a5b7a9e87854b68c595326df5758e10c861a186b0d214d`；logical hash：`9afd820eed5622838e08a2ba06187e357faf88c2306624b6049b5c1310b59178`。
- private manifest 与 public preflight evidence SHA-256 均为 `5605b2458957ca5f19d79a579ca1b3b17f5497b43b99913f2c549bb69dae1ffb`。
- R8 `SHA256SUMS.txt`：86/86 行复核通过，自身 SHA-256 为 `110685d1b3cd51823a23df85a879495d3945e7308d761f4b85d0577aab8ab21f`；清单不包含自身。

唯一一次 R8 CLI preflight：

```text
node scripts/run-redraw-fumin-full-episode-live.mjs --episode-package "<r8-root>\package\episode-package.json" --state-dir "<r8-root>\state" --stage preflight
```

- 起止 UTC：`2026-09-04T08:18:32.3273699Z` 至 `2026-09-04T08:18:50.7756895Z`；exit 0；终态 `preflight_passed`。
- 结果：28 execution units、28 个物化 5 秒 motion、0 tasks、keep duration 合计 68,733 ms；28 个文件均重新核对 SHA 与 ffprobe，均为 496×864、24 fps、H.264、yuv420p、无音轨。
- 硬网络哨兵的 fetch/http/https/net/tls 计数全部为 0；provider GET / POST / upload / generation / billed 为 `0 / 0 / 0 / 0 / 0`。
- execution plan 与 prompt 证据递归扫描 `key/token/auth/url/bytes` 字段命中 0；CJK、Chinese word、源角色名与 `Mateo` 均为 0；模型配置变更 0。

R8 回归门禁：

| 门禁 | UTC | 结果 |
| --- | --- | --- |
| adapter + generic runner + wrapper 三文件 | `2026-09-04T08:20:10.3184537Z` 至 `2026-09-04T08:21:28.9465771Z` | exit 0；68 tests / 66 pass / 0 fail / 0 cancelled / 2 skip |
| 受影响前端六文件 | `2026-09-04T08:21:55.2578986Z` 至 `2026-09-04T08:23:13.8956717Z` | exit 0；103 tests / 101 pass / 0 fail / 0 cancelled / 2 skip |
| 完整前端，`rg --files scripts test` 后显式枚举 144 文件 | `2026-09-04T08:24:08.8058880Z` 至 `2026-09-04T08:25:34.5675855Z` | exit 0；1090 tests / 1088 pass / 0 fail / 0 cancelled / 2 skip |
| 当前 HEAD 后端 `featureLockManifest` + `incrementalReleaseScope` | `2026-09-04T08:25:48.5816169Z` 至 `2026-09-04T08:25:50.2002923Z` | exit 0；66/66 pass，0 fail / 0 cancelled / 0 skip |

三组前端回归中的 2 个 skip 均为 Windows 主机创建符号链接返回 EPERM。关键日志 SHA-256：三文件 `09f543136929d508744a59294b034bcfecef2d4b357d02274420b2e3dd9e1bca`，六文件 `9ae5e6e05ff165a2b8e9fa01e5d1f1631035df67402e6143027067b0bd501361`，完整前端 `c0ac76e7c82e892d8043e9c27a19116ec6bbee7d91baae8b211339af56440c95`，当前后端 66 项 `31ca7ae78cb62a6a7c9c06b53c54a90df938841d416f42afceebb10d7865f9b4`。

### 后端证据分区

- `git diff 2b6c2c9ae54fedc3e4f01b84a5379a7fce153866..4994ffe108359015050a7c85c753e7b96edda900` 显示 backend runtime 路径变更为 0；backend 范围只有 `backend-node/test/featureLockManifest.test.js`，并同步更新平台 feature-lock manifest 文档。
- R7 的完整后端结果为 3944 tests / 3934 pass / 0 fail / 0 cancelled / 10 skip，日志 SHA-256 `bb52da380b00a41e3debfb92c1d61096e50353902118e1928806921c62f32f3a`；该证据只绑定 R7 source HEAD `2b6c2c9ae54fedc3e4f01b84a5379a7fce153866`。
- R8 没有重复运行约 57.6 分钟的完整后端，也不宣称当前 HEAD 有一份新鲜完整后端结果；当前 HEAD 的直接证据是上述 66/66 后端受影响回归，并以“backend runtime 无变更”的差异审计与 R7 历史全量证据分区组合说明。

## 未执行事项

- 真实供应商 HTTP GET/POST、上传、生成与付费：均未执行。
- 真实供应商 Key 读取或写入：未执行。
- 部署、生产数据库/shared 写入、模型或供应商配置变更：未执行。
- 真实付费生成验收：未执行，必须等待独立明确授权；不得从本地 preflight 与离线回归推导其已通过。
