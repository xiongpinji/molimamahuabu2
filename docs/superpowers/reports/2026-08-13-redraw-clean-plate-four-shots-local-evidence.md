# 四镜 clean plate 本地验收证据

## 结论

**静态四镜 clean plate 本地合同通过。**

本次证据仅覆盖本地 fixture 的 manifest 与 contact sheet 生成，以及对应 Node 测试；不外推为供应商生成或生产验收。

## 代码状态

- 分支：`codex/redraw-r12-merge-20260809`
- 短 HEAD：`6a2c1035`

## 执行命令与结果

```text
node scripts/run-redraw-clean-plate-local-case.js --fixture --output-dir <temp>
```

- 退出码：`0`
- 输出：`REDRAW_CLEAN_PLATE_LOCAL_OK`

```text
node --test --test-concurrency=1 test/redrawAssets.test.js test/redrawCleanPlateLocalCase.test.js test/redrawGeneration.test.js
```

- 退出码：`0`
- `tests 117`，`pass 116`，`fail 0`，`cancelled 0`，`skipped 1`，`todo 0`
- `duration_ms 25377.2328`

## 四镜 manifest 状态

fixture 生成四个镜头：`shot-1`、`shot-6`、`shot-7`、`shot-8`。每镜均包含 source、mask、clean_plate 三项，路径为 manifest 内相对路径；四镜字段均满足：

- 尺寸：`1280×720`
- MIME：`image/png`
- SHA-256：source、mask、clean_plate 均为 `54f1e2cc4b9d372c8735511320bedf96ed320fd52b08ffe389489546a10c73b6`
- review：`pending`
- `ready_for_reference`：`false`
- 绝对路径：未发现（manifest 中路径均为相对路径）

对应相对文件名：

| 镜头 | source | mask | clean_plate |
|---|---|---|---|
| shot-1 | `shots/shot-1/source.png` | `shots/shot-1/mask.png` | `shots/shot-1/clean-plate.png` |
| shot-6 | `shots/shot-6/source.png` | `shots/shot-6/mask.png` | `shots/shot-6/clean-plate.png` |
| shot-7 | `shots/shot-7/source.png` | `shots/shot-7/mask.png` | `shots/shot-7/clean-plate.png` |
| shot-8 | `shots/shot-8/source.png` | `shots/shot-8/mask.png` | `shots/shot-8/clean-plate.png` |

## 输出文件名

- `redraw-clean-plate-local-manifest.json`
- `redraw-clean-plate-contact-sheet.jpg`（`960×720`，`image/jpeg`）

## Local-only 声明

本次仅在指定本地 worktree 执行 fixture dry-run 与联合测试；未 SSH、未部署、未写生产数据库、未执行 `activate`，未调用 ToAPIs/供应商、未进行付费请求，也未读取或写入 Key。未删除用户输出目录或既有未跟踪项。
