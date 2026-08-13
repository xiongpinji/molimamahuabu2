# 文字净景两镜本地证据报告

日期：2026-08-13

## 范围与边界

本报告只记录本地 fixture、服务测试和本地 CLI 的可复现实证。报告建立前的代码证据提交为 `b9c4a59e`；本报告提交不把自身 SHA 当作执行证据。未执行 SSH、部署、activate、生产数据库写入、付费供应商调用，也未读取或写入任何线上 Key。

本报告证明的是第 4、8 镜的静态两镜文字清除本地合同，不代表整段视频已完成文字清除，也不代表真实供应商生成或视频级跨帧跟踪已经验收。

## 执行环境与命令

实际执行目录：`backend-node`（仓库工作树为 `codex/redraw-r12-merge-20260809`）。

1. `node scripts/run-redraw-text-clean-plate-local-case.js --fixture --output-dir <本地临时输出目录>`
   - 退出码：0
   - 标准输出：`REDRAW_TEXT_CLEAN_PLATE_LOCAL_OK`
   - 输出：`redraw-text-clean-plate-local-manifest.json`、`redraw-text-clean-plate-contact-sheet.jpg`
   - contact sheet 元数据：JPEG，960×360
2. `node --test --test-concurrency=1 test/redrawAssets.test.js test/redrawTextCleanPlateLocalCase.test.js test/redrawGeneration.test.js`
   - tests 146，pass 145，fail 0，skipped 1

## 逐镜证据链

| 镜头 | 类型 | 证据链 | review | reference_gate |
|---|---|---|---|---|
| shot-4 | `text_subtitle` | `source → text_mask → text_clean_plate` | `pending` | `ready_for_reference=false` |
| shot-8 | `text_screen` | `source → text_mask → text_clean_plate` | `pending` | `ready_for_reference=false` |

两镜 manifest 均为 1280×720、`image/png`，source、mask 和 text-clean 均有 64 位小写 SHA-256；质量 fixture 为 `mask_area_changed=true`、`non_mask_similarity=0.98`、`text_residual=false`。区域仅保存脱敏后的类型、polygon 和受控来源枚举，不保存 OCR 原文、绝对路径、Authorization 或 API Key。

## 结论

静态两镜文字清除本地合同通过：fixture、manifest、contact sheet、资产快照和联合测试均已完成本地验证。审核状态仍为 pending，reference gate 未开放；后续若要进入真实生成或整集验收，必须另行完成真实供应商成功终态、可读产物、逐镜/跨帧证据和人工审核。
