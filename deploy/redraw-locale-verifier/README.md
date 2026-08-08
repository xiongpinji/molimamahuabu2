# 重绘语言验证 worker 沙箱材料

本目录只保存重绘语言验证 worker 的 systemd unit 和发布说明。release 允许携带受审计的 `server.py` 入口源码；其余 worker source、模型权重和 venv 必须预置在 `/opt/moli-drama/shared/redraw-locale-verifier/`。release 不携带模型权重、虚拟环境、密钥或生产数据。

上线顺序必须保持保守：先完成基准、签名和 disabled 部署，确认 unit 仍保持离线、单进程和资源受限，再批准付费 canary。付费 canary 需要单独授权，不能由本材料自动触发。

本 worker 只提供语言/地区重绘验证的独立补充信号，不能替代 Worker evidence。生产验收仍必须保留原 Worker evidence 链路，包括真实任务、状态写回、可读产物、计费/审计证据和用户产品流。

systemd 通过 shared verifier 目录下的 `verifier.env` 注入 socket、ready、allowed-root、pack、model-manifest、ASR 模型、口音 runtime 和 smoke 音频路径；缺少任一项时 entrypoint fail closed，不发布 ready attestation。

发布包边界由 `deploy/release-scopes/redraw-locale-verifier.json` 固定。禁止将密钥、模型权重、venv、生产 DB、`current` symlink 或 `shared/release-guard` 文件加入该 scope。

## Gate 使用与证据等级

本目录只能作为生产候选中的离线 sandbox 材料。门禁报告必须明确区分：

- `LOCAL_STATIC`：本 worktree 的 systemd、release scope、Node 合同测试、hash 和文档检查。
- `LOCAL_SYNTHETIC`：合成 fixture、dry-run、无供应商/无目标机的 canary 自测。
- `STALE_ARTIFACT`：只从历史本地产物读取且本轮未能复核的证据。
- `BLOCKED` / `NOT_RUN`：需要 SSH 目标机、生产 shared verifier、真实授权音频、生产 DB/storage、付费供应商或人工授权的项目。

不能把 `LOCAL_STATIC`、`LOCAL_SYNTHETIC` 或 `STALE_ARTIFACT` 写成生产通过。目标机 benchmark、独立 tune/eval calibration、签名生产材料和付费 canary 只有在用户批准并具备目标机/真实数据后才能执行。
