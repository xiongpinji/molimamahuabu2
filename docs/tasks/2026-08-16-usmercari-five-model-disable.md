# USMercari 五模型停用任务

## 目标

停用 `chat-ai.mercarimx.com` 中转站的五个失败模型路由：

- `MiniMax H3`
- `seedance-2.0-fast`
- `seedance-2.0-mini`
- `gpt-image-2-2-4k`
- `nano-banana-2`

## 精确范围

- 仅停用 `ai_service_configs.id = 15`（视频，3 个模型）和 `id = 17`（图片，2 个模型）。
- 保留配置、密钥和历史证据，不做物理删除。
- 不修改模型价格，不影响其他中转站或同名模型路由。
- 不部署代码、不重启服务、不接触 AI 音乐进程。

## 成功标准

1. 操作前数据库备份可读且 `quick_check = ok`。
2. 在部署锁和实时 release CAS 下，将配置 15、17 的 `is_active` 由 1 改为 0，并将实时验证状态标记为失败。
3. 操作后五个 USMercari 模型不再出现在用户模型目录；其他供应商模型仍保留。
4. 新增生成任务为 0、活动任务为 0，用户积分不发生变化。
5. 数据库 `quick_check = ok`，本地与公网健康检查为 200，服务无重启，AI 音乐进程保持运行。

## 状态

已完成（2026-08-16 11:44，Asia/Shanghai）。

## 执行证据

- 实时 release：`/opt/moli-drama/releases/usmercari-static-pr162-20260816-c4612d20`。
- 备份：`/opt/moli-drama/shared/backups/disable-usmercari-5models-20260816T034403Z.sqlite`。
- 备份 SHA-256：`3695cdbfbb04fe0863b4f30cb88d63ceb17ece58562ad61d9ffbbe59fcc41683`。
- 配置 15、17 均由 `is_active = 1` 精确更新为 `is_active = 0`，验证状态由 `verified` 更新为 `failed`。
- 首页真实目录读回：五个 USMercari 模型均不再展示；MiniMax H3-2K、fumin Seedance 和国内 Seedance 等其他供应商模型仍展示。
- 操作前后账户均为：可用 63876、冻结 240、已消费 48084。
- 操作前后生成记录总数均为：图片 561、视频 308；未创建生成任务。
- 操作后活动生成任务为 0，数据库 `quick_check = ok`。
- 本地与公网 `/health` 均为 200，`moli-drama` 保持运行且无重启，AI 音乐 PID 206874、206895 保持运行。

## 后续独立价格清理阶段

五模型路由停用完成后，另经批准在独立阶段将其遗留的三条孤立价格 `gpt-image-2-2-4k`、`minimax h3`、`nano-banana-2` 由 `enabled` 精确改为 `disabled`。该后续变更不改变本任务当时“仅停路由、不改价格”的执行边界；详细证据见 `2026-08-16-provider-failover-protection-phase.md`。
