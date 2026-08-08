# 重绘语言验证 Worker 门禁报告

## 范围与安全边界

- Worktree：`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\baseline-canvas-video-first-last-20260806`
- Branch：`codex/short-drama-redraw-design`
- 本轮未 SSH、未访问生产 `current`/DB/storage、未启动 Worker、未下载模型、未调用付费供应商。
- 目标机 30 条 benchmark、200 条 tune/eval 校准、生产签名 manifest 和付费 canary 均为 `BLOCKED/NOT_RUN`。

## 本地证据

| 项目 | 命令（均在当前 worktree） | 结果 |
| --- | --- | --- |
| Worker 单测 | `$env:PYTHONPATH='workers/redraw-locale-verifier/src'; uv run --with jiwer python -m unittest discover -s workers/redraw-locale-verifier/tests` | `exit 0; 72 passed, 7 Windows symlink skips` |
| Python 无第三方依赖回归 | `$env:PYTHONPATH=...; python -S -m unittest discover ...` | `exit 1; 49 tests，jiwer 缺失导致 normalization/verifier 导入错误` |
| Worker 静态语法 | `python -S -m compileall workers/redraw-locale-verifier` | `exit 0` |
| Node 语言/计费目标组 | `cd backend-node && node --test --test-concurrency=1 test/redrawLocaleManifestSigning.test.js ... test/webProductionDeploymentContract.test.js` | `exit 1; 当前 dirty fixtures 中仍有 batch 状态断言失败` |
| Node 核心五组回归 | `cd backend-node && node --test --test-concurrency=1 test/redrawAssetBatch.test.js test/redrawAssets.test.js test/redrawDialogue.test.js test/redrawDialogueOrchestrator.test.js test/redrawRoutes.test.js` | `exit 1; TAP 150 ok, 7 not ok；失败集中于既有 batch 旧状态断言` |
| Backend 全量 | `cd backend-node && npm test -- --test-concurrency=1` | `exit 1；在本地 dirty worktree 中存在既有回归失败，未作为生产通过依据` |
| 前端测试脚本 | `cd frontweb && npm test` | `NOT_RUN/未配置 test script` |
| 合同静态检查 | `cd backend-node && node --test --test-concurrency=1 test/webProductionDeploymentContract.test.js test/incrementalReleaseScope.test.js`、`git diff --check` | `16/16 pass；无生产写入` |

Node 目标组失败不被隐藏，也不把历史 dirty fixture 失败改写成 Worker 通过。当前 Worker 纯函数与 socket/registry/adapter 的已覆盖目标测试仍分别由前序任务证据支撑；本报告只记录本轮新鲜命令结果。

## 依赖与 hash

| 项目 | 级别 | SHA-256/状态 |
| --- | --- | --- |
| `backend-node/package-lock.json` | `LOCAL_STATIC` | `65e3471058d7f61b453e9033f9abd99022d32834ccbfac94dce5468620bce2c9` |
| `frontweb/package-lock.json` | `LOCAL_STATIC` | `c1221a846ea495e9c5614b3e669e208ea8e4f8fca5cf569ff70fbdb791d3539d` |
| `desktop/package-lock.json` | `LOCAL_STATIC` | `3da8dd64f8db84c34933079ccea04e1a51304eecabe2ba9e6cdb77e189317b46` |
| Worker `server.py` entrypoint | `LOCAL_STATIC` | `python -S -m py_compile` exit 0；systemd 使用 `redraw_locale_worker.server` |
| 模型 revision/tree hash | `BLOCKED` | 当前 worktree 无目标机 staged model manifest；不伪造 |
| calibration manifest/signature | `BLOCKED` | 无 200 条授权 tune/eval 音频与生产签名材料 |

## 未完成的生产门禁

- 目标机隔离目录 `/home/ubuntu/moli-redraw-locale-benchmark-<run>`：`NOT_RUN`，未 SSH。
- 30 条授权音频、五个时长档位、peak RSS/延迟/系统可用内存：`BLOCKED`。
- 至少 200 条 tune/eval 不重叠标注音频、FAR/FRR 校准及 Ed25519 生产 manifest：`BLOCKED`。
- 实时 `/opt/moli-drama/current`、候选发布、共享 release guard、真实模型生成与付费 canary：`NOT_RUN`，需要新的明确批准。

因此本报告不是生产可用性证明，也不写入 `verified capability`。下一关必须在获得批准、目标机、真实授权音频和供应商预算后，重新执行 benchmark、校准、真实生成、可播放产物、Worker evidence、积分/任务状态、预览/绑定及跨 key 防重验收。

## Provenance

本报告来自当前 worktree 的本地命令；报告文件的 Git commit provenance 由提交历史记录，避免在文档内自引用其自身 SHA。前序实现与审查 commit 链包括 `ad1613f6`、`d7ff094e`、`3849574d`、`22f94e19`、`3ddd90fe`、`eac30cb1`、`caf00406`、`5d93524e`、`908beb65`、`87deaff3`、`71b2d9e2`、`b327482a`、`f5a77fd8`。
